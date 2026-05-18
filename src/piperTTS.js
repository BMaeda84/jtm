// ─────────────────────────────────────────────────────────────────────────────
// piperTTS.js — Síntese de voz neural via Piper TTS (offline, alta qualidade)
//
// PIPER TTS:
//   Piper é um sintetizador de voz neural de código aberto criado pela Nabu Casa.
//   Roda inteiramente no navegador via WebAssembly (WASM) — sem servidor externo.
//   A biblioteca @mintplex-labs/piper-tts-web encapsula o WASM e gerencia o
//   armazenamento do modelo de voz via OPFS (Origin Private File System):
//     - Modelo baixado uma vez (~63MB), persistido no storage local do navegador
//     - Nas próximas aberturas do app, o modelo é carregado do OPFS (rápido)
//     - Funciona offline após o download inicial
//
// VOZ ESCOLHIDA — pt_BR-faber-medium:
//   Treinada em dados de voz do projeto Common Voice (português brasileiro).
//   Qualidade "medium" é um balanço entre tamanho de arquivo e naturalidade.
//   Alta qualidade de pronúncia comparada às vozes de síntese do sistema.
//
// FLUXO DE USO:
//   1. isPiperCached()   → verifica se o modelo já foi baixado
//   2. downloadPiper()   → baixa o modelo, reportando progresso (0–1)
//   3. speakWithPiper()  → sintetiza e reproduz áudio WAV como blob URL
//   4. cancelPiper()     → para o áudio em andamento
//
// POR QUE BLOB URL?
//   tts.predict() retorna um Blob de áudio (WAV). Para reproduzir via <Audio>,
//   criamos um URL temporário com URL.createObjectURL(). Isso evita que o
//   áudio precise ser serializado para base64 (mais memória) ou enviado a servidor.
//   O URL é implicitamente descartado quando o áudio termina (GC do browser).
//
// CONTROLE DE TAXA (playbackRate):
//   O Piper gera áudio em velocidade normal (rate=1.0).
//   Para sincronizar com a preferência de speechRate do usuário (padrão 0.85),
//   dividimos pelo valor de referência 0.85 para obter um fator relativo.
//   Exemplo: rate=0.70 → playbackRate = 0.70/0.85 ≈ 0.82 (ligeiramente mais lento)
//            rate=1.00 → playbackRate = 1.00/0.85 ≈ 1.18 (ligeiramente mais rápido)
// ─────────────────────────────────────────────────────────────────────────────

import * as tts from '@mintplex-labs/piper-tts-web'

// ID da voz Piper para português brasileiro (deve corresponder ao modelo disponível)
const VOICE_ID = 'pt_BR-faber-medium'

// Referência ao objeto Audio atualmente em reprodução.
// Usamos uma variável de módulo (singleton) para que cancelPiper() possa
// interromper qualquer áudio em andamento, mesmo que não seja o último
// Audio criado neste contexto.
let currentAudio = null

// ─────────────────────────────────────────────────────────────────────────────
// isPiperCached()
//
// Verifica se o modelo de voz já foi baixado e está armazenado no OPFS.
// Retorna: Promise<boolean>
//   true  — modelo disponível, speakWithPiper() pode ser usado imediatamente
//   false — modelo precisa ser baixado antes do uso
// ─────────────────────────────────────────────────────────────────────────────
export async function isPiperCached() {
  try {
    // tts.stored() retorna um array de IDs de vozes já baixadas no OPFS
    const stored = await tts.stored()
    return stored.includes(VOICE_ID)
  } catch {
    // OPFS pode estar indisponível em alguns navegadores (ex: iOS com restrições)
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// downloadPiper(onProgress)
//
// Baixa o modelo de voz neural e o persiste no OPFS para uso offline.
//
// Parâmetros:
//   onProgress — callback opcional ({loaded, total}) chamado durante o download.
//                Use para atualizar uma barra de progresso:
//                pct = Math.round((loaded / total) * 100)
//
// O download é um Promise — aguardar sua resolução garante que speakWithPiper()
// funcionará na chamada seguinte.
// ─────────────────────────────────────────────────────────────────────────────
export async function downloadPiper(onProgress) {
  await tts.download(VOICE_ID, onProgress)
}

// ─────────────────────────────────────────────────────────────────────────────
// speakWithPiper(text, rate)
//
// Sintetiza e reproduz o texto usando a voz neural Piper.
// Cancela qualquer áudio em andamento antes de iniciar (evita sobreposição).
//
// Parâmetros:
//   text — string a ser falada
//   rate — velocidade alvo (escala 0.5–1.2, padrão 0.85)
//          0.85 é o valor de referência Piper → playbackRate=1.0
//
// Retorna: Promise<void> — resolvido quando o áudio inicia (não quando termina)
// ─────────────────────────────────────────────────────────────────────────────
export async function speakWithPiper(text, rate = 0.85) {
  // Para o áudio anterior antes de sintetizar o novo
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }

  // tts.predict() roda o modelo Piper via WASM e retorna um Blob WAV
  // Isso é computacionalmente intenso (100–500ms dependendo do dispositivo)
  const wav = await tts.predict({ text, voiceId: VOICE_ID })

  const audio = new Audio()
  // Converte o Blob para um URL temporário que o elemento <Audio> pode reproduzir
  audio.src = URL.createObjectURL(wav)

  // Ajusta a velocidade de reprodução em relação ao padrão Piper (0.85)
  // Isso altera apenas o tempo de reprodução, não a pitch (diferente de resampling)
  audio.playbackRate = rate / 0.85

  currentAudio = audio
  await audio.play()

  // Limpa a referência quando o áudio termina naturalmente
  audio.onended = () => { currentAudio = null }
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelPiper()
//
// Para imediatamente o áudio em reprodução, se houver.
// Chamado antes de iniciar nova fala (para evitar sobreposição) ou
// quando o usuário fecha o app / navega para outra tela.
// ─────────────────────────────────────────────────────────────────────────────
export function cancelPiper() {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// clearPiperCache()
//
// Remove o modelo de voz baixado do OPFS (Origin Private File System).
// Após limpar, isPiperCached() voltará a retornar false e downloadPiper()
// precisará ser chamado novamente para restaurar o uso offline.
//
// Útil quando o modelo ficou corrompido ou para liberar espaço em disco.
// ─────────────────────────────────────────────────────────────────────────────
export async function clearPiperCache() {
  await tts.remove(VOICE_ID)
}

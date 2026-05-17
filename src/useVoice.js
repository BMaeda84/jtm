// ─────────────────────────────────────────────────────────────────────────────
// useVoice.js — Seleção e priorização de voz para síntese de fala (TTS)
//
// A Web Speech API (SpeechSynthesis) oferece as vozes instaladas no sistema
// operacional. A qualidade varia enormemente entre dispositivos:
//   - Google Neural voices (Android): alta qualidade, natural
//   - Samsung Neural TTS: qualidade boa
//   - Vozes nativas do sistema: variam de aceitável a ruim
//
// O hook filtra apenas vozes em português, as ordena por qualidade estimada
// e persiste a escolha do usuário no localStorage.
//
// NOTA: A Piper TTS (piperTTS.js) é preferida quando disponível.
// Esta função serve como fallback quando o Piper não está carregado.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react'

// Atribui uma pontuação de qualidade estimada a uma voz.
// Critérios heurísticos baseados em nomes comuns de vozes:
//   100 = Google Neural PT (melhor disponível no Android)
//    90 = Qualquer voz Google (neural presumido)
//    70 = Neural genérico (ex: Samsung Neural TTS)
//    60 = Enhanced/Premium (iOS vozes de alta qualidade)
//    40 = Qualquer voz pt-BR
//    30 = Qualquer voz pt (ex: pt-PT)
//    10 = Padrão (fallback)
function scorePtVoice(voice) {
  const name = voice.name.toLowerCase()
  if (name.includes('google') && name.includes('pt')) return 100
  if (name.includes('google'))                         return 90
  if (name.includes('neural'))                         return 70
  if (name.includes('enhanced') || name.includes('premium')) return 60
  if (voice.lang.toLowerCase().startsWith('pt-br'))    return 40
  if (voice.lang.toLowerCase().startsWith('pt'))       return 30
  return 10
}

// Retorna todas as vozes em português ordenadas por qualidade (melhor primeiro)
function getPtVoices() {
  return window.speechSynthesis
    .getVoices()
    .filter(v => v.lang.toLowerCase().startsWith('pt'))
    .sort((a, b) => scorePtVoice(b) - scorePtVoice(a))
}

const STORAGE_KEY = 'jtm_voice'  // chave localStorage para a voz preferida do usuário

export function useVoice() {
  const [voices, setVoices] = useState([])
  const [selectedVoice, setSelectedVoice] = useState(null)

  useEffect(() => {
    function load() {
      const ptVoices = getPtVoices()
      if (ptVoices.length === 0) return  // vozes ainda não carregadas (assíncrono no Chrome)

      setVoices(ptVoices)
      setSelectedVoice(prev => {
        if (prev) return prev  // mantém a voz já selecionada se existir

        // Tenta restaurar a preferência salva pelo nome da voz.
        // Usa o nome porque o objeto de voz muda a cada carregamento.
        const saved = localStorage.getItem(STORAGE_KEY)
        return ptVoices.find(v => v.name === saved) ?? ptVoices[0]  // fallback para melhor voz
      })
    }

    load()

    // 'voiceschanged' é disparado pelo Chrome quando as vozes são carregadas
    // de forma assíncrona. Sem esse listener, vozes neural do Google podem
    // não estar disponíveis na primeira chamada de getVoices().
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])

  function selectAndSave(voice) {
    localStorage.setItem(STORAGE_KEY, voice.name)  // persiste pelo nome (string estável)
    setSelectedVoice(voice)
  }

  return { voices, selectedVoice, setSelectedVoice: selectAndSave }
}

// ─────────────────────────────────────────────────────────────────────────────
// speak(phrase, voice, rate)
//
// Fala uma frase usando a Web Speech API nativa do sistema.
// Cancela qualquer fala em andamento antes de iniciar a nova —
// evita fila de falas que acumulam se o usuário ativa múltiplos botões.
// ─────────────────────────────────────────────────────────────────────────────
export function speak(phrase, voice, rate = 0.85) {
  window.speechSynthesis.cancel()  // interrompe fala anterior imediatamente

  const utterance = new SpeechSynthesisUtterance(phrase)
  utterance.lang  = 'pt-BR'   // forçamos pt-BR para que vozes genéricas usem sotaque correto
  utterance.rate  = rate       // 1.0 = velocidade normal; 0.85 = ligeiramente mais lento
  utterance.pitch = 1          // tom neutro
  if (voice) utterance.voice = voice  // usa a voz selecionada (ou padrão do sistema se null)

  window.speechSynthesis.speak(utterance)
}

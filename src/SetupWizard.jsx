// ─────────────────────────────────────────────────────────────────────────────
// SetupWizard.jsx — Fluxo de configuração inicial do app JTM
//
// VISÃO GERAL DO FLUXO:
//   Exibido na primeira abertura do app (quando 'jtm_setup_done' não existe
//   no localStorage). Guia o usuário por uma sequência de telas:
//
//   [welcome] → escolha do modo:
//     ├── Toque    → marca setup → entra no app (sem câmera)
//     ├── Varredura → [scan-trigger] → escolhe gatilho:
//     │     ├── auto   → marca setup → entra no app (sem câmera)
//     │     └── piscar/boca → [precheck] → [gesture-calib] → entra no app
//     └── Rastreamento ocular → [precheck] → [calibration] → [done] → entra no app
//
// COMPONENTES:
//   SetupWizard      — controlador de fluxo (máquina de estados de steps)
//   ScanTriggerStep  — seleção do gatilho de varredura (piscar / boca / automático)
//   PreCheckStep     — verifica câmera + WASM antes de prosseguir; exibe erros com instruções OS-específicas
//   GestureCalibStep — confirma que piscar/boca está sendo detectado pelo MediaPipe
//   CalibrationStep  — calibração de rastreamento ocular (complexo — ver detalhes abaixo)
//
// CALIBRAÇÃO — CONCEITO GERAL:
//   A câmera vê o rosto do usuário e extrai a posição da íris (fx, fy: 0–1).
//   Esses valores "crus" (rawGaze) não correspondem diretamente a posições de tela
//   porque dependem da posição do rosto, inclinação da câmera e morfologia ocular.
//
//   Solução: ajustar uma transformação afim 2D que mapeia (fx, fy) → (sx, sy)
//   onde (sx, sy) é a posição normalizada na tela.
//
//   Processo:
//   1. Exibimos 11 alvos (6 botões de frases + 5 abas de categoria) no layout
//      exato do app de produção (mesmas dimensões e posições de CSS).
//   2. Para cada alvo, coletamos rawGaze enquanto o usuário olha fixamente.
//   3. Usamos fitTransform() (calibration.js) para encontrar os 6 coeficientes
//      afins (a,b,c,d,e,f) via mínimos quadrados.
//   4. Repetimos PASSES=2 vezes para média de dados → mais robustez.
//
// ESTABILIDADE:
//   Problema: tremores oculares (nystagmus), piscar, ruído do modelo MediaPipe.
//   Solução: janela deslizante de 15 frames (≈250ms a 60fps).
//     - Calculamos o desvio padrão combinado XY dos frames mais recentes.
//     - Só aceitamos amostras quando stddev < STABILITY_THR (0.018).
//     - Exigimos STABLE_NEEDED=20 frames estáveis consecutivos por alvo.
//     - Barra de progresso visual mostra quantos frames estáveis já foram coletados.
//
// PERFIL DE TREMOR (tremorProfile):
//   Durante a calibração, coletamos o stddev de estabilidade para cada alvo.
//   Após todos os alvos, computeTremorProfile() calcula a mediana dos stddevs
//   e a mapeia para parâmetros do filtro One Euro (minCutoff, beta).
//   Usuários com mais tremor recebem mais suavização (minCutoff menor).
//   Esse perfil é salvo em localStorage e carregado por useFaceTracking().
//
// MOCK LAYOUT:
//   A calibração usa um layout que espelha EXATAMENTE o app de produção:
//   - Grid 2×N de botões de frase (mesmas proporções de App.jsx/App.css)
//   - Barra de navegação de categorias na parte inferior (mesma altura: 72px)
//   - Header com mesma altura (56px)
//   Isso garante que os (fx,fy) coletados correspondam às posições reais
//   onde o usuário vai olhar ao usar o app.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { FilesetResolver } from '@mediapipe/tasks-vision'  // usado no PreCheckStep para testar o WASM
import { useFaceTracking } from './useFaceTracking'
import { fitTransform, saveTransform, saveTremorProfile, clearTransform, clearTremorProfile } from './calibration'
import './SetupWizard.css'

// Versão pinada do WASM do MediaPipe — deve ser mantida em sincronia com useFaceTracking.js.
// Duplicada aqui para que o PreCheckStep possa testá-la independentemente do hook de tracking.
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'

// ── Constantes de calibração ──────────────────────────────────────────────────

const SETUP_KEY = 'jtm_setup_done'    // chave localStorage que indica setup completo

const WARMUP_MS = 400           // ms de pausa entre alvos (deixa o olhar estabilizar antes de coletar)
const STABILITY_WINDOW = 15    // quantos frames recentes guardar no buffer de estabilidade
const STABILITY_THR    = 0.018 // desvio padrão máximo (XY combinado) para considerar olhar "estável"
const STABLE_NEEDED    = 20    // quantos frames estáveis são necessários para confirmar um alvo
const PASSES           = 2     // quantas passagens pelos alvos (mais dados = melhor ajuste)

// ── Alvos do mock layout ──────────────────────────────────────────────────────
// Seis botões de frase (grid principal) + cinco abas de categoria (nav inferior).
// Os labels/emojis são apenas visuais — o que importa é a POSIÇÃO de cada elemento.
const MOCK_PHRASES = [
  { label: 'Sim',      emoji: '✅' },
  { label: 'Não',      emoji: '❌' },
  { label: 'Ajuda',    emoji: '🆘' },
  { label: 'Água',     emoji: '💧' },
  { label: 'Comida',   emoji: '🍽️' },
  { label: 'Banheiro', emoji: '🚽' },
]
const MOCK_CATS = [
  { label: 'Essencial',   emoji: '🆘' },
  { label: 'Preciso',     emoji: '🍽️' },
  { label: 'Sentimentos', emoji: '😊' },
  { label: 'Pessoas',     emoji: '👤' },
  { label: 'Digitar',     emoji: '✏️' },
]

// Total de alvos por passagem = frases + categorias
const TOTAL_TARGETS = MOCK_PHRASES.length + MOCK_CATS.length  // 6 + 5 = 11

// ── Opções de gatilho de varredura ────────────────────────────────────────────
const TRIGGER_OPTIONS = [
  { id: 'blink', icon: '😉', title: 'Piscar',     hint: 'Pisque intencionalmente para selecionar um botão' },
  { id: 'mouth', icon: '😮', title: 'Boca',       hint: 'Abra a boca por um instante para selecionar' },
  { id: 'auto',  icon: '⏱️', title: 'Automático', hint: 'Seleciona sozinho — não precisa de nenhum movimento' },
]

// ── Funções utilitárias de localStorage ──────────────────────────────────────

// Verifica se o setup ainda não foi concluído (usado em App.jsx para mostrar o wizard)
export function needsSetup() {
  return !localStorage.getItem(SETUP_KEY)
}

// Marca o setup como concluído; o wizard não será exibido na próxima abertura
export function markSetupDone() {
  localStorage.setItem(SETUP_KEY, '1')
}

// Remove todos os dados de configuração, forçando o wizard aparecer novamente.
// Chamado pelo botão "Reconfigurar" nas configurações.
// IMPORTANTE: limpa também a calibração e o perfil de tremor — caso contrário,
// o usuário ficaria preso com dados de calibração de uma posição de câmera anterior.
export function resetSetup() {
  localStorage.removeItem(SETUP_KEY)
  clearTransform()      // remove jtm_calib do localStorage
  clearTremorProfile()  // remove jtm_tremor do localStorage
}

// Remove apenas os dados de calibração ocular (transform afim + perfil de tremor),
// sem apagar o modo de controle escolhido (jtm_gaze, jtm_scan, jtm_setup_done).
// Usado pelo botão "Recalibrar rastreamento" nas configurações — permite refazer
// a calibração para outro usuário ou nova posição de câmera, sem recomeçar o wizard.
export function clearCalibrationOnly() {
  clearTransform()
  clearTremorProfile()
}

// ─────────────────────────────────────────────────────────────────────────────
// SetupWizard — controlador do fluxo de onboarding
//
// Props:
//   onComplete({ mode, trigger?, calibrated? }) — chamado ao fim do setup
//     mode: 'touch' | 'scan' | 'gaze'
//     trigger: 'blink'|'mouth'|'auto' (só para mode='scan')
//     calibrated: boolean (só para mode='gaze')
// ─────────────────────────────────────────────────────────────────────────────
// Props extras usadas no fluxo de recalibração iniciado pelas configurações:
//   startAt     — step inicial; 'welcome' (padrão) ou 'precheck' para pular a tela de boas-vindas
//   initialMode — modo pré-selecionado quando startAt !== 'welcome'; ex: 'gaze'
export function SetupWizard({ onComplete, startAt = 'welcome', initialMode = null }) {
  // Máquina de estados do wizard: tela atual sendo exibida
  // 'welcome' | 'scan-trigger' | 'precheck' | 'calibration' | 'gesture-calib' | 'done'
  const [step, setStep] = useState(startAt)

  // Preserva as escolhas do usuário enquanto navega pelo wizard.
  // Pré-inicializado com initialMode para o fluxo de recalibração.
  const [chosenMode,    setChosenMode]    = useState(initialMode)  // 'touch'|'scan'|'gaze'
  const [chosenTrigger, setChosenTrigger] = useState(null)         // 'blink'|'mouth'|'auto'|null

  // Modo toque: não precisa de câmera — setup imediato
  function chooseTouch() {
    markSetupDone()
    onComplete({ mode: 'touch' })
  }

  function chooseScanning() {
    setChosenMode('scan')
    setStep('scan-trigger')
  }

  function confirmScanning(trigger) {
    setChosenTrigger(trigger)
    if (trigger === 'auto') {
      // Auto-varredura usa apenas timer — não precisa de câmera nem de verificação de gesto
      markSetupDone()
      onComplete({ mode: 'scan', trigger: 'auto' })
    } else {
      // Piscar/boca: precisa câmera + WASM; vai verificar antes de calibrar
      setStep('precheck')
    }
  }

  function chooseGaze() {
    setChosenMode('gaze')
    setStep('precheck')
  }

  // PreCheckStep concluiu com sucesso → próximo passo depende do modo
  function onPreCheckSuccess() {
    if (chosenMode === 'gaze') {
      setStep('calibration')
    } else {
      // scan com piscar ou boca: confirma que o gesto está sendo detectado
      setStep('gesture-calib')
    }
  }

  // Calibração ocular concluída — salva os dados e exibe tela de sucesso
  function onCalibDone(transform, tremorProfile) {
    saveTransform(transform)       // persiste a matriz afim em localStorage
    saveTremorProfile(tremorProfile)  // persiste os params do One Euro Filter
    setStep('done')
  }

  // Usuário pulou a calibração — usa rastreamento sem transform personalizado
  function onCalibSkip() {
    markSetupDone()
    onComplete({ mode: 'gaze', calibrated: false })
  }

  function finishGaze() {
    markSetupDone()
    onComplete({ mode: 'gaze', calibrated: true })
  }

  // GestureCalibStep concluiu (ou foi pulado) — entra no app
  function onGestureDone() {
    markSetupDone()
    onComplete({ mode: 'scan', trigger: chosenTrigger })
  }

  if (step === 'precheck') {
    return (
      <PreCheckStep
        onSuccess={onPreCheckSuccess}
        onBack={() => setStep(chosenMode === 'gaze' ? 'welcome' : 'scan-trigger')}
      />
    )
  }

  if (step === 'gesture-calib') {
    return (
      <GestureCalibStep
        trigger={chosenTrigger}
        onDone={onGestureDone}
        onSkip={onGestureDone}  // pular = aceitar e entrar mesmo sem confirmar
      />
    )
  }

  if (step === 'calibration') {
    return <CalibrationStep onDone={onCalibDone} onSkip={onCalibSkip} />
  }

  if (step === 'done') {
    return (
      <div className="wizard">
        <div className="calib-done">
          <span className="calib-done-icon">✅</span>
          <span className="calib-done-title">Calibração concluída!</span>
          <span className="calib-done-desc">O rastreamento ocular está pronto.</span>
          <button className="wizard-confirm-btn" style={{ marginTop: 16 }} onClick={finishGaze}>
            Entrar no app
          </button>
        </div>
      </div>
    )
  }

  if (step === 'scan-trigger') {
    return <ScanTriggerStep onConfirm={confirmScanning} onBack={() => setStep('welcome')} />
  }

  // Tela de boas-vindas — escolha do modo de controle
  return (
    <div className="wizard">
      <img
        src={`${import.meta.env.BASE_URL}logo.svg`}
        alt="JTM — Comunicação Aumentativa e Alternativa"
        className="wizard-logo-img"
      />
      <p className="wizard-subtitle">
        App de comunicação para pessoas com dificuldades de fala.{'\n'}
        Como você quer controlar o app?
      </p>
      <p className="wizard-title">Escolha o modo de controle</p>
      <div className="wizard-options">
        <button className="wizard-option" onClick={chooseTouch}>
          <span className="wizard-option-icon">👆</span>
          <div className="wizard-option-text">
            <span className="wizard-option-title">Toque</span>
            <span className="wizard-option-desc">Toque nos botões normalmente. Ideal para quem tem mobilidade nas mãos.</span>
          </div>
        </button>

        <button className="wizard-option" onClick={chooseScanning}>
          <span className="wizard-option-icon">📡</span>
          <div className="wizard-option-text">
            <span className="wizard-option-title">Varredura</span>
            <span className="wizard-option-desc">Os botões acendem em sequência. Selecione piscando, abrindo a boca, ou automaticamente.</span>
          </div>
        </button>

        <button className="wizard-option" onClick={chooseGaze}>
          <span className="wizard-option-icon">👁️</span>
          <div className="wizard-option-text">
            <span className="wizard-option-title">Rastreamento ocular</span>
            <span className="wizard-option-desc">Olhe para o botão e fixe o olhar para ativá-lo. Requer calibração rápida.</span>
          </div>
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ScanTriggerStep — seleciona como o usuário vai selecionar botões na varredura
// ─────────────────────────────────────────────────────────────────────────────
function ScanTriggerStep({ onConfirm, onBack }) {
  const [selected, setSelected] = useState('blink')  // gatilho padrão: piscar
  return (
    <div className="wizard">
      <p className="wizard-title">Como quer selecionar os botões?</p>
      <div className="wizard-trigger-options">
        {TRIGGER_OPTIONS.map(opt => (
          <button
            key={opt.id}
            className={`wizard-trigger-btn${selected === opt.id ? ' selected' : ''}`}
            onClick={() => setSelected(opt.id)}
          >
            <span className="wizard-trigger-icon">{opt.icon}</span>
            <div>
              <div className="wizard-trigger-title">{opt.title}</div>
              <div className="wizard-trigger-hint">{opt.hint}</div>
            </div>
          </button>
        ))}
      </div>
      <button className="wizard-confirm-btn" onClick={() => onConfirm(selected)}>
        Confirmar
      </button>
      <button className="wizard-back" onClick={onBack}>← Voltar</button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PreCheckStep — verificação automática de câmera + WASM antes de calibrar
//
// Executa dois passos em sequência, sem interação do usuário salvo erro:
//   1. getUserMedia: verifica se a câmera existe e se a permissão foi concedida.
//      Libera o stream imediatamente após — só precisamos confirmar o acesso.
//   2. FilesetResolver.forVisionTasks(): inicializa o ambiente WASM do MediaPipe.
//      Isso baixa os arquivos da CDN (~5 MB) e testa se a CSP permite o acesso.
//      O modelo neural (.task, ~11 MB) é baixado depois, na CalibrationStep.
//
// Em caso de erro, exibe instruções específicas por tipo de falha e OS.
// O botão "Tentar novamente" re-executa os passos a partir do início.
//
// Props:
//   onSuccess() — chamado automaticamente quando os dois passos passam
//   onBack()    — chamado se o usuário quiser voltar e escolher outro modo
// ─────────────────────────────────────────────────────────────────────────────
function PreCheckStep({ onSuccess, onBack }) {
  // 'pending'|'checking'|'ok'|'denied'|'error'
  const [cameraStatus, setCameraStatus] = useState('pending')
  // 'pending'|'loading'|'ok'|'error'
  const [wasmStatus, setWasmStatus] = useState('pending')
  // null | 'camera-denied' | 'camera-error' | 'wasm-error'
  const [errorType, setErrorType] = useState(null)

  // retryCount: incrementar força o useEffect a re-executar (re-verificação)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function run() {
      // ── Passo 1: câmera ──────────────────────────────────────────────────
      setCameraStatus('checking')
      setWasmStatus('pending')
      setErrorType(null)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        // Libera o stream imediatamente — CalibrationStep abrirá a câmera novamente
        stream.getTracks().forEach(t => t.stop())
        if (!cancelled) setCameraStatus('ok')
      } catch (e) {
        if (cancelled) return
        // NotAllowedError: usuário ou sistema operacional negou explicitamente
        const denied = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
        setCameraStatus(denied ? 'denied' : 'error')
        setErrorType(denied ? 'camera-denied' : 'camera-error')
        return  // sem câmera → não tem sentido checar WASM
      }

      // ── Passo 2: WASM do MediaPipe ───────────────────────────────────────
      // Testa se a CDN está acessível, se a CSP permite script-src + worker-src,
      // e se o dispositivo consegue compilar WASM (wasm-unsafe-eval).
      setWasmStatus('loading')
      try {
        await FilesetResolver.forVisionTasks(WASM_URL)
        if (cancelled) return
        setWasmStatus('ok')
        // Pausa curta para o usuário ver o ✓ antes de avançar automaticamente
        setTimeout(() => { if (!cancelled) onSuccess() }, 600)
      } catch (e) {
        if (cancelled) return
        setWasmStatus('error')
        setErrorType('wasm-error')
      }
    }

    run()
    return () => { cancelled = true }
  }, [retryCount])  // re-executa quando o usuário clica em "Tentar novamente"

  // Detecta o SO para mostrar instruções de permissão específicas
  const isIOS     = /iPhone|iPad|iPod/.test(navigator.userAgent)
  const isAndroid = /Android/.test(navigator.userAgent)

  // Instrução de como desbloquear a câmera após negação, por SO
  const cameraFixMsg = isIOS
    ? 'Vá em Ajustes → Safari → Câmera → Permitir. Depois volte ao app e tente novamente.'
    : isAndroid
      ? 'Toque em 🔒 na barra do navegador → Permissões → Câmera → Permitir. Depois recarregue a página.'
      : 'Clique no ícone de câmera ou cadeado na barra do navegador e permita o acesso à câmera.'

  // Ícone e cor de cada estado
  function stepIcon(status) {
    return { pending: '·', checking: '⌛', loading: '⌛', ok: '✅', denied: '🚫', error: '❌' }[status] ?? '·'
  }
  function stepColor(status) {
    return { ok: '#22C55E', denied: '#EF4444', error: '#EF4444' }[status] ?? '#94A3B8'
  }

  return (
    <div className="wizard">
      <p className="wizard-title">Verificando requisitos</p>

      {/* Lista de passos com ícone de status */}
      <div className="precheck-steps">
        {[
          { label: 'Câmera',        status: cameraStatus },
          { label: 'Motor de IA',   status: wasmStatus   },
        ].map(({ label, status }) => (
          <div key={label} className="precheck-step-row">
            <span className="precheck-step-icon">{stepIcon(status)}</span>
            <span className="precheck-step-label" style={{ color: stepColor(status) }}>{label}</span>
            {status === 'loading' && (
              <span className="precheck-step-hint">baixando...</span>
            )}
          </div>
        ))}
      </div>

      {/* Mensagens de erro com instruções específicas */}
      {errorType === 'camera-denied' && (
        <div className="precheck-error-box">
          <strong>Câmera bloqueada</strong>
          <p>{cameraFixMsg}</p>
          <button className="wizard-confirm-btn" onClick={() => window.location.reload()}>
            Recarregar após permitir
          </button>
        </div>
      )}

      {errorType === 'camera-error' && (
        <div className="precheck-error-box">
          <strong>Câmera não encontrada</strong>
          <p>Verifique se o dispositivo tem câmera frontal disponível e tente novamente.</p>
          <button className="wizard-confirm-btn" onClick={() => setRetryCount(c => c + 1)}>
            Tentar novamente
          </button>
        </div>
      )}

      {errorType === 'wasm-error' && (
        <div className="precheck-error-box">
          <strong>Falha ao baixar motor de IA</strong>
          <p>Verifique sua conexão com a internet e tente novamente. O download é de ~5 MB.</p>
          <button className="wizard-confirm-btn" onClick={() => setRetryCount(c => c + 1)}>
            Tentar novamente
          </button>
        </div>
      )}

      {!errorType && (
        <p className="precheck-hint">
          {cameraStatus !== 'ok' ? 'Verificando câmera...' : 'Baixando motor de IA (~5 MB)...'}
        </p>
      )}

      <button className="wizard-back" onClick={onBack}>← Voltar</button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// GestureCalibStep — confirma que piscar/boca está sendo detectado
//
// Exibida após o PreCheckStep quando o gatilho de varredura é 'blink' ou 'mouth'.
// Inicia o rastreamento facial e aguarda o usuário fazer o gesto solicitado.
// Detectado → exibe ✓ por 1,5s e avança automaticamente.
// Timeout de 12s sem detecção → exibe dica de posicionamento + botão de pular.
//
// Baseline: registramos blinkCount/mouthCount quando status vira 'active'
// para não confundir eventos do próprio init com gestos intencionais do usuário.
//
// Props:
//   trigger  — 'blink' | 'mouth'
//   onDone() — gesto detectado com sucesso (ou skipped)
//   onSkip() — usuário quer pular a verificação
// ─────────────────────────────────────────────────────────────────────────────
function GestureCalibStep({ trigger, onDone, onSkip }) {
  const [detected,  setDetected]  = useState(false)
  const [timedOut,  setTimedOut]  = useState(false)
  const detectedRef = useRef(false)
  // Valores iniciais de blinkCount/mouthCount no momento em que a câmera ficou ativa.
  // Qualquer incremento acima desses valores é um gesto intencional do usuário.
  const baselineRef = useRef({ blink: null, mouth: null })

  const { blinkCount, mouthCount, status, videoRef } = useFaceTracking(true)

  // Registra o baseline assim que o tracking ficar ativo
  useEffect(() => {
    if (status === 'active' && baselineRef.current.blink === null) {
      baselineRef.current = { blink: blinkCount, mouth: mouthCount }
    }
  }, [status, blinkCount, mouthCount])

  // Monitora gestos após o baseline estar definido
  useEffect(() => {
    if (detectedRef.current || status !== 'active' || baselineRef.current.blink === null) return
    const blinked = trigger === 'blink' && blinkCount > baselineRef.current.blink
    const mouthed = trigger === 'mouth' && mouthCount > baselineRef.current.mouth
    if (blinked || mouthed) {
      detectedRef.current = true
      setDetected(true)
      // Exibe o estado de sucesso brevemente antes de avançar
      setTimeout(onDone, 1500)
    }
  }, [blinkCount, mouthCount, status, trigger, onDone])

  // Timeout de 12s após câmera ativa: mostra dica se o gesto não foi detectado
  useEffect(() => {
    if (status !== 'active') return
    const t = setTimeout(() => { if (!detectedRef.current) setTimedOut(true) }, 12000)
    return () => clearTimeout(t)
  }, [status])

  const icon        = trigger === 'blink' ? '😉' : '😮'
  const instruction = trigger === 'blink'
    ? 'Pisque um olho intencionalmente'
    : 'Abra bem a boca por um instante'

  return (
    <div className="wizard">
      {/* Preview da câmera para que o usuário saiba que está sendo detectado */}
      <video
        ref={videoRef}
        autoPlay playsInline muted
        className="gesture-video-preview"
      />

      {detected ? (
        <div className="calib-done">
          <span className="calib-done-icon">✅</span>
          <span className="calib-done-title">Detectado!</span>
          <span className="calib-done-desc">O gesto está funcionando perfeitamente.</span>
        </div>
      ) : (
        <>
          <div className="gesture-icon">{icon}</div>
          <p className="wizard-title">
            {status === 'loading' ? 'Iniciando câmera...'
              : status === 'error' ? 'Erro ao acessar câmera'
              : instruction}
          </p>
          {status === 'active' && (
            <p className="wizard-subtitle" style={{ marginBottom: 0 }}>
              Câmera ativa — fique a 30–60 cm de distância, com rosto bem iluminado.
            </p>
          )}
          {timedOut && (
            <div className="precheck-error-box">
              <strong>Gesto não detectado</strong>
              <p>
                Certifique-se de que o rosto está visível no preview acima e bem iluminado.
                {trigger === 'blink'
                  ? ' Pisque com mais intensidade — feche o olho por pelo menos 0,2 segundos.'
                  : ' Abra bem a boca, como se fosse bocejar.'}
              </p>
            </div>
          )}
        </>
      )}

      {!detected && (
        <button className="wizard-back" style={{ marginTop: 20 }} onClick={onSkip}>
          Pular esta verificação
        </button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// computeTremorProfile(variances)
//
// Converte os desvios padrão de estabilidade coletados durante a calibração
// em parâmetros do filtro One Euro Filter para uso em useFaceTracking.
//
// LÓGICA:
//   1. Ordena os stddevs e pega a mediana (mais robusta que média contra outliers).
//   2. Mapeia a mediana linearmente de [LOW=0.006, HIGH=0.020] para t ∈ [0, 1].
//      - LOW: olhar muito estável (tremor mínimo)
//      - HIGH: olhar com muito tremor (nystagmus, Parkinson etc.)
//   3. minCutoff: varia de 0.70 (olhar estável → menos suavização) a
//                            0.25 (muito tremor → mais suavização)
//      Fórmula: minCutoff = 0.70 - t * 0.45
//   4. beta=1.6 é fixo — controla a responsividade ao movimento intencional.
//      Valor empírico que funciona bem para movimentos de olho em interfaces.
//
// Parâmetros:
//   variances — array de stddevs (um por alvo de calibração)
//
// Retorna: { minCutoff, beta } para salvar em localStorage e passar ao One Euro Filter
// ─────────────────────────────────────────────────────────────────────────────
function computeTremorProfile(variances) {
  // Sem dados de variância → usa valores médios (calibração pulada ou falhou)
  if (!variances.length) return { minCutoff: 0.5, beta: 1.6 }

  const sorted = [...variances].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  // Limites de tremor observados empiricamente em testes com usuários reais
  const LOW = 0.006, HIGH = 0.020

  // t=0 → olhar muito estável; t=1 → muito tremor
  // clamp: Math.max(0,...) e Math.min(1,...) garantem que t ∈ [0,1]
  const t = Math.max(0, Math.min(1, (median - LOW) / (HIGH - LOW)))

  // Mais tremor (t→1) → minCutoff menor → mais suavização de baseline
  return { minCutoff: parseFloat((0.70 - t * 0.45).toFixed(3)), beta: 1.6 }
}

// ─────────────────────────────────────────────────────────────────────────────
// CalibrationStep — UI e lógica de coleta de dados de calibração
//
// Props:
//   onDone(transform, tremorProfile) — chamado ao concluir todas as passagens
//   onSkip()                         — chamado se o usuário pular a calibração
// ─────────────────────────────────────────────────────────────────────────────
function CalibrationStep({ onDone, onSkip }) {
  // targetIdx: qual dos 11 alvos está sendo coletado agora (0–10)
  const [targetIdx, setTargetIdx] = useState(0)

  // pass: passagem atual (0 ou 1 para PASSES=2)
  const [pass, setPass] = useState(0)

  // phase:
  //   'waiting'    — câmera ainda não está ativa
  //   'warmup'     — pausa entre alvos (WARMUP_MS ms), deixa o olhar estabilizar
  //   'collecting' — coletando frames estáveis para o alvo atual
  const [phase, setPhase] = useState('waiting')

  // progress: 0.0–1.0, quantos frames estáveis foram coletados vs. STABLE_NEEDED
  const [progress, setProgress] = useState(0)

  // isLocked: true quando o stddev do rolling window está abaixo de STABILITY_THR
  // Usado para mudar a cor visual do botão (azul → verde quando estável)
  const [isLocked, setIsLocked] = useState(false)

  // Refs para os elementos DOM dos alvos (para medir suas posições na tela)
  const targetRefs = useRef([])

  // positions: {x, y} normalizados (0–1) do centro de cada alvo, medidos após layout
  const positions = useRef([])

  // samplesRef: amostras de rawGaze estáveis para o alvo atual
  // Serão agregadas em uma média ao confirmar o alvo
  const samplesRef = useRef([])

  // allDataRef: todos os pares (iris, screen) coletados nas passagens completas
  // Entrada para fitTransform() ao final
  const allDataRef = useRef([])

  // irisWindowRef: buffer deslizante dos últimos STABILITY_WINDOW frames
  // Usado para calcular o desvio padrão XY atual
  const irisWindowRef = useRef([])

  // stableCountRef: contador de frames estáveis consecutivos para o alvo atual
  const stableCountRef = useRef(0)

  // varDataRef: stddev de estabilidade de cada alvo, para computeTremorProfile()
  const varDataRef = useRef([])

  // phaseStart: timestamp (performance.now()) do início do warmup atual
  const phaseStart = useRef(0)

  // rawGaze: posição atual da íris (0–1), sem transformação
  // Usamos rawGaze (não gazePoint) para coletar dados ANTES da calibração existir
  const { rawGaze, status, videoRef } = useFaceTracking(true)

  // ── Mede as posições dos alvos após o primeiro paint ──────────────────────
  // useLayoutEffect garante que a medição ocorre após o DOM ser atualizado
  // mas antes que o browser pinte — posições ainda não afetadas por scroll/zoom.
  // getBoundingClientRect() retorna coordenadas em pixels relativas ao viewport.
  // Normalizamos dividindo por innerWidth/innerHeight para obter 0–1.
  useLayoutEffect(() => {
    positions.current = targetRefs.current.map(el => {
      const r = el.getBoundingClientRect()
      return {
        x: (r.left + r.width  / 2) / window.innerWidth,
        y: (r.top  + r.height / 2) / window.innerHeight,
      }
    })
  }, [])

  // ── Inicia o warmup assim que a câmera estiver ativa ─────────────────────
  useEffect(() => {
    if (status === 'active' && positions.current.length > 0) {
      phaseStart.current = performance.now()
      setPhase('warmup')
    }
  }, [status])

  // ── Loop principal de calibração — executa a cada frame de rawGaze ────────
  useEffect(() => {
    if (!rawGaze || status !== 'active' || phase === 'waiting') return

    const now = performance.now()

    // Durante o warmup, apenas aguarda WARMUP_MS antes de começar a coletar
    if (phase === 'warmup') {
      if (now - phaseStart.current >= WARMUP_MS) {
        // Warmup concluído — reseta os buffers e começa a coletar
        irisWindowRef.current  = []
        stableCountRef.current = 0
        samplesRef.current     = []
        phaseStart.current     = now
        setPhase('collecting')
      }
      return
    }

    // ── Fase de coleta: detecção de estabilidade do olhar ──────────────────

    // Adiciona o frame atual ao buffer deslizante
    const win = irisWindowRef.current
    win.push({ x: rawGaze.x, y: rawGaze.y })
    if (win.length > STABILITY_WINDOW) win.shift()  // remove o frame mais antigo
    if (win.length < STABILITY_WINDOW) return        // aguarda o buffer encher

    // Calcula a média XY dos frames no buffer
    const n  = win.length
    const mx = win.reduce((s, p) => s + p.x, 0) / n
    const my = win.reduce((s, p) => s + p.y, 0) / n

    // Calcula variância XY (média dos desvios ao quadrado)
    // vx = Σ(xi - mx)² / n   ;   vy = Σ(yi - my)² / n
    const vx = win.reduce((s, p) => s + (p.x - mx) ** 2, 0) / n
    const vy = win.reduce((s, p) => s + (p.y - my) ** 2, 0) / n

    // stddev combinado XY: raiz da soma das variâncias
    // Mede o "raio" médio de dispersão do olhar nos últimos 15 frames
    const stddev = Math.sqrt(vx + vy)

    // O olhar é estável se o stddev está abaixo do limiar
    const stable = stddev < STABILITY_THR
    setIsLocked(stable)

    if (stable) {
      stableCountRef.current++
      samplesRef.current.push({ x: rawGaze.x, y: rawGaze.y })
    }

    // Atualiza a barra de progresso (0→1)
    const pct = Math.min(stableCountRef.current / STABLE_NEEDED, 1)
    setProgress(pct)
    if (pct < 1) return  // ainda coletando

    // ── Alvo confirmado — registra os dados ───────────────────────────────

    // Salva o stddev deste alvo para o perfil de tremor
    varDataRef.current.push(stddev)

    // Calcula a média das amostras estáveis → representação do olhar neste alvo
    const m   = samplesRef.current.length
    const avg = samplesRef.current.reduce(
      (a, s) => ({ x: a.x + s.x / m, y: a.y + s.y / m }),
      { x: 0, y: 0 }
    )

    // Registra o par (posição de tela do alvo → posição média da íris)
    allDataRef.current.push({ screen: positions.current[targetIdx], iris: avg })

    // Reseta para o próximo alvo
    irisWindowRef.current  = []
    stableCountRef.current = 0
    samplesRef.current     = []

    const nextIdx = targetIdx + 1

    if (nextIdx < TOTAL_TARGETS) {
      // Avança para o próximo alvo dentro desta passagem
      setTargetIdx(nextIdx)
      setProgress(0)
      setIsLocked(false)
      setPhase('warmup')
      phaseStart.current = now
      return
    }

    const nextPass = pass + 1
    if (nextPass < PASSES) {
      // Fim de uma passagem — inicia a próxima do alvo 0
      setPass(nextPass)
      setTargetIdx(0)
      setProgress(0)
      setIsLocked(false)
      setPhase('warmup')
      phaseStart.current = now
      return
    }

    // ── Todas as passagens concluídas — ajusta a transformação ───────────

    // Separa os dados em dois arrays paralelos para fitTransform()
    const irisPoints   = allDataRef.current.map(d => d.iris)
    const screenPoints = allDataRef.current.map(d => d.screen)

    // fitTransform: calcula os 6 coeficientes afins por mínimos quadrados
    // computeTremorProfile: calcula os params do One Euro Filter pelo stddev mediano
    onDone(fitTransform(irisPoints, screenPoints), computeTremorProfile(varDataRef.current))
  }, [rawGaze]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Variáveis derivadas para o render ────────────────────────────────────

  const totalSteps  = TOTAL_TARGETS * PASSES       // 11 × 2 = 22 passos totais
  const currentStep = pass * TOTAL_TARGETS + targetIdx + 1
  const isPhrase    = targetIdx < MOCK_PHRASES.length  // true → alvo no grid; false → nav
  const catIdx      = targetIdx - MOCK_PHRASES.length   // índice na nav (quando !isPhrase)

  const instruction = status === 'loading' ? '⏳ Iniciando câmera...'
    : status === 'error'  ? '❌ Câmera indisponível.'
    : phase === 'waiting' ? '⏳ Aguardando câmera...'
    : phase === 'warmup'  ? 'Olhe para o botão destacado'
    : isLocked            ? 'Perfeito — mantendo o olhar...'
    : 'Fixe o olhar no botão'

  // Constantes de layout exatas que espelham App.css (CSS custom properties)
  // HEADER_H e NAV_H devem ser iguais ao app para que as posições medidas
  // com getBoundingClientRect() sejam transferíveis para o modo de uso real.
  const HEADER_H = 56, NAV_H = 72, GAP = 10

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#0F172A',
      display: 'flex', flexDirection: 'column',
      maxWidth: 600, margin: '0 auto',
    }}>
      {/* Preview da câmera — permite ao usuário ver que está sendo detectado */}
      <video ref={videoRef} autoPlay playsInline muted style={{
        position: 'absolute', bottom: NAV_H + 10, right: 10,
        width: 80, height: 60, borderRadius: 6, zIndex: 10,
        border: '2px solid #60A5FA', objectFit: 'cover',
      }} />

      {/* Header: instrução textual + contador de progresso geral */}
      <div style={{
        height: HEADER_H, flexShrink: 0, background: '#0F172A',
        borderBottom: '1px solid #1E293B',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 12px',
      }}>
        {/* Cor muda para verde quando o olhar está estável (isLocked) */}
        <span style={{ color: isLocked ? '#22C55E' : '#94A3B8', fontSize: 13, transition: 'color 0.2s' }}>
          {instruction}
        </span>
        <span style={{ color: '#475569', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          {pass + 1}/{PASSES} · {currentStep}/{totalSteps}
        </span>
      </div>

      {/* Grid de botões de frase — idêntico ao layout de produção (2 colunas) */}
      <div style={{
        flex: 1, overflow: 'hidden',
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        gridAutoRows: '1fr',
        gap: GAP, padding: GAP,
      }}>
        {MOCK_PHRASES.map((btn, i) => {
          const active = phase !== 'waiting' && isPhrase && i === targetIdx
          const locked = active && phase === 'collecting' && isLocked
          return (
            <div
              key={i}
              ref={el => { targetRefs.current[i] = el }}  // registra o ref para medir posição
              style={{
                borderRadius: 16,
                // Azul = alvo ativo mas olhar instável; verde = olhar fixo e estável
                background: locked ? 'rgba(34,197,94,0.18)'  : active ? 'rgba(37,99,235,0.2)' : '#1E293B',
                border: `3px solid ${locked ? '#22C55E' : active ? '#60A5FA' : 'transparent'}`,
                boxShadow: locked ? '0 0 0 4px rgba(34,197,94,0.3)' : active ? '0 0 0 4px rgba(96,165,250,0.3)' : 'none',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 6,
                position: 'relative', overflow: 'hidden',
                transition: 'border-color 0.15s, box-shadow 0.15s, background 0.15s',
              }}
            >
              <span style={{ fontSize: 36, lineHeight: 1 }}>{btn.emoji}</span>
              <span style={{ fontSize: 15, fontWeight: 600, color: active ? '#F1F5F9' : '#64748B' }}>
                {btn.label}
              </span>
              {/* Barra de progresso: cresce da esquerda → direita, visível apenas no alvo ativo */}
              {active && phase === 'collecting' && (
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, height: 4,
                  background: locked ? '#22C55E' : '#475569',
                  borderRadius: '0 0 16px 16px',
                  width: `${progress * 100}%`,
                  // transition só ativo quando estável — evita animação estranha durante instabilidade
                  transition: locked ? 'width 0.1s linear' : 'none',
                }} />
              )}
            </div>
          )
        })}
      </div>

      {/* Barra de categorias — espelha exatamente a nav do app */}
      <div style={{
        height: NAV_H, flexShrink: 0,
        borderTop: '1px solid #1E293B', display: 'flex',
      }}>
        {MOCK_CATS.map((cat, i) => {
          // gi: índice global (após os 6 botões de frase)
          const gi     = MOCK_PHRASES.length + i
          const active = phase !== 'waiting' && !isPhrase && i === catIdx
          const locked = active && phase === 'collecting' && isLocked
          return (
            <div
              key={i}
              ref={el => { targetRefs.current[gi] = el }}  // ref na posição global
              style={{
                flex: '0 0 auto', minWidth: 70,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 2,
                background: locked ? 'rgba(34,197,94,0.22)' : active ? 'rgba(37,99,235,0.25)' : 'transparent',
                border: `2px solid ${locked ? '#22C55E' : active ? '#60A5FA' : 'transparent'}`,
                borderRadius: 8, position: 'relative', overflow: 'hidden',
                boxShadow: locked ? '0 0 0 2px rgba(34,197,94,0.35)' : active ? '0 0 0 2px rgba(96,165,250,0.35)' : 'none',
                transition: 'border-color 0.15s, box-shadow 0.15s, background 0.15s',
              }}
            >
              <span style={{ fontSize: 22 }}>{cat.emoji}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: active ? '#E2E8F0' : '#475569' }}>
                {cat.label}
              </span>
              {active && phase === 'collecting' && (
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, height: 4,
                  background: locked ? '#22C55E' : '#475569',
                  width: `${progress * 100}%`,
                  transition: locked ? 'width 0.1s linear' : 'none',
                }} />
              )}
            </div>
          )
        })}
      </div>

      {/* Botão de escape para quem não consegue calibrar (ex: câmera com problema) */}
      <div style={{ textAlign: 'center', padding: '4px 0 10px', flexShrink: 0 }}>
        <button onClick={onSkip} style={{
          background: 'none', border: 'none', color: '#475569',
          fontSize: 13, cursor: 'pointer', textDecoration: 'underline',
        }}>
          Pular calibração
        </button>
      </div>
    </div>
  )
}

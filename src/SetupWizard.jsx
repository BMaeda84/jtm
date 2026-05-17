// ─────────────────────────────────────────────────────────────────────────────
// SetupWizard.jsx — Fluxo de configuração inicial do app JTM
//
// VISÃO GERAL DO FLUXO:
//   Exibido na primeira abertura do app (quando 'jtm_setup_done' não existe
//   no localStorage). Guia o usuário por uma sequência de telas:
//
//   [welcome] → escolha do modo:
//     ├── Toque → marca setup como feito → entra no app
//     ├── Varredura → [scan-trigger] → escolhe gatilho → entra no app
//     └── Rastreamento ocular → [calibration] → coleta dados → [done] → entra no app
//
// COMPONENTES:
//   SetupWizard      — controlador de fluxo (gerencia a máquina de estados de steps)
//   ScanTriggerStep  — seleção do gatilho de varredura (piscar / boca / automático)
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
import { useFaceTracking } from './useFaceTracking'
import { fitTransform, saveTransform, saveTremorProfile, clearTransform, clearTremorProfile } from './calibration'
import './SetupWizard.css'

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

// ─────────────────────────────────────────────────────────────────────────────
// SetupWizard — controlador do fluxo de onboarding
//
// Props:
//   onComplete({ mode, trigger?, calibrated? }) — chamado ao fim do setup
//     mode: 'touch' | 'scan' | 'gaze'
//     trigger: 'blink'|'mouth'|'auto' (só para mode='scan')
//     calibrated: boolean (só para mode='gaze')
// ─────────────────────────────────────────────────────────────────────────────
export function SetupWizard({ onComplete }) {
  // Máquina de estados do wizard: tela atual sendo exibida
  const [step, setStep] = useState('welcome') // 'welcome' | 'scan-trigger' | 'calibration' | 'done'

  // Usuário escolheu toque — modo mais simples, sem câmera
  function chooseTouch() {
    markSetupDone()
    onComplete({ mode: 'touch' })
  }

  // Avança para escolha de gatilho de varredura
  function chooseScanning() {
    setStep('scan-trigger')
  }

  // Usuário confirmou o gatilho de varredura; salva e entra no app
  function confirmScanning(trigger) {
    markSetupDone()
    onComplete({ mode: 'scan', trigger })
  }

  // Avança para a tela de calibração ocular
  function chooseGaze() {
    setStep('calibration')
  }

  // Calibração concluída com sucesso — salva os dados e vai para tela "done"
  function onCalibDone(transform, tremorProfile) {
    saveTransform(transform)       // persiste a matriz afim em localStorage
    saveTremorProfile(tremorProfile)  // persiste os params do One Euro Filter
    setStep('done')
  }

  // Usuário pulou a calibração — ainda pode usar o olhar, mas sem precisão garantida
  function onCalibSkip() {
    markSetupDone()
    onComplete({ mode: 'gaze', calibrated: false })
  }

  // Tela "done" → botão de entrada no app
  function finishGaze() {
    markSetupDone()
    onComplete({ mode: 'gaze', calibrated: true })
  }

  // Renderiza o step atual
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
      <div className="wizard-logo">JTM</div>
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

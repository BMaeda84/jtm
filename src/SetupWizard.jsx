import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { useFaceTracking } from './useFaceTracking'
import { fitTransform, saveTransform, saveTremorProfile } from './calibration'
import './SetupWizard.css'

const SETUP_KEY  = 'jtm_setup_done'
const WARMUP_MS        = 400
const STABILITY_WINDOW = 15    // frames in rolling iris buffer (~250ms at 60fps)
const STABILITY_THR    = 0.018 // max combined XY stddev to be considered "stable"
const STABLE_NEEDED    = 20    // stable frames required to confirm each target
const PASSES           = 2

// Mock layout matching the real app structure so target positions are accurate
const MOCK_PHRASES = [
  { label: 'Sim',     emoji: '✅' },
  { label: 'Não',     emoji: '❌' },
  { label: 'Ajuda',   emoji: '🆘' },
  { label: 'Água',    emoji: '💧' },
  { label: 'Comida',  emoji: '🍽️' },
  { label: 'Banheiro',emoji: '🚽' },
]
const MOCK_CATS = [
  { label: 'Essencial',   emoji: '🆘' },
  { label: 'Preciso',     emoji: '🍽️' },
  { label: 'Sentimentos', emoji: '😊' },
  { label: 'Pessoas',     emoji: '👤' },
  { label: 'Digitar',     emoji: '✏️' },
]
const TOTAL_TARGETS = MOCK_PHRASES.length + MOCK_CATS.length

const TRIGGER_OPTIONS = [
  { id: 'blink', icon: '😉', title: 'Piscar',    hint: 'Pisque intencionalmente para selecionar um botão' },
  { id: 'mouth', icon: '😮', title: 'Boca',      hint: 'Abra a boca por um instante para selecionar' },
  { id: 'auto',  icon: '⏱️', title: 'Automático', hint: 'Seleciona sozinho — não precisa de nenhum movimento' },
]

export function needsSetup() {
  return !localStorage.getItem(SETUP_KEY)
}

export function markSetupDone() {
  localStorage.setItem(SETUP_KEY, '1')
}

export function resetSetup() {
  localStorage.removeItem(SETUP_KEY)
}

// ─────────────────────────────────────────────
export function SetupWizard({ onComplete }) {
  const [step, setStep] = useState('welcome') // welcome | scan-trigger | calibration | done

  function chooseTouch() {
    markSetupDone()
    onComplete({ mode: 'touch' })
  }

  function chooseScanning() {
    setStep('scan-trigger')
  }

  function confirmScanning(trigger) {
    markSetupDone()
    onComplete({ mode: 'scan', trigger })
  }

  function chooseGaze() {
    setStep('calibration')
  }

  function onCalibDone(transform, tremorProfile) {
    saveTransform(transform)
    saveTremorProfile(tremorProfile)
    setStep('done')
  }

  function onCalibSkip() {
    markSetupDone()
    onComplete({ mode: 'gaze', calibrated: false })
  }

  function finishGaze() {
    markSetupDone()
    onComplete({ mode: 'gaze', calibrated: true })
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

// ─────────────────────────────────────────────
function ScanTriggerStep({ onConfirm, onBack }) {
  const [selected, setSelected] = useState('blink')
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

// Maps per-target iris stddev values to One Euro Filter params
function computeTremorProfile(variances) {
  if (!variances.length) return { minCutoff: 0.5, beta: 1.6 }
  const sorted = [...variances].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const LOW = 0.006, HIGH = 0.020
  const t = Math.max(0, Math.min(1, (median - LOW) / (HIGH - LOW)))
  // More tremor (t→1) → lower minCutoff (more baseline smoothing)
  return { minCutoff: parseFloat((0.70 - t * 0.45).toFixed(3)), beta: 1.6 }
}

// ─────────────────────────────────────────────
function CalibrationStep({ onDone, onSkip }) {
  const [targetIdx, setTargetIdx] = useState(0)
  const [pass,      setPass]      = useState(0)
  const [phase,     setPhase]     = useState('waiting') // waiting | warmup | collecting
  const [progress,  setProgress]  = useState(0)
  const [isLocked,  setIsLocked]  = useState(false) // true when gaze is stably on target

  const targetRefs   = useRef([])
  const positions    = useRef([])  // {x,y} screen-normalized, set after layout
  const samplesRef   = useRef([])  // stable iris samples for current target
  const allDataRef   = useRef([])  // accumulated (screen, iris) pairs across all targets
  const irisWindowRef = useRef([]) // rolling buffer for stability detection
  const stableCountRef = useRef(0) // stable frames accumulated for current target
  const varDataRef   = useRef([])  // per-target stddev for tremor profiling
  const phaseStart   = useRef(0)

  const { rawGaze, status, videoRef } = useFaceTracking(true)

  // Measure button centres after first paint
  useLayoutEffect(() => {
    positions.current = targetRefs.current.map(el => {
      const r = el.getBoundingClientRect()
      return {
        x: (r.left + r.width  / 2) / window.innerWidth,
        y: (r.top  + r.height / 2) / window.innerHeight,
      }
    })
  }, [])

  // Start warmup once camera is active
  useEffect(() => {
    if (status === 'active' && positions.current.length > 0) {
      phaseStart.current = performance.now()
      setPhase('warmup')
    }
  }, [status])

  // Main calibration loop — runs on every iris update
  useEffect(() => {
    if (!rawGaze || status !== 'active' || phase === 'waiting') return

    const now = performance.now()

    if (phase === 'warmup') {
      if (now - phaseStart.current >= WARMUP_MS) {
        irisWindowRef.current = []
        stableCountRef.current = 0
        samplesRef.current = []
        phaseStart.current = now
        setPhase('collecting')
      }
      return
    }

    // ── collecting: only count stable fixation frames ──
    const win = irisWindowRef.current
    win.push({ x: rawGaze.x, y: rawGaze.y })
    if (win.length > STABILITY_WINDOW) win.shift()
    if (win.length < STABILITY_WINDOW) return  // wait until buffer is full

    // Compute combined XY standard deviation of the rolling window
    const n  = win.length
    const mx = win.reduce((s, p) => s + p.x, 0) / n
    const my = win.reduce((s, p) => s + p.y, 0) / n
    const vx = win.reduce((s, p) => s + (p.x - mx) ** 2, 0) / n
    const vy = win.reduce((s, p) => s + (p.y - my) ** 2, 0) / n
    const stddev = Math.sqrt(vx + vy)

    const stable = stddev < STABILITY_THR
    setIsLocked(stable)

    if (stable) {
      stableCountRef.current++
      samplesRef.current.push({ x: rawGaze.x, y: rawGaze.y })
    }

    const pct = Math.min(stableCountRef.current / STABLE_NEEDED, 1)
    setProgress(pct)
    if (pct < 1) return

    // ── target confirmed — record data ──
    varDataRef.current.push(stddev)
    const m   = samplesRef.current.length
    const avg = samplesRef.current.reduce(
      (a, s) => ({ x: a.x + s.x / m, y: a.y + s.y / m }),
      { x: 0, y: 0 }
    )
    allDataRef.current.push({ screen: positions.current[targetIdx], iris: avg })

    // Reset for next target
    irisWindowRef.current  = []
    stableCountRef.current = 0
    samplesRef.current     = []

    const nextIdx = targetIdx + 1
    if (nextIdx < TOTAL_TARGETS) {
      setTargetIdx(nextIdx)
      setProgress(0)
      setIsLocked(false)
      setPhase('warmup')
      phaseStart.current = now
      return
    }

    const nextPass = pass + 1
    if (nextPass < PASSES) {
      setPass(nextPass)
      setTargetIdx(0)
      setProgress(0)
      setIsLocked(false)
      setPhase('warmup')
      phaseStart.current = now
      return
    }

    // ── all passes done — fit transform + tremor profile ──
    const irisPoints   = allDataRef.current.map(d => d.iris)
    const screenPoints = allDataRef.current.map(d => d.screen)
    onDone(fitTransform(irisPoints, screenPoints), computeTremorProfile(varDataRef.current))
  }, [rawGaze]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalSteps  = TOTAL_TARGETS * PASSES
  const currentStep = pass * TOTAL_TARGETS + targetIdx + 1
  const isPhrase    = targetIdx < MOCK_PHRASES.length
  const catIdx      = targetIdx - MOCK_PHRASES.length

  const instruction = status === 'loading' ? '⏳ Iniciando câmera...'
    : status === 'error'  ? '❌ Câmera indisponível.'
    : phase === 'waiting' ? '⏳ Aguardando câmera...'
    : phase === 'warmup'  ? 'Olhe para o botão destacado'
    : isLocked            ? 'Perfeito — mantendo o olhar...'
    : 'Fixe o olhar no botão'

  // Exact production layout constants (mirrors App.css CSS variables)
  const HEADER_H = 56, NAV_H = 72, GAP = 10

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#0F172A',
      display: 'flex', flexDirection: 'column',
      maxWidth: 600, margin: '0 auto',
    }}>
      {/* Camera preview */}
      <video ref={videoRef} autoPlay playsInline muted style={{
        position: 'absolute', bottom: NAV_H + 10, right: 10,
        width: 80, height: 60, borderRadius: 6, zIndex: 10,
        border: '2px solid #60A5FA', objectFit: 'cover',
      }} />

      {/* Header */}
      <div style={{
        height: HEADER_H, flexShrink: 0, background: '#0F172A',
        borderBottom: '1px solid #1E293B',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 12px',
      }}>
        <span style={{ color: isLocked ? '#22C55E' : '#94A3B8', fontSize: 13, transition: 'color 0.2s' }}>
          {instruction}
        </span>
        <span style={{ color: '#475569', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          {pass + 1}/{PASSES} · {currentStep}/{totalSteps}
        </span>
      </div>

      {/* Phrase grid — mirrors production: 2 cols, 1fr rows, gap/padding 10px */}
      <div style={{
        flex: 1, overflow: 'hidden',
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        gridAutoRows: '1fr',
        gap: GAP, padding: GAP,
      }}>
        {MOCK_PHRASES.map((btn, i) => {
          const active  = phase !== 'waiting' && isPhrase && i === targetIdx
          const locked  = active && phase === 'collecting' && isLocked
          return (
            <div
              key={i}
              ref={el => { targetRefs.current[i] = el }}
              style={{
                borderRadius: 16,
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
              {active && phase === 'collecting' && (
                <div style={{
                  position: 'absolute', bottom: 0, left: 0, height: 4,
                  background: locked ? '#22C55E' : '#475569',
                  borderRadius: '0 0 16px 16px',
                  width: `${progress * 100}%`,
                  transition: locked ? 'width 0.1s linear' : 'none',
                }} />
              )}
            </div>
          )
        })}
      </div>

      {/* Category nav — mirrors production: height 72px, flex row */}
      <div style={{
        height: NAV_H, flexShrink: 0,
        borderTop: '1px solid #1E293B', display: 'flex',
      }}>
        {MOCK_CATS.map((cat, i) => {
          const gi     = MOCK_PHRASES.length + i
          const active = phase !== 'waiting' && !isPhrase && i === catIdx
          const locked = active && phase === 'collecting' && isLocked
          return (
            <div
              key={i}
              ref={el => { targetRefs.current[gi] = el }}
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

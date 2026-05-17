import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { categories as baseCategories } from './phrases'
import { useVoice, speak as speakNative } from './useVoice'
import { useSettings } from './useSettings'
import { isPiperCached, downloadPiper, speakWithPiper } from './piperTTS'
import { useFaceTracking } from './useFaceTracking'
import { useScanning } from './useScanning'
import { GazeCursor } from './GazeCursor'
import { SetupWizard, needsSetup, resetSetup } from './SetupWizard'
import { loadTransform, loadTremorProfile } from './calibration'
import { useBattery } from './useBattery'
import { useFallDetection, getDeviceType, requestMotionPermission } from './useFallDetection'
import './App.css'

const DIGITAR_ID = '__digitar__'
const FAVORITOS_ID = '__favoritos__'

export default function AppRoot() {
  const [showSetup, setShowSetup] = useState(() => needsSetup())

  function handleSetupComplete({ mode, trigger }) {
    if (mode === 'scan') {
      localStorage.setItem('jtm_scan', 'true')
      if (trigger) localStorage.setItem('jtm_scan_trigger', JSON.stringify(trigger))
    } else if (mode === 'gaze') {
      localStorage.setItem('jtm_gaze', 'true')
    }
    setShowSetup(false)
  }

  if (showSetup) return <SetupWizard onComplete={handleSetupComplete} />
  return <App onResetSetup={() => { resetSetup(); setShowSetup(true) }} />
}

function App({ onResetSetup }) {
  const [activeCategoryId, setActiveCategoryId] = useState(baseCategories[0].id)
  const [lastSpoken, setLastSpoken] = useState(null)
  const [showVoicePicker, setShowVoicePicker] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [piperState, setPiperState] = useState('checking')
  const [downloadProgress, setDownloadProgress] = useState(0)
  const { voices, selectedVoice, setSelectedVoice } = useVoice()
  const {
    speechRate, setSpeechRate,
    darkMode, setDarkMode,
    gazeEnabled, setGazeEnabled, dwellTime, setDwellTime,
    scanEnabled, setScanEnabled, scanSpeed, setScanSpeed, scanTrigger, setScanTrigger,
    favorites, toggleFavorite, history, addToHistory,
  } = useSettings()

  const usingPiper  = piperState === 'ready'
  const faceEnabled = gazeEnabled || scanEnabled

  // ── Battery ──────────────────────────────────
  const battery = useBattery()
  const batteryLow = battery && battery.level < 0.2 && !battery.charging

  // ── Fall detection ───────────────────────────
  const [fellAlert, setFellAlert] = useState(null) // null | deviceType string
  const fallRepeatRef = useRef(null)

  function speakFallPhrase(device) {
    const phrase = `Por favor, me ajude, meu ${device} caiu`
    if (usingPiper) speakWithPiper(phrase, speechRate).catch(() => speakNative(phrase, selectedVoice, speechRate))
    else speakNative(phrase, selectedVoice, speechRate)
  }

  useFallDetection((device) => {
    setFellAlert(device)
    speakFallPhrase(device)
    if (fallRepeatRef.current) clearInterval(fallRepeatRef.current)
    fallRepeatRef.current = setInterval(() => speakFallPhrase(device), 18000)
  }, faceEnabled)

  function dismissFall() {
    setFellAlert(null)
    if (fallRepeatRef.current) { clearInterval(fallRepeatRef.current); fallRepeatRef.current = null }
  }

  useEffect(() => () => {
    if (fallRepeatRef.current) clearInterval(fallRepeatRef.current)
  }, [])

  const calibTransform = useMemo(() => gazeEnabled ? loadTransform()     : null, [gazeEnabled])
  const tremorProfile  = useMemo(() => gazeEnabled ? loadTremorProfile() : null, [gazeEnabled])
  const { gazePoint, blinkCount, mouthCount, status: faceStatus, videoRef: faceVideoRef } = useFaceTracking(faceEnabled, 1.8, calibTransform, tremorProfile)

  useEffect(() => {
    isPiperCached().then(cached => setPiperState(cached ? 'ready' : 'prompt'))
  }, [])

  async function handleDownloadPiper() {
    setPiperState('downloading')
    setDownloadProgress(0)
    try {
      await downloadPiper(p => {
        const pct = Math.round((p.loaded / p.total) * 100)
        setDownloadProgress(isNaN(pct) ? 0 : pct)
      })
      setPiperState('ready')
    } catch {
      setPiperState('error')
    }
  }

  const handleSpeakRef = useRef(null)
  const handleSpeak = useCallback((phrase, label, emoji, btn) => {
    if (navigator.vibrate) navigator.vibrate(40)
    setLastSpoken({ label, phrase, emoji })
    addToHistory({ label, phrase, emoji })
    if (usingPiper) {
      speakWithPiper(phrase, speechRate).catch(() => speakNative(phrase, selectedVoice, speechRate))
    } else {
      speakNative(phrase, selectedVoice, speechRate)
    }
  }, [usingPiper, selectedVoice, speechRate, addToHistory])

  useEffect(() => { handleSpeakRef.current = handleSpeak }, [handleSpeak])

  const handleGazeDwell = useCallback((el) => {
    if (el.dataset.gazeAction === 'category') {
      setActiveCategoryId(el.dataset.gazeCategoryId)
    } else {
      handleSpeakRef.current?.(el.dataset.gazePhrase, el.dataset.gazeLabel, el.dataset.gazeEmoji)
    }
  }, [setActiveCategoryId])

  const handleScanSelect = useCallback((btn) => {
    handleSpeakRef.current?.(btn.phrase, btn.label, btn.emoji)
  }, [])

  useEffect(() => {
    if (!lastSpoken) return
    const t = setTimeout(() => setLastSpoken(null), 3000)
    return () => clearTimeout(t)
  }, [lastSpoken])

  const favoritesCategory = {
    id: FAVORITOS_ID,
    label: 'Favoritos',
    emoji: '⭐',
    color: '#D97706',
    buttons: baseCategories.flatMap(c => c.buttons).filter(b => favorites.has(b.phrase)),
  }

  const categories = [
    ...(favoritesCategory.buttons.length > 0 ? [favoritesCategory] : []),
    ...baseCategories,
  ]

  const activeCategory = categories.find(c => c.id === activeCategoryId) ?? categories[0]
  const isDigitar = activeCategoryId === DIGITAR_ID

  const { activeIndex: scanIndex } = useScanning({
    buttons: scanEnabled ? activeCategory.buttons : [],
    enabled: scanEnabled,
    scanSpeed,
    trigger: scanTrigger,
    blinkCount,
    mouthCount,
    onSelect: handleScanSelect,
  })

  return (
    <div className="app" data-dark={darkMode}>
      <header className="app-header">
        <span className="app-logo">JTM</span>
        <span className={`speaking-indicator${lastSpoken ? ' visible' : ''}`}>
          🔊 {lastSpoken?.label}
        </span>
        <div className="header-actions">
          {usingPiper && <span className="piper-badge">Piper</span>}
          {faceEnabled && (
            <span className={`gaze-badge gaze-${faceStatus}`}>
              {{ idle: '👁️', loading: '⏳', active: '👁️✓', error: '👁️✗' }[faceStatus]}
            </span>
          )}
          <button className="icon-btn" onClick={() => setShowHistory(true)} title="Histórico">🕐</button>
          <button className="icon-btn" onClick={() => setShowSettings(true)} title="Configurações">⚙️</button>
        </div>
      </header>

      {/* Hidden video element — React manages lifecycle, avoids Strict Mode issues */}
      {faceEnabled && (
        <video
          ref={faceVideoRef}
          autoPlay playsInline muted
          style={{ position: 'fixed', top: -9999, left: -9999, width: 320, height: 240, pointerEvents: 'none' }}
        />
      )}

      {piperState === 'prompt' && (
        <div className="piper-banner">
          <div className="piper-banner-text">
            <strong>Voz melhorada disponível</strong>
            <span>Download único de ~63MB. Recomendado em Wi-Fi.</span>
          </div>
          <div className="piper-banner-actions">
            <button className="piper-btn-secondary" onClick={() => setPiperState('dismissed')}>Agora não</button>
            <button className="piper-btn-primary" onClick={handleDownloadPiper}>Baixar</button>
          </div>
        </div>
      )}

      {piperState === 'downloading' && (
        <div className="piper-banner">
          <div className="piper-banner-text">
            <strong>Baixando voz... {downloadProgress}%</strong>
            <span>Não feche o app durante o download.</span>
          </div>
          <div className="piper-progress-bar">
            <div className="piper-progress-fill" style={{ width: `${downloadProgress}%` }} />
          </div>
        </div>
      )}

      {piperState === 'error' && (
        <div className="piper-error">
          ⚠️ Falha no download.{' '}
          <button onClick={handleDownloadPiper}>Tentar novamente</button>
        </div>
      )}

      {lastSpoken && (
        <button className="repetir-bar" onClick={() => handleSpeak(lastSpoken.phrase, lastSpoken.label, lastSpoken.emoji)}>
          <span className="repetir-emoji">{lastSpoken.emoji}</span>
          <span className="repetir-text">Repetir: <strong>{lastSpoken.label}</strong></span>
          <span className="repetir-icon">🔁</span>
        </button>
      )}

      {isDigitar ? (
        <TextInput onSpeak={handleSpeak} />
      ) : (
        <main className="phrase-grid">
          {batteryLow && activeCategoryId === 'essencial' && (
            <div
              className="phrase-btn-wrap battery-alert"
              data-gaze
              data-gaze-phrase={`Minha bateria está fraca. Por favor, me ajude a recarregar o ${getDeviceType()}`}
              data-gaze-label="Bateria fraca"
              data-gaze-emoji="🪫"
            >
              <button
                className="phrase-btn-main"
                onClick={() => handleSpeak(
                  `Minha bateria está fraca. Por favor, me ajude a recarregar o ${getDeviceType()}`,
                  'Bateria fraca', '🪫'
                )}
              >
                <span className="phrase-emoji">🪫</span>
                <span className="phrase-label">Bateria fraca</span>
                <span className="battery-pct">{Math.round(battery.level * 100)}%</span>
              </button>
            </div>
          )}
          {activeCategory.buttons.length === 0 && (
            <div className="empty-state">
              <span>Nenhum favorito ainda.</span>
              <span>Toque ⭐ em qualquer frase para salvar aqui.</span>
            </div>
          )}
          {activeCategory.buttons.map((btn, i) => (
            <PhraseButton
              key={btn.phrase}
              {...btn}
              categoryColor={activeCategory.color}
              isFavorite={favorites.has(btn.phrase)}
              isScanning={scanEnabled && scanIndex === i}
              onSpeak={handleSpeak}
              onToggleFavorite={toggleFavorite}
            />
          ))}
        </main>
      )}

      <nav className="category-nav">
        {categories.map((cat) => (
          <button
            key={cat.id}
            className={`cat-btn${activeCategoryId === cat.id ? ' active' : ''}`}
            style={{ '--cat-color': cat.color }}
            onClick={() => setActiveCategoryId(cat.id)}
            data-gaze
            data-gaze-action="category"
            data-gaze-category-id={cat.id}
          >
            <span className="cat-emoji">{cat.emoji}</span>
            <span className="cat-label">{cat.label}</span>
          </button>
        ))}
        <button
          className={`cat-btn${isDigitar ? ' active' : ''}`}
          style={{ '--cat-color': '#6366F1' }}
          onClick={() => setActiveCategoryId(DIGITAR_ID)}
          data-gaze
          data-gaze-action="category"
          data-gaze-category-id={DIGITAR_ID}
        >
          <span className="cat-emoji">✏️</span>
          <span className="cat-label">Digitar</span>
        </button>
      </nav>

      {gazeEnabled && (
        <GazeCursor
          gazePoint={gazePoint}
          dwellTime={dwellTime}
          onDwell={handleGazeDwell}
          faceDetected={faceStatus === 'active'}
        />
      )}

      {showHistory && (
        <HistorySheet
          history={history}
          onSpeak={(item) => { handleSpeak(item.phrase, item.label, item.emoji); setShowHistory(false) }}
          onClose={() => setShowHistory(false)}
        />
      )}

      {fellAlert && (
        <div className="fall-overlay" onClick={dismissFall}>
          <div className="fall-card" onClick={e => e.stopPropagation()}>
            <span className="fall-icon">📱</span>
            <p className="fall-text">Por favor, me ajude,<br />meu {fellAlert} caiu</p>
            <button className="fall-dismiss" onClick={dismissFall}>Estou bem ✓</button>
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsSheet
          onResetSetup={onResetSetup}
          speechRate={speechRate}
          onRateChange={setSpeechRate}
          darkMode={darkMode}
          onDarkModeChange={setDarkMode}
          gazeEnabled={gazeEnabled}
          onGazeChange={setGazeEnabled}
          dwellTime={dwellTime}
          onDwellChange={setDwellTime}
          scanEnabled={scanEnabled}
          onScanChange={setScanEnabled}
          scanSpeed={scanSpeed}
          onScanSpeedChange={setScanSpeed}
          scanTrigger={scanTrigger}
          onScanTriggerChange={setScanTrigger}
          usingPiper={usingPiper}
          voices={voices}
          selectedVoice={selectedVoice}
          onSelectVoice={setSelectedVoice}
          onPreviewVoice={v => speakNative('Olá, eu sou a voz que vai te ajudar.', v, speechRate)}
          onRequestMotion={requestMotionPermission}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

function PhraseButton({ label, emoji, phrase, categoryColor, isFavorite, isScanning, onSpeak, onToggleFavorite }) {
  const [pressed, setPressed] = useState(false)

  function handlePress() {
    setPressed(true)
    onSpeak(phrase, label, emoji)
    setTimeout(() => setPressed(false), 200)
  }

  return (
    <div
      className={`phrase-btn-wrap${pressed ? ' pressed' : ''}${isScanning ? ' scanning' : ''}`}
      style={{ '--category-color': categoryColor }}
      data-gaze
      data-gaze-phrase={phrase}
      data-gaze-label={label}
      data-gaze-emoji={emoji}
    >
      <button className="phrase-btn-main" onClick={handlePress}>
        <span className="phrase-emoji">{emoji}</span>
        <span className="phrase-label">{label}</span>
      </button>
      <button
        className={`fav-btn${isFavorite ? ' active' : ''}`}
        onClick={() => onToggleFavorite(phrase)}
      >
        {isFavorite ? '⭐' : '☆'}
      </button>
    </div>
  )
}

function TextInput({ onSpeak }) {
  const [text, setText] = useState('')
  const inputRef = useRef(null)

  function handleSpeak() {
    const trimmed = text.trim()
    if (!trimmed) return
    onSpeak(trimmed, trimmed, '✏️')
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSpeak()
    }
  }

  return (
    <div className="text-input-area">
      <p className="text-input-hint">Digite qualquer frase e toque em Falar</p>
      <textarea
        ref={inputRef}
        className="text-input-field"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKey}
        placeholder="Ex: Estou com sede..."
        rows={4}
        maxLength={500}
        autoFocus
      />
      <button
        className="text-input-speak"
        onClick={handleSpeak}
        disabled={!text.trim()}
      >
        🔊 Falar
      </button>
    </div>
  )
}

function HistorySheet({ history, onSpeak, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="voice-sheet" onClick={e => e.stopPropagation()}>
        <div className="voice-sheet-header">
          <span>Histórico</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        {history.length === 0 && (
          <p className="voice-empty">Nenhuma frase falada ainda.</p>
        )}
        <ul className="history-list">
          {history.map((item, i) => (
            <li key={i}>
              <button className="history-item" onClick={() => onSpeak(item)}>
                <span className="history-emoji">{item.emoji}</span>
                <span className="history-label">{item.label}</span>
                <span className="history-play">🔁</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function SettingsSheet({ onResetSetup, speechRate, onRateChange, darkMode, onDarkModeChange, gazeEnabled, onGazeChange, dwellTime, onDwellChange, scanEnabled, onScanChange, scanSpeed, onScanSpeedChange, scanTrigger, onScanTriggerChange, usingPiper, voices, selectedVoice, onSelectVoice, onPreviewVoice, onRequestMotion, onClose }) {
  const [motionPerm, setMotionPerm] = useState(null)
  const needsMotionPerm = typeof DeviceMotionEvent?.requestPermission === 'function'
  const rateLabels = { 0.5: 'Muito lento', 0.7: 'Lento', 0.85: 'Normal', 1.0: 'Rápido', 1.2: 'Muito rápido' }
  const closestLabel = Object.entries(rateLabels).reduce((best, [k, v]) =>
    Math.abs(k - speechRate) < Math.abs(best[0] - speechRate) ? [k, v] : best, [0.85, 'Normal'])[1]

  return (
    <div className="overlay" onClick={onClose}>
      <div className="voice-sheet" onClick={e => e.stopPropagation()}>
        <div className="voice-sheet-header">
          <span>Configurações</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body">
          <div className="settings-section">
            <label className="settings-label">Velocidade da voz — <strong>{closestLabel}</strong></label>
            <input
              type="range"
              min="0.5" max="1.2" step="0.05"
              value={speechRate}
              onChange={e => onRateChange(parseFloat(e.target.value))}
              className="rate-slider"
            />
            <div className="rate-slider-ends">
              <span>🐢 Lento</span>
              <span>Rápido 🐇</span>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-row">
              <div>
                <span className="settings-label">Varredura automática</span>
                <p className="settings-hint">Os botões acendem em sequência. Selecione com piscar, boca ou automaticamente.</p>
              </div>
              <button className={`toggle-btn${scanEnabled ? ' on' : ''}`} onClick={() => onScanChange(!scanEnabled)}>
                {scanEnabled ? '✓ Ativo' : 'Inativo'}
              </button>
            </div>
            {scanEnabled && (
              <>
                <label className="settings-label">Gatilho de seleção</label>
                <div className="trigger-options">
                  {[
                    { id: 'blink', label: '😉 Piscar', hint: 'Pisque para selecionar' },
                    { id: 'mouth', label: '😮 Boca',   hint: 'Abra a boca para selecionar' },
                    { id: 'auto',  label: '⏱️ Auto',   hint: 'Seleciona sozinho — zero movimento' },
                  ].map(opt => (
                    <button
                      key={opt.id}
                      className={`trigger-btn${scanTrigger === opt.id ? ' active' : ''}`}
                      onClick={() => onScanTriggerChange(opt.id)}
                    >
                      <span>{opt.label}</span>
                      <small>{opt.hint}</small>
                    </button>
                  ))}
                </div>
                <label className="settings-label">
                  Velocidade — <strong>{(scanSpeed / 1000).toFixed(1)}s por botão</strong>
                </label>
                <input
                  type="range" min="800" max="5000" step="200"
                  value={scanSpeed}
                  onChange={e => onScanSpeedChange(Number(e.target.value))}
                  className="rate-slider"
                />
                <div className="rate-slider-ends"><span>Rápido</span><span>Lento</span></div>
              </>
            )}
          </div>

          <div className="settings-section">
            <div className="settings-row">
              <div>
                <span className="settings-label">Rastreamento ocular</span>
                <p className="settings-hint">Mova o olhar para mover o cursor. Fixe o olhar por alguns segundos para ativar.</p>
              </div>
              <button className={`toggle-btn${gazeEnabled ? ' on' : ''}`} onClick={() => onGazeChange(!gazeEnabled)}>
                {gazeEnabled ? '👁️ Ativo' : '👁️ Inativo'}
              </button>
            </div>
            {gazeEnabled && (
              <>
                <label className="settings-label">
                  Tempo para ativar — <strong>{(dwellTime / 1000).toFixed(1)}s</strong>
                </label>
                <input
                  type="range" min="800" max="3000" step="100"
                  value={dwellTime}
                  onChange={e => onDwellChange(Number(e.target.value))}
                  className="rate-slider"
                />
                <div className="rate-slider-ends"><span>Rápido (0.8s)</span><span>Lento (3s)</span></div>
              </>
            )}
          </div>

          <div className="settings-section">
            <div className="settings-row">
              <span className="settings-label">Modo escuro</span>
              <button
                className={`toggle-btn${darkMode ? ' on' : ''}`}
                onClick={() => onDarkModeChange(!darkMode)}
              >
                {darkMode ? '🌙 Ativo' : '☀️ Inativo'}
              </button>
            </div>
          </div>

          {!usingPiper && voices.length > 0 && (
            <div className="settings-section">
              <label className="settings-label">Voz do sistema</label>
              <ul className="voice-list">
                {voices.map(v => (
                  <li key={v.name}>
                    <button
                      className={`voice-item${selectedVoice?.name === v.name ? ' selected' : ''}`}
                      onClick={() => onSelectVoice(v)}
                    >
                      <span className="voice-name">{v.name}</span>
                      <span className="voice-lang">{v.lang}</span>
                    </button>
                    <button className="voice-preview-btn" onClick={() => onPreviewVoice(v)}>▶</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {needsMotionPerm && motionPerm !== 'granted' && (
            <div className="settings-section">
              <div className="settings-row">
                <div>
                  <span className="settings-label">Detecção de queda</span>
                  <p className="settings-hint">
                    {motionPerm === 'denied'
                      ? 'Permissão negada. Ative o sensor de movimento nas configurações do iOS.'
                      : 'Permite detectar se o aparelho caiu e alertar automaticamente.'}
                  </p>
                </div>
                <button
                  className={`toggle-btn${motionPerm === 'granted' ? ' on' : ''}`}
                  onClick={() => onRequestMotion().then(p => setMotionPerm(p))}
                >
                  {motionPerm === 'denied' ? '⚠️ Negado' : '📡 Ativar'}
                </button>
              </div>
            </div>
          )}

          <div className="settings-section">
            <div className="settings-row">
              <div>
                <span className="settings-label">Modo de controle</span>
                <p className="settings-hint">Refazer a configuração inicial (toque, varredura ou olhos).</p>
              </div>
              <button className="toggle-btn" onClick={() => { onClose(); onResetSetup() }}>
                Reconfigurar
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


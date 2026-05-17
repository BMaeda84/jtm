// ─────────────────────────────────────────────────────────────────────────────
// App.jsx — Componente raiz e lógica principal do app JTM
//
// ARQUITETURA:
//   AppRoot  — guarda de setup: decide se mostra SetupWizard ou App
//   App      — interface principal de comunicação (CAA)
//     ├── PhraseButton   — botão de frase individual com favorito
//     ├── TextInput      — campo de texto livre para frases personalizadas
//     ├── HistorySheet   — sheet de histórico de frases recentes
//     └── SettingsSheet  — painel de configurações (voz, rastreamento, varredura)
//
// FLUXO DE FALA:
//   1. Usuário ativa um botão (toque / dwell / varredura)
//   2. handleSpeak() é chamado com (phrase, label, emoji)
//   3. Se Piper estiver pronto (usingPiper=true): speakWithPiper() com fallback nativo
//   4. Caso contrário: speakNative() com a voz do sistema selecionada
//   5. Navigator.vibrate(40ms) fornece feedback háptico no mobile
//   6. lastSpoken é atualizado → barra "Repetir" aparece por 3 segundos
//   7. addToHistory() registra no histórico em memória (máx 10)
//
// MODOS DE INTERAÇÃO:
//   - Toque direto: padrão universal, sem câmera
//   - Rastreamento ocular (gazeEnabled): useFaceTracking → GazeCursor → dwell
//   - Varredura (scanEnabled): useScanning → realce visual → disparo por piscar/boca/auto
//   faceEnabled = gazeEnabled || scanEnabled — ativa a câmera para ambos os modos
//   ATENÇÃO: faceEnabled deve ser declarado ANTES de useFallDetection()
//   (evita TDZ — Temporal Dead Zone — ao referenciar const antes da declaração)
//
// DETECÇÃO DE QUEDA:
//   Ativa somente quando faceEnabled=true (usuário com mobilidade limitada).
//   Ao detectar queda: exibe overlay vermelho + fala a frase a cada 18s até dispensado.
//   Implementado em useFallDetection() via acelerômetro do dispositivo.
//
// BATERIA FRACA:
//   useBattery() monitora nivel e estado de carregamento.
//   Quando bateria < 20% e não carregando: botão extra aparece na categoria "Essencial".
//   O botão fala uma frase pedindo ajuda para recarregar, identificando o tipo de device.
//
// PIPER TTS:
//   Na montagem, verifica se o modelo neural já foi baixado (isPiperCached).
//   Se não: exibe banner solicitando download (~63MB, único).
//   Após download ou se já cacheado: piperState='ready', usingPiper=true.
//   A fala nativa (useVoice/Web Speech API) é o fallback automático.
// ─────────────────────────────────────────────────────────────────────────────

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

// IDs virtuais de categorias geradas dinamicamente (não constam em phrases.js)
const DIGITAR_ID    = '__digitar__'     // tela de entrada de texto livre
const FAVORITOS_ID  = '__favoritos__'   // categoria filtrada dos botões favoritados

// ─────────────────────────────────────────────────────────────────────────────
// AppRoot — guarda de rota: setup ou app principal
//
// Verifica localStorage na montagem para saber se o setup já foi feito.
// Após o setup, passa as escolhas do usuário gravando-as em localStorage
// (jtm_gaze / jtm_scan / jtm_scan_trigger) para que useSettings() as leia.
// ─────────────────────────────────────────────────────────────────────────────
export default function AppRoot() {
  const [showSetup, setShowSetup] = useState(() => needsSetup())

  function handleSetupComplete({ mode, trigger }) {
    if (mode === 'scan') {
      // Persiste o modo de varredura e o gatilho escolhido
      localStorage.setItem('jtm_scan', 'true')
      if (trigger) localStorage.setItem('jtm_scan_trigger', JSON.stringify(trigger))
    } else if (mode === 'gaze') {
      // Persiste que o rastreamento ocular está ativado
      localStorage.setItem('jtm_gaze', 'true')
    }
    setShowSetup(false)
  }

  if (showSetup) return <SetupWizard onComplete={handleSetupComplete} />
  return <App onResetSetup={() => { resetSetup(); setShowSetup(true) }} />
}

// ─────────────────────────────────────────────────────────────────────────────
// App — componente principal da interface de CAA
//
// Props:
//   onResetSetup — callback que restaura o estado inicial (volta ao wizard)
// ─────────────────────────────────────────────────────────────────────────────
function App({ onResetSetup }) {
  // ── Estado da UI ──────────────────────────────────────────────────────────
  const [activeCategoryId, setActiveCategoryId] = useState(baseCategories[0].id)
  const [lastSpoken, setLastSpoken] = useState(null)       // {label, phrase, emoji} | null
  const [showVoicePicker, setShowVoicePicker] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  // ── Estado do Piper TTS ───────────────────────────────────────────────────
  // 'checking'    → verificando cache (montagem)
  // 'prompt'      → modelo não baixado, exibe banner
  // 'downloading' → download em progresso
  // 'ready'       → modelo disponível, usando Piper
  // 'error'       → download falhou
  // 'dismissed'   → usuário dispensou o banner (usa voz nativa)
  const [piperState, setPiperState] = useState('checking')
  const [downloadProgress, setDownloadProgress] = useState(0)

  // ── Hooks de voz e configurações ─────────────────────────────────────────
  const { voices, selectedVoice, setSelectedVoice } = useVoice()
  const {
    speechRate, setSpeechRate,
    darkMode, setDarkMode,
    gazeEnabled, setGazeEnabled, dwellTime, setDwellTime,
    scanEnabled, setScanEnabled, scanSpeed, setScanSpeed, scanTrigger, setScanTrigger,
    favorites, toggleFavorite, history, addToHistory,
  } = useSettings()

  const usingPiper = piperState === 'ready'

  // faceEnabled: determina se a câmera deve ser ligada.
  // DEVE ser declarado ANTES de useFallDetection para evitar TDZ ReferenceError.
  //
  // Auto-varredura avança por timer — não precisa de câmera para detecção de gesto.
  // Piscar/boca precisam do MediaPipe; por isso só ligamos a câmera nesses casos.
  const faceEnabled = gazeEnabled || (scanEnabled && scanTrigger !== 'auto')

  // ── Bateria ───────────────────────────────────────────────────────────────
  // battery: { level: 0–1, charging: boolean } | null
  const battery = useBattery()
  const batteryLow = battery && battery.level < 0.2 && !battery.charging

  // ── Detecção de queda ─────────────────────────────────────────────────────
  // fellAlert: null = sem alerta ativo | string = tipo de device ('celular'|'tablet')
  const [fellAlert, setFellAlert] = useState(null)
  const fallRepeatRef = useRef(null)  // referência ao setInterval de repetição de fala

  // Sintetiza a frase de alerta de queda usando Piper ou voz nativa
  function speakFallPhrase(device) {
    const phrase = `Por favor, me ajude, meu ${device} caiu`
    if (usingPiper) speakWithPiper(phrase, speechRate).catch(() => speakNative(phrase, selectedVoice, speechRate))
    else speakNative(phrase, selectedVoice, speechRate)
  }

  // Callback de queda: ativa o overlay e repete a frase a cada 18 segundos
  useFallDetection((device) => {
    setFellAlert(device)
    speakFallPhrase(device)
    if (fallRepeatRef.current) clearInterval(fallRepeatRef.current)
    // Intervalo de 18s: tempo suficiente para quem está próximo ouvir e reagir
    fallRepeatRef.current = setInterval(() => speakFallPhrase(device), 18000)
  }, faceEnabled)  // detector ativo somente quando câmera está ativa

  // Dispensar o alerta de queda (botão "Estou bem ✓")
  function dismissFall() {
    setFellAlert(null)
    if (fallRepeatRef.current) { clearInterval(fallRepeatRef.current); fallRepeatRef.current = null }
  }

  // Cleanup do interval ao desmontar o componente
  useEffect(() => () => {
    if (fallRepeatRef.current) clearInterval(fallRepeatRef.current)
  }, [])

  // ── Rastreamento facial ───────────────────────────────────────────────────
  // Carregamos a transformação afim e o perfil de tremor do localStorage.
  // useMemo evita recarregar a cada render — só recarrega quando gazeEnabled muda.
  const calibTransform = useMemo(() => gazeEnabled ? loadTransform()     : null, [gazeEnabled])
  const tremorProfile  = useMemo(() => gazeEnabled ? loadTremorProfile() : null, [gazeEnabled])

  // useFaceTracking(ativo, maxRosto, calibTransform, tremorProfile)
  //   gazePoint   → {x,y} transformado para a tela (null se rosto não detectado)
  //   blinkCount  → contador crescente de piscadas (usado por useScanning)
  //   mouthCount  → contador crescente de abertura de boca
  //   faceStatus  → 'idle'|'loading'|'active'|'error'
  //   faceVideoRef → ref do elemento <video> (gerenciado por React)
  const { gazePoint, blinkCount, mouthCount, status: faceStatus, videoRef: faceVideoRef, diagSteps } =
    useFaceTracking(faceEnabled, 1.8, calibTransform, tremorProfile)

  // ── Diagnóstico de CSP na tela (temporário) ──────────────────────────────
  // Captura violações de Content-Security-Policy e exibe na tela junto com os
  // passos do init. Isso evita precisar de DevTools no celular para depurar.
  const [cspViolations, setCspViolations] = useState([])
  useEffect(() => {
    function onCspViolation(e) {
      const msg = `CSP: bloqueou ${e.blockedURI} em ${e.violatedDirective}`
      setCspViolations(prev => [...prev.slice(-4), msg])  // mantém últimas 5
    }
    document.addEventListener('securitypolicyviolation', onCspViolation)
    return () => document.removeEventListener('securitypolicyviolation', onCspViolation)
  }, [])

  // ── Verificação de cache do Piper na montagem ─────────────────────────────
  useEffect(() => {
    isPiperCached().then(cached => setPiperState(cached ? 'ready' : 'prompt'))
  }, [])

  // ── Download do modelo Piper ──────────────────────────────────────────────
  async function handleDownloadPiper() {
    setPiperState('downloading')
    setDownloadProgress(0)
    try {
      await downloadPiper(p => {
        // p = { loaded, total } — calculamos a porcentagem e truncamos para int
        const pct = Math.round((p.loaded / p.total) * 100)
        setDownloadProgress(isNaN(pct) ? 0 : pct)
      })
      setPiperState('ready')
    } catch {
      setPiperState('error')
    }
  }

  // ── handleSpeak — função central de fala ─────────────────────────────────
  // useCallback: memoiza a função para evitar que GazeCursor e useScanning
  // recebam uma referência nova a cada render (o que causaria re-renders desnecessários).
  //
  // handleSpeakRef: um ref que espelha a versão mais recente do callback.
  // Isso permite que closures antigas (ex: inside setInterval do fall detection)
  // sempre chamem a versão atualizada — sem precisar re-registrar o interval.
  const handleSpeakRef = useRef(null)
  const handleSpeak = useCallback((phrase, label, emoji, btn) => {
    if (navigator.vibrate) navigator.vibrate(40)  // feedback háptico 40ms
    setLastSpoken({ label, phrase, emoji })
    addToHistory({ label, phrase, emoji })
    if (usingPiper) {
      // Tenta Piper; se falhar (ex: modelo corrompido), usa voz nativa como fallback
      speakWithPiper(phrase, speechRate).catch(() => speakNative(phrase, selectedVoice, speechRate))
    } else {
      speakNative(phrase, selectedVoice, speechRate)
    }
  }, [usingPiper, selectedVoice, speechRate, addToHistory])

  // Mantém o ref atualizado sem re-executar efeitos que dependem dele
  useEffect(() => { handleSpeakRef.current = handleSpeak }, [handleSpeak])

  // ── Dwell handler — chamado pelo GazeCursor quando o dwell completa ───────
  // O elemento DOM (el) tem atributos data-gaze-* que codificam a ação:
  //   data-gaze-action="category" → troca de categoria (não fala)
  //   padrão                      → fala a frase codificada em data-gaze-phrase
  const handleGazeDwell = useCallback((el) => {
    if (el.dataset.gazeAction === 'category') {
      setActiveCategoryId(el.dataset.gazeCategoryId)
    } else {
      handleSpeakRef.current?.(el.dataset.gazePhrase, el.dataset.gazeLabel, el.dataset.gazeEmoji)
    }
  }, [setActiveCategoryId])

  // ── Scan select handler — chamado por useScanning quando um botão é selecionado
  const handleScanSelect = useCallback((btn) => {
    handleSpeakRef.current?.(btn.phrase, btn.label, btn.emoji)
  }, [])

  // ── Timer de exibição da barra "Repetir" ─────────────────────────────────
  // Limpa lastSpoken após 3 segundos para que a barra desapareça automaticamente
  useEffect(() => {
    if (!lastSpoken) return
    const t = setTimeout(() => setLastSpoken(null), 3000)
    return () => clearTimeout(t)
  }, [lastSpoken])

  // ── Categoria de favoritos ────────────────────────────────────────────────
  // Gerada dinamicamente: filtra todos os botões de todas as categorias
  // cujas frases estão no Set<favorites>. Aparece no início da nav quando não-vazia.
  const favoritesCategory = {
    id: FAVORITOS_ID,
    label: 'Favoritos',
    emoji: '⭐',
    color: '#D97706',
    buttons: baseCategories.flatMap(c => c.buttons).filter(b => favorites.has(b.phrase)),
  }

  // Lista final de categorias exibidas na nav (favoritos primeiro, se houver)
  const categories = [
    ...(favoritesCategory.buttons.length > 0 ? [favoritesCategory] : []),
    ...baseCategories,
  ]

  // Categoria ativa: busca pelo ID; se não encontrar (ex: favoritos esvaziados),
  // cai para a primeira disponível
  const activeCategory = categories.find(c => c.id === activeCategoryId) ?? categories[0]
  const isDigitar = activeCategoryId === DIGITAR_ID

  // ── Varredura ─────────────────────────────────────────────────────────────
  // useScanning avança o índice iluminado e detecta o disparo do gatilho.
  // Quando scanEnabled=false, passamos buttons=[] para que o hook se desative.
  const { activeIndex: scanIndex } = useScanning({
    buttons: scanEnabled ? activeCategory.buttons : [],
    enabled: scanEnabled,
    scanSpeed,
    trigger: scanTrigger,
    blinkCount,
    mouthCount,
    onSelect: handleScanSelect,
  })

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app" data-dark={darkMode}>

      {/* Header: logo, indicador de fala ativa, status da câmera, ações */}
      <header className="app-header">
        {/* Marca JTM: ícone olho + wordmark */}
        <div className="app-logo-wrap" aria-label="JTM — Comunicação Aumentativa e Alternativa">
          <img
            src={`${import.meta.env.BASE_URL}logo.svg`}
            alt=""
            aria-hidden="true"
            className="app-logo-img"
          />
          <span className="app-logo">JTM</span>
        </div>

        {/* Anunciado por leitores de tela quando uma frase é falada */}
        <span
          className={`speaking-indicator${lastSpoken ? ' visible' : ''}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          🔊 {lastSpoken?.label}
        </span>

        <div className="header-actions">
          {usingPiper && <span className="piper-badge" aria-label="Usando voz Piper neural">Piper</span>}
          {faceEnabled && (
            <span
              className={`gaze-badge gaze-${faceStatus}`}
              aria-label={`Câmera: ${{ idle: 'aguardando', loading: 'iniciando', active: 'ativa', error: 'erro' }[faceStatus]}`}
            >
              {{ idle: '👁️', loading: '⏳', active: '👁️✓', error: '👁️✗' }[faceStatus]}
            </span>
          )}
          <button
            className="icon-btn"
            onClick={() => setShowHistory(true)}
            aria-label="Ver histórico de frases"
          >🕐</button>
          <button
            className="icon-btn"
            onClick={() => setShowSettings(true)}
            aria-label="Abrir configurações"
          >⚙️</button>
        </div>
      </header>

      {/* Elemento de vídeo da câmera — posicionado fora da tela para ser invisível.
          Gerenciado pelo React para garantir que o lifecycle (montagem/desmontagem)
          esteja sincronizado com faceEnabled, evitando problemas do StrictMode. */}
      {faceEnabled && (
        <video
          ref={faceVideoRef}
          autoPlay playsInline muted
          style={{ position: 'fixed', top: -9999, left: -9999, width: 320, height: 240, pointerEvents: 'none' }}
        />
      )}

      {/* ── Painel de diagnóstico visual (temporário) ───────────────────────
          Exibe os passos do init e violações de CSP diretamente na tela para
          depurar sem precisar de DevTools em celular. Removível após diagnóstico. */}
      {faceEnabled && faceStatus !== 'active' && (diagSteps.length > 0 || cspViolations.length > 0) && (
        <div style={{
          position: 'fixed', top: 60, left: 0, right: 0, zIndex: 999,
          background: 'rgba(0,0,0,0.85)', color: '#a3e635', fontSize: 11,
          fontFamily: 'monospace', padding: '8px 12px', maxHeight: '40vh', overflowY: 'auto',
        }}>
          <div style={{ color: '#facc15', marginBottom: 4 }}>── init steps ──</div>
          {diagSteps.map((s, i) => <div key={i}>{s}</div>)}
          {cspViolations.length > 0 && (
            <>
              <div style={{ color: '#f87171', marginTop: 6, marginBottom: 4 }}>── CSP violations ──</div>
              {cspViolations.map((v, i) => <div key={i}>{v}</div>)}
            </>
          )}
        </div>
      )}

      {/* Banner de download do Piper — exibido na primeira abertura */}
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

      {/* Barra de progresso do download */}
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

      {/* Erro de download — permite tentar novamente */}
      {piperState === 'error' && (
        <div className="piper-error">
          ⚠️ Falha no download.{' '}
          <button onClick={handleDownloadPiper}>Tentar novamente</button>
        </div>
      )}

      {/* Barra de repetição — aparece 3s após cada fala e permite repetir com um toque */}
      {lastSpoken && (
        <button className="repetir-bar" onClick={() => handleSpeak(lastSpoken.phrase, lastSpoken.label, lastSpoken.emoji)}>
          <span className="repetir-emoji">{lastSpoken.emoji}</span>
          <span className="repetir-text">Repetir: <strong>{lastSpoken.label}</strong></span>
          <span className="repetir-icon">🔁</span>
        </button>
      )}

      {/* Área de conteúdo principal: grid de botões ou campo de texto livre */}
      {isDigitar ? (
        <TextInput onSpeak={handleSpeak} />
      ) : (
        <main className="phrase-grid">
          {/* Botão extra de bateria fraca — só na categoria "Essencial" quando crítico */}
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
                {/* Mostra o percentual atual para informar o cuidador */}
                <span className="battery-pct">{Math.round(battery.level * 100)}%</span>
              </button>
            </div>
          )}

          {/* Estado vazio: categoria de favoritos sem itens */}
          {activeCategory.buttons.length === 0 && (
            <div className="empty-state">
              <span>Nenhum favorito ainda.</span>
              <span>Toque ⭐ em qualquer frase para salvar aqui.</span>
            </div>
          )}

          {/* Botões de frase da categoria ativa */}
          {activeCategory.buttons.map((btn, i) => (
            <PhraseButton
              key={btn.phrase}
              {...btn}
              categoryColor={activeCategory.color}
              isFavorite={favorites.has(btn.phrase)}
              isScanning={scanEnabled && scanIndex === i}  // destaque visual de varredura
              onSpeak={handleSpeak}
              onToggleFavorite={toggleFavorite}
            />
          ))}
        </main>
      )}

      {/* Barra de navegação de categorias */}
      <nav className="category-nav">
        {categories.map((cat) => (
          <button
            key={cat.id}
            className={`cat-btn${activeCategoryId === cat.id ? ' active' : ''}`}
            style={{ '--cat-color': cat.color }}
            onClick={() => setActiveCategoryId(cat.id)}
            data-gaze                              // marcador para o GazeCursor encontrar via closest()
            data-gaze-action="category"            // instrui o dwell handler a trocar categoria
            data-gaze-category-id={cat.id}         // qual categoria ativar
          >
            <span className="cat-emoji">{cat.emoji}</span>
            <span className="cat-label">{cat.label}</span>
          </button>
        ))}
        {/* Botão "Digitar" — virtual, não existe em phrases.js */}
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

      {/* Cursor de olhar — só renderizado quando rastreamento ocular está ativo */}
      {gazeEnabled && (
        <GazeCursor
          gazePoint={gazePoint}
          dwellTime={dwellTime}
          onDwell={handleGazeDwell}
          faceDetected={faceStatus === 'active'}
        />
      )}

      {/* Histórico de frases recentes */}
      {showHistory && (
        <HistorySheet
          history={history}
          onSpeak={(item) => { handleSpeak(item.phrase, item.label, item.emoji); setShowHistory(false) }}
          onClose={() => setShowHistory(false)}
        />
      )}

      {/* Overlay de alerta de queda — tela cheia vermelha, bloqueante */}
      {fellAlert && (
        <div className="fall-overlay" onClick={dismissFall}>
          {/* Clique fora do card também dispensa — facilidade de acesso para cuidadores */}
          <div className="fall-card" onClick={e => e.stopPropagation()}>
            <span className="fall-icon">📱</span>
            <p className="fall-text">Por favor, me ajude,<br />meu {fellAlert} caiu</p>
            <button className="fall-dismiss" onClick={dismissFall}>Estou bem ✓</button>
          </div>
        </div>
      )}

      {/* Painel de configurações */}
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
          onRequestMotion={requestMotionPermission}  // iOS: exige user gesture para DeviceMotion
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PhraseButton — botão de frase individual
//
// Responsabilidades:
//   - Exibe emoji grande + label
//   - Animação de "pressed" ao ativar (200ms)
//   - Destaque visual quando está sendo varrido (isScanning)
//   - Botão ⭐ de favorito no canto
//   - Expõe atributos data-gaze-* para o GazeCursor
// ─────────────────────────────────────────────────────────────────────────────
function PhraseButton({ label, emoji, phrase, categoryColor, isFavorite, isScanning, onSpeak, onToggleFavorite }) {
  const [pressed, setPressed] = useState(false)

  function handlePress() {
    setPressed(true)
    onSpeak(phrase, label, emoji)
    setTimeout(() => setPressed(false), 200)  // duração da animação de press
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
      <button
        className="phrase-btn-main"
        onClick={handlePress}
        aria-label={phrase}
      >
        <span className="phrase-emoji" aria-hidden="true">{emoji}</span>
        <span className="phrase-label">{label}</span>
      </button>
      <button
        className={`fav-btn${isFavorite ? ' active' : ''}`}
        onClick={() => onToggleFavorite(phrase)}
        aria-label={isFavorite ? `Remover "${label}" dos favoritos` : `Adicionar "${label}" aos favoritos`}
        aria-pressed={isFavorite}
      >
        <span aria-hidden="true">{isFavorite ? '⭐' : '☆'}</span>
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TextInput — campo de digitação livre para frases personalizadas
//
// maxLength={500}: limite de segurança contra input excessivo (OWASP A03).
// Enter sem Shift confirma e fala; Shift+Enter insere quebra de linha.
// ─────────────────────────────────────────────────────────────────────────────
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
        maxLength={500}  // limita input — segurança e usabilidade (frase TTS não deve ser muito longa)
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

// ─────────────────────────────────────────────────────────────────────────────
// HistorySheet — exibe as últimas frases faladas (máx 10, sem persistência)
//
// O histórico é mantido apenas em memória (useSettings → history).
// Não persiste entre sessões — é uma lista de consulta rápida para repetição.
// ─────────────────────────────────────────────────────────────────────────────
function HistorySheet({ history, onSpeak, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      {/* Clique fora do sheet fecha o painel */}
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

// ─────────────────────────────────────────────────────────────────────────────
// SettingsSheet — painel de configurações do app
//
// Agrupa todas as opções ajustáveis pelo usuário:
//   - Velocidade da voz (slider 0.5–1.2)
//   - Varredura automática (on/off + gatilho + velocidade)
//   - Rastreamento ocular (on/off + tempo de dwell)
//   - Modo escuro
//   - Seleção de voz do sistema (quando Piper não está disponível)
//   - Permissão de movimento do iOS (DeviceMotion para detecção de queda)
//   - Reconfigurar modo de controle (volta ao wizard)
//
// rateLabels: mapeia valores de speechRate para labels legíveis.
//   closestLabel encontra o label mais próximo do valor atual usando reduce.
//
// needsMotionPerm: verdadeiro apenas no iOS 13+, onde DeviceMotionEvent.requestPermission
//   é uma função (no Android esta propriedade não existe).
// ─────────────────────────────────────────────────────────────────────────────
function SettingsSheet({ onResetSetup, speechRate, onRateChange, darkMode, onDarkModeChange, gazeEnabled, onGazeChange, dwellTime, onDwellChange, scanEnabled, onScanChange, scanSpeed, onScanSpeedChange, scanTrigger, onScanTriggerChange, usingPiper, voices, selectedVoice, onSelectVoice, onPreviewVoice, onRequestMotion, onClose }) {
  // Estado local da permissão de movimento iOS — null=não solicitada, 'granted', 'denied'
  const [motionPerm, setMotionPerm] = useState(null)

  // Detecta se estamos no iOS 13+ (única plataforma com requestPermission)
  const needsMotionPerm = typeof DeviceMotionEvent?.requestPermission === 'function'

  // Mapeamento de valores de speechRate para labels amigáveis
  const rateLabels = { 0.5: 'Muito lento', 0.7: 'Lento', 0.85: 'Normal', 1.0: 'Rápido', 1.2: 'Muito rápido' }

  // Encontra o label cujo valor numérico é mais próximo do speechRate atual
  // reduce: acumula o par [chave, label] com menor distância ao valor atual
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
          {/* ── Velocidade da voz ── */}
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

          {/* ── Varredura automática ── */}
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

          {/* ── Rastreamento ocular ── */}
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

          {/* ── Modo escuro ── */}
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

          {/* ── Seleção de voz do sistema (só quando Piper não está ativo) ── */}
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

          {/* ── Permissão de movimento iOS — necessário para detecção de queda ── */}
          {/* Só aparece no iOS 13+ E enquanto a permissão ainda não foi concedida */}
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
                {/* O clique neste botão é o "user gesture" exigido pelo iOS para requestPermission */}
                <button
                  className={`toggle-btn${motionPerm === 'granted' ? ' on' : ''}`}
                  onClick={() => onRequestMotion().then(p => setMotionPerm(p))}
                >
                  {motionPerm === 'denied' ? '⚠️ Negado' : '📡 Ativar'}
                </button>
              </div>
            </div>
          )}

          {/* ── Reconfigurar modo de controle ── */}
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

// ─────────────────────────────────────────────────────────────────────────────
// useFaceTracking.js — Rastreamento facial com MediaPipe + One Euro Filter
//
// VISÃO GERAL DO PIPELINE:
//
//   Câmera → frames de vídeo → MediaPipe FaceLandmarker
//                                        ↓
//                             478 landmarks do rosto (pontos 3D)
//                                        ↓
//                        processGaze() → razões da íris (ratioX, ratioY)
//                                        ↓
//                        One Euro Filter → suavização adaptativa
//                                        ↓
//                        applyTransform() → coordenadas na tela (0–1)
//                                        ↓
//                             gazePoint → GazeCursor
//
// RESPONSABILIDADES DO HOOK:
//   - Gerenciar ciclo de vida da câmera (abrir/fechar stream)
//   - Carregar e executar o modelo de IA (MediaPipe)
//   - Extrair posição da íris e calcular razões de posição no olho
//   - Filtrar tremor com One Euro Filter personalizado por usuário
//   - Detectar piscadas (blink) e abertura da boca (jaw open)
//   - Expor rawGaze (pré-transformada) para coleta de dados de calibração
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react'
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { applyTransform } from './calibration'

// ── URLs externas ─────────────────────────────────────────────────────────────
// WASM: runtime do MediaPipe compilado em WebAssembly. Executa a rede neural
//       diretamente no navegador, sem enviar dados para servidores.
//       Versão pinada em @0.10.35 — não use @latest (risco de supply chain).
const WASM_URL  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'

// MODEL: arquivo do modelo de rede neural (float16 = metade da precisão = menor
//        tamanho, sem perda significativa de qualidade para detecção de landmarks).
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// ── Índices dos landmarks do MediaPipe ───────────────────────────────────────
// O FaceLandmarker detecta 478 pontos. Cada ponto é {x, y, z} normalizado
// (0–1 em relação ao tamanho da imagem). Usamos apenas os relevantes:

// Íris: centróide da íris, calculado pelo MediaPipe a partir dos landmarks
// das pálpebras. É o ponto mais preciso para rastreamento de olhar.
const LEFT_IRIS   = 468  // íris esquerda (do usuário)
const RIGHT_IRIS  = 473  // íris direita

// Cantos dos olhos: pontos nos tecidos moles, mas ancorados ao crânio.
// IMPORTANTE: usamos os CANTOS, não as pálpebras. Os cantos são estáveis
// mesmo durante piscadas e sono parcial — as pálpebras se movem, os cantos não.
// Isso é fundamental para a normalização do Y (ver processGaze abaixo).
const LEFT_EYE_L  = 33   // canto nasal (interno) do olho esquerdo
const LEFT_EYE_R  = 133  // canto temporal (externo) do olho esquerdo
const RIGHT_EYE_L = 362  // canto nasal do olho direito
const RIGHT_EYE_R = 263  // canto temporal do olho direito

// ─────────────────────────────────────────────────────────────────────────────
// ONE EURO FILTER
//
// Problema: o sinal da íris é ruidoso. Um filtro de média simples suaviza
// bem o tremor, mas atrasa movimentos rápidos (lag perceptível). Um filtro
// sem suavização responde rápido, mas treme.
//
// Solução: One Euro Filter (Casiez et al., 2012) — adapta dinamicamente
// a frequência de corte baseado na VELOCIDADE do sinal:
//
//   velocity baixa (olhar parado, tremor) → frequência de corte baixa → mais suavização
//   velocity alta (movimento intencional) → frequência de corte alta → responsivo
//
// PARÂMETROS:
//   minCutoff (Hz): suavização mínima quando parado. Padrão 0.5 Hz.
//                   Personalizado pelo perfil de tremor do usuário (calibração.js).
//   beta:           taxa de aumento da frequência de corte com a velocidade.
//                   Padrão 1.6. Valores maiores = mais responsivo a movimentos rápidos.
//   dCutoff (Hz):   frequência de corte do filtro de derivada (velocidade estimada).
//                   Fixo em 1.0 Hz — suaviza a estimativa de velocidade.
//
// MATEMÁTICA INTERNA:
//   alpha(cutoff, dt) = 1 / (1 + 1 / (2π · cutoff · dt))
//     → quanto maior a frequência de corte ou maior o dt, mais peso ao sinal novo
//
//   dxHat: estimativa suavizada da velocidade (derivada do sinal)
//   xHat:  estimativa suavizada do sinal
//
//   frequência de corte dinâmica = minCutoff + beta * |dxHat|
//     → quando está parado, |dxHat| ≈ 0, cutoff = minCutoff (máxima suavização)
//     → quando move rápido, |dxHat| cresce, cutoff cresce (menos suavização)
// ─────────────────────────────────────────────────────────────────────────────
function makeOneEuro({ minCutoff = 0.5, beta = 1.6, dCutoff = 1.0 } = {}) {
  let xHat = null  // estimativa filtrada atual (null = não inicializado)
  let dxHat = 0   // estimativa filtrada da derivada (velocidade)
  let tLast = null // timestamp do frame anterior (em segundos)

  // Calcula o coeficiente alpha do filtro exponencial para dados parâmetros.
  // alpha próximo de 1 = muito peso no sinal novo (pouca suavização).
  // alpha próximo de 0 = muito peso no histórico (muita suavização).
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt))

  return (x, t) => {
    const ts = t / 1000  // converte ms (performance.now()) para segundos

    // Primeiro frame: inicializa sem filtrar
    if (xHat === null) {
      xHat = x
      tLast = ts
      return x
    }

    const dt = Math.max(ts - tLast, 0.001)  // intervalo de tempo; mínimo 1ms para evitar divisão por zero
    tLast = ts

    // Estima a velocidade instantânea (derivada numérica)
    const dx = (x - xHat) / dt

    // Suaviza a estimativa de velocidade com frequência de corte dCutoff
    dxHat += alpha(dCutoff, dt) * (dx - dxHat)

    // Frequência de corte dinâmica: cresce com a velocidade do movimento
    const cutoff = minCutoff + beta * Math.abs(dxHat)

    // Aplica o filtro exponencial com a frequência de corte calculada
    xHat += alpha(cutoff, dt) * (x - xHat)

    return xHat
  }
}

// ── Limiares de detecção de gestos ───────────────────────────────────────────
// Blendshapes: scores de 0–1 que o MediaPipe calcula para expressões faciais.
// "eyeBlinkLeft/Right" → quão fechado está o olho.
// "jawOpen"            → quão aberta está a mandíbula.

const BLINK_THRESHOLD = 0.35   // score acima disso = olho considerado fechado
const BLINK_MIN_MS    = 60     // mínimo de 60ms fechado = piscada intencional (evita micro-piscadas involuntárias)
const BLINK_MAX_MS    = 1500   // máximo de 1.5s = acima disso assume sono, não seleção

const MOUTH_THRESHOLD = 0.22   // score de jawOpen acima disso = boca aberta intencionalmente
const MOUTH_MIN_MS    = 80     // deve ficar aberta pelo menos 80ms (filtra espirros, palavras involuntárias)

// ─────────────────────────────────────────────────────────────────────────────
// useFaceTracking(enabled, sensitivity, calibTransform, tremorProfile)
//
// Parâmetros:
//   enabled        — boolean: liga/desliga o tracker (câmera é fechada quando false)
//   sensitivity    — escala de movimento no fallback sem calibração (padrão 2.5)
//   calibTransform — objeto {a,b,c,d,e,f} da calibração afim (ou null)
//   tremorProfile  — objeto {minCutoff, beta} medido na calibração (ou null)
//
// NOTA IMPORTANTE sobre o videoRef:
//   O elemento <video> é CRIADO PELO COMPONENTE CHAMADOR via `ref={videoRef}`.
//   O hook não cria nem injeta o vídeo no DOM — apenas lê os frames.
//   Isso evita problemas com o React Strict Mode (que monta/desmonta duas vezes
//   em desenvolvimento para detectar efeitos colaterais).
// ─────────────────────────────────────────────────────────────────────────────
export function useFaceTracking(enabled, sensitivity = 2.5, calibTransform = null, tremorProfile = null) {
  const [gazePoint,  setGazePoint]  = useState(null)  // posição na tela (0–1), pós-transformada
  const [rawGaze,    setRawGaze]    = useState(null)  // razões da íris filtradas, PRÉ-transformada (usado na calibração)
  const [blinkCount, setBlinkCount] = useState(0)     // contador crescente de piscadas válidas
  const [mouthCount, setMouthCount] = useState(0)     // contador crescente de aberturas de boca válidas
  const [status,     setStatus]     = useState('idle') // 'idle' | 'loading' | 'active' | 'error'

  // ── Diagnóstico visual (temporário) ──────────────────────────────────────
  // Acumula mensagens de progresso de cada etapa do init para exibir na tela.
  // Útil para depurar tela em branco / travamento em dispositivos móveis sem DevTools.
  const [diagSteps, setDiagSteps] = useState([])
  // addStep: registra uma etapa com timestamp relativo ao início do init
  const diagStartRef = useRef(0)
  function addStep(msg) {
    const elapsed = ((Date.now() - diagStartRef.current) / 1000).toFixed(1)
    setDiagSteps(prev => [...prev, `+${elapsed}s ${msg}`])
    console.log('[JTM diag]', msg)
  }

  // Ref para calibTransform: permite atualizar sem reiniciar o efeito
  // (os filtros e a câmera continuam rodando; só o transform muda)
  const calibRef   = useRef(calibTransform)
  calibRef.current = calibTransform

  // Refs de infraestrutura
  const videoRef      = useRef(null)       // elemento <video> montado pelo componente pai
  const streamRef     = useRef(null)       // MediaStream da câmera (para poder fechar as tracks)
  const landmarkerRef = useRef(null)       // instância do FaceLandmarker
  const rafRef        = useRef(null)       // ID do requestAnimationFrame ativo

  // Um par de filtros One Euro: um para X, outro para Y do olhar
  const filterX = useRef(makeOneEuro())
  const filterY = useRef(makeOneEuro())

  // Estado das máquinas de estado de piscada e boca
  const blinkState = useRef({ closedAt: null })           // quando o olho fechou (null = aberto)
  const mouthState = useRef({ openAt: null, fired: false }) // quando a boca abriu; fired = evento já disparado

  useEffect(() => {
    // ── Desligamento ─────────────────────────────────────────────────────────
    if (!enabled) {
      setGazePoint(null)
      setStatus('idle')
      cleanup()
      return
    }

    // ── Personalização dos filtros pelo perfil de tremor ─────────────────────
    // Se o usuário calibrou com medição de tremor, usa os parâmetros medidos.
    // Caso contrário, usa os padrões (minCutoff=0.5, beta=1.6).
    const { minCutoff = 0.5, beta = 1.6 } = tremorProfile || {}
    filterX.current = makeOneEuro({ minCutoff, beta })
    filterY.current = makeOneEuro({ minCutoff, beta })

    let cancelled = false  // flag para abortar operações assíncronas se o efeito for desmontado
    setStatus('loading')
    setDiagSteps([])
    diagStartRef.current = Date.now()

    async function init() {
      try {
        addStep('aguardando videoRef...')
        // Aguarda até 2 segundos pelo elemento <video> ser montado no DOM.
        // O React monta o <video> no JSX do componente pai e atribui ao ref;
        // há uma janela de tempo entre o efeito rodar e o ref ser preenchido.
        const video = await waitForRef(videoRef, 2000)
        if (!video || cancelled) return
        addStep('videoRef OK, pedindo câmera...')

        // Solicita acesso à câmera frontal com resolução baixa (320×240).
        // Resolução menor = menos CPU/GPU = mais frames por segundo para o modelo.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        addStep('câmera OK, aguardando metadados...')

        streamRef.current = stream
        video.srcObject    = stream

        // Aguarda os metadados do vídeo (necessário para saber resolução)
        await new Promise(r => {
          if (video.readyState >= 1) { r(); return }
          video.onloadedmetadata = r
        })
        addStep('metadados OK, iniciando play()...')
        await video.play()
        addStep('play() OK, aguardando canplay...')

        // Aguarda o primeiro frame decodificado (readyState >= 2).
        // O MediaPipe só aceita frames quando há dados de imagem disponíveis.
        // Timeout de 8s para não travar se canplay não disparar (alguns browsers
        // disparam 'playing' em vez de 'canplay' dependendo do stream de câmera).
        await new Promise((resolve, reject) => {
          if (video.readyState >= 2) { resolve(); return }
          const tid = setTimeout(() => {
            // Se readyState ainda é 0 após 8s, provavelmente há problema real.
            // Se >= 1 (metadados OK mas sem frames), tentamos prosseguir assim mesmo.
            if (video.readyState >= 1) { addStep(`canplay timeout (readyState=${video.readyState}), continuando...`); resolve() }
            else reject(new Error(`canplay timeout após 8s (readyState=${video.readyState})`))
          }, 8000)
          video.addEventListener('canplay', () => { clearTimeout(tid); resolve() }, { once: true })
          // 'playing' também indica que frames estão chegando — aceita ambos
          video.addEventListener('playing', () => { clearTimeout(tid); resolve() }, { once: true })
        })
        if (cancelled) { cleanup(); return }
        addStep('vídeo pronto, baixando WASM MediaPipe...')

        // ── Carregamento do modelo MediaPipe ─────────────────────────────────
        // FilesetResolver baixa e configura o ambiente WASM.
        // FaceLandmarker detecta 478 landmarks + blendshapes em tempo real.
        //
        // delegate: 'GPU' usa WebGL para inferência na GPU (mais rápido).
        // Fallback para CPU se o dispositivo não suportar GPU delegate.
        const vision = await FilesetResolver.forVisionTasks(WASM_URL)
        addStep('WASM OK, criando FaceLandmarker (GPU)...')
        const opts = {
          baseOptions:          { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode:          'VIDEO',     // modo otimizado para frames sequenciais
          numFaces:             1,           // só rastreia um rosto (performance)
          outputFaceBlendshapes: true,       // gera scores de expressão (piscada, boca)
        }
        try {
          landmarkerRef.current = await FaceLandmarker.createFromOptions(vision, opts)
          addStep('FaceLandmarker GPU pronto!')
        } catch {
          // GPU delegate falhou (comum em alguns dispositivos Android antigos)
          addStep('GPU falhou, tentando CPU...')
          console.warn('[JTM] GPU delegate falhou, tentando CPU')
          landmarkerRef.current = await FaceLandmarker.createFromOptions(vision, {
            ...opts,
            baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
          })
          addStep('FaceLandmarker CPU pronto!')
        }
        if (cancelled) { cleanup(); return }

        setStatus('active')
        loop()  // inicia o ciclo de inferência frame a frame
      } catch (e) {
        console.error('[JTM] Erro no FaceTracking:', e)
        addStep(`ERRO: ${e.message}`)
        if (!cancelled) setStatus('error')
      }
    }

    // ── Loop de inferência ────────────────────────────────────────────────────
    // Roda em requestAnimationFrame — sincronizado com o refresh do display.
    // Em 60 Hz: ~16 ms por frame. O modelo MediaPipe leva ~10–20 ms por frame.
    function loop() {
      const video = videoRef.current
      if (!video || !landmarkerRef.current) return

      // readyState >= 2 (HAVE_CURRENT_DATA): há dados de imagem para processar
      if (video.readyState >= 2) {
        try {
          // detectForVideo retorna landmarks para o timestamp dado.
          // performance.now() em ms — o MediaPipe usa isso para sincronizar
          // a estimativa de posição com o tempo real do frame.
          const result = landmarkerRef.current.detectForVideo(video, performance.now())

          if (result.faceLandmarks?.length > 0) {
            // faceLandmarks[0] = array de 478 pontos {x, y, z} do primeiro rosto detectado
            processGaze(result.faceLandmarks[0])
          }
          if (result.faceBlendshapes?.length > 0) {
            // faceBlendshapes[0].categories = array de scores de expressão facial
            processGestures(result.faceBlendshapes[0].categories)
          }
        } catch (e) {
          console.warn('[JTM] Erro em detectForVideo:', e)
          // Continua o loop mesmo com erro de um frame
        }
      }
      rafRef.current = requestAnimationFrame(loop)
    }

    // ── Processamento da posição da íris ─────────────────────────────────────
    function processGaze(lm) {
      // Extrai os landmarks relevantes da íris e dos cantos dos olhos
      const lIris = lm[LEFT_IRIS],   rIris = lm[RIGHT_IRIS]
      const lEyeL = lm[LEFT_EYE_L],  lEyeR = lm[LEFT_EYE_R]
      const rEyeL = lm[RIGHT_EYE_L], rEyeR = lm[RIGHT_EYE_R]

      // Largura de cada olho em coordenadas normalizadas de imagem.
      // Usada para normalizar as posições da íris — assim o resultado
      // independe do tamanho do rosto na imagem (distância da câmera).
      // O fallback 0.001 evita divisão por zero se os cantos coincidirem.
      const lW = lEyeR.x - lEyeL.x || 0.001  // largura do olho esquerdo
      const rW = rEyeR.x - rEyeL.x || 0.001  // largura do olho direito

      // ── Cálculo da razão horizontal (X) ──────────────────────────────────
      // ratioX: posição horizontal da íris dentro do olho.
      //   0.0 = íris no canto nasal (olhando para o lado oposto)
      //   0.5 = íris centralizada (olhando para frente)
      //   1.0 = íris no canto temporal (olhando para o mesmo lado)
      //
      // Usamos a MÉDIA dos dois olhos para cancelar ruídos individuais
      // e obter uma estimativa mais estável do vetor de olhar.
      const lRatioX = (lIris.x - lEyeL.x) / lW
      const rRatioX = (rIris.x - rEyeL.x) / rW
      const ratioX  = (lRatioX + rRatioX) / 2

      // ── Cálculo da razão vertical (Y) ─────────────────────────────────────
      // DECISÃO TÉCNICA IMPORTANTE: usamos a linha média dos CANTOS do olho
      // como referência, em vez das pálpebras superior/inferior.
      //
      // Por quê? As pálpebras SE MOVEM com piscadas e meia-abertura dos olhos.
      // Se usarmos a pálpebra como referência vertical, a posição da íris sobe
      // e desce junto com a pálpebra — o cursor rastreia o piscar, não o olhar.
      //
      // Os cantos (33/133, 362/263) são ancorados no crânio e não se movem
      // com as pálpebras, tornando a referência estável.
      //
      // Normalizamos também pela LARGURA do olho (lW, rW) em vez da abertura
      // das pálpebras, porque a largura é mais estável entre piscadas.
      const lMidY   = (lEyeL.y + lEyeR.y) / 2                // Y médio dos cantos esquerdos
      const rMidY   = (rEyeL.y + rEyeR.y) / 2                // Y médio dos cantos direitos
      const lRatioY = (lIris.y - lMidY) / lW                  // desvio vertical normalizado (esquerdo)
      const rRatioY = (rIris.y - rMidY) / rW                  // desvio vertical normalizado (direito)
      const ratioY  = (lRatioY + rRatioY) / 2                  // média dos dois olhos

      // ── Filtragem com One Euro ────────────────────────────────────────────
      // Passa os valores crús pelos filtros adaptativos de cada eixo.
      // t = timestamp em ms (para calcular dt entre frames).
      const t  = performance.now()
      const fx = filterX.current(ratioX, t)
      const fy = filterY.current(ratioY, t)

      // ── rawGaze: coordenadas pré-transformada ─────────────────────────────
      // rawGaze é exposto para a calibração (SetupWizard.jsx) coletar amostras.
      // É essencial que a calibração e a produção usem EXATAMENTE o mesmo
      // espaço de coordenadas. O transform afim aprenderá automaticamente
      // o mapeamento correto, incluindo espelhamento da câmera se necessário.
      setRawGaze({ x: fx, y: fy })

      // ── Aplicação do transform ────────────────────────────────────────────
      if (calibRef.current) {
        // Modo calibrado: o transform afim mapeia fx,fy → posição na tela.
        // O transform foi treinado com esses mesmos valores (fx, fy),
        // então a consistência do espaço de coordenadas está garantida.
        setGazePoint(applyTransform(calibRef.current, { x: fx, y: fy }))
      } else {
        // Modo não calibrado (fallback heurístico):
        // ratioX está em [0, 1] centrado em 0.5.
        // A inversão (1 - ...) assume câmera espelhada (típico em selfie).
        // A multiplicação por sensitivity aumenta a amplitude do movimento.
        // ratioY está em [~-0.15, ~0.15]; multiplicamos para mapear para [0,1].
        //
        // Este modo é apenas para uso antes da calibração. A experiência
        // melhora dramaticamente após a calibração personalizada.
        const rawX = 1 - ((fx - 0.5) * sensitivity + 0.5)
        const rawY = fy * sensitivity * 3.5 + 0.5
        setGazePoint({
          x: Math.max(0, Math.min(1, rawX)),
          y: Math.max(0, Math.min(1, rawY)),
        })
      }
    }

    // ── Detecção de gestos (piscada e boca) ───────────────────────────────────
    function processGestures(cats) {
      // Busca o score de um blendshape pelo nome. Retorna 0 se não encontrado.
      const get = name => cats.find(c => c.categoryName === name)?.score ?? 0
      const now = performance.now()

      // ── Piscada ───────────────────────────────────────────────────────────
      // Usa a MÉDIA dos dois olhos para robustez — funciona mesmo que o usuário
      // tenha um olho parcialmente coberto ou com ptose (queda de pálpebra).
      const eyeClosed = (get('eyeBlinkLeft') + get('eyeBlinkRight')) / 2
      const bs = blinkState.current

      if (eyeClosed > BLINK_THRESHOLD) {
        // Olho fechado: registra o momento em que fechou (se ainda não registrado)
        if (!bs.closedAt) bs.closedAt = now
      } else if (bs.closedAt) {
        // Olho abriu: calcula a duração e decide se foi piscada válida
        const dur = now - bs.closedAt
        // Valida: ≥ 60ms (não é micro-tremedeira) E ≤ 1.5s (não é sono)
        if (dur >= BLINK_MIN_MS && dur <= BLINK_MAX_MS) {
          setBlinkCount(c => c + 1)  // incrementa contador; o useScanning reage
        }
        bs.closedAt = null  // reset: pronto para próxima piscada
      }

      // ── Boca ──────────────────────────────────────────────────────────────
      // jawOpen mede a abertura da mandíbula independente de outros movimentos faciais.
      const jaw = get('jawOpen')
      const ms  = mouthState.current

      if (jaw > MOUTH_THRESHOLD) {
        if (!ms.openAt) {
          ms.openAt = now   // registra momento em que a boca abriu
        } else if (now - ms.openAt >= MOUTH_MIN_MS && !ms.fired) {
          // Ficou aberta por tempo suficiente E ainda não disparou: dispara uma vez
          ms.fired = true
          setMouthCount(c => c + 1)
        }
        // Se ms.fired = true e a boca continua aberta, não dispara novamente
      } else {
        // Boca fechou: reset completo do estado
        ms.openAt = null
        ms.fired  = false
      }
    }

    init()

    // Função de limpeza: executada quando enabled muda ou componente desmonta
    return () => { cancelled = true; cleanup() }

  }, [enabled, sensitivity, tremorProfile]) // re-executa se qualquer um mudar

  // ── Limpeza de recursos ───────────────────────────────────────────────────
  // Para a câmera e libera o modelo de IA da memória.
  // IMPORTANTE: chamar landmarker.close() libera a memória WASM alocada.
  // Sem isso, o modelo fica em memória mesmo após o componente desmontar.
  function cleanup() {
    if (rafRef.current)        { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (landmarkerRef.current) { landmarkerRef.current.close(); landmarkerRef.current = null }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())  // libera o acesso à câmera
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null  // desanexa o stream do elemento de vídeo
    }
  }

  return { gazePoint, rawGaze, blinkCount, mouthCount, status, videoRef, diagSteps }
}

// ─────────────────────────────────────────────────────────────────────────────
// waitForRef(ref, timeoutMs)
//
// Aguarda até que ref.current seja preenchido (com polling de 30 ms).
// Necessário porque useEffect pode rodar antes do React anexar o ref ao DOM.
//
// Retorna: Promise<element> que resolve com o elemento, ou rejeita com timeout.
// ─────────────────────────────────────────────────────────────────────────────
function waitForRef(ref, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (ref.current) { resolve(ref.current); return }
    const deadline = Date.now() + timeoutMs
    const id = setInterval(() => {
      if (ref.current) {
        clearInterval(id)
        resolve(ref.current)
      } else if (Date.now() > deadline) {
        clearInterval(id)
        reject(new Error('Timeout: videoRef não foi montado a tempo'))
      }
    }, 30)
  })
}

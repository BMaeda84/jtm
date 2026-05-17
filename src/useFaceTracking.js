import { useState, useEffect, useRef } from 'react'
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { applyTransform } from './calibration'

const WASM_URL  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

const LEFT_IRIS   = 468, RIGHT_IRIS  = 473
const LEFT_EYE_L  = 33,  LEFT_EYE_R  = 133
const LEFT_EYE_T  = 159, LEFT_EYE_B  = 145
const RIGHT_EYE_L = 362, RIGHT_EYE_R = 263

// One Euro Filter — adapts smoothing to gaze velocity:
// slow movement (tremor) → heavy smoothing; fast movement → responsive
function makeOneEuro({ minCutoff = 0.5, beta = 1.6, dCutoff = 1.0 } = {}) {
  let xHat = null, dxHat = 0, tLast = null
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt))
  return (x, t) => {
    const ts = t / 1000
    if (xHat === null) { xHat = x; tLast = ts; return x }
    const dt  = Math.max(ts - tLast, 0.001)
    tLast = ts
    const dx  = (x - xHat) / dt
    dxHat    += alpha(dCutoff, dt) * (dx - dxHat)
    xHat     += alpha(minCutoff + beta * Math.abs(dxHat), dt) * (x - xHat)
    return xHat
  }
}

const BLINK_THRESHOLD = 0.35
const BLINK_MIN_MS    = 60
const BLINK_MAX_MS    = 1500
const MOUTH_THRESHOLD = 0.22
const MOUTH_MIN_MS    = 80

// videoRef is created here and returned — the caller must render:
//   <video ref={videoRef} autoPlay playsInline muted />
// This keeps the element in the React tree, avoiding Strict Mode / DOM issues.
export function useFaceTracking(enabled, sensitivity = 2.5, calibTransform = null) {
  const [gazePoint,  setGazePoint]  = useState(null)
  const [blinkCount, setBlinkCount] = useState(0)
  const [mouthCount, setMouthCount] = useState(0)
  const [status,     setStatus]     = useState('idle')

  const calibRef    = useRef(calibTransform)
  calibRef.current  = calibTransform

  const videoRef      = useRef(null)
  const streamRef     = useRef(null)
  const landmarkerRef = useRef(null)
  const rafRef        = useRef(null)
  const filterX       = useRef(makeOneEuro())
  const filterY       = useRef(makeOneEuro())
  const blinkState    = useRef({ closedAt: null })
  const mouthState    = useRef({ openAt: null, fired: false })

  useEffect(() => {
    if (!enabled) {
      setGazePoint(null)
      setStatus('idle')
      cleanup()
      return
    }

    filterX.current = makeOneEuro()
    filterY.current = makeOneEuro()

    let cancelled = false
    setStatus('loading')

    async function init() {
      try {
        // videoRef.current is the <video> element rendered in JSX by the caller.
        // Wait up to 2s for it to be mounted.
        const video = await waitForRef(videoRef, 2000)
        if (!video || cancelled) return

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }

        streamRef.current  = stream
        video.srcObject    = stream

        await new Promise(r => {
          if (video.readyState >= 1) { r(); return }
          video.onloadedmetadata = r
        })
        await video.play()
        await new Promise(r => {
          if (video.readyState >= 2) { r(); return }
          video.addEventListener('canplay', r, { once: true })
        })
        if (cancelled) { cleanup(); return }

        const vision = await FilesetResolver.forVisionTasks(WASM_URL)
        const opts = {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
        }
        try {
          landmarkerRef.current = await FaceLandmarker.createFromOptions(vision, opts)
        } catch {
          console.warn('[JTM] GPU delegate failed, retrying with CPU')
          landmarkerRef.current = await FaceLandmarker.createFromOptions(vision, {
            ...opts,
            baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
          })
        }
        if (cancelled) { cleanup(); return }

        setStatus('active')
        loop()
      } catch (e) {
        console.error('[JTM] FaceTracking error:', e)
        if (!cancelled) setStatus('error')
      }
    }

    function loop() {
      const video = videoRef.current
      if (!video || !landmarkerRef.current) return
      if (video.readyState >= 2) {
        try {
          const result = landmarkerRef.current.detectForVideo(video, performance.now())
          if (result.faceLandmarks?.length > 0)   processGaze(result.faceLandmarks[0])
          if (result.faceBlendshapes?.length > 0) processGestures(result.faceBlendshapes[0].categories)
        } catch (e) {
          console.warn('[JTM] detectForVideo error:', e)
        }
      }
      rafRef.current = requestAnimationFrame(loop)
    }

    function processGaze(lm) {
      const lIris = lm[LEFT_IRIS],   rIris = lm[RIGHT_IRIS]
      const lEyeL = lm[LEFT_EYE_L],  lEyeR = lm[LEFT_EYE_R]
      const lEyeT = lm[LEFT_EYE_T],  lEyeB = lm[LEFT_EYE_B]
      const rEyeL = lm[RIGHT_EYE_L], rEyeR = lm[RIGHT_EYE_R]

      const lW = lEyeR.x - lEyeL.x || 0.001
      const rW = rEyeR.x - rEyeL.x || 0.001
      const eH = lEyeB.y - lEyeT.y || 0.001

      const lRatioX = (lIris.x - lEyeL.x) / lW
      const rRatioX = (rIris.x - rEyeL.x) / rW
      const ratioX  = (lRatioX + rRatioX) / 2
      const ratioY  = (lIris.y - lEyeT.y) / eH

      // Feed raw iris ratios to the One Euro filter (no sensitivity scaling).
      // With calibration the transform handles all mapping — sensitivity would
      // corrupt the range the transform was trained on.
      const t  = performance.now()
      const fx = filterX.current(ratioX, t)
      const fy = filterY.current(ratioY, t)

      if (calibRef.current) {
        setGazePoint(applyTransform(calibRef.current, { x: fx, y: fy }))
      } else {
        // Uncalibrated fallback: apply mirror + sensitivity for rough mapping
        const rawX = 1 - ((fx - 0.5) * sensitivity + 0.5)
        const rawY =      (fy - 0.5) * sensitivity + 0.5
        setGazePoint({ x: Math.max(0, Math.min(1, rawX)), y: Math.max(0, Math.min(1, rawY)) })
      }
    }

    function processGestures(cats) {
      const get = name => cats.find(c => c.categoryName === name)?.score ?? 0
      const now = performance.now()

      const eyeClosed = (get('eyeBlinkLeft') + get('eyeBlinkRight')) / 2
      const bs = blinkState.current
      if (eyeClosed > BLINK_THRESHOLD) {
        if (!bs.closedAt) bs.closedAt = now
      } else if (bs.closedAt) {
        const dur = now - bs.closedAt
        if (dur >= BLINK_MIN_MS && dur <= BLINK_MAX_MS) setBlinkCount(c => c + 1)
        bs.closedAt = null
      }

      const jaw = get('jawOpen')
      const ms  = mouthState.current
      if (jaw > MOUTH_THRESHOLD) {
        if (!ms.openAt) ms.openAt = now
        else if (now - ms.openAt >= MOUTH_MIN_MS && !ms.fired) {
          ms.fired = true
          setMouthCount(c => c + 1)
        }
      } else {
        ms.openAt = null
        ms.fired  = false
      }
    }

    init()
    return () => { cancelled = true; cleanup() }
  }, [enabled, sensitivity])

  function cleanup() {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (landmarkerRef.current) { landmarkerRef.current.close(); landmarkerRef.current = null }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }

  return { gazePoint, blinkCount, mouthCount, status, videoRef }
}

function waitForRef(ref, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (ref.current) { resolve(ref.current); return }
    const deadline = Date.now() + timeoutMs
    const id = setInterval(() => {
      if (ref.current) { clearInterval(id); resolve(ref.current) }
      else if (Date.now() > deadline) { clearInterval(id); reject(new Error('videoRef timeout')) }
    }, 30)
  })
}

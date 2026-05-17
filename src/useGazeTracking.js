import { useState, useEffect, useRef } from 'react'
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// MediaPipe face landmark indices
const LEFT_IRIS    = 468
const RIGHT_IRIS   = 473
const LEFT_EYE_L   = 33
const LEFT_EYE_R   = 133
const LEFT_EYE_T   = 159
const LEFT_EYE_B   = 145
const RIGHT_EYE_L  = 362
const RIGHT_EYE_R  = 263

const WASM_URL  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const SMOOTHING = 0.2 // 0=no smoothing, 1=frozen

export function useGazeTracking(enabled, sensitivity = 2.5) {
  const [gazePoint, setGazePoint] = useState(null)  // { x, y } in 0–1
  const [status, setStatus]       = useState('idle') // idle|loading|active|error
  const landmarkerRef = useRef(null)
  const videoRef      = useRef(null)
  const rafRef        = useRef(null)
  const smooth        = useRef({ x: 0.5, y: 0.5 })

  useEffect(() => {
    if (!enabled) {
      setGazePoint(null)
      setStatus('idle')
      cleanup()
      return
    }

    let cancelled = false
    setStatus('loading')

    async function init() {
      try {
        // Camera
        const video = document.createElement('video')
        Object.assign(video, { autoplay: true, playsInline: true })
        video.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px'
        document.body.appendChild(video)
        videoRef.current = video

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: 320, height: 240 },
        })
        video.srcObject = stream
        await new Promise(r => { video.onloadedmetadata = r })
        await video.play()

        if (cancelled) { cleanup(); return }

        // MediaPipe
        const vision = await FilesetResolver.forVisionTasks(WASM_URL)
        const landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
        })
        landmarkerRef.current = landmarker

        if (cancelled) { cleanup(); return }
        setStatus('active')
        loop()
      } catch {
        if (!cancelled) setStatus('error')
      }
    }

    function loop() {
      if (!videoRef.current || !landmarkerRef.current) return

      const result = landmarkerRef.current.detectForVideo(videoRef.current, performance.now())

      if (result.faceLandmarks?.length > 0) {
        const lm = result.faceLandmarks[0]

        const lIris = lm[LEFT_IRIS],  rIris = lm[RIGHT_IRIS]
        const lEyeL = lm[LEFT_EYE_L], lEyeR = lm[LEFT_EYE_R]
        const lEyeT = lm[LEFT_EYE_T], lEyeB = lm[LEFT_EYE_B]
        const rEyeL = lm[RIGHT_EYE_L], rEyeR = lm[RIGHT_EYE_R]

        const lRatioX = (lIris.x - lEyeL.x) / (lEyeR.x - lEyeL.x)
        const rRatioX = (rIris.x - rEyeL.x) / (rEyeR.x - rEyeL.x)
        const ratioX  = (lRatioX + rRatioX) / 2
        const ratioY  = (lIris.y - lEyeT.y) / (lEyeB.y - lEyeT.y)

        // Invert X (camera mirror), apply sensitivity
        const rawX = 1 - ((ratioX - 0.5) * sensitivity + 0.5)
        const rawY =      (ratioY - 0.5) * sensitivity + 0.5

        const s = smooth.current
        s.x += SMOOTHING * (Math.max(0, Math.min(1, rawX)) - s.x)
        s.y += SMOOTHING * (Math.max(0, Math.min(1, rawY)) - s.y)

        setGazePoint({ x: s.x, y: s.y })
      }

      rafRef.current = requestAnimationFrame(loop)
    }

    init()
    return () => { cancelled = true; cleanup() }
  }, [enabled, sensitivity])

  function cleanup() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (landmarkerRef.current) { landmarkerRef.current.close(); landmarkerRef.current = null }
    if (videoRef.current) {
      videoRef.current.srcObject?.getTracks().forEach(t => t.stop())
      videoRef.current.remove()
      videoRef.current = null
    }
  }

  return { gazePoint, status }
}

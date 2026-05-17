import { useEffect, useRef, useState } from 'react'
import './GazeCursor.css'

const RADIUS = 30
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const COOLDOWN_MS = 700

export function GazeCursor({ gazePoint, dwellTime, onDwell, faceDetected }) {
  const [progress, setProgress] = useState(0)
  const state = useRef({ target: null, startTime: null, coolingDown: false })

  useEffect(() => {
    if (!gazePoint) return

    const px = gazePoint.x * window.innerWidth
    const py = gazePoint.y * window.innerHeight
    const el = document.elementFromPoint(px, py)
    const target = el?.closest('[data-gaze]') ?? null
    const s = state.current

    if (target !== s.target) {
      s.target    = target
      s.startTime = (target && !s.coolingDown) ? performance.now() : null
      setProgress(0)
    }

    if (s.startTime) {
      const p = Math.min((performance.now() - s.startTime) / dwellTime, 1)
      setProgress(p)
      if (p >= 1) {
        s.startTime    = null
        s.coolingDown  = true
        setProgress(0)
        onDwell(target)
        setTimeout(() => {
          s.coolingDown = false
          if (s.target) s.startTime = performance.now()
        }, COOLDOWN_MS)
      }
    }
  }, [gazePoint, dwellTime, onDwell])

  if (!gazePoint) {
    return faceDetected === false
      ? <div className="gaze-no-face">👁️ Posicione o rosto na frente da câmera</div>
      : null
  }

  const x = gazePoint.x * window.innerWidth
  const y = gazePoint.y * window.innerHeight
  const offset = CIRCUMFERENCE * (1 - progress)
  const size = RADIUS * 2 + 20

  return (
    <div className="gaze-cursor" style={{ left: x, top: y }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Outer ring background */}
        <circle
          cx={size / 2} cy={size / 2} r={RADIUS}
          fill="none"
          stroke="rgba(0,0,0,0.4)"
          strokeWidth={6}
        />
        {/* White border for contrast */}
        <circle
          cx={size / 2} cy={size / 2} r={RADIUS}
          fill="none"
          stroke="white"
          strokeWidth={3}
          opacity={0.6}
        />
        {/* Dwell progress ring */}
        {progress > 0 && (
          <circle
            cx={size / 2} cy={size / 2} r={RADIUS}
            fill="none"
            stroke="#FBBF24"
            strokeWidth={5}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
        {/* Center dot */}
        <circle cx={size / 2} cy={size / 2} r={6} fill="white" opacity={0.9} />
        <circle cx={size / 2} cy={size / 2} r={4} fill="#2563EB" />
      </svg>
    </div>
  )
}

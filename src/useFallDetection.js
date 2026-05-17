import { useEffect, useRef } from 'react'

export function getDeviceType() {
  const ua = navigator.userAgent.toLowerCase()
  if (/ipad/.test(ua)) return 'tablet'
  if (/android/.test(ua) && !/mobile/.test(ua)) return 'tablet'
  const minDim = Math.min(screen.width, screen.height)
  return minDim >= 600 ? 'tablet' : 'celular'
}

// iOS 13+ requires a user-gesture to request DeviceMotion permission.
// Call this from a button click handler; returns 'granted'|'denied'|'unavailable'.
export async function requestMotionPermission() {
  if (typeof DeviceMotionEvent?.requestPermission !== 'function') return 'unavailable'
  try {
    return await DeviceMotionEvent.requestPermission()
  } catch {
    return 'denied'
  }
}

// ── Algorithm ────────────────────────────────────────────────────────────────
// accelerationIncludingGravity: at rest ≈ 9.8 m/s², in free-fall ≈ 0.
// Pattern: [FREEFALL] mag < FREEFALL_THR for ≥ FREEFALL_MIN ms
//          [IMPACT]   mag > IMPACT_THR within IMPACT_WINDOW ms afterwards
//
// Tuned for short drops (20-40 cm from table / chest):
//   - 20 cm: fall time ≈ 200 ms, impact on soft surface ≈ 10-15 m/s²
//   - 40 cm: fall time ≈ 285 ms, impact on hard floor ≈ 100+ m/s²
//
const FREEFALL_THR  = 5.5   // m/s² — comfortably below resting G (9.8); catches partial free-falls
const IMPACT_THR    = 12    // m/s² — above resting G + typical motion noise; catches soft landings
const FREEFALL_MIN  = 35    // ms   — about 7 cm of drop already qualifies; very short drops included
const IMPACT_WINDOW = 600   // ms   — wait up to 600 ms after free-fall for the impact event
const COOLDOWN_MS   = 8000  // ms   — minimum interval between alerts (avoid repetition from bounces)

export function useFallDetection(onFall, enabled = true) {
  const onFallRef = useRef(onFall)
  onFallRef.current = onFall

  useEffect(() => {
    if (!enabled || !window.DeviceMotionEvent) return

    const deviceType = getDeviceType()

    // State: 'idle' | 'freefall' | 'impact_watch'
    let state        = 'idle'
    let phaseStart   = 0
    let cooldownUntil = 0

    function mag(e) {
      // Prefer accelerationIncludingGravity: reads ~9.8 at rest, ~0 in free-fall.
      // Fall back to linear acceleration only for impact detection (if aIG is missing).
      const aG = e.accelerationIncludingGravity
      if (aG && aG.x !== null) {
        return Math.sqrt((aG.x || 0) ** 2 + (aG.y || 0) ** 2 + (aG.z || 0) ** 2)
      }
      const a = e.acceleration
      if (a && a.x !== null) {
        return Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2)
      }
      return null
    }

    function fire(now) {
      state = 'idle'
      cooldownUntil = now + COOLDOWN_MS
      onFallRef.current(deviceType)
    }

    function handleMotion(e) {
      const m = mag(e)
      if (m === null) return
      const now = Date.now()
      if (now < cooldownUntil) return

      if (state === 'idle') {
        if (m < FREEFALL_THR) {
          state = 'freefall'
          phaseStart = now
        }
        return
      }

      if (state === 'freefall') {
        if (m >= FREEFALL_THR) {
          // Free-fall phase ended
          const dur = now - phaseStart
          if (dur >= FREEFALL_MIN) {
            // Long enough to count — now wait for the impact spike
            state = 'impact_watch'
            phaseStart = now
            // Impact may arrive in the same reading (hard floor)
            if (m > IMPACT_THR) { fire(now); return }
          } else {
            state = 'idle'
          }
        }
        return
      }

      if (state === 'impact_watch') {
        if (m > IMPACT_THR) {
          fire(now)
        } else if (now - phaseStart > IMPACT_WINDOW) {
          // Timed out — too soft or not a fall
          state = 'idle'
        }
      }
    }

    async function setup() {
      // iOS 13+ requires explicit permission (must be triggered from a user gesture;
      // if called from useEffect it may silently fail — see requestMotionPermission export)
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        try {
          const perm = await DeviceMotionEvent.requestPermission()
          if (perm !== 'granted') return
        } catch { return }
      }
      window.addEventListener('devicemotion', handleMotion)
    }

    setup()
    return () => window.removeEventListener('devicemotion', handleMotion)
  }, [enabled])
}

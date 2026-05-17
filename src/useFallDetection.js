import { useEffect, useRef } from 'react'

// Detects device type from userAgent and screen dimensions
export function getDeviceType() {
  const ua = navigator.userAgent.toLowerCase()
  if (/ipad/.test(ua)) return 'tablet'
  if (/android/.test(ua) && !/mobile/.test(ua)) return 'tablet'
  const minDim = Math.min(screen.width, screen.height)
  return minDim >= 600 ? 'tablet' : 'celular'
}

// Free-fall detection using DeviceMotion accelerometer.
// Pattern: near-zero acceleration (weightless during fall) followed by
// high-acceleration spike (impact). Both phases needed to avoid false positives.
export function useFallDetection(onFall, enabled = true) {
  const onFallRef = useRef(onFall)
  onFallRef.current = onFall

  useEffect(() => {
    if (!enabled || !window.DeviceMotionEvent) return

    const FREEFALL_THR  = 3    // m/s² — below this the device is nearly weightless
    const IMPACT_THR    = 22   // m/s² — above this after free-fall = impact
    const FREEFALL_MIN  = 70   // ms — minimum free-fall duration to count

    let freeFallStart = null
    const deviceType  = getDeviceType()

    function magnitude(a) {
      // Use accelerationIncludingGravity for widest device support (reads ~0 in free-fall)
      const src = a.accelerationIncludingGravity ?? a.acceleration
      if (!src) return null
      return Math.sqrt((src.x || 0) ** 2 + (src.y || 0) ** 2 + (src.z || 0) ** 2)
    }

    function handleMotion(e) {
      const mag = magnitude(e)
      if (mag === null) return

      if (mag < FREEFALL_THR) {
        if (!freeFallStart) freeFallStart = Date.now()
      } else if (freeFallStart) {
        const dur = Date.now() - freeFallStart
        freeFallStart = null
        if (dur >= FREEFALL_MIN && mag > IMPACT_THR) {
          onFallRef.current(deviceType)
        }
      }
    }

    async function setup() {
      // iOS 13+ requires explicit permission for DeviceMotionEvent
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
  }, [])
}

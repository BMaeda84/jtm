import { useState, useEffect, useRef } from 'react'

export function useScanning({ buttons, enabled, scanSpeed, trigger, blinkCount, mouthCount, onSelect }) {
  const [activeIndex, setActiveIndex] = useState(0)
  const indexRef      = useRef(0)
  const prevBlinkRef  = useRef(0)
  const prevMouthRef  = useRef(0)
  // Track buttons in a ref so interval/effects can read current value
  const buttonsRef    = useRef(buttons)
  useEffect(() => { buttonsRef.current = buttons }, [buttons])

  function getCurrent() {
    return buttonsRef.current[indexRef.current] ?? null
  }

  function advance() {
    const len = buttonsRef.current.length
    if (!len) return
    indexRef.current = (indexRef.current + 1) % len
    setActiveIndex(indexRef.current)
  }

  // Main timer: advance (and auto-select in auto mode)
  useEffect(() => {
    if (!enabled || !buttons.length) {
      setActiveIndex(0)
      indexRef.current  = 0
      prevBlinkRef.current = 0
      prevMouthRef.current = 0
      return
    }

    indexRef.current = 0
    setActiveIndex(0)

    const interval = setInterval(() => {
      if (trigger === 'auto') {
        const btn = getCurrent()
        if (btn) onSelect(btn)
      }
      advance()
    }, scanSpeed)

    return () => clearInterval(interval)
  }, [enabled, buttons.length, scanSpeed, trigger])

  // Blink trigger
  useEffect(() => {
    if (!enabled || trigger !== 'blink') return
    if (blinkCount > prevBlinkRef.current) {
      prevBlinkRef.current = blinkCount
      const btn = getCurrent()
      if (btn) onSelect(btn)
    }
  }, [blinkCount, enabled, trigger])

  // Mouth trigger
  useEffect(() => {
    if (!enabled || trigger !== 'mouth') return
    if (mouthCount > prevMouthRef.current) {
      prevMouthRef.current = mouthCount
      const btn = getCurrent()
      if (btn) onSelect(btn)
    }
  }, [mouthCount, enabled, trigger])

  return { activeIndex }
}

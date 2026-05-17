import { useState } from 'react'

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : JSON.parse(v)
  } catch {
    return fallback
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

export function useSettings() {
  const [speechRate, setSpeechRateRaw] = useState(() => load('jtm_rate', 0.85))
  const [darkMode, setDarkModeRaw] = useState(() => load('jtm_dark', false))
  const [gazeEnabled, setGazeEnabledRaw]       = useState(() => load('jtm_gaze', false))
  const [dwellTime,   setDwellTimeRaw]          = useState(() => load('jtm_dwell', 1500))
  const [scanEnabled, setScanEnabledRaw]        = useState(() => load('jtm_scan', false))
  const [scanSpeed,   setScanSpeedRaw]          = useState(() => load('jtm_scan_speed', 2000))
  const [scanTrigger, setScanTriggerRaw]        = useState(() => load('jtm_scan_trigger', 'blink'))
  const [favorites, setFavoritesRaw] = useState(() => new Set(load('jtm_favorites', [])))
  const [history, setHistory] = useState([])

  function setSpeechRate(rate) {
    save('jtm_rate', rate)
    setSpeechRateRaw(rate)
  }

  function setDarkMode(val) {
    save('jtm_dark', val)
    setDarkModeRaw(val)
  }

  function setGazeEnabled(val) {
    save('jtm_gaze', val)
    setGazeEnabledRaw(val)
  }

  function setDwellTime(val) {
    save('jtm_dwell', val)
    setDwellTimeRaw(val)
  }

  function setScanEnabled(val) { save('jtm_scan', val); setScanEnabledRaw(val) }
  function setScanSpeed(val)   { save('jtm_scan_speed', val); setScanSpeedRaw(val) }
  function setScanTrigger(val) { save('jtm_scan_trigger', val); setScanTriggerRaw(val) }

  function toggleFavorite(phrase) {
    setFavoritesRaw(prev => {
      const next = new Set(prev)
      next.has(phrase) ? next.delete(phrase) : next.add(phrase)
      save('jtm_favorites', [...next])
      return next
    })
  }

  function addToHistory(item) {
    setHistory(prev => {
      const filtered = prev.filter(h => h.phrase !== item.phrase)
      return [item, ...filtered].slice(0, 10)
    })
  }

  return {
    speechRate, setSpeechRate,
    darkMode, setDarkMode,
    gazeEnabled, setGazeEnabled,
    dwellTime, setDwellTime,
    scanEnabled, setScanEnabled,
    scanSpeed, setScanSpeed,
    scanTrigger, setScanTrigger,
    favorites, toggleFavorite,
    history, addToHistory,
  }
}

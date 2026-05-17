import { useState, useEffect } from 'react'

function scorePtVoice(voice) {
  const name = voice.name.toLowerCase()
  // Highest: Google neural voices
  if (name.includes('google') && name.includes('pt')) return 100
  if (name.includes('google')) return 90
  // Samsung Neural TTS is decent
  if (name.includes('neural')) return 70
  if (name.includes('enhanced') || name.includes('premium')) return 60
  // Any pt-BR over generic
  if (voice.lang.toLowerCase().startsWith('pt-br')) return 40
  if (voice.lang.toLowerCase().startsWith('pt')) return 30
  return 10
}

function getPtVoices() {
  return window.speechSynthesis
    .getVoices()
    .filter(v => v.lang.toLowerCase().startsWith('pt'))
    .sort((a, b) => scorePtVoice(b) - scorePtVoice(a))
}

const STORAGE_KEY = 'jtm_voice'

export function useVoice() {
  const [voices, setVoices] = useState([])
  const [selectedVoice, setSelectedVoice] = useState(null)

  useEffect(() => {
    function load() {
      const ptVoices = getPtVoices()
      if (ptVoices.length === 0) return
      setVoices(ptVoices)
      setSelectedVoice(prev => {
        if (prev) return prev
        const saved = localStorage.getItem(STORAGE_KEY)
        return ptVoices.find(v => v.name === saved) ?? ptVoices[0]
      })
    }

    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])

  function selectAndSave(voice) {
    localStorage.setItem(STORAGE_KEY, voice.name)
    setSelectedVoice(voice)
  }

  return { voices, selectedVoice, setSelectedVoice: selectAndSave }
}

export function speak(phrase, voice, rate = 0.85) {
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(phrase)
  utterance.lang = 'pt-BR'
  utterance.rate = rate
  utterance.pitch = 1
  if (voice) utterance.voice = voice
  window.speechSynthesis.speak(utterance)
}

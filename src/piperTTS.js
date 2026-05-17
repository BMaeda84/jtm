import * as tts from '@mintplex-labs/piper-tts-web'

const VOICE_ID = 'pt_BR-faber-medium'
let currentAudio = null

export async function isPiperCached() {
  try {
    const stored = await tts.stored()
    return stored.includes(VOICE_ID)
  } catch {
    return false
  }
}

export async function downloadPiper(onProgress) {
  await tts.download(VOICE_ID, onProgress)
}

export async function speakWithPiper(text, rate = 0.85) {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }

  const wav = await tts.predict({ text, voiceId: VOICE_ID })
  const audio = new Audio()
  audio.src = URL.createObjectURL(wav)
  audio.playbackRate = rate / 0.85
  currentAudio = audio
  await audio.play()
  audio.onended = () => { currentAudio = null }
}

export function cancelPiper() {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }
}

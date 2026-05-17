// ─────────────────────────────────────────────────────────────────────────────
// useSettings.js — Gerenciamento de preferências do usuário
//
// Todas as configurações são persistidas em localStorage para sobreviver
// ao fechamento do app. O histórico de frases é mantido APENAS em memória
// (perde ao fechar) — é uma lista temporária de consulta rápida, não um log.
//
// CHAVES NO localStorage:
//   jtm_rate         → velocidade de fala (float 0.5–1.2)
//   jtm_dark         → modo escuro (boolean)
//   jtm_gaze         → rastreamento ocular ativo (boolean)
//   jtm_dwell        → tempo de fixação para ativar botão em ms (int)
//   jtm_scan         → varredura ativa (boolean)
//   jtm_scan_speed   → velocidade da varredura em ms por botão (int)
//   jtm_scan_trigger → gatilho da varredura ('blink'|'mouth'|'auto')
//   jtm_favorites    → array de strings (frases favoritadas)
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'

// Lê um valor do localStorage, deserializando de JSON.
// Retorna o fallback se a chave não existir ou se o JSON for inválido.
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : JSON.parse(v)
  } catch {
    return fallback  // JSON corrompido ou quota excedida: usa padrão sem travar
  }
}

// Persiste um valor no localStorage, serializando para JSON.
function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

export function useSettings() {
  // Cada setting é inicializado via função lazy (() => load(...)) para que
  // o localStorage seja lido apenas uma vez na montagem, não a cada render.

  const [speechRate,   setSpeechRateRaw]   = useState(() => load('jtm_rate',         0.85))
  const [darkMode,     setDarkModeRaw]     = useState(() => load('jtm_dark',          false))
  const [gazeEnabled,  setGazeEnabledRaw]  = useState(() => load('jtm_gaze',          false))
  const [dwellTime,    setDwellTimeRaw]    = useState(() => load('jtm_dwell',          1500))
  const [scanEnabled,  setScanEnabledRaw]  = useState(() => load('jtm_scan',           false))
  const [scanSpeed,    setScanSpeedRaw]    = useState(() => load('jtm_scan_speed',     2000))
  const [scanTrigger,  setScanTriggerRaw]  = useState(() => load('jtm_scan_trigger',   'blink'))

  // Favoritos: Set<string> com as frases salvas.
  // Armazenado como array no JSON (Set não é serializável), convertido na leitura.
  const [favorites,    setFavoritesRaw]    = useState(() => new Set(load('jtm_favorites', [])))

  // Histórico: array em memória (máx 10 items). Não persiste entre sessões —
  // é só para consulta rápida e repetição de frases recentes.
  const [history, setHistory] = useState([])

  // ── Setters com persistência automática ──────────────────────────────────
  // Cada setter atualiza o state React E persiste no localStorage atomicamente.
  // Isso garante que a UI e o armazenamento nunca fiquem dessincronizados.

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

  function setScanEnabled(val)  { save('jtm_scan',          val); setScanEnabledRaw(val) }
  function setScanSpeed(val)    { save('jtm_scan_speed',    val); setScanSpeedRaw(val) }
  function setScanTrigger(val)  { save('jtm_scan_trigger',  val); setScanTriggerRaw(val) }

  // Alterna uma frase nos favoritos (adiciona se não estiver, remove se estiver).
  function toggleFavorite(phrase) {
    setFavoritesRaw(prev => {
      const next = new Set(prev)
      next.has(phrase) ? next.delete(phrase) : next.add(phrase)
      save('jtm_favorites', [...next])  // converte Set para Array para serializar
      return next
    })
  }

  // Adiciona uma frase ao início do histórico, mantendo no máximo 10 itens.
  // Deduplication: se a frase já existe, remove a ocorrência anterior antes
  // de inserir no início (para manter a ordem cronológica inversa).
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

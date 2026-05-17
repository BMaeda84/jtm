// ─────────────────────────────────────────────────────────────────────────────
// useBattery.js — Leitura do nível de bateria via Battery Status API
//
// A Battery Status API (navigator.getBattery) é suportada principalmente em
// navegadores Chromium no Android. No iOS (Safari), ela foi removida por
// questões de privacidade (poderia ser usada para fingerprinting do usuário).
//
// O hook trata graciosamente a ausência da API (retorna null), então os
// componentes que o usam devem verificar se o valor é null antes de exibir.
//
// Retorna: { level: 0.0–1.0, charging: boolean } | null
//   level: 0.0 = vazia, 1.0 = cheia
//   charging: true se o carregador está conectado
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react'

export function useBattery() {
  // null = API não disponível ou ainda carregando
  const [battery, setBattery] = useState(null)

  useEffect(() => {
    // Verifica se a API existe antes de chamar (graceful degradation)
    if (!navigator.getBattery) return

    let bat = null  // referência ao objeto BatteryManager (para remover listeners depois)

    function update() {
      if (!bat) return
      // Lê o estado atual e atualiza o state do React
      setBattery({ level: bat.level, charging: bat.charging })
    }

    navigator.getBattery()
      .then(b => {
        bat = b
        update()  // leitura inicial

        // Inscreve nos eventos de mudança:
        // 'levelchange'    → disparado quando o nível muda (a cada ~1% tipicamente)
        // 'chargingchange' → disparado quando conecta/desconecta o carregador
        b.addEventListener('levelchange',    update)
        b.addEventListener('chargingchange', update)
      })
      .catch(() => {})  // ignora silenciosamente — API pode ser rejeitada por contexto inseguro

    // Limpeza: remove os listeners quando o componente desmonta
    return () => {
      if (bat) {
        bat.removeEventListener('levelchange',    update)
        bat.removeEventListener('chargingchange', update)
      }
    }
  }, [])  // [] = executa só uma vez, na montagem do componente

  return battery
}

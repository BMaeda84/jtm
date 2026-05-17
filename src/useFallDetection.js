// ─────────────────────────────────────────────────────────────────────────────
// useFallDetection.js — Detecção de queda por acelerômetro
//
// FÍSICA DO PROBLEMA:
//   Um acelerômetro mede a ACELERAÇÃO PRÓPRIA (força por unidade de massa).
//   Em repouso sobre uma superfície, o sensor detecta a reação normal ao peso:
//   ~9,8 m/s² no eixo perpendicular à superfície (gravidade).
//
//   Em QUEDA LIVRE, o dispositivo está em inércia — sem força de reação.
//   O sensor lê próximo a ZERO (weightlessness, como os astronautas).
//
//   No IMPACTO, a queda é abruptamente travada. Surge uma deceleração brusca
//   que o sensor lê como pico alto (30–200+ m/s² dependendo da superfície).
//
// PADRÃO DE DETECÇÃO:
//   [REPOUSO ~9,8 m/s²] → [QUEDA LIVRE <5,5 m/s² por ≥35ms] → [IMPACTO >12 m/s²]
//
// POR QUE accelerationIncludingGravity e não acceleration (linear)?
//   'acceleration' (linear, sem gravidade) lê ~0 tanto em repouso QUANTO em
//   queda livre — seria impossível distinguir os dois estados.
//   'accelerationIncludingGravity' lê ~9,8 em repouso e ~0 em queda livre,
//   tornando a distinção trivial. Tem suporte em mais dispositivos.
//
// MÁQUINA DE ESTADOS:
//   IDLE ──(magnitude < FREEFALL_THR)──▶ FREEFALL
//   FREEFALL ──(magnitude ≥ FREEFALL_THR por ≥FREEFALL_MIN ms)──▶ IMPACT_WATCH
//   FREEFALL ──(retornou para ≥FREEFALL_THR antes do tempo mínimo)──▶ IDLE
//   IMPACT_WATCH ──(magnitude > IMPACT_THR)──▶ FIRED → IDLE (com cooldown)
//   IMPACT_WATCH ──(timeout IMPACT_WINDOW sem impacto)──▶ IDLE
//
// CALIBRAÇÃO DOS LIMIARES (baseada em física de quedas):
//   Queda de 20 cm: tempo total ≈ 200ms, velocidade no impacto ≈ 2 m/s
//   Queda de 40 cm: tempo total ≈ 285ms, velocidade no impacto ≈ 2,8 m/s
//   Em superfície macia (colo, cama): impacto absorvido em ~10cm → pico ~10–15 m/s²
//   Em piso duro: impacto absorvido em ~1cm → pico ~100–200 m/s²
//   IMPACT_THR = 12 m/s² pega ambos os casos.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react'

// ── Detecção de tipo de dispositivo ──────────────────────────────────────────
// Tenta inferir se o dispositivo é celular ou tablet para personalizar a mensagem.
// Critérios (por ordem de confiabilidade):
//   1. 'ipad' no userAgent → tablet Apple
//   2. Android sem 'mobile' → tablet Android (Google, Samsung etc)
//   3. Menor dimensão de tela ≥ 600px → provável tablet (heurística de DPI real)
export function getDeviceType() {
  const ua = navigator.userAgent.toLowerCase()
  if (/ipad/.test(ua)) return 'tablet'
  if (/android/.test(ua) && !/mobile/.test(ua)) return 'tablet'
  // screen.width/height são em pixels físicos antes do zoom do navegador
  const minDim = Math.min(screen.width, screen.height)
  return minDim >= 600 ? 'tablet' : 'celular'
}

// ─────────────────────────────────────────────────────────────────────────────
// requestMotionPermission()
//
// iOS 13+ exige uma permissão EXPLÍCITA com gesto do usuário para acessar
// DeviceMotionEvent. Esta função deve ser chamada a partir de um handler
// de clique (botão), não de useEffect — o iOS rejeita pedidos fora de
// interação direta.
//
// Android não usa esse mecanismo (DeviceMotionEvent.requestPermission é undefined
// no Android), então a função retorna 'unavailable' para Android.
//
// Retorna: 'granted' | 'denied' | 'unavailable'
// ─────────────────────────────────────────────────────────────────────────────
export async function requestMotionPermission() {
  if (typeof DeviceMotionEvent?.requestPermission !== 'function') return 'unavailable'
  try {
    return await DeviceMotionEvent.requestPermission()
  } catch {
    return 'denied'
  }
}

// ── Limiares ─────────────────────────────────────────────────────────────────
const FREEFALL_THR  = 5.5   // m/s² — abaixo disto = queda livre (bem abaixo do repouso 9,8)
const IMPACT_THR    = 12    // m/s² — acima disto = impacto (inclui superfícies macias)
const FREEFALL_MIN  = 35    // ms — duração mínima de queda livre (~7cm de queda já classifica)
const IMPACT_WINDOW = 600   // ms — janela após a queda livre para detectar o impacto
const COOLDOWN_MS   = 8000  // ms — intervalo mínimo entre dois alertas (evita re-disparos por quiques)

// ─────────────────────────────────────────────────────────────────────────────
// useFallDetection(onFall, enabled)
//
// Parâmetros:
//   onFall(deviceType)  — callback chamado quando uma queda é detectada;
//                         recebe 'celular' ou 'tablet'
//   enabled             — boolean; o listener só é registrado quando true
//                         (por segurança e economia de bateria)
// ─────────────────────────────────────────────────────────────────────────────
export function useFallDetection(onFall, enabled = true) {
  // Usamos ref para o callback para evitar que mudanças de closure
  // reiniciem o efeito e o listener toda vez que o componente re-renderiza.
  const onFallRef = useRef(onFall)
  onFallRef.current = onFall

  useEffect(() => {
    if (!enabled || !window.DeviceMotionEvent) return

    const deviceType = getDeviceType()

    // ── Variáveis da máquina de estados ──────────────────────────────────────
    let state        = 'idle'    // estado atual: 'idle' | 'freefall' | 'impact_watch'
    let phaseStart   = 0         // timestamp do início da fase atual
    let cooldownUntil = 0        // timestamp até quando o detector está em cooldown

    // ── Calcula a magnitude do vetor de aceleração ────────────────────────────
    // Magnitude = raiz quadrada da soma dos quadrados dos componentes (Pitágoras 3D).
    // Preferimos accelerationIncludingGravity — lê ~9,8 em repouso e ~0 em queda.
    // Fallback para acceleration (linear) se o primeiro não estiver disponível.
    function mag(e) {
      const aG = e.accelerationIncludingGravity
      if (aG && aG.x !== null) {
        return Math.sqrt((aG.x || 0) ** 2 + (aG.y || 0) ** 2 + (aG.z || 0) ** 2)
      }
      const a = e.acceleration
      if (a && a.x !== null) {
        return Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2)
      }
      return null  // sensor indisponível neste frame
    }

    // Dispara o alerta e entra em cooldown para evitar repetições por quiques
    function fire(now) {
      state = 'idle'
      cooldownUntil = now + COOLDOWN_MS
      onFallRef.current(deviceType)
    }

    // ── Handler principal — chamado a ~60 Hz pelo dispositivo ─────────────────
    function handleMotion(e) {
      const m = mag(e)
      if (m === null) return  // sensor sem dados neste frame
      const now = Date.now()
      if (now < cooldownUntil) return  // ainda em cooldown após último alerta

      if (state === 'idle') {
        // Aguardando início de queda livre
        if (m < FREEFALL_THR) {
          state = 'freefall'
          phaseStart = now
        }
        return
      }

      if (state === 'freefall') {
        if (m >= FREEFALL_THR) {
          // A magnitude voltou para acima do limiar — fim da fase de queda livre
          const dur = now - phaseStart
          if (dur >= FREEFALL_MIN) {
            // Durou tempo suficiente para ser uma queda real; aguarda o impacto
            state = 'impact_watch'
            phaseStart = now

            // O impacto pode chegar no mesmo frame que a queda livre termina
            // (em quedas em superfícies muito duras com pico instantâneo)
            if (m > IMPACT_THR) { fire(now); return }
          } else {
            // Durou pouco demais — provavelmente só um sacolejar do dispositivo
            state = 'idle'
          }
        }
        // Se m ainda < FREEFALL_THR, continuamos em queda livre (não retorna)
        return
      }

      if (state === 'impact_watch') {
        if (m > IMPACT_THR) {
          // Impacto detectado dentro da janela — queda confirmada!
          fire(now)
        } else if (now - phaseStart > IMPACT_WINDOW) {
          // Passou o tempo da janela sem impacto forte —
          // provavelmente foi o dispositivo deslizando suavemente sobre superfície
          state = 'idle'
        }
        // Se nem impacto nem timeout, continua aguardando no estado impact_watch
      }
    }

    // ── Setup assíncrono (para lidar com iOS) ─────────────────────────────────
    async function setup() {
      // iOS 13+ exige permissão explícita. Se não for concedida, não registramos o listener.
      // Em Android, requestPermission não existe, então pulamos direto para o addEventListener.
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        try {
          const perm = await DeviceMotionEvent.requestPermission()
          if (perm !== 'granted') return
        } catch {
          return  // iOS negou ou ocorreu erro — não monitora
        }
      }
      window.addEventListener('devicemotion', handleMotion)
    }

    setup()

    // Limpeza: remove o listener quando o componente desmonta ou enabled muda
    return () => window.removeEventListener('devicemotion', handleMotion)
  }, [enabled])  // re-executa só quando enabled muda
}

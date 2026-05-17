// ─────────────────────────────────────────────────────────────────────────────
// useScanning.js — Modo de varredura automática (scanning)
//
// CONCEITO:
//   Varredura é uma técnica de CAA para usuários sem mobilidade suficiente
//   para toque direto e sem capacidade de rastreamento ocular. Os botões
//   se iluminam sequencialmente; o usuário seleciona o botão desejado
//   emitindo um sinal (piscar, abrir a boca, ou aguardar seleção automática).
//
// MODOS DE DISPARO (trigger):
//   'blink' — o usuário pisca para selecionar o botão iluminado no momento
//   'mouth' — o usuário abre a boca para selecionar
//   'auto'  — o botão é selecionado automaticamente após scanSpeed ms;
//              o usuário precisa apenas piscar/agir para INTERROMPER (útil
//              quando qualquer ação controlável é difícil)
//
// CONTADOR DE PISCADAS/BOCA:
//   Os valores blinkCount e mouthCount vêm de useFaceTracking e são
//   CONTADORES CRESCENTES (não booleans). O hook de varredura observa
//   quando o contador aumenta (em relação ao valor anterior) e interpreta
//   isso como um novo gesto de seleção.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react'

export function useScanning({ buttons, enabled, scanSpeed, trigger, blinkCount, mouthCount, onSelect }) {
  const [activeIndex, setActiveIndex] = useState(0)   // índice do botão atualmente iluminado

  // Refs para acessar valores atuais dentro de setInterval/callbacks sem
  // precisar reiniciar o intervalo a cada re-render.
  const indexRef       = useRef(0)           // índice atual (espelho do state, acessível sem closure)
  const prevBlinkRef   = useRef(0)           // último valor de blinkCount processado
  const prevMouthRef   = useRef(0)           // último valor de mouthCount processado
  const buttonsRef     = useRef(buttons)     // array de botões atual
  useEffect(() => { buttonsRef.current = buttons }, [buttons])

  // Retorna o botão atualmente selecionado (pelo índice do intervalo)
  function getCurrent() {
    return buttonsRef.current[indexRef.current] ?? null
  }

  // Avança para o próximo botão em loop circular
  function advance() {
    const len = buttonsRef.current.length
    if (!len) return
    indexRef.current = (indexRef.current + 1) % len  // módulo = volta ao início
    setActiveIndex(indexRef.current)
  }

  // ── Timer principal de varredura ──────────────────────────────────────────
  // Avança o botão iluminado a cada scanSpeed ms.
  // No modo 'auto', também seleciona automaticamente antes de avançar.
  useEffect(() => {
    if (!enabled || !buttons.length) {
      // Desabilitado ou sem botões: reseta tudo para o estado inicial
      setActiveIndex(0)
      indexRef.current  = 0
      prevBlinkRef.current = 0
      prevMouthRef.current = 0
      return
    }

    // Reinicia do botão 0 sempre que a varredura é ativada ou a lista muda
    indexRef.current = 0
    setActiveIndex(0)

    const interval = setInterval(() => {
      if (trigger === 'auto') {
        // No modo automático, seleciona o botão atual antes de avançar
        const btn = getCurrent()
        if (btn) onSelect(btn)
      }
      advance()  // move para o próximo botão
    }, scanSpeed)

    return () => clearInterval(interval)  // limpa ao desmontar ou mudar parâmetros
  }, [enabled, buttons.length, scanSpeed, trigger])

  // ── Disparo por piscada ───────────────────────────────────────────────────
  // blinkCount é um contador crescente. Quando seu valor aumenta em relação
  // ao último valor processado, houve uma nova piscada válida.
  useEffect(() => {
    if (!enabled || trigger !== 'blink') return
    if (blinkCount > prevBlinkRef.current) {
      prevBlinkRef.current = blinkCount
      const btn = getCurrent()
      if (btn) onSelect(btn)
    }
  }, [blinkCount, enabled, trigger])

  // ── Disparo por boca ──────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// GazeCursor.jsx — Cursor de olhar e lógica de seleção por fixação (dwell)
//
// CONCEITO DE DWELL (fixação):
//   Em interfaces de rastreamento ocular, "dwell" é o ato de olhar fixamente
//   para um alvo por um período mínimo para ativá-lo. Diferente de um clique,
//   o critério é apenas o tempo de permanência — não há ação física.
//
// COMO FUNCIONA O CURSOR:
//   1. A cada frame, gazePoint (x,y em 0–1 normalizado) é convertido para
//      coordenadas de tela em pixels.
//   2. document.elementFromPoint() identifica qual elemento HTML está sob o cursor.
//   3. Subimos na árvore DOM com .closest('[data-gaze]') para encontrar o
//      botão interativo mais próximo (evita que spans internos do botão quebrem a detecção).
//   4. Se o alvo mudou, o timer de dwell é reiniciado.
//   5. Se o alvo permanece o mesmo, um progresso de 0→1 é calculado e
//      renderizado como um arco SVG no cursor.
//   6. Ao atingir progresso=1, onDwell(element) é chamado e um cooldown
//      de COOLDOWN_MS impede ativações duplicadas enquanto o olhar permanece.
//
// REPRESENTAÇÃO VISUAL:
//   O cursor é um SVG com três camadas:
//     - Anel de fundo cinza escuro (guide ring)
//     - Borda branca semi-transparente (contraste sobre qualquer fundo)
//     - Arco de progresso amarelo (#FBBF24) que vai de 0° a 360°
//     - Ponto central branco+azul (crosshair)
//   O arco usa strokeDasharray/strokeDashoffset:
//     dasharray = circunferência total (2πr) → define o comprimento "preenchível"
//     dashoffset = circunferência * (1 - progress) → encurta o traço visível
//     Valores: RADIUS=30px → CIRCUMFERENCE = 2π×30 ≈ 188.5px
//   rotate(-90°): SVG começa o traço às 3h (0°), rotacionamos para começar às 12h.
//
// COOLDOWN:
//   Após uma ativação, se o olhar permanecer no mesmo botão,
//   um cooldown de 700ms impede nova ativação imediata.
//   Assim que o cooldown termina, o timer recomeça — permitindo ativação
//   contínua se o usuário intencionalmente quiser repetir.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react'
import './GazeCursor.css'

// Raio do arco SVG em pixels
const RADIUS = 30

// Comprimento total da circunferência (usado como base do strokeDasharray)
// Fórmula: C = 2 × π × r
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

// Tempo de espera após uma ativação antes de permitir nova ativação no mesmo alvo
const COOLDOWN_MS = 700

// ─────────────────────────────────────────────────────────────────────────────
// GazeCursor
//
// Props:
//   gazePoint    — {x, y} em coordenadas normalizadas (0–1), ou null se rosto não detectado
//   dwellTime    — duração em ms para considerar fixação suficiente para ativar
//   onDwell(el)  — callback chamado quando o dwell completa; recebe o elemento DOM ativado
//   faceDetected — boolean (ou undefined): exibe aviso quando false
// ─────────────────────────────────────────────────────────────────────────────
export function GazeCursor({ gazePoint, dwellTime, onDwell, faceDetected }) {
  // progress: 0.0 (sem progresso) → 1.0 (ativação completa)
  const [progress, setProgress] = useState(0)

  // state.current evita re-renders desnecessários para dados mutáveis de frame.
  // Usar useState aqui causaria renders a 60fps — overkill para lógica interna.
  // Estrutura:
  //   target      — elemento DOM do alvo atual (ou null)
  //   startTime   — performance.now() quando o timer de dwell começou (ou null)
  //   coolingDown — true durante o período de cooldown pós-ativação
  const state = useRef({ target: null, startTime: null, coolingDown: false })

  useEffect(() => {
    if (!gazePoint) return

    // Converte coordenadas normalizadas (0–1) para pixels de tela
    const px = gazePoint.x * window.innerWidth
    const py = gazePoint.y * window.innerHeight

    // Detecta o elemento HTML na posição do olhar
    const el = document.elementFromPoint(px, py)

    // Sobe na árvore DOM até encontrar um elemento marcado com data-gaze.
    // Isso garante que, mesmo que o olhar caia num <span> dentro do botão,
    // o botão pai (data-gaze) seja o alvo — não o span.
    const target = el?.closest('[data-gaze]') ?? null
    const s = state.current

    if (target !== s.target) {
      // O olhar moveu para um novo alvo (ou saiu de qualquer alvo)
      s.target = target

      // Só inicia o timer se: há um alvo E não estamos em cooldown
      s.startTime = (target && !s.coolingDown) ? performance.now() : null
      setProgress(0)  // zera o arco visual
    }

    if (s.startTime) {
      // Calcula quanto tempo do dwell já passou (clamped a 1.0 = 100%)
      const p = Math.min((performance.now() - s.startTime) / dwellTime, 1)
      setProgress(p)

      if (p >= 1) {
        // Dwell completo — ativa o botão
        s.startTime   = null
        s.coolingDown = true
        setProgress(0)
        onDwell(target)  // chama o handler externo (ex: falar frase ou mudar categoria)

        // Inicia o cooldown; ao terminar, reinicia o timer se o olhar ainda estiver no alvo
        setTimeout(() => {
          s.coolingDown = false
          if (s.target) s.startTime = performance.now()  // recomeça para o mesmo alvo
        }, COOLDOWN_MS)
      }
    }
  }, [gazePoint, dwellTime, onDwell])

  // Se não há gazePoint: rosto fora de quadro ou câmera inativa
  if (!gazePoint) {
    // faceDetected === false (não undefined) significa que a câmera está ativa
    // mas o rosto não foi detectado — exibe aviso orientando o usuário
    return faceDetected === false
      ? <div className="gaze-no-face">👁️ Posicione o rosto na frente da câmera</div>
      : null
  }

  // Converte normalizado → pixels para posicionar o cursor
  const x = gazePoint.x * window.innerWidth
  const y = gazePoint.y * window.innerHeight

  // strokeDashoffset controla quanto do arco é visível:
  //   offset = CIRCUMFERENCE * (1 - progress)
  //   progress=0 → offset=CIRCUMFERENCE → arco completamente invisível (trace começa onde termina)
  //   progress=1 → offset=0            → arco completamente visível (círculo cheio)
  const offset = CIRCUMFERENCE * (1 - progress)

  // Tamanho do SVG: diâmetro + 20px de padding para a espessura do traço
  const size = RADIUS * 2 + 20

  return (
    // Posicionado com CSS position:fixed, centrado no ponto de olhar via transform (em GazeCursor.css)
    <div className="gaze-cursor" style={{ left: x, top: y }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>

        {/* Anel de fundo: guia visual sempre visível para mostrar o raio do arco */}
        <circle
          cx={size / 2} cy={size / 2} r={RADIUS}
          fill="none"
          stroke="rgba(0,0,0,0.4)"
          strokeWidth={6}
        />

        {/* Borda branca: melhora legibilidade sobre fundos escuros e claros */}
        <circle
          cx={size / 2} cy={size / 2} r={RADIUS}
          fill="none"
          stroke="white"
          strokeWidth={3}
          opacity={0.6}
        />

        {/* Arco de progresso do dwell — só renderizado quando há progresso visível */}
        {progress > 0 && (
          <circle
            cx={size / 2} cy={size / 2} r={RADIUS}
            fill="none"
            stroke="#FBBF24"            // amarelo âmbar — visível em fundo claro e escuro
            strokeWidth={5}
            strokeDasharray={CIRCUMFERENCE}   // comprimento total disponível
            strokeDashoffset={offset}          // quanto encurtar (0 = cheio, CIRC = vazio)
            strokeLinecap="round"              // extremidades arredondadas para visual suave
            transform={`rotate(-90 ${size / 2} ${size / 2})`}  // começa às 12h, não 3h
          />
        )}

        {/* Ponto central: branco externo + azul interno — visível em qualquer fundo */}
        <circle cx={size / 2} cy={size / 2} r={6} fill="white" opacity={0.9} />
        <circle cx={size / 2} cy={size / 2} r={4} fill="#2563EB" />
      </svg>
    </div>
  )
}

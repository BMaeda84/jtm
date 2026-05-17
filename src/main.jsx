// ─────────────────────────────────────────────────────────────────────────────
// main.jsx — Ponto de entrada da aplicação React
//
// Este arquivo é o bootstrap mínimo do React. Suas responsabilidades são:
//   1. Selecionar o elemento DOM raiz (#root, definido em index.html)
//   2. Criar a raiz React com createRoot (API do React 18+)
//   3. Renderizar o componente App dentro de StrictMode
//
// REACT 18 — createRoot:
//   A API createRoot substitui a antiga ReactDOM.render() do React 17.
//   Ela habilita o modo concorrente (Concurrent Mode), que permite ao React
//   interromper e retomar renders para manter a UI responsiva — essencial
//   para o processamento pesado de MediaPipe que acontece em paralelo.
//
// STRICTMODE:
//   Em desenvolvimento (NODE_ENV=development), o StrictMode:
//   - Monta, desmonta e remonta cada componente deliberadamente para detectar
//     efeitos colaterais não-idempotentes (ex: setInterval sem cleanup)
//   - Avisa sobre uso de APIs obsoletas
//   - NÃO tem efeito em produção (build otimizado com Vite)
//
//   Consequência visível: em dev, useEffect é executado duas vezes para cada
//   componente — o que pode parecer um bug, mas é intencional para revelar
//   efeitos sem cleanup adequado. O código de useScanning, useFallDetection
//   etc. trata isso corretamente com funções de cleanup retornadas no useEffect.
//
// index.css:
//   Importado aqui (não no App) para garantir que os estilos globais (reset CSS,
//   variáveis CSS, fontes) sejam carregados antes de qualquer componente renderizar.
//   Vite processa este import e o inclui no bundle CSS final.
// ─────────────────────────────────────────────────────────────────────────────

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// createRoot recebe o elemento DOM onde toda a árvore React será montada.
// O elemento #root está definido em index.html como <div id="root"></div>.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

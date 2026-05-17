// ─────────────────────────────────────────────────────────────────────────────
// calibration.js — Calibração do rastreamento ocular por transformada afim
//
// CONCEITO GERAL
// O eye tracker produz coordenadas cruas de íris: (iris_x, iris_y), que são
// razões adimensionais dentro do globo ocular. Elas NÃO têm relação direta
// com pixels na tela — dependem do rosto do usuário, distância da câmera,
// ângulo de inclinação do dispositivo etc.
//
// A calibração resolve isso: o usuário olha para N pontos conhecidos da tela
// e coletamos os pares (iris_raw, screen_pos). A partir desses pares,
// ajustamos uma TRANSFORMADA AFIM que mapeia qualquer iris_raw → screen_pos.
//
// TRANSFORMADA AFIM — por que?
// Uma transformada afim modela: translação + escala + rotação + shear.
// Isso é suficiente para corrigir:
//   - Offset (usuário olha "para cima" em relação ao centro)
//   - Escala diferente em X e Y (movimentos horizontais maiores que verticais)
//   - Rotação leve (cabeça levemente inclinada)
//   - Assimetria entre olhos (shear)
//
// A fórmula é:
//   screen_x = a * iris_x + b * iris_y + c
//   screen_y = d * iris_x + e * iris_y + f
//
// Os 6 parâmetros {a, b, c, d, e, f} são aprendidos por mínimos quadrados
// usando todos os pares (iris, screen) coletados na calibração.
// ─────────────────────────────────────────────────────────────────────────────

// Pontos de calibração padrão (5 pontos): centro + 4 cantos.
// Coordenadas em 0–1 normalizadas pela janela.
// Estes são usados se o app precisar de uma calibração genérica simples;
// a calibração principal usa os botões reais do layout (em SetupWizard.jsx).
export const CALIB_POINTS = [
  { x: 0.50, y: 0.50 }, // centro
  { x: 0.15, y: 0.20 }, // topo-esquerda
  { x: 0.85, y: 0.20 }, // topo-direita
  { x: 0.85, y: 0.80 }, // baixo-direita
  { x: 0.15, y: 0.80 }, // baixo-esquerda
]

// Chave do localStorage onde o transform calibrado é persistido entre sessões.
export const CALIB_STORAGE_KEY = 'jtm_calib'

// ─────────────────────────────────────────────────────────────────────────────
// solve3x3(A, b)
//
// Resolve o sistema linear  A · x = b  onde A é 3×3 e b é vetor 3×1.
// Retorna o vetor solução x = [x0, x1, x2].
//
// MÉTODO: Eliminação Gaussiana com pivotamento parcial.
//
// Por que Gaussiana e não inversão de matriz?
//   Inversão é numericamente instável para matrizes quase-singulares.
//   A eliminação com pivotamento parcial (trocar linhas para colocar o maior
//   coeficiente na diagonal) minimiza erros de ponto flutuante.
//
// Por que 3×3?
//   Cada eixo (X ou Y) tem 3 parâmetros: [coef_irisX, coef_irisY, constante].
//   O sistema normal A^T A x = A^T b reduz para 3×3 independente do número
//   de pontos de calibração.
// ─────────────────────────────────────────────────────────────────────────────
function solve3x3(A, b) {
  // Monta matriz aumentada [A | b] de forma 3×4.
  // Cada linha i é [...A[i], b[i]].
  const M = A.map((row, i) => [...row, b[i]])

  // Fase de eliminação: transforma M em forma triangular superior.
  for (let col = 0; col < 3; col++) {
    // Pivotamento parcial: encontra a linha com maior valor absoluto na coluna
    // atual (abaixo da diagonal) e a troca para a posição da diagonal.
    // Isso evita divisão por zero e reduz erros de arredondamento.
    let maxRow = col
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]] // troca de linhas

    // Elimina a coluna `col` nas linhas abaixo da diagonal.
    for (let row = col + 1; row < 3; row++) {
      const f = M[row][col] / M[col][col] // fator de escala
      for (let j = col; j <= 3; j++) M[row][j] -= f * M[col][j]
      // Após essa operação, M[row][col] == 0 (eliminado).
    }
  }

  // Fase de substituição regressiva (back-substitution):
  // Com M triangular superior, resolve de baixo para cima.
  // Ex: se M[2] = [0, 0, 5, 10] → x[2] = 10/5 = 2
  //     se M[1] = [0, 3, 4, 17] → x[1] = (17 - 4*2) / 3 = 3
  const x = [0, 0, 0]
  for (let i = 2; i >= 0; i--) {
    x[i] = M[i][3]                           // lado direito da equação
    for (let j = i + 1; j < 3; j++) {
      x[i] -= M[i][j] * x[j]                 // subtrai contribuições já resolvidas
    }
    x[i] /= M[i][i]                          // divide pelo coeficiente diagonal
  }
  return x
}

// ─────────────────────────────────────────────────────────────────────────────
// fitTransform(irisPoints, screenPoints)
//
// Ajusta a transformada afim por MÍNIMOS QUADRADOS usando todos os pares
// (iris, screen) coletados durante a calibração.
//
// MÍNIMOS QUADRADOS — conceito:
//   Com N pontos, temos N equações e apenas 3 incógnitas por eixo. O sistema
//   é super-determinado (mais equações do que variáveis). Em vez de exigir
//   que todas as equações sejam satisfeitas exatamente (impossível com ruído),
//   encontramos os parâmetros que minimizam a SOMA DOS ERROS AO QUADRADO:
//
//     minimizar  Σ(i=0..N-1) [ (a·ix_i + b·iy_i + c) - sx_i ]²
//
//   A solução analítica dessas equações normais é:
//
//     (A^T · A) · θ = A^T · b
//
//   onde A é a matriz N×3 com linhas [iris_x, iris_y, 1],
//   b é o vetor N×1 com os screen_x (ou screen_y),
//   θ = [a, b, c] são os parâmetros desejados.
//
// Parâmetros:
//   irisPoints   — array de {x, y} com coordenadas cruas do olhar
//   screenPoints — array de {x, y} com posições na tela (0–1)
//
// Retorna: { a, b, c, d, e, f } — parâmetros da transformada afim.
// ─────────────────────────────────────────────────────────────────────────────
export function fitTransform(irisPoints, screenPoints) {
  const n = irisPoints.length

  // Acumuladores para A^T·A (3×3) e A^T·b para cada eixo (3×1).
  // Inicializados com zeros.
  let ATA  = [[0,0,0],[0,0,0],[0,0,0]]  // A transposta vezes A
  let ATbx = [0,0,0]                    // A transposta vezes b (eixo X)
  let ATby = [0,0,0]                    // A transposta vezes b (eixo Y)

  for (let i = 0; i < n; i++) {
    // Cada ponto de calibração gera uma linha da matriz A: [iris_x, iris_y, 1].
    // O "1" é a constante que permite modelar translação.
    const row = [irisPoints[i].x, irisPoints[i].y, 1]

    // Acumula os produtos externos para montar A^T·A e A^T·b.
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) ATA[r][c] += row[r] * row[c]
      ATbx[r] += row[r] * screenPoints[i].x  // contribuição do ponto i para X
      ATby[r] += row[r] * screenPoints[i].y  // contribuição do ponto i para Y
    }
  }

  // Resolve o sistema normal para cada eixo independentemente.
  // X: screen_x = a*iris_x + b*iris_y + c
  const [a, b, c] = solve3x3(ATA, ATbx)
  // Y: screen_y = d*iris_x + e*iris_y + f
  const [d, e, f] = solve3x3(ATA, ATby)

  return { a, b, c, d, e, f }
}

// ─────────────────────────────────────────────────────────────────────────────
// applyTransform(t, iris)
//
// Aplica a transformada afim a um ponto de íris crú, produzindo a posição
// correspondente na tela (coordenadas 0–1 normalizadas).
//
// Também faz clamping em [0, 1] para impedir que o cursor saia da tela
// quando o usuário olha para as bordas extremas.
// ─────────────────────────────────────────────────────────────────────────────
export function applyTransform(t, iris) {
  if (!t) return iris  // sem calibração, devolve o ponto crú
  return {
    x: Math.max(0, Math.min(1, t.a * iris.x + t.b * iris.y + t.c)),
    y: Math.max(0, Math.min(1, t.d * iris.x + t.e * iris.y + t.f)),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistência do transform no localStorage
//
// Optamos por localStorage (em vez de IndexedDB) por simplicidade:
// os dados são apenas 6 floats + metadados de tremor. O impacto de segurança
// é baixo — são parâmetros numéricos, não dados pessoais identificáveis.
// ─────────────────────────────────────────────────────────────────────────────

export function loadTransform() {
  try {
    return JSON.parse(localStorage.getItem(CALIB_STORAGE_KEY))
  } catch {
    return null  // JSON.parse lança se o valor for corrompido; retornamos null sem travar o app
  }
}

export function saveTransform(t) {
  localStorage.setItem(CALIB_STORAGE_KEY, JSON.stringify(t))
}

export function clearTransform() {
  localStorage.removeItem(CALIB_STORAGE_KEY)
}

// ─────────────────────────────────────────────────────────────────────────────
// Perfil de tremor
//
// Durante a calibração, medimos o desvio padrão do olhar em cada alvo.
// Esse valor varia por usuário: pessoas com tremor essencial ou doença de
// Parkinson têm stddev muito maior que pessoas sem tremor.
//
// O perfil é passado para o One Euro Filter (useFaceTracking.js) como
// parâmetro minCutoff: quanto maior o tremor, menor o minCutoff (mais
// suavização basal), sem prejudicar a responsividade a movimentos rápidos.
// ─────────────────────────────────────────────────────────────────────────────
const TREMOR_KEY = 'jtm_tremor'

export function saveTremorProfile(p) {
  localStorage.setItem(TREMOR_KEY, JSON.stringify(p))
}

export function loadTremorProfile() {
  try {
    return JSON.parse(localStorage.getItem(TREMOR_KEY))
  } catch {
    return null
  }
}

export function clearTremorProfile() {
  localStorage.removeItem(TREMOR_KEY)
}

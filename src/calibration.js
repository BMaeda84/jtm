// Calibration points: (screen position) → (iris position)
// Fits an affine transform: screen = A * iris + b
// So that any iris position maps to the correct screen position

export const CALIB_POINTS = [
  { x: 0.50, y: 0.50 }, // centro
  { x: 0.15, y: 0.20 }, // topo-esquerda
  { x: 0.85, y: 0.20 }, // topo-direita
  { x: 0.85, y: 0.80 }, // baixo-direita
  { x: 0.15, y: 0.80 }, // baixo-esquerda
]

export const CALIB_STORAGE_KEY = 'jtm_calib'

// Solve 3×3 linear system Ax = b using Gaussian elimination
function solve3x3(A, b) {
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < 3; col++) {
    let maxRow = col
    for (let row = col + 1; row < 3; row++)
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    [M[col], M[maxRow]] = [M[maxRow], M[col]]
    for (let row = col + 1; row < 3; row++) {
      const f = M[row][col] / M[col][col]
      for (let j = col; j <= 3; j++) M[row][j] -= f * M[col][j]
    }
  }
  const x = [0, 0, 0]
  for (let i = 2; i >= 0; i--) {
    x[i] = M[i][3]
    for (let j = i + 1; j < 3; j++) x[i] -= M[i][j] * x[j]
    x[i] /= M[i][i]
  }
  return x
}

// Least-squares affine fit over n calibration points
// irisPoints[i] = { x, y } raw iris normalized coords
// screenPoints[i] = { x, y } desired screen normalized coords
export function fitTransform(irisPoints, screenPoints) {
  const n = irisPoints.length
  // Build A^T A (3×3) and A^T b (3×1) for x and y separately
  let ATA = [[0,0,0],[0,0,0],[0,0,0]]
  let ATbx = [0,0,0], ATby = [0,0,0]

  for (let i = 0; i < n; i++) {
    const row = [irisPoints[i].x, irisPoints[i].y, 1]
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) ATA[r][c] += row[r] * row[c]
      ATbx[r] += row[r] * screenPoints[i].x
      ATby[r] += row[r] * screenPoints[i].y
    }
  }

  const [a, b, c] = solve3x3(ATA, ATbx)
  const [d, e, f] = solve3x3(ATA, ATby)
  return { a, b, c, d, e, f }
}

export function applyTransform(t, iris) {
  if (!t) return iris
  return {
    x: Math.max(0, Math.min(1, t.a * iris.x + t.b * iris.y + t.c)),
    y: Math.max(0, Math.min(1, t.d * iris.x + t.e * iris.y + t.f)),
  }
}

export function loadTransform() {
  try { return JSON.parse(localStorage.getItem(CALIB_STORAGE_KEY)) } catch { return null }
}

export function saveTransform(t) {
  localStorage.setItem(CALIB_STORAGE_KEY, JSON.stringify(t))
}

export function clearTransform() {
  localStorage.removeItem(CALIB_STORAGE_KEY)
}

const TREMOR_KEY = 'jtm_tremor'

export function saveTremorProfile(p) {
  localStorage.setItem(TREMOR_KEY, JSON.stringify(p))
}

export function loadTremorProfile() {
  try { return JSON.parse(localStorage.getItem(TREMOR_KEY)) } catch { return null }
}

export function clearTremorProfile() {
  localStorage.removeItem(TREMOR_KEY)
}

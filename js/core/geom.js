// Small 3D math helpers. 3MF transforms are 12 numbers:
// m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32 (row vectors: p' = p * M).

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export function parseTransform(s) {
  if (!s) return IDENTITY.slice();
  const v = String(s).trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY.slice();
}

export function formatNumber(n) {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

export function formatTransform(m) {
  return m.map(formatNumber).join(' ');
}

export function applyPoint(m, x, y, z) {
  return [
    x * m[0] + y * m[3] + z * m[6] + m[9],
    x * m[1] + y * m[4] + z * m[7] + m[10],
    x * m[2] + y * m[5] + z * m[8] + m[11],
  ];
}

// Composition: first apply a, then b.
export function multiply(a, b) {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  return r;
}

export function translate(m, dx, dy, dz = 0) {
  const r = m.slice();
  r[9] += dx;
  r[10] += dy;
  r[11] += dz;
  return r;
}

export function emptyBox() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

export function boxValid(b) {
  return b && b.min[0] <= b.max[0];
}

export function extendBox(b, p) {
  for (let i = 0; i < 3; i++) {
    if (p[i] < b.min[i]) b.min[i] = p[i];
    if (p[i] > b.max[i]) b.max[i] = p[i];
  }
}

export function mergeBox(a, b) {
  if (!boxValid(b)) return a;
  extendBox(a, b.min);
  extendBox(a, b.max);
  return a;
}

export function transformBox(b, m) {
  const out = emptyBox();
  if (!boxValid(b)) return out;
  for (let i = 0; i < 8; i++) {
    extendBox(out, applyPoint(m, i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]));
  }
  return out;
}

// Bambu Studio plate grid (PartPlate.cpp): LOGICAL_PART_PLATE_GAP = 1/5, rows grow towards -Y.
export function plateColumns(count) {
  const v = Math.sqrt(count);
  const r = Math.round(v);
  return v > r ? r + 1 : r;
}

export function plateOrigin(index, count, width, depth) {
  const cols = plateColumns(Math.max(1, count));
  const row = Math.floor(index / cols);
  const col = index % cols;
  return [col * Math.trunc(width) * 1.2, -row * Math.trunc(depth) * 1.2];
}

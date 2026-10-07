// Encoder/decoder for the per-triangle painting strings stored in 3MF files
// (paint_color / paint_supports / paint_seam in Bambu Studio & OrcaSlicer,
//  slic3rpe:mmu_segmentation / custom_supports / custom_seam in PrusaSlicer).
//
// The string is a hex dump of a bit stream, written in reverse order (last char = first nibble).
// Each triangle node starts with a nibble `xxyy`:
//   yy = number of split sides (0 = leaf). For split nodes xx = special side and the
//   (yy + 1) children follow in pre-order.
//   For leaves xx is the state (0..2). xx = 0b11 means an extended state follows:
//     Bambu/Orca: zero or more 0xF nibbles (+15 each) and a final nibble; state = sum + 3.
//     PrusaSlicer: one nibble z; if z != 0xE state = z + 3, otherwise 8 more bits hold state - 17.
// State n > 0 in paint_color means "filament n" (1-based).

function toNibbles(str) {
  const out = new Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const v = parseInt(str[str.length - 1 - i], 16);
    if (Number.isNaN(v)) return null;
    out[i] = v;
  }
  return out;
}

function fromNibbles(nibbles) {
  let s = '';
  for (let i = nibbles.length - 1; i >= 0; i--) s += nibbles[i].toString(16).toUpperCase();
  return s;
}

function encodeLeaf(state, out) {
  if (state < 3) {
    out.push(state << 2);
    return;
  }
  out.push(0b1100);
  let n = state - 3;
  while (n >= 15) {
    out.push(0xf);
    n -= 15;
  }
  out.push(n);
}

// Walks the stream, calling mapState for every leaf. Returns re-encoded nibbles (Bambu flavour).
function walk(nibbles, prusa, mapState) {
  let pos = 0;
  const out = [];
  const next = () => {
    if (pos >= nibbles.length) throw new Error('truncated paint data');
    return nibbles[pos++];
  };
  const node = () => {
    const code = next();
    const split = code & 0b11;
    if (split) {
      out.push(code);
      for (let c = 0; c <= split; c++) node();
      return;
    }
    let state;
    if ((code & 0b1100) === 0b1100) {
      if (prusa) {
        const z = next();
        if (z !== 0b1110) state = z + 3;
        else {
          const lo = next();
          const hi = next();
          state = (lo | (hi << 4)) + 17;
        }
      } else {
        let num = 0;
        let z = next();
        while (z === 0xf) {
          num++;
          z = next();
        }
        state = z + 15 * num + 3;
      }
    } else state = code >> 2;
    encodeLeaf(mapState(state), out);
  };
  node();
  return out;
}

// Returns the set of states used in a painting string.
export function paintStates(str, prusa = false) {
  const states = new Set();
  const nib = toNibbles(str || '');
  if (!nib || !nib.length) return states;
  try {
    walk(nib, prusa, (s) => {
      states.add(s);
      return s;
    });
  } catch {
    /* ignore malformed data */
  }
  return states;
}

// Re-encodes a painting string in Bambu format, remapping every state through mapState.
// Returns '' when the triangle ends up unpainted, or null if the input is malformed.
export function remapPaint(str, mapState, prusa = false) {
  const nib = toNibbles(str || '');
  if (!nib) return null;
  if (!nib.length) return '';
  let out;
  try {
    out = walk(nib, prusa, mapState);
  } catch {
    return null;
  }
  if (out.length === 1 && out[0] === 0) return '';
  return fromNibbles(out);
}

// Painting string for a whole (unsplit) triangle painted with `state`.
export function leafPaint(state) {
  if (!state) return '';
  const out = [];
  encodeLeaf(state, out);
  return fromNibbles(out);
}

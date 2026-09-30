// Fast, regex based readers for 3MF model XML (3D/*.model). Meshes can be huge, so we avoid
// building a DOM and only extract what the converter needs.

import { decodeEntities, parseAttrs } from './xml.js';
import { parseTransform, emptyBox, extendBox } from './geom.js';

const UNIT_SCALE = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export const PAINT_ATTRS = {
  paint_color: 'paint_color',
  'slic3rpe:mmu_segmentation': 'paint_color',
  paint_supports: 'paint_supports',
  'slic3rpe:custom_supports': 'paint_supports',
  paint_seam: 'paint_seam',
  'slic3rpe:custom_seam': 'paint_seam',
  paint_fuzzy_skin: 'paint_fuzzy_skin',
  'slic3rpe:fuzzy_skin': 'paint_fuzzy_skin',
};

// Structure of a model file without mesh data: objects (with text ranges), components, build items,
// materials and metadata.
export function scanModel(text) {
  const out = { unit: 'millimeter', scale: 1, metadata: {}, objects: new Map(), items: [], basematerials: {}, colorgroups: {} };
  const modelTag = /<(?:\w+:)?model\b([^>]*)>/.exec(text);
  if (modelTag) {
    const a = parseAttrs(modelTag[1]);
    if (a.unit) {
      out.unit = a.unit;
      out.scale = UNIT_SCALE[a.unit] || 1;
    }
    out.modelAttrs = a;
  }
  // Metadata before resources (the only place where it matters for us).
  const resStart = text.search(/<(?:\w+:)?resources\b/);
  const head = resStart >= 0 ? text.slice(0, resStart) : text.slice(0, 20000);
  const metaRe = /<(?:\w+:)?metadata\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?metadata>)/g;
  let m;
  while ((m = metaRe.exec(head))) {
    const a = parseAttrs(m[1]);
    if (a.name) out.metadata[a.name] = decodeEntities(m[2] || a.value || '');
  }

  const objRe = /<(\w+:)?object\b([^>]*?)(\/)?>/g;
  while ((m = objRe.exec(text))) {
    const attrs = parseAttrs(m[2]);
    const start = objRe.lastIndex;
    let end = start;
    if (!m[3]) {
      end = text.indexOf(m[1] ? `</${m[1]}object>` : '</object>', start);
      if (end < 0) end = text.length;
    }
    const obj = {
      id: attrs.id,
      name: attrs.name || '',
      type: attrs.type || 'model',
      pid: attrs.pid,
      pindex: attrs.pindex,
      uuid: attrs['p:UUID'],
      attrs,
      start,
      end,
      hasMesh: false,
      components: [],
      metadata: {},
    };
    const body = text.slice(start, Math.min(end, start + 4096));
    obj.hasMesh = /<(?:\w+:)?mesh\b/.test(body) || text.slice(start, end).search(/<(?:\w+:)?mesh\b/) >= 0;
    if (!obj.hasMesh) {
      const compRe = /<(?:\w+:)?component\b([^>]*?)\/?>/g;
      const block = text.slice(start, end);
      let c;
      while ((c = compRe.exec(block))) {
        const ca = parseAttrs(c[1]);
        obj.components.push({ objectid: ca.objectid, path: ca['p:path'] || ca.path || null, transform: parseTransform(ca.transform), attrs: ca });
      }
    }
    // Object level metadata (Cura writes <metadatagroup><metadata name="cura:...">)
    const block = obj.hasMesh ? text.slice(start, Math.min(end, start + 20000)).split(/<(?:\w+:)?mesh\b/)[0] : text.slice(start, end);
    const omRe = /<(?:\w+:)?metadata\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?metadata>)/g;
    let om;
    while ((om = omRe.exec(block))) {
      const a = parseAttrs(om[1]);
      if (a.name) obj.metadata[a.name] = decodeEntities(om[2] || a.value || '');
    }
    out.objects.set(String(attrs.id), obj);
    objRe.lastIndex = Math.max(objRe.lastIndex, end);
  }

  // Materials (core basematerials + materials extension colorgroup).
  const bmRe = /<(?:\w+:)?basematerials\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?basematerials>/g;
  while ((m = bmRe.exec(text))) {
    const id = parseAttrs(m[1]).id;
    const list = [];
    const baseRe = /<(?:\w+:)?base\b([^>]*?)\/?>/g;
    let b;
    while ((b = baseRe.exec(m[2]))) {
      const a = parseAttrs(b[1]);
      list.push({ name: a.name || '', color: normColor(a.displaycolor) });
    }
    out.basematerials[id] = list;
  }
  const cgRe = /<(?:\w+:)?colorgroup\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?colorgroup>/g;
  while ((m = cgRe.exec(text))) {
    const id = parseAttrs(m[1]).id;
    const list = [];
    const cRe = /<(?:\w+:)?color\b([^>]*?)\/?>/g;
    let c;
    while ((c = cRe.exec(m[2]))) list.push({ name: '', color: normColor(parseAttrs(c[1]).color) });
    out.colorgroups[id] = list;
  }

  const buildStart = text.search(/<(?:\w+:)?build\b/);
  if (buildStart >= 0) {
    const itemRe = /<(?:\w+:)?item\b([^>]*?)\/?>/g;
    itemRe.lastIndex = buildStart;
    while ((m = itemRe.exec(text))) {
      const a = parseAttrs(m[1]);
      out.items.push({ objectid: a.objectid, transform: parseTransform(a.transform), printable: a.printable, path: a['p:path'] || null, attrs: a, tagStart: m.index, tagEnd: itemRe.lastIndex });
    }
  }
  return out;
}

export function normColor(c) {
  if (!c) return '';
  let s = String(c).trim();
  if (!s.startsWith('#')) return '';
  s = s.toUpperCase();
  if (s.length === 4) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  if (s.length === 9) s = s.slice(0, 7);
  return /^#[0-9A-F]{6}$/.test(s) ? s : '';
}

// Bounding box of an object's mesh (object coordinates, unscaled).
export function meshBox(text, obj) {
  const box = emptyBox();
  const re = /<(?:\w+:)?vertex\b([^>]*?)\/?>/g;
  re.lastIndex = obj.start;
  let m;
  while ((m = re.exec(text)) && m.index < obj.end) {
    const a = m[1];
    extendBox(box, [num(a, 'x'), num(a, 'y'), num(a, 'z')]);
  }
  return box;
}

function num(attrs, name) {
  const k = attrs.indexOf(` ${name}="`);
  const i = k >= 0 ? k + name.length + 3 : attrs.indexOf(`${name}="`) === 0 ? name.length + 2 : -1;
  if (i < 0) return 0;
  return parseFloat(attrs.slice(i, attrs.indexOf('"', i)));
}

function strAttr(attrs, name) {
  const k = attrs.indexOf(` ${name}="`);
  if (k < 0) return undefined;
  const i = k + name.length + 3;
  return attrs.slice(i, attrs.indexOf('"', i));
}

// Full mesh of an object: vertices, triangles, per-triangle material refs and painting strings.
export function readMesh(text, obj) {
  const verts = [];
  const tris = [];
  const triPid = [];
  const triP1 = [];
  const paint = {};
  let hasPid = false;
  const re = /<(?:\w+:)?(vertex|triangle)\b([^>]*?)\/?>/g;
  re.lastIndex = obj.start;
  let m;
  while ((m = re.exec(text)) && m.index < obj.end) {
    const a = m[2];
    if (m[1] === 'vertex') {
      verts.push(num(a, 'x'), num(a, 'y'), num(a, 'z'));
    } else {
      const t = tris.length / 3;
      tris.push(num(a, 'v1') | 0, num(a, 'v2') | 0, num(a, 'v3') | 0);
      const pid = strAttr(a, 'pid');
      const p1 = strAttr(a, 'p1');
      if (pid !== undefined || p1 !== undefined) {
        hasPid = true;
        triPid[t] = pid;
        triP1[t] = p1;
      }
      if (a.indexOf('paint') >= 0 || a.indexOf('slic3rpe:') >= 0 || a.indexOf('fuzzy') >= 0) {
        for (const [attrName, key] of Object.entries(PAINT_ATTRS)) {
          const v = strAttr(a, attrName);
          if (v) (paint[key] ||= [])[t] = v;
        }
      }
    }
  }
  return {
    vertices: Float64Array.from(verts),
    triangles: Uint32Array.from(tris),
    triPid: hasPid ? triPid : null,
    triP1: hasPid ? triP1 : null,
    paint,
    prusaPaint: /slic3rpe:mmu_segmentation/.test(text.slice(obj.start, Math.min(obj.end, obj.start + 2_000_000))),
  };
}

// Distinct painting strings of a whole model file (used to find which filaments are painted).
export function collectPaintStrings(text, attrName = 'paint_color') {
  const set = new Set();
  const re = new RegExp(`\\s${attrName.replace(':', '\\:')}="([0-9A-Fa-f]+)"`, 'g');
  let m;
  while ((m = re.exec(text))) set.add(m[1]);
  return set;
}

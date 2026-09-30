// Reads a 3MF produced by any slicer into a neutral description the converter can work with.

import { parseXml, children, child, attr, findAll } from './xml.js';
import { scanModel, meshBox, readMesh, collectPaintStrings, normColor } from './model3mf.js';
import { paintStates } from './paint.js';
import { bedFromArea } from './profiles.js';
import { IDENTITY, multiply, applyPoint, emptyBox, extendBox, mergeBox, transformBox, boxValid, plateOrigin } from './geom.js';

export const FORMAT_LABELS = {
  bambu: 'Bambu Studio',
  orca: 'OrcaSlicer',
  snaporca: 'Snapmaker Orca (U1)',
  bbsfamily: 'Slicer basado en Bambu/Orca',
  prusa: 'PrusaSlicer',
  cura: 'UltiMaker Cura',
  generic: '3MF genérico',
};

export async function readText(zip, path) {
  const f = zip.file(path);
  return f ? f.async('string') : null;
}

function findFile(zip, re) {
  return Object.keys(zip.files).find((n) => re.test(n)) || null;
}

async function rootModelPath(zip) {
  const rels = await readText(zip, '_rels/.rels');
  if (rels) {
    const m = /Target="\/?([^"]+\.model)"/i.exec(rels);
    if (m && zip.file(m[1])) return m[1];
  }
  return findFile(zip, /^3D\/3dmodel\.model$/i) || findFile(zip, /\.model$/i);
}

// ---------------------------------------------------------------------------------------------
// Config readers

export function parseIni(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*;?\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function parseCuraCfg(text) {
  const out = { sections: {} };
  let sec = '';
  for (const line of text.split(/\r?\n/)) {
    const s = /^\s*\[(.+)\]\s*$/.exec(line);
    if (s) {
      sec = s[1];
      out.sections[sec] ||= {};
      continue;
    }
    const m = /^\s*([^=#;]+?)\s*=\s*(.*)$/.exec(line);
    if (m && sec) out.sections[sec][m[1]] = m[2].trim();
  }
  return out;
}

// Splits PrusaSlicer list values: `"a";"b"` or `#fff;#000`.
export function splitPrusaList(v) {
  if (v == null || v === '') return [];
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^;]+)/g;
  let m;
  while ((m = re.exec(v))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2].trim());
  return out;
}

// ---------------------------------------------------------------------------------------------

export async function readSource(zip) {
  const warnings = [];
  const rootPath = await rootModelPath(zip);
  if (!rootPath) throw new Error('El archivo no contiene un modelo 3MF (3D/3dmodel.model).');
  const rootText = await readText(zip, rootPath);
  const root = scanModel(rootText);
  const app = root.metadata.Application || '';
  const names = Object.keys(zip.files);

  if (names.some((n) => /^Metadata\/plate_\d+\.gcode$/i.test(n)) && ![...root.objects.values()].length) {
    throw new Error('Es un archivo ya laminado (.gcode.3mf) sin geometría. Subí el proyecto 3MF original.');
  }

  let format = 'generic';
  const hasProject = !!zip.file('Metadata/project_settings.config');
  if (/^PrusaSlicer|^SuperSlicer|^Slic3r/i.test(app) || zip.file('Metadata/Slic3r_PE.config')) format = 'prusa';
  else if (/snapmaker/i.test(app) || /Snapmaker_Orca/.test(rootText.slice(0, 3000))) format = 'snaporca';
  else if (/^OrcaSlicer/i.test(app) || root.metadata.OrcaSlicer) format = 'orca';
  else if (/^BambuStudio/i.test(app)) format = 'bambu';
  else if (hasProject && zip.file('Metadata/model_settings.config')) format = 'bbsfamily';
  else if (/cura/i.test(app) || names.some((n) => /^Cura\//.test(n)) || /software\.ultimaker\.com/.test(rootText.slice(0, 3000))) format = 'cura';

  const src = { format, application: app, rootPath, rootText, root, warnings, config: {}, filaments: [], bed: null, printerModel: '' };

  if (['bambu', 'orca', 'snaporca', 'bbsfamily'].includes(format)) {
    if (hasProject) {
      try {
        src.config = JSON.parse(await readText(zip, 'Metadata/project_settings.config'));
      } catch {
        warnings.push('No se pudo leer project_settings.config; se usarán los valores por defecto.');
      }
    }
    await readBbsScene(zip, src);
  } else if (format === 'prusa') {
    const ini = await readText(zip, 'Metadata/Slic3r_PE.config');
    src.ini = ini ? parseIni(ini) : {};
    await readMeshScene(zip, src);
  } else if (format === 'cura') {
    src.cura = {};
    for (const n of names.filter((n) => /^Cura\/.*\.cfg$/i.test(n))) src.cura[n] = parseCuraCfg(await readText(zip, n));
    await readMeshScene(zip, src);
  } else {
    await readMeshScene(zip, src);
  }

  describeFilaments(src);
  src.bed = sourceBed(src);
  src.printerModel = src.config.printer_model || (src.ini && src.ini.printer_model) || '';
  markUsedFilaments(src);
  return src;
}

// ---------------------------------------------------------------------------------------------
// Bambu / Orca family: keep geometry files, read structure + model_settings.

async function readBbsScene(zip, src) {
  const { root, rootText } = src;
  const fileTexts = new Map([[src.rootPath, rootText]]);
  const scans = new Map([[src.rootPath, root]]);
  const getScan = async (path) => {
    const p = (path || src.rootPath).replace(/^\//, '');
    if (!scans.has(p)) {
      const t = await readText(zip, p);
      if (t == null) return null;
      fileTexts.set(p, t);
      scans.set(p, scanModel(t));
    }
    return { path: p, scan: scans.get(p), text: fileTexts.get(p) };
  };

  const objects = new Map();
  for (const [id, o] of root.objects) {
    const obj = { id, name: o.name, components: [], inlineMesh: o.hasMesh, bbox: emptyBox(), extruder: 1, config: {}, parts: [], instances: [], metadataOrder: [] };
    if (o.hasMesh) {
      mergeBox(obj.bbox, meshBox(rootText, o));
    }
    for (const c of o.components) {
      const f = await getScan(c.path);
      const sub = f && f.scan.objects.get(String(c.objectid));
      obj.components.push({ ...c, file: f ? f.path : null });
      if (sub && sub.hasMesh) mergeBox(obj.bbox, transformBox(meshBox(f.text, sub), c.transform));
    }
    objects.set(id, obj);
  }
  const items = root.items.map((it, i) => ({ ...it, index: i }));
  const instCount = new Map();
  for (const it of items) {
    const obj = objects.get(String(it.objectid));
    if (!obj) continue;
    const n = instCount.get(obj.id) || 0;
    instCount.set(obj.id, n + 1);
    it.instanceId = n;
    obj.instances.push({ item: it, transform: it.transform, instanceId: n });
  }

  // model_settings.config: names, extruders, per object/part settings, plates.
  let ms = null;
  const msText = await readText(zip, 'Metadata/model_settings.config');
  if (msText) {
    try {
      ms = parseXml(msText);
    } catch {
      src.warnings.push('model_settings.config dañado; se ignorarán los ajustes por objeto.');
    }
  }
  const plates = [];
  if (ms) {
    for (const on of children(ms, 'object')) {
      const obj = objects.get(String(attr(on, 'id')));
      if (!obj) continue;
      obj.settingsNode = on;
      for (const md of children(on, 'metadata')) {
        const k = attr(md, 'key');
        if (!k) continue;
        if (k === 'name') obj.name = attr(md, 'value') || obj.name;
        else if (k === 'extruder') obj.extruder = parseInt(attr(md, 'value'), 10) || 1;
        else obj.config[k] = attr(md, 'value');
      }
      for (const pn of children(on, 'part')) {
        const part = { id: attr(pn, 'id'), subtype: attr(pn, 'subtype') || 'normal_part', extruder: 0, config: {}, node: pn };
        for (const md of children(pn, 'metadata')) {
          const k = attr(md, 'key');
          if (k === 'extruder') part.extruder = parseInt(attr(md, 'value'), 10) || 0;
          else if (k && !['name', 'matrix'].includes(k) && !k.startsWith('source_')) part.config[k] = attr(md, 'value');
        }
        obj.parts.push(part);
      }
    }
    for (const pn of children(ms, 'plate')) {
      const p = { meta: {}, instances: [] };
      for (const md of children(pn, 'metadata')) p.meta[attr(md, 'key')] = attr(md, 'value');
      for (const mi of children(pn, 'model_instance')) {
        const m = {};
        for (const md of children(mi, 'metadata')) m[attr(md, 'key')] = attr(md, 'value');
        p.instances.push({ objectId: String(m.object_id), instanceId: parseInt(m.instance_id, 10) || 0, identifyId: m.identify_id });
      }
      p.id = parseInt(p.meta.plater_id, 10) || plates.length + 1;
      plates.push(p);
    }
    plates.sort((a, b) => a.id - b.id);
  }

  // Paint states used anywhere (paint_color).
  const usedStates = new Set();
  const paintFiles = [];
  for (const [p, t] of fileTexts) {
    const set = collectPaintStrings(t, 'paint_color');
    if (set.size) {
      paintFiles.push(p);
      for (const s of set) for (const st of paintStates(s)) usedStates.add(st);
    }
  }
  // Model files that were not reached through components (keep them anyway).
  src.scene = { kind: 'bbs', objects, items, plates, modelSettings: ms, fileTexts, paintFiles, usedStates };
}

// ---------------------------------------------------------------------------------------------
// PrusaSlicer / Cura / generic: parse meshes into objects & volumes.

async function readMeshScene(zip, src) {
  const { root, rootText } = src;
  const texts = new Map([[src.rootPath, rootText]]);
  const scans = new Map([[src.rootPath, root]]);
  const getFile = async (path) => {
    const p = (path || src.rootPath).replace(/^\//, '');
    if (!scans.has(p)) {
      const t = await readText(zip, p);
      if (t == null) return null;
      texts.set(p, t);
      scans.set(p, scanModel(t));
    }
    return { path: p, scan: scans.get(p), text: texts.get(p) };
  };

  // PrusaSlicer volumes (triangle ranges) and object settings.
  let prusaModel = null;
  if (src.format === 'prusa') {
    const t = await readText(zip, 'Metadata/Slic3r_PE_model.config');
    if (t) prusaModel = parseXml(t);
  }
  const prusaObjects = new Map();
  if (prusaModel) {
    for (const on of children(prusaModel, 'object')) {
      const o = { config: {}, volumes: [] };
      for (const md of children(on, 'metadata')) if (attr(md, 'type') === 'object') o.config[attr(md, 'key')] = attr(md, 'value');
      for (const vn of children(on, 'volume')) {
        const v = { first: parseInt(attr(vn, 'firstid'), 10), last: parseInt(attr(vn, 'lastid'), 10), config: {} };
        for (const md of children(vn, 'metadata')) v.config[attr(md, 'key')] = attr(md, 'value');
        o.volumes.push(v);
      }
      prusaObjects.set(String(attr(on, 'id')), o);
    }
  }

  // Colour palette: every distinct material colour gets a filament index.
  const palette = [];
  const paletteIndex = new Map();
  const colorToFilament = (color, name) => {
    const key = color || name || '#default';
    if (!paletteIndex.has(key)) {
      palette.push({ color: color || '', name: name || '' });
      paletteIndex.set(key, palette.length);
    }
    return paletteIndex.get(key);
  };
  const resolveMaterial = (scan, pid, pindex) => {
    if (pid === undefined || pid === null) return 0;
    const list = scan.basematerials[pid] || scan.colorgroups[pid];
    if (!list) return 0;
    const e = list[parseInt(pindex || '0', 10)] || list[0];
    return e ? colorToFilament(e.color, e.name) : 0;
  };

  const objects = [];
  // Flattens an object tree into leaf meshes with baked transforms.
  const collect = async (file, id, transform, inherited, out, depth = 0) => {
    const o = file.scan.objects.get(String(id));
    if (!o || depth > 16) return;
    const own = resolveMaterial(file.scan, o.pid, o.pindex) || inherited;
    if (o.hasMesh) {
      out.push({ file, obj: o, transform, material: own });
      return;
    }
    for (const c of o.components) {
      const f = c.path ? await getFile(c.path) : file;
      if (f) await collect(f, c.objectid, multiply(c.transform, transform), own, out, depth + 1);
    }
  };

  const rootFile = { path: src.rootPath, scan: root, text: rootText };
  const byObject = new Map();
  // Build item translations are expressed in the file unit; meshes are converted to millimetres.
  const itemTransform = (it) => {
    const t = it.transform.slice();
    for (let i = 9; i < 12; i++) t[i] *= root.scale;
    return t;
  };
  for (const it of root.items) {
    const key = `${it.path || ''}#${it.objectid}`;
    if (byObject.has(key)) {
      byObject.get(key).instances.push({ transform: itemTransform(it) });
      continue;
    }
    const file = it.path ? await getFile(it.path) : rootFile;
    if (!file) continue;
    const top = file.scan.objects.get(String(it.objectid));
    if (!top) continue;
    const leaves = [];
    await collect(file, it.objectid, IDENTITY, 0, leaves);
    if (!leaves.length) continue;
    const s = file.scan.scale;
    const unitScale = s === 1 ? null : [s, 0, 0, 0, s, 0, 0, 0, s, 0, 0, 0];
    const obj = { name: top.name || top.metadata.name || `Objeto ${objects.length + 1}`, extruder: 0, config: {}, volumes: [], instances: [], bbox: emptyBox(), meta: top.metadata };
    const pObj = prusaObjects.get(String(it.objectid));
    if (pObj) {
      obj.config = { ...pObj.config };
      if (pObj.config.name) obj.name = pObj.config.name;
      obj.extruder = parseInt(pObj.config.extruder, 10) || 0;
    }
    for (const leaf of leaves) {
      const mesh = readMesh(leaf.file.text, leaf.obj);
      const t = unitScale ? multiply(leaf.transform, unitScale) : leaf.transform;
      bake(mesh.vertices, t);
      // Per-triangle colours -> painting.
      let triMat = null;
      if (mesh.triPid) {
        triMat = new Array(mesh.triangles.length / 3);
        for (let i = 0; i < triMat.length; i++) {
          const pid = mesh.triPid[i] ?? leaf.obj.pid;
          const p1 = mesh.triP1[i] ?? leaf.obj.pindex;
          triMat[i] = pid !== undefined ? resolveMaterial(leaf.file.scan, pid, p1) : 0;
        }
      }
      const baseVolume = { name: leaf.obj.name || obj.name, subtype: 'normal_part', extruder: leaf.material, config: {}, mesh, triMat, prusaPaint: mesh.prusaPaint };
      if (pObj && pObj.volumes.length) {
        for (const v of pObj.volumes) obj.volumes.push(sliceVolume(baseVolume, v, obj.name));
      } else {
        if (src.format === 'cura') applyCuraMeshType(baseVolume, leaf.obj.metadata, top.metadata);
        obj.volumes.push(baseVolume);
      }
    }
    if (src.format === 'cura') {
      const e = top.metadata['cura:extruder_nr'];
      if (e !== undefined) obj.extruder = (parseInt(e, 10) || 0) + 1;
      for (const [k, v] of Object.entries(top.metadata)) if (k.startsWith('cura:')) obj.config[k.slice(5)] = v;
    }
    // Object extruder: most common volume material when no explicit extruder.
    if (!obj.extruder) {
      const counts = new Map();
      for (const v of obj.volumes) if (v.subtype === 'normal_part' && v.extruder) counts.set(v.extruder, (counts.get(v.extruder) || 0) + v.mesh.triangles.length);
      obj.extruder = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 1;
    }
    for (const v of obj.volumes) {
      if (v.subtype === 'normal_part') {
        const b = emptyBox();
        const vs = v.mesh.vertices;
        for (let i = 0; i < vs.length; i += 3) extendBox(b, [vs[i], vs[i + 1], vs[i + 2]]);
        mergeBox(obj.bbox, b);
      }
    }
    obj.instances.push({ transform: itemTransform(it) });
    byObject.set(key, obj);
    objects.push(obj);
  }
  src.palette = palette;
  src.scene = { kind: 'mesh', objects, plates: null };
}

function bake(vertices, m) {
  if (m.every((v, i) => v === IDENTITY[i])) return;
  for (let i = 0; i < vertices.length; i += 3) {
    const p = applyPoint(m, vertices[i], vertices[i + 1], vertices[i + 2]);
    vertices[i] = p[0];
    vertices[i + 1] = p[1];
    vertices[i + 2] = p[2];
  }
}

const PRUSA_VOLUME_TYPES = {
  ModelPart: 'normal_part',
  NegativeVolume: 'negative_part',
  ParameterModifier: 'modifier_part',
  SupportEnforcer: 'support_enforcer',
  SupportBlocker: 'support_blocker',
};

// Extracts the triangle range of a PrusaSlicer volume into its own mesh.
function sliceVolume(base, v, objName) {
  const { mesh } = base;
  const first = Math.max(0, v.first);
  const last = Math.min(mesh.triangles.length / 3 - 1, v.last);
  const map = new Map();
  const verts = [];
  const tris = [];
  const paint = {};
  const triMat = base.triMat ? [] : null;
  for (let t = first; t <= last; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = mesh.triangles[t * 3 + k];
      if (!map.has(vi)) {
        map.set(vi, verts.length / 3);
        verts.push(mesh.vertices[vi * 3], mesh.vertices[vi * 3 + 1], mesh.vertices[vi * 3 + 2]);
      }
      tris.push(map.get(vi));
    }
    for (const [k, arr] of Object.entries(mesh.paint)) if (arr[t]) (paint[k] ||= [])[t - first] = arr[t];
    if (triMat) triMat.push(base.triMat[t]);
  }
  const cfg = { ...v.config };
  const subtype = PRUSA_VOLUME_TYPES[cfg.volume_type] || (cfg.modifier === '1' ? 'modifier_part' : 'normal_part');
  const name = cfg.name || objName;
  const extruder = parseInt(cfg.extruder, 10) || base.extruder || 0;
  for (const k of ['name', 'volume_type', 'modifier', 'extruder', 'matrix', 'mesh_stats', 'source_file', 'source_object_id', 'source_volume_id', 'source_offset_x', 'source_offset_y', 'source_offset_z', 'source_in_inches', 'source_in_meters']) delete cfg[k];
  for (const k of Object.keys(cfg)) if (k.startsWith('source_')) delete cfg[k];
  return {
    name,
    subtype,
    extruder,
    config: cfg,
    mesh: { vertices: Float64Array.from(verts), triangles: Uint32Array.from(tris), paint },
    triMat,
    prusaPaint: true,
  };
}

function applyCuraMeshType(vol, meta, topMeta) {
  const m = { ...topMeta, ...meta };
  const on = (k) => m[k] === 'True' || m[k] === 'true' || m[k] === '1';
  if (on('cura:anti_overhang_mesh')) vol.subtype = 'support_blocker';
  else if (on('cura:support_mesh')) vol.subtype = 'support_enforcer';
  else if (on('cura:cutting_mesh')) vol.subtype = 'modifier_part';
  else if (on('cura:infill_mesh')) vol.subtype = 'modifier_part';
}

// ---------------------------------------------------------------------------------------------
// Filaments of the source file.

function describeFilaments(src) {
  const f = [];
  const c = src.config;
  if (['bambu', 'orca', 'snaporca', 'bbsfamily'].includes(src.format) && Array.isArray(c.filament_colour)) {
    const n = c.filament_colour.length;
    for (let i = 0; i < n; i++) {
      f.push({
        index: i + 1,
        color: normColor(c.filament_colour[i]) || '#FFFFFF',
        type: (c.filament_type || [])[i] || '',
        name: (c.filament_settings_id || [])[i] || '',
        vendor: (c.filament_vendor || [])[i] || '',
      });
    }
  } else if (src.format === 'prusa') {
    const ini = src.ini;
    const colors = splitPrusaList(ini.filament_colour);
    const ecolors = splitPrusaList(ini.extruder_colour);
    const types = splitPrusaList(ini.filament_type);
    const names = splitPrusaList(ini.filament_settings_id);
    const vendors = splitPrusaList(ini.filament_vendor);
    const n = Math.max(colors.length, ecolors.length, types.length, names.length, 1);
    for (let i = 0; i < n; i++) {
      f.push({
        index: i + 1,
        color: normColor(ecolors[i]) || normColor(colors[i]) || '#FFFFFF',
        type: types[i] || types[0] || 'PLA',
        name: names[i] || '',
        vendor: vendors[i] || '',
      });
    }
  } else if (src.format === 'cura') {
    const exts = Object.entries(src.cura)
      .filter(([n, cfg]) => cfg.sections.metadata && cfg.sections.metadata.position !== undefined && /extruder/i.test(n))
      .sort((a, b) => a[1].sections.metadata.position - b[1].sections.metadata.position);
    for (const [, cfg] of exts) {
      const mat = (cfg.sections.containers && Object.values(cfg.sections.containers).find((v) => /pla|petg|abs|tpu|asa|nylon|pva|pc|cpe|hips|bvoh|tough/i.test(v))) || '';
      f.push({ index: f.length + 1, color: '', type: curaMaterialType(mat), name: mat, vendor: '' });
    }
  }
  // Per-triangle / per-object colours of generic files.
  if (src.palette && src.palette.length) {
    const pal = src.palette.map((p, i) => ({ index: i + 1, color: p.color || '', type: guessType(p.name), name: p.name, vendor: '' }));
    if (!f.length || src.format === 'generic') f.splice(0, f.length, ...pal);
  }
  if (!f.length) f.push({ index: 1, color: '', type: 'PLA', name: '', vendor: '' });
  const defaults = ['#FFFFFF', '#000000', '#E74C3C', '#3498DB', '#2ECC71', '#F1C40F', '#9B59B6', '#E67E22'];
  f.forEach((x, i) => {
    if (!x.color) x.color = defaults[i % defaults.length];
    if (!x.type) x.type = 'PLA';
  });
  src.filaments = f;
}

function curaMaterialType(id) {
  const s = String(id).toLowerCase();
  if (/tpu|flex/.test(s)) return 'TPU';
  if (/petg|cpe/.test(s)) return 'PETG';
  if (/abs/.test(s)) return 'ABS';
  if (/asa/.test(s)) return 'ASA';
  if (/nylon|\bpa\b/.test(s)) return 'PA';
  if (/pva/.test(s)) return 'PVA';
  if (/\bpc\b/.test(s)) return 'PC';
  if (/hips/.test(s)) return 'HIPS';
  if (/bvoh/.test(s)) return 'BVOH';
  return 'PLA';
}

function guessType(name) {
  const m = String(name || '').toUpperCase().match(/\b(PLA|PETG|ABS|ASA|TPU|PVA|PA|PC|HIPS)\b/);
  return m ? m[1] : 'PLA';
}

function sourceBed(src) {
  const c = src.config;
  if (c.printable_area) return bedFromArea(c.printable_area, c.printable_height);
  if (src.ini && src.ini.bed_shape) return bedFromArea(src.ini.bed_shape.split(','), src.ini.max_print_height);
  if (src.cura) {
    for (const cfg of Object.values(src.cura)) {
      const v = cfg.sections.values || {};
      if (v.machine_width && v.machine_depth) return { minX: 0, minY: 0, maxX: +v.machine_width, maxY: +v.machine_depth, w: +v.machine_width, d: +v.machine_depth, h: +v.machine_height || 0 };
    }
  }
  return null;
}

// Which source filaments does the model actually use?
function markUsedFilaments(src) {
  const used = new Set();
  const sc = src.scene;
  if (sc.kind === 'bbs') {
    for (const o of sc.objects.values()) {
      if (!o.instances.length) continue;
      used.add(o.extruder || 1);
      for (const p of o.parts) if (p.extruder) used.add(p.extruder);
      for (const k of ['wall_filament', 'sparse_infill_filament', 'solid_infill_filament', 'support_filament', 'support_interface_filament']) {
        const v = parseInt(o.config[k], 10);
        if (v > 0) used.add(v);
      }
    }
    for (const s of sc.usedStates) if (s > 0) used.add(s);
    for (const k of ['support_filament', 'support_interface_filament', 'wall_filament', 'sparse_infill_filament', 'solid_infill_filament']) {
      const v = parseInt(src.config[k], 10);
      if (v > 0) used.add(v);
    }
  } else {
    for (const o of sc.objects) {
      used.add(o.extruder || 1);
      for (const v of o.volumes) {
        if (v.extruder) used.add(v.extruder);
        if (v.triMat) for (const m of v.triMat) if (m) used.add(m);
        const pc = v.mesh.paint.paint_color;
        if (pc) {
          const seen = new Set();
          for (const s of pc) if (s && !seen.has(s)) {
            seen.add(s);
            for (const st of paintStates(s, v.prusaPaint)) if (st > 0) used.add(st);
          }
        }
      }
    }
    if (src.ini) {
      for (const k of ['support_material_extruder', 'support_material_interface_extruder', 'perimeter_extruder', 'infill_extruder', 'solid_infill_extruder']) {
        const v = parseInt(src.ini[k], 10);
        if (v > 0) used.add(v);
      }
    }
  }
  // Extend the filament list if the model references more extruders than described.
  const max = Math.max(...used, src.filaments.length);
  for (let i = src.filaments.length + 1; i <= max; i++) src.filaments.push({ index: i, color: '#808080', type: 'PLA', name: '', vendor: '' });
  for (const f of src.filaments) f.used = used.has(f.index);
  if (!src.filaments.some((f) => f.used)) src.filaments[0].used = true;
}

// World-space bounding box of every instance, and its plate (Bambu/Orca files).
export function instanceBoxes(src) {
  const sc = src.scene;
  const out = [];
  if (sc.kind === 'bbs') {
    const plateOf = new Map();
    sc.plates.forEach((p, pi) => p.instances.forEach((i) => plateOf.set(`${i.objectId}:${i.instanceId}`, pi)));
    const bed = src.bed || { minX: 0, minY: 0, w: 256, d: 256 };
    const plateCount = Math.max(1, sc.plates.length);
    for (const o of sc.objects.values()) {
      for (const inst of o.instances) {
        const box = transformBox(o.bbox, inst.transform);
        let plate = plateOf.get(`${o.id}:${inst.instanceId}`);
        if (plate === undefined) plate = guessPlate(box, bed, plateCount);
        out.push({ object: o, inst, box, plate });
      }
    }
  } else {
    for (const o of sc.objects) for (const inst of o.instances) out.push({ object: o, inst, box: transformBox(o.bbox, inst.transform), plate: 0 });
  }
  return out;
}

function guessPlate(box, bed, count) {
  if (!boxValid(box)) return 0;
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  for (let i = 0; i < count; i++) {
    const [ox, oy] = plateOrigin(i, count, bed.w, bed.d);
    if (cx >= ox + bed.minX - bed.w * 0.1 && cx <= ox + bed.minX + bed.w * 1.1 && cy >= oy + bed.minY - bed.d * 0.1 && cy <= oy + bed.minY + bed.d * 1.1) return i;
  }
  return 0;
}

export { findAll, child };

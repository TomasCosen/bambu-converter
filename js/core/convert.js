// Any 3MF -> slicer project for the target printer (Bambu Studio: A1 / A1 mini / A2L, Snapmaker Orca: U1).

import { readSource, instanceBoxes, FORMAT_LABELS } from './source.js';
import { parseXml, serializeXml, children, attr, escapeXml } from './xml.js';
import { remapPaint, leafPaint } from './paint.js';
import { normColor } from './model3mf.js';
import {
  TRANSFER_KEYS, TUNED_KEYS, FILAMENT_INDEX_KEYS, normalizeValue, shapeLike, sameValue, fromPrusa, fromPrusaObject, fromCura, curaValues,
} from './settings.js';
import { formatTransform, formatNumber, translate, plateOrigin, boxValid } from './geom.js';
import { presetBase, normalizeType } from './profiles.js';

export const BED_TYPE_LABELS = {
  'Textured PEI Plate': 'Placa PEI texturizada',
  'High Temp Plate': 'Placa PEI lisa (High Temp)',
  'Cool Plate': 'Cool Plate',
  'Supertack Plate': 'Cool Plate SuperTack',
  'Engineering Plate': 'Engineering Plate',
  'Textured Cool Plate': 'Cool Plate texturizada',
  'Graphic Effect Plate': 'Placa de efecto gráfico',
};
const MAX_PLATES = 36;
const BED_TEMP_KEY = {
  'Cool Plate': 'cool_plate_temp',
  'Engineering Plate': 'eng_plate_temp',
  'High Temp Plate': 'hot_plate_temp',
  'Textured PEI Plate': 'textured_plate_temp',
  'Supertack Plate': 'supertack_plate_temp',
  'Textured Cool Plate': 'textured_cool_plate_temp',
  'Graphic Effect Plate': 'graphic_effect_plate_temp',
};

// Accepts either a Catalog (several vendors) or a single Profiles object.
function profilesFor(catalogOrProfiles, printer) {
  return catalogOrProfiles.forPrinter ? catalogOrProfiles.forPrinter(printer) : catalogOrProfiles;
}

// Bed types every selected filament can be printed on (a plate temperature of 0 means "not supported").
export function supportedBedTypes(profiles, slots, printer) {
  return profiles.bedTypes(printer).filter((bt) =>
    slots.every((s) => {
      const key = BED_TEMP_KEY[bt];
      const v = key && profiles.filament(s.preset)[key];
      return v === undefined || parseFloat(Array.isArray(v) ? v[0] : v) > 0;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Analysis & suggestions

export async function analyze(zip, catalog) {
  const src = await readSource(zip);
  src.formatLabel = FORMAT_LABELS[src.format] || src.format;
  src.process = sourceProcess(src);
  const diff = Array.isArray(src.config.different_settings_to_system) ? src.config.different_settings_to_system[0] : '';
  src.userModified = new Set(String(diff || '').split(';').filter(Boolean));
  src.boxes = instanceBoxes(src);
  const printer = suggestPrinter(src, catalog);
  const profiles = profilesFor(catalog, printer);
  const nozzle = suggestNozzle(src, profiles, printer);
  return { src, options: defaultOptions(src, profiles, printer, nozzle) };
}

function sourceProcess(src) {
  if (src.format === 'prusa') return fromPrusa(src.ini || {});
  if (src.format === 'cura') return fromCura(curaValues(src.cura));
  const out = {};
  for (const k of TRANSFER_KEYS) if (src.config[k] !== undefined) out[k] = src.config[k];
  return out;
}

function suggestPrinter(src, catalog) {
  const models = catalog.printerModels();
  if (models.includes(src.printerModel)) return src.printerModel;
  const mini = models.find((m) => /A1 mini/i.test(m));
  const big = models.find((m) => /Bambu Lab A1$/.test(m)) || models.find((m) => !/mini/i.test(m));
  if (src.bed && src.bed.w <= 185 && src.bed.d <= 185 && mini) return mini;
  return big || models[0];
}

function suggestNozzle(src, profiles, printer) {
  const available = profiles.nozzles(printer);
  let d = parseFloat(Array.isArray(src.config.nozzle_diameter) ? src.config.nozzle_diameter[0] : src.config.nozzle_diameter);
  if (!d && src.ini) d = parseFloat(String(src.ini.nozzle_diameter || '').split(/[;,]/)[0]);
  if (!d) return available.includes('0.4') ? '0.4' : available[0];
  return available.reduce((best, n) => (Math.abs(n - d) < Math.abs(best - d) ? n : best), available[0]);
}

export function defaultOptions(src, catalog, printer, nozzle, previous = null) {
  const profiles = profilesFor(catalog, printer);
  const layer = parseFloat(src.process.layer_height);
  const hint = src.config.print_settings_id || (src.ini && src.ini.print_settings_id) || '';
  const process = profiles.suggestProcess(printer, nozzle, layer, hint);
  const used = src.filaments.filter((f) => f.used);
  const slots = [];
  const map = {};
  for (const f of src.filaments) {
    if (!f.used) {
      map[f.index] = null;
      continue;
    }
    const prev = previous && previous.map[f.index];
    const reuse = prev && previous.slots[prev - 1];
    const sug = profiles.suggestFilament(printer, nozzle, f);
    slots.push({ preset: sug.name, color: reuse ? reuse.color : f.color, exact: sug.exact, source: f.index });
    map[f.index] = slots.length;
  }
  if (!slots.length) {
    const sug = profiles.suggestFilament(printer, nozzle, used[0] || src.filaments[0]);
    slots.push({ preset: sug.name, color: src.filaments[0].color, source: 1 });
    map[src.filaments[0].index] = 1;
  }
  const preferred = profiles.printerInfo(printer).default_bed_type || 'Textured PEI Plate';
  let bedType = previous ? previous.bedType : normalizeValue(profiles, 'curr_bed_type', src.config.curr_bed_type) || preferred;
  const beds = supportedBedTypes(profiles, slots, printer);
  if (!beds.includes(bedType)) bedType = beds.includes(preferred) ? preferred : beds[0] || preferred;
  return {
    printer,
    nozzle,
    process,
    processManual: false,
    bedType,
    transferSettings: previous ? previous.transferSettings : true,
    placement: previous ? previous.placement : src.scene.kind === 'bbs' && src.bed ? 'keep' : 'center',
    slots,
    map,
  };
}

// ---------------------------------------------------------------------------------------------
// Placement

// Returns [{ entry, transform, plate }] for every instance, plus the plate count.
export function planPlacement(src, catalog, opts) {
  const profiles = profilesFor(catalog, opts.printer);
  const bed = profiles.bed(opts.printer, opts.nozzle);
  const boxes = src.boxes;
  const cx = (bed.minX + bed.maxX) / 2;
  const cy = (bed.minY + bed.maxY) / 2;
  const result = [];
  const warnings = [];
  let mode = opts.placement;
  if (mode === 'keep' && !(src.scene.kind === 'bbs' && src.bed)) mode = 'center';

  if (mode === 'arrange') {
    const r = arrange(boxes, bed);
    result.push(...r.placed);
    if (r.overflow.length) warnings.push(`${r.overflow.length} objeto(s) no entran en la cama y quedaron sin reubicar.`);
  } else {
    const groups = new Map();
    for (const b of boxes) {
      if (!groups.has(b.plate)) groups.set(b.plate, []);
      groups.get(b.plate).push(b);
    }
    const srcCount = Math.max(1, src.scene.plates ? src.scene.plates.length : 1, ...boxes.map((b) => b.plate + 1));
    for (const [plate, list] of groups) {
      let dx, dy;
      if (mode === 'keep') {
        const sb = src.bed;
        const [ox, oy] = plateOrigin(plate, srcCount, sb.w, sb.d);
        dx = cx - (ox + (sb.minX + sb.maxX) / 2);
        dy = cy - (oy + (sb.minY + sb.maxY) / 2);
      } else {
        const g = groupBox(list);
        dx = cx - (g.min[0] + g.max[0]) / 2;
        dy = cy - (g.min[1] + g.max[1]) / 2;
      }
      for (const b of list) result.push({ entry: b, dx, dy, plate });
    }
  }
  const plateCount = Math.min(MAX_PLATES, Math.max(1, ...result.map((r) => r.plate + 1)));
  for (const r of result) {
    const [ox, oy] = plateOrigin(r.plate, plateCount, bed.w, bed.d);
    const dz = src.scene.kind === 'mesh' && boxValid(r.entry.box) ? -r.entry.box.min[2] : 0;
    r.transform = translate(r.entry.inst.transform, r.dx + ox, r.dy + oy, dz);
    const b = r.entry.box;
    if (boxValid(b)) {
      const w = b.max[0] - b.min[0];
      const d = b.max[1] - b.min[1];
      const minX = b.min[0] + r.dx, maxX = b.max[0] + r.dx, minY = b.min[1] + r.dy, maxY = b.max[1] + r.dy;
      r.fits = minX >= bed.minX - 0.5 && maxX <= bed.maxX + 0.5 && minY >= bed.minY - 0.5 && maxY <= bed.maxY + 0.5;
      r.tooBig = w > bed.w + 0.01 || d > bed.d + 0.01;
      r.tooTall = b.max[2] - b.min[2] > bed.h + 0.01;
    } else r.fits = true;
  }
  const names = (f) => [...new Set(result.filter(f).map((r) => r.entry.object.name || 'objeto'))].slice(0, 5).join(', ');
  if (result.some((r) => r.tooBig)) warnings.push(`Hay objetos más grandes que la cama (${bed.w}×${bed.d} mm): ${names((r) => r.tooBig)}. Escalalos o cortalos en ${profiles.vendor.slicer}.`);
  else if (result.some((r) => !r.fits)) warnings.push(`Algunos objetos quedan fuera de la cama: ${names((r) => !r.fits)}. Probá la opción “Reorganizar automáticamente”.`);
  if (result.some((r) => r.tooTall)) warnings.push(`Hay objetos más altos que el volumen de impresión (${bed.h} mm): ${names((r) => r.tooTall)}.`);
  return { placements: result, plateCount, warnings, bed, mode };
}

function groupBox(list) {
  const g = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const b of list) {
    if (!boxValid(b.box)) continue;
    for (let i = 0; i < 3; i++) {
      g.min[i] = Math.min(g.min[i], b.box.min[i]);
      g.max[i] = Math.max(g.max[i], b.box.max[i]);
    }
  }
  if (!boxValid(g)) return { min: [0, 0, 0], max: [0, 0, 0] };
  return g;
}

// Simple shelf packing, one plate after another.
function arrange(boxes, bed) {
  const gap = 6;
  const margin = 5;
  const items = boxes
    .map((b) => ({ b, w: boxValid(b.box) ? b.box.max[0] - b.box.min[0] : 10, d: boxValid(b.box) ? b.box.max[1] - b.box.min[1] : 10 }))
    .sort((a, c) => c.d - a.d || c.w - a.w);
  const placed = [];
  const overflow = [];
  let plate = 0, x = bed.minX + margin, y = bed.minY + margin, rowD = 0;
  const plates = [[]];
  for (const it of items) {
    if (it.w > bed.w - 2 * margin + 0.01 || it.d > bed.d - 2 * margin + 0.01) {
      overflow.push(it);
      // Still put it alone on a plate, centred.
      if (plates[plate].length) {
        plate++;
        plates.push([]);
      }
      plates[plate].push({ it, x: bed.minX + (bed.w - it.w) / 2, y: bed.minY + (bed.d - it.d) / 2 });
      plate++;
      plates.push([]);
      x = bed.minX + margin;
      y = bed.minY + margin;
      rowD = 0;
      continue;
    }
    if (x + it.w > bed.maxX - margin + 0.01) {
      x = bed.minX + margin;
      y += rowD + gap;
      rowD = 0;
    }
    if (y + it.d > bed.maxY - margin + 0.01) {
      plate++;
      plates.push([]);
      x = bed.minX + margin;
      y = bed.minY + margin;
      rowD = 0;
    }
    plates[plate].push({ it, x, y });
    x += it.w + gap;
    rowD = Math.max(rowD, it.d);
  }
  plates.forEach((list, p) => {
    if (!list.length) return;
    // Centre the used area of each plate.
    const maxX = Math.max(...list.map((e) => e.x + e.it.w));
    const maxY = Math.max(...list.map((e) => e.y + e.it.d));
    const minX = Math.min(...list.map((e) => e.x));
    const minY = Math.min(...list.map((e) => e.y));
    const sx = (bed.minX + bed.maxX) / 2 - (minX + maxX) / 2;
    const sy = (bed.minY + bed.maxY) / 2 - (minY + maxY) / 2;
    for (const e of list) {
      const box = e.it.b.box;
      const bx = boxValid(box) ? box.min[0] : 0;
      const by = boxValid(box) ? box.min[1] : 0;
      placed.push({ entry: e.it.b, dx: e.x + sx - bx, dy: e.y + sy - by, plate: p });
    }
  });
  // Renumber plates to remove empty ones.
  const usedPlates = [...new Set(placed.map((p) => p.plate))].sort((a, b) => a - b);
  for (const p of placed) p.plate = Math.min(MAX_PLATES - 1, usedPlates.indexOf(p.plate));
  return { placed, overflow };
}

// ---------------------------------------------------------------------------------------------
// Conversion

export async function convert(zip, src, catalog, opts, JSZip) {
  const profiles = profilesFor(catalog, opts.printer);
  const vendor = profiles.vendor;
  const report = { changes: [], warnings: [], dropped: [] };
  const change = (group, text) => report.changes.push({ group, text });
  const K = opts.slots.length;
  const mapIndex = (i) => {
    const s = opts.map[i];
    return s && s <= K ? s : 1;
  };
  const info = profiles.info(opts.printer, opts.nozzle);
  const beds = supportedBedTypes(profiles, opts.slots, opts.printer);
  if (beds.length && !beds.includes(opts.bedType)) {
    const nb = beds.includes('Textured PEI Plate') ? 'Textured PEI Plate' : beds[0];
    report.warnings.push(`La placa “${BED_TYPE_LABELS[opts.bedType]}” no es compatible con alguno de los filamentos elegidos; se usó “${BED_TYPE_LABELS[nb]}”.`);
    opts = { ...opts, bedType: nb };
  }
  const plan = planPlacement(src, profiles, opts);
  report.warnings.push(...plan.warnings);

  const project = buildProjectConfig(src, profiles, opts, mapIndex, plan.plateCount, report, change, plan.placements);
  const out = new JSZip();

  if (src.scene.kind === 'bbs') await writeBbs(zip, out, src, profiles, opts, plan, mapIndex, report, change);
  else await writeMesh(zip, out, src, profiles, opts, plan, mapIndex, report, change);

  out.file('Metadata/project_settings.config', JSON.stringify(project, null, 4));
  out.file('Metadata/slice_info.config', sliceInfo(vendor));
  change('Archivo', `Metadatos reescritos como proyecto de ${vendor.slicer} (Application = ${vendor.application}).`);

  change('Impresora', `Impresora: ${info.machine} (antes: ${src.printerModel || FORMAT_LABELS[src.format]}).`);
  change('Impresora', `Cama: ${BED_TYPE_LABELS[opts.bedType] || opts.bedType}, ${plan.bed.w}×${plan.bed.d}×${plan.bed.h} mm.`);
  if (plan.mode === 'keep') change('Posición', 'Objetos recentrados en la cama nueva conservando la disposición de cada placa.');
  if (plan.mode === 'center') change('Posición', 'Cada grupo de objetos se centró en la cama.');
  if (plan.mode === 'arrange') change('Posición', `Objetos reorganizados automáticamente en ${plan.plateCount} placa(s).`);

  const data = await out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { data, report, plan };
}

// ---------------------------------------------------------------------------------------------
// project_settings.config

export function buildProjectConfig(src, profiles, opts, mapIndex, plateCount, report, change, placements = []) {
  const info = profiles.info(opts.printer, opts.nozzle);
  const machine = profiles.machine(info.machine);
  const proc = profiles.process(opts.process);
  const K = opts.slots.length;
  const cfg = JSON.parse(JSON.stringify(profiles.template));
  const valid = profiles.validKeys;

  for (const [k, v] of Object.entries(machine)) if (valid.has(k)) cfg[k] = v;
  for (const [k, v] of Object.entries(proc)) if (valid.has(k)) cfg[k] = v;

  // Filaments.
  const fp = opts.slots.map((s) => profiles.filament(s.preset));
  const filamentKeys = new Set(profiles.filamentKeys());
  for (const k of filamentKeys) {
    if (!valid.has(k)) continue;
    const vals = fp.map((p) => p[k]);
    if (vals.every((v) => Array.isArray(v) && v.length === 1)) cfg[k] = vals.map((v) => v[0]);
    else if (vals[0] !== undefined) cfg[k] = vals[0];
  }
  // Per-filament keys of the template that no filament preset provides: one entry per filament.
  const perFilament = ['default_filament_colour', 'first_x_layer_fan_speed', 'first_x_layer_part_fan_speed', 'ironing_fan_speed', 'enable_overhang_bridge_fan', 'enable_pressure_advance', 'pressure_advance', 'overhang_threshold_participating_cooling'];
  const tK = (profiles.template.filament_colour || ['']).length;
  for (const [k, v] of Object.entries(profiles.template)) {
    if (filamentKeys.has(k) || !Array.isArray(v) || v.length !== tK) continue;
    if (k.startsWith('filament_') || perFilament.includes(k)) cfg[k] = Array.from({ length: K }, (_, i) => v[Math.min(i, tK - 1)]);
  }
  const has = (k) => profiles.template[k] !== undefined;
  const colors = opts.slots.map((s) => normColor(s.color) || '#FFFFFF');
  cfg.filament_colour = colors;
  if (has('filament_multi_colour')) cfg.filament_multi_colour = colors.slice();
  if (has('filament_multi_colors')) cfg.filament_multi_colors = colors.slice();
  if (has('filament_colour_mode')) cfg.filament_colour_mode = Array(K).fill('0');
  if (has('default_filament_colour')) cfg.default_filament_colour = Array(K).fill('');
  cfg.filament_settings_id = opts.slots.map((s) => s.preset);
  cfg.filament_ids = fp.map((p) => p.filament_id || '');
  if (has('filament_self_index')) cfg.filament_self_index = opts.slots.map((_, i) => String(i + 1));
  if (has('filament_map')) cfg.filament_map = Array(K).fill('1');
  if (has('filament_extruder_variant')) cfg.filament_extruder_variant = Array(K).fill((machine.printer_extruder_variant || ['Direct Drive Standard'])[0]);
  if (Array.isArray(profiles.template.flush_volumes_vector)) cfg.flush_volumes_vector = Array(2 * K).fill(profiles.template.flush_volumes_vector[0] || '140');
  // Per-filament maps indexed by filament id in Bambu Studio: never shorter than the filament count.
  for (const k of ['filament_nozzle_map', 'filament_volume_map']) {
    const t = profiles.template[k];
    if (Array.isArray(t)) cfg[k] = Array(Math.max(K, t.length)).fill(t[0] ?? '0');
  }
  cfg.flush_volumes_matrix = flushMatrix(colors);

  // Identity.
  cfg.printer_settings_id = info.machine;
  cfg.print_settings_id = opts.process;
  cfg.print_compatible_printers = [info.machine];
  cfg.inherits_group = Array(K + 2).fill('');
  cfg.version = profiles.vendor.version;
  cfg.name = 'project_settings';
  cfg.from = 'project';
  cfg.curr_bed_type = opts.bedType;
  const bed = profiles.bed(opts.printer, opts.nozzle);
  const towers = wipeTowerPositions(bed, plateCount, placements, K, parseFloat(cfg.prime_tower_width) || 35);
  cfg.wipe_tower_x = towers.map((t) => formatNumber(t[0]));
  cfg.wipe_tower_y = towers.map((t) => formatNumber(t[1]));
  cfg.wipe_tower_rotation_angle = '0';

  // Print settings carried over from the original file.
  const procDiff = [];
  if (opts.transferSettings) {
    const transferred = [];
    const skipped = [];
    for (const [k, raw] of Object.entries(src.process)) {
      if (opts.processManual && (k === 'layer_height' || k === 'initial_layer_print_height')) continue;
      if (FILAMENT_INDEX_KEYS.includes(k)) continue;
      if (TUNED_KEYS.has(k) && !src.userModified.has(k)) continue;
      const v = normalizeValue(profiles, k, raw);
      if (v === undefined) {
        skipped.push(k);
        continue;
      }
      const shaped = shapeLike(cfg[k] !== undefined ? cfg[k] : profiles.template[k], v);
      if (cfg[k] !== undefined && sameValue(cfg[k], shaped)) continue;
      cfg[k] = shaped;
      procDiff.push(k);
      transferred.push(`${k} = ${Array.isArray(shaped) ? shaped.join(',') : shaped}`);
    }
    if (transferred.length) change('Proceso', `Ajustes conservados del archivo original (${transferred.length}): ${transferred.join('; ')}.`);
    if (skipped.length) report.warnings.push(`Ajustes del original sin equivalente en ${profiles.vendor.slicer} (se usan los del perfil): ${skipped.join(', ')}.`);
  }
  // Filament role assignments (walls / infill / support) need remapping to the new slots.
  // OrcaSlicer (and forks) use 1 as "default filament" for walls/infill where Bambu Studio uses 0.
  const orcaFamily = ['orca', 'snaporca'].includes(src.format) || !/^Bambu Lab/.test(src.printerModel || 'Bambu Lab');
  const idxDefault = profiles.vendor.filament_index_default || '0';
  for (const k of FILAMENT_INDEX_KEYS) {
    let raw = parseInt(Array.isArray(src.process[k]) ? src.process[k][0] : src.process[k], 10);
    const roleKey = !['support_filament', 'support_interface_filament'].includes(k);
    if (orcaFamily && raw === 1 && roleKey) raw = 0;
    let v = raw > 0 && opts.map[raw] && K > 1 ? String(mapIndex(raw)) : '0';
    if (v === '0' && roleKey) v = idxDefault;
    if (cfg[k] !== undefined && !sameValue(cfg[k], v)) {
      cfg[k] = v;
      procDiff.push(k);
      change('Proceso', `${k}: filamento ${v}.`);
    }
  }
  cfg.different_settings_to_system = [procDiff.join(';'), ...Array(K).fill(''), ''];

  change('Proceso', `Perfil de proceso: ${opts.process}${procDiff.length ? ` (con ${procDiff.length} ajuste(s) modificados)` : ''}.`);
  opts.slots.forEach((s, i) => change('Filamentos', `Ranura ${i + 1}: ${s.preset} — color ${colors[i]}.`));
  const pinfo = profiles.printerInfo(opts.printer);
  if (K > pinfo.slots) {
    report.warnings.push(pinfo.slot_kind === 'tools'
      ? `El proyecto usa ${K} filamentos y la ${opts.printer.replace(/^\S+ /, '')} tiene ${pinfo.slots} cabezales: fusioná colores o prepará cambios de bobina manuales.`
      : `El proyecto usa ${K} filamentos y un AMS tiene ${pinfo.slots} ranuras: vas a necesitar más de un AMS, cambios de bobina manuales o fusionar colores.`);
  }
  for (const s of opts.slots) {
    const srcF = src.filaments.find((f) => f.index === s.source);
    if (srcF && normalizeType(srcF.type) && normalizeType(profiles.filament(s.preset).filament_type?.[0]) !== normalizeType(srcF.type) && !/-CF|-GF/.test(normalizeType(srcF.type))) {
      report.warnings.push(`El filamento original ${srcF.index} era ${srcF.type} y se asignó “${presetBase(s.preset)}” (${profiles.filament(s.preset).filament_type?.[0]}). Revisalo si no es lo que querés.`);
    }
  }
  return cfg;
}

// Prime tower position per plate: Bambu's default (back-left) for single colour prints; with several
// filaments the tower grows deeper, so pick a free corner with room for it.
function wipeTowerPositions(bed, plateCount, placements, K, width) {
  const def = [15, Math.max(bed.minY + 20, bed.maxY - 39.028)];
  const out = [];
  for (let p = 0; p < plateCount; p++) {
    if (K < 2) {
      out.push(def);
      continue;
    }
    const w = width + 10;
    const d = Math.min(65, bed.d * 0.4);
    const candidates = [
      [bed.minX + 15, bed.maxY - d - 8],
      [bed.minX + 15, bed.minY + 12],
      [bed.maxX - w - 12, bed.maxY - d - 8],
      [bed.maxX - w - 12, bed.minY + 12],
    ];
    const boxes = placements.filter((r) => r.plate === p && boxValid(r.entry.box)).map((r) => ({
      minX: r.entry.box.min[0] + r.dx - 5, maxX: r.entry.box.max[0] + r.dx + 5, minY: r.entry.box.min[1] + r.dy - 5, maxY: r.entry.box.max[1] + r.dy + 5,
    }));
    const free = candidates.find(([x, y]) => boxes.every((b) => x + w < b.minX || x > b.maxX || y + d < b.minY || y > b.maxY));
    out.push(free || [bed.minX + 15, bed.maxY - d - 8]);
  }
  return out;
}

function hexToRgb(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgb2hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max];
}

// Colour based purge volume estimate (FlushVolCalculator::calc_flush_vol_rgb in Bambu Studio).
export function flushVolume(from, to) {
  const [r1, g1, b1] = hexToRgb(from).map((x) => x / 255);
  const [r2, g2, b2] = hexToRgb(to).map((x) => x / 255);
  const [h1, s1, v1] = rgb2hsv(r1, g1, b1);
  const [h2, s2, v2] = rgb2hsv(r2, g2, b2);
  const rad = Math.PI / 180;
  const dx = Math.cos(h1 * rad) * s1 * v1 - Math.cos(h2 * rad) * s2 * v2;
  const dy = Math.sin(h1 * rad) * s1 * v1 - Math.sin(h2 * rad) * s2 * v2;
  let hs = Math.min(1.2, Math.hypot(dx, dy));
  const l1 = r1 * 0.3 + g1 * 0.59 + b1 * 0.11;
  const l2 = r2 * 0.3 + g2 * 0.59 + b2 * 0.11;
  let lumi;
  if (l2 >= l1) lumi = Math.pow(l2 - l1, 0.7) * 560;
  else {
    lumi = (l1 - l2) * 80;
    hs = Math.min(0.67 * v2 + 0.33 * v1, hs);
  }
  const hsFlush = 230 * hs;
  const v = Math.sqrt(hsFlush * hsFlush + lumi * lumi - 2 * hsFlush * lumi * Math.cos(120 * rad));
  return Math.min(900, Math.round(Math.max(v, 60) + 107));
}

function flushMatrix(colors) {
  const out = [];
  for (let i = 0; i < colors.length; i++) for (let j = 0; j < colors.length; j++) out.push(i === j ? '0' : String(flushVolume(colors[i], colors[j])));
  return out;
}

function sliceInfo(vendor) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="${vendor.version}"/>
  </header>
</config>
`;
}

// ---------------------------------------------------------------------------------------------
// Shared XML pieces

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>`;

function rootRels(thumb) {
  const t = thumb
    ? `\n <Relationship Target="/${thumb}" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n <Relationship Target="/${thumb}" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>\n <Relationship Target="/${thumb}" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${t}
</Relationships>`;
}

function uuid(n, rest) {
  return `${n.toString(16).padStart(8, '0')}-${rest}`;
}

const PLATE_KEYS = ['plater_id', 'plater_name', 'locked', 'bed_type', 'print_sequence', 'spiral_mode', 'filament_map_mode', 'filament_maps', 'thumbnail_file', 'thumbnail_no_light_file', 'top_file', 'pick_file', 'pattern_bbox_file'];

function md(key, value) {
  return { name: 'metadata', attrs: { key, value: String(value) }, children: [], text: '' };
}

// Builds <plate> nodes for the new placement. `sourcePlates` (Bambu/Orca files) keep names/locks/thumbnails
// when the plate keeps the same index.
function plateNodes(plateCount, placements, K, profiles, sourcePlates, keepThumbs, zipOut) {
  const nodes = [];
  let identify = 100;
  for (let p = 0; p < plateCount; p++) {
    const sp = sourcePlates && sourcePlates[p];
    const meta = [];
    meta.push(md('plater_id', p + 1));
    meta.push(md('plater_name', sp ? sp.meta.plater_name || '' : ''));
    meta.push(md('locked', sp ? sp.meta.locked || 'false' : 'false'));
    if (sp) {
      const bt = normalizeValue(profiles, 'curr_bed_type', sp.meta.bed_type);
      if (sp.meta.bed_type && bt) meta.push(md('bed_type', bt));
      const ps = normalizeValue(profiles, 'print_sequence', sp.meta.print_sequence);
      if (sp.meta.print_sequence && ps) meta.push(md('print_sequence', ps));
      if (sp.meta.spiral_mode !== undefined) meta.push(md('spiral_mode', sp.meta.spiral_mode));
    }
    meta.push(md('filament_map_mode', 'Auto For Flush'));
    meta.push(md('filament_maps', Array(K).fill('1').join(' ')));
    if (sp && keepThumbs) {
      for (const k of ['thumbnail_file', 'thumbnail_no_light_file', 'top_file', 'pick_file', 'pattern_bbox_file']) {
        if (sp.meta[k] && zipOut.file(sp.meta[k])) meta.push(md(k, sp.meta[k]));
      }
    }
    const inst = placements
      .filter((pl) => pl.plate === p)
      .map((pl) => ({
        name: 'model_instance',
        attrs: {},
        text: '',
        children: [md('object_id', pl.objectId), md('instance_id', pl.instanceId), md('identify_id', pl.identifyId || identify++)],
      }));
    nodes.push({ name: 'plate', attrs: {}, text: '', children: [...meta, ...inst] });
  }
  return nodes;
}

// Normalises a per-object/per-part config map for Bambu Studio; returns [key, value] pairs.
function objectConfig(profiles, cfg, mapIndex, dropped) {
  const out = [];
  for (const [k, raw] of Object.entries(cfg)) {
    if (FILAMENT_INDEX_KEYS.includes(k)) {
      const n = parseInt(raw, 10);
      out.push([k, n > 0 ? String(mapIndex(n)) : '0']);
      continue;
    }
    const v = normalizeValue(profiles, k, raw);
    if (v === undefined) dropped.add(k);
    else out.push([k, Array.isArray(v) ? v.join(',') : v]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Bambu / Orca / SnapOrca: keep geometry, rewrite metadata.

const DROP_PATTERNS = [
  [/^Metadata\/plate_\d+\.gcode(\.md5)?$/i, 'G-code laminado del slicer anterior'],
  [/^Metadata\/plate_\d+\.json$/i, 'datos de laminado del slicer anterior'],
  [/^Metadata\/(process|filament|machine)_settings_\d+\.config$/i, 'perfil personalizado embebido (se usan los perfiles de sistema)'],
  [/^Metadata\/filament_sequence\.json$/i, 'orden de filamentos (el slicer lo recalcula)'],
  [/^Metadata\/_rels\//i, 'relaciones del G-code laminado'],
  [/^Metadata\/(Slic3r_PE|Prusa_Slicer).*$/i, 'configuración de PrusaSlicer'],
  [/^Cura\//i, 'configuración de Cura'],
  [/^Metadata\/(project_settings|slice_info)\.config$/i, null],
  [/^Metadata\/model_settings\.config$/i, null],
  [/^Metadata\/custom_gcode_per_layer\.xml$/i, null],
  [/^\[Content_Types\]\.xml$/i, null],
  [/^_rels\/\.rels$/i, null],
];

async function writeBbs(zip, out, src, profiles, opts, plan, mapIndex, report, change) {
  const sc = src.scene;
  const K = opts.slots.length;
  // Paint remap needed?
  const paintMap = (s) => (s > 0 ? mapIndex(s) : 0);
  const paintIdentity = [...sc.usedStates].every((s) => s === 0 || paintMap(s) === s);

  // Copy / transform every entry.
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    const rule = DROP_PATTERNS.find(([re]) => re.test(name));
    if (rule) {
      if (rule[1]) report.dropped.push(`${name} — ${rule[1]}`);
      continue;
    }
    if (/\.model$/i.test(name)) {
      let text = sc.fileTexts.get(name) ?? (await entry.async('string'));
      if (name === src.rootPath) text = rewriteRootModel(text, sc, plan, profiles.vendor.application);
      else text = fixModelHeader(text);
      if (!paintIdentity && sc.paintFiles.includes(name)) {
        text = text.replace(/(\spaint_color=")([0-9A-Fa-f]+)"/g, (m, pre, s) => {
          const r = remapPaint(s, paintMap);
          return r ? `${pre}${r}"` : r === '' ? '' : m;
        });
      }
      out.file(name, text);
      continue;
    }
    if (/\.rels$/i.test(name)) {
      out.file(name, fixRelTypes(await entry.async('string')));
      continue;
    }
    out.file(name, await entry.async('uint8array'), { date: entry.date });
  }
  if (!paintIdentity) change('Filamentos', 'Pintado multicolor reasignado a las ranuras nuevas.');

  out.file('[Content_Types].xml', CONTENT_TYPES);
  const rels = await zip.file('_rels/.rels')?.async('string');
  out.file('_rels/.rels', rels ? cleanRels(fixRelTypes(rels), out) : rootRels(null));

  // model_settings.config
  const dropped = new Set();
  const placements = plan.placements.map((p) => ({
    plate: p.plate,
    objectId: p.entry.object.id,
    instanceId: p.entry.inst.instanceId,
    identifyId: identifyFor(sc, p.entry.object.id, p.entry.inst.instanceId),
  }));
  const keepThumbs = plan.mode !== 'arrange';
  let ms = sc.modelSettings;
  if (ms) {
    for (const on of children(ms, 'object')) rewriteSettingsNode(on, profiles, mapIndex, dropped);
    ms.children = ms.children.filter((c) => c.name !== 'plate');
    const asm = ms.children.findIndex((c) => c.name === 'assemble');
    const plates = plateNodes(plan.plateCount, placements, K, profiles, sc.plates, keepThumbs, out);
    if (asm >= 0) ms.children.splice(asm, 0, ...plates);
    else ms.children.push(...plates);
  } else {
    ms = { name: 'config', attrs: {}, text: '', children: [] };
    for (const o of sc.objects.values()) {
      if (!o.instances.length) continue;
      ms.children.push({
        name: 'object',
        attrs: { id: o.id },
        text: '',
        children: [md('name', o.name || `Objeto ${o.id}`), md('extruder', mapIndex(o.extruder || 1))],
      });
    }
    ms.children.push(...plateNodes(plan.plateCount, placements, K, profiles, null, false, out));
  }
  out.file('Metadata/model_settings.config', `<?xml version="1.0" encoding="UTF-8"?>\n${serializeXml(ms)}\n`);
  if (dropped.size) report.warnings.push(`Ajustes por objeto que ${profiles.vendor.slicer} no reconoce y se quitaron: ${[...dropped].join(', ')}.`);
  if (!keepThumbs) report.changes.push({ group: 'Archivo', text: `Miniaturas de placa descartadas (${profiles.vendor.slicer} las regenera al guardar).` });

  // Custom G-code per layer (pauses, colour changes).
  const cg = await zip.file('Metadata/custom_gcode_per_layer.xml')?.async('string');
  if (cg) {
    if (plan.mode === 'arrange') report.warnings.push('Se descartaron pausas/cambios de color por capa porque los objetos se reorganizaron en otras placas.');
    else out.file('Metadata/custom_gcode_per_layer.xml', rewriteCustomGcode(cg, mapIndex, profiles, opts));
  }
}

function identifyFor(sc, objectId, instanceId) {
  for (const p of sc.plates) for (const i of p.instances) if (i.objectId === objectId && i.instanceId === instanceId) return i.identifyId;
  return undefined;
}

function rewriteSettingsNode(node, profiles, mapIndex, dropped) {
  const keep = [];
  const tail = [];
  const cfg = {};
  for (const c of node.children) {
    if (c.name !== 'metadata') {
      if (c.name === 'part') rewriteSettingsNode(c, profiles, mapIndex, dropped);
      tail.push(c);
      continue;
    }
    if (!attr(c, 'key')) {
      tail.unshift(c);
      continue;
    }
    const k = attr(c, 'key');
    if (k === 'extruder') {
      const v = parseInt(attr(c, 'value'), 10);
      keep.push(md('extruder', v > 0 ? mapIndex(v) : node.name === 'part' ? 0 : 1));
    } else if (['name', 'matrix', 'module', 'mesh_shared'].includes(k) || k.startsWith('source_') || k.endsWith('_guid')) keep.push(c);
    else cfg[k] = attr(c, 'value');
  }
  for (const [k, v] of objectConfig(profiles, cfg, mapIndex, dropped)) keep.push(md(k, v));
  // Keyed metadata first (as Bambu Studio writes it), then face_count, parts and mesh_stat.
  node.children = [...keep, ...tail];
}

function rewriteCustomGcode(text, mapIndex, profiles, opts) {
  const pause = (profiles.machine(profiles.info(opts.printer, opts.nozzle).machine).machine_pause_gcode) || 'M400 U1';
  return text.replace(/<layer\b([^>]*?)\/>/g, (m, a) => {
    let s = a.replace(/\sextruder="(\d+)"/, (mm, n) => ` extruder="${+n > 0 ? mapIndex(+n) : 0}"`);
    if (/\stype="1"/.test(s)) s = s.replace(/\sgcode="[^"]*"/, ` gcode="${escapeXml(pause)}"`);
    return `<layer${s}/>`;
  });
}

// Snapmaker Orca writes its own relationship namespace; both slicers read the Bambu one.
function fixRelTypes(rels) {
  return rels.replace(/http:\/\/schemas\.snapmaker\.com\/package\/\d+\//g, 'http://schemas.bambulab.com/package/2021/');
}

function cleanRels(rels, out) {
  // Drop relationships to files that are not in the output (e.g. sliced gcode).
  return rels.replace(/\s*<Relationship\b[^>]*Target="\/?([^"]+)"[^>]*\/>/g, (m, target) => (out.file(target) || /3dmodel\.model$/.test(target) ? m : ''));
}

function fixModelHeader(text) {
  const head = text.slice(0, 4000);
  let h = head.replace(/<metadata name="Snapmaker_Orca:3mfVersion">/g, '<metadata name="BambuStudio:3mfVersion">');
  if (!/xmlns:BambuStudio=/.test(h)) h = h.replace(/<model\b/, '<model xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"');
  return h + text.slice(4000);
}

function rewriteRootModel(text, sc, plan, app) {
  // Item transforms (from the end so offsets stay valid).
  const byItem = new Map(plan.placements.map((p) => [p.entry.inst.item.index, p.transform]));
  const items = sc.items.slice().sort((a, b) => b.tagStart - a.tagStart);
  for (const it of items) {
    const t = byItem.get(it.index);
    if (!t) continue;
    let tag = text.slice(it.tagStart, it.tagEnd);
    tag = /\stransform="/.test(tag) ? tag.replace(/\stransform="[^"]*"/, ` transform="${formatTransform(t)}"`) : tag.replace(/<(\w+:)?item\b/, (m) => `${m} transform="${formatTransform(t)}"`);
    text = text.slice(0, it.tagStart) + tag + text.slice(it.tagEnd);
  }
  let head = text.slice(0, 6000);
  const rest = text.slice(6000);
  head = head.replace(/\s*<metadata name="(Snapmaker_Orca:3mfVersion|OrcaSlicer|Snapmaker_Orca)">[^<]*<\/metadata>/g, '');
  if (/<metadata name="Application">/.test(head)) head = head.replace(/<metadata name="Application">[^<]*<\/metadata>/, `<metadata name="Application">${app}</metadata>`);
  else head = head.replace(/(<model\b[^>]*>)/, `$1\n <metadata name="Application">${app}</metadata>`);
  if (!/<metadata name="BambuStudio:3mfVersion">/.test(head)) head = head.replace(/(<metadata name="Application">[^<]*<\/metadata>)/, '$1\n <metadata name="BambuStudio:3mfVersion">1</metadata>');
  if (!/xmlns:BambuStudio=/.test(head)) head = head.replace(/<model\b/, '<model xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"');
  return head + rest;
}

// ---------------------------------------------------------------------------------------------
// PrusaSlicer / Cura / generic: write a brand new Bambu project structure.

const SUB_SUFFIX = '81cb-4c03-9d28-80fed5dfa1dc';

async function writeMesh(zip, out, src, profiles, opts, plan, mapIndex, report, change) {
  const sc = src.scene;
  const K = opts.slots.length;
  const dropped = new Set();
  let nextId = 1;
  const objectsXml = [];
  const rootRelsList = [];
  const msObjects = [];
  const objInfo = new Map();
  let painted = 0;

  sc.objects.forEach((obj, oi) => {
    const file = `3D/Objects/object_${oi + 1}.model`;
    const partIds = [];
    const chunks = [];
    chunks.push(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
`);
    const objExtruder = mapIndex(obj.extruder || 1);
    for (const vol of obj.volumes) {
      const id = nextId++;
      partIds.push({ id, vol });
      chunks.push(`  <object id="${id}" p:UUID="${uuid(id, SUB_SUFFIX)}" type="model">\n   <mesh>\n    <vertices>\n`);
      const v = vol.mesh.vertices;
      let buf = [];
      for (let i = 0; i < v.length; i += 3) {
        buf.push(`     <vertex x="${formatNumber(v[i])}" y="${formatNumber(v[i + 1])}" z="${formatNumber(v[i + 2])}"/>\n`);
        if (buf.length >= 5000) {
          chunks.push(buf.join(''));
          buf = [];
        }
      }
      chunks.push(buf.join(''), '    </vertices>\n    <triangles>\n');
      buf = [];
      const t = vol.mesh.triangles;
      const volExtruder = vol.extruder ? mapIndex(vol.extruder) : objExtruder;
      const pc = vol.mesh.paint.paint_color;
      for (let i = 0; i < t.length; i += 3) {
        const ti = i / 3;
        let attrs = '';
        let paint = pc && pc[ti] ? remapPaint(pc[ti], (s) => (s > 0 ? mapIndex(s) : 0), vol.prusaPaint) : '';
        if (!paint && vol.triMat && vol.triMat[ti]) {
          const f = mapIndex(vol.triMat[ti]);
          if (f !== volExtruder) paint = leafPaint(f);
        }
        if (paint) {
          attrs += ` paint_color="${paint}"`;
          painted++;
        }
        for (const k of ['paint_supports', 'paint_seam', 'paint_fuzzy_skin']) {
          const s = vol.mesh.paint[k] && vol.mesh.paint[k][ti];
          if (s) {
            const r = vol.prusaPaint ? remapPaint(s, (x) => x, true) : s;
            if (r) attrs += ` ${k}="${r}"`;
          }
        }
        buf.push(`     <triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"${attrs}/>\n`);
        if (buf.length >= 5000) {
          chunks.push(buf.join(''));
          buf = [];
        }
      }
      chunks.push(buf.join(''), '    </triangles>\n   </mesh>\n  </object>\n');
    }
    chunks.push(' </resources>\n <build/>\n</model>\n');
    out.file(file, chunks.join(''));
    rootRelsList.push(file);
    const wrapperId = nextId++;
    objInfo.set(obj, { wrapperId, file, partIds });
  });

  // Root model.
  const itemsXml = [];
  const placements = [];
  let itemN = 0;
  for (const p of plan.placements) {
    const info = objInfo.get(p.entry.object);
    const instanceId = p.entry.object.instances.indexOf(p.entry.inst);
    itemsXml.push(`  <item objectid="${info.wrapperId}" p:UUID="${uuid(++itemN, 'b1ec-4553-aec9-835e5b724bb4')}" transform="${formatTransform(p.transform)}" printable="1"/>`);
    placements.push({ plate: p.plate, objectId: info.wrapperId, instanceId });
  }
  for (const [obj, info] of objInfo) {
    const comps = info.partIds
      .map(({ id }) => `    <component p:path="/${info.file}" objectid="${id}" p:UUID="${uuid(id, 'b206-40ff-9872-83e8017abed1')}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`)
      .join('\n');
    objectsXml.push(`  <object id="${info.wrapperId}" p:UUID="${uuid(info.wrapperId, '61cb-4c03-9d28-80fed5dfa1dc')}" type="model">\n   <components>\n${comps}\n   </components>\n  </object>`);
    // model_settings object
    const objCfg = src.format === 'prusa' ? fromPrusaObject(obj.config) : src.format === 'cura' ? fromCura(obj.config) : {};
    const kids = [md('name', obj.name), md('extruder', mapIndex(obj.extruder || 1))];
    for (const [k, v] of objectConfig(profiles, objCfg, mapIndex, dropped)) kids.push(md(k, v));
    for (const { id, vol } of info.partIds) {
      const pc = [md('name', vol.name || obj.name), md('matrix', '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1')];
      if (vol.extruder && mapIndex(vol.extruder) !== mapIndex(obj.extruder || 1)) pc.push(md('extruder', mapIndex(vol.extruder)));
      const volCfg = src.format === 'prusa' ? fromPrusaObject(vol.config) : {};
      for (const [k, v] of objectConfig(profiles, volCfg, mapIndex, dropped)) pc.push(md(k, v));
      pc.push({ name: 'mesh_stat', attrs: { face_count: String(vol.mesh.triangles.length / 3), edges_fixed: '0', degenerate_facets: '0', facets_removed: '0', facets_reversed: '0', backwards_edges: '0' }, children: [], text: '' });
      kids.push({ name: 'part', attrs: { id: String(id), subtype: vol.subtype }, text: '', children: pc });
    }
    msObjects.push({ name: 'object', attrs: { id: String(info.wrapperId) }, text: '', children: kids });
  }
  const title = escapeXml(src.root.metadata.Title || sc.objects[0]?.name || '');
  const date = new Date().toISOString().slice(0, 10);
  out.file('3D/3dmodel.model', `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">${profiles.vendor.application}</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="CreationDate">${date}</metadata>
 <metadata name="ModificationDate">${date}</metadata>
 <metadata name="Title">${title}</metadata>
 <metadata name="Designer">${escapeXml(src.root.metadata.Designer || '')}</metadata>
 <metadata name="Description">${escapeXml(src.root.metadata.Description || '')}</metadata>
 <metadata name="License">${escapeXml(src.root.metadata.License || '')}</metadata>
 <resources>
${objectsXml.join('\n')}
 </resources>
 <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">
${itemsXml.join('\n')}
 </build>
</model>
`);
  out.file('3D/_rels/3dmodel.model.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rootRelsList.map((f, i) => ` <Relationship Target="/${f}" Id="rel-${i + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join('\n')}
</Relationships>
`);

  // Thumbnail from the source file, if any.
  const thumbName = Object.keys(zip.files).find((n) => /^Metadata\/(thumbnail|plate_1)\.png$/i.test(n)) || Object.keys(zip.files).find((n) => /thumbnail.*\.png$/i.test(n));
  let thumb = null;
  if (thumbName) {
    thumb = 'Metadata/plate_1.png';
    out.file(thumb, await zip.file(thumbName).async('uint8array'));
  }
  out.file('[Content_Types].xml', CONTENT_TYPES);
  out.file('_rels/.rels', rootRels(thumb));

  const plates = plateNodes(plan.plateCount, placements, K, profiles, null, false, out);
  if (thumb && plates[0]) plates[0].children.push(md('thumbnail_file', thumb));
  const ms = { name: 'config', attrs: {}, text: '', children: [...msObjects, ...plates] };
  out.file('Metadata/model_settings.config', `<?xml version="1.0" encoding="UTF-8"?>\n${serializeXml(ms)}\n`);

  change('Archivo', `Geometría reescrita en formato ${profiles.vendor.slicer} (${sc.objects.length} objeto(s), ${sc.objects.reduce((n, o) => n + o.volumes.length, 0)} pieza(s)).`);
  if (painted) change('Filamentos', `${painted} triángulo(s) con pintado multicolor convertidos a pintura de ${profiles.vendor.slicer}.`);
  if (dropped.size) report.warnings.push(`Ajustes por objeto sin equivalente en ${profiles.vendor.slicer}: ${[...dropped].join(', ')}.`);
  const others = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /^(Metadata|Cura)\//.test(n) && n !== thumbName);
  for (const n of others) report.dropped.push(`${n} — metadatos del slicer original`);
}

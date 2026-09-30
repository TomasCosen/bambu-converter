// UI of the converter. All the heavy lifting lives in js/core/.
import { Profiles, presetBase } from './core/profiles.js';
import { analyze, convert, defaultOptions, planPlacement, supportedBedTypes, BED_TYPES, BED_TYPE_LABELS } from './core/convert.js';
import { boxValid } from './core/geom.js';

const $ = (id) => document.getElementById(id);
const state = { profiles: null, zip: null, src: null, opts: null, fileName: '' };

const SETTING_LABELS = {
  layer_height: 'altura de capa', initial_layer_print_height: 'primera capa', wall_loops: 'paredes', top_shell_layers: 'capas superiores',
  bottom_shell_layers: 'capas inferiores', sparse_infill_density: 'relleno', sparse_infill_pattern: 'patrón de relleno',
  enable_support: 'soportes', support_type: 'tipo de soporte', support_style: 'estilo de soporte', brim_type: 'borde (brim)',
  brim_width: 'ancho de borde', seam_position: 'costura', ironing_type: 'planchado', spiral_mode: 'modo jarrón',
  print_sequence: 'secuencia', enable_prime_tower: 'torre de purga', raft_layers: 'capas de balsa', skirt_loops: 'faldas',
  fuzzy_skin: 'piel difusa', top_surface_pattern: 'patrón superior', bottom_surface_pattern: 'patrón inferior',
};

init();

async function init() {
  try {
    const res = await fetch('data/bambu-a1.json');
    state.profiles = new Profiles(await res.json());
    const g = state.profiles.data.generated_from;
    $('profile-version').textContent = `perfiles ${g.profile_version}`;
  } catch (e) {
    showError('No se pudieron cargar los perfiles de Bambu (data/bambu-a1.json). Abrí la página desde un servidor web, no como archivo local.');
    return;
  }
  const drop = $('drop');
  $('file').addEventListener('change', (e) => e.target.files[0] && loadFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && loadFile(e.dataTransfer.files[0]));
  $('sample').addEventListener('click', async () => {
    const r = await fetch('samples/ejemplo-orca-multicolor.3mf');
    loadFile(new File([await r.blob()], 'ejemplo-orca-multicolor.3mf'));
  });

  $('printer').addEventListener('change', () => retarget($('printer').value, null));
  $('nozzle').addEventListener('change', () => retarget(state.opts.printer, $('nozzle').value));
  $('process').addEventListener('change', () => {
    state.opts.process = $('process').value;
    state.opts.processManual = true;
    renderPreview();
  });
  $('bed').addEventListener('change', () => { state.opts.bedType = $('bed').value; });
  $('transfer').addEventListener('change', () => { state.opts.transferSettings = $('transfer').checked; });
  document.querySelectorAll('input[name="placement"]').forEach((r) => r.addEventListener('change', () => {
    state.opts.placement = r.value;
    renderPreview();
  }));
  $('convert').addEventListener('click', doConvert);
  window.addEventListener('resize', () => state.src && renderBeds());
}

function showError(msg) {
  const el = $('load-error');
  el.textContent = msg;
  el.hidden = !msg;
}

async function loadFile(file) {
  showError('');
  $('report').hidden = true;
  $('status').textContent = '';
  try {
    const zip = await window.JSZip.loadAsync(file);
    const { src, options } = await analyze(zip, state.profiles);
    Object.assign(state, { zip, src, opts: options, fileName: file.name });
  } catch (e) {
    console.error(e);
    showError(e.message && !/zip/i.test(e.message) ? e.message : 'No se pudo leer el archivo. ¿Es un .3mf válido?');
    return;
  }
  renderSource();
  renderTarget();
}

// ---------------------------------------------------------------------------------------------

function renderSource() {
  const { src } = state;
  const sc = src.scene;
  const objects = sc.kind === 'bbs' ? [...sc.objects.values()].filter((o) => o.instances.length) : sc.objects;
  const instances = src.boxes.length;
  const plates = sc.kind === 'bbs' ? Math.max(1, sc.plates.length) : 1;
  const facts = [
    ['Archivo', state.fileName],
    ['Hecho con', `${src.formatLabel}${src.application ? ` (${src.application})` : ''}`],
    ['Impresora', src.printerModel || 'sin especificar'],
    ['Cama', src.bed ? `${fmt(src.bed.w)} × ${fmt(src.bed.d)} mm` : 'sin especificar'],
    ['Objetos', `${objects.length} (${instances} ${instances === 1 ? 'copia' : 'copias'})`],
    ['Placas', String(plates)],
  ];
  $('facts').replaceChildren(...facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  $('src-filaments').replaceChildren(...src.filaments.map((f) => el('li', { class: f.used ? '' : 'unused' },
    swatch(f.color),
    el('span', {}, `${f.index}. ${f.name || f.type}`),
    el('span', { class: 'tag' }, f.type),
    f.used ? null : el('span', { class: 'tag' }, 'sin usar'),
  )));
  const keys = Object.entries(src.process).filter(([k]) => SETTING_LABELS[k]);
  $('src-settings').replaceChildren(...(keys.length
    ? keys.map(([k, v]) => el('span', { class: 'chip', title: k }, `${SETTING_LABELS[k]}: ${Array.isArray(v) ? v[0] : v}`))
    : [el('p', { class: 'empty' }, 'El archivo no trae ajustes de impresión; se usará el perfil de Bambu.')]));
  $('source').hidden = false;
  $('howto').hidden = true;
}

function renderTarget() {
  const { profiles, opts, src } = state;
  $('target').disabled = false;
  fillSelect($('printer'), profiles.printerModels().map((m) => [m, m.replace('Bambu Lab ', '')]), opts.printer);
  fillSelect($('nozzle'), profiles.nozzles(opts.printer).map((n) => [n, `${n} mm`]), opts.nozzle);
  const info = profiles.info(opts.printer, opts.nozzle);
  fillSelect($('process'), info.processes.map((p) => [p, p + (p === info.default_process ? '  (predeterminado)' : '')]), opts.process);
  renderBedTypes();
  $('transfer').checked = opts.transferSettings;
  const keepOk = src.scene.kind === 'bbs' && !!src.bed;
  $('pl-keep').disabled = !keepOk;
  if (!keepOk && opts.placement === 'keep') opts.placement = 'center';
  document.querySelectorAll('input[name="placement"]').forEach((r) => { r.checked = r.value === opts.placement; });
  renderSlots();
  renderPreview();
}

function renderBedTypes() {
  const { profiles, opts } = state;
  const ok = supportedBedTypes(profiles, opts.slots);
  if (!ok.includes(opts.bedType) && ok.length) opts.bedType = ok.includes('Textured PEI Plate') ? 'Textured PEI Plate' : ok[0];
  const sel = $('bed');
  sel.replaceChildren(...BED_TYPES.map((b) => {
    const o = el('option', { value: b }, BED_TYPE_LABELS[b] + (ok.includes(b) ? '' : ' — no compatible con los filamentos'));
    o.disabled = !ok.includes(b);
    return o;
  }));
  sel.value = opts.bedType;
}

// Slot table: one row per used source filament.
function renderSlots() {
  const { profiles, opts, src } = state;
  const info = profiles.info(opts.printer, opts.nozzle);
  const used = src.filaments.filter((f) => f.used);
  const firstOfSlot = new Map();
  const rows = used.map((f) => {
    const slot = opts.map[f.index];
    const first = !firstOfSlot.has(slot);
    if (first) firstOfSlot.set(slot, f.index);
    const s = opts.slots[slot - 1];
    const slotSel = el('select', { class: 'slot-select', 'aria-label': `Ranura para el filamento ${f.index}` });
    opts.slots.forEach((_, i) => slotSel.append(el('option', { value: String(i + 1) }, `Ranura ${i + 1}`)));
    slotSel.append(el('option', { value: 'new' }, 'Nueva ranura'));
    slotSel.value = String(slot);
    slotSel.addEventListener('change', () => moveToSlot(f.index, slotSel.value));

    let presetCell, colorCell;
    if (first) {
      const ps = presetSelect(info.filaments, s.preset);
      ps.setAttribute('aria-label', `Perfil de filamento para la ranura ${slot}`);
      ps.addEventListener('change', () => {
        s.preset = ps.value;
        s.exact = false;
        renderBedTypes();
      });
      presetCell = el('td', {}, ps);
      const ci = el('input', { type: 'color', value: s.color.toLowerCase(), 'aria-label': `Color de la ranura ${slot}` });
      const hex = el('span', { class: 'hex' }, s.color);
      ci.addEventListener('input', () => {
        s.color = ci.value.toUpperCase();
        hex.textContent = s.color;
        renderBeds();
      });
      colorCell = el('td', {}, el('div', { class: 'color-cell' }, ci, hex));
    } else {
      presetCell = el('td', { colspan: '2', class: 'merged' }, `Fusionado con la ranura ${slot} (${presetBase(s.preset)})`);
      colorCell = null;
    }
    return el('tr', {},
      el('td', {}, el('div', { class: 'src-cell' }, swatch(f.color), el('div', {}, `${f.index}. ${f.name ? presetBase(f.name) : f.type}`, el('small', {}, f.type)))),
      el('td', {}, slotSel),
      presetCell,
      colorCell,
    );
  });
  $('slots').replaceChildren(...rows);
  const n = opts.slots.length;
  const pill = $('slot-count');
  pill.textContent = `${n} ${n === 1 ? 'ranura' : 'ranuras'}${n > 4 ? ' · más que el AMS lite' : ''}`;
  pill.classList.toggle('warn', n > 4);
}

function presetSelect(list, value) {
  const groups = { Bambu: [], 'Genéricos': [], 'Otras marcas': [] };
  for (const n of list) {
    const g = n.startsWith('Bambu ') ? 'Bambu' : n.startsWith('Generic ') ? 'Genéricos' : 'Otras marcas';
    groups[g].push(n);
  }
  const sel = el('select');
  for (const [label, items] of Object.entries(groups)) {
    if (!items.length) continue;
    const og = el('optgroup', { label });
    items.sort().forEach((n) => og.append(el('option', { value: n }, presetBase(n))));
    sel.append(og);
  }
  sel.value = value;
  return sel;
}

function moveToSlot(srcIndex, value) {
  const { opts, profiles, src } = state;
  if (value === 'new') {
    const f = src.filaments.find((x) => x.index === srcIndex);
    opts.slots.push({ preset: profiles.suggestFilament(opts.printer, opts.nozzle, f).name, color: f.color, source: srcIndex });
    opts.map[srcIndex] = opts.slots.length;
  } else opts.map[srcIndex] = parseInt(value, 10);
  // Drop empty slots and renumber.
  const usedSlots = [...new Set(Object.values(opts.map).filter(Boolean))].sort((a, b) => a - b);
  const renumber = new Map(usedSlots.map((s, i) => [s, i + 1]));
  opts.slots = usedSlots.map((s) => opts.slots[s - 1]);
  for (const k of Object.keys(opts.map)) if (opts.map[k]) opts.map[k] = renumber.get(opts.map[k]);
  renderSlots();
  renderBedTypes();
  renderPreview();
}

function retarget(printer, nozzle) {
  const { profiles, src, opts } = state;
  const nozzles = profiles.nozzles(printer);
  const nz = nozzle && nozzles.includes(nozzle) ? nozzle : nozzles.includes(opts.nozzle) ? opts.nozzle : nozzles.includes('0.4') ? '0.4' : nozzles[0];
  const next = defaultOptions(src, profiles, printer, nz, opts);
  // Keep the user's slot layout (merges and colours) and re-pick presets for the new printer.
  next.map = { ...opts.map };
  next.slots = opts.slots.map((s) => {
    const f = src.filaments.find((x) => x.index === s.source) || src.filaments[0];
    const sug = profiles.suggestFilament(printer, nz, { ...f, name: s.preset || f.name });
    return { ...s, preset: sug.name };
  });
  state.opts = next;
  renderTarget();
}

// ---------------------------------------------------------------------------------------------
// Bed preview

function renderPreview() {
  const plan = planPlacement(state.src, state.profiles, state.opts);
  state.plan = plan;
  const list = $('warnings');
  list.replaceChildren(...plan.warnings.map((w) => el('li', {}, w)));
  if (state.opts.slots.length > 4) list.append(el('li', {}, `Usás ${state.opts.slots.length} filamentos y el AMS lite tiene 4 ranuras: fusioná colores o prepará cambios de bobina manuales.`));
  list.hidden = !list.children.length;
  renderBeds();
}

function renderBeds() {
  const { plan, opts, src } = state;
  if (!plan) return;
  const container = $('beds');
  const nodes = [];
  const css = getComputedStyle(document.documentElement);
  const tok = (n) => css.getPropertyValue(n).trim();
  for (let p = 0; p < plan.plateCount; p++) {
    const canvas = el('canvas', { role: 'img', 'aria-label': `Placa ${p + 1}` });
    const items = plan.placements.filter((r) => r.plate === p);
    nodes.push(el('div', { class: 'bed' }, canvas, el('div', { class: 'bed-label' }, el('span', {}, `Placa ${p + 1}`), el('span', {}, `${items.length} ${items.length === 1 ? 'pieza' : 'piezas'}`))));
    requestAnimationFrame(() => drawBed(canvas, plan, items, tok, opts, src));
  }
  container.replaceChildren(...nodes);
}

function drawBed(canvas, plan, items, tok, opts, src) {
  const size = canvas.clientWidth || 220;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const bed = plan.bed;
  const pad = 6;
  const s = (size - pad * 2) / Math.max(bed.w, bed.d);
  const X = (x) => pad + (x - bed.minX) * s;
  const Y = (y) => size - pad - (y - bed.minY) * s;
  ctx.fillStyle = tok('--plate');
  ctx.fillRect(X(bed.minX), Y(bed.maxY), bed.w * s, bed.d * s);
  ctx.strokeStyle = tok('--plate-grid');
  ctx.lineWidth = 1;
  for (let g = 0; g <= bed.w; g += 10) { ctx.beginPath(); ctx.moveTo(X(bed.minX + g) + 0.5, Y(bed.minY)); ctx.lineTo(X(bed.minX + g) + 0.5, Y(bed.maxY)); ctx.stroke(); }
  for (let g = 0; g <= bed.d; g += 10) { ctx.beginPath(); ctx.moveTo(X(bed.minX), Y(bed.minY + g) + 0.5); ctx.lineTo(X(bed.maxX), Y(bed.minY + g) + 0.5); ctx.stroke(); }
  for (const r of items) {
    const b = r.entry.box;
    if (!boxValid(b)) continue;
    const obj = r.entry.object;
    const slot = opts.map[obj.extruder || 1] || 1;
    const color = (opts.slots[slot - 1] || opts.slots[0]).color;
    const x0 = X(b.min[0] + r.dx), y0 = Y(b.max[1] + r.dy);
    const w = (b.max[0] - b.min[0]) * s, h = (b.max[1] - b.min[1]) * s;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x0, y0, Math.max(w, 2), Math.max(h, 2));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = r.fits ? tok('--ink') : tok('--bad');
    ctx.lineWidth = r.fits ? 1 : 2;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(w, 2), Math.max(h, 2));
  }
  ctx.fillStyle = tok('--ink');
  ctx.font = `500 11px ${tok('--font-mono')}`;
  ctx.fillText(`${fmt(bed.w)} × ${fmt(bed.d)} mm`, pad + 4, pad + 14);
}

// ---------------------------------------------------------------------------------------------

async function doConvert() {
  const btn = $('convert');
  const status = $('status');
  btn.disabled = true;
  status.className = 'status';
  status.textContent = 'Convirtiendo…';
  try {
    const opts = JSON.parse(JSON.stringify(state.opts));
    const { data, report } = await convert(state.zip, state.src, state.profiles, opts, window.JSZip);
    const suffix = state.opts.printer.includes('mini') ? 'A1mini' : 'A1';
    const name = state.fileName.replace(/(\.gcode)?\.3mf$/i, '') + `-${suffix}.3mf`;
    const url = URL.createObjectURL(new Blob([data], { type: 'model/3mf' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.className = 'status ok';
    status.textContent = `Listo: ${name} (${(data.length / 1024).toFixed(0)} KB). Abrilo con Bambu Studio.`;
    renderReport(report);
  } catch (e) {
    console.error(e);
    status.className = 'status bad';
    status.textContent = `No se pudo convertir: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderReport(report) {
  const groups = new Map();
  for (const c of report.changes) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c.text);
  }
  const order = ['Impresora', 'Proceso', 'Filamentos', 'Posición', 'Archivo'];
  const sections = order.filter((g) => groups.has(g)).map((g) => el('section', {}, el('h4', {}, g), el('ul', {}, ...groups.get(g).map((t) => el('li', {}, t)))));
  if (report.warnings.length) sections.push(el('section', {}, el('h4', {}, 'Para revisar'), el('ul', {}, ...report.warnings.map((t) => el('li', {}, t)))));
  if (report.dropped.length) sections.push(el('section', {}, el('h4', {}, 'Archivos descartados'), el('ul', {}, ...report.dropped.map((t) => el('li', {}, el('code', {}, t))))));
  $('report-body').replaceChildren(...sections);
  $('report').hidden = false;
}

// ---------------------------------------------------------------------------------------------

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined) e.append(k);
  return e;
}

function swatch(color) {
  const s = el('span', { class: 'swatch' });
  s.style.background = color;
  return s;
}

function fillSelect(sel, entries, value) {
  sel.replaceChildren(...entries.map(([v, label]) => el('option', { value: v }, label)));
  sel.value = value;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { Profiles, Catalog } from '../js/core/profiles.js';
import { analyze, convert, defaultOptions } from '../js/core/convert.js';
import { readSource, instanceBoxes } from '../js/core/source.js';
import { paintStates, remapPaint, leafPaint } from '../js/core/paint.js';
import { plateOrigin } from '../js/core/geom.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => new Profiles(JSON.parse(fs.readFileSync(path.join(root, 'data', f), 'utf8')));
const catalog = new Catalog([load('bambu.json'), load('snapmaker.json')]);
const profiles = catalog.forPrinter('Bambu Lab A1');
const fixture = (n) => fs.readFileSync(path.join(root, 'tests/fixtures', n));

async function run(name, tweak = (o) => o) {
  const zip = await JSZip.loadAsync(fixture(name));
  const { src, options } = await analyze(zip, catalog);
  const opts = tweak(options, src);
  const { data, report } = await convert(zip, src, catalog, opts, JSZip);
  const out = await JSZip.loadAsync(data);
  const cfg = JSON.parse(await out.file('Metadata/project_settings.config').async('string'));
  const reread = await readSource(out);
  return { src, opts, out, cfg, reread, report };
}

function assertInsideBed(reread, cfg) {
  const bed = catalog.forPrinter(cfg.printer_model).bed(cfg.printer_model, cfg.nozzle_diameter[0]);
  const count = Math.max(1, reread.scene.plates ? reread.scene.plates.length : 1);
  for (const b of instanceBoxes(reread)) {
    const [ox, oy] = plateOrigin(b.plate, count, bed.w, bed.d);
    const minX = b.box.min[0] - ox, maxX = b.box.max[0] - ox, minY = b.box.min[1] - oy, maxY = b.box.max[1] - oy;
    assert.ok(minX >= bed.minX - 0.5 && maxX <= bed.maxX + 0.5 && minY >= bed.minY - 0.5 && maxY <= bed.maxY + 0.5, `${b.object.name} fuera de la cama`);
  }
}

test('paint strings: decode, remap and Prusa extended states', () => {
  assert.deepEqual([...paintStates('8')], [2]);
  assert.deepEqual([...paintStates('1C4443')].sort(), [1, 4]);
  assert.equal(remapPaint('1C4443', (s) => (s === 4 ? 3 : s)), '0C4443');
  assert.equal(remapPaint('8', () => 0), '');
  assert.equal(leafPaint(1), '4');
  assert.equal(leafPaint(3), '0C');
  assert.equal(leafPaint(18), '0FC');
  // PrusaSlicer writes states >= 17 as C, E, 8 bits.
  assert.deepEqual([...paintStates('00EC', true)], [17]);
  assert.equal(remapPaint('00EC', (s) => s, true), 'EC'); // Bambu: C then 17-3=14
});

test('Snapmaker U1 file converts back to an A1 project equal to the original Bambu one', async () => {
  const { cfg, reread } = await run('cubo-snapmaker-u1.3mf', (o, src) => defaultOptions(src, catalog, 'Bambu Lab A1', '0.4'));
  const original = JSON.parse(await (await JSZip.loadAsync(fixture('cubo-bambu-a1.3mf'))).file('Metadata/project_settings.config').async('string'));
  assert.equal(reread.format, 'bambu');
  assert.equal(cfg.printer_settings_id, 'Bambu Lab A1 0.4 nozzle');
  assert.equal(cfg.printer_model, 'Bambu Lab A1');
  assert.deepEqual(cfg.printable_area, original.printable_area);
  // Everything except the user's own customisations and version stamps matches.
  const expected = new Set(['different_settings_to_system', 'inherits_group', 'machine_start_gcode', 'printer_settings_id', 'version', 'filament_cost', 'pre_start_fan_time']);
  const diff = Object.keys(original).filter((k) => !expected.has(k) && JSON.stringify(original[k]) !== JSON.stringify(cfg[k]));
  assert.deepEqual(diff, []);
  assertInsideBed(reread, cfg);
});

test('A1 project retargets to A1 mini', async () => {
  const { cfg, reread } = await run('cubo-bambu-a1.3mf', (o) => {
    o.printer = 'Bambu Lab A1 mini';
    o.process = profiles.suggestProcess(o.printer, '0.4', 0.2);
    o.slots[0].preset = 'Bambu PLA Basic @BBL A1M';
    return o;
  });
  assert.equal(cfg.printer_settings_id, 'Bambu Lab A1 mini 0.4 nozzle');
  assert.equal(cfg.print_settings_id, '0.20mm Standard @BBL A1M');
  assert.deepEqual(cfg.filament_settings_id, ['Bambu PLA Basic @BBL A1M']);
  assert.equal(cfg.different_settings_to_system[0], '');
  const item = reread.root.items[0].transform;
  assert.ok(Math.abs(item[9] - 90) < 0.01 && Math.abs(item[10] - 90) < 0.01);
});

test('OrcaSlicer multicolour project: unused filament dropped, paint and tool changes remapped, plates kept', async () => {
  const { cfg, out, reread, report } = await run('orca-multicolor-2plates.3mf');
  assert.deepEqual(cfg.filament_colour, ['#FF0000', '#00AA00', '#FFFF00']);
  assert.equal(cfg.flush_volumes_matrix.length, 9);
  assert.equal(cfg.curr_bed_type, 'Textured PEI Plate');
  assert.ok(cfg.different_settings_to_system[0].split(';').includes('wall_loops'));
  assert.equal(cfg.sparse_infill_pattern, 'gyroid');
  assert.equal(reread.scene.plates.length, 2);
  const obj = await out.file('3D/Objects/object_1.model').async('string');
  assert.match(obj, /paint_color="0C4443"/);
  const cg = await out.file('Metadata/custom_gcode_per_layer.xml').async('string');
  assert.match(cg, /extruder="3"/);
  assert.match(cg, /gcode="M400 U1"/);
  const ms = await out.file('Metadata/model_settings.config').async('string');
  assert.match(ms, /key="ensure_vertical_shell_thickness" value="enabled"/);
  assert.doesNotMatch(ms, /orca_only_setting/);
  assert.ok(report.warnings.some((w) => w.includes('orca_only_setting')));
  // Plate 2 object lands in the centre of plate 2 (origin 256 * 1.2).
  const t = reread.root.items[2].transform;
  assert.ok(Math.abs(t[9] - (307.2 + 128)) < 0.01);
});

test('PrusaSlicer project: volumes, modifiers and MMU painting become Bambu parts', async () => {
  const { cfg, out, reread } = await run('prusa-mmu.3mf');
  assert.equal(reread.format, 'bambu');
  assert.deepEqual(cfg.filament_settings_id, ['Generic PLA @BBL A1', 'Generic PETG @BBL A1', 'Generic TPU @BBL A1']);
  assert.equal(cfg.layer_height, '0.15');
  assert.equal(cfg.support_style, 'tree_organic');
  const ms = await out.file('Metadata/model_settings.config').async('string');
  assert.match(ms, /subtype="modifier_part"/);
  assert.match(ms, /key="sparse_infill_density" value="50%"/);
  assert.match(ms, /key="wall_loops" value="4"/);
  const obj = await out.file('3D/Objects/object_1.model').async('string');
  assert.match(obj, /paint_color="8"/);
  assert.match(obj, /paint_color="0C"/);
  assert.match(obj, /paint_supports="4"/);
  assertInsideBed(reread, cfg);
});

test('generic 3MF in inches with per-triangle colours', async () => {
  const { cfg, out, reread } = await run('generic-colors-inch.3mf');
  assert.deepEqual(cfg.filament_colour, ['#FFFFFF', '#FF0000']);
  const xs = reread.root.items.map((i) => i.transform[9]);
  assert.ok(Math.abs(xs[1] - xs[0] - 101.6) < 0.01, 'copies keep their 4 inch spacing');
  const obj = await out.file('3D/Objects/object_1.model').async('string');
  assert.equal((obj.match(/paint_color="8"/g) || []).length, 2);
  assert.match(obj, /x="12.7"/);
});

test('Cura project: extruder and per-object settings', async () => {
  const { cfg, out } = await run('cura-dual.3mf');
  assert.deepEqual(cfg.filament_settings_id, ['Generic PETG @BBL A1']);
  assert.equal(cfg.print_settings_id, '0.28mm Extra Draft @BBL A1');
  const ms = await out.file('Metadata/model_settings.config').async('string');
  assert.match(ms, /key="sparse_infill_density" value="35%"/);
});

test('merging two colours into one slot remaps painting', async () => {
  const { cfg, out } = await run('orca-multicolor-2plates.3mf', (o) => {
    o.map[4] = 1;
    o.slots.pop();
    return o;
  });
  assert.equal(cfg.filament_colour.length, 2);
  const obj = await out.file('3D/Objects/object_1.model').async('string');
  assert.match(obj, /paint_color="44443"/);
});

test('auto-arrange splits objects over plates when they do not fit', async () => {
  const { reread } = await run('orca-multicolor-2plates.3mf', (o) => ({ ...o, placement: 'arrange', printer: 'Bambu Lab A1 mini', process: '0.20mm Standard @BBL A1M', slots: o.slots.map((s) => ({ ...s, preset: 'Generic PLA @BBL A1M' })) }));
  assert.ok(reread.scene.plates.length >= 1);
});

// Retarget to another printer the way the UI does it.
const retarget = (printer) => (o, src) => defaultOptions(src, catalog, printer, '0.4');

// Real Snapmaker Orca 2.4.0 project. Not committed (third-party model): drop any SnapOrca .3mf in tests/local/.
const localSnap = fs.existsSync(path.join(root, 'tests/local')) && fs.readdirSync(path.join(root, 'tests/local')).find((f) => f.endsWith('.3mf'));

test('Snapmaker Orca project converts to an A1 project and keeps parts and colours', { skip: !localSnap && 'sin archivo en tests/local/' }, async () => {
  const { cfg, out, reread } = await run(`../local/${localSnap}`, retarget('Bambu Lab A1'));
  assert.equal(reread.format, 'bambu');
  assert.equal(cfg.printer_settings_id, 'Bambu Lab A1 0.4 nozzle');
  assert.ok(cfg.filament_colour.length >= 1);
  assert.equal(cfg.wall_filament, '0');
  assert.equal(out.file(/process_settings_\d+\.config/).length, 0, 'embedded presets of the old printer are dropped');
  assertInsideBed(reread, cfg);
});

test('Bambu A1 project converts to a Snapmaker U1 project', async () => {
  const { cfg, out, reread } = await run('cubo-bambu-a1.3mf', retarget('Snapmaker U1'));
  const model = await out.file('3D/3dmodel.model').async('string');
  assert.match(model, /<metadata name="Application">Snapmaker_Orca-2\.4\.0<\/metadata>/);
  assert.equal(reread.format, 'snaporca');
  assert.equal(cfg.printer_settings_id, 'Snapmaker U1 (0.4 nozzle)');
  assert.equal(cfg.print_settings_id, '0.20mm Standard @Snapmaker U1 (0.4 nozzle)');
  assert.deepEqual(cfg.filament_settings_id, ['Snapmaker PLA Basic @U1']);
  assert.equal(cfg.nozzle_diameter.length, 4);
  assert.equal(cfg.wall_filament, '1', 'Orca uses 1 as the default wall filament');
  assert.equal(cfg.version, '2.4.0');
  const item = reread.root.items[0].transform;
  assert.ok(Math.abs(item[9] - 135.5) < 0.01 && Math.abs(item[10] - 136) < 0.01, 'centred on the U1 bed');
});

test('PrusaSlicer values are translated to Snapmaker Orca names', async () => {
  const { cfg } = await run('prusa-mmu.3mf', retarget('Snapmaker U1'));
  assert.equal(cfg.support_style, 'organic');
  assert.deepEqual(cfg.filament_settings_id, ['Generic PLA', 'Generic PETG', 'Generic TPU']);
  assert.equal(cfg.filament_multi_colors.length, 3);
  assert.equal(cfg.flush_volumes_vector.length, 6);
});

test('A2L uses its own bed and presets', async () => {
  const { cfg, reread } = await run('orca-multicolor-2plates.3mf', retarget('Bambu Lab A2L'));
  assert.equal(cfg.printer_model, 'Bambu Lab A2L');
  assert.deepEqual(cfg.printable_area, ['0x0', '330x0', '330x320', '0x320']);
  assert.ok(cfg.filament_settings_id.every((f) => / @BBL A2L/.test(f)));
  assert.equal(reread.scene.plates.length, 2);
  assertInsideBed(reread, cfg);
});

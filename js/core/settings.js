// Translation of print settings from other slicers into Bambu Studio keys/values.

// Process settings worth carrying over from the source file. Speeds, accelerations, temperatures and
// machine limits are intentionally NOT copied: the Bambu system presets are tuned for the A1/A1 mini.
export const TRANSFER_KEYS = [
  'layer_height', 'initial_layer_print_height',
  'wall_loops', 'top_shell_layers', 'bottom_shell_layers', 'top_shell_thickness', 'bottom_shell_thickness',
  'sparse_infill_density', 'sparse_infill_pattern', 'top_surface_pattern', 'bottom_surface_pattern', 'internal_solid_infill_pattern',
  'infill_direction', 'infill_wall_overlap', 'ensure_vertical_shell_thickness', 'detect_thin_wall', 'wall_generator', 'wall_sequence',
  'is_infill_first', 'only_one_wall_first_layer', 'top_one_wall_type',
  'enable_support', 'support_type', 'support_style', 'support_threshold_angle', 'support_on_build_plate_only',
  'support_critical_regions_only', 'support_top_z_distance', 'support_bottom_z_distance', 'support_interface_top_layers',
  'support_interface_bottom_layers', 'support_interface_spacing', 'support_base_pattern', 'support_base_pattern_spacing',
  'support_object_xy_distance', 'support_interface_pattern', 'tree_support_branch_angle', 'tree_support_branch_distance',
  'tree_support_branch_diameter', 'independent_support_layer_height', 'support_remove_small_overhang',
  'enforce_support_layers', 'raft_layers', 'raft_contact_distance', 'raft_expansion', 'raft_first_layer_density',
  'brim_type', 'brim_width', 'brim_object_gap', 'skirt_loops', 'skirt_distance', 'skirt_height',
  'seam_position', 'seam_gap', 'ironing_type', 'ironing_flow', 'ironing_spacing', 'ironing_pattern',
  'fuzzy_skin', 'fuzzy_skin_thickness', 'fuzzy_skin_point_distance',
  'spiral_mode', 'print_sequence', 'enable_prime_tower', 'prime_tower_width', 'prime_tower_brim_width',
  'elefant_foot_compensation', 'xy_hole_compensation', 'xy_contour_compensation', 'slice_closing_radius',
  'reduce_crossing_wall', 'bridge_flow', 'thick_bridges', 'bridge_angle',
  'flush_into_infill', 'flush_into_objects', 'flush_into_support',
  'minimum_sparse_infill_area', 'infill_combination', 'interface_shells', 'mmu_segmented_region_max_width',
  'mmu_segmented_region_interlocking_depth', 'interlocking_beam', 'enable_arc_fitting', 'resolution',
  'wall_filament', 'sparse_infill_filament', 'solid_infill_filament', 'support_filament', 'support_interface_filament',
];

// Values tuned per machine/profile. They are only carried over when the user changed them by hand in
// the original project (listed in its different_settings_to_system), never from another printer's preset.
export const TUNED_KEYS = new Set([
  'initial_layer_print_height', 'top_shell_thickness', 'bottom_shell_thickness', 'infill_wall_overlap',
  'support_top_z_distance', 'support_bottom_z_distance', 'support_object_xy_distance', 'support_interface_spacing',
  'support_base_pattern_spacing', 'tree_support_branch_angle', 'tree_support_branch_distance', 'tree_support_branch_diameter',
  'raft_contact_distance', 'raft_expansion', 'raft_first_layer_density', 'brim_object_gap', 'skirt_distance', 'seam_gap',
  'ironing_flow', 'ironing_spacing', 'prime_tower_width', 'prime_tower_brim_width', 'elefant_foot_compensation',
  'xy_hole_compensation', 'xy_contour_compensation', 'slice_closing_radius', 'bridge_flow', 'thick_bridges', 'bridge_angle',
  'minimum_sparse_infill_area', 'infill_combination', 'interface_shells', 'mmu_segmented_region_max_width',
  'mmu_segmented_region_interlocking_depth', 'enable_arc_fitting', 'resolution', 'wall_sequence', 'is_infill_first',
  'wall_generator', 'detect_thin_wall', 'top_one_wall_type', 'only_one_wall_first_layer', 'reduce_crossing_wall',
  'ensure_vertical_shell_thickness', 'support_remove_small_overhang', 'independent_support_layer_height', 'fuzzy_skin_thickness',
  'fuzzy_skin_point_distance', 'infill_direction', 'support_critical_regions_only', 'support_interface_pattern',
]);

// Filament index settings (0 = default filament of the object).
export const FILAMENT_INDEX_KEYS = ['wall_filament', 'sparse_infill_filament', 'solid_infill_filament', 'support_filament', 'support_interface_filament'];

// Enum values used by OrcaSlicer / forks that Bambu Studio names differently.
export const VALUE_ALIASES = {
  ensure_vertical_shell_thickness: { none: 'disabled', ensure_critical_only: 'partial', ensure_moderate: 'partial', ensure_all: 'enabled' },
  brim_type: { painted: 'brim_ears' },
  sparse_infill_pattern: {
    rectilinear: 'zig-zag', '2dhoneycomb': 'honeycomb', 'lateral-honeycomb': 'honeycomb', 'lateral-lattice': '2dlattice',
    tpmsd: 'gyroid', tpmsfk: 'gyroid', adaptivecube: 'adaptivecubic', stars: 'tri-hexagon',
  },
  top_surface_pattern: { rectilinear: 'zig-zag', monotonicline: 'monotonicline' },
  bottom_surface_pattern: { rectilinear: 'zig-zag' },
  internal_solid_infill_pattern: { rectilinear: 'zig-zag' },
  seam_position: { aligned_back: 'aligned', rear: 'back' },
  curr_bed_type: { 'Textured Cool Plate': 'Cool Plate', 'SuperTack Plate': 'Supertack Plate', 'Smooth PEI Plate': 'High Temp Plate', 'PEI Plate': 'High Temp Plate', 'Textured PEI': 'Textured PEI Plate' },
  support_type: { normal: 'normal(auto)', tree: 'tree(auto)' },
  fuzzy_skin: { disabled_fuzzy: 'none' },
};

const NUMERIC = new Set(['Float', 'Int', 'Percent', 'FloatOrPercent']);

// Returns the value normalised for Bambu Studio, or undefined when it cannot be represented.
export function normalizeValue(profiles, key, value) {
  if (value === undefined || value === null) return undefined;
  const def = profiles.schema[key];
  const tmpl = profiles.template[key];
  if (!def && tmpl === undefined) return undefined;
  if (Array.isArray(value)) {
    if (def && !/s$/.test(def.t) && def.t !== 'Points' && value.length) value = value[0];
    else return value.map(String);
  }
  let v = String(value).trim();
  if (!def) return v;
  switch (def.t) {
    case 'Enum': {
      const alias = VALUE_ALIASES[key] && VALUE_ALIASES[key][v];
      if (alias) v = alias;
      return def.e && def.e.length && !def.e.includes(v) ? undefined : v;
    }
    case 'Bool':
      if (/^(1|true|yes)$/i.test(v)) return '1';
      if (/^(0|false|no)$/i.test(v)) return '0';
      return undefined;
    case 'Int':
      return /^-?\d+(\.0+)?$/.test(v) ? String(parseInt(v, 10)) : undefined;
    case 'Float':
      return Number.isFinite(parseFloat(v)) && !/%$/.test(v) ? String(parseFloat(v)) : undefined;
    case 'Percent':
      return Number.isFinite(parseFloat(v)) ? `${parseFloat(v)}%` : undefined;
    case 'FloatOrPercent':
      return Number.isFinite(parseFloat(v)) ? v : undefined;
    default:
      return NUMERIC.has(def.t) ? undefined : v;
  }
}

// Wraps/unwraps a value so its shape matches what Bambu Studio stores in the project file.
export function shapeLike(templateValue, value) {
  if (Array.isArray(templateValue) && !Array.isArray(value)) return templateValue.map(() => value);
  if (!Array.isArray(templateValue) && Array.isArray(value)) return value[0];
  return value;
}

export function sameValue(a, b) {
  const na = Array.isArray(a) ? a : [a];
  const nb = Array.isArray(b) ? b : [b];
  if (na.length !== nb.length) return false;
  return na.every((x, i) => {
    const fx = parseFloat(x), fy = parseFloat(nb[i]);
    if (Number.isFinite(fx) && Number.isFinite(fy) && /^-?[\d.]+%?$/.test(String(x)) && /^-?[\d.]+%?$/.test(String(nb[i]))) return Math.abs(fx - fy) < 1e-9;
    return String(x) === String(nb[i]);
  });
}

// ---------------------------------------------------------------------------------------------
// PrusaSlicer

const PRUSA_PATTERNS = {
  rectilinear: 'zig-zag', alignedrectilinear: 'alignedrectilinear', grid: 'grid', triangles: 'triangles', stars: 'tri-hexagon',
  cubic: 'cubic', line: 'line', concentric: 'concentric', honeycomb: 'honeycomb', '3dhoneycomb': '3dhoneycomb',
  gyroid: 'gyroid', hilbertcurve: 'hilbertcurve', archimedeanchords: 'archimedeanchords', octagramspiral: 'octagramspiral',
  adaptivecubic: 'adaptivecubic', supportcubic: 'supportcubic', lightning: 'lightning', zigzag: 'zigzag', crosshatch: 'crosshatch',
  monotonic: 'monotonic', monotoniclines: 'monotonicline',
};

export function fromPrusa(ini) {
  const o = {};
  const set = (k, v) => {
    if (v !== undefined && v !== null && v !== '') o[k] = String(v);
  };
  const lh = parseFloat(ini.layer_height);
  set('layer_height', ini.layer_height);
  if (ini.first_layer_height) {
    const f = String(ini.first_layer_height);
    set('initial_layer_print_height', f.endsWith('%') && lh ? String(Math.round((lh * parseFloat(f)) / 100 * 1000) / 1000) : f);
  }
  set('wall_loops', ini.perimeters);
  set('top_shell_layers', ini.top_solid_layers);
  set('bottom_shell_layers', ini.bottom_solid_layers);
  set('top_shell_thickness', ini.top_solid_min_thickness);
  set('bottom_shell_thickness', ini.bottom_solid_min_thickness);
  set('sparse_infill_density', ini.fill_density);
  set('sparse_infill_pattern', PRUSA_PATTERNS[ini.fill_pattern]);
  set('top_surface_pattern', PRUSA_PATTERNS[ini.top_fill_pattern]);
  set('bottom_surface_pattern', PRUSA_PATTERNS[ini.bottom_fill_pattern]);
  set('infill_direction', ini.fill_angle);
  set('detect_thin_wall', ini.thin_walls);
  set('wall_generator', ini.perimeter_generator);
  if (ini.support_material !== undefined) {
    set('enable_support', ini.support_material);
    const organic = ini.support_material_style === 'organic';
    const auto = ini.support_material_auto !== '0';
    set('support_type', `${organic ? 'tree' : 'normal'}(${auto ? 'auto' : 'manual'})`);
    if (organic) set('support_style', 'tree_organic');
    else if (ini.support_material_style === 'snug') set('support_style', 'snug');
    else if (ini.support_material_style === 'grid') set('support_style', 'grid');
  }
  if (parseFloat(ini.support_material_threshold) > 0) set('support_threshold_angle', ini.support_material_threshold);
  set('support_on_build_plate_only', ini.support_material_buildplate_only);
  set('support_top_z_distance', ini.support_material_contact_distance);
  if (parseFloat(ini.support_material_bottom_contact_distance) > 0) set('support_bottom_z_distance', ini.support_material_bottom_contact_distance);
  set('support_interface_top_layers', ini.support_material_interface_layers);
  set('support_interface_bottom_layers', ini.support_material_bottom_interface_layers === '-1' ? ini.support_material_interface_layers : ini.support_material_bottom_interface_layers);
  set('support_base_pattern_spacing', ini.support_material_spacing);
  set('support_object_xy_distance', ini.support_material_xy_spacing && !String(ini.support_material_xy_spacing).endsWith('%') ? ini.support_material_xy_spacing : undefined);
  set('raft_layers', ini.raft_layers);
  set('raft_contact_distance', ini.raft_contact_distance);
  set('raft_expansion', ini.raft_expansion);
  if (ini.brim_width !== undefined) {
    const w = parseFloat(ini.brim_width);
    set('brim_type', !w || ini.brim_type === 'no_brim' ? 'no_brim' : ini.brim_type || 'outer_only');
    if (w) set('brim_width', ini.brim_width);
  }
  set('brim_object_gap', ini.brim_separation);
  set('skirt_loops', ini.skirts);
  set('skirt_distance', ini.skirt_distance);
  set('skirt_height', ini.skirt_height);
  set('seam_position', { aligned: 'aligned', nearest: 'nearest', random: 'random', rear: 'back' }[ini.seam_position]);
  if (ini.ironing !== undefined) {
    set('ironing_type', ini.ironing === '1' ? ({ top: 'top', topmost: 'topmost', solid: 'solid' }[ini.ironing_type] || 'top') : 'no ironing');
    if (ini.ironing_flowrate) set('ironing_flow', ini.ironing_flowrate);
    set('ironing_spacing', ini.ironing_spacing);
  }
  if (ini.fuzzy_skin !== undefined) {
    set('fuzzy_skin', { none: 'none', external: 'external', all: 'all' }[ini.fuzzy_skin]);
    set('fuzzy_skin_thickness', ini.fuzzy_skin_thickness);
    set('fuzzy_skin_point_distance', ini.fuzzy_skin_point_dist);
  }
  set('spiral_mode', ini.spiral_vase);
  if (ini.complete_objects !== undefined) set('print_sequence', ini.complete_objects === '1' ? 'by object' : 'by layer');
  set('enable_prime_tower', ini.wipe_tower);
  set('prime_tower_width', ini.wipe_tower_width);
  set('elefant_foot_compensation', ini.elefant_foot_compensation);
  set('xy_contour_compensation', ini.xy_size_compensation);
  set('slice_closing_radius', ini.slice_closing_radius);
  set('bridge_flow', ini.bridge_flow_ratio);
  set('interface_shells', ini.interface_shells);
  set('wall_filament', ini.perimeter_extruder);
  set('sparse_infill_filament', ini.infill_extruder);
  set('solid_infill_filament', ini.solid_infill_extruder);
  set('support_filament', ini.support_material_extruder);
  set('support_interface_filament', ini.support_material_interface_extruder);
  return o;
}

// Per-object / per-volume PrusaSlicer overrides use the same names as the global config.
export function fromPrusaObject(cfg) {
  const o = fromPrusa(cfg);
  // Only keep keys that were actually present for the object.
  const present = new Set(Object.keys(cfg));
  const sources = {
    layer_height: 'layer_height', wall_loops: 'perimeters', top_shell_layers: 'top_solid_layers', bottom_shell_layers: 'bottom_solid_layers',
    sparse_infill_density: 'fill_density', sparse_infill_pattern: 'fill_pattern', enable_support: 'support_material',
    support_type: 'support_material', brim_type: 'brim_width', brim_width: 'brim_width', seam_position: 'seam_position',
    ironing_type: 'ironing', fuzzy_skin: 'fuzzy_skin', infill_direction: 'fill_angle', top_surface_pattern: 'top_fill_pattern',
    bottom_surface_pattern: 'bottom_fill_pattern', raft_layers: 'raft_layers', wall_filament: 'perimeter_extruder',
    sparse_infill_filament: 'infill_extruder', solid_infill_filament: 'solid_infill_extruder',
  };
  for (const k of Object.keys(o)) if (!present.has(sources[k] || k)) delete o[k];
  return o;
}

// ---------------------------------------------------------------------------------------------
// Cura

const CURA_PATTERNS = {
  grid: 'grid', lines: 'line', triangles: 'triangles', trihexagon: 'tri-hexagon', cubic: 'cubic', cubicsubdiv: 'adaptivecubic',
  tetrahedral: 'cubic', quarter_cubic: 'cubic', concentric: 'concentric', zigzag: 'zig-zag', cross: 'crosshatch', cross_3d: 'crosshatch',
  gyroid: 'gyroid', lightning: 'lightning',
};

export function fromCura(values) {
  const o = {};
  const num = (k) => {
    const v = values[k];
    return v !== undefined && /^-?[\d.]+$/.test(String(v).trim()) ? String(v).trim() : undefined;
  };
  const bool = (k) => (values[k] === undefined ? undefined : /^true$/i.test(values[k]) ? '1' : '0');
  const set = (k, v) => {
    if (v !== undefined && v !== null && v !== '') o[k] = String(v);
  };
  set('layer_height', num('layer_height'));
  set('initial_layer_print_height', num('layer_height_0'));
  set('wall_loops', num('wall_line_count'));
  set('top_shell_layers', num('top_layers'));
  set('bottom_shell_layers', num('bottom_layers'));
  set('top_shell_thickness', num('top_thickness'));
  set('bottom_shell_thickness', num('bottom_thickness'));
  if (num('infill_sparse_density')) set('sparse_infill_density', `${num('infill_sparse_density')}%`);
  set('sparse_infill_pattern', CURA_PATTERNS[values.infill_pattern]);
  set('enable_support', bool('support_enable'));
  if (values.support_structure) set('support_type', values.support_structure === 'tree' ? 'tree(auto)' : 'normal(auto)');
  if (values.support_type) set('support_on_build_plate_only', values.support_type === 'buildplate' ? '1' : '0');
  set('support_threshold_angle', num('support_angle'));
  if (values.adhesion_type) {
    const a = values.adhesion_type;
    set('brim_type', a === 'brim' ? 'outer_only' : 'no_brim');
    if (a === 'raft') set('raft_layers', '3');
    if (a === 'skirt') set('skirt_loops', num('skirt_line_count') || '1');
  }
  set('brim_width', num('brim_width'));
  set('skirt_distance', num('skirt_gap'));
  set('spiral_mode', bool('magic_spiralize'));
  if (values.ironing_enabled !== undefined) set('ironing_type', /^true$/i.test(values.ironing_enabled) ? (/^true$/i.test(values.ironing_only_highest_layer) ? 'topmost' : 'top') : 'no ironing');
  if (values.print_sequence) set('print_sequence', values.print_sequence === 'one_at_a_time' ? 'by object' : 'by layer');
  set('enable_prime_tower', bool('prime_tower_enable'));
  if (values.z_seam_type) set('seam_position', { back: 'back', shortest: 'nearest', random: 'random', sharpest_corner: 'aligned' }[values.z_seam_type]);
  set('elefant_foot_compensation', num('xy_offset_layer_0') ? String(-parseFloat(num('xy_offset_layer_0'))) : undefined);
  set('xy_contour_compensation', num('xy_offset'));
  set('fuzzy_skin', values.magic_fuzzy_skin_enabled !== undefined ? (/^true$/i.test(values.magic_fuzzy_skin_enabled) ? 'external' : 'none') : undefined);
  return o;
}

export function curaValues(cura) {
  // Merge [values] of every container, user changes last so they win.
  const entries = Object.entries(cura || {}).sort(([a], [b]) => rank(a) - rank(b));
  const out = {};
  for (const [, cfg] of entries) Object.assign(out, cfg.sections.values || {});
  return out;
  function rank(n) {
    if (/user/i.test(n)) return 3;
    if (/quality_changes|qualitychanges/i.test(n)) return 2;
    if (/global/i.test(n)) return 1;
    return 0;
  }
}

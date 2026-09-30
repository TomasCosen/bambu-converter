// Builds small synthetic 3MF files that mimic what other slicers write.
// Usage: node tests/make-fixtures.mjs  (writes into tests/fixtures/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// A cube of side `s` centred on the origin (object coordinates), 8 vertices / 12 triangles.
function cube(s = 20, center = [0, 0, 0]) {
  const h = s / 2;
  const [cx, cy, cz] = center;
  const v = [];
  for (const z of [-h, h]) for (const y of [-h, h]) for (const x of [-h, h]) v.push([x + cx, y + cy, z + cz]);
  const t = [
    [0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4],
    [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5],
  ];
  return { v, t };
}

function meshXml({ v, t }, triAttrs = () => '', indent = '   ') {
  return `${indent}<mesh>\n${indent} <vertices>\n${v.map((p) => `${indent}  <vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('\n')}\n${indent} </vertices>\n${indent} <triangles>\n${t
    .map((tr, i) => `${indent}  <triangle v1="${tr[0]}" v2="${tr[1]}" v3="${tr[2]}"${triAttrs(i)}/>`)
    .join('\n')}\n${indent} </triangles>\n${indent}</mesh>`;
}

const CT = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

async function save(name, zip) {
  fs.writeFileSync(path.join(dir, name), await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  console.log('wrote', name);
}

// 1) OrcaSlicer project for a Creality-like 220x220 printer: 2 objects on 2 plates, 4 filaments
//    (filament 3 unused), object 2 painted with filaments 2 and 4, a tool change to filament 4.
async function orca() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CT);
  zip.file('_rels/.rels', RELS);
  const c = cube(20);
  // Paint: triangles 0-3 whole-triangle state 2 ("8"), triangle 4 split into children (one painted with state 4 -> "1C" extended).
  const paint = (i) => (i < 4 ? ' paint_color="8"' : i === 4 ? ' paint_color="1C4443"' : '');
  zip.file('3D/Objects/object_1.model', `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
  <object id="1" type="model">
${meshXml(c)}
  </object>
  <object id="2" type="model">
${meshXml(c, paint)}
  </object>
 </resources>
 <build/>
</model>`);
  zip.file('3D/_rels/3dmodel.model.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`);
  // Plate 1 at origin, plate 2 at x = 220*1.2 = 264 (2 plates -> 2 columns).
  zip.file('3D/3dmodel.model', `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">BambuStudio-02.01.00.00</metadata>
 <metadata name="OrcaSlicer">2.3.0</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
  <object id="3" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>
  <object id="4" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>
 </resources>
 <build>
  <item objectid="3" transform="1 0 0 0 1 0 0 0 1 90 110 10" printable="1"/>
  <item objectid="3" transform="1 0 0 0 1 0 0 0 1 130 110 10" printable="1"/>
  <item objectid="4" transform="1 0 0 0 1 0 0 0 1 374 110 10" printable="1"/>
 </build>
</model>`);
  zip.file('Metadata/model_settings.config', `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="3">
    <metadata key="name" value="Cubo verde"/>
    <metadata key="extruder" value="2"/>
    <metadata key="sparse_infill_density" value="40%"/>
    <metadata key="ensure_vertical_shell_thickness" value="ensure_all"/>
    <metadata key="orca_only_setting" value="7"/>
    <part id="1" subtype="normal_part"><metadata key="name" value="Cubo verde"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/></part>
  </object>
  <object id="4">
    <metadata key="name" value="Cubo pintado"/>
    <metadata key="extruder" value="1"/>
    <part id="2" subtype="normal_part"><metadata key="name" value="Cubo pintado"/><metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/></part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/><metadata key="plater_name" value="Verdes"/><metadata key="locked" value="false"/>
    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="11"/></model_instance>
    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="1"/><metadata key="identify_id" value="12"/></model_instance>
  </plate>
  <plate>
    <metadata key="plater_id" value="2"/><metadata key="plater_name" value="Pintado"/><metadata key="locked" value="false"/>
    <model_instance><metadata key="object_id" value="4"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="13"/></model_instance>
  </plate>
</config>`);
  zip.file('Metadata/project_settings.config', JSON.stringify({
    printer_model: 'Creality K1',
    printer_settings_id: 'Creality K1 (0.4 nozzle)',
    print_settings_id: '0.16mm Optimal @Creality K1 (0.4 nozzle)',
    printable_area: ['0x0', '220x0', '220x220', '0x220'],
    printable_height: '250',
    nozzle_diameter: ['0.4'],
    layer_height: '0.16',
    wall_loops: '3',
    sparse_infill_density: '20%',
    sparse_infill_pattern: 'tpmsd',
    enable_support: '1',
    support_type: 'tree(auto)',
    brim_type: 'painted',
    elefant_foot_compensation: '0.2',
    wall_filament: '1',
    sparse_infill_filament: '1',
    curr_bed_type: 'Textured Cool Plate',
    filament_colour: ['#FF0000', '#00AA00', '#0000FF', '#FFFF00'],
    filament_type: ['PLA', 'PETG', 'PLA', 'PLA'],
    filament_settings_id: ['Generic PLA @System', 'Generic PETG @System', 'Generic PLA Silk', 'Polymaker PolyTerra PLA'],
    filament_vendor: ['Generic', 'Generic', 'Generic', 'Polymaker'],
    different_settings_to_system: ['wall_loops;sparse_infill_density', '', '', '', '', ''],
  }, null, 4));
  zip.file('Metadata/custom_gcode_per_layer.xml', `<?xml version="1.0" encoding="utf-8"?>
<custom_gcodes_per_layer>
<plate>
<plate_info id="1"/>
<layer top_z="5" type="2" extruder="4" color="#FFFF00" extra="" gcode="tool_change"/>
<layer top_z="8" type="1" extruder="1" color="" extra="" gcode="M600"/>
<mode value="MultiAsSingle"/>
</plate>
</custom_gcodes_per_layer>`);
  await save('orca-multicolor-2plates.3mf', zip);
}

// 2) PrusaSlicer project: one object with 2 volumes (a part and a modifier) + MMU painting (extended state 5).
async function prusa() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CT);
  zip.file('_rels/.rels', RELS);
  const a = cube(30);
  const b = cube(10, [0, 0, 20]);
  const v = [...a.v, ...b.v];
  const t = [...a.t, ...b.t.map((tr) => tr.map((x) => x + 8))];
  // Prusa encoding: state 2 -> "8", state 5 -> extended "2C" (nibble C then 5-3=2), state 17 -> prusa-only "0EC"? (C, E, then 8 bits)
  const paint = (i) => (i === 0 ? ' slic3rpe:mmu_segmentation="8"' : i === 1 ? ' slic3rpe:mmu_segmentation="2C"' : i === 2 ? ' slic3rpe:custom_supports="4"' : '');
  zip.file('3D/3dmodel.model', `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
 <metadata name="slic3rpe:Version3mf">1</metadata>
 <metadata name="Application">PrusaSlicer-2.9.2</metadata>
 <metadata name="slic3rpe:MmPaintingVersion">1</metadata>
 <metadata name="Title">Torre Prusa</metadata>
 <resources>
  <object id="1" type="model">
${meshXml({ v, t }, paint)}
  </object>
 </resources>
 <build>
  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 125 105 15" printable="1"/>
 </build>
</model>`);
  zip.file('Metadata/Slic3r_PE_model.config', `<?xml version="1.0" encoding="utf-8"?>
<config>
 <object id="1" instances_count="1">
  <metadata type="object" key="name" value="Torre"/>
  <metadata type="object" key="perimeters" value="4"/>
  <metadata type="object" key="extruder" value="1"/>
  <volume firstid="0" lastid="11">
   <metadata type="volume" key="name" value="Base"/>
   <metadata type="volume" key="volume_type" value="ModelPart"/>
   <metadata type="volume" key="extruder" value="0"/>
  </volume>
  <volume firstid="12" lastid="23">
   <metadata type="volume" key="name" value="Modificador"/>
   <metadata type="volume" key="volume_type" value="ParameterModifier"/>
   <metadata type="volume" key="fill_density" value="50%"/>
  </volume>
 </object>
</config>`);
  zip.file('Metadata/Slic3r_PE.config', `; generated by PrusaSlicer 2.9.2
; bed_shape = 0x0,250x0,250x210,0x210
; max_print_height = 220
; printer_model = MK4S
; layer_height = 0.15
; first_layer_height = 0.2
; perimeters = 3
; top_solid_layers = 5
; bottom_solid_layers = 4
; fill_density = 25%
; fill_pattern = gyroid
; support_material = 1
; support_material_auto = 1
; support_material_style = organic
; brim_width = 3
; seam_position = rear
; ironing = 1
; ironing_type = top
; nozzle_diameter = 0.4,0.4,0.4,0.4,0.4
; extruder_colour = "#FF8000";"#FFFFFF";"";"#000000";"#00FF00"
; filament_colour = "#FF8000";"#FFFFFF";"#123456";"#000000";"#00FF00"
; filament_type = PLA;PETG;PLA;PLA;TPU
; filament_settings_id = "Prusament PLA";"Prusament PETG";"Generic PLA";"Generic PLA";"Generic FLEX"
; print_settings_id = 0.15mm QUALITY @MK4S 0.4
`);
  await save('prusa-mmu.3mf', zip);
}

// 3) Generic 3MF (e.g. exported by a CAD tool): basematerials + per-triangle colours, one object used twice, inches.
async function generic() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CT);
  zip.file('_rels/.rels', RELS);
  const c = cube(1); // 1 inch
  zip.file('3D/3dmodel.model', `<?xml version="1.0" encoding="UTF-8"?>
<model unit="inch" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Application">SomeCAD 1.0</metadata>
 <resources>
  <basematerials id="5">
   <base name="Blanco" displaycolor="#FFFFFFFF"/>
   <base name="Rojo" displaycolor="#FF0000FF"/>
  </basematerials>
  <object id="1" type="model" pid="5" pindex="0">
${meshXml(c, (i) => (i < 2 ? ' pid="5" p1="1"' : ''))}
  </object>
  <object id="2" type="model">
   <components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0.5"/></components>
  </object>
 </resources>
 <build>
  <item objectid="2" transform="1 0 0 0 1 0 0 0 1 -2 0 0"/>
  <item objectid="2" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>
 </build>
</model>`);
  await save('generic-colors-inch.3mf', zip);
}

// 4) Cura project: object with extruder 2 (0-based 1) and Cura settings.
async function cura() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CT);
  zip.file('_rels/.rels', RELS);
  const c = cube(40, [0, 0, 20]);
  zip.file('3D/3dmodel.model', `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:cura="http://software.ultimaker.com/xml/cura/3mf/2015/10">
 <metadata name="Application">UltiMaker Cura 5.8.0</metadata>
 <resources>
  <object id="1" name="caja.stl" type="model">
   <metadatagroup>
    <metadata name="cura:extruder_nr" preserve="true" type="xs:string">1</metadata>
    <metadata name="cura:infill_sparse_density" preserve="true" type="xs:string">35</metadata>
   </metadatagroup>
${meshXml(c)}
  </object>
 </resources>
 <build>
  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 117.5 117.5 0"/>
 </build>
</model>`);
  zip.file('Cura/Ender-3.global.cfg', `[general]
version = 4
name = Creality Ender-3

[metadata]
type = machine

[values]
machine_width = 235
machine_depth = 235
machine_height = 250
`);
  zip.file('Cura/Ender-3_user.inst.cfg', `[general]
version = 4
name = Ender-3_user

[metadata]
type = user

[values]
layer_height = 0.28
wall_line_count = 3
infill_sparse_density = 18
infill_pattern = gyroid
support_enable = True
support_structure = tree
adhesion_type = brim
`);
  zip.file('Cura/extruder_1.extruder.cfg', `[general]
version = 4
name = Extruder 1

[metadata]
position = 0

[containers]
0 = extruder_1_user
3 = generic_pla_175
`);
  zip.file('Cura/extruder_2.extruder.cfg', `[general]
version = 4
name = Extruder 2

[metadata]
position = 1

[containers]
0 = extruder_2_user
3 = generic_petg_175
`);
  await save('cura-dual.3mf', zip);
}

fs.mkdirSync(dir, { recursive: true });
await orca();
await prusa();
await generic();
await cura();

#!/usr/bin/env python3
"""Generate the printer data files used by the converter.

Usage:
  python3 tools/build_data.py bambu     <BambuStudio checkout>   <template project_settings.config>
  python3 tools/build_data.py snapmaker <Snapmaker/OrcaSlicer checkout> <template project_settings.config>

Each output (data/bambu.json, data/snapmaker.json) contains, for the configured printers and all nozzle sizes:
  - fully resolved system presets (machine / process / filament),
  - the option schema (type + enum values) parsed from the slicer's PrintConfig.cpp,
  - a template project_settings.config holding the keys that no preset defines,
  - what the target slicer expects in the 3MF (application name, version).
"""
import json, os, re, subprocess, sys
sys.path.insert(0, os.path.dirname(__file__))
from resolve import Resolver

VENDORS = {
    'bambu': {
        'profile_vendor': 'BBL',
        'printers': ['Bambu Lab A1', 'Bambu Lab A1 mini', 'Bambu Lab A2L'],
        'slicer': 'Bambu Studio',
        'application': 'BambuStudio-02.00.00.00',
        'version': '02.00.00.00',
        'repo': 'https://github.com/bambulab/BambuStudio',
        'filament_index_default': '0',
        'unescape_strings': False,
    },
    'snapmaker': {
        'profile_vendor': 'Snapmaker',
        'printers': ['Snapmaker U1'],
        'slicer': 'Snapmaker Orca',
        'application': 'Snapmaker_Orca-2.4.0',
        'version': '2.4.0',
        'repo': 'https://github.com/Snapmaker/OrcaSlicer',
        'filament_index_default': '1',
        'unescape_strings': True,
    },
}
# Physical tool heads / AMS slots, used for warnings in the UI.
SLOTS = {'Bambu Lab A1': 4, 'Bambu Lab A1 mini': 4, 'Bambu Lab A2L': 4, 'Snapmaker U1': 4}
SLOT_KIND = {'Snapmaker U1': 'tools'}
META = {'type', 'name', 'inherits', 'include', 'from', 'instantiation', 'setting_id', 'filament_id',
        'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition',
        'description', 'renamed_from', 'alias', 'is_custom_defined', 'version'}


def to_str(v):
    if isinstance(v, list):
        return [to_str(x) for x in v]
    if isinstance(v, bool):
        return '1' if v else '0'
    return str(v)


def parse_schema(printconfig_cpp):
    src = open(printconfig_cpp, encoding='utf-8').read()
    schema, cur, var_key = {}, None, {}
    for line in src.splitlines():
        m = re.search(r'this->add(?:_nullable)?\(\s*"([a-zA-Z0-9_]+)"\s*,\s*(co\w+)\s*\)', line)
        if m:
            cur = m.group(1)
            schema[cur] = {'t': m.group(2)[2:]}
            for v in re.findall(r'(\w+)\s*=', line.split('this->add')[0]):
                var_key[v] = cur
            continue
        m = re.search(r'def->enum_values\.(?:push_back|emplace_back)\(\s*"([^"]*)"\s*\)', line)
        if m and cur:
            e = schema[cur].setdefault('e', [])
            if m.group(1) not in e:
                e.append(m.group(1))
            continue
        m = re.search(r'def->enum_values_u1\.(?:push_back|emplace_back)\(\s*"([^"]*)"\s*\)', line)
        if m and cur:
            schema[cur].setdefault('e_u1', []).append(m.group(1))
            continue
        m = re.search(r'def->enum_values\s*=\s*(\w+)->enum_values', line)
        if m and cur and var_key.get(m.group(1)) in schema:
            schema[cur]['e'] = list(schema[var_key[m.group(1)]].get('e', []))
    return schema


def unescape_cstyle(s):
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == '\\' and i + 1 < len(s):
            n = s[i + 1]
            out.append({'n': '\n', 'r': '\r', 't': '\t', '\\': '\\', '"': '"'}.get(n, n))
            i += 2
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def main():
    vendor_id, src_root, template_path = sys.argv[1], sys.argv[2], sys.argv[3]
    V = VENDORS[vendor_id]
    R = Resolver(os.path.join(src_root, 'resources', 'profiles'), V['profile_vendor'])
    schema = parse_schema(os.path.join(src_root, 'src', 'libslic3r', 'PrintConfig.cpp'))
    template = json.load(open(template_path, encoding='utf-8'))
    version = R.version
    try:
        commit = subprocess.check_output(['git', '-C', src_root, 'rev-parse', 'HEAD'], text=True).strip()
    except Exception:
        commit = ''

    def fmt(key, v):
        # Serialise values the way Bambu Studio writes them into project_settings.config.
        t = schema.get(key, {}).get('t', '')
        if isinstance(v, list):
            return [fmt(key, x) for x in v]
        v = to_str(v)
        if V['unescape_strings'] and t in ('String', 'Strings') and '\\' in v:
            v = unescape_cstyle(v)
        if t in ('Float', 'Floats', 'Percent', 'Percents', 'FloatOrPercent', 'FloatsOrPercents') and re.fullmatch(r'-?\d+\.0+%?', v):
            v = v.replace('.', '%').split('%')[0] + ('%' if v.endswith('%') else '')
        if t in ('Percent', 'Percents') and re.fullmatch(r'-?[\d.]+', v):
            v += '%'
        if t == 'Point' and re.fullmatch(r'-?[\d.]+x-?[\d.]+', v):
            v = v.replace('x', ',')
        return v

    def clean(cfg):
        return {k: fmt(k, v) for k, v in cfg.items() if k not in META}

    def is_inst(n):
        return R.raw(n).get('instantiation') == 'true'

    printers, machines, processes, filaments = {}, {}, {}, {}
    instances = [n for n in R.files if R.raw(n).get('instantiation') == 'true']
    for model in V['printers']:
        mm = R.raw(model)
        nozzles = mm['nozzle_diameter'].split(';')
        not_supported = [b for b in mm.get('not_support_bed_type', '').split(';') if b]
        bed_enum = schema.get('curr_bed_type', {})
        beds = bed_enum.get('e_u1') if 'Snapmaker U1' in model and bed_enum.get('e_u1') else bed_enum.get('e', [])
        printers[model] = {
            'model_id': mm.get('model_id'),
            'slots': SLOTS.get(model, 4),
            'slot_kind': SLOT_KIND.get(model, 'ams'),
            'bed_types': [b for b in beds if b not in not_supported],
            'default_bed_type': mm.get('default_bed_type', 'Textured PEI Plate'),
            'nozzles': {},
        }
        for nz in sorted(nozzles, key=float):
            mnames = [n for n in instances if R.files[n].startswith('machine')
                      and R.resolve(n).get('printer_model') == model and str(R.resolve(n).get('printer_variant')) == nz]
            if not mnames:
                continue
            mname = mnames[0]
            mc = R.resolve(mname)
            machines[mname] = clean(mc)
            procs = sorted(n for n in instances if R.files[n].startswith('process')
                           and mname in R.resolve(n).get('compatible_printers', []))
            fils = sorted(n for n in instances if R.files[n].startswith('filament')
                          and mname in R.resolve(n).get('compatible_printers', []))
            for p in procs:
                processes.setdefault(p, clean(R.resolve(p)))
            for f in fils:
                if f not in filaments:
                    fc = R.resolve(f)
                    c = clean(fc)
                    c['filament_id'] = fc.get('filament_id', '')
                    filaments[f] = c
            # Some vendor profiles name a default that does not exist (e.g. "0.20 Standard" vs "0.20mm Standard").
            dp = mc.get('default_print_profile', '')
            if dp not in procs:
                lh = re.match(r'([\d.]+)', dp)
                cands = [p for p in procs if lh and p.startswith(lh.group(1)) and 'Standard' in p] or procs
                dp = cands[0]
            df = to_str(mc.get('default_filament_profile', ['']))[0]
            if df not in fils:
                cands = [f for f in fils if f.split(' @')[0] in (df, df + ' Basic', 'Generic PLA')] or fils
                dp_f = sorted(cands, key=lambda f: ('Basic' not in f, 'Generic' in f))[0]
                df = dp_f
            printers[model]['nozzles'][nz] = {
                'machine': mname,
                'default_process': dp,
                'default_filament': df,
                'processes': procs,
                'filaments': fils,
            }

    # Store filament / process presets as diffs against a common base to keep the file small.
    def factor(presets):
        keys = set().union(*[set(p) for p in presets.values()])
        base = {}
        for k in keys:
            vals = [json.dumps(p.get(k)) for p in presets.values()]
            best = max(set(vals), key=vals.count)
            if best != 'null':
                base[k] = json.loads(best)
        diffs = {n: {k: v for k, v in p.items() if base.get(k) != v} for n, p in presets.items()}
        for n, p in presets.items():
            for k in base:
                if k not in p:
                    diffs[n][k] = None
        return base, diffs

    fbase, fdiff = factor(filaments)
    pbase, pdiff = factor(processes)
    out = {
        'vendor': {'id': vendor_id, 'slicer': V['slicer'], 'application': V['application'], 'version': V['version'],
                   'filament_index_default': V['filament_index_default']},
        'generated_from': {'repo': V['repo'], 'commit': commit, 'profile_version': version},
        'printers': printers,
        'machines': machines,
        'process_base': pbase, 'processes': pdiff,
        'filament_base': fbase, 'filaments': fdiff,
        'schema': schema,
        'template': template,
    }
    os.makedirs('data', exist_ok=True)
    path = f'data/{vendor_id}.json'
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    print('written', path, os.path.getsize(path), 'bytes;',
          len(machines), 'machines', len(processes), 'processes', len(filaments), 'filaments', len(schema), 'schema keys')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Generate data/bambu-a1.json from a BambuStudio source checkout.

Usage: python3 tools/build_data.py <BambuStudio checkout> <template project_settings.config>

The output contains, for Bambu Lab A1 and A1 mini (all nozzle sizes):
  - fully resolved system presets (machine / process / filament),
  - the option schema (type + enum values) parsed from PrintConfig.cpp,
  - a template project_settings.config holding the keys that no preset defines.
"""
import json, os, re, subprocess, sys
sys.path.insert(0, os.path.dirname(__file__))
from resolve import Resolver

PRINTERS = ['Bambu Lab A1', 'Bambu Lab A1 mini']
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
        m = re.search(r'def->enum_values\s*=\s*(\w+)->enum_values', line)
        if m and cur and var_key.get(m.group(1)) in schema:
            schema[cur]['e'] = list(schema[var_key[m.group(1)]].get('e', []))
    return schema


def main():
    bs, template_path = sys.argv[1], sys.argv[2]
    R = Resolver(os.path.join(bs, 'resources', 'profiles'))
    schema = parse_schema(os.path.join(bs, 'src', 'libslic3r', 'PrintConfig.cpp'))
    template = json.load(open(template_path, encoding='utf-8'))
    version = json.load(open(os.path.join(bs, 'resources', 'profiles', 'BBL.json')))['version']
    try:
        commit = subprocess.check_output(['git', '-C', bs, 'rev-parse', 'HEAD'], text=True).strip()
    except Exception:
        commit = ''

    def fmt(key, v):
        # Serialise values the way Bambu Studio writes them into project_settings.config.
        t = schema.get(key, {}).get('t', '')
        if isinstance(v, list):
            return [fmt(key, x) for x in v]
        v = to_str(v)
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
    for model in PRINTERS:
        mm = R.raw(model)
        nozzles = mm['nozzle_diameter'].split(';')
        printers[model] = {'model_id': mm.get('model_id'), 'nozzles': {}}
        for nz in sorted(nozzles, key=float):
            mname = f'{model} {nz} nozzle'
            mc = R.resolve(mname)
            machines[mname] = clean(mc)
            procs = sorted(n for n in R.files if R.files[n].startswith('process') and is_inst(n)
                           and mname in R.resolve(n).get('compatible_printers', []))
            fils = sorted(n for n in R.files if R.files[n].startswith('filament') and is_inst(n)
                          and mname in R.resolve(n).get('compatible_printers', []))
            for p in procs:
                processes.setdefault(p, clean(R.resolve(p)))
            for f in fils:
                if f not in filaments:
                    fc = R.resolve(f)
                    c = clean(fc)
                    c['filament_id'] = fc.get('filament_id', '')
                    filaments[f] = c
            printers[model]['nozzles'][nz] = {
                'machine': mname,
                'default_process': mc['default_print_profile'],
                'default_filament': to_str(mc['default_filament_profile'])[0],
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
        'generated_from': {'repo': 'https://github.com/bambulab/BambuStudio', 'commit': commit, 'profile_version': version},
        'printers': printers,
        'machines': machines,
        'process_base': pbase, 'processes': pdiff,
        'filament_base': fbase, 'filaments': fdiff,
        'schema': schema,
        'template': template,
    }
    os.makedirs('data', exist_ok=True)
    with open('data/bambu-a1.json', 'w', encoding='utf-8') as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
    print('written data/bambu-a1.json', os.path.getsize('data/bambu-a1.json'), 'bytes;',
          len(machines), 'machines', len(processes), 'processes', len(filaments), 'filaments', len(schema), 'schema keys')


if __name__ == '__main__':
    main()

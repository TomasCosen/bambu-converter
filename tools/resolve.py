"""Resolve Bambu Studio system presets (inherits + include) into flat dicts."""
import json, os

class Resolver:
    def __init__(self, profiles_dir):
        self.base = os.path.join(profiles_dir, 'BBL')
        idx = json.load(open(os.path.join(profiles_dir, 'BBL.json'), encoding='utf-8'))
        self.files = {}
        for lst in ('machine_model_list', 'machine_list', 'process_list', 'filament_list'):
            for e in idx[lst]:
                self.files[e['name']] = e['sub_path']
        self.raw_cache, self.cache = {}, {}

    def raw(self, name):
        if name not in self.raw_cache:
            self.raw_cache[name] = json.load(open(os.path.join(self.base, self.files[name]), encoding='utf-8'))
        return self.raw_cache[name]

    def resolve(self, name):
        """Returns (flat config, list of keys explicitly defined along the chain)."""
        if name in self.cache:
            return self.cache[name]
        r = self.raw(name)
        cfg = dict(self.resolve(r['inherits'])) if 'inherits' in r else {}
        inc = r.get('include', [])
        for i in ([inc] if isinstance(inc, str) else inc):
            cfg.update({k: v for k, v in self.raw(i).items() if k not in ('name', 'instantiation', 'type', 'from')})
        cfg.update({k: v for k, v in r.items() if k not in ('inherits', 'include')})
        self.cache[name] = cfg
        return cfg

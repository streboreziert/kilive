"""Python reference for every project found by findProjects (projects.json), for broader JS verification."""
import json, os, sys, time, traceback
sys.path.insert(0, '/home/claude/noeti/tools')
from build import B, subst_vars, stats_for, kicad_major
from kicad_pcb import parse_pcb
from kicad_sch import parse_schematic
from classify import classify
from checks import run_checks, bom_lines, power_nets
HERE = os.path.dirname(os.path.abspath(__file__))
projs = json.load(open(os.path.join(HERE, 'projects.json')))
listing = []
for d, lst in projs.items():
    rdir = os.path.join(B, d)
    for p in lst:
        if not p['pcb']:
            continue
        key = (d + '__' + p['pcb']).replace('/', '_').replace(' ', '_')
        rec = {'key': key, 'dir': d, 'proj': p}
        t0 = time.time()
        try:
            pcb = parse_pcb(os.path.join(rdir, p['pcb']))
            sch = parse_schematic(os.path.join(rdir, p['sch']), d) if p['sch'] and os.path.exists(os.path.join(rdir, p['sch'])) else None
            subst_vars(rdir, {'pcb': p['pcb']}, pcb, sch)
            classes = [classify(f) for f in pcb['fps']]
            for f, c in zip(pcb['fps'], classes):
                f['z'] = [c[0], c[1], c[2]]
            checks = run_checks(pcb, sch, classes)
            lines = bom_lines(pcb, sch)
            data = {'pcb': pcb, 'sch': sch, 'bom': lines, 'checks': checks, 'power': sorted(power_nets(pcb)),
                    'stats': stats_for(pcb, sch, lines, classes), 'kicad': kicad_major(pcb['meta']['kicad'], pcb['meta']['gen'])}
            json.dump(data, open(os.path.join(HERE, 'ref_extra', key + '.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
            rec['ok'] = True
        except Exception as e:
            rec['ok'] = False
            rec['error'] = repr(e)[:200]
        rec['s'] = round(time.time() - t0, 2)
        listing.append(rec)
        print(key, rec['ok'], rec.get('error', ''), rec['s'], flush=True)
json.dump(listing, open(os.path.join(HERE, 'ref_extra', '_list.json'), 'w'), indent=1)

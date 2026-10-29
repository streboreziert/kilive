"""Regenerate reference JSON with the current Python pipeline (same steps as build.py main), into jsport/ref/."""
import json, os, sys, time
sys.path.insert(0, '/home/claude/noeti/tools')
from build import REPOS, B, subst_vars, stats_for, kicad_major
from kicad_pcb import parse_pcb
from kicad_sch import parse_schematic
from classify import classify
from checks import run_checks, bom_lines, power_nets

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ref')
only = set(sys.argv[1:])
for repo in REPOS:
    rdir = os.path.join(B, repo['dir'])
    for board in repo['boards']:
        for ver in board['versions']:
            key = f"{repo['id']}__{board['id']}__{ver['id']}"
            if only and key not in only:
                continue
            t0 = time.time()
            pcb = parse_pcb(os.path.join(rdir, ver['pcb']))
            sch = None
            if ver.get('sch') and os.path.exists(os.path.join(rdir, ver['sch'])):
                sch = parse_schematic(os.path.join(rdir, ver['sch']), repo['name'])
            subst_vars(rdir, ver, pcb, sch)
            classes = [classify(f) for f in pcb['fps']]
            for f, c in zip(pcb['fps'], classes):
                f['z'] = [c[0], c[1], c[2]]
            checks = run_checks(pcb, sch, classes)
            lines = bom_lines(pcb, sch)
            pw = sorted(power_nets(pcb))
            st = stats_for(pcb, sch, lines, classes)
            data = {'key': key, 'pcb': pcb, 'sch': sch, 'bom': lines, 'checks': checks, 'power': pw, 'stats': st,
                    'kicad': kicad_major(pcb['meta']['kicad'], pcb['meta']['gen'])}
            raw = json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
            open(os.path.join(OUT, key + '.json'), 'wb').write(raw)
            print(f"{key}: {time.time()-t0:.1f}s", flush=True)

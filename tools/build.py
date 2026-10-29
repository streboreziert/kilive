"""Import KiCad projects from cloned GitHub repos into the web app's data folder."""
import gzip
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from kicad_pcb import parse_pcb
from kicad_sch import parse_schematic
from classify import classify
from checks import run_checks, bom_lines, power_nets, short

B = '/home/claude/boards'
OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'data'))   # app/data

REPOS = [
    {
        'id': 'anyon-e', 'owner': 'byrantech', 'name': 'laptop', 'title': 'anyon_e laptop', 'dir': 'anyon_e',
        'desc': 'anyon_e, a highly integrated, high end, open source laptop. Attempt the impossible.',
        'homepage': 'https://byran.ee/', 'license': 'MIT', 'stars': 4200, 'forks': 245,
        'topics': ['laptop', 'rk3588', 'linux', 'keyboard', 'hardware'], 'readme': 'README.md',
        'boards': [
            {'id': 'motherboard', 'name': 'motherboard', 'versions': [{'id': 'v1', 'pcb': 'motherboard/motherboard.kicad_pcb', 'sch': 'motherboard/motherboard.kicad_sch'}]},
            {'id': 'power', 'name': 'power', 'versions': [{'id': 'v1', 'pcb': 'power/power.kicad_pcb', 'sch': 'power/power.kicad_sch'}]},
            {'id': 'keyboard', 'name': 'keyboard', 'versions': [{'id': 'v1', 'pcb': 'keyboard/keyboard.kicad_pcb', 'sch': 'keyboard/keyboard.kicad_sch'}]},
            {'id': 'audio', 'name': 'audio', 'versions': [{'id': 'v1', 'pcb': 'audio/audio.kicad_pcb', 'sch': 'audio/audio.kicad_sch'}]},
            {'id': 'display_eval', 'name': 'display_eval', 'versions': [{'id': 'v1', 'pcb': 'motherboard/display_eval/display_eval.kicad_pcb', 'sch': 'motherboard/display_eval/display_eval.kicad_sch'}]},
            {'id': 'display_eval_short', 'name': 'display_eval_short', 'versions': [{'id': 'v1', 'pcb': 'motherboard/display_eval_short/display_eval_short.kicad_pcb', 'sch': 'motherboard/display_eval_short/display_eval_short.kicad_sch'}]},
            {'id': 'switch', 'name': 'switch', 'versions': [{'id': 'v1', 'pcb': 'switch/switch.kicad_pcb', 'sch': 'switch/switch.kicad_sch'}]},
            {'id': 'encoder', 'name': 'haptic encoder', 'versions': [{'id': 'v1', 'pcb': 'haptic/encoder/encoder.kicad_pcb', 'sch': 'haptic/encoder/encoder.kicad_sch'}]},
        ],
    },
    {
        'id': 'glasgow', 'owner': 'GlasgowEmbedded', 'name': 'glasgow', 'title': 'Glasgow Interface Explorer', 'dir': 'glasgow',
        'desc': 'Scots Army Knife for electronics: an FPGA-based multitool for talking to, reverse engineering and debugging digital hardware.',
        'homepage': 'https://glasgow-embedded.org/', 'license': '0BSD', 'stars': 2200, 'forks': 255,
        'topics': ['debugging-tool', 'fpga', 'usb', 'hardware'], 'readme': 'README.md',
        'boards': [
            {'id': 'glasgow', 'name': 'glasgow', 'default': 'revC3', 'versions': [
                {'id': 'revC3', 'label': 'revC3 · shipping', 'pcb': 'hardware/boards/glasgow/revC3/glasgow.kicad_pcb', 'sch': 'hardware/boards/glasgow/revC3/glasgow.kicad_sch'},
                {'id': 'revD0', 'label': 'revD0', 'pcb': 'hardware/boards/glasgow/revD0/glasgow.kicad_pcb', 'sch': 'hardware/boards/glasgow/revD0/glasgow.kicad_sch'},
                {'id': 'revD1', 'label': 'revD1 · in development', 'pcb': 'hardware/boards/glasgow/revD1/glasgow.kicad_pcb', 'sch': 'hardware/boards/glasgow/revD1/glasgow.kicad_sch'},
            ]},
        ],
    },
    {
        'id': 'hackrf', 'owner': 'greatscottgadgets', 'name': 'hackrf', 'title': 'HackRF One', 'dir': 'hackrf',
        'desc': 'Low cost software radio platform: a half-duplex transceiver from 1 MHz to 6 GHz.',
        'homepage': 'https://greatscottgadgets.com/hackrf/', 'license': 'GPL-2.0', 'stars': 8100, 'forks': 1700,
        'topics': ['sdr', 'rf', 'usb', 'hardware'], 'readme': 'Readme.md',
        'boards': [
            {'id': 'hackrf-one', 'name': 'hackrf-one', 'versions': [{'id': 'r10', 'label': 'hackrf-one (main)', 'pcb': 'hardware/hackrf-one/hackrf-one.kicad_pcb', 'sch': 'hardware/hackrf-one/hackrf-one.kicad_sch'}]},
        ],
    },
    {
        'id': 'bus-pirate', 'owner': 'DangerousPrototypes', 'name': 'BusPirate5-hardware', 'title': 'Bus Pirate 5 & 6', 'dir': 'BusPirate5-hardware',
        'desc': 'Bus Pirate hardware and accessories for v5 and higher: an RP2040/RP2350 universal serial interface tool for probing chips.',
        'homepage': 'https://docs.buspirate.com', 'license': 'MIT', 'stars': 117, 'forks': 15,
        'topics': ['debugging-tool', 'rp2040', 'rp2350', 'usb'], 'readme': 'README.md',
        'boards': [
            {'id': 'bus-pirate', 'name': 'bus_pirate', 'default': '6-REV2B', 'versions': [
                {'id': '5-REV10A', 'label': 'Bus Pirate 5 · REV10A', 'pcb': 'bus_pirate_pcb/5-REV10A/REV10a.kicad_pcb', 'sch': 'bus_pirate_pcb/5-REV10A/REV10a.kicad_sch'},
                {'id': '5XL-REV0', 'label': 'Bus Pirate 5XL · REV0', 'pcb': 'bus_pirate_pcb/5XL-REV0/5XL-REV0.kicad_pcb', 'sch': 'bus_pirate_pcb/5XL-REV0/5XL-REV0.kicad_sch'},
                {'id': '6-REV2B', 'label': 'Bus Pirate 6 · REV2B', 'pcb': 'bus_pirate_pcb/6-REV2B/6-REV2b.kicad_pcb', 'sch': 'bus_pirate_pcb/6-REV2B/6-REV2b.kicad_sch'},
            ]},
        ],
    },
    {
        'id': 'rp2040-guide', 'owner': 'Sleepdealr', 'name': 'RP2040-designguide', 'title': 'RP2040 design guide', 'dir': 'RP2040-designguide',
        'desc': 'Minimal reference hardware design for the Raspberry Pi RP2040: flash, crystal, USB-C and a 3.3 V LDO on two layers.',
        'homepage': '', 'license': 'MIT', 'stars': 271, 'forks': 15,
        'topics': ['rp2040', 'reference-design', 'usb', 'beginner'], 'readme': 'README.md',
        'boards': [
            {'id': 'rp2040-guide', 'name': 'RP2040-Guide', 'versions': [{'id': 'v0.1', 'label': 'v0.1', 'pcb': 'PCB/RP2040-Guide.kicad_pcb', 'sch': 'PCB/RP2040-Guide.kicad_sch'}]},
        ],
    },
]


def kicad_major(version, gen):
    if gen:
        try:
            return str(int(float(gen) + 0.02))
        except ValueError:
            pass
    v = int(str(version)[:8]) if str(version)[:8].isdigit() else 0
    for cut, major in ((20260101, '10'), (20241201, '9'), (20231001, '8'), (20220601, '7'), (20210601, '6'), (20171130, '5')):
        if v >= cut:
            return major
    return '?'


def subst_vars(rdir, ver, pcb, sch):
    pro = os.path.join(rdir, ver['pcb'][:-len('.kicad_pcb')] + '.kicad_pro')
    tv = {}
    try:
        tv = json.load(open(pro)).get('text_variables') or {}
    except Exception:
        pass
    def sub(s):
        if not isinstance(s, str) or '${' not in s:
            return s
        return re.sub(r'\$\{([A-Za-z0-9_]+)\}', lambda m: tv.get(m.group(1), m.group(0)), s)
    for L, g in pcb['gfx'].items():
        for t in g['texts']:
            t[0] = sub(t[0])
    if sch:
        for pg in sch['pages']:
            pg['tb'] = {k: sub(v) for k, v in pg['tb'].items()}
            if '${' in pg['tb'].get('title', ''):
                pg['tb']['title'] = ''
            for t in pg['texts']:
                t[0] = sub(t[0])
            for s in pg['syms']:
                for f in s['f']:
                    f[0] = sub(f[0])


def git(repo_dir, *args):
    return subprocess.run(['git', '-C', repo_dir, *args], capture_output=True, text=True).stdout


def history(repo_dir, path):
    out = git(repo_dir, 'log', '--format=%h|%ad|%an|%s', '--date=short', '-n', '20', '--', path)
    res = []
    for line in out.strip().splitlines():
        parts = line.split('|', 3)
        if len(parts) == 4:
            res.append({'h': parts[0], 'd': parts[1], 'a': parts[2], 'm': parts[3][:120]})
    return res


def file_list(repo_dir, folder):
    out = git(repo_dir, 'ls-files', '--', folder)
    files = []
    for f in out.strip().splitlines():
        p = os.path.join(repo_dir, f)
        try:
            size = os.path.getsize(p)
        except OSError:
            size = 0
        files.append([f, size])
    return files[:400]


def stats_for(pcb, sch, lines, classes):
    fps = pcb['fps']
    m = pcb['meta']
    ics = []
    for fi, f in enumerate(fps):
        if re.match(r'^(U|IC|M|MOD)\d', f['r']):
            desc = ''
            if sch:
                for p in sch['parts']:
                    if p['r'] == f['r']:
                        desc = p.get('desc', '')
                        break
            ics.append([f['r'], f['v'], f['fp'], desc[:90]])
    track_len = sum(pcb['trackLen'].values())
    return {
        'parts': len([f for f in fps if not f.get('bo') and classes[fps.index(f)][0] != 'none']),
        'fps': len(fps), 'smd': len([f for f in fps if f['k'] == 'smd']), 'tht': len([f for f in fps if f['k'] == 'th']),
        'top': len([f for i, f in enumerate(fps) if f['s'] == 0 and not f.get('bo') and classes[i][0] != 'none']),
        'bottom': len([f for i, f in enumerate(fps) if f['s'] == 1 and not f.get('bo') and classes[i][0] != 'none']),
        'lines': len(lines), 'nets': len([n for n in pcb['nets'] if n]), 'pads': len(pcb['pads']), 'vias': len(pcb['vias']),
        'segments': sum(len(v) // 6 for v in pcb['tracks'].values()), 'trackLen': round(track_len), 'layers': len(m['cu']),
        'w': m['w'], 'h': m['h'], 'thickness': m['thickness'], 'sheets': len(sch['pages']) if sch else 0, 'ics': ics[:80],
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    index = []
    only = set(sys.argv[1:])
    for repo in REPOS:
        rdir = os.path.join(B, repo['dir'])
        branch = git(rdir, 'rev-parse', '--abbrev-ref', 'HEAD').strip() or 'main'
        head = git(rdir, 'log', '-1', '--format=%h|%ad', '--date=short').strip().split('|')
        readme_path = os.path.join(rdir, repo['readme'])
        readme = open(readme_path, encoding='utf-8', errors='replace').read()[:24000] if os.path.exists(readme_path) else ''
        rec = {k: repo[k] for k in ('id', 'owner', 'name', 'title', 'desc', 'homepage', 'license', 'stars', 'forks', 'topics')}
        rec.update({'url': f"https://github.com/{repo['owner']}/{repo['name']}", 'branch': branch, 'head': head[0],
                    'updated': head[1] if len(head) > 1 else '', 'readme': readme, 'boards': []})
        for board in repo['boards']:
            brec = {'id': board['id'], 'name': board['name'], 'versions': [], 'default': board.get('default', board['versions'][-1]['id'])}
            for ver in board['versions']:
                key = f"{repo['id']}__{board['id']}__{ver['id']}"
                folder = os.path.dirname(ver['pcb'])
                t0 = time.time()
                if only and repo['id'] not in only:
                    # reuse existing metadata
                    mp = os.path.join(OUT, key + '.meta.json')
                    if os.path.exists(mp):
                        brec['versions'].append(json.load(open(mp)))
                    continue
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
                data = {'key': key, 'pcb': pcb, 'sch': sch, 'bom': lines, 'checks': checks, 'power': pw, 'stats': st}
                raw = json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
                with open(os.path.join(OUT, key + '.json'), 'wb') as fh:
                    fh.write(raw)
                hist = history(rdir, folder)
                meta = {'id': ver['id'], 'label': ver.get('label', ver['id']), 'file': f"data/{key}.json",
                        'pcbPath': ver['pcb'], 'schPath': ver.get('sch', ''), 'folder': folder,
                        'kicad': kicad_major(pcb['meta']['kicad'], pcb['meta']['gen']), 'stats': st,
                        'checks': {c['id']: c['status'] for c in checks},
                        'mask': pcb['meta']['mask'], 'history': hist, 'files': file_list(rdir, folder),
                        'size': len(raw)}
                json.dump(meta, open(os.path.join(OUT, key + '.meta.json'), 'w'))
                brec['versions'].append(meta)
                fails = sum(1 for c in checks if c['status'] == 'fail')
                warns = sum(1 for c in checks if c['status'] == 'warn')
                print(f"{key}: {st['parts']} parts, {st['nets']} nets, {st['sheets']} sheets, raw {len(raw)/1e6:.2f} MB, "
                      f"fail {fails} warn {warns}  [{time.time()-t0:.1f}s]  missing sheets: {sch['missing'] if sch else '-'}", flush=True)
                for c in checks:
                    print(f"    {c['status']:5} {c['title']}: {c['summary'][:150]}")
            if brec['versions']:
                rec['boards'].append(brec)
        if rec['boards']:
            index.append(rec)
    json.dump(index, open(os.path.join(OUT, 'index.json'), 'w'), separators=(',', ':'))
    print('index', os.path.getsize(os.path.join(OUT, 'index.json')))


if __name__ == '__main__':
    main()

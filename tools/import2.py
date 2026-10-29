"""Import many open KiCad repos: sparse clone, pick the main board, parse, write data + meta; collect index records.
Usage: import2.py [N_WORKERS] [only_repo ...]"""
import json, os, re, subprocess, sys, time, traceback
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(__file__))
from kicad_pcb import parse_pcb
from kicad_sch import parse_schematic
from classify import classify
from checks import run_checks, bom_lines, power_nets
from build import kicad_major, history, file_list, stats_for, git

ROOT = '/home/claude/boards2'
OUT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'data'))   # app/data
HERE = os.path.dirname(__file__)
NOTES = json.load(open(os.path.join(HERE, 'boards2', 'candidates_notes.json')))
VAL = {}
for l in open(os.path.join(HERE, 'boards2', 'validated.jsonl')):
    try:
        r = json.loads(l)
        if r.get('ok'): VAL[r['repo'].lower()] = r
    except Exception: pass
SKIP = {'sleepdealr/rp2040-designguide', 'glasgowembedded/glasgow', 'dangerousprototypes/buspirate5-hardware', 'greatscottgadgets/hackrf'}
BAD = re.compile(r'(^|/)(old|backup|backups|archive|archived|deprecated|obsolete|legacy|template|templates|plate|plates|panel|panels|panelized|panelize|faceplate|case|enclosure|test|tests|testing|jig|adapter|adaptor|breakout|lib|libs|library|libraries|footprints?|symbols?|examples?|samples?|cable|fixture|stencil|kicad-lib|3d|mechanical)(/|$)|-backups/|_backup|\.bak|autosave|_old\b|-old\b|copy', re.I)


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:40]


def natkey(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', s)]


def sh(*a, cwd=None, timeout=900):
    return subprocess.run(list(a), cwd=cwd, capture_output=True, text=True, timeout=timeout)


def clone(repo):
    d = os.path.join(ROOT, repo.replace('/', '__'))
    if os.path.isdir(os.path.join(d, '.git')):
        return d
    os.makedirs(ROOT, exist_ok=True)
    r = sh('git', 'clone', '--filter=blob:none', '--depth', '25', '--sparse', '-q', f'https://github.com/{repo}.git', d)
    if r.returncode != 0:
        raise RuntimeError('clone failed: ' + r.stderr[-200:])
    r = sh('git', '-C', d, 'sparse-checkout', 'set', '--no-cone', '/*.md', '/README*', '/readme*', '/LICENSE*', '/LICENCE*', '/COPYING*', '*.kicad_pcb', '*.kicad_sch', '*.kicad_pro')
    if r.returncode != 0:
        raise RuntimeError('sparse failed: ' + r.stderr[-200:])
    return d


def license_of(d, hint):
    if hint: return hint
    for f in os.listdir(d):
        if f.lower().startswith(('license', 'licence', 'copying')):
            t = open(os.path.join(d, f), errors='replace').read(4000)
            for rx, spdx in ((r'CERN.{0,40}Strongly', 'CERN-OHL-S-2.0'), (r'CERN.{0,40}Weakly', 'CERN-OHL-W-2.0'), (r'CERN.{0,40}Permissive', 'CERN-OHL-P-2.0'), (r'CERN', 'CERN-OHL'),
                             (r'Attribution-ShareAlike 4', 'CC-BY-SA-4.0'), (r'Attribution 4', 'CC-BY-4.0'), (r'Attribution-ShareAlike', 'CC-BY-SA'), (r'Solderpad', 'SHL'),
                             (r'Apache License', 'Apache-2.0'), (r'GNU GENERAL PUBLIC LICENSE\s+Version 3', 'GPL-3.0'), (r'GNU GENERAL PUBLIC LICENSE\s+Version 2', 'GPL-2.0'),
                             (r'Permission is hereby granted, free of charge', 'MIT'), (r'BSD', 'BSD'), (r'TAPR', 'TAPR-OHL-1.0'), (r'Mozilla Public', 'MPL-2.0')):
                if re.search(rx, t, re.I | re.S): return spdx
            return 'see LICENSE'
    return ''


TOPIC_RX = [('rp2040', r'RP2040'), ('rp2350', r'RP2350'), ('esp32', r'ESP32'), ('stm32', r'STM32'), ('nrf52', r'nRF52'), ('avr', r'ATmega|ATtiny|AT90'), ('samd', r'SAMD|SAML|ATSAM'),
            ('ice40', r'iCE40'), ('ecp5', r'ECP5'), ('fpga', r'FPGA|iCE40|ECP5|Artix|Kintex|Spartan|MachXO'), ('risc-v', r'CH32V|ESP32-C|ESP32-H|ESP32-P4'), ('usb', r'USB'), ('lora', r'LoRa|SX12|RAK')]


def pick_projects(d, projects, repo):
    cands = [p for p in projects if not BAD.search(p) and os.path.exists(os.path.join(d, p + '.kicad_pcb'))]
    if not cands:
        cands = [p for p in projects if os.path.exists(os.path.join(d, p + '.kicad_pcb'))]
    # revisions of the same board: keep the newest by natural sort of the path
    groups = {}
    for p in cands:
        base = re.sub(r'[-_ ]?(rev|v|r)[-_.]?\d+[a-z]?\b', '', os.path.basename(p), flags=re.I).lower()
        groups.setdefault(base, []).append(p)
    latest = [sorted(v, key=natkey)[-1] for v in groups.values()]
    sized = []
    for p in latest:
        try: sz = os.path.getsize(os.path.join(d, p + '.kicad_pcb'))
        except OSError: sz = 0
        name = os.path.basename(p).lower()
        bonus = 1.6 if any(k in name for k in (repo.split('/')[1].lower()[:6], 'main', 'mother', 'mobo', 'board')) else 1.0
        sized.append((sz * bonus, p))
    sized.sort(reverse=True)
    return [p for _, p in sized[:3]]


def build_one(repo):
    t0 = time.time()
    note = next((n for n in NOTES if n['repo'].lower() == repo.lower()), {})
    val = VAL.get(repo.lower())
    out = {'repo': repo, 'ok': False}
    try:
        d = clone(repo)
        pk = os.path.join(HERE, 'boards2', 'picks.json')
        over = json.load(open(pk)) if os.path.exists(pk) else {}
        projs = [over[repo]] if repo in over else pick_projects(d, val['projects'], repo)
        rid = slug(repo.split('/')[1])
        boards = []
        for p in projs[:1]:
            pcb_path, sch_path = p + '.kicad_pcb', p + '.kicad_sch'
            pcb = parse_pcb(os.path.join(d, pcb_path))
            sch = parse_schematic(os.path.join(d, sch_path), repo.split('/')[1])
            classes = [classify(f) for f in pcb['fps']]
            for f, c in zip(pcb['fps'], classes):
                f['z'] = [c[0], c[1], c[2]]
            checks = run_checks(pcb, sch, classes)
            lines = bom_lines(pcb, sch)
            pw = sorted(power_nets(pcb))
            st = stats_for(pcb, sch, lines, classes)
            bid = slug(os.path.basename(p)) or 'main'
            vid = 'latest'
            m = re.search(r'(rev[-_. ]?[0-9a-z.]+|v\d+(\.\d+)*[a-z]?)', p, re.I)
            if m: vid = m.group(1)
            key = f'{rid}__{bid}__{slug(vid) or "latest"}'
            data = {'key': key, 'pcb': pcb, 'sch': sch, 'bom': lines, 'checks': checks, 'power': pw, 'stats': st}
            raw = json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
            folder = os.path.dirname(pcb_path)
            meta = {'id': slug(vid) or 'latest', 'label': vid, 'file': f'data/{key}.json', 'pcbPath': pcb_path, 'schPath': sch_path, 'folder': folder,
                    'kicad': kicad_major(pcb['meta']['kicad'], pcb['meta']['gen']), 'stats': st, 'checks': {c['id']: c['status'] for c in checks},
                    'mask': pcb['meta']['mask'], 'history': history(d, folder or '.'), 'files': file_list(d, folder or '.'), 'size': len(raw)}
            boards.append({'id': bid, 'name': os.path.basename(p), 'default': meta['id'], 'versions': [meta], '_raw': raw, '_key': key, 'parts': st['parts'], 'sheets': st['sheets']})
        readme = ''
        for f in sorted(os.listdir(d)):
            if f.lower().startswith('readme'):
                readme = open(os.path.join(d, f), encoding='utf-8', errors='replace').read()[:24000]
                break
        head = git(d, 'log', '-1', '--format=%h|%ad', '--date=short').strip().split('|')
        blob = ' '.join([note.get('mcu', ''), note.get('title', ''), note.get('desc', '')])
        topics = [note.get('category', 'other')] + [t for t, rx in TOPIC_RX if re.search(rx, blob, re.I)]
        topics = list(dict.fromkeys(topics))[:5]
        rec = {'id': rid, 'owner': repo.split('/')[0], 'name': repo.split('/')[1], 'title': note.get('title') or repo.split('/')[1], 'desc': note.get('desc', ''),
               'homepage': '', 'license': license_of(d, note.get('license', '')), 'stars': 0, 'forks': 0, 'topics': topics, 'category': note.get('category', 'other'), 'mcu': note.get('mcu', ''),
               'url': f'https://github.com/{repo}', 'branch': git(d, 'rev-parse', '--abbrev-ref', 'HEAD').strip() or 'main', 'head': head[0], 'updated': head[1] if len(head) > 1 else '',
               'readme': readme, 'boards': []}
        for b in boards:
            with open(os.path.join(OUT, b['_key'] + '.json'), 'wb') as fh: fh.write(b['_raw'])
            json.dump(b['versions'][0], open(os.path.join(OUT, b['_key'] + '.meta.json'), 'w'))
            rec['boards'].append({k: b[k] for k in ('id', 'name', 'default', 'versions')})
        out.update(ok=bool(boards), rec=rec, parts=boards[0]['parts'] if boards else 0, sheets=boards[0]['sheets'] if boards else 0, size=len(boards[0]['_raw']) if boards else 0, project=projs[:1], secs=round(time.time() - t0, 1))
    except Exception as e:
        out['err'] = (str(e) or repr(e))[:300]
        out['tb'] = traceback.format_exc()[-600:]
    return out


if __name__ == '__main__':
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    only = [a.lower() for a in sys.argv[2:]]
    repos = [x['repo'] for x in NOTES if x['repo'].lower() not in SKIP and (not only or x['repo'].lower() in only)]
    res_path = os.path.join(HERE, 'boards2', 'import_results.jsonl')
    done = set()
    if os.path.exists(res_path) and not only:
        for l in open(res_path):
            try: done.add(json.loads(l)['repo'].lower())
            except Exception: pass
    repos = [r for r in repos if r.lower() not in done]
    print('importing', len(repos), flush=True)
    with Pool(n) as pool:
        for r in pool.imap_unordered(build_one, repos):
            with open(res_path, 'a') as f: f.write(json.dumps(r) + '\n')
            print(r['repo'], 'OK' if r['ok'] else 'FAIL', r.get('parts'), r.get('sheets'), r.get('size'), r.get('project'), r.get('secs'), r.get('err', ''), flush=True)

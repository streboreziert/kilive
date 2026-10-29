#!/usr/bin/env python3
"""Validate candidate GitHub repos: does the repo hold KiCad 6+ projects (a .kicad_pcb with a .kicad_sch of the same name)?
Usage: validate.py owner/repo [owner/repo ...]  -> appends JSON lines to validated.jsonl
Lists the tree without downloading file contents (blob-less clone)."""
import json, os, subprocess, sys, tempfile, shutil
OUT = os.path.join(os.path.dirname(__file__), 'validated.jsonl')
done = set()
if os.path.exists(OUT):
    for l in open(OUT):
        try: done.add(json.loads(l)['repo'].lower())
        except Exception: pass
for arg in sys.argv[1:]:
    repo = arg.strip().replace('https://github.com/', '').strip('/')
    if repo.endswith('.git'): repo = repo[:-4]
    if not repo or repo.lower() in done: continue
    d = tempfile.mkdtemp()
    rec = {'repo': repo, 'ok': False}
    try:
        r = subprocess.run(['git', 'clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '-q', f'https://github.com/{repo}.git', d], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            rec['err'] = (r.stderr or '').strip()[-160:]
        else:
            files = subprocess.run(['git', '-C', d, 'ls-tree', '-r', '--name-only', 'HEAD'], capture_output=True, text=True, timeout=60).stdout.split('\n')
            pcbs = [f for f in files if f.endswith('.kicad_pcb')]
            schs = set(f for f in files if f.endswith('.kicad_sch'))
            projects = []
            for p in pcbs:
                base = p[:-len('.kicad_pcb')]
                if base + '.kicad_sch' in schs:
                    projects.append(base)
            rec.update(ok=bool(projects), projects=projects[:40], nProjects=len(projects),
                       readme=next((f for f in files if '/' not in f and f.lower().startswith('readme')), None),
                       license=next((f for f in files if '/' not in f and f.lower().startswith(('license', 'licence', 'copying'))), None),
                       branch=subprocess.run(['git', '-C', d, 'rev-parse', '--abbrev-ref', 'HEAD'], capture_output=True, text=True).stdout.strip(),
                       head=subprocess.run(['git', '-C', d, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip())
    except Exception as e:
        rec['err'] = str(e)[:160]
    finally:
        shutil.rmtree(d, ignore_errors=True)
    with open(OUT, 'a') as f: f.write(json.dumps(rec) + '\n')
    print(repo, 'OK' if rec['ok'] else 'NO', rec.get('nProjects', ''), rec.get('err', ''), flush=True)

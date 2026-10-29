"""Append the boards listed in batch3.txt to data/index.json: unique ids, packed data (gzip + base64 .gz.txt), orphan clean-up."""
import base64, gzip, json, os, re
HERE = os.path.dirname(__file__)
OUT = '/home/claude/noeti/app/data'
batch = [l.strip() for l in open(os.path.join(HERE, 'batch3.txt')) if l.strip()]
res = {}
for l in open(os.path.join(HERE, 'import_results.jsonl')):
    r = json.loads(l)
    if r.get('ok'): res[r['repo'].lower()] = r          # the last good import wins
idx = json.load(open(os.path.join(OUT, 'index.json')))
have = {(r['owner'] + '/' + r['name']).lower() for r in idx}
ids = {r['id'] for r in idx}
added = []
for repo in batch:
    if repo.lower() in have: continue
    r = res.get(repo.lower())
    if not r: print('MISSING', repo); continue
    rec = json.loads(json.dumps(r['rec']))
    if rec['id'] in ids: rec['id'] = (rec['owner'][:12] + '-' + rec['id']).lower()
    ids.add(rec['id'])
    for b in rec['boards']:
        for v in b['versions']:
            f = os.path.basename(v['file'])
            key = f[:-5] if f.endswith('.json') else re.sub(r'\.json(\.gz(\.txt)?)?$', '', f)
            want = f"{rec['id']}__{b['id']}__{v['id']}"
            d = json.load(open(os.path.join(OUT, key + '.json')))
            if key != want:
                d['key'] = want
            raw = json.dumps(d, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
            open(os.path.join(OUT, want + '.json'), 'wb').write(raw)
            gz = gzip.compress(raw, 9, mtime=0)
            open(os.path.join(OUT, want + '.json.gz'), 'wb').write(gz)
            open(os.path.join(OUT, want + '.json.gz.txt'), 'w').write(base64.b64encode(gz).decode('ascii'))
            v['file'] = f'data/{want}.json.gz.txt'
            json.dump(v, open(os.path.join(OUT, want + '.meta.json'), 'w'))
    rec.setdefault('code', {'procs': 0, 'emu': []})
    idx.append(rec); added.append(rec['id'])
json.dump(idx, open(os.path.join(OUT, 'index.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
# orphans: board files no version points at
keep = set()
for r in idx:
    for b in r['boards']:
        for v in b['versions']:
            keep.add(re.sub(r'\.json(\.gz(\.txt)?)?$', '', os.path.basename(v['file'])))
removed = 0
for f in os.listdir(OUT):
    if f == 'index.json': continue
    k = re.sub(r'\.(meta\.json|json\.gz\.txt|json\.gz|json)$', '', f)
    if k not in keep: os.remove(os.path.join(OUT, f)); removed += 1
print('added', len(added), added)
print('repos', len(idx), 'boards', sum(len(r['boards']) for r in idx), 'removed orphans', removed)
tot = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT) if f.endswith('.gz.txt'))
print('gz.txt MB', round(tot / 1e6, 1), 'index KB', os.path.getsize(os.path.join(OUT, 'index.json')) // 1000)

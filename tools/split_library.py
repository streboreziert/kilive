#!/usr/bin/env python3
"""Keep a small set of example boards bundled in app/data; list every other library board as a GitHub link.

    python3 tools/split_library.py            uses EXAMPLES below
    python3 tools/split_library.py a,b,c      bundle these repository ids instead

Bundled boards: data + photos stay in app/, attribution in BOARDS.md (tools/license_audit.py).
Other boards: removed from app/, written to app/data/github.json; the app opens them live from GitHub (#gh/owner/repo).
Only permissive or attribution licenses are bundled, so the repository itself carries no copyleft or NC design files.
"""
import json, os, sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
APP = os.path.join(ROOT, 'app')
INDEX = os.path.join(APP, 'data', 'index.json')
MORE = os.path.join(APP, 'data', 'github.json')

EXAMPLES = ['rp2040-guide', 'glasgow', 'thunderscope', 'bus-pirate', 'sprig', 'smartknob', 'moteus', 'crkbd',
            'castor-and-pollux', 'picopd']
BUNDLE_OK = {'MIT', 'Apache-2.0', '0BSD', 'BSD-3-Clause', 'CERN-OHL-P-2.0', 'CC-BY-4.0', 'Unlicense'}


def gh_hash(r):
    owner, repo = r['url'].rstrip('/').split('/')[-2:]
    folders = {v.get('folder', '') for b in r.get('boards', []) for v in b.get('versions', [])[:1]}
    path = folders.pop() if len(folders) == 1 else ''
    return 'gh/' + owner + '/' + repo + ('/' + path if path else ''), owner, repo


def main():
    keep_ids = sys.argv[1].split(',') if len(sys.argv) > 1 else EXAMPLES
    with open(INDEX, encoding='utf-8') as h:
        repos = json.load(h)
    more = []
    if os.path.exists(MORE):
        with open(MORE, encoding='utf-8') as h:
            more = json.load(h)
    keep, drop = [], []
    for r in repos:
        (keep if r['id'] in keep_ids else drop).append(r)
    for r in keep:
        if r.get('license') not in BUNDLE_OK:
            sys.exit(f"{r['id']}: license {r.get('license')} is not in the bundle list {sorted(BUNDLE_OK)}")
    for r in drop:
        names = {r['id']} | {b['id'] for b in r.get('boards', [])}
        for b in r.get('boards', []):
            for v in b.get('versions', []):
                f = v.get('file')
                for p in ([f, f.replace('.json.gz.txt', '.meta.json')] if f else []):
                    fp = os.path.join(APP, p)
                    if os.path.isfile(fp): os.remove(fp)
        for d in ('photos', 'thumbs'):
            for fn in os.listdir(os.path.join(APP, d)):
                if os.path.splitext(fn)[0] in names: os.remove(os.path.join(APP, d, fn))
        h, owner, repo = gh_hash(r)
        more = [m for m in more if m.get('id') != r['id']]
        more.append({'id': r['id'], 'title': r['title'], 'desc': (r.get('desc') or '')[:240], 'owner': owner, 'repo': repo,
                     'url': r['url'], 'license': r.get('license') or '', 'category': r.get('category') or '',
                     'topics': (r.get('topics') or [])[:8], 'hash': h})
    more.sort(key=lambda m: m['title'].lower())
    keep.sort(key=lambda r: keep_ids.index(r['id']))
    with open(INDEX, 'w', encoding='utf-8') as h:
        json.dump(keep, h, ensure_ascii=False, separators=(',', ':'))
    with open(MORE, 'w', encoding='utf-8') as h:
        json.dump(more, h, ensure_ascii=False, indent=0)
    print(f'bundled {len(keep)} boards; {len(more)} listed as GitHub links in app/data/github.json')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Build KiLive as a plain static website (GitHub Pages, Netlify, any web server) into dist/.

    python3 scripts/build_site.py              -> dist/
    python3 scripts/build_site.py --out site   -> site/
    cd dist && python3 -m http.server 8000     -> http://localhost:8000

What it does:
  - copies app/ (the page, js/, data/, photos/, thumbs/, datasheet.html), leaving out previews and test pages
  - wraps app/index.html in a full HTML document (the claude.ai host normally adds that part)
  - puts scripts/browser-runtime.js in front: your library, stars and comments are kept in this browser (IndexedDB)
No dependencies beyond Python 3.8+.
"""
import argparse, os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
APP = os.path.join(ROOT, 'app')

SKIP_FILES = {'preview.html', 'preview-mock.html', 'test-editor.html', 'test-layout.html', 'index.html'}

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>KiLive — KiCad boards, live in the browser</title>
<meta name="description" content="Open any KiCad project in the browser: PCB, schematic and 3D, with a live circuit simulation running on it. Free and open source.">
<meta property="og:title" content="KiLive">
<meta property="og:description" content="Open-hardware PCBs and schematics in the browser, with the electricity flowing through them.">
<meta property="og:type" content="website">
<link rel="icon" type="image/png" href="icon.png">
<style>:root{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui;background:#fafaf7}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=os.path.join(ROOT, 'dist'))
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    if os.path.commonpath([out, ROOT]) == out:
        sys.exit('refusing to write over the repository root')
    if os.path.isdir(out):
        shutil.rmtree(out)

    def ignore(d, names):
        top = os.path.abspath(d) == APP
        return [n for n in names if (top and n in SKIP_FILES) or n == '__pycache__' or n == '.DS_Store']

    shutil.copytree(APP, out, ignore=ignore)

    with open(os.path.join(APP, 'index.html'), encoding='utf-8') as h:
        page = h.read()
    import re
    page = re.sub(r'<title>.*?</title>\s*', '', page, count=1)   # the head above carries the title
    with open(os.path.join(HERE, 'browser-runtime.js'), encoding='utf-8') as h:
        runtime = h.read()
    with open(os.path.join(out, 'browser-runtime.js'), 'w', encoding='utf-8') as h:
        h.write(runtime)
    with open(os.path.join(out, 'index.html'), 'w', encoding='utf-8') as h:
        h.write(HEAD + '<script src="browser-runtime.js"></script>\n' + page + '\n</body>\n</html>\n')

    shutil.copy(os.path.join(HERE, 'app-icon.png'), os.path.join(out, 'icon.png'))
    open(os.path.join(out, '.nojekyll'), 'w').close()          # GitHub Pages: serve files as they are

    n = sum(len(f) for _, _, f in os.walk(out))
    size = sum(os.path.getsize(os.path.join(r, x)) for r, _, f in os.walk(out) for x in f)
    print(f'wrote {out}: {n} files, {size / 1e6:.1f} MB')


if __name__ == '__main__':
    main()

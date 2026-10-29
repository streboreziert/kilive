"""Builds app/test-editor.html: the editor mounted full-page with the app's design tokens and control styles copied from index.html."""
import re, pathlib
root = pathlib.Path('/home/claude/noeti/app')
css = re.search(r'<style>(.*?)</style>', (root / 'index.html').read_text(), re.S).group(1)
keep = []
wanted = [r'^:root', r'^@media \(prefers-color-scheme', r'^\*', r'^html', r'^body', r'^button', r'^:focus-visible', r'^\.num', r'^\.mono', r'^\.muted', r'^\.small',
          r'^\.eyebrow', r'^\.ico', r'^\.grow', r'^\.btn', r'^\.icon-btn', r'^\.input', r'^textarea', r'^\.seg', r'^\.pill', r'^\.tag', r'^\.menu-', r'^\.mi-',
          r'^#toasts', r'^\.toast', r'^\.viewer-tip', r'^\.toolbar', r'^\.tb', r'^\.tab-badge', r'^\.probe-chip', r'^\.err']
# split top-level blocks (keeps nested @media blocks whole)
blocks, depth, cur = [], 0, ''
for ch in css:
    cur += ch
    if ch == '{': depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0: blocks.append(cur.strip()); cur = ''
for b in blocks:
    b = re.sub(r'^/\*.*?\*/\s*', '', b, flags=re.S)
    if b.startswith('@media (max-width') or b.startswith('@media (prefers-reduced'): continue
    if any(re.match(w, b) for w in wanted): keep.append(b)
page = f'''<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Schematic editor · KiLive</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="js/scheditor.css">
<script>if (/[?&]dark\\b/.test(location.search)) document.documentElement.dataset.theme = 'dark'; else if (/[?&]light\\b/.test(location.search)) document.documentElement.dataset.theme = 'light';</script>
<style>
/* copied from index.html: design tokens and the control classes the editor reuses */
{chr(10).join(keep)}
/* test page */
html, body {{ margin: 0; height: 100%; overflow: hidden; }}
#host {{ width: 100vw; height: 100vh; height: 100dvh; }}
</style>
<div id="host"></div>
<script src="js/util.js"></script>
<script src="js/ds2k-engine.js"></script>
<script src="js/scheditor.js"></script>
<script>
  const params = new URLSearchParams(location.search);
  window.changes = [];
  window.ed = new Noeti.SchEditor(document.getElementById('host'), {{
    title: 'Untitled circuit',
    readOnly: params.has('ro'),
    onChange: doc => {{ window.changes.push(doc); window.lastDoc = doc; }},
  }});
  if (params.has('example')) ed.setDoc(Noeti.SchEditor.fromCircuit(DS2K_EXAMPLE));
</script>
</html>
'''
(root / 'test-editor.html').write_text(page)
print('wrote', len(page), 'bytes;', len(keep), 'css blocks')

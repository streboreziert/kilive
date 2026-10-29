"""Builds app/datasheet.html: the datasheet -> reference design reader (datasheet2kicad's browser build) as one
self-contained page. KiLive shows it in a window (New board -> Read a datasheet) and the page hands the
extracted circuit back to the app, which places it on a board.

Sources in datasheet/:
  shell.html       the page markup and CSS
  app_all.js       the datasheet2kicad engine + page logic (unchanged upstream file; patched below for the embed)
  pdf.min.mjs, pdf.worker.mjs   pdf.js, inlined so nothing loads from a CDN
"""
import os, re

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.normpath(os.path.join(here, '..'))
src = os.path.join(root, 'datasheet')
out = os.path.join(root, 'app', 'datasheet.html')

shell = open(os.path.join(src, 'shell.html'), encoding='utf-8').read()
app = open(os.path.join(src, 'app_all.js'), encoding='utf-8').read()


def patch(text, old, new, what):
    assert text.count(old) == 1, f'{what}: anchor not found exactly once'
    return text.replace(old, new)


# --- the page: title, embed styling (the window hides the page's own top bar)
shell = patch(shell, '<title>Debug AI</title>', '<title>Datasheet to reference design</title>', 'title')
shell = patch(shell, '\n</style>', '\nhtml.embedded .bar{display:none}html.embedded .wrap{padding-block:14px 48px}\n</style>', 'embed css')
shell = patch(shell, '<header class="bar">', '<script>if(window.parent!==window)document.documentElement.classList.add("embedded");</script>\n<header class="bar">', 'embed class')

# --- the logic: in the window the page is a plain page (its own key or manual mode; normal downloads), and the result
# carries a button that hands the circuit to KiLive
app = patch(app, 'const IN_HOST = !!(window.claude && window.claude.use);',
            'const EMBED = window.parent !== window;\nconst IN_HOST = !EMBED && !!(window.claude && window.claude.use);', 'IN_HOST')
anchor = 'const pv = el("div", { class: "preview", tabindex: "0", "aria-label": "Schematic preview" }); pv.innerHTML = r.svg; box.append(pv);'
app = patch(app, anchor, anchor + '\n  if (EMBED) box.append(el("div", { class: "row", style: "align-items:center;gap:12px" }, '
            'el("button", { type: "button", class: "primary", onclick: () => { parent.postMessage({ type: "noeti-circuit", circuit: bakedCircuit(), name: projectName(), source: state.pdfName || "", example: !!state.isExample }, location.origin); } }, "Open as a board in KiLive"), '
            'el("span", { class: "small" }, "Every part placed on a PCB, the circuit simulated live, saved to your library.")));', 'noeti button')

assert '</script' not in app.lower(), 'app_all.js must not contain </script'
body = shell.rstrip()
if body.endswith('</html>'):
    body = body[: body.rfind('</body>')] if '</body>' in body else body[: body.rfind('</html>')]
body += '\n<script>\n' + app + '\n</script>\n'
for name in ('pdf.worker.mjs', 'pdf.min.mjs'):
    mod = open(os.path.join(src, name), encoding='utf-8').read()
    # pdf.worker carries raw control bytes inside string literals (a code-page table); the artifact host refuses them,
    # so they become the equivalent \xNN escapes
    mod = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', lambda m: '\\x%02x' % ord(m.group(0)), mod)
    assert '</script' not in mod.lower() and '<!--' not in mod, name
    body += '<script type="module">\n' + mod + '\n</script>\n'
body += '<script type="module">window.dispatchEvent(new Event("ds2k-pdfready"));</script>\n</body></html>\n'
open(out, 'w', encoding='utf-8').write(body)
print('wrote', out, len(body), 'bytes')

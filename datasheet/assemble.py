"""Builds the two deliverables from the sources in this folder:

  datasheet-to-kicad.html   page fragment published as the Claude artifact
  datasheet2kicad.html      the same page as a complete document - double-click to open locally

Both are fully self-contained: the PDF reader (pdf.js) is inlined, nothing is loaded from a CDN.
"""
import json, os

base = os.path.dirname(os.path.abspath(__file__)) + "/"
root = os.path.dirname(os.path.dirname(base)) + "/"
PDFJS = os.environ.get("PDFJS_DIR", "/home/claude/.npm-global/lib/node_modules/pdfjs-dist/legacy/build/")

ex = json.load(open(root + "examples/tps54331_buck.json"))
for c in ex["components"]:
    for k in ("optional", "kicad_symbol", "footprint"):
        c.pop(k, None)
ex["confidence"] = None
ex.update(json.load(open(base + "example_options.json")))      # the choices the example offers (output voltage, soft start, UVLO)

js = "".join(open(base + f).read() + "\n" for f in ["engine1.js", "engine2.js", "engine3.js", "engine4.js", "options.js", "combine.js", "sim.js", "compare.js", "zipstore.js"])
js += "window.DS2K_EXAMPLE = " + json.dumps(ex, separators=(",", ":")) + ";\n" + open(base + "app.js").read()


def module(path):
    src = open(path).read()
    assert "</script" not in src.lower() and "<!--" not in src, path
    return '<script type="module">\n' + src + "\n</script>\n"


assert "</script" not in js.lower() and "<!--" not in js
body = open(base + "shell.html").read()
body += "<script>\n" + js + "</script>\n"
body += module(PDFJS + "pdf.worker.min.mjs")      # sets globalThis.pdfjsWorker -> pdf.js runs on the main thread, no Worker needed
body += module(PDFJS + "pdf.min.mjs")             # sets globalThis.pdfjsLib
body += '<script type="module">window.dispatchEvent(new Event("ds2k-pdfready"));</script>\n'

open(base + "datasheet-to-kicad.html", "w").write(body)
full = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' + body + "</html>\n")
open(base + "datasheet2kicad.html", "w").write(full)
print(len(body) // 1024, "KB")

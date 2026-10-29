"""Parse .kicad_pcb files with the app's importer and print {path: {pcb, z}} as JSON (used by test.js)."""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from kicad_pcb import parse_pcb
from classify import classify

out = {}
for p in sys.argv[1:]:
    pcb = parse_pcb(p)
    out[p] = {'pcb': pcb, 'z': [list(classify(f)) for f in pcb['fps']]}
json.dump(out, sys.stdout)

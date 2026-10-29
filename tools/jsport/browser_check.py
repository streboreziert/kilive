"""Load app/js/kicad-import.js in headless Chromium and import RP2040-designguide (plain files and from a ZIP)."""
import base64, io, json, os, zipfile
from playwright.sync_api import sync_playwright

B = '/home/claude/boards/RP2040-designguide/PCB'
files = {f'PCB/{f}': open(os.path.join(B, f), encoding='utf-8').read() for f in os.listdir(B) if f.endswith(('.kicad_pcb', '.kicad_sch', '.kicad_pro'))}
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
    for k, v in files.items():
        zf.writestr('RP2040-designguide-main/' + k, v.encode('utf-8'))
zip_b64 = base64.b64encode(buf.getvalue()).decode()
ref = json.load(open('/home/claude/noeti/app/data/rp2040-guide__rp2040-guide__v0.1.json'))

JS = r"""
async ([files, zipB64]) => {
  const K = window.Noeti && window.Noeti.kicad;
  if (!K) return {error: 'Noeti.kicad missing'};
  const out = {};
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 0);
  const stages = [];
  const proj = K.findProjects(Object.keys(files))[0];
  const t0 = performance.now();
  const r = await K.importProject(files, proj, {onProgress: (l, f) => stages.push([l, f])});
  out.ms = Math.round(performance.now() - t0);
  clearInterval(iv);
  out.ticksDuringImport = ticks;
  out.stages = stages;
  out.proj = proj;
  out.stats = r.stats;
  out.kicad = r.kicad;
  out.checks = r.checks.map((c) => c.id + ':' + c.status);
  out.full = JSON.stringify([r.pcb, r.sch, r.bom, r.checks, r.power, r.stats]);
  // ZIP path through DecompressionStream('deflate-raw')
  const bin = Uint8Array.from(atob(zipB64), (c) => c.charCodeAt(0));
  const unz = await K.unzip(bin.buffer);
  const zp = K.findProjects(Object.keys(unz).map((k) => [k, unz[k].length]))[0];
  const r2 = await K.importProject(unz, zp);
  out.zipProj = zp;
  out.zipSame = JSON.stringify([r2.pcb, r2.sch, r2.bom, r2.checks, r2.power, r2.stats]) === out.full;
  return out;
}
"""

with sync_playwright() as p:
    br = p.chromium.launch(headless=True)
    page = br.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:8765/index.html')
    page.add_script_tag(url='http://localhost:8765/js/kicad-import.js')
    res = page.evaluate(JS, [files, zip_b64])
    br.close()

full = res.pop('full')
py = json.dumps([ref['pcb'], ref['sch'], ref['bom'], ref['checks'], ref['power'], ref['stats']])
same_full = json.loads(full) == json.loads(py)
print('browser import ms:', res['ms'], ' setTimeout ticks during import:', res['ticksDuringImport'])
print('stages:', res['stages'])
print('project:', res['proj'], ' kicad:', res['kicad'])
print('stats equal to Python:', res['stats'] == ref['stats'])
print('pcb/sch/bom/checks/power/stats deep-equal to Python JSON:', same_full)
print('zip project:', res['zipProj'], ' zip import identical:', res['zipSame'])
print('page errors (from index.html, not this module):', errors[:3])

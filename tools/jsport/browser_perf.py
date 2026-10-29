"""Time importProject on the largest board in Chromium and measure the longest main-thread block."""
import os
from playwright.sync_api import sync_playwright
D = '/home/claude/boards/glasgow/hardware/boards/glasgow/revD1'
files = {f'revD1/{f}': open(os.path.join(D, f), encoding='utf-8').read() for f in os.listdir(D) if f.endswith(('.kicad_pcb', '.kicad_sch', '.kicad_pro'))}
JS = r"""
async (files) => {
  const K = window.Noeti.kicad;
  const proj = K.findProjects(Object.keys(files))[0];
  let last = performance.now(), maxGap = 0, gaps = [];
  let running = true;
  const beat = () => { const t = performance.now(); const g = t - last; if (g > maxGap) maxGap = g; if (g > 60) gaps.push(Math.round(g)); last = t; if (running) setTimeout(beat, 0); };
  setTimeout(beat, 0);
  const t0 = performance.now();
  const stages = [];
  const r = await K.importProject(files, proj, {onProgress: (l) => stages.push([l, Math.round(performance.now() - t0)])});
  const total = performance.now() - t0;
  running = false;
  const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
  return {total: Math.round(total), maxGap: Math.round(maxGap), longGaps: gaps, stages, parts: r.stats.parts, heapMB: mem};
}
"""
with sync_playwright() as p:
    br = p.chromium.launch(headless=True)
    page = br.new_page()
    page.goto('http://localhost:8765/index.html')
    page.add_script_tag(url='http://localhost:8765/js/kicad-import.js')
    for i in range(2):
        print(page.evaluate(JS, files))
    br.close()

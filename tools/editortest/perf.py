from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch(); page = b.new_page(viewport={'width': 1440, 'height': 900})
    page.goto('http://localhost:8765/test-editor.html', wait_until='load'); page.wait_for_timeout(300)
    for scale in ['fit', 6]:
        r = page.evaluate("""(scale) => {
          const comps = [], nets = [], types = ['resistor', 'capacitor', 'led', 'diode', 'bjt_npn', 'inductor'], pre = {resistor:'R',capacitor:'C',led:'D',diode:'D',bjt_npn:'Q',inductor:'L'};
          for (let i = 0; i < 150; i++) { const t = types[i % 6]; comps.push({ ref: pre[t] + (i + 1), type: t, value: '1k' }); }
          for (let i = 0; i + 1 < comps.length; i++) { const a = comps[i], b = comps[i + 1]; const pa = /^D/.test(a.ref) ? 'K' : a.type === 'bjt_npn' ? 'C' : '2'; const pb = /^D/.test(b.ref) ? 'A' : b.type === 'bjt_npn' ? 'B' : '1'; nets.push({ name: i % 10 ? '' : 'GND', kind: i % 10 ? 'signal' : 'ground', nodes: [{ ref: a.ref, pin: pa }, { ref: b.ref, pin: pb }] }); }
          ed.setDoc(Noeti.SchEditor.fromCircuit({ components: comps, nets })); if (scale !== 'fit') ed.view.s = scale;
          const t0 = performance.now(); for (let i = 0; i < 30; i++) ed._paint(); return { s: ed.view.s, paintMs: (performance.now() - t0) / 30 }; }""", scale)
        print(r)
    b.close()

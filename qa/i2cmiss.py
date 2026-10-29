import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1500)
        allm = {}
        for r in idx:
            for bd in r['boards']:
                v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
                res = await pg.evaluate("""async (f) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d); const c = Noeti.simtab.boardCircuit(B);
                  const procs = new Set(Noeti.fw.detect(c).map(p => p.ref)); const out = [];
                  for (const x of c.components) { if (x.type !== 'ic' || procs.has(x.ref)) continue; const pins = (x.pins || []).map(p => String(p.name || '').toUpperCase());
                    const i2c = pins.some(n => /^(SDA|SDATA|SDI\\/SDA|SDA\\/SDI|I2C_SDA)$/.test(n)) && pins.some(n => /^(SCL|SCLK|SCL\\/SPC|SCL\\/SCLK|I2C_SCL)$/.test(n));
                    if (!i2c) continue; let s = null; try { s = Noeti.devices.match(x); } catch (e) {} if (!s) out.push((x.value || '').slice(0, 26) + ' | ' + (x.description || '').slice(0, 60)); }
                  return out; }""", v['file'])
                for x in res: allm[x] = allm.get(x, 0) + 1
        for k, n in sorted(allm.items(), key=lambda kv: -kv[1]): print(n, k)
        await b.close()
asyncio.run(main())

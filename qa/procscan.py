import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1500)
        for r in idx:
            for bd in r['boards']:
                v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
                res = await pg.evaluate("""async (f) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d); const wb = Noeti.simtab.wholeBoard(B); const c = wb.circuit;
                  const procs = Noeti.fw.detect(c); const links = Noeti.fw.uartLinks(c, procs);
                  let i2c = 0, spi = 0; for (const p of procs) { try { const a = Noeti.analysis.forProc(c, p); i2c += a.i2c.reduce((s, b) => s + b.devices.length, 0); spi += a.spi.reduce((s, b) => s + b.devices.length, 0); } catch (e) {} }
                  return { procs: procs.map(p => p.ref + ':' + (p.chip ? p.chip.id : p.value)).join(','), links: links.map(k => k.from + '>' + k.to).join(','), i2c, spi }; }""", v['file'])
                if res['i2c'] or res['spi'] or res['links']:
                    print(r['id'] + '/' + bd['id'], json.dumps(res), flush=True)
        await b.close()
asyncio.run(main())

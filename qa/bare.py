import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    want = sys.argv[1].split('|')
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1500)
        for r in idx:
            for bd in r['boards']:
                v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
                res = await pg.evaluate("""async ([f, want]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
                  const wb = Noeti.simtab.wholeBoard(B); const out = [];
                  for (const c of wb.circuit.components) { if (!want.some(w => (c.value || '').startsWith(w))) continue;
                    const pins = (c.pins || []).map(p => { const n = wb.circuit.nets.find(n => n.nodes.some(x => x.ref === c.ref && String(x.pin) === String(p.number))); return p.number + ':' + p.name + ':' + (p.etype || '').slice(0, 5) + (p.low ? '~' : '') + '=' + (n ? n.name.slice(0, 16) : '-'); });
                    out.push({ ref: c.ref, type: c.type, kind: c.kind, value: c.value, desc: (c.description || '').slice(0, 70), lib: c.lib, pkg: (c.package || '').slice(0, 40), pins: pins.slice(0, 16), model: wb.sim.models[c.ref] ? wb.sim.models[c.ref].family : null }); }
                  return out; }""", [v['file'], want])
                for x in res:
                    print(r['id'], json.dumps(x))
        await b.close()
asyncio.run(main())

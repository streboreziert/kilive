import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1500)
        out = []
        for r in idx:
            for bd in r['boards']:
                v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
                res = await pg.evaluate("""async (f) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
                  const full = Noeti.simtab.boardCircuit(B); const circ = { components: full.components, nets: full.nets };
                  const procs = new Set((Noeti.fw.detect(circ) || []).map(p => p.ref));
                  const rows = [];
                  for (const c of full.components) {
                    if (!['ic', 'other', 'connector'].includes(c.type)) continue;
                    let g = null; try { g = Noeti.simtab.guessChip(circ, c); } catch (e) {}
                    let sp = null; try { sp = Noeti.devices.match(c); } catch (e) {}
                    const pins = (c.pins || []).map(p => { const n = circ.nets.find(n => n.nodes.some(x => x.ref === c.ref && String(x.pin) === String(p.number))); return [p.number, p.name, p.etype, n ? n.name : '', n ? n.kind : '']; });
                    rows.push({ ref: c.ref, type: c.type, value: c.value, desc: c.description, pkg: c.package, model: g ? g.model : null, proc: procs.has(c.ref), dev: sp ? sp.id : null, pins });
                  }
                  return rows; }""", v['file'])
                for row in res: row['board'] = r['id'] + '/' + bd['id']
                out.extend(res)
                print(r['id'], bd['id'], len(res), flush=True)
        json.dump(out, open('/tmp/claude-0/qa/census.json', 'w'))
        await b.close()
asyncio.run(main())

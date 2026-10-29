import asyncio, json, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu']); pg = await b.new_page()
        await pg.goto(URL, wait_until='networkidle')
        for r in idx:
            v = r['boards'][0]['versions'][0]
            res = await pg.evaluate("""async (f)=>{ const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d); const c = Noeti.simtab.boardCircuit(B);
              const inNets = new Set(); for (const n of c.nets) for (const x of n.nodes) inNets.add(x.ref);
              const np = c.components.filter(x=>!(x.pins||[]).length && inNets.has(x.ref));
              return {n: c.components.length, nopins: np.length, ex: np.slice(0,4).map(x=>x.ref+':'+x.type)} }""", v['file'])
            if res['nopins']: print(r['id'], res)
        await b.close()
asyncio.run(main())

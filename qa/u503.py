import asyncio, json, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    r = [x for x in idx if x['id']==sys.argv[1]][0]; v = r['boards'][0]['versions'][int(sys.argv[2])]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu']); pg = await b.new_page()
        await pg.goto(URL, wait_until='networkidle')
        res = await pg.evaluate("""async ([f, ref])=>{ const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d); const c = Noeti.simtab.boardCircuit(B); const ix = Noeti.analysis.index(c);
          const u = ix.comp.get(ref); const ps = Noeti.fw.detect(c); const p = ps[0];
          return {val: u.value, mpn: u.mpn, type: u.type, pins: (u.pins||[]).map(q=>q.number+':'+q.name+'='+((ix.at(ref,q.number)||{}).name)), procNets: p.io.filter(i=>/LED|CDO|N9/.test(i.net)).map(i=>i.number+':'+i.net)} }""", [v['file'], sys.argv[3]])
        print(json.dumps(res, indent=1))
        await b.close()
asyncio.run(main())

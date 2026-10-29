import asyncio, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    out = {}
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL, wait_until='networkidle')
        for r in idx:
            for bd in r['boards']:
                v = bd['versions'][0]
                try:
                    res = await pg.evaluate("""async (f)=>{ const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d); const c = Noeti.simtab.boardCircuit(B);
                      return Noeti.fw.detect(c).map(p=>({ref:p.ref,value:p.value,description:p.description,family:p.family,kind:p.kind,vnom:p.vnom,
                         pins:(c.components.find(x=>x.ref===p.ref).pins||[]).map(q=>[q.number,q.name,q.etype]), io:p.io.map(i=>i.name+'='+i.net.split('/').pop())})) }""", v['file'])
                    out[r['id']+'/'+bd['id']] = res
                except Exception as e:
                    out[r['id']+'/'+bd['id']] = {'error': str(e)[:200]}
        await b.close()
    json.dump(out, open('/home/claude/emu/procpins.json','w'), indent=0)
    print(len(out))
asyncio.run(main())

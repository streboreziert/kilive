import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; nets = sys.argv[2].split(',')
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle')
        await pg.wait_for_timeout(1200)
        await pg.evaluate("Noeti.startLive()")
        await pg.wait_for_timeout(300)
        await pg.evaluate("(()=>{const L=Noeti.live; L.running=false; const e=L.engine; e.setDt(2e-6); e.advance(0.06, 90000); L.running=true; L.setSpeed(1e-5); })()")
        await pg.wait_for_timeout(500)
        for n in nets:
            r = await pg.evaluate("""(n)=>{const L=Noeti.live; const name=[...L.netIdx.keys()].find(k=>k.split('/').pop()===n)||n; const ex=L.explain(name); const e=L.engine; const nd=L.netNode.get(name);
               return {name, v: nd? e.V(nd):null, ex, chips:(L.base.sim.chips||[]).filter(c=>JSON.stringify(c).includes('')).map(c=>c.ref+':'+c.model+(c.vout?' vout='+c.vout:'')+(c.note?' ('+c.note+')':'')).slice(0,30), sources:(L.base.sim.sources||[]).map(s=>s.net.split('/').pop()+'='+s.value)}}""", n)
            print(json.dumps(r, indent=0)[:3000])
        await b.close()
asyncio.run(main())

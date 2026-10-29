import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1000)
        await pg.evaluate("Noeti.live.setSpeed(1)"); await pg.wait_for_timeout(2500)
        r = await pg.evaluate("""(()=>{ const L=Noeti.live, e=L.engine, c=L.base.circuit; const p=L.procs[0]; const ix=Noeti.analysis.index(c);
          const v = n => { const nd = e.nodeOf(n); return nd ? +e.V(nd).toFixed(3) : null; };
          const comp = c.components.find(x=>x.ref===p.ref);
          const pw = comp.pins.filter(q=>/VDD|VCC|3V3|VBAT/i.test(q.name)).map(q=>q.number+':'+q.name+'='+((ix.at(p.ref,q.number)||{}).name)+' '+v((ix.at(p.ref,q.number)||{}).name));
          const rails = (L.rails ? L.rails() : []).slice(0,12).map(r=>JSON.stringify(r).slice(0,160));
          return {t:e.t, sup: e.supplies(), vddPin: p.vdd, pw, rails, sim: JSON.stringify(L.base.sim.sources||L.base.sim.supplies||'').slice(0,400)} })()""")
        print(json.dumps(r, indent=1))
        await b.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#e-paper-climate-logger~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1000)
        await pg.evaluate("(()=>{const L=Noeti.live; const p=L.procs[0]; window.__a=L.analysisFor(p); L.fwm.runScript(p, Noeti.analysis.program(window.__a)); L.realTime();})()")
        await pg.wait_for_timeout(2500)
        r = await pg.evaluate("""(()=>{ const L=Noeti.live, e=L.engine, c=L.base.circuit; const a=window.__a; const v = n => { const nd = e.nodeOf(n); return nd ? +e.V(nd).toFixed(3) : null; };
          const d = a.i2c.flatMap(b=>b.devices).find(d=>/ds3231/.test(d.spec.id)); const comp = c.components.find(x=>x.ref===d.ref);
          const ix = Noeti.analysis.index(c);
          return {d: d.ref+' '+d.address, pins: comp.pins.map(p=>p.number+':'+p.name+'='+((ix.at(d.ref,p.number)||{}).name)+' '+v((ix.at(d.ref,p.number)||{}).name)), con: [...L.fwm.procs.values()][0].console.text.slice(0,400)} })()""")
        print(json.dumps(r, indent=1))
        await b.close()
asyncio.run(main())

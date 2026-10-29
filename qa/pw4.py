import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd, ref = sys.argv[1], sys.argv[2]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1000)
        await pg.evaluate("Noeti.live.setSpeed(1)"); await pg.wait_for_timeout(2000)
        r = await pg.evaluate("""(ref)=>{ const L=Noeti.live, e=L.engine, c=L.base.circuit; const ix=Noeti.analysis.index(c);
          const v = n => { const nd = e.nodeOf(n); return nd ? +e.V(nd).toFixed(3) : null; };
          const x = ix.comp.get(ref);
          const el = e.els.filter(q=>q.ref===ref).map(q=>{ const o={}; for (const k in q) if (typeof q[k] !== 'object' && typeof q[k] !== 'function') o[k]=q[k]; return o; });
          const ch = (L.base.sim.chips||[]).filter(q=>q.ref===ref);
          return {comp: x.ref+' '+x.value+' '+(x.description||'').slice(0,80), pins: ix.pinList(x).map(pn=>pn+':'+(((x.pins||[]).find(q=>String(q.number)===pn)||{}).name||'')+'='+((ix.at(x.ref,pn)||{}).name)+' '+v((ix.at(x.ref,pn)||{}).name)), el, ch} }""", ref)
        print(json.dumps(r, indent=1)[:5000])
        await b.close()
asyncio.run(main())

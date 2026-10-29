import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd, sw = sys.argv[1], sys.argv[2]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1000)
        r = await pg.evaluate("""(sw)=>{ const L=Noeti.live, e=L.engine, c=L.base.circuit; const p=L.procs[0]; const a=L.analysisFor(p); const ix=Noeti.analysis.index(c);
          const v = n => { const nd = e.nodeOf(n); return nd ? +e.V(nd).toFixed(3) : null; };
          const b = a.buttons.find(x=>x.ref===sw); const n = ix.net.get(b.io.net);
          const sws = c.components.find(x=>x.ref===sw);
          return {btn: b.io, nodes: n.nodes.map(x=>x.ref+'.'+x.pin+' '+((ix.comp.get(x.ref)||{}).value||'')), r21: ix.pinList(ix.comp.get('R21')).map(pn=>pn+'='+((ix.at('R21',pn)||{}).name)+' '+v((ix.at('R21',pn)||{}).name)), swNets: ix.pinList(sws).map(pn=>pn+'='+((ix.at(sw,pn)||{}).name)+' '+v((ix.at(sw,pn)||{}).name)), vnow: v(b.io.net)} }""", sw)
        print(json.dumps(r, indent=1))
        await b.close()
asyncio.run(main())

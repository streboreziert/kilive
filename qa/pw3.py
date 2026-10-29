import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd, net = sys.argv[1], sys.argv[2]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1000)
        r = await pg.evaluate("""(net)=>{ const L=Noeti.live, e=L.engine, c=L.base.circuit; const ix=Noeti.analysis.index(c);
          const v = n => { const nd = e.nodeOf(n); return nd ? +e.V(nd).toFixed(3) : null; };
          const n = ix.net.get(net);
          const ics = [...new Set(n.nodes.map(x=>x.ref))].map(r=>ix.comp.get(r)).filter(x=>x && !/capacitor|resistor/.test(x.type));
          const els = e.els.filter(x=>/REG|SWR|LSW/.test(x.t)).map(x=>x.t+' '+x.ref+' in='+x.inNet+' out='+x.outNet+' '+(x.vout||'')).slice(0,20);
          return {ics: ics.map(x=>x.ref+' '+x.type+' '+x.value+' '+(x.description||'').slice(0,60)+' pins: '+ix.pinList(x).map(pn=>pn+':'+(((x.pins||[]).find(q=>String(q.number)===pn)||{}).name||'')+'='+((ix.at(x.ref,pn)||{}).name)).join(', ')), els, regs: (L.base.sim.regulators||L.base.sim.regs||[]).length, simKeys: Object.keys(L.base.sim)} }""", net)
        print(json.dumps(r, indent=1)[:5000])
        await b.close()
asyncio.run(main())

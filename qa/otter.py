import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#otterpill~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1000)
        r = await pg.evaluate("""(()=>{ const L=Noeti.live, e=L.engine, c=L.base.circuit; const p=L.procs[0]; const io=p.io.find(i=>/PA0/.test(i.chipPin||i.name));
          const v = n => { const nd = e.nodeOf(n); return nd ? +e.V(nd).toFixed(3) : null; };
          const rs = c.components.filter(x=>/^R1[45]$/.test(x.ref)).map(x=>x.ref+' '+x.value);
          const nets = c.nets.filter(n=>n.nodes.some(x=>/^R1[45]$/.test(x.ref))).map(n=>n.name+': '+n.nodes.map(x=>x.ref+'.'+x.pin).join(' ')+' V='+v(n.name));
          const els = e.els.filter(x=>/^R1[45]$/.test(x.ref)).map(x=>x.ref+' t='+x.t+' v='+x.v);
          return {io, rs, nets, els, vbus: v('VBUS'), pin: e.pinV(p.ref, io.number), mode: p.drive ? null : null} })()""")
        print(json.dumps(r, indent=1))
        await b.close()
asyncio.run(main())

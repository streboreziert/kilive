import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1300, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.live.setSpeed(1, false, true)")
        await pg.wait_for_timeout(5000)
        r = await pg.evaluate("""(() => { const L = Noeti.live, B = L.B, F = Noeti.pcbFlow(B); Noeti.pcbFlowUpdate(B, F, L);
          const out = [];
          for (const [net, o] of F.byNet) { if (!o.fac) continue; const W = o.W;
            for (let c = 0; c < o.fac.length; c++) { const pads = o.fac.pads[c]; let s = 0; for (const nd of pads) s += o.inj[nd];
              if (Math.abs(s) > 1e-4) { const pl = W.pads.filter(([pi, nd]) => o.fac.comp[nd] === c).map(([pi]) => { const p = B.pads[pi]; return B.fps[p[0]].r + '.' + p[1] + '=' + (L.padI(B.fps[p[0]].r, p[1]) * 1000).toFixed(2); });
                out.push({ net: B.nets[net], comp: c, ncomp: o.fac.length, nodes: o.fac[c].nodes.length, s: +(s * 1000).toFixed(2), pads: pl.slice(0, 8), zones: o.d.zones.length, vias: o.d.vias.length }); } } }
          out.sort((a, b) => Math.abs(b.s) - Math.abs(a.s));
          return out.slice(0, 12); })()""")
        for x in r: print(json.dumps(x))
        await b.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1300, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error',) and 'TUNNEL' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        r0 = await pg.evaluate("""(() => { const B = Noeti.app.cur.B; delete B._pcbFlow; const t0 = performance.now(); const F = Noeti.pcbFlow(B); const t1 = performance.now();
          let maxN = 0, tot = 0, maxNet = 0; for (const [net, o] of F.byNet) { tot += o.W.n; if (o.W.n > maxN) { maxN = o.W.n; maxNet = net; } }
          return { buildMs: Math.round(t1 - t0), nets: F.byNet.size, nodes: tot, maxNodes: maxN, maxNet: B.nets[maxNet], nseg: F.nseg }; })()""")
        print('build', json.dumps(r0))
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.live.setSpeed(1, false, true)")
        await pg.wait_for_timeout(5000)
        r = await pg.evaluate("""(() => { const L = Noeti.live, B = L.B, F = Noeti.pcbFlow(B);
          for (const [, o] of F.byNet) o.fac = null;
          const t0 = performance.now(); Noeti.pcbFlowUpdate(B, F, L); const t1 = performance.now(); Noeti.pcbFlowUpdate(B, F, L); const t2 = performance.now();
          const chk = Noeti.pcbFlowCheck(B, F, L);
          let nz = 0, big = []; for (let s = 0; s < F.nseg; s++) if (Math.abs(F.segI[s]) > 1e-6) nz++;
          // biggest factor
          let fmax = 0, fnet = 0; for (const [net, o] of F.byNet) if (o.fac) { let nn = 0; for (const C of o.fac) if (C.ci) nn += C.ci.length; if (nn > fmax) { fmax = nn; fnet = net; } }
          // per net: total current entering at pads
          return { firstMs: Math.round(t1 - t0), againMs: +(t2 - t1).toFixed(2), kcl: chk, segsWithCurrent: nz, maxFactorNnz: fmax, maxFactorNet: B.nets[fnet], t: L.engine.t }; })()""")
        print('update', json.dumps(r))
        print('\n'.join(logs[:10]))
        await b.close()
asyncio.run(main())

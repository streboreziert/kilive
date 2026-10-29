import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + ('~pcb' if '~' in bd else '~~pcb'), wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(3000)
        await pg.evaluate("""(() => { const v = Noeti.app.views.pcb, B = v.B; const f = B.fps.find(f => /^U\\d/.test(f.r) && f.pads.length > 6) || B.fps[0]; v.zoomTo(f.x, f.y, 18); v.draw(); })()""")
        await pg.wait_for_timeout(2500)
        info = await pg.evaluate("""(() => { const v = Noeti.app.views.pcb, F = v.B._pcbFlow; if (!F) return null; let best = -1, bi = 0; const W = v.root.clientWidth, H = v.root.clientHeight;
          for (let s = 0; s < F.nseg; s++) { const a = v.toScreen(F.segs[s*6], F.segs[s*6+1]), b = v.toScreen(F.segs[s*6+2], F.segs[s*6+3]); const mx = (a[0]+b[0])/2, my = (a[1]+b[1])/2; if (mx < 80 || my < 80 || mx > W-80 || my > H-80) continue; if (Math.abs(F.segI[s]) > bi) { bi = Math.abs(F.segI[s]); best = s; } }
          if (best < 0) return null; const a = v.toScreen(F.segs[best*6], F.segs[best*6+1]), b = v.toScreen(F.segs[best*6+2], F.segs[best*6+3]); const r = v.root.getBoundingClientRect();
          return {best, I: F.segI[best], net: F.segNet[best], netName: v.B.nets[F.segNet[best]], layer: F.segs[best*6+5], seg: Array.from(F.segs.slice(best*6, best*6+6)), pos: [r.left + (a[0]+b[0])/2, r.top + (a[1]+b[1])/2]}; })()""")
        print(json.dumps(info))
        pos = info['pos']
        await pg.mouse.click(pos[0], pos[1]); await pg.wait_for_timeout(1500)
        r = await pg.evaluate("""(() => { const A = Noeti.app, h = A.selHit, B = Noeti.app.views.pcb.B, F = B._pcbFlow; if (!h) return 'nohit';
          const s = Noeti.liveSegAt(B, h.hit.net, h.at[0], h.at[1], h.hit.L);
          return {view: h.view, type: h.hit.type, L: h.hit.L, net: h.hit.net, at: h.at, sel: [...A.sel.nets], segAt: s, segI: s >= 0 ? F.segI[s] : null, segNet: s>=0 ? F.segNet[s] : null}; })()""")
        print(json.dumps(r))
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: pcbzoom.py board ref span [layer|all] [flip]
async def main():
    bd, ref = sys.argv[1], sys.argv[2]
    span = float(sys.argv[3]) if len(sys.argv) > 3 else 12
    layer = sys.argv[4] if len(sys.argv) > 4 else 'all'
    flip = len(sys.argv) > 5 and sys.argv[5] == 'flip'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error',) and 'TUNNEL' not in m.text and 'fonts' not in m.text and '404' not in m.text else None)
        await pg.goto(URL + '#' + bd + ('~pcb' if '~' in bd else '~~pcb'), wait_until='networkidle'); await pg.wait_for_timeout(2500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1200)
        await pg.evaluate("(()=>{const L=Noeti.live; const p=L.procs[0]; if (p) { const a=L.analysisFor(p); const src=Noeti.analysis.program(a); L.fwm.runScript(p, src); } L.setSpeed(1, false, true); L.ui.toggleSide(false); })()")
        await pg.wait_for_timeout(1500)
        r = await pg.evaluate(f"""(() => {{ const v = Noeti.app.views.pcb; const B = v.B; const f = B.fp('{ref}'); if (!f) return null;
          {'v.setFlip && v.setFlip(true);' if flip else ''}
          if ('{layer}' !== 'all') for (const L of B.cu) v.layerVis[L] = L === '{layer}';
          v.zoomTo(f.x, f.y, {span}); v.draw(); return [f.r, f.v, f.x, f.y, v.view.s]; }})()""")
        print('target', r)
        await pg.wait_for_timeout(5000)
        await pg.screenshot(path=f'/tmp/claude-0/qa/pcbz-{bd.split("~")[0]}-{ref}.png', clip={'x': 25, 'y': 125, 'width': 1000, 'height': 700})
        # hover the busiest track near the part and read the tooltip
        tip = await pg.evaluate("""(() => { const v = Noeti.app.views.pcb, F = v.B._pcbFlow; if (!F) return 'no flow'; let best = -1, bi = 0; const W = v.root.clientWidth, H = v.root.clientHeight;
          for (let s = 0; s < F.nseg; s++) { const a = v.toScreen(F.segs[s*6], F.segs[s*6+1]), b = v.toScreen(F.segs[s*6+2], F.segs[s*6+3]); const mx = (a[0]+b[0])/2, my = (a[1]+b[1])/2; if (mx < 40 || my < 40 || mx > W-40 || my > H-40) continue; if (Math.abs(F.segI[s]) > bi) { bi = Math.abs(F.segI[s]); best = s; } }
          if (best < 0) return 'none'; const a = v.toScreen(F.segs[best*6], F.segs[best*6+1]), b = v.toScreen(F.segs[best*6+2], F.segs[best*6+3]); const r = v.root.getBoundingClientRect(); return [r.left + (a[0]+b[0])/2, r.top + (a[1]+b[1])/2]; })()""")
        if isinstance(tip, list):
            await pg.mouse.move(tip[0], tip[1]); await pg.wait_for_timeout(1200)
            t = await pg.evaluate("(() => { const t = document.querySelector('.pcb-tip, .tip, [class*=tip]:not([hidden])'); return t ? t.innerText : ''; })()")
            print('tooltip:', t.replace('\n', ' | '))
            await pg.screenshot(path=f'/tmp/claude-0/qa/pcbz-{bd.split("~")[0]}-{ref}-tip.png', clip={'x': 25, 'y': 125, 'width': 1000, 'height': 700})
        print('\n'.join(logs[:12]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: uishots.py board tag - full-window screenshots of the live views, before and after clicking a trace
async def main():
    bd = sys.argv[1]; tag = sys.argv[2] if len(sys.argv) > 2 else 'a'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + ('~pcb' if '~' in bd else '~~pcb'), wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-0-pcb.png')
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(3000)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-1-live.png')
        # zoom in somewhere busy
        await pg.evaluate("""(() => { const v = Noeti.app.views.pcb, B = v.B; const f = B.fps.find(f => /^U\\d/.test(f.r) && f.pads.length > 6) || B.fps[0]; v.zoomTo(f.x, f.y, 18); v.draw(); })()""")
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-2-zoom.png')
        # click the busiest visible track
        pos = await pg.evaluate("""(() => { const v = Noeti.app.views.pcb, F = v.B._pcbFlow; if (!F) return null; let best = -1, bi = 0; const W = v.root.clientWidth, H = v.root.clientHeight;
          for (let s = 0; s < F.nseg; s++) { const a = v.toScreen(F.segs[s*6], F.segs[s*6+1]), b = v.toScreen(F.segs[s*6+2], F.segs[s*6+3]); const mx = (a[0]+b[0])/2, my = (a[1]+b[1])/2; if (mx < 80 || my < 80 || mx > W-80 || my > H-80) continue; if (Math.abs(F.segI[s]) > bi) { bi = Math.abs(F.segI[s]); best = s; } }
          if (best < 0) return null; const a = v.toScreen(F.segs[best*6], F.segs[best*6+1]), b = v.toScreen(F.segs[best*6+2], F.segs[best*6+3]); const r = v.root.getBoundingClientRect(); return [r.left + (a[0]+b[0])/2, r.top + (a[1]+b[1])/2]; })()""")
        if pos:
            await pg.mouse.move(pos[0], pos[1]); await pg.wait_for_timeout(800)
            await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-3-hover.png')
            await pg.mouse.click(pos[0], pos[1]); await pg.wait_for_timeout(1500)
            await pg.mouse.move(5, 300); await pg.wait_for_timeout(300)
            await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-4-click.png')
            print('probes after click:', await pg.evaluate("Noeti.live.probes.map(p => p.label)"))
            btn = await pg.query_selector('.selcard .scl-probe')
            if btn:
                await btn.click(); await pg.wait_for_timeout(1500)
                await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-4b-probed.png')
        print('probes:', await pg.evaluate("Noeti.live.probes.map(p => p.label)"))
        # select a part
        await pg.evaluate("Noeti.select(['U7'], [])"); await pg.wait_for_timeout(1500)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-4c-part.png')
        await pg.evaluate("location.hash = location.hash.replace('~pcb', '~sch')"); await pg.wait_for_timeout(2500)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-5-sch.png')
        await pg.evaluate("location.hash = location.hash.replace('~sch', '~3d')"); await pg.wait_for_timeout(4000)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-6-3d.png')
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

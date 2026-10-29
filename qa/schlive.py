import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; zoom = float(sys.argv[2]) if len(sys.argv) > 2 else 1
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error',) and 'TUNNEL' not in m.text and 'fonts' not in m.text and '404' not in m.text else None)
        await pg.goto(URL + '#' + bd + ('~sch' if '~' in bd else '~~sch'), wait_until='networkidle'); await pg.wait_for_timeout(2500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1200)
        await pg.evaluate("(()=>{const L=Noeti.live; const p=L.procs[0]; if (p) { const a=L.analysisFor(p); const src=Noeti.analysis.program(a); L.fwm.runScript(p, src); } L.setSpeed(1, false, true); L.ui.toggleSide(false); })()")
        await pg.wait_for_timeout(4000)
        if zoom != 1:
            await pg.evaluate(f"(() => {{ const v = Noeti.app.views.sch; const W = v.root.clientWidth, H = v.root.clientHeight; const c = v.toWorld ? v.toWorld(W/2, H/2) : null; v.view.s *= {zoom}; if (c) {{ v.view.ox = W/2 - c[0] * v.view.s; v.view.oy = H/2 - c[1] * v.view.s; }} v.draw(); }})()")
            await pg.wait_for_timeout(2500)
        await pg.screenshot(path=f'/tmp/claude-0/qa/sch-{bd.split("~")[0]}.png', clip={'x': 25, 'y': 125, 'width': 1000, 'height': 700})
        print('\n'.join(logs[:12]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error', 'warning') and 'TUNNEL' not in m.text and 'fonts' not in m.text and 'GPU stall' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        refs = await pg.evaluate("(() => { const v = Noeti.app.views.v3d; v.setReal(true, true); return v.B.fps.filter(f => f.z && f.z[0] === 'elco').map(f => f.r); })()")
        print('elco:', refs)
        # click on the cap through the app (as a user would): project its centre and click
        await pg.wait_for_timeout(3000)
        if refs:
            pt = await pg.evaluate(f"(() => {{ const v = Noeti.app.views.v3d; const f = v.B.fp('{refs[0]}'); const q = v.project(f.x, f.y, f.s); const r = v.canvas.getBoundingClientRect(); return [r.left + q[0], r.top + q[1] - 8]; }})()")
            await pg.mouse.click(pt[0], pt[1]); await pg.wait_for_timeout(4000)
            print('selected:', await pg.evaluate("[...Noeti.app.views.v3d.hl.refs]"))
        await pg.screenshot(path=f'/tmp/claude-0/qa/sel-{bd}.png')
        print('\n'.join(logs[:12]))
        await b.close()
asyncio.run(main())

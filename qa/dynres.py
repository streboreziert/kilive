import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=2)
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(4000)
        await pg.evaluate("(() => { const v = Noeti.app.views.v3d; v.setReal(true, true); v.dirty = true; })()")
        await pg.wait_for_timeout(5000)
        r0 = await pg.evaluate("(() => { const v = Noeti.app.views.v3d; return [v.canvas.width, v.canvas.height, v.fullW, v.fullH, +v.moveScale.toFixed(3)]; })()")
        box = await pg.evaluate("(() => { const r = Noeti.app.views.v3d.canvas.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        await pg.mouse.move(box[0], box[1]); await pg.mouse.down()
        for i in range(6): await pg.mouse.move(box[0] + i * 8, box[1] + i * 2); await pg.wait_for_timeout(30)
        r1 = await pg.evaluate("(() => { const v = Noeti.app.views.v3d; return [v.canvas.width, v.canvas.height, v.curScale]; })()")
        await pg.mouse.up(); await pg.wait_for_timeout(4000)
        r2 = await pg.evaluate("(() => { const v = Noeti.app.views.v3d; return [v.canvas.width, v.canvas.height, v.curScale, v.realOn]; })()")
        print('rest', r0, 'moving', r1, 'after', r2)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{bd}-dyn.png')
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

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
        await pg.click('button:has-text("Light")'); await pg.wait_for_timeout(400)
        await pg.screenshot(path=f'/tmp/claude-0/qa/menu-{bd}.png')
        await pg.click('text=Realistic parts'); await pg.wait_for_timeout(2500)
        print('after click:', await pg.evaluate("(() => { const v = Noeti.app.views.v3d; return { realOn: v.realOn, vao: !!(v.real && v.real.vao), stored: Noeti.store.get('real3d') }; })()"))
        await pg.click('button:has-text("Bare board")'); await pg.wait_for_timeout(3000)
        await pg.screenshot(path=f'/tmp/claude-0/qa/bare-{bd}.png')
        await pg.click('button:has-text("Light")'); await pg.wait_for_timeout(300)
        await pg.click('text=Simple shapes'); await pg.wait_for_timeout(1500)
        print('after simple:', await pg.evaluate("(() => { const v = Noeti.app.views.v3d; return { realOn: v.realOn, stored: Noeti.store.get('real3d') }; })()"))
        print('\n'.join(logs[:12]))
        await b.close()
asyncio.run(main())

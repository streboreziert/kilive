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
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:200]}') if m.type in ('error', 'warning') and 'TUNNEL' not in m.text and 'fonts' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3000)
        await pg.click('button:has-text("Light")'); await pg.wait_for_timeout(300)
        await pg.click('text=Photo-real (renders')
        for i in range(50):
            await pg.wait_for_timeout(2000)
            on = await pg.evaluate("document.querySelector('.gl-still') && document.querySelector('.gl-still').classList.contains('on')")
            if on: break
        print('still on after', (i + 1) * 2, 's')
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=f'/tmp/claude-0/qa/still-{bd}.png')
        # orbit a bit and check it re-renders quickly (scene cached)
        box = await pg.evaluate("(()=>{const r=document.querySelector('.gl-canvas').getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2]})()")
        await pg.mouse.move(box[0], box[1]); await pg.mouse.down(); await pg.mouse.move(box[0] + 120, box[1] + 30, steps=8); await pg.mouse.up()
        await pg.wait_for_timeout(200)
        off = await pg.evaluate("document.querySelector('.gl-still').classList.contains('on')")
        t0 = 0
        for i in range(40):
            await pg.wait_for_timeout(1000)
            on = await pg.evaluate("document.querySelector('.gl-still').classList.contains('on')")
            if on: break
        print('hidden while moving:', not off, '; re-rendered after', i + 1, 's')
        await pg.screenshot(path=f'/tmp/claude-0/qa/still2-{bd}.png')
        print('\n'.join(logs[:10]))
        await b.close()
asyncio.run(main())

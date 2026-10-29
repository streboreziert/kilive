import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(4000)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/ph-board-0.png')
        await pg.goto(URL + '#' + bd + '~~checks', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("window.scrollTo(0, 250)"); await pg.wait_for_timeout(500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/ph-board-1.png')
        print('scrollWidth', await pg.evaluate("document.documentElement.scrollWidth"))
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; tag = sys.argv[2] if len(sys.argv) > 2 else 't'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + ('~pcb' if '~' in bd else '~~pcb'), wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(3000)
        for tab in ['actions', 'board', 'code']:
            await pg.evaluate(f"Noeti.live.ui.open('{tab}')"); await pg.wait_for_timeout(1200)
            await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-{tab}.png')
        # the More menu
        btn = await pg.query_selector('.live-bar [aria-label="More"], .live-bar .lb-more')
        if btn:
            await btn.click(); await pg.wait_for_timeout(500)
            await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-more.png')
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

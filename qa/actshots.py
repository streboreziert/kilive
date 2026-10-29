import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; tag = sys.argv[2] if len(sys.argv) > 2 else 'act'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 2400})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + ('~pcb' if '~' in bd else '~~pcb'), wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(3000)
        for tab in sys.argv[3].split(','):
            await pg.evaluate(f"Noeti.live.ui.open('{tab}')"); await pg.wait_for_timeout(1500)
            el = await pg.query_selector('.live-side')
            if el: await el.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-{tab}.png')
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

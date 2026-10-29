import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd, tag = sys.argv[1], sys.argv[2]; scale = float(sys.argv[3]) if len(sys.argv) > 3 else 1
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=scale)
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + '~~sch', wait_until='networkidle'); await pg.wait_for_timeout(3000)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}.png')
        if len(sys.argv) > 4:
            await pg.evaluate(sys.argv[4]); await pg.wait_for_timeout(1500)
            await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-b.png')
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

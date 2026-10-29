import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else 'home'
    w = int(sys.argv[2]) if len(sys.argv) > 2 else 1440
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': w, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#explore', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-0.png')
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}-full.png', full_page=True)
        h = await pg.evaluate("document.documentElement.scrollHeight")
        print('page height', h)
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

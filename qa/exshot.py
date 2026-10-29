import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        for w, h, tag, dark in [(1440, 1000, 'ex-desk', False), (1440, 1000, 'ex-dark', True), (390, 844, 'ex-phone', False)]:
            pg = await b.new_page(viewport={'width': w, 'height': h}, color_scheme='dark' if dark else 'light')
            logs = []
            pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
            await pg.goto(URL + '#explore', wait_until='networkidle'); await pg.wait_for_timeout(1500)
            await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}.png')
            if tag == 'ex-desk':
                await pg.click('.ex-cat-list button:nth-child(1)'); await pg.wait_for_timeout(300)
                await pg.evaluate("document.querySelector('.ex-vb[data-v=list]').click()"); await pg.wait_for_timeout(500)
                await pg.screenshot(path='/tmp/claude-0/qa/ui/ex-list.png')
                await pg.evaluate("document.querySelector('.ex-vb[data-v=cards]').click()")
            print(tag, 'scrollWidth', await pg.evaluate('document.documentElement.scrollWidth'), '\n'.join(logs) or 'NO ERRORS')
            await pg.close()
        await b.close()
asyncio.run(main())

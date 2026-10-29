import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#glasgow~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(3000)
        await pg.click('#ver-btn'); await pg.wait_for_timeout(300)
        print('menu:', await pg.evaluate("document.querySelector('.menu-pop').innerText.replace(/\\n+/g, ' | ')"))
        items = await pg.query_selector_all('.menu-pop button')
        for it in items:
            if 'Compare with' in await it.inner_text(): await it.click(); break
        await pg.wait_for_timeout(4000)
        print('compare:', await pg.evaluate("document.querySelector('.modal') && document.querySelector('.modal').innerText.replace(/\\n+/g, ' | ').slice(0, 900)"))
        await pg.screenshot(path='/tmp/claude-0/qa/ui/k-8-glasgow-diff.png')
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
        await pg.click('#kicad-btn'); await pg.wait_for_timeout(300)
        print('kicad:', await pg.evaluate("document.querySelector('.menu-pop').innerText.replace(/\\n+/g, ' | ')"))
        items = await pg.query_selector_all('.menu-pop button')
        for it in items:
            if 'plugin' in await it.inner_text(): await it.click(); break
        await pg.wait_for_timeout(500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/k-9-plugin.png')
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

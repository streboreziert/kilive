import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'ERR_TUNNEL' not in m.text else None)
        await pg.goto(URL + '#new', wait_until='networkidle'); await pg.wait_for_timeout(1200)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/na-0-new.png')
        await pg.goto(URL + '#' + bd + '~~checks', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        print('ask section:', await pg.evaluate("!!document.querySelector('.ask')"), 'sim/explain text:', await pg.evaluate("document.body.innerText.includes('KiLive is') || document.body.innerText.includes('Ask KiLive')"))
        await pg.screenshot(path='/tmp/claude-0/qa/ui/na-1-checks.png')
        await pg.evaluate("location.hash = location.hash.replace('~checks', '~sim')"); await pg.wait_for_timeout(2000)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/na-2-sim.png')
        await pg.evaluate("location.hash = location.hash.replace('~sim', '~pcb')"); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(3000)
        await pg.evaluate("Noeti.live.ui.open('code')"); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/na-3-code.png')
        await pg.evaluate("Noeti.live.ui.open('board')"); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/na-4-board.png')
        await pg.click('.live-bar .lb-more'); await pg.wait_for_timeout(400)
        print('more menu:', await pg.evaluate("document.querySelector('.menu-pop') && document.querySelector('.menu-pop').innerText.replace(/\\n+/g, ' | ')"))
        await pg.keyboard.press('Escape')
        await pg.evaluate("Noeti.select(['U1'], [])"); await pg.wait_for_timeout(600)
        print('card buttons:', await pg.evaluate("[...document.querySelectorAll('#selcard .sc-acts button')].map(b => b.innerText)"))
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

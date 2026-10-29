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
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        await pg.evaluate("document.querySelector('.ask').scrollIntoView()"); await pg.wait_for_timeout(300)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/ai-1-ask.png')
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(3000)
        await pg.evaluate("window.scrollTo(0, 0)")
        # open the code tab
        await pg.click('.live-bar .lb:has-text("Code")') if await pg.query_selector('.live-bar .lb:has-text("Code")') else None
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/ai-2-code.png')
        await pg.evaluate("Noeti.select(['U1'], [])"); await pg.wait_for_timeout(800)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/ai-3-card.png')
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

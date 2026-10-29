import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    boards = sys.argv[1].split(',')
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1300, 'height': 850})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:200]}') if m.type == 'error' and 'TUNNEL' not in m.text and '404' not in m.text and 'fonts' not in m.text else None)
        await pg.goto(URL + '#explore', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        for bd in boards:
            for t in ['3d', 'sch', 'pcb', 'checks', 'bom', 'files']:
                await pg.evaluate(f"location.hash = '{bd}~~{t}'"); await pg.wait_for_timeout(1500 if t in ('3d', 'sch') else 700)
            n = await pg.evaluate("document.querySelectorAll('.sch-sheet').length")
            side = await pg.evaluate("(() => { const s = document.querySelector('.sch-sheets'); return s ? !s.hidden : null; })()")
            print(bd, 'sheets', n, 'side shown', side, flush=True)
        await pg.evaluate("location.hash = 'explore'"); await pg.wait_for_timeout(1000)
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; js = sys.argv[2]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + ('~pcb' if '~' in bd else '~~pcb'), wait_until='networkidle'); await pg.wait_for_timeout(2000)
        if len(sys.argv) > 3 and sys.argv[3] == 'live':
            await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(int(sys.argv[4]) if len(sys.argv) > 4 else 2500)
        r = await pg.evaluate(js)
        print(json.dumps(r, indent=1)[:12000])
        print('\n'.join(logs[:10]))
        await b.close()
asyncio.run(main())

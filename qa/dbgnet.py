import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd, net = sys.argv[1], sys.argv[2]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        logs = []
        pg.on('console', lambda m: logs.append(m.text) if m.text.startswith('DBG') else None)
        await pg.goto(URL + '#' + bd + ('~pcb' if '~' in bd else '~~pcb'), wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await pg.evaluate("(net) => { Noeti.simtab._dbgNet = net; const B = Noeti.app.B || Noeti.app.views.pcb.B; Noeti.simtab.wholeBoard(B); Noeti.simtab._dbgNet = null; }", net)
        print('\n'.join(logs) or 'never reached the candidate loop (driven?)')
        await b.close()
asyncio.run(main())

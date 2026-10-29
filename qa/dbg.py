import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle')
        await pg.wait_for_timeout(1200)
        await pg.evaluate("Noeti.startLive()")
        await pg.wait_for_timeout(300)
        print(await pg.evaluate("(()=>{const L=Noeti.live; L.running=false; const e=L.engine; const t0=e.t; e.setDt(2e-6); const r=e.advance(0.06, 90000); return {t0, t:e.t, r, ramp:e.opts.rampTime}})()"))
        print(await pg.evaluate(sys.argv[2]))
        await b.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; live = len(sys.argv) > 2 and sys.argv[2] == 'live'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        await pg.goto(URL + '#' + bd + '~3d', wait_until='networkidle')
        await pg.wait_for_timeout(2500)
        if live:
            await pg.click('#live-btn'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path=f'/tmp/claude-0/qa/{bd}-3dA.png')
        # zoom in on bottom area
        await pg.evaluate("""(()=>{const v=Noeti.app&&Noeti.app.views? Noeti.app.views.v3d : null; window._v=v; return !!v})()""")
        print(await pg.evaluate("Object.keys(KiLive).join(',')"))
        await b.close()
asyncio.run(main())

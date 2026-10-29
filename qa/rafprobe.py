import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd, mode = sys.argv[1], sys.argv[2]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3000)
        if mode == 'notick': await pg.evaluate("Noeti.app.views.v3d.liveTick = () => {}")
        if mode == 'nopaint': await pg.evaluate("Noeti.app.views.v3d.paintLiveSide = () => {}")
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(2000)
        r = await pg.evaluate("""new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 4000) requestAnimationFrame(f); else res({ raf: n, frame: Noeti.live.frameId }); }; requestAnimationFrame(f); })""")
        print(mode, json.dumps(r))
        await b.close()
asyncio.run(main())

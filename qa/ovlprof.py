import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3000)
        await pg.evaluate("""(() => { const v = Noeti.app.views.v3d; window.__T = { tick: 0, render: 0, nt: 0, nr: 0, paint: 0, np: 0 };
          const t0 = v.liveTick.bind(v); v.liveTick = (L, w) => { const a = performance.now(); t0(L, w); __T.tick += performance.now() - a; __T.nt++; };
          const r0 = v.render.bind(v); v.render = () => { const a = performance.now(); r0(); __T.render += performance.now() - a; __T.nr++; };
          const p0 = v.paintLiveSide.bind(v); v.paintLiveSide = (S, sd, L) => { const a = performance.now(); p0(S, sd, L); __T.paint += performance.now() - a; __T.np++; }; })()""")
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(6000)
        r = await pg.evaluate("({ T: __T, frame: Noeti.live.frameId, sps: Noeti.live.sps, speed: Noeti.live.speed })")
        print(json.dumps(r))
        await b.close()
asyncio.run(main())

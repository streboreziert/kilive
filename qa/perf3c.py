import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        tm = await pg.evaluate("""(() => { const v = Noeti.app.views.v3d, gl = v.gl, px = new Uint8Array(4); const R = v.real;
          const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const time = f => { sync(); const t0 = performance.now(); for (let i = 0; i < 3; i++) { f(); sync(); } return Math.round((performance.now() - t0) / 3); };
          const out = {};
          const keyNow = () => { const lt = v.realLight(); return lt.keyDir.map(x => x.toFixed(4)).join() + '|' + v.assembled + '|' + R.gen; };
          out.shadowThenMain = time(() => { const lt = v.realLight(); v.shadowPass(R, lt); R.shKey = keyNow(); v.render(); });
          out.mainOnly = time(() => { R.shKey = keyNow(); v.render(); });
          out.shadowOnly = time(() => { const lt = v.realLight(); v.shadowPass(R, lt); });
          out.shadowSyncMain = time(() => { const lt = v.realLight(); v.shadowPass(R, lt); sync(); R.shKey = keyNow(); v.render(); });
          return out; })()""")
        print(bd, tm)
        await b.close()
asyncio.run(main())

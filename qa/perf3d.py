import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        print('software:', await pg.evaluate("(() => { const v = Noeti.app.views.v3d; const s = [v.software, v.realOn, v.renderer]; v.setReal(true, true); return s; })()"))
        tm = await pg.evaluate("""(() => { const v = Noeti.app.views.v3d, gl = v.gl, px = new Uint8Array(4);
          const run = (f) => { const t0 = performance.now(); for (let i = 0; i < 3; i++) { f(); v.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } return Math.round((performance.now() - t0) / 3); };
          const R = v.real; const out = { w: v.canvas.width, h: v.canvas.height, tris: R.tris };
          out.orbit = run(() => { v.cam.yaw += 0.003; });
          out.zoom = run(() => { v.cam.dist *= 1.001; });
          const L = v.light; v.light = 'inspect'; out.noShadowZoom = run(() => { v.cam.dist *= 1.001; }); v.light = L;
          v.realOn = false; out.old = run(() => { v.cam.yaw += 0.003; }); v.realOn = true;
          return out; })()""")
        print(bd, tm)
        await b.close()
asyncio.run(main())

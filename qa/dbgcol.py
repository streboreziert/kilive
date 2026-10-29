import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1000, 'height': 700})
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        r = await pg.evaluate("""(() => { const v = Noeti.app.views.v3d, gl = v.gl; v.setReal(true, true);
          const B = v.B; const out = { mask: B.meta.mask, silk: B.meta.silk, finish: B.meta.finish };
          v.cam.yaw = 0; v.cam.pitch = Math.PI / 2 - 0.01; v.render();
          const px = new Uint8Array(4 * 25); const W = v.canvas.width, H = v.canvas.height;
          const grab = () => { const res = []; for (const [fx, fy] of [[0.3, 0.3], [0.5, 0.5], [0.7, 0.6], [0.4, 0.7], [0.6, 0.35]]) { gl.readPixels(Math.round(W * fx), Math.round(H * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); res.push([...px.slice(0, 3)].join(',')); } return res; };
          out.realTop = grab();
          v.realOn = false; v.render(); out.oldTop = grab();
          // texture colour at the same spots
          const T = v.texTop.canvas, g = T.getContext('2d');
          out.texSample = [[0.3, 0.3], [0.5, 0.5]].map(([fx, fy]) => [...g.getImageData(Math.round(T.width * fx), Math.round(T.height * (1 - fy)), 1, 1).data.slice(0, 3)].join(','));
          return out; })()""")
        print(json.dumps(r, indent=1))
        await b.close()
asyncio.run(main())

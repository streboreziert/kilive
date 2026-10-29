import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1000, 'height': 700})
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        r = await pg.evaluate("""(() => { const v = Noeti.app.views.v3d, K = Noeti.photoKit, gl = v.gl; const out = {};
          const P = K.parts(v.B, v.t, v.center[0], v.center[1]); out.h = P.atlas.height;
          const px = new Uint8Array(4); const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let t0 = performance.now(); const g = P.atlas.getContext('2d', { willReadFrequently: true }); const id = g.getImageData(0, 0, P.atlas.width, P.atlas.height); out.getImageData = Math.round(performance.now() - t0);
          const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
          sync(); t0 = performance.now(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, P.atlas); sync(); out.upCanvas = Math.round(performance.now() - t0);
          t0 = performance.now(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, P.atlas.width, P.atlas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, id.data); sync(); out.upBytes = Math.round(performance.now() - t0);
          t0 = performance.now(); gl.generateMipmap(gl.TEXTURE_2D); sync(); out.mip = Math.round(performance.now() - t0);
          return out; })()""")
        print(bd, json.dumps(r))
        await b.close()
asyncio.run(main())

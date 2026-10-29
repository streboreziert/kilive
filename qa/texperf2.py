import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1000, 'height': 700})
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        for mode in ['ktex', 'gid-then-ktex', 'ktex-nomip']:
            r = await pg.evaluate("""((mode) => { const v = Noeti.app.views.v3d, K = Noeti.photoKit, gl = v.gl; const out = { mode };
              const px = new Uint8Array(4); const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
              let t0 = performance.now(); const P = K.parts(v.B, v.t, v.center[0], v.center[1]); out.parts = Math.round(performance.now() - t0);
              if (mode === 'gid-then-ktex') { t0 = performance.now(); P.atlas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 4, 4); out.gid = Math.round(performance.now() - t0); }
              sync(); t0 = performance.now();
              if (mode === 'ktex-nomip') K.tex(gl, P.atlas, { mip: false }); else K.tex(gl, P.atlas);
              sync(); out.tex = Math.round(performance.now() - t0);
              return out; })""" + f"('{mode}')")
            print(bd, json.dumps(r))
        await b.close()
asyncio.run(main())

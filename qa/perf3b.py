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
          const lt = v.realLight();
          const out = {};
          out.full = time(() => v.shadowPass(R, lt));
          const as = v.assembled; v.assembled = false; out.wallsOnly = time(() => v.shadowPass(R, lt)); v.assembled = as;
          // mesh only, no faces
          out.meshOnly = time(() => { gl.bindFramebuffer(gl.FRAMEBUFFER, R.shFbo); gl.viewport(0, 0, R.SM, R.SM); gl.clear(gl.DEPTH_BUFFER_BIT); gl.useProgram(R.depth.p); gl.uniformMatrix4fv(R.depth.u.uLVP, false, R.LVP); gl.bindVertexArray(R.vao.vao); gl.drawElements(gl.TRIANGLES, R.vao.count, gl.UNSIGNED_INT, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null); });
          out.clearOnly = time(() => { gl.bindFramebuffer(gl.FRAMEBUFFER, R.shFbo); gl.viewport(0, 0, R.SM, R.SM); gl.clear(gl.DEPTH_BUFFER_BIT); gl.bindFramebuffer(gl.FRAMEBUFFER, null); });
          return out; })()""")
        print(bd, tm)
        await b.close()
asyncio.run(main())

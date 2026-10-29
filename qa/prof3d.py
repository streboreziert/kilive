import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1000, 'height': 700})
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        await pg.evaluate("Noeti.app.views.v3d.setReal(true, true)")
        await pg.wait_for_timeout(500)
        r = await pg.evaluate("""(() => { const v = Noeti.app.views.v3d, K = Noeti.photoKit, gl = v.gl; const out = {};
          let t0 = performance.now(); const P = K.parts(v.B, v.t, v.center[0], v.center[1]); out.parts = Math.round(performance.now() - t0);
          t0 = performance.now(); const vao = K.meshVAO(gl, P.M); out.vao = Math.round(performance.now() - t0);
          t0 = performance.now(); const tx = K.tex(gl, P.atlas); out.tex = Math.round(performance.now() - t0);
          out.verts = P.M.n; out.tris = P.M.I.length / 3; out.fps = v.B.fps.length; out.pop = P.pop.size;
          return out; })()""")
        print(bd, json.dumps(r))
        # CPU profile of parts()
        cdp = await pg.context.new_cdp_session(pg)
        await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', {'interval': 200}); await cdp.send('Profiler.start')
        await pg.evaluate("(() => { const v = Noeti.app.views.v3d; Noeti.photoKit.parts(v.B, v.t, v.center[0], v.center[1]); })()")
        prof = (await cdp.send('Profiler.stop'))['profile']
        nodes = {n['id']: n for n in prof['nodes']}
        self_t = {}
        dt = prof['timeDeltas']; samples = prof['samples']
        for s, d in zip(samples, dt):
            n = nodes[s]; k = n['callFrame']['functionName'] + ':' + str(n['callFrame']['lineNumber'] + 1) + ' ' + n['callFrame']['url'].split('/')[-1]
            self_t[k] = self_t.get(k, 0) + d
        for k, v in sorted(self_t.items(), key=lambda x: -x[1])[:25]: print(f'{v/1000:8.1f} ms  {k}')
        await b.close()
asyncio.run(main())

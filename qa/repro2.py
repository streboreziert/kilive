import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        await pg.goto(URL + '#anyon-e~motherboard~pcb~v1', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(3000)
        await pg.evaluate("Noeti.live.setSpeed(1, false, true)")
        await pg.wait_for_timeout(6000)
        info = await pg.evaluate("""(() => { const L = Noeti.live, B = L.B, F = B._pcbFlow; const f = B.fp('U21');
          const out = []; const S = F.segs;
          for (let s = 0; s < F.nseg; s++) { const x = (S[s*6] + S[s*6+2]) / 2, y = (S[s*6+1] + S[s*6+3]) / 2; if (Math.abs(x - f.x) > 4 || Math.abs(y - f.y) > 4) continue;
            const li = S[s*6+5]; let net = 0; out.push([s, li < 0 ? 'air' : B.cu[li], +S[s*6+4].toFixed(3), +(F.segI[s]*1000).toFixed(3)]); }
          return { t: L.engine.t, speed: L.speed, segs: out.slice(0, 40), u21: f.pads.map(pi => { const p = B.pads[pi]; return [p[1], B.nets[p[10]], +(L.padI('U21', p[1])*1000).toFixed(3)]; }) }; })()""")
        print(json.dumps(info))
        for (zoom, name) in [(60, 'z60'), (18, 'z18'), (8, 'z8')]:
            await pg.evaluate(f"(() => {{ const v = Noeti.app.views.pcb; const f = Noeti.live.B.fp('U21'); v.zoomTo(f.x, f.y, {zoom}); }})()")
            await pg.wait_for_timeout(2000)
            await pg.screenshot(path=f'/tmp/claude-0/qa/repro-{name}.png', clip={'x': 25, 'y': 125, 'width': 605, 'height': 830})
        await b.close()
asyncio.run(main())

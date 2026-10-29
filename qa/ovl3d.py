import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd, ref = sys.argv[1], sys.argv[2]
    dist = float(sys.argv[3]) if len(sys.argv) > 3 else 30
    real = len(sys.argv) > 4 and sys.argv[4] == 'real'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error', 'warning') and 'TUNNEL' not in m.text and 'fonts' not in m.text and 'GPU stall' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3000)
        if real: await pg.evaluate("Noeti.app.views.v3d.setReal(true, true)")
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.live.setSpeed(1, false, true)")
        await pg.evaluate(f"""(() => {{ const v = Noeti.app.views.v3d; const f = v.B.fp('{ref}'); v.anim = null; v.cam.target = [f.x - v.center[0], v.t / 2, f.y - v.center[1]]; v.cam.dist = {dist}; v.cam.yaw = -0.3; v.cam.pitch = 0.9; v.dirty = true; }})()""")
        for i in range(40):
            await pg.wait_for_timeout(1000)
            ok = await pg.evaluate("(() => { const v = Noeti.app.views.v3d; return !!(v.liveR && v.liveTop.R && Date.now() - (window.__t0 || (window.__t0 = Date.now())) > 4000); })()")
            if ok: break
        info = await pg.evaluate("(() => { const v = Noeti.app.views.v3d; return { R: v.liveR, cv: v.liveTop && [v.liveTop.cv.width, v.liveTop.cv.height] }; })()")
        print(json.dumps(info))
        await pg.screenshot(path=f'/tmp/claude-0/qa/ovl-{bd.split("~")[0]}.png', clip={'x': 25, 'y': 125, 'width': 605, 'height': 790}, timeout=120000)
        print('\n'.join(logs[:12]))
        await b.close()
asyncio.run(main())

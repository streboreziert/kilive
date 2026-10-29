import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: real3d.py board [light] [yawdeg] [pitchdeg] [zoom]
async def main():
    bd = sys.argv[1]
    light = sys.argv[2] if len(sys.argv) > 2 else 'studio'
    yaw = float(sys.argv[3]) if len(sys.argv) > 3 else None
    pitch = float(sys.argv[4]) if len(sys.argv) > 4 else None
    zoom = float(sys.argv[5]) if len(sys.argv) > 5 else 1
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error', 'warning') and 'TUNNEL' not in m.text and 'fonts' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        print('software:', await pg.evaluate("(() => { const v = Noeti.app.views.v3d; const s = [v.software, v.realOn, v.renderer]; v.setReal(true, true); return s; })()"))
        info = await pg.evaluate("""(() => { const v = Noeti.app.views.v3d; const R = v.real; return R ? { real: !!R.vao, shadows: R.shadows, ms: R.ms && Math.round(R.ms), tris: R.tris, parts: R.partsCount } : { real: false }; })()""")
        print(bd, json.dumps(info))
        await pg.evaluate(f"""(() => {{ const v = Noeti.app.views.v3d; v.setLight('{light}');
          {'v.cam.yaw = ' + str(yaw) + ' * Math.PI / 180;' if yaw is not None else ''}
          {'v.cam.pitch = ' + str(pitch) + ' * Math.PI / 180;' if pitch is not None else ''}
          v.cam.dist /= {zoom}; v.dirty = true; }})()""")
        sel = sys.argv[6] if len(sys.argv) > 6 else ''
        if sel: await pg.evaluate(f"Noeti.app.views.v3d.setHighlight(['{sel}'], [])")
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=f'/tmp/claude-0/qa/real-{bd}-{light}.png')
        t = await pg.evaluate("""(() => { const v = Noeti.app.views.v3d; const t0 = performance.now(); for (let i = 0; i < 3; i++) { v.cam.yaw += 0.01; v.render(); } v.gl.finish(); return Math.round((performance.now() - t0) / 3); })()""")
        print('frame ms (swiftshader):', t)
        print('\n'.join(logs[:12]))
        await b.close()
asyncio.run(main())

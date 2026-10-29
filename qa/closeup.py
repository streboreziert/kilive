import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd, rx, light = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'studio'
    dist = float(sys.argv[4]) if len(sys.argv) > 4 else 40
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error', 'warning') and 'TUNNEL' not in m.text and 'fonts' not in m.text and 'GPU stall' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3500)
        r = await pg.evaluate(f"""(() => {{ const v = Noeti.app.views.v3d; v.setReal(true, true); v.setLight('{light}');
          const f = v.B.fps.find(f => new RegExp({json.dumps(rx)}, 'i').test((f.v || '') + ' ' + f.r + ' ' + (f.fp || '')));
          if (!f) return null;
          v.anim = null; v.cam.target = [f.x - v.center[0], v.t / 2, f.y - v.center[1]]; v.cam.dist = {dist}; v.cam.yaw = -0.6; v.cam.pitch = 0.55; v.dirty = true;
          return [f.r, f.v, f.fp]; }})()""")
        print('target', r)
        await pg.wait_for_timeout(6000)
        await pg.screenshot(path=f'/tmp/claude-0/qa/close-{bd}.png', clip={'x': 25, 'y': 240, 'width': 985, 'height': 610})
        print('\n'.join(logs[:12]))
        await b.close()
asyncio.run(main())

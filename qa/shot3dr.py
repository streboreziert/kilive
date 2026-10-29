import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: shot3dr.py board tag [light] [yaw pitch distK]
async def main():
    bd, tag = sys.argv[1], sys.argv[2]; light = sys.argv[3] if len(sys.argv) > 3 else 'studio'
    cam = [float(x) for x in sys.argv[4:7]] if len(sys.argv) > 6 else None
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        await pg.goto(URL + '#' + bd + '~~3d', wait_until='networkidle'); await pg.wait_for_timeout(4000)
        await pg.evaluate("""([light, cam]) => { const v = Noeti.app.views.v3d; v.setReal(true, true); v.setLight(light); document.querySelector('#pane-3d').dataset.light = light; if (cam) { v.cam.yaw = cam[0]; v.cam.pitch = cam[1]; v.cam.dist *= cam[2]; } v.dirty = true; }""", [light, cam])
        await pg.wait_for_timeout(6000)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{tag}.png')
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

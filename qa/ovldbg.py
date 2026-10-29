import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}'))
        await pg.goto(URL + '#glasgow~~3d', wait_until='networkidle'); await pg.wait_for_timeout(3000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(2500)
        r = await pg.evaluate("""(() => { const v = Noeti.app.views.v3d; let w = null, err = null; const views = Noeti.live.ctx.getViews(); try { w = { vis: Noeti.live.ctx.visible(), frame: Noeti.live.frameId, acc0: v.liveAcc, R0: v.liveR }; } catch (e) { err = String(e.stack || e); }
          w = Object.assign({}, w, { acc: v.liveAcc, every: v.liveEvery, liveN: v.liveN });
          return { w, err, R: v.liveR, live: !!v.live, top: !!v.liveTop, tab: Noeti.live.ctx.getViews().tab }; })()""")
        print(json.dumps(r, indent=1))
        print('\n'.join(logs[-15:]))
        await b.close()
asyncio.run(main())

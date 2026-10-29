import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + '~~sch', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        await pg.click('#pane-sch .probe-tool-btn'); await pg.wait_for_timeout(300)
        pos = await pg.evaluate("""(() => { const v = Noeti.app.views.sch, dl = v.dl[v.page], r = v.canvas.getBoundingClientRect(); const W = v.stage.clientWidth, H = v.stage.clientHeight;
          for (const p of dl.pins) { const n = v.B.padNet(p.ref, p.num); if (!n) continue; const s = v.toScreen(p.x, p.y); if (s[0] > 60 && s[1] > 80 && s[0] < W - 60 && s[1] < H - 60) return [r.left + s[0], r.top + s[1], p.ref + '.' + p.num]; } return null; })()""")
        print('pin at', pos)
        print('hit:', await pg.evaluate("([x, y]) => { const v = Noeti.app.views.sch, r = v.canvas.getBoundingClientRect(); const h = v.hit(x - r.left, y - r.top); return [h && h.type, v.probeMode, document.elementFromPoint(x, y).className]; }", pos))
        await pg.mouse.click(pos[0], pos[1]); await pg.wait_for_timeout(3500)
        print('after:', await pg.evaluate("[Noeti.live.on, (Noeti.live.probes || []).map(p => p.ref + '.' + p.pin), Noeti.app.probeTool]"))
        await pg.screenshot(path='/tmp/claude-0/qa/ui/pt-5-sch.png')
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

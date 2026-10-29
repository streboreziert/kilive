import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.add_init_script("""window.__lt = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });""")
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        await pg.evaluate("""(() => { window.__lt = []; window.__tm = {}; const wrap = (o, k, tag) => { const f = o[k]; if (!f) return; o[k] = function () { const t = performance.now(); const r = f.apply(this, arguments); window.__tm[tag] = (window.__tm[tag] || 0) + Math.round(performance.now() - t); return r; }; };
          wrap(KiLive, 'bakeBoardTexture', 'bake'); if (Noeti.photoKit) { wrap(Noeti.photoKit, 'parts', 'parts'); wrap(Noeti.photoKit, 'meshVAO', 'vao'); wrap(Noeti.photoKit, 'tex', 'atlas'); } wrap(KiLive, 'drillPoly', 'drill'); })()""")
        t0 = await pg.evaluate("performance.now()")
        await pg.evaluate("location.hash = location.hash.replace('~pcb', '~3d')")
        await pg.wait_for_timeout(6000)
        r = await pg.evaluate("(() => { const v = Noeti.app.views.v3d; const R = v.real; return { realOn: v.realOn, ms: R && Math.round(R.ms), tris: R && R.tris, sw: v.software, lt: window.__lt, tm: window.__tm }; })()")
        print(bd, r)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui/{bd}-3d.png')
        await b.close()
asyncio.run(main())

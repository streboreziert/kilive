import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1500)
        src = await pg.evaluate("(()=>{const L=Noeti.live; const p=L.procs[0]; const a=L.analysisFor(p); const src=Noeti.analysis.program(a); L.fwm.runScript(p, src); L.realTime(); return src;})()")
        print(src[:3000])
        await pg.wait_for_timeout(6000)
        r = await pg.evaluate("(()=>{const L=Noeti.live; const run=[...L.fwm.procs.values()][0]; return {t: L.engine.t, i2c: run.hw.i2c.map(b => ({n: b.wire.log.length, last: b.wire.log.slice(-3).map(x => [x.t.toFixed(3), x.addr, x.write, x.read])})), con: run.console.log.slice(-5)}; })()")
        print(json.dumps(r, indent=1)[:2500])
        await b.close()
asyncio.run(main())

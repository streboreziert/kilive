import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#otterpill~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1000)
        await pg.evaluate("(()=>{const L=Noeti.live; const p=L.procs[0]; window.__src=Noeti.analysis.program(L.analysisFor(p)); L.fwm.runScript(p, window.__src); L.realTime();})()")
        await pg.wait_for_timeout(2500)
        r = await pg.evaluate("""(()=>{ const L=Noeti.live, e=L.engine; const pr=[...L.fwm.procs.values()][0]; const v = n => { const nd = e.nodeOf(n); return nd ? +e.V(nd).toFixed(3) : null; };
          return {src: window.__src, drive: [...pr.drive].join(' '), vbus: v('VBUS'), pa0: v('PA0'), con: pr.console.text.slice(-300), adc: pr.info.chip.adc} })()""")
        print(r['src']); del r['src']; print(json.dumps(r, indent=1))
        await b.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1500)
        await pg.evaluate("(()=>{const L=Noeti.live; const p=L.procs[0]; const a=L.analysisFor(p); window.__a=a; const src=Noeti.analysis.program(a); window.__src=src; L.fwm.runScript(p, src); L.realTime();})()")
        await pg.wait_for_timeout(3000)
        st = await pg.evaluate("""(()=>{const L=Noeti.live; const p=[...L.fwm.procs.values()][0]; const hw=p.hw; return {spi: hw.spi.map(b=>({sck:b.sck,mosi:b.mosi,devices:b.devices.map(d=>({ref:d.ref,cs:d.csIo,dc:d.dcIo})),ents:b.spi.ents.map(e=>({cs:e.cs,dc:e.dc,act:e.act})),lv:[...b.spi.lv],stats:b.spi.stats})), sel:hw.sel, src: window.__src.split('\\n').filter(l=>/tft|SPI|SW\\d|button|digitalRead/.test(l)).slice(0,40)}})()""")
        print(json.dumps(st, indent=1))
        print('\n'.join(logs[:20]))
        await b.close()
asyncio.run(main())

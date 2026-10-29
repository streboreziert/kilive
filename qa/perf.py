import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; tab = sys.argv[2] if len(sys.argv) > 2 else 'pcb'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~' + tab, wait_until='networkidle')
        await pg.wait_for_timeout(1200)
        await pg.evaluate("Noeti.startLive()")
        await pg.wait_for_timeout(1500)
        r = await pg.evaluate("""(async()=>{const L=Noeti.live; const e=L.engine; const adv=e.advance.bind(e); let tAdv=0, n=0; e.advance=(a,b)=>{const t0=performance.now(); const r=adv(a,b); tAdv+=performance.now()-t0; n++; return r;};
          const t0=performance.now(); const s0=e.t; await new Promise(r=>setTimeout(r,3000)); const wall=performance.now()-t0; e.advance=adv;
          return {wall, tAdv, frames:n, simT:e.t-s0, speed:L.speed, sps:L.sps, ratio:L.ratio, dt:e.dt, info:e.info(), stats:e.stats}})()""")
        print(json.dumps(r, indent=1))
        await b.close()
asyncio.run(main())

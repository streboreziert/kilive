import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def wait_loaded(pg):
    for i in range(80):
        if await pg.evaluate("!!(document.querySelector('#loading') && document.querySelector('#loading').hidden)"): return
        await pg.wait_for_timeout(250)
FPS = """(()=>new Promise(r=>{let n=0;const t0=performance.now();function f(){n++; if(performance.now()-t0<2000) requestAnimationFrame(f); else r(n/2);} requestAnimationFrame(f);}))()"""
async def main():
    boards = sys.argv[1].split(',')
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'TUNNEL' not in m.text and 'fonts' not in m.text else None)
        for bd in boards:
            await pg.goto(URL + '#' + bd + '~pcb', wait_until='networkidle')
            await wait_loaded(pg); await pg.wait_for_timeout(500)
            await pg.click('#live-btn'); await pg.wait_for_timeout(3000)
            res = {}
            for tab in ['pcb','sch','3d']:
                await pg.evaluate(f"location.hash = location.hash.replace(/~[a-z0-9]+$/,'~{tab}')"); await pg.wait_for_timeout(1500)
                res[tab+'_fps'] = await pg.evaluate(FPS)
                await pg.screenshot(path=f'/tmp/claude-0/qa/{bd}-{tab}.png')
            st = await pg.evaluate("""(()=>{const L=Noeti.live; const nv=L.netV; let sim=0,nan=0,zero=0; for(let i=1;i<nv.length;i++){ if(nv[i]!==nv[i]) nan++; else {sim++; if(Math.abs(nv[i])<0.01) zero++;}}
              return {ratio:L.ratio, sps:L.sps, speed:L.speed, t:L.engine.t, nets:nv.length-1, sim, nan, zero, info:L.info, notes:L.engine.notes.slice(0,8),
              rails:[...document.querySelectorAll('.ld-rail')].map(x=>x.innerText.replace(/\\n/g,' ')), procs:(L.procs||[]).map(p=>p.ref+':'+p.family)}})()""")
            res.update(st)
            print(bd, json.dumps(res))
            print('\n'.join(logs)); logs.clear()
        await b.close()
asyncio.run(main())

import asyncio, sys, json, time
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
BOARDS = sys.argv[1:] or ['rp2040-guide~rp2040-guide']
async def wait_loaded(pg):
    for i in range(80):
        if await pg.evaluate("!!(document.querySelector('#loading') && document.querySelector('#loading').hidden)"): return
        await pg.wait_for_timeout(250)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error','warning') else None)
        await pg.goto(URL + '#explore', wait_until='networkidle')
        for bd in BOARDS:
            await pg.evaluate(f"location.hash='{bd}~pcb'")
            await wait_loaded(pg)
            await pg.wait_for_timeout(500)
            t0 = time.time()
            await pg.click('#live-btn')
            await pg.wait_for_timeout(2500)
            st = await pg.evaluate("""(()=>{const L=Noeti.live; if(!L.on) return {on:false};
              let nv=0, tot=0; for(let i=1;i<L.B.nets.length;i++){tot++; if(L.netV[i]===L.netV[i]) nv++;}
              const F=L.B._pcbFlow; let moving=0; if(F) for(let s=0;s<F.nseg;s++) if(Math.abs(F.segI[s])>2e-7) moving++;
              return {on:true, t:L.engine.t, speed:L.speed, sps:Math.round(L.sps||0), ratio:+(L.ratio||0).toFixed(2), info:L.info, nets:nv+'/'+tot, moving, segs:F?F.nseg:0, running:L.running,
                rails:[...document.querySelectorAll('.ld-rail')].slice(0,8).map(x=>x.innerText.replace(/\\n/g,' ')).join(' | '), probes:L.probes, leds:(L.leds||[]).map(d=>d.ref+':'+d.lvl.toFixed(2)).join(','), notes:L.engine.notes.slice(0,4)}})()""")
            print(bd, json.dumps(st))
            await pg.screenshot(path=f'/tmp/claude-0/shots/live-pcb-{bd.split("~")[1]}.png')
            if len(BOARDS) == 1:
                await pg.click('#tab-sch'); await pg.wait_for_timeout(1500)
                await pg.screenshot(path=f'/tmp/claude-0/shots/live-sch-{bd.split("~")[1]}.png')
                await pg.click('#tab-3d'); await pg.wait_for_timeout(3000)
                await pg.screenshot(path=f'/tmp/claude-0/shots/live-3d-{bd.split("~")[1]}.png')
                await pg.click('#tab-pcb'); await pg.wait_for_timeout(500)
            await pg.click('#live-btn')
            await pg.wait_for_timeout(300)
            off = await pg.evaluate("Noeti.live.on")
            print('   stopped:', not off, f'{time.time()-t0:.1f}s')
        print('\n'.join(logs[-30:]))
        await b.close()
asyncio.run(main())

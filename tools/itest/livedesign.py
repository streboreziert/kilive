import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
TPL = sys.argv[1] if len(sys.argv) > 1 else 'blinker'
async def wait_loaded(pg):
    for i in range(80):
        if await pg.evaluate("!!(document.querySelector('#loading') && document.querySelector('#loading').hidden)"): return
        await pg.wait_for_timeout(250)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1250})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error',) else None)
        await pg.goto(URL + '#explore', wait_until='networkidle')
        await pg.evaluate(f"Noeti.create.newDesignDraft('{TPL}')")
        await pg.wait_for_timeout(1500); await wait_loaded(pg)
        await pg.click('#tab-pcb'); await pg.wait_for_timeout(800)
        await pg.click('#live-btn'); await pg.wait_for_timeout(4000)
        st = await pg.evaluate("""(()=>{const L=Noeti.live; if(!L.on) return {on:false};
          const h=L.hist; const mm=a=>a.length?[Math.min(...a.filter(x=>x===x)).toFixed(2), Math.max(...a.filter(x=>x===x)).toFixed(2)]:null;
          return {t:L.engine.t, speed:L.speed, fmax:L.fmax, dt:L.engine.dt, probes:L.probes, ranges:L.probes.map((p,j)=>p+':'+mm(h.v[j])), leds:(L.leds||[]).map(d=>d.ref+':'+d.lvl.toFixed(2)), rails:[...document.querySelectorAll('.ld-rail')].map(x=>x.innerText.replace(/\\n/g,' ')).join(' | '), sps:Math.round(L.sps), notes:L.engine.notes, pad:[...L.pad.entries()].slice(0,12).map(([k,v])=>k.replace('\\u0000','.')+'='+(v*1e3).toFixed(3)+'mA')}})()""")
        print(TPL, json.dumps(st, indent=0))
        await pg.screenshot(path=f'/tmp/claude-0/shots/ld-pcb-{TPL}.png')
        await pg.click('#tab-sch'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path=f'/tmp/claude-0/shots/ld-sch-{TPL}.png')
        await pg.click('#tab-3d'); await pg.wait_for_timeout(3500)
        await pg.screenshot(path=f'/tmp/claude-0/shots/ld-3d-{TPL}.png')
        await pg.click('#tab-pcb'); await pg.wait_for_timeout(500)
        # faults: select R2 via finder-free API
        await pg.evaluate("Noeti.select(['R1'], [])")
        await pg.wait_for_timeout(300)
        await pg.click('.live-dock .ld-btn:has-text(\"Inject fault\")')
        await pg.wait_for_timeout(300)
        items = await pg.evaluate("[...document.querySelectorAll('.menu-pop .menu-item')].map(x=>x.innerText)")
        print('fault items', items[:8])
        if items:
            await pg.click('.menu-pop .menu-item >> nth=0'); await pg.wait_for_timeout(2000)
            fs = await pg.evaluate("({fault: Noeti.live.fault && Noeti.live.fault.text, banner: (document.querySelector('.ld-fault')||{}).innerText, t: Noeti.live.engine.t, rails:[...document.querySelectorAll('.ld-rail')].map(x=>x.innerText.replace(/\\n/g,' ')).join(' | ')})")
            print('after fault', fs)
            await pg.screenshot(path=f'/tmp/claude-0/shots/ld-fault-{TPL}.png')
            await pg.click('.ld-fault .btn'); await pg.wait_for_timeout(500)
            print('cleared', await pg.evaluate("Noeti.live.fault"))
        # controls menu
        await pg.click('.live-dock .ld-btn:has-text(\"Controls\")'); await pg.wait_for_timeout(300)
        print('controls', await pg.evaluate("(document.querySelector('.menu-pop')||{}).innerText"))
        await pg.keyboard.press('Escape')
        # speed change + power up
        await pg.select_option('.ld-sel', '0.001'); await pg.wait_for_timeout(300)
        await pg.click('.live-dock .ld-btn:has-text(\"Power up\")'); await pg.wait_for_timeout(1500)
        print('after power up', await pg.evaluate("({t:Noeti.live.engine.t, speed:Noeti.live.speed})"))
        # hover tooltip on pcb
        print('\n'.join(logs[-30:]))
        await b.close()
asyncio.run(main())

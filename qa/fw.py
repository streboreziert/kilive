import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; ref = sys.argv[2] if len(sys.argv) > 2 else None
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'TUNNEL' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~pcb', wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        await pg.evaluate("document.querySelector('.vc-tab[data-tab=\"pcb\"]') && document.querySelector('.vc-tab[data-tab=\"pcb\"]').click()")
        await pg.click('#live-btn'); await pg.wait_for_timeout(2000)
        if ref: await pg.evaluate(f"Noeti.live.openCode('{ref}')")
        else: await pg.click('.lb-tab[data-tab="code"]')
        await pg.wait_for_timeout(500)
        print(await pg.evaluate("[...document.querySelectorAll('.cd-sub span')].map(x=>x.innerText).join(' | ')"))
        await pg.click('.cd-tab:has-text("Firmware file")'); await pg.wait_for_timeout(2500)
        print(await pg.evaluate("(document.querySelector('.cd-fw .cd-hint')||{}).innerText"))
        await pg.click('.cd-fw .lb-run'); await pg.wait_for_timeout(6000)
        st = await pg.evaluate("""(()=>{const L=Noeti.live; const p=[...L.fwm.procs.values()][0]; return {state:p&&p.state, err:p&&p.error, console:p&&p.console.text.slice(-500), pins:p&&p.pinsSummary().slice(0,10).map(x=>x.pin+' '+x.mode).join(', '), ratio:L.ratio, speed:L.speed, t:L.engine.t, leds:(L.leds||[]).filter(d=>d.lvl>0.1).map(d=>d.ref), status:document.querySelector('.cd-status').innerText, instr:p&&p.m&&p.m.stats}})()""")
        print(json.dumps(st, indent=1))
        await pg.screenshot(path=f'/tmp/claude-0/qa/fw-{bd}.png')
        bw = await pg.evaluate("(()=>{const b=document.querySelector('.live-bar'); return [b.scrollWidth, b.clientWidth]})()")
        print('bar', bw)
        print('\n'.join(logs[:20]))
        await b.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def wait_loaded(pg):
    for i in range(80):
        if await pg.evaluate("!!(document.querySelector('#loading') && document.querySelector('#loading').hidden)"): return
        await pg.wait_for_timeout(250)
async def main():
    bd, mode = sys.argv[1], sys.argv[2]   # mode: example | starter
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1200})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'TUNNEL' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~pcb', wait_until='networkidle')
        await wait_loaded(pg); await pg.wait_for_timeout(500)
        await pg.click('#live-btn'); await pg.wait_for_timeout(800)
        await pg.click('#ld-code'); await pg.wait_for_timeout(400)
        info = await pg.evaluate("(Noeti.live.procs||[]).map(p=>p.ref+':'+p.family+':'+p.io.length)")
        print('procs', info)
        if mode == 'example':
            await pg.click('.cd-tab:has-text("Firmware file")'); await pg.wait_for_timeout(300)
            await pg.click('.cd-fw .ld-run'); await pg.wait_for_timeout(4000)
        else:
            print(await pg.evaluate("document.querySelector('.cd-ed').value.split('\\n').slice(0,14).join('\\n')"))
            await pg.click('.cd-prog .ld-run'); await pg.wait_for_timeout(4000)
        st = await pg.evaluate("""(()=>{const L=Noeti.live; const p=[...L.fwm.procs.values()][0]; return {state:p&&p.state, err:p&&p.error, console:p&&p.console.text.slice(-300), pins:p&&p.pinsSummary().slice(0,8), speed:L.speed, t:L.engine.t, ratio:L.ratio, leds:(L.leds||[]).map(d=>d.ref+':'+d.lvl.toFixed(2)), status:document.querySelector('.cd-status').innerText, instr:p&&p.instr, rails:[...document.querySelectorAll('.ld-rail')].map(x=>x.innerText.replace(/\\n/g,' ')).join(' | ')}})()""")
        print(json.dumps(st, indent=1))
        await pg.screenshot(path=f'/tmp/claude-0/shots/code-{bd.split("~")[0]}-{mode}.png')
        print('\n'.join(logs[-10:]))
        await b.close()
asyncio.run(main())

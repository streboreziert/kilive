import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'TUNNEL' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~pcb', wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        await pg.click('#live-btn'); await pg.wait_for_timeout(2500)
        # probe the first processor IO pad via API (like a click)
        r = await pg.evaluate("""(()=>{const L=Noeti.live, B=L.B; const p=L.procs[0]; const io=p.io.find(x=>/LED|GPIO7|D2/.test(x.net))||p.io[0]; const f=B.fp(p.ref); const pi=f.pads.find(i=>String(B.pads[i][1])===io.number); L.probePad(pi); const r2=L.rails()[0]; if (r2) L.addProbe({name:r2.name}); return {proc:p.ref, io:io.name, probes:L.probes.map(q=>q.label)} })()""")
        print(r)
        await pg.wait_for_timeout(800)
        # open code tab and run the auto program
        await pg.click('.lb-tab[data-tab="code"]'); await pg.wait_for_timeout(600)
        src = await pg.evaluate("document.querySelector('.cd-ed').value")
        print(src[:1800])
        await pg.click('.cd-prog .lb-run'); await pg.wait_for_timeout(5000)
        st = await pg.evaluate("""(()=>{const L=Noeti.live; const p=[...L.fwm.procs.values()][0]; return {state:p.state, err:p.error, speed:L.speed, console:p.console.text.slice(-900), pins:p.pinsSummary().slice(0,8), devs:(p.hw&&p.hw.devs||[]).map(d=>d.ref+':'+(d.status?d.status():'')), probes:L.probes.map(q=>q.label+' '+JSON.stringify(q.stats&&{v:q.stats.v&&q.stats.v.toFixed(2),f:q.stats.freq,logic:q.stats.logic}))}})()""")
        print(json.dumps(st, indent=1))
        await pg.screenshot(path=f'/tmp/claude-0/qa/l3-{bd}-code.png')
        await pg.click('.ls-tab:has-text("Probes")'); await pg.wait_for_timeout(1200)
        await pg.screenshot(path=f'/tmp/claude-0/qa/l3-{bd}-probes.png')
        await pg.click('.ls-tab:has-text("Board")'); await pg.wait_for_timeout(800)
        await pg.screenshot(path=f'/tmp/claude-0/qa/l3-{bd}-board.png')
        print('\n'.join(logs[:20]))
        await b.close()
asyncio.run(main())

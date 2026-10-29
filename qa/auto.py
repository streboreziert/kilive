import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; ref = sys.argv[2] if len(sys.argv) > 2 else ''; tab = sys.argv[3] if len(sys.argv) > 3 else 'pcb'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'TUNNEL' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~' + tab, wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1500)
        await pg.evaluate(f"(()=>{{const L=Noeti.live; const p=L.procs.find(q=>q.ref==='{ref}')||L.procs[0]; const a=L.analysisFor(p); const src=Noeti.analysis.program(a); window.__src=src; L.fwm.runScript(p, src); L.realTime(); L.ui.open('code', p.ref);}})()")
        await pg.wait_for_timeout(6000)
        st = await pg.evaluate("""(()=>{const L=Noeti.live; const p=[...L.fwm.procs.values()][0]; return {src: window.__src.slice(0,2500), state:p.state, err:p.error, console:p.console.text.slice(-700), pix:[...(L.pix||new Map())].slice(0,6), screens:[...L.fwm.screens.values()].flat().map(s=>s.ref+' '+s.name+' v'+s.dev.version), devs:(p.hw&&p.hw.devs||[]).map(d=>d.ref+':'+(d.status?d.status():''))}})()""")
        print(json.dumps(st, indent=1))
        await pg.screenshot(path=f'/tmp/claude-0/qa/auto-{bd}.png')
        print('\n'.join(logs[:20]))
        await b.close()
asyncio.run(main())

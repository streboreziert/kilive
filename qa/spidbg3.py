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
        await pg.evaluate("""(()=>{const L=Noeti.live; const p=L.procs[0]; const a=L.analysisFor(p); const src=Noeti.analysis.program(a); L.fwm.runScript(p, src);
          const pr=[...L.fwm.procs.values()][0]; window.__cmds=[]; const hook=()=>{ for (const d of pr.hw.devs) if (!d.__h) { d.__h=1; const c=d.command.bind(d); d.command=x=>{ window.__cmds.push(x.toString(16)+'@'+(L.engine.t*1000).toFixed(1)); return c(x);}; const r=d.reset.bind(d); d.reset=()=>{ window.__cmds.push('RESET@'+(L.engine?L.engine.t*1000:0).toFixed(1)+' '+new Error().stack.split('\\n').slice(2,5).join('|')); return r(); }; } }; hook(); window.__hook=setInterval(hook,5); L.realTime();})()""")
        await pg.wait_for_timeout(3000)
        st = await pg.evaluate("({cmds: window.__cmds.slice(0,60), n: window.__cmds.length, st:[...Noeti.live.fwm.procs.values()][0].hw.devs[0].status()})")
        print(json.dumps(st, indent=1))
        print('\n'.join(logs[:20]))
        await b.close()
asyncio.run(main())

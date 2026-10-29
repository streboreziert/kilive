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
        await pg.evaluate("""(()=>{const L=Noeti.live; const p=L.procs[0]; const a=L.analysisFor(p); const src=Noeti.analysis.program(a); window.__src=src; L.fwm.runScript(p, src);})()""")
        await pg.wait_for_timeout(500)
        await pg.evaluate("""(()=>{const L=Noeti.live; const pr=[...L.fwm.procs.values()][0]; const P=pr.hw.devs[0].constructor.prototype; window.__cmds=[]; let id=0;
          const c=P.command; P.command=function(x){ if(!this.__id) this.__id=++id; window.__cmds.push(this.__id+':'+x.toString(16)+'@'+(L.engine.t*1000).toFixed(1)); return c.call(this,x);};
          const r=P.reset; P.reset=function(){ if(!this.__id) this.__id=++id; window.__cmds.push(this.__id+':RESET@'+(L.engine?L.engine.t*1000:0).toFixed(1)); return r.call(this); };
          const st=pr.start; pr.start=function(t){ window.__cmds.push('START@'+(t*1000).toFixed(1)+' '+new Error().stack.split('\\n').slice(2,6).join(' | ')); return st.call(this,t); };
          L.fwm.runScript(L.procs[0], window.__src); L.realTime();})()""")
        await pg.wait_for_timeout(2500)
        st = await pg.evaluate("({cmds: window.__cmds.filter(x=>!/:2[abc]@/.test(x)).slice(0,60), n: window.__cmds.length, st:[...Noeti.live.fwm.procs.values()][0].hw.devs[0].status(), id:[...Noeti.live.fwm.procs.values()][0].hw.devs[0].__id})")
        print(json.dumps(st, indent=1))
        print('\n'.join(logs[:20]))
        await b.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    only = sys.argv[1].split(',') if len(sys.argv) > 1 and sys.argv[1] else None
    out = open('/tmp/claude-0/qa/audit.txt', 'w')
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        for r in idx:
            if only and r['id'] not in only: continue
            pg = await b.new_page(viewport={'width': 1440, 'height': 900})
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
            try:
                await pg.goto(URL + '#' + r['id'] + '~pcb', wait_until='networkidle', timeout=60000)
                await pg.wait_for_timeout(1200)
                await pg.evaluate("Noeti.startLive()")
                await pg.wait_for_timeout(300)
                await pg.evaluate("(()=>{const L=Noeti.live; L.running=false; L.userSpeed=true; const e=L.engine; e.setDt(2e-6); e.advance(0.06, 90000); L.setSpeed(1e-5); L.running=true; return e.t})()")
                await pg.wait_for_timeout(700)
                st = await pg.evaluate("""(()=>{const L=Noeti.live; if(!L.on) return {off:true}; const rails=L.rails(); return {t:L.engine.t, speed:L.speed, nets:L.netV.length-1, flt:[...L.flt].filter(x=>x).length,
                    bad: rails.filter(x=>x.ok===false).map(x=>x.name.split('/').pop()+'='+(x.v||0).toFixed(2)+' (nom '+x.nom+') '+x.reason),
                    ok: rails.filter(x=>x.ok).map(x=>x.name.split('/').pop()+'='+(x.v||0).toFixed(2)).join(' '),
                    other: rails.filter(x=>x.ok==null).map(x=>x.name.split('/').pop()+'='+(x.v||0).toFixed(2)).join(' '), notes:L.engine.notes.slice(0,5)}})()""")
            except Exception as e:
                st = {'exc': str(e)[:200]}
            line = r['id'] + ' ' + json.dumps(st) + (' ERR ' + ' | '.join(errs[:3]) if errs else '')
            print(line[:3000]); out.write(line + '\n'); out.flush()
            await pg.close()
        await b.close()
asyncio.run(main())

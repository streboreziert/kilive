import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; tab = sys.argv[2] if len(sys.argv) > 2 else 'pcb'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error','warning') and 'fonts' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~' + tab, wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        await pg.click('#live-btn'); await pg.wait_for_timeout(3500)
        await pg.screenshot(path=f'/tmp/claude-0/qa/l2-{bd}-{tab}.png')
        st = await pg.evaluate("""(()=>{const L=Noeti.live; return {on:L.on, speed:L.speed, t:L.engine&&L.engine.t, probes:L.probes.length, flt:[...L.flt].filter(x=>x).length, rails:L.rails().map(r=>r.name+' '+(r.v||0).toFixed(2)+(r.ok===false?' ! '+r.reason:''))}})()""")
        print(json.dumps(st, indent=1))
        print('\n'.join(logs[:20]))
        await b.close()
asyncio.run(main())

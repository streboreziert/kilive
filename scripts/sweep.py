import asyncio, json, os
from playwright.async_api import async_playwright
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1280, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(f'PAGEERROR {cur}: {e}'))
        pg.on('console', lambda m: errs.append(f'{m.type} {cur}: {m.text}') if m.type in ('error','warning') and 'ERR_TUNNEL' not in m.text and '404' not in m.text else None)
        cur = 'home'
        await pg.goto('http://localhost:8765/preview-mock.html', wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        for r in idx:
            for bd in r['boards']:
                for v in bd['versions']:
                    for tab in ['3d','pcb','sch','bom','checks','sim','files']:
                        cur = f"{r['id']}/{bd['id']}/{v['id']}/{tab}"
                        await pg.evaluate(f"location.hash = '{r['id']}~{bd['id']}~{tab}~{v['id']}'")
                        await pg.wait_for_timeout(2200 if tab=='3d' else 700)
                        t0 = await pg.evaluate("performance.now()")
                    # quick selection round-trip
                    await pg.evaluate("Noeti.select([Noeti.app.cur.B.fps[0].r],[])")
                    await pg.wait_for_timeout(300)
                    cur = f"{r['id']}/{bd['id']}/{v['id']}/simrun"
                    await pg.evaluate("location.hash = location.hash.replace(/~files/, '~sim')")
                    await pg.wait_for_timeout(500)
                    sg = await pg.evaluate("document.querySelectorAll('.sugg:not(.sel)').length")
                    if sg:
                        await pg.click('.sugg:not(.sel) >> nth=0'); await pg.wait_for_timeout(300); await pg.click('#sim-run'); await pg.wait_for_timeout(1500)
                        res = await pg.evaluate("((document.querySelector('.legend')||document.querySelector('.sim-err')||{}).innerText||'').replace(/\\n/g,' ')")
                        print('   sim', res[:100])
                    print('ok', r['id'], bd['id'], v['id'], flush=True)
        print('\n'.join(errs) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

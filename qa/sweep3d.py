import asyncio, json, sys, time
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    only = sys.argv[1].split(',') if len(sys.argv) > 1 and sys.argv[1] else None
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        errs = []; cur = ['home']
        pg.on('pageerror', lambda e: errs.append(f'PAGEERROR {cur[0]}: {e}'))
        pg.on('console', lambda m: errs.append(f'{m.type} {cur[0]}: {m.text[:300]}') if m.type in ('error', 'warning') and 'ERR_TUNNEL' not in m.text and '404' not in m.text and 'fonts' not in m.text and 'GPU stall' not in m.text else None)
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1200)
        tot = []
        for r in idx:
            if only and r['id'] not in only: continue
            for bd in r['boards']:
                v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
                cur[0] = f"{r['id']}/{bd['id']}/{v['id']}"
                try:
                    await pg.evaluate(f"location.hash = '{r['id']}~{bd['id']}~3d~{v['id']}'")
                    for k in range(40):
                        await pg.wait_for_timeout(500)
                        ready = await pg.evaluate("(() => { const v = Noeti.app.views.v3d; const A = Noeti.app; return !!(v && v.B && A.cur && v.B === A.cur.B); })()")
                        if ready: break
                    res = await pg.evaluate("""(()=>{ const v = Noeti.app.views.v3d; if (!v || !v.B) return { none: true }; const t0 = performance.now(); v.buildReal(); const R = v.real;
                      return { ok: !!(R && R.vao), ms: Math.round(performance.now() - t0), tris: R && R.tris, parts: v.B.fps.length, atlasH: R && R.atlas ? 1 : 0 }; })()""")
                    tot.append(res.get('ms') or 0)
                    print(('ok  ' if res.get('ok') else 'BAD ') + cur[0], json.dumps(res), flush=True)
                except Exception as e:
                    print('EXC', cur[0], str(e)[:300], flush=True)
                    await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1000)
        tot.sort()
        print('build ms median', tot[len(tot)//2] if tot else None, 'max', tot[-1] if tot else None)
        print('\n'.join(errs[:60]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

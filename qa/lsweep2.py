import asyncio, json, sys, time
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    only = sys.argv[1].split(',') if len(sys.argv) > 1 and sys.argv[1] else None
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        errs = []; cur = ['home']
        pg.on('pageerror', lambda e: errs.append(f'PAGEERROR {cur[0]}: {e}'))
        pg.on('console', lambda m: errs.append(f'{m.type} {cur[0]}: {m.text[:300]}') if m.type == 'error' and 'ERR_TUNNEL' not in m.text and '404' not in m.text and 'fonts' not in m.text else None)
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1200)
        for r in idx:
            if only and r['id'] not in only: continue
            for bd in r['boards']:
                v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
                cur[0] = f"{r['id']}/{bd['id']}/{v['id']}"
                t0 = time.time()
                try:
                    await pg.evaluate(f"location.hash = '{r['id']}~{bd['id']}~pcb~{v['id']}'"); await pg.wait_for_timeout(1500)
                    await pg.evaluate("(() => { window.__toasts = []; if (!Noeti.__tw) { const t0 = Noeti.toast; Noeti.toast = (m, k) => { (window.__toasts = window.__toasts || []).push(m); return t0(m, k); }; Noeti.__tw = 1; } Noeti.startLive(); })()"); await pg.wait_for_timeout(1000)
                    for tab in ['probes', 'actions', 'board', 'code']:
                        await pg.evaluate(f"Noeti.live.ui && Noeti.live.ui.open('{tab}')"); await pg.wait_for_timeout(250)
                    res = await pg.evaluate("""(()=>{ const L = Noeti.live; const out = {procs: (L.procs||[]).length, t: L.engine ? L.engine.t : null};
                      const p = (L.procs||[])[0]; if (!p) return out; const a = L.analysisFor(p); const src = a ? Noeti.analysis.program(a) : null; out.srcLen = src ? src.length : 0;
                      if (src) { const pr = L.fwm.runScript(p, src); out.state0 = pr.state; out.err0 = pr.error; L.realTime(); } out.ref = p.ref; out.fam = p.family; return out; })()""")
                    await pg.wait_for_timeout(1800)
                    res3 = await pg.evaluate("""(()=>{ const L = Noeti.live; const gs = L.signalGroups(); for (const g of gs) g.add(); L.ui.open('probes'); L.ui.cursor = 160; L.ui.drawScope(); L.ui.updateProbes(true); return { groups: gs.length, probes: L.probes.length, dec: L.probes.filter(p => p.kind === 'decode').map(p => p.bus + ':' + (p.stats ? p.stats.n : '-')).join(' ') }; })()""")
                    await pg.wait_for_timeout(700)
                    await pg.evaluate("(()=>{ const L = Noeti.live; L.ui.scopeMode = 'overlay'; L.ui.renderSide(); L.ui.cursor = 120; L.ui.drawScope(); L.ui.scopeMode = 'auto'; })()")
                    res.update(res3)
                    res2 = await pg.evaluate("""(()=>{ const L = Noeti.live; const pr = [...L.fwm.procs.values()][0]; if (!pr) return {}; return {state: pr.state, err: pr.error, con: pr.console.text.slice(-160).replace(/\\n/g,' | '), screens: [...L.fwm.screens.values()].flat().length, pix: L.fwm.pixels.size}; })()""")
                    # other views with live on
                    await pg.evaluate(f"location.hash = '{r['id']}~{bd['id']}~sch~{v['id']}'"); await pg.wait_for_timeout(700)
                    await pg.evaluate(f"location.hash = '{r['id']}~{bd['id']}~3d~{v['id']}'"); await pg.wait_for_timeout(1200)
                    await pg.evaluate("Noeti.live.on && Noeti.live.stop()"); await pg.wait_for_timeout(200)
                    res.update(res2)
                    tw = await pg.evaluate("(window.__toasts || []).filter(t => /could not|stopped/.test(t))")
                    if tw: res['toasts'] = tw
                    bad = res.get('state') == 'error' or res.get('state0') == 'error' or bool(tw)
                    print(('BAD ' if bad else 'ok  ') + cur[0], f"{time.time()-t0:.1f}s", json.dumps(res)[:400], flush=True)
                except Exception as e:
                    print('EXC', cur[0], str(e)[:300], flush=True)
                    await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1000)
        print('\n'.join(errs[:80]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

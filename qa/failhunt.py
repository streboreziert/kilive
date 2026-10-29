import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
HOOK = """(() => { const L = Noeti.live; window.__dump = null; const hook = () => { const e = L.engine; if (!e || e._hooked) return; e._hooked = true; const st = e.step.bind(e); e.step = () => { const snap = Float64Array.from(e.x); const ok = st(); if (!ok && !window.__dump) { const bad = []; for (const [nm, i] of e.idx) bad.push([nm, snap[i], e.x[i]]); bad.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])); const nb = []; for (let k = e.nn; k < e.N; k++) nb.push(snap[k]); window.__dump = { t: e.t, dt: e.dt, stats: JSON.stringify(e.stats), top: bad.slice(0, 10).map(([n, v, w]) => n + '=' + v.toFixed(3) + '->' + w), br: e.els.filter(x => x._br != null).map(x => x.t + ':' + x.name + '=' + snap[x._br].toExponential(2)).slice(0, 12), drv: [...e.drv.values()].filter(d => d.mode !== 'z').map(d => d.ref + '.' + d.pin + ':' + d.mode + ':' + d.g), swr: e.els.filter(x => x.t === 'SWR').map(x => 'D=' + x._D + ' ilf=' + x._ilf), reg: e.els.filter(x => x.t === 'REG').map(x => x.ref + ':' + x._on), sing: e.P && e.P.singular }; } return ok; }; }; hook(); setInterval(hook, 50); })()"""
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("(() => { window.__toasts = []; const t0 = Noeti.toast; Noeti.toast = (m, k) => { window.__toasts.push(m); return t0(m, k); }; Noeti.startLive(); })()")
        await pg.evaluate(HOOK)
        await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.live.ui.open('actions')")
        for i in range(12):
            await pg.wait_for_timeout(500)
            d = await pg.evaluate("window.__dump")
            if d: break
        print(json.dumps({'toasts': await pg.evaluate('window.__toasts'), 'dump': await pg.evaluate('window.__dump'), 't': await pg.evaluate('Noeti.live.engine.t')}, indent=1))
        await b.close()
asyncio.run(main())

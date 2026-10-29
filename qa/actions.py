import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: actions.py board [shot-name]
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error', 'warning') and 'TUNNEL' not in m.text and 'fonts' not in m.text and '404' not in m.text and 'GPU stall' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("(() => { window.__toasts = []; const t0 = Noeti.toast; Noeti.toast = (m, k) => { window.__toasts.push(m); return t0(m, k); }; Noeti.startLive(); })()"); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.live.ui.open('actions')"); await pg.wait_for_timeout(800)
        info = await pg.evaluate("""(() => { const L = Noeti.live; const gs = Noeti.actions.groups(L, L.ui);
          return gs.map(g => g.title + ' (' + g.items.length + '): ' + g.items.slice(0, 8).map(i => i.title + (i.status ? ' [' + (i.status() || '') + ']' : '')).join(' | ')); })()""")
        print('\n'.join(info))
        await pg.wait_for_timeout(2500)
        side = await pg.evaluate("(() => { const s = document.querySelector('.live-side'); const r = s.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        await pg.screenshot(path=f'/tmp/claude-0/qa/act-{bd.replace("~", "_")}.png', clip={'x': side[0], 'y': max(0, side[1]), 'width': side[2], 'height': min(1000 - max(0, side[1]), side[3])})
        # power: unplug the first supply, check the rails, plug back
        r = await pg.evaluate("""(async () => { const L = Noeti.live, e = L.engine; const s = e.supplies()[0]; if (!s) return 'no supply';
          const rails0 = L.rails().map(r => r.name + '=' + (r.v || 0).toFixed(2)).join(' ');
          e.setSupplyOn(s.net, false); await new Promise(r => setTimeout(r, 1500));
          const rails1 = L.rails().map(r => r.name + '=' + (r.v || 0).toFixed(2)).join(' ');
          e.setSupplyOn(s.net, true); await new Promise(r => setTimeout(r, 1500));
          const rails2 = L.rails().map(r => r.name + '=' + (r.v || 0).toFixed(2)).join(' ');
          return { net: s.net, before: rails0, unplugged: rails1, after: rails2, ok: L.running }; })()""")
        print('unplug:', json.dumps(r, indent=1))
        # force the first regulator off and on
        r = await pg.evaluate("""(async () => { const L = Noeti.live, e = L.engine; const x = e.els.find(q => q.t === 'REG' || q.t === 'SWR' || q.t === 'LSW'); if (!x) return 'no regulator';
          e.setEnable(x.ref, false); await new Promise(r => setTimeout(r, 1500)); const off = L.rails().map(r => r.name + '=' + (r.v || 0).toFixed(2)).join(' ');
          e.setEnable(x.ref, null); await new Promise(r => setTimeout(r, 1500)); const auto = L.rails().map(r => r.name + '=' + (r.v || 0).toFixed(2)).join(' ');
          return { ref: x.ref, t: x.t, off, auto, running: L.running }; })()""")
        print('enable:', json.dumps(r, indent=1))
        # run the first conversation
        r = await pg.evaluate("""(async () => { const L = Noeti.live; const gs = Noeti.actions.groups(L, L.ui); const g = gs.find(g => g.id === 'talk'); if (!g) return 'no talk';
          const out = []; for (const it of g.items.slice(0, 1)) { const c = it.controls.find(c => c.type === 'button'); c.run(); out.push(it.title); }
          await new Promise(r => setTimeout(r, 3500));
          const pr = [...L.fwm.procs.values()][0]; return { ran: out, state: pr && pr.state, err: pr && pr.error, con: pr ? pr.console.text.slice(-300) : '', probes: L.probes.map(p => p.label + (p.kind === 'decode' ? ' [' + (p.stats && p.stats.n) + ']' : '')) }; })()""")
        print('talk:', json.dumps(r, indent=1))
        await pg.evaluate("Noeti.live.ui.open('actions')"); await pg.wait_for_timeout(1200)
        await pg.screenshot(path=f'/tmp/claude-0/qa/act2-{bd.replace("~", "_")}.png', clip={'x': side[0], 'y': max(0, side[1]), 'width': side[2], 'height': min(1000 - max(0, side[1]), side[3])})
        print('toasts:', await pg.evaluate("window.__toasts"))
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

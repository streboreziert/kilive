import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: talk.py board idregex [wait-ms]
async def main():
    bd, rx = sys.argv[1], sys.argv[2]
    wait = int(sys.argv[3]) if len(sys.argv) > 3 else 5000
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error',) and 'TUNNEL' not in m.text and 'fonts' not in m.text and '404' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("(() => { window.__toasts = []; const t0 = Noeti.toast; Noeti.toast = (m, k) => { window.__toasts.push(m); return t0(m, k); }; Noeti.startLive();  })()"); await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.live.ui.open('actions')"); await pg.wait_for_timeout(500)
        items = await pg.evaluate(f"""(() => {{ const L = Noeti.live; const gs = Noeti.actions.groups(L, L.ui); const all = gs.flatMap(g => g.items); const hit = all.filter(i => new RegExp({json.dumps(rx)}).test(i.id)); for (const it of hit.slice(0, 1)) {{ const c = it.controls.find(c => c.type === 'button'); c.run(); }} return {{ ids: all.map(i => i.id), ran: hit.slice(0, 1).map(i => i.title + ' — ' + i.sub) }}; }})()""")
        print(json.dumps(items, indent=0)[:1500])
        await pg.wait_for_timeout(wait)
        res = await pg.evaluate("""(() => { const L = Noeti.live; const out = {};
          for (const [ref, pr] of L.fwm.procs) out[ref] = { state: pr.state, err: pr.error, con: pr.console.text.slice(-400) };
          out.probes = L.probes.map(p => p.label + (p.kind === 'decode' ? ' [' + (p.stats && p.stats.n) + ' ev; ' + (p.stats && p.stats.last) + ']' : ''));
          out.links = (L.fwm.links() || []).map(k => k.from + '>' + k.to + ':' + (k.bytes || 0));
          out.t = L.engine.t; out.running = L.running; return out; })()""")
        print(json.dumps(res, indent=1)[:4000])
        print('toasts:', await pg.evaluate('window.__toasts'))
        side = await pg.evaluate("(() => { const s = document.querySelector('.live-side'); const r = s.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        await pg.screenshot(path=f'/tmp/claude-0/qa/talk-{bd.replace("~", "_")}.png', clip={'x': side[0], 'y': max(0, side[1]), 'width': side[2], 'height': min(1000 - max(0, side[1]), side[3])})
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

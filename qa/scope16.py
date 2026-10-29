import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: scope16.py board [group-regex ...]
async def main():
    bd = sys.argv[1]
    pats = sys.argv[2:] or ['pins the program drives', 'I2C', 'Serial']
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1300})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error', 'warning') and 'TUNNEL' not in m.text and 'fonts' not in m.text and 'GPU stall' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1500)
        await pg.evaluate("(()=>{const L=Noeti.live; const p=L.procs[0]; if (!p) return; const a=L.analysisFor(p); const src=Noeti.analysis.program(a); L.fwm.runScript(p, src); L.realTime(); L.ui.open('probes');})()")
        await pg.wait_for_timeout(2500)
        groups = await pg.evaluate("Noeti.live.signalGroups().map(g => g.label + ' [' + g.hint + ']')")
        print('groups:', json.dumps(groups, indent=1))
        for pat in pats:
            n = await pg.evaluate(f"(() => {{ const g = Noeti.live.signalGroups().find(g => new RegExp({json.dumps(pat)}, 'i').test(g.label)); return g ? g.add() : -1; }})()")
            print('add', pat, '->', n)
        await pg.wait_for_timeout(5000)
        st = await pg.evaluate("Noeti.live.probes.map(p => 'CH' + (p.ch + 1) + ' ' + p.label + (p.kind === 'decode' ? ' [' + (p.stats && p.stats.n) + ' ev, last: ' + (p.stats && p.stats.last) + ']' : ' ' + (p.stats && p.stats.v != null ? p.stats.v.toFixed(2) + 'V' : '?') + (p.stats && p.stats.freq ? ' ' + p.stats.freq.toFixed(1) + 'Hz' : '')))")
        print('\n'.join(st))
        # hover the scope at 70%
        await pg.evaluate("(() => { const card = document.querySelector('.viewer-card') || document.querySelector('.live-side'); window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - 4); const b = document.querySelector('.ls-body'); if (b) b.scrollTop = 0; })()")
        await pg.wait_for_timeout(400)
        r = await pg.evaluate("(() => { const c = document.querySelector('.pb-scope'); const r = c.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        print('scope rect', r)
        await pg.mouse.move(r[0] + r[2] * 0.72, r[1] + r[3] * 0.4)
        await pg.wait_for_timeout(400)
        side = await pg.evaluate("(() => { const s = document.querySelector('.live-side'); const r = s.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        await pg.screenshot(path=f'/tmp/claude-0/qa/scope-{bd}.png', clip={'x': side[0], 'y': max(0, side[1]), 'width': side[2], 'height': min(1300 - max(0, side[1]), side[3])})
        await pg.screenshot(path=f'/tmp/claude-0/qa/scopefull-{bd}.png')
        print('\n'.join(logs[:12]))
        await b.close()
asyncio.run(main())

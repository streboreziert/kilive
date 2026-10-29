import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error',) and 'TUNNEL' not in m.text and 'fonts' not in m.text and '404' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(1200)
        await pg.evaluate("(() => { const ui = Noeti.live.ui; ui.acOpen = new Set(['models']); ui.open('actions'); })()"); await pg.wait_for_timeout(800)
        side = await pg.evaluate("(() => { const s = document.querySelector('.live-side'); const r = s.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        await pg.screenshot(path=f'/tmp/claude-0/qa/models-{bd.replace("~", "_")}.png', clip={'x': side[0], 'y': max(0, side[1]), 'width': side[2], 'height': min(1000 - max(0, side[1]), side[3])})
        # open the editor on the first chip with an Edit / Make button
        name = await pg.evaluate("""(() => { const rows = [...document.querySelectorAll('.ac-m')]; const r = rows.find(r => r.querySelector('button.lb')); if (!r) return null; const ref = r.querySelector('.ac-mref').textContent; r.querySelector('button.lb').click(); return ref + ' ' + r.className; })()""")
        print('editing', name)
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=f'/tmp/claude-0/qa/editor-{bd.replace("~", "_")}.png')
        # set the first input pin to "drives high" and save on this device
        r = await pg.evaluate("""(async () => { const sels = [...document.querySelectorAll('.me-sel')]; const s = sels.find(x => x.value === 'in'); if (!s) return 'no input pin'; s.value = 'hi'; s.dispatchEvent(new Event('change')); const pin = s.getAttribute('aria-label');
          const btn = [...document.querySelectorAll('.modal-foot button')].find(b => /this device/.test(b.textContent)); btn.click(); await new Promise(r => setTimeout(r, 1500));
          const L = Noeti.live; return { pin, user: [...Noeti.partModels.user.values()].map(m => m.match + ':' + Object.entries(m.roles).filter(([, o]) => o.role === 'hi').map(([k]) => k).join(',')), beh: L.pm ? L.pm.items.map(i => i.b.ref + ':' + i.b.family) : [], models: Object.keys(L.partModels).length }; })()""")
        print(json.dumps(r, indent=1))
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

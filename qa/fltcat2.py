import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        errs = []
        pg.on('pageerror', lambda e: errs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: errs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error',) and 'TUNNEL' not in m.text and 'fonts' not in m.text and '404' not in m.text else None)
        for bd in sys.argv[1].split(','):
            await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2500)
            await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(3000)
            res = await pg.evaluate("""(() => { const L = Noeti.live; let n1 = 0, n2 = 0; const ex1 = [], why2 = {};
              for (const [name, i] of L.netIdx) { if (L.flt[i] === 1) { n1++; if (ex1.length < 12) ex1.push(name + ': ' + L.netWhy(i)); } else if (L.flt[i] === 2) { n2++; const k = L.netWhy(i).replace(/[A-Z]+\\d+[A-Z]?\\d*|pin \\S+|\\([^)]*\\)/g, '#').slice(0, 60); why2[k] = (why2[k] || 0) + 1; } }
              return { n1, n2, nets: L.netIdx.size, ex1, why2: Object.entries(why2).sort((a, b) => b[1] - a[1]).slice(0, 8), models: L.models.size, beh: L.pm ? L.pm.items.length : 0, notes: L.engine.notes.slice(0, 5) }; })()""")
            print(bd, json.dumps(res, indent=1))
            await pg.evaluate("Noeti.live.stop()")
        print('\n'.join(errs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

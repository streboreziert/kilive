import asyncio, json, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# prints the "What this board does" lines (analysis.describe) of every processor on every board
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    pat = sys.argv[1] if len(sys.argv) > 1 else ''
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        errs = []
        pg.on('pageerror', lambda e: errs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1000)
        for r in idx:
            for bd in r['boards']:
                v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
                key = f"{r['id']}/{bd['id']}"
                await pg.evaluate(f"location.hash = '{r['id']}~{bd['id']}~pcb~{v['id']}'"); await pg.wait_for_timeout(1300)
                try:
                    out = await pg.evaluate("""(() => { const N = KiLive, m = N.simModel ? N.simModel() : null; const L = N.live; N.startLive(); const res = []; for (const p of (L.procs || [])) { const a = L.analysisFor(p); if (!a) continue; res.push({ ref: p.ref, lines: N.analysis.describe(a), eth: a.eth ? a.eth.pins.length : 0, uarts: a.uarts.map(u => u.peer) }); } L.stop(); return res; })()""")
                except Exception as e:
                    out = str(e)[:200]
                print(key, json.dumps(out)[:1500], flush=True)
        print('\n'.join(errs[:30]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

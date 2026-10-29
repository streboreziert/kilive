"""Smoke test for the static build (dist/): the page boots with no server-side help, boards open in every tab,
and the in-browser library storage survives a reload.

    python3 scripts/build_site.py
    (cd dist && python3 -m http.server 8766 &)
    python3 qa/static_smoke.py [http://localhost:8766/] [board1,board2] [shots_dir]
Exit code 1 on any page error.
"""
import asyncio, os, sys
from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8766/'
BOARDS = (sys.argv[2] if len(sys.argv) > 2 else 'rp2040-guide,glasgow').split(',')
SHOTS = sys.argv[3] if len(sys.argv) > 3 else None


async def main():
    errors = []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width': 1400, 'height': 880})
        pg = await ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: errors.append(f'console: {m.text[:200]}') if m.type == 'error' and 'fonts' not in m.text else None)

        await pg.goto(URL + '#explore', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        rt = await pg.evaluate("!!(window.claude && window.claude.browser)")
        cards = await pg.evaluate("document.querySelectorAll('a[href^=\"#\"], .card, .repo-card').length")
        print('browser runtime', rt, '| catalogue links', cards)
        if SHOTS: os.makedirs(SHOTS, exist_ok=True); await pg.screenshot(path=os.path.join(SHOTS, 'explore.png'))

        for bd in BOARDS:
            for t in ['pcb', 'sch', '3d', 'checks', 'bom', 'files']:
                await pg.evaluate(f"location.hash = '{bd}~~{t}'"); await pg.wait_for_timeout(1800 if t in ('3d', 'sch') else 900)
                if SHOTS and t in ('pcb', 'sch', '3d'): await pg.screenshot(path=os.path.join(SHOTS, f'{bd}-{t}.png'))
            print(bd, 'ok')

        # storage round trip through the runtime the app uses
        await pg.evaluate("""(async () => { const db = await window.claude.use('db');
            await db.collection('qa').doc('probe').set({v: 42, at: Date.now()}); })()""")
        await pg.reload(wait_until='networkidle'); await pg.wait_for_timeout(800)
        v = await pg.evaluate("""(async () => { const db = await window.claude.use('db');
            const s = await db.collection('qa').get(); return s.docs.map(d => d.data().v); })()""")
        print('persisted after reload', v)
        if v != [42]: errors.append('storage did not persist: %r' % (v,))
        await b.close()
    print('\n'.join(errors[:30]) or 'NO ERRORS')
    sys.exit(1 if errors else 0)


asyncio.run(main())

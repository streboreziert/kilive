import asyncio, sys, json, base64, time
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    ids = sys.argv[1].split(','); extra = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text[:300]}') if (m.type in ('error','warning') or 'photo:' in m.text) and 'fonts' not in m.text else None)
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(800)
        for rid in ids:
            r = [x for x in idx if x['id'] == rid][0]; bd = r['boards'][0]
            v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
            t0 = time.time()
            res = await pg.evaluate("""async ([f, o]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
              const t0 = performance.now(); const cv = await Noeti.renderPhoto(B, o); const ms = performance.now() - t0;
              return { url: cv.toDataURL('image/png'), ms, meta: cv.meta }; }""", [v['file'], extra])
            open(f'/tmp/claude-0/qa/ph-{rid}.png', 'wb').write(base64.b64decode(res['url'].split(',')[1]))
            print(rid, f"{time.time()-t0:.1f}s render {res['ms']:.0f}ms", res['meta'], flush=True)
        print('\n'.join(logs[:20]))
        await b.close()
asyncio.run(main())

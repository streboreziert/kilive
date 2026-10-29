import asyncio, sys, json, base64, time
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    rid = sys.argv[1]; extra = json.loads(sys.argv[2])
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        logs = []
        pg.on('console', lambda m: logs.append(m.text[:200]) if 'photo:' in m.text else None)
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(800)
        r = [x for x in idx if x['id'] == rid][0]; bd = r['boards'][0]
        v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
        res = await pg.evaluate("""async ([f, o]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
          const t0 = performance.now(); const cv = await Noeti.renderPhoto(B, o); const t1 = performance.now();
          const url = cv.toDataURL('image/png'); const t2 = performance.now();
          return { url, render: t1 - t0, encode: t2 - t1, meta: cv.meta }; }""", [v['file'], extra])
        open(f'/tmp/claude-0/qa/ph-{rid}.png', 'wb').write(base64.b64decode(res['url'].split(',')[1]))
        print(rid, 'render', round(res['render']), 'encode', round(res['encode']), res['meta'], logs)
        await b.close()
asyncio.run(main())

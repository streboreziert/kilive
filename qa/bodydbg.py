import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    rid = sys.argv[1]; expr = sys.argv[2]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL + '#explore', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        out = await pg.evaluate("""async ([rid, expr]) => { const idx = await Noeti.loadJSON('data/index.json'); const r = idx.find(r => r.id === rid); const res = [];
          for (const bd of r.boards) { const v = bd.versions.find(v => v.id === bd.default) || bd.versions[0];
            try { const d = await Noeti.loadJSON(v.file); const B = new Noeti.Board(d); res.push(eval(expr)); } catch (e) { res.push('ERR ' + e.stack.split('\\n').slice(0, 3).join(' | ')); } }
          return res; }""", [rid, expr])
        print(json.dumps(out, indent=0)[:4000])
        await b.close()
asyncio.run(main())

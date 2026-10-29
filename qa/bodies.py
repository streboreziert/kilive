import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL + '#explore', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        out = await pg.evaluate("""async () => { const idx = await Noeti.loadJSON('data/index.json'); const res = [];
          for (const r of (idx.repos || idx)) for (const bd of r.boards) { const v = bd.versions.find(v => v.id === bd.default) || bd.versions[0];
            try { const d = await Noeti.loadJSON(v.file); const B = new Noeti.Board(d); const bo = B.bodies(); const hid = [], chg = [];
              bo.forEach((o, i) => { const f = B.fps[i]; if (!o.z && o.why && o.why !== 'dnp' && f.z && f.z[0] !== 'none') hid.push(f.r + ' ' + String(f.fp).slice(0, 34) + ' [' + f.z[0] + '] ' + o.why); else if (o.z && f.z && o.z[0] !== f.z[0]) chg.push(f.r + ' ' + f.z[0] + '->' + o.z[0] + ' ' + String(f.fp).slice(0, 30)); });
              if (hid.length || chg.length) res.push({ id: r.id + '/' + bd.id, hid, chg }); } catch (e) { res.push({ id: r.id, err: String(e) }); } }
          return res; }""")
        json.dump(out, open('/tmp/claude-0/qa/bodies.json', 'w'), indent=1)
        nh = sum(len(x.get('hid', [])) for x in out); nc = sum(len(x.get('chg', [])) for x in out)
        print(len(out), 'boards affected; hidden', nh, 'changed', nc)
        await b.close()
asyncio.run(main())

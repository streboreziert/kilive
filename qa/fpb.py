import asyncio, json, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    rid, refs = sys.argv[1], sys.argv[2].split(',')
    r = [x for x in idx if x['id']==rid][0]; bd=r['boards'][0]; v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu']); pg = await b.new_page()
        await pg.goto(URL, wait_until='networkidle')
        res = await pg.evaluate("""async ([f, refs])=>{ const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
          return refs.map(ref => { const f = B.fp(ref); if (!f) return ref + ' missing'; const a = f.a*Math.PI/180, ca=Math.cos(a), sa=Math.sin(a);
            const ps = f.pads.map(pi => { const p = B.pads[pi]; const dx=p[4]-f.x, dy=p[5]-f.y; return [+(dx*ca-dy*sa).toFixed(2), +(dx*sa+dy*ca).toFixed(2), p[6], p[7], p[8]]; });
            const xs = ps.map(q=>q[0]), zs = ps.map(q=>q[1]);
            return {ref, fp: f.fp, a: f.a, b: f.b, z: f.z, n: ps.length, xr: [Math.min(...xs), Math.max(...xs)], zr: [Math.min(...zs), Math.max(...zs)], ex: ps.slice(0,3)}; }); }""", [v['file'], refs])
        for x in res: print(json.dumps(x))
        await b.close()
asyncio.run(main())

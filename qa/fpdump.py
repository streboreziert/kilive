import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; minA = float(sys.argv[2]) if len(sys.argv) > 2 else 30
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        out = await pg.evaluate("""(minA) => { const B = Noeti.app.views.pcb.B; const bb = B.bbox;
          return { bbox: bb, n: B.fps.length, outline: !!B.outline, parts: B.fps.filter(f => f.b).map(f => { const sx = f.b[2]-f.b[0], sz = f.b[3]-f.b[1]; return { r: f.r, v: String(f.v||'').slice(0,30), fp: String(f.fp||'').slice(0,50), z: f.z, s: f.s, x: +f.x.toFixed(1), y: +f.y.toFixed(1), a: f.a, sx: +sx.toFixed(1), sz: +sz.toFixed(1), out: f.x < bb[0] || f.x > bb[2] || f.y < bb[1] || f.y > bb[3], dnp: f.dnp, npads: f.pads.length }; }).filter(p => p.sx * p.sz >= minA || p.out || /gold|metal/.test(p.z && p.z[0]) || /sma/i.test(p.fp)) }; }""", minA)
        print(json.dumps({k: out[k] for k in ('bbox','n','outline')}))
        for q in out['parts']: print(q)
        await b.close()
asyncio.run(main())

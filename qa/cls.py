import asyncio, json, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    ids = sys.argv[1].split(',')
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu']); pg = await b.new_page()
        await pg.goto(URL, wait_until='networkidle')
        for rid in ids:
            r = [x for x in idx if x['id']==rid][0]; bd=r['boards'][0]; v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
            res = await pg.evaluate("""async (f)=>{ const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
              return B.fps.filter(f => f.z && f.z[0] !== 'none' && (f.z[1] > 1.4 || f.z[0] === 'ic') && !/^(R|C|L|FB|D|LED|Q|TP)\\d/.test(f.r)).map(f => [f.r, f.v, f.fp, f.z[0], f.z[1], f.s].join(' | ')); }""", v['file'])
            print('==', rid); print('\n'.join(res))
        await b.close()
asyncio.run(main())

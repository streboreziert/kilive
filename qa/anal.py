import asyncio, json, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    want = sys.argv[1].split(',') if len(sys.argv) > 1 else None
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page()
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL, wait_until='networkidle')
        for r in idx:
            if want and r['id'] not in want: continue
            for bd in r['boards'][:1]:
                vi = int(sys.argv[2]) if len(sys.argv) > 2 else 0
                v = bd['versions'][vi]
                res = await pg.evaluate("""async (f)=>{ const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d); const c = Noeti.simtab.boardCircuit(B);
                  const ps = Noeti.fw.detect(c); return ps.map(p=>{ let a; try { a = Noeti.analysis.forProc(c,p); return {ref:p.ref, fam:p.family, emu:p.emuChip, chip:p.chipId, text:Noeti.analysis.describe(a), mapped:p.io.filter(i=>i.chipPin).length+'/'+p.io.length}; } catch(e) { return {ref:p.ref, err:e.message+' '+e.stack.split('\\n')[1]}; } }) }""", v['file'])
                print('==', r['id'])
                for x in res: print('  ', json.dumps(x)[:1500])
        print('\n'.join(errs[:5]))
        await b.close()
asyncio.run(main())

import asyncio, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
IDX = '/home/claude/noeti/app/data/index.json'
async def main():
    idx = json.load(open(IDX))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu']); pg = await b.new_page()
        await pg.goto(URL, wait_until='networkidle')
        out = {}
        for r in idx:
            procs = 0; emu = []
            for bd in r['boards']:
                v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
                res = await pg.evaluate("""async (f)=>{ const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d); const c = Noeti.simtab.boardCircuit(B);
                  const ps = Noeti.fw.detect(c); return ps.map(p=>({fam:p.family, emu:p.emuChip, chip:p.chip ? p.chip.name : p.value})) }""", v['file'])
                procs = max(procs, len(res))
                for x in res:
                    if x['fam'] == 'rp2040': n = 'RP2040'
                    elif x['fam'] == 'avr': n = 'AVR'
                    elif x['fam'] in ('arm', 'riscv') and x['emu'] and not x['emu'].startswith('esp32'):
                        e = x['emu']
                        n = {'rp2350': 'RP2350', 'rp2350b': 'RP2350', 'samd21g18': 'SAMD21', 'samd51p20': 'SAMD51', 'same54p20': 'SAME54', 'saml22j18': 'SAML22', 'efr32mg24': 'EFR32MG24', 'cc1352p': 'CC1352P'}.get(e, e.upper().replace('NRF', 'nRF'))
                    else: continue
                    if n not in emu: emu.append(n)
            old = r.get('code')
            r['code'] = {'procs': procs, 'emu': emu}
            if json.dumps(old) != json.dumps(r['code']): print(r['id'], old, '->', r['code'])
        await b.close()
    json.dump(idx, open(IDX, 'w'), separators=(',', ':'), ensure_ascii=False)
asyncio.run(main())

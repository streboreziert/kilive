import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: pinnets.py board REF,REF,...  - every pin of those parts with its net (and the net's other parts, short)
async def main():
    bd = sys.argv[1]; refs = sys.argv[2].split(',')
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL + '#' + bd + ('~pcb' if '~' in bd else '~~pcb'), wait_until='networkidle'); await pg.wait_for_timeout(1500)
        r = await pg.evaluate("""(refs) => { const B = Noeti.app.B || Noeti.app.views.pcb.B; const wb = Noeti.simtab.wholeBoard(B); const circ = wb.circuit, out = [];
          const comp = new Map(circ.components.map(c => [c.ref, c]));
          for (const ref of refs) { const c = comp.get(ref); if (!c) { out.push(ref + ': none'); continue; }
            out.push(ref + ' ' + c.type + (c.kind ? ':' + c.kind : '') + ' ' + c.value + (c.sub ? ' sub=' + JSON.stringify(c.sub) : ''));
            for (const n of circ.nets) for (const x of n.nodes) if (x.ref === ref) { const p = (c.pins || []).find(q => String(q.number) === String(x.pin));
              out.push('   ' + x.pin + (p && p.name ? '/' + p.name : '') + ' -> ' + n.name + ' [' + n.kind + '] (' + n.nodes.filter(y => y.ref !== ref).slice(0, 10).map(y => { const d = comp.get(y.ref); return y.ref + '.' + y.pin + ':' + (d ? d.type : '?'); }).join(' ') + (n.nodes.length > 11 ? ' …' : '') + ')'); }
          }
          return out; }""", refs)
        print('\n'.join(r))
        await b.close()
asyncio.run(main())

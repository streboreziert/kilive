import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: netaround.py board net1,net2,... [legacy]  - parts on those nets, chips, sources
async def main():
    bd = sys.argv[1]; nets = sys.argv[2].split(',') if len(sys.argv) > 2 and sys.argv[2] else []
    legacy = len(sys.argv) > 3 and sys.argv[3] == 'legacy'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#' + bd + ('~pcb' if '~' in bd else '~~pcb'), wait_until='networkidle'); await pg.wait_for_timeout(1500)
        r = await pg.evaluate("""([nets, legacy]) => { const B = Noeti.app.B || Noeti.app.views.pcb.B; Noeti.simtab._legacySources = legacy; const wb = Noeti.simtab.wholeBoard(B); Noeti.simtab._legacySources = false;
          const circ = wb.circuit, sim = wb.sim, out = [];
          const comp = new Map(circ.components.map(c => [c.ref, c]));
          for (const nm of nets) { const n = circ.nets.find(q => q.name === nm); if (!n) { out.push(nm + ': no such net'); continue; }
            out.push(nm + ' [' + n.kind + ']: ' + n.nodes.map(x => { const c = comp.get(x.ref); const p = c && c.pins ? c.pins.find(q => String(q.number) === String(x.pin)) : null; return x.ref + '.' + x.pin + (p && p.name ? '/' + p.name : '') + '(' + (c ? c.type + (c.kind ? ':' + c.kind : '') + ' ' + String(c.value || '').slice(0, 18) : '?') + ')'; }).join(' ')); }
          out.push('SOURCES ' + sim.sources.map(s => s.net + '=' + s.value + (s.note ? ' (' + s.note + ')' : '')).join(' | '));
          out.push('CHIPS ' + sim.chips.map(c => c.ref + ':' + c.model + (c.boost ? '/boost' : '') + (c.series ? '/' + c.series : '') + ' in=' + c.in + ' out=' + (c.out ?? c.outNet ?? c.sw) + ' v=' + (c.vout ?? '')).join(' | '));
          return out; }""", [nets, legacy])
        print('\n'.join(r))
        print('\n'.join(logs[:10]))
        await b.close()
asyncio.run(main())

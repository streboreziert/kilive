import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(2500)
        res = await pg.evaluate("""(() => { const L = Noeti.live, e = L.engine, circ = L.base.circuit;
          const comp = new Map(circ.components.map(c => [c.ref, c]));
          const procs = new Set((L.procs || []).map(p => p.ref));
          const fl = e.floatingNodes(); const cats = {}; const ex = {};
          for (const n of circ.nets) {
            const nd = L.netNode.get(n.name); if (!nd) continue; const i = e.nodeIndex(nd); if (i < 0 || !fl[i]) continue;
            const kinds = new Set(n.nodes.map(x => { const c = comp.get(x.ref); if (!c) return '?'; if (procs.has(c.ref)) return 'proc'; return c.type === 'ic' ? (L.partModels[c.ref] ? 'icmodel' : 'ic') : c.type; }));
            const k = [...kinds].sort().join('+');
            cats[k] = (cats[k] || 0) + 1; if (!ex[k]) ex[k] = []; if (ex[k].length < 4) ex[k].push(n.name + ' [' + n.nodes.slice(0, 4).map(x => x.ref + '.' + x.pin).join(' ') + ']');
          }
          return { cats: Object.entries(cats).sort((a, b) => b[1] - a[1]), ex }; })()""")
        for k, n in res['cats'][:30]:
            print(f"{n:4d}  {k:40s} {res['ex'][k][:3]}")
        await b.close()
asyncio.run(main())

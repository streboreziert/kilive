import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: bigi.py [from:to] [steps] - elements carrying more than 1 A after the whole-board sim settles (likely model errors)
async def main():
    sel = sys.argv[1] if len(sys.argv) > 1 else ''
    steps = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    boards = []
    for r in idx:
        for bd in r['boards']:
            v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
            boards.append((r['id'] + '/' + bd['id'], v['file']))
    if ':' in sel: a, b = sel.split(':'); boards = boards[int(a or 0):int(b) if b else None]
    elif sel: boards = [x for x in boards if x[0].split('/')[0] in sel.split(',')]
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--disable-gpu'])
        pg = await br.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1000)
        for name, f in boards:
            res = await pg.evaluate("""async ([f, steps]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
                const wb = Noeti.simtab.wholeBoard(B); const circ = wb.circuit, sim = wb.sim;
                const procs = Noeti.fw.detect(circ);
                const drivers = []; const seen = new Set(); const add = x => { const k = x.ref + '\\u0000' + x.pin; if (!seen.has(k)) { seen.add(k); drivers.push(x); } };
                for (const pr of procs) for (const io of pr.io) add({ ref: pr.ref, pin: io.number, vdd: pr.vdd, vnom: pr.vnom });
                for (const x of Noeti.fw.deviceDrivers(circ)) add(x);
                for (const x of sim.drivers || []) add(x);
                const eng = new Noeti.LiveSim(circ, Object.assign({}, sim, { drivers }), {}, {}, { rampTime: 0 });
                const L = { engine: eng, base: { circuit: circ }, gen: 1, forced: new Map() };
                const rt = (sim.behaviours || []).length ? Noeti.partModels.runtime(L, sim.behaviours) : null;
                eng.setDt(1e-5); eng.powerCycle(2e-3);
                for (let n = 0; n < steps; n++) { if (!eng.step()) break; if (rt) rt.step(eng.t, eng.dt); }
                eng.pinCurrents();
                const big = eng.els.filter(e => e.cur != null && Math.abs(e.cur) > 1).map(e => e.t + ' ' + e.name + ' ' + (+e.cur).toFixed(2) + 'A').slice(0, 8);
                const sup = eng.supplies().filter(s => Math.abs(s.i || 0) > 1).map(s => 'SUP ' + s.net + ' ' + (+s.i).toFixed(2) + 'A');
                return big.concat(sup); }""", [f, steps])
            if res: print(f"{name:52s} " + ' | '.join(res), flush=True)
        print('DONE')
        await br.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: trace.py board nets steps every - node voltages over the start-up
async def main():
    sel = sys.argv[1]; nets = sys.argv[2].split(','); steps = int(sys.argv[3]); every = int(sys.argv[4])
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    f = None
    for r in idx:
        for bd in r['boards']:
            if r['id'] + '/' + bd['id'] == sel or r['id'] == sel:
                v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0]); f = f or v['file']
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--disable-gpu'])
        pg = await br.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1000)
        res = await pg.evaluate("""async ([f, steps, every, nets]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
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
            const ids = nets.map(nm => eng.nodeIndex(eng.nodeOf(nm)));
            const out = [];
            for (let n = 0; n < steps; n++) { if (!eng.step()) { out.push('FAIL'); break; } if (rt) rt.step(eng.t, eng.dt); if (n % every === 0) out.push((eng.t * 1e3).toFixed(2) + 'ms ' + ids.map(i => i >= 0 ? eng.x[i].toFixed(3) : '-').join(' ')); }
            return out; }""", [f, steps, every, nets])
        print('\n'.join(res))
        await br.close()
asyncio.run(main())

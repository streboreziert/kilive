import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: region.py board net [steps] - elements with > 5 mA in the region reached from net through <= 1 ohm links
async def main():
    sel = sys.argv[1]; net = sys.argv[2]; steps = int(sys.argv[3]) if len(sys.argv) > 3 else 1500
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
        res = await pg.evaluate("""async ([f, steps, net]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
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
            const pc = eng.pinCurrents(); const rep = {}; for (const nm of ["VREG5V{slash}1", "+5V{slash}1", "+6V", "N94", "N83"]) rep[nm] = eng.nodeReport(eng.nodeOf(nm)).slice(0, 8).map(r => JSON.stringify(r)); return rep;
            const names = new Map(); for (const [nm, i] of eng.idx) names.set(i, nm);
            const start = eng.nodeIndex(eng.nodeOf(net)); const reg = new Set([start]); const q = [start];
            while (q.length) { const i = q.shift(); for (const { e } of eng.byNode.get(i) || []) if (e.t === 'R' && e.v <= 1) for (const j of [e._a, e._b]) if (j >= 0 && !reg.has(j)) { reg.add(j); q.push(j); } }
            const out = [];
            for (const i of reg) for (const { e, k } of eng.byNode.get(i) || []) { if (e.t === 'C' || (e.t === 'R' && e.v <= 1)) continue; const c = e.t === 'DRV' ? null : e.cur; out.push(names.get(i) + ' ' + e.t + ' ' + e.name + '.' + k + ' cur=' + (c == null ? '?' : (+c).toExponential(2)) + (e.t === 'DRV' ? ' mode=' + e.mode + ' v=' + eng.x[e._a]?.toFixed(2) : '')); }
            return out; }""", [f, steps, net])
        print(json.dumps(res, indent=1))
        await br.close()
asyncio.run(main())

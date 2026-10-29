import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: prof.py board-id [steps] [noBody] - engine stats for the whole-board sim
async def main():
    sel = sys.argv[1]; steps = int(sys.argv[2]) if len(sys.argv) > 2 else 1200
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
            const marks = []; window.__eng = eng; let t0 = performance.now(), it0 = 0;
            for (let n = 0; n < steps; n++) { if (!eng.step()) break; if (rt) rt.step(eng.t, eng.dt); if ((n + 1) % 200 === 0) { const t1 = performance.now(); marks.push({ n: n + 1, ms: Math.round(t1 - t0), iters: eng.stats.iters - it0, reorders: eng.stats.reorders, failed: eng.stats.failed }); t0 = t1; it0 = eng.stats.iters; } }
            const counts = {}; for (const e of eng.els) counts[e.t] = (counts[e.t] || 0) + 1;
            const names = new Map(); for (const [nm, i] of eng.idx) names.set(i, nm); const ms = eng.els.filter(e => e.t === "M").map(e => e.name + (e.pch ? "(p)" : "(n)") + " d=" + names.get(e._d) + ":" + (e._d >= 0 ? eng.x[e._d].toFixed(3) : 0) + " g=" + names.get(e._g) + ":" + (e._g >= 0 ? eng.x[e._g].toFixed(3) : 0) + " s=" + names.get(e._s) + ":" + (e._s >= 0 ? eng.x[e._s].toFixed(3) : 0) + " vbd=" + (e._vbd || 0).toFixed(3)); return { marks, ms }; }""", [f, steps])
        print(json.dumps(res, indent=0)[:3000])
        await br.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    sel = sys.argv[1]; steps = int(sys.argv[2]) if len(sys.argv) > 2 else 400
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
            eng.setDt(1e-5); eng.powerCycle(2e-3);
            const hist = new Map();
            for (let n = 0; n < steps; n++) { const i0 = eng.stats.iters; if (!eng.step()) break; if (eng.stats.iters - i0 >= 30) { const w = eng._worst; hist.set(w, (hist.get(w) || 0) + 1); } }
            const names = new Map(); for (const [nm, i] of eng.idx) names.set(i, nm);
            const out = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([i, c]) => { const els = (eng.byNode.get(i) || []).map(q => q.e.t + " " + q.e.name + "." + q.k).slice(0, 12); const br = eng.els.find(e => e._br === i); return { node: names.get(i) || ("branch " + i + (br ? " " + br.t + " " + br.name + " out=" + (br._out >= 0 ? eng.x[br._out].toFixed(3) : "") + " in=" + (br._in >= 0 ? eng.x[br._in].toFixed(3) : "") : "")), count: c, v: eng.x[i], els }; });
            return out; }""", [f, steps])
        print(json.dumps(res, indent=1)[:4000])
        await br.close()
asyncio.run(main())

import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: elsnet.py board-id net1,net2 [steps] - engine elements touching those nets, with currents, after running the whole-board sim
async def main():
    sel = sys.argv[1]; nets = sys.argv[2].split(','); steps = int(sys.argv[3]) if len(sys.argv) > 3 else 1500
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
        res = await pg.evaluate("""async ([f, steps, nets]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
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
            const out = [];
            for (const nm of nets) {
              const nd = eng.nodeOf(nm); const i = eng.nodeIndex(nd);
              out.push('== ' + nm + ' node ' + nd + ' idx ' + i + ' V=' + (i >= 0 ? eng.x[i].toFixed(3) : '-'));
              for (const { e, k } of (eng.byNode.get(i) || [])) out.push('   ' + e.t + ' ' + e.name + ' .' + k + (e.v != null ? ' v=' + (+e.v).toPrecision(3) : '') + (e.vout != null ? ' vout=' + e.vout : '') + (e.ilim != null ? ' ilim=' + e.ilim : '') + (e.load ? ' load' : '') + (e.cur != null ? " cur=" + (+e.cur).toExponential(2) : "") + (e.t === "REG" ? " I=" + (-eng.x[e._br]).toFixed(3) + " out=" + (e._out >= 0 ? eng.x[e._out].toFixed(2) : "-") : "") + (e._on != null ? ' on=' + e._on : ''));
            }
            for (const e of eng.els) if (/^(L1|C20|C25)$/.test(e.ref || "")) out.push("EL " + e.t + " " + e.name + " a=" + e.a + "(" + e._a + ") b=" + e.b + "(" + e._b + ")" + (e._br != null ? " i=" + eng.x[e._br].toExponential(2) : ""));
            return out; }""", [f, steps, nets])
        print('\n'.join(res))
        await br.close()
asyncio.run(main())

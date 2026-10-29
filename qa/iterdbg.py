import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    sel = sys.argv[1]; nodes = sys.argv[2].split(','); steps = int(sys.argv[3]) if len(sys.argv) > 3 else 200
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
        res = await pg.evaluate("""async ([f, steps, nodes]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
            const wb = Noeti.simtab.wholeBoard(B); const circ = wb.circuit, sim = wb.sim;
            const procs = Noeti.fw.detect(circ);
            const drivers = []; const seen = new Set(); const add = x => { const k = x.ref + '\\u0000' + x.pin; if (!seen.has(k)) { seen.add(k); drivers.push(x); } };
            for (const pr of procs) for (const io of pr.io) add({ ref: pr.ref, pin: io.number, vdd: pr.vdd, vnom: pr.vnom });
            for (const x of Noeti.fw.deviceDrivers(circ)) add(x);
            for (const x of sim.drivers || []) add(x);
            const eng = new Noeti.LiveSim(circ, Object.assign({}, sim, { drivers }), {}, {}, { rampTime: 0 });
            eng.setDt(1e-5); eng.powerCycle(2e-3);
            for (let n = 0; n < steps; n++) eng.step();
            // one more step, iteration by iteration
            const ids = nodes.map(nm => eng.idx.get(nm));
            const trace = [];
            const t = eng.t + eng.dt, x = eng.x;
            for (let it = 0; it < 12; it++) {
              eng.assemble(t); eng.factor(); const xn = eng.xn; xn.set(eng.b); const sol = new Float64Array(eng.N);
              Noeti.__solve ? 0 : 0;
              trace.push(ids.map(i => i == null ? null : +x[i].toFixed(5)).join(' ') + ' lim=' + eng._limited);
              eng.step(); // advance (not exact iteration trace but shows state per step)
            }
            const opa = eng.els.filter(e => e.t === 'OPA' && /^U7/.test(e.name)).map(e => e.name + ' p=' + eng.x[e._p].toFixed(4) + ' n=' + eng.x[e._n].toFixed(4) + ' out=' + eng.x[e._out].toFixed(4) + ' vl=' + e._vl + ' vp=' + (e._vp >= 0 ? eng.x[e._vp].toFixed(3) : '-') + ' vn=' + (e._vn >= 0 ? eng.x[e._vn].toFixed(3) : '-'));
            return { trace, opa }; }""", [f, steps, nodes])
        print('\n'.join(res['trace'])); print('\n'.join(res['opa']))
        await br.close()
asyncio.run(main())

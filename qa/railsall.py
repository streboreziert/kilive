import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: railsall.py out.json [from:to] [steps] - every board's named rails vs the voltage their name states
async def main():
    outp = sys.argv[1]; sel = sys.argv[2] if len(sys.argv) > 2 else ''; steps = int(sys.argv[3]) if len(sys.argv) > 3 else 1500
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    boards = []
    for r in idx:
        for bd in r['boards']:
            v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
            boards.append((r['id'] + '/' + bd['id'], v['file']))
    if ':' in sel: a, b = sel.split(':'); boards = boards[int(a or 0):int(b) if b else None]
    elif sel: boards = [x for x in boards if x[0].split('/')[0] in sel.split(',')]
    res = {}
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--disable-gpu'])
        pg = await br.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1000)
        for name, f in boards:
            try:
                r = await pg.evaluate("""async ([f, steps]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
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
                    let ok = true; for (let n = 0; n < steps; n++) { if (!eng.step()) { ok = false; break; } if (rt) rt.step(eng.t, eng.dt); }
                    const nv = eng.netVoltages(); const rails = {};
                    for (const n of circ.nets) if (n.kind === 'power' && nv.has(n.name)) { const nom = Noeti.simtab.nominalOf(n.name); rails[n.name] = [+nv.get(n.name).toFixed(3), nom]; }
                    let imax = 0, who = ''; for (const e of eng.els) { const i = eng.current ? Math.abs(eng.current(e) || 0) : 0; if (i > imax) { imax = i; who = e.name; } }
                    return { ok, rails, sources: sim.sources.map(s => s.net + '=' + s.value), imax, who }; }""", [f, steps])
            except Exception as e:
                r = {'err': str(e)[:300]}
            res[name] = r
            bad = [k + ' ' + str(v[0]) + '/' + str(v[1]) for k, v in (r.get('rails') or {}).items() if v[1] and abs(v[1]) > 0.5 and abs(v[0] - v[1]) > 0.15 * abs(v[1])]
            print(name, 'ok' if r.get('ok') else 'FAIL', len(r.get('rails') or {}), 'off:', '; '.join(bad[:8]), r.get('err', ''), flush=True)
        await br.close()
    json.dump(res, open(outp, 'w'))
asyncio.run(main())

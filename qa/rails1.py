import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: rails1.py board-id [legacy] [steps] - every power rail's voltage, the sources, the regulators
async def main():
    sel = sys.argv[1]; legacy = len(sys.argv) > 2 and sys.argv[2] == 'legacy'; steps = int(sys.argv[3]) if len(sys.argv) > 3 else 1500
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
        res = await pg.evaluate("""async ([f, steps, legacy, extra]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
            Noeti.simtab._legacySources = legacy; let wb; try { wb = Noeti.simtab.wholeBoard(B); } finally { Noeti.simtab._legacySources = false; }
            const circ = wb.circuit, sim = wb.sim;
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
            const nv = eng.netVoltages(); const out = [];
            for (const n of circ.nets) if ((n.kind === 'power' || extra.includes(n.name)) && nv.has(n.name)) out.push(n.name + '=' + nv.get(n.name).toFixed(2));
            const regs = eng.els.filter(e => e.t === 'REG' || e.t === 'SWR' || e.t === 'LSW').map(e => e.t + ' ' + e.ref + ' in=' + (e._in >= 0 ? eng.x[e._in].toFixed(2) : '-') + ' out=' + (e._out >= 0 ? eng.x[e._out].toFixed(2) : '-') + ' en=' + (e._en >= 0 ? eng.x[e._en].toFixed(2) : '-') + ' on=' + (e._on ?? e.on ?? ''));
            return { ok, sources: sim.sources.map(s => s.net + '=' + s.value + (s.note ? ' (' + s.note + ')' : '')), rails: out, regs, notes: eng.notes.slice(0, 6) }; }""", [f, steps, legacy, sys.argv[4].split(',') if len(sys.argv) > 4 else []])
        print('ok', res['ok']); print('SOURCES', ' | '.join(res['sources'])); print('RAILS', ' '.join(res['rails'])); print('REGS', '\n  '.join(res['regs'])); print('NOTES', res['notes'])
        await br.close()
asyncio.run(main())

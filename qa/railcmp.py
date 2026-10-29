import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: railcmp.py [from:to | id,id] [steps]  - legacy source placement vs the current one: rails that differ
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    sel = sys.argv[1] if len(sys.argv) > 1 else ''
    steps = int(sys.argv[2]) if len(sys.argv) > 2 else 1200
    boards = []
    for r in idx:
        for bd in r['boards']:
            v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
            boards.append((r['id'] + '/' + bd['id'], v['file'], r['id']))
    if ':' in sel: a, b = sel.split(':'); boards = boards[int(a or 0):int(b) if b else None]
    elif sel: ids = sel.split(','); boards = [x for x in boards if x[2] in ids or x[0] in ids]
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--disable-gpu'])
        pg = await br.new_page(viewport={'width': 1200, 'height': 800})
        errs = []
        pg.on('pageerror', lambda e: errs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1200)
        for name, f, _ in boards:
            try:
                res = await pg.evaluate("""async ([f, steps]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
                  const run = legacy => {
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
                    const nv = eng.netVoltages(); const rails = {};
                    for (const n of circ.nets) if (n.kind === 'power' && nv.has(n.name)) rails[n.name] = +nv.get(n.name).toFixed(2);
                    return { ok, ff: (sim.fetForce || []).map(f => f.name), ps: (sim.powerSwitches || []).map(p => p.name + ':' + p.ctl + ':' + p.rail), sup: eng.supplies().map(s => s.net + '=' + s.value), rails, regs: eng.els.filter(e => e.t === 'REG').map(e => e.ref + ':' + (e._out >= 0 ? eng.x[e._out].toFixed(2) : '?') + '/' + e.vout) };
                  };
                  return { a: run(true), b: run(false) }; }""", [f, steps])
                a, b = res['a'], res['b']
                diffs = [f"{k}: {a['rails'][k]} -> {b['rails'].get(k)}" for k in a['rails'] if k in b['rails'] and abs(a['rails'][k] - b['rails'][k]) > 0.3]
                lost = sorted(set(a['sup']) - set(b['sup'])); new = sorted(set(b['sup']) - set(a['sup']))
                up_a = sum(1 for v in a['rails'].values() if abs(v) > 0.5); up_b = sum(1 for v in b['rails'].values() if abs(v) > 0.5)
                flag = '  <<<' if up_b < up_a else ''
                print(f"{name:52s} rails up {up_a}->{up_b}/{len(a['rails'])} ok {a['ok']}/{b['ok']}{flag}")
                if lost or new: print('   sources -' + ' '.join(lost) + '  +' + ' '.join(new))
                if b.get('ps'): print('   switches ' + ' '.join(b['ps'][:8]) + (' forced ' + ' '.join(b['ff'][:8]) if b.get('ff') else ''))
                for d in diffs[:14]: print('     ' + d)
                if len(diffs) > 14: print(f'     ... {len(diffs) - 14} more')
            except Exception as e:
                print('EXC', name, str(e)[:300])
        print('\n'.join(errs[:20]) or 'NO ERRORS')
        await br.close()
asyncio.run(main())

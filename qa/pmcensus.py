import asyncio, sys, json, time
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
# usage: pmcensus.py [board-id-filter,...] [steps]
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    only = sys.argv[1].split(',') if len(sys.argv) > 1 and sys.argv[1] else None
    steps = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        errs = []
        pg.on('pageerror', lambda e: errs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: errs.append(f'{m.type}: {m.text[:300]}') if m.type in ('error', 'warning') and 'TUNNEL' not in m.text and 'fonts' not in m.text and '404' not in m.text else None)
        await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(1500)
        out = []
        for r in idx:
            if only and r['id'] not in only: continue
            for bd in r['boards']:
                v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
                try:
                    res = await pg.evaluate("""async ([f, steps]) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
                      const t0 = performance.now();
                      const wb = Noeti.simtab.wholeBoard(B);
                      const t1 = performance.now();
                      const circ = wb.circuit, sim = wb.sim;
                      const kinds = {}, chips = {}, fams = {};
                      for (const c of circ.components) if (c.type === 'composite') kinds[c.kind] = (kinds[c.kind] || 0) + 1;
                      for (const ch of sim.chips) { const k = ch.model + (ch.boost ? '/boost' : ch.series ? '/charger' : ''); chips[k] = (chips[k] || 0) + 1; }
                      for (const m of Object.values(sim.models || {})) fams[m.family] = (fams[m.family] || 0) + 1;
                      const procs = Noeti.fw.detect(circ); const pset = new Set(procs.map(p => p.ref));
                      const modeled = new Set(sim.chips.map(c => c.ref)); for (const k of Object.keys(sim.models || {})) modeled.add(k);
                      const devRefs = new Set(); for (const c of circ.components) { let s = null; try { s = Noeti.devices.match(c); } catch (e) {} if (s) devRefs.add(c.ref); }
                      const bare = circ.components.filter(c => (c.type === 'ic' || c.type === 'other') && !modeled.has(c.ref) && !pset.has(c.ref) && !devRefs.has(c.ref)).map(c => c.ref + ':' + (c.value || '').slice(0, 22));
                      const types = {}; for (const c of circ.components) types[c.type] = (types[c.type] || 0) + 1;
                      // engine: processors + IO expanders + behaviour drivers; behaviours stepped by the runtime
                      const drivers = []; const seen = new Set(); const add = x => { const k = x.ref + '\\u0000' + x.pin; if (!seen.has(k)) { seen.add(k); drivers.push(x); } };
                      for (const pr of procs) for (const io of pr.io) add({ ref: pr.ref, pin: io.number, vdd: pr.vdd, vnom: pr.vnom });
                      for (const x of Noeti.fw.deviceDrivers(circ)) add(x);
                      const run = (withPm) => {
                        const dr = withPm ? drivers.concat((sim.drivers || []).filter(x => !seen.has(x.ref + '\\u0000' + x.pin))) : drivers;
                        const eng = new Noeti.LiveSim(circ, Object.assign({}, sim, { drivers: dr }), {}, {}, { rampTime: 0 });
                        const L = { engine: eng, base: { circuit: circ }, gen: 1, forced: new Map() };
                        const rt = withPm && (sim.behaviours || []).length ? Noeti.partModels.runtime(L, sim.behaviours) : null;
                        eng.setDt(1e-5); eng.powerCycle(2e-3);
                        let ok = true, n = 0; const ta = performance.now();
                        for (; n < steps; n++) { if (!eng.step()) { ok = false; break; } if (rt) rt.step(eng.t, eng.dt); }
                        const ms = performance.now() - ta;
                        const fl = eng.floatingNodes(); let nf = 0; for (const [nd] of eng.nodeNet) { const i = eng.nodeIndex(nd); if (i >= 0 && fl[i]) nf++; }
                        let nan = 0; for (let i = 0; i < eng.N; i++) if (!isFinite(eng.x[i])) nan++;
                        const sup = eng.supplies().map(s => s.net + '=' + s.value).slice(0, 6);
                        const regs = eng.els.filter(e => e.t === 'REG').map(e => e.ref + (e.boost ? '(b)' : e.charger ? '(c)' : '') + ':' + (e._out >= 0 ? eng.x[e._out].toFixed(2) : '?') + '/' + e.vout);
                        return { ok, n, ms: Math.round(ms), floating: nf, nets: eng.nodeNet.size, nan, notes: eng.notes.length, notesTxt: eng.notes.slice(0, 4), sup, regs: regs.slice(0, 8), info: eng.info(), beh: rt ? rt.items.length : 0 };
                      };
                      const a = run(false), b = run(true);
                      return { buildMs: Math.round(t1 - t0), types, kinds, chips, fams, bare: bare.slice(0, 40), nbare: bare.length, procs: procs.length, base: a, pm: b };
                    }""", [v['file'], steps])
                    res['board'] = r['id'] + '/' + bd['id']
                    out.append(res)
                    a, bb = res['base'], res['pm']
                    print(f"{res['board']:55s} build {res['buildMs']}ms  float {a['floating']}->{bb['floating']}/{bb['nets']}  ok {a['ok']}/{bb['ok']} nan {bb['nan']} steps {bb['ms']}ms beh {bb['beh']} bare {res['nbare']}", flush=True)
                except Exception as e:
                    print('EXC', r['id'], bd['id'], str(e)[:400], flush=True)
        json.dump(out, open('/tmp/claude-0/qa/pmcensus.json', 'w'))
        print('\n'.join(errs[:40]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())

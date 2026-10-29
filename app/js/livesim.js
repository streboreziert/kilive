/* KiLive — live circuit simulation: the Debug AI element models on a sparse, incrementally stepped solver
   (modified nodal analysis, backward Euler, Newton; Markowitz ordering compiled into a straight-line LU program). */
(function (root) {
  'use strict';
  const N = root.Noeti = root.Noeti || {};
  const P2 = () => root.DS2K_P2, OPT = () => root.DS2K_OPT, SIMX = () => root.DS2K_SIM;

  const UNIT = { resistor: 'ohm', thermistor: 'ohm', potentiometer: 'ohm', capacitor: 'F', capacitor_polarized: 'F', inductor: 'H' };
  const DIODES = { diode: 'DGEN', schottky_diode: 'DSCH', zener_diode: 'DZ', tvs_diode: 'DZ', led: 'DLED' };
  // DIR: an infrared LED (optocouplers, about 1.2 V); DIDEAL: an ideal-diode controller's switch (tens of mV)
  const MODELS = { DGEN: { is: 1e-14, n: 1, rs: 0.05 }, DSCH: { is: 1e-6, n: 1.05, rs: 0.03 }, DLED: { is: 1e-18, n: 2, rs: 5 }, DZ: { is: 1e-14, n: 1, rs: 0.5 }, DIR: { is: 1e-20, n: 1.2, rs: 1 }, DIDEAL: { is: 1e-9, n: 0.2, rs: 0.01 } };
  const GND_RX = /^(A|D|P|S)?GND\d*$|^VSS$|^0V?$|^EARTH$/i;
  const VT = 0.02585;

  // ------------------------------------------------------------------ elements (with the part pin behind every terminal)
  function buildElements(circuit, simIn, vals, alias) {
    const sim = SIMX().cleanSim(simIn, circuit);
    const els = [], notes = [];
    const netOf = new Map(), nodeNet = new Map(), used = new Set(['0']);
    for (const n of circuit.nets) {
      let nm;
      if (n.kind === 'ground' || GND_RX.test(String(n.name).split('/').pop())) nm = '0';
      else {
        const base = 'n_' + String(n.name).replace(/[^A-Za-z0-9_]/g, '_');
        nm = base; let i = 2;
        while (used.has(nm)) nm = base + '_' + i++;
        used.add(nm);
      }
      n._node = nm;
      if (nm !== '0') nodeNet.set(nm, n.name);
      for (const x of n.nodes) netOf.set(x.ref + '\u0000' + x.pin, nm);
    }
    const at = (ref, pin) => netOf.get(ref + '\u0000' + pin) || ('nc_' + ref + '_' + String(pin).replace(/[^A-Za-z0-9]/g, ''));
    const refOf = r => { const k = String(r || '').trim(); return (alias && (alias[k] || alias[k.toUpperCase()])) || k.toUpperCase(); };
    const num = (x, dflt) => {
      if (typeof x === 'number') return x;
      if (x === undefined || x === null || x === '') return dflt;
      try {
        const v = OPT().evaluate(String(x), name => {
          for (const k of Object.keys(vals || {})) if (k.toLowerCase() === name.toLowerCase()) return vals[k];
          const c = circuit.components.find(q => q.ref === refOf(name));
          if (c) { const pv = P2().parseValue(c.value, UNIT[c.type]); if (pv !== null) return pv; }
          throw new Error('unknown name ' + name);
        });
        return typeof v === 'number' && isFinite(v) ? v : dflt;
      } catch (e) { notes.push("Could not work out '" + x + "': " + e.message); return dflt; }
    };
    const wave = s => {
      const k = String(s.kind || 'dc').toLowerCase();
      if (k === 'pulse' || k === 'clock') return { kind: 'pulse', low: num(s.low, 0), high: num(s.high !== undefined ? s.high : s.value, 3.3), freq: num(s.freq, 1000), duty: Math.min(0.99, Math.max(0.01, num(s.duty, 0.5))) };
      if (k === 'sine') return { kind: 'sine', offset: num(s.offset, 0), ampl: num(s.ampl !== undefined ? s.ampl : s.value, 1), freq: num(s.freq, 1000) };
      return { kind: 'dc', value: num(s.value, 0) };
    };
    // each part's pins on ground: return currents of chip models leave through them
    const gndOf = new Map();
    for (const n of circuit.nets) if (n._node === '0') for (const x of n.nodes) { let a = gndOf.get(x.ref); if (!a) gndOf.set(x.ref, (a = [])); if (!a.includes(String(x.pin))) a.push(String(x.pin)); }
    const gndT = ref => { const a = gndOf.get(ref); return a && a.length ? a.map(p => [ref, p]) : null; };
    const tps = list => { const a = (list || []).filter(q => Array.isArray(q) && q.length >= 2).map(q => [String(q[0]), String(q[1])]); return a.length ? a : null; };
    const driven = new Map();
    const drive = (nd, who) => { if (nd === '0') { notes.push(who + ' would drive ground - skipped'); return false; } if (driven.has(nd)) { notes.push(who + ' skipped: already driven by ' + driven.get(nd)); return false; } driven.set(nd, who); return true; };
    const T = (ref, pin) => [ref, String(pin)];

    for (const c of circuit.components) {
      if (c.dnp) continue;
      const p = x => at(c.ref, x);
      const t = c.type;
      if (UNIT[t] && t !== 'potentiometer') {
        let v = P2().parseValue(c.value, UNIT[t]);
        // an inductor without a value still carries the current (a converter's coil marked just "INDUCTOR"): assume a typical one
        if ((v === null || !(v > 0)) && t === 'inductor') { v = 4.7e-6; notes.push(c.ref + ": no usable value ('" + c.value + "') - 4.7 µH assumed"); }
        if (v === null || !(v > 0)) { notes.push(c.ref + ": no usable value ('" + c.value + "') - left out"); continue; }
        const pa = t === 'capacitor_polarized' ? '+' : '1', pb = t === 'capacitor_polarized' ? '-' : '2';
        els.push({ t: t === 'inductor' ? 'L' : t.startsWith('capacitor') ? 'C' : 'R', name: c.ref, ref: c.ref, a: p(pa), b: p(pb), v, pins: { a: T(c.ref, pa), b: T(c.ref, pb) } });
      } else if (t === 'potentiometer') {
        const v = P2().parseValue(c.value, 'ohm') || 10e3;
        els.push({ t: 'R', name: c.ref + ':a', ref: c.ref, pot: 'a', total: v, a: p('1'), b: p('W'), v: v / 2, pins: { a: T(c.ref, '1'), b: T(c.ref, 'W') } },
          { t: 'R', name: c.ref + ':b', ref: c.ref, pot: 'b', total: v, a: p('W'), b: p('3'), v: v / 2, pins: { a: T(c.ref, 'W'), b: T(c.ref, '3') } });
      } else if (t === 'ferrite_bead' || t === 'fuse') els.push({ t: 'R', name: c.ref, ref: c.ref, a: p('1'), b: p('2'), v: t === 'ferrite_bead' ? 0.1 : 0.01, pins: { a: T(c.ref, '1'), b: T(c.ref, '2') } });
      else if (t === 'switch' || t === 'jumper') {
        const sw = sim.switches.find(x => refOf(x.ref) === c.ref);
        const closed = sw ? !!sw.closed : c.closed != null ? !!c.closed : t === 'jumper';
        els.push({ t: 'R', name: c.ref, ref: c.ref, sw: true, key: '', jumper: t === 'jumper', closed, a: p('1'), b: p('2'), v: closed ? 0.01 : 1e9, pins: { a: T(c.ref, '1'), b: T(c.ref, '2') } });
      } else if (DIODES[t]) {
        const m = DIODES[t];
        const vx = /^(\d{1,2})V(\d{1,2})\b/i.exec(String(c.value || '').trim());
        let bv = m === 'DZ' ? ((vx ? parseFloat(vx[1] + '.' + vx[2]) : 0) || P2().parseValue(c.value, '') || parseFloat((/(\d+(?:\.\d+)?)\s*V/i.exec(c.value + ' ' + (c.rating || '')) || [])[1]) || 0) : 0;
        if (t === 'tvs_diode') {
          // a TVS clamps above its stand-off voltage: SMBJ33A, P6KE15CA, ESD5B5.0, PESD5V0, SMF5.0A; unknown: well above the rail it guards
          const u = String(c.value || '').toUpperCase();
          const mt = /(?:SM[ABCDF]J|SMF|P[46]KE|1\.5KE|SMAJ|SMBJ|SMCJ|TVS)(\d+(?:\.\d+)?)/.exec(u) || /SM[ABC]\d+K(\d+(?:\.\d+)?)/.exec(u) || /ESD\d*[BU](\d+(?:[._]\d+)?)/.exec(u) || /PESD(\d+)V(\d)/.exec(u) || /(\d+(?:\.\d+)?)\s*V/.exec(u);
          const rail = Math.max(...[p('A'), p('K')].map(nd => Math.abs((N.simtab && N.simtab.voltOf ? N.simtab.voltOf(nodeNet.get(nd) || '') : 0) || 0)), 0);
          bv = mt ? parseFloat(mt[2] != null && /PESD/.test(mt[0]) ? mt[1] + '.' + mt[2] : String(mt[1]).replace('_', '.')) * 1.15 : 0;
          if (!(bv > rail)) bv = Math.max(rail * 1.3, 5.5);
        } else if (m === 'DZ' && !(bv > 0)) bv = 5.1;
        els.push({ t: 'D', name: c.ref, ref: c.ref, a: p('A'), b: p('K'), model: m, bv, bidir: t === 'tvs_diode', pins: { a: T(c.ref, 'A'), b: T(c.ref, 'K') } });
      } else if (t === 'bjt_npn' || t === 'bjt_pnp') {
        // a digital (pre-biased) transistor: its base resistors are inside the package
        const dg = N.partModels && N.partModels.digital ? N.partModels.digital(c.value + ' ' + (c.description || '')) : null;
        if (dg) {
          const bi = 'nc_' + c.ref + '_Bint';
          els.push({ t: 'R', name: c.ref + ':r1', ref: c.ref, a: p('B'), b: bi, v: dg.r1, pins: { a: T(c.ref, 'B'), b: null } }, { t: 'R', name: c.ref + ':r2', ref: c.ref, a: bi, b: p('E'), v: dg.r2, pins: { a: null, b: T(c.ref, 'E') } });
          els.push({ t: 'Q', name: c.ref, ref: c.ref, c: p('C'), b: bi, e: p('E'), pnp: t === 'bjt_pnp', pins: { c: T(c.ref, 'C'), b: null, e: T(c.ref, 'E') } });
        } else els.push({ t: 'Q', name: c.ref, ref: c.ref, c: p('C'), b: p('B'), e: p('E'), pnp: t === 'bjt_pnp', pins: { c: T(c.ref, 'C'), b: T(c.ref, 'B'), e: T(c.ref, 'E') } });
      }
      else if (t === 'mosfet_n' || t === 'mosfet_p') els.push({ t: 'M', name: c.ref, ref: c.ref, d: p('D'), g: p('G'), s: p('S'), pch: t === 'mosfet_p', pins: { d: T(c.ref, 'D'), g: T(c.ref, 'G'), s: T(c.ref, 'S') } });
      else if (t === 'composite' && Array.isArray(c.sub)) composite(c, p);
    }
    // multi-pin passives from the part model library: switches, arrays, dual diodes and transistors, relays, batteries …
    function composite(c, p) {
      c.sub.forEach((s, i) => {
        const name = c.ref + '#' + i;
        const a = s.a != null ? p(String(s.a)) : null, b = s.b != null ? p(String(s.b)) : null;
        const pa = s.a != null ? T(c.ref, s.a) : null, pb = s.b != null ? T(c.ref, s.b) : null;
        switch (s.t) {
          case 'R': { const v = s.v > 0 ? s.v : P2().parseValue(String(s.value || ''), 'ohm'); if (v > 0) els.push({ t: 'R', name, ref: c.ref, a, b, v, pins: { a: pa, b: pb } }); else notes.push(c.ref + ': no usable value for part ' + (i + 1)); break; }
          case 'C': { const v = s.v > 0 ? s.v : P2().parseValue(String(s.value || ''), 'F'); if (v > 0) els.push({ t: 'C', name, ref: c.ref, a, b, v, pins: { a: pa, b: pb } }); break; }
          case 'SW': {
            const key = s.key || '';
            const sw = sim.switches.find(x => refOf(x.ref) === c.ref && (x.key || '') === key);
            const closed = sw ? !!sw.closed : !!s.closed, ron = s.ron || 0.01;
            els.push({ t: 'R', name, ref: c.ref, sw: true, key, spdt: !!s.spdt, throw: !!s.throw, ctl: s.ctl != null ? c.ref + '#' + s.ctl : null, thr: s.thr || 1e-3, off: s.off || 5e-4, inv: !!s.inv, ron, closed, a, b, v: closed ? ron : 1e9, pins: { a: pa, b: pb } });
            break;
          }
          case 'D': case 'LED': {
            const m = s.t === 'LED' ? 'DLED' : MODELS[s.model] ? s.model : 'DGEN';
            els.push({ t: 'D', name, ref: c.ref, a, b, model: m, bv: m === 'DZ' ? (s.bv || 5.1) : 0, led: s.t === 'LED', col: s.col || null, pins: { a: pa, b: pb } });
            break;
          }
          case 'M': els.push({ t: 'M', name, ref: c.ref, d: p(String(s.d)), g: p(String(s.g)), s: p(String(s.s)), pch: !!s.pch, pins: { d: T(c.ref, s.d), g: T(c.ref, s.g), s: T(c.ref, s.s) } }); break;
          case 'Q': els.push({ t: 'Q', name, ref: c.ref, c: p(String(s.c)), b: p(String(s.b)), e: p(String(s.e)), pnp: !!s.pnp, pins: { c: T(c.ref, s.c), b: T(c.ref, s.b), e: T(c.ref, s.e) } }); break;
          case 'BAT': {
            // a cell: a source with its internal resistance, between its + and - pins
            if (a && a !== '0' && !/^nc_/.test(a) && drive(a, c.ref + ' battery')) els.push({ t: 'V', name: c.ref + ':bat', ref: c.ref, supply: true, battery: true, net: nodeNet.get(a) || a, a, b: b || '0', w: { kind: 'dc', value: s.v || 3.7 }, rs: s.rs || 0.1, pins: { a: pa, b: pb } });
            break;
          }
        }
      });
    }
    const netNode = new Map(circuit.nets.map(n => [String(n.name).toUpperCase(), n._node]));
    const has = ref => circuit.components.some(c => c.ref === ref && !c.dnp);
    for (const ch of sim.chips) {
      const ref = refOf(ch.ref);
      if (!has(ref)) continue;
      const m = String(ch.model || '').toLowerCase();
      const pin = k => (ch[k] !== undefined && ch[k] !== '' ? at(ref, String(ch[k])) : null);
      const tp = k => (ch[k] !== undefined && ch[k] !== '' ? T(ref, ch[k]) : null);
      if (m === 'regulator') {
        // the output: a pin of the chip, or a net (a boost converter's output after its diode)
        const o = ch.outNet ? netNode.get(String(ch.outNet).toUpperCase()) || null : pin('out');
        const outPins = ch.outAt ? T(refOf(ch.outAt[0]), ch.outAt[1]) : tp('out');
        const base = { t: 'REG', name: ref, ref, in: pin('in'), gnd: pin('gnd') || '0', en: pin('en'), enLow: !!ch.enLow, vout: num(ch.vout, 3.3), drop: num(ch.dropout, 0.3), ilim: num(ch.ilim, 0), boost: !!ch.boost, sw: !!ch.switching, ratio: ch.boost ? Math.max(1, num(ch.ratio, num(ch.vout, 5) / 3.7 / 0.9)) : 1 };
        if (!o || !pin('in') || o === '0') { if (ch.outNet) notes.push(ref + ': output net ' + ch.outNet + ' not found'); }
        else if (ch.series) {
          // a charger: the regulated voltage reaches the battery through a diode, so the battery is never discharged into it
          const io = 'chg_' + ref.replace(/[^A-Za-z0-9]/g, '_');
          if (drive(io, ref + ' charger')) els.push(Object.assign(base, { out: io, charger: true, pins: { in: tp('in'), out: null, gnd: tp('gnd') } }), { t: 'D', name: 'dchg_' + ref, ref, a: io, b: o, model: 'DIDEAL', bv: 0, pins: { a: null, b: outPins } });
        } else if (drive(o, ref + (ch.boost ? ' boost converter' : ' regulator'))) els.push(Object.assign(base, { out: o, pins: { in: tp('in'), out: outPins, gnd: tp('gnd') } }));
      }
      else if (m === 'switch' || m === 'loadswitch') { const a = pin('in'), b = pin('out'); if (a && b) els.push({ t: 'LSW', name: ref, ref, a, b, en: pin('en'), gnd: pin('gnd') || '0', enLow: !!ch.enLow, ron: num(ch.ron, 0.08), ron0: num(ch.ron, 0.08), ilim: num(ch.ilim, 2), v: num(ch.ron, 0.08), on: true, pins: { a: tp('in'), b: tp('out') } }); }
      else if (m === 'opamp') {
        const units = Array.isArray(ch.units) ? ch.units : [ch];
        units.forEach((u, i) => {
          const o = at(ref, String(u.out));
          if (u.out !== undefined && drive(o, ref + ' op-amp')) els.push({ t: 'OPA', name: ref + (i ? '_' + (i + 1) : ''), ref, p: at(ref, String(u.inp)), n: at(ref, String(u.inn)), out: o, vp: pin('vp'), vn: pin('vn') || '0', pins: { out: T(ref, u.out), p: T(ref, u.inp), n: T(ref, u.inn), vp: tp('vp'), vn: tp('vn') || gndT(ref) } });
        });
      }
      else if (m === 'switcher' || m === 'buck') {
        const o = pin('sw'), fb = pin('fb');
        if (!fb || !o || !pin('in')) notes.push(ref + ': the buck model needs in, sw and fb pins');
        else if (drive(o, ref + ' switch node')) els.push({ t: 'SWR', name: ref, ref, in: pin('in'), sw: o, fb, gnd: pin('gnd') || '0', en: pin('en'), enLow: !!ch.enLow, ss: pin('ss'), vref: num(ch.vref, 0.8), freq: num(ch.freq, 500e3), fc: num(ch.fc, 300), dmax: num(ch.dmax, 0.95), iss: num(ch.iss, 2e-6), ven: num(ch.ven, 1.1), ron: num(ch.ron, 0.1), ilim: num(ch.ilim, 4), pins: { in: tp('in'), sw: tp('sw'), gnd: tp('gnd'), ss: tp('ss') } });
      } else if (m === 'timer555' || m === '555') {
        const o = pin('out');
        if (o && pin('vcc') && drive(o, ref + ' 555 output')) els.push({ t: 'T555', name: ref, ref, vcc: pin('vcc'), gnd: pin('gnd') || '0', trig: pin('trig'), thr: pin('thr'), dis: pin('dis'), out: o, cont: pin('cont') || ref + '_cont', reset: pin('reset'), pins: { out: tp('out'), vcc: tp('vcc'), gnd: tp('gnd') || gndT(ref), dis: tp('dis'), cont: tp('cont') } });
      } else notes.push(ref + ": unknown chip model '" + ch.model + "'");
    }
    for (const s of sim.standins) {
      const ref = refOf(s.ref);
      if (!has(ref)) continue;
      const nd = at(ref, String(s.pin));
      const k = String(s.kind || 'dc').toLowerCase();
      if (k === 'open') continue;
      if (k === 'load') { els.push({ t: 'R', name: 'load_' + ref + '_' + s.pin, ref, load: true, a: nd, b: '0', v: Math.max(1e-3, num(s.value !== undefined ? s.value : s.r, 10e3)), pins: { a: T(ref, s.pin), b: gndT(ref) } }); continue; }
      if (drive(nd, ref + ' pin ' + s.pin)) els.push({ t: 'V', name: ref + '.' + s.pin, ref, standin: true, a: nd, b: '0', w: wave(s), rs: num(s.r, 0), pins: { a: T(ref, s.pin), b: gndT(ref) } });
    }
    // processor pins that code can drive (high-impedance until a program runs)
    for (const d of (simIn && simIn.drivers) || []) {
      const ref = refOf(d.ref);
      if (!has(ref)) continue;
      const nd = at(ref, String(d.pin));
      if (nd === '0' || /^nc_/.test(nd)) continue;
      const vn = d.vdd != null ? at(ref, String(d.vdd)) : null;
      els.push({ t: 'DRV', name: 'io_' + ref + '_' + d.pin, ref, pin: String(d.pin), a: nd, vdd: vn && vn !== '0' && !/^nc_/.test(vn) ? vn : null, vnom: d.vnom || 3.3, mode: 'z', g: 1e-9, kh: 0, pins: { a: T(ref, d.pin), vdd: d.vdd != null ? T(ref, d.vdd) : null, gnd: gndT(ref) } });
    }
    for (const s of sim.sources) {
      const n = circuit.nets.find(x => String(x.name).toUpperCase() === String(s.net || '').toUpperCase());
      if (!n) { notes.push("Source on '" + s.net + "': no such net"); continue; }
      if (driven.has(n._node)) continue;
      // the pins the supply comes in on (a connector, an unmodelled converter) and returns through, when known
      if (drive(n._node, 'supply ' + n.name)) els.push({ t: 'V', name: 'src:' + n.name, net: n.name, supply: true, a: n._node, b: '0', w: wave(s), rs: 0, pins: { a: tps(s.pins), b: tps(s.gnd) } });
    }
    for (const l of sim.loads) {
      const n = circuit.nets.find(x => String(x.name).toUpperCase() === String(l.net || '').toUpperCase());
      if (!n) { notes.push("Load on '" + l.net + "': no such net"); continue; }
      els.push({ t: 'R', name: 'load:' + n.name, net: n.name, load: true, a: n._node, b: '0', v: Math.max(1e-3, num(l.value, 1e3)), pins: {} });
    }
    let fmax = 0;
    for (const e of els) if (e.t === 'V' && e.w.freq) fmax = Math.max(fmax, e.w.freq);
    for (const n of circuit.nets) delete n._node;
    return { els, notes, sim, fmax, nodeNet };
  }

  // internal nodes and helper resistors, as the Debug AI solver does it
  function expand(els) {
    const out = [];
    for (const e of els) {
      if (e.t === 'V' && e.rs > 0) { out.push(Object.assign({}, e, { a: e.a + '~i', rs: 0, pins: { b: e.pins.b } }), { t: 'R', name: 'rs_' + e.name, ref: e.ref, a: e.a + '~i', b: e.a, v: e.rs, pins: { b: e.pins.a } }); }
      else if (e.t === 'OPA') out.push(Object.assign({}, e, { out: e.out + '~o' + e.name }), { t: 'R', name: 'ro_' + e.name, ref: e.ref, a: e.out + '~o' + e.name, b: e.out, v: 10, pins: { b: e.pins.out } });
      else if (e.t === 'D' && MODELS[e.model].rs) out.push(Object.assign({}, e, { a: e.a + '~d' + e.name, pins: { b: e.pins.b } }), { t: 'R', name: 'rd_' + e.name, ref: e.ref, a: e.a, b: e.a + '~d' + e.name, v: MODELS[e.model].rs, pins: { a: e.pins.a } });
      else if (e.t === 'T555') out.push(Object.assign({}, e, { out: e.out + '~o' + e.name }), { t: 'R', name: 'ro_' + e.name, ref: e.ref, a: e.out + '~o' + e.name, b: e.out, v: 10, pins: { b: e.pins.out } },
        { t: 'R', name: 'rc1_' + e.name, ref: e.ref, a: e.vcc, b: e.cont, v: 5000, pins: { a: e.pins.vcc, b: e.pins.cont } }, { t: 'R', name: 'rc2_' + e.name, ref: e.ref, a: e.cont, b: e.gnd, v: 10000, pins: { a: e.pins.cont, b: e.pins.gnd } });
      else if ((e.t === 'SWR' || e.t === 'REG' || e.t === 'LSW') && e.en) out.push(e, { t: 'R', name: 'ren_' + e.name, ref: e.ref, a: e.enLow ? (e.gnd || '0') : (e.t === 'LSW' ? e.a : e.in), b: e.en, v: 5e6, pins: {} });
      else out.push(e);
    }
    return out;
  }

  // ------------------------------------------------------------------ sparse LU compiled from a Markowitz ordering
  function analyze(n, rowOf, colOf, vals) {
    const rows = Array.from({ length: n }, () => new Map());
    const cols = Array.from({ length: n }, () => []);
    const v = Array.from(vals);
    const rowOfS = Array.from(rowOf), colOfS = Array.from(colOf);
    for (let s = 0; s < rowOf.length; s++) { rows[rowOf[s]].set(colOf[s], s); cols[colOf[s]].push(rowOf[s]); }
    const aR = new Uint8Array(n).fill(1), aC = new Uint8Array(n).fill(1);
    const rc = new Int32Array(n), cc = new Int32Array(n);
    for (let i = 0; i < n; i++) rc[i] = rows[i].size;
    for (let j = 0; j < n; j++) cc[j] = cols[j].length;
    const pivRow = new Int32Array(n), pivCol = new Int32Array(n), pivSlot = new Int32Array(n);
    const Lptr = [0], Lrow = [], Lslot = [], Uptr = [0], Ucol = [], Uslot = [], upd = [];
    let singular = 0;
    const activeCols = new Set(Array.from({ length: n }, (_, j) => j));
    for (let k = 0; k < n; k++) {
      let best = null;
      for (const c of activeCols) {
        let cmax = 0;
        for (const r of cols[c]) if (aR[r]) { const a = Math.abs(v[rows[r].get(c)]); if (a > cmax) cmax = a; }
        if (cmax === 0) continue;
        const thr = cmax * 1e-3;
        for (const r of cols[c]) {
          if (!aR[r]) continue;
          const a = Math.abs(v[rows[r].get(c)]);
          if (a < thr) continue;
          const cost = (rc[r] - 1) * (cc[c] - 1);
          if (!best || cost < best.cost || (cost === best.cost && ((r === c && best.r !== best.c) || (((r === c) === (best.r === best.c)) && a > best.a)))) best = { r, c, cost, a };
        }
        if (best && best.cost === 0) break;
      }
      if (!best) {
        // structurally or numerically singular: pin a remaining row/col pair with a tiny pivot
        singular++;
        let r = 0, c = 0;
        while (!aR[r]) r++;
        c = [...activeCols][0];
        let s = rows[r].get(c);
        if (s === undefined) { s = v.length; v.push(0); rowOfS.push(r); colOfS.push(c); rows[r].set(c, s); cols[c].push(r); rc[r]++; cc[c]++; }
        v[s] = v[s] || 1e-18;
        best = { r, c };
      }
      const { r, c } = best;
      const ps = rows[r].get(c);
      pivRow[k] = r; pivCol[k] = c; pivSlot[k] = ps;
      const pv = v[ps];
      const U = [];
      for (const [j, s] of rows[r]) if (j !== c && aC[j]) { U.push(j, s); Ucol.push(j); Uslot.push(s); }
      Uptr.push(Ucol.length);
      for (const i of cols[c]) {
        if (!aR[i] || i === r) continue;
        const ls = rows[i].get(c);
        const m = v[ls] / pv;
        v[ls] = m;
        Lrow.push(i); Lslot.push(ls);
        for (let q = 0; q < U.length; q += 2) {
          const j = U[q];
          let t = rows[i].get(j);
          if (t === undefined) { t = v.length; v.push(0); rowOfS.push(i); colOfS.push(j); rows[i].set(j, t); cols[j].push(i); rc[i]++; cc[j]++; }
          v[t] -= m * v[U[q + 1]];
          upd.push(t);
        }
      }
      Lptr.push(Lrow.length);
      aR[r] = 0; aC[c] = 0; activeCols.delete(c);
      for (const [j] of rows[r]) if (aC[j]) cc[j]--;
      for (const i of cols[c]) if (aR[i]) rc[i]--;
    }
    return {
      n, nSlots: v.length, pivRow, pivCol, pivSlot, singular,
      Lptr: Int32Array.from(Lptr), Lrow: Int32Array.from(Lrow), Lslot: Int32Array.from(Lslot),
      Uptr: Int32Array.from(Uptr), Ucol: Int32Array.from(Ucol), Uslot: Int32Array.from(Uslot), upd: Int32Array.from(upd),
    };
  }
  function refactor(P, v) {
    const { n, pivSlot, Lptr, Lslot, Uptr, Uslot, upd } = P;
    let t = 0;
    for (let k = 0; k < n; k++) {
      const p = v[pivSlot[k]];
      if (!(Math.abs(p) > 1e-30) || !isFinite(p)) return false;
      const inv = 1 / p;
      const u0 = Uptr[k], u1 = Uptr[k + 1], nu = u1 - u0;
      for (let l = Lptr[k]; l < Lptr[k + 1]; l++) {
        const s = Lslot[l];
        const m = (v[s] *= inv);
        if (m === 0) { t += nu; continue; }
        for (let u = u0; u < u1; u++) v[upd[t++]] -= m * v[Uslot[u]];
      }
    }
    return true;
  }
  function solve(P, v, b, x) {
    const { n, pivRow, pivCol, pivSlot, Lptr, Lrow, Lslot, Uptr, Ucol, Uslot } = P;
    for (let k = 0; k < n; k++) {
      const br = b[pivRow[k]];
      if (br !== 0) for (let l = Lptr[k]; l < Lptr[k + 1]; l++) b[Lrow[l]] -= v[Lslot[l]] * br;
    }
    for (let k = n - 1; k >= 0; k--) {
      let s = b[pivRow[k]];
      for (let u = Uptr[k]; u < Uptr[k + 1]; u++) s -= v[Uslot[u]] * x[Ucol[u]];
      x[pivCol[k]] = s / v[pivSlot[k]];
    }
  }

  // ------------------------------------------------------------------ device physics (from the Debug AI solver)
  const ZKNEE = 0.0259 * Math.log(1e-3 / 1e-14);
  const RSINK = 300;   // Ω per amp a regulator's output rises by when something pushes current back into it
  // a power MOSFET's body diode: soft (about 0.8 V at 1 mA), which also keeps Newton calm where it sits at its knee
  const BODY_IS = 1e-10, BODY_N = 2;
  const VCRIT_BODY = BODY_N * 0.02585 * Math.log(BODY_N * 0.02585 / (Math.SQRT2 * BODY_IS));
  // above about 1 A it behaves like 50 mΩ (the die and bond wires), not an ever steeper exponential
  const BODY_G = 20, BODY_V20 = BODY_N * 0.02585 * Math.log(BODY_G * BODY_N * 0.02585 / BODY_IS), BODY_I20 = BODY_IS * (Math.exp(BODY_V20 / (BODY_N * 0.02585)) - 1);
  const bodyPn = v => (v > BODY_V20 ? [BODY_I20 + BODY_G * (v - BODY_V20), BODY_G] : pn(v, BODY_IS, BODY_N));
  function pn(v, is, n) {
    const vt = n * VT, vc = vt * Math.log(vt / (1.414 * is));
    if (v > vc + 10 * vt) { const ec = Math.exp((vc + 10 * vt) / vt); return [is * (ec - 1) + is / vt * ec * (v - vc - 10 * vt), is / vt * ec]; }
    const ev = Math.exp(v / vt);
    return [is * (ev - 1), is / vt * ev + 1e-12];
  }
  const softW = 0.02;
  const soft = u => (u > 30 * softW ? u : softW * Math.log1p(Math.exp(u / softW)));
  const dsoft = u => 1 / (1 + Math.exp(-u / softW));
  function waveAt(w, t) { return w.kind === 'pulse' ? (((t * w.freq) % 1) < w.duty ? w.high : w.low) : w.kind === 'sine' ? w.offset + w.ampl * Math.sin(2 * Math.PI * w.freq * t) : w.value; }

  // ------------------------------------------------------------------ the engine
  class LiveSim {
    /**
     * circuit: Debug AI circuit dict (nodes {ref, pin}); sim: its simulation section; vals/alias: design options.
     * opts: {rampTime (s) for power-up, gmin}
     */
    constructor(circuit, sim, vals, alias, opts) {
      this.opts = Object.assign({ rampTime: 0, gmin: 1e-12 }, opts || {});
      this.circuit = circuit; this.simIn = sim; this.vals = vals || {}; this.alias = alias || {};
      const E = buildElements(circuit, sim, vals, alias);
      this.notes = E.notes; this.sim = E.sim; this.fmax = E.fmax; this.nodeNet = E.nodeNet;
      this.els = expand(E.els);
      this.t = 0; this.steps = 0; this.dt = 1e-5;
      // power switches the firmware would turn on (or a chip that is only a load here): on until the panel says otherwise
      for (const f of (sim && sim.fetForce) || []) { const e = this.els.find(q => (q.t === 'M' || q.t === 'Q') && q.name === f.name); if (e) { e.fet = e.fetDefault = f.on ? 'on' : 'off'; e.fetNote = f.note || ''; } }
      // regulators the firmware would switch on: on until the panel hands them back to their enable pin
      for (const f of (sim && sim.regForce) || []) for (const e of this.els) if ((e.t === 'REG' || e.t === 'SWR' || e.t === 'LSW') && e.ref === f.ref) { e.force = !!f.on; e.forceDflt = e.hadDflt = true; e.forceNote = f.note || ''; if (e.t === 'REG') e._on = f.on ? 1 : 0; if (e.t === 'LSW') e.on = !!f.on; }
      this.setup();
    }
    setup() {
      const idx = this.idx = new Map();
      const id = nm => { if (nm === '0' || nm == null) return -1; if (!idx.has(nm)) idx.set(nm, idx.size); return idx.get(nm); };
      const KEYS = ['a', 'b', 'c', 'e', 'd', 'g', 's', 'p', 'n', 'out', 'in', 'gnd', 'vp', 'vn', 'sw', 'fb', 'en', 'ss', 'vcc', 'trig', 'thr', 'dis', 'cont', 'reset', 'vdd'];
      for (const e of this.els) for (const k of KEYS) if (k in e) e['_' + k] = typeof e[k] === 'string' ? id(e[k]) : -1;
      this.nn = idx.size;
      let nb = 0;
      for (const e of this.els) if (['V', 'L', 'REG', 'OPA', 'SWR', 'T555'].includes(e.t)) e._br = this.nn + nb++;
      this.N = this.nn + nb;
      this.nonlinear = this.els.some(e => ['D', 'Q', 'M', 'OPA', 'REG'].includes(e.t));
      this.varying = this.els.some(e => e.t === 'SWR' || e.t === 'T555');
      this.drv = new Map();
      for (const e of this.els) { if (e.t === 'DRV') this.drv.set(e.ref + '\u0000' + e.pin, e); if (e.t === 'REG') e._on = 1; }
      for (const e of this.els) { if (e.t === 'SWR') e._D = 0; if (e.t === 'T555') e._q = 0; }
      // bucks: damp the output LC (real parts do it with current-mode control or compensation) so the averaged model settles
      for (const e of this.els) {
        if (e.t !== 'SWR') continue;
        e._rd = 0; e._ilf = 0;
        const Ls = this.els.filter(q => q.t === 'L' && (q.a === e.sw || q.b === e.sw));
        if (Ls.length !== 1) continue;
        const vo = Ls[0].a === e.sw ? Ls[0].b : Ls[0].a;
        const C = this.els.filter(q => q.t === 'C' && ((q.a === vo && q.b === '0') || (q.b === vo && q.a === '0'))).reduce((a, q) => a + q.v, 0);
        if (!(C > 0)) continue;
        e._rd = 1.2 * Math.sqrt(Ls[0].v / C);
        e._f0 = 1 / (2 * Math.PI * Math.sqrt(Ls[0].v * C));
      }
      this.x = new Float64Array(this.N); this.xo = new Float64Array(this.N); this.xn = new Float64Array(this.N);
      // pattern: record every matrix position each element can touch, in call order
      const key = new Map(), rowOf = [], colOf = [];
      const slot = (i, j) => { if (i < 0 || j < 0) return -1; const k = i * this.N + j; let s = key.get(k); if (s === undefined) { s = rowOf.length; key.set(k, s); rowOf.push(i); colOf.push(j); } return s; };
      for (let i = 0; i < this.N; i++) slot(i, i);
      this.diag = new Int32Array(this.N);
      for (let i = 0; i < this.N; i++) this.diag[i] = key.get(i * this.N + i);
      const rec = { G: (i, j) => { rec.list.push(slot(i, j)); }, I() {} };
      for (const e of this.els) { rec.list = []; this.stampEl(e, rec, 0, true); e.sl = Int32Array.from(rec.list); }
      this.rowOf = Int32Array.from(rowOf); this.colOf = Int32Array.from(colOf);
      this.nnz = rowOf.length;
      this.b = new Float64Array(this.N);
      this.A = new Float64Array(this.nnz);
      this.P = null; this.lu = null;
      this.dirty = true;
      this.stats = { reorders: 0, failed: 0, iters: 0 };
      this.topo = 1;
      // elements on every node, for probes and "what drives this net"
      this.byNode = new Map();
      for (const e of this.els) for (const k of KEYS) { const i = e['_' + k]; if (typeof i === 'number' && i >= 0) { let a = this.byNode.get(i); if (!a) this.byNode.set(i, (a = [])); if (!a.some(q => q.e === e && q.k === k)) a.push({ e, k }); } }
      for (const e of this.els) if (e.load && e.v) e.v0 = e.v;
      for (const e of this.els) if (e.ctl) e._ctlEl = this.els.find(q => q.name === e.ctl && q !== e) || null;
    }

    // one element's stamps; ctx.G(i, j, val) must be called in the same order every time
    stampEl(e, S, t, pattern) {
      const x = this.x, xo = this.xo, dt = this.dt;
      const V = (i, arr) => (i < 0 ? 0 : (arr || x)[i]);
      const G = S.G, I = S.I;
      const g2 = (a, c, g) => { G(a, a, g); G(c, c, g); G(a, c, -g); G(c, a, -g); };
      switch (e.t) {
        case 'R': g2(e._a, e._b, 1 / e.v); break;
        case 'C': { const g = e.v / dt; g2(e._a, e._b, g); if (!pattern) { const vo = V(e._a, xo) - V(e._b, xo); I(e._a, g * vo); I(e._b, -g * vo); } break; }
        case 'L': { const k = e._br; G(e._a, k, 1); G(e._b, k, -1); G(k, e._a, 1); G(k, e._b, -1); G(k, k, -e.v / dt); if (!pattern) I(k, -e.v / dt * xo[k]); break; }
        case 'V': {
          // a disconnected source (unplugged connector, removed battery) carries no current: same stamp pattern, k row = x[k] = 0
          const k = e._br, on = !e.off;
          G(e._a, k, 1); G(e._b, k, -1); G(k, e._a, on ? 1 : 0); G(k, e._b, on ? -1 : 0); G(k, k, on ? 0 : 1);
          if (!pattern && on) I(k, waveAt(e.w, t) * this.ramp(t) * (e.scale == null ? 1 : e.scale));
          break;
        }
        case 'D': {
          const m = MODELS[e.model];
          const vd = V(e._a) - V(e._b);
          let i, g;
          if (e.bidir) {
            // a bidirectional TVS: two zeners back to back, nothing flows either way below the clamp voltage
            i = 0; g = pattern ? 1 : 1e-12;
            if (!pattern && vd > e.bv - 1) { const [i1, g1] = pn(vd - e.bv + ZKNEE, 1e-14, 1); i += i1; g += g1; }
            if (!pattern && vd < -e.bv + 1) { const [i2, g2b] = pn(-vd - e.bv + ZKNEE, 1e-14, 1); i -= i2; g += g2b; }
          } else {
            [i, g] = pattern ? [0, 1] : pn(vd, m.is, m.n);
            // reverse breakdown: about 1 mA at the zener voltage (its test current), sharp below it
            if (!pattern && e.bv && vd < -e.bv + 1) { const [ib, gb] = pn(-vd - e.bv + ZKNEE, 1e-14, 1); i -= ib; g += gb; }
          }
          g2(e._a, e._b, g);
          if (!pattern) { const ieq = i - g * vd; I(e._a, -ieq); I(e._b, ieq); e._i = i; }
          break;
        }
        case 'Q': {
          const s = e.pnp ? -1 : 1;
          const vbe = s * (V(e._b) - V(e._e)), vbc = s * (V(e._b) - V(e._c));
          const off = e.fet === 'off';
          const [ife, gfe] = pattern ? [0, 1] : off ? [0, 1e-12] : pn(vbe, 1e-14, 1), [ire, gre] = pattern ? [0, 1] : off ? [0, 1e-12] : pn(vbc, 1e-14, 1);
          const bf = 200, br = 2;
          const ic = ife - ire * (1 + 1 / br), ib = ife / bf + ire / br;
          const dic_be = gfe, dic_bc = -gre * (1 + 1 / br), dib_be = gfe / bf, dib_bc = gre / br;
          const put = (row, cur, dbe, dbc) => { const eq = cur - dbe * vbe - dbc * vbc; if (!pattern && row >= 0) S.I(row, -s * eq); G(row, e._b, dbe + dbc); G(row, e._e, -dbe); G(row, e._c, -dbc); };
          put(e._c, ic, dic_be, dic_bc); put(e._b, ib, dib_be, dib_bc); put(e._e, -(ic + ib), -(dic_be + dib_be), -(dic_bc + dib_bc));
          if (!pattern) { e._ic = s * ic; e._ib = s * ib; }
          const gon = e.fet === 'on' ? 5 : 0;
          g2(e._c, e._e, gon);
          if (!pattern) e._ic += gon * (V(e._c) - V(e._e));
          break;
        }
        case 'M': {
          // always stamps the drain, gate and source rows against all three columns, so the pattern stays fixed when drain and source swap
          const s = e.pch ? -1 : 1;
          let vds = s * (V(e._d) - V(e._s));
          const swapped = vds < 0;
          if (swapped) vds = -vds;
          const src = swapped ? e._d : e._s;
          const vgs = s * (V(e._g) - V(src));
          const kp = 2, vt = 2, vov = vgs - vt;
          let id0 = 0, gm = 0, gds = 1e-9;
          if (!pattern && vov > 0 && e.fet !== 'off' && !e._gfl) { if (vds < vov) { id0 = kp * (vov * vds - vds * vds / 2); gm = kp * vds; gds += kp * (vov - vds); } else { id0 = kp / 2 * vov * vov; gm = kp * vov; } }
          const eq = id0 - gm * vgs - gds * vds;
          const cD = swapped ? -(gm + gds) : gds, cS = swapped ? gds : -(gm + gds);   // d(i into effective drain)/dV of the original drain / source
          const rows = [[e._d, swapped ? -1 : 1], [e._g, 0], [e._s, swapped ? 1 : -1]];
          for (const [r, sign] of rows) {
            if (!pattern && sign && r >= 0) S.I(r, -sign * s * eq);
            G(r, e._d, sign * cD);
            G(r, e._g, sign * gm);
            G(r, e._s, sign * cS);
          }
          let itot = (swapped ? -1 : 1) * s * id0;   // into the drain
          // the body diode (source to drain in an N-MOS, drain to source in a P-MOS): it carries a power path before the channel turns on
          {
            const an = e.pch ? e._d : e._s, ca = e.pch ? e._s : e._d;
            let vb = V(an) - V(ca);
            // junction limiting (as SPICE does): the step a Newton iteration may take on the junction voltage is bounded
            if (!pattern) {
              const vo = e._vbd || 0;
              const vtb = BODY_N * VT;
              if (vb > VCRIT_BODY && Math.abs(vb - vo) > 2 * vtb) { vb = vo > 0 ? (1 + (vb - vo) / vtb > 0 ? vo + vtb * Math.log(1 + (vb - vo) / vtb) : VCRIT_BODY) : vtb * Math.log(vb / vtb); this._limited = true; }
              e._vbd = vb;
            }
            const [ib, gb] = pattern ? [0, 1] : bodyPn(vb);
            g2(an, ca, gb);
            if (!pattern) { const ieq = ib - gb * vb; I(an, -ieq); I(ca, ieq); itot += e.pch ? ib : -ib; }
          }
          // switched on from the panel (or by default, where the firmware would): the channel as a 50 mΩ link
          // (stamped every time, zero when not forced, so the matrix pattern never changes)
          const gon = e.fet === 'on' ? 20 : 0;
          g2(e._d, e._s, gon);
          if (!pattern) { itot += gon * (V(e._d) - V(e._s)); e._id = itot; }
          break;
        }
        case 'REG': {
          // linear: the output follows the input less the dropout up to vout; boost: vout from any input above about 0.8 V,
          // and the input carries ratio × the output current (power in = power out / efficiency)
          const k = e._br, r = e.ratio || 1;
          const vin = V(e._in) - V(e._gnd);
          const ka = e.boost ? 20 : 1;
          const a = e.boost ? (vin - 0.75) * ka : vin - e.drop;
          const vt = e.vout * this.ramp(t) * (e._on == null ? 1 : e._on);
          const up = soft(a), f = vt - soft(vt - up), df = dsoft(vt - up) * dsoft(a) * ka;
          // the input carries ratio × the current delivered, never current pushed back into it (smoothly: about 1 mA of its own
          // at no load, like a real regulator's quiescent current)
          const xs = pattern ? 0 : -x[k], wsi = 2e-3, spi = xs > 30 * wsi ? xs : wsi * Math.log1p(Math.exp(xs / wsi)), dspi = 1 / (1 + Math.exp(-xs / wsi));
          G(e._out, k, 1); G(e._gnd, k, -1); G(k, e._out, 1); G(k, e._gnd, -1); G(k, e._in, -df); G(k, e._gnd, df); G(e._in, k, -r * dspi); G(e._gnd, k, r * dspi);
          if (!pattern) { const cin = r * (spi + dspi * x[k]); I(e._in, -cin); I(e._gnd, cin); I(k, f - df * vin); }
          let rf = 0, rb = 0;
          if (e.ilim > 0 && !pattern) { const wi = 0.02 * e.ilim, idel = -x[k]; const u = idel - e.ilim; const sp = u > 30 * wi ? u : wi * Math.log1p(Math.exp(u / wi)), dsp = 1 / (1 + Math.exp(-u / wi)); rf = -50 * dsp; rb = -(50 * sp + 50 * dsp * x[k]); }
          // a regulator only sources current: pushed above its target by another supply (or switched off) it lets go instead of
          // sinking amps into its output
          // (running, it absorbs what an output filter rings back, up to about 0.2 A; switched off, next to nothing)
          if (!pattern) { const off = e._on === 0, i0 = off ? 1e-3 : 0.2, ws = off ? 1e-3 : 0.04, us = x[k] - i0, sps = us > 30 * ws ? us : ws * Math.log1p(Math.exp(us / ws)), dsps = 1 / (1 + Math.exp(-us / ws)); rf -= RSINK * dsps; rb += RSINK * (sps - dsps * x[k]); }
          G(k, k, rf);
          if (!pattern && rb) I(k, rb);
          break;
        }
        case 'LSW': g2(e._a, e._b, e.on ? 1 / e.ron : 1e-8); break;
        case 'DRV': {
          // pin driver: output resistance to the chip's supply net (high, pull-up) and/or to ground (low, pull-down, open drain);
          // kh is the share to the supply (1 high, 0 low, 0.5 a clock's average); the supply net really delivers the current,
          // so an LED on a pin loads the regulator
          if (e._vdd >= 0) {
            const gh = e.g * e.kh, gl = e.g * (1 - e.kh) + 1e-12;
            G(e._a, e._a, gh + gl); G(e._a, e._vdd, -gh); G(e._vdd, e._a, -gh); G(e._vdd, e._vdd, gh);
          } else {
            G(e._a, e._a, e.g);
            if (!pattern && e.kh) I(e._a, e.g * e.kh * e.vnom);
          }
          break;
        }
        case 'SWR': {
          const k = e._br, D = e._D;
          G(e._sw, k, 1); G(e._gnd, k, -1); G(k, e._sw, 1); G(k, e._gnd, -1); G(k, e._in, -D); G(k, e._gnd, D); G(e._in, k, -D); G(e._gnd, k, D);
          // switched off, both of its switches are open: the switch node floats rather than shorting the output to ground
          G(k, k, -((e._rd || 0) + (e._run === false ? 1e4 : 0)));
          if (!pattern && e._rd) I(k, e._rd * e._ilf);
          if (!pattern && e._ss >= 0) I(e._ss, e.iss);
          break;
        }
        case 'T555': {
          const k = e._br;
          const vcc = V(e._vcc) - V(e._gnd);
          const vo = e._q ? Math.max(vcc - 1.2, 0) : 0.05;
          G(e._out, k, 1); G(e._gnd, k, -1); G(k, e._out, 1); G(k, e._gnd, -1);
          if (!pattern) I(k, vo);
          g2(e._dis, e._gnd, e._q ? 0 : 0.1);
          break;
        }
        case 'OPA': {
          const k = e._br;
          const hi = e.vp ? V(e._vp) : 5, lo = e.vn && e.vn !== '0' ? V(e._vn) : 0;
          const mid = (hi + lo) / 2, sw = Math.max(1e-3, (hi - lo) / 2);
          // an amplifier with no supply to speak of (its rail unpowered) has next to no gain: it cannot swing anyway
          const A = Math.pow(10, 1 + 4 * Math.min(1, Math.max(0, (hi - lo - 0.5) / 1.0)));
          const vreal = V(e._p) - V(e._n);
          let vd = e._vl || 0;
          const dd = vreal - vd, lim = Math.max(4 * sw / A, 0.75 * Math.abs(vd));
          if (!pattern) { if (Math.abs(dd) > lim) { vd += Math.sign(dd) * lim; this._limited = true; } else vd = vreal; e._vl = vd; }
          const th = Math.tanh(A * vd / sw), f = mid + sw * th, g = Math.max(A * (1 - th * th), 1e-3);
          G(e._out, k, 1); G(k, e._out, 1); G(k, e._p, -g); G(k, e._n, g);
          if (!pattern) I(k, f - g * vd);
          break;
        }
      }
    }
    ramp(t) { const r = this.opts.rampTime; return r > 0 ? Math.min(1, Math.max(0, t / r)) : 1; }

    assemble(t) {
      const A = this.A, b = this.b;
      A.fill(0); b.fill(0);
      const gmin = this.opts.gmin;
      for (let i = 0; i < this.nn; i++) A[this.diag[i]] += gmin;
      let sl = null, pos = 0;
      const S = { G: (i, j, val) => { const s = sl[pos++]; if (s >= 0) A[s] += val; }, I: (i, val) => { if (i >= 0) b[i] += val; } };
      this._limited = false;
      for (const e of this.els) { sl = e.sl; pos = 0; this.stampEl(e, S, t, false); }
    }
    factor() {
      if (!this.P) this.reorder();
      let lu = this.lu;
      lu.fill(0);
      lu.set(this.A);
      if (refactor(this.P, lu)) return true;
      // a pivot vanished (a switch opened, a supply was unplugged): order again; the new ordering has its own LU storage
      this.stats.reorders++;
      this.reorder();
      lu = this.lu;
      lu.fill(0); lu.set(this.A);
      return refactor(this.P, lu);
    }
    reorder() {
      this.P = analyze(this.N, this.rowOf, this.colOf, this.A);
      this.lu = new Float64Array(this.P.nSlots);
      this.stats.fill = this.P.nSlots - this.nnz;
      this.stats.ops = this.P.upd.length;
    }

    // advance one time step; returns false if the solve failed
    step() {
      const t = this.t + this.dt, N = this.N, x = this.x, xn = this.xn;
      // a MOSFET whose gate nothing drives (an unmodelled driver chip, a gate resistor to nowhere) stays off: a gate left at
      // 0 V would otherwise turn every high-side P-MOS fully on
      if (this._gtopo !== this.topo) {
        this._gtopo = this.topo;
        const fl = this.floatingNodes();
        for (const e of this.els) if (e.t === 'M') { const off = e._g < 0 ? false : fl[e._g] === 1; if (off !== !!e._gfl) { e._gfl = off; this.dirty = true; } }
      }
      let ok = this.newton(t);
      if (ok === null) return false;
      // not converged (a converter starting, a diode snapping on): the same span again in smaller steps, each starting from a
      // converged state, rather than accepting a solution that is not one
      if (!ok && this.nonlinear) {
        const dt0 = this.dt, t0 = this.t, x0 = this._x0 || (this._x0 = new Float64Array(N));
        x0.set(this.xo);
        for (const k of [4, 16]) {
          x.set(x0); this.xo.set(x0); this.dt = dt0 / k; this.dirty = true;
          let good = true, tt = t0;
          for (let j = 0; j < k && good; j++) { tt += this.dt; const r = this.newton(tt); if (r === null) { this.dt = dt0; this.dirty = true; return false; } good = r; if (good) this.xo.set(x); }
          if (good) { ok = true; break; }
        }
        this.dt = dt0; this.dirty = true;
        this.stats.substeps = (this.stats.substeps || 0) + 1;
      }
      // state machines between steps
      for (const e of this.els) {
        if (e.t === 'SWR') {
          const V = i => (i < 0 ? 0 : x[i]);
          const vfb = V(e._fb) - V(e._gnd);
          let vref = e.vref * this.ramp(t);
          if (e._ss >= 0) vref = Math.min(vref, V(e._ss) - V(e._gnd));
          const ven = V(e._en) - V(e._gnd);
          // with a little hysteresis, like the real enable comparators (an EN tied to a 1.2 V rail turns it on)
          const th = e._run ? (e.enLow ? e.ven + 0.1 : e.ven - 0.1) : e.ven;
          const on = e._en < 0 || (e.enLow ? ven < th : ven > th);
          const K = 2 * Math.PI * e.fc * Math.max(e._D, 0.05) / e.vref;
          const run = e.force != null ? !!e.force : on;
          if (run !== e._run) { e._run = run; this.dirty = true; }
          e._D = run ? Math.min(e.dmax, Math.max(0, e._D + this.dt * K * (vref - vfb))) : Math.max(0, e._D - this.dt * 2000 * e._D);
          const il = -x[e._br];
          if (e._rd) e._ilf += (il - e._ilf) * Math.min(1, this.dt * 2 * Math.PI * e._f0 / 5);
          if (e.ilim > 0 && il > e.ilim) e._D *= Math.max(0.5, e.ilim / il) * 0.98;
        }
        // a boost (or a switching stage modelled as a regulator) draws its output power from the input, at about 90 %: the ratio
        // of input to output current follows the voltages (eased, so the solve never has to chase a jump)
        if (e.t === 'REG' && (e.boost || e.sw) && e._out >= 0 && e._in >= 0) {
          const g0 = e._gnd >= 0 ? x[e._gnd] : 0, vin = x[e._in] - g0, vo = x[e._out] - g0;
          if (vin > 0.5 && vo > 0.2) {
            const want = vo / (vin * 0.9), r = e.boost ? Math.min(20, Math.max(1, want)) : Math.min(1, Math.max(0.05, want));
            if (Math.abs(r - e.ratio) > 1e-3) e.ratio += (r - e.ratio) * 0.2;
          }
        }
        if (e.t === 'REG' && (e._en >= 0 || e.force != null)) {
          let want;
          if (e.force != null) want = e.force;
          else { const v = (x[e._en] || 0) - (e._gnd >= 0 ? x[e._gnd] : 0); want = e.enLow ? v < (e._on ? 0.9 : 0.7) : v > (e._on ? 0.7 : 0.9); }
          e._on = want ? 1 : 0;
        } else if (e.t === 'LSW') {
          if (e._en >= 0 || e.force != null) {
            let want;
            if (e.force != null) want = e.force;
            else { const v = (x[e._en] || 0) - (e._gnd >= 0 ? x[e._gnd] : 0); want = e.enLow ? v < (e.on ? 0.9 : 0.7) : v > (e.on ? 0.7 : 0.9); }
            if (want !== e.on) { e.on = want; this.dirty = true; this.topo++; }
          }
          // current limit, as real power switches have: the channel resistance rises until the current is at the limit
          if (e.on && e.ilim > 0) {
            const dv = Math.abs((e._a >= 0 ? x[e._a] : 0) - (e._b >= 0 ? x[e._b] : 0));
            const want = Math.max(e.ron0, dv / e.ilim);
            if (Math.abs(want - e.ron) > 0.05 * e.ron) { e.ron = e.ron + (want - e.ron) * 0.5; this.dirty = true; e.limited = want > e.ron0 * 1.5; }
          }
        } else if (e._ctlEl) {
          // a relay contact or an optocoupler output: follows the current in its coil / LED, with hysteresis
          const ce = e._ctlEl;
          const i = ce.t === 'D' ? (ce._i || 0) : ce.t === 'R' ? ((ce._a < 0 ? 0 : x[ce._a]) - (ce._b < 0 ? 0 : x[ce._b])) / ce.v : 0;
          const on = Math.abs(i) > (e._st ? e.off : e.thr);
          e._st = on;
          const want = e.inv ? !on : on;
          if (want !== e.closed) { e.closed = want; e.v = want ? (e.ron || 0.01) : 1e9; this.dirty = true; this.topo++; }
        } else if (e.t === 'T555') {
          const V = i => (i < 0 ? 0 : x[i]);
          const g = V(e._gnd), cont = V(e._cont) - g;
          if (e._reset >= 0 && V(e._reset) - g < 0.7) e._q = 0;
          else if (V(e._thr) - g > cont) e._q = 0;
          else if (V(e._trig) - g < cont / 2) e._q = 1;
        }
      }
      this.xo.set(x);
      this.t = t;
      this.steps++;
      this.converged = ok;
      return true;
    }
    // Newton iterations at time t from the current x: true converged, false not, null the matrix failed
    newton(t) {
      const N = this.N, x = this.x, xn = this.xn;
      const maxIt = this.nonlinear ? 30 : 1;
      for (let it = 0; it < maxIt; it++) {
        this.assemble(t);
        if (this.nonlinear || this.varying || this.dirty || !this.luOk) {
          if (!this.factor()) { this.stats.failed++; return null; }
          this.luOk = true; this.dirty = false;
        }
        xn.set(this.b);
        const sol = this._sol || (this._sol = new Float64Array(N));
        solve(this.P, this.lu, xn, sol);
        let err = 0;
        for (let i = 0; i < N; i++) {
          let d = sol[i] - x[i];
          if (!isFinite(d)) { this.stats.failed++; return null; }
          if (this.nonlinear && i < this.nn && Math.abs(d) > 2) d = 2 * Math.sign(d);
          const r = Math.abs(d) / (1e-6 + 1e-3 * Math.abs(sol[i]));
          if (r > err) { err = r; this._worst = i; }
          x[i] += d;
        }
        this.stats.iters++;
        if (!this.nonlinear || (err < 1 && !this._limited)) return true;
      }
      return false;
    }
    // run steps until simulated time advanced by `span` or the wall-clock budget is used up
    advance(span, budgetMs) {
      const t0 = performance.now(), tEnd = this.t + span;
      let n = 0;
      while (this.t + this.dt * 0.5 < tEnd) {
        if (!this.step()) return { ok: false, steps: n };
        if (this.onStep) this.onStep(this.t, this.dt);
        n++;
        if ((n & 3) === 0 && performance.now() - t0 > budgetMs) break;
      }
      return { ok: true, steps: n, ms: performance.now() - t0 };
    }
    setDt(dt) { if (Math.abs(dt - this.dt) / this.dt > 1e-9) { this.dt = dt; this.dirty = true; } }

    // ---------------------------------------------------------------- results
    V(node) { const i = this.idx.get(node); return i == null ? 0 : this.x[i]; }
    netVoltages() {
      const out = new Map();
      for (const [node, net] of this.nodeNet) out.set(net, this.V(node));
      return out;
    }
    // current flowing from the net into each part pin, keyed "REF\u0000pin"
    pinCurrents() {
      const x = this.x, xo = this.xo;
      const V = i => (i < 0 ? 0 : x[i]);
      const out = new Map();
      const add1 = (tp, i) => { const k = tp[0] + '\u0000' + tp[1]; out.set(k, (out.get(k) || 0) + i); };
      // a list of pins shares the current (a chip's ground pins)
      const add = (tp, i) => { if (!tp || !isFinite(i) || i === 0) return; if (Array.isArray(tp[0])) { for (const q of tp) add1(q, i / tp.length); } else add1(tp, i); };
      for (const e of this.els) {
        const pn_ = e.pins || {};
        switch (e.t) {
          case 'R': { const i = (V(e._a) - V(e._b)) / e.v; add(pn_.a, i); add(pn_.b, -i); e.cur = i; break; }
          case 'C': { const i = e.v / this.dt * ((V(e._a) - V(e._b)) - ((e._a < 0 ? 0 : xo[e._a]) - (e._b < 0 ? 0 : xo[e._b]))); add(pn_.a, i); add(pn_.b, -i); e.cur = i; break; }
          case 'L': case 'V': { const i = x[e._br]; add(pn_.a, i); add(pn_.b, -i); e.cur = i; break; }
          case 'D': { const i = e._i || 0; add(pn_.a, i); add(pn_.b, -i); e.cur = i; break; }
          case 'Q': add(pn_.c, e._ic || 0); add(pn_.b, e._ib || 0); add(pn_.e, -((e._ic || 0) + (e._ib || 0))); e.cur = e._ic || 0; break;
          case 'M': add(pn_.d, e._id || 0); add(pn_.s, -(e._id || 0)); e.cur = e._id || 0; break;
          case 'REG': { const i = x[e._br], r = e.ratio || 1; add(pn_.out, i); add(pn_.in, -i * r); if (r !== 1) add(pn_.gnd, (r - 1) * i); e.cur = -i; break; }
          case 'SWR': { const i = x[e._br]; add(pn_.sw, i); add(pn_.in, -e._D * i); add(pn_.gnd, -i + e._D * i); e.cur = -i; break; }
          case 'T555': {
            if (!e._q && e._dis >= 0) { const id = (V(e._dis) - V(e._gnd)) * 0.1; add(pn_.dis, id); add(pn_.gnd, -id); }
            const ik = x[e._br]; if (ik < 0) add(pn_.vcc, -ik); else add(pn_.gnd, -ik);
            break;
          }
          case 'OPA': { const ik = x[e._br]; if (ik < 0) add(pn_.vp, -ik); else add(pn_.vn, -ik); break; }
          case 'LSW': { const i = (V(e._a) - V(e._b)) * (e.on ? 1 / e.ron : 1e-8); add(pn_.a, i); add(pn_.b, -i); e.cur = i; break; }
          case 'DRV': {
            if (e.mode === 'z') break;
            const va = V(e._a), vh = e._vdd >= 0 ? x[e._vdd] : e.vnom, gh = e.g * e.kh, gl = e.g * (1 - e.kh);
            const ih = gh * (va - vh), il = gl * va;
            add(pn_.a, ih + il);
            if (e._vdd >= 0) add(pn_.vdd, -ih);
            add(pn_.gnd, -il);
            e.cur = ih + il;
            break;
          }
        }
      }
      return out;
    }
    // what the parts are doing, for readouts: {ref: {i (A), p (W)}}
    partReadout() {
      this.pinCurrents();
      const out = {};
      const x = this.x;
      const V = i => (i < 0 ? 0 : x[i]);
      for (const e of this.els) {
        if (!e.ref || e.cur == null) continue;
        let p = 0;
        if (e.t === 'R' || e.t === 'C' || e.t === 'D') p = Math.abs((V(e._a) - V(e._b)) * e.cur);
        const o = out[e.ref] || (out[e.ref] = { i: 0, p: 0 });
        if (Math.abs(e.cur) > Math.abs(o.i)) o.i = e.cur;
        o.p += p;
      }
      return out;
    }
    // ---------------------------------------------------------------- processor pins
    // mode: 'z' (input), 'hi', 'lo', 'pu' (pull-up), 'pd' (pull-down), 'od' (open drain low)
    // r: output resistance in ohm instead of the mode's own (a 15 kΩ USB pull-down, a 1.5 kΩ pull-up)
    setDrive(ref, pin, mode, r) {
      const e = this.drv.get(ref + '\u0000' + pin);
      if (!e || (e.mode === mode && (r == null || e.r === r))) return !!e;
      const G = r > 0 ? 1 / r : { z: 1e-9, hi: 1 / 30, lo: 1 / 30, pu: 1 / 45e3, pd: 1 / 45e3, od: 1 / 30, half: 1 / 60 }[mode] || 1e-9;
      const kh = mode === 'hi' || mode === 'pu' ? 1 : mode === 'half' ? 0.5 : 0;
      if (G !== e.g || kh !== e.kh) this.dirty = true;
      if ((mode === 'z') !== (e.mode === 'z')) this.topo++;
      e.mode = mode; e.g = G; e.kh = kh; e.r = r;
      return true;
    }
    driveOf(ref, pin) { const e = this.drv.get(ref + '\u0000' + pin); return e ? e.mode : null; }
    hasPin(ref, pin) { return this.drv.has(ref + '\u0000' + pin); }
    pinV(ref, pin) { const e = this.drv.get(ref + '\u0000' + pin); return e && e._a >= 0 ? this.x[e._a] : 0; }
    supplyV(ref, pin) { const e = this.drv.get(ref + '\u0000' + pin); return e && e._vdd >= 0 ? this.x[e._vdd] : e ? e.vnom : 0; }
    releaseAll(ref) { for (const e of this.drv.values()) if (!ref || e.ref === ref) this.setDrive(e.ref, e.pin, 'z'); }
    // ---------------------------------------------------------------- live controls
    setSupply(net, value) { for (const e of this.els) if (e.supply && e.net === net && e.w.kind === 'dc') e.w.value = value; }
    // plug or unplug a supply (a connector's source, a battery): unplugged it neither holds the net nor carries current
    setSupplyOn(net, on) { let hit = false; for (const e of this.els) if (e.supply && e.net === net && !!e.off === !!on) { e.off = !on; hit = true; } if (hit) { this.dirty = true; this.topo++; } return hit; }
    supplies() {
      return this.els.filter(e => e.supply).map(e => {
        const pa = e.pins && e.pins.a;
        const refs = pa ? [...new Set((Array.isArray(pa[0]) ? pa : [pa]).map(q => q[0]))] : [];
        return { net: e.net, value: e.w.kind === 'dc' ? e.w.value : e.w.high, kind: e.w.kind, on: !e.off, battery: !!e.battery, ref: e.ref || null, refs, i: e._br != null ? -this.x[e._br] : 0 };
      });
    }
    // switches and jumpers (key: one contact of a DIP switch, an encoder, a jumper pad pair); a changeover switch moves both contacts
    setSwitch(ref, closed, key) {
      let hit = false;
      for (const e of this.els) {
        if (e.sw !== true || e.ref !== ref) continue;
        let c = closed;
        if (e.spdt) c = e.throw ? !closed : closed;
        else if (key != null && (e.key || '') !== key) continue;
        e.closed = c; e.v = c ? (e.ron || 0.01) : 1e9; hit = true;
      }
      if (hit) { this.dirty = true; this.topo++; }
      return hit;
    }
    // regulators, converters and load switches held on or off by hand (null: their enable pin decides again)
    setEnable(ref, on) {
      let hit = false;
      for (const e of this.els) {
        if ((e.t !== 'REG' && e.t !== 'LSW' && e.t !== 'SWR') || e.ref !== ref) continue;
        e.force = on == null ? null : !!on; e.forceDflt = false; hit = true;
        if (e.t === 'LSW' && on != null && e.on !== !!on) { e.on = !!on; this.topo++; }
        if (e.t === 'REG') e._on = on != null ? (on ? 1 : 0) : e._en < 0 ? 1 : e._on;
        this.dirty = true;
      }
      return hit;
    }
    // transistors used as power switches: forced on / off from the panel, or null to let the circuit decide
    setFet(name, state) { const e = this.els.find(q => (q.t === 'M' || q.t === 'Q') && q.name === name); if (!e) return false; e.fet = state === 'on' || state === 'off' ? state : null; this.dirty = true; return true; }
    fetOf(name) {
      const e = this.els.find(q => (q.t === 'M' || q.t === 'Q') && q.name === name);
      if (!e) return null;
      const i = e.t === 'M' ? e._id || 0 : e._ic || 0;
      const vc = e.t === 'M' ? (e._g >= 0 ? this.x[e._g] : 0) - (e._s >= 0 ? this.x[e._s] : 0) : (e._b >= 0 ? this.x[e._b] : 0) - (e._e >= 0 ? this.x[e._e] : 0);
      const on = e.fet === 'on' || (e.fet !== 'off' && !e._gfl && (e.t === 'M' ? (e.pch ? -vc : vc) > 2 : (e.pnp ? -vc : vc) > 0.55));
      return { name, ref: e.ref, t: e.t, state: e.fet || null, dflt: e.fetDefault || null, on, i, vctl: vc };
    }
    enableOf(ref) { const e = this.els.find(q => (q.t === 'REG' || q.t === 'LSW' || q.t === 'SWR') && q.ref === ref); if (!e) return null; return { force: e.force == null ? null : e.force, dflt: !!e.forceDflt, note: e.forceNote || '', on: e.t === 'REG' ? !!e._on : e.t === 'LSW' ? !!e.on : e._D > 0.01, hasEn: e._en >= 0, t: e.t }; }
    // chips modelled as their supply current: scale it (a processor running code draws more than one held idle)
    setLoadScale(ref, k) { let hit = false; for (const e of this.els) if (e.load && e.ref === ref && e.v0) { const v = e.v0 / Math.max(1e-3, k); if (v !== e.v) { e.v = v; hit = true; } } if (hit) this.dirty = true; return hit; }
    // ---------------------------------------------------------------- analysis for probes
    nodeOf(net) { if (!this._netNode) { this._netNode = new Map(); for (const [nd, nm] of this.nodeNet) this._netNode.set(nm, nd); } return this._netNode.get(net); }
    nodeIndex(node) { const i = this.idx.get(node); return i == null ? -1 : i; }
    // nodes with no DC path to ground or a source: nothing drives them (they would read as noise on a real board)
    floatingNodes() {
      if (this._flt && this._fltTopo === this.topo) return this._flt;
      const n = this.nn, par = new Int32Array(n + 1);
      for (let i = 0; i <= n; i++) par[i] = i;
      const G = n;   // ground
      const f = i => { i = i < 0 ? G : i; while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
      const u = (a, b) => { const x = f(a), y = f(b); if (x !== y) par[x] = y; };
      for (const e of this.els) {
        switch (e.t) {
          case 'R': if (e.v < 1e8) u(e._a, e._b); break;
          case 'L': case 'D': u(e._a, e._b); break;
          case 'V': if (!e.off) { u(e._a, G); u(e._b, G); } break;
          case 'REG': u(e._out, G); u(e._in, G); break;
          case 'SWR': u(e._sw, G); u(e._in, G); break;
          case 'LSW': if (e.on) u(e._a, e._b); break;
          case 'OPA': u(e._out, G); break;
          case 'T555': u(e._out, G); break;
          case 'Q': u(e._b, e._e); u(e._c, e._e); break;
          case 'M': u(e._d, e._s); break;
          case 'DRV': if (e.mode !== 'z') { if (e.kh > 0 && e._vdd >= 0) u(e._a, e._vdd); if (e.kh < 1 || e._vdd < 0) u(e._a, G); } break;
        }
      }
      const g = f(G), out = new Uint8Array(n), root = new Int32Array(n);
      for (let i = 0; i < n; i++) { root[i] = f(i); out[i] = root[i] === g ? 0 : 1; }
      this._flt = out; this._fltTopo = this.topo; this._fltRoot = root;   // nodes with the same root float together
      return out;
    }
    // current each element pushes into a node (A, positive = into the net), strongest first
    nodeReport(node) {
      const i = typeof node === 'number' ? node : this.nodeIndex(node);
      if (i < 0) return [];
      const x = this.x, xo = this.xo, V = k => (k < 0 ? 0 : x[k]);
      const out = [];
      for (const { e, k } of this.byNode.get(i) || []) {
        let cur = null;
        const other = [];
        switch (e.t) {
          case 'R': { const o = k === 'a' ? e._b : e._a; cur = (V(o) - V(i)) / e.v; other.push(o); break; }
          case 'C': { const o = k === 'a' ? e._b : e._a; const vo = (o < 0 ? 0 : xo[o]); cur = e.v / this.dt * ((V(o) - V(i)) - (vo - xo[i])); other.push(o); break; }
          case 'L': case 'V': { const b = x[e._br]; cur = k === 'a' ? -b : b; other.push(k === 'a' ? e._b : e._a); break; }
          case 'D': { const d = e._i || 0; cur = k === 'a' ? -d : d; other.push(k === 'a' ? e._b : e._a); break; }
          case 'REG': if (k === 'out') cur = -x[e._br]; else if (k === 'in') cur = x[e._br] * (e.ratio || 1); else if (k === 'gnd') cur = -((e.ratio || 1) - 1) * x[e._br]; break;
          case 'SWR': if (k === 'sw') cur = -x[e._br]; else if (k === 'in') cur = e._D * x[e._br]; break;
          case 'LSW': { const o = k === 'a' ? e._b : e._a; cur = (V(o) - V(i)) * (e.on ? 1 / e.ron : 1e-8); other.push(o); break; }
          case 'DRV': if (k === 'a') { const vh = e._vdd >= 0 ? x[e._vdd] : e.vnom; cur = -(e.g * e.kh * (V(i) - vh) + e.g * (1 - e.kh) * V(i)); } break;
          case 'Q': cur = k === 'c' ? -(e._ic || 0) : k === 'b' ? -(e._ib || 0) : k === 'e' ? (e._ic || 0) + (e._ib || 0) : null; break;
          case 'M': cur = k === 'd' ? -(e._id || 0) : k === 's' ? (e._id || 0) : null; break;
          case 'OPA': case 'T555': if (k === 'out') cur = null; break;
        }
        out.push({ e, k, i: cur, other });
      }
      out.sort((a, b) => Math.abs(b.i || 0) - Math.abs(a.i || 0));
      return out;
    }
    switches() { return this.els.filter(e => e.sw === true && !(e.spdt && e.throw)).map(e => ({ ref: e.ref, key: e.key || '', closed: e.closed, auto: !!e.ctl, spdt: !!e.spdt, jumper: !!e.jumper })); }
    setPot(ref, frac) { frac = Math.min(0.999, Math.max(0.001, frac)); for (const e of this.els) if (e.pot && e.ref === ref) { e.v = e.pot === 'a' ? e.total * frac : e.total * (1 - frac); e.frac = frac; } this.dirty = true; }
    pots() { return this.els.filter(e => e.pot === 'a').map(e => ({ ref: e.ref, frac: e.frac == null ? 0.5 : e.frac })); }
    powerCycle(rampTime) { this.opts.rampTime = rampTime == null ? this.opts.rampTime : rampTime; this.t = 0; this.x.fill(0); this.xo.fill(0); for (const e of this.els) { if (e.t === 'SWR') { e._D = 0; e._ilf = 0; } if (e.t === 'T555') e._q = 0; e._vl = 0; } this.dirty = true; }
    // carry node voltages and branch currents across a rebuild (fault injected or cleared)
    snapshot() {
      const nodes = new Map(), br = new Map(), st = new Map();
      for (const [nm, i] of this.idx) nodes.set(nm, this.x[i]);
      for (const e of this.els) { if (e._br != null) br.set(e.t + ':' + e.name, this.x[e._br]); if (e.t === 'SWR') { st.set(e.name, e._D); st.set(e.name + '~ilf', e._ilf); } if (e.t === 'T555') st.set(e.name, e._q); }
      const en = [];
      for (const e of this.els) if ((e.force != null || e.hadDflt) && (e.t === 'REG' || e.t === 'LSW' || e.t === 'SWR')) en.push([e.ref, e.force, !!e.forceDflt]);
      const fets = this.els.filter(e => (e.t === 'M' || e.t === 'Q') && (e.fet || null) !== (e.fetDefault || null)).map(e => [e.name, e.fet || null]);
      return { nodes, br, st, t: this.t, dt: this.dt, rampTime: this.opts.rampTime, sw: this.switches(), pots: this.pots(), sup: this.supplies(), en, fets };
    }
    restore(s) {
      this.t = s.t; this.dt = s.dt; this.opts.rampTime = s.rampTime;
      for (const [nm, i] of this.idx) if (s.nodes.has(nm)) this.x[i] = s.nodes.get(nm);
      for (const e of this.els) { if (e._br != null && s.br.has(e.t + ':' + e.name)) this.x[e._br] = s.br.get(e.t + ':' + e.name); if (e.t === 'SWR' && s.st.has(e.name + '~ilf')) e._ilf = s.st.get(e.name + '~ilf'); if (s.st.has(e.name)) { if (e.t === 'SWR') e._D = s.st.get(e.name); if (e.t === 'T555') e._q = s.st.get(e.name); } }
      for (const w of s.sw || []) if (!w.auto) this.setSwitch(w.ref, w.closed, w.key);
      for (const p of s.pots || []) this.setPot(p.ref, p.frac);
      for (const p of s.sup || []) { this.setSupply(p.net, p.value); if (p.on === false) this.setSupplyOn(p.net, false); }
      for (const [ref, on, d] of s.en || []) { this.setEnable(ref, on); if (d) for (const e of this.els) if (e.ref === ref && (e.t === 'REG' || e.t === 'LSW' || e.t === 'SWR')) e.forceDflt = true; }
      for (const [name, st] of s.fets || []) this.setFet(name, st);
      this.xo.set(this.x);
      this.dirty = true;
    }
    info() { return { unknowns: this.N, nodes: this.nn, nnz: this.nnz, fill: this.stats.fill || 0, ops: this.stats.ops || 0, nonlinear: this.nonlinear, elements: this.els.length }; }
  }
  N.LiveSim = LiveSim;
  N.LiveSim.buildElements = buildElements;
})(typeof window !== 'undefined' ? window : globalThis);

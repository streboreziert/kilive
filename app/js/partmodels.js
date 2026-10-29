/* KiLive — the part model library: how the live simulation treats every part that is not a plain two-pin component.
   - composite(): multi-pin passives as several simple elements (tactile and key switches, diode / resistor / capacitor arrays,
     RGB LEDs, dual transistors, common-mode chokes, ESD arrays with flow-through pins, rotary encoders, DIP switches, crystals)
   - model(): chips without a circuit model get a behaviour from the library: a role for every pin (supply, input, output high /
     low, clock, open drain, USB pull-ups, follows another pin, logic gate, reset output, constant-current sink …), from a
     built-in family entry (level translators, buffers and gates, clock generators, supervisors, chargers, LED drivers, USB hubs
     and PHYs, CAN / RS-485 transceivers, motor and gate drivers, class-D amplifiers, Ethernet PHYs …), a model someone saved
     to the shared library, or inferred from the pin names and electrical types.
   - runtime(): drives those pins while the simulation runs.
   N.partModels = { composite, model, plan, runtime, families, roles, user, save, describe } */
(function () {
  'use strict';
  const N = window.Noeti = window.Noeti || {};
  const up = s => String(s == null ? '' : s).toUpperCase();
  // KiCad pin names: ~{RESET} -> RESET (active low noted), SW_3 on pin 3 -> SW
  function pinName(p) {
    let n = up(p.name || '').replace(/\{SLASH\}/g, '/').trim();
    const low = !!p.low || /^~\{.*\}$|^~|^\/|#$|_N$|^N(RST|RESET|EN|SHDN|SLEEP|FAULT|INT|IRQ|CS|OE|WE|RD|WR|PG|STBY|ALERT|BUSY|CHG|STAT|PWRDN|PD)\b/.test(n);
    n = n.replace(/^~\{(.*)\}$/, '$1').replace(/^~|^\//, '').replace(/[{}]/g, '');
    if (p.number != null && n.endsWith('_' + up(p.number))) n = n.slice(0, -(String(p.number).length + 1));
    return { n, low };
  }
  N.pinName = pinName;

  // ---------------------------------------------------------------- context: one part with its pins and nets
  // one index per circuit: the nets of every part pin, the parts by reference, the nets with a crystal on them
  const IX = new WeakMap();
  function index(circ) {
    let ix = IX.get(circ.nets);
    if (ix) return ix;
    const pinNets = new Map(), comp = new Map(), byName = new Map();
    for (const c of circ.components || []) comp.set(c.ref, c);
    for (const n of circ.nets) { byName.set(n.name, n); for (const x of n.nodes) { let m = pinNets.get(x.ref); if (!m) pinNets.set(x.ref, (m = new Map())); m.set(String(x.pin), n); } }
    const crystal = new Set();
    for (const n of circ.nets) for (const x of n.nodes) { const c = comp.get(x.ref); if (c && (c.type === 'crystal' || (c.type === 'composite' && c.kind === 'crystal'))) { crystal.add(n.name); break; } }
    ix = { pinNets, comp, byName, crystal };
    IX.set(circ.nets, ix);
    return ix;
  }
  function ctxOf(c, circ) {
    const nets = (index(circ).pinNets.get(c.ref)) || new Map();
    const volt = N.simtab && N.simtab.voltOf ? N.simtab.voltOf : () => null;
    const pins = (c.pins || []).map(p => {
      const { n, low } = pinName(p);
      const net = nets.get(String(p.number)) || null;
      const kind = net ? net.kind : null;
      const nm = net ? net.name : '';
      return { num: String(p.number), name: n, low, etype: String(p.etype || '').replace(/\+no_connect$/, ''), net: nm, kind, v: net ? volt(nm) : null, nc: !net || /^(unconnected|NC$)/i.test(nm) || /no_connect/.test(p.etype || '') };
    });
    const by = rx => pins.filter(p => rx.test(p.name));
    const one = rx => pins.find(p => rx.test(p.name));
    const text = up([c.value, c.description, c.mpn].join(' '));
    return { c, circ, pins, by, one, text, nets, ix: index(circ), lib: up(c.lib || ''), pkg: up(c.package || '') };
  }
  N.partCtx = ctxOf;
  // a resistance or capacitance written on a part: 10mΩ, 0.016, 2.2k, 100n
  function valueOf(s, unit) {
    const P2 = window.DS2K_P2;
    const str = String(s || '').trim();
    if (P2) { const v = P2.parseValue(str, unit); if (v != null && v > 0) return v; }
    const m = /(\d+(?:[.,]\d+)?)\s*([pnuµmkKMG]?)\s*(Ω|OHM|R\b|F\b)?/i.exec(str);
    if (!m) return null;
    const k = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 }[m[2]] || 1;
    const v = parseFloat(m[1].replace(',', '.')) * k;
    return v > 0 ? v : null;
  }

  // ---------------------------------------------------------------- composites: multi-pin passives
  const DUAL_DIODE = [   // part number -> [[anode pin, cathode pin], ...]
    [/BAV70|BAT54C|BAS40-04|BAS70-04|BAT54CW|RB715|BAS40T-04/, [['1', '3'], ['2', '3']]],
    [/BAV99|BAT54S|BAS40-05|BAS70-05|BAS40T-05|BAT54SW/, [['1', '3'], ['3', '2']]],
    [/BAW56|BAT54A|BAS40-06|BAS70-06|BAT54AW/, [['3', '1'], ['3', '2']]],
  ];
  // SOT-363 / SOT-563 duals: pin -> [unit, role]
  const DUAL6 = { '1': [1, 'S'], '2': [1, 'G'], '3': [2, 'D'], '4': [2, 'S'], '5': [2, 'G'], '6': [1, 'D'] };
  const DUAL6B = { '1': [1, 'E'], '2': [1, 'B'], '3': [2, 'C'], '4': [2, 'E'], '5': [2, 'B'], '6': [1, 'C'] };
  const SO8DUAL = { '1': [1, 'S'], '2': [1, 'G'], '3': [2, 'S'], '4': [2, 'G'], '5': [2, 'D'], '6': [2, 'D'], '7': [1, 'D'], '8': [1, 'D'] };
  const polar = nm => { const s = up(nm); return /(^|[^A-Z])(D?P|DP|POS)$|\+$|_P$|PLUS|_DP\b|D\+/.test(s) ? 'P' : /(^|[^A-Z])(D?N|DN|DM|NEG)$|-$|_N$|MINUS|_DN\b|_DM\b|D-/.test(s) ? 'N' : ''; };
  const freqOf = s => { const m = /(\d+(?:\.\d+)?)\s*(MHZ|KHZ|M\b|K\b)/i.exec(s || ''); if (!m) return null; return +m[1] * (/^K/i.test(m[2]) ? 1e3 : 1e6); };

  function composite(c, ctx) {
    const P = ctx || ctxOf(c, { nets: [] });
    const t = P.text, pins = P.pins, n = pins.length, ref = up(c.ref);
    const pre = (/^[A-Z]+/.exec(ref) || [''])[0];
    const named = rx => pins.filter(p => rx.test(p.name));
    const sub = [];
    const link = (a, b, r) => sub.push({ t: 'R', a, b, v: r || 0.01 });
    if (!n) return null;
    const pin = num => pins.find(p => p.num === String(num));
    const all = t + ' ' + P.lib + ' ' + P.pkg;
    // relays: the coil as a resistor; the contacts close (NO) or open (NC) when enough current flows in the coil
    if ((/^(K|RL|RLY|REL|RELAY)$/.test(pre) || /RELAY/.test(t)) && /RELAY|G5V|G6K|G5LE|HK19F|HK4100|SRD-|TQ2|HF46F|HF115|JQC|AQY|OMRON|IM0\d|EE2-|PANASONIC.*TX|TX2-|SANYOU|FTR-|V23|RT\d{6}|AXICOM/.test(all)) {
      const coil = pins.filter(p => /^(A1|A2|COIL\+?|COIL-|COIL_?\d|L\d|L\+|L-|\+|-)$/.test(p.name));
      const vm = /(\d+(?:\.\d+)?)\s*V(DC)?\b/.exec(t) || /-(3|5|6|9|12|24)(V|VDC|DC|-|$)/.exec(t);
      const vc = vm ? +vm[1] : 5, rc = Math.max(10, vc * vc / 0.36);
      if (coil.length === 2) {
        sub.push({ t: 'R', a: coil[0].num, b: coil[1].num, v: +rc.toPrecision(3), key: 'coil' });
        const inom = vc / rc;
        const poles = new Map();
        for (const p of pins) {
          const m = /^(COM|C|NO|NC|11|12|14|21|22|24)(\d?)$/.exec(p.name);
          if (!m) continue;
          const role = /^(COM|C|11|21)$/.test(m[1]) ? 'com' : /^(NO|14|24)$/.test(m[1]) ? 'no' : 'nc';
          const k = m[2] || (/^2/.test(m[1]) ? '2' : '1');
          if (!poles.has(k)) poles.set(k, {});
          poles.get(k)[role] = p.num;
        }
        for (const [k, o] of poles) {
          if (!o.com) continue;
          if (o.no) sub.push({ t: 'SW', a: o.com, b: o.no, key: 'NO' + k, ctl: 0, thr: inom * 0.6, off: inom * 0.3, inv: false, closed: false, auto: true });
          if (o.nc) sub.push({ t: 'SW', a: o.com, b: o.nc, key: 'NC' + k, ctl: 0, thr: inom * 0.6, off: inom * 0.3, inv: true, closed: true, auto: true });
        }
        return { kind: 'relay', label: vc + ' V relay: the contacts follow the coil', sub };
      }
    }
    // optocouplers: the LED inside, and the output transistor as a switch that closes when the LED carries current
    // (word starts matter: TPS2553 is a USB power switch, not a PS25xx optocoupler)
    if (/OPTO|\bPC817|\bEL817|\bLTV-?8\d\d|\bLTV-?3\d\d|\bLTV-?2\d\d|\bTLP\d{3}|\b4N2[5-8]|\b4N3[5-7]|\bH11[A-L]\d|\bPS25\d\d|\bPS28\d\d|\bFOD8\d\d|\bFOD81\d|\bCNY17|\bSFH6\d\d|\bK?PC?817|\bTCMT\d|\bVO6\d\d|\bPC357|\bEL357|\bTLP29\d|\bACPL|\bHCPL|\b6N13\d|\b6N137|PHOTOCOUPLER/.test(t) && !/LOAD.?SWITCH|POWER.?SWITCH|DISTRIBUTION|CURRENT.?LIMIT|REGULATOR/.test(t)) {
      const A = P.one(/^(A|AN|ANODE|LED\+|\+)$/), K = P.one(/^(K|C|CA|CATHODE|LED-|-)$/), Cc = P.one(/^(C|COL|COLLECTOR|D|VO)$/), E = P.one(/^(E|EMI|EMITTER|S)$/);
      let a = A && A.num, k = K && K !== Cc ? K.num : null, cc = Cc && Cc !== K ? Cc.num : null, e = E && E.num;
      if (!(a && k && cc && e)) { if (n === 4) { a = '1'; k = '2'; e = '3'; cc = '4'; } else if (n === 6) { a = '1'; k = '2'; e = '4'; cc = '5'; } }
      if (pin(a) && pin(k) && pin(cc) && pin(e)) {
        sub.push({ t: 'D', a, b: k, model: 'DIR', key: 'led' }, { t: 'SW', a: cc, b: e, key: 'out', ctl: 0, thr: 5e-4, off: 2e-4, inv: false, closed: false, auto: true, ron: 150 });
        return { kind: 'opto', label: 'optocoupler: the output conducts while its LED is on', sub };
      }
    }
    // shunt voltage references (LM4040, TL4050, LM385) and TL431 with REF tied to the cathode: a precise zener
    if (/LM4040|LM4041|LM4050|LM4051|TL4050|LT1004|LT1009|LM385|LM336|ZXRE|AZ432|ADR5\d\d|REF30\d\d.*SHUNT|SHUNT.?(VOLTAGE.?)?REF|TL431|TLV431|AZ431|ATL431|KA431|LMV431|NCP431|SC431/.test(t)) {
      const A = P.one(/^(A|ANODE|-)$/), K = P.one(/^(K|C|CATHODE|\+)$/), REF = P.one(/^(REF|R|ADJ|FB)$/);
      if (A && K) {
        let v = null;
        const m = /(\d+(?:\.\d+)?)\s*V\b/.exec(P.c.description || '') || /(\d+(?:\.\d+)?)\s*V\b/.exec(P.c.value || '');
        if (m && +m[1] > 0.9 && +m[1] < 40) v = +m[1];
        if (/431/.test(t)) {
          v = 2.495;
          // REF on a divider from the cathode: V = 2.495 (1 + Rtop / Rbottom)
          if (REF && REF.net && REF.net !== K.net) { const r = divider(P, REF.net, K.net, A.net); if (r) v = +(2.495 * (1 + r.top / r.bot)).toFixed(3); }
        }
        if (v == null) { const k2 = /(LM404\d|LM405\d|TL4050)[A-Z]*?(\d{2})/.exec(t); if (k2) v = { 10: 1.225, 12: 1.225, 20: 2.048, 25: 2.5, 30: 3.0, 41: 4.096, 50: 5.0, 82: 8.192 }[k2[2]] || null; if (/TL4050C10/.test(t)) v = 10; }
        if (v == null) v = 2.5;
        sub.push({ t: 'D', a: A.num, b: K.num, model: 'DZ', bv: v });
        return { kind: 'vref', label: 'shunt reference ' + v + ' V', sub };
      }
    }
    // ideal-diode and OR-ing controllers with the switch inside: a diode with a very small drop from IN to OUT
    if (/IDEAL.?DIODE|LTC4358|LTC4411|LTC4412|LM66100|LM66200|MAX40200|TPS2113|TPS2115|TPS2116|AP2210|DIODE.?OR|POWER.?MUX|ORING/.test(t)) {
      const ins = pins.filter(p => /^(IN\d?|VIN\d?|A|VDD?IN|INA|INB)$/.test(p.name) && !p.nc), out = P.one(/^(OUT|VOUT|K|OUTPUT)$/);
      if (ins.length && out) {
        const nets = new Set();
        for (const p of ins) { if (nets.has(p.net)) continue; nets.add(p.net); sub.push({ t: 'D', a: p.num, b: out.num, model: 'DIDEAL' }); }
        return { kind: 'idealdiode', label: 'ideal diode (input to output, tiny drop)', sub };
      }
    }
    // three-pad solder jumpers: which side is bridged
    if (n === 3 && (/^(JP|SJ)$/.test(pre) || /SOLDER.?JUMPER|SOLDERJUMPER|JUMPER|SJ\dW|SJ_\d/.test(all))) {
      // Bridged12, Closed(1-2)/Opened(2-3), SJ_2_SMALL_12_TIED
      const b123 = /BRIDGED123|CLOSED\(?1-2-3/.test(all);
      const b12 = b123 || /BRIDGED_?12|(CLOSED|TIED)[^A-Z0-9]*\(?1-?2\b|\b12_TIED/.test(all), b23 = b123 || /BRIDGED_?23|(CLOSED|TIED)[^A-Z0-9]*\(?2-?3\b|\b23_TIED/.test(all);
      sub.push({ t: 'SW', a: '1', b: '2', key: '1-2', closed: b12 || b123 }, { t: 'SW', a: '2', b: '3', key: '2-3', closed: b23 || b123 });
      return { kind: 'jumper3', label: 'three-pad solder jumper', sub };
    }
    // four-terminal current shunts: the resistance between the force pads, the sense pads at their ends
    if (n === 4 && (/SHUNT|KELVIN|4.?TERMINAL|R_SHUNT|WSK\d|WSL\d.*4|FMF\d|PMR\d|CSS2H|LVK\d/.test(all) || (/^(R|RS|RSH|SH)$/.test(pre) && /SHUNT/.test(all)))) {
      const v = valueOf(c.value, 'ohm') || 0.01;
      sub.push({ t: 'R', a: '1', b: '4', v }, { t: 'R', a: '1', b: '2', v: 0.001 }, { t: 'R', a: '4', b: '3', v: 0.001 });
      return { kind: 'shunt', label: 'current shunt ' + (v < 1 ? +(v * 1000).toPrecision(3) + ' mΩ' : v + ' Ω'), sub };
    }
    // ESD / TVS arrays: high impedance in normal use; flow-through pins with the same name are one line inside
    if (/ESD|TVS|USBLC|PESD|TPD\d+E|SP30\d\d|SRV05|SRDA|PRTR5V|IP4234|RCLAMP|ESDA|CDSOT|NUP\d|TVS2200|ESDS3|ESDR05|SMF\d|PUSB|TPD2E|TPD4E|D_TVS/.test(t)) {
      const byName = new Map();
      for (const p of pins) if (p.name && !/^(GND|VSS|VBUS|VCC|VDD|NC)$/.test(p.name)) { if (!byName.has(p.name)) byName.set(p.name, []); byName.get(p.name).push(p.num); }
      for (const [, list] of byName) for (let i = 1; i < list.length; i++) link(list[0], list[i], 0.05);
      return { kind: 'esd', label: 'ESD protection (no effect in normal use)', sub };
    }
    // common-mode chokes / EMI filters: two windings, paired by the polarity in the net names
    if (n === 4 && /COMMON.?MODE|CHOKE|EMI|ACM\d|DLW\d|DLP\d|CMC|FILTER_EMI|SRF\d|WCM\d/.test(t)) {
      const pp = pins.filter(p => polar(p.net) === 'P'), nn = pins.filter(p => polar(p.net) === 'N');
      if (pp.length === 2 && nn.length === 2) { link(pp[0].num, pp[1].num, 0.2); link(nn[0].num, nn[1].num, 0.2); }
      else { link('1', '2', 0.2); link('3', '4', 0.2); }
      return { kind: 'choke', label: 'common-mode choke (two windings)', sub };
    }
    // crystals with ground pads: the oscillator inside the chip drives them
    if ((/^(Y|X|XTAL|XT|OSC)$/.test(pre) || /CRYSTAL|XTAL|\dMHZ\b|\dKHZ\b|ABM\d|ECS-|TSX-|FA-\d|NX\d{4}|7M\d|ABS\d|X\d{3}/.test(t)) && n >= 3 && n <= 4 && !pins.some(p => /^(VDD|VCC|OUT|OE|EN|ST)$/.test(p.name))) {
      return { kind: 'crystal', label: 'crystal' + (freqOf(t) ? ' ' + fmtHz(freqOf(t)) : ''), hz: freqOf(t), sub };
    }
    // switches: two pins, four-pin tactile switches (pairs joined inside), SPDT slide switches, DIP switches, key switches
    const isSwitch = /^(SW|S|BTN|BUT|KEY|K|SWL|SWR|SWN|SWT|MX|KSW|PB|SA|SB|RSW|LSW|SMDSW|EXSW|RST|BOOT)$/.test(pre) && !/REGULATOR|CONVERTER|MOSFET|LOAD|ANALOG|USB|RF|RELAY|LED|DIODE/.test(t) || /PUSH.?BUTTON|TACTILE|KEY.?SWITCH|KEYSWITCH|KEYSW|HOT.?SWAP|SW_PUSH|SW_SPST|SW_SPDT|SW_DIP|SLIDE.?SWITCH|DIP.?SWITCH|SKQG|PTS\d|TL3340|EVQ|B3F|TS-\d|SW_MEC|KAILH|CHERRY|CPG\d|MX_|GATERON|TOGGLE.?SWITCH|SWITCH,|\bSWITCH\b/.test(t) && !/LOAD.?SWITCH|POWER.?SWITCH|ANALOG.?SWITCH|USB.?SWITCH|RF.?SWITCH|SWITCHING|SWITCHER|SWITCH.?MODE|MUX|ETHERNET|FET\b|MOSFET|HIGH.?SIDE|LOW.?SIDE|HALL|DISTRIBUTION|PROTECTION|CROSSBAR|MATRIX|REGULATOR|CONVERTER|CONTROLLER|DRIVER/.test(t);
    if (isSwitch && !/ENCODER/.test(t)) {
      // shield / mounting legs do not switch
      const sig = pins.filter(p => !/^(MP|SH|SHIELD|EP|MH|PAD|GND_?MP)\d*$/.test(p.name) && !/^MP/.test(p.num) && !(p.nc && !p.name));
      if (sig.length === 2) { sub.push({ t: 'SW', a: sig[0].num, b: sig[1].num, key: '' }); return { kind: 'switch', label: /KEY|MX|CHOC|KAILH|CHERRY|GATERON|CPG/.test(all) ? 'key switch' : 'push button', sub }; }
      if (n === 2) { sub.push({ t: 'SW', a: pins[0].num, b: pins[1].num, key: '' }); return { kind: 'switch', label: 'push button', sub }; }
      // DIP switches: SWk_A / SWk_B or k / 2N+1-k
      const dip = new Map();
      for (const p of pins) { const m = /^SW?(\d+)_?([AB])$/.exec(p.name); if (m) { if (!dip.has(m[1])) dip.set(m[1], {}); dip.get(m[1])[m[2]] = p.num; } }
      if (dip.size >= 2 && [...dip.values()].every(o => o.A && o.B)) { for (const [k, o] of dip) sub.push({ t: 'SW', a: o.A, b: o.B, key: k }); return { kind: 'dip', label: dip.size + '-way DIP switch', sub }; }
      if (/DIP/.test(t) && n >= 4 && n % 2 === 0) { const h = n / 2; for (let i = 1; i <= h; i++) sub.push({ t: 'SW', a: String(i), b: String(n + 1 - i), key: String(i) }); return { kind: 'dip', label: h + '-way DIP switch', sub }; }
      if (sig.length === 3 || (/SPDT|SLIDE|TOGGLE/.test(t) && sig.length >= 3)) {
        const com = sig.find(p => /^(C|COM|2|COMMON|P)$/.test(p.name)) || sig[1], others = sig.filter(p => p !== com).slice(0, 2);
        sub.push({ t: 'SW', a: com.num, b: others[0].num, key: 'A', closed: true, spdt: true }, { t: 'SW', a: com.num, b: others[1].num, key: 'B', closed: false, spdt: true, throw: true });
        return { kind: 'spdt', label: 'changeover switch', sub };
      }
      if (sig.length >= 4) {
        // four legs: the two legs on one side are one contact; which pairs are joined follows the nets, else 1-2 / 3-4
        const [a, b, cc, d] = sig;
        if (a && b && cc && d) {
          let A = [a, b], Bp = [cc, d];
          if (a.net && a.net === cc.net) { A = [a, cc]; Bp = [b, d]; } else if (a.net && a.net === d.net) { A = [a, d]; Bp = [b, cc]; }
          link(A[0].num, A[1].num); link(Bp[0].num, Bp[1].num);
          sub.push({ t: 'SW', a: A[0].num, b: Bp[0].num, key: '' });
          return { kind: 'switch', label: 'push button', sub };
        }
      }
    }
    // rotary encoders: A and B to C (contacts that the knob opens and closes), the push switch S1-S2
    if (/ENCODER|EC11|EC12|PEC1\d|ROTARY/.test(t)) {
      const A = P.one(/^A$/), B = P.one(/^B$/), C = P.one(/^(C|COM)$/), S1 = P.one(/^S1$/), S2 = P.one(/^S2$/);
      if (A && B && C) { sub.push({ t: 'SW', a: A.num, b: C.num, key: 'A' }, { t: 'SW', a: B.num, b: C.num, key: 'B' }); if (S1 && S2) sub.push({ t: 'SW', a: S1.num, b: S2.num, key: 'S' }); return { kind: 'encoder', label: 'rotary encoder', sub }; }
    }
    // RGB / bi-colour LEDs: one LED per colour, common anode or cathode
    if (/LED|RGB/.test(t) && n >= 3 && n <= 6) {
      const an = P.one(/^(A|COM|CA|ANODE|\+|VDD)$/), ks = pins.filter(p => /^(R|G|B|RK|GK|BK|K_?R|K_?G|K_?B|RED|GREEN|BLUE)$/.test(p.name));
      const kc = P.one(/^(K|CC|CATHODE|-|GND)$/), as = pins.filter(p => /^(R|G|B|RA|GA|BA|A_?R|A_?G|A_?B|RED|GREEN|BLUE)$/.test(p.name));
      const col = nm => /R/.test(nm) && !/G|B/.test(nm.replace(/K|A/g, '')) ? [255, 40, 30] : /G/.test(nm) ? [40, 255, 90] : [60, 120, 255];
      if (an && ks.length >= 2) { for (const k of ks) sub.push({ t: 'LED', a: an.num, b: k.num, col: col(k.name) }); return { kind: 'rgb', label: ks.length + '-colour LED', sub }; }
      if (kc && as.length >= 2) { for (const a of as) sub.push({ t: 'LED', a: a.num, b: kc.num, col: col(a.name) }); return { kind: 'rgb', label: as.length + '-colour LED', sub }; }
    }
    // diodes with other prefixes (key matrix diodes DR1 …) and dual diodes
    if (/DIODE|D_SMALL|SCHOTTKY|ZENER|BAV|BAT\d|BAS\d|1N4\d|1N58|RB\d{3}|MBR|SS\d\d|B5819|PMEG|DSS|SBR/.test(t) && !/LED|TVS|ESD|BRIDGE/.test(t)) {
      const model = /SCHOTTKY|BAT\d|BAS40|BAS70|1N58|RB\d|MBR|SS\d|B5819|PMEG|SBR|STPS/.test(t) ? 'DSCH' : /ZENER|BZX|MMSZ/.test(t) ? 'DZ' : 'DGEN';
      const A = pins.filter(p => /^A\d?$/.test(p.name)), K = pins.filter(p => /^K\d?$/.test(p.name));
      if (n === 2 && A.length === 1 && K.length === 1) { sub.push({ t: 'D', a: A[0].num, b: K[0].num, model }); return { kind: 'diode', label: 'diode', sub }; }
      if (n === 3) {
        // by pin names: two anodes and a cathode, or the reverse; A1/K1 A2/K2 pairs
        if (A.length === 2 && K.length === 1) { for (const a of A) sub.push({ t: 'D', a: a.num, b: K[0].num, model }); return { kind: 'diodes', label: 'dual diode, common cathode', sub }; }
        if (K.length === 2 && A.length === 1) { for (const k of K) sub.push({ t: 'D', a: A[0].num, b: k.num, model }); return { kind: 'diodes', label: 'dual diode, common anode', sub }; }
        for (const [rx, list] of DUAL_DIODE) if (rx.test(t)) { for (const [a, k] of list) sub.push({ t: 'D', a, b: k, model }); return { kind: 'diodes', label: 'dual diode', sub }; }
      }
    }
    // resistor / capacitor arrays: R1.1-R1.2 by name, k.1-k.2 by number, else i-(n+1-i)
    const isR = /^(R|RN|RA|RM|RP|RR)$/.test(pre) && n >= 4, isC = /^(C|CN|CA)$/.test(pre) && n >= 4;
    if ((isR || isC || /RESISTOR.?ARRAY|RES.?NET|RESISTOR NETWORK|R_ARRAY|R_PACK|CAY16|CAT16|EXB-|YC\d{3}|4X0603|4X0402|8X0402/.test(all)) && n % 2 === 0) {
      const v = c.value || '';
      const pairs = [];
      const byNm = new Map();
      for (const p of pins) { const m = /^[RC]?(\d+)[._]([12AB])$/.exec(p.name); if (m) { if (!byNm.has(m[1])) byNm.set(m[1], {}); byNm.get(m[1])[m[2] === 'A' ? '1' : m[2] === 'B' ? '2' : m[2]] = p.num; } }
      if (byNm.size === n / 2 && [...byNm.values()].every(o => o['1'] && o['2'])) for (const [, o] of byNm) pairs.push([o['1'], o['2']]);
      else if (pins.every(p => /^\d+\.[12]$/.test(p.num))) { const g = new Map(); for (const p of pins) { const [k, s] = p.num.split('.'); if (!g.has(k)) g.set(k, {}); g.get(k)[s] = p.num; } for (const [, o] of g) if (o['1'] && o['2']) pairs.push([o['1'], o['2']]); }
      else { const nums = pins.map(p => p.num).sort((a, b) => (+a || 0) - (+b || 0)); const h = nums.length / 2; for (let i = 0; i < h; i++) pairs.push([nums[i], nums[nums.length - 1 - i]]); }
      for (const [a, b] of pairs) sub.push({ t: isC ? 'C' : 'R', a, b, value: v });
      return { kind: isC ? 'carray' : 'rarray', label: (isC ? 'capacitor' : 'resistor') + ' array ×' + pairs.length + (v ? ' ' + v : ''), sub };
    }
    // dual transistors: S1/G1/D1 … names, else the usual SOT-363 / SO-8 pin-outs
    const notAmp = !/AMPLIFIER|OPERATIONAL|COMPARATOR|OP.?AMP|JFET.?INPUT|REGULATOR|CONVERTER|DRIVER|MICROCONTROLLER/.test(t);
    const dualFet = notAmp && /DUAL.*(MOSFET|\bN?P?-?FET\b|N-CH|P-CH)|MOSFET.*DUAL|2N7002DW|DMG1029|DMC\d|DMN\d{4}DW|SI4\d{3}DY|AO4\d{3}|NTJD|FDS89|BSS138DW|SSM6N|SI1\d{3}EDH|NX3008/.test(t), dualBjt = notAmp && /DUAL.*(TRANSISTOR|BJT|NPN|PNP)|(NPN|PNP).*DUAL|MBT\d{4}DW|BC847BS|BC857BS|MMDT|DMMT|2PNP|2NPN|UMH\d|EMH\d|PUMH|PEMH|BC846BS|PMP4201|DW1\b/.test(t);
    if ((dualFet || dualBjt) && (n === 6 || n === 8)) {
      const roles = dualFet ? ['G', 'D', 'S'] : ['B', 'C', 'E'];
      const units = { 1: {}, 2: {} };
      let ok = true;
      for (const p of pins) { const m = new RegExp('^(' + roles.join('|') + ')([12])$').exec(p.name); if (m) units[m[2]][m[1]] = p.num; else ok = false; }
      if (!ok) {
        const map = n === 8 ? SO8DUAL : dualFet ? DUAL6 : DUAL6B;
        units[1] = {}; units[2] = {};
        for (const p of pins) { const r = map[p.num]; if (r && !units[r[0]][r[1]]) units[r[0]][r[1]] = p.num; }
      }
      for (const u of [1, 2]) {
        const o = units[u];
        if (!roles.every(r => o[r])) return null;
        if (dualFet) {
          const sp = pins.find(p => p.num === o.S);
          const pch = /P-?CH|PMOS|DUAL P|P-CHANNEL/.test(t) && !/N AND P|N\/P|COMPLEMENTARY|N- AND P|N & P/.test(t) ? true : /COMPLEMENTARY|N AND P|N\/P|N & P|N- AND P/.test(t) ? !!(sp && sp.kind === 'power' && !(sp.kind === 'ground')) : false;
          sub.push({ t: 'M', d: o.D, g: o.G, s: o.S, pch });
        } else {
          const pnp = /PNP/.test(t) && !/NPN/.test(t) ? true : /NPN/.test(t) && !/PNP/.test(t) ? false : /\bBS\b|COMPLEMENTARY|NPN.?PNP|PNP.?NPN/.test(t) ? u === 2 : /3906|857|2907|UMT|PNP/.test(t);
          const dg = digital(all);
          if (dg) sub.push({ t: 'R', a: o.B, b: 'Bi' + u, v: dg.r1 }, { t: 'R', a: 'Bi' + u, b: o.E, v: dg.r2 }, { t: 'Q', c: o.C, b: 'Bi' + u, e: o.E, pnp });
          else sub.push({ t: 'Q', c: o.C, b: o.B, e: o.E, pnp });
        }
      }
      return { kind: dualFet ? 'dualfet' : 'dualbjt', label: 'dual ' + (dualFet ? 'MOSFET' : digital(all) ? 'digital transistor (base resistors inside)' : 'transistor'), sub };
    }
    // single transistors with unnamed pins: the symbol name (Q_NPN_BEC, Q_NMOS_GSD), else the package's usual pin-out
    if (n >= 3 && n <= 5 && notAmp && (/^(Q|T|TR|FET|M|QN|QP|MOS|NPN|PNP)$/.test(pre) || /MOSFET|TRANSISTOR|\bBJT\b/.test(t))) {
      const S = N.simtab || {};
      const fet = /MOSFET|\bFET\b|NMOS|PMOS|Q_NMOS|Q_PMOS|N-CH|P-CH|2N7002|BSS1\d\d|BSS84|AO3\d{3}|AO4\d{3}|SI23\d\d|DMG\d|DMN\d|DMP\d|IRLML|IRF|NTR\d|FDN\d|SSM3K|SSM3J|PMV\d|RQ5|NX7002|AON\d|RU\d{3}|RJK|BUK\d|WPM\d|WNM\d|YJG\d|CJ\d{4}|\d+N\d{2}[A-Z]?\b|\d+P\d{2}[A-Z]?\b/.test(all);
      const bjt = !fet && /NPN|PNP|BJT|TRANSISTOR|MMBT|BC8\d\d|BC5\d\d|BC3\d\d|2N3904|2N3906|2N2222|2N4401|2N4403|S8050|S8550|SS8050|SS8550|PBSS|BCX\d|MMBTA|PMBT|DTC\d|DTA\d|MUN\d|KTC\d|KTA\d|2SC\d|2SA\d|Q_NPN|Q_PNP|TIP\d|BD\d{3}/.test(all);
      if (fet || bjt) {
        const sig = pins.filter(p => !p.nc || p.name);
        const named = {};
        const roles = fet ? ['G', 'D', 'S'] : ['B', 'C', 'E'];
        for (const p of sig) if (roles.includes(p.name)) named[p.name] = p.num;
        let o = roles.every(r => named[r]) ? named : null;
        if (!o) {
          // Q_NPN_BEC / Q_NMOS_GSD / Q_PMOS_GDS: the letters are pins 1, 2, 3
          const m = /Q_[NP](PN|MOS)_([BCEGDS]{3})/.exec(P.lib) || /_([BCEGDS]{3})\b/.exec(P.lib);
          let order = m ? (m[2] || m[1]) : null;
          if (!order || !roles.every(r => order.includes(r))) {
            if (/SOT-?23|SOT-?323|SC-?70|SOT-?416|SOT-?523|SOT-?723|SOT-?883|SC-?59|SOT-?346|SOT-?1123/.test(P.pkg)) order = fet ? 'GSD' : 'BEC';
            else if (/TO-?92/.test(P.pkg)) order = fet ? 'DGS' : /BC5\d\d|BC3\d\d/.test(t) ? 'CBE' : 'EBC';
            else if (/TO-?220|TO-?247|TO-?252|TO-?263|DPAK|D2PAK|IPAK/.test(P.pkg)) order = fet ? 'GDS' : 'BCE';
            else if (/SOT-?89|SOT-?223/.test(P.pkg)) order = fet ? 'GDS' : 'BCE';
            else order = fet ? 'GSD' : 'BEC';
          }
          o = {};
          for (let i = 0; i < 3; i++) { const p = pin(String(i + 1)); if (p) o[order[i]] = p.num; }
        }
        if (roles.every(r => o[r])) {
          if (fet) sub.push({ t: 'M', d: o.D, g: o.G, s: o.S, pch: (S.PMOS_RX ? S.PMOS_RX.test(all) : /PMOS|P-CH/.test(all)) || /\d+P\d{2}[A-Z]?\b/.test(t) && !/\d+N\d{2}/.test(t) });
          else {
            const pnp = S.PNP_RX ? S.PNP_RX.test(all) : /PNP/.test(all), dg = digital(all);
            if (dg) sub.push({ t: 'R', a: o.B, b: 'Bi', v: dg.r1 }, { t: 'R', a: 'Bi', b: o.E, v: dg.r2 }, { t: 'Q', c: o.C, b: 'Bi', e: o.E, pnp });
            else sub.push({ t: 'Q', c: o.C, b: o.B, e: o.E, pnp });
          }
          return { kind: fet ? 'mosfet' : 'bjt', label: fet ? 'MOSFET' : digital(all) ? 'digital transistor (base resistors inside)' : 'transistor', sub };
        }
      }
    }
    // two-pin diodes and LEDs with unusual names or prefixes (C for the cathode, pins 1 and 2)
    if (n === 2 && /\bLEDS?\b|LED_|DIODE|D_SMALL|SCHOTTKY|ZENER|RECTIFIER/.test(all)) {
      const a = P.one(/^(A|ANODE|\+|AN)$/) || pin('2'), k = P.one(/^(K|C|CATHODE|-|KA)$/) || pin('1');
      if (a && k && a !== k) {
        const led = /\bLEDS?\b|LED_/.test(all);
        sub.push(led ? { t: 'LED', a: a.num, b: k.num, col: null } : { t: 'D', a: a.num, b: k.num, model: /SCHOTTKY|BAT\d|SS\d|MBR/.test(t) ? 'DSCH' : /ZENER/.test(t) ? 'DZ' : 'DGEN' });
        return { kind: led ? 'led' : 'diode', label: led ? 'LED' : 'diode', sub };
      }
    }
    // a coin cell or battery holder
    if ((/^(BT|BAT|B|BATT|CELL)$/.test(pre) && /BATT|CELL|CR\d{4}|COIN|LIPO|LI-?ION|18650|AAA?\b/.test(all + ' ' + pre) || /^(BT|BAT|BATT)$/.test(pre)) && n >= 2) {
      const plus = P.one(/^(\+|POS|VBAT|BAT\+|P)$/) || pins.find(p => p.kind === 'power') || pins[0], minus = P.one(/^(-|NEG|GND|BAT-|N)$/) || pins.find(p => p.kind === 'ground') || pins.find(p => p !== plus);
      const v = /CR\d{4}|LIR|COIN|3V\b/.test(t) ? 3.0 : /2XAA|2 ?X ?AA/.test(t) ? 3.0 : /AA|AAA|1\.5V/.test(t) ? 1.5 : /9V/.test(t) ? 9 : 3.7;
      if (plus && minus) { sub.push({ t: 'BAT', a: plus.num, b: minus.num, v, rs: v <= 3 ? 10 : 0.15 }); return { kind: 'battery', label: v + ' V battery', sub }; }
    }
    // buzzers, speakers, motors: a coil
    if (/^(BZ|LS|SPK|M|MOT)$/.test(pre) && n === 2) { sub.push({ t: 'R', a: pins[0].num, b: pins[1].num, v: /^M/.test(pre) ? 10 : /SPK|LS/.test(pre) ? 8 : 40 }); return { kind: 'coil', label: /^M/.test(pre) ? 'motor' : 'buzzer / speaker', sub }; }
    return null;
  }

  // ---------------------------------------------------------------- roles: what each pin of a chip does
  // role: vdd, gnd, in, nc, hi, lo, pd (weak low), pu (weak high), z, od (open drain, released), odlo (open drain, low),
  // pull {to: 'gnd'|'vdd', r}, clk {hz}, follow {from, invert, oe, oeLow, dir, dirOut (DIR level that makes this pin an output)},
  // gate {fn, from: [pins], od}, reset {vth, od, low}, stat (charger status, open drain low while charging), sink {mA, en, enLow},
  // half (a fast signal's average), level {v}
  const ROLE_TXT = {
    vdd: 'supply', gnd: 'ground', in: 'input', nc: 'not connected', hi: 'drives high', lo: 'drives low', pd: 'weak pull-down (idle low)', pu: 'weak pull-up (idle high)',
    z: 'high impedance', od: 'open drain, released', odlo: 'open drain, pulls low', pull: 'resistor', clk: 'clock output', follow: 'follows', gate: 'logic gate output',
    reset: 'reset output', stat: 'status output (low while charging)', sink: 'constant-current sink', half: 'switching (average shown)', level: 'analog level', reg: 'regulated output',
  };
  const fmtHz = f => (f >= 1e6 ? +(f / 1e6).toPrecision(4) + ' MHz' : f >= 1e3 ? +(f / 1e3).toPrecision(4) + ' kHz' : f + ' Hz');

  // the supply pin a chip's outputs swing to (the I/O supply when there is one)
  function supplyFor(P, prefer) {
    const sup = P.pins.filter(p => !p.nc && p.kind !== 'ground' && (p.etype === 'power_in' || /^(VCC|VDD|VDDIO|VIO|VCCIO|VCC_?IO|VDD_?IO|VL|VDD33|VDD3V3|VCC33|DVDD|IOVDD|VDDA|AVDD|VDD\d*|VCC\d*|V\+|VS|PVDD|VLOGIC|VREF)$/.test(p.name)));
    if (prefer) { const q = sup.find(p => prefer.test(p.name)); if (q) return q; }
    return sup.find(p => /IO|VL\b|LOGIC/.test(p.name)) || sup.find(p => p.v != null && p.v >= 1.6 && p.v <= 3.6) || sup[0] || null;
  }
  const gate = (fn, ins) => {
    const v = ins.map(Boolean);
    switch (fn) { case 'and': return v.every(Boolean); case 'nand': return !v.every(Boolean); case 'or': return v.some(Boolean); case 'nor': return !v.some(Boolean);
      case 'xor': return v.filter(Boolean).length % 2 === 1; case 'xnor': return v.filter(Boolean).length % 2 === 0; case 'not': return !v[0]; default: return v[0]; }
  };

  // ---------------------------------------------------------------- built-in families
  // each: { id, name, match: rx on value + description, build(P) -> { roles: {pin: role}, chips?: [sim chip models], note } }
  const R = (role, o) => Object.assign({ role }, o || {});
  const LOGIC_FN = [[/(^|[^0-9])(1G|2G|3G)?(00|37|132)([^0-9]|$)/, 'nand'], [/(^|[^0-9])(1G|2G)?(02|36)([^0-9]|$)/, 'nor'], [/(^|[^0-9])(1G|2G)?(08|09|11|21)([^0-9]|$)/, 'and'], [/(^|[^0-9])(1G|2G)?(32)([^0-9]|$)/, 'or'],
    [/(^|[^0-9])(1G|2G)?(86|386)([^0-9]|$)/, 'xor'], [/(^|[^0-9])(1G|2G)?(04|05|06|14|19|240|540)([^0-9]|$)/, 'not'], [/(^|[^0-9])(1G|2G|3G)?(07|17|34|125|126|241|244|245|541|16|50|367|365|3S)([^0-9]|$)/, 'buf']];
  const families = [
    { id: 'translator', name: 'Level translator / bus transceiver', match: /TXB0|TXS0|TXU0|LVC\d?T45|AVC\d?T45|AVC\dT245|LVC8T245|LVC245|LVCH245|HC245|AHC245|ALVC164245|LSF0|PCA9306|GTL2003|NTB0|NTS0|74[A-Z]*245|74[A-Z]*16245|74[A-Z]*4245|74[A-Z]*64[05]|FXMA|ADG3304|SN74AXC|AXC\dT|BUS.?TRANSCEIVER/,
      build(P) {
        const roles = {};
        const vcca = P.one(/^(VCCA|VCC_?A|VL|VREF_?A|VCCI|VA)$/), vccb = P.one(/^(VCCB|VCC_?B|VCCY|VREF_?B|VCCO|VB)$/), vcc = P.one(/^(VCC|VDD)$/);
        const dir = P.one(/^(DIR|T\/R|1DIR|DIR1|A->B|A-B|AB\/BA|A\/B|DIR_?AB|T\/~?R)$/), oe = P.one(/^(OE|E|EN|~?OE|1OE|G|~?G)$/);
        const auto = /TXB0|TXS0|LSF0|PCA9306|GTL2003|NTB0|NTS0|FXMA|ADG3304/.test(P.text);
        const As = P.pins.filter(p => /^(\d?A\d*|A\d+|IO_?A\d*|I\/O_?A\d*|\dA\d?)$/.test(p.name)), Bs = P.pins.filter(p => /^(\d?B\d*|B\d+|IO_?B\d*|I\/O_?B\d*|\dB\d?)$/.test(p.name));
        const key = p => p.name.replace(/[AB]/, '#');
        const pairs = [];
        for (const a of As) { const b = Bs.find(q => key(q) === key(a)) || (As.length === 1 && Bs.length === 1 ? Bs[0] : null); if (b) pairs.push([a, b]); }
        // unnamed pins (TXU0104 …): the usual flow-through pin-out, inputs on one side
        if (!pairs.length && /TXU0\d0(\d)/.test(P.text)) { const k = +/TXU0\d0(\d)/.exec(P.text)[1]; for (let i = 0; i < k; i++) pairs.push([P.pins.find(p => p.num === String(2 + i)), P.pins.find(p => p.num === String(13 - i))]); }
        for (const [a, b] of pairs.filter(x => x[0] && x[1])) {
          if (auto || !dir) {
            // auto-direction parts and fixed A->B parts: B follows A (the side a processor drives decides in the runtime)
            roles[b.num] = R('follow', { from: a.num, oe: oe && oe.num, oeLow: oe && oe.low, vdd: (vccb || vcc || {}).num, auto });
            if (auto) roles[a.num] = R('follow', { from: b.num, oe: oe && oe.num, oeLow: oe && oe.low, vdd: (vcca || vcc || {}).num, auto, back: true });
          } else {
            roles[b.num] = R('follow', { from: a.num, oe: oe && oe.num, oeLow: oe ? oe.low || /~|\//.test(oe.name) || /245/.test(P.text) : false, dir: dir.num, dirOut: 1, vdd: (vccb || vcc || {}).num });
            roles[a.num] = R('follow', { from: b.num, oe: oe && oe.num, oeLow: oe ? oe.low || /245/.test(P.text) : false, dir: dir.num, dirOut: 0, vdd: (vcca || vcc || {}).num });
          }
        }
        return { roles, note: pairs.length + ' channel' + (pairs.length === 1 ? '' : 's') + (auto ? ', direction from the driven side' : dir ? ', direction from DIR' : '') };
      } },
    { id: 'logic', name: 'Logic gate / buffer', match: /74(LVC|HC|HCT|AHC|AHCT|ACT|AC|LV|LVX|VHC|ALVC|AUP|AUC|LS|F)?\d?G?\d{2,3}|SN74|NC7S|NC7SZ|NL17|NLX|TC7S|^SN7/,
      build(P) {
        const roles = {};
        const fn = (LOGIC_FN.find(([rx]) => rx.test(P.text.replace(/SN74|74[A-Z]*/, ' '))) || [0, 'buf'])[1];
        const od = /1G07|1G06|2G07|2G06|\b07\b|\b06\b|LVC07|HC07|HC05/.test(P.text);
        const vdd = supplyFor(P);
        // named gates: 1A 1B 1Y …, or A B Y for one gate
        const outs = P.pins.filter(p => /^(\d?Y\d?|\dY|Y)$/.test(p.name) || (/^(\d?Q\d?)$/.test(p.name) && p.etype === 'output'));
        for (const o of outs) {
          const k = o.name.replace(/[YQ]/, '');
          const ins = P.pins.filter(p => p !== o && new RegExp('^' + k + '[A-D]$|^[A-D]' + k + '$').test(p.name));
          const ins2 = ins.length ? ins : P.pins.filter(p => /^[A-D]$/.test(p.name));
          const oe = P.one(new RegExp('^' + (k || '') + '(OE|~?OE|G|E)$'));
          if (ins2.length) roles[o.num] = R(fn === 'buf' || fn === 'not' ? 'follow' : 'gate', fn === 'buf' || fn === 'not' ? { from: ins2[0].num, invert: fn === 'not', oe: oe && oe.num, oeLow: oe ? oe.low || /OE/.test(oe.name) : false, od, vdd: vdd && vdd.num } : { fn, from: ins2.map(p => p.num), od, vdd: vdd && vdd.num });
        }
        // unnamed pins: the common single / dual gate pin-outs
        if (!outs.length) {
          const tbl = /2G/.test(P.text) ? [['1', '6'], ['3', '4']] : /1G/.test(P.text) ? [[P.pins.length === 5 ? '2' : '2', '4']] : [];
          for (const [i, o] of tbl) if (P.pins.find(p => p.num === i) && P.pins.find(p => p.num === o)) roles[o] = R('follow', { from: i, invert: fn === 'not', od, vdd: vdd && vdd.num });
        }
        return Object.keys(roles).length ? { roles, note: (od ? 'open-drain ' : '') + fn } : null;
      } },
    { id: 'clockgen', name: 'Oscillator / clock generator', match: /OSCILLATOR|\bXO\b|TCXO|VCXO|CLOCK.?GEN|CLOCK.?BUFFER|PI6C|SI51\d|CDCE|LMK\d|DSC\d{4}|SIT\d{4}|ASE-|ASFL|ECS-\d{4}MV|FXO|KC\d{4}|SG-\d{3}|7XZ|ASCO|MCO-|ASEM|CB3LV|ICS\d{3}|9FG|PL\d{3}/,
      build(P) {
        const roles = {};
        const hz = freqOf(P.text) || null;
        const outs = P.pins.filter(p => /^(OUT|CLK\d*[NP]?|CLKOUT\d*|Q\d*[NP]?|CLK|FOUT|Y\d*|OUT\d*|REFOUT|SCLK)$/.test(p.name) && p.etype !== 'input');
        const en = P.one(/^(OE|EN|ST|E\/D|STANDBY|PD)$/);
        for (const o of outs) roles[o.num] = R('clk', { hz, en: en && en.num, enLow: en && /^(ST|STANDBY|PD)$/.test(en.name) ? true : en ? en.low : false, vdd: (supplyFor(P) || {}).num });
        return outs.length ? { roles, note: hz ? fmtHz(hz) : 'clock outputs' } : null;
      } },
    { id: 'supervisor', name: 'Supply supervisor / reset IC', match: /SUPERVISOR|VOLTAGE.?DETECT|RESET.?IC|APX8\d\d|TPS38\d\d|TPS37\d\d|MAX8\d\d|MAX6\d{3}|XC61\d\d|TLV80\d|MCP1\d\d-|MCP13\d|ADM8\d\d|STM8\d\d|BD52|BD48|RT9818|NCP30\d|TCM809|LM809|DS1233|MIC803/,
      build(P) {
        const out = P.one(/^(RESET|RST|NRST|RESETB|RESET_?N|OUT|VOUT|PG|PGOOD|WDO|RESET\/?)$/) || P.pins.find(p => /output|open_c/.test(p.etype));
        const vdd = P.one(/^(VCC|VDD|VIN|SENSE|VDDS)$/) || P.pins.find(p => p.etype === 'power_in' && p.kind !== 'ground');
        if (!out || !vdd) return null;
        const m = /THRESHOLD\s*(\d+(?:\.\d+)?)\s*V/.exec(P.text) || /-(\d)(\d)/.exec(P.text) || /(\d\.\d+)V/.exec(P.text);
        let vth = m ? (m[2] && !/THRESHOLD/.test(m[0]) && m[0].length === 3 ? +(m[1] + '.' + m[2]) : +m[1]) : null;
        if (vth != null && (vth > 6 || vth < 0.8)) vth = null;
        const od = out.etype === 'open_collector' || /809|803|MCP1\d1|TPS3839|N$|OD/.test(P.text) && !/810/.test(P.text);
        const activeLow = !/RESET$/.test(out.name) || out.low || /RESET|RST/.test(out.name);
        return { roles: { [out.num]: R('reset', { vdd: vdd.num, vth: vth || (vdd.v ? +(vdd.v * 0.9).toFixed(2) : 2.9), od, low: activeLow && !/810|PG/.test(P.text + out.name) }) }, note: 'threshold ' + (vth || 'about 90 % of the supply') + (vth ? ' V' : '') };
      } },
    { id: 'charger', name: 'Battery charger', match: /CHARGER|CHARGE.?MANAGEMENT|TP405\d|TP4054|MCP7383\d|MCP7384\d|BQ2407\d|BQ2405\d|BQ2410\d|BQ2429\d|LTC4054|LTC4065|MAX1555|IP5306|CN30\d\d|LP4060|XB408|SGM405\d|ETA60\d\d|BQ21040|STC4054|HT4928|TC4056/,
      build(P) {
        const vin = P.one(/^(VCC|VDD|VIN|IN|VBUS|VUSB)$/), bat = P.one(/^(BAT|VBAT|BATT|VBATT|BAT\+)$/), prog = P.one(/^(PROG|ISET|ISET1|RPROG|IPRG)$/);
        const stat = P.pins.filter(p => /^(STAT\d?|CHRG|CHG|STDBY|CHARGE|STATUS|PG|PGOOD|DONE|LED\d?)$/.test(p.name));
        if (!vin || !bat) return null;
        const roles = {};
        for (const s of stat) roles[s.num] = /^(STDBY|DONE|PG|PGOOD)$/.test(s.name) ? R('stat', { done: !/PG/.test(s.name), power: /PG/.test(s.name), vin: vin.num, bat: bat.num }) : R('stat', { vin: vin.num, bat: bat.num });
        // charge current from the program resistor (about 1000 V / R on TP405x, MCP738xx; 890 V / R on BQ240xx)
        let ilim = 0.5;
        if (prog) { const rp = progR(P, prog); if (rp) ilim = Math.min(2, (/BQ24/.test(P.text) ? 890 : /TP4056|TC4056/.test(P.text) ? 1200 : 1000) / rp); }
        const chips = [{ ref: P.c.ref, model: 'regulator', in: vin.num, out: bat.num, vout: 4.2, dropout: 0.15, ilim: +ilim.toFixed(3), series: 'diode', note: 'charger: 4.2 V, up to ' + Math.round(ilim * 1000) + ' mA (program resistor)' }];
        return { roles, chips, note: 'charges to 4.2 V at up to ' + Math.round(ilim * 1000) + ' mA' };
      } },
    { id: 'leddriver', name: 'LED driver (constant current)', match: /BCR4\d\d|BCR3\d\d|NSI45|AL5809|CAT4\d{3}|LED.?DRIVER|NSI50|LM3414|PAM2861|CL2\d|DIO5\d{3}|SN3\d{3}/,
      build(P) {
        const outs = P.pins.filter(p => /^(IOUT|OUT|I_?OUT|K|LED|LX)$/.test(p.name) || /^IOUT/.test(p.name));
        const en = P.one(/^(EN|V_?EN|PWM|DIM|CTRL|VEN)$/);
        const rext = P.one(/^(REXT|R_?EXT|ISET|RSET)$/);
        if (!outs.length) return null;
        let mA = /BCR4/.test(P.text) ? 10 : /NSI45(\d{3})/.test(P.text) ? +/NSI45(\d{3})/.exec(P.text)[1] / 10 : 20;
        if (rext) { const r = progR(P, rext); if (r) mA = Math.min(350, (/BCR4/.test(P.text) ? 0.83 : 1) * 1000 / r + (/BCR4/.test(P.text) ? 10 : 0)); }
        const roles = {};
        for (const o of outs) roles[o.num] = R('sink', { mA: +mA.toFixed(1), en: en && en.num, enLow: en && en.low, share: outs.length });
        return { roles, note: Math.round(mA) + ' mA' };
      } },
    { id: 'usbhub', name: 'USB hub', match: /USB.?HUB|CH33[45]|FE1\.1|GL85\d|GL3523|USB25\d\d|USB24\d\d|TUSB80\d\d|SL2\.1|HS8836|USB57\d\d|CYUSB33|VL8\d\d|RTS54\d\d/,
      build(P) {
        const roles = usbRoles(P, 'hub');
        for (const p of P.pins) {
          if (/^(PWREN\d?|PRTPWR\d?|PWR_?EN\d?|PWREN#?\d?)$/.test(p.name) && !p.nc && p.kind !== 'ground') roles[p.num] = R(p.low || /#|N$/.test(p.name) ? 'lo' : 'hi', { vdd: (supplyFor(P) || {}).num, note: 'downstream port power on' });
          if (/^(LED\d?|LED\d?\/.*|ACT|SUSP.*)$/.test(p.name) && !roles[p.num]) roles[p.num] = R('od');
          if (/^(XO|XOUT|XTAL_?OUT|XTALO|OSCO|X2|XTAL2)$/.test(p.name)) roles[p.num] = R('clk', { hz: 12e6 });
        }
        return { roles, note: 'upstream port pulled up (attached), downstream ports with host pull-downs' };
      } },
    { id: 'usbphy', name: 'USB PHY / transceiver', match: /USB33[0-4]\d|USB3300|USB3320|TUSB1210|TUSB1106|USB1T11|MAX3421|USB3740|TUSB2\d\d|ULPI/,
      build(P) {
        const id = P.one(/^ID$/);
        const host = id && id.kind === 'ground';
        const roles = usbRoles(P, host ? 'host' : 'device');
        const clk = P.one(/^(CLKOUT|CLK|REFCLK_?OUT)$/);
        if (clk && clk.etype === 'output') roles[clk.num] = R('clk', { hz: 60e6 });
        for (const p of P.pins) if (/^(DIR|NXT)$/.test(p.name)) roles[p.num] = R('lo', { vdd: (supplyFor(P, /VDDIO|VIO/) || {}).num });
        return { roles, note: host ? 'host role (ID grounded)' : 'device role' };
      } },
    { id: 'can', name: 'CAN transceiver', match: /TJA10\d\d|TJA11\d\d|MCP25(5|6)\d|SN65HVD2[3-5]\d|TCAN\d{3,4}|ISO1050|MAX3051|ATA6561|SIT1\d{3}|NCV7351|L9616|CAN.?TRANSCEIVER/,
      build(P) {
        const roles = {};
        const rx = P.one(/^(RXD|R|RX|CRX)$/), h = P.one(/^CANH$/), l = P.one(/^CANL$/);
        const vdd = supplyFor(P, /VIO|VCC|VDD/);
        if (rx) roles[rx.num] = R('hi', { vdd: vdd && vdd.num, note: 'recessive bus reads high' });
        if (h) roles[h.num] = R('pull', { mode: 'half', r: 25e3, vdd: vdd && vdd.num, note: 'recessive: half the supply' });
        if (l) roles[l.num] = R('pull', { mode: 'half', r: 25e3, vdd: vdd && vdd.num });
        return { roles, note: 'idle (recessive) bus' };
      } },
    { id: 'rs485', name: 'RS-485 / RS-422 transceiver', match: /MAX3485|MAX485|SP3485|SP485|THVD\d{4}|SN65HVD\d{2}\b|SN75176|ADM\d{4}|ISL83\d\d|ST3485|SIT3485|RS-?485/,
      build(P) {
        const roles = {}, vdd = supplyFor(P);
        const ro = P.one(/^(RO|R|RXD)$/), a = P.one(/^(A|Y|A\/Y)$/), b = P.one(/^(B|Z|B\/Z)$/);
        if (ro) roles[ro.num] = R('hi', { vdd: vdd && vdd.num, note: 'idle bus reads high (fail-safe)' });
        if (a) roles[a.num] = R('pull', { mode: 'pu', r: 100e3, vdd: vdd && vdd.num });
        if (b) roles[b.num] = R('pull', { mode: 'pd', r: 100e3 });
        return { roles, note: 'receiver on, bus idle' };
      } },
    { id: 'stepper', name: 'Stepper / motor driver', match: /TMC2\d{3}|TMC5\d{3}|A49\d\d|DRV88\d\d|DRV84\d\d|DRV83\d\d|TB6612|TB67S|L298|L293|STSPIN|LV8729|MP6500|BD6\d{3}|AT8833|MX1508|TC78H|DRV2605/,
      build(P) {
        const roles = {}, vdd = supplyFor(P, /VCC_?IO|VIO|VDD|VCC/), vm = P.one(/^(VS|VM|VMOT|VBB|VCP|VSA|VSB)$/);
        const outs = P.pins.filter(p => /^(OA\d|OB\d|AOUT\d|BOUT\d|OUT\d|OUT[AB]\d?|[AB]O\d|MOTA\d|M\d[AB]|OUT\d[AB]|A\d|B\d)$/.test(p.name) && (p.etype === 'output' || p.etype === 'power_out' || /O/.test(p.name)));
        const en = P.one(/^(ENN|EN|~?ENABLE|NSLEEP|SLEEP|STBY|STANDBY|~?SLEEP|NENBL|ENBL)$/), step = P.one(/^(STEP|STP)$/), dir = P.one(/^DIR$/);
        const ins = P.pins.filter(p => /^(IN\d|AIN\d|BIN\d|IN[AB]\d?|PWM[AB]|PH[AB]?|EN[AB])$/.test(p.name));
        for (const o of outs) roles[o.num] = R('motor', { step: step && step.num, dir: dir && dir.num, en: en && en.num, enLow: en ? /ENN|NEN|~/.test(en.name) || en.low : false, ins: ins.map(p => p.num), vdd: vm && vm.num, out: o.name });
        const five = P.one(/^(5VOUT|VREG|V5|VCC_?OUT|VINT|DVDD)$/);
        const chips = five && vm && five.etype === 'power_out' ? [{ ref: P.c.ref, model: 'regulator', in: vm.num, out: five.num, vout: /5V/.test(five.name) ? 5 : 3.3, dropout: 0.4, ilim: 0.05, note: 'internal regulator' }] : [];
        for (const p of P.pins) if (/^(DIAG|FAULT|NFAULT|FLT|INDEX|ERR)$/.test(p.name) && !roles[p.num]) roles[p.num] = R(/N|~/.test(p.name) || p.etype === 'open_collector' ? 'od' : 'lo', { vdd: vdd && vdd.num });
        return { roles, chips, note: step ? 'STEP/DIR: the coil outputs follow the step sequence' : 'outputs follow the inputs' };
      } },
    { id: 'gatedriver', name: 'Gate driver', match: /IRS2\d{3}|IR21\d\d|IR2\d{3}|UCC27\d{3}|UCC2\d{3}|LM5\d{3}|FAN73\d\d|NCP51\d{3}|MIC44\d\d|TC442\d|EG21\d\d|EG3\d{3}|DGD0\d{3}|2EDN|1EDN|GATE.?DRIVER/,
      build(P) {
        const roles = {};
        const hin = P.one(/^(HIN|IN_?H|INH|HI)$/), lin = P.one(/^(LIN|IN_?L|INL|LI|IN|INA|IN_?A|INB)$/), ho = P.one(/^(HO|OUTH|HOUT|HG)$/), lo = P.one(/^(LO|OUTL|LOUT|LG|OUT|OUTA|OUT_?A|OUTB)$/);
        const vb = P.one(/^(VB|HB|BST|BOOT)$/), vs = P.one(/^(VS|HS|SW|PH)$/), vcc = P.one(/^(VCC|VDD|VCCL)$/);
        if (ho && hin) roles[ho.num] = R('follow', { from: hin.num, invert: hin.low, vdd: vb && vb.num, lo: vs && vs.num });
        if (lo && lin) roles[lo.num] = R('follow', { from: lin.num, invert: lin.low || /LIN/.test(lin.name) && /\bIRS2186/.test(P.text) ? false : lin.low, vdd: vcc && vcc.num });
        return Object.keys(roles).length ? { roles, note: 'outputs follow the inputs' } : null;
      } },
    { id: 'classd', name: 'Audio amplifier', match: /TPA\d{4}|PAM8\d{3}|MAX9\d{4}|NS4\d{3}|LM4\d{3}|SSM2\d{3}|TAS\d{4}|HT\d{4}|CS4\d{3}|AMPLIFIER.*AUDIO|AUDIO.*AMPLIFIER|CLASS.?D/,
      build(P) {
        const roles = {}, vdd = P.one(/^(PVDD|VDD|VCC|PVCC|AVDD)$/);
        for (const p of P.pins) if (/^(OUT[+-]?|[LR]OUT[+-]?|OUT[LR][+-]?|VO[+-]|OUTP|OUTN|SPK[+-]?|[LR]\+|[LR]-|OUT[LR][PN])$/.test(p.name) && p.etype !== 'input') roles[p.num] = R('half', { vdd: vdd && vdd.num, note: 'bridge output: half the supply on average' });
        return Object.keys(roles).length ? { roles, note: 'outputs at their idle level' } : null;
      } },
    { id: 'ethphy', name: 'Ethernet PHY', match: /LAN87\d\d|LAN86\d\d|KSZ80\d\d|KSZ90\d\d|RTL82\d\d|DP838\d\d|IP101|YT85\d\d|AR8035|88E\d{4}|ETHERNET.?PHY/,
      build(P) {
        const roles = {}, vdd = supplyFor(P, /VDDIO|VIO/);
        for (const p of P.pins) {
          if (/^(XTAL2|XO|XTAL_?OUT)$/.test(p.name)) roles[p.num] = R('clk', { hz: 25e6 });
          else if (/^(REFCLKO|CLKOUT|REF_?CLK_?OUT|50MHZ_?OUT|TXCLK|RXCLK|TX_?CLK|RX_?CLK)/.test(p.name) && p.etype !== 'input') roles[p.num] = R('clk', { hz: /50/.test(p.name) ? 50e6 : 25e6, vdd: vdd && vdd.num });
          else if (/^(LED\d|LED\d\/.*|LINK|ACT|SPEED)/.test(p.name)) roles[p.num] = R('od');
          else if (/^(RXDV|CRS|COL|RXER|CRS_?DV)/.test(p.name) && /output|bidir/.test(p.etype)) roles[p.num] = R('lo', { vdd: vdd && vdd.num });
          else if (/^(TXP|TXN|TD[+-]|TX[+-]|TXD[+-]|TRD\d[PN]|TXOP|TXON|RXP|RXN|RD[+-]|RX[+-]|RXIP|RXIN)$/.test(p.name)) roles[p.num] = R('half', { vdd: (supplyFor(P, /VDDA|AVDD|VDD1A|VDD2A/) || {}).num });
        }
        return { roles, note: 'no link (cable out), clocks running' };
      } },
    { id: 'usbserial', name: 'USB to serial bridge', match: /CH34[0-3]|CP210\d|FT23\d|FT2232|FT4232|PL2303|CH9102|CH910\d|MCP2200|MCP2221|FT260/,
      build(P) {
        const roles = usbRoles(P, 'device');
        const vdd = supplyFor(P, /VIO|V3|VDD|VCC/);
        // VDD / V3 as an output: the chip's own 3.3 V regulator (CP2102 VDD from VREGIN, CH340 V3 from VCC)
        for (const p of P.pins) if (/^(VDD|V3|3V3|VDD33|VCCIO)$/.test(p.name) && p.etype === 'power_out' && !p.nc) roles[p.num] = R('reg', { v: 3.3 });
        for (const p of P.pins) {
          if (/^(TXD|TX|TXD0)$/.test(p.name)) roles[p.num] = R('hi', { vdd: vdd && vdd.num, note: 'UART idle high' });
          else if (/^(RTS|DTR|RTS#|DTR#)$/.test(p.name) && !roles[p.num]) roles[p.num] = R('hi', { vdd: vdd && vdd.num, note: 'no port open on the computer: inactive (high)' });
          else if (/^(XO|XOUT|XTALO)$/.test(p.name)) roles[p.num] = R('clk', { hz: 12e6 });
        }
        return { roles, note: 'enumerated on USB, serial idle' };
      } },
  ];
  // the other net of a two-pin part
  function otherNet(P, ref, net) { const pn = P.ix.pinNets.get(ref); if (!pn) return null; for (const m of pn.values()) if (m !== net) return m; return null; }
  // a resistor from a pin to ground: the program / set resistor of a charger or LED driver
  function progR(P, pin) {
    const net = P.ix.byName.get(pin.net);
    if (!net) return null;
    for (const x of net.nodes) {
      const r = P.ix.comp.get(x.ref);
      if (!r || r.type !== 'resistor') continue;
      const other = otherNet(P, r.ref, net);
      if (other && other.kind === 'ground') { const v = valueOf(r.value, 'ohm'); if (v > 0) return v; }
    }
    return null;
  }
  // the divider on a feedback / reference pin: {top, bot} in ohm
  function divider(P, refNet, topNet, botNet) {
    const n = P.ix.byName.get(refNet);
    if (!n) return null;
    let top = 0, bot = 0;
    for (const x of n.nodes) {
      const r = P.ix.comp.get(x.ref);
      if (!r || r.type !== 'resistor') continue;
      const v = valueOf(r.value, 'ohm');
      const other = otherNet(P, r.ref, n);
      if (!v || !other) continue;
      if (other.name === botNet || other.kind === 'ground') bot += 1 / v;
      else if (other.name === topNet || other.kind === 'power') top += 1 / v;
    }
    return top && bot ? { top: 1 / top, bot: 1 / bot } : null;
  }
  // USB data pins: a device pulls D+ up (1.5 kΩ, attached at full speed), a host or hub port pulls both down (15 kΩ)
  function usbRoles(P, role) {
    const roles = {};
    const v33 = supplyFor(P, /VDD33|V33|VCC33|VDD3V3|V3|VDD|VCC/);
    for (const p of P.pins) {
      const m = /^(USB_?)?(D|U)?(DP|DM|DN|D\+|D-|DPU|DMU|DP\d|DM\d|USBDP|USBDM|USB_?DP|USB_?DM|UDP|UDM|USB_?P|USB_?N|DPLUS|DMINUS|DP_?UP|DM_?UP|USBDP_?(UP|DN\d))$/.exec(p.name);
      if (!m) continue;
      const upstream = /U$|UP|^DPU|^DMU/.test(p.name) || role === 'device';
      const plus = /DP|D\+|P$|PLUS|UDP/.test(p.name.replace(/UP$/, '')) && !/DM|DN|D-|MINUS/.test(p.name);
      if (upstream && role !== 'host') { if (plus) roles[p.num] = R('pull', { mode: 'pu', r: 1500, vdd: v33 && v33.num, note: 'D+ pull-up: device attached (full speed)' }); else roles[p.num] = R('in'); }
      else roles[p.num] = R('pull', { mode: 'pd', r: 15e3, note: 'host port: 15 kΩ pull-down' });
    }
    return roles;
  }

  // ---------------------------------------------------------------- inference from pin names (any chip not in the families)
  function infer(P) {
    const roles = {};
    const vdd = supplyFor(P);
    const crystalNets = P.ix.crystal;
    for (const p of P.pins) {
      if (p.nc) continue;
      const nm = p.name, e = p.etype;
      if (p.kind === 'ground') continue;
      if (/^(XO|XOUT|XTAL_?OUT|XTALO|XTAL2|OSC_?OUT|OSCO|X2|XOUT32|XO32|XTAL_?N|XC2|OSC32_?OUT|XTAL_?P)$/.test(nm) && (crystalNets.has(p.net) || /XTAL|XO|OSC/.test(nm))) { roles[p.num] = R('clk', { hz: crystalHz(P, p.net), vdd: vdd && vdd.num }); continue; }
      // the oscillator's input: its internal feedback resistor biases it at half the supply
      if (/^(XI|XIN|XTAL_?IN|XTALI|XTAL1|OSC_?IN|OSCI|X1|XIN32|XI32|XC1|OSC32_?IN|XTAL_?I|CLKIN|XTAL)$/.test(nm) && crystalNets.has(p.net)) { roles[p.num] = R('pull', { mode: 'half', r: 1e6, vdd: vdd && vdd.num, note: 'oscillator input, biased at half the supply' }); continue; }
      if (/^(CLKOUT\d*|CLK_?OUT\d*|MCLK_?OUT|REFCLK_?OUT|SYSCLK)$/.test(nm) && /output|tri|bidir/.test(e)) { roles[p.num] = R('clk', { vdd: vdd && vdd.num }); continue; }
      // an internal regulator's output (REG18, VREG33, V1P8, LDO_1V2): the voltage from the rail or the pin name
      // (a converter's switch node, bootstrap or gate drive is a power_out pin too, but never a steady rail)
      if (/^(SW\d*|LX\d*|PH\d*|BST|BOOT|CBOOT|RBOOT|CB|BS|HO|LO|HG|LG|GH|GL|DH|DL|VSW|SWN|SWP)$/.test(nm)) continue;
      if (e === 'power_out' || (/^(REG|VREG|LDO|VCAP|REGOUT|VDD_?OUT|VOUT_?LDO)\w*$/.test(nm) && !/IN$|_I$|INPUT/.test(nm) && e !== 'power_in' && e !== 'input')) {
        const v = p.v != null && p.v > 0 ? p.v : voltInName(nm) || voltInName(up(p.net).split('/').pop());
        if (v) { roles[p.num] = R('reg', { v }); continue; }
      }
      if (e === 'power_in' || e === 'power_out') continue;
      if (/^(TXD\d?|TX\d?|UART_?TX\d?|U\dTXD|TXD_?\w*)$/.test(nm) && /output|bidir|tri/.test(e)) { roles[p.num] = R('hi', { vdd: vdd && vdd.num, note: 'UART idle high' }); continue; }
      if (/^(INT\d?|IRQ\d?|ALERT|NINT|INTB|INTN|DRDY|RDY|BUSY|FAULT|NFAULT|PG|PGOOD|POWER_?GOOD|SMBALERT|OVERTEMP|OTW)$/.test(nm) && /output|open|bidir|tri/.test(e)) { roles[p.num] = R(/^(DRDY|RDY|BUSY)$/.test(nm) && e === 'output' ? 'lo' : 'od', { vdd: vdd && vdd.num }); continue; }
      if (e === 'open_collector') { roles[p.num] = R('od'); continue; }
      if (e === 'output') { roles[p.num] = R('pd', { vdd: vdd && vdd.num, note: 'level unknown: weakly low' }); continue; }
    }
    if (!Object.keys(roles).length) return null;
    // what was found, in a few words: "clock output 25 MHz, 2 open-drain lines, UART TX idle high"
    const cnt = {};
    for (const o of Object.values(roles)) cnt[o.role] = (cnt[o.role] || 0) + 1;
    const W = { clk: n => n > 1 ? n + ' clock outputs' : 'a clock output', pull: n => n > 1 ? n + ' biased pins' : 'oscillator bias', od: n => n > 1 ? n + ' open-drain lines' : 'an open-drain line', hi: n => n > 1 ? n + ' outputs idle high' : 'an output idle high', pd: n => n > 1 ? n + ' outputs (level unknown, weakly low)' : 'an output (level unknown, weakly low)', lo: n => n > 1 ? n + ' outputs low' : 'an output low', reg: n => n > 1 ? n + ' regulated outputs' : 'a regulated output' };
    const parts = Object.entries(cnt).filter(([k]) => W[k]).map(([k, n]) => W[k](n));
    return { roles, note: parts.length ? parts.join(', ') : 'pins read from their names' };
  }
  // 1V8, 3V3, 1P8, REG18, VDD33 -> volts
  function voltInName(s) {
    s = String(s || '');
    let m = /(?:^|[^0-9])(\d)[VP](\d{1,2})(?:$|[^0-9])/.exec(s);
    if (m) return +(m[1] + '.' + m[2]);
    m = /(?:REG|LDO|VREG|VDD|VCC|VOUT|OUT|VCAP)_?(\d)(\d)$/.exec(s);
    if (m && +m[1] > 0 && +m[1] <= 5) return +(m[1] + '.' + m[2]);
    return null;
  }
  function crystalHz(P, net) {
    const n = P.ix.byName.get(net);
    if (!n) return null;
    for (const x of n.nodes) { const c = P.ix.comp.get(x.ref); if (c && (c.type === 'crystal' || c.kind === 'crystal')) return freqOf(c.value + ' ' + (c.description || '')); }
    return null;
  }

  // ---------------------------------------------------------------- models saved in the shared library
  const user = new Map();   // id -> { id, match (exact part value, upper), name, roles: {pin: role}, by, at }
  function userModel(P) {
    const v = up(P.c.value).trim();
    for (const m of user.values()) if (m.match && (m.match === v || (m.rx && new RegExp(m.rx, 'i').test(P.c.value || '')))) return m;
    return null;
  }

  // ---------------------------------------------------------------- one chip
  function model(c, circ) {
    const P = ctxOf(c, circ);
    const um = userModel(P);
    if (um) return finish(P, { roles: Object.assign({}, um.roles), chips: um.chips || [], note: um.note || '' }, { id: 'library', name: um.name || 'Library model' }, um.by ? 'library' : 'library');
    for (const f of families) {
      if (!f.match.test(P.text)) continue;
      let r = null;
      try { r = f.build(P); } catch (e) { r = null; }
      if (r && (Object.keys(r.roles || {}).length || (r.chips || []).length)) {
        // pins the family left alone still get the generic treatment (clock outputs, UART TX, interrupt lines)
        const g = infer(P);
        if (g) for (const [k, v] of Object.entries(g.roles)) if (!r.roles[k]) r.roles[k] = v;
        return finish(P, r, f, 'built-in');
      }
    }
    const g = infer(P);
    return g ? finish(P, g, { id: 'generic', name: 'Inferred from the pins' }, 'inferred') : null;
  }
  function finish(P, r, fam, source) {
    const roles = {};
    for (const p of P.pins) {
      const o = r.roles[p.num];
      if (o) roles[p.num] = o;
      else roles[p.num] = R(p.nc ? 'nc' : p.kind === 'ground' ? 'gnd' : p.etype === 'power_in' || (p.kind === 'power' && /^(V|AV|DV|PV)/.test(p.name)) ? 'vdd' : 'in');
    }
    // internal regulator outputs -> regulator models from the chip's highest supply
    const chips = (r.chips || []).slice();
    for (const [num, o] of Object.entries(roles)) {
      if (o.role !== 'reg') continue;
      // fed from the chip's highest known supply; else from any supply pin on a rail (its voltage shows in the simulation)
      const sup = P.pins.filter(p => p.kind === 'power' && p.v != null && p.v > o.v + 0.2 && roles[p.num] && roles[p.num].role === 'vdd').sort((a, b) => b.v - a.v)[0]
        || P.pins.find(p => !p.nc && p.kind === 'power' && p.v == null && roles[p.num] && roles[p.num].role === 'vdd' && p.net !== (P.pins.find(q => q.num === num) || {}).net)
        || P.pins.find(p => !p.nc && p.kind !== 'ground' && /^(BAT|VBAT|VIN|VCC|VDD|VBUS|VSYS|PVIN|VSUP|VS|VPWR|VBATT|VDDA)$/.test(p.name) && p.net !== (P.pins.find(q => q.num === num) || {}).net);
      // a main output (VOUT, SYS) carries the board; a VDD / VCAP / REG pin only the chip's own logic
      const pn = (P.pins.find(q => q.num === num) || {}).name || '';
      const main = /^(V?OUT\d*|VSYS|SYS|VBUS_?OUT|OUTPUT)$/.test(pn);
      // a switching power stage (a DC-DC module, a converter with its own switch pin) draws less from its input than it delivers
      const switching = main && (/DC.?DC|BUCK|STEP.?DOWN|CONVERTER|SWITCHING|\bPOL\b|POWER MODULE/i.test(P.text) || P.pins.some(q => /^(SW|LX|PH|VSW)\d*$/.test(q.name)));
      if (sup && !chips.some(ch => String(ch.out) === num)) chips.push({ ref: P.c.ref, model: 'regulator', in: sup.num, out: num, vout: o.v, dropout: main ? 0.1 : 0.2, ilim: main ? 2.5 : 0.3, switching: switching || undefined, note: main ? 'output ' + o.v + ' V (power stage modelled as a regulator' + (switching ? ', drawing power in, not current' : '') + ')' : 'internal regulator output' });
      else if (!sup) o.role = 'in';
    }
    return { ref: P.c.ref, part: P.c.value, family: fam.id, familyName: fam.name, source, note: r.note || '', roles, chips };
  }

  // ---------------------------------------------------------------- the whole board: sim pieces for every chip with a model
  // returns { chips, drivers: [{ref, pin, vdd, vnom, lo}], behaviours: [{ref, family, roles, supplies}], models: Map(ref -> model) }
  function plan(circ, opts) {
    opts = opts || {};
    const skip = opts.skip || new Set();
    const out = { chips: [], drivers: [], behaviours: [], models: new Map() };
    for (const c of circ.components) {
      if (c.type !== 'ic' || c.dnp || skip.has(c.ref)) continue;
      let m = null;
      try { m = model(c, circ); } catch (e) { m = null; }
      if (!m) continue;
      out.models.set(c.ref, m);
      for (const ch of m.chips) out.chips.push(ch);
      const sup = [];
      const P = ctxOf(c, circ);
      for (const p of P.pins) if (m.roles[p.num] && m.roles[p.num].role === 'vdd') sup.push(p.num);
      const vdef = supplyFor(P);
      const drives = [];
      for (const [num, o] of Object.entries(m.roles)) {
        if (!DRIVE_ROLES.has(o.role)) continue;
        const p = P.pins.find(q => q.num === num);
        if (!p || p.nc || p.kind === 'ground') continue;
        const vpin = o.vdd || (vdef && vdef.num) || null;
        const vp = vpin ? P.pins.find(q => q.num === vpin) : null;
        out.drivers.push({ ref: c.ref, pin: num, vdd: vpin, vnom: vp && vp.v || 3.3, lo: o.lo || null });
        drives.push(num);
      }
      if (drives.length) out.behaviours.push({ ref: c.ref, family: m.family, roles: m.roles, supplies: sup.length ? sup : vdef ? [vdef.num] : [], vnom: vdef && vdef.v || 3.3 });
    }
    return out;
  }
  const DRIVE_ROLES = new Set(['hi', 'lo', 'pd', 'pu', 'z', 'od', 'odlo', 'pull', 'clk', 'follow', 'gate', 'reset', 'stat', 'sink', 'half', 'level', 'motor']);

  // ---------------------------------------------------------------- runtime: drive the pins while the simulation runs
  function runtime(L, behaviours) {
    const e = () => L.engine;
    const items = [];
    const nodeOf = new Map();   // ref\0pin -> node index (resolved per engine)
    let gen = -1;
    const resolve = () => {
      const eng = e();
      nodeOf.clear();
      for (const n of L.base.circuit.nets) { const nd = eng.nodeOf(n.name); const i = nd ? eng.nodeIndex(nd) : -1; for (const x of n.nodes) nodeOf.set(x.ref + '\u0000' + x.pin, i); }
      gen = L.gen;
    };
    const V = (ref, pin) => { const i = nodeOf.get(ref + '\u0000' + pin); return i == null || i < 0 ? 0 : e().x[i]; };
    for (const b of behaviours || []) items.push({ b, st: {}, phase: 0, last: {} });
    let k = 0;
    const rt = {
      items,
      step(t, dt) {
        const eng = e();
        if (!eng || !items.length) return;
        if (gen !== L.gen) { resolve(); for (const it of items) it.last = {}; }
        // a few times per millisecond of simulated time is plenty for these parts; every step when the steps are long
        k++;
        if (dt < 2e-5 && (k & 7)) return;
        for (const it of items) run(it, eng, t);
      },
      forced: new Map(),   // ref\0pin -> mode set from the actions panel
    };
    function run(it, eng, t) {
      const b = it.b, ref = b.ref;
      let vs = 0;
      for (const s of b.supplies) vs = Math.max(vs, V(ref, s));
      const powered = vs > 0.6 * (b.vnom || 3.3) || (!b.supplies.length);
      const set = (pin, mode, r) => { const k = ref + '\u0000' + pin; const f = rt.forced.get(k) || (L.forced && L.forced.get(k)); if (f) { mode = f === 'release' ? mode : f; if (f !== 'release') r = undefined; } if (it.last[pin] === mode + ':' + (r || '')) return; it.last[pin] = mode + ':' + (r || ''); eng.setDrive(ref, pin, mode, r); };
      const lvl = (pin, ref2) => { const v = V(ref2 || ref, pin); const vr = Math.max(0.8, vs || 3.3); return v > vr * 0.5 ? 1 : 0; };
      for (const [pin, o] of Object.entries(b.roles)) {
        if (!DRIVE_ROLES.has(o.role)) continue;
        if (!powered) { set(pin, 'z'); continue; }
        switch (o.role) {
          case 'hi': case 'lo': case 'pd': case 'pu': case 'z': set(pin, o.role); break;
          case 'od': set(pin, 'z'); break;
          case 'odlo': set(pin, 'od'); break;
          case 'pull': set(pin, o.mode || 'pd', o.r); break;
          case 'clk': case 'half': {
            const en = o.en ? lvl(o.en) : 1, on = o.enLow ? !en : !!en || !o.en;
            set(pin, on ? 'half' : 'lo');
            break;
          }
          case 'follow': {
            if (o.oe) { const v = lvl(o.oe); if (o.oeLow ? v : !v) { set(pin, 'z'); break; } }
            if (o.dir != null) { const d = lvl(o.dir); if (d !== o.dirOut) { set(pin, 'z'); break; } }
            if (o.auto) {
              // auto-direction translators: a side that something else drives is the input
              const other = eng.driveOf(ref, o.from);
              if (o.back && other !== 'z' && other != null && it.st['own:' + o.from]) { set(pin, 'z'); break; }
              const mine = drivenElsewhere(eng, ref, pin);
              if (mine) { set(pin, 'z'); it.st['own:' + pin] = 0; break; }
              it.st['own:' + pin] = 1;
            }
            let v = lvl(o.from);
            if (o.invert) v = 1 - v;
            set(pin, o.od ? (v ? 'z' : 'od') : v ? 'hi' : 'lo');
            break;
          }
          case 'gate': {
            const v = gate(o.fn, o.from.map(p => lvl(p))) ? 1 : 0;
            set(pin, o.od ? (v ? 'z' : 'od') : v ? 'hi' : 'lo');
            break;
          }
          case 'reset': {
            const vd = V(ref, o.vdd);
            const ok = vd > (it.st[pin] ? o.vth * 0.97 : o.vth);
            it.st[pin] = ok ? 1 : 0;
            const active = !ok;   // reset asserted below the threshold
            const high = o.low ? !active : active;
            set(pin, o.od ? (high ? 'z' : 'od') : high ? 'hi' : 'lo');
            break;
          }
          case 'stat': {
            const vin = V(ref, o.vin), vb = V(ref, o.bat);
            const charging = vin > 4.3 && vb < 4.12;
            if (o.power) set(pin, vin > 4.3 ? 'od' : 'z');
            else if (o.done) set(pin, vin > 4.3 && !charging ? 'od' : 'z');
            else set(pin, charging ? 'od' : 'z');
            break;
          }
          case 'sink': {
            const en = o.en ? lvl(o.en) : 1, on = o.enLow ? !en : !!en;
            if (!on) { set(pin, 'z'); break; }
            const v = Math.max(0.05, V(ref, pin));
            const want = v / (o.mA / 1000 / (o.share || 1));
            const prev = it.st['r' + pin] || want;
            const r = Math.abs(want - prev) / prev > 0.1 ? want : prev;
            it.st['r' + pin] = r;
            set(pin, 'od', +r.toPrecision(3));
            break;
          }
          case 'motor': {
            const en = o.en ? lvl(o.en) : 1, on = o.enLow ? !en : !!en || !o.en;
            if (!on) { set(pin, 'z'); break; }
            if (o.step) {
              const s = lvl(o.step), key = 'step';
              if (s && !it.st[key]) it.phase = (it.phase + (o.dir && !lvl(o.dir) ? 3 : 1)) & 3;
              it.st[key] = s;
              const SEQ = { A1: [1, 0, 0, 1], A2: [0, 1, 1, 0], B1: [1, 1, 0, 0], B2: [0, 0, 1, 1] };
              const nm = o.out.replace(/^O/, '').replace(/^OUT/, '').replace(/^MOT/, '');
              const seq = SEQ[nm] || SEQ[nm.replace(/OUT/, '')] || [0, 0, 0, 0];
              set(pin, seq[it.phase] ? 'hi' : 'lo');
            } else if (o.ins && o.ins.length) {
              const idx = /2$|B$/.test(o.out) ? 1 : 0;
              set(pin, lvl(o.ins[Math.min(idx, o.ins.length - 1)]) ? 'hi' : 'lo');
            } else set(pin, 'lo');
            break;
          }
          case 'level': set(pin, 'half'); break;
        }
      }
      void t;
    }
    // is a pin's net driven by another part (a processor pin that drives, a stand-in, a regulator)?
    function drivenElsewhere(eng, ref, pin) {
      const i = nodeOf.get(ref + '\u0000' + pin);
      if (i == null || i < 0) return false;
      for (const { e: el } of eng.byNode.get(i) || []) {
        if (el.ref === ref) continue;
        if (el.t === 'DRV' && el.mode !== 'z' && el.mode !== 'pu' && el.mode !== 'pd') return true;
        if (el.t === 'V' || el.t === 'REG' || el.t === 'OPA') return true;
      }
      return false;
    }
    return rt;
  }

  // ---------------------------------------------------------------- library: save, list, describe
  function describe(m) {
    if (!m) return '';
    const rows = [];
    for (const [num, o] of Object.entries(m.roles)) {
      if (['in', 'nc', 'gnd', 'vdd'].includes(o.role)) continue;
      rows.push(num + ' ' + roleText(o));
    }
    return rows.join(' · ');
  }
  function roleText(o) {
    let s = ROLE_TXT[o.role] || o.role;
    if (o.role === 'follow') s = (o.invert ? 'inverts pin ' : 'follows pin ') + o.from + (o.dir ? ' (DIR)' : '') + (o.oe ? ' when enabled' : '');
    if (o.role === 'gate') s = o.fn.toUpperCase() + ' of pins ' + o.from.join(', ');
    if (o.role === 'clk' && o.hz) s += ' ' + fmtHz(o.hz);
    if (o.role === 'pull') s = (o.mode === 'pu' ? 'pull-up ' : o.mode === 'half' ? 'bias to half supply ' : 'pull-down ') + (o.r >= 1000 ? +(o.r / 1000).toPrecision(3) + ' kΩ' : o.r + ' Ω');
    if (o.role === 'reset') s = 'reset output (' + (o.low ? 'low' : 'high') + ' below ' + o.vth + ' V)';
    if (o.role === 'sink') s = 'sinks ' + o.mA + ' mA';
    if (o.role === 'reg') s = 'regulated ' + o.v + ' V';
    if (o.note) s += ' — ' + o.note;
    return s;
  }

  // ---------------------------------------------------------------- digital (pre-biased) transistors: base resistors inside
  // MUN2235: R1 2.2k in series with the base, R2 47k from base to emitter; DTC114E: 10k / 10k; PDTC143Z: 4.7k / 47k
  const DIGITAL_RX = /\b(?:L|S|NSV)?MUN\d{4}|\bP?DT[CAB]\d{3}[A-Z]|\bDDT[CA]\d{3}|\bPDT[CA]\d{3}|\bBCR\d{3}|\bRN[12]\d{3}|\bNSB[CA]\d|\b(?:EM|UM|IM)[HDXZ]\d|\bPUM[HDXZ]\d|\bPEM[HDXZ]\d|\bKR[CA]\d{3}|\bRT1[NP]\d|PRE.?BIASED|DIGITAL TRANSISTOR|BIAS RESISTOR|BUILT.?IN RESISTOR|RESISTOR.?EQUIPPED/;
  const MUN = { 11: [10e3, 10e3], 12: [22e3, 22e3], 13: [47e3, 47e3], 14: [10e3, 47e3], 15: [10e3, 0], 16: [4.7e3, 0], 30: [1e3, 1e3], 31: [2.2e3, 2.2e3], 32: [4.7e3, 4.7e3], 33: [4.7e3, 47e3], 34: [22e3, 47e3], 35: [2.2e3, 47e3], 36: [100e3, 100e3], 37: [47e3, 22e3] };
  function digital(text) {
    const t = String(text || '').toUpperCase();
    if (!DIGITAL_RX.test(t)) return null;
    let m = /MUN\d{2}(\d{2})/.exec(t);
    if (m && MUN[m[1]]) return { r1: MUN[m[1]][0], r2: MUN[m[1]][1] || 1e9 };
    // Rohm / Nexperia / Diodes codes: DTC114E = 10k/10k, DTC143Z = 4.7k/47k, DTC114Y = 10k/47k, DTC143T = 4.7k alone
    m = /DT[CAB](\d)([124])([3-6])([A-Z])/.exec(t);
    if (m) {
      const r1 = { 1: 1, 2: 2.2, 4: 4.7 }[m[2]] * Math.pow(10, +m[3]);
      const k = { E: 1, Y: 4.7, Z: 10, X: 2.2, W: 0.47, V: 0.1, T: 0, U: 0, G: 1, M: 1 }[m[4]];
      return { r1, r2: k ? r1 * k : k === 0 ? 1e9 : r1 };
    }
    return { r1: 10e3, r2: 47e3 };
  }
  N.partModels = { composite, model, plan, runtime, families, infer, user, describe, roleText, ROLE_TXT, ctxOf, fmtHz, DRIVE_ROLES, digital };
})();

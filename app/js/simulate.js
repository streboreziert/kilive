/* KiLive — the circuit model of a board for the live simulation: supplies, chip stand-ins, sections (Debug AI engine) */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const I = N.icons;
  const SIM = () => window.DS2K_SIM;
  const DBG = () => window.DS2K_DBG;

  const S = (N.simtab = {});
  // supply voltage from a net name: +3V3, 3.3V, +3.3V_PCIE, VCC_1V8, 5V_USB, VBUS ...
  function voltOf(name) {
    const s = String(name || '').toUpperCase().split('/').pop();
    // negative rails: -5V, -12V, NEG_5V, VEE_15V, -3V3
    const neg = /^(-|NEG_?|VEE_?|V-_?|M(?=\d))/.test(s);
    if (neg) {
      const r = s.replace(/^(-|NEG_?|VEE_?|V-_?|M(?=\d))/, '');
      const m = /^(\d{1,2})V(\d{1,3})(?![0-9])/.exec(r) || /^(\d{1,2}(?:\.\d{1,3})?)V?(?![0-9A-Z])/.exec(r);
      if (m) return -parseFloat(m[2] != null && /V\d/.test(m[0]) ? m[1] + '.' + m[2] : m[1]);
    }
    // USB data and control lines are not 5 V rails
    const dataLine = /USB/.test(s) && (/(^|[^A-Z])(D[+-PN]|D_[PN]|DP|DM|DATA|CC\d?|SBU\d?|ID|OTG)([^A-Z]|$)|[+-]$/.test(s) || /USBD[MPN+-]$/.test(s));
    if (dataLine) return null;
    const v = explicitVolt(s);
    return v != null ? v : SIM().guessVolt(name);
  }
  function explicitVolt(s) {
    let m = /(?:^|[^A-Z0-9.])\+?(\d{1,2})V(\d{1,3})(?![0-9])/.exec(s) || /^\+?(\d{1,2})V(\d{1,3})(?![0-9])/.exec(s);
    if (m) return parseFloat(m[1] + '.' + m[2]);
    m = /(?:^|[^A-Z0-9.])\+?(\d{1,2}(?:\.\d{1,3})?)V(?![0-9A-Z])/.exec(s) || /^\+?(\d{1,2}(?:\.\d{1,3})?)V(?![0-9A-Z])/.exec(s) || /^\+?(\d{1,2}(?:\.\d{1,3})?)V_/.exec(s);
    if (m) return parseFloat(m[1]);
    // standby / analog / switched variants: +3.3VSB, 5VA, 3V3SB, +12V_IN
    m = /^\+?(\d{1,2})V(\d{1,3})[A-Z_]/.exec(s) || /^\+?(\d{1,2}(?:\.\d{1,3})?)V[A-Z_]/.exec(s);
    if (m) return parseFloat(m[2] != null ? m[1] + '.' + m[2] : m[1]);
    // a rail prefix glued to the voltage: PWR5V0, VCC3V3, VDD1V8, P3V3, PWR12V
    // (not its enable / power-good / sense lines: PWR1V1EN, VCC3V3_PG)
    const notRail = /^_?(?:EN|ENABLE|PG|PGOOD|OK|SNS|SENSE|FB|ON|OFF|CTRL|CTL|DET)(?:$|[^A-Z])/;
    m = /^(?:PWR|VCC|VDD|VDDIO|VCCIO|VIN|VOUT|VBUS|P)_?(\d{1,2})V(\d{1,3})(?![0-9])/.exec(s);
    if (m && !notRail.test(s.slice(m[0].length))) return parseFloat(m[1] + '.' + m[2]);
    m = /^(?:PWR|VCC|VDD|VIN|VOUT|P)_?(\d{1,2}(?:\.\d{1,3})?)V(?![0-9A-Z])/.exec(s);
    return m ? parseFloat(m[1]) : null;
  }
  S.voltOf = voltOf;
  // the voltage a rail's name states outright (+3V3, 5V_USB, VCC_1V8), or null for VCC / VDD / VDDA
  S.nominalOf = name => { const s = String(name || '').toUpperCase().split('/').pop(); const neg = /^(-|NEG_?|VEE_?|V-_?|M(?=\d))/.test(s); if (neg) return voltOf(name); return explicitVolt(s); };
  const fmt = v => String(parseFloat(Number(v).toPrecision(3)));
  function fmtSI(v, unit) { const a = Math.abs(v); const [k, p] = a >= 1 ? [1, ''] : a >= 1e-3 ? [1e3, 'm'] : a >= 1e-6 ? [1e6, 'µ'] : a === 0 ? [1, ''] : [1e9, 'n']; return fmt(v * k) + ' ' + p + unit; }
  const clone = o => JSON.parse(JSON.stringify(o));
  const upper = s => String(s == null ? '' : s).toUpperCase();

  // ------------------------------------------------------------------ board → DS2K-style circuit
  const PNP_RX = /PNP|2N3906|BC85[6-9]|BC80[78]|MMBT3906|MMBT2907|2N2907|PBSS5|2SA|MMBTA92|BCX5[1-3]|DSS5|S8550|SS8550|2N4403|KTA\d|DTA\d|MUN21\d\d|MUN51\d\d|PDTA\d|DDTA\d|RN2\d{3}|KRA\d/;
  const PMOS_RX = /PMOS|P-CH|PCH|Q_PMOS|AO340[1-9]|AO3415|SI2301|SI2305|SI2333|DMG2305|DMP\d|BSS84|IRLML6402|IRLML2244|NTR1P|FDN3[0-9]{2}P|FDS\d{4}P|SSM3J|PMV\d+XP|RQ5|DMG3415|WPM\d|AO3423|SI2343|IRF9|FQP\d+P|NDS0610|TP0610|P-MOSFET|P CHANNEL|P-CHANNEL/;
  S.PNP_RX = PNP_RX; S.PMOS_RX = PMOS_RX;
  // generated symbols name every pin FUNCTION_number (EN_1, GND_2, SW_3): drop the suffix when every named pin has it
  function suffixed(pads) {
    const named = pads.filter(q => q.name);
    return named.length >= 2 && named.every(q => upper(q.name).endsWith('_' + upper(q.num)) && upper(q.name).length > String(q.num).length + 1);
  }
  const pinNm = q => upper(q.name).replace(/^~\{?|\}$/g, '');
  function partType(f, sp, names) {
    const ref = upper(f.r), v = upper(f.v), lib = upper(sp && sp.lib), fp = upper(f.fp), desc = upper((sp && sp.desc) || f.d);
    const n = names.length;
    const pre = (/^[A-Z]+/.exec(ref) || [''])[0];
    const all = v + ' ' + lib + ' ' + desc;
    if (!n) return null;
    const t = partTypeByRef(ref, pre, v, lib, fp, all, names, n);
    if (t !== 'ic') return t;
    return partTypeByWhat(ref, pre, v, fp, all, names, n);
  }
  // what the part says it is, for unusual reference prefixes (DR1 diodes, PWRLED1, FET1, TR4, rC7, BUT1, K25 keys, EXT1 headers …)
  function partTypeByWhat(ref, pre, v, fp, all, names, n) {
    const nm = new Set(names.map(pinNm));
    const txt = all + ' ' + fp;
    if (n === 2) {
      if (/\bLEDS?\b|LED_|_LED|LED\/|LIGHT.?EMITTING/.test(all) || /^LED[_-]/.test(fp)) return 'led';
      if (/DIODE|D_SMALL|SCHOTTKY|ZENER|RECTIFIER|\b1N4\d{3}|\b1N5\d{3}|\bBAT\d\d|\bSS\d\d\b|MBR\d|\bD_SOD|SOD-?123|SOD-?323|SOD-?523/.test(txt) || (nm.has('A') && nm.has('K'))) {
        if (TVS_PN.test(v.trim())) return 'tvs_diode';
        if (/ZENER|BZX|BZT|MM3Z|MMSZ/.test(all)) return 'zener_diode';
        if (/TVS|ESD|SMAJ|SMBJ|PESD/.test(all)) return 'tvs_diode';
        if (/SCHOTTKY|\bBAT\d|\bSS\d|MBR|1N58|RB\d{3}|PMEG|STPS|BAS40|NSR/.test(all)) return 'schottky_diode';
        return 'diode';
      }
      if (nm.has('A') && nm.has('C') && /LED|DIODE|^D/.test(txt + ' ' + ref)) return /LED/.test(txt + ' ' + ref) ? 'led' : 'diode';
      if (/SOLDER.?JUMPER|SOLDERJUMPER|\bJUMPER|SJ_\d|NET.?TIE/.test(txt)) return 'jumper';
      if (/CAPACITOR|\bCAP\b|C_SMALL|C_POLARI[SZ]ED|CPOL|ELECTROLYTIC|TANTALUM/.test(all) || /^C_\d{4}|^CP_|^C_ELEC|^CP_ELEC/.test(fp)) return /POLARI|ELECTROLYTIC|TANTALUM|CPOL|^CP_/.test(all + ' ' + fp) ? 'capacitor_polarized' : 'capacitor';
      if (/FERRITE|\bBEAD\b/.test(all)) return 'ferrite_bead';
      if (/RESISTOR|R_SMALL|\bRES\b|THERMISTOR/.test(all) || /^R_\d{4}/.test(fp)) return /NTC|PTC|THERMISTOR/.test(all) ? 'thermistor' : 'resistor';
      if (/INDUCTOR|L_SMALL|\bCHOKE/.test(all) || /^L_\d{4}/.test(fp)) return 'inductor';
      if (/\bFUSE|POLYFUSE|RESETTABLE/.test(all)) return 'fuse';
      if (/PUSH.?BUTTON|TACTILE|KEY.?SWITCH|KEYSW|SW_PUSH|SW_SPST|BUTTON|\bSWITCH\b|TS-\d{4}|PTS\d|SKQG|EVQ|KAILH|CHERRY|CPG\d|T1107|YTS-/.test(txt) || /^(SW|BUT|BTN|KEY|K|S|PB|RST|RESET|BOOT)[A-Z]*\d/.test(ref) && !/LED|DIODE|CAP|RES/.test(all)) return 'switch';
      if (/CRYSTAL|XTAL|RESONATOR/.test(all)) return 'crystal';
    }
    // transistors by their pin names, whatever the prefix (FET1, TR4, Q_ with S_1 G_4 D_5 names)
    if (n >= 3 && n <= 8) {
      if (nm.has('G') && nm.has('D') && nm.has('S') && [...nm].every(x => /^(G|D|S|TAB|EP|PAD)$/.test(x))) return PMOS_RX.test(all) ? 'mosfet_p' : 'mosfet_n';
      if (nm.has('B') && nm.has('C') && nm.has('E') && [...nm].every(x => /^(B|C|E|TAB|EP)$/.test(x))) return PNP_RX.test(all) ? 'bjt_pnp' : 'bjt_npn';
    }
    // connectors and headers with their own prefixes (EXT1, UEXT1, PWR1 jacks, CONN1)
    if (/\bCONNECTOR\b|\bCONN_|^CONN|PIN.?HEADER|\bHEADER\b|RECEPTACLE|\bJACK\b|BARREL|TERMINAL.?BLOCK|SCREW.?TERMINAL|USB.?C\b|USB_C_|MICRO.?USB|\bHN\d|PWRJ|\bJST\b|PINHEADER|PINSOCKET|PIN_?SOCKET|IDC|BOX.?HEADER|FPC|FFC|SMA\b|U\.FL|IPEX/.test(txt) && !/MCU|MICROCONTROLLER|REGULATOR|CONVERTER|TRANSCEIVER|DRIVER|CONTROLLER/.test(all)) return 'connector';
    if (/^(EXT|UEXT|PWR|PWRJ|CONN|HDR|HEADER|JST|TERM|PH|CN|CON|SV|X)\d/.test(ref) && n >= 2 && !/CRYSTAL|XTAL|MHZ|KHZ|OSC/.test(all) && names.every(q => q.etype === 'passive' || q.etype === '' || q.etype === 'unspecified')) return 'connector';
    return 'ic';
  }
  const ZENER_V = /^\d{1,2}(\.\d{1,2})?\s?V(\s|$|[,;_ ])|^\d{1,2}V\d{1,2}(\s|$|[,;_ ])/;
  // TVS part numbers win over a library description that calls the part a zener (SMC5K51A drawn as "Zener Diode")
  const TVS_PN = /^(SM[ABCD]J|SMLJ|SM[ABC]\d+K|SM[56]T|SM8S|P[46]KE|1\.5KE|5KP|15KP|SMF\d|PESD|TPD\d|SP\d{4}|SD0[35]|PRTR|ESD\d|TVS)/;
  function partTypeByRef(ref, pre, v, lib, fp, all, names, n) {
    if (pre === 'R' && n === 2) return /NTC|PTC|THERMISTOR/.test(all) ? 'thermistor' : 'resistor';
    if (/^(RV|VR|POT)$/.test(pre) && n === 3) return 'potentiometer';
    if (/^(TH|NTC|RT)$/.test(pre) && n === 2) return 'thermistor';
    if (/^C$/.test(pre) && n === 2) return /CP_|POLARI|ELEC|TANT|C_POL|:CP\b|CPOL/.test(lib + ' ' + fp) ? 'capacitor_polarized' : 'capacitor';
    if ((/^(FB|FL|BEAD)$/.test(pre) || (pre === 'L' && /FERRITE|BEAD|BLM|MPZ|\bFB\b/.test(all))) && n === 2) return 'ferrite_bead';
    if (pre === 'L' && n === 2) return 'inductor';
    if (/^(F|PF|PTC)$/.test(pre) && n === 2) return 'fuse';
    if (/^(D|LED|CR|DS)$/.test(pre) && n === 2) {
      if (TVS_PN.test(v.trim())) return 'tvs_diode';
      // a voltage for a value is a zener, whatever symbol or footprint it was drawn with (6.8V, 6V8, 5.1V, 3V3)
      if (ZENER_V.test(v.trim()) && !/LED/.test(v) && (/LED/.test(all + ' ' + fp + ' ' + ref) || /^\d{1,2}[.V]\d/.test(v.trim())) && !/SCHOTTKY|TVS|ESD/.test(all)) return 'zener_diode';
      if (/LED/.test(all + ' ' + fp + ' ' + ref)) return 'led';
      if (/ZENER|BZX|BZT|MM3Z|MMSZ|\bZD|D_ZENER|PDZ|UDZ/.test(all)) return 'zener_diode';
      if (/TVS|ESD|SMAJ|SMBJ|SMF\d|PESD|D_TVS|TPD\d|PRTR|SD05|CDSOD/.test(all)) return 'tvs_diode';
      if (/SCHOTTKY|BAT\d|\bSS\d|\bSK\d|MBR|\bB\d{3}|1N58|RB\d{3}|PMEG|STPS|CUS\d|D_SCHOTTKY|BAS40|NSR/.test(all)) return 'schottky_diode';
      return 'diode';
    }
    if ((pre === 'Q' || pre === 'T' || pre === 'M') && n >= 3) {
      const s = new Set(names.map(x => upper(x.name)));
      if (s.has('B') && s.has('C') && s.has('E')) return PNP_RX.test(all) ? 'bjt_pnp' : 'bjt_npn';
      if (s.has('G') && s.has('D') && s.has('S')) return PMOS_RX.test(all) ? 'mosfet_p' : 'mosfet_n';
      return 'other';
    }
    if (/^(Y|X|XTAL|XT)$/.test(pre) && n === 2) return 'crystal';
    if (/^(SW|S|BTN|KEY)$/.test(pre) && n === 2) return 'switch';
    if (/^(JP|SJ|J?P)$/.test(pre) && n === 2 && /JUMPER|SOLDER|JP/.test(all + ' ' + fp + ' ' + ref)) return 'jumper';
    if (pre === 'TP') return n === 1 ? 'test_point' : 'connector';
    if (/^(J|P|CN|CON|USB|H)$/.test(pre)) return 'connector';
    return 'ic';
  }
  const DIODE_T = new Set(['diode', 'schottky_diode', 'zener_diode', 'tvs_diode', 'led']);
  function pinIdFor(type, pad, byName) {
    const nm = upper(pad.name);
    if (DIODE_T.has(type)) { if (nm === 'A' || nm === 'K') return nm; if (nm === 'C' || nm === 'CATHODE' || nm === '-') return 'K'; if (nm === 'ANODE' || nm === '+') return 'A'; return pad.num === '1' ? 'K' : pad.num === '2' ? 'A' : null; }
    if (type === 'capacitor_polarized') return pad.num === '1' ? '+' : pad.num === '2' ? '-' : null;
    if (type === 'bjt_npn' || type === 'bjt_pnp') return ['B', 'C', 'E'].includes(nm) ? nm : null;
    if (type === 'mosfet_n' || type === 'mosfet_p') return ['G', 'D', 'S'].includes(nm) ? nm : null;
    if (type === 'potentiometer') return pad.num === '2' ? 'W' : pad.num === '1' ? '1' : pad.num === '3' ? '3' : null;
    if (['resistor', 'capacitor', 'inductor', 'ferrite_bead', 'fuse', 'thermistor', 'crystal', 'switch', 'jumper'].includes(type)) return byName[pad.num];
    return pad.num;
  }

  S.boardCircuit = function (B) {
    if (B._simFull) return B._simFull;
    const shortCount = new Map();
    for (let i = 1; i < B.nets.length; i++) { const s = N.fmt.shortNet(B.nets[i]); shortCount.set(s, (shortCount.get(s) || 0) + 1); }
    const netName = i => { const s = N.fmt.shortNet(B.nets[i]); return shortCount.get(s) > 1 ? B.nets[i] : s; };
    const components = [], nodesByNet = new Map(), refsSeen = new Set();
    const padsOf = new Map();   // ref -> Map(circuit pin id -> [pad numbers])
    for (const f of B.fps) {
      if (!f.r || f.bo || f.dnp || refsSeen.has(f.r) || (f.z && f.z[0] === 'none') || /^#|^REF\*/.test(f.r)) continue;
      refsSeen.add(f.r);
      const sp = B.schParts.get(f.r);
      const pads = [];
      const seen = new Set();
      for (const pi of f.pads) {
        const p = B.pads[pi];
        if (p[2] === 2 || !String(p[1])) continue;
        const num = String(p[1]);
        const raw = (p[14] && p[14] !== '~') ? String(p[14]) : '';
        const name = raw.replace(/^~\{?|\}$/g, '');
        // an overbar (~{RESET}, ~SHDN) marks an active-low pin
        pads.push({ num, name, etype: p[15] || '', net: p[10] || 0, low: /^~\{?./.test(raw) || undefined });
        if (!seen.has(num)) seen.add(num);
      }
      let uniq = [...seen].map(num => pads.find(q => q.num === num));
      // EN_1, GND_2, SW_3 …: the function is the name
      if (suffixed(uniq)) for (const q of pads) if (q.name && upper(q.name).endsWith('_' + upper(q.num))) q.name = q.name.slice(0, -(q.num.length + 1));
      // mechanical pads with neither a name nor a net do not count (a key switch's third leg, a shield tab)
      const eff = uniq.filter(q => q.net || q.name);
      if (eff.length && eff.length < uniq.length) uniq = eff;
      const type = partType(f, sp, uniq);
      if (!type) continue;
      const byName = {};
      if (uniq.length === 2) { const s = uniq.map(q => q.num).sort((a, b) => (+a || 0) - (+b || 0) || (a < b ? -1 : 1)); byName[s[0]] = '1'; byName[s[1]] = '2'; }
      let t = type;
      const map = new Map();
      for (const q of uniq) { const id = pinIdFor(t, q, byName); if (id == null) { t = 'other'; break; } map.set(q.num, id); }
      if (t === 'other' && type !== 'other') { map.clear(); for (const q of uniq) map.set(q.num, q.num); }
      let value = f.v || '';
      if (/^(DNP|DNF|NC|N\/C|NP|NOPOP|NO_?POP|NOSTUFF)$/i.test(value.trim())) continue;
      const P2 = window.DS2K_P2;
      // values written as library names: R_2k_0402, C_47u_0805, C_10u_1206_50V, L_2u2_8A_Coilcraft
      { const unit = t === 'resistor' ? 'ohm' : t === 'inductor' ? 'H' : /^capacitor/.test(t) ? 'F' : null; const m = /^(?:R|C|CP|L)_(\d[\d.]*[pnuµmkKMRrΩ]?\d*)(?:_|$)/.exec(value.trim()); if (unit && m && P2.parseValue(value, unit) == null) value = m[1]; }
      if (t === 'inductor' && /\d\s*(R|OHM|Ω)\s*@|@\s*\d+\s*MHZ/i.test(value)) t = 'ferrite_bead';
      // an "inductor" whose value is in ohms (100 ohm, 4 A / 600R / 120Ω) is a ferrite bead, never 100 henries
      if (t === 'inductor' && /^\s*\d+(\.\d+)?\s*(OHMS?|Ω|R)(?![A-Z0-9])/i.test(value) && !/\d\s*[pnuµm]?H\b/i.test(value)) t = 'ferrite_bead';
      if (t === 'inductor' && P2.parseValue(value, 'H') == null) { const m = /(\d+)R(\d+)/i.exec(value) || /(?:^|\D)R(\d+)/i.exec(value); if (m) value = (m.length > 2 ? m[1] + '.' + m[2] : '0.' + m[1]) + 'uH'; }
      if (t === 'resistor' && /^0R?$|^0\.0+$|^0 ?ohm/i.test(value.trim())) value = '0.01';
      // KiCad shorthand with the multiplier first: u1 = 0.1 µF, n47 = 0.47 nF, k1 = 0.1 kΩ
      { const m = /^([pnuµmkKM])(\d+)(\s|$)/.exec(value.trim()); if (m && P2.parseValue(value, t === 'resistor' ? 'ohm' : t === 'inductor' ? 'H' : 'F') == null) value = '0.' + m[2] + m[1] + value.trim().slice(m[0].trimEnd().length); }
      const c = { ref: f.r, type: t, value, description: ((sp && sp.desc) || f.d || '').slice(0, 120), package: f.fp || '', dnp: false };
      if (['ic', 'other', 'connector'].includes(t)) { c.pins = uniq.map(q => q.low ? { number: q.num, name: q.name, etype: q.etype || 'passive', side: '', low: true } : { number: q.num, name: q.name, etype: q.etype || 'passive', side: '' }); if (sp && sp.lib) c.lib = String(sp.lib).slice(0, 80); }
      // solder jumpers: open or bridged as the value / symbol says
      if (t === 'jumper') c.closed = !/OPEN/i.test(value + ' ' + ((sp && sp.lib) || '')) || /BRIDGED|CLOSED/i.test(value + ' ' + ((sp && sp.lib) || ''));
      components.push(c);
      const pm = new Map();
      for (const [num, id] of map) { if (!pm.has(id)) pm.set(id, []); pm.get(id).push(num); }
      padsOf.set(f.r, pm);
      for (const q of pads) {
        if (!q.net) continue;
        const pin = map.get(q.num);
        if (pin == null) continue;
        let a = nodesByNet.get(q.net);
        if (!a) nodesByNet.set(q.net, (a = []));
        if (!a.some(x => x.ref === f.r && x.pin === pin)) a.push({ ref: f.r, pin });
      }
    }
    const nets = [];
    for (const [ni, nodes] of nodesByNet) {
      const nm = netName(ni);
      const kind = B.isGnd(ni) ? 'ground' : B.isPower(ni) ? 'power' : 'signal';
      nets.push({ name: /^(Net-|unconnected-)/.test(nm) ? '' : nm, kind, port: 'none', nodes, _i: ni });
    }
    let k = 1;
    const used = new Set(nets.map(n => n.name));
    for (const n of nets) if (!n.name) { while (used.has('N' + k)) k++; n.name = 'N' + k; used.add(n.name); n.auto = true; }
    // a USB socket's VBUS or a header's supply pin makes a rail even where the netlist's power flag is missing (CONTROL_VBUS)
    {
      const byRef = new Map(components.map(c => [c.ref, c]));
      const DATAISH = /(^|[^A-Z])(D[+-PN]|D_[PN]|DP|DM|DATA|CC\d?|SBU\d?|ID|OTG|GATE|SENSE|SNS|DET|EN|CAP|FB|ADC|MON|STAT|CTRL|SW)([^A-Z0-9]|$)|[+-]$/;
      const SUPPLY_PIN = /^(VBUS\d*|VUSB|VIN|VCC|VDD|VEE|V\+|V-|[+-]?\d{1,2}V\d?|[+-]?\d{1,2}\.\d{1,2}V|PWR|POWER)$/;
      for (const n of nets) {
        if (n.kind !== 'signal') continue;
        const nm = n.auto ? '' : upper(n.name).split('/').pop();
        if (nm && DATAISH.test(nm)) continue;
        const pinSays = n.nodes.some(x => { const c = byRef.get(x.ref); if (!c || c.type !== 'connector') return false; const p = (c.pins || []).find(q => String(q.number) === String(x.pin)); return p && SUPPLY_PIN.test(upper(p.name).trim()); });
        if (/VBUS|VUSB/.test(nm) || pinSays) n.kind = 'power';
      }
    }
    // multi-pin passives (switches, arrays, dual diodes and transistors, ESD arrays, relays …) become several simple elements
    if (N.partModels) {
      const circ0 = { components, nets };
      for (const c of components) {
        if (c.type !== 'ic' && c.type !== 'other') continue;
        let cm = null;
        try { cm = N.partModels.composite(c, N.partModels.ctxOf(c, circ0)); } catch (e) { console.warn('composite', c.ref, e); cm = null; }
        if (!cm) continue;
        c.type = 'composite'; c.kind = cm.kind; c.label = cm.label; c.sub = cm.sub;
        if (cm.hz) c.hz = cm.hz;
      }
    }
    B._simFull = { components, nets, padsOf };
    return B._simFull;
  };

  // parts worth simulating on their own
  const RX = {
    reg: /LDO|REGULATOR|1117|AP21\d\d|AP7\d|MIC5\d|MIC29|LP59|LP29|TLV7\d|TLV1117|XC62|RT9\d|MCP17\d\d|LM317|LM1117|LM78|78M\d|HT7\d|SPX\d|NCP11|NCP7|LD1117|LD39|TPS7\d|LT17\d|ADP1\d\d|AMS1117|ME6\d|SGM20|LDL\d|LD3985|TCR2|BL9\d{3}|NCP16\d|AP2125|XC6220|RT90\d\d|TLV755|LP38\d\d|LM3940|AZ1117|\bL78|\bL79|LM2937|LM340|MC78|UA78|KA78|LT30\d\d|LT1963|LT1763|LT3042|LT3045|NCV8\d{3}|TPS7A|ADP7\d{3}|ADP3\d{3}|MAX1658|MAX8\d{3}A?|IFX\d{4}|LM2940/,
    boost: /BOOST|STEP[- ]UP|TPS61\d|TPS6102|MT3608|SX1308|TLV61\d|MCP16\d\d|AP3012|LM2577|XL6009|FP6291|RT9266|ME2108|BL8530|SY7\d{3}|MP3\d{3}[^0-9]|LTC3\d{3}.*BOOST|MAX1\d{3}.*BOOST|TPS6123\d|TPS6124\d|TPS610\d\d|AAT1217|CE8301|HX3001/,
    buck: /BUCK|STEP[- ]DOWN|DC[- ]?DC|TPS5\d|TPS6\d|MP1\d|MP2\d|RT8\d|SY8\d|AP3\d|LM259|LMR\d|TLV62|AOZ|ACT4|MP15|LM26|TPS54|TPS62|AP6\d{4}|XL\d{4}|MT2\d{3}|MP8\d{3}|MP9\d{3}|TPS56\d|TPS55\d|LM43\d{3}|LM46\d{3}|LT8\d{3}|LTC3\d{3}|MAX77\d{3}|ISL8\d{3}|NCP15\d\d|FAN53\d{3}|TPS82\d{3}|TPSM\d|MPM\d{4}|LMZM\d|LTM\d{4}|SY\d{4}|RT6\d{3}|RT7\d{3}|JW5\d{3}|ETA\d{4}|MP2\d{3}/,
    opamp: /OP[- ]?AMP|OPERATIONAL|COMPARATOR|LM358|LM324|LM393|LM339|MCP60\d|MCP6\d{3}|OPA\d|TLV9\d|TL07|TL08|TL0\d\d|AD86|LMV\d|NE5532|TSV\d|LM2904|LM2902|LM321|LMC6\d{3}|SGM8\d{3}|NCS\d{4}|TS9\d{2}|LMP7\d{3}|ADA4\d{3}|AD8\d{3}|OPA\d{3,4}|TLV\d{3,4}A?I|MCP65\d\d|TLC27\d|LM6\d{3}|OP\d{2,3}\b/,
    // (a part number with 555 or 556 inside a longer number is no timer: LT5560 is a mixer)
    t555: /(?:^|[^0-9A-Z])(?:NE|SE|NA|SA|LM|TLC|LMC|ICM7|ICL7|TS|XR-?|MC1|CA|UA|KA|HA17)?55[56](?:[^0-9]|$)/,
    lsw: /LOAD[- ]?SWITCH|POWER[- ]?SWITCH|POWER DISTRIBUTION|SY628\d|TPS20[4-6]\d|TPS25\d\d|TPS229\d\d|TPS228\d\d|AP21[5-9]\d|AP22\d{3}|AP22802|MIC20\d\d|MIC94\d|RT97\d\d|FPF\d|SIP32\d|NCP38\d|STMPS2|SLG59|AOZ13\d\d/,
  };
  function icKind(c) {
    const t = upper(c.value + ' ' + c.description);
    // instrumentation and differential amplifiers, ADCs and DACs are no plain op-amps
    for (const k of ['t555', 'lsw', 'reg', 'boost', 'buck', 'opamp']) if (RX[k].test(t)) { if (k === 'opamp' && /INSTRUMENTATION|FULLY.?DIFFERENTIAL|\bADC\b|\bDAC\b|INA\d{3}|THS45/.test(t)) return ''; return k; }
    return '';
  }
  S.suggestions = function (B) {
    const full = S.boardCircuit(B);
    const out = [];
    const label = { reg: 'regulator', buck: 'buck converter', opamp: 'op-amp', t555: '555 timer', lsw: 'load switch' };
    for (const c of full.components) {
      if (c.type !== 'ic') continue;
      const k = icKind(c);
      if (k && k !== 'lsw') out.push({ refs: [c.ref], nets: [], label: c.ref + ' · ' + c.value, sub: label[k], score: { reg: 3, buck: 4, t555: 5, opamp: 2 }[k] });
    }
    for (const c of full.components) {
      if (c.type !== 'led') continue;
      const nets = full.nets.filter(n => n.nodes.some(x => x.ref === c.ref));
      const r = nets.flatMap(n => n.nodes.filter(x => x.ref !== c.ref && /^R\d/.test(x.ref)).map(x => x.ref))[0];
      if (r) out.push({ refs: [c.ref, r], nets: [], label: c.ref + ' + ' + r, sub: 'LED indicator', score: 1 });
    }
    out.sort((a, b) => b.score - a.score || N.refCmp(a.refs[0], b.refs[0]));
    const seen = new Set();
    return out.filter(s => { const k = s.sub + ':' + s.label.split(' ')[0]; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
  };

  // the part of the board around the chosen parts / nets
  S.section = function (B, seedRefs, seedNetIdx, opt) {
    opt = opt || {};
    const full = S.boardCircuit(B);
    const comps = new Map(full.components.map(c => [c.ref, c]));
    const netsOf = new Map(), partsOn = new Map();
    for (const n of full.nets) for (const x of n.nodes) { (netsOf.get(x.ref) || netsOf.set(x.ref, new Set()).get(x.ref)).add(n.name); (partsOn.get(n.name) || partsOn.set(n.name, new Set()).get(n.name)).add(x.ref); }
    const byName = new Map(full.nets.map(n => [n.name, n]));
    const include = new Set(seedRefs.filter(r => comps.has(r)));
    const seedNets = new Set((seedNetIdx || []).map(i => { const n = full.nets.find(x => x._i === i); return n && n.name; }).filter(Boolean));
    const discrete = c => c && !['ic', 'other', 'connector', 'test_point'].includes(c.type);
    let frontier = new Set(seedNets);
    for (const r of include) for (const n of netsOf.get(r) || []) frontier.add(n);
    const visited = new Set();
    const maxParts = opt.maxParts || 40, depth = opt.depth || 2;
    for (let d = 0; d <= depth && frontier.size; d++) {
      const next = new Set();
      for (const net of frontier) {
        visited.add(net);
        const n = byName.get(net);
        if (!n || n.kind === 'ground') continue;
        const cand = [...(partsOn.get(net) || [])].filter(r => !include.has(r) && discrete(comps.get(r))).sort(N.refCmp);
        const cap = n.kind === 'power' ? 8 : 12;
        for (const r of cand.slice(0, cap)) {
          if (include.size >= maxParts) break;
          include.add(r);
          for (const n2 of netsOf.get(r) || []) if (!visited.has(n2)) next.add(n2);
        }
      }
      frontier = next;
      if (include.size >= maxParts) break;
    }
    const components = [...include].map(r => clone(comps.get(r))).sort((a, b) => N.refCmp(a.ref, b.ref));
    const nets = [];
    for (const n of full.nets) {
      const nodes = n.nodes.filter(x => include.has(x.ref));
      if (!nodes.length) continue;
      const cut = n.nodes.length > nodes.length;
      nets.push({ name: n.name, kind: n.kind, port: n.kind !== 'ground' && cut ? (n.kind === 'power' ? 'input' : 'bidirectional') : 'none', nodes: clone(nodes), cut, _i: n._i });
    }
    const circuit = { design: { title: '' }, components, nets, no_connects: [] };
    const outside = new Set();
    const outsideIC = new Set();
    for (const n of nets) if (n.cut) for (const x of byName.get(n.name).nodes) if (!include.has(x.ref)) { outside.add(x.ref); const k = comps.get(x.ref); if (k && ['ic', 'other'].includes(k.type)) outsideIC.add(n.name); }
    return { circuit, refs: [...include], outside: [...outside].sort(N.refCmp), sim: sectionSim(circuit, seedRefs, seedNets, outsideIC) };
  };

  // chip models guessed from pin names and part numbers; supply sources on rails entering the section
  function pinBy(c, rx, not) { return (c.pins || []).find(p => rx.test(upper(p.name)) && !(not && not.test(upper(p.name)))); }
  function netOfPin(circ, ref, pin) { return circ.nets.find(n => n.nodes.some(x => x.ref === ref && String(x.pin) === String(pin))); }
  function voutFrom(value) {
    const v = upper(value);
    // SPX3819M5-L-3-3, XC6206-1-8: the voltage split by a dash
    let m = /[-_](\d)[-_](\d)(?![\d.])/.exec(v);
    if (m && +m[1] <= 5) return parseFloat(m[1] + '.' + m[2]);
    m = /[-_ ](\d)[.V](\d{1,2})\b/.exec(v) || /(\d)V(\d)/.exec(v);
    if (m) return parseFloat(m[1] + '.' + m[2]);
    m = /[-_](\d{2})(?:[A-Z]|$)/.exec(v);
    if (m) return +m[1] / 10;
    // ST's LDL212PU50R, LDK130PU33R, LD39050PU18R: the voltage in tenths after the package letters
    m = /\b(?:LDL|LDK|LD39|LD59|LDLN|LDBL|LD56)\d{2,4}[A-Z]{1,3}(\d{2})R?\b/.exec(v);
    if (m && +m[1] >= 8 && +m[1] <= 55) return +m[1] / 10;
    // -3.3, -1.8, -5 or -3.3V; not reel codes like -7 or -13
    m = /[-_](\d\.\d{1,2})V?\b/.exec(v) || /[-_]([1235])V?\b(?![.\d])/.exec(v);
    return m && +m[1] <= 5.5 ? parseFloat(m[1]) : null;
  }
  // the reference voltage a feedback divider implies for the rail it is named after
  // feedback references of common converters (datasheet values), for a divider whose output rail has no voltage in its name
  const VREF_TABLE = [[/TPS54[1-5]0\b|TPS5430|TPS5450|TPS5410|TPS5420/, 1.221], [/LM257[4-6]|LM259[4-7]/, 1.23], [/LM267[3-9]/, 1.21], [/XL40\d\d|XL6009|XL6019/, 1.25],
    [/MP2307/, 0.925], [/TPS54[23]0[28]/, 0.596], [/TPS56[23]20[01]/, 0.768], [/LMR3[36]6\d\d|LMR336\d0/, 1.0], [/LMR1[46]006/, 0.765],
    [/MT3608|SY80(89|8\d)|SY811[3-9]|SY812\d|RT8059|TLV6256[89]|TPS62A0[12]|AP3429/, 0.6], [/TPS6102[2-4]/, 0.595], [/LM3670/, 0.5]];
  const VREF_OF = v => { const t = upper(v); for (const [rx, x] of VREF_TABLE) if (rx.test(t)) return x; return null; };
  function feedbackRef(circ, ref, fbPin) {
    const P2 = window.DS2K_P2;
    const fbNet = netOfPin(circ, ref, fbPin);
    if (!fbNet) return null;
    let top = null, bot = null;
    for (const x of fbNet.nodes) {
      const r = circ.components.find(q => q.ref === x.ref && q.type === 'resistor');
      if (!r) continue;
      const other = circ.nets.find(n => n !== fbNet && n.nodes.some(y => y.ref === r.ref));
      const v = P2.parseValue(r.value, 'ohm');
      if (!other || !(v > 0)) continue;
      // resistors in parallel add conductance
      if (other.kind === 'ground') bot = bot ? { r: bot.r, refs: bot.refs + '+' + r.ref, g: bot.g + 1 / v } : { r, refs: r.ref, g: 1 / v };
      else if (!top || top.net === other) top = top ? { r: top.r, refs: top.refs + '+' + r.ref, g: top.g + 1 / v, net: other } : { r, refs: r.ref, g: 1 / v, net: other };
    }
    if (!top || !bot) return null;
    top.v = 1 / top.g; bot.v = 1 / bot.g;
    // follow the top resistor to a rail name that carries a voltage (possibly through an inductor from the switch node)
    let vnom = voltOf(top.net.name), netName = top.net.name;
    if (vnom == null) return null;
    let vref = vnom * bot.v / (top.v + bot.v);
    // the nearest usual reference (resistor values are rounded; the chip's reference is what the datasheet says)
    let best = null;
    for (const s of [0.5, 0.591, 0.6, 0.65, 0.7, 0.75, 0.76, 0.765, 0.8, 0.9, 1.0, 1.2, 1.221, 1.23, 1.25]) { const d = Math.abs(vref - s) / s; if (d < 0.04 && (!best || d < best.d)) best = { s, d }; }
    if (best) vref = best.s;
    return { vref: +vref.toFixed(3), top: top.refs, bot: bot.refs, net: netName };
  }
  // enable pins: returns {en, enLow}. EN, CE, ON, ~{SHDN} run the part when high; ~{EN}, EN#, SHDN, SD when low.
  // (the overbar is kept as pin.low: board pin names lose their ~{ } wrapping)
  function enableOf(c, circ) {
    let best = null;
    for (const p of c.pins || []) {
      const raw = upper(p.name).trim();
      const barred = !!p.low || /^~|^\/|#$|_N$|^N(?=(EN|SHDN|SD|SLEEP|OFF|CE)$)/.test(raw) || raw === 'ENB';
      const nm = raw.replace(/^~\{?|\}$/g, '').replace(/^~|^\//, '').replace(/#$|_N$/, '').replace(/^N(?=(EN|SHDN|SD|SLEEP|OFF|CE)$)/, '').replace(/^ENB$/, 'EN');
      let on = null;   // true: the part runs while the pin is high
      if (/^(EN|ENABLE|CE|ON|EN\/UVLO|EN_UVLO|UVLO\/EN|EN\d|PWR_?EN|RUN|ENA|EN_?IN|SHDN\/EN|ON\/OFF|ON\/~?\{?OFF\}?)$/.test(nm)) on = !barred;
      // a converter's SHDN pin is nearly always "pull low to shut down" even where the symbol lost its bar (LMR16006, LT parts)
      else if (/^(SHDN|SHUTDOWN)$/.test(nm) && !barred) on = true;
      else if (/^(SHDN|SD|OFF|SHUTDOWN|STBY|STANDBY|SLEEP)$/.test(nm)) on = barred;
      if (on == null) continue;
      best = { en: p.number, enLow: !on };
      if (/^EN|^CE|^ON|RUN/.test(nm)) break;   // a real enable beats a sleep pin
    }
    if (best && best.enLow && circ) {
      // an "active low" enable tied straight to a supply rail means the designer wants the part on: the name is really ~SHDN
      const n = netOfPin(circ, c.ref, best.en);
      if (n && n.kind === 'power' && (voltOf(n.name) || 0) > 1.2) best.enLow = false;
    }
    if (best && !best.enLow && circ) {
      // a shutdown pin tied to ground: the part is meant to run
      const n = netOfPin(circ, c.ref, best.en), pn = (c.pins || []).find(p => String(p.number) === String(best.en));
      if (n && n.kind === 'ground' && pn && /SHDN|SHUTDOWN|SD\b/i.test(String(pn.name))) return {};
    }
    // an enable nothing on the board drives (a header pin, a soft-start capacitor, a pull-up left unfitted): whatever plugs
    // into the header switches the part on, so it runs
    if (best && circ && !enableDriven(circ, c.ref, best.en)) return { enFree: best.en };
    return best || {};
  }
  // does something on the board drive this enable? A chip pin or a transistor does. A header or module connector means whatever
  // plugs in drives it (assumed to switch the part on), even with a pull resistor; with only a pull resistor, the pull decides
  function enableDriven(circ, ref, pin) {
    const start = netOfPin(circ, ref, pin);
    if (!start) return false;
    if (start.kind === 'ground' || start.kind === 'power') return true;
    const seen = new Set([start.name]), q = [[start, 0]];
    let external = false, pulled = false;
    while (q.length) {
      const [n, depth] = q.shift();
      for (const x of n.nodes) {
        if (x.ref === ref) continue;
        const p = circ.components.find(k => k.ref === x.ref);
        if (!p || p.dnp) continue;
        const xp = String(x.pin);
        if (p.type === 'capacitor' || p.type === 'capacitor_polarized' || p.type === 'test_point' || DIODE_T.has(p.type)) continue;
        if (p.type === 'connector') { external = true; continue; }
        if (p.type === 'switch') continue;   // a button, open until pressed
        if (p.type === 'composite' && (p.sub || []).some(sb => sb.t === 'SW')) continue;
        if ((p.type === 'mosfet_n' || p.type === 'mosfet_p') && xp === 'G') continue;
        if ((p.type === 'bjt_npn' || p.type === 'bjt_pnp') && xp === 'B') continue;
        if (p.type === 'resistor' || p.type === 'jumper' || p.type === 'ferrite_bead') {
          const far = circ.nets.find(m => m !== n && m.nodes.some(y => y.ref === p.ref));
          if (!far) continue;
          if (far.kind === 'power' || far.kind === 'ground') { pulled = true; continue; }
          if (depth < 2 && !seen.has(far.name)) { seen.add(far.name); q.push([far, depth + 1]); }
          continue;
        }
        // another part's enable on the same line is not a driver either
        if (p.type === 'ic') {
          const pp = (p.pins || []).find(k => String(k.number) === xp);
          if (pp && /^(~?\{?)?(EN|ENABLE|CE|ON|RUN|SHDN|EN\d|PWR_?EN)\}?$/i.test(String(pp.name || '').trim())) continue;
        }
        return true;   // a chip or a transistor decides
      }
    }
    return external ? false : pulled;
  }
  // the inductor on a switch-node net and the net on its other side
  function inductorFrom(circ, swNet) {
    for (const x of swNet.nodes) {
      const l = circ.components.find(q => q.ref === x.ref && q.type === 'inductor');
      if (!l) continue;
      const other = circ.nets.find(n => n !== swNet && n.nodes.some(y => y.ref === l.ref));
      if (other) return { l, other };
    }
    return null;
  }
  // the diode whose anode sits on a net, and the net at its cathode (a boost converter's output)
  function diodeFrom(circ, net) {
    for (const x of net.nodes) {
      if (x.pin !== 'A') continue;
      const d = circ.components.find(q => q.ref === x.ref && DIODE_T.has(q.type) && q.type !== 'led');
      if (!d) continue;
      const k = circ.nets.find(n => n !== net && n.nodes.some(y => y.ref === d.ref && y.pin === 'K'));
      if (k) return { d, net: k };
    }
    return null;
  }
  // the divider on a feedback pin: {top, bot} in ohm and the net above it
  function fbDivider(circ, ref, fbPin) {
    const P2 = window.DS2K_P2;
    const fbNet = netOfPin(circ, ref, fbPin);
    if (!fbNet) return null;
    let gt = 0, gb = 0, topNet = null;
    for (const x of fbNet.nodes) {
      const r = circ.components.find(q => q.ref === x.ref && q.type === 'resistor');
      if (!r) continue;
      const other = circ.nets.find(n => n !== fbNet && n.nodes.some(y => y.ref === r.ref));
      const v = P2.parseValue(r.value, 'ohm');
      if (!other || !(v > 0)) continue;
      if (other.kind === 'ground') gb += 1 / v; else if (!topNet || topNet === other) { gt += 1 / v; topNet = other; }
    }
    return gt && gb ? { top: 1 / gt, bot: 1 / gb, net: topNet } : null;
  }
  S.guessChip = function (circ, c) {
    let k = icKind(c);
    const swp = pinBy(c, /^(SW|LX|PH|SW\d|LX\d|SWITCH|VSW|PHASE)$/), fbp = pinBy(c, /^(FB|VFB|VSENSE|FB\d|ADJ\/FB)$/);
    // a "regulator" (or an unknown part, or one whose number reads like an op-amp: LM62440) with a switch node and feedback is a
    // switching converter
    if ((k === 'reg' || !k || k === 'opamp') && swp && fbp) k = 'buck';
    // buck or boost: an inductor from the input rail to the switch node makes it a boost
    if ((k === 'buck' || k === 'boost') && swp) {
      const swNet = netOfPin(circ, c.ref, swp.number);
      const vinP = pinBy(c, /^(VIN|IN|PVIN|VCC|VDD|VBAT|AVIN|SUP|VSUP)$/);
      const vinNet = vinP && netOfPin(circ, c.ref, vinP.number);
      const ind = swNet && inductorFrom(circ, swNet);
      if (ind && vinNet) k = ind.other === vinNet ? 'boost' : 'buck';
    }
    const gnd = pinBy(c, /^(GND|VSS|PGND|AGND|EP|PAD|THERMAL|TAB|GND\/ADJ|ADJ\/GND)/);
    // an inverting converter (its ground pin sits on the negative output): none of these models fit
    if ((k === 'buck' || k === 'boost') && gnd) { const gn = netOfPin(circ, c.ref, gnd.number); if (gn && gn.kind !== 'ground' && (voltOf(gn.name) || 0) < 0) return null; }
    if (k === 'reg' && (c.pins || []).every(p => !p.name)) {
      // a regulator drawn without pin names: its output is the pin on the rail named for its voltage (AP2127K-1.2 on +1V2), its
      // input the pin on a higher rail, and ground the pin on ground
      const vo = voutFrom(c.value);
      const at = p => netOfPin(circ, c.ref, p.number);
      const g0 = (c.pins || []).find(p => { const n = at(p); return n && n.kind === 'ground'; });
      const outP = vo ? (c.pins || []).find(p => { const n = at(p); const v = n ? S.nominalOf(n.name) : null; return v != null && Math.abs(v - vo) <= 0.1 * vo; }) : null;
      const inP = outP && (c.pins || []).find(p => { const n = at(p); if (!n || p === outP || n.kind === 'ground' || n === at(outP)) return false; const v = voltOf(n.name); return n.kind === 'power' && (v == null || v > vo); });
      if (outP && inP) return { ref: c.ref, model: 'regulator', in: inP.number, out: outP.number, gnd: g0 ? g0.number : undefined, vout: vo, dropout: 0.3, ilim: 0.5, note: c.value + ' as a ' + vo + ' V regulator (pins found from the rails they sit on)' };
    }
    if (k === 'reg') {
      const pin = pinBy(c, /^(VIN|IN|VI|INPUT|PVIN|VDD)$/) || (c.pins || []).find(p => p.etype === 'power_in' && p !== gnd);
      const pout = pinBy(c, /^(VOUT|OUT|VO|OUTPUT)$/) || (c.pins || []).find(p => p.etype === 'power_out');
      if (pin && pout) {
        const on = netOfPin(circ, c.ref, pout.number);
        // the output rail's name, when it states a voltage, beats a guess from the part number
        const named = on ? S.nominalOf(on.name) : null;
        const v = (named != null && named > 0 ? named : null) || voutFrom(c.value) || (on && voltOf(on.name)) || 3.3;
        return Object.assign({ ref: c.ref, model: 'regulator', in: pin.number, out: pout.number, gnd: gnd ? gnd.number : undefined, vout: v, dropout: 0.3, ilim: 1.5, note: 'guessed from ' + c.value }, enableOf(c, circ));
      }
    }
    if (k === 'boost') {
      const pin = pinBy(c, /^(VIN|IN|VCC|VDD|VBAT|VBATT|AVIN)$/) || (c.pins || []).find(p => p.etype === 'power_in' && p !== gnd);
      const pout = pinBy(c, /^(VOUT|OUT|VO|OUTPUT|VSYS)$/);
      const swNet = swp && netOfPin(circ, c.ref, swp.number);
      // the output: the chip's VOUT pin (synchronous parts), else the cathode of the diode from the switch node
      let outNet = pout ? netOfPin(circ, c.ref, pout.number) : null, outAt = null;
      if (!outNet && swNet) { const d = diodeFrom(circ, swNet); if (d) { outNet = d.net; outAt = [d.d.ref, 'K']; } }
      if (pin && outNet && outNet.kind !== 'ground') {
        let named = S.nominalOf(outNet.name);
        // the rail after the output filter (VREG6V_SWD → L5 → +6V) says it as well
        if (named == null) for (const x of outNet.nodes) { const k = circ.components.find(q => q.ref === x.ref); if (!k || !['inductor', 'ferrite_bead', 'fuse'].includes(k.type)) continue; const m = circ.nets.find(q => q !== outNet && q.nodes.some(y => y.ref === k.ref)); const v = m ? S.nominalOf(m.name) : null; if (v != null && v > 0) { named = v; break; } }
        const dv = fbp ? fbDivider(circ, c.ref, fbp.number) : null;
        const U = upper(c.value);
        let vref = /TPS61\d|TLV61/.test(U) ? 0.595 : /MCP16\d\d/.test(U) ? 1.21 : /LM2577|XL6009/.test(U) ? 1.23 : /MIC22\d\d|MIC2[89]\d\d/.test(U) ? 1.245 : /LT1\d{3}|LT3\d{3}|LTC3\d{3}/.test(U) ? 1.23 : 0.6;
        // a boost below its own input is a wrong guess: the reference that gives the named rail, else one that boosts at all
        const vinNet = netOfPin(circ, c.ref, pin.number), vin = vinNet ? voltOf(vinNet.name) || 3.7 : 3.7;
        if (dv && named == null && vref * (1 + dv.top / dv.bot) <= vin + 0.3) { const alt = [0.8, 1.0, 1.2, 1.23, 1.245, 1.25].find(r => r * (1 + dv.top / dv.bot) > vin + 0.3); if (alt) vref = alt; }
        if (dv && named != null) { const best = [0.5, 0.595, 0.6, 0.8, 1.0, 1.2, 1.21, 1.23, 1.245, 1.25].map(r => [r, Math.abs(r * (1 + dv.top / dv.bot) - named)]).sort((a, b) => a[1] - b[1])[0]; if (best && best[1] <= 0.1 * named) vref = best[0]; }
        const vout = named != null && named > 0 ? named : dv ? +(vref * (1 + dv.top / dv.bot)).toFixed(2) : 5;
        return Object.assign({ ref: c.ref, model: 'regulator', boost: true, in: pin.number, out: pout ? pout.number : undefined, outNet: pout ? undefined : outNet.name, outAt: outAt || undefined, gnd: gnd ? gnd.number : undefined, vout, dropout: 0, ilim: 2,
          note: `boost converter to ${vout} V${named == null && dv ? ' (from the ' + Math.round(dv.top) + ' / ' + Math.round(dv.bot) + ' Ω feedback divider)' : ''}; averaged, so the inductor and diode carry no ripple` }, enableOf(c, circ));
      }
    }
    if (k === 'buck') {
      const isIn = p => p && p.etype !== 'output' && p.etype !== 'power_out';
      const pin = [pinBy(c, /^(VIN|PVIN|IN|AVIN|VIN\d|PVIN\d|SUP|VSUP)$/), pinBy(c, /^(VCC|VDD)$/)].find(isIn);
      let sw = swp, fb = fbp;
      // a dual converter (LM3370: two SW and two FB pins of the same names): pair a switch pin with the feedback pin that senses its
      // own output (straight, or through its divider), so the model does not regulate one channel from the other one's rail
      const sws = (c.pins || []).filter(q => /^(SW|LX|PH|SW\d|LX\d|SWITCH|VSW|PHASE)$/.test(upper(q.name)));
      const fbs = (c.pins || []).filter(q => /^(FB|VFB|VSENSE|FB\d|ADJ\/FB)$/.test(upper(q.name)));
      if (sws.length > 1 || fbs.length > 1) {
        let pair = null;
        for (const sp of sws) {
          const sn = netOfPin(circ, c.ref, sp.number), ind = sn && inductorFrom(circ, sn);
          if (!ind) continue;
          for (const fp of fbs) {
            const fn = netOfPin(circ, c.ref, fp.number);
            const dv = fbDivider(circ, c.ref, fp.number);
            if ((fn && fn === ind.other) || (dv && dv.net === ind.other)) { pair = [sp, fp]; break; }
          }
          if (pair) break;
        }
        if (pair) [sw, fb] = pair;
      }
      // the averaged model needs the inductor from the switch node to the output (a flyback's transformer is no buck)
      const swN = sw && netOfPin(circ, c.ref, sw.number);
      if (pin && sw && fb && swN && inductorFrom(circ, swN)) {
        const ss = pinBy(c, /^(SS|SS\/TR|TR\/SS)$/);
        const ssNet = ss && netOfPin(circ, c.ref, ss.number);
        const ssCap = ssNet && ssNet.nodes.some(x => { const k = circ.components.find(q => q.ref === x.ref); return k && /^capacitor/.test(k.type); });
        let ref = feedbackRef(circ, c.ref, fb.number);
        if (ref && ref.vref <= 0) return null;   // a negative output: an inverting converter
        if (!ref) {
          // a fixed-output part: FB tied straight (or through a 0 Ω link) to the output rail senses the output itself
          const swNet = netOfPin(circ, c.ref, sw.number), ind = swNet && inductorFrom(circ, swNet);
          const fbNet = netOfPin(circ, c.ref, fb.number);
          const linked = new Set(fbNet ? [fbNet.name] : []);
          for (const x of fbNet ? fbNet.nodes : []) {
            const k = circ.components.find(q => q.ref === x.ref);
            const ohm = k && k.type === 'resistor' ? window.DS2K_P2.parseValue(k.value, 'ohm') : k && (k.type === 'ferrite_bead' || k.type === 'jumper') ? 0 : null;
            if (ohm == null || ohm > 1) continue;
            for (const m of circ.nets) if (m !== fbNet && m.nodes.some(y => y.ref === k.ref)) linked.add(m.name);
          }
          if (ind && linked.has(ind.other.name)) {
            const vo = S.nominalOf(ind.other.name) || voutFrom(c.value) || voltOf(ind.other.name) || 3.3;
            if (vo > 0) ref = { vref: vo, fixed: true, net: ind.other.name };
          }
        }
        const en = enableOf(c, circ);
        const known = ref ? null : VREF_OF(c.value);
        return Object.assign({ ref: c.ref, model: 'switcher', in: pin.number, sw: sw.number, fb: fb.number, gnd: gnd ? gnd.number : undefined, ss: ssCap ? ss.number : undefined, vref: ref ? ref.vref : known || 0.8, freq: 500000,
          note: (ref && ref.fixed ? `fixed ${ref.vref} V output (its FB pin senses the ${ref.net} rail directly)` : ref ? `feedback reference ${ref.vref} V worked out from ${ref.top}/${ref.bot} and the ${ref.net} net name` : known ? `feedback reference ${known} V (its datasheet value)` : 'feedback reference assumed 0.8 V - check the datasheet') + (en.en ? '; enable on pin ' + en.en + ' (on when left floating)' : '') }, en);
      }
    }
    if (k === 'lsw' || (!k && (c.pins || []).length <= 8 && !/MHZ|KHZ|OSC|\bXO\b|TCXO|CRYSTAL/.test(upper(c.value + ' ' + c.description)))) {
      // load / power switches: IN, OUT and an enable
      const pin = pinBy(c, /^(VIN|IN|VIN\d|IN\d|VBUS_?IN)$/), pout = pinBy(c, /^(VOUT|OUT|VOUT\d|OUT\d)$/), en = enableOf(c, circ);
      if (pin && pout && en.en && (k === 'lsw' || !pinBy(c, /^(FB|SW|LX|ADJ|BST|BOOT)$/))) {
        // an unknown part whose output rail is named lower than its input is a regulator (MCP1824-1202 on a 1V2 rail), not a switch
        const on = netOfPin(circ, c.ref, pout.number), inn = netOfPin(circ, c.ref, pin.number);
        const vo = on ? S.nominalOf(on.name) : null, vi = inn ? voltOf(inn.name) : null;
        if (!k && vo != null && vo > 0 && (vi == null || vo < vi - 0.25)) return Object.assign({ ref: c.ref, model: 'regulator', in: pin.number, out: pout.number, gnd: gnd ? gnd.number : undefined, vout: vo, dropout: 0.3, ilim: 1.5, note: c.value + ' as a ' + vo + ' V regulator (from its output rail name)' }, en);
        return Object.assign({ ref: c.ref, model: 'switch', in: pin.number, out: pout.number, gnd: gnd ? gnd.number : undefined, ron: 0.08, ilim: 2, note: c.value + ' as a load switch (on when its enable is at the active level)' }, en);
      }
    }
    if (k === 't555') {
      const P = rx => pinBy(c, rx);
      const m = { vcc: P(/^(VCC|V\+|VDD)$/), trig: P(/^(TRIG|TR|TRIGGER|~TRIG)$/), thr: P(/^(THR|THRES|THRESHOLD|TH)$/), dis: P(/^(DIS|DISCH|DISCHARGE)$/), out: P(/^(OUT|Q|OUTPUT)$/), cont: P(/^(CV|CONT|CTRL|CONTROL)$/), reset: P(/^(R|RESET|~RESET|RST)$/) };
      const num = (x, d) => (x ? x.number : d);
      return { ref: c.ref, model: '555', vcc: num(m.vcc, '8'), gnd: gnd ? gnd.number : '1', trig: num(m.trig, '2'), thr: num(m.thr, '6'), dis: num(m.dis, '7'), out: num(m.out, '3'), cont: num(m.cont, '5'), reset: num(m.reset, '4') };
    }
    if (k === 'opamp') {
      const pins = c.pins || [];
      const units = [];
      for (const suf of ['', 'A', 'B', 'C', 'D', '1', '2', '3', '4']) {
        const f = rx => pins.find(p => rx.test(upper(p.name)));
        const e = s => s.replace(/[+]/g, '\\+');
        const inp = f(new RegExp('^(' + e('+IN' + suf) + '|' + e('IN' + suf + '+') + '|' + e('+IN_' + suf) + '|' + e('IN+' + suf) + '|' + e(suf + '+IN') + ')$'));
        const inn = f(new RegExp('^(-IN' + suf + '|IN' + suf + '-|-IN_' + suf + '|IN-' + suf + '|' + suf + '-IN)$'));
        const out = f(new RegExp('^(OUT' + suf + '|' + (suf ? suf + 'OUT|OUT_' + suf : 'OUT') + '|VOUT' + suf + ')$'));
        if (inp && inn && out) units.push({ inp: inp.number, inn: inn.number, out: out.number });
        if (!suf && units.length) break;
      }
      // generic symbols name the inputs + and - and leave the output unnamed: pair each output with the nearest free inputs
      if (!units.length) {
        const outs = pins.filter(p => /^(|~|OUT|VOUT|O|Y)$/.test(upper(p.name)) && /output|open_c|open_e|tri|bidir/.test(p.etype)).sort((a, b) => (+a.number || 0) - (+b.number || 0));
        const plus = pins.filter(p => /^(\+|IN\+|\+IN|INP|IN_P|NONINV|V_?IN\+)$/.test(upper(p.name))), minus = pins.filter(p => /^(-|IN-|-IN|INN|IN_N|INV|V_?IN-)$/.test(upper(p.name)));
        const usedP = new Set(), usedM = new Set();
        const near = (list, used, o) => list.filter(q => !used.has(q)).sort((a, b) => Math.abs((+a.number || 0) - (+o.number || 0)) - Math.abs((+b.number || 0) - (+o.number || 0)))[0];
        for (const o of outs) {
          const m = near(minus, usedM, o), p = near(plus, usedP, o);
          if (!m || !p) break;
          usedM.add(m); usedP.add(p);
          units.push({ inp: p.number, inn: m.number, out: o.number });
        }
      }
      const vp = pinBy(c, /^(V\+|VCC|VDD|VS\+|\+VS|V_?CC|VCC\+|AVDD)$/), vn = pinBy(c, /^(V-|VEE|VSS|VS-|-VS|GND|VCC-)$/);
      if (units.length) return { ref: c.ref, model: 'opamp', units, vp: vp ? vp.number : undefined, vn: vn ? vn.number : undefined };
    }
    return null;
  };
  function sectionSim(circ, seedRefs, seedNets, outsideIC) {
    const chips = [], driven = new Set(), inputs = new Map();
    const comp = r => circ.components.find(c => c.ref === r);
    for (const c of circ.components) {
      if (c.type !== 'ic') continue;
      const g = S.guessChip(circ, c);
      if (!g || g.model === 'switch' || g.boost) continue;   // the section simulator has no load-switch or boost model
      if (g.enLow) { delete g.en; delete g.enLow; }  // and only active-high enables
      chips.push(g);
      for (const k of ['out', 'sw']) if (g[k] !== undefined) { const n = netOfPin(circ, c.ref, g[k]); if (n) driven.add(n.name); }
      for (const u of g.units || []) { const n = netOfPin(circ, c.ref, u.out); if (n) driven.add(n.name); }
      for (const k of ['in', 'vcc', 'vp']) if (g[k] !== undefined) { const n = netOfPin(circ, c.ref, g[k]); if (n) inputs.set(n.name, g); }
    }
    // what an output feeds through inductors, beads, fuses and 0-ohm links is an output too
    const series = c => ['inductor', 'ferrite_bead', 'fuse', 'jumper'].includes(c.type) || (c.type === 'resistor' && (window.DS2K_P2.parseValue(c.value, 'ohm') ?? 1e9) <= 1);
    const queue = [...driven];
    while (queue.length) {
      const nm = queue.shift();
      const n = circ.nets.find(x => x.name === nm);
      for (const x of n ? n.nodes : []) {
        const c = comp(x.ref);
        if (!c || !series(c)) continue;
        for (const m of circ.nets) if (m !== n && !driven.has(m.name) && m.kind !== 'ground' && m.nodes.some(y => y.ref === c.ref)) { driven.add(m.name); queue.push(m.name); }
      }
    }
    const sources = [];
    for (const n of circ.nets) {
      if (n.kind === 'ground' || driven.has(n.name)) continue;
      const v = voltOf(n.name);
      const g = inputs.get(n.name);
      if (g) {
        if (g.model === 'switch') {
          const on = netOfPin(circ, g.ref, g.out), vo = on && voltOf(on.name);
          sources.push({ net: n.name, kind: 'dc', value: v != null ? v : vo || 5, note: v != null ? '' : 'input of ' + g.ref + ' taken from its output rail' });
          continue;
        }
        const outV = g.model === 'regulator' ? +g.vout || 3.3 : g.model === 'switcher' ? Math.max(...[...driven].map(x => voltOf(x)).filter(x => x != null), 1) : 0;
        const ok = v != null && v > outV + (g.model === 'regulator' ? 0.2 : 0.5);
        sources.push({ net: n.name, kind: 'dc', value: ok || (v != null && !outV) ? v : g.model === 'regulator' ? Math.max(5, outV + 1.5) : 12, note: ok || (v != null && !outV) ? '' : 'input voltage assumed - set the real one' });
      }
      else if (n.kind === 'power' && v != null) sources.push({ net: n.name, kind: 'dc', value: v });
      else if (n.kind === 'signal' && n.cut && outsideIC && outsideIC.has(n.name) && n.nodes.length === 1 && (comp(n.nodes[0].ref) || {}).type === 'resistor' && sources.length < 6) sources.push({ net: n.name, kind: 'dc', value: 3.3, note: 'driven from outside this section - assumed logic high' });
    }
    const probes = [];
    for (const n of circ.nets) if (driven.has(n.name)) probes.push(n.name);
    for (const n of circ.nets) if (seedNets.has(n.name) && !probes.includes(n.name) && n.kind !== 'ground') probes.push(n.name);
    for (const n of circ.nets) if (probes.length < 3 && n.kind !== 'ground' && !n.auto && !probes.includes(n.name) && circ.components.some(c => DIODE_T.has(c.type) && n.nodes.some(x => x.ref === c.ref))) probes.push(n.name);
    for (const s of sources) if (probes.length < 4 && !probes.includes(s.net)) probes.push(s.net);
    const loads = [];
    for (const n of circ.nets) if (driven.has(n.name) && n.cut) loads.push({ net: n.name, value: 100, note: 'rest of the board (assumed)' });
    return { sources, standins: [], chips, loads, switches: [], probes: probes.slice(0, 4), tstop: chips.some(c => c.model === '555') ? 2 : undefined };
  }

  // ------------------------------------------------------------------ whole board: every part, chips as models or as the current they draw
  const CHIP_MA = [[/FPGA|ICE40|ECP5|XC7|ARTIX|SPARTAN|CYCLONE|GW1N|MACHXO/, 120], [/RK35|CM3588|IMX|SOM|MODULE|CM4/, 800], [/RP2040|RP2350|STM32|ATSAM|NRF5|ESP32|LPC4|LPC1|MCU|MICROCONTROLLER|ATMEGA|ATTINY|PIC\d/, 25],
    [/USB.*(HUB|PHY)|CH33|USB25|FUSB|CYPRESS|FX2|FX3/, 40], [/PHY|ETH|LAN8|KSZ|RTL8/, 60], [/FLASH|W25Q|IS25|EEPROM|24C|SRAM|PSRAM|DRAM|DDR/, 8], [/ADC|DAC|AFE|CODEC|MAX2837|MAX5864|RFFC|MIXER|LNA|AMP|TPA\d/, 30],
    [/BUFFER|LEVEL|SHIFT|TXB|TXS|SN74|74LVC|74HC|LOGIC|MUX|SWITCH|GATE/, 1], [/LED|DRIVER/, 5], [/SENSOR|IMU|ACCEL|GYRO|TEMP|HALL|ENCODER|MT6701/, 5]];
  function chipCurrent(c) {
    const t = upper(c.value + ' ' + (c.description || ''));
    for (const [rx, ma] of CHIP_MA) if (rx.test(t)) return ma;
    const n = (c.pins || []).length;
    return n <= 8 ? 2 : n <= 16 ? 5 : n <= 32 ? 10 : n <= 64 ? 25 : n <= 128 ? 60 : 100;
  }
  S.chipCurrent = chipCurrent;
  S.wholeBoard = function (B) {
    const full = S.boardCircuit(B);
    const circuit = { design: { title: '' }, components: full.components.map(c => Object.assign({}, c)), nets: full.nets.map(n => Object.assign({}, n, { nodes: n.nodes.slice() })), no_connects: [] };
    placeholderPulls(circuit);
    const sim = autoSim(circuit, { chipLoads: true, connectorSources: true });
    return { circuit, sim, padsOf: full.padsOf };
  };
  // a "resistor" of a few milliohms from a rail (or ground) straight to a logic line (a chip select, a clock, a reset) is a value
  // the designer never filled in, not a short: it is simulated as the 10 kΩ pull it stands for
  const LOGIC_NET = /(^|[^A-Z])(CS|NCS|SS|CHIP.?SELECT|SCK|SCLK|SCL|SDA|MOSI|MISO|COPI|CIPO|TX|RX|INT\d?|IRQ|RST|RESET|NRST|BOOT\d?|GPIO\d*|EN|ENABLE|CLK|DATA|SEL|ADDR?\d?|A[0-2]|WP|HOLD|DRDY)([^A-Z]|$)/;
  function placeholderPulls(circ) {
    const byRef = new Map();
    for (const n of circ.nets) for (const x of n.nodes) { let a = byRef.get(x.ref); if (!a) byRef.set(x.ref, (a = [])); if (!a.includes(n)) a.push(n); }
    for (const c of circ.components) {
      if (c.type !== 'resistor' || c.dnp) continue;
      const v = window.DS2K_P2.parseValue(c.value, 'ohm');
      if (!(v > 0 && v < 0.1)) continue;
      const ns = byRef.get(c.ref) || [];
      if (ns.length !== 2) continue;
      const rail = ns.find(n => n.kind === 'power' || n.kind === 'ground'), sig = ns.find(n => n !== rail);
      if (!rail || !sig || sig.kind === 'power' || sig.kind === 'ground') continue;
      if (!LOGIC_NET.test(upper(sig.name).split('/').pop())) continue;
      c.value = '10k';
      c.valueNote = `${c.ref} is marked ${+v} Ω between ${rail.name} and the logic line ${sig.name}: simulated as a 10 kΩ pull`;
    }
  }
  // chip models for what they fit, supplies on rails that come from outside, and every other chip as its supply current
  function autoSim(circ, o) {
    const chips = [], driven = new Set(), inputs = new Map(), modeled = new Set(), dv = new Map();
    const compMap = new Map(circ.components.map(c => [c.ref, c]));
    const comp = r => compMap.get(r);
    const addChip = (g, ref) => {
      chips.push(g); modeled.add(ref);
      // a charger feeds the battery through its own diode: the battery net stays free for the battery itself
      if (!g.series) for (const k of ['out', 'sw']) if (g[k] !== undefined) { const n = netOfPin(circ, ref, g[k]); if (n) { driven.add(n.name); if (k === 'out' && g.vout != null) dv.set(n.name, +g.vout); } }
      if (g.outNet && !g.series) { driven.add(g.outNet); if (g.vout != null) dv.set(g.outNet, +g.vout); }
      for (const u of g.units || []) { const n = netOfPin(circ, ref, u.out); if (n) driven.add(n.name); }
      // (a boost converter wins: its input has to stay below its output, which says the most about the voltage there)
      for (const k of ['in', 'vcc', 'vp']) if (g[k] !== undefined) { const n = netOfPin(circ, ref, g[k]); if (n && (!inputs.has(n.name) || (g.boost && !inputs.get(n.name).boost))) inputs.set(n.name, g); }
    };
    for (const c of circ.components) {
      if (c.type !== 'ic') continue;
      const g = S.guessChip(circ, c);
      if (g) addChip(g, c.ref);
    }
    // batteries in holders are sources of their own
    for (const c of circ.components) {
      if (c.type !== 'composite' || !c.sub) continue;
      for (const s of c.sub) if (s.t === 'BAT') { const n = netOfPin(circ, c.ref, s.a); if (n && n.kind !== 'ground') driven.add(n.name); }
    }
    // every other chip: a behaviour from the part model library (translators, gates, clocks, supervisors, chargers, USB parts …)
    let pm = null;
    if (N.partModels) {
      const skip = new Set(modeled);
      try { for (const p of (N.fw && N.fw.detect ? N.fw.detect(circ) : [])) skip.add(p.ref); } catch (e) { /* no processors */ }
      try { for (const d of (N.fw && N.fw.deviceDrivers ? N.fw.deviceDrivers(circ) : [])) skip.add(d.ref); } catch (e) { /* no IO expanders */ }
      try { pm = N.partModels.plan(circ, { skip }); } catch (e) { console.warn('part models', e); pm = null; }
      if (pm) for (const g of pm.chips) addChip(g, g.ref);
    }
    const series = c => ['inductor', 'ferrite_bead', 'fuse', 'jumper'].includes(c.type) || (c.type === 'resistor' && (window.DS2K_P2.parseValue(c.value, 'ohm') ?? 1e9) <= 1);
    const byName = new Map(circ.nets.map(n => [n.name, n]));
    const partsNets = new Map();
    for (const n of circ.nets) for (const x of n.nodes) (partsNets.get(x.ref) || partsNets.set(x.ref, []).get(x.ref)).push(n);
    const queue = [...driven];
    while (queue.length) {
      const n = byName.get(queue.shift());
      for (const x of n ? n.nodes : []) {
        const c = comp(x.ref);
        if (!c || !series(c)) continue;
        for (const m of partsNets.get(c.ref) || []) if (m !== n && !driven.has(m.name) && m.kind !== 'ground') { driven.add(m.name); queue.push(m.name); }
      }
    }
    const sources = [];
    const onConnector = n => n.nodes.some(x => { const c = comp(x.ref); return c && c.type === 'connector'; });
    // power paths. For sure: series parts (a fuse, a ferrite, a link, a shunt) and diodes from anode to cathode (an OR-ing diode).
    // Always on: a transistor nothing switches (a P-MOS with its gate pulled to ground for reverse-polarity protection, a pass
    // transistor on a zener) and small filter resistors. Switched: every other MOSFET channel and pass transistor.
    const pinNet = (ref, pin) => { for (const m of partsNets.get(ref) || []) if (m.nodes.some(y => y.ref === ref && String(y.pin) === String(pin))) return m; return null; };
    const otherEnd = (ref, n) => { for (const m of partsNets.get(ref) || []) if (m !== n) return m; return null; };
    const SPREAD_D = new Set(['diode', 'diodes', 'idealdiode']);
    const PASSIVE = new Set(['resistor', 'capacitor', 'capacitor_polarized', 'zener_diode', 'diode', 'schottky_diode', 'led', 'thermistor']);
    // the control pin only sees resistors, capacitors and diodes (nothing switches it); 'gnd': and one of them pulls it to ground
    const staticCtl = (ref, pin, want) => {
      const g = pinNet(ref, pin);
      if (!g) return false;
      if (g.kind === 'ground') return want === 'gnd';
      let pulled = false;
      for (const x of g.nodes) {
        if (x.ref === ref) continue;
        const p = comp(x.ref);
        if (!p || !PASSIVE.has(p.type)) return false;
        const far = otherEnd(p.ref, g);
        if (far && far.kind === 'ground' && p.type !== 'capacitor' && p.type !== 'capacitor_polarized') pulled = true;
      }
      return want === 'gnd' ? pulled : true;
    };
    const fetOn = (ref, gpin, pch) => (pch ? staticCtl(ref, gpin, 'gnd') : !!(pinNet(ref, gpin) && pinNet(ref, gpin).kind === 'power'));
    // who works a switch: 'chip' (a processor pin, a controller, a header, a button, through resistors and driver transistors) or
    // 'circuit' (only resistors, diodes and transistors around it, like the current mirror of a discrete ideal diode)
    const ctlOf = (ref, pin) => {
      const seen = new Set(), q = [[pinNet(ref, pin), 0]];
      while (q.length) {
        const [n, depth] = q.shift();
        if (!n || n.kind === 'ground' || n.kind === 'power' || seen.has(n.name)) continue;
        seen.add(n.name);
        const more = (m) => { if (depth < 3 && m) q.push([m, depth + 1]); };
        for (const x of n.nodes) {
          if (x.ref === ref) continue;
          const p = comp(x.ref), xp = String(x.pin);
          if (!p || p.dnp) continue;
          if (p.type === 'ic' || p.type === 'connector' || p.type === 'switch' || p.type === 'other' || p.type === 'test_point') return 'chip';
          if (p.type === 'mosfet_n' || p.type === 'mosfet_p') { if (xp === 'D' || xp === 'S') more(pinNet(p.ref, 'G')); continue; }
          if (p.type === 'bjt_npn' || p.type === 'bjt_pnp') { if (xp === 'C' || xp === 'E') more(pinNet(p.ref, 'B')); continue; }
          if (p.type === 'composite') {
            for (const sb of p.sub || []) {
              if (sb.t === 'SW' && (String(sb.a) === xp || String(sb.b) === xp)) return 'chip';
              if (sb.t === 'M' && (String(sb.d) === xp || String(sb.s) === xp)) more(pinNet(p.ref, sb.g));
              else if (sb.t === 'Q' && (String(sb.c) === xp || String(sb.e) === xp)) more(pinNet(p.ref, sb.b));
              else if (sb.a != null && sb.b != null && (String(sb.a) === xp || String(sb.b) === xp)) more(pinNet(p.ref, String(sb.a) === xp ? sb.b : sb.a));
            }
            continue;
          }
          more(otherEnd(p.ref, n));
        }
      }
      return 'circuit';
    };
    // mode: 0 = for sure, 1 = also always-on parts, 2 = also switches. Lists [net, hop]: hop says what was passed (a switch, an inductor)
    const through = (n, x, mode) => {
      const c = comp(x.ref), pin = String(x.pin);
      if (!c) return [];
      if (series(c)) return c.type === 'jumper' && c.closed === false ? [] : (partsNets.get(c.ref) || []).filter(m => m !== n).map(m => [m, c.type === 'inductor' ? { coil: true } : null]);
      if (mode === 'series') {
        if (c.type !== 'composite') return [];
        const out = [];
        for (const sb of c.sub || []) if (((sb.t === 'R' && sb.v <= 1) || (sb.t === 'SW' && sb.closed && sb.ctl == null)) && (String(sb.a) === pin || String(sb.b) === pin)) out.push([pinNet(c.ref, String(sb.a) === pin ? sb.b : sb.a), null]);
        return out;
      }
      if (DIODE_T.has(c.type)) return (c.type === 'diode' || c.type === 'schottky_diode') && pin === 'A' ? [[pinNet(c.ref, 'K'), null]] : [];
      if (c.type === 'composite') {
        const out = [];
        (c.sub || []).forEach((sb, i) => {
          if (((sb.t === 'R' && sb.v <= (mode ? 100 : 1)) || (sb.t === 'SW' && sb.closed && sb.ctl == null)) && (String(sb.a) === pin || String(sb.b) === pin)) out.push([pinNet(c.ref, String(sb.a) === pin ? sb.b : sb.a), null]);
          else if (sb.t === 'D' && SPREAD_D.has(c.kind) && sb.model !== 'DZ' && String(sb.a) === pin) out.push([pinNet(c.ref, sb.b), null]);
          else if (mode && sb.t === 'M' && (String(sb.d) === pin || String(sb.s) === pin)) {
            const on = fetOn(c.ref, sb.g, sb.pch);
            if (on || mode === 2) out.push([pinNet(c.ref, String(sb.d) === pin ? sb.s : sb.d), on ? null : { name: c.ref + '#' + i, ref: c.ref, kind: 'M', ctlPin: String(sb.g), pch: !!sb.pch }]);
          }
        });
        return out;
      }
      if (!mode) return [];
      if (c.type === 'resistor') return (window.DS2K_P2.parseValue(c.value, 'ohm') ?? 1e9) <= 100 ? [[otherEnd(c.ref, n), null]] : [];
      if (c.type === 'mosfet_n' || c.type === 'mosfet_p') {
        if (pin !== 'D' && pin !== 'S') return [];
        const on = fetOn(c.ref, 'G', c.type === 'mosfet_p');
        return on || mode === 2 ? [[pinNet(c.ref, pin === 'D' ? 'S' : 'D'), on ? null : { name: c.ref, ref: c.ref, kind: 'M', ctlPin: 'G', pch: c.type === 'mosfet_p' }]] : [];
      }
      // a pass transistor: an NPN (or a PNP on a negative rail) follows from collector to emitter, a PNP high-side switch from emitter to collector
      if (c.type === 'bjt_npn' || c.type === 'bjt_pnp') {
        const on = staticCtl(c.ref, 'B', 'any');
        if (!on && mode === 1) return [];
        const from = c.type === 'bjt_npn' || (voltOf(n.name) || 0) < 0 ? 'C' : 'E';
        return pin === from ? [[pinNet(c.ref, from === 'C' ? 'E' : 'C'), on ? null : { name: c.ref, ref: c.ref, kind: 'Q', ctlPin: 'B' }]] : [];
      }
      return [];
    };
    // par: how each net was first reached (from which net, through what), to find the switches between a supply and a rail
    const reach = (name, mode, into, par, value, vmap) => {
      const out = into || new Set();
      const q = [name];
      out.add(name);
      if (vmap && value != null && !vmap.has(name)) vmap.set(name, value);
      while (q.length) {
        const n = byName.get(q.shift());
        if (!n) continue;
        for (const x of n.nodes) for (const [m, hop] of through(n, x, mode)) if (m && m.kind !== 'ground' && !out.has(m.name)) {
          out.add(m.name); q.push(m.name);
          if (par) par.set(m.name, { from: n.name, hop });
          if (vmap && value != null && !vmap.has(m.name)) vmap.set(m.name, value);
        }
      }
      return out;
    };
    // sureS: reached through series parts only (a fuse, a ferrite, a link): the same rail; an entry rail behind an OR-ing diode is
    // still an entry of its own
    const sure = new Set(), sureS = new Set(), fed = new Set(), switched = new Set(), par = new Map(), viaV = new Map();
    const spread = (name, value) => { reach(name, 'series', sureS); reach(name, 0, sure); reach(name, 1, fed); reach(name, 2, switched, par, value, viaV); };
    // what the modelled chips make reaches on as well, but never stands in for a connector rail or a battery: the chip's model
    // may not be the whole story (a PoE or flyback converter, a charger's system output), and power comes in there
    const drivenV = name => (dv.has(name) ? dv.get(name) : voltOf(name));
    for (const d of driven) { reach(d, 1, fed); reach(d, 2, switched, par, drivenV(d), viaV); }
    // the switches between a supply and a rail that relies on them: a MOSFET a chip or the firmware works is switched on, as it
    // would be on the running board (the panel can switch it off); one the circuit itself works is left to the circuit
    // a converter's switch node: a coil, a diode or a transistor channel (or a chip's SW pin), and no capacitor to ground (an
    // output rail has its bulk capacitors)
    const swNode = name => {
      const n = byName.get(name);
      if (!n) return false;
      let coilHere = false, other = false;
      for (const x of n.nodes) {
        const c = comp(x.ref);
        if (!c) continue;
        if (/^capacitor/.test(c.type)) { const m = otherEnd(c.ref, n); if (m && m.kind === 'ground') return false; continue; }
        if (c.type === 'inductor') coilHere = true;
        else if (DIODE_T.has(c.type) || c.type === 'mosfet_n' || c.type === 'mosfet_p') other = true;
        else if (c.type === 'composite' && (c.sub || []).some(sb => sb.t === 'D' || sb.t === 'M')) other = true;
        else if (c.type === 'ic') { const p = (c.pins || []).find(q => String(q.number) === String(x.pin)); if (p && /^(SW\d*|LX\d*|PH\d*|VSW|PHASE)$/i.test(String(p.name || ''))) other = true; }
      }
      return coilHere && other;
    };
    const fetForce = new Map(), powerSwitches = new Map();
    const openPath = name => {
      const hops = [];
      let k = name, guard = 0;
      while (par.has(k) && guard++ < 60) { const p = par.get(k); if (p.hop && !p.hop.coil) hops.push(Object.assign({ a: p.from, b: k }, p.hop)); k = p.from; }
      // a switch on a converter's switch node (a coil and a diode or another switch there: a buck's high side, a boost's low
      // side) is the converter's own switch, not a power switch
      if (hops.some(h => swNode(h.a) || swNode(h.b))) return false;
      for (const h of hops) {
        const ctl = ctlOf(h.ref, h.ctlPin);
        if (!powerSwitches.has(h.name)) powerSwitches.set(h.name, { name: h.name, ref: h.ref, kind: h.kind, pch: !!h.pch, ctl, from: h.a, to: h.b, rail: name, on: ctl === 'chip' && h.kind === 'M' });
        if (ctl === 'chip' && h.kind === 'M') fetForce.set(h.name, { name: h.name, on: true, note: 'switched on, as the firmware or its controller would on the running board' });
      }
      return true;
    };
    // where a supply physically comes in: connector pins on the rail, else the output pins of a chip that is not modelled,
    // else a battery; its return flows through that part's ground pins (so the copper shows the current going round)
    const gndNets = circ.nets.filter(n => n.kind === 'ground');
    const gndPins = ref => { const a = []; for (const n of gndNets) for (const x of n.nodes) if (x.ref === ref) a.push([ref, String(x.pin)]); return a; };
    const OUT_PIN = /^(V?OUT\d*|VO|LX\d*|SW\d*|VREG\w*|LDO\w*|VCAP\w*|VDD\d*_?OUT|V\d+(V\d+)?_?OUT|BUCK\d*|PWR_?OUT|VSYS|SYS)$/i;
    const entry = n => {
      const conn = n.nodes.filter(x => { const c = comp(x.ref); return c && c.type === 'connector'; });
      let pins = conn, refs = [...new Set(conn.map(x => x.ref))];
      if (!pins.length) {
        pins = n.nodes.filter(x => { const c = comp(x.ref); if (!c || c.type !== 'ic' || modeled.has(c.ref)) return false; const p = (c.pins || []).find(q => String(q.number) === String(x.pin)); return p && (p.etype === 'power_out' || OUT_PIN.test(String(p.name || ''))); });
        refs = [...new Set(pins.map(x => x.ref))];
      }
      if (!pins.length) { pins = n.nodes.filter(x => /^(BT|BAT)\d/i.test(x.ref)); refs = [...new Set(pins.map(x => x.ref))]; }
      if (!pins.length) return {};
      return { pins: pins.map(x => [x.ref, String(x.pin)]), gnd: refs.flatMap(gndPins) };
    };
    // supplies in order: what comes in on a connector, a battery, a converter's input, then rails nothing on the board makes
    const isBatt = n => /^(\+?V?BAT|BATT|VBATT|BAT\+|\+BATT)/i.test(n.name.split('/').pop());
    const rank = n => (n.kind === 'power' && onConnector(n) ? 0 : isBatt(n) ? 1 : inputs.has(n.name) ? 2 : 3);
    // within a rank: the rails named as inputs first (VBUS, VIN, a DC jack), then the bigger voltage (a +9 V rail feeds the +6 V one
    // made from it, not the other way round)
    const INPUT_NAME = /VBUS|VUSB|USB|^\+?V_?IN|VIN$|DC_?IN|JACK|BARREL|POE|EXT|PWR_?IN|RAW|INPUT/i;
    const mag = n => Math.abs(voltOf(n.name) || 0);
    const inName = n => { const nm = n.name.split('/').pop(); return /VBUS|VUSB|USB/i.test(nm) ? 0 : INPUT_NAME.test(nm) ? 1 : 2; };
    // (a rail whose name states its voltage before one whose voltage is only guessed: +1V2 before VCC_PLL)
    const stated = n => (S.nominalOf(n.name) != null ? 0 : 1);
    let candidates = circ.nets.filter(n => n.kind !== 'ground' && !driven.has(n.name)).sort((a, b) => rank(a) - rank(b) || inName(a) - inName(b) || stated(a) - stated(b) || mag(b) - mag(a));
    if (S._legacySources) candidates = circ.nets.filter(n => n.kind !== 'ground' && !driven.has(n.name));
    else {
      // a named rail that feeds a converter's input through a fuse, a ferrite or a diode goes before that input (VIN before 3V3_VIN)
      const named = candidates.filter(n => rank(n) === 3 && n.kind === 'power' && voltOf(n.name) != null);
      if (named.length && named.length <= 150) {
        const rr = new Map(named.map(n => [n.name, reach(n.name, 0)]));
        const out = [], done = new Set();
        for (const n of candidates) {
          if (done.has(n.name)) continue;
          if (rank(n) === 2) for (const p of named) if (!done.has(p.name) && rr.get(p.name).has(n.name)) { out.push(p); done.add(p.name); }
          out.push(n); done.add(n.name);
        }
        candidates = out;
      }
    }
    const push = (n, src) => { sources.push(Object.assign(src, entry(n))); spread(n.name, src.value); };
    // the voltage a rail's name commits to: written out (+3V3, 5V_USB), or a USB rail (5 V). A battery's name does not: +BATT is
    // a lithium cell on one board and a car battery on another
    const statedV = n => { const v = S.nominalOf(n.name); if (v != null) return v; const nm = n.name.split('/').pop(); if (/VBUS|VUSB|USB/i.test(nm) && !dataLine(n)) return 5; return null; };
    // the nearest named rail behind fuses, ferrites and protection diodes (either way round: a negative rail's diode points
    // at the header)
    // a rail whose voltage is only guessed from its name (VinP1, VCC_X) is held only where a chip draws its supply from it
    const SUPPLY_NM = /^(V?CC|V?DD|VIN|AVDD|DVDD|IOVDD|VDDIO|VIO|VBAT|VSYS|VS|V\+|PVDD|AVCC|DVCC|VCCIO|VDDA|VDDD|VCCA|VCCB|VREF|VDDQ|VPP|VM|VBB|VLED|VDD\w*|VCC\w*)\d*$/i;
    const feedsChip = n => n.nodes.some(x => { const c = comp(x.ref); if (!c || c.type !== 'ic') return false; const p = (c.pins || []).find(q => String(q.number) === String(x.pin)); return p && (p.etype === 'power_in' || SUPPLY_NM.test(String(p.name || '').replace(/[_-]\d+$/, ''))); });
    const namedNeighbour = n0 => {
      const seen = new Set([n0.name]), q = [[n0, 0, null]];
      let best = null;
      while (q.length) {
        const [n, depth, via] = q.shift();
        if (best && depth > best.depth) break;
        for (const x of n.nodes) {
          const c = comp(x.ref);
          if (!c || !(series(c) || c.type === 'diode' || c.type === 'schottky_diode')) continue;
          const m = otherEnd(c.ref, n);
          if (!m || m.kind === 'ground' || seen.has(m.name)) continue;
          seen.add(m.name);
          const v = S.nominalOf(m.name);
          if (v != null) { if (!best || Math.abs(v) > Math.abs(best.v)) best = { v, name: m.name, ref: via || c.ref, depth: depth + 1 }; }
          else if (depth < 3) q.push([m, depth + 1, via || c.ref]);
        }
      }
      return best;
    };
    // USB data and control lines are never a supply, whatever the net class says
    const dataLine = n => { const nm = n.name.split('/').pop(); return /(^|[^A-Z])(D[+-PN]|D_[PN]|DP|DM|DATA|CC\d?|SBU\d?|ID|OTG|GATE|SENSE|SNS|DET|CAP|MOS|FET|NPN|PNP|DRV|DRIVE|CTRL|CTL|EN|FB|ADC|MON)([^A-Z]|$)|[+-]$/i.test(nm) || /CTRL|CTL|ENABLE|DETECT|SENSE|GATE|FAULT|ALERT|STATUS/i.test(nm); };
    for (const n of candidates) {
      // a supply already reaches it for sure (a fuse, a link, a diode), or through an always-on part and it is not where power comes in
      if (!S._legacySources && (rank(n) <= 1 ? sureS.has(n.name) : sure.has(n.name) || fed.has(n.name))) continue;
      // tied to ground through a 0 Ω link (an unused battery input strapped off): it is ground, not a supply
      if (!S._legacySources && n.nodes.some(x => { const c = comp(x.ref); if (!c || !series(c) || (c.type === 'jumper' && c.closed === false)) return false; const m = otherEnd(c.ref, n); return m && m.kind === 'ground'; })) continue;
      // an entry rail behind an OR-ing diode keeps its own supply only at a voltage that does not push current into it
      if (!S._legacySources && rank(n) <= 1 && sure.has(n.name)) { const vst0 = statedV(n), vs0 = viaV.get(n.name); if (vst0 == null || (vs0 != null && vst0 < vs0 - 0.25)) continue; }
      const g = inputs.get(n.name);
      let v = voltOf(n.name);
      // a converter's input named after what it makes (3V3_VIN on a 3.3 V buck) does not say its own voltage
      if (g && v != null && (g.model === 'regulator' || g.model === 'switcher') && g.vout != null && Math.abs(v - g.vout) <= 0.1 * Math.max(1, g.vout) && /IN/i.test(n.name)) v = null;
      // a buck's input whose name says no more than its output (5V_VCC on the VCC pins of a 5 V buck): the input is higher
      let swOut = null;
      if (g && g.model === 'switcher' && !g.boost) {
        const swN = g.sw != null ? netOfPin(circ, g.ref, g.sw) : null, ind = swN && inductorFrom(circ, swN);
        swOut = ind ? S.nominalOf(ind.other.name) : null;
        if (swOut == null && g.fb != null && g.vref) { const dv2 = fbDivider(circ, g.ref, g.fb); if (dv2) swOut = g.vref * (1 + dv2.top / dv2.bot); }
        if (v != null && swOut != null && swOut > 0.5 && v <= swOut + 0.3) v = null;
      }
      // reached only through a power switch: the switch decides (switched on where a chip works it), unless it is where power
      // comes in with a voltage of its own, or the switch belongs to a converter (the voltage differs: a buck's high-side FET)
      if (!S._legacySources && switched.has(n.name) && (rank(n) > 1 || statedV(n) == null)) {
        const vs = viaV.get(n.name), vst = statedV(n);
        const same = vst == null || vs == null || Math.abs(vs - vst) <= 0.15 * Math.max(Math.abs(vst), 1);
        const wants = g || (n.kind === 'power' && (v != null || rank(n) === 0));
        if (same && (!wants || openPath(n.name))) continue;
      }
      const viaNote = '';
      // a boost converter's input sits below its output: a guessed voltage above it (DCDC_VIN read as 12 V) is no good
      const bv = S.nominalOf(n.name) != null ? v : v != null && g && g.boost && g.vout != null && v < +g.vout ? v : null;
      if (g && g.boost) push(n, { net: n.name, kind: 'dc', value: bv != null ? bv : 3.7, note: bv != null ? viaNote : 'boost input assumed 3.7 V (a lithium cell) - set the real one' });
      else if (g && g.series) { if (v != null || onConnector(n)) push(n, { net: n.name, kind: 'dc', value: v != null ? v : 5, note: v != null ? viaNote : 'charger input assumed 5 V (USB)' }); }
      else if (g) {
        const outV = g.model === 'regulator' ? +g.vout || 3.3 : g.model === 'switcher' ? Math.max(...[...driven].map(x => voltOf(x)).filter(x => x != null), 1) : 0;
        const ok = v != null && (v > outV + (g.model === 'regulator' ? 0.2 : 0.5) || S.nominalOf(n.name) != null);
        const assumed = /POE/i.test(n.name) ? 48 : g.model === 'regulator' ? Math.max(5, outV + 1.5) : swOut != null && swOut >= 8 ? Math.round(swOut * 2) : 12;   // PoE: 48 V
        push(n, { net: n.name, kind: 'dc', value: ok || (v != null && !outV) ? v : assumed, note: ok || (v != null && !outV) ? viaNote : 'input voltage assumed - set the real one' });
      } else if (n.kind === 'power' && v != null && !(dataLine(n) && S.nominalOf(n.name) == null) && (S.nominalOf(n.name) != null || rank(n) <= 1 || feedsChip(n))) push(n, { net: n.name, kind: 'dc', value: v, note: onConnector(n) ? 'from the connector' : 'rail with no modelled source - held at its nominal voltage' });
      else if (n.kind === 'power' && o.connectorSources && onConnector(n) && /VBUS|VUSB|USB/i.test(n.name) && !dataLine(n)) push(n, { net: n.name, kind: 'dc', value: 5, note: 'USB supply' });
      else if (n.kind === 'power' && o.connectorSources && rank(n) === 0) {
        // a header rail with no voltage in its name that feeds a named rail through a diode or a fuse (reverse-polarity protection
        // on a eurorack or DC header): it brings that rail's voltage
        const nb = namedNeighbour(n);
        if (nb) push(n, { net: n.name, kind: 'dc', value: nb.v, note: 'the ' + nb.name + ' supply, which it feeds through ' + nb.ref });
      }
    }
    const standins = [];
    const sourced = new Set(sources.map(x => x.net));
    const filterR = name => {
      const n = byName.get(name);
      if (!n || driven.has(name) || sourced.has(name)) return Infinity;
      let r = Infinity;
      for (const x of n.nodes) {
        const c = comp(x.ref);
        if (!c || c.type !== 'resistor') continue;
        const val = window.DS2K_P2.parseValue(c.value, 'ohm');
        const m = otherEnd(c.ref, n);
        if (val != null && val > 1 && val < r && m && m.kind === 'power') r = val;
      }
      return r;
    };
    if (o.chipLoads) {
      for (const c of circ.components) {
        if (c.type !== 'ic' || modeled.has(c.ref) || c.dnp) continue;
        const sup = new Map();
        for (const p of c.pins || []) {
          const n = netOfPin(circ, c.ref, p.number);
          if (!n || n.kind === 'ground') continue;
          if (n.kind === 'power' || p.etype === 'power_in') { if (!sup.has(n.name)) sup.set(n.name, p.number); }
        }
        if (!sup.size) continue;
        const ma0 = chipCurrent(c) / sup.size;
        for (const [net, pin] of sup) {
          const v = Math.abs(voltOf(net) || 3.3);   // a negative rail loads the same way
          // a supply pin behind a filter resistor (a PLL or analog supply's RC) draws little: at most a 5 % drop across it
          const rf = filterR(net);
          const ma = rf < Infinity ? Math.min(ma0, 50 * v / rf) : ma0;
          standins.push({ ref: c.ref, pin, kind: 'load', value: +(v / (ma / 1000)).toPrecision(3), note: `${c.value}: about ${+ma.toPrecision(2)} mA from ${net} (estimated)` });
        }
      }
    }
    // a regulator whose enable a processor works (or a chip nothing models here, or another regulator's power-good), held off by a
    // pull until then: it starts on, as on the running board where the firmware has switched it on. The panel hands it back to its
    // pin. One a switch, a header or a modelled part works is left to them
    const procRefs = new Set();
    try { for (const p of (N.fw && N.fw.detect ? N.fw.detect(circ) : [])) procRefs.add(p.ref); } catch (e) { /* no processors */ }
    const behaved = new Set(pm && pm.models ? [...pm.models.keys()] : []);
    const enCtl = (ref, pin) => {
      const seen = new Set(), q = [[pinNet(ref, pin), 0]];
      while (q.length) {
        const [n, depth] = q.shift();
        if (!n || n.kind === 'ground' || n.kind === 'power' || seen.has(n.name)) continue;
        seen.add(n.name);
        for (const x of n.nodes) {
          if (x.ref === ref) continue;
          const p = comp(x.ref), xp = String(x.pin);
          if (!p || p.dnp) continue;
          if (p.type === 'switch' || p.type === 'connector' || p.type === 'test_point' || (p.type === 'composite' && (p.sub || []).some(sb => sb.t === 'SW'))) return 'manual';
          if (p.type === 'ic') {
            if (procRefs.has(p.ref)) return 'proc';
            const pp = (p.pins || []).find(k => String(k.number) === xp), nm = upper(pp && pp.name).replace(/^~\{?|\}$/g, '');
            if (/^(EN|ENABLE|CE|ON|RUN|SHDN|EN\d|PWR_?EN|EN_?IN)$/.test(nm)) continue;   // another part's enable on the same line
            if (/^(P(OWER_?)?G(OOD)?\d?|POK|PWRGD|PWR_?GOOD)$/.test(nm)) return 'pg';
            return behaved.has(p.ref) || modeled.has(p.ref) ? 'model' : 'ic';
          }
          if ((p.type === 'mosfet_n' || p.type === 'mosfet_p' || p.type === 'bjt_npn' || p.type === 'bjt_pnp') && !/^[GB]$/.test(xp)) return 'circuit';
          if (p.type === 'resistor' && depth < 2) { const far = otherEnd(p.ref, n); if (far && far.kind !== 'power' && far.kind !== 'ground') q.push([far, depth + 1]); }
        }
      }
      return 'none';
    };
    const regForce = [];
    for (const ch of chips) {
      if (ch.en == null || ch.series) continue;
      const n = pinNet(ch.ref, ch.en);
      if (!n || n.kind === 'power' || n.kind === 'ground') continue;
      const who = enCtl(ch.ref, ch.en);
      if (who !== 'proc' && who !== 'ic' && who !== 'pg') continue;
      // only a regulator that makes a named rail (+3V3_PGA, 1V8_ACQ): one feeding an unnamed net is often adjustable from the
      // firmware (an I/O bank supply set by a DAC) and stays as its pin says
      let outN = ch.out != null ? pinNet(ch.ref, ch.out) : null;
      if (!outN && ch.sw != null) { const swN = pinNet(ch.ref, ch.sw), ind = swN && inductorFrom(circ, swN); outN = ind ? ind.other : null; }
      if (!outN || S.nominalOf(outN.name) == null) continue;
      let up = false;
      for (const x of n.nodes) { const p = comp(x.ref); if (!p || p.type !== 'resistor' || x.ref === ch.ref) continue; const far = otherEnd(p.ref, n); if (far && far.kind === 'power') up = true; }
      // already on from its pull (active high pulled up, active low pulled down or left alone): nothing to do
      if (ch.enLow ? !up : up) continue;
      regForce.push({ ref: ch.ref, on: true, by: who, note: who === 'pg' ? 'switched on, as the power-good of the rail before it would on the running board' : 'switched on, as the firmware would on the running board' });
    }
    const probes = [...driven].filter(n => byName.get(n) && byName.get(n).kind === 'power').slice(0, 4);
    return { sources, standins, chips, loads: [], switches: [], probes, tstop: undefined, drivers: pm ? pm.drivers : [], behaviours: pm ? pm.behaviours : [], models: pm ? Object.fromEntries(pm.models) : {}, fetForce: [...fetForce.values()], powerSwitches: [...powerSwitches.values()], regForce };
  }
  S.autoSim = autoSim;

})();

/* KiLive — schematic capture editor.
   Draw a new circuit (parts, wires, net labels, power ports) and turn it into a DS2K circuit dict.
   Document coordinates are integer grid units (1 unit = 1.27 mm = 50 mil), y down. Symbols come from the DS2K engine. */
(function () {
  'use strict';
  const N = (window.Noeti = window.Noeti || {});
  const G = 1.27;
  const FONT = '"IBM Plex Sans Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  const PROBE = '#e3a600';
  const E1 = () => window.DS2K_P1;
  const DS = () => window.DS2K;
  const INF = Infinity;

  // ------------------------------------------------------------------ small helpers
  const K = (x, y) => x + ',' + y;
  const unK = k => k.split(',').map(Number);
  const clone = o => JSON.parse(JSON.stringify(o));
  const uid = () => Math.random().toString(36).slice(2, 8);
  const S = v => (v == null ? '' : String(v));
  const mod360 = r => (((Math.round((+r || 0) / 90) * 90) % 360) + 360) % 360;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(v); };
  const bbNew = () => [INF, INF, -INF, -INF];
  const grow = (b, x, y) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; };
  const growBB = (b, o) => { if (o && o[0] <= o[2]) { grow(b, o[0], o[1]); grow(b, o[2], o[3]); } };
  const inBB = (b, x, y, t = 0) => x >= b[0] - t && x <= b[2] + t && y >= b[1] - t && y <= b[3] + t;
  const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  const within = (a, r) => a[0] >= r[0] && a[2] <= r[2] && a[1] >= r[1] && a[3] <= r[3];
  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  const refCmp = (a, b) => (N.refCmp ? N.refCmp(a, b) : String(a).localeCompare(String(b)));
  function hexRgb(h) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  function rgba(h, a) { const c = hexRgb(h); return c ? `rgba(${c[0]},${c[1]},${c[2]},${a})` : h; }
  function mix(a, b, t) {
    const x = hexRgb(a), y = hexRgb(b);
    if (!x || !y) return a;
    return 'rgb(' + x.map((v, i) => Math.round(v * t + y[i] * (1 - t))).join(',') + ')';
  }

  let mctx = null;
  function textW(str, size, weight) {
    if (!mctx && typeof document !== 'undefined') mctx = document.createElement('canvas').getContext('2d');
    if (!mctx) return String(str).length * size * 0.72;
    mctx.font = `${weight || 400} 100px ${FONT}`;
    return mctx.measureText(String(str).replace(/~\{([^}]*)\}/g, '$1')).width * size * 1.3 / 100;
  }
  // bbox of a text run (ang 0 or 90) anchored at x,y with horizontal justification h and vertical centre
  function textBox(x, y, w, size, h, ang) {
    const hh = size * 1.3;
    if (!ang) { const x0 = h === 'left' ? x : h === 'right' ? x - w : x - w / 2; return [x0, y - hh * 0.6, x0 + w, y + hh * 0.6]; }
    const y1 = h === 'left' ? y : h === 'right' ? y + w : y + w / 2;
    return [x - hh * 0.6, y1 - w, x + hh * 0.6, y1];
  }

  // ------------------------------------------------------------------ catalogue
  const PK_CHIP = ['0402', '0603', '0805', '1206', '1210'];
  const PK_DIODE = ['SOD-123', 'SOD-123F', 'SOD-323', 'SOD-523', 'SMA', 'SMB', 'SMC', 'DO-41', 'DO-35', 'SOT-23'];
  const PK_Q = ['SOT-23', 'SOT-323', 'SOT-223', 'SOT-89', 'TO-92', 'TO-220', 'TO-252', 'TO-263'];
  const PK_IC = ['SOIC-8', 'SOIC-14', 'SOIC-16', 'TSSOP-8', 'TSSOP-14', 'TSSOP-16', 'TSSOP-20', 'MSOP-8', 'MSOP-10', 'DIP-8', 'DIP-14', 'DIP-16',
    'SOT-23', 'SOT-23-5', 'SOT-23-6', 'SOT-223', 'SOT-89', 'TO-220', 'TO-92', 'QFN-16', 'QFN-20', 'QFN-24', 'QFN-32', 'LQFP-32', 'LQFP-48', 'LQFP-64', 'TQFP-32', 'TQFP-44', 'Module'];
  const Q_ORDERS = { bjt: ['BEC', 'BCE', 'EBC', 'CBE', 'ECB'], mos: ['GSD', 'GDS', 'SGD', 'DGS'] };
  const T = (name, prefix, o) => Object.assign({ name, prefix, ph: ['', '', ''] }, o);
  const TYPES = {
    resistor: T('Resistor', 'R', { lib: 'Device:R', value: '10k', pkg: '0603', pkgs: [...PK_CHIP, '2010', '2512', 'Axial THT'], ph: ['10k', '0.1W', '1%'], kw: 'res ohm' }),
    capacitor: T('Capacitor', 'C', { lib: 'Device:C', value: '100nF', pkg: '0603', pkgs: [...PK_CHIP, 'Radial THT'], ph: ['100nF', '50V X7R', '10%'], kw: 'cap ceramic mlcc' }),
    capacitor_polarized: T('Polarised capacitor', 'C', { lib: 'Device:C_Polarized', value: '10uF', pkg: '3528', pkgs: ['3216', '3528', '6032', '7343', 'Radial 5mm', 'Radial 6.3mm', 'Radial 8mm'], ph: ['10uF', '16V', '20%'], kw: 'cap electrolytic tantalum polarized' }),
    inductor: T('Inductor', 'L', { lib: 'Device:L', value: '10uH', pkg: '1210', pkgs: ['0603', '0805', '1206', '1210', '4x4mm', '5x5mm', '6x6mm', '10x10mm'], ph: ['10uH', '2A', '20%'], kw: 'coil choke' }),
    ferrite_bead: T('Ferrite bead', 'FB', { lib: 'Device:FerriteBead', value: '600R@100MHz', pkg: '0603', pkgs: ['0402', '0603', '0805', '1206'], ph: ['600R@100MHz', '1A', '25%'], kw: 'bead emi' }),
    fuse: T('Fuse', 'F', { lib: 'Device:Fuse', value: '500mA', pkg: '1206', pkgs: ['0603', '0805', '1206', '1812', '5x20mm'], ph: ['500mA', '32V', ''], kw: 'polyfuse ptc' }),
    thermistor: T('NTC thermistor', 'TH', { lib: 'Device:Thermistor_NTC', value: '10k', pkg: '0603', pkgs: ['0402', '0603', '0805'], ph: ['10k', 'B3950', '1%'], kw: 'ntc temperature' }),
    diode: T('Diode', 'D', { lib: 'Device:D', value: '1N4148W', pkg: 'SOD-123', pkgs: PK_DIODE, ph: ['1N4148W', '100V 150mA', ''], kw: 'rectifier' }),
    schottky_diode: T('Schottky diode', 'D', { lib: 'Device:D_Schottky', value: 'SS14', pkg: 'SMA', pkgs: PK_DIODE, ph: ['SS14', '40V 1A', ''], kw: 'diode' }),
    zener_diode: T('Zener diode', 'D', { lib: 'Device:D_Zener', value: '5.1V', pkg: 'SOD-123', pkgs: PK_DIODE, ph: ['5.1V', '500mW', '5%'], kw: 'diode reference' }),
    tvs_diode: T('TVS diode', 'D', { lib: 'Device:D_TVS', value: 'SMAJ5.0A', pkg: 'SMA', pkgs: PK_DIODE, ph: ['SMAJ5.0A', '400W', ''], kw: 'diode esd protection' }),
    led: T('LED', 'D', { lib: 'Device:LED', value: 'Red', pkg: '0603', pkgs: ['0402', '0603', '0805', '1206', '3mm THT', '5mm THT'], ph: ['Red', '20mA', ''], kw: 'light diode' }),
    bjt_npn: T('NPN transistor', 'Q', { value: 'MMBT3904', pkg: 'SOT-23', pkgs: PK_Q, ph: ['MMBT3904', '40V 200mA', ''], kw: 'bjt transistor' }),
    bjt_pnp: T('PNP transistor', 'Q', { value: 'MMBT3906', pkg: 'SOT-23', pkgs: PK_Q, ph: ['MMBT3906', '40V 200mA', ''], kw: 'bjt transistor' }),
    mosfet_n: T('N-channel MOSFET', 'Q', { value: '2N7002', pkg: 'SOT-23', pkgs: PK_Q, ph: ['2N7002', '60V 300mA', ''], kw: 'fet nmos transistor' }),
    mosfet_p: T('P-channel MOSFET', 'Q', { value: 'AO3401A', pkg: 'SOT-23', pkgs: PK_Q, ph: ['AO3401A', '30V 4A', ''], kw: 'fet pmos transistor' }),
    crystal: T('Crystal', 'Y', { lib: 'Device:Crystal', value: '16MHz', pkg: '3225', pkgs: ['2016', '2520', '3225', '5032', 'HC-49/S', 'HC-49/U'], ph: ['16MHz', '18pF load', '20ppm'], kw: 'xtal oscillator' }),
    potentiometer: T('Potentiometer', 'RV', { lib: 'Device:R_Potentiometer', value: '10k', pkg: 'Trimmer 3362P', pkgs: ['Trimmer 3362P', 'Trimmer 3314J', 'Rotary 9mm', 'Rotary 16mm'], ph: ['10k', '0.5W', '20%'], kw: 'pot trimmer variable resistor' }),
    switch: T('Push button', 'SW', { lib: 'Switch:SW_Push', value: 'SW_Push', pkg: 'SMD 6x6mm', pkgs: ['SMD 3x6mm', 'SMD 6x6mm', 'THT 6x6mm', 'THT 12x12mm'], ph: ['SW_Push', '12V 50mA', ''], kw: 'switch tactile key' }),
    test_point: T('Test point', 'TP', { lib: 'Connector:TestPoint', value: 'TestPoint', pkg: 'Pad 1.5mm', pkgs: ['Pad 1.0mm', 'Pad 1.5mm', 'Pad 2.0mm', 'THT loop'], ph: ['TestPoint', '', ''], kw: 'probe pad' }),
    jumper: T('Solder jumper', 'JP', { lib: 'Jumper:SolderJumper_2_Open', value: 'SolderJumper', pkg: 'Pads 1.0mm', pkgs: ['Pads 1.0mm', 'Pads 1.5mm'], ph: ['SolderJumper', '', ''], kw: 'bridge link' }),
    connector: T('Connector', 'J', { value: 'Conn_01x02', pkg: 'Header 2.54mm', pkgs: ['Header 2.54mm', 'Header 1.27mm', 'JST PH 2.0mm', 'JST XH 2.5mm', 'JST SH 1.0mm', 'Screw terminal 5.08mm', 'Screw terminal 3.5mm'], ph: ['Conn_01x02', '3A', ''], kw: 'header jst terminal plug' }),
    ic: T('IC / module', 'U', { value: 'IC', pkg: 'SOIC-8', pkgs: PK_IC, ph: ['e.g. LM358', '', ''], kw: 'chip module custom' }),
    other: T('Part', 'U', { value: '', pkg: '', pkgs: PK_IC }),
    transformer: T('Transformer', 'T', { value: '', pkg: '', pkgs: [] }),
    relay: T('Relay', 'K', { value: '', pkg: '', pkgs: [] }),
  };
  const DIODES = new Set(['diode', 'schottky_diode', 'zener_diode', 'tvs_diode', 'led']);
  const QTYPES = { bjt_npn: 'NPN', bjt_pnp: 'PNP', mosfet_n: 'NMOS', mosfet_p: 'PMOS' };
  const TWO_PIN = new Set(['resistor', 'capacitor', 'capacitor_polarized', 'inductor', 'ferrite_bead', 'diode', 'schottky_diode',
    'zener_diode', 'tvs_diode', 'led', 'crystal', 'fuse', 'switch', 'jumper', 'thermistor']);
  const IC_LIKE = new Set(['ic', 'other', 'transformer', 'relay']);
  const NEEDS_VALUE = new Set(['resistor', 'capacitor', 'capacitor_polarized', 'inductor', 'potentiometer', 'thermistor']);
  const ETYPES = [['input', 'input'], ['output', 'output'], ['bidirectional', 'bidir'], ['tri_state', 'tri-state'], ['passive', 'passive'], ['power_in', 'pwr in'],
    ['power_out', 'pwr out'], ['open_collector', 'open-C'], ['open_emitter', 'open-E'], ['no_connect', 'NC'], ['unspecified', 'unspec'], ['free', 'free']];
  const SIDES = [['', 'auto'], ['left', 'left'], ['right', 'right'], ['top', 'top'], ['bottom', 'bottom']];
  const PORTS = [['', 'None (net label)'], ['input', 'Input'], ['output', 'Output'], ['bidirectional', 'Bidirectional'], ['passive', 'Passive']];
  const POWER_NAMES = ['GND', '+5V', '+3V3', '+12V', '+1V8', '+24V', 'VCC', 'VDD', 'VBUS', 'VBAT', 'VIN', '-5V', '-12V', 'GNDA', 'AGND'];

  const pin = (number, name, etype, side) => ({ number, name, etype, side });
  const TEMPLATES = {
    ic: { value: 'IC', package: 'SOIC-8', pins: [pin('1', 'VCC', 'power_in', 'top'), pin('2', 'IN', 'input', 'left'), pin('3', 'OUT', 'output', 'right'), pin('4', 'GND', 'power_in', 'bottom')] },
    ne555: { value: 'NE555', mpn: 'NE555P', package: 'DIP-8', pins: [pin('8', 'VCC', 'power_in', 'top'), pin('4', 'R', 'input', 'top'), pin('2', 'TR', 'input', 'left'),
      pin('6', 'THR', 'input', 'left'), pin('5', 'CV', 'input', 'left'), pin('3', 'Q', 'output', 'right'), pin('7', 'DIS', 'open_collector', 'right'), pin('1', 'GND', 'power_in', 'bottom')] },
    lm358: { value: 'LM358', mpn: 'LM358DR', package: 'SOIC-8', pins: [pin('8', 'V+', 'power_in', 'top'), pin('3', '+INA', 'input', 'left'), pin('2', '-INA', 'input', 'left'),
      pin('5', '+INB', 'input', 'left'), pin('6', '-INB', 'input', 'left'), pin('1', 'OUTA', 'output', 'right'), pin('7', 'OUTB', 'output', 'right'), pin('4', 'V-', 'power_in', 'bottom')] },
    ams1117: { value: 'AMS1117-3.3', mpn: 'AMS1117-3.3', package: 'SOT-223', pins: [pin('3', 'VIN', 'power_in', 'left'), pin('2', 'VOUT', 'power_out', 'right'), pin('1', 'GND/ADJ', 'power_in', 'bottom')] },
    mcp1700: { value: 'MCP1700-3.3', mpn: 'MCP1700T-3302E/TT', package: 'SOT-23', pins: [pin('3', 'VIN', 'power_in', 'left'), pin('2', 'VOUT', 'power_out', 'right'), pin('1', 'GND', 'power_in', 'bottom')] },
    attiny85: { value: 'ATtiny85', mpn: 'ATTINY85-20SU', package: 'SOIC-8', pins: [pin('8', 'VCC', 'power_in', 'top'), pin('1', 'PB5/RST', 'bidirectional', 'left'), pin('2', 'PB3', 'bidirectional', 'left'),
      pin('3', 'PB4', 'bidirectional', 'left'), pin('5', 'PB0', 'bidirectional', 'right'), pin('6', 'PB1', 'bidirectional', 'right'), pin('7', 'PB2', 'bidirectional', 'right'), pin('4', 'GND', 'power_in', 'bottom')] },
  };
  // DS2K_SIM chip models for the templates (pin numbers)
  const SIM_CHIPS = {
    ne555: { model: '555', vcc: '8', gnd: '1', trig: '2', thr: '6', dis: '7', out: '3', cont: '5', reset: '4' },
    lm358: { model: 'opamp', vp: '8', vn: '4', units: [{ inp: '3', inn: '2', out: '1' }, { inp: '5', inn: '6', out: '7' }] },
    ams1117: { model: 'regulator', in: '3', out: '2', gnd: '1', vout: 3.3, dropout: 1.1 },
    mcp1700: { model: 'regulator', in: '3', out: '2', gnd: '1', vout: 3.3, dropout: 0.18 },
  };
  const PALETTE = [
    ['Passives', [['resistor'], ['capacitor'], ['capacitor_polarized'], ['inductor'], ['ferrite_bead'], ['fuse'], ['thermistor']]],
    ['Semiconductors', [['diode'], ['schottky_diode', 'Schottky'], ['zener_diode', 'Zener'], ['tvs_diode', 'TVS'], ['led'], ['bjt_npn', 'NPN'], ['bjt_pnp', 'PNP'], ['mosfet_n', 'N-MOSFET'], ['mosfet_p', 'P-MOSFET']]],
    ['Electromechanical', [['crystal'], ['potentiometer'], ['switch'], ['test_point'], ['jumper'], ['connector', 'Connector 1×N']]],
    ['ICs & templates', [['ic', 'IC / module', 'ic', 'custom pin table'], ['ic', 'NE555', 'ne555', 'timer DIP-8'], ['ic', 'LM358', 'lm358', 'dual op-amp SOIC-8'],
      ['ic', 'AMS1117-3.3', 'ams1117', 'LDO SOT-223'], ['ic', 'MCP1700-3.3', 'mcp1700', 'LDO SOT-23'], ['ic', 'ATtiny85', 'attiny85', 'MCU SOIC-8']]],
  ];

  function qDefault(type, pkg) {
    const p = S(pkg).toUpperCase();
    if (type === 'bjt_npn' || type === 'bjt_pnp') return /TO-?92/.test(p) ? 'EBC' : /TO-?220|TO-?126|TO-?247|SOT-?223|DPAK|TO-?252/.test(p) ? 'BCE' : 'BEC';
    return /TO-?220|TO-?247|TO-?252|TO-?263|DPAK|D2PAK|SOT-?223/.test(p) ? 'GDS' : 'GSD';
  }
  const qOrders = type => (type.startsWith('bjt') ? Q_ORDERS.bjt : Q_ORDERS.mos);
  function qOrder(part) {
    const m = /_([A-Z]{3})$/.exec(S(part.sym));
    return m && qOrders(part.type).includes(m[1]) ? m[1] : qDefault(part.type, part.package);
  }
  const qSym = part => 'Q_' + QTYPES[part.type] + '_' + qOrder(part);
  const connTable = p => Array.isArray(p.pins) && p.pins.length > 0 && p.pins.some(q => !/^\d+$/.test(S(q.number)));
  function connN(p) {
    const tbl = Array.isArray(p.pins) ? p.pins : [];
    const nums = tbl.map(q => (/^\d+$/.test(S(q.number)) ? +q.number : 0));
    return Math.min(99, Math.max(1, Math.round(+p.n || 0), tbl.length, ...nums));
  }
  const icName = p => (S(p.mpn) || S(p.value) || S(p.ref)).replace(/[^A-Za-z0-9_+\-.]/g, '_').replace(/^_+|_+$/g, '') || S(p.ref) || 'IC';
  const icPins = p => (Array.isArray(p.pins) ? p.pins : []).map(q => ({ number: S(q.number), name: S(q.name), etype: S(q.etype) || 'passive', side: S(q.side) }));
  function partPrefix(p) { const m = /^([A-Za-z#_]+)\d/.exec(S(p.ref)); return m ? m[1] : (TYPES[p.type] || TYPES.other).prefix; }

  function newPart(type, tpl) {
    const t = TYPES[type] || TYPES.other;
    const p = { type, value: t.value, package: t.pkg, mpn: '', rating: '', tolerance: '', dnp: false, rot: 0, mirror: false };
    if (QTYPES[type]) p.sym = 'Q_' + QTYPES[type] + '_' + qDefault(type, p.package);
    if (type === 'connector') p.n = 2;
    const tp = tpl && TEMPLATES[tpl];
    if (tp) { p.value = tp.value; p.mpn = tp.mpn || ''; p.package = tp.package; p.pins = clone(tp.pins); if (tpl !== 'ic') p.tpl = tpl; }
    else if (IC_LIKE.has(type)) p.pins = clone(TEMPLATES.ic.pins);
    return p;
  }

  function pinId(type, p) {
    if (DIODES.has(type)) return p.name === 'A' || p.name === 'K' ? p.name : p.number === '1' ? 'K' : 'A';
    if (type === 'capacitor_polarized') return p.number === '1' ? '+' : '-';
    if (QTYPES[type]) return p.name;
    if (type === 'potentiometer') return p.number === '2' ? 'W' : p.number;
    return p.number;
  }

  // ------------------------------------------------------------------ symbols (from DS2K nodes)
  const SYM = new Map();
  function partSym(p) {
    const t = p.type, E = E1();
    if (QTYPES[t]) { const id = 'Device:' + qSym(p); return { key: id, make: () => E.builtinSymbols()[id] }; }
    const d = TYPES[t];
    if (d && d.lib) return { key: d.lib, make: () => E.builtinSymbols()[d.lib] };
    if (t === 'connector' && !connTable(p)) { const n = connN(p); return { key: 'conn:' + n, make: () => E.connectorNode(n) }; }
    const name = icName(p), pins = icPins(p);
    return { key: 'ic:' + name + ':' + JSON.stringify(pins), make: () => E.icSymbolNode(name, pins, {}) };
  }
  function arcParams(s, m, e) {
    const [ax, ay] = s, [bx, by] = m, [cx, cy] = e;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy), TAU = Math.PI * 2, n = a => ((a % TAU) + TAU) % TAU;
    const a0 = Math.atan2(ay - uy, ax - ux), am = Math.atan2(by - uy, bx - ux), a1 = Math.atan2(cy - uy, cx - ux);
    return { ux, uy, r, a0, a1, anti: n(am - a0) > n(a1 - a0) };
  }
  function symInfo(key, make) {
    let info = SYM.get(key);
    if (info) return info;
    if (SYM.size > 600) SYM.clear();
    const E = E1(), node = make();
    if (!node) throw new Error('No symbol for ' + key);
    const def = new E.SymbolDef('lib', E.str(node[1]), node);
    const gfx = [], body = bbNew();
    const hidden = n => !!n && n.slice(1).some(t => E.isSym(t, 'hide') || (E.head(t) === 'hide' && (t.length < 2 || E.str(t[1]) === 'yes')));
    for (const sub of E.children(node, 'symbol')) {
      const m = /^(.*)_(\d+)_(\d+)$/.exec(E.str(sub[1]));
      const u = m ? +m[2] : 1, st = m ? +m[3] : 1;
      if (!(st === 0 || st === 1) || !(u === 0 || u === 1)) continue;
      for (const g of sub) {
        const h = E.head(g);
        if (!h || h === 'pin' || h === 'text') continue;
        const sn = E.child(g, 'stroke'), wn = sn && E.child(sn, 'width');
        const w = wn ? E.fnum(wn[1]) : 0;
        const fn = E.child(g, 'fill'), ft = fn && E.child(fn, 'type');
        const fill = ft ? E.str(ft[1]) : 'none';
        const xy = n => [E.fnum(n[1]), E.fnum(n[2])];
        if (h === 'rectangle') { const a = xy(E.child(g, 'start')), b = xy(E.child(g, 'end')); gfx.push({ k: 'r', a, b, w, fill }); grow(body, ...a); grow(body, ...b); }
        else if (h === 'polyline') { const pts = E.children(E.child(g, 'pts'), 'xy').map(xy); gfx.push({ k: 'p', pts, w, fill }); pts.forEach(q => grow(body, ...q)); }
        else if (h === 'circle') { const c = xy(E.child(g, 'center')), r = E.fnum(E.child(g, 'radius')[1]); gfx.push({ k: 'c', c, r, w, fill }); grow(body, c[0] - r, c[1] - r); grow(body, c[0] + r, c[1] + r); }
        else if (h === 'arc') { const s = xy(E.child(g, 'start')), mid = xy(E.child(g, 'mid')), e = xy(E.child(g, 'end')); gfx.push({ k: 'a', s, m: mid, e, w, fill }); [s, mid, e].forEach(q => grow(body, ...q)); }
      }
    }
    const fields = {};
    for (const p of E.children(node, 'property')) {
      const nm = E.str(p[1]);
      if (nm !== 'Reference' && nm !== 'Value') continue;
      const at = E.child(p, 'at'), eff = E.child(p, 'effects'), j = eff && E.child(eff, 'justify');
      const toks = j ? j.slice(1).map(E.str) : [];
      fields[nm === 'Reference' ? 'ref' : 'val'] = { x: E.fnum(at[1]), y: E.fnum(at[2]), a: at.length > 3 ? E.fnum(at[3]) : 0, h: toks.includes('left') ? 'left' : toks.includes('right') ? 'right' : 'center', hide: hidden(eff) };
    }
    const pins = def.allPins();
    if (body[0] > body[2]) { body[0] = -1.27; body[1] = -1.27; body[2] = 1.27; body[3] = 1.27; }
    const pn = E.child(node, 'pin_names'), off = pn && E.child(pn, 'offset');
    info = { key, gfx, pins, body, fields, isPower: def.isPower, hideNums: hidden(E.child(node, 'pin_numbers')), hideNames: hidden(pn), po: off ? E.fnum(off[1]) : 0.508, paths: null };
    SYM.set(key, info);
    return info;
  }
  function symPaths(info) {
    if (info.paths) return info.paths;
    info.paths = info.gfx.map(g => {
      const p = new Path2D();
      if (g.k === 'r') p.rect(Math.min(g.a[0], g.b[0]), Math.min(g.a[1], g.b[1]), Math.abs(g.a[0] - g.b[0]), Math.abs(g.a[1] - g.b[1]));
      else if (g.k === 'p') { g.pts.forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]))); }
      else if (g.k === 'c') p.arc(g.c[0], g.c[1], g.r, 0, Math.PI * 2);
      else if (g.k === 'a') { const a = arcParams(g.s, g.m, g.e); if (a) p.arc(a.ux, a.uy, a.r, a.a0, a.a1, a.anti); else { p.moveTo(...g.s); p.lineTo(...g.e); } }
      return { p, w: g.w, fill: g.fill };
    });
    return info.paths;
  }
  // small inline SVG preview of a symbol (palette), lib coords are y-up
  function thumbSVG(info, size) {
    const b = info.body.slice();
    for (const q of info.pins) { if (q.hidden) continue; const a = q.angle * Math.PI / 180; grow(b, q.x, q.y); grow(b, q.x + q.length * Math.cos(a), q.y + q.length * Math.sin(a)); }
    const w = b[2] - b[0], h = b[3] - b[1], span = Math.max(w, h, 5) + 1.6;
    const cx = (b[0] + b[2]) / 2, cy = -(b[1] + b[3]) / 2, f = v => Math.round(v * 1000) / 1000;
    const out = [];
    const st = (fill) => ` fill="${fill === 'background' ? 'var(--sch-fill)' : fill === 'outline' ? 'var(--sch-body)' : 'none'}" stroke="var(--sch-body)" stroke-width="1.25" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"`;
    for (const g of info.gfx) {
      if (g.k === 'r') out.push(`<rect x="${f(Math.min(g.a[0], g.b[0]))}" y="${f(-Math.max(g.a[1], g.b[1]))}" width="${f(Math.abs(g.a[0] - g.b[0]))}" height="${f(Math.abs(g.a[1] - g.b[1]))}"${st(g.fill)}/>`);
      else if (g.k === 'p') out.push(`<polyline points="${g.pts.map(q => f(q[0]) + ',' + f(-q[1])).join(' ')}"${st(g.fill)}/>`);
      else if (g.k === 'c') out.push(`<circle cx="${f(g.c[0])}" cy="${f(-g.c[1])}" r="${f(g.r)}"${st(g.fill)}/>`);
      else if (g.k === 'a') {
        const s = [g.s[0], -g.s[1]], m = [g.m[0], -g.m[1]], e = [g.e[0], -g.e[1]], a = arcParams(s, m, e);
        if (!a) continue;
        const TAU = Math.PI * 2, n = x => ((x % TAU) + TAU) % TAU, span2 = a.anti ? n(a.a0 - a.a1) : n(a.a1 - a.a0);
        out.push(`<path d="M${f(s[0])} ${f(s[1])}A${f(a.r)} ${f(a.r)} 0 ${span2 > Math.PI ? 1 : 0} ${a.anti ? 0 : 1} ${f(e[0])} ${f(e[1])}"${st('none')}/>`);
      }
    }
    for (const q of info.pins) {
      if (q.hidden) continue;
      const a = q.angle * Math.PI / 180;
      out.push(`<line x1="${f(q.x)}" y1="${f(-q.y)}" x2="${f(q.x + q.length * Math.cos(a))}" y2="${f(-(q.y + q.length * Math.sin(a)))}" stroke="var(--sch-pin)" stroke-width="1.25" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`);
    }
    return `<svg viewBox="${f(cx - span / 2)} ${f(cy - span / 2)} ${f(span)} ${f(span)}" width="${size}" height="${size}" aria-hidden="true">${out.join('')}</svg>`;
  }

  // ------------------------------------------------------------------ geometry
  // 2x2 matrix mapping lib coords (mm, y up) to sheet offsets (mm, y down); mirror = horizontal flip before rotation
  function mat(rot, mirror) {
    const tf = E1().transform, m = mirror ? 'y' : '';
    const p = tf(1, 0, rot, m), q = tf(0, 1, rot, m);
    return [p[0] + 0, q[0] + 0, p[1] + 0, q[1] + 0];
  }
  const ap = (M, x, y) => [M[0] * x + M[1] * y, M[2] * x + M[3] * y];
  const labelRot = d => (d[0] > 0 ? 0 : d[0] < 0 ? 180 : d[1] < 0 ? 90 : 270);
  // power symbol rotation so its body points along d (natural: 'up' points up, gnd/down point down)
  function powerRot(style, d) {
    let v = style === 'up' ? [0, -1] : [0, 1];
    for (const r of [0, 90, 180, 270]) { if (v[0] === d[0] && v[1] === d[1]) return r; v = [v[1], -v[0]]; }
    return 0;
  }

  function partGeo(p) {
    const src = partSym(p), info = symInfo(src.key, src.make), E = E1();
    const M = mat(p.rot, p.mirror), mir = p.mirror ? 'y' : '';
    const ox = p.x * G, oy = p.y * G;
    const pins = info.pins.map((q, i) => {
      const o = ap(M, q.x, q.y), a = q.angle * Math.PI / 180;
      const e = ap(M, q.x + q.length * Math.cos(a), q.y + q.length * Math.sin(a));
      const d = E.pinOutward(q.angle, p.rot, mir);
      return { i, num: q.number, name: q.name, et: q.etype, id: pinId(p.type, q), x: p.x + Math.round(o[0] / G), y: p.y + Math.round(o[1] / G),
        S: [ox + o[0], oy + o[1]], E: [ox + e[0], oy + e[1]], dir: [d[0] + 0, d[1] + 0], hidden: q.hidden };
    });
    const b = info.body, body = bbNew();
    for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) { const o = ap(M, x, y); grow(body, ox + o[0], oy + o[1]); }
    const bb = body.slice();
    for (const q of pins) if (!q.hidden) { grow(bb, ...q.S); grow(bb, ...q.E); }
    const texts = [], hit = bb.slice();
    // reference / value fields: the symbol's own positions when unrotated, otherwise kept horizontal beside the body
    const cx = (body[0] + body[2]) / 2, cy = (body[1] + body[3]) / 2;
    const plain = !p.rot && !p.mirror;
    const axisV = pins.length === 2 && TWO_PIN.has(p.type) ? pins[0].x === pins[1].x : null;
    const fl = [['ref', (S(p.ref) || '?') + (p.dnp ? ' DNP' : '')], ['val', S(p.value)]].filter(([k, str]) => str && info.fields[k] && !info.fields[k].hide);
    const side = {};          // rotated / mirrored multi-pin symbols: each field goes outside the symbol on the side it falls on
    if (!plain && axisV === null) for (const [k] of fl) {
      const f = info.fields[k], o = ap(M, f.x, f.y), dx = ox + o[0] - cx, dy = oy + o[1] - cy;
      side[k] = Math.abs(dx) > Math.abs(dy) + 0.01 ? (dx > 0 ? 'r' : 'l') : dy > 0 ? 'b' : 't';
    }
    for (const [k, str] of fl) {
      const f = info.fields[k];
      let x, y, h, ang = 0;
      if (plain) { x = ox + f.x; y = oy - f.y; h = f.h; ang = ((Math.round(f.a) % 180) + 180) % 180; }
      else if (axisV === true) { x = body[2] + 1.27; y = cy + (k === 'ref' ? -1.27 : 1.27); h = 'left'; }
      else if (axisV === false) { x = cx; y = k === 'ref' ? body[1] - 1.4 : body[3] + 1.4; h = 'center'; }
      else {
        const sd = side[k], mates = fl.filter(([j]) => side[j] === sd).map(([j]) => j), n = mates.length, i = mates.indexOf(k);
        if (sd === 'r' || sd === 'l') { x = sd === 'r' ? bb[2] + 0.8 : bb[0] - 0.8; h = sd === 'r' ? 'left' : 'right'; y = cy + (i - (n - 1) / 2) * 1.9; }
        else { x = cx; h = 'center'; y = sd === 't' ? bb[1] - 1.2 - (n - 1 - i) * 1.9 : bb[3] + 1.2 + i * 1.9; }
      }
      const w = textW(str, 1.27, k === 'ref' ? 600 : 400), tb = textBox(x, y, w, 1.27, h, ang);
      texts.push({ str, x, y, size: 1.27, ang, h, v: 'middle', kind: k, bb: tb });
      growBB(hit, tb);
    }
    // pin numbers and names (same placement rules as the schematic viewer)
    for (const q of pins) {
      if (q.hidden) continue;
      const [sx, sy] = q.S, [ex, ey] = q.E, dx = ex - sx, dy = ey - sy, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      const vertical = Math.abs(uy) > 0.5;
      if (!info.hideNums && q.num && !info.isPower) {
        const mx = (sx + ex) / 2, my = (sy + ey) / 2, off = 1.27 * 0.3 + 0.15;
        texts.push(vertical ? { str: q.num, x: mx - off, y: my, size: 1.27, ang: 90, h: 'center', v: 'bottom', kind: 'pinnum' }
          : { str: q.num, x: mx, y: my - off, size: 1.27, ang: 0, h: 'center', v: 'bottom', kind: 'pinnum' });
      }
      if (!info.hideNames && q.name && q.name !== '~' && !info.isPower) {
        if (info.po > 0) {
          const nx = ex + ux * info.po, ny = ey + uy * info.po;
          texts.push(vertical ? { str: q.name, x: nx, y: ny, size: 1.27, ang: 90, h: uy < 0 ? 'left' : 'right', v: 'middle', kind: 'pinname' }
            : { str: q.name, x: nx, y: ny, size: 1.27, ang: 0, h: ux > 0 ? 'left' : 'right', v: 'middle', kind: 'pinname' });
        } else {
          const mx = (sx + ex) / 2, my = (sy + ey) / 2;
          texts.push(vertical ? { str: q.name, x: mx - 0.35, y: my, size: 1.27, ang: 90, h: 'center', v: 'bottom', kind: 'pinname' }
            : { str: q.name, x: mx, y: my - 0.35, size: 1.27, ang: 0, h: 'center', v: 'bottom', kind: 'pinname' });
        }
      }
    }
    return { p, info, M, ox, oy, pins, body, bb, hit, texts };
  }

  function powerGeo(w) {
    const style = w.style || E1().powerStyle(S(w.name));
    const info = symInfo('pwr:' + style, () => E1().powerSymbolNode('PWR', style));
    const M = mat(w.rot, false), ox = w.x * G, oy = w.y * G;
    const b = info.body, body = bbNew();
    for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) { const o = ap(M, x, y); grow(body, ox + o[0], oy + o[1]); }
    grow(body, ox, oy);
    const f = info.fields.val, o = ap(M, f.x, f.y), tx = ox + o[0], ty = oy + o[1];
    const cx = (body[0] + body[2]) / 2, cy = (body[1] + body[3]) / 2, dx = tx - cx, dy = ty - cy;
    const h = Math.abs(dx) > Math.abs(dy) + 0.01 ? (dx > 0 ? 'left' : 'right') : 'center';
    const str = S(w.name) || '?', tb = textBox(tx, ty, textW(str, 1.27, 500), 1.27, h, 0);
    const hit = body.slice(); growBB(hit, tb);
    return { w, info, M, ox, oy, body, hit, text: { str, x: tx, y: ty, size: 1.27, ang: 0, h, v: 'middle' } };
  }

  // net label: plain (text on the wire) or a pointed port shape (KiCad global label), same geometry as the viewer
  function labelGeo(l) {
    const size = 1.27, x = l.x * G, y = l.y * G, txt = S(l.name) || '?';
    const W = textW(txt, size, 500), ar = mod360(l.rot);
    const D = [Math.round(Math.cos(ar * Math.PI / 180)), -Math.round(Math.sin(ar * Math.PI / 180))];
    const lab = { l, txt, x, y, size, D, W };
    const hh = size * 0.72;
    if (l.port) {
      const Lw = W + size * 1.6, tip = size * 0.6;
      const leftPoint = l.port === 'input' || l.port === 'bidirectional', rightPoint = l.port === 'output' || l.port === 'bidirectional';
      const loc = [leftPoint ? [0, 0] : [0, -hh], [leftPoint ? tip : 0, -hh], [rightPoint ? Lw - tip : Lw, -hh], rightPoint ? [Lw, 0] : [Lw, -hh]];
      if (!rightPoint) loc.push([Lw, hh]);
      loc.push([rightPoint ? Lw - tip : Lw, hh], [leftPoint ? tip : 0, hh]);
      if (!leftPoint) loc.push([0, hh]);
      lab.poly = loc.map(([u, v]) => [x + D[0] * u - D[1] * v, y + D[1] * u + D[0] * v]);
      lab.tx = x + D[0] * Lw / 2; lab.ty = y + D[1] * Lw / 2; lab.ang = D[0] === 0 ? 90 : 0; lab.h = 'center'; lab.v = 'middle';
      lab.bb = bbNew(); lab.poly.forEach(q => grow(lab.bb, ...q));
    } else {
      const off = size * 0.25;
      if (ar === 0) { lab.tx = x; lab.ty = y - off; lab.ang = 0; lab.h = 'left'; }
      else if (ar === 180) { lab.tx = x; lab.ty = y - off; lab.ang = 0; lab.h = 'right'; }
      else if (ar === 90) { lab.tx = x - off; lab.ty = y; lab.ang = 90; lab.h = 'left'; }
      else { lab.tx = x - off; lab.ty = y; lab.ang = 90; lab.h = 'right'; }
      lab.v = 'bottom';
      if (!lab.ang) { const ex = lab.h === 'left' ? x + W : x - W; lab.bb = [Math.min(x, ex) - 0.3, y - size * 1.5, Math.max(x, ex) + 0.3, y + 0.4]; }
      else { const ey = lab.h === 'left' ? y - W : y + W; lab.bb = [x - size * 1.5, Math.min(y, ey) - 0.3, x + 0.4, Math.max(y, ey) + 0.3]; }
    }
    lab.hit = lab.bb;
    return lab;
  }

  function buildGeo(doc) {
    const g = { parts: new Map(), power: new Map(), labels: new Map(), pts: new Map(), H: new Map(), V: new Map() };
    const at = (x, y) => { const k = K(x, y); let e = g.pts.get(k); if (!e) g.pts.set(k, (e = { k, x, y, pins: [], power: [], labels: [], ends: [], nc: [] })); return e; };
    for (const p of doc.parts) { const pg = partGeo(p); g.parts.set(p.id, pg); pg.pins.forEach((q, i) => at(q.x, q.y).pins.push([p.id, i])); }
    for (const w of doc.power) { g.power.set(w.id, powerGeo(w)); at(w.x, w.y).power.push(w.id); }
    for (const l of doc.labels) { g.labels.set(l.id, labelGeo(l)); at(l.x, l.y).labels.push(l.id); }
    doc.wires.forEach((w, i) => {
      at(w[0], w[1]).ends.push(i); at(w[2], w[3]).ends.push(i);
      if (w[1] === w[3] && w[0] !== w[2]) push(g.H, w[1], i);
      else if (w[0] === w[2] && w[1] !== w[3]) push(g.V, w[0], i);
    });
    doc.nc.forEach((n, i) => at(n[0], n[1]).nc.push(i));
    return g;
  }
  // index of a wire whose interior (not an end) contains grid point x,y, or -1
  function wireThrough(doc, g, x, y) {
    for (const i of g.H.get(y) || []) { const w = doc.wires[i]; if (x > Math.min(w[0], w[2]) && x < Math.max(w[0], w[2])) return i; }
    for (const i of g.V.get(x) || []) { const w = doc.wires[i]; if (y > Math.min(w[1], w[3]) && y < Math.max(w[1], w[3])) return i; }
    return -1;
  }

  // ------------------------------------------------------------------ wire clean-up: merge collinear runs, split at every connection point
  function normalizeWires(doc, g) {
    const sig = new Map();
    const at = (x, y) => { const k = K(x, y); let e = sig.get(k); if (!e) sig.set(k, (e = { x, y, a: 0, h: 0, v: 0, d: 0 })); return e; };
    for (const pg of g.parts.values()) for (const q of pg.pins) at(q.x, q.y).a++;
    for (const w of doc.power) at(w.x, w.y).a++;
    for (const l of doc.labels) at(l.x, l.y).a++;
    const H = new Map(), V = new Map(), D = [];
    for (const w of doc.wires) {
      const [x1, y1, x2, y2] = w;
      if (x1 === x2 && y1 === y2) continue;
      if (y1 === y2) { push(H, y1, [Math.min(x1, x2), Math.max(x1, x2)]); at(x1, y1).h++; at(x2, y2).h++; }
      else if (x1 === x2) { push(V, x1, [Math.min(y1, y2), Math.max(y1, y2)]); at(x1, y1).v++; at(x2, y2).v++; }
      else { D.push(w.slice()); at(x1, y1).d++; at(x2, y2).d++; }
    }
    const byY = new Map(), byX = new Map();
    for (const e of sig.values()) { push(byY, e.y, e); push(byX, e.x, e); }
    const out = [];
    const run = (lines, horiz) => {
      for (const [c, ivs] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
        ivs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const merged = [];
        for (const iv of ivs) { const m = merged[merged.length - 1]; if (m && iv[0] <= m[1]) m[1] = Math.max(m[1], iv[1]); else merged.push(iv.slice()); }
        const cand = (horiz ? byY : byX).get(c) || [];
        for (const [a, b] of merged) {
          const cuts = new Set();
          for (const e of cand) { const t = horiz ? e.x : e.y; if (t > a && t < b && ((horiz ? e.v : e.h) || e.d || (e.a && (horiz ? e.h : e.v)))) cuts.add(t); }
          let s = a;
          for (const t of [...cuts].sort((p, q) => p - q)) { out.push(horiz ? [s, c, t, c] : [c, s, c, t]); s = t; }
          out.push(horiz ? [s, c, b, c] : [c, s, c, b]);
        }
      }
    };
    run(H, true); run(V, false);
    return out.concat(D);
  }

  // ------------------------------------------------------------------ connectivity
  function connectivity(doc, g) {
    const par = new Map();
    const find = a => { if (!par.has(a)) { par.set(a, a); return a; } let r = a; while (par.get(r) !== r) r = par.get(r); while (par.get(a) !== r) { const n = par.get(a); par.set(a, r); a = n; } return r; };
    const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) par.set(x, y); };
    doc.wires.forEach(w => union(K(w[0], w[1]), K(w[2], w[3])));
    for (const e of g.pts.values()) {                       // T-junctions (a wire end on the middle of a wire) in drawings that were not normalised
      find(e.k);
      if (!e.ends.length) continue;
      const i = wireThrough(doc, g, e.x, e.y);
      if (i >= 0) union(e.k, K(doc.wires[i][0], doc.wires[i][1]));
    }
    for (const w of doc.power) if (w.name) union(K(w.x, w.y), 'N\u0000' + w.name);
    for (const l of doc.labels) if (l.name) union(K(l.x, l.y), 'N\u0000' + l.name);
    const nets = new Map();
    const get = r => { let n = nets.get(r); if (!n) nets.set(r, (n = { root: r, pts: [], pins: [], power: [], labels: [], wires: [] })); return n; };
    for (const e of g.pts.values()) {
      const n = get(find(e.k));
      n.pts.push(e.k);
      for (const pp of e.pins) n.pins.push(pp);
      for (const id of e.power) n.power.push(id);
      for (const id of e.labels) n.labels.push(id);
    }
    doc.wires.forEach((w, i) => get(find(K(w[0], w[1]))).wires.push(i));
    const pwById = new Map(doc.power.map(w => [w.id, w])), lbById = new Map(doc.labels.map(l => [l.id, l]));
    for (const n of nets.values()) {
      const pw = n.power.map(id => pwById.get(id)), lb = n.labels.map(id => lbById.get(id));
      const pn = [...new Set(pw.map(w => S(w.name)).filter(Boolean))].sort(), ln = [...new Set(lb.map(l => S(l.name)).filter(Boolean))].sort();
      n.names = [...new Set(pn.concat(ln))];
      n.port = 'none';
      if (pn.length) { n.name = pn[0]; n.kind = DS().isGroundName(n.name) ? 'ground' : 'power'; const w = pw.find(x => x.port); if (w) n.port = w.port; }
      else if (ln.length) { n.name = ln[0]; n.kind = 'signal'; const l = lb.find(x => x.port); if (l) n.port = l.port; }
      else { n.name = ''; n.kind = 'signal'; }
    }
    const list = [...nets.values()];
    return { nets: list, netOf: k => nets.get(find(k)) || null, byName: name => list.filter(n => n.names.includes(name)) };
  }
  const pinConnected = n => !!n && (n.pins.length > 1 || n.names.length > 0);

  // ------------------------------------------------------------------ document model
  const PORT_OK = new Set(['input', 'output', 'bidirectional', 'passive']);
  function emptyDoc(title) { return { v: 1, title: S(title), parts: [], power: [], labels: [], wires: [], nc: [] }; }
  function normDoc(d) {
    d = d && typeof d === 'object' ? d : {};
    const arr = a => (Array.isArray(a) ? a : []);
    const int = v => Math.round(+v || 0);
    const out = emptyDoc(d.title);
    const ids = new Set(), nid = id => { let x = S(id); while (!x || ids.has(x)) x = uid(); ids.add(x); return x; };
    const types = (DS() && DS().COMPONENT_TYPES) || Object.keys(TYPES);
    for (const p of arr(d.parts)) {
      if (!p || typeof p !== 'object') continue;
      const type = types.includes(p.type) && TYPES[p.type] ? p.type : 'other';
      const q = { id: nid(p.id), ref: S(p.ref).trim(), type, value: S(p.value), package: S(p.package), mpn: S(p.mpn), rating: S(p.rating), tolerance: S(p.tolerance),
        dnp: !!p.dnp, x: int(p.x), y: int(p.y), rot: mod360(p.rot), mirror: !!p.mirror };
      if (QTYPES[type]) q.sym = qSym({ type, sym: p.sym, package: q.package });
      if (type === 'connector') { q.n = connN(p); if (connTable(p)) q.pins = icPins(p); }
      if (IC_LIKE.has(type)) q.pins = icPins(p);
      if (p.tpl && TEMPLATES[p.tpl]) q.tpl = S(p.tpl);
      out.parts.push(q);
    }
    for (const w of arr(d.power)) {
      if (!w || typeof w !== 'object') continue;
      const name = S(w.name).trim() || 'GND';
      const q = { id: nid(w.id), name, x: int(w.x), y: int(w.y), rot: mod360(w.rot), style: ['up', 'gnd', 'down'].includes(w.style) ? w.style : E1().powerStyle(name) };
      if (PORT_OK.has(w.port)) q.port = w.port;
      out.power.push(q);
    }
    for (const l of arr(d.labels)) {
      if (!l || typeof l !== 'object') continue;
      out.labels.push({ id: nid(l.id), name: S(l.name).trim() || 'NET', x: int(l.x), y: int(l.y), rot: mod360(l.rot), port: PORT_OK.has(l.port) ? l.port : '' });
    }
    for (const w of arr(d.wires)) if (Array.isArray(w) && w.length >= 4) out.wires.push([int(w[0]), int(w[1]), int(w[2]), int(w[3])]);
    const seen = new Set();
    for (const n of arr(d.nc)) if (Array.isArray(n) && n.length >= 2 && !seen.has(K(int(n[0]), int(n[1])))) { seen.add(K(int(n[0]), int(n[1]))); out.nc.push([int(n[0]), int(n[1])]); }
    return out;
  }
  // compact JSON for storage: optional fields only when set
  function compactDoc(doc) {
    const o = { v: 1, title: doc.title || '', parts: [], power: [], labels: [], wires: doc.wires.map(w => w.slice()), nc: doc.nc.map(n => n.slice()) };
    for (const p of doc.parts) {
      const q = { id: p.id, ref: p.ref, type: p.type, value: p.value };
      for (const k of ['package', 'mpn', 'rating', 'tolerance']) if (p[k]) q[k] = p[k];
      if (p.dnp) q.dnp = true;
      q.x = p.x; q.y = p.y; q.rot = p.rot;
      if (p.mirror) q.mirror = true;
      if (p.sym) q.sym = p.sym;
      if (p.pins) q.pins = p.pins.map(x => Object.assign({}, x));
      if (p.type === 'connector') q.n = p.n;
      if (p.tpl) q.tpl = p.tpl;
      o.parts.push(q);
    }
    for (const w of doc.power) { const q = { id: w.id, name: w.name, x: w.x, y: w.y, rot: w.rot, style: w.style }; if (w.port) q.port = w.port; o.power.push(q); }
    for (const l of doc.labels) { const q = { id: l.id, name: l.name, x: l.x, y: l.y, rot: l.rot }; if (l.port) q.port = l.port; o.labels.push(q); }
    return o;
  }

  // ------------------------------------------------------------------ drawing → DS2K circuit dict
  function pinTable(p) {
    if (IC_LIKE.has(p.type)) return icPins(p);
    if (p.type === 'connector') return connTable(p) ? icPins(p) : Array.from({ length: connN(p) }, (_, i) => ({ number: String(i + 1), name: '', etype: 'passive', side: '' }));
    return null;
  }
  function circuitOf(doc, g, cn, opts) {
    opts = opts || {};
    const components = doc.parts.map(p => {
      const c = { ref: p.ref, type: p.type, value: p.value, package: p.package, mpn: p.mpn, rating: p.rating, tolerance: p.tolerance, dnp: !!p.dnp };
      const t = pinTable(p);
      if (t) c.pins = t;
      if (QTYPES[p.type]) c.kicad_symbol = 'Device:' + qSym(p);
      return c;
    });
    const pById = id => g.parts.get(id);
    const nets = [];
    for (const n of cn.nets) {
      const nodes = [], seen = new Set();
      for (const [pid, i] of n.pins) {
        const pg = pById(pid), q = pg && pg.pins[i];
        if (!q || !pg.p.ref) continue;
        const key = pg.p.ref + '\u0000' + q.id;
        if (!seen.has(key)) { seen.add(key); nodes.push({ ref: pg.p.ref, pin: q.id }); }
      }
      if (!nodes.length || (!n.name && nodes.length < 2)) continue;
      nets.push({ name: n.name, kind: n.kind, port: n.port || 'none', nodes });
    }
    nets.sort((a, b) => (!a.name) - (!b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!opts.blankUnnamed) {          // DS2K treats N<k> as unnamed; DS2K_SIM needs distinct names
      const used = new Set(nets.map(n => n.name));
      let k = 1;
      for (const n of nets) if (!n.name) { while (used.has('N' + k)) k++; n.name = 'N' + k; used.add(n.name); }
    }
    const no_connects = [];
    for (const [x, y] of doc.nc) {
      const e = g.pts.get(K(x, y));
      for (const [pid, i] of e ? e.pins : []) { const pg = pById(pid); no_connects.push({ ref: pg.p.ref, pin: pg.pins[i].id }); }
    }
    return { design: { title: doc.title || '' }, components, nets, no_connects };
  }

  // ------------------------------------------------------------------ design checks
  function runCheck(doc, g, cn) {
    const out = [], add = (level, text, refs, at) => out.push({ level, text, refs: refs || [], at: at || null });
    const byRef = new Map();
    for (const p of doc.parts) { if (!p.ref) add('error', 'A ' + (TYPES[p.type] || TYPES.other).name.toLowerCase() + ' has no reference', [], [p.x, p.y]); else push(byRef, p.ref, p); }
    for (const [ref, ps] of byRef) if (ps.length > 1) add('error', `Duplicate reference ${ref} (${ps.length} parts)`, [ref], [ps[1].x, ps[1].y]);
    const ncAt = new Set(doc.nc.map(n => K(n[0], n[1])));
    for (const p of doc.parts) {
      const pg = g.parts.get(p.id), ref = p.ref || '?';
      const pinName = q => (q.id !== q.num ? q.id : q.num) + (q.name && q.name !== '~' && q.name !== q.id && q.name !== q.num ? ' (' + q.name + ')' : '');
      const conNets = [];
      for (const q of pg.pins) {
        const k = K(q.x, q.y), n = cn.netOf(k), ok = pinConnected(n);
        if (ncAt.has(k)) { if (ok) add('warn', `${ref}: pin ${pinName(q)} is marked no-connect but is connected`, [ref], [q.x, q.y]); continue; }
        if (ok) { conNets.push(n); continue; }
        if (!g.pts.get(k).ends.length && wireThrough(doc, g, q.x, q.y) >= 0) { add('warn', `${ref}: pin ${pinName(q)} lies on a wire but is not connected (wires only connect at their ends)`, [ref], [q.x, q.y]); continue; }
        if (TWO_PIN.has(p.type)) add('error', `${ref}: pin ${pinName(q)} is not connected`, [ref], [q.x, q.y]);
        else if (IC_LIKE.has(p.type) || p.type === 'connector') add('warn', `${ref}: pin ${pinName(q)} is neither connected nor marked no-connect`, [ref], [q.x, q.y]);
        else add('warn', `${ref}: pin ${pinName(q)} is not connected`, [ref], [q.x, q.y]);
      }
      if (TWO_PIN.has(p.type) && pg.pins.length === 2 && conNets.length === 2 && conNets[0] === conNets[1])
        add('warn', `${ref} is shorted: both pins are on ${conNets[0].name ? 'net ' + conNets[0].name : 'the same net'}`, [ref], [p.x, p.y]);
      if (NEEDS_VALUE.has(p.type) && !S(p.value).trim()) add('warn', `${ref} has no value`, [ref], [p.x, p.y]);
    }
    const touches = e => !!e && (e.ends.length > 0 || e.pins.length > 0 || e.power.length + e.labels.length > 1);
    for (const e of g.pts.values()) {
      if (e.ends.length !== 1 || e.pins.length || e.labels.length || e.power.length || e.nc.length) continue;
      if (wireThrough(doc, g, e.x, e.y) >= 0) continue;
      add('warn', 'Dangling wire end', [], [e.x, e.y]);
    }
    for (const l of doc.labels) if (!touches(g.pts.get(K(l.x, l.y)))) add('warn', `Label ${l.name} is not attached to a wire or pin`, [], [l.x, l.y]);
    for (const w of doc.power) if (!touches(g.pts.get(K(w.x, w.y)))) add('warn', `Power port ${w.name} is not attached to a wire or pin`, [], [w.x, w.y]);
    for (const n of cn.nets) {
      const refs = [...new Set(n.pins.map(([pid]) => g.parts.get(pid).p.ref))];
      const at = n.pts.length ? unK(n.pts[0]) : null;
      if (n.names.length > 1) add('error', `Nets ${n.names.join(' and ')} are shorted together`, refs.slice(0, 8), at);
      if (n.names.length && n.pins.length === 1 && n.port === 'none' && n.kind === 'signal') {
        const [pid, i] = n.pins[0], pg = g.parts.get(pid);
        add('warn', `Net ${n.name} only connects to ${pg.p.ref}.${pg.pins[i].id}`, [pg.p.ref], [pg.pins[i].x, pg.pins[i].y]);
      }
    }
    for (const [x, y] of doc.nc) { const e = g.pts.get(K(x, y)); if (!e || !e.pins.length) add('warn', 'No-connect marker is not on a pin', [], [x, y]); }
    out.sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1));
    return out;
  }

  // ------------------------------------------------------------------ circuit → drawing (auto layout: parts grouped by IC, every pin gets a stub + label or a power port)
  function compPart(comp, id) {
    const type = TYPES[comp.type] ? comp.type : 'other';
    const p = { id, ref: S(comp.ref), type, value: S(comp.value), package: S(comp.package), mpn: S(comp.mpn), rating: S(comp.rating), tolerance: S(comp.tolerance),
      dnp: !!comp.dnp, x: 0, y: 0, rot: 0, mirror: false };
    if (QTYPES[type]) { const m = /_([A-Z]{3})$/.exec(S(comp.kicad_symbol)); p.sym = qSym({ type, sym: m ? 'Q_' + QTYPES[type] + '_' + m[1] : '', package: p.package }); }
    const pins = icPins(comp);
    if (type === 'connector') { p.n = connN({ pins }); if (connTable({ pins })) p.pins = pins; }
    else if (IC_LIKE.has(type)) p.pins = pins;
    return p;
  }
  function blockBox(b) {
    const g = buildGeo({ parts: [b.part], power: b.power, labels: b.labels, wires: b.wires, nc: b.nc });
    const bb = bbNew();
    for (const pg of g.parts.values()) growBB(bb, pg.hit);
    for (const pw of g.power.values()) growBB(bb, pw.hit);
    for (const lg of g.labels.values()) growBB(bb, lg.hit);
    for (const w of b.wires) { grow(bb, w[0] * G, w[1] * G); grow(bb, w[2] * G, w[3] * G); }
    return bb.map(v => v / G);
  }
  function moveBlock(b, dx, dy) {
    b.part.x += dx; b.part.y += dy;
    for (const w of b.power) { w.x += dx; w.y += dy; }
    for (const l of b.labels) { l.x += dx; l.y += dy; }
    for (const w of b.wires) { w[0] += dx; w[1] += dy; w[2] += dx; w[3] += dy; }
    for (const n of b.nc) { n[0] += dx; n[1] += dy; }
    b.bb = [b.bb[0] + dx, b.bb[1] + dy, b.bb[2] + dx, b.bb[3] + dy];
  }
  // shelf packing of blocks starting at x0,y0; returns the packed bbox
  function packBlocks(items, x0, y0, maxW, gap) {
    let x = x0, y = y0, rowH = 0;
    const bb = bbNew();
    for (const b of items) {
      const w = b.bb[2] - b.bb[0], h = b.bb[3] - b.bb[1];
      if (x > x0 && x + w > x0 + maxW) { x = x0; y += rowH + gap; rowH = 0; }
      moveBlock(b, Math.ceil(x - b.bb[0]), Math.ceil(y - b.bb[1]));
      growBB(bb, b.bb);
      x = b.bb[2] + gap; rowH = Math.max(rowH, h);
    }
    return bb;
  }
  function fromCircuit(circuit) {
    const E = E1(), c = new (DS().Circuit)(clone(circuit || {}));
    c.normalize();
    const d = c.toDict();
    const used = new Set(d.nets.map(n => n.name));
    let auto = 1;
    for (const n of d.nets) if (!n.name || /^N\$\d+$/.test(n.name)) { let nm; do nm = 'N' + auto++; while (used.has(nm)); used.add(nm); n.name = nm; }
    const netOf = new Map();
    for (const n of d.nets) for (const nd of n.nodes) netOf.set(nd.ref + '\u0000' + nd.pin, n);
    const ncSet = new Set(d.no_connects.map(x => x.ref + '\u0000' + x.pin));
    const isPwr = n => !!n && (n.kind === 'power' || n.kind === 'ground');
    const styleOf = n => (n.kind === 'ground' ? 'gnd' : E.powerStyle(n.name));
    const cls = n => (!isPwr(n) ? 'sig' : styleOf(n) === 'up' ? 'up' : 'dn');
    const ids = new Set(), nid = () => { let x; do x = uid(); while (ids.has(x)); ids.add(x); return x; };
    const doc = emptyDoc(d.design.title || (d.part && d.part.mpn ? d.part.mpn + ' reference design' : ''));
    const blocks = d.components.map(comp => {
      const part = compPart(comp, nid());
      let geo = partGeo(part);
      const net = q => netOf.get(part.ref + '\u0000' + q.id);
      if (TWO_PIN.has(part.type) && geo.pins.length === 2) {
        const ca = cls(net(geo.pins[0])), cb = cls(net(geo.pins[1]));
        let want;
        if (ca !== 'sig' || cb !== 'sig') want = [(ca === 'up' || cb === 'dn') ? 0 : (cb === 'up' || ca === 'dn') ? 1 : 0, [0, -1]];
        else want = [0, [-1, 0]];
        for (const r of [0, 90, 180, 270]) {
          part.rot = r;
          const g2 = partGeo(part), q = g2.pins[want[0]];
          if (q.dir[0] === want[1][0] && q.dir[1] === want[1][1]) { geo = g2; break; }
        }
      }
      const b = { part, wires: [], labels: [], power: [], nc: [], nets: new Set() };
      for (const q of geo.pins) {
        const n = net(q);
        if (!n) { if (ncSet.has(part.ref + '\u0000' + q.id)) b.nc.push([q.x, q.y]); continue; }
        b.nets.add(n);
        const port = n.port && n.port !== 'none' ? n.port : '';
        if (isPwr(n)) {
          const style = styleOf(n), w = { id: nid(), name: n.name, x: q.x, y: q.y, rot: powerRot(style, q.dir), style };
          if (port) w.port = port;
          b.power.push(w);
        } else {
          const ex = q.x + q.dir[0] * 2, ey = q.y + q.dir[1] * 2;
          b.wires.push([q.x, q.y, ex, ey]);
          b.labels.push({ id: nid(), name: n.name, x: ex, y: ey, rot: labelRot(q.dir), port });
        }
      }
      b.bb = blockBox(b);
      return b;
    });
    // group small parts with the IC / connector they connect to (breadth-first over signal nets, then supply nets)
    const isHub = b => IC_LIKE.has(b.part.type) || b.part.type === 'connector';
    const pinCount = b => partGeo(b.part).pins.length;
    const hubs = blocks.filter(isHub).sort((a, b) => pinCount(b) - pinCount(a) || refCmp(a.part.ref, b.part.ref));
    const members = new Map();
    for (const b of blocks) for (const n of b.nets) push(members, n, b);
    const owner = new Map(), order = new Map();
    let seq = 0, frontier = hubs.map(h => [h, h]);
    while (frontier.length) {
      const next = [];
      for (const [b, hub] of frontier) for (const n of b.nets) {
        if (isPwr(n)) continue;
        for (const m of members.get(n)) if (!isHub(m) && !owner.has(m)) { owner.set(m, hub); order.set(m, seq++); next.push([m, hub]); }
      }
      frontier = next;
    }
    for (const b of blocks) if (!isHub(b) && !owner.has(b)) for (const n of b.nets) {
      if (!isPwr(n) || n.kind === 'ground') continue;
      const hub = hubs.find(h => h.nets.has(n)) || owner.get(blocks.find(m => m !== b && owner.has(m) && m.nets.has(n)));
      if (hub) { owner.set(b, hub); order.set(b, seq++); break; }
    }
    const groups = hubs.map(h => ({ hub: h, items: [] })), misc = { hub: null, items: [] };
    for (const b of blocks) if (!isHub(b)) { const h = owner.get(b); (h ? groups.find(x => x.hub === h) : misc).items.push(b); }
    const TYPE_ORDER = Object.keys(TYPES);
    for (const gr of groups) gr.items.sort((a, b) => order.get(a) - order.get(b));
    misc.items.sort((a, b) => TYPE_ORDER.indexOf(a.part.type) - TYPE_ORDER.indexOf(b.part.type) || refCmp(a.part.ref, b.part.ref));
    if (misc.items.length) groups.push(misc);
    const GAP = 3;
    const area = items => items.reduce((s, b) => s + (b.bb[2] - b.bb[0] + GAP) * (b.bb[3] - b.bb[1] + GAP), 0);
    const gblocks = groups.map(gr => {
      let bb = bbNew();
      let x0 = 0, y0 = 0;
      if (gr.hub) { moveBlock(gr.hub, -Math.round(gr.hub.bb[0]), -Math.round(gr.hub.bb[1])); growBB(bb, gr.hub.bb); x0 = Math.ceil(gr.hub.bb[2]) + GAP * 2; y0 = Math.floor(gr.hub.bb[1]); }
      if (gr.items.length) {
        const widest = Math.max(...gr.items.map(b => b.bb[2] - b.bb[0]));
        const hubH = gr.hub ? gr.hub.bb[3] - gr.hub.bb[1] : 0;
        const maxW = Math.max(widest, Math.sqrt(area(gr.items) * 1.6), hubH ? area(gr.items) / Math.max(hubH, 1) * 0.6 : 0);
        growBB(bb, packBlocks(gr.items, x0, y0, Math.min(maxW, 220), GAP));
      }
      const all = (gr.hub ? [gr.hub] : []).concat(gr.items);
      return { all, bb };
    });
    // pack the groups themselves
    const totalA = gblocks.reduce((s, x) => s + (x.bb[2] - x.bb[0] + 8) * (x.bb[3] - x.bb[1] + 8), 0);
    const rowW = Math.max(...gblocks.map(x => x.bb[2] - x.bb[0]), Math.sqrt(totalA * 1.7), 0);
    let x = 0, y = 0, rowH = 0;
    for (const gb of gblocks) {
      const w = gb.bb[2] - gb.bb[0], h = gb.bb[3] - gb.bb[1];
      if (x > 0 && x + w > rowW) { x = 0; y += rowH + 8; rowH = 0; }
      const dx = Math.ceil(x - gb.bb[0]), dy = Math.ceil(y - gb.bb[1]);
      for (const b of gb.all) moveBlock(b, dx, dy);
      x += w + 8 + 1; rowH = Math.max(rowH, h);
    }
    for (const b of blocks) {
      doc.parts.push(b.part);
      doc.power.push(...b.power); doc.labels.push(...b.labels); doc.wires.push(...b.wires); doc.nc.push(...b.nc);
    }
    const out = normDoc(doc);
    out.wires = normalizeWires(out, buildGeo(out));
    return out;
  }

  // ------------------------------------------------------------------ moving things while keeping connections
  const emptySel = () => ({ parts: new Set(), power: new Set(), labels: new Set(), wires: new Set(), nc: new Set() });
  const cloneSel = s => ({ parts: new Set(s.parts), power: new Set(s.power), labels: new Set(s.labels), wires: new Set(s.wires), nc: new Set(s.nc) });
  // decorations that belong to the pin at point k: labels / power ports / no-connects on it, and stubs that lead only to a label or power port
  function followersAt(doc, g, k, out) {
    const e = g.pts.get(k);
    if (!e) return out;
    e.labels.forEach(id => out.labels.add(id)); e.power.forEach(id => out.power.add(id)); e.nc.forEach(i => out.nc.add(i));
    for (const i of e.ends) {
      const w = doc.wires[i], a = K(w[0], w[1]), b = K(w[2], w[3]), far = a === k ? b : a;
      if (far === k) continue;
      const f = g.pts.get(far);
      if (f && f.ends.length === 1 && !f.pins.length && !f.nc.length && wireThrough(doc, g, f.x, f.y) < 0) {
        out.wires.add(i); f.labels.forEach(id => out.labels.add(id)); f.power.forEach(id => out.power.add(id));
      }
    }
    return out;
  }
  function lpath(a, b, hFirst) {
    if (a[0] === b[0] || a[1] === b[1]) return [[a[0], a[1], b[0], b[1]]];
    const c = hFirst ? [b[0], a[1]] : [a[0], b[1]];
    return [[a[0], a[1], c[0], c[1]], [c[0], c[1], b[0], b[1]]];
  }
  const chain = pts => pts.slice(1).map((q, i) => [pts[i][0], pts[i][1], q[0], q[1]]);
  // M: old point key -> new [x,y] for everything that moves; movedW: wire index -> new coords for wires moved rigidly
  function rubberBand(base, g, M, movedW, mv) {
    const plan = [], override = new Map(), claimed = new Set();
    const occ = new Set();
    for (const e of g.pts.values()) if ((e.pins.length || e.labels.length || e.power.length) && !M.has(e.k)) occ.add(e.k);
    for (const v of M.values()) occ.add(K(v[0], v[1]));
    const clear = segs => segs.every(s => {
      if (s[1] === s[3]) { for (let x = Math.min(s[0], s[2]) + 1; x < Math.max(s[0], s[2]); x++) if (occ.has(K(x, s[1]))) return false; }
      else if (s[0] === s[2]) { for (let y = Math.min(s[1], s[3]) + 1; y < Math.max(s[1], s[3]); y++) if (occ.has(K(s[0], y))) return false; }
      return true;
    });
    const dogleg = (fix, mov, horiz) => {
      const a = horiz ? fix[0] : fix[1], b = horiz ? mov[0] : mov[1], mid = Math.round((a + b) / 2);
      const cands = [mid];
      for (let d = 1; d <= Math.abs(b - a) + 3; d++) cands.push(mid + d, mid - d);
      let first = null;
      for (const m of cands) {
        const segs = horiz ? chain([fix, [m, fix[1]], [m, mov[1]], mov]) : chain([fix, [fix[0], m], [mov[0], m], mov]);
        if (!first) first = segs;
        if (clear(segs)) return segs;
      }
      return first;
    };
    base.wires.forEach((w, i) => {
      if (movedW.has(i)) { plan[i] = [movedW.get(i)]; return; }
      const A = [w[0], w[1]], B = [w[2], w[3]], ma = M.get(K(...A)), mb = M.get(K(...B));
      if (!ma && !mb) { plan[i] = null; return; }
      const horiz = w[1] === w[3] && w[0] !== w[2], vert = w[0] === w[2] && w[1] !== w[3];
      if (ma && mb) { plan[i] = lpath(ma, mb, horiz); return; }
      const fix = ma ? B : A, mov = ma || mb;
      if ((horiz && mov[1] === fix[1]) || (vert && mov[0] === fix[0]) || (!horiz && !vert)) { plan[i] = [[fix[0], fix[1], mov[0], mov[1]]]; return; }
      // slide a free corner: the neighbouring perpendicular wire stretches, this one stays straight
      const e = g.pts.get(K(...fix));
      if (e && e.ends.length === 2 && !e.pins.length && !e.labels.length && !e.power.length && !e.nc.length) {
        const j = e.ends[0] === i ? e.ends[1] : e.ends[0], wj = base.wires[j];
        if (j !== i && wj && !movedW.has(j) && !claimed.has(j)) {
          const jh = wj[1] === wj[3], jv = wj[0] === wj[2];
          const other = wj[0] === fix[0] && wj[1] === fix[1] ? [wj[2], wj[3]] : [wj[0], wj[1]];
          const nf = horiz ? [fix[0], mov[1]] : [mov[0], fix[1]];
          if (((horiz && jv) || (vert && jh)) && !M.has(K(...other)) && clear([[nf[0], nf[1], mov[0], mov[1]], [other[0], other[1], nf[0], nf[1]]])) {
            claimed.add(j); override.set(j, [other[0], other[1], nf[0], nf[1]]);
            plan[i] = [[nf[0], nf[1], mov[0], mov[1]]];
            return;
          }
        }
      }
      plan[i] = dogleg(fix, mov, horiz);
    });
    const out = [], map = new Map();
    plan.forEach((segs, i) => {
      const list = segs || [override.get(i) || base.wires[i].slice()];
      map.set(i, []);
      for (const s of list) { if (s[0] === s[2] && s[1] === s[3]) continue; map.get(i).push(out.length); out.push(s); }
    });
    // anything that stays behind on a moving point (another part's pin, a label) gets a wire to the new position
    for (const [k, np] of M) {
      const e = g.pts.get(k);
      if (!e) continue;
      const fixed = e.pins.some(([pid]) => !mv.parts.has(pid)) || e.labels.some(id => !mv.labels.has(id)) || e.power.some(id => !mv.power.has(id));
      if (fixed) { const [x, y] = unK(k); for (const s of lpath([x, y], np, true)) out.push(s); }
    }
    return { wires: out, map };
  }
  // rigid transform (translate / rotate / mirror) of the moving set
  function rigid(base, g, mv, tf, fn) {
    const next = clone(base), M = new Map();
    const put = (x, y, nx, ny) => { if (x !== nx || y !== ny) M.set(K(x, y), [nx, ny]); };
    for (const p of next.parts) if (mv.parts.has(p.id)) {
      const og = g.parts.get(p.id);
      [p.x, p.y] = tf(p.x, p.y);
      if (fn) fn('part', p);
      const ng = partGeo(p);
      og.pins.forEach((q, i) => put(q.x, q.y, ng.pins[i].x, ng.pins[i].y));
    }
    for (const w of next.power) if (mv.power.has(w.id)) { const [x, y] = tf(w.x, w.y); put(w.x, w.y, x, y); w.x = x; w.y = y; if (fn) fn('power', w); }
    for (const l of next.labels) if (mv.labels.has(l.id)) { const [x, y] = tf(l.x, l.y); put(l.x, l.y, x, y); l.x = x; l.y = y; if (fn) fn('label', l); }
    next.nc.forEach((n, i) => { if (mv.nc.has(i)) { const [x, y] = tf(n[0], n[1]); put(n[0], n[1], x, y); n[0] = x; n[1] = y; } });
    const movedW = new Map();
    for (const i of mv.wires) {
      const w = base.wires[i];
      if (!w) continue;
      const a = tf(w[0], w[1]), b = tf(w[2], w[3]);
      put(w[0], w[1], a[0], a[1]); put(w[2], w[3], b[0], b[1]);
      movedW.set(i, [a[0], a[1], b[0], b[1]]);
    }
    const rb = rubberBand(base, g, M, movedW, mv);
    next.wires = rb.wires;
    return { doc: next, map: rb.map };
  }
  // change a part in place (value, pin table, pin count...): pins that move drag their decorations and wires along
  function regen(base, g, id, mutate, anchor) {
    const next = clone(base), p = next.parts.find(q => q.id === id), og = g.parts.get(id);
    if (!p || !og) return next;
    mutate(p);
    let ng = partGeo(p);
    const oldBy = new Map(og.pins.map(q => [q.num, q]));
    if (anchor) {
      const a = ng.pins.find(q => oldBy.has(q.num));
      if (a) { const o = oldBy.get(a.num); p.x += o.x - a.x; p.y += o.y - a.y; ng = partGeo(p); }
    }
    const M = new Map(), mv = emptySel(), movedW = new Map();
    mv.parts.add(id);
    for (const q of ng.pins) {
      const o = oldBy.get(q.num);
      if (!o || (o.x === q.x && o.y === q.y)) continue;
      const k = K(o.x, o.y), dx = q.x - o.x, dy = q.y - o.y;
      M.set(k, [q.x, q.y]);
      const f = followersAt(base, g, k, emptySel());
      for (const l of next.labels) if (f.labels.has(l.id) && !mv.labels.has(l.id)) { mv.labels.add(l.id); M.set(K(l.x, l.y), [l.x + dx, l.y + dy]); l.x += dx; l.y += dy; }
      for (const w of next.power) if (f.power.has(w.id) && !mv.power.has(w.id)) { mv.power.add(w.id); M.set(K(w.x, w.y), [w.x + dx, w.y + dy]); w.x += dx; w.y += dy; }
      next.nc.forEach((n, i) => { if (f.nc.has(i) && !mv.nc.has(i)) { mv.nc.add(i); n[0] += dx; n[1] += dy; } });
      for (const i of f.wires) if (!movedW.has(i)) { const w = base.wires[i]; movedW.set(i, [w[0] + dx, w[1] + dy, w[2] + dx, w[3] + dy]); }
    }
    next.wires = rubberBand(base, g, M, movedW, mv).wires;
    return next;
  }

  // ------------------------------------------------------------------ icons (16px line icons, same style as N.icons)
  const I = (d, extra = '') => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
  const NI = () => N.icons || {};
  const ICONS = {
    select: I('<path d="M3.5 2.5l8.8 5.3-3.8.9 2.2 4.1-1.7.9-2.2-4.1-3 2.6z"/>'),
    wire: I('<path d="M2.5 12.5h4.2V4.5h6.8"/><circle cx="2.5" cy="12.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="13.5" cy="4.5" r="1.2" fill="currentColor" stroke="none"/>'),
    label: I('<path d="M1.8 5h8.6l3.8 3-3.8 3H1.8z"/><path d="M4.5 8h3.5"/>'),
    power: I('<path d="M8 14.2V4.5M4.7 7.6L8 2.5l3.3 5.1"/>'),
    ground: I('<path d="M8 1.8v6.4M3.2 8.2h9.6M5.2 10.7h5.6M7 13.2h2"/>'),
    nc: I('<path d="M1.5 8h4"/><path d="M6.5 4.5l7 7M13.5 4.5l-7 7"/>'),
    rotate: I('<path d="M13.2 8.4a5.2 5.2 0 11-1.6-4.1"/><path d="M13.3 1.9v3.4H9.9"/>'),
    undo: I('<path d="M5.5 3L2.5 6l3 3"/><path d="M2.5 6h7.3a3.7 3.7 0 010 7.4H6.5"/>'),
    redo: I('<path d="M10.5 3l3 3-3 3"/><path d="M13.5 6H6.2a3.7 3.7 0 000 7.4h3.3"/>'),
    plus: I('<path d="M8 3v10M3 8h10"/>'),
    minus: I('<path d="M3.5 8h9"/>'),
  };

  // ------------------------------------------------------------------ stylesheet (auto-load next to this script if the page did not link it)
  const CSS_URL = (() => { try { const s = document.currentScript && document.currentScript.src; return s ? s.replace(/[^/]*$/, 'scheditor.css') : null; } catch (e) { return null; } })();
  function ensureCss() {
    if (!CSS_URL || document.querySelector('link[href*="scheditor.css"]') || [...document.querySelectorAll('style')].some(st => st.textContent.includes('.se-bar {'))) return;
    document.head.append(N.el('link', { rel: 'stylesheet', href: CSS_URL }));
  }

  // ================================================================== editor
  class SchEditor {
    constructor(host, opts = {}) {
      ensureCss();
      this.host = host;
      this.opts = opts;
      this.readOnly = !!opts.readOnly;
      this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
      this.doc = normDoc(opts.doc || emptyDoc(opts.title));
      if (opts.title && !this.doc.title) this.doc.title = S(opts.title);
      this.undoStack = []; this.redoStack = [];
      this.sel = emptySel();
      this.mode = 'select'; this.placing = null; this.wire = null;
      this.view = { s: 5, ox: 0, oy: 0 };
      this.hl = { net: null, refs: new Set() };
      this.netSel = null;
      this.hover = null; this.cursor = null; this.drag = null;
      this._ptrs = new Map();
      this._lastPower = '+5V';
      this._buildDom();
      const g0 = buildGeo(this.doc);
      this.doc.wires = normalizeWires(this.doc, g0);
      this._rebuild();
      this._bind();
      this._renderInsp(true);
      this._syncTools();
      this._updateEmpty();
      this._scheduleCheck();
    }

    // -------------------------------------------------------------- DOM
    _buildDom() {
      const el = N.el;
      this.btn = {};
      const tb = (id, icon, label, key, onclick, edit) => {
        const b = el('button', { class: 'tb' + (edit ? ' se-edit' : ''), type: 'button', title: label + (key ? ' (' + key + ')' : ''), 'aria-label': label, dataset: { t: id }, onclick },
          N.svg(icon), el('span', { class: 'se-tl' }, label));
        this.btn[id] = b;
        return b;
      };
      const sep = () => el('span', { class: 'tb-sep se-edit' });
      this.bar = el('div', { class: 'toolbar se-bar', role: 'toolbar', 'aria-label': 'Schematic tools' },
        tb('select', ICONS.select, 'Select', 'Esc', () => this.setMode('select')),
        tb('wire', ICONS.wire, 'Wire', 'W', () => this.setMode('wire'), true),
        tb('label', ICONS.label, 'Label', 'L', () => this._tool('label'), true),
        tb('power', ICONS.power, 'Power', 'P', () => this._tool('power'), true),
        tb('ground', ICONS.ground, 'Ground', 'G', () => this._tool('ground'), true),
        tb('nc', ICONS.nc, 'No-connect', 'Q', () => this._tool('nc'), true),
        sep(),
        tb('rotate', ICONS.rotate, 'Rotate', 'R', () => this.rotate(), true),
        tb('mirror', NI().flip || ICONS.rotate, 'Mirror', 'X', () => this.mirror(), true),
        tb('delete', NI().trash || ICONS.nc, 'Delete', 'Del', () => this.deleteSelection(), true),
        sep(),
        tb('undo', ICONS.undo, 'Undo', 'Ctrl+Z', () => this.undo(), true),
        tb('redo', ICONS.redo, 'Redo', 'Ctrl+Shift+Z', () => this.redo(), true),
        el('span', { class: 'grow' }),
        tb('fit', NI().fit || ICONS.plus, 'Zoom fit', 'F', () => this.fit()),
        tb('check', NI().checks || ICONS.plus, 'Check', '', e => this._openChecks(e.currentTarget)));
      this.checkBadge = el('span', { class: 'tab-badge se-badge', hidden: true });
      this.btn.check.append(this.checkBadge);

      // palette
      this.pal = el('aside', { class: 'se-pal', 'aria-label': 'Parts' });
      this.palQ = el('input', { class: 'input small se-pal-q', type: 'search', placeholder: 'Search parts', 'aria-label': 'Search parts', spellcheck: 'false', autocomplete: 'off' });
      this.palList = el('div', { class: 'se-pal-list' });
      this.palNone = el('div', { class: 'se-pal-none', hidden: true }, 'No parts match');
      this.pal.append(el('div', { class: 'se-pal-search' }, N.svg(NI().search || ICONS.plus), this.palQ), this.palList);
      this.palItems = [];
      for (const [title, items] of PALETTE) {
        const sec = el('div', { class: 'se-pal-sec' }, el('div', { class: 'se-pal-h' }, title));
        for (const [type, label, tpl, sub] of items) {
          const t = TYPES[type], proto = newPart(type, tpl), key = type + ':' + (tpl || '');
          let thumb = '';
          try { const src = partSym(Object.assign({ ref: t.prefix }, proto)); thumb = thumbSVG(symInfo(src.key, src.make), 30); } catch (e) { thumb = ''; }
          const name = label || t.name;
          const subText = sub || [proto.value, proto.package].filter(Boolean).join(' · ');
          const item = { type, tpl, key, name };
          const b = el('button', { class: 'se-pal-item', type: 'button', title: 'Place ' + name + (subText ? ' — ' + subText : ''), dataset: { k: key }, onclick: () => this._tool('part', item) },
            el('span', { class: 'se-pal-th', html: thumb }), el('span', { class: 'se-pal-tx' }, el('span', { class: 'se-pal-n' }, name), el('span', { class: 'se-pal-s' }, subText)));
          item.btn = b; item.sec = sec;
          item.hay = [name, t.name, t.kw || '', proto.value, proto.package, proto.mpn, sub || '', tpl || '', t.prefix].join(' ').toLowerCase();
          this.palItems.push(item);
          sec.append(b);
        }
        this.palList.append(sec);
      }
      this.palList.append(this.palNone);
      this.palQ.addEventListener('input', () => this._filterPalette());
      this.palQ.addEventListener('keydown', e => {
        if (e.key === 'Enter') { const first = this.palItems.find(it => !it.btn.hidden); if (first) { this._tool('part', first); this.canvas.focus({ preventScroll: true }); } }
        if (e.key === 'Escape') { this.palQ.value = ''; this._filterPalette(); this.canvas.focus({ preventScroll: true }); }
      });

      // stage
      this.stage = el('div', { class: 'se-stage' });
      this.canvas = el('canvas', { class: 'se-canvas', tabindex: '0', 'aria-label': 'Schematic drawing. Pick a part to place it, W draws wires, drag to move, wheel zooms.' });
      this.ctx = this.canvas.getContext('2d');
      this.tip = el('div', { class: 'viewer-tip se-tip', hidden: true });
      this.statusEl = el('div', { class: 'se-status', 'aria-live': 'polite', hidden: true });
      this.hintText = el('span', { class: 'se-hint-t' });
      this.hint = el('div', { class: 'se-hint', hidden: true }, this.hintText, el('button', { class: 'btn tiny', type: 'button', onclick: () => this._done() }, 'Done'));
      this.emptyEl = el('div', { class: 'se-empty', hidden: true },
        el('div', { class: 'se-empty-t' }, 'Start a new circuit'),
        el('div', { class: 'se-empty-s' }, 'Pick a part from the list, click to place it, then press W to wire pins together.'));
      this.stage.append(this.canvas, this.emptyEl, this.tip, this.statusEl, this.hint);

      // inspector
      this.insp = el('aside', { class: 'se-insp', 'aria-label': 'Inspector' });
      this.inspHeadText = el('span', { class: 'se-insp-ht' });
      this.inspHead = el('button', { class: 'se-insp-head', type: 'button', 'aria-expanded': 'false', onclick: () => this._toggleSheet() }, this.inspHeadText, N.svg(NI().chevron || ICONS.plus, 'se-chev'));
      this.inspBody = el('div', { class: 'se-insp-body' });
      this.insp.append(this.inspHead, this.inspBody);

      this.root = el('div', { class: 'se' + (this.readOnly ? ' se--ro' : '') },
        this.bar, el('div', { class: 'se-main' }, this.pal, this.stage, this.insp));
      this.host.append(this.root);
    }
    _filterPalette() {
      const q = this.palQ.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      let any = false;
      for (const it of this.palItems) { const ok = q.every(w => it.hay.includes(w)); it.btn.hidden = !ok; any = any || ok; }
      for (const sec of this.palList.querySelectorAll('.se-pal-sec')) sec.hidden = ![...sec.querySelectorAll('.se-pal-item')].some(b => !b.hidden);
      this.palNone.hidden = any;
    }
    _toggleSheet(open) {
      const on = open === undefined ? !this.root.classList.contains('se--sheet') : !!open;
      this.root.classList.toggle('se--sheet', on);
      this.inspHead.setAttribute('aria-expanded', String(on));
    }

    // -------------------------------------------------------------- public API
    getDoc() { return compactDoc(this.doc); }
    setDoc(doc) {
      this._cancelDrag();
      this.wire = null;
      this.doc = normDoc(doc);
      if (this.opts.title && !this.doc.title) this.doc.title = S(this.opts.title);
      this.doc.wires = normalizeWires(this.doc, buildGeo(this.doc));
      this.undoStack = []; this.redoStack = [];
      this.sel = emptySel(); this.netSel = null; this._lastKey = null; this.hover = null; this._flash = null;
      this.tip.hidden = true;
      this._afterDocChange(false);
      this.fit();
    }
    toCircuit(opts) { return circuitOf(this.doc, this.geo, this._conn(), opts); }
    check() { return runCheck(this.doc, this.geo, this._conn()); }
    // DS2K_SIM chip models for template ICs (NE555, LM358, LDOs) - merge into sim.chips to simulate them
    simChips() {
      return this.doc.parts.filter(p => p.tpl && SIM_CHIPS[p.tpl] && p.ref && !p.dnp).map(p => Object.assign({ ref: p.ref }, clone(SIM_CHIPS[p.tpl])));
    }
    undo() {
      if (!this.undoStack.length || this.readOnly) return false;
      this._cancelDrag(); this.wire = null;
      this.redoStack.push(JSON.stringify(this.doc));
      this.doc = JSON.parse(this.undoStack.pop());
      this._lastKey = null;
      this._afterDocChange(true);
      return true;
    }
    redo() {
      if (!this.redoStack.length || this.readOnly) return false;
      this._cancelDrag(); this.wire = null;
      this.undoStack.push(JSON.stringify(this.doc));
      this.doc = JSON.parse(this.redoStack.pop());
      this._lastKey = null;
      this._afterDocChange(true);
      return true;
    }
    fit() {
      const W = this.stage.clientWidth || 800, H = this.stage.clientHeight || 500;
      const bb = this._docBBox();
      if (!bb) { this.view = { s: 8, ox: Math.round(W / 2), oy: Math.round(H / 2) }; this.draw(); return; }
      const pad = W < 520 ? 22 : 44;
      const bw = Math.max(bb[2] - bb[0], 12), bh = Math.max(bb[3] - bb[1], 12);
      const s = Math.max(0.4, Math.min(9, (W - 2 * pad) / bw, (H - 2 * pad - 30) / bh));
      this.view = { s, ox: W / 2 - (bb[0] + bb[2]) / 2 * s, oy: (H - 30) / 2 - (bb[1] + bb[3]) / 2 * s };
      this.draw();
    }
    setReadOnly(on) {
      this.readOnly = !!on;
      if (this.readOnly) { this._cancelDrag(); this.wire = null; this.mode = 'select'; this.placing = null; }
      this.root.classList.toggle('se--ro', this.readOnly);
      this._syncTools(); this._renderInsp(true); this._resize(); this.draw();
    }
    highlightNet(name) {
      this.hl.net = name ? String(name) : null;
      this.draw();
      return !!this.hl.net && this._conn().byName(this.hl.net).length > 0;
    }
    highlightRefs(refs) { this.hl.refs = new Set(refs || []); this.draw(); }
    zoomToRefs(refs) {
      const want = new Set(refs || []), bb = bbNew();
      for (const pg of this.geo.parts.values()) if (want.has(pg.p.ref)) growBB(bb, pg.hit);
      if (bb[0] > bb[2]) return false;
      this._zoomBox(bb);
      return true;
    }
    // grid coordinates of a pin (DS2K pin id like "A", "+", "W" or a pin number)
    pinAt(ref, pin) {
      for (const pg of this.geo.parts.values()) if (pg.p.ref === ref) {
        const q = pg.pins.find(x => x.id === String(pin)) || pg.pins.find(x => x.num === String(pin));
        return q ? { x: q.x, y: q.y } : null;
      }
      return null;
    }
    // client (page) pixel position of a grid point - handy for overlays and tests
    toClient(x, y) {
      const r = this.canvas.getBoundingClientRect();
      return { x: r.left + this.view.ox + x * G * this.view.s, y: r.top + this.view.oy + y * G * this.view.s };
    }
    destroy() {
      if (this._destroyed) return;
      this._flushChange();
      this._destroyed = true;
      clearTimeout(this._chkT);
      this._ro && this._ro.disconnect();
      this._mo && this._mo.disconnect();
      if (this._mq) this._mq.removeEventListener('change', this._mqh);
      document.removeEventListener('keydown', this._kd);
      document.removeEventListener('keyup', this._ku);
      window.removeEventListener('blur', this._blur);
      if (this._chkPop) this._chkPop.close();
      if (this._raf) cancelAnimationFrame(this._raf);
      this.root.remove();
    }

    // -------------------------------------------------------------- edit core
    _rebuild() { this.geo = buildGeo(this.doc); this._cn = null; }
    _conn() { if (!this._cn) this._cn = connectivity(this.doc, this.geo); return this._cn; }
    _normalize() {
      const selW = [...this.sel.wires].map(i => this.doc.wires[i]).filter(Boolean);
      this.doc.wires = normalizeWires(this.doc, buildGeo(this.doc));
      if (!selW.length) return;
      const cov = (s, w) => {
        if (s[1] === s[3] && w[1] === w[3] && s[1] === w[1] && s[0] !== s[2]) return Math.min(Math.max(w[0], w[2]), Math.max(s[0], s[2])) - Math.max(Math.min(w[0], w[2]), Math.min(s[0], s[2])) > 0;
        if (s[0] === s[2] && w[0] === w[2] && s[0] === w[0] && s[1] !== s[3]) return Math.min(Math.max(w[1], w[3]), Math.max(s[1], s[3])) - Math.max(Math.min(w[1], w[3]), Math.min(s[1], s[3])) > 0;
        return s.every((v, i) => v === w[i]);
      };
      this.sel.wires = new Set();
      this.doc.wires.forEach((w, i) => { if (selW.some(s => cov(s, w))) this.sel.wires.add(i); });
    }
    // run an edit: fn mutates this.doc or returns a replacement doc (false = nothing happened); one undo step per call
    // (successive edits with the same key within 1.5 s share one undo step, e.g. typing in a field)
    _edit(fn, opts = {}) {
      if (this.readOnly) return false;
      const before = JSON.stringify(this.doc);
      const r = fn(this.doc);
      if (r === false) return false;
      if (r && typeof r === 'object' && Array.isArray(r.parts)) this.doc = r;
      return this._commit(before, opts.key);
    }
    _commit(before, key) {
      this._normalize();
      const after = JSON.stringify(this.doc);
      if (after === before) { this._rebuild(); this.draw(); return false; }
      const now = Date.now();
      if (!(key && key === this._lastKey && now - this._lastT < 1500)) {
        this.undoStack.push(before);
        if (this.undoStack.length > 100) this.undoStack.shift();
      }
      this.redoStack = [];
      this._lastKey = key || null; this._lastT = now;
      this._afterDocChange(true);
      return true;
    }
    _afterDocChange(emit) {
      this._rebuild();
      this._prune();
      this._renderInsp();
      this._syncTools();
      this._updateEmpty();
      this.draw();
      if (emit) this._changed();
      this._scheduleCheck();
    }
    _prune() {
      const s = this.sel, has = (arr, id) => arr.some(x => x.id === id);
      for (const id of [...s.parts]) if (!has(this.doc.parts, id)) s.parts.delete(id);
      for (const id of [...s.power]) if (!has(this.doc.power, id)) s.power.delete(id);
      for (const id of [...s.labels]) if (!has(this.doc.labels, id)) s.labels.delete(id);
      for (const i of [...s.wires]) if (i >= this.doc.wires.length) s.wires.delete(i);
      for (const i of [...s.nc]) if (i >= this.doc.nc.length) s.nc.delete(i);
      if (this.netSel && !this.geo.pts.has(this.netSel)) this.netSel = null;
    }
    _changed() {
      if (!this.onChange) return;
      this._pending = true;
      clearTimeout(this._chT);
      this._chT = setTimeout(() => this._flushChange(), 250);
    }
    _flushChange() {
      clearTimeout(this._chT);
      if (!this._pending || !this.onChange) return;
      this._pending = false;
      try { this.onChange(this.getDoc()); } catch (e) { console.error(e); }
    }
    _scheduleCheck() {
      clearTimeout(this._chkT);
      this._chkT = setTimeout(() => {
        if (this._destroyed) return;
        const list = this.check(), err = list.filter(x => x.level === 'error').length;
        this.checkBadge.hidden = !list.length;
        this.checkBadge.textContent = String(list.length);
        this.checkBadge.className = 'tab-badge se-badge ' + (err ? 'fail' : 'warn');
        this.btn.check.title = list.length ? `Check: ${err} error${err === 1 ? '' : 's'}, ${list.length - err} warning${list.length - err === 1 ? '' : 's'}` : 'Check: no problems';
      }, 300);
    }
    _docBBox() {
      const bb = bbNew(), g = this.geo;
      for (const pg of g.parts.values()) growBB(bb, pg.hit);
      for (const pw of g.power.values()) growBB(bb, pw.hit);
      for (const lg of g.labels.values()) growBB(bb, lg.hit);
      for (const w of this.doc.wires) { grow(bb, w[0] * G, w[1] * G); grow(bb, w[2] * G, w[3] * G); }
      for (const n of this.doc.nc) grow(bb, n[0] * G, n[1] * G);
      return bb[0] <= bb[2] ? bb : null;
    }
    _zoomBox(bb) {
      const W = this.stage.clientWidth || 800, H = this.stage.clientHeight || 500;
      const span = Math.max(bb[2] - bb[0], bb[3] - bb[1], 16) * 1.8;
      const s = Math.max(this.view.s, Math.min(12, Math.min(W, H) / span));
      this.view = { s, ox: W / 2 - (bb[0] + bb[2]) / 2 * s, oy: H / 2 - (bb[1] + bb[3]) / 2 * s };
      this.draw();
    }
    _nextRef(prefix, doc) {
      const used = new Set();
      for (const p of (doc || this.doc).parts) { const m = /^([A-Za-z#_]+)(\d+)$/.exec(p.ref); if (m && m[1] === prefix) used.add(+m[2]); }
      let n = 1;
      while (used.has(n)) n++;
      return prefix + n;
    }
    _nextLabelName() {
      const used = new Set(this.doc.labels.map(l => l.name));
      let n = 1;
      while (used.has('NET' + n)) n++;
      return 'NET' + n;
    }

    // -------------------------------------------------------------- selection
    _selCount() { const s = this.sel; return s.parts.size + s.power.size + s.labels.size + s.wires.size + s.nc.size; }
    _setOf(h) { return h.kind === 'part' ? this.sel.parts : h.kind === 'power' ? this.sel.power : h.kind === 'label' ? this.sel.labels : h.kind === 'wire' ? this.sel.wires : h.kind === 'nc' ? this.sel.nc : null; }
    _hkey(h) { return h.kind === 'wire' || h.kind === 'nc' ? h.i : h.id; }
    _isSel(h) { const s = this._setOf(h); return !!s && s.has(this._hkey(h)); }
    _select(list, add) {
      if (!add) this.sel = emptySel();
      for (const h of list) { const s = this._setOf(h); if (s) s.add(this._hkey(h)); }
      if (!add) this.netSel = null;
      this._renderInsp(); this._syncTools(); this.draw();
    }
    _toggleSel(h) { const s = this._setOf(h); if (!s) return; const k = this._hkey(h); if (s.has(k)) s.delete(k); else s.add(k); this._renderInsp(); this._syncTools(); this.draw(); }
    clearSelection() { this.sel = emptySel(); this.netSel = null; this._renderInsp(); this._syncTools(); this.draw(); }
    selectAll() {
      const s = emptySel();
      this.doc.parts.forEach(p => s.parts.add(p.id)); this.doc.power.forEach(w => s.power.add(w.id)); this.doc.labels.forEach(l => s.labels.add(l.id));
      this.doc.wires.forEach((_, i) => s.wires.add(i)); this.doc.nc.forEach((_, i) => s.nc.add(i));
      this.sel = s; this._renderInsp(); this._syncTools(); this.draw();
    }
    // selection plus the stubs / labels / power ports hanging off the selected parts' pins
    _movingSet() {
      const m = cloneSel(this.sel);
      for (const id of this.sel.parts) { const pg = this.geo.parts.get(id); if (pg) for (const q of pg.pins) followersAt(this.doc, this.geo, K(q.x, q.y), m); }
      return m;
    }
    _selBBoxGrid(m) {
      const bb = bbNew();
      for (const id of m.parts) { const p = this.doc.parts.find(x => x.id === id); if (p) grow(bb, p.x, p.y); }
      for (const w of this.doc.power) if (m.power.has(w.id)) grow(bb, w.x, w.y);
      for (const l of this.doc.labels) if (m.labels.has(l.id)) grow(bb, l.x, l.y);
      for (const i of m.wires) { const w = this.doc.wires[i]; if (w) { grow(bb, w[0], w[1]); grow(bb, w[2], w[3]); } }
      for (const i of m.nc) { const n = this.doc.nc[i]; if (n) grow(bb, n[0], n[1]); }
      return bb[0] <= bb[2] ? bb : null;
    }
    _applyRigid(tf, fn) {
      const mv = this._movingSet();
      const r = rigid(this.doc, this.geo, mv, tf, fn);
      const selW = new Set();
      for (const i of this.sel.wires) for (const j of r.map.get(i) || []) selW.add(j);
      this.sel.wires = selW;
      return r.doc;
    }

    // -------------------------------------------------------------- operations
    rotate() {
      if (this.readOnly) return;
      if (this.mode === 'place' && this.placing) { this.placing.rot = mod360((this.placing.rot || 0) + 90); this.placing.userRot = true; this.draw(); return; }
      if (!this._selCount()) return;
      const s = this.sel;
      let pivot;
      if (s.parts.size === 1 && this._selCount() === s.parts.size) { const p = this.doc.parts.find(x => x.id === [...s.parts][0]); pivot = [p.x, p.y]; }
      else { const bb = this._selBBoxGrid(this._movingSet()); if (!bb) return; pivot = [Math.round((bb[0] + bb[2]) / 2), Math.round((bb[1] + bb[3]) / 2)]; }
      const [px, py] = pivot;
      this._edit(() => this._applyRigid((x, y) => [px + (y - py), py - (x - px)], (kind, o) => { o.rot = mod360(o.rot + 90); }));
    }
    mirror() {
      if (this.readOnly) return;
      if (this.mode === 'place' && this.placing) {
        const pl = this.placing;
        if (pl.kind === 'part') { pl.mirror = !pl.mirror; pl.rot = mod360(360 - (pl.rot || 0)); }
        else if (pl.kind === 'label') pl.rot = mod360(540 - (pl.rot || 0));
        else pl.rot = mod360(360 - (pl.rot || 0));
        pl.userRot = true; this.draw(); return;
      }
      if (!this._selCount()) return;
      let px;
      const s = this.sel;
      if (s.parts.size === 1 && this._selCount() === 1) px = this.doc.parts.find(x => x.id === [...s.parts][0]).x;
      else { const bb = this._selBBoxGrid(this._movingSet()); if (!bb) return; px = Math.round((bb[0] + bb[2]) / 2); }
      this._edit(() => this._applyRigid((x, y) => [2 * px - x, y], (kind, o) => {
        if (kind === 'part') { o.mirror = !o.mirror; o.rot = mod360(360 - o.rot); }
        else if (kind === 'label') o.rot = mod360(540 - o.rot);
        else o.rot = mod360(360 - o.rot);
      }));
    }
    deleteSelection() {
      if (this.readOnly || !this._selCount()) return;
      const m = this._movingSet();
      this._edit(d => {
        d.parts = d.parts.filter(p => !m.parts.has(p.id));
        d.power = d.power.filter(w => !m.power.has(w.id));
        d.labels = d.labels.filter(l => !m.labels.has(l.id));
        d.wires = d.wires.filter((_, i) => !m.wires.has(i));
        d.nc = d.nc.filter((_, i) => !m.nc.has(i));
        this.sel = emptySel();
      });
    }
    duplicate() {
      if (this.readOnly || !this._selCount()) return;
      const m = this._movingSet(), dx = 4, dy = 4, ns = emptySel();
      this._edit(d => {
        for (const p of d.parts.slice()) if (m.parts.has(p.id)) { const q = clone(p); q.id = uid(); q.ref = this._nextRef(partPrefix(p), d); q.x += dx; q.y += dy; d.parts.push(q); ns.parts.add(q.id); }
        for (const w of d.power.slice()) if (m.power.has(w.id)) { const q = Object.assign(clone(w), { id: uid(), x: w.x + dx, y: w.y + dy }); d.power.push(q); ns.power.add(q.id); }
        for (const l of d.labels.slice()) if (m.labels.has(l.id)) { const q = Object.assign(clone(l), { id: uid(), x: l.x + dx, y: l.y + dy }); d.labels.push(q); ns.labels.add(q.id); }
        for (const i of m.wires) { const w = d.wires[i]; ns.wires.add(d.wires.length); d.wires.push([w[0] + dx, w[1] + dy, w[2] + dx, w[3] + dy]); }
        for (const i of m.nc) { const n = d.nc[i]; d.nc.push([n[0] + dx, n[1] + dy]); }
        this.sel = ns;
      });
    }
    nudge(dx, dy) {
      if (this.readOnly || !this._selCount()) return;
      this._edit(() => this._applyRigid((x, y) => [x + dx, y + dy]), { key: 'nudge' });
    }

    // -------------------------------------------------------------- modes and tools
    setMode(mode, placing) {
      if (this.readOnly && mode !== 'select') return;
      if (this.wire) this._finishWire();
      this.mode = mode;
      this.placing = placing || null;
      this.wire = null;
      this._wireFromSelect = false;
      if (mode !== 'select') this.netSel = null;
      this._syncTools();
      this._updateCursor();
      this.draw();
    }
    _tool(kind, item) {
      if (this.readOnly) return;
      if (kind === 'part') this.setMode('place', { kind: 'part', item, rot: 0, mirror: false });
      else if (kind === 'label') this.setMode('place', { kind: 'label', rot: 0 });
      else if (kind === 'power') this.setMode('place', { kind: 'power', name: this._lastPower || '+5V', rot: 0 });
      else if (kind === 'ground') this.setMode('place', { kind: 'power', name: 'GND', ground: true, rot: 0 });
      else if (kind === 'nc') this.setMode('place', { kind: 'nc' });
    }
    _done() { if (this.mode === 'wire' && this.wire) this._finishWire(); else this.setMode('select'); }
    _escape() {
      if (this.drag && this.drag.kind === 'move') { this._cancelDrag(); return; }
      if (this.mode === 'wire' && this.wire) { this._finishWire(); return; }
      if (this.mode !== 'select') { this.setMode('select'); return; }
      if (this._selCount() || this.netSel) this.clearSelection();
    }
    _activeTool() {
      if (this.mode === 'wire') return 'wire';
      if (this.mode === 'place' && this.placing) { const k = this.placing.kind; return k === 'power' ? (this.placing.ground ? 'ground' : 'power') : k === 'part' ? null : k; }
      return 'select';
    }
    _syncTools() {
      const act = this._activeTool();
      for (const id of ['select', 'wire', 'label', 'power', 'ground', 'nc']) this.btn[id].classList.toggle('on', act === id);
      const pk = this.mode === 'place' && this.placing && this.placing.kind === 'part' ? this.placing.item.key : null;
      for (const it of this.palItems) it.btn.classList.toggle('on', it.key === pk);
      const has = this._selCount() > 0;
      this.btn.rotate.disabled = !has && this.mode !== 'place';
      this.btn.mirror.disabled = !has && this.mode !== 'place';
      this.btn.delete.disabled = !has;
      this.btn.undo.disabled = !this.undoStack.length;
      this.btn.redo.disabled = !this.redoStack.length;
      // mode hint
      let t = '';
      const narrow = this.root.classList.contains('se--narrow');
      if (this.mode === 'place' && this.placing) {
        const pl = this.placing;
        if (pl.kind === 'part') t = narrow ? `Tap to place ${pl.item.name}` : `Placing ${pl.item.name} — click to place, R rotate, X mirror, Esc to stop`;
        else if (pl.kind === 'label') t = narrow ? 'Tap a pin or wire to label it' : 'Click a pin or wire end to attach a net label — Esc to stop';
        else if (pl.kind === 'power') t = narrow ? `Tap a pin to attach ${pl.name}` : `Click a pin or wire end to attach ${pl.name} — Esc to stop`;
        else if (pl.kind === 'nc') t = narrow ? 'Tap a pin to mark it unused' : 'Click a pin to mark it not connected — Esc to stop';
      } else if (this.mode === 'wire') {
        t = this.wire ? (narrow ? 'Tap to add a corner, tap a pin to finish' : 'Click to add a corner, click a pin or wire to finish — Esc ends')
          : (narrow ? 'Tap a pin to start a wire' : 'Click a pin (or anywhere) to start a wire — Esc to stop');
      }
      this.hint.hidden = !t;
      this.hintText.textContent = t;
    }
    _updateEmpty() { this.emptyEl.hidden = !!(this.doc.parts.length || this.doc.wires.length || this.doc.labels.length || this.doc.power.length) || this.readOnly; }

    // -------------------------------------------------------------- placing
    _placeAt(t) {
      const pl = this.placing;
      if (!pl) return;
      const gx = t.x, gy = t.y;
      if (pl.kind === 'part') {
        let id;
        this._edit(d => {
          const p = newPart(pl.item.type, pl.item.tpl);
          p.id = id = uid();
          p.ref = this._nextRef((TYPES[p.type] || TYPES.other).prefix, d);
          p.x = gx; p.y = gy; p.rot = pl.rot || 0; p.mirror = !!pl.mirror;
          d.parts.push(p);
        });
        this._select([{ kind: 'part', id }]);
      } else if (pl.kind === 'label') {
        let id;
        const rot = !pl.userRot && t.dir ? labelRot(t.dir) : pl.rot || 0;
        this._edit(d => { id = uid(); d.labels.push({ id, name: this._nextLabelName(), x: gx, y: gy, rot, port: '' }); this._splitAt(d, gx, gy); });
        this._select([{ kind: 'label', id }]);
        this._focusField('name');
      } else if (pl.kind === 'power') {
        const style = pl.ground ? 'gnd' : E1().powerStyle(pl.name);
        const rot = !pl.userRot && t.dir ? powerRot(style, t.dir) : pl.rot || 0;
        let id;
        this._edit(d => { id = uid(); d.power.push({ id, name: pl.name, x: gx, y: gy, rot, style }); this._splitAt(d, gx, gy); });
        if (!pl.ground) this._lastPower = pl.name;
        this._select([{ kind: 'power', id }]);
      } else if (pl.kind === 'nc') {
        const e = this.geo.pts.get(K(gx, gy));
        if (!e || !e.pins.length) { N.toast && N.toast('Click on a pin end to mark it not connected'); return; }
        const i = this.doc.nc.findIndex(n => n[0] === gx && n[1] === gy);
        this._edit(d => { if (i >= 0) d.nc.splice(i, 1); else d.nc.push([gx, gy]); });
      }
    }

    // -------------------------------------------------------------- wires
    // a label or power port dropped on the middle of a wire attaches to it: split the wire there
    _splitAt(d, x, y) {
      const i = wireThrough(d, this.geo, x, y);
      if (i >= 0) { const w = d.wires[i]; d.wires.splice(i, 1, [w[0], w[1], x, y], [x, y, w[2], w[3]]); }
    }
    // what lies under world point w: a pin, a wire end / label / power port, a wire, or plain grid
    _target(w, noMagnet) {
      const s = this.view.s, tol = 9 / s, g = this.geo;
      let best = null, bd = tol;
      for (const pg of g.parts.values()) {
        if (!inBB(pg.bb, w[0], w[1], tol)) continue;
        for (const q of pg.pins) { const d = Math.hypot(q.x * G - w[0], q.y * G - w[1]); if (d < bd) { bd = d; best = { x: q.x, y: q.y, kind: 'pin', dir: q.dir, pid: pg.p.id, pin: q }; } }
      }
      if (best) return best;
      if (!noMagnet) {
        for (const e of g.pts.values()) {
          if (!e.ends.length && !e.labels.length && !e.power.length) continue;
          const d = Math.hypot(e.x * G - w[0], e.y * G - w[1]);
          if (d < bd) { bd = d; best = { x: e.x, y: e.y, kind: e.power.length ? 'power' : e.labels.length ? 'label' : 'end', dir: this._endDir(e) }; }
        }
        if (best) return best;
      }
      const gx = Math.round(w[0] / G), gy = Math.round(w[1] / G);
      const e = g.pts.get(K(gx, gy));
      if (e && (e.ends.length || e.labels.length || e.power.length || e.pins.length)) return { x: gx, y: gy, kind: e.pins.length ? 'pin' : 'end', dir: this._endDir(e) };
      if (wireThrough(this.doc, g, gx, gy) >= 0) return { x: gx, y: gy, kind: 'wire', dir: null };
      return { x: gx, y: gy, kind: null, dir: null };
    }
    _endDir(e) {
      if (e.pins.length) { const [pid, i] = e.pins[0]; return this.geo.parts.get(pid).pins[i].dir; }
      if (e.ends.length === 1) {
        const w = this.doc.wires[e.ends[0]], o = w[0] === e.x && w[1] === e.y ? [w[2], w[3]] : [w[0], w[1]];
        return [Math.sign(e.x - o[0]), Math.sign(e.y - o[1])];
      }
      return null;
    }
    _startWire(t, fromSelect) {
      if (this.mode !== 'wire') { this.mode = 'wire'; this.placing = null; }
      this._wireFromSelect = !!fromSelect;
      this.wire = { pts: [[t.x, t.y]], next: t.dir ? (t.dir[0] ? 'h' : 'v') : null };
      this._syncTools(); this.draw();
    }
    _route(a, b, tdir) {
      if (a[0] === b[0] || a[1] === b[1]) return [b];
      const first = this.wire && this.wire.next, last = tdir ? (tdir[0] ? 'h' : 'v') : null;
      if (first && last && first === last) {
        if (first === 'h') { const mx = Math.round((a[0] + b[0]) / 2); return [[mx, a[1]], [mx, b[1]], b]; }
        const my = Math.round((a[1] + b[1]) / 2); return [[a[0], my], [b[0], my], b];
      }
      const f = first || (last ? (last === 'h' ? 'v' : 'h') : (Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 'h' : 'v'));
      return f === 'h' ? [[b[0], a[1]], b] : [[a[0], b[1]], b];
    }
    _wireClick(t) {
      if (!this.wire) { this._startWire(t, false); return; }
      const pts = this.wire.pts, last = pts[pts.length - 1];
      if (t.x === last[0] && t.y === last[1]) { this._finishWire(); return; }
      const legs = this._route(last, [t.x, t.y], t.kind === 'pin' ? t.dir : null);
      let prev = last;
      for (const q of legs) { pts.push(q); if (q[0] !== prev[0] || q[1] !== prev[1]) this.wire.next = q[0] !== prev[0] ? 'v' : 'h'; prev = q; }
      if (t.kind && pts.length > 1) this._finishWire();
      else { this._syncTools(); this.draw(); }
    }
    _finishWire() {
      const w = this.wire;
      this.wire = null;
      if (w && w.pts.length > 1) {
        this._edit(d => {
          for (let i = 1; i < w.pts.length; i++) { const a = w.pts[i - 1], b = w.pts[i]; if (a[0] !== b[0] || a[1] !== b[1]) d.wires.push([a[0], a[1], b[0], b[1]]); }
        });
      }
      if (this._wireFromSelect) { this._wireFromSelect = false; this.mode = 'select'; }
      this._syncTools(); this._updateCursor(); this.draw();
    }

    // -------------------------------------------------------------- input
    _bind() {
      const cv = this.canvas;
      cv.addEventListener('pointerdown', e => this._down(e));
      cv.addEventListener('pointermove', e => this._move(e));
      cv.addEventListener('pointerup', e => this._up(e, false));
      cv.addEventListener('pointercancel', e => this._up(e, true));
      cv.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.cursor = null; this.tip.hidden = true; this._status(); this.draw(); } });
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('dblclick', e => this._dbl(e));
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const sp = this._sp(e);
        if (e.shiftKey && !e.ctrlKey) { this.view.ox -= e.deltaY || e.deltaX; this.draw(); return; }
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this._zoomAt(sp[0], sp[1], Math.exp(-dy * (e.ctrlKey ? 0.006 : 0.0015)));
      }, { passive: false });
      this.bar.addEventListener('scroll', () => this._barMore(), { passive: true });
      this.root.addEventListener('pointerenter', () => { this._hoverIn = true; });
      this.root.addEventListener('pointerleave', () => { this._hoverIn = false; });
      this._kd = e => this._key(e, true);
      this._ku = e => this._key(e, false);
      this._blur = () => { this._space = false; this._updateCursor(); };
      document.addEventListener('keydown', this._kd);
      document.addEventListener('keyup', this._ku);
      window.addEventListener('blur', this._blur);
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this.root); this._ro.observe(this.stage);
      this._mo = new MutationObserver(() => { this._C = null; this.draw(); });
      this._mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
      if (window.matchMedia) { this._mq = matchMedia('(prefers-color-scheme: dark)'); this._mqh = () => { this._C = null; this.draw(); }; this._mq.addEventListener('change', this._mqh); }
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (this._destroyed) return; SYM.clear(); this._rebuild(); this.draw(); });
    }
    _resize() {
      if (this._destroyed) return;
      const narrow = this.root.clientWidth < 760;
      if (narrow !== this.root.classList.contains('se--narrow')) { this.root.classList.toggle('se--narrow', narrow); this.palQ.placeholder = narrow ? 'Search' : 'Search parts'; this._syncTools(); }
      this.root.classList.remove('se--compact');
      if (this.bar.scrollWidth > this.bar.clientWidth + 2) this.root.classList.add('se--compact');
      this._barMore();
      const r = this.stage.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
      if (this.canvas.width !== W || this.canvas.height !== H || this.dpr !== dpr) {
        const prev = this._size;
        this.dpr = dpr; this.canvas.width = W; this.canvas.height = H;
        this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
        this._size = [r.width, r.height];
        if (!prev) this.fit();
        else { this.view.ox += (r.width - prev[0]) / 2; this.view.oy += (r.height - prev[1]) / 2; this._paint(); }
      }
    }
    _barMore() { const b = this.bar; b.classList.toggle('se-more', b.scrollLeft + b.clientWidth < b.scrollWidth - 2); }
    _sp(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    _world(sp) { return [(sp[0] - this.view.ox) / this.view.s, (sp[1] - this.view.oy) / this.view.s]; }
    _zoomAt(sx, sy, k) {
      const s0 = this.view.s, s1 = Math.max(0.4, Math.min(80, s0 * k)), f = s1 / s0;
      this.view.ox = sx - (sx - this.view.ox) * f;
      this.view.oy = sy - (sy - this.view.oy) * f;
      this.view.s = s1;
      this.draw();
    }
    // hit test in select mode: pin > label/power/no-connect > wire > part
    _hit(sp) {
      const w = this._world(sp), s = this.view.s, g = this.geo;
      if (!this.readOnly) {
        let best = null, bd = 6 / s;
        for (const pg of g.parts.values()) {
          if (!inBB(pg.bb, w[0], w[1], bd)) continue;
          for (const q of pg.pins) { const d = Math.hypot(q.x * G - w[0], q.y * G - w[1]); if (d < bd) { bd = d; best = { kind: 'pin', pid: pg.p.id, i: q.i, x: q.x, y: q.y, dir: q.dir }; } }
        }
        if (best) return best;
      }
      const t = 2 / s;
      for (const lg of [...g.labels.values()].reverse()) if (inBB(lg.hit, w[0], w[1], t)) return { kind: 'label', id: lg.l.id };
      for (const pw of [...g.power.values()].reverse()) if (inBB(pw.hit, w[0], w[1], t)) return { kind: 'power', id: pw.w.id };
      for (let i = this.doc.nc.length - 1; i >= 0; i--) { const n = this.doc.nc[i]; if (Math.hypot(n[0] * G - w[0], n[1] * G - w[1]) < Math.max(0.9, 5 / s)) return { kind: 'nc', i }; }
      let wb = -1, wd = 5 / s;
      this.doc.wires.forEach((q, i) => { const d = segDist(w[0], w[1], q[0] * G, q[1] * G, q[2] * G, q[3] * G); if (d < wd) { wd = d; wb = i; } });
      if (wb >= 0) return { kind: 'wire', i: wb };
      let bp = null, ba = INF;
      for (const pg of g.parts.values()) {
        if (!inBB(pg.hit, w[0], w[1], t)) continue;
        const inBody = inBB(pg.bb, w[0], w[1], t);
        const a = (pg.bb[2] - pg.bb[0]) * (pg.bb[3] - pg.bb[1]) * (inBody ? 1 : 4);
        if (a < ba) { ba = a; bp = { kind: 'part', id: pg.p.id }; }
      }
      return bp;
    }
    _down(e) {
      if (this._destroyed) return;
      const cv = this.canvas, sp = this._sp(e);
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      this._ptrs.set(e.pointerId, sp);
      if (document.activeElement !== cv) cv.focus({ preventScroll: true });
      this.tip.hidden = true;
      this._flash = null;
      if (this._ptrs.size === 2) {
        if (this.drag && this.drag.kind === 'move') this._cancelDrag();
        const [a, b] = [...this._ptrs.values()];
        this.drag = { kind: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        return;
      }
      if (this._ptrs.size > 2) return;
      const touch = e.pointerType === 'touch';
      if (e.button === 1 || (e.button === 0 && this._space)) { e.preventDefault(); this.drag = { kind: 'pan', last: sp, start: sp, moved: 0 }; this._updateCursor(); return; }
      if (e.button === 2) {
        if (this.mode === 'wire') { if (this.wire) this._finishWire(); else this.setMode('select'); }
        else if (this.mode === 'place') this.setMode('select');
        return;
      }
      if (e.button !== 0) return;
      if (this.mode === 'place' || this.mode === 'wire') { this.drag = { kind: 'tap', start: sp, moved: 0, touch }; return; }
      const h = this._hit(sp);
      if (h && h.kind === 'pin') {
        this._startWire({ x: h.x, y: h.y, dir: h.dir, kind: 'pin' }, true);
        this.drag = { kind: 'wiretap', start: sp, moved: 0, touch };
        return;
      }
      if (h) {
        const was = this._isSel(h);
        if (!was) this._select([h], e.shiftKey);
        if (h.kind === 'wire') this.netSel = K(this.doc.wires[h.i][0], this.doc.wires[h.i][1]);
        this.drag = { kind: 'press', start: sp, w0: this._world(sp), h, shift: e.shiftKey, was, moved: 0, touch };
        this.draw();
        return;
      }
      if (touch) { this.drag = { kind: 'pan', last: sp, start: sp, moved: 0, tapEmpty: true }; return; }
      this.drag = { kind: 'box', start: sp, cur: sp, shift: e.shiftKey, moved: 0 };
    }
    _move(e) {
      if (this._destroyed) return;
      const sp = this._sp(e);
      if (this._ptrs.has(e.pointerId)) this._ptrs.set(e.pointerId, sp);
      const d = this.drag;
      if (d && d.kind === 'pinch') {
        if (this._ptrs.size < 2) return;
        const [a, b] = [...this._ptrs.values()];
        const dist = Math.hypot(a[0] - b[0], a[1] - b[1]), c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        this.view.ox += c[0] - d.c[0]; this.view.oy += c[1] - d.c[1];
        if (d.d > 0) this._zoomAt(c[0], c[1], dist / d.d);
        d.d = dist; d.c = c; this.draw();
        return;
      }
      if (d) d.moved = Math.max(d.moved || 0, Math.hypot(sp[0] - d.start[0], sp[1] - d.start[1]));
      if (d && d.kind === 'pan') { this.view.ox += sp[0] - d.last[0]; this.view.oy += sp[1] - d.last[1]; d.last = sp; this.draw(); return; }
      if (d && d.kind === 'tap' && d.moved > (d.touch ? 10 : 8)) { d.kind = 'pan'; this.view.ox += sp[0] - d.start[0]; this.view.oy += sp[1] - d.start[1]; d.last = sp; this._updateCursor(); this.draw(); return; }
      if (d && d.kind === 'press' && d.moved > (d.touch ? 8 : 4) && !this.readOnly) this._beginMove(d);
      this.cursor = this._world(sp);
      if (d && d.kind === 'move') { this._updateMove(d); this._status(); return; }
      if (d && d.kind === 'box') { d.cur = sp; this.draw(); return; }
      this._updateHover(sp);
      this._status();
      this.draw();
    }
    _up(e, cancel) {
      const had = this._ptrs.has(e.pointerId);
      this._ptrs.delete(e.pointerId);
      const d = this.drag;
      if (!d || !had) return;
      if (d.kind === 'pinch') {
        if (this._ptrs.size === 1) { const p = [...this._ptrs.values()][0]; this.drag = { kind: 'pan', last: p, start: p, moved: 99 }; }
        else if (!this._ptrs.size) this.drag = null;
        return;
      }
      this.drag = null;
      this._updateCursor();
      if (cancel) { if (d.kind === 'move') this._restoreMove(d); this.draw(); return; }
      const sp = this._sp(e);
      if (d.kind === 'tap') {
        const t = this._target(this._world(sp), this.mode === 'place' && this.placing && this.placing.kind === 'part');
        if (this.mode === 'place') this._placeAt(t);
        else if (this.mode === 'wire') this._wireClick(t);
      } else if (d.kind === 'wiretap') {
        if (d.moved > 8) this._wireClick(this._target(this._world(sp)));
      } else if (d.kind === 'press') {
        if (d.shift && d.was) this._toggleSel(d.h);
        else if (!d.shift && this._selCount() > 1) this._select([d.h]);
        if (d.h.kind === 'wire') this.netSel = K(this.doc.wires[d.h.i][0], this.doc.wires[d.h.i][1]);
        this._renderInsp(); this._status(); this.draw();
      } else if (d.kind === 'move') this._endMove(d);
      else if (d.kind === 'box') {
        if (d.moved < 4) { if (!d.shift) this.clearSelection(); }
        else this._boxSelect(d);
        this.draw();
      } else if (d.kind === 'pan' && d.tapEmpty && d.moved < 8) this.clearSelection();
    }
    _cancelDrag() {
      const d = this.drag;
      this.drag = null;
      if (d && d.kind === 'move') this._restoreMove(d);
    }
    _beginMove(d) {
      d.kind = 'move';
      d.base = this.doc; d.baseGeo = this.geo; d.baseSnap = JSON.stringify(this.doc);
      d.baseSel = cloneSel(this.sel);
      d.mv = this._movingSet();
      d.g0 = [Math.round(d.w0[0] / G), Math.round(d.w0[1] / G)];
      d.delta = [0, 0];
      this.tip.hidden = true; this.hover = null;
      this._updateCursor();
    }
    _updateMove(d) {
      const g = [Math.round(this.cursor[0] / G), Math.round(this.cursor[1] / G)];
      const dx = g[0] - d.g0[0], dy = g[1] - d.g0[1];
      if (dx === d.delta[0] && dy === d.delta[1]) return;
      d.delta = [dx, dy];
      const r = rigid(d.base, d.baseGeo, d.mv, (x, y) => [x + dx, y + dy]);
      this.doc = r.doc;
      const selW = new Set();
      for (const i of d.baseSel.wires) for (const j of r.map.get(i) || []) selW.add(j);
      this.sel = cloneSel(d.baseSel); this.sel.wires = selW;
      this._rebuild();
      this.draw();
    }
    _restoreMove(d) {
      if (!d.base) return;
      this.doc = d.base; this.sel = d.baseSel;
      this._rebuild(); this.draw();
    }
    _endMove(d) {
      if (!d.delta[0] && !d.delta[1]) { this._restoreMove(d); return; }
      this._lastKey = null;
      this._commit(d.baseSnap, null);
    }
    _boxSelect(d) {
      const a = this._world(d.start), b = this._world(d.cur);
      const r = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      const crossing = d.cur[0] < d.start[0];
      const test = bb => (crossing ? overlaps(bb, r) : within(bb, r));
      const list = [], g = this.geo;
      for (const pg of g.parts.values()) if (test(pg.bb)) list.push({ kind: 'part', id: pg.p.id });
      for (const pw of g.power.values()) if (test(pw.hit)) list.push({ kind: 'power', id: pw.w.id });
      for (const lg of g.labels.values()) if (test(lg.hit)) list.push({ kind: 'label', id: lg.l.id });
      this.doc.wires.forEach((w, i) => { const bb = [Math.min(w[0], w[2]) * G, Math.min(w[1], w[3]) * G, Math.max(w[0], w[2]) * G, Math.max(w[1], w[3]) * G]; if (test(bb)) list.push({ kind: 'wire', i }); });
      this.doc.nc.forEach((n, i) => { if (inBB(r, n[0] * G, n[1] * G)) list.push({ kind: 'nc', i }); });
      this._select(list, d.shift);
    }
    _dbl(e) {
      if (this.mode !== 'select') return;
      const h = this._hit(this._sp(e));
      if (!h) return;
      if (h.kind === 'part') { this._select([h]); this._focusField('value'); }
      else if (h.kind === 'label' || h.kind === 'power') { this._select([h]); this._focusField('name'); }
    }
    _updateHover(sp) {
      let h = null;
      if (this.mode === 'select' && !this.readOnly) { const x = this._hit(sp); if (x && x.kind === 'pin') h = x; }
      else if (this.mode !== 'select') { const t = this._target(this._world(sp)); if (t.kind === 'pin') h = { kind: 'pin', pid: t.pid, i: t.pin.i, x: t.x, y: t.y }; }
      this.hover = h;
      if (h) {
        const pg = this.geo.parts.get(h.pid), q = pg.pins[h.i], n = this._conn().netOf(K(q.x, q.y));
        const nm = q.name && q.name !== '~' && q.name !== q.id && q.name !== q.num ? ' ' + esc(q.name) : '';
        const net = pinConnected(n) ? (n.name ? 'net ' + esc(n.name) : 'unnamed net') : this.doc.nc.some(c => c[0] === q.x && c[1] === q.y) ? 'marked not connected' : 'not connected';
        this.tip.innerHTML = `<b>${esc(pg.p.ref || '?')}.${esc(q.id)}</b>${nm}<br><span>${net}${this.mode === 'select' && !this.readOnly ? ' · click to wire' : ''}</span>`;
        this.tip.hidden = false;
        const W = this.stage.clientWidth;
        this.tip.style.left = Math.max(4, Math.min(sp[0] + 14, W - 200)) + 'px';
        this.tip.style.top = sp[1] + 18 + 'px';
      } else this.tip.hidden = true;
      this._updateCursor(sp);
    }
    _updateCursor(sp) {
      let c = 'default';
      const d = this.drag;
      if (this._space || (d && d.kind === 'pan')) c = d && d.kind === 'pan' ? 'grabbing' : 'grab';
      else if (d && d.kind === 'move') c = 'move';
      else if (this.mode === 'wire' || this.mode === 'place') c = 'crosshair';
      else if (this.hover) c = 'crosshair';
      else if (sp && this.mode === 'select') { const h = this._hit(sp); if (h) c = this._isSel(h) && !this.readOnly ? 'move' : 'pointer'; }
      if (this.canvas.style.cursor !== c) this.canvas.style.cursor = c;
    }
    _status() {
      const parts = [];
      if (this.cursor) {
        const gx = Math.round(this.cursor[0] / G), gy = Math.round(this.cursor[1] / G);
        parts.push(`<span class="se-xy">${(gx * G).toFixed(2)}, ${(gy * G).toFixed(2)} mm</span>`);
      }
      if (this.drag && this.drag.kind === 'move' && this.drag.delta) parts.push(`<span>move ${this.drag.delta[0]}, ${this.drag.delta[1]}</span>`);
      const n = this.netSel ? this._conn().netOf(this.netSel) : null;
      if (n) {
        const pins = new Set(n.pins.map(([pid, i]) => { const pg = this.geo.parts.get(pid); return pg.p.ref + '.' + pg.pins[i].id; }));
        parts.push(`<span class="se-net"><b>${n.name ? esc(n.name) : 'unnamed net'}</b> · ${pins.size} pin${pins.size === 1 ? '' : 's'}</span>`);
      }
      this.statusEl.innerHTML = parts.join('');
      this.statusEl.hidden = !parts.length;
    }
    _key(e, down) {
      if (this._destroyed) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const ae = document.activeElement;
      const inside = this.root.contains(ae) || (this._hoverIn && (!ae || ae === document.body));
      if (!inside) return;
      if (e.key === ' ') { if (this._space !== down) { this._space = down; this._updateCursor(); } if (!/^(BUTTON|A)$/.test(t && t.tagName)) e.preventDefault(); return; }
      if (!down) return;
      const mod = e.ctrlKey || e.metaKey, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (this._chkPop && k === 'Escape') { this._chkPop.close(); return; }
      if (mod) {
        if (k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
        else if (k === 'y') { e.preventDefault(); this.redo(); }
        else if (k === 'a' && this.root.contains(ae)) { e.preventDefault(); this.selectAll(); }
        else if (k === 'd') { e.preventDefault(); this.duplicate(); }
        return;
      }
      if (e.altKey) return;
      const act = {
        Escape: () => this._escape(), r: () => this.rotate(), x: () => this.mirror(), Delete: () => this.deleteSelection(), Backspace: () => this.deleteSelection(),
        w: () => this.setMode('wire'), l: () => this._tool('label'), p: () => this._tool('power'), g: () => this._tool('ground'), q: () => this._tool('nc'), f: () => this.fit(),
        ArrowLeft: () => this.nudge(-1, 0), ArrowRight: () => this.nudge(1, 0), ArrowUp: () => this.nudge(0, -1), ArrowDown: () => this.nudge(0, 1),
      }[k];
      if (!act) return;
      if (/^(BUTTON)$/.test(t && t.tagName) && (k === 'Enter' || k === ' ')) return;
      if (/^Arrow/.test(k) && !this._selCount()) return;
      e.preventDefault();
      act();
    }

    // -------------------------------------------------------------- rendering
    draw() {
      if (this._raf || this._destroyed) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this._paint(); });
    }
    _colors() {
      if (this._C) return this._C;
      const cs = getComputedStyle(this.root), v = n => cs.getPropertyValue(n).trim();
      const C = { paper: v('--sch-paper') || '#fbfaf5', wire: v('--sch-wire') || '#13804a', body: v('--sch-body') || '#8a2a20', fill: v('--sch-fill') || '#fff4d4',
        pin: v('--sch-pin') || '#8a2a20', pinname: v('--sch-pinname') || '#146a6a', ref: v('--sch-ref') || '#146a6a', text: v('--sch-text') || '#222', nc: v('--sch-nc') || '#2350b8',
        label: v('--sch-label') || '#1b1b1b', accent: v('--accent') || '#0e7656', info: v('--info') || '#3462ad', probe: v('--probe') || PROBE, fail: v('--fail') || '#bf3727' };
      C.grid = mix(C.text, C.paper, 0.24);
      C.selFill = rgba(C.info, 0.1); C.selLine = C.info;
      C.probeFill = rgba(PROBE, 0.3);
      this._C = C;
      return C;
    }
    _text(ctx, t, color, weight) {
      if (t.size * this.view.s < 2.4) return;
      const font = `${weight || 400} ${t.size * 1.3}px ${FONT}`, align = t.h === 'left' ? 'left' : t.h === 'right' ? 'right' : 'center';
      const base = t.v === 'top' ? 'top' : t.v === 'bottom' ? 'alphabetic' : 'middle';
      if (ctx.font !== font) ctx.font = font;
      if (ctx.textAlign !== align) ctx.textAlign = align;
      if (ctx.textBaseline !== base) ctx.textBaseline = base;
      ctx.fillStyle = color;
      const str = t.str.indexOf('~{') >= 0 ? String(t.str).replace(/~\{([^}]*)\}/g, '$1') : t.str;
      if (!t.ang) { ctx.fillText(str, t.x, t.y); return; }
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(-t.ang * Math.PI / 180);
      ctx.fillText(str, 0, 0);
      ctx.restore();
    }
    _paintGrid(ctx, C, dpr) {
      const { s, ox, oy } = this.view;
      let step = 1;
      while (step * G * s < 9) step *= 2;
      const sp = step * G * s, W = this.canvas.width / dpr, H = this.canvas.height / dpr;
      const k0 = Math.ceil(-ox / sp), k1 = Math.floor((W - ox) / sp), j0 = Math.ceil(-oy / sp), j1 = Math.floor((H - oy) / sp);
      if ((k1 - k0 + 1) * (j1 - j0 + 1) > 60000) return;
      const r = Math.max(1, Math.round(dpr * 1.25));
      ctx.fillStyle = C.grid;
      ctx.beginPath();
      for (let kx = k0; kx <= k1; kx++) {
        const x = Math.round((ox + kx * sp) * dpr) - (r >> 1);
        for (let ky = j0; ky <= j1; ky++) ctx.rect(x, Math.round((oy + ky * sp) * dpr) - (r >> 1), r, r);
      }
      ctx.fill();
    }
    _paintPart(ctx, C, pg, px, alpha) {
      const paths = symPaths(pg.info);
      ctx.save();
      if (alpha < 1) ctx.globalAlpha = alpha;
      ctx.transform(pg.M[0], pg.M[2], pg.M[1], pg.M[3], pg.ox, pg.oy);
      for (const g of paths) {
        if (g.fill === 'background') { ctx.fillStyle = C.fill; ctx.fill(g.p); }
        else if (g.fill === 'outline') { ctx.fillStyle = C.body; ctx.fill(g.p); }
        ctx.strokeStyle = C.body; ctx.lineWidth = Math.max(g.w || 0.16, px * 0.9);
        ctx.stroke(g.p);
      }
      ctx.restore();
      ctx.save();
      if (alpha < 1) ctx.globalAlpha = alpha;
      ctx.strokeStyle = C.pin; ctx.lineWidth = Math.max(0.16, px * 0.9);
      ctx.beginPath();
      for (const q of pg.pins) if (!q.hidden) { ctx.moveTo(q.S[0], q.S[1]); ctx.lineTo(q.E[0], q.E[1]); }
      ctx.stroke();
      for (const t of pg.texts) {
        const col = t.kind === 'ref' || t.kind === 'val' ? C.ref : t.kind === 'pinname' ? C.pinname : t.kind === 'pinnum' ? C.pin : C.text;
        this._text(ctx, t, col, t.kind === 'ref' ? 600 : 400);
      }
      ctx.restore();
    }
    _paintPower(ctx, C, pw, px, alpha) {
      ctx.save();
      if (alpha < 1) ctx.globalAlpha = alpha;
      ctx.save();
      ctx.transform(pw.M[0], pw.M[2], pw.M[1], pw.M[3], pw.ox, pw.oy);
      for (const g of symPaths(pw.info)) {
        if (g.fill === 'outline') { ctx.fillStyle = C.body; ctx.fill(g.p); }
        ctx.strokeStyle = C.body; ctx.lineWidth = Math.max(g.w || 0.16, px * 0.9);
        ctx.stroke(g.p);
      }
      ctx.restore();
      this._text(ctx, pw.text, C.ref, 500);
      ctx.restore();
    }
    _paintLabel(ctx, C, lg, px, alpha, probe) {
      ctx.save();
      if (alpha < 1) ctx.globalAlpha = alpha;
      if (lg.poly) {
        ctx.beginPath();
        lg.poly.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
        ctx.closePath();
        if (probe) { ctx.fillStyle = C.probeFill; ctx.fill(); }
        ctx.strokeStyle = C.label; ctx.lineWidth = Math.max(0.16, px); ctx.stroke();
      } else if (probe) { const b = lg.bb; ctx.fillStyle = C.probeFill; ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); }
      this._text(ctx, { str: lg.txt, x: lg.tx, y: lg.ty, size: lg.size, ang: lg.ang, h: lg.h, v: lg.v }, C.label, 500);
      ctx.restore();
    }
    _ghost() {
      const pl = this.placing;
      if (this.mode !== 'place' || !pl || !this.cursor || (this.drag && this.drag.kind !== 'tap')) return null;
      const t = this._target(this.cursor, pl.kind === 'part');
      if (pl.kind === 'part') { const p = Object.assign(newPart(pl.item.type, pl.item.tpl), { id: '_ghost', ref: this._nextRef((TYPES[pl.item.type] || TYPES.other).prefix), x: t.x, y: t.y, rot: pl.rot || 0, mirror: !!pl.mirror }); return { kind: 'part', g: partGeo(p), t }; }
      if (pl.kind === 'label') return { kind: 'label', g: labelGeo({ name: this._nextLabelName(), x: t.x, y: t.y, rot: !pl.userRot && t.dir ? labelRot(t.dir) : pl.rot || 0, port: '' }), t };
      if (pl.kind === 'power') { const style = pl.ground ? 'gnd' : E1().powerStyle(pl.name); return { kind: 'power', g: powerGeo({ name: pl.name, x: t.x, y: t.y, style, rot: !pl.userRot && t.dir ? powerRot(style, t.dir) : pl.rot || 0 }), t }; }
      return { kind: 'nc', t };
    }
    _paint() {
      if (this._destroyed || !this.canvas.width) return;
      const ctx = this.ctx, dpr = this.dpr || 1, C = this._colors();
      const cw = this.canvas.width, ch = this.canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.paper; ctx.fillRect(0, 0, cw, ch);
      this._paintGrid(ctx, C, dpr);
      const { s, ox, oy } = this.view, px = 1 / s;
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const vis = [-ox / s - 4, -oy / s - 4, (cw / dpr - ox) / s + 4, (ch / dpr - oy) / s + 4];
      const doc = this.doc, g = this.geo, cn = this._conn(), sel = this.sel;
      // probe highlight (net traced by a wire click or by the app)
      const hn = [];
      if (this.netSel) { const n = cn.netOf(this.netSel); if (n) hn.push(n); }
      if (this.hl.net) for (const n of cn.byName(this.hl.net)) if (!hn.includes(n)) hn.push(n);
      const probeLabels = new Set();
      if (hn.length) {
        ctx.strokeStyle = C.probeFill; ctx.lineWidth = Math.max(0.9, px * 7);
        ctx.beginPath();
        for (const n of hn) for (const i of n.wires) { const w = doc.wires[i]; ctx.moveTo(w[0] * G, w[1] * G); ctx.lineTo(w[2] * G, w[3] * G); }
        ctx.stroke();
        for (const n of hn) n.labels.forEach(id => probeLabels.add(id));
      }
      // wires
      ctx.strokeStyle = C.wire; ctx.lineWidth = Math.max(0.16, px * 1.15);
      ctx.beginPath();
      for (const w of doc.wires) { ctx.moveTo(w[0] * G, w[1] * G); ctx.lineTo(w[2] * G, w[3] * G); }
      ctx.stroke();
      if (sel.wires.size) {
        ctx.strokeStyle = C.selLine; ctx.lineWidth = Math.max(0.3, px * 2.6);
        ctx.beginPath();
        for (const i of sel.wires) { const w = doc.wires[i]; if (w) { ctx.moveTo(w[0] * G, w[1] * G); ctx.lineTo(w[2] * G, w[3] * G); } }
        ctx.stroke();
      }
      // junction dots and dangling ends
      ctx.fillStyle = C.wire;
      const dangling = [], openPins = [];
      for (const e of g.pts.values()) {
        const n = e.ends.length + e.pins.length + e.power.length;
        if (e.ends.length && n >= 3) { ctx.beginPath(); ctx.arc(e.x * G, e.y * G, 0.46, 0, Math.PI * 2); ctx.fill(); }
        if (e.ends.length === 1 && n === 1 && !e.labels.length && !e.nc.length && wireThrough(doc, g, e.x, e.y) < 0) dangling.push(e);
        if (e.pins.length === 1 && !e.ends.length && !e.labels.length && !e.power.length && !e.nc.length) openPins.push(e);
      }
      // external part highlight (probe) and selection halos
      for (const pg of g.parts.values()) {
        const on = sel.parts.has(pg.p.id), probe = this.hl.refs.has(pg.p.ref);
        if (!on && !probe) continue;
        const b = pg.bb, m = 0.9;
        ctx.fillStyle = probe ? C.probeFill : C.selFill;
        ctx.fillRect(b[0] - m, b[1] - m, b[2] - b[0] + 2 * m, b[3] - b[1] + 2 * m);
        ctx.strokeStyle = probe && !on ? PROBE : C.selLine; ctx.lineWidth = Math.max(0.2, px * 1.4);
        ctx.setLineDash([1, 0.6]);
        ctx.strokeRect(b[0] - m, b[1] - m, b[2] - b[0] + 2 * m, b[3] - b[1] + 2 * m);
        ctx.setLineDash([]);
      }
      for (const pw of g.power.values()) if (sel.power.has(pw.w.id)) { const b = pw.hit; ctx.fillStyle = C.selFill; ctx.fillRect(b[0] - 0.5, b[1] - 0.5, b[2] - b[0] + 1, b[3] - b[1] + 1); ctx.strokeStyle = C.selLine; ctx.lineWidth = Math.max(0.2, px * 1.4); ctx.strokeRect(b[0] - 0.5, b[1] - 0.5, b[2] - b[0] + 1, b[3] - b[1] + 1); }
      for (const lg of g.labels.values()) if (sel.labels.has(lg.l.id)) { const b = lg.hit; ctx.fillStyle = C.selFill; ctx.fillRect(b[0] - 0.4, b[1] - 0.4, b[2] - b[0] + 0.8, b[3] - b[1] + 0.8); ctx.strokeStyle = C.selLine; ctx.lineWidth = Math.max(0.2, px * 1.4); ctx.strokeRect(b[0] - 0.4, b[1] - 0.4, b[2] - b[0] + 0.8, b[3] - b[1] + 0.8); }
      // parts, power ports, labels
      for (const pg of g.parts.values()) if (overlaps(pg.hit, vis)) this._paintPart(ctx, C, pg, px, pg.p.dnp ? 0.45 : 1);
      for (const pw of g.power.values()) if (overlaps(pw.hit, vis)) this._paintPower(ctx, C, pw, px, 1);
      for (const lg of g.labels.values()) if (overlaps(lg.hit, vis)) this._paintLabel(ctx, C, lg, px, 1, probeLabels.has(lg.l.id));
      // pins on the traced net
      if (hn.length) {
        ctx.fillStyle = PROBE;
        for (const n of hn) for (const [pid, i] of n.pins) { const q = g.parts.get(pid).pins[i]; ctx.beginPath(); ctx.arc(q.x * G, q.y * G, 0.55, 0, Math.PI * 2); ctx.fill(); }
      }
      // no-connect markers
      doc.nc.forEach((n, i) => {
        const x = n[0] * G, y = n[1] * G, r = 0.64;
        ctx.strokeStyle = sel.nc.has(i) ? C.selLine : C.nc; ctx.lineWidth = Math.max(0.16, px * (sel.nc.has(i) ? 2 : 1.1));
        ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
      });
      // KiCad-style open-end markers
      if (s > 2.2) {
        ctx.lineWidth = Math.max(0.1, px);
        ctx.strokeStyle = C.wire;
        for (const e of dangling) ctx.strokeRect(e.x * G - 0.32, e.y * G - 0.32, 0.64, 0.64);
        ctx.strokeStyle = C.pin;
        for (const e of openPins) { ctx.beginPath(); ctx.arc(e.x * G, e.y * G, 0.3, 0, Math.PI * 2); ctx.stroke(); }
      }
      // location picked from the check list
      if (this._flash) {
        const [fx, fy] = this._flash;
        ctx.strokeStyle = PROBE; ctx.lineWidth = Math.max(0.3, px * 2.5);
        ctx.beginPath(); ctx.arc(fx * G, fy * G, Math.max(1.6, 14 * px), 0, Math.PI * 2); ctx.stroke();
      }
      // hovered pin
      if (this.hover && this.hover.kind === 'pin') {
        ctx.strokeStyle = C.accent; ctx.lineWidth = Math.max(0.2, px * 2);
        ctx.beginPath(); ctx.arc(this.hover.x * G, this.hover.y * G, Math.max(0.7, 6 * px), 0, Math.PI * 2); ctx.stroke();
      }
      // wire in progress
      if (this.mode === 'wire' && this.wire) {
        const pts = this.wire.pts.slice();
        if (this.cursor && (!this.drag || this.drag.kind === 'wiretap' || this.drag.kind === 'tap')) {
          const t = this._target(this.cursor);
          pts.push(...this._route(pts[pts.length - 1], [t.x, t.y], t.kind === 'pin' ? t.dir : null));
        }
        ctx.strokeStyle = C.wire; ctx.lineWidth = Math.max(0.2, px * 1.6);
        ctx.beginPath();
        pts.forEach((q, i) => (i ? ctx.lineTo(q[0] * G, q[1] * G) : ctx.moveTo(q[0] * G, q[1] * G)));
        ctx.stroke();
        ctx.fillStyle = C.wire;
        ctx.beginPath(); ctx.arc(pts[0][0] * G, pts[0][1] * G, Math.max(0.35, 2.5 * px), 0, Math.PI * 2); ctx.fill();
      }
      // placement ghost
      const gh = this._ghost();
      if (gh) {
        if (gh.kind === 'part') this._paintPart(ctx, C, gh.g, px, 0.55);
        else if (gh.kind === 'power') this._paintPower(ctx, C, gh.g, px, 0.55);
        else if (gh.kind === 'label') this._paintLabel(ctx, C, gh.g, px, 0.55, false);
        else { const x = gh.t.x * G, y = gh.t.y * G, r = 0.64; ctx.globalAlpha = 0.6; ctx.strokeStyle = C.nc; ctx.lineWidth = Math.max(0.16, px * 1.2); ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke(); ctx.globalAlpha = 1; }
      }
      // cross-hair at the snapped cursor while drawing
      if ((this.mode === 'wire' || this.mode === 'place') && this.cursor && !gh) {
        const t = this._target(this.cursor), x = t.x * G, y = t.y * G, r = 5 * px;
        ctx.strokeStyle = C.accent; ctx.lineWidth = px * 1.2;
        ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
      }
      // rubber-band box
      const d = this.drag;
      if (d && d.kind === 'box' && d.moved > 3) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const x = Math.min(d.start[0], d.cur[0]), y = Math.min(d.start[1], d.cur[1]), w = Math.abs(d.cur[0] - d.start[0]), h = Math.abs(d.cur[1] - d.start[1]);
        ctx.fillStyle = rgba(C.info, 0.07); ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = C.info; ctx.lineWidth = 1;
        if (d.cur[0] < d.start[0]) ctx.setLineDash([5, 4]);
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        ctx.setLineDash([]);
      }
    }

    // -------------------------------------------------------------- inspector
    _part(id) { return this.doc.parts.find(p => p.id === id); }
    _editPart(id, fn, opts = {}) {
      return this._edit(() => (this._part(id) ? regen(this.doc, this.geo, id, fn, !!opts.anchor) : false), { key: opts.key });
    }
    _selSig() { const s = this.sel; return [this.readOnly, [...s.parts], [...s.power], [...s.labels], [...s.wires], [...s.nc]].join('|'); }
    _renderInsp(force) {
      const sig = this._selSig();
      if (!force && sig === this._inspSig && this.inspBody.contains(document.activeElement)) { this._binders.forEach(f => f()); this._inspHeadSync(); return; }
      this._inspSig = sig;
      this._binders = [];
      const body = this.inspBody;
      body.innerHTML = '';
      const s = this.sel, n = this._selCount();
      if (n === 1 && s.parts.size) body.append(...this._inspPart(this._part([...s.parts][0])));
      else if (n === 1 && s.labels.size) body.append(...this._inspLabel(this.doc.labels.find(l => l.id === [...s.labels][0])));
      else if (n === 1 && s.power.size) body.append(...this._inspPower(this.doc.power.find(w => w.id === [...s.power][0])));
      else if (n && s.wires.size + s.nc.size === n) body.append(...this._inspWires());
      else if (n) body.append(...this._inspMulti());
      else body.append(...this._inspNone());
      this._inspHeadSync();
    }
    _inspHeadSync() {
      const s = this.sel, n = this._selCount();
      let t = 'Drawing · ' + this.doc.parts.length + ' part' + (this.doc.parts.length === 1 ? '' : 's');
      if (n === 1 && s.parts.size) { const p = this._part([...s.parts][0]); if (p) t = (p.ref || '?') + (p.value ? ' · ' + p.value : '') + ' · ' + (TYPES[p.type] || TYPES.other).name; }
      else if (n === 1 && s.labels.size) { const l = this.doc.labels.find(x => x.id === [...s.labels][0]); if (l) t = 'Label · ' + l.name; }
      else if (n === 1 && s.power.size) { const w = this.doc.power.find(x => x.id === [...s.power][0]); if (w) t = 'Power port · ' + w.name; }
      else if (n) t = n + ' items selected';
      this.inspHeadText.textContent = t;
    }
    _focusField(f) {
      this._renderInsp(true);
      if (this.root.classList.contains('se--narrow')) this._toggleSheet(true);
      const inp = this.inspBody.querySelector(`[data-f="${f}"]`);
      if (inp) { inp.focus({ preventScroll: true }); if (inp.select) inp.select(); }
    }
    _backToCanvas(exitPlace) {
      this._lastKey = null;
      if (exitPlace && this.mode !== 'select') this.setMode('select');
      this.canvas.focus({ preventScroll: true });
    }
    _inp(key, get, set, o = {}) {
      const inp = N.el('input', { class: 'input small' + (o.mono ? ' mono' : ''), type: o.type || 'text', placeholder: o.ph || '', spellcheck: 'false', autocomplete: 'off',
        dataset: { f: key }, disabled: this.readOnly, list: o.list, min: o.min, max: o.max, 'aria-label': o.label || key });
      inp.value = get();
      inp.addEventListener(o.live ? 'input' : 'change', () => set(inp.value, inp));
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); this._backToCanvas(false); }
        else if (e.key === 'Escape') { e.preventDefault(); if (!o.live) inp.value = get(); inp.blur(); this._backToCanvas(true); }
      });
      inp.addEventListener('blur', () => { this._lastKey = null; });
      this._binders.push(() => { if (document.activeElement !== inp) inp.value = get(); });
      return inp;
    }
    _select_(key, options, get, set, label) {
      const s = N.el('select', { class: 'input small', dataset: { f: key }, disabled: this.readOnly, 'aria-label': label || key });
      for (const [v, l] of options) s.append(N.el('option', { value: v }, l));
      s.value = get();
      s.addEventListener('change', () => set(s.value));
      this._binders.push(() => { if (document.activeElement !== s) s.value = get(); });
      return s;
    }
    _fld(label, ctrl, cls) { return N.el('label', { class: 'se-f' + (cls ? ' ' + cls : '') }, N.el('span', { class: 'se-fl' }, label), ctrl); }
    _acts(list) {
      if (this.readOnly) return N.el('div');
      return N.el('div', { class: 'se-acts' }, ...list.map(([icon, label, fn]) => N.el('button', { class: 'btn tiny', type: 'button', onclick: fn }, N.svg(icon), label)));
    }
    _stdActs(mirror) {
      const a = [[ICONS.rotate, 'Rotate', () => this.rotate()]];
      if (mirror) a.push([NI().flip || ICONS.rotate, 'Mirror', () => this.mirror()]);
      a.push([NI().trash || ICONS.minus, 'Delete', () => this.deleteSelection()]);
      return this._acts(a);
    }
    _pkgCtrl(p) {
      const el = N.el, T = TYPES[p.type] || TYPES.other, id = p.id;
      const cur = () => (this._part(id) || {}).package || '';
      const sel = el('select', { class: 'input small', dataset: { f: 'package' }, disabled: this.readOnly, 'aria-label': 'Package' });
      const custom = el('input', { class: 'input small se-pkg-c', placeholder: 'Package, e.g. SOIC-8', hidden: true, spellcheck: 'false', 'aria-label': 'Custom package' });
      const fill = () => {
        const c = cur(), opts = (T.pkgs || []).slice();
        sel.innerHTML = '';
        if (!c) sel.append(el('option', { value: '' }, '—'));
        if (c && !opts.includes(c)) opts.unshift(c);
        for (const o of opts) sel.append(el('option', { value: o }, o));
        sel.append(el('option', { value: '\u0000' }, 'Custom…'));
        sel.value = c;
      };
      const setPkg = v => this._editPart(id, q => {
        const auto = QTYPES[q.type] && qOrder(q) === qDefault(q.type, q.package);
        q.package = v.trim();
        if (auto) q.sym = 'Q_' + QTYPES[q.type] + '_' + qDefault(q.type, q.package);
      });
      fill();
      sel.addEventListener('change', () => {
        if (sel.value === '\u0000') { custom.hidden = false; custom.value = cur(); custom.focus(); custom.select(); fill(); return; }
        setPkg(sel.value); fill();
      });
      custom.addEventListener('change', () => { setPkg(custom.value); custom.hidden = true; fill(); });
      custom.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); custom.blur(); } if (e.key === 'Escape') { custom.hidden = true; fill(); this._backToCanvas(false); } });
      this._binders.push(() => { if (document.activeElement !== sel) fill(); });
      return el('div', { class: 'se-pkg' }, sel, custom);
    }
    _inspPart(p) {
      const el = N.el, T = TYPES[p.type] || TYPES.other, id = p.id, pg = this.geo.parts.get(id), cn = this._conn();
      const get = k => () => { const q = this._part(id); return q ? S(q[k]) : ''; };
      const out = [];
      out.push(el('div', { class: 'se-sec se-head' },
        el('div', { class: 'se-head-l' }, el('div', { class: 'se-ref' }, p.ref || '?'), el('div', { class: 'eyebrow' }, T.name + (p.tpl ? ' · template' : ''))),
        el('span', { class: 'se-head-th', html: (() => { try { return thumbSVG(pg.info, 40); } catch (e) { return ''; } })() })));
      const f = el('div', { class: 'se-sec' });
      const refInp = this._inp('ref', get('ref'), (v, inp) => {
        v = v.trim().replace(/\s+/g, '').toUpperCase();
        const q = this._part(id);
        if (!q) return;
        if (!v) { N.toast && N.toast('A reference cannot be empty'); inp.value = q.ref; return; }
        if (this.doc.parts.some(x => x.id !== id && x.ref === v)) { N.toast && N.toast(v + ' is already used by another part', 'warn'); inp.value = q.ref; return; }
        this._editPart(id, x => { x.ref = v; });
        this._renderInsp(true);
      }, { mono: true, label: 'Reference' });
      const valInp = this._inp('value', get('value'), v => this._editPart(id, q => { q.value = v; }, { key: 'value:' + id }), { live: true, ph: T.ph[0], label: 'Value' });
      f.append(el('div', { class: 'se-row2 se-row-rv' }, this._fld('Reference', refInp), this._fld('Value', valInp)));
      f.append(this._fld('Package', this._pkgCtrl(p)));
      if (QTYPES[p.type]) {
        const opts = qOrders(p.type).map(o => [o, o.split('').join('-') + '  (pins 1-2-3)']);
        f.append(this._fld('Pin order', this._select_('sym', opts, () => { const q = this._part(id); return q ? qOrder(q) : ''; },
          v => this._editPart(id, q => { q.sym = 'Q_' + QTYPES[q.type] + '_' + v; }), 'Pin order')));
      }
      if (p.type === 'connector' && !connTable(p)) {
        f.append(this._fld('Pins', this._inp('n', () => { const q = this._part(id); return q ? String(connN(q)) : ''; }, (v, inp) => {
          const n = Math.max(1, Math.min(40, Math.round(+v) || 1));
          inp.value = n;
          this._editPart(id, q => {
            const old = connN(q), pad = x => 'Conn_01x' + String(x).padStart(2, '0');
            q.n = n;
            if (!q.value || q.value === pad(old)) q.value = pad(n);
          }, { anchor: true });
        }, { type: 'number', min: 1, max: 40, label: 'Pin count' })));
      }
      f.append(this._fld('MPN', this._inp('mpn', get('mpn'), v => this._editPart(id, q => { q.mpn = v; }, { key: 'mpn:' + id }), { live: true, ph: 'Manufacturer part number', label: 'MPN' })));
      f.append(el('div', { class: 'se-row2' },
        this._fld('Rating', this._inp('rating', get('rating'), v => this._editPart(id, q => { q.rating = v; }, { key: 'rating:' + id }), { live: true, ph: T.ph[1], label: 'Rating' })),
        this._fld('Tolerance', this._inp('tolerance', get('tolerance'), v => this._editPart(id, q => { q.tolerance = v; }, { key: 'tol:' + id }), { live: true, ph: T.ph[2], label: 'Tolerance' }))));
      const dnp = el('input', { type: 'checkbox', dataset: { f: 'dnp' }, disabled: this.readOnly });
      dnp.checked = !!p.dnp;
      dnp.addEventListener('change', () => this._editPart(id, q => { q.dnp = dnp.checked; }));
      this._binders.push(() => { const q = this._part(id); if (q) dnp.checked = !!q.dnp; });
      f.append(el('label', { class: 'se-check' }, dnp, el('span', null, 'Do not populate (DNP)')));
      out.push(f);
      if (IC_LIKE.has(p.type) || connTable(p)) out.push(this._pinTable(p));
      else {
        const list = el('div', { class: 'se-conns' });
        for (const q of pg.pins) {
          const k = K(q.x, q.y), n = cn.netOf(k), ok = pinConnected(n), nc = this.doc.nc.some(c => c[0] === q.x && c[1] === q.y);
          list.append(el('button', { class: 'se-conn', type: 'button', title: ok ? 'Trace this net' : '', onclick: () => { if (ok) { this.netSel = k; this._status(); this.draw(); } } },
            el('span', { class: 'se-conn-p mono' }, q.id), el('span', { class: 'se-conn-n' + (ok ? '' : ' muted') }, ok ? (n.name || 'unnamed net') : nc ? 'no-connect' : 'not connected')));
        }
        out.push(el('div', { class: 'se-sec' }, el('div', { class: 'eyebrow' }, 'Connections'), list));
      }
      out.push(el('div', { class: 'se-sec se-last' }, this._stdActs(true)));
      return out;
    }
    _pinTable(p) {
      const el = N.el, id = p.id;
      const cur = () => this._part(id);
      const setPin = (i, k, v, inp) => {
        const q = cur();
        if (!q || !q.pins[i]) return;
        if (k === 'number') {
          v = v.trim();
          if (!v || q.pins.some((x, j) => j !== i && x.number === v)) { N.toast && N.toast(v ? 'Pin ' + v + ' already exists' : 'A pin needs a number', 'warn'); if (inp) inp.value = q.pins[i].number; return; }
        }
        this._editPart(id, x => { x.pins[i][k] = v; }, { anchor: true });
      };
      const tbody = el('tbody');
      (p.pins || []).forEach((q, i) => {
        const pinGet = k => () => { const x = cur(); return x && x.pins[i] ? S(x.pins[i][k]) : ''; };
        const num = this._inp('pin-num-' + i, pinGet('number'), (v, inp) => setPin(i, 'number', v, inp), { mono: true, label: 'Pin number' });
        const name = this._inp('pin-name-' + i, pinGet('name'), v => setPin(i, 'name', v.trim()), { label: 'Pin name', ph: 'name' });
        const et = this._select_('pin-et-' + i, ETYPES, pinGet('etype'), v => setPin(i, 'etype', v), 'Electrical type');
        const side = this._select_('pin-side-' + i, SIDES, pinGet('side'), v => setPin(i, 'side', v), 'Side');
        const rm = this.readOnly ? el('span') : el('button', { class: 'icon-btn small', type: 'button', title: 'Remove pin', 'aria-label': 'Remove pin', onclick: () => {
          this._editPart(id, x => { x.pins.splice(i, 1); }, { anchor: true }); this._renderInsp(true);
        } }, N.svg(NI().close || ICONS.minus));
        tbody.append(el('tr', null, el('td', { class: 'se-pt-num' }, num), el('td', null, name), el('td', null, et), el('td', null, side), el('td', { class: 'se-pt-x' }, rm)));
      });
      const add = this.readOnly ? null : el('button', { class: 'btn tiny', type: 'button', onclick: () => {
        this._editPart(id, x => {
          const nums = x.pins.map(q => parseInt(q.number, 10)).filter(v => Number.isFinite(v));
          let n = (nums.length ? Math.max(...nums) : 0) + 1;
          while (x.pins.some(q => q.number === String(n))) n++;
          x.pins.push({ number: String(n), name: '', etype: 'passive', side: '' });
        }, { anchor: true });
        this._renderInsp(true);
        const inp = this.inspBody.querySelector(`[data-f="pin-name-${(cur().pins || []).length - 1}"]`);
        if (inp) inp.focus();
      } }, N.svg(ICONS.plus), 'Add pin');
      return el('div', { class: 'se-sec' },
        el('div', { class: 'se-pt-h' }, el('span', { class: 'eyebrow' }, 'Pins · ' + (p.pins || []).length), add),
        el('div', { class: 'se-pt-wrap' }, el('table', { class: 'se-pt' },
          el('thead', null, el('tr', null, el('th', null, '#'), el('th', null, 'Name'), el('th', null, 'Type'), el('th', null, 'Side'), el('th'))), tbody)));
    }
    _netInfo(n) {
      const el = N.el;
      if (!n) return el('div', { class: 'muted small' }, 'Not connected to anything yet.');
      const pins = [...new Set(n.pins.map(([pid, i]) => { const pg = this.geo.parts.get(pid); return (pg.p.ref || '?') + '.' + pg.pins[i].id; }))].sort(refCmp);
      return el('div', { class: 'se-net-info' },
        el('div', { class: 'se-net-name' }, el('b', null, n.name || 'Unnamed net'), el('span', { class: 'tag' + (n.kind !== 'signal' ? ' pwr' : '') }, n.kind)),
        n.names.length > 1 ? el('div', { class: 'err' }, 'Shorted: ' + n.names.join(' + ')) : null,
        pins.length ? el('div', { class: 'se-chips' }, ...pins.map(t => el('span', { class: 'probe-chip ref static' }, t))) : el('div', { class: 'muted small' }, 'No pins on this net yet.'));
    }
    _inspLabel(l) {
      const el = N.el, id = l.id, get = () => { const x = this.doc.labels.find(q => q.id === id); return x ? x.name : ''; };
      const name = this._inp('name', get, v => { v = v.trim(); if (!v) return; this._edit(d => { const x = d.labels.find(q => q.id === id); if (!x || x.name === v) return false; x.name = v; }, { key: 'lname:' + id }); }, { live: true, mono: true, label: 'Net name' });
      const port = this._select_('port', PORTS, () => { const x = this.doc.labels.find(q => q.id === id); return x ? x.port : ''; },
        v => this._edit(d => { const x = d.labels.find(q => q.id === id); if (x) x.port = v; }), 'Port direction');
      return [
        el('div', { class: 'se-sec se-head' }, el('div', { class: 'se-head-l' }, el('div', { class: 'se-ref mono' }, l.name), el('div', { class: 'eyebrow' }, l.port ? 'Port label' : 'Net label'))),
        el('div', { class: 'se-sec' }, this._fld('Net name', name), this._fld('Port', port),
          el('p', { class: 'se-help' }, 'Labels with the same name are connected. A port direction draws it as a pointed port and marks the net as an input or output of the design.')),
        el('div', { class: 'se-sec' }, el('div', { class: 'eyebrow' }, 'Net'), this._netInfo(this._conn().netOf(K(l.x, l.y)))),
        el('div', { class: 'se-sec se-last' }, this._stdActs(false)),
      ];
    }
    _inspPower(w) {
      const el = N.el, id = w.id, find = () => this.doc.power.find(q => q.id === id);
      const dl = el('datalist', { id: 'se-pw-' + id }, ...POWER_NAMES.map(n => el('option', { value: n })));
      const name = this._inp('name', () => (find() || {}).name || '', v => {
        v = v.trim();
        if (!v) return;
        this._edit(d => { const x = d.power.find(q => q.id === id); if (!x || x.name === v) return false; const auto = x.style === E1().powerStyle(x.name); x.name = v; if (auto) x.style = E1().powerStyle(v); }, { key: 'pname:' + id });
        if (!DS().isGroundName(v)) this._lastPower = v;
      }, { live: true, mono: true, list: dl.id, label: 'Net name' });
      const style = this._select_('style', [['up', 'Supply arrow'], ['gnd', 'Ground'], ['down', 'Negative rail']], () => (find() || {}).style || 'up',
        v => this._edit(d => { const x = d.power.find(q => q.id === id); if (x) x.style = v; }), 'Symbol');
      return [
        el('div', { class: 'se-sec se-head' }, el('div', { class: 'se-head-l' }, el('div', { class: 'se-ref mono' }, w.name), el('div', { class: 'eyebrow' }, DS().isGroundName(w.name) ? 'Ground port' : 'Power port'))),
        el('div', { class: 'se-sec' }, this._fld('Net name', name), dl, this._fld('Symbol', style),
          el('p', { class: 'se-help' }, 'Every power port with the same name is one net, e.g. all GND symbols.')),
        el('div', { class: 'se-sec' }, el('div', { class: 'eyebrow' }, 'Net'), this._netInfo(this._conn().netOf(K(w.x, w.y)))),
        el('div', { class: 'se-sec se-last' }, this._stdActs(false)),
      ];
    }
    _inspWires() {
      const el = N.el, s = this.sel, cn = this._conn();
      const nets = new Set();
      for (const i of s.wires) { const w = this.doc.wires[i]; if (w) nets.add(cn.netOf(K(w[0], w[1]))); }
      const n = nets.size === 1 ? [...nets][0] : null;
      const title = s.nc.size && !s.wires.size ? 'No-connect marker' : s.wires.size === 1 ? 'Wire' : s.wires.size + ' wire segments';
      return [
        el('div', { class: 'se-sec se-head' }, el('div', { class: 'se-head-l' }, el('div', { class: 'se-ref' }, title), el('div', { class: 'eyebrow' }, s.wires.size ? 'Connection' : 'Marks a pin as intentionally unused'))),
        s.wires.size ? el('div', { class: 'se-sec' }, el('div', { class: 'eyebrow' }, nets.size > 1 ? nets.size + ' nets' : 'Net'), nets.size > 1 ? el('div', { class: 'muted small' }, 'The selection spans several nets.') : this._netInfo(n)) : null,
        el('div', { class: 'se-sec se-last' }, this._acts([[NI().trash || ICONS.minus, 'Delete', () => this.deleteSelection()]])),
      ].filter(Boolean);
    }
    _inspMulti() {
      const el = N.el, s = this.sel, bits = [];
      if (s.parts.size) bits.push(s.parts.size + ' part' + (s.parts.size === 1 ? '' : 's'));
      if (s.wires.size) bits.push(s.wires.size + ' wire' + (s.wires.size === 1 ? '' : 's'));
      if (s.labels.size) bits.push(s.labels.size + ' label' + (s.labels.size === 1 ? '' : 's'));
      if (s.power.size) bits.push(s.power.size + ' power port' + (s.power.size === 1 ? '' : 's'));
      if (s.nc.size) bits.push(s.nc.size + ' no-connect' + (s.nc.size === 1 ? '' : 's'));
      const refs = this.doc.parts.filter(p => s.parts.has(p.id)).map(p => p.ref).sort(refCmp);
      return [
        el('div', { class: 'se-sec se-head' }, el('div', { class: 'se-head-l' }, el('div', { class: 'se-ref' }, this._selCount() + ' selected'), el('div', { class: 'eyebrow' }, bits.join(' · ')))),
        refs.length ? el('div', { class: 'se-sec' }, el('div', { class: 'se-chips' }, ...refs.slice(0, 40).map(r => el('span', { class: 'probe-chip ref static' }, r)))) : null,
        el('div', { class: 'se-sec se-last' }, this.readOnly ? null : this._acts([[ICONS.rotate, 'Rotate', () => this.rotate()], [NI().flip || ICONS.rotate, 'Mirror', () => this.mirror()],
          [NI().copy || ICONS.plus, 'Duplicate', () => this.duplicate()], [NI().trash || ICONS.minus, 'Delete', () => this.deleteSelection()]])),
      ].filter(Boolean);
    }
    _inspNone() {
      const el = N.el, d = this.doc, cn = this._conn();
      const nets = cn.nets.filter(n => n.pins.length && (n.pins.length > 1 || n.names.length)).length;
      const title = this._inp('title', () => this.doc.title || '', v => this._edit(x => { x.title = v; }, { key: 'title' }), { live: true, ph: 'Untitled circuit', label: 'Title' });
      const kb = (keys, what) => el('div', { class: 'se-kb' }, el('span', { class: 'se-kb-k' }, ...keys.map(k => el('kbd', { class: 'se-kbd' }, k))), el('span', null, what));
      return [
        el('div', { class: 'se-sec se-head' }, el('div', { class: 'se-head-l' }, el('div', { class: 'se-ref' }, 'Drawing'), el('div', { class: 'eyebrow' }, 'Nothing selected'))),
        el('div', { class: 'se-sec' }, this._fld('Title', title),
          el('div', { class: 'se-stats' },
            el('div', null, el('b', { class: 'num' }, String(d.parts.length)), el('span', null, 'parts')),
            el('div', null, el('b', { class: 'num' }, String(nets)), el('span', null, 'nets')),
            el('div', null, el('b', { class: 'num' }, String(d.wires.length)), el('span', null, 'wires')))),
        this.readOnly ? el('div', { class: 'se-sec' }, el('p', { class: 'se-help' }, 'This drawing is read-only. Click a wire to trace its net.')) :
          el('div', { class: 'se-sec se-last' }, el('div', { class: 'eyebrow' }, 'Keys'),
            el('div', { class: 'se-kbs' },
              kb(['W'], 'Wire (or click a pin)'), kb(['L'], 'Net label'), kb(['P'], 'Power port'), kb(['G'], 'Ground'), kb(['Q'], 'No-connect'),
              kb(['R'], 'Rotate'), kb(['X'], 'Mirror'), kb(['Del'], 'Delete'), kb(['Ctrl', 'D'], 'Duplicate'), kb(['Ctrl', 'Z'], 'Undo'), kb(['Ctrl', '⇧', 'Z'], 'Redo'),
              kb(['F'], 'Zoom to fit'), kb(['Space'], 'Hold and drag to pan'), kb(['Esc'], 'Stop the current tool'))),
      ];
    }

    // -------------------------------------------------------------- design check popover
    _openChecks(anchor) {
      if (this._chkPop) { this._chkPop.close(); return; }
      document.querySelectorAll('.menu-pop').forEach(m => m.remove());
      const el = N.el, list = this.check(), err = list.filter(x => x.level === 'error').length, warn = list.length - err;
      const close = () => { pop.remove(); document.removeEventListener('pointerdown', outside, true); this._chkPop = null; anchor.classList.remove('on'); };
      const outside = e => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
      const summary = !list.length ? 'No problems found' : [err ? err + ' error' + (err === 1 ? '' : 's') : '', warn ? warn + ' warning' + (warn === 1 ? '' : 's') : ''].filter(Boolean).join(' · ');
      const pop = el('div', { class: 'menu-pop wide se-chk', role: 'dialog', 'aria-label': 'Design check' },
        el('div', { class: 'se-chk-h' }, el('span', { class: 'pill ' + (err ? 'fail' : warn ? 'warn' : 'pass') }, el('span', { class: 'dot' }), summary),
          el('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Close', onclick: close }, N.svg(NI().close || ICONS.minus))));
      if (!list.length) pop.append(el('p', { class: 'se-chk-empty' }, 'Every pin is connected or marked not connected, and no nets are shorted.'));
      else {
        const ul = el('div', { class: 'se-chk-list' });
        for (const it of list) ul.append(el('button', { class: 'se-chk-item', type: 'button', onclick: () => { close(); this._focusProblem(it); } },
          el('span', { class: 'se-chk-dot ' + (it.level === 'error' ? 'fail' : 'warn'), title: it.level }), el('span', { class: 'se-chk-t' }, it.text)));
        pop.append(ul);
      }
      document.body.append(pop);
      const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
      pop.style.left = Math.max(8, Math.min(r.right - pw, innerWidth - pw - 8)) + 'px';
      pop.style.top = (r.bottom + 6 + ph > innerHeight - 8 ? Math.max(8, r.top - ph - 6) : r.bottom + 6) + 'px';
      setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
      anchor.classList.add('on');
      this._chkPop = { close, el: pop };
    }
    _focusProblem(it) {
      if (it.refs && it.refs.length) {
        const want = new Set(it.refs);
        this._select(this.doc.parts.filter(p => want.has(p.ref)).map(p => ({ kind: 'part', id: p.id })));
      }
      if (it.at) {
        const W = this.stage.clientWidth, H = this.stage.clientHeight, s = Math.max(this.view.s, 7);
        this.view = { s, ox: W / 2 - it.at[0] * G * s, oy: H / 2 - it.at[1] * G * s };
        this._flash = it.at;
        this.draw();
      } else if (it.refs && it.refs.length) this.zoomToRefs(it.refs);
    }

    // -------------------------------------------------------------- static helpers
    static fromCircuit(circuit) { return compactDoc(fromCircuit(circuit)); }
    static docToCircuit(doc, opts) { const d = normDoc(doc); d.wires = normalizeWires(d, buildGeo(d)); const g = buildGeo(d); return circuitOf(d, g, connectivity(d, g), opts); }
    static simChipsOf(doc) { return ((doc && doc.parts) || []).filter(p => p.tpl && SIM_CHIPS[p.tpl] && p.ref && !p.dnp).map(p => Object.assign({ ref: p.ref }, clone(SIM_CHIPS[p.tpl]))); }
    static checkDoc(doc) { const d = normDoc(doc); d.wires = normalizeWires(d, buildGeo(d)); const g = buildGeo(d); return runCheck(d, g, connectivity(d, g)); }
  }
  SchEditor.TYPES = TYPES;
  SchEditor.TEMPLATES = TEMPLATES;
  SchEditor.SIM_CHIPS = SIM_CHIPS;
  SchEditor.GRID_MM = G;
  N.SchEditor = SchEditor;
})();

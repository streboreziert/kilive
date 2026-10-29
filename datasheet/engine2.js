/* datasheet2kicad browser engine - part 2: circuit model, values, footprints, symbol resolver */
(function (root) {
"use strict";
const E1 = root.DS2K_P1;
const { SymbolDef, renameSymbol, powerSymbolNode, connectorNode, icSymbolNode, builtinSymbols } = E1;

const COMPONENT_TYPES = ["ic", "resistor", "capacitor", "capacitor_polarized", "inductor", "ferrite_bead", "diode", "schottky_diode",
  "zener_diode", "tvs_diode", "led", "bjt_npn", "bjt_pnp", "mosfet_n", "mosfet_p", "crystal", "fuse", "potentiometer", "switch",
  "connector", "test_point", "jumper", "thermistor", "transformer", "relay", "other"];
const TWO_PIN_TYPES = new Set(["resistor", "capacitor", "capacitor_polarized", "inductor", "ferrite_bead", "diode", "schottky_diode",
  "zener_diode", "tvs_diode", "led", "crystal", "fuse", "switch", "jumper", "thermistor"]);
const REF_PREFIX = { ic: "U", resistor: "R", capacitor: "C", capacitor_polarized: "C", inductor: "L", ferrite_bead: "FB", diode: "D",
  schottky_diode: "D", zener_diode: "D", tvs_diode: "D", led: "D", bjt_npn: "Q", bjt_pnp: "Q", mosfet_n: "Q", mosfet_p: "Q", crystal: "Y",
  fuse: "F", potentiometer: "RV", switch: "SW", connector: "J", test_point: "TP", jumper: "JP", thermistor: "TH", transformer: "T", relay: "K", other: "U" };
const DIODE_ALIASES = { A: "A", ANODE: "A", "+": "A", K: "K", C: "K", CATHODE: "K", "-": "K", "2": "A", "1": "K" };
const BJT_ALIASES = { B: "B", BASE: "B", C: "C", COLLECTOR: "C", E: "E", EMITTER: "E" };
const MOS_ALIASES = { G: "G", GATE: "G", D: "D", DRAIN: "D", S: "S", SOURCE: "S" };
const PIN_ALIASES = {
  diode: DIODE_ALIASES, schottky_diode: DIODE_ALIASES, zener_diode: DIODE_ALIASES, tvs_diode: DIODE_ALIASES, led: DIODE_ALIASES,
  capacitor_polarized: { "+": "+", P: "+", POS: "+", POSITIVE: "+", "1": "+", A: "+", "-": "-", N: "-", NEG: "-", NEGATIVE: "-", "2": "-", K: "-" },
  bjt_npn: BJT_ALIASES, bjt_pnp: BJT_ALIASES, mosfet_n: MOS_ALIASES, mosfet_p: MOS_ALIASES,
  potentiometer: { "1": "1", A: "1", CW: "1", "2": "W", W: "W", WIPER: "W", "3": "3", B: "3", CCW: "3" },
};
const TYPE_ALIASES = { r: "resistor", res: "resistor", c: "capacitor", cap: "capacitor", electrolytic: "capacitor_polarized",
  polarized_capacitor: "capacitor_polarized", tantalum: "capacitor_polarized", l: "inductor", choke: "inductor", bead: "ferrite_bead",
  schottky: "schottky_diode", zener: "zener_diode", tvs: "tvs_diode", npn: "bjt_npn", pnp: "bjt_pnp", nmos: "mosfet_n", pmos: "mosfet_p",
  nfet: "mosfet_n", pfet: "mosfet_p", xtal: "crystal", pot: "potentiometer", button: "switch", header: "connector", testpoint: "test_point",
  module: "ic", regulator: "ic", opamp: "ic", mcu: "ic", ntc: "thermistor", ptc: "thermistor" };
const KICAD_POWER_NAMES = new Set(("+10V +12C +12L +12LF +12P +12V +12VA +15V +1V0 +1V1 +1V2 +1V35 +1V5 +1V8 +24V +28V +2V5 +2V8 +3.3V " +
  "+3.3VA +3.3VADC +3.3VDAC +3.3VP +36V +3V0 +3V3 +3V8 +48V +4V +5C +5F +5P +5V +5VA +5VD +5VL +5VP +6V +7.5V +8V +9V +9VA +BATT +VDC +VSW " +
  "-10V -12V -12VA -15V -24V -2V5 -36V -3V3 -48V -5V -5VA -6V -8V -9V -9VA -BATT -VDC -VSW Earth GND GND1 GND2 GND3 GNDA GNDD GNDPWR GNDREF " +
  "GNDS VAA VBUS VCC VCCQ VCOM VD VDC VDD VDDA VDDF VEE VMEM VPP VS VSS VSSA").split(" "));
const POWER_CANON = { AGND: "GNDA", DGND: "GNDD", PGND: "GNDPWR", SGND: "GNDS", GROUND: "GND", "0V": "GND", EARTH: "Earth", "3V3": "+3V3",
  "3.3V": "+3V3", "+3.3V": "+3V3", "5V": "+5V", "5V0": "+5V", "+5V0": "+5V", "12V": "+12V", "1V8": "+1V8", "1.8V": "+1V8", "+1.8V": "+1V8",
  "2V5": "+2V5", "2.5V": "+2V5", "+2.5V": "+2V5", "1V2": "+1V2", "1.2V": "+1V2", "+1.2V": "+1V2", "24V": "+24V", "9V": "+9V", "15V": "+15V",
  VBAT: "+BATT", "-5.0V": "-5V", "+5.0V": "+5V" };
const AUTO_NAME_RE = /^(?:N\$?\d+|NET[-_ ]?\d*|NODE[-_ ]?\d+|NET-\(.*\)|UNNAMED.*|NC\d*|X\d+)?$/i;
const isAutoName = (n) => AUTO_NAME_RE.test(n || "");
function canonicalPowerName(name) {
  const n = String(name || "").trim(); if (KICAD_POWER_NAMES.has(n)) return n;
  const up = n.toUpperCase(); if (up in POWER_CANON) return POWER_CANON[up];
  for (const k of KICAD_POWER_NAMES) if (k.toUpperCase() === up) return k;
  return null;
}
const GNDLIKE = /^(?:[ADPS]?GND[A-Z0-9_]*|GND[A-Z0-9_]*|VSS[A-Z0-9_]*|EARTH|0V)$/i;
const isGroundName = (n) => GNDLIKE.test(String(n || "").trim());
const sv = (d, k) => String(d[k] === undefined || d[k] === null ? "" : d[k]).trim();

class Component {
  constructor(d) {
    this.ref = sv(d, "ref"); this.type = (sv(d, "type") || "other").toLowerCase();
    if (!COMPONENT_TYPES.includes(this.type)) this.type = TYPE_ALIASES[this.type] || "other";
    for (const k of ["value", "mpn", "manufacturer", "description", "package", "rating", "tolerance", "kicad_symbol", "footprint", "suggested_mpn", "lcsc"]) this[k] = sv(d, k);
    this.dnp = !!d.dnp; this.pins = [];
    for (const p of d.pins || []) if (p && typeof p === "object") this.pins.push({ number: sv(p, "number"), name: sv(p, "name"), etype: sv(p, "etype"), side: sv(p, "side").toLowerCase() });
  }
  get isTwoPin() { return TWO_PIN_TYPES.has(this.type); }
  toDict() { const d = {}; for (const k of ["ref", "type", "value", "mpn", "suggested_mpn", "manufacturer", "description", "package", "rating", "tolerance", "kicad_symbol", "footprint", "lcsc", "dnp"]) d[k] = this[k]; d.pins = this.pins.map((p) => Object.assign({}, p)); return d; }
}
class Net {
  constructor(d) {
    this.name = sv(d, "name"); this.kind = (sv(d, "kind") || "signal").toLowerCase(); if (!["signal", "power", "ground"].includes(this.kind)) this.kind = "signal";
    this.port = (sv(d, "port") || "none").toLowerCase(); if (!["none", "input", "output", "bidirectional", "passive"].includes(this.port)) this.port = "none";
    this.nodes = [];
    for (const n of d.nodes || []) {
      let ref = "", pin = "";
      if (n && typeof n === "object" && !Array.isArray(n)) { ref = sv(n, "ref"); pin = sv(n, "pin"); }
      else if (typeof n === "string" && n.includes(".")) { const j = n.indexOf("."); ref = n.slice(0, j).trim(); pin = n.slice(j + 1).trim(); }
      else if (Array.isArray(n) && n.length === 2) { ref = String(n[0]).trim(); pin = String(n[1]).trim(); }
      if (ref && pin && !this.nodes.some((x) => x[0] === ref && x[1] === pin)) this.nodes.push([ref, pin]);
    }
  }
  toDict() { return { name: this.name, kind: this.kind, port: this.port, nodes: this.nodes.map(([ref, pin]) => ({ ref, pin })) }; }
}
function expectedPins(c) {
  const t = c.type;
  if (["diode", "schottky_diode", "zener_diode", "tvs_diode", "led"].includes(t)) return ["A", "K"];
  if (t === "capacitor_polarized") return ["+", "-"];
  if (t === "bjt_npn" || t === "bjt_pnp") return ["B", "C", "E"];
  if (t === "mosfet_n" || t === "mosfet_p") return ["G", "D", "S"];
  if (t === "potentiometer") return ["1", "W", "3"];
  if (TWO_PIN_TYPES.has(t)) return ["1", "2"];
  if (t === "test_point") return ["1"];
  return [];
}
class Circuit {
  constructor(d) {
    d = d || {};
    this.part = Object.assign({}, d.part || {}); this.design = Object.assign({}, d.design || {});
    this.components = (d.components || []).filter((c) => c && typeof c === "object").map((c) => new Component(c));
    this.nets = (d.nets || []).filter((n) => n && typeof n === "object").map((n) => new Net(n));
    this.noConnects = (d.no_connects || []).filter((n) => n && n.ref && n.pin).map((n) => [String(n.ref).trim(), String(n.pin).trim()]);
    this.notes = (d.notes || []).map(String); this.warnings = (d.warnings || []).map(String);
    this.confidence = typeof d.confidence === "number" ? d.confidence : null;
  }
  toDict() {
    return { part: this.part, design: this.design, components: this.components.map((c) => c.toDict()), nets: this.nets.map((n) => n.toDict()),
      no_connects: this.noConnects.map(([ref, pin]) => ({ ref, pin })), notes: this.notes, warnings: this.warnings, confidence: this.confidence };
  }
  component(ref) { return this.components.find((c) => c.ref === ref) || null; }
  netOf(ref, pin) { return this.nets.find((n) => n.nodes.some((x) => x[0] === ref && x[1] === pin)) || null; }
  _renameRef(old, nw) {
    if (old === nw) return;
    for (const n of this.nets) n.nodes = n.nodes.map(([r, p]) => [r === old ? nw : r, p]);
    this.noConnects = this.noConnects.map(([r, p]) => [r === old ? nw : r, p]);
  }
  normalize() {
    const issues = []; const seen = new Set(); const counters = {};
    for (const c of this.components) {
      let ref = c.ref.replace(/[^A-Za-z0-9_#]/g, "").toUpperCase();
      if (!/^[A-Z#_]+\d+$/.test(ref)) {
        const letters = ref.replace(/[^A-Z_]/g, ""); const existing = new Set(this.components.map((x) => x.ref.toUpperCase())); let nw;
        if (letters) { let k = 1; while (existing.has(letters + k) || seen.has(letters + k)) k++; nw = letters + k; }
        else { const prefix = REF_PREFIX[c.type] || "U"; counters[prefix] = (counters[prefix] || 100) + 1; nw = prefix + counters[prefix]; }
        if (ref) issues.push("Component reference '" + c.ref + "' renamed to " + nw);
        this._renameRef(c.ref, nw); ref = nw;
      } else if (ref !== c.ref) this._renameRef(c.ref, ref);
      c.ref = ref;
      if (seen.has(ref)) { let k = 2; while (seen.has(ref + "_" + k)) k++; issues.push("Duplicate reference " + ref + " - second instance renamed " + ref + "_" + k); c.ref = ref + "_" + k; }
      seen.add(c.ref);
    }
    for (const c of this.components) {
      const aliases = PIN_ALIASES[c.type]; if (!aliases) continue;
      for (const n of this.nets) {
        const nn = [];
        for (let [ref, pin] of n.nodes) {
          if (ref === c.ref) { const key = pin.toUpperCase(); if (key in aliases) pin = aliases[key]; else issues.push(c.ref + ": unknown pin '" + pin + "' for a " + c.type); }
          if (!nn.some((x) => x[0] === ref && x[1] === pin)) nn.push([ref, pin]);
        }
        n.nodes = nn;
      }
    }
    for (const c of this.components) {
      if (!c.isTwoPin || PIN_ALIASES[c.type]) continue;
      const used = [];
      for (const n of this.nets) for (const [ref, pin] of n.nodes) if (ref === c.ref && !used.includes(pin)) used.push(pin);
      if (used.length > 2) { issues.push(c.ref + ": declared as " + c.type + " but uses " + used.length + " pins - treated as a generic part"); c.type = "other"; continue; }
      if (used.every((p) => p === "1" || p === "2")) continue;
      const ordered = used.slice().sort((a, b) => a.length - b.length || (a < b ? -1 : 1)); const free = ["1", "2"].filter((x) => !used.includes(x)); const mapping = {};
      for (const pin of ordered) mapping[pin] = (pin === "1" || pin === "2") ? pin : free.shift();
      for (const n of this.nets) n.nodes = n.nodes.map(([r, p]) => (r === c.ref ? [r, mapping[p] || p] : [r, p]));
    }
    const merged = new Map(); let auto = 0;
    for (const n of this.nets) {
      let name = n.name.trim().replace(/\s+/g, "_").replace(/["()]/g, "");
      if (n.kind === "ground" || isGroundName(name)) n.kind = "ground";
      const canon = (n.kind === "power" || n.kind === "ground" || isGroundName(name)) ? canonicalPowerName(name) : null;
      if (canon) name = canon;
      if (!name || isAutoName(name)) { do { auto++; name = "N$" + auto; } while (merged.has(name)); }
      n.name = name;
      if (merged.has(name)) { const tgt = merged.get(name); for (const node of n.nodes) if (!tgt.nodes.some((x) => x[0] === node[0] && x[1] === node[1])) tgt.nodes.push(node); if (n.port !== "none" && tgt.port === "none") tgt.port = n.port; }
      else merged.set(name, n);
    }
    this.nets = [...merged.values()];
    const refs = new Set(this.components.map((c) => c.ref));
    for (const n of this.nets) { for (const node of n.nodes) if (!refs.has(node[0])) issues.push("Net " + n.name + " references unknown component " + node[0] + " (dropped)"); n.nodes = n.nodes.filter((x) => refs.has(x[0])); }
    const owner = new Map();
    for (const n of this.nets) {
      const keep = [];
      for (const node of n.nodes) { const key = node[0] + "\u0000" + node[1]; if (owner.has(key) && owner.get(key) !== n.name) { issues.push("CONFLICT: " + node[0] + "." + node[1] + " is listed on both " + owner.get(key) + " and " + n.name + " (kept on " + owner.get(key) + ")"); continue; } owner.set(key, n.name); keep.push(node); }
      n.nodes = keep;
    }
    this.nets = this.nets.filter((n) => n.nodes.length);
    for (const c of this.components) {
      if (PIN_ALIASES[c.type] || c.isTwoPin) continue;
      const known = new Set(c.pins.map((p) => p.number));
      for (const n of this.nets) n.nodes.forEach((node, idx) => {
        const [ref, pin] = node; if (ref !== c.ref || known.has(pin)) return;
        const byName = c.pins.filter((p) => p.name && p.name.toUpperCase() === pin.toUpperCase());
        if (byName.length === 1) { n.nodes[idx] = [ref, byName[0].number]; issues.push(c.ref + ": pin name " + pin + " mapped to number " + byName[0].number); }
        else { c.pins.push({ number: pin, name: "", etype: "", side: "" }); known.add(pin); }
      });
    }
    this.noConnects = this.noConnects.filter(([r, p]) => refs.has(r) && !owner.has(r + "\u0000" + p));
    return issues;
  }
  validate() {
    const errors = [], warnings = [];
    if (!this.components.length) errors.push("No components were extracted.");
    if (!this.nets.length) errors.push("No nets were extracted.");
    const connected = {};
    for (const n of this.nets) for (const [ref, pin] of n.nodes) (connected[ref] = connected[ref] || new Set()).add(pin);
    const nc = new Set(this.noConnects.map(([r, p]) => r + "\u0000" + p));
    for (const c of this.components) {
      const pins = connected[c.ref] || new Set();
      if (!pins.size) { warnings.push(c.ref + " (" + (c.value || c.type) + ") is not connected to anything."); continue; }
      const missing = expectedPins(c).filter((p) => !pins.has(p) && !nc.has(c.ref + "\u0000" + p));
      if (missing.length) (c.isTwoPin ? errors : warnings).push(c.ref + " (" + (c.value || c.type) + "): pin(s) " + missing.join(", ") + " not connected.");
      if (c.isTwoPin && pins.size === 2) { const ns = [...pins].map((p) => this.netOf(c.ref, p).name); if (ns[0] === ns[1]) warnings.push(c.ref + " has both pins on net " + ns[0] + " (shorted)."); }
    }
    for (const n of this.nets) if (n.nodes.length === 1 && n.port === "none" && n.kind === "signal") warnings.push("Net " + n.name + " only connects to " + n.nodes[0][0] + "." + n.nodes[0][1] + " - is a connection missing?");
    for (const c of this.components) if (c.type === "ic" && c.pins.length) {
      const unc = c.pins.filter((p) => !(connected[c.ref] || new Set()).has(p.number) && !nc.has(c.ref + "\u0000" + p.number));
      if (unc.length) warnings.push(c.ref + ": pins left unconnected: " + unc.map((p) => p.name ? p.number + "(" + p.name + ")" : p.number).join(", "));
    }
    return [errors, warnings];
  }
}
function usedPinsOf(circ, ref) {
  const out = [];
  for (const n of circ.nets) for (const [r, p] of n.nodes) if (r === ref && !out.includes(p)) out.push(p);
  for (const [r, p] of circ.noConnects) if (r === ref && !out.includes(p)) out.push(p);
  return out;
}

/* ------------------------------------------------------------------ values */
function parseValue(text, unit) {
  if (!text) return null;
  let t = String(text).trim().replace(/[ΩΩ]/g, "").replace(/ /g, " ").replace(/^[=≈~]/, "").trim();
  const mult = (p) => { if (/^meg$/i.test(p)) return 1e6; if (p === "R" || p === "r" || p === "") return 1; if (p === "m") return 1e-3; if (p === "M") return (unit === "ohm" || !unit) ? 1e6 : 1e-3;
    if (p === "k" || p === "K") return 1e3; if ("uµμU".includes(p)) return 1e-6; if (p === "n" || p === "N") return 1e-9; if (p === "p" || p === "P") return 1e-12; if (p === "f") return 1e-15; if (p === "G" || p === "g") return 1e9; if (p === "F") return 1; return null; };
  let m = /^\s*(\d+)([fpnuµμmkKMGRr])(\d+)/.exec(t);
  if (m) { const k = mult(m[2]); return k === null ? null : parseFloat(m[1] + "." + m[3]) * k; }
  m = /^\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*(meg|[fpnuµμmkKMGRr]?)/i.exec(t);
  if (!m) return null;
  const k = mult(m[2]); return k === null ? null : parseFloat(m[1].replace(",", ".")) * k;
}

/* ------------------------------------------------------------------ footprints (table based - no library index in the browser) */
const METRIC = { "01005": "0402", "0201": "0603", "0402": "1005", "0603": "1608", "0805": "2012", "1206": "3216", "1210": "3225", "1812": "4532", "2010": "5025", "2512": "6332" };
const CHIP_RE = /(?:^|[^\d])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)(?!\d)/;
const CHIP_LIBS = { resistor: ["Resistor_SMD", "R"], thermistor: ["Resistor_SMD", "R"], capacitor: ["Capacitor_SMD", "C"], inductor: ["Inductor_SMD", "L"], ferrite_bead: ["Inductor_SMD", "L"], led: ["LED_SMD", "LED"], fuse: ["Fuse", "Fuse"] };
const DIODE_PKG = [[/SOD-?123F/, "Diode_SMD:D_SOD-123F"], [/SOD-?123/, "Diode_SMD:D_SOD-123"], [/SOD-?323/, "Diode_SMD:D_SOD-323"], [/SOD-?523/, "Diode_SMD:D_SOD-523"],
  [/\bSMA\b|DO-?214AC/, "Diode_SMD:D_SMA"], [/\bSMB\b|DO-?214AA/, "Diode_SMD:D_SMB"], [/\bSMC\b|DO-?214AB/, "Diode_SMD:D_SMC"], [/DO-?41/, "Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal"],
  [/DO-?35/, "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal"], [/SOT-?23/, "Package_TO_SOT_SMD:SOT-23"]];
const Q_PKG = [[/SOT-?23(?!-\d)/, "Package_TO_SOT_SMD:SOT-23"], [/SOT-?323|SC-?70(?!-\d)/, "Package_TO_SOT_SMD:SOT-323_SC-70"], [/SOT-?223/, "Package_TO_SOT_SMD:SOT-223-3_TabPin2"],
  [/SOT-?89/, "Package_TO_SOT_SMD:SOT-89-3"], [/TO-?252|DPAK/, "Package_TO_SOT_SMD:TO-252-2"], [/TO-?263|D2PAK/, "Package_TO_SOT_SMD:TO-263-2"],
  [/TO-?220/, "Package_TO_SOT_THT:TO-220-3_Vertical"], [/TO-?92/, "Package_TO_SOT_THT:TO-92_Inline"]];
const IC_TABLE = [
  [/(?:^|[^A-Z])(?:HTSSOP|TSSOP)(?![A-Z])/, "Package_SO", "TSSOP-", { 8: "3x3mm_P0.65mm", 14: "4.4x5mm_P0.65mm", 16: "4.4x5mm_P0.65mm", 20: "4.4x6.5mm_P0.65mm", 24: "4.4x7.8mm_P0.65mm", 28: "4.4x9.7mm_P0.65mm" }],
  [/(?:^|[^A-Z])(?:MSOP|VSSOP|HVSSOP)(?![A-Z])/, "Package_SO", "MSOP-", { 8: "3x3mm_P0.65mm", 10: "3x3mm_P0.5mm", 12: "3x4mm_P0.65mm", 16: "3x4mm_P0.5mm" }],
  [/(?:^|[^A-Z])SSOP(?![A-Z])/, "Package_SO", "SSOP-", { 16: "5.3x6.2mm_P0.65mm", 20: "5.3x7.2mm_P0.65mm", 24: "5.3x8.2mm_P0.65mm", 28: "5.3x10.2mm_P0.65mm" }],
  [/(?:^|[^A-Z])(?:HSOIC|SOIC|HSOP|SOP|SO)(?![A-Z])/, "Package_SO", "SOIC-", { 8: "3.9x4.9mm_P1.27mm", 14: "3.9x8.7mm_P1.27mm", 16: "3.9x9.9mm_P1.27mm", 18: "7.5x11.6mm_P1.27mm", 20: "7.5x12.8mm_P1.27mm", 24: "7.5x15.4mm_P1.27mm", 28: "7.5x17.9mm_P1.27mm" }],
  [/(?:^|[^A-Z])(?:PDIP|DIP)(?![A-Z])/, "Package_DIP", "DIP-", { 4: "W7.62mm", 6: "W7.62mm", 8: "W7.62mm", 14: "W7.62mm", 16: "W7.62mm", 18: "W7.62mm", 20: "W7.62mm", 24: "W7.62mm", 28: "W7.62mm" }],
  [/(?:^|[^A-Z])LQFP(?![A-Z])/, "Package_QFP", "LQFP-", { 32: "7x7mm_P0.8mm", 44: "10x10mm_P0.8mm", 48: "7x7mm_P0.5mm", 64: "10x10mm_P0.5mm", 100: "14x14mm_P0.5mm", 144: "20x20mm_P0.5mm" }],
  [/(?:^|[^A-Z])TQFP(?![A-Z])/, "Package_QFP", "TQFP-", { 32: "7x7mm_P0.8mm", 44: "10x10mm_P0.8mm", 48: "7x7mm_P0.5mm", 64: "10x10mm_P0.5mm", 100: "14x14mm_P0.5mm" }]];
const IC_FIXED = [[/(?:^|[^A-Z])TSOT-?23-?5|(?:^|[^A-Z])TSOT-?5/, "Package_TO_SOT_SMD:TSOT-23-5"], [/(?:^|[^A-Z])TSOT-?23-?6|(?:^|[^A-Z])TSOT-?6/, "Package_TO_SOT_SMD:TSOT-23-6"],
  [/(?:^|[^A-Z])SOT-?23-?5|(?:^|[^A-Z])SOT-?25/, "Package_TO_SOT_SMD:SOT-23-5"], [/(?:^|[^A-Z])SOT-?23-?6|(?:^|[^A-Z])SOT-?26/, "Package_TO_SOT_SMD:SOT-23-6"],
  [/(?:^|[^A-Z])SOT-?23-?8/, "Package_TO_SOT_SMD:SOT-23-8"], [/(?:^|[^A-Z])SOT-?23(?:-?3)?$/, "Package_TO_SOT_SMD:SOT-23"], [/(?:^|[^A-Z])SC-?70-?5|(?:^|[^A-Z])SOT-?353/, "Package_TO_SOT_SMD:SOT-353_SC-70-5"],
  [/(?:^|[^A-Z])SC-?70-?6|(?:^|[^A-Z])SOT-?363/, "Package_TO_SOT_SMD:SOT-363_SC-70-6"], [/(?:^|[^A-Z])SOT-?223/, "Package_TO_SOT_SMD:SOT-223-3_TabPin2"], [/(?:^|[^A-Z])SOT-?89/, "Package_TO_SOT_SMD:SOT-89-3"],
  [/(?:^|[^A-Z])TO-?220-?5/, "Package_TO_SOT_THT:TO-220-5_Vertical"], [/(?:^|[^A-Z])TO-?220/, "Package_TO_SOT_THT:TO-220-3_Vertical"], [/(?:^|[^A-Z])TO-?263-?5|(?:^|[^A-Z])D2PAK-?5|(?:^|[^A-Z])DDPAK-?5/, "Package_TO_SOT_SMD:TO-263-5_TabPin3"],
  [/(?:^|[^A-Z])TO-?263|(?:^|[^A-Z])D2PAK|(?:^|[^A-Z])DDPAK/, "Package_TO_SOT_SMD:TO-263-2"], [/(?:^|[^A-Z])TO-?252|(?:^|[^A-Z])DPAK/, "Package_TO_SOT_SMD:TO-252-2"], [/(?:^|[^A-Z])TO-?92/, "Package_TO_SOT_THT:TO-92_Inline"]];
const chipSize = (t) => { const m = CHIP_RE.exec(t || ""); return m ? m[1] : null; };
function icFootprint(pkg, pinCount) {
  if (!pkg) return ["", "no package information"];
  const p = pkg.toUpperCase().replace(/–/g, "-").replace(/×/g, "X");
  const ep = /\bEP\b|EXPOSED|POWERPAD|THERMAL PAD|-1EP|HSOP|HTSSOP|HSOIC|HVSSOP|SO-?8-?EP|ESOP/.test(p);
  let count = null;
  const m = /(?:^|[^0-9.X])(\d{1,3})\s*-?\s*(?:PIN|LEAD|LD|L)\b/.exec(p) || /[A-Z]\s*-?\s*\(?(\d{1,3})\)?\s*$/.exec(p) || /^(\d{1,3})\s*-\s*[A-Z]/.exec(p) || /[A-Z]-?(\d{1,3})(?:-|_|\s|$)/.exec(p);
  if (m) count = parseInt(m[1], 10);
  const fam = p.replace(/^\d+\s*-?\s*(?:PIN|LEAD)?\s*/, "").replace(/ /g, "");
  for (const [rx, fp] of IC_FIXED) if (rx.test(fam)) return [fp, "matched package " + pkg];
  let n = count || pinCount; if (ep && count === null && pinCount) n = pinCount % 2 === 1 ? pinCount - 1 : pinCount;
  if (/(VQFN|WQFN|UQFN|TQFN|QFN|WSON|VSON|USON|SON|UDFN|WDFN|TDFN|DFN|MLF|LFCSP)/.test(fam)) return ["", "package " + pkg + ": pick the exact QFN/DFN footprint variant in KiCad"];
  for (const [rx, lib, base, table] of IC_TABLE) if (rx.test(fam) && n) {
    if (ep) return ["", "package " + pkg + " has an exposed pad: choose the matching -1EP footprint in KiCad"];
    if (table[n]) return [lib + ":" + base + n + "_" + table[n], "matched package " + pkg];
  }
  return ["", "package " + pkg + " not recognised - assign a footprint in KiCad"];
}
function capDefaultSize(value, dflt) {
  const v = parseValue(value, "F"); if (v === null) return dflt;
  const order = ["0201", "0402", "0603", "0805", "1206", "1210"];
  const need = v <= 1e-7 ? "0402" : v <= 2.2e-6 ? "0603" : v <= 1e-5 ? "0805" : v <= 4.7e-5 ? "1206" : "1210";
  return order[Math.max(order.indexOf(need), order.includes(dflt) ? order.indexOf(dflt) : 2)];
}
function chooseFootprint(c, pinCount, dfltChip) {
  dfltChip = dfltChip || "0603";
  if (c.footprint && c.footprint.includes(":")) return [c.footprint, "from extraction"];
  const pkg = c.package || "", t = c.type, PK = pkg.toUpperCase();
  if (CHIP_LIBS[t]) {
    let size = chipSize(pkg);
    if (size === null && /AXIAL|THT|THROUGH|RADIAL|DIP|LEADED/.test(PK)) return t === "resistor" ? ["Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal", "through-hole resistor"] : ["", "through-hole " + t + ": assign a footprint in KiCad"];
    if (t === "inductor" && size === null) return ["", "power inductor: footprint depends on the chosen part"];
    if (t === "capacitor" && size === null) size = capDefaultSize(c.value, dfltChip);
    const explicit = !!chipSize(pkg); size = size || dfltChip; const [lib, prefix] = CHIP_LIBS[t];
    return [lib + ":" + prefix + "_" + size + "_" + METRIC[size] + "Metric", "package " + size + (explicit ? "" : " (default)")];
  }
  if (["diode", "schottky_diode", "zener_diode", "tvs_diode"].includes(t)) { for (const [rx, fp] of DIODE_PKG) if (rx.test(PK)) return [fp, "package " + pkg]; return t === "schottky_diode" ? ["Diode_SMD:D_SMA", "default for power diodes - verify"] : ["Diode_SMD:D_SOD-123", "default - verify"]; }
  if (["bjt_npn", "bjt_pnp", "mosfet_n", "mosfet_p"].includes(t)) { for (const [rx, fp] of Q_PKG) if (rx.test(PK)) return [fp, "package " + pkg + " - verify the pin order against the transistor's datasheet"]; return ["Package_TO_SOT_SMD:SOT-23", "default SOT-23 - verify the pin order"]; }
  if (t === "connector") return (pinCount && pinCount <= 40) ? ["Connector_PinHeader_2.54mm:PinHeader_1x" + String(pinCount).padStart(2, "0") + "_P2.54mm_Vertical", "generic 2.54 mm header"] : ["", "connector: assign a footprint in KiCad"];
  if (t === "test_point") return ["TestPoint:TestPoint_Pad_D1.5mm", "generic test pad"];
  if (t === "capacitor_polarized") { const tant = { "1206": "CP_EIA-3216-18_Kemet-A", "3216": "CP_EIA-3216-18_Kemet-A", "1210": "CP_EIA-3528-21_Kemet-B", "3528": "CP_EIA-3528-21_Kemet-B", "2312": "CP_EIA-6032-28_Kemet-C", "6032": "CP_EIA-6032-28_Kemet-C", "2917": "CP_EIA-7343-31_Kemet-D", "7343": "CP_EIA-7343-31_Kemet-D" };
    const m = /(?:^|[^\d])(1206|3216|1210|3528|2312|6032|2917|7343)(?!\d)/.exec(pkg); return m ? ["Capacitor_Tantalum_SMD:" + tant[m[1]], "tantalum case " + m[1] + " - verify"] : ["", "polarised capacitor: footprint depends on the chosen part"]; }
  return icFootprint(pkg, pinCount);
}

/* ------------------------------------------------------------------ resolver (built-in + generated symbols, all shipped in the project library) */
const GENERIC = { resistor: "Device:R", capacitor: "Device:C", capacitor_polarized: "Device:C_Polarized", inductor: "Device:L", ferrite_bead: "Device:FerriteBead", diode: "Device:D",
  schottky_diode: "Device:D_Schottky", zener_diode: "Device:D_Zener", tvs_diode: "Device:D_TVS", led: "Device:LED", crystal: "Device:Crystal", fuse: "Device:Fuse",
  potentiometer: "Device:R_Potentiometer", switch: "Switch:SW_Push", test_point: "Connector:TestPoint", jumper: "Jumper:SolderJumper_2_Open", thermistor: "Device:Thermistor_NTC" };
function transistorCandidate(c) {
  const pkg = (c.package || "").toUpperCase();
  if (c.type === "bjt_npn" || c.type === "bjt_pnp") { const order = /TO-?92/.test(pkg) ? "EBC" : /TO-?220|TO-?126|TO-?247|SOT-?223|DPAK|TO-?252/.test(pkg) ? "BCE" : "BEC"; return "Device:Q_" + (c.type === "bjt_npn" ? "NPN" : "PNP") + "_" + order; }
  const order = /TO-?220|TO-?247|TO-?252|TO-?263|DPAK|D2PAK|SOT-?223/.test(pkg) ? "GDS" : "GSD"; return "Device:Q_" + (c.type === "mosfet_n" ? "NMOS" : "PMOS") + "_" + order;
}
class Resolver {
  constructor(projectLib, config) { this.projectLib = projectLib; this.config = config || {}; this.custom = {}; this.log = []; }
  _ship(name, node) { if (!this.custom[name]) this.custom[name] = new SymbolDef(this.projectLib, name, node, "builtin"); return this.custom[name]; }
  builtin(libId) { const node = builtinSymbols()[libId]; return node ? this._ship(libId.split(":")[1], node) : null; }
  powerSymbol(netName) {
    const name = netName === "PWR_FLAG" ? "PWR_FLAG" : "PWR_" + netName.replace(/[^A-Za-z0-9_+\-.]/g, "_");
    if (!this.custom[name]) {
      const node = renameSymbol(powerSymbolNode(netName, netName === "PWR_FLAG" ? "flag" : undefined), name);
      for (const p of node) if (Array.isArray(p) && p.length > 2 && E1.isSym(p[0], "property") && p[1] === "Value") p[2] = netName;
      this.custom[name] = new SymbolDef(this.projectLib, name, node, "generated");
    }
    return this.custom[name];
  }
  resolve(c, usedPins) {
    const r = this._resolve(c, usedPins);
    const fp = chooseFootprint(c, r.sym.allPins().length, this.config.default_passive_package || "0603");
    r.footprint = fp[0]; r.footprintNote = fp[1]; return r;
  }
  _resolve(c, usedPins) {
    const t = c.type; let libId = GENERIC[t];
    if (["bjt_npn", "bjt_pnp", "mosfet_n", "mosfet_p"].includes(t)) libId = transistorCandidate(c);
    if (libId) { const sym = this.builtin(libId); const pm = sym && this._pinMap(c, sym, usedPins); if (pm) return { comp: c, sym, libId: this.projectLib + ":" + sym.name, pinMap: pm, notes: [] }; }
    if (t === "connector") {
      const nums = usedPins.filter((p) => /^\d+$/.test(p)).map(Number); const n = Math.max(c.pins.length, nums.length ? Math.max(...nums) : 0, usedPins.length, 1);
      const name = "Conn_01x" + String(n).padStart(2, "0"); const sym = this._ship(name, connectorNode(n)); const pm = {}; for (const p of sym.allPins()) pm[p.number] = p.number;
      if (usedPins.every((p) => pm[p])) return { comp: c, sym, libId: this.projectLib + ":" + name, pinMap: pm, notes: [] };
    }
    return this.generate(c, usedPins);
  }
  _pinMap(c, sym, usedPins) {
    const libPins = sym.allPins(); const byNumber = {}; const byName = {};
    for (const p of libPins) { byNumber[p.number] = p; (byName[p.name.toUpperCase()] = byName[p.name.toUpperCase()] || []).push(p.number); }
    const exp = expectedPins(c); if (!exp.length) return null;
    let m = {}; const fixed = (c.type === "capacitor_polarized") ? { "+": "1", "-": "2" } : {};
    for (const pid of exp) {
      if (fixed[pid] && byNumber[fixed[pid]]) m[pid] = fixed[pid];
      else if ((byName[pid.toUpperCase()] || []).length === 1 && !/^\d+$/.test(pid)) m[pid] = byName[pid.toUpperCase()][0];
      else if (byNumber[pid]) m[pid] = pid;
    }
    if (c.type === "potentiometer") m = { "1": "1", W: "2", "3": "3" };
    if (new Set(Object.values(m)).size !== exp.length || usedPins.some((p) => !(p in m))) return null;
    return m;
  }
  generate(c, usedPins) {
    let pins = c.pins.map((p) => Object.assign({}, p)); const known = new Set(pins.map((p) => p.number));
    for (const u of usedPins) if (!known.has(u)) { pins.push({ number: u, name: "", etype: "passive", side: "" }); known.add(u); }
    const exp = expectedPins(c); let pinMap = {};
    if (exp.length && !c.pins.length) { pins = exp.map((pid, i) => ({ number: String(i + 1), name: pid, etype: "passive", side: "" })); exp.forEach((pid, i) => { pinMap[pid] = String(i + 1); }); }
    else for (const p of pins) pinMap[p.number] = p.number;
    const base = (c.mpn || c.value || c.ref).replace(/[^A-Za-z0-9_+\-.]/g, "_").replace(/^_+|_+$/g, "") || c.ref;
    let final = base, k = 2;
    const same = (sym) => JSON.stringify(sym.allPins().map((p) => p.number).sort()) === JSON.stringify(pins.map((p) => String(p.number)).sort());
    while (this.custom[final] && !same(this.custom[final])) { final = base + "_" + k; k++; }
    if (!this.custom[final]) { const m = /^[A-Z#]+/.exec(c.ref); this.custom[final] = new SymbolDef(this.projectLib, final, icSymbolNode(final, pins, { ref: m ? m[0] : "U", description: c.description || c.value, datasheet: this.config.datasheet_url || "~" }), "generated"); }
    return { comp: c, sym: this.custom[final], libId: this.projectLib + ":" + final, pinMap, notes: ["symbol generated from the datasheet pin table"] };
  }
}

root.DS2K_P2 = { COMPONENT_TYPES, Circuit, Component, Net, expectedPins, usedPinsOf, canonicalPowerName, isAutoName, isGroundName, parseValue, chooseFootprint, icFootprint, Resolver };
})(typeof window !== "undefined" ? window : globalThis);

/* datasheet2kicad browser engine - part 1: s-expressions, symbols, symbol generation */
(function (root) {
"use strict";
const GRID = 1.27;
const P = 2.54;

/* ------------------------------------------------------------------ s-expressions */
class Sym { constructor(n) { this.n = String(n); } toString() { return this.n; } }
const S = (n) => new Sym(n);
const isSym = (x, name) => x instanceof Sym && (name === undefined || x.n === name);
const isList = Array.isArray;

function fmtNum(v) {
  if (Math.abs(v) < 5e-7) return "0";
  let s = v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return (s === "-0" || s === "") ? "0" : s;
}
function quote(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "").replace(/\t/g, " ") + '"';
}
function atom(a) {
  if (a instanceof Sym) return a.n;
  if (typeof a === "string") return quote(a);
  if (typeof a === "boolean") return a ? "yes" : "no";
  if (typeof a === "number") return Number.isInteger(a) ? String(a) : fmtNum(a);
  throw new Error("cannot serialise " + a);
}
const INLINE = new Set(["at", "xy", "start", "end", "mid", "center", "size", "font", "stroke", "fill", "effects", "justify",
  "color", "offset", "length", "width", "type", "uuid", "unit", "page", "reference", "version", "generator",
  "generator_version", "paper", "lib_id", "hide", "in_bom", "on_board", "dnp", "exclude_from_sim", "fields_autoplaced",
  "diameter", "radius", "name", "number", "pin_numbers", "pin_names", "power", "embedded_fonts", "mirror", "shape",
  "thickness", "bold", "italic", "title", "date", "rev", "company", "comment", "pts", "path", "pin", "junction", "no_connect"]);
function inlineOk(node) {
  if (node.every((x) => !isList(x))) return true;
  const h = node[0];
  if (h instanceof Sym && INLINE.has(h.n)) return node.every((x) => !isList(x) || inlineOk(x));
  return false;
}
function renderInline(node) { return "(" + node.map((x) => isList(x) ? renderInline(x) : atom(x)).join(" ") + ")"; }
function dumpInto(node, depth, out) {
  const pad = "\t".repeat(depth);
  if (inlineOk(node)) { out.push(pad + renderInline(node)); return; }
  let k = 0; const headParts = [];
  while (k < node.length && !isList(node[k])) { headParts.push(atom(node[k])); k++; }
  out.push(pad + "(" + headParts.join(" "));
  for (const x of node.slice(k)) { if (isList(x)) dumpInto(x, depth + 1, out); else out.push(pad + "\t" + atom(x)); }
  out.push(pad + ")");
}
function dumps(node) { const out = []; dumpInto(node, 0, out); return out.join("\n") + "\n"; }

function parse(text) {
  const stack = []; let i = 0; const n = text.length; let result = null;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === "(") { const nw = []; if (stack.length) stack[stack.length - 1].push(nw); stack.push(nw); i++; }
    else if (c === ")") { const done = stack.pop(); if (!stack.length) { result = done; break; } i++; }
    else if (c === '"') {
      let j = i + 1; let buf = "";
      while (j < n) {
        const d = text[j];
        if (d === "\\" && j + 1 < n) { const e = text[j + 1]; buf += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e; j += 2; continue; }
        if (d === '"') break;
        buf += d; j++;
      }
      stack[stack.length - 1].push(buf); i = j + 1;
    } else {
      let j = i;
      while (j < n && !" \t\r\n()\"".includes(text[j])) j++;
      stack[stack.length - 1].push(new Sym(text.slice(i, j))); i = j;
    }
  }
  if (!result) throw new Error("no S-expression found");
  return result;
}
const head = (node) => (isList(node) && node.length && node[0] instanceof Sym) ? node[0].n : null;
const children = (node, name) => (isList(node) ? node : []).filter((x) => isList(x) && x.length && isSym(x[0], name));
const child = (node, name) => { for (const x of (isList(node) ? node : [])) if (isList(x) && x.length && isSym(x[0], name)) return x; return null; };
const fnum = (x, d = 0) => { const v = parseFloat(x instanceof Sym ? x.n : x); return Number.isFinite(v) ? v : d; };
const str = (x) => (x instanceof Sym ? x.n : String(x));

/* ------------------------------------------------------------------ placement transform */
function transform(x, y, rot, mirror) {
  if (mirror === "y") x = -x; else if (mirror === "x") y = -y;
  const r = ((rot % 360) + 360) % 360;
  if (r === 0) return [x, -y];
  if (r === 90) return [-y, -x];
  if (r === 180) return [-x, y];
  if (r === 270) return [y, x];
  throw new Error("rotation must be a multiple of 90");
}
function pinOutward(angle, rot, mirror) {
  const a = angle * Math.PI / 180;
  const o = transform(-Math.cos(a), -Math.sin(a), rot, mirror);
  return [Math.round(o[0]) + 0, Math.round(o[1]) + 0];
}

/* ------------------------------------------------------------------ symbol model */
const UNIT_RE = /^(.*)_(\d+)_(\d+)$/;
class Pin {
  constructor(number, name, etype, x, y, angle, length, unit, hidden, style) {
    Object.assign(this, { number, name, etype, x, y, angle, length, unit, hidden, style });
  }
  get side() { return { 0: "left", 180: "right", 90: "bottom", 270: "top" }[((Math.round(this.angle) % 360) + 360) % 360] || "left"; }
}
function parsePin(pn, unit, style) {
  if (pn.length < 3) return null;
  const at = child(pn, "at"); if (!at) return null;
  const ln = child(pn, "length"), nm = child(pn, "name"), nu = child(pn, "number");
  let hidden = false;
  for (const x of pn.slice(1)) {
    if (isSym(x, "hide")) hidden = true;
    else if (head(x) === "hide") hidden = x.length < 2 || str(x[1]) === "yes";
  }
  return new Pin(nu && nu.length > 1 ? str(nu[1]) : "", nm && nm.length > 1 ? str(nm[1]) : "", str(pn[1]),
    fnum(at[1]), fnum(at[2]), at.length > 3 ? fnum(at[3]) : 0, ln ? fnum(ln[1]) : 0, unit, hidden, style);
}
class SymbolDef {
  constructor(lib, name, node, source) {
    this.lib = lib; this.name = name; this.node = node; this.source = source || "builtin";
    this.pins = []; this.properties = {}; this.propNodes = {};
    this.isPower = child(node, "power") !== null; this.unitCount = 1; this._bbox = {};
    for (const p of children(node, "property")) if (p.length >= 3) { this.properties[str(p[1])] = str(p[2]); this.propNodes[str(p[1])] = p; }
    const units = new Set();
    for (const sub of children(node, "symbol")) {
      const m = UNIT_RE.exec(str(sub[1]));
      const unit = m ? parseInt(m[2], 10) : 1, style = m ? parseInt(m[3], 10) : 1;
      if (unit > 0) units.add(unit);
      for (const pn of children(sub, "pin")) { const pin = parsePin(pn, unit, style); if (pin) this.pins.push(pin); }
    }
    this.unitCount = units.size ? Math.max(...units) : 1;
  }
  get libId() { return this.lib + ":" + this.name; }
  pinsForUnit(unit) { return this.pins.filter((p) => (p.style === 0 || p.style === 1) && (p.unit === unit || p.unit === 0)); }
  allPins() { return this.pins.filter((p) => p.style === 0 || p.style === 1); }
  pin(number) { return this.allPins().find((p) => p.number === number) || null; }
  bodyBbox(unit) {
    unit = unit || 1;
    if (this._bbox[unit]) return this._bbox[unit];
    const xs = [], ys = [];
    for (const sub of children(this.node, "symbol")) {
      const m = UNIT_RE.exec(str(sub[1]));
      const u = m ? parseInt(m[2], 10) : 1, st = m ? parseInt(m[3], 10) : 1;
      if (!(st === 0 || st === 1) || !(u === 0 || u === unit)) continue;
      for (const g of sub) {
        const h = head(g);
        if (h === "rectangle") { for (const k of ["start", "end"]) { const c = child(g, k); if (c) { xs.push(fnum(c[1])); ys.push(fnum(c[2])); } } }
        else if (h === "polyline" || h === "bezier") { const pts = child(g, "pts"); if (pts) for (const xy of children(pts, "xy")) { xs.push(fnum(xy[1])); ys.push(fnum(xy[2])); } }
        else if (h === "circle") { const c = child(g, "center"), r = child(g, "radius"); if (c && r) { const cx = fnum(c[1]), cy = fnum(c[2]), rr = fnum(r[1]); xs.push(cx - rr, cx + rr); ys.push(cy - rr, cy + rr); } }
        else if (h === "arc") { for (const k of ["start", "mid", "end"]) { const c = child(g, k); if (c) { xs.push(fnum(c[1])); ys.push(fnum(c[2])); } } }
        else if (h === "pin") {
          const at = child(g, "at"), ln = child(g, "length");
          if (at) { const a = (at.length > 3 ? fnum(at[3]) : 0) * Math.PI / 180, l = ln ? fnum(ln[1]) : 0; xs.push(fnum(at[1]) + l * Math.cos(a)); ys.push(fnum(at[2]) + l * Math.sin(a)); }
        }
      }
    }
    if (!xs.length) { xs.push(-2.54, 2.54); ys.push(-2.54, 2.54); }
    const bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    this._bbox[unit] = bb; return bb;
  }
  embeddedNode(libNick) { const node = JSON.parse(JSON.stringify(this.node, (k, v) => v instanceof Sym ? { __sym: v.n } : v), (k, v) => (v && v.__sym !== undefined) ? new Sym(v.__sym) : v); node[1] = (libNick || this.lib) + ":" + this.name; return node; }
}
function cloneNode(node) { return JSON.parse(JSON.stringify(node, (k, v) => v instanceof Sym ? { __sym: v.n } : v), (k, v) => (v && v.__sym !== undefined) ? new Sym(v.__sym) : v); }
function renameSymbol(node, newName) {
  node = cloneNode(node); const old = str(node[1]); node[1] = newName;
  for (const sub of children(node, "symbol")) { const m = UNIT_RE.exec(str(sub[1])); if (m && m[1] === old) sub[1] = newName + "_" + m[2] + "_" + m[3]; }
  return node;
}

/* ------------------------------------------------------------------ symbol generation */
function effects(hide, justify, size) {
  size = size || 1.27;
  const e = [S("effects"), [S("font"), [S("size"), size, size]]];
  if (justify) e.push([S("justify")].concat(justify.split(" ").map(S)));
  if (hide) e.push([S("hide"), S("yes")]);
  return e;
}
const prop = (name, value, x, y, angle, hide, justify) => [S("property"), name, value, [S("at"), x, y, angle || 0], effects(hide, justify)];
const stroke = (w) => [S("stroke"), [S("width"), w === undefined ? 0.254 : w], [S("type"), S("default")]];
const fill = (kind) => [S("fill"), [S("type"), S(kind || "none")]];
const rect = (x1, y1, x2, y2, w, f) => [S("rectangle"), [S("start"), x1, y1], [S("end"), x2, y2], stroke(w), fill(f)];
const poly = (pts, w, f) => [S("polyline"), [S("pts")].concat(pts.map(([x, y]) => [S("xy"), x, y])), stroke(w), fill(f)];
const circle = (cx, cy, r, w, f) => [S("circle"), [S("center"), cx, cy], [S("radius"), r], stroke(w), fill(f)];
const arc = (sx, sy, mx, my, ex, ey, w) => [S("arc"), [S("start"), sx, sy], [S("mid"), mx, my], [S("end"), ex, ey], stroke(w), fill("none")];
function pinNode(etype, x, y, angle, length, name, number, hide) {
  const node = [S("pin"), S(etype), S("line"), [S("at"), x, y, angle], [S("length"), length]];
  if (hide) node.push([S("hide"), S("yes")]);
  node.push([S("name"), name, effects()]); node.push([S("number"), number, effects()]);
  return node;
}
function makeSymbol(name, ref, graphics, pins, o) {
  o = o || {};
  const node = [S("symbol"), name];
  if (o.power) node.push([S("power")]);
  if (o.hidePinNumbers) node.push([S("pin_numbers"), [S("hide"), S("yes")]]);
  const pn = [S("pin_names"), [S("offset"), o.pinNameOffset === undefined ? 1.016 : o.pinNameOffset]];
  if (o.hidePinNames) pn.push([S("hide"), S("yes")]);
  node.push(pn, [S("exclude_from_sim"), S("no")], [S("in_bom"), S(o.inBom === false ? "no" : "yes")], [S("on_board"), S(o.onBoard === false ? "no" : "yes")]);
  const ra = o.refAt || [0, 0], va = o.valAt || [0, 0], fa = o.fieldAngle || 0;
  node.push(prop("Reference", ref, ra[0], ra[1], fa, !!o.refHidden, o.refJustify));
  node.push(prop("Value", o.value === undefined ? name : o.value, va[0], va[1], fa, false, o.valJustify));
  node.push(prop("Footprint", o.footprint || "", 0, 0, 0, true));
  node.push(prop("Datasheet", o.datasheet || "~", 0, 0, 0, true));
  node.push(prop("Description", o.description || "", 0, 0, 0, true));
  node.push([S("symbol"), name + "_0_1"].concat(graphics));
  node.push([S("symbol"), name + "_1_1"].concat(pins));
  return node;
}
function twoPinVertical(name, ref, graphics, desc, plen) {
  plen = plen || 1.27;
  return makeSymbol(name, ref, graphics, [pinNode("passive", 0, 3.81, 270, plen, "~", "1"), pinNode("passive", 0, -3.81, 90, plen, "~", "2")],
    { description: desc, hidePinNumbers: true, hidePinNames: true, pinNameOffset: 0, refAt: [2.54, 1.27], valAt: [2.54, -1.27], refJustify: "left", valJustify: "left" });
}
function diode(name, extra, desc) {
  const g = [poly([[1.27, 1.27], [1.27, -1.27], [-1.27, 0], [1.27, 1.27]]), poly([[1.27, 0], [-1.27, 0]], 0)].concat(extra);
  return makeSymbol(name, "D", g, [pinNode("passive", -3.81, 0, 0, 2.54, "K", "1"), pinNode("passive", 3.81, 0, 180, 2.54, "A", "2")],
    { description: desc, hidePinNumbers: true, hidePinNames: true, refAt: [0, 2.54], valAt: [0, -2.54] });
}
function transistor(name, kind, order, desc) {
  let g, names;
  if (kind === "npn" || kind === "pnp") {
    g = [circle(1.27, 0, 2.8194), poly([[0.635, 1.905], [0.635, -1.905]], 0.508), poly([[-2.54, 0], [0.635, 0]], 0),
      poly([[0.635, 0.635], [2.54, 2.54]], 0), poly([[0.635, -0.635], [2.54, -2.54]], 0)];
    if (kind === "npn") { g.push(poly([[1.27, -1.778], [1.778, -1.27], [2.286, -2.286], [1.27, -1.778]], 0, "outline")); names = { B: [-5.08, 0, 0], C: [2.54, 5.08, 270], E: [2.54, -5.08, 90] }; }
    else { g.push(poly([[1.524, 2.032], [2.032, 1.524], [1.016, 1.016], [1.524, 2.032]], 0, "outline")); names = { B: [-5.08, 0, 0], E: [2.54, 5.08, 270], C: [2.54, -5.08, 90] }; }
  } else {
    g = [circle(1.27, 0, 2.8194), poly([[0.254, 1.905], [0.254, -1.905]], 0.254), poly([[-2.54, 0], [0.254, 0]], 0),
      poly([[0.762, 2.286], [0.762, 1.27]], 0.254), poly([[0.762, 0.508], [0.762, -0.508]], 0.254), poly([[0.762, -1.27], [0.762, -2.286]], 0.254),
      poly([[0.762, 1.778], [2.54, 1.778], [2.54, 2.54]], 0), poly([[0.762, -1.778], [2.54, -1.778], [2.54, -2.54]], 0), poly([[0.762, 0], [2.54, 0], [2.54, -1.778]], 0)];
    if (kind === "nmos") { g.push(poly([[1.016, 0], [2.032, 0.381], [2.032, -0.381], [1.016, 0]], 0, "outline")); names = { G: [-5.08, 0, 0], D: [2.54, 5.08, 270], S: [2.54, -5.08, 90] }; }
    else { g.push(poly([[2.286, 0], [1.27, 0.381], [1.27, -0.381], [2.286, 0]], 0, "outline")); names = { G: [-5.08, 0, 0], S: [2.54, 5.08, 270], D: [2.54, -5.08, 90] }; }
  }
  const pins = order.split("").map((letter, i) => { const [x, y, a] = names[letter]; return pinNode("BG".includes(letter) ? "input" : "passive", x, y, a, 2.54, letter, String(i + 1)); });
  return makeSymbol(name, "Q", g, pins, { description: desc, hidePinNames: true, pinNameOffset: 0, refAt: [5.08, 1.27], valAt: [5.08, -1.27], refJustify: "left", valJustify: "left" });
}
const GND_RE = /^(?:[ADPS]?GND[A-Z0-9_]*|GND|VSS[A-Z0-9_]*|VEE|EARTH|0V|COM)$/i;
const NEG_RE = /^(?:-\d|V-|VNEG|-V)/i;
function powerStyle(n) { n = n.trim(); return GND_RE.test(n) ? "gnd" : NEG_RE.test(n) ? "down" : "up"; }
function powerSymbolNode(name, style) {
  style = style || powerStyle(name);
  if (style === "flag") {
    return makeSymbol(name, "#FLG", [poly([[0, 0], [0, 1.27], [-1.016, 1.905], [0, 2.54], [1.016, 1.905], [0, 1.27]], 0)], [pinNode("power_out", 0, 0, 90, 0, "~", "1")],
      { description: "Tells ERC where power comes from", power: true, hidePinNumbers: true, hidePinNames: true, pinNameOffset: 0, refAt: [0, 1.905], valAt: [0, 3.81], refHidden: true, inBom: false, onBoard: false });
  }
  let g, pins, refAt, valAt;
  if (style === "gnd") { g = [poly([[0, 0], [0, -1.27], [1.27, -1.27], [0, -2.54], [-1.27, -1.27], [0, -1.27]], 0)]; pins = [pinNode("power_in", 0, 0, 270, 0, "~", "1", true)]; refAt = [0, -6.35]; valAt = [0, -3.81]; }
  else if (style === "down") { g = [poly([[0, 0], [0, -1.27], [0.762, -1.27], [0, -2.54], [-0.762, -1.27], [0, -1.27]], 0, "outline")]; pins = [pinNode("power_in", 0, 0, 270, 0, "~", "1", true)]; refAt = [0, -6.35]; valAt = [0, -3.81]; }
  else { g = [poly([[-0.762, 1.27], [0, 2.54]], 0), poly([[0, 0], [0, 2.54]], 0), poly([[0, 2.54], [0.762, 1.27]], 0)]; pins = [pinNode("power_in", 0, 0, 90, 0, "~", "1", true)]; refAt = [0, -3.81]; valAt = [0, 3.556]; }
  return makeSymbol(name, "#PWR", g, pins, { description: 'Power symbol creates a global label with name "' + name + '"', power: true, hidePinNumbers: true, hidePinNames: true, pinNameOffset: 0, refAt, valAt, refHidden: true });
}
function connectorNode(n, name) {
  name = name || ("Conn_01x" + String(n).padStart(2, "0"));
  const top = P * Math.floor((n - 1) / 2); const pins = [], g = [];
  for (let i = 0; i < n; i++) { const y = top - i * P; pins.push(pinNode("passive", -5.08, y, 0, 3.81, "Pin_" + (i + 1), String(i + 1))); g.push(rect(-1.27, y + 0.127, 0, y - 0.127, 0.1524)); }
  const bottom = top - (n - 1) * P;
  g.push(rect(-1.27, top + 1.27, 1.27, bottom - 1.27, 0.254, "background"));
  return makeSymbol(name, "J", g, pins, { description: "Generic connector, single row", hidePinNames: true, refAt: [0, top + 2.54], valAt: [0, bottom - 2.54] });
}
const KICAD_ETYPES = new Set(["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"]);
const ETYPE_ALIASES = { in: "input", out: "output", io: "bidirectional", "i/o": "bidirectional", bidir: "bidirectional", power: "power_in", pwr: "power_in", supply: "power_in", ground: "power_in", gnd: "power_in", nc: "no_connect", analog: "passive", open_drain: "open_collector", od: "open_collector", tristate: "tri_state", "": "passive" };
function normEtype(t) { t = String(t || "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_"); if (t in ETYPE_ALIASES) t = ETYPE_ALIASES[t]; return KICAD_ETYPES.has(t) ? t : "passive"; }
function isGndName(name) { const n = String(name).toUpperCase().replace(/[^A-Z0-9]/g, ""); return /^(A|D|P|S)?GND\d*$|^VSS[AD]?\d*$|^EP$|^EPAD$|^PAD$|^THERMALPAD$|^PGND\d*$|^TAB$/.test(n); }
function icSymbolNode(name, pins, o) {
  o = o || {};
  const sides = { left: [], right: [], top: [], bottom: [] }; const undecided = [];
  for (const p of pins) { const side = String(p.side || "").trim().toLowerCase(); if (sides[side]) sides[side].push(p); else undecided.push(p); }
  for (const p of undecided) {
    const et = normEtype(p.etype);
    if (isGndName(p.name || "")) sides.bottom.push(p);
    else if (["output", "power_out", "open_collector", "open_emitter", "tri_state"].includes(et)) sides.right.push(p);
    else if (et === "input" || et === "power_in") sides.left.push(p);
    else (sides.left.length <= sides.right.length ? sides.left : sides.right).push(p);
  }
  if (!sides.left.length && !sides.right.length && (sides.top.length || sides.bottom.length)) { sides.left = sides.top; sides.top = []; }
  const textw = (s) => String(s).length + 1.0;
  const mx = (arr) => arr.length ? Math.max(...arr.map((p) => textw(p.name || ""))) : 0;
  const maxL = mx(sides.left), maxR = mx(sides.right), maxT = mx(sides.top), maxB = mx(sides.bottom);
  const vpitch = 2 * P, nTb = Math.max(sides.top.length, sides.bottom.length);
  let width = Math.max(4 * P, maxL + maxR + 2 * P, nTb ? (nTb + 1) * vpitch : 0, textw(name) + P);
  width = Math.ceil(width / (2 * P)) * 2 * P;
  const rows = Math.max(sides.left.length, sides.right.length, 1);
  const extraT = sides.top.length ? Math.ceil(maxT / P) * P : 0, extraB = sides.bottom.length ? Math.ceil(maxB / P) * P : 0;
  let height = (rows + 1) * P + extraT + extraB; height = Math.ceil(height / (2 * P)) * 2 * P;
  const hw = width / 2, hh = height / 2;
  const numlen = pins.length ? Math.max(...pins.map((p) => String(p.number || "").length)) : 1;
  let plen = numlen <= 2 ? P : numlen <= 4 ? 1.5 * P : 2 * P; plen = Math.ceil(plen / 1.27 - 1e-9) * 1.27;
  const pinNodes = [], seen = new Set();
  const addPin = (p, x, y, angle) => {
    let number = String(p.number || "").trim() || "?"; const base = number; let k = 2;
    while (seen.has(number)) { number = base + "_" + k; k++; }
    seen.add(number);
    pinNodes.push(pinNode(normEtype(p.etype), x, y, angle, plen, String(p.name || "").trim() || "~", number));
  };
  const y0 = hh - extraT - P;
  sides.left.forEach((p, i) => addPin(p, -(hw + plen), y0 - i * P, 0));
  sides.right.forEach((p, i) => addPin(p, hw + plen, y0 - i * P, 180));
  for (const [key, ang, ysign] of [["top", 270, 1], ["bottom", 90, -1]]) {
    const n = sides[key].length;
    sides[key].forEach((p, j) => { const x = Math.round(((j - (n - 1) / 2) * vpitch) / 1.27) * 1.27; addPin(p, x, ysign * (hh + plen), ang); });
  }
  const fieldX = (key) => { const n = sides[key].length; return n ? Math.round((((n - 1) / 2) * vpitch) / 1.27) * 1.27 + 2.54 : -hw; };
  return makeSymbol(name, o.ref || "U", [rect(-hw, hh, hw, -hh, 0.254, "background")], pinNodes,
    { description: o.description || "", datasheet: o.datasheet || "~", footprint: o.footprint || "", refAt: [fieldX("top"), hh + 1.27], valAt: [fieldX("bottom"), -(hh + 1.27)], refJustify: "left", valJustify: "left" });
}
let _builtins = null;
function builtinSymbols() {
  if (_builtins) return _builtins;
  const out = {}; const add = (lib, node) => { out[lib + ":" + node[1]] = node; };
  add("Device", twoPinVertical("R", "R", [rect(-1.016, -2.54, 1.016, 2.54)], "Resistor"));
  add("Device", twoPinVertical("C", "C", [poly([[-2.032, -0.762], [2.032, -0.762]], 0.508), poly([[-2.032, 0.762], [2.032, 0.762]], 0.508)], "Unpolarized capacitor", 2.794));
  add("Device", twoPinVertical("C_Polarized", "C", [rect(-2.286, 0.508, 2.286, 1.016), rect(-2.286, -0.508, 2.286, -1.016, 0.254, "outline"), poly([[-1.778, 2.286], [-0.762, 2.286]]), poly([[-1.27, 2.794], [-1.27, 1.778]])], "Polarized capacitor", 2.794));
  add("Device", twoPinVertical("L", "L", [arc(0, -2.54, 0.635, -1.905, 0, -1.27), arc(0, -1.27, 0.635, -0.635, 0, 0), arc(0, 0, 0.635, 0.635, 0, 1.27), arc(0, 1.27, 0.635, 1.905, 0, 2.54)], "Inductor"));
  add("Device", twoPinVertical("FerriteBead", "FB", [poly([[-2.286, -1.524], [-0.254, -2.667], [2.286, 1.524], [0.254, 2.667], [-2.286, -1.524]])], "Ferrite bead", 2.54));
  add("Device", twoPinVertical("Fuse", "F", [rect(-0.762, -2.54, 0.762, 2.54), poly([[0, 2.54], [0, -2.54]], 0)], "Fuse"));
  add("Device", twoPinVertical("Thermistor_NTC", "TH", [rect(-1.016, -2.54, 1.016, 2.54), poly([[-2.54, 2.54], [-2.54, 1.524], [2.54, -1.524], [2.54, -2.54]], 0)], "NTC thermistor"));
  add("Device", diode("D", [poly([[-1.27, 1.27], [-1.27, -1.27]])], "Diode"));
  add("Device", diode("D_Schottky", [poly([[-1.905, 0.635], [-1.905, 1.27], [-1.27, 1.27], [-1.27, -1.27], [-0.635, -1.27], [-0.635, -0.635]])], "Schottky diode"));
  add("Device", diode("D_Zener", [poly([[-1.27, -1.27], [-1.27, 1.27], [-0.762, 1.27]])], "Zener diode"));
  add("Device", diode("D_TVS", [poly([[-1.778, -1.27], [-1.27, -1.27], [-1.27, 1.27], [-0.762, 1.27]])], "TVS diode"));
  add("Device", diode("LED", [poly([[-1.27, 1.27], [-1.27, -1.27]]), poly([[-3.048, -0.762], [-4.572, -2.286], [-3.81, -2.286], [-4.572, -2.286], [-4.572, -1.524]], 0), poly([[-1.778, -0.762], [-3.302, -2.286], [-2.54, -2.286], [-3.302, -2.286], [-3.302, -1.524]], 0)], "Light emitting diode"));
  for (const order of ["BCE", "BEC", "EBC", "CBE", "ECB"]) { add("Device", transistor("Q_NPN_" + order, "npn", order, "NPN transistor")); add("Device", transistor("Q_PNP_" + order, "pnp", order, "PNP transistor")); }
  for (const order of ["GSD", "GDS", "SGD", "DGS"]) { add("Device", transistor("Q_NMOS_" + order, "nmos", order, "N-channel MOSFET")); add("Device", transistor("Q_PMOS_" + order, "pmos", order, "P-channel MOSFET")); }
  add("Device", makeSymbol("Crystal", "Y", [rect(-1.143, 2.54, 1.143, -2.54, 0.3048), poly([[-2.54, 0], [-1.905, 0]], 0), poly([[-1.905, -1.27], [-1.905, 1.27]], 0.508), poly([[1.905, -1.27], [1.905, 1.27]], 0.508), poly([[2.54, 0], [1.905, 0]], 0)],
    [pinNode("passive", -3.81, 0, 0, 1.27, "1", "1"), pinNode("passive", 3.81, 0, 180, 1.27, "2", "2")], { description: "Two pin crystal", hidePinNumbers: true, hidePinNames: true, refAt: [0, 3.81], valAt: [0, -3.81] }));
  add("Device", makeSymbol("R_Potentiometer", "RV", [rect(-1.016, -2.54, 1.016, 2.54), poly([[1.143, 0], [2.286, 0.508], [2.286, -0.508], [1.143, 0]], 0, "outline"), poly([[2.54, 0], [1.524, 0]], 0)],
    [pinNode("passive", 0, 3.81, 270, 1.27, "1", "1"), pinNode("passive", 3.81, 0, 180, 1.27, "2", "2"), pinNode("passive", 0, -3.81, 90, 1.27, "3", "3")], { description: "Potentiometer", hidePinNames: true, refAt: [-4.445, 0], valAt: [-2.54, 0], fieldAngle: 90 }));
  add("Switch", makeSymbol("SW_Push", "SW", [circle(-2.032, 0, 0.508, 0), circle(2.032, 0, 0.508, 0), poly([[0, 1.27], [0, 3.048]], 0), poly([[2.54, 1.27], [-2.54, 1.27]], 0)],
    [pinNode("passive", -5.08, 0, 0, 2.54, "1", "1"), pinNode("passive", 5.08, 0, 180, 2.54, "2", "2")], { description: "Push button switch", hidePinNumbers: true, hidePinNames: true, refAt: [1.27, 5.08], valAt: [0, -1.524] }));
  add("Connector", makeSymbol("TestPoint", "TP", [circle(0, 3.302, 0.762, 0)], [pinNode("passive", 0, 0, 90, 2.54, "1", "1")], { description: "Test point", hidePinNumbers: true, hidePinNames: true, refAt: [0, 6.858], valAt: [0, 5.08] }));
  add("Jumper", makeSymbol("SolderJumper_2_Open", "JP", [arc(-0.254, 1.016, -1.27, 0, -0.254, -1.016, 0), arc(0.254, -1.016, 1.27, 0, 0.254, 1.016, 0)],
    [pinNode("passive", -3.81, 0, 0, 2.54, "A", "1"), pinNode("passive", 3.81, 0, 180, 2.54, "B", "2")], { description: "Solder jumper", hidePinNumbers: true, hidePinNames: true, refAt: [0, 2.032], valAt: [0, -2.54] }));
  _builtins = out; return out;
}

root.DS2K_P1 = { GRID, P, Sym, S, isSym, dumps, parse, head, children, child, fnum, str, transform, pinOutward, Pin, SymbolDef, renameSymbol, cloneNode,
  powerStyle, powerSymbolNode, connectorNode, icSymbolNode, builtinSymbols, normEtype, effects };
})(typeof window !== "undefined" ? window : globalThis);

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

/* datasheet2kicad browser engine - part 3: schematic layout (port of ds2kicad/layout.py) */
(function (root) {
"use strict";
const { GRID, transform, pinOutward, powerStyle, child, fnum, str, isSym } = root.DS2K_P1;
const { canonicalPowerName, isAutoName, usedPinsOf } = root.DS2K_P2;

const U = (mm) => Math.round(mm / GRID);
const textW = (s) => Math.ceil(0.9 * String(s || "").length) + 1;
const mod2 = (x) => ((x % 2) + 2) % 2;
const STUB = 2, LANE_GAP = 2, COL = 2;

class SymInst {
  constructor(sym, libId, ref, value, x, y, rot, mirror, unit) {
    Object.assign(this, { kind: "sym", sym, libId, ref, value, x, y, rot: rot || 0, mirror: mirror || "", unit: unit || 1,
      footprint: "", datasheet: "", description: "", extraFields: {}, dnp: false, isPower: sym.isPower, fieldPos: {} });
  }
  pinXY(p) { const t = transform(p.x / GRID, p.y / GRID, this.rot, this.mirror); return [this.x + Math.round(t[0]), this.y + Math.round(t[1])]; }
  pinDir(p) { return pinOutward(p.angle, this.rot, this.mirror); }
  bodyBox() {
    const [x1, y1, x2, y2] = this.sym.bodyBbox(this.unit); const xs = [], ys = [];
    for (const [x, y] of [[x1, y1], [x1, y2], [x2, y1], [x2, y2]]) { const t = transform(x / GRID, y / GRID, this.rot, this.mirror); xs.push(this.x + t[0]); ys.push(this.y + t[1]); }
    for (const p of this.sym.pinsForUnit(this.unit)) { const q = this.pinXY(p); xs.push(q[0]); ys.push(q[1]); }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  bbox() {
    let [x1, y1, x2, y2] = this.bodyBox();
    for (const name of Object.keys(this.fieldPos)) {
      const [fx, fy, horiz, just] = this.fieldPos[name];
      const txt = name === "Reference" ? this.ref : name === "Value" ? this.value : "";
      if (!txt) continue;
      const w = textW(txt);
      if (horiz) { const bx1 = just === "left" ? fx : just === "right" ? fx - w : fx - w / 2; x1 = Math.min(x1, bx1); x2 = Math.max(x2, bx1 + w); y1 = Math.min(y1, fy - 0.7); y2 = Math.max(y2, fy + 0.7); }
      else { x1 = Math.min(x1, fx - 0.7); x2 = Math.max(x2, fx + 0.7); y1 = Math.min(y1, fy - w / 2); y2 = Math.max(y2, fy + w / 2); }
    }
    return [x1, y1, x2, y2];
  }
  translate(dx, dy) { this.x += dx; this.y += dy; for (const k of Object.keys(this.fieldPos)) { const v = this.fieldPos[k]; this.fieldPos[k] = [v[0] + dx, v[1] + dy, v[2], v[3]]; } }
}
class Wire { constructor(x1, y1, x2, y2) { Object.assign(this, { kind: "wire", x1, y1, x2, y2 }); } bbox() { return [Math.min(this.x1, this.x2), Math.min(this.y1, this.y2), Math.max(this.x1, this.x2), Math.max(this.y1, this.y2)]; } translate(dx, dy) { this.x1 += dx; this.x2 += dx; this.y1 += dy; this.y2 += dy; } }
class Junction { constructor(x, y) { Object.assign(this, { kind: "junction", x, y }); } bbox() { return [this.x, this.y, this.x, this.y]; } translate(dx, dy) { this.x += dx; this.y += dy; } }
class NoConnect extends Junction { constructor(x, y) { super(x, y); this.kind = "nc"; } }
class Label {
  constructor(name, x, y, angle, type, shape) { Object.assign(this, { kind: "label", name, x, y, angle, type: type || "local", shape: shape || "passive" }); }
  bbox() {
    const g = this.type === "global", w = textW(this.name) + (g ? 3 : 0), h = g ? 1.0 : 1.4, lo = g ? h : 0.2;
    if (this.angle === 0) return [this.x, this.y - h, this.x + w, this.y + lo];
    if (this.angle === 180) return [this.x - w, this.y - h, this.x, this.y + lo];
    if (this.angle === 90) return [this.x - h, this.y - w, this.x + lo, this.y];
    return [this.x - h, this.y, this.x + lo, this.y + w];
  }
  translate(dx, dy) { this.x += dx; this.y += dy; }
}
class Text {
  constructor(text, x, y, size) { Object.assign(this, { kind: "text", text, x, y, size: size || 1.27 }); }
  bbox() { const lines = this.text.split("\n"); const k = this.size / 1.27; return [this.x, this.y, this.x + Math.max(...lines.map((l) => l.length)) * 0.9 * k, this.y + lines.length * 1.7 * k]; }
  translate(dx, dy) { this.x += dx; this.y += dy; }
}
class Group {
  constructor() { this.items = []; }
  add(it) { this.items.push(it); return it; }
  extend(o) { for (const it of o.items) this.items.push(it); }
  bbox() { if (!this.items.length) return [0, 0, 0, 0]; const bs = this.items.map((i) => i.bbox()); return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))]; }
  translate(dx, dy) { for (const it of this.items) it.translate(dx, dy); }
}

function twoPinGeometry(sym) {
  const pins = sym.allPins(); if (pins.length !== 2 || sym.unitCount !== 1) return null;
  const [a, b] = pins; const ax = U(a.x), ay = U(a.y), bx = U(b.x), by = U(b.y); let length;
  if (ax === bx && ay !== by) length = Math.abs(ay - by); else if (ay === by && ax !== bx) length = Math.abs(ax - bx); else return null;
  const oa = pinOutward(a.angle, 0), ob = pinOutward(b.angle, 0);
  if (oa[0] + ob[0] !== 0 || oa[1] + ob[1] !== 0) return null;
  return [a, b, length];
}

class Layout {
  constructor(circuit, resolver, options) {
    this.circ = circuit; this.resolver = resolver; this.opt = options || {}; this.warnings = [];
    this.parts = new Map(); this.nets = new Map(); this.pwrCounter = 0; this.flagCounter = 0; this.forceLabels = new Set(); this.paper = "A4";
    this._prepare();
  }
  _prepare() {
    for (const c of this.circ.components) { const res = this.resolver.resolve(c, usedPinsOf(this.circ, c.ref)); this.parts.set(c.ref, { res, ref: c.ref, sym: res.sym, comp: c, pinNet: new Map(), axis: null, placed: false }); }
    for (const n of this.circ.nets) {
      const ln = { name: n.name, display: n.name, kind: n.kind, port: n.port, powerName: null, auto: isAutoName(n.name), nodes: [], sites: 0 };
      const pname = canonicalPowerName(n.name); if (pname) ln.powerName = pname;
      for (const [ref, pin] of n.nodes) {
        const part = this.parts.get(ref); if (!part) continue;
        const num = part.res.pinMap[pin];
        if (num === undefined) { this.warnings.push(ref + ": pin " + pin + " has no counterpart on symbol " + part.res.libId + " - left unconnected"); continue; }
        if (part.pinNet.has(num) && part.pinNet.get(num) !== ln) { this.warnings.push(ref + " pin " + num + " is on two nets"); continue; }
        part.pinNet.set(num, ln); ln.nodes.push([ref, num]);
      }
      this.nets.set(ln.name, ln);
    }
    for (const part of this.parts.values()) part.axis = twoPinGeometry(part.sym);
    this._deriveNames();
  }
  _deriveNames() {
    const taken = new Set([...this.nets.values()].filter((n) => !n.auto).map((n) => n.display.toUpperCase()));
    for (const ln of this.nets.values()) {
      if (!ln.auto) continue; let cand = null;
      for (const [ref, num] of ln.nodes) {
        const part = this.parts.get(ref);
        if (part.axis === null && !part.comp.isTwoPin) {
          const p = part.sym.pin(num); const nm = ((p ? p.name : "") || "").replace(/[^A-Za-z0-9_+\-]/g, "");
          if (nm && nm !== "~" && !/^\d+$/.test(nm)) {
            const alone = ln.nodes.filter(([r]) => !this.parts.get(r).comp.isTwoPin).length === 1;
            const descriptive = nm.length >= 2 && ["ic", "other", "connector"].includes(part.comp.type);
            cand = (alone && descriptive) ? nm : ref + "_" + nm; break;
          }
        }
      }
      if (cand === null) { const [ref, num] = ln.nodes.length ? ln.nodes[0] : ["NET", "0"]; cand = "Net_" + ref + "_" + num; }
      const base = cand; let k = 2; while (taken.has(cand.toUpperCase())) { cand = base + "_" + k; k++; }
      taken.add(cand.toUpperCase()); ln.display = cand;
    }
  }
  /* helpers */
  _isPower(net) { return !!net && net.powerName !== null; }
  _wantsLabel(net) { return !net.auto || this.forceLabels.has(net.name); }
  _twopinsOn(net) {
    const out = [];
    for (const [ref] of net.nodes) {
      const part = this.parts.get(ref);
      if (part.axis !== null && !part.placed && !out.includes(part)) { const [a, b] = part.axis; if (part.pinNet.get(a.number) === part.pinNet.get(b.number)) continue; out.push(part); }
    }
    return out;
  }
  _other(part, net) { const [a, b] = part.axis; const na = part.pinNet.get(a.number) || null, nb = part.pinNet.get(b.number) || null; return na === net ? [a, b, nb] : [b, a, na]; }
  _newInst(part, x, y, rot, mirror, unit) {
    const c = part.comp; const inst = new SymInst(part.sym, part.res.libId, c.ref, c.value || c.mpn || part.sym.name, x, y, rot, mirror, unit);
    inst.footprint = part.res.footprint; inst.description = c.description; inst.dnp = c.dnp; return inst;
  }
  _placeTwoPin(g, part, pinA, pa, dir, textSide) {
    const [a, b, length] = part.axis; const pinB = pinA === a ? b : a; let inst = null;
    for (const rot of [0, 90, 180, 270]) {
      const ta = transform(pinA.x / GRID, pinA.y / GRID, rot), tb = transform(pinB.x / GRID, pinB.y / GRID, rot);
      if (Math.round(tb[0] - ta[0]) === dir[0] * length && Math.round(tb[1] - ta[1]) === dir[1] * length) { inst = this._newInst(part, pa[0] - Math.round(ta[0]), pa[1] - Math.round(ta[1]), rot); break; }
    }
    if (!inst) throw new Error("cannot orient " + part.ref);
    const pb = [pa[0] + dir[0] * length, pa[1] + dir[1] * length];
    const [bx1, by1, bx2, by2] = inst.bodyBox(); const cx = (pa[0] + pb[0]) / 2, cy = (pa[1] + pb[1]) / 2;
    if (dir[0] === 0) {
      const half = Math.max(Math.abs(bx1 - cx), Math.abs(bx2 - cx));
      for (const [fname, txt, dy] of [["Reference", inst.ref, -1], ["Value", inst.value, 1]]) inst.fieldPos[fname] = [cx + textSide * (half + 0.8 + 0.9 * String(txt || "").length / 2), cy + dy, true, "center"];
    } else {
      const half = Math.max(Math.abs(by1 - cy), Math.abs(by2 - cy));
      inst.fieldPos.Reference = [cx, cy - half - 1.2, true, "center"]; inst.fieldPos.Value = [cx, cy + half + 1.2, true, "center"];
    }
    part.placed = true; g.add(inst); return [inst, pb];
  }
  _powerLibDir(sym) {
    const p = sym.allPins()[0]; const a = p.angle * Math.PI / 180; let d = [Math.round(Math.cos(a)), Math.round(Math.sin(a))];
    const [x1, y1, x2, y2] = sym.bodyBbox(1); const cx = (x1 + x2) / 2 - p.x, cy = (y1 + y2) / 2 - p.y;
    if (Math.abs(cx) > Math.abs(cy)) d = [cx > 0 ? 1 : -1, 0]; else if (Math.abs(cy) > 0) d = [0, cy > 0 ? 1 : -1];
    return d;
  }
  _powerInst(g, net, at, bodyDir) {
    const sym = this.resolver.powerSymbol(net.powerName); const p = sym.allPins()[0]; const libDir = this._powerLibDir(sym); let rotFound = 0;
    for (const rot of [0, 90, 180, 270]) { const t = transform(libDir[0], libDir[1], rot); if (Math.round(t[0]) === bodyDir[0] && Math.round(t[1]) === bodyDir[1]) { rotFound = rot; break; } }
    this.pwrCounter++; const ref = "#PWR" + String(this.pwrCounter).padStart(3, "0"); const tp = transform(p.x / GRID, p.y / GRID, rotFound);
    const inst = new SymInst(sym, this.resolver.projectLib + ":" + sym.name, ref, net.powerName, at[0] - Math.round(tp[0]), at[1] - Math.round(tp[1]), rotFound);
    const w = textW(net.powerName);
    inst.fieldPos.Value = bodyDir[0] === 0 ? [at[0], at[1] + bodyDir[1] * 3.3, true, "center"] : [at[0] + bodyDir[0] * (2.8 + w / 2), at[1], true, "center"];
    g.add(inst); return inst;
  }
  _powerStyleDir(net) {
    const sym = this.resolver.powerSymbol(net.powerName); const p = sym.allPins()[0]; const bb = sym.bodyBbox(1); const cy = (bb[1] + bb[3]) / 2 - p.y;
    if (Math.abs(cy) < 1e-6) return ["gnd", "down"].includes(powerStyle(net.powerName)) ? 1 : -1;
    return cy < 0 ? 1 : -1;
  }
  _shape(net) { return { input: "input", output: "output", bidirectional: "bidirectional" }[net.port] || "passive"; }
  _label(g, net, x, y, angle) {
    net.sites++; if (!this._wantsLabel(net)) return;
    if (net.port !== "none") g.add(new Label(net.display, x, y, angle, "global", this._shape(net))); else g.add(new Label(net.display, x, y, angle, "local"));
  }
  _labelW(net) { return this._wantsLabel(net) ? textW(net.display) + (net.port !== "none" ? 3 : 0) : 0; }
  /* which series part may carry a rail into a net */
  _entryRank(part) { const t = part.comp.type; return ["inductor", "ferrite_bead", "fuse"].includes(t) ? 3 : (t.includes("diode") || t === "led") ? 2 : 1; }
  _bestEntryRank(net) {
    let best = 0;
    for (const [ref] of net.nodes) { const part = this.parts.get(ref); if (part.axis === null) continue; const other = this._other(part, net)[2]; if (other && other !== net && !this._isPower(other)) best = Math.max(best, this._entryRank(part)); }
    return best;
  }
  _mayContinue(part, net, owned, sideNets) { const other = this._other(part, net)[2]; if (!other || this._isPower(other) || owned.has(other.name) || sideNets.has(other.name)) return false; return this._entryRank(part) >= this._bestEntryRank(other); }
  _treeWeight(net, owned, sideNets, seen) {
    seen = seen || new Set(); seen.add(net.name); let w = 0;
    for (const part of this._twopinsOn(net)) { w += 1 + (this._entryRank(part) === 3 ? 2 : 0); const other = this._other(part, net)[2]; if (other && !seen.has(other.name) && this._mayContinue(part, net, owned, sideNets)) w += this._treeWeight(other, owned, sideNets, seen); }
    return w;
  }
  _railWires(g, x0, y0, taps, xEnd) {
    const pts = [x0].concat(taps); if (xEnd !== null && xEnd !== undefined) pts.push(xEnd);
    const ordered = []; for (const p of pts) if (!ordered.length || ordered[ordered.length - 1] !== p) ordered.push(p);
    for (let i = 0; i + 1 < ordered.length; i++) g.add(new Wire(ordered[i], y0, ordered[i + 1], y0));
  }
  _chainable(part, net) {
    const other = this._other(part, net)[2]; if (!other || this._isPower(other)) return false;
    const nxt = this._twopinsOn(other).filter((p) => p !== part); if (nxt.length !== 1) return false;
    const far = this._other(nxt[0], other)[2]; return !!far && this._isPower(far);
  }
  _chainDir(part, net) {
    if (this._chainable(part, net)) { const other = this._other(part, net)[2]; const nxt = this._twopinsOn(other).filter((p) => p !== part)[0]; return this._powerStyleDir(this._other(nxt, other)[2]); }
    return 1;
  }
  _decouplingOn(net) { return this._twopinsOn(net).filter((part) => { const o = this._other(part, net)[2]; return o && this._isPower(o); }); }
  _drawPowerRail(g, net, d, owned) {
    const taps = []; let x = 0;
    for (const part of this._decouplingOn(net)) x = this._hang(g, part, net, x, 0, d, this._powerStyleDir(this._other(part, net)[2]), taps, owned);
    let xEnd = x + d * 2; xEnd += d * mod2(xEnd);
    this._railWires(g, 0, 0, taps, xEnd); this._powerInst(g, net, [xEnd, 0], [0, this._powerStyleDir(net)]);
  }
  _hang(g, part, net, x, y0, d, vdir, taps, owned) {
    const [pinA, , other] = this._other(part, net); const tw = Math.max(textW(part.comp.ref), textW(part.comp.value || ""));
    let xc = x + d * 2; xc += d * mod2(xc); taps.push(xc);
    const y = y0 + vdir * 2; g.add(new Wire(xc, y0, xc, y));
    const pb = this._placeTwoPin(g, part, pinA, [xc, y], [0, vdir], d)[1];
    let right = 2 + tw + 1, curNet = other, curPart = part, curEnd = pb, hops = 0;
    for (;;) {
      if (!curNet) break;
      if (this._isPower(curNet)) { this._powerInst(g, curNet, curEnd, [0, this._powerStyleDir(curNet)]); right = Math.max(right, 2 + Math.floor(textW(curNet.powerName) / 2) + 1); break; }
      const nxt = this._twopinsOn(curNet).filter((p) => p !== curPart); const node = [curEnd[0], curEnd[1] + vdir * 2]; let canChain = false;
      if (nxt.length === 1 && hops < 2) { const far = this._other(nxt[0], curNet)[2]; if (far && this._isPower(far) && this._powerStyleDir(far) === vdir) canChain = true; }
      const hasElsewhere = curNet.nodes.length > (canChain ? 2 : 1);
      g.add(new Wire(curEnd[0], curEnd[1], node[0], node[1]));
      if (hasElsewhere || this._wantsLabel(curNet)) {
        const lw = this._labelW(curNet);
        if (hasElsewhere || lw) { g.add(new Wire(node[0], node[1], node[0] + d * 2, node[1])); this._label(g, curNet, node[0] + d * 2, node[1], d > 0 ? 0 : 180); right = Math.max(right, 2 + 2 + lw + 1); }
      }
      if (!canChain) break;
      owned.add(curNet.name);
      const nxtPart = nxt[0]; const [na, , far] = this._other(nxtPart, curNet); const ya = node[1] + vdir * 2;
      g.add(new Wire(node[0], node[1], node[0], ya));
      const pb2 = this._placeTwoPin(g, nxtPart, na, [node[0], ya], [0, vdir], d)[1];
      right = Math.max(right, 2 + Math.max(textW(nxtPart.comp.ref), textW(nxtPart.comp.value || "")) + 1);
      curNet = far; curPart = nxtPart; curEnd = pb2; hops++;
    }
    let nx = xc + d * right; nx += d * mod2(nx); return nx;
  }
  _drawRail(g, net, x0, y0, d, owned, sideNets, rootLabel, depth) {
    depth = depth || 0; owned.add(net.name);
    const downs = [], ups = [], signal = [];
    for (const part of this._twopinsOn(net)) { const other = this._other(part, net)[2]; if (!other) downs.push(part); else if (this._isPower(other)) (this._powerStyleDir(other) > 0 ? downs : ups).push(part); else signal.push(part); }
    let inline = null, bestScore = -1;
    for (const part of signal) {
      const other = this._other(part, net)[2]; if (depth >= 6 || !this._mayContinue(part, net, owned, sideNets)) continue;
      const score = this._twopinsOn(other).filter((p) => p !== part).length + 3 * this._entryRank(part);
      if (score > bestScore) { inline = part; bestScore = score; }
    }
    let rest = signal.filter((p) => p !== inline), bridge = null;
    if (!inline && rest.length === 1 && !downs.length && !ups.length && !this._chainable(rest[0], net)) { bridge = rest[0]; rest = []; }
    const taps = []; let x = x0; const through = !!inline || !!bridge;
    if (through && !rootLabel) {
      net.sites++;
      if (this._wantsLabel(net)) {
        let xLab = x + d * 2; xLab += d * mod2(xLab); taps.push(xLab);
        if (net.port !== "none") { g.add(new Wire(xLab, y0, xLab, y0 - 2)); g.add(new Label(net.display, xLab, y0 - 2, 90, "global", this._shape(net))); x = xLab + d * 2; }
        else { g.add(new Label(net.display, xLab, y0, d > 0 ? 0 : 180, "local")); x = xLab + d * (textW(net.display) + 1); }
        x += d * mod2(x);
      }
    }
    for (const part of downs) x = this._hang(g, part, net, x, y0, d, 1, taps, owned);
    for (const part of ups) x = this._hang(g, part, net, x, y0, d, -1, taps, owned);
    for (const part of rest) x = this._hang(g, part, net, x, y0, d, this._chainDir(part, net), taps, owned);
    if (through) {
      const part = inline || bridge; const [pinA, , other] = this._other(part, net); const length = part.axis[2];
      const tw = Math.max(textW(part.comp.ref), textW(part.comp.value || "")); let pad = 2 + Math.max(0, Math.ceil((tw - length) / 2)); pad += mod2(pad);
      const xa = x + d * pad; const pb = this._placeTwoPin(g, part, pinA, [xa, y0], [d, 0], d)[1];
      let start = (rootLabel && taps.length && !this._wantsLabel(net)) ? taps[0] : x0; if (rootLabel && !taps.length && !this._wantsLabel(net)) start = xa;
      this._railWires(g, start, y0, taps, xa);
      if (inline) { const xNext = pb[0] + d * (pad - 2); if (xNext !== pb[0]) g.add(new Wire(pb[0], y0, xNext, y0)); return this._drawRail(g, other, xNext, y0, d, owned, sideNets, false, depth + 1); }
      if (this._wantsLabel(other)) { g.add(new Wire(pb[0], y0, pb[0] + d * pad, y0)); this._label(g, other, pb[0] + d * pad, y0, d > 0 ? 0 : 180); } else other.sites++;
      return pb[0] + d * (pad + this._labelW(other));
    }
    if (rootLabel) { const start = (this._wantsLabel(net) || !taps.length) ? x0 : taps[0]; this._railWires(g, start, y0, taps, null); return x; }
    if (this._wantsLabel(net)) {
      let xEnd = taps.length ? x : x0 + d * 2; if (xEnd === (taps.length ? taps[taps.length - 1] : x0)) xEnd += d * 2;
      this._railWires(g, x0, y0, taps, xEnd); this._label(g, net, xEnd, y0, d > 0 ? 0 : 180); return xEnd + d * this._labelW(net);
    }
    net.sites++; this._railWires(g, x0, y0, taps, null); return x;
  }
  /* anchors */
  _anchorPrepare(part, unit) {
    const g = new Group(); const inst = this._newInst(part, 0, 0, 0, "", unit);
    for (const fname of ["Reference", "Value"]) {
      const node = part.sym.propNodes[fname]; let fx = 0, fy = 0, just = "center", horiz = true;
      if (node) {
        const at = child(node, "at"); if (at) { fx = fnum(at[1]) / GRID; fy = -fnum(at[2]) / GRID; horiz = at.length > 3 ? (Math.round(fnum(at[3])) % 180 === 0) : true; }
        const eff = child(node, "effects"); const j = eff ? child(eff, "justify") : null;
        if (j) { const toks = j.slice(1).map(str); just = toks.includes("left") ? "left" : toks.includes("right") ? "right" : "center"; }
      }
      inst.fieldPos[fname] = [fx, fy, horiz, just];
    }
    g.add(inst); part.placed = true;
    const sites = new Map();
    for (const p of part.sym.pinsForUnit(unit)) { if (p.unit === 0 && unit !== 1 && part.sym.unitCount > 1) continue; const q = inst.pinXY(p); const key = q[0] + "," + q[1]; if (!sites.has(key)) sites.set(key, { pos: q, pins: [] }); sites.get(key).pins.push(p); }
    const nc = new Set(this.circ.noConnects.filter(([r]) => this.parts.has(r)).map(([r, pn]) => r + "\u0000" + (this.parts.get(r).res.pinMap[pn] || pn)));
    const rows = { left: [], right: [], top: [], bottom: [] };
    for (const { pos, pins } of sites.values()) {
      let net = null; for (const p of pins) if (part.pinNet.has(p.number)) { net = part.pinNet.get(p.number); break; }
      const [dx, dy] = inst.pinDir(pins[0]); const side = dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "top" : "bottom";
      rows[side].push({ pos, pins, net, nc: pins.some((p) => nc.has(part.ref + "\u0000" + p.number)), lane: null, side });
    }
    return { part, unit, inst, group: g, rows };
  }
  _anchorFinish(ctx) {
    const g = ctx.group, rows = ctx.rows;
    for (const [side, d] of [["left", -1], ["right", 1]]) {
      const rs = rows[side].slice().sort((a, b) => a.pos[1] - b.pos[1]); let labelZone = STUB; const built = [];
      for (const r of rs) {
        const net = r.net, [x, y] = r.pos;
        if (!net) { if (r.nc || r.pins.every((p) => p.etype === "no_connect")) g.add(new NoConnect(x, y)); continue; }
        if (r.lane) { const b = r.lane.bbox(); built.push([r, r.lane, Math.max(0, Math.ceil(-b[1])), Math.max(0, Math.ceil(b[3]))]); continue; }
        g.add(new Wire(x, y, x + d * STUB, y));
        if (this._isPower(net)) { this._powerInst(g, net, [x + d * STUB, y], [d, 0]); labelZone = Math.max(labelZone, STUB + 4 + textW(net.powerName)); }
        else { this._label(g, net, x + d * STUB, y, d > 0 ? 0 : 180); labelZone = Math.max(labelZone, STUB + this._labelW(net) + 1); }
      }
      if (!built.length) continue;
      let ys = [], prevBottom = null;
      for (const [r, , up, down] of built) { let y = r.pos[1]; if (prevBottom !== null) y = Math.max(y, prevBottom + LANE_GAP + up); y += mod2(y); ys.push(y); prevBottom = y + down; }
      let shift = Math.round(built.reduce((s, b, i) => s + (ys[i] - b[0].pos[1]), 0) / built.length); shift -= mod2(shift);
      ys = ys.map((y) => y - shift);
      const ups = [], dns = []; built.forEach((b, i) => { if (ys[i] < b[0].pos[1]) ups.push(i); else if (ys[i] > b[0].pos[1]) dns.push(i); });
      const colOf = new Map(); ups.forEach((i, k) => colOf.set(i, k + 1)); dns.slice().reverse().forEach((i, k) => colOf.set(i, k + 1));
      const ncols = colOf.size ? Math.max(...colOf.values()) : 0; const pinX = rs[0].pos[0];
      let xCols0 = pinX + d * (labelZone + 1); xCols0 += d * mod2(xCols0); const xStart = xCols0 + d * ((ncols + 1) * COL);
      built.forEach(([r, lg], i) => {
        const [px, py] = r.pos, y = ys[i];
        if (colOf.has(i)) { const xc = xCols0 + d * (colOf.get(i) * COL); g.add(new Wire(px, py, xc, py)); g.add(new Wire(xc, py, xc, y)); g.add(new Wire(xc, y, xStart, y)); }
        else g.add(new Wire(px, py, xStart, y));
        lg.translate(xStart, y); g.extend(lg);
      });
    }
    for (const [side, d] of [["top", -1], ["bottom", 1]]) {
      const rs = rows[side].slice().sort((a, b) => a.pos[0] - b.pos[0]); let k = 0;
      for (const r of rs) {
        const net = r.net, [x, y] = r.pos;
        if (!net) { if (r.nc || r.pins.every((p) => p.etype === "no_connect")) g.add(new NoConnect(x, y)); continue; }
        const stub = STUB + (k % 2 ? 4 : 0); k++;
        g.add(new Wire(x, y, x, y + d * stub));
        if (this._isPower(net)) this._powerInst(g, net, [x, y + d * stub], [0, d]); else this._label(g, net, x, y + d * stub, d < 0 ? 90 : 270);
      }
    }
    return g;
  }
  /* top level */
  run() {
    this.forceLabels = new Set(); let first = this._runOnce();
    const forced = new Set([...this.nets.values()].filter((n) => n.auto && n.sites > 1).map((n) => n.name)); for (const f of this.forceLabels) forced.add(f);
    if (forced.size) { this.forceLabels = forced; first = this._runOnce(); }
    this.items = first; return first;
  }
  _runOnce() {
    for (const p of this.parts.values()) p.placed = false; for (const n of this.nets.values()) n.sites = 0; this.pwrCounter = 0; this.flagCounter = 0;
    const owned = new Set(); const main = String(this.circ.part.mpn || "").toUpperCase();
    const anchors = [...this.parts.values()].filter((p) => p.axis === null);
    const key = (p) => [(main && ((p.comp.value || "").toUpperCase().includes(main) || (p.comp.mpn || "").toUpperCase().includes(main))) ? 0 : 1, p.comp.type === "ic" ? 0 : 1, -p.sym.allPins().length, p.ref];
    const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
    anchors.sort((a, b) => cmp(key(a), key(b)));
    const sideNets = new Set();
    for (const part of anchors) for (const p of part.sym.allPins()) if ((p.side === "left" || p.side === "right") && part.pinNet.has(p.number)) { const net = part.pinNet.get(p.number); if (!this._isPower(net)) sideNets.add(net.name); }
    const ctxs = [];
    for (const part of anchors) for (let unit = 1; unit <= part.sym.unitCount; unit++) { if (unit > 1 && !part.sym.allPins().some((p) => p.unit === unit)) continue; ctxs.push(this._anchorPrepare(part, unit)); }
    const cands = [];
    ctxs.forEach((ctx, ci) => { for (const side of ["left", "right"]) for (const r of ctx.rows[side].slice().sort((a, b) => a.pos[1] - b.pos[1])) {
      const net = r.net; if (!net) continue;
      if (this._isPower(net)) { if (this._powerStyleDir(net) < 0 && this._decouplingOn(net).length) cands.push([[-this._decouplingOn(net).length, ci, r.pos[1], side], side, r]); }
      else if (this._twopinsOn(net).length) cands.push([[-this._treeWeight(net, owned, sideNets), ci, r.pos[1], side], side, r]);
    } });
    cands.sort((a, b) => cmp(a[0], b[0]));
    for (const [, side, r] of cands) {
      const net = r.net, d = side === "left" ? -1 : 1;
      if (this._isPower(net)) { if (this._decouplingOn(net).length) { const lg = new Group(); this._drawPowerRail(lg, net, d, owned); r.lane = lg; } continue; }
      if (owned.has(net.name) || !this._twopinsOn(net).length) continue;
      const lg = new Group(); this._drawRail(lg, net, 0, 0, d, owned, sideNets); r.lane = lg;
    }
    const blocks = ctxs.map((ctx) => this._anchorFinish(ctx));
    for (;;) {
      const c2 = [...this.nets.values()].filter((n) => !this._isPower(n) && this._twopinsOn(n).length); if (!c2.length) break;
      const k2 = (n) => [owned.has(n.name) ? 1 : 0, -this._twopinsOn(n).length, n.auto ? 1 : 0, n.name]; c2.sort((a, b) => cmp(k2(a), k2(b)));
      const g = new Group(); this._label(g, c2[0], 0, 0, 180); this._drawRail(g, c2[0], 0, 0, 1, owned, new Set(), true); blocks.push(g);
    }
    const row = new Group(); let x = 0;
    for (const part of this.parts.values()) {
      if (part.placed || part.axis === null) continue;
      const [a, b] = part.axis; const na = part.pinNet.get(a.number) || null, nb = part.pinNet.get(b.number) || null; let top = a, bot = b;
      if (this._isPower(na) && this._powerStyleDir(na) > 0 && !(this._isPower(nb) && this._powerStyleDir(nb) > 0)) { top = b; bot = a; }
      const ntop = part.pinNet.get(top.number) || null, nbot = part.pinNet.get(bot.number) || null;
      const pb = this._placeTwoPin(row, part, top, [x, 0], [0, 1], 1)[1]; let extra = 0;
      for (const [net, pt, vd] of [[ntop, [x, 0], -1], [nbot, pb, 1]]) {
        if (!net) continue;
        if (this._isPower(net)) this._powerInst(row, net, pt, [0, vd]);
        else { row.add(new Wire(pt[0], pt[1], pt[0], pt[1] + vd * 2)); row.add(new Wire(pt[0], pt[1] + vd * 2, pt[0] + 2, pt[1] + vd * 2)); if (net.auto) this.forceLabels.add(net.name); this._label(row, net, pt[0] + 2, pt[1] + vd * 2, 0); extra = Math.max(extra, 2 + this._labelW(net)); }
      }
      x += 4 + Math.max(textW(part.comp.ref), textW(part.comp.value || ""), 6, extra); x += mod2(x);
    }
    if (row.items.length) blocks.push(row);
    const flags = this._powerFlags(); if (flags.items.length) blocks.push(flags);
    this._addJunctions(blocks);
    if (this.opt.notes) { const ng = new Group(); ng.add(new Text(String(this.opt.notes), 0, 0, 1.27)); blocks.push(ng); }
    return this._pack(blocks);
  }
  _powerFlags() {
    const g = new Group(); if (this.opt.noPwrFlags) return g; let x = 0;
    for (const net of this.nets.values()) {
      const etypes = []; for (const [ref, num] of net.nodes) { const p = this.parts.get(ref).sym.pin(num); if (p) etypes.push(p.etype); }
      if (!etypes.includes("power_in") || etypes.includes("power_out")) continue;
      const sym = this.resolver.powerSymbol("PWR_FLAG"); this.flagCounter++;
      const inst = new SymInst(sym, this.resolver.projectLib + ":" + sym.name, "#FLG" + String(this.flagCounter).padStart(3, "0"), "PWR_FLAG", x, 0, 0);
      inst.fieldPos.Value = [x, -4.2, true, "center"]; g.add(inst); g.add(new Wire(x, 0, x + 4, 0));
      if (this._isPower(net)) { this._powerInst(g, net, [x + 4, 0], [0, this._powerStyleDir(net)]); x += 12; }
      else { net.sites++; g.add(new Label(net.display, x + 4, 0, 0, net.port !== "none" ? "global" : "local", this._shape(net))); if (net.auto) this.forceLabels.add(net.name); x += 8 + textW(net.display) + 4; }
      x += mod2(x);
    }
    return g;
  }
  _addJunctions(blocks) {
    for (const g of blocks) {
      const ends = new Map(); const bump = (pt) => { const k = pt[0] + "," + pt[1]; ends.set(k, (ends.get(k) || 0) + 1); };
      for (const it of g.items) if (it.kind === "wire") { bump([it.x1, it.y1]); bump([it.x2, it.y2]); }
      for (const it of g.items) if (it.kind === "sym") for (const p of it.sym.pinsForUnit(it.unit)) { const q = it.pinXY(p); const k = q[0] + "," + q[1]; if (ends.has(k)) ends.set(k, ends.get(k) + 1); }
      for (const [k, cnt] of ends) if (cnt >= 3) { const [jx, jy] = k.split(",").map(Number); g.add(new Junction(jx, jy)); }
    }
  }
  _pack(blocks) {
    const papers = [["A4", 297, 210], ["A3", 420, 297], ["A2", 594, 420], ["A1", 841, 594], ["A0", 1189, 841]]; const margin = 20, gap = 8;
    const sized = blocks.map((b) => { const bb = b.bbox(); return [b, Math.floor(bb[0]), Math.floor(bb[1]), Math.ceil(bb[2]), Math.ceil(bb[3])]; });
    let name = "A0", placements = null;
    for (const [pn, pw, ph] of papers) { name = pn; placements = Layout._tryPack(sized, U(pw - 2 * margin), U(ph - 2 * margin), gap, [U(pw - 2 * margin - 115), U(ph - 2 * margin - 38)]); if (placements) break; }
    if (!placements) { placements = []; let y = 0; for (const s of sized) { placements.push([0, y]); y += (s[4] - s[2]) + gap; } }
    this.paper = name; const out = new Group(); const ox = U(margin), oy = U(margin);
    sized.forEach(([b, x1, y1], i) => { let dx = ox + placements[i][0] - x1, dy = oy + placements[i][1] - y1; dx += mod2(dx); dy += mod2(dy); b.translate(dx, dy); out.extend(b); });
    return out;
  }
  static _tryPack(sized, availW, availH, gap, title) {
    const placements = []; let x = 0, y = 0, rowH = 0;
    for (const [, x1, y1, x2, y2] of sized) {
      const w = x2 - x1, h = y2 - y1; if (w > availW || h > availH) return null;
      if (x > 0 && x + w > availW) { x = 0; y = y + rowH + gap; rowH = 0; }
      if (y + h > availH) return null; if (x + w > title[0] && y + h > title[1]) return null;
      placements.push([x, y]); x += w + 2 * gap; rowH = Math.max(rowH, h);
    }
    return placements;
  }
}

root.DS2K_P3 = { Layout, SymInst, Wire, Junction, NoConnect, Label, Text, Group, U, textW };
})(typeof window !== "undefined" ? window : globalThis);

/* datasheet2kicad browser engine - part 4: KiCad file writer, netlist self-check, SVG preview, BOM, top-level build */
(function (root) {
"use strict";
const E1 = root.DS2K_P1, E2 = root.DS2K_P2, E3 = root.DS2K_P3;
const { GRID, S, Sym, isSym, dumps, parse, head, children, child, fnum, str, transform, SymbolDef, effects } = E1;
const { Circuit, Resolver } = E2;
const { Layout } = E3;
const FILE_VERSION = 20231120;      // KiCad 8 format: opens in KiCad 8, 9 and 10

const mm = (v) => Math.round(v * GRID * 10000) / 10000;
function legacyHide(node) {
  if (!Array.isArray(node)) return node;
  const out = [];
  for (const x of node) {
    if (Array.isArray(x) && x.length === 2 && isSym(x[0], "hide")) { if (str(x[1]) === "yes") out.push(S("hide")); continue; }
    out.push(legacyHide(x));
  }
  return out;
}
/* deterministic uuid (v4 layout) from a seeded PRNG so that a rebuild gives the same file */
function uuidGen(seed) {
  let h = 2166136261; for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.floor(rnd() * 16); return (c === "x" ? r : (r & 3) | 8).toString(16); });
}
const flag = (symNode, name) => { const c = child(symNode, name); return c && c.length > 1 ? str(c[1]) : "yes"; };

class Writer {
  constructor(project, title, comments) {
    this.project = String(project).replace(/[^A-Za-z0-9_\-.]/g, "_") || "design"; this.title = title || ""; this.comments = comments || [];
    this.uuid = uuidGen(this.project); this.rootUuid = this.uuid();
  }
  _prop(name, value, x, y, horizontal, rot, hide, justify) {
    const rotated = ((rot % 180) + 180) % 180 === 90; const angle = horizontal ? (rotated ? 90 : 0) : (rotated ? 0 : 90);
    return [S("property"), name, value, [S("at"), mm(x), mm(y), angle], effects(hide, justify === "center" || !justify ? null : justify)];
  }
  _symbol(it) {
    const node = [S("symbol"), [S("lib_id"), it.libId], [S("at"), mm(it.x), mm(it.y), it.rot]];
    if (it.mirror) node.push([S("mirror"), S(it.mirror)]);
    node.push([S("unit"), it.unit], [S("exclude_from_sim"), S("no")], [S("in_bom"), S(flag(it.sym.node, "in_bom"))], [S("on_board"), S(flag(it.sym.node, "on_board"))], [S("dnp"), S(it.dnp ? "yes" : "no")], [S("uuid"), this.uuid()]);
    const r = it.fieldPos.Reference || [it.x, it.y - 3, true, "center"], v = it.fieldPos.Value || [it.x, it.y + 3, true, "center"];
    node.push(this._prop("Reference", it.ref, r[0], r[1], r[2], it.rot, it.isPower, r[3]));
    node.push(this._prop("Value", it.value, v[0], v[1], v[2], it.rot, false, v[3]));
    node.push(this._prop("Footprint", it.footprint || "", it.x, it.y, true, it.rot, true));
    node.push(this._prop("Datasheet", it.datasheet || it.sym.properties.Datasheet || "~", it.x, it.y, true, it.rot, true));
    node.push(this._prop("Description", it.description || it.sym.properties.Description || "", it.x, it.y, true, it.rot, true));
    for (const k of Object.keys(it.extraFields)) if (it.extraFields[k]) node.push(this._prop(k, String(it.extraFields[k]), it.x, it.y, true, it.rot, true));
    const seen = new Set();
    for (const p of it.sym.pinsForUnit(it.unit)) { if (seen.has(p.number)) continue; seen.add(p.number); node.push([S("pin"), p.number, [S("uuid"), this.uuid()]]); }
    node.push([S("instances"), [S("project"), this.project, [S("path"), "/" + this.rootUuid, [S("reference"), it.ref], [S("unit"), it.unit]]]]);
    return node;
  }
  _label(it) {
    if (it.type === "global") return [S("global_label"), it.name, [S("shape"), S(it.shape)], [S("at"), mm(it.x), mm(it.y), it.angle], effects(false, (it.angle === 0 || it.angle === 90) ? "left" : "right"), [S("uuid"), this.uuid()],
      [S("property"), "Intersheetrefs", "${INTERSHEET_REFS}", [S("at"), mm(it.x), mm(it.y), 0], effects(true)]];
    return [S("label"), it.name, [S("at"), mm(it.x), mm(it.y), it.angle], effects(false, (it.angle === 0 || it.angle === 90) ? "left bottom" : "right bottom"), [S("uuid"), this.uuid()]];
  }
  schematic(items, paper) {
    const libSyms = new Map(); const body = [];
    for (const it of items.items) {
      if (it.kind === "sym") { if (!libSyms.has(it.libId)) libSyms.set(it.libId, it.sym.embeddedNode(it.libId.split(":")[0])); body.push(this._symbol(it)); }
      else if (it.kind === "wire") { if (it.x1 === it.x2 && it.y1 === it.y2) continue; body.push([S("wire"), [S("pts"), [S("xy"), mm(it.x1), mm(it.y1)], [S("xy"), mm(it.x2), mm(it.y2)]], [S("stroke"), [S("width"), 0], [S("type"), S("default")]], [S("uuid"), this.uuid()]]); }
      else if (it.kind === "nc") body.push([S("no_connect"), [S("at"), mm(it.x), mm(it.y)], [S("uuid"), this.uuid()]]);
      else if (it.kind === "junction") body.push([S("junction"), [S("at"), mm(it.x), mm(it.y)], [S("diameter"), 0], [S("color"), 0, 0, 0, 0], [S("uuid"), this.uuid()]]);
      else if (it.kind === "label") body.push(this._label(it));
      else if (it.kind === "text") body.push([S("text"), it.text, [S("exclude_from_sim"), S("no")], [S("at"), mm(it.x), mm(it.y), 0], effects(false, "left top", it.size), [S("uuid"), this.uuid()]]);
    }
    const order = { junction: 0, no_connect: 1, wire: 2, text: 3, label: 4, global_label: 5, symbol: 6 };
    body.sort((a, b) => (order[a[0].n] ?? 9) - (order[b[0].n] ?? 9));
    let rootNode = [S("kicad_sch"), [S("version"), FILE_VERSION], [S("generator"), "datasheet2kicad"], [S("generator_version"), "8.0"], [S("uuid"), this.rootUuid], [S("paper"), paper]];
    const tb = [S("title_block"), [S("title"), this.title], [S("date"), new Date().toISOString().slice(0, 10)], [S("rev"), "1"], [S("company"), ""]];
    this.comments.slice(0, 4).forEach((c, i) => tb.push([S("comment"), i + 1, c]));
    rootNode.push(tb); rootNode.push([S("lib_symbols")].concat([...libSyms.keys()].sort().map((k) => libSyms.get(k))));
    rootNode = rootNode.concat(body); rootNode.push([S("sheet_instances"), [S("path"), "/", [S("page"), "1"]]]);
    return dumps(legacyHide(rootNode));
  }
  symbolLibrary(symbols) {
    const rootNode = [S("kicad_symbol_lib"), [S("version"), FILE_VERSION], [S("generator"), "datasheet2kicad"], [S("generator_version"), "8.0"]];
    for (const name of Object.keys(symbols).sort()) rootNode.push(symbols[name].node);
    return dumps(legacyHide(rootNode));
  }
  symLibTable(lib) { return '(sym_lib_table\n  (version 7)\n  (lib (name "' + lib + '")(type "KiCad")(uri "${KIPRJMOD}/' + lib + '.kicad_sym")(options "")(descr "Symbols generated by datasheet2kicad"))\n)\n'; }
  projectFile() { return JSON.stringify({ meta: { filename: this.project + ".kicad_pro", version: 1 } }, null, 2) + "\n"; }
}

/* ------------------------------------------------------------------ netlist self-check: re-read the written file */
function schematicNets(text) {
  const rootNode = parse(text); const problems = []; const libs = {};
  const ls = child(rootNode, "lib_symbols");
  for (const s of ls ? children(ls, "symbol") : []) { const lid = str(s[1]); const j = lid.indexOf(":"); libs[lid] = new SymbolDef(j >= 0 ? lid.slice(0, j) : "", j >= 0 ? lid.slice(j + 1) : lid, s); }
  const parent = new Map(); const find = (a) => { if (!parent.has(a)) parent.set(a, a); while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const pt = (x, y) => Math.round(x / GRID * 100) + "," + Math.round(y / GRID * 100);
  const xy = (k) => k.split(",").map(Number);
  const wires = [];
  for (const w of children(rootNode, "wire")) { const p = children(child(w, "pts"), "xy"); const a = pt(fnum(p[0][1]), fnum(p[0][2])), b = pt(fnum(p[1][1]), fnum(p[1][2])); const A = xy(a), B = xy(b); if (A[0] !== B[0] && A[1] !== B[1]) problems.push("diagonal wire"); wires.push([a, b]); union("pt" + a, "pt" + b); }
  const junctions = new Set(children(rootNode, "junction").map((j) => pt(fnum(child(j, "at")[1]), fnum(child(j, "at")[2]))));
  const points = new Map(); const addPoint = (k, what) => { if (!points.has(k)) points.set(k, []); points.get(k).push(what); };
  for (const [a, b] of wires) { addPoint(a, "wire"); addPoint(b, "wire"); }
  const nodes = [];
  for (const s of children(rootNode, "symbol")) {
    const lid = str(child(s, "lib_id")[1]); const sym = libs[lid]; if (!sym) { problems.push("symbol " + lid + " missing from lib_symbols"); continue; }
    const at = child(s, "at"); const sx = fnum(at[1]), sy = fnum(at[2]), rot = at.length > 3 ? Math.round(fnum(at[3])) : 0; const mir = child(s, "mirror") ? str(child(s, "mirror")[1]) : "";
    const unit = child(s, "unit") ? Math.round(fnum(child(s, "unit")[1])) : 1; let ref = "", val = "";
    for (const p of children(s, "property")) { if (p[1] === "Reference") ref = str(p[2]); else if (p[1] === "Value") val = str(p[2]); }
    for (const p of sym.pinsForUnit(unit)) {
      const t = transform(p.x, p.y, rot, mir); const pos = pt(sx + t[0], sy + t[1]); const key = "pin" + ref + "\u0000" + p.number + "\u0000" + unit;
      union(key, "pt" + pos); addPoint(pos, "pin " + ref + "." + p.number);
      if (sym.isPower) { if (p.etype === "power_in") union(key, "power" + val); } else { nodes.push([ref, p.number]); union("node" + ref + "\u0000" + p.number, key); }
    }
  }
  for (const [kind, tag] of [["label", "local"], ["global_label", "global"]]) for (const l of children(rootNode, kind)) {
    const at = child(l, "at"); const pos = pt(fnum(at[1]), fnum(at[2])); union(tag + str(l[1]), "pt" + pos); addPoint(pos, "label " + str(l[1]));
    if (!wires.some(([a, b]) => a === pos || b === pos) && !points.get(pos).some((k) => k.startsWith("pin"))) problems.push("label " + str(l[1]) + " is not on a wire end or pin");
  }
  const inside = (p, a, b) => (a[0] === b[0] && b[0] === p[0]) ? (Math.min(a[1], b[1]) < p[1] && p[1] < Math.max(a[1], b[1])) : (a[1] === b[1] && b[1] === p[1]) ? (Math.min(a[0], b[0]) < p[0] && p[0] < Math.max(a[0], b[0])) : false;
  const overlap = (a, b, c, d) => { if (a[0] === b[0] && c[0] === d[0] && a[0] === c[0]) return Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) < Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])); if (a[1] === b[1] && c[1] === d[1] && a[1] === c[1]) return Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) < Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])); return false; };
  wires.forEach(([a, b], i) => {
    const A = xy(a), B = xy(b);
    for (const [pos, kinds] of points) { if (pos === a || pos === b) continue; if (inside(xy(pos), A, B)) { if (junctions.has(pos)) union("pt" + pos, "pt" + a); problems.push([...new Set(kinds)].sort().join(", ") + " touches the middle of a wire"); } }
    for (const [c, d] of wires.slice(i + 1)) if (overlap(A, B, xy(c), xy(d))) problems.push("two wires overlap");
  });
  const groups = new Map();
  for (const [ref, num] of nodes) { const r = find("node" + ref + "\u0000" + num); if (!groups.has(r)) groups.set(r, []); if (!groups.get(r).some((n) => n[0] === ref && n[1] === num)) groups.get(r).push([ref, num]); }
  return { groups: [...groups.values()], problems };
}
function compareNets(expected, groups) {
  const errs = []; const gid = new Map(); groups.forEach((g, i) => g.forEach(([r, p]) => gid.set(r + "\u0000" + p, i)));
  const expOf = new Map(); for (const [name, nodes] of expected) for (const [r, p] of nodes) expOf.set(r + "\u0000" + p, name);
  for (const [name, nodes] of expected) {
    const missing = nodes.filter(([r, p]) => !gid.has(r + "\u0000" + p)); if (missing.length) errs.push("net " + name + ": pin(s) " + missing.map((n) => n.join(".")).join(", ") + " not found in the schematic");
    const ids = new Set(nodes.filter(([r, p]) => gid.has(r + "\u0000" + p)).map(([r, p]) => gid.get(r + "\u0000" + p))); if (ids.size > 1) errs.push("OPEN: net " + name + " is split into " + ids.size + " pieces");
  }
  for (const g of groups) { const names = [...new Set(g.map(([r, p]) => expOf.get(r + "\u0000" + p)).filter(Boolean))].sort(); if (names.length > 1) errs.push("SHORT: nets " + names.join(" + ") + " are connected together"); }
  return errs;
}

/* ------------------------------------------------------------------ SVG preview */
const escXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function hiddenProp(node) { const eff = child(node, "effects"); if (!eff) return false; return eff.slice(1).some((x) => isSym(x, "hide") || (head(x) === "hide" && (x.length < 2 || str(x[1]) === "yes"))); }
function renderSvg(text) {
  const rootNode = parse(text); const out = [], xs = [], ys = []; const mark = (x, y) => { xs.push(x); ys.push(y); };
  const libs = {}; const ls = child(rootNode, "lib_symbols");
  for (const s of ls ? children(ls, "symbol") : []) { const lid = str(s[1]); const j = lid.indexOf(":"); libs[lid] = new SymbolDef(lid.slice(0, j), lid.slice(j + 1), s); }
  const f = (v) => Math.round(v * 1000) / 1000;
  for (const w of children(rootNode, "wire")) { const p = children(child(w, "pts"), "xy"); const x1 = fnum(p[0][1]), y1 = fnum(p[0][2]), x2 = fnum(p[1][1]), y2 = fnum(p[1][2]); out.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" class="w"/>'); mark(x1, y1); mark(x2, y2); }
  for (const j of children(rootNode, "junction")) { const at = child(j, "at"); out.push('<circle cx="' + fnum(at[1]) + '" cy="' + fnum(at[2]) + '" r="0.5" class="j"/>'); }
  for (const j of children(rootNode, "no_connect")) { const at = child(j, "at"); const x = fnum(at[1]), y = fnum(at[2]); out.push('<path d="M' + (x - 0.6) + " " + (y - 0.6) + "l1.2 1.2M" + (x + 0.6) + " " + (y - 0.6) + 'l-1.2 1.2" class="nc"/>'); }
  for (const s of children(rootNode, "symbol")) {
    const sym = libs[str(child(s, "lib_id")[1])]; const at = child(s, "at"); const sx = fnum(at[1]), sy = fnum(at[2]), rot = at.length > 3 ? Math.round(fnum(at[3])) : 0;
    const mir = child(s, "mirror") ? str(child(s, "mirror")[1]) : ""; const unit = child(s, "unit") ? Math.round(fnum(child(s, "unit")[1])) : 1;
    const T = (x, y) => { const t = transform(x, y, rot, mir); mark(sx + t[0], sy + t[1]); return [f(sx + t[0]), f(sy + t[1])]; };
    if (sym) {
      for (const sub of children(sym.node, "symbol")) {
        const parts = str(sub[1]).split("_"); const u = parseInt(parts[parts.length - 2], 10), st = parseInt(parts[parts.length - 1], 10);
        if (!(st === 0 || st === 1) || !(u === 0 || u === unit)) continue;
        for (const g of sub) {
          const h = head(g); const fl = child(g, "fill"); const ft = fl && child(fl, "type") ? str(child(fl, "type")[1]) : "none"; const cls = "g" + (ft === "background" ? " bg" : ft === "outline" ? " ol" : "");
          if (h === "rectangle") { const a = child(g, "start"), b = child(g, "end"); const p1 = T(fnum(a[1]), fnum(a[2])), p2 = T(fnum(b[1]), fnum(b[2])); out.push('<rect x="' + Math.min(p1[0], p2[0]) + '" y="' + Math.min(p1[1], p2[1]) + '" width="' + f(Math.abs(p1[0] - p2[0])) + '" height="' + f(Math.abs(p1[1] - p2[1])) + '" class="' + cls + '"/>'); }
          else if (h === "polyline") { const pts = children(child(g, "pts"), "xy").map((q) => T(fnum(q[1]), fnum(q[2])).join(",")); out.push('<polyline points="' + pts.join(" ") + '" class="' + cls + '"/>'); }
          else if (h === "circle") { const c = child(g, "center"); const p = T(fnum(c[1]), fnum(c[2])); out.push('<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + fnum(child(g, "radius")[1]) + '" class="' + cls + '"/>'); }
          else if (h === "arc") { const q = ["start", "mid", "end"].map((k) => { const c = child(g, k); return T(fnum(c[1]), fnum(c[2])); }); out.push('<path d="M' + q[0][0] + " " + q[0][1] + "Q" + f(2 * q[1][0] - (q[0][0] + q[2][0]) / 2) + " " + f(2 * q[1][1] - (q[0][1] + q[2][1]) / 2) + " " + q[2][0] + " " + q[2][1] + '" class="g"/>'); }
        }
      }
      const hid = (n) => { const c = child(sym.node, n); return !!c && c.slice(1).some((t) => isSym(t, "hide") || head(t) === "hide"); };
      const showNames = !hid("pin_names"), showNums = !hid("pin_numbers");
      for (const p of sym.pinsForUnit(unit)) {
        const a = p.angle * Math.PI / 180; const [x1, y1] = T(p.x, p.y); const [x2, y2] = T(p.x + p.length * Math.cos(a), p.y + p.length * Math.sin(a));
        out.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" class="p"/>');
        if (p.hidden || sym.isPower) continue;
        const dx = x2 - x1, dy = y2 - y1, ln = Math.hypot(dx, dy) || 1, ux = dx / ln, uy = dy / ln;
        if (showNames && p.name && p.name !== "~") { const tx = f(x2 + ux * 0.8), ty = f(y2 + uy * 0.8); if (Math.abs(ux) > 0.5) out.push('<text x="' + tx + '" y="' + ty + '" class="pn" text-anchor="' + (ux > 0 ? "start" : "end") + '" dominant-baseline="middle">' + escXml(p.name) + "</text>"); else out.push('<text x="' + tx + '" y="' + ty + '" class="pn" text-anchor="' + (uy > 0 ? "end" : "start") + '" dominant-baseline="middle" transform="rotate(-90 ' + tx + " " + ty + ')">' + escXml(p.name) + "</text>"); }
        if (showNums && p.number) { const mx = f((x1 + x2) / 2), my = f((y1 + y2) / 2); if (Math.abs(ux) > 0.5) out.push('<text x="' + mx + '" y="' + f(my - 0.3) + '" class="pnum" text-anchor="middle">' + escXml(p.number) + "</text>"); else out.push('<text x="' + f(mx - 0.3) + '" y="' + my + '" class="pnum" text-anchor="middle" transform="rotate(-90 ' + f(mx - 0.3) + " " + my + ')">' + escXml(p.number) + "</text>"); }
      }
    }
    for (const pr of children(s, "property")) {
      if (hiddenProp(pr) || !str(pr[2]) || str(pr[2]) === "~") continue; const pat = child(pr, "at"); const fx = fnum(pat[1]), fy = fnum(pat[2]), fa = pat.length > 3 ? Math.round(fnum(pat[3])) : 0;
      const vertical = ((fa % 180) === 90) !== ((rot % 180) === 90); mark(fx, fy); const eff = child(pr, "effects"); const j = eff ? child(eff, "justify") : null; const toks = j ? j.slice(1).map(str) : [];
      out.push('<text x="' + fx + '" y="' + fy + '" class="' + (pr[1] === "Reference" ? "ref" : "val") + '" text-anchor="' + (toks.includes("left") ? "start" : toks.includes("right") ? "end" : "middle") + '" dominant-baseline="middle"' + (vertical ? ' transform="rotate(-90 ' + fx + " " + fy + ')"' : "") + ">" + escXml(str(pr[2])) + "</text>");
    }
  }
  for (const kind of ["label", "global_label"]) for (const l of children(rootNode, kind)) {
    const at = child(l, "at"); const x = fnum(at[1]), y = fnum(at[2]), a = at.length > 3 ? Math.round(fnum(at[3])) : 0; const g = kind === "global_label"; const name = str(l[1]); const w = name.length * 1.05 + (g ? 3 : 0);
    mark(x, y); if (a === 0) mark(x + w, y); else if (a === 180) mark(x - w, y); else if (a === 90) mark(x, y - w); else mark(x, y + w);
    const dy = g ? 0 : -0.4, base = g ? "middle" : "auto", pad = g ? 1.2 : 0;
    if (a === 0 || a === 180) out.push('<text x="' + (a === 0 ? x + pad : x - pad) + '" y="' + (y + dy) + '" class="' + (g ? "gl" : "ll") + '" text-anchor="' + (a === 0 ? "start" : "end") + '" dominant-baseline="' + base + '">' + escXml(name) + "</text>");
    else { const ty = a === 90 ? y - pad : y + pad; out.push('<text x="' + (x + dy) + '" y="' + ty + '" class="' + (g ? "gl" : "ll") + '" text-anchor="' + (a === 90 ? "start" : "end") + '" dominant-baseline="' + base + '" transform="rotate(-90 ' + (x + dy) + " " + ty + ')">' + escXml(name) + "</text>"); }
    out.push('<circle cx="' + x + '" cy="' + y + '" r="0.3" class="lp"/>');
  }
  for (const t of children(rootNode, "text")) { const at = child(t, "at"); const x = fnum(at[1]), y = fnum(at[2]); str(t[1]).split("\n").forEach((line, i) => { out.push('<text x="' + x + '" y="' + f(y + 1.6 + i * 2.1) + '" class="note">' + escXml(line) + "</text>"); mark(x + line.length, y + 2 + i * 2.1); }); mark(x, y); }
  const x0 = Math.min(...xs) - 8, y0 = Math.min(...ys) - 8, x1 = Math.max(...xs) + 8, y1 = Math.max(...ys) + 8;
  const K = ".ds2ksvg ";   // scoped: an inline SVG's <style> applies to the whole host page
  const style = K + ".w{stroke:#0a7d2c;stroke-width:.18;fill:none;stroke-linecap:round}" + K + ".j{fill:#0a7d2c}" + K + ".nc{stroke:#1d4ed8;stroke-width:.2;fill:none}" + K + ".g{stroke:#8b1a1a;stroke-width:.2;fill:none;stroke-linejoin:round}" + K + ".bg{fill:#fdf6d8}" + K + ".ol{fill:#8b1a1a}" + K + ".p{stroke:#8b1a1a;stroke-width:.16}" + K + "text{font-family:Helvetica,Arial,sans-serif;font-size:1.27px}" + K + ".pn{fill:#0e6e78;font-size:1.1px}" + K + ".pnum{fill:#8b1a1a;font-size:.9px}" + K + ".ref," + K + ".val{fill:#0e6e78}" + K + ".ll{fill:#111}" + K + ".gl{fill:#a3143c;font-weight:bold}" + K + ".lp{fill:#111}" + K + ".note{fill:#1e3a8a;font-size:1.4px}";
  return '<svg xmlns="http://www.w3.org/2000/svg" class="ds2ksvg" viewBox="' + f(x0) + " " + f(y0) + " " + f(x1 - x0) + " " + f(y1 - y0) + '" style="background:#fff"><style>' + style + "</style>" + out.join("") + "</svg>";
}

/* ------------------------------------------------------------------ BOM */
function yageoMpn(ohms, pkg, tol) {
  if (!["0201", "0402", "0603", "0805", "1206", "1210", "2010", "2512"].includes(pkg) || ohms < 1 || ohms > 10e6) return "";
  let mant, unit; if (ohms < 1000) { mant = ohms; unit = "R"; } else if (ohms < 1e6) { mant = ohms / 1e3; unit = "K"; } else { mant = ohms / 1e6; unit = "M"; }
  let s = String(parseFloat(mant.toPrecision(3))); let code; if (s.includes(".")) { const [a, b] = s.split("."); code = a + unit + b; } else code = s + unit;
  return "RC" + pkg + (tol <= 0.011 ? "F" : "J") + "R-07" + code + "L";
}
function bomRows(circ, symbols) {
  const fp = {}; for (const s of symbols) fp[s.ref] = s.footprint || ""; const groups = new Map();
  for (const c of circ.components) {
    if (c.type === "test_point") continue; let mpn = c.mpn || c.suggested_mpn || "";
    if (!mpn && c.type === "resistor") { const ohms = E2.parseValue(c.value, "ohm"); const m = /(\d+(?:\.\d+)?)\s*%/.exec(c.tolerance || ""); const pk = (/(0201|0402|0603|0805|1206|1210|2010|2512)/.exec(c.package || "") || [])[1] || "0603"; if (ohms) mpn = yageoMpn(ohms, pk, m ? parseFloat(m[1]) / 100 : 0.01); }
    const key = [c.type, c.value, c.package, c.rating, fp[c.ref], mpn, c.lcsc, c.dnp].join("\u0000"); if (!groups.has(key)) groups.set(key, { refs: [], c, mpn }); groups.get(key).refs.push(c.ref);
  }
  const nat = (r) => { const m = /^([A-Za-z#_]+)(\d+)/.exec(r); return m ? [m[1], parseInt(m[2], 10)] : [r, 0]; };
  const rows = [...groups.values()].map(({ refs, c, mpn }) => { refs.sort((a, b) => { const x = nat(a), y = nat(b); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]; });
    const q = [c.value, c.type.startsWith("capacitor") || c.type === "resistor" || c.type === "inductor" ? (c.package || "") : "", mpn && !mpn.startsWith("RC0") ? "" : ""].join(" ").trim();
    const search = mpn || [c.value, c.package, c.rating, c.type.replace(/_/g, " ")].filter(Boolean).join(" ");
    return { refs, qty: refs.length, value: c.value, type: c.type, rating: c.rating, tolerance: c.tolerance, package: c.package, footprint: fp[c.ref] || "", mpn, lcsc: c.lcsc || "", manufacturer: c.manufacturer, dnp: c.dnp, description: c.description,
      lcscUrl: "https://www.lcsc.com/search?q=" + encodeURIComponent(search), mouserUrl: "https://www.mouser.com/c/?q=" + encodeURIComponent(search), q }; });
  rows.sort((a, b) => { const x = nat(a.refs[0]), y = nat(b.refs[0]); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]; });
  return rows;
}
const csvCell = (v) => { v = String(v === undefined || v === null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
function bomCsv(rows) { return [["References", "Qty", "Value", "Rating", "Tolerance", "Package", "Footprint", "MPN (suggested)", "Manufacturer", "LCSC", "DNP", "LCSC search", "Mouser search"]].concat(rows.map((r) => [r.refs.join(" "), r.qty, r.value, r.rating, r.tolerance, r.package, r.footprint, r.mpn, r.manufacturer, r.lcsc, r.dnp ? "DNP" : "", r.lcsc ? "https://www.lcsc.com/product-detail/" + r.lcsc + ".html" : r.lcscUrl, r.mouserUrl])).map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n"; }
function jlcCsv(rows) { return [["Comment", "Designator", "Footprint", "LCSC Part #"]].concat(rows.filter((r) => !r.dnp).map((r) => [r.value, r.refs.join(","), r.footprint ? r.footprint.split(":").pop() : r.package, r.lcsc])).map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n"; }

/* ------------------------------------------------------------------ top level */
function safeName(s, dflt) { s = String(s || "").replace(/[^A-Za-z0-9_\-]+/g, "_").replace(/^_+|_+$/g, ""); return s.slice(0, 48) || dflt || "design"; }
function wrap(s, n) { const out = []; let line = ""; for (const w of String(s).split(/\s+/)) { if ((line + " " + w).trim().length > n) { out.push(line); line = w; } else line = (line + " " + w).trim(); } if (line) out.push(line); return out; }
function build(circuitJson, name, config) {
  config = config || {}; name = safeName(name);
  const circ = new Circuit(circuitJson); const issues = circ.normalize(); const [errors, warnings] = circ.validate();
  const projectLib = name + "_ds2k"; const resolver = new Resolver(projectLib, config);
  const lines = []; if (circ.design.title) lines.push(circ.design.title); if (config.source) lines.push("Source: " + config.source); if (circ.design.page) lines.push("Datasheet page: " + circ.design.page);
  if (circ.design.description) lines.push(...wrap(circ.design.description, 110)); for (const n of circ.notes.slice(0, 12)) { const w = wrap(n, 106); lines.push("- " + (w[0] || "")); for (const x of w.slice(1)) lines.push("  " + x); }
  lines.push("Generated by Debug AI - verify against the datasheet before ordering boards.");
  const layout = new Layout(circ, resolver, { noPwrFlags: config.add_pwr_flags === false, notes: lines.join("\n") }); const items = layout.run();
  for (const it of items.items) if (it.kind === "sym" && !it.isPower) { const part = layout.parts.get(it.ref); if (!part) continue; const c = part.comp; it.extraFields = { MPN: c.mpn || c.suggested_mpn, Manufacturer: c.manufacturer, LCSC: c.lcsc, Rating: c.rating, Tolerance: c.tolerance }; }
  const writer = new Writer(name, circ.design.title || ((circ.part.mpn || name) + " reference design"), ["Generated by Debug AI", config.source ? "Source: " + config.source : "", "Verify all connections and values against the datasheet"]);
  const sch = writer.schematic(items, layout.paper);
  const expected = new Map(); for (const n of layout.nets.values()) if (n.nodes.length) expected.set(n.name, n.nodes);
  const chk = schematicNets(sch); const selfErrors = compareNets(expected, chk.groups).concat([...new Set(chk.problems)]);
  const symbols = [...layout.parts.values()].map((p) => ({ ref: p.ref, value: p.comp.value, symbol: p.res.libId, source: p.sym.source, footprint: p.res.footprint, footprintNote: p.res.footprintNote }));
  const rows = bomRows(circ, symbols);
  const files = {}; files[name + ".kicad_sch"] = sch; files[name + ".kicad_pro"] = writer.projectFile(); files[projectLib + ".kicad_sym"] = writer.symbolLibrary(resolver.custom); files["sym-lib-table"] = writer.symLibTable(projectLib);
  files["bom.csv"] = bomCsv(rows); files["bom_jlcpcb.csv"] = jlcCsv(rows); files["circuit.json"] = JSON.stringify(circ.toDict(), null, 1);
  files["README.txt"] = "Open " + name + ".kicad_pro in KiCad 8 or newer.\nAll symbols live in the project library " + projectLib + ".kicad_sym (registered in sym-lib-table).\nCompare the schematic with the datasheet figure before ordering boards.\n";
  return { name, circuit: circ, issues, errors, warnings: warnings.concat(layout.warnings), paper: layout.paper, files, svg: renderSvg(sch), selfCheck: { ok: !selfErrors.length, errors: selfErrors }, symbols, bom: rows };
}

const api = Object.assign({}, E1, E2, E3, { Writer, schematicNets, compareNets, renderSvg, bomRows, bomCsv, jlcCsv, build, safeName, yageoMpn });
root.DS2K = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* Design options: the choices a reference design offers (output voltage set by a divider, I2C or SPI, address pins,
   optional parts...) and the rules that turn a choice into component values, part numbers and connections.
   Expressions are parsed by a small hand-written parser - nothing is ever eval()'d. */
(function (root) {
"use strict";
const parseValue = root.DS2K_P2.parseValue;

/* ------------------------------------------------------------------ expressions */
const SI = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, m: 1e-3, u: 1e-6, "µ": 1e-6, "μ": 1e-6, n: 1e-9, p: 1e-12 };
const WORDS = { and: "&&", or: "||", not: "!" };
function tokenize(src) {
  const out = []; let i = 0; const s = String(src);
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(s.slice(i)); if (!m) throw new Error("bad number at " + i);
      i += m[0].length; let v = parseFloat(m[0]);
      if (s[i] && SI[s[i]] !== undefined && !/[A-Za-z0-9_]/.test(s[i + 1] || "")) { v *= SI[s[i]]; i++; }
      out.push({ t: "num", v }); continue;
    }
    if (ch === "'" || ch === '"') { const j = s.indexOf(ch, i + 1); if (j < 0) throw new Error("unterminated string"); out.push({ t: "str", v: s.slice(i + 1, j) }); i = j + 1; continue; }
    if (/[A-Za-z_]/.test(ch)) { const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i)); i += m[0].length; const w = WORDS[m[0].toLowerCase()]; out.push(w ? { t: "op", v: w } : { t: "id", v: m[0] }); continue; }
    const two = s.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
    if (two === "**") { out.push({ t: "op", v: "^" }); i += 2; continue; }
    if ("+-*/^()?:,<>!=".includes(ch)) { out.push({ t: "op", v: ch === "=" ? "==" : ch }); i++; continue; }
    if (ch === "×") { out.push({ t: "op", v: "*" }); i++; continue; }
    throw new Error("unexpected '" + ch + "'");
  }
  return out;
}
const BIN = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6 };
function parseExpr(src) {
  const tk = tokenize(src); let p = 0;
  const peek = () => tk[p]; const isOp = (v) => tk[p] && tk[p].t === "op" && tk[p].v === v;
  const need = (v) => { if (!isOp(v)) throw new Error("expected '" + v + "'"); p++; };
  function ternary() { const c = binary(1); if (isOp("?")) { p++; const a = ternary(); need(":"); const b = ternary(); return { k: "if", c, a, b }; } return c; }
  function binary(min) { let left = unary(); for (;;) { const t = peek(); if (!t || t.t !== "op" || !(t.v in BIN) || BIN[t.v] < min) return left; p++; const right = binary(BIN[t.v] + 1); left = { k: "bin", op: t.v, a: left, b: right }; } }
  function unary() { if (isOp("-")) { p++; return { k: "neg", a: unary() }; } if (isOp("+")) { p++; return unary(); } if (isOp("!")) { p++; return { k: "not", a: unary() }; } return power(); }
  function power() { const base = primary(); if (isOp("^")) { p++; return { k: "bin", op: "^", a: base, b: unary() }; } return base; }
  function primary() {
    const t = peek(); if (!t) throw new Error("unexpected end");
    if (t.t === "num") { p++; return { k: "num", v: t.v }; } if (t.t === "str") { p++; return { k: "str", v: t.v }; }
    if (t.t === "id") { p++; if (isOp("(")) { p++; const args = []; if (!isOp(")")) { args.push(ternary()); while (isOp(",")) { p++; args.push(ternary()); } } need(")"); return { k: "call", f: t.v.toLowerCase(), args }; } return { k: "id", v: t.v }; }
    if (isOp("(")) { p++; const e = ternary(); need(")"); return e; }
    throw new Error("unexpected '" + t.v + "'");
  }
  const e = ternary(); if (p < tk.length) throw new Error("unexpected '" + tk[p].v + "'"); return e;
}
const FN = {
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a), sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log10: Math.log10, log2: Math.log2, exp: Math.exp, pow: Math.pow,
  round: (x, n) => { const k = Math.pow(10, n || 0); return Math.round(x * k) / k; }, floor: Math.floor, ceil: Math.ceil,
  par: (...a) => 1 / a.reduce((s, x) => s + 1 / x, 0), if: (c, a, b) => (c ? a : b),
};
const same = (a, b) => (typeof a === "string" || typeof b === "string") ? String(a).trim().toLowerCase() === String(b).trim().toLowerCase() : a === b;
function evalNode(n, lookup) {
  switch (n.k) {
    case "num": case "str": return n.v;
    case "id": { const low = n.v.toLowerCase(); if (low === "pi") return Math.PI; if (low === "true") return true; if (low === "false") return false; return lookup(n.v); }
    case "neg": return -num(evalNode(n.a, lookup)); case "not": return !evalNode(n.a, lookup);
    case "if": return evalNode(n.c, lookup) ? evalNode(n.a, lookup) : evalNode(n.b, lookup);
    case "call": { const f = FN[n.f]; if (!f) throw new Error(n.f === "log" ? "use ln() or log10() instead of log()" : "unknown function " + n.f + "()"); return f(...n.args.map((a) => evalNode(a, lookup))); }
    case "bin": {
      if (n.op === "&&") return !!(evalNode(n.a, lookup) && evalNode(n.b, lookup)); if (n.op === "||") return !!(evalNode(n.a, lookup) || evalNode(n.b, lookup));
      const a = evalNode(n.a, lookup), b = evalNode(n.b, lookup);
      if (n.op === "==") return same(a, b); if (n.op === "!=") return !same(a, b);
      if (n.op === "+" && (typeof a === "string" || typeof b === "string")) return String(a) + String(b);
      const x = num(a), y = num(b);
      switch (n.op) { case "+": return x + y; case "-": return x - y; case "*": return x * y; case "/": return x / y; case "^": return Math.pow(x, y); case "<": return x < y; case ">": return x > y; case "<=": return x <= y; case ">=": return x >= y; }
    }
  }
  throw new Error("cannot evaluate");
}
function num(v) { if (typeof v === "number") return v; if (typeof v === "boolean") return v ? 1 : 0; const f = parseFloat(v); if (isNaN(f)) throw new Error("'" + v + "' is not a number"); return f; }
function evaluate(src, lookup) { return evalNode(parseExpr(src), lookup || ((name) => { throw new Error("unknown name " + name); })); }

/* ------------------------------------------------------------------ standard values */
const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
const SERIES = { E24, E12: E24.filter((_, i) => i % 2 === 0), E6: E24.filter((_, i) => i % 4 === 0), E96: Array.from({ length: 96 }, (_, i) => Math.round(Math.pow(10, i / 96) * 100) / 100) };
SERIES.STD = [...new Set(SERIES.E24.concat(SERIES.E96))].sort((a, b) => a - b);      // what 1 % resistors are actually stocked in
function snap(v, series) {
  const list = SERIES[String(series || "").toUpperCase()]; if (!list || !(v > 0) || !isFinite(v)) return v;
  const dec = Math.floor(Math.log10(v)); let best = v, err = Infinity;
  for (const d of [dec - 1, dec, dec + 1]) for (const m of list) { const c = m * Math.pow(10, d); const e = Math.abs(Math.log(c / v)); if (e < err) { err = e; best = c; } }
  return parseFloat(best.toPrecision(6));
}
const UNIT_OF = { resistor: "ohm", potentiometer: "ohm", thermistor: "ohm", capacitor: "F", capacitor_polarized: "F", inductor: "H", ferrite_bead: "ohm" };
const DEFAULT_SERIES = { resistor: "STD", capacitor: "E12", capacitor_polarized: "E6", inductor: "E12" };
const trim = (x) => String(parseFloat(x.toPrecision(3)));
function formatValue(v, type) {
  const unit = UNIT_OF[type]; if (!(v > 0) || !isFinite(v) || !unit) return trim(v);
  if (unit === "ohm") return v >= 1e6 ? trim(v / 1e6) + "M" : v >= 1e3 ? trim(v / 1e3) + "k" : v >= 1 ? trim(v) : trim(v * 1e3) + "m";
  if (unit === "F") return v >= 1e-6 ? trim(v * 1e6) + "uF" : v >= 1e-9 ? trim(v * 1e9) + "nF" : trim(v * 1e12) + "pF";
  return v >= 1e-3 ? trim(v * 1e3) + "mH" : v >= 1e-6 ? trim(v * 1e6) + "uH" : trim(v * 1e9) + "nH";
}

/* ------------------------------------------------------------------ options */
const cleanId = (s) => String(s || "").trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^(\d)/, "_$1");
function cleanOptions(list) {
  const out = []; const seen = new Set();
  for (const o of Array.isArray(list) ? list : []) {
    if (!o || typeof o !== "object") continue; const id = cleanId(o.id || o.label); if (!id || seen.has(id.toLowerCase())) continue; seen.add(id.toLowerCase());
    const choices = (Array.isArray(o.choices) ? o.choices : []).map((c) => (c && typeof c === "object") ? { id: String(c.id !== undefined ? c.id : c.label), label: String(c.label || c.id) } : { id: String(c), label: String(c) }).filter((c) => c.id !== "");
    const type = (o.type === "choice" || (o.type !== "number" && choices.length)) ? "choice" : "number";
    if (type === "choice") { if (choices.length < 2) continue; const def = choices.find((c) => same(c.id, o.default)) || choices[0]; out.push({ id, label: String(o.label || id), type, choices, default: def.id, help: String(o.help || o.description || "") }); }
    else { const def = parseFloat(o.default); if (isNaN(def)) continue; const f = (x) => { const v = parseFloat(x); return isNaN(v) ? null : v; }; out.push({ id, label: String(o.label || id), type, unit: String(o.unit || ""), default: def, min: f(o.min), max: f(o.max), step: f(o.step), help: String(o.help || o.description || ""), actual: String(o.actual || "") }); }
  }
  return out.slice(0, 8);
}
function chosenValues(options, chosen) {
  const vals = {};
  for (const o of options) {
    let v = chosen && chosen[o.id];
    if (o.type === "choice") { const c = o.choices.find((x) => same(x.id, v)); vals[o.id] = c ? c.id : o.default; }
    else { v = parseFloat(v); if (isNaN(v)) v = o.default; if (o.min !== null && v < o.min) v = o.min; if (o.max !== null && v > o.max) v = o.max; vals[o.id] = v; }
  }
  return vals;
}
const netKind = (name) => /^(A|D|P)?GND|^VSS|^0V$/i.test(name) ? "ground" : /^(\+|-)?\d|^V(CC|DD|IN|OUT|BUS|BAT|REF|EE|SS|PP)|^AVDD|^DVDD|^VM$/i.test(name) ? "power" : "signal";

/* Applies the chosen option values to a copy of the base circuit. `alias` maps refs as written by the datasheet to normalised refs. */
function applyOptions(base, chosen, alias) {
  const circuit = JSON.parse(JSON.stringify(base)); const options = cleanOptions(base.options); const vals = chosenValues(options, chosen);
  const rules = Array.isArray(base.rules) ? base.rules : []; const changes = [], problems = [], controlled = new Set(), removed = new Set();
  const refOf = (r) => { const key = String(r || "").trim(); const up = key.toUpperCase(); return (alias && (alias[key] || alias[up])) || up; };
  const comp = (r) => circuit.components.find((c) => c.ref === refOf(r)) || null;
  const lookup = (name) => {
    const low = name.toLowerCase(); for (const o of options) if (o.id.toLowerCase() === low) return vals[o.id];
    const c = comp(name); if (c) { const v = parseValue(c.value, UNIT_OF[c.type]); if (v === null) throw new Error(c.ref + " has no numeric value ('" + c.value + "')"); return v; }
    if (removed.has(refOf(name))) throw new Error(name + " is not fitted"); throw new Error("unknown name " + name);
  };
  const detach = (ref, pin) => { for (const n of circuit.nets) n.nodes = (n.nodes || []).filter((x) => !(x.ref === ref && (pin === null || String(x.pin) === pin))); circuit.no_connects = (circuit.no_connects || []).filter((x) => !(x.ref === ref && (pin === null || String(x.pin) === pin))); };
  rules.forEach((rule, idx) => {
    if (!rule || typeof rule !== "object") return; const what = String(rule.set || "value").toLowerCase(); const tag = "Rule " + (idx + 1) + " (" + (rule.ref || "?") + ")";
    try {
      if (String(rule.when || "").trim() && !evaluate(rule.when, lookup)) return;
      const c = comp(rule.ref); if (!c) { if (!removed.has(refOf(rule.ref))) problems.push(tag + ": there is no component " + rule.ref); return; }
      const to = String(rule.to === undefined || rule.to === null ? "" : rule.to).trim();
      if (what === "value") {
        const r = evaluate(to, lookup); let text;
        if (typeof r === "number") { if (!(r > 0) || !isFinite(r)) throw new Error("the result is " + r); const s = snap(r, (rule.series === undefined || rule.series === null || rule.series === "") ? DEFAULT_SERIES[c.type] : rule.series); const old = parseValue(c.value, UNIT_OF[c.type]); text = (old !== null && Math.abs(old - s) <= 1e-4 * s) ? c.value : formatValue(s, c.type); }
        else text = String(r);
        controlled.add(c.ref); if (text !== c.value) { changes.push({ ref: c.ref, what: "value", from: c.value, to: text }); c.value = text; }
      } else if (what === "mpn") { const r = String(evaluate(to, lookup)); controlled.add(c.ref + ".mpn"); if (r !== c.mpn) { changes.push({ ref: c.ref, what: "part", from: c.mpn, to: r }); c.mpn = r; c.lcsc = ""; } }
      else if (what === "dnp") { const r = to ? !!evaluate(to, lookup) : true; if (r !== !!c.dnp) { changes.push({ ref: c.ref, what: "dnp", from: !!c.dnp, to: r }); c.dnp = r; } }
      else if (what === "remove") { detach(c.ref, null); circuit.components = circuit.components.filter((x) => x !== c); removed.add(c.ref); changes.push({ ref: c.ref, what: "removed" }); }
      else if (what === "net") {
        const pin = String(rule.pin === undefined ? "" : rule.pin).trim(); if (!pin) throw new Error("no pin given"); let name = String(evaluate(to || "''", lookup)).trim(); if (/^(nc|n\/c|open|none)$/i.test(name)) name = "";
        const cur = circuit.nets.find((n) => (n.nodes || []).some((x) => x.ref === c.ref && String(x.pin) === pin)); if (cur && name && same(cur.name, name)) return;
        detach(c.ref, pin);
        if (!name) { circuit.no_connects = (circuit.no_connects || []).concat([{ ref: c.ref, pin }]); changes.push({ ref: c.ref, what: "pin", pin, to: "not connected" }); }
        else { let net = circuit.nets.find((n) => same(n.name, name)); if (!net) { net = { name, kind: netKind(name), port: "none", nodes: [] }; circuit.nets.push(net); } net.nodes.push({ ref: c.ref, pin }); changes.push({ ref: c.ref, what: "pin", pin, to: net.name }); }
      } else problems.push(tag + ": unknown action '" + rule.set + "'");
    } catch (e) { problems.push(tag + ": " + e.message); }
  });
  circuit.nets = circuit.nets.filter((n) => (n.nodes || []).length > 0);
  const actual = {};
  for (const o of options) if (o.type === "number" && o.actual) { try { const v = evaluate(o.actual, lookup); if (typeof v === "number" && isFinite(v)) actual[o.id] = v; } catch (e) { /* not computable right now */ } }
  delete circuit.options; delete circuit.rules;
  return { circuit, options, values: vals, changes, problems, controlled, removed, actual };
}

const api = { parseExpr, evaluate, snap, formatValue, cleanOptions, chosenValues, applyOptions, SERIES };
root.DS2K_OPT = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* Combine several finished designs into one circuit: references are renumbered, ground / supply rails / bus signals with
   the same name join automatically, every other net that would collide gets the block's IC as a suffix. */
(function (root) {
"use strict";
const P2 = root.DS2K_P2;
const SHARED = /^(A|D|P)?GND$|^VSS$|^[+-]\d+V\d*$|^VCC$|^VDD$|^VBUS$|^VBAT$|^(SDA|SCL|MOSI|MISO|SCK|SCLK)$/i;
const prefixOf = (ref) => (/^[A-Za-z_#]+/.exec(ref) || ["X"])[0].toUpperCase();
function combine(designs, title) {
  const counters = {}; const blocks = []; const sim = { sources: [], standins: [], chips: [], loads: [], probes: [] }; const comps = [], nets = [], ncs = [], notes = [], warnings = [];
  const prepared = designs.map((d) => { const c = new P2.Circuit(JSON.parse(JSON.stringify(d.circuit))); c.normalize(); return { name: d.name, c: c.toDict(), sim: d.sim }; });
  const count = new Map(); for (const p of prepared) for (const n of p.c.nets) if (!P2.isAutoName(n.name)) count.set(n.name.toUpperCase(), (count.get(n.name.toUpperCase()) || 0) + 1);
  for (const p of prepared) {
    const map = {}; for (const k of p.c.components) { const pre = prefixOf(k.ref); counters[pre] = (counters[pre] || 0) + 1; map[k.ref] = pre + counters[pre]; }
    const main = p.c.components.find((k) => k.type === "ic") || p.c.components[0]; const tag = main ? map[main.ref] : "B" + (blocks.length + 1);
    for (const k of p.c.components) comps.push(Object.assign({}, k, { ref: map[k.ref] }));
    for (const n of p.c.nets) { let name = P2.isAutoName(n.name) ? "" : n.name; if (name && !SHARED.test(name) && n.kind !== "ground" && count.get(name.toUpperCase()) > 1) name = name + "_" + tag; nets.push({ name, kind: n.kind, port: n.port, nodes: n.nodes.map((x) => ({ ref: map[x.ref], pin: x.pin })) }); }
    for (const x of p.c.no_connects || []) ncs.push({ ref: map[x.ref], pin: x.pin });
    for (const w of p.c.warnings || []) warnings.push(p.name + ": " + w); if ((p.c.notes || []).length) notes.push(p.name + ": " + p.c.notes.slice(0, 2).join("; "));
    const nameOf = {}; p.c.nets.forEach((n, i) => { nameOf[n.name.toUpperCase()] = nets[nets.length - p.c.nets.length + i].name; }); const sm = p.sim;
    if (sm && typeof sm === "object") { const nn = (x) => nameOf[String(x || "").toUpperCase()] || x; for (const x of sm.sources || []) sim.sources.push(Object.assign({}, x, { net: nn(x.net) })); for (const x of sm.loads || []) sim.loads.push(Object.assign({}, x, { net: nn(x.net) }));
      for (const x of sm.standins || []) if (map[String(x.ref).toUpperCase()]) sim.standins.push(Object.assign({}, x, { ref: map[String(x.ref).toUpperCase()] })); for (const x of sm.chips || []) if (map[String(x.ref).toUpperCase()]) sim.chips.push(Object.assign({}, x, { ref: map[String(x.ref).toUpperCase()] })); for (const x of sm.probes || []) if (sim.probes.length < 4) sim.probes.push(nn(x)); sim.tstop = Math.max(sim.tstop || 0, +sm.tstop || 0) || undefined; }
    blocks.push({ name: p.name, tag, refs: Object.values(map) });
  }
  return { part: { mpn: "" }, design: { title: title || blocks.map((b) => b.name).join(" + "), description: "" }, components: comps, nets, no_connects: ncs, notes: notes.slice(0, 8), warnings, confidence: null, options: [], rules: [], blocks, sim: (sim.sources.length || sim.standins.length || sim.chips.length) ? sim : null };
}
root.DS2K_COMBINE = { combine, SHARED };
})(typeof window !== "undefined" ? window : globalThis);

/* Simulation: turns a circuit + "stand-ins" for the chips into (a) an ngspice netlist and (b) a quick transient run in the page.
   Chips have no model here, so each chip pin that drives something is replaced by what the datasheet says it does:
   a DC level, a clock, a sine, a load - or the whole chip by a behavioural model: regulator (with drop-out and current limit),
   op-amp, buck controller (closed loop, averaged switch: the feedback divider, soft-start and enable all work) or 555 timer. */
(function (root) {
"use strict";
const P2 = root.DS2K_P2, OPT = root.DS2K_OPT;
const UNIT = { resistor: "ohm", thermistor: "ohm", potentiometer: "ohm", capacitor: "F", capacitor_polarized: "F", inductor: "H" };
const DIODES = { diode: "DGEN", schottky_diode: "DSCH", zener_diode: "DZ", tvs_diode: "DZ", led: "DLED" };
const MODELS = { DGEN: { is: 1e-14, n: 1, rs: 0.05 }, DSCH: { is: 1e-6, n: 1.05, rs: 0.03 }, DLED: { is: 1e-18, n: 2, rs: 5 }, DZ: { is: 1e-14, n: 1, rs: 0.5 } };
const node = (name) => { const s = String(name || ""); if (/^(A|D|P)?GND$|^VSS$|^0V?$/i.test(s)) return "0"; return s.replace(/^\+/, "P").replace(/^-/, "N").replace(/[^A-Za-z0-9_]/g, "_") || "n"; };
const guessVolt = (name) => { const s = String(name || "").toUpperCase(); let m = /^\+?(\d+)V(\d+)$/.exec(s); if (m) return parseFloat(m[1] + "." + m[2]); m = /^\+?(\d+(?:\.\d+)?)V?$/.exec(s); if (m) return parseFloat(m[1]); if (/VBUS|USB/.test(s)) return 5; if (/VBAT/.test(s)) return 3.7; if (/^VIN/.test(s)) return 12; if (/^VCC|^VDD|^AVDD|^DVDD/.test(s)) return 3.3; return null; };

/* what to assume when the design carries no `sim` section */
function defaultSim(circuit) {
  const sources = [], standins = [], probes = [];
  for (const n of circuit.nets) { if (n.kind === "ground") continue; if (n.kind === "power" && n.port === "input") { const v = guessVolt(n.name); sources.push({ net: n.name, kind: "dc", value: v === null ? 5 : v }); } if (n.port === "output" || (n.kind === "power" && n.port !== "input")) probes.push(n.name); }
  for (const c of circuit.components) if (c.type === "ic") for (const p of c.pins || []) if (p.etype === "power_out") { const net = circuit.nets.find((n) => n.nodes.some((x) => x.ref === c.ref && String(x.pin) === String(p.number))); const v = net ? guessVolt(net.name) : null; if (net && v !== null) standins.push({ ref: c.ref, pin: String(p.number), kind: "dc", value: v }); }
  if (!sources.length) { const n = circuit.nets.find((x) => x.kind === "power" && !standins.some((s) => circuit.nets.find((m) => m === x && m.nodes.some((y) => y.ref === s.ref && String(y.pin) === s.pin)))); if (n) sources.push({ net: n.name, kind: "dc", value: guessVolt(n.name) === null ? 5 : guessVolt(n.name) }); }
  return { sources, standins, chips: [], loads: [], switches: [], probes: probes.slice(0, 4), tstop: 0.005 };
}
function cleanSim(sim, circuit) {
  const d = defaultSim(circuit); if (!sim || typeof sim !== "object") return d; const arr = (x) => (Array.isArray(x) ? x.filter((y) => y && typeof y === "object") : []);
  const out = { sources: arr(sim.sources), standins: arr(sim.standins), chips: arr(sim.chips), loads: arr(sim.loads), switches: arr(sim.switches), probes: Array.isArray(sim.probes) ? sim.probes.map(String).filter((p, i, a) => a.findIndex((q) => q.toUpperCase() === p.toUpperCase()) === i) : [], tstop: sim.tstop };
  if (!out.sources.length && !out.standins.length && !out.chips.length) { out.sources = d.sources; out.standins = d.standins; } if (!out.probes.length) out.probes = d.probes; return out;
}

/* Builds the flat element list both back-ends use. `vals` = chosen option values (stand-in numbers may be expressions of them). */
function elements(circuit, simIn, vals, alias) {
  const sim = cleanSim(simIn, circuit); const els = [], notes = [], netOf = new Map(); const used = new Set(["0"]);
  for (const n of circuit.nets) { let nm = node(n.name); if (nm !== "0") { let k = nm, i = 2; while (used.has(k.toUpperCase()) && ![...netOf.values()].includes(k)) k = nm + "_" + i++; nm = k; used.add(nm.toUpperCase()); } for (const x of n.nodes) netOf.set(x.ref + "\u0000" + x.pin, nm); n._node = nm; }
  let open = 0; const at = (ref, pin) => netOf.get(ref + "\u0000" + pin) || ("nc_" + ref + "_" + String(pin).replace(/[^A-Za-z0-9]/g, "") + (open++ ? "" : ""));
  const refOf = (r) => { const k = String(r || "").trim(); return (alias && (alias[k] || alias[k.toUpperCase()])) || k.toUpperCase(); };
  const num = (x, dflt) => { if (typeof x === "number") return x; if (x === undefined || x === null || x === "") return dflt; try { const v = OPT.evaluate(String(x), (name) => { for (const k of Object.keys(vals || {})) if (k.toLowerCase() === name.toLowerCase()) return vals[k]; const c = circuit.components.find((q) => q.ref === refOf(name)); if (c) { const pv = P2.parseValue(c.value, UNIT[c.type]); if (pv !== null) return pv; } throw new Error("unknown name " + name); }); return typeof v === "number" && isFinite(v) ? v : dflt; } catch (e) { notes.push("Could not work out '" + x + "': " + e.message); return dflt; } };
  const wave = (s) => { const k = String(s.kind || "dc").toLowerCase(); if (k === "pulse" || k === "clock") { const f = num(s.freq, 1000); return { kind: "pulse", low: num(s.low, 0), high: num(s.high !== undefined ? s.high : s.value, 3.3), freq: f, duty: Math.min(0.99, Math.max(0.01, num(s.duty, 0.5))) }; } if (k === "sine") return { kind: "sine", offset: num(s.offset, 0), ampl: num(s.ampl !== undefined ? s.ampl : s.value, 1), freq: num(s.freq, 1000) }; return { kind: "dc", value: num(s.value, 0) }; };
  const driven = new Map(); const drive = (nd, who) => { if (nd === "0") { notes.push(who + " would drive ground - skipped"); return false; } if (driven.has(nd)) { notes.push(who + " skipped: " + nd + " is already driven by " + driven.get(nd)); return false; } driven.set(nd, who); return true; };

  for (const c of circuit.components) {
    if (c.dnp) continue; const p = (x) => at(c.ref, x); const t = c.type;
    if (UNIT[t] && t !== "potentiometer") { let v = P2.parseValue(c.value, UNIT[t]); if (v === null || !(v > 0)) { notes.push(c.ref + ": no usable value ('" + c.value + "') - left out"); continue; } els.push({ t: t === "inductor" ? "L" : t.startsWith("capacitor") ? "C" : "R", name: c.ref, a: p(t === "capacitor_polarized" ? "+" : "1"), b: p(t === "capacitor_polarized" ? "-" : "2"), v }); }
    else if (t === "potentiometer") { const v = P2.parseValue(c.value, "ohm") || 10e3; els.push({ t: "R", name: c.ref + "a", a: p("1"), b: p("W"), v: v / 2 }, { t: "R", name: c.ref + "b", a: p("W"), b: p("3"), v: v / 2 }); }
    else if (t === "ferrite_bead" || t === "fuse") els.push({ t: "R", name: c.ref, a: p("1"), b: p("2"), v: t === "ferrite_bead" ? 0.1 : 0.01 });
    else if (t === "switch" || t === "jumper") { const sw = sim.switches.find((x) => refOf(x.ref) === c.ref); const closed = sw ? !!sw.closed : t === "jumper"; if (closed) els.push({ t: "R", name: c.ref, a: p("1"), b: p("2"), v: 0.01 }); if (!sw) notes.push(c.ref + " is simulated " + (closed ? "closed" : "open")); }
    else if (DIODES[t]) { const m = DIODES[t]; const bv = m === "DZ" ? (P2.parseValue(c.value, "") || parseFloat((/(\d+(?:\.\d+)?)\s*V/i.exec(c.value + " " + c.rating) || [])[1]) || 5.1) : 0; els.push({ t: "D", name: c.ref, a: p("A"), b: p("K"), model: m, bv }); }
    else if (t === "bjt_npn" || t === "bjt_pnp") els.push({ t: "Q", name: c.ref, c: p("C"), b: p("B"), e: p("E"), pnp: t === "bjt_pnp" });
    else if (t === "mosfet_n" || t === "mosfet_p") els.push({ t: "M", name: c.ref, d: p("D"), g: p("G"), s: p("S"), pch: t === "mosfet_p" });
    else if (t === "ic" || t === "other") { /* handled by chips / stand-ins below */ }
    else if (t !== "test_point" && t !== "connector" && t !== "crystal") notes.push(c.ref + " (" + t.replace(/_/g, " ") + ") is left open in the simulation");
  }
  const has = (ref) => circuit.components.some((c) => c.ref === ref && !c.dnp);
  for (const ch of sim.chips) {
    const ref = refOf(ch.ref); if (!has(ref)) continue; const m = String(ch.model || "").toLowerCase();
    if (m === "regulator") { const o = at(ref, String(ch.out)); if (drive(o, ref + " regulator")) els.push({ t: "REG", name: ref, in: at(ref, String(ch.in)), out: o, gnd: ch.gnd !== undefined ? at(ref, String(ch.gnd)) : "0", vout: num(ch.vout, 3.3), drop: num(ch.dropout, 0.3), ilim: num(ch.ilim, 0) }); }
    else if (m === "opamp") { (Array.isArray(ch.units) ? ch.units : [ch]).forEach((u, i) => { const o = at(ref, String(u.out)); if (drive(o, ref + " op-amp")) els.push({ t: "OPA", name: ref + (i ? "_" + (i + 1) : ""), p: at(ref, String(u.inp)), n: at(ref, String(u.inn)), out: o, vp: ch.vp !== undefined ? at(ref, String(ch.vp)) : null, vn: ch.vn !== undefined ? at(ref, String(ch.vn)) : "0" }); }); }
    else if (m === "switcher" || m === "buck") { const o = at(ref, String(ch.sw)); if (drive(o, ref + " switch node")) { const fb = ch.fb !== undefined ? at(ref, String(ch.fb)) : null; if (!fb) notes.push(ref + ": the buck controller needs an fb pin");
      else els.push({ t: "SWR", name: ref, in: at(ref, String(ch.in)), sw: o, fb, gnd: ch.gnd !== undefined ? at(ref, String(ch.gnd)) : "0", en: ch.en !== undefined ? at(ref, String(ch.en)) : null, ss: ch.ss !== undefined ? at(ref, String(ch.ss)) : null, vref: num(ch.vref, 0.8), freq: num(ch.freq, 500e3), fc: num(ch.fc, 300), dmax: num(ch.dmax, 0.95), iss: num(ch.iss, 2e-6), ven: num(ch.ven, 1.2), ron: num(ch.ron, 0.1), ilim: num(ch.ilim, 4) }); } }
    else if (m === "timer555" || m === "555") { const o = at(ref, String(ch.out)); if (drive(o, ref + " 555 output")) els.push({ t: "T555", name: ref, vcc: at(ref, String(ch.vcc)), gnd: ch.gnd !== undefined ? at(ref, String(ch.gnd)) : "0", trig: at(ref, String(ch.trig)), thr: at(ref, String(ch.thr)), dis: ch.dis !== undefined ? at(ref, String(ch.dis)) : null, out: o, cont: ch.cont !== undefined ? at(ref, String(ch.cont)) : ref + "_cont", reset: ch.reset !== undefined ? at(ref, String(ch.reset)) : null }); }
    else notes.push(ref + ": unknown chip model '" + ch.model + "'");
  }
  for (const s of sim.standins) {
    const ref = refOf(s.ref); if (!has(ref)) continue; const nd = at(ref, String(s.pin)); const k = String(s.kind || "dc").toLowerCase();
    if (k === "open") continue; if (k === "load") { els.push({ t: "R", name: "load_" + ref + "_" + s.pin, a: nd, b: "0", v: Math.max(1e-3, num(s.value !== undefined ? s.value : s.r, 10e3)) }); continue; }
    if (drive(nd, ref + " pin " + s.pin)) els.push({ t: "V", name: ref + "_" + String(s.pin).replace(/[^A-Za-z0-9]/g, ""), a: nd, b: "0", w: wave(s), rs: num(s.r, 0) });
  }
  for (const s of sim.sources) { const n = circuit.nets.find((x) => x.name.toUpperCase() === String(s.net || "").toUpperCase()); if (!n) { notes.push("Source on '" + s.net + "': no such net"); continue; } if (driven.has(n._node)) continue; if (drive(n._node, "supply " + n.name)) els.push({ t: "V", name: "src_" + n._node, a: n._node, b: "0", w: wave(s), rs: 0 }); }
  for (const l of sim.loads) { const n = circuit.nets.find((x) => x.name.toUpperCase() === String(l.net || "").toUpperCase()); if (!n) { notes.push("Load on '" + l.net + "': no such net"); continue; } els.push({ t: "R", name: "load_" + n._node, a: n._node, b: "0", v: Math.max(1e-3, num(l.value, 1e3)) }); }
  const probes = sim.probes.map((p) => circuit.nets.find((x) => x.name.toUpperCase() === String(p).toUpperCase())).filter((n) => n && n._node !== "0").slice(0, 4).map((n) => ({ label: n.name, node: n._node }));
  let fmax = 0; for (const e of els) if (e.t === "V" && e.w.freq) fmax = Math.max(fmax, e.w.freq); let fsw = 0; for (const e of els) if (e.t === "SWR") fsw = Math.max(fsw, e.freq);
  let tstop = num(sim.tstop, 0); if (!(tstop > 0)) tstop = fmax ? Math.max(20 / fmax, 0.002) : 0.005; tstop = Math.min(tstop, 10);
  for (const n of circuit.nets) delete n._node;
  return { els, probes, tstop, fmax, fsw, notes, sim };
}

/* ------------------------------------------------------------------ ngspice netlist */
const eng = (x) => String(parseFloat(Number(x).toPrecision(6)));
function netlist(circuit, simIn, vals, alias, title) {
  const E = elements(circuit, simIn, vals, alias); const L = ["* " + (title || "reference design") + " - generated by Debug AI", "* Chips are replaced by stand-ins (see the V/B sources named after them). Run:  ngspice thisfile.cir"]; const models = new Set();
  const src = (w) => w.kind === "pulse" ? "PULSE(" + [w.low, w.high, 0, 1 / w.freq / 200, 1 / w.freq / 200, w.duty / w.freq, 1 / w.freq].map(eng).join(" ") + ")" : w.kind === "sine" ? "SIN(" + [w.offset, w.ampl, w.freq].map(eng).join(" ") + ")" : "DC " + eng(w.value);
  for (const e of E.els) {
    if (e.t === "R" || e.t === "C" || e.t === "L") L.push(e.t + e.name + " " + e.a + " " + e.b + " " + eng(e.v));
    else if (e.t === "D") { const m = e.model === "DZ" ? "DZ_" + e.name : e.model; if (e.model === "DZ") L.push(".model " + m + " D(Is=1e-14 Rs=0.5 BV=" + eng(e.bv) + " IBV=1m)"); else models.add(e.model); L.push("D" + e.name + " " + e.a + " " + e.b + " " + m); }
    else if (e.t === "Q") { models.add(e.pnp ? "QP" : "QN"); L.push("Q" + e.name + " " + e.c + " " + e.b + " " + e.e + " " + (e.pnp ? "QP" : "QN")); }
    else if (e.t === "M") { models.add(e.pch ? "MP" : "MN"); L.push("M" + e.name + " " + e.d + " " + e.g + " " + e.s + " " + e.s + " " + (e.pch ? "MP" : "MN") + " W=1 L=1"); }
    else if (e.t === "V") { if (e.rs > 0) { L.push("V" + e.name + " " + e.a + "_i " + e.b + " " + src(e.w), "Rs_" + e.name + " " + e.a + "_i " + e.a + " " + eng(e.rs)); } else L.push("V" + e.name + " " + e.a + " " + e.b + " " + src(e.w)); }
    else if (e.t === "REG") L.push("* " + e.name + ": ideal regulator, " + e.vout + " V, " + e.drop + " V dropout" + (e.ilim ? ", " + e.ilim + " A limit" : ""), "B" + e.name + " " + e.out + "_r " + e.gnd + " V=min(max(V(" + e.in + "," + e.gnd + ")-" + eng(e.drop) + ",0)," + eng(e.vout) + ")" + (e.ilim ? "-50*max(0,i(Vs_" + e.name + ")-" + eng(e.ilim) + ")" : ""), "Vs_" + e.name + " " + e.out + "_r " + e.out + " DC 0", "F" + e.name + " " + e.in + " " + e.gnd + " Vs_" + e.name + " 1");
    else if (e.t === "SWR") { const T = 1 / e.freq, ref = e.ss ? "min(" + eng(e.vref) + ",V(" + e.ss + "))" : eng(e.vref), en = e.en ? "*(V(" + e.en + ")>" + eng(e.ven) + "?1:0)" : ""; const K = 2 * Math.PI * e.fc * 0.3 / e.vref;
      L.push("* " + e.name + ": buck controller stand-in - " + eng(e.freq) + " Hz, Vref " + eng(e.vref) + " V, closed loop (integrating error amp, PWM comparator, ideal switch, no current limit)",
        "Berr_" + e.name + " 0 " + e.name + "_int I=(" + ref + "-V(" + e.fb + "))*" + eng(K * 1e-6) + en, "Cint_" + e.name + " " + e.name + "_int 0 1u", "Rint_" + e.name + " " + e.name + "_int 0 1e9",
        "Vsaw_" + e.name + " " + e.name + "_saw 0 PULSE(0 1 0 " + eng(T * 0.98) + " " + eng(T * 0.01) + " " + eng(T * 0.005) + " " + eng(T) + ")",
        "Bpwm_" + e.name + " " + e.name + "_pwm 0 V=(V(" + e.name + "_saw)<max(min(V(" + e.name + "_int)," + eng(e.dmax) + "),0))?1:0",
        "S_" + e.name + " " + e.in + " " + e.sw + " " + e.name + "_pwm 0 SWM_" + e.name, ".model SWM_" + e.name + " SW(Ron=" + eng(e.ron) + " Roff=1e7 Vt=0.5 Vh=0.1)");
      if (e.ss) L.push("Iss_" + e.name + " 0 " + e.ss + " DC " + eng(e.iss)); if (e.en) L.push("Ren_" + e.name + " " + e.in + " " + e.en + " 5e6"); }
    else if (e.t === "T555") { const g = e.gnd; L.push("* " + e.name + ": 555 timer stand-in (comparators, latch, output stage, discharge switch)",
        "Rc1_" + e.name + " " + e.vcc + " " + e.cont + " 5k", "Rc2_" + e.name + " " + e.cont + " " + g + " 10k",
        "Bq_" + e.name + " " + e.name + "_qn " + g + " V=" + (e.reset ? "(V(" + e.reset + "," + g + ")<0.7)?0:" : "") + "(V(" + e.thr + "," + g + ")>V(" + e.cont + "," + g + "))?0:(V(" + e.trig + "," + g + ")<V(" + e.cont + "," + g + ")/2)?1:(V(" + e.name + "_q," + g + ")>0.5?1:0)",
        "Rq_" + e.name + " " + e.name + "_qn " + e.name + "_q 1", "Cq_" + e.name + " " + e.name + "_q " + g + " 1n",
        "Bo_" + e.name + " " + e.name + "_o " + g + " V=(V(" + e.name + "_q," + g + ")>0.5)?max(V(" + e.vcc + "," + g + ")-1.2,0):0.05", "Ro_" + e.name + " " + e.name + "_o " + e.out + " 10");
      if (e.dis) L.push("Bd_" + e.name + " " + e.name + "_d " + g + " V=(V(" + e.name + "_q," + g + ")>0.5)?0:1", "Sd_" + e.name + " " + e.dis + " " + g + " " + e.name + "_d " + g + " SWD_" + e.name, ".model SWD_" + e.name + " SW(Ron=10 Roff=1e7 Vt=0.5 Vh=0.1)"); }
    else if (e.t === "OPA") { const hi = e.vp ? "V(" + e.vp + ")" : "5", lo = e.vn && e.vn !== "0" ? "V(" + e.vn + ")" : "0"; L.push("* " + e.name + ": ideal rail-to-rail op-amp", "B" + e.name + " " + e.out + "_o 0 V=(" + hi + "+" + lo + ")/2+(" + hi + "-" + lo + ")/2*tanh(1e5*V(" + e.p + "," + e.n + ")/((" + hi + "-" + lo + ")/2+1e-9))", "Ro_" + e.name + " " + e.out + "_o " + e.out + " 10"); }
  }
  const M = { DGEN: ".model DGEN D(Is=1e-14 N=1 Rs=0.05)", DSCH: ".model DSCH D(Is=1e-6 N=1.05 Rs=0.03)", DLED: ".model DLED D(Is=1e-18 N=2 Rs=5)", QN: ".model QN NPN(Bf=200 Is=1e-14)", QP: ".model QP PNP(Bf=200 Is=1e-14)", MN: ".model MN NMOS(Level=1 Vto=2 Kp=2)", MP: ".model MP PMOS(Level=1 Vto=-2 Kp=2)" };
  for (const m of models) L.push(M[m]);
  const fm = Math.max(E.fmax, E.fsw); const dt = fm ? Math.min(E.tstop / 2000, 1 / fm / 50) : E.tstop / 2000; const pl = E.probes.map((p) => "v(" + p.node + ")").join(" ");
  L.push(".options reltol=1e-3", ".control", "tran " + eng(dt) + " " + eng(E.tstop) + " uic", pl ? "plot " + pl : "* no probes chosen", ".endc", ".end", "");
  return { text: L.join("\n"), notes: E.notes, probes: E.probes };
}

/* ------------------------------------------------------------------ quick transient solver (modified nodal analysis, backward Euler, Newton) */
function solve(A, b, n) {
  for (let i = 0; i < n; i++) { let p = i, m = Math.abs(A[i * n + i]); for (let r = i + 1; r < n; r++) { const v = Math.abs(A[r * n + i]); if (v > m) { m = v; p = r; } } if (m < 1e-300) return false;
    if (p !== i) { for (let c = 0; c < n; c++) { const t = A[i * n + c]; A[i * n + c] = A[p * n + c]; A[p * n + c] = t; } const t = b[i]; b[i] = b[p]; b[p] = t; }
    const d = A[i * n + i]; for (let r = i + 1; r < n; r++) { const f = A[r * n + i] / d; if (f === 0) continue; for (let c = i; c < n; c++) A[r * n + c] -= f * A[i * n + c]; b[r] -= f * b[i]; } }
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i * n + c] * b[c]; b[i] = s / A[i * n + i]; } return true;
}
function luFactor(A, piv, n) {
  for (let i = 0; i < n; i++) { let p = i, m = Math.abs(A[i * n + i]); for (let r = i + 1; r < n; r++) { const v = Math.abs(A[r * n + i]); if (v > m) { m = v; p = r; } } if (m < 1e-300) return false; piv[i] = p;
    if (p !== i) for (let c = 0; c < n; c++) { const t = A[i * n + c]; A[i * n + c] = A[p * n + c]; A[p * n + c] = t; }
    const d = A[i * n + i]; for (let r = i + 1; r < n; r++) { const f = A[r * n + i] / d; A[r * n + i] = f; if (f === 0) continue; for (let c = i + 1; c < n; c++) A[r * n + c] -= f * A[i * n + c]; } }
  return true;
}
function luSolve(LU, piv, b, n) {
  for (let i = 0; i < n; i++) { const p = piv[i]; if (p !== i) { const t = b[i]; b[i] = b[p]; b[p] = t; } for (let r = i + 1; r < n; r++) b[r] -= LU[r * n + i] * b[i]; }
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= LU[i * n + c] * b[c]; b[i] = s / LU[i * n + i]; }
}
function run(circuit, simIn, vals, alias, opts) {
  const E = elements(circuit, simIn, vals, alias); const idx = new Map(); const id = (nm) => { if (nm === "0") return -1; if (!idx.has(nm)) idx.set(nm, idx.size); return idx.get(nm); };
  const els = []; for (const e of E.els) { if (e.t === "V" && e.rs > 0) { els.push(Object.assign({}, e, { a: e.a + "_i", rs: 0 }), { t: "R", name: "rs_" + e.name, a: e.a + "_i", b: e.a, v: e.rs }); } else if (e.t === "OPA") { els.push(Object.assign({}, e, { out: e.out + "_o" }), { t: "R", name: "ro_" + e.name, a: e.out + "_o", b: e.out, v: 10 }); } else if (e.t === "D" && MODELS[e.model].rs) { els.push(Object.assign({}, e, { a: e.a + "_d" + e.name }), { t: "R", name: "rd_" + e.name, a: e.a, b: e.a + "_d" + e.name, v: MODELS[e.model].rs }); }
    else if (e.t === "T555") { els.push(Object.assign({}, e, { out: e.out + "_o" }), { t: "R", name: "ro_" + e.name, a: e.out + "_o", b: e.out, v: 10 }, { t: "R", name: "rc1_" + e.name, a: e.vcc, b: e.cont, v: 5000 }, { t: "R", name: "rc2_" + e.name, a: e.cont, b: e.gnd, v: 10000 }); }
    else if (e.t === "SWR" && e.en) { els.push(e, { t: "R", name: "ren_" + e.name, a: e.in, b: e.en, v: 5e6 }); }
    else els.push(e); }
  for (const e of els) for (const k of ["a", "b", "c", "e", "d", "g", "s", "p", "n", "out", "in", "gnd", "vp", "vn", "sw", "fb", "en", "ss", "vcc", "trig", "thr", "dis", "cont", "reset"]) if (typeof e[k] === "string") e["_" + k] = id(e[k]); else if (k in e) e["_" + k] = -1;
  const nn = idx.size; let nb = 0; for (const e of els) if (e.t === "V" || e.t === "L" || e.t === "REG" || e.t === "OPA" || e.t === "SWR" || e.t === "T555") e._br = nn + nb++; const N = nn + nb;
  if (!N) return { ok: false, error: "There is nothing to simulate.", notes: E.notes };
  const limit = (opts && opts.maxSteps) || 40000; let dt = E.fmax ? Math.min(E.tstop / 2000, 1 / E.fmax / 40) : E.tstop / 2000; let steps = Math.ceil(E.tstop / dt); const notes = E.notes.slice(); if (steps > limit) { steps = limit; dt = E.tstop / steps; if (E.fmax && dt > 1 / E.fmax / 12) notes.push("The run is long compared with the fastest clock, so switching edges are coarse - shorten the time for detail."); }
  const x = new Float64Array(N), xo = new Float64Array(N), A = new Float64Array(N * N), b = new Float64Array(N), xn = new Float64Array(N);
  const V = (arr, i) => (i < 0 ? 0 : arr[i]); const G = (i, j, g) => { if (i >= 0 && j >= 0) A[i * N + j] += g; }; const g2 = (a, c, g) => { G(a, a, g); G(c, c, g); G(a, c, -g); G(c, a, -g); }; const I = (i, v) => { if (i >= 0) b[i] += v; };
  const wv = (w, t) => w.kind === "pulse" ? (((t * w.freq) % 1) < w.duty ? w.high : w.low) : w.kind === "sine" ? w.offset + w.ampl * Math.sin(2 * Math.PI * w.freq * t) : w.value;
  const VT = 0.02585; const pn = (v, is, n) => { const vt = n * VT, vc = vt * Math.log(vt / (1.414 * is)); if (v > vc + 10 * vt) { const ec = Math.exp((vc + 10 * vt) / vt); return [is * (ec - 1) + is / vt * ec * (v - vc - 10 * vt), is / vt * ec]; } const ev = Math.exp(v / vt); return [is * (ev - 1), is / vt * ev + 1e-12]; };
  const nonlinear = els.some((e) => ["D", "Q", "M", "OPA", "REG"].includes(e.t)); const stateful = els.some((e) => e.t === "SWR" || e.t === "T555"); const linear = !nonlinear && !stateful;
  for (const e of els) { if (e.t === "SWR") { e._D = 0; } if (e.t === "T555") { e._q = 0; } } const keep = Math.max(1, Math.ceil(steps / 1500)); const T = [], traces = E.probes.map(() => []); const pi = E.probes.map((p) => (idx.has(p.node) ? idx.get(p.node) : -1));
  let limited = false;
  const stamp = (t) => {
    limited = false; A.fill(0); b.fill(0); for (let i = 0; i < nn; i++) A[i * N + i] += 1e-12;
    for (const e of els) {
      if (e.t === "R") g2(e._a, e._b, 1 / e.v);
      else if (e.t === "C") { const g = e.v / dt; g2(e._a, e._b, g); const vo = V(xo, e._a) - V(xo, e._b); I(e._a, g * vo); I(e._b, -g * vo); }
      else if (e.t === "L") { const k = e._br; G(e._a, k, 1); G(e._b, k, -1); G(k, e._a, 1); G(k, e._b, -1); A[k * N + k] -= e.v / dt; b[k] -= e.v / dt * xo[k]; }
      else if (e.t === "V") { const k = e._br; G(e._a, k, 1); G(e._b, k, -1); G(k, e._a, 1); G(k, e._b, -1); b[k] += wv(e.w, t); }
      else if (e.t === "D") { const m = MODELS[e.model]; const vd = V(x, e._a) - V(x, e._b); let [i, g] = pn(vd, m.is, m.n); if (e.bv && vd < -e.bv + 1) { const [ib, gb] = pn(-vd - e.bv, 1e-14, 1); i -= ib; g += gb; } g2(e._a, e._b, g); const ieq = i - g * vd; I(e._a, -ieq); I(e._b, ieq); }
      else if (e.t === "Q") { const s = e.pnp ? -1 : 1; const vbe = s * (V(x, e._b) - V(x, e._e)), vbc = s * (V(x, e._b) - V(x, e._c)); const [ife, gfe] = pn(vbe, 1e-14, 1), [ire, gre] = pn(vbc, 1e-14, 1); const bf = 200, br = 2;
        const ic = ife - ire * (1 + 1 / br), ib = ife / bf + ire / br; const dic_be = gfe, dic_bc = -gre * (1 + 1 / br), dib_be = gfe / bf, dib_bc = gre / br;
        const put = (row, cur, dbe, dbc) => { if (row < 0) return; const eq = cur - dbe * vbe - dbc * vbc; b[row] -= s * eq; G(row, e._b, (dbe + dbc)); G(row, e._e, -dbe); G(row, e._c, -dbc); };
        put(e._c, ic, dic_be, dic_bc); put(e._b, ib, dib_be, dib_bc); put(e._e, -(ic + ib), -(dic_be + dib_be), -(dic_bc + dib_bc)); }
      else if (e.t === "M") { const s = e.pch ? -1 : 1; let d = e._d, so = e._s; let vds = s * (V(x, d) - V(x, so)); if (vds < 0) { const tmp = d; d = so; so = tmp; vds = -vds; } const vgs = s * (V(x, e._g) - V(x, so)); const kp = 2, vt = 2, vov = vgs - vt; let id0 = 0, gm = 0, gds = 1e-9;
        if (vov > 0) { if (vds < vov) { id0 = kp * (vov * vds - vds * vds / 2); gm = kp * vds; gds += kp * (vov - vds); } else { id0 = kp / 2 * vov * vov; gm = kp * vov; } }
        const eq = id0 - gm * vgs - gds * vds; const row = (r, sign) => { if (r < 0) return; b[r] -= sign * s * eq; G(r, e._g, sign * gm); G(r, so, -sign * (gm + gds)); G(r, d, sign * gds); }; row(d, 1); row(so, -1); }
      else if (e.t === "REG") { const k = e._br; const vin = V(x, e._in) - V(x, e._gnd); const a = vin - e.drop, w = 0.02; const soft = (u) => (u > 30 * w ? u : w * Math.log1p(Math.exp(u / w))); const dsoft = (u) => 1 / (1 + Math.exp(-u / w)); const up = soft(a); const f = e.vout - soft(e.vout - up); const df = dsoft(e.vout - up) * dsoft(a);
        G(e._out, k, 1); G(e._gnd, k, -1); G(k, e._out, 1); G(k, e._gnd, -1); G(k, e._in, -df); G(k, e._gnd, df); b[k] += f - df * vin; G(e._in, k, -1); G(e._gnd, k, 1);
        if (e.ilim > 0) { const wi = 0.02 * e.ilim, idel = -x[k]; const u = idel - e.ilim; const sp = u > 30 * wi ? u : wi * Math.log1p(Math.exp(u / wi)), dsp = 1 / (1 + Math.exp(-u / wi)); const Rf = 50; G(k, k, -Rf * dsp); b[k] -= Rf * sp + Rf * dsp * x[k]; } }
      else if (e.t === "SWR") { const k = e._br, D = e._D; G(e._sw, k, 1); G(e._gnd, k, -1); G(k, e._sw, 1); G(k, e._gnd, -1); G(k, e._in, -D); G(k, e._gnd, D); G(e._in, k, -D); G(e._gnd, k, D); if (e._ss >= 0) I(e._ss, e.iss); }
      else if (e.t === "T555") { const k = e._br; const vcc = V(x, e._vcc) - V(x, e._gnd); const vo = e._q ? Math.max(vcc - 1.2, 0) : 0.05; G(e._out, k, 1); G(e._gnd, k, -1); G(k, e._out, 1); G(k, e._gnd, -1); b[k] += vo; if (e._dis >= 0 && !e._q) g2(e._dis, e._gnd, 0.1); }
      else if (e.t === "OPA") { const k = e._br; const hi = e._vp !== undefined && e._vp !== null && e.vp ? V(x, e._vp) : 5, lo = e.vn && e.vn !== "0" ? V(x, e._vn) : 0; const mid = (hi + lo) / 2, sw = Math.max(1e-3, (hi - lo) / 2); const vreal = V(x, e._p) - V(x, e._n); let vd = e._vl || 0; const dd = vreal - vd, lim = Math.max(4 * sw / 1e5, 0.75 * Math.abs(vd)); if (Math.abs(dd) > lim) { vd += Math.sign(dd) * lim; limited = true; } else vd = vreal; e._vl = vd;      /* step the linearisation point geometrically, otherwise Newton flips between the rails */
        const th = Math.tanh(1e5 * vd / sw); const f = mid + sw * th, g = Math.max(1e5 * (1 - th * th), 1e-3);
        G(e._out, k, 1); G(k, e._out, 1); G(k, e._p, -g); G(k, e._n, g); b[k] += f - g * vd; }
    }
  };
  let LU = null, piv = null;
  for (let s = 1; s <= steps; s++) {
    const t = s * dt; let ok = false;
    for (let it = 0; it < (nonlinear ? 80 : 1); it++) { stamp(t); xn.set(b);
      if (linear) { if (!LU) { LU = A.slice(); piv = new Int32Array(N); if (!luFactor(LU, piv, N)) return { ok: false, error: "The circuit cannot be solved (a floating node or two sources on one net).", notes }; } luSolve(LU, piv, xn, N); }
      else { const M = A.slice(); if (!solve(M, xn, N)) return { ok: false, error: "The circuit cannot be solved (a floating node or two sources on one net).", notes }; }
      let err = 0; for (let i = 0; i < N; i++) { let d = xn[i] - x[i]; if (nonlinear && i < nn && Math.abs(d) > 2) d = 2 * Math.sign(d); err = Math.max(err, Math.abs(d) / (1e-6 + 1e-3 * Math.abs(xn[i]))); x[i] += d; } if (!nonlinear || (err < 1 && !limited)) { ok = true; break; } }
    if (!ok && s === 1 && false) return { ok: false, error: "no convergence", notes }; for (let i = 0; i < N; i++) if (!isFinite(x[i])) return { ok: false, error: "The simulation blew up at t = " + t.toExponential(2) + " s.", notes };
    for (const e of els) {
      if (e.t === "SWR") { const vfb = V(x, e._fb) - V(x, e._gnd); let vref = e.vref; if (e._ss >= 0) vref = Math.min(vref, V(x, e._ss) - V(x, e._gnd)); const on = e._en < 0 || (V(x, e._en) - V(x, e._gnd)) > e.ven; const K = 2 * Math.PI * e.fc * Math.max(e._D, 0.05) / e.vref; e._D = on ? Math.min(e.dmax, Math.max(0, e._D + dt * K * (vref - vfb))) : Math.max(0, e._D - dt * 2000 * e._D); const il = -x[e._br]; if (e.ilim > 0 && il > e.ilim) e._D *= Math.max(0.5, e.ilim / il) * 0.98; }
      else if (e.t === "T555") { const g = V(x, e._gnd), cont = V(x, e._cont) - g; if (e._reset >= 0 && V(x, e._reset) - g < 0.7) e._q = 0; else if (V(x, e._thr) - g > cont) e._q = 0; else if (V(x, e._trig) - g < cont / 2) e._q = 1; }
    }
    xo.set(x); if (s % keep === 0 || s === steps) { T.push(t); pi.forEach((k, j) => traces[j].push(k < 0 ? 0 : x[k])); }
  }
  const final = {}; for (const [nm, k] of idx) if (!/_(i|o|r|cont)$|_d[A-Z]/.test(nm)) final[nm] = x[k]; const states = {}; for (const e of els) if (e.t === "SWR") states[e.name] = { duty: e._D }; else if (e.t === "T555") states[e.name] = { q: e._q };
  return { ok: true, t: T, traces: E.probes.map((p, j) => ({ label: p.label, v: traces[j] })), final, states, notes, tstop: E.tstop, steps };
}
/* fixes every expression to a number and every ref to its normalised name (used when designs are combined and their options disappear) */
function bake(simIn, vals, circuit, alias) {
  if (!simIn || typeof simIn !== "object") return null; const sim = JSON.parse(JSON.stringify(simIn)); const refOf = (r) => { const k = String(r || "").trim(); return (alias && (alias[k] || alias[k.toUpperCase()])) || k.toUpperCase(); };
  const ev = (x) => { if (typeof x !== "string" || x.trim() === "") return x; try { const v = OPT.evaluate(x, (name) => { for (const k of Object.keys(vals || {})) if (k.toLowerCase() === name.toLowerCase()) return vals[k]; const c = circuit.components.find((q) => q.ref === refOf(name)); const pv = c ? P2.parseValue(c.value, UNIT[c.type]) : null; if (pv !== null) return pv; throw new Error("?"); }); return typeof v === "number" && isFinite(v) ? v : x; } catch (e) { return x; } };
  for (const list of ["sources", "standins", "chips", "loads", "switches"]) for (const it of Array.isArray(sim[list]) ? sim[list] : []) { if (!it || typeof it !== "object") continue; for (const k of ["value", "low", "high", "freq", "duty", "offset", "ampl", "vout", "dropout", "r", "ilim", "vref", "fc", "dmax", "iss", "ven", "ron", "freq"]) if (k in it) it[k] = ev(it[k]); if (it.ref !== undefined) it.ref = refOf(it.ref); }
  return sim;
}
root.DS2K_SIM = { bake,  defaultSim, cleanSim, elements, netlist, run, guessVolt };
})(typeof window !== "undefined" ? window : globalThis);

/* Compare two independent reads of the same figure, and check a circuit against its own pin table. */
(function (root) {
"use strict";
const P2 = root.DS2K_P2;
function norm(d) { const c = new P2.Circuit(JSON.parse(JSON.stringify(d))); c.normalize(); return c.toDict(); }
function diffReads(a, b) {
  const A = norm(a), B = norm(b), out = []; const by = (c) => Object.fromEntries(c.components.map((k) => [k.ref, k]));
  const ca = by(A), cb = by(B);
  for (const r of Object.keys(ca)) if (!cb[r]) out.push(r + " (" + ca[r].value + ") appears in only one of the two reads"); for (const r of Object.keys(cb)) if (!ca[r]) out.push(r + " (" + cb[r].value + ") appears in only one of the two reads");
  for (const r of Object.keys(ca)) if (cb[r]) { const x = ca[r], y = cb[r]; const u = { resistor: "ohm", capacitor: "F", capacitor_polarized: "F", inductor: "H" }[x.type]; const vx = P2.parseValue(x.value, u), vy = P2.parseValue(y.value, u); const same = (vx !== null && vy !== null) ? Math.abs(vx - vy) <= 1e-3 * Math.max(vx, vy) : String(x.value).trim().toUpperCase() === String(y.value).trim().toUpperCase(); if (!same) out.push(r + ": value read as " + (x.value || "?") + " and as " + (y.value || "?")); if (x.type !== y.type) out.push(r + ": read as " + x.type.replace(/_/g, " ") + " and as " + y.type.replace(/_/g, " ")); }
  const mates = (c) => { const m = new Map(); for (const n of c.nets) for (const x of n.nodes) m.set(x.ref + "." + x.pin, new Set(n.nodes.map((y) => y.ref + "." + y.pin))); return m; };
  const ma = mates(A), mb = mates(B), seen = new Set();
  for (const pin of new Set([...ma.keys(), ...mb.keys()])) {
    const ref = pin.split(".")[0]; if (!ca[ref] || !cb[ref]) continue; const sa = ma.get(pin) || new Set([pin]), sb = mb.get(pin) || new Set([pin]); const both = (x) => ca[x.split(".")[0]] && cb[x.split(".")[0]];
    const onlyA = [...sa].filter((x) => !sb.has(x) && both(x)), onlyB = [...sb].filter((x) => !sa.has(x) && both(x)); if (!onlyA.length && !onlyB.length) continue;
    const key = [...new Set([...sa, ...sb])].sort().join(","); if (seen.has(key)) continue; seen.add(key);
    out.push(pin + ": one read connects it to " + (onlyA.join(", ") || "nothing more") + ", the other to " + (onlyB.join(", ") || "nothing more"));
  }
  return out;
}
const DRIVES = new Set(["output", "power_out"]);
function pinChecks(circuit) {
  const out = []; const netOf = new Map(); for (const n of circuit.nets) for (const x of n.nodes) netOf.set(x.ref + "\u0000" + x.pin, n); const nc = new Set((circuit.no_connects || []).map((x) => x.ref + "\u0000" + x.pin)); const drivers = new Map();
  for (const c of circuit.components) { if (c.type !== "ic" || c.dnp) continue; for (const p of c.pins || []) { const key = c.ref + "\u0000" + p.number, n = netOf.get(key), label = c.ref + " pin " + p.number + (p.name ? " (" + p.name + ")" : "");
    if (p.etype === "power_in" && !n) out.push(label + " is a supply pin but " + (nc.has(key) ? "is marked not-connected" : "is not connected"));
    if (p.etype === "power_in" && n && n.kind === "signal" && n.nodes.length === 1) out.push(label + " is a supply pin on a net with nothing else on it");
    if (p.etype === "input" && n && n.nodes.length === 1 && n.port === "none") out.push(label + " is an input with nothing driving it");
    if (p.etype === "no_connect" && n && n.nodes.length > 1) out.push(label + " should be left open according to the pin table, but it is wired to " + n.name);
    if (n && DRIVES.has(p.etype)) { if (!drivers.has(n)) drivers.set(n, []); drivers.get(n).push(label); } } }
  for (const [n, list] of drivers) { if (list.length > 1) out.push("Outputs tied together on " + n.name + ": " + list.join(", ")); if (n.kind === "ground") out.push(list[0] + " is an output but sits on " + n.name); }
  return out;
}
root.DS2K_CMP = { diffReads, pinChecks };
})(typeof window !== "undefined" ? window : globalThis);

/* Debug: what could make a built board misbehave?  Turns a description ("VOUT is a square wave", "3V3 reads 2.1 V") into a
   measurable symptom, injects one plausible assembly / part fault at a time into the design, simulates each, and keeps the
   faults whose simulated waveform shows that symptom. */
(function (root) {
"use strict";
const P2 = root.DS2K_P2, OPT = root.DS2K_OPT, SIM = root.DS2K_SIM;
const UNIT = { resistor: "ohm", capacitor: "F", capacitor_polarized: "F", inductor: "H" };
const DIODE = new Set(["diode", "schottky_diode", "zener_diode", "led", "tvs_diode"]);
const TWO = new Set(["resistor", "capacitor", "capacitor_polarized", "inductor", "ferrite_bead", "fuse", "jumper", ...DIODE]);

/* ------------------------------------------------------------------ symptom */
const KINDS = [
  ["oscillating", /oscillat|square|ring|pulsing|pulses|toggl|switching|unstable|burst|hiccup|flicker|periodic|wave/i],
  ["zero", /\b(zero|nothing|dead|no output|no voltage|0 ?v|flat|missing|off)\b/i],
  ["low", /\b(low|drop|sag|below|less|under|weak|dim|only)\b/i],
  ["high", /\b(high|above|over|too much|more than|exceed|bright)\b/i],
  ["ripple", /ripple|nois|spik|jitter|hash|glitch/i],
  ["slow", /slow|sluggish|lag|takes long|rise time|soft/i],
];
function parseSymptom(text, nets) {
  const t = String(text || ""); let kind = "";
  for (const [k, rx] of KINDS) if (rx.test(t)) { kind = k; break; }
  const m = /(-?\d+(?:[.,]\d+)?)\s*(m?v)\b/i.exec(t); const measured = m ? parseFloat(m[1].replace(",", ".")) * (/^m/i.test(m[2]) ? 1e-3 : 1) : null;
  const f = /(\d+(?:\.\d+)?)\s*(k|m)?hz/i.exec(t); const freq = f ? parseFloat(f[1]) * ({ k: 1e3, m: 1e6 }[(f[2] || "").toLowerCase()] || 1) : null;
  let net = ""; const key = (x) => String(x).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(\d)V(\d)/, "$1V$2"); const words = t.toUpperCase().replace(/[.,;:]/g, " ").split(/\s+/).map((w) => w.replace(/[^A-Z0-9+]/g, ""));
  for (const n of nets) { if (/^(A|D|P)?GND$/i.test(n)) continue; const k = key(n); if (!k) continue; if (words.some((w) => w.replace(/[^A-Z0-9]/g, "") === k) && n.length >= net.length) net = n; }
  if (!kind && measured !== null) kind = "level";
  return { kind, measured, freq, net };
}

/* ------------------------------------------------------------------ waveform features */
function features(trace, t) {
  const n = trace.length; if (!n) return null; const from = Math.floor(n * 0.6); const tail = trace.slice(from); let mean = 0, lo = Infinity, hi = -Infinity;
  for (const v of tail) { mean += v; if (v < lo) lo = v; if (v > hi) hi = v; } mean /= tail.length;
  let cross = 0; for (let i = 1; i < tail.length; i++) if ((tail[i - 1] < mean) !== (tail[i] < mean) && Math.abs(tail[i] - tail[i - 1]) > 1e-4) cross++;
  const span = t[n - 1] - t[from]; const freq = span > 0 ? cross / 2 / span : 0;
  let t90 = null; const target = 0.9 * mean; if (Math.abs(mean) > 0.05) for (let i = 0; i < n; i++) if ((mean > 0 ? trace[i] >= target : trace[i] <= target)) { t90 = t[i]; break; }
  return { mean, pp: hi - lo, lo, hi, freq, t90 };
}
function score(kind, symptom, F, B) {
  if (!F) return 0; const am = Math.abs(B.mean), ripB = Math.max(B.pp, 0.02 * am, 0.02);
  if (kind === "oscillating") { const swing = F.pp > Math.max(0.25 * am, 0.15) && F.pp > 3 * ripB; if (!swing) return 0; let s = 0.6 + Math.min(0.3, F.pp / (am + 0.5) * 0.3); if (symptom.freq && F.freq) s += 0.1 * Math.max(0, 1 - Math.abs(Math.log10(F.freq / symptom.freq))); else if (F.freq) s += 0.05; return Math.min(1, s); }
  if (kind === "zero") return Math.abs(F.mean) < Math.max(0.08 * am, 0.05) ? 0.95 : 0;
  if (kind === "low") { if (Math.abs(F.mean) < Math.max(0.08 * am, 0.05)) return 0.55; return Math.abs(F.mean) < 0.85 * am ? 0.9 - 0.2 * (F.pp > 3 * ripB ? 1 : 0) : 0; }
  if (kind === "high") return Math.abs(F.mean) > 1.15 * am + 0.05 ? 0.9 : 0;
  if (kind === "ripple") return F.pp > 2.5 * ripB && F.pp > 0.03 * am ? Math.min(0.9, 0.6 + F.pp / (am + 0.5)) : 0;
  if (kind === "slow") return F.t90 !== null && B.t90 !== null && F.t90 > 3 * B.t90 + 1e-6 ? 0.85 : 0;
  if (kind === "level") return 0;
  return 0;
}
function levelScore(F, measured, B) { if (!F || measured === null) return 0; const tol = 0.06 * Math.abs(B.mean) + 0.05; return Math.exp(-Math.abs(F.mean - measured) / tol); }

/* ------------------------------------------------------------------ faults */
function faults(circuit) {
  const out = []; const nets = circuit.nets; const isGnd = (n) => n.kind === "ground";
  const netsOf = (ref) => nets.filter((n) => n.nodes.some((x) => x.ref === ref));
  for (const c of circuit.components) {
    if (c.dnp) continue;
    if (UNIT[c.type]) { const v = P2.parseValue(c.value, UNIT[c.type]); if (v) { out.push({ id: c.ref + ":x10", ref: c.ref, kind: "value", factor: 10, text: c.ref + " is 10× too large (" + OPT.formatValue(v * 10, c.type) + " fitted instead of " + c.value + ")", check: "Read the marking on " + c.ref + " or measure it out of circuit" });
      out.push({ id: c.ref + ":d10", ref: c.ref, kind: "value", factor: 0.1, text: c.ref + " is 10× too small (" + OPT.formatValue(v / 10, c.type) + " fitted instead of " + c.value + ")", check: "Read the marking on " + c.ref + " or measure it out of circuit" }); } }
    if (TWO.has(c.type)) { out.push({ id: c.ref + ":open", ref: c.ref, kind: "open", text: c.ref + " (" + c.value + ") is missing or not soldered", check: "Look at " + c.ref + " under magnification; measure across it" });
      if (c.type.startsWith("capacitor") || DIODE.has(c.type)) out.push({ id: c.ref + ":short", ref: c.ref, kind: "short", text: c.ref + " (" + c.value + ") is shorted" + (c.type.startsWith("capacitor") ? " (cracked or solder bridge)" : ""), check: "Measure resistance across " + c.ref + " with power off" }); }
    if (DIODE.has(c.type)) out.push({ id: c.ref + ":rev", ref: c.ref, kind: "reverse", text: c.ref + " (" + c.value + ") is fitted backwards", check: "Check the cathode mark on " + c.ref + " against the footprint" });
    if (c.type === "capacitor_polarized") out.push({ id: c.ref + ":rev", ref: c.ref, kind: "reverse", text: c.ref + " (" + c.value + ") is fitted backwards", check: "Check the polarity stripe on " + c.ref });
    if (c.type === "ic") for (const p of c.pins || []) { if (p.etype === "no_connect") continue; const n = netsOf(c.ref).find((x) => x.nodes.some((y) => y.ref === c.ref && String(y.pin) === String(p.number))); if (!n) continue;
      out.push({ id: c.ref + ":open:" + p.number, ref: c.ref, pin: String(p.number), kind: "pinopen", text: c.ref + " pin " + p.number + (p.name ? " (" + p.name + ")" : "") + " is not soldered / lifted", check: "Probe pin " + p.number + " of " + c.ref + " directly against the net " + n.name });
      if (!isGnd(n) && n.kind !== "power") out.push({ id: c.ref + ":gnd:" + p.number, ref: c.ref, pin: String(p.number), kind: "pingnd", text: c.ref + " pin " + p.number + (p.name ? " (" + p.name + ")" : "") + " is shorted to ground (solder bridge)", check: "Measure pin " + p.number + " of " + c.ref + " to GND with power off" }); }
  }
  const gnd = nets.find(isGnd); if (gnd) for (const n of nets) if (!isGnd(n) && n.kind !== "power" && n.nodes.length >= 2 && !/^N\$/.test(n.name)) out.push({ id: "net:" + n.name, net: n.name, kind: "netgnd", text: "Net " + n.name + " is shorted to ground", check: "Measure " + n.name + " to GND with power off" });
  const pw = nets.filter((n) => n.kind === "power" && !isGnd(n)); for (let i = 0; i < pw.length; i++) for (let j = i + 1; j < pw.length; j++) out.push({ id: "bridge:" + pw[i].name + ":" + pw[j].name, a: pw[i].name, b: pw[j].name, kind: "bridge", text: pw[i].name + " and " + pw[j].name + " are bridged", check: "Measure between " + pw[i].name + " and " + pw[j].name + " with power off" });
  return out;
}
function apply(circuit, f) {
  const c = JSON.parse(JSON.stringify(circuit)); const comp = c.components.find((k) => k.ref === f.ref); const drop = (pred) => { for (const n of c.nets) n.nodes = n.nodes.filter((x) => !pred(x)); };
  if (f.kind === "value") comp.value = OPT.formatValue(P2.parseValue(comp.value, UNIT[comp.type]) * f.factor, comp.type);
  else if (f.kind === "open") { drop((x) => x.ref === f.ref); c.components = c.components.filter((k) => k !== comp); }
  else if (f.kind === "short") { comp.type = "resistor"; comp.value = "0.001"; for (const n of c.nets) for (const x of n.nodes) if (x.ref === f.ref) x.pin = x.pin === "+" || x.pin === "A" ? "1" : x.pin === "-" || x.pin === "K" ? "2" : x.pin; }
  else if (f.kind === "reverse") { const sw = comp.type === "capacitor_polarized" ? { "+": "-", "-": "+" } : { A: "K", K: "A" }; for (const n of c.nets) for (const x of n.nodes) if (x.ref === f.ref && sw[x.pin]) x.pin = sw[x.pin]; }
  else if (f.kind === "pinopen") drop((x) => x.ref === f.ref && String(x.pin) === f.pin);
  else if (f.kind === "pingnd") { drop((x) => x.ref === f.ref && String(x.pin) === f.pin); const g = c.nets.find((n) => n.kind === "ground"); if (g) g.nodes.push({ ref: f.ref, pin: f.pin }); }
  else if (f.kind === "netgnd") { const n = c.nets.find((x) => x.name === f.net), g = c.nets.find((x) => x.kind === "ground"); if (n && g) { g.nodes.push(...n.nodes); c.nets = c.nets.filter((x) => x !== n); } }
  else if (f.kind === "bridge") { const a = c.nets.find((x) => x.name === f.a), b = c.nets.find((x) => x.name === f.b); if (a && b) { a.nodes.push(...b.nodes); c.nets = c.nets.filter((x) => x !== b); } }
  c.nets = c.nets.filter((n) => n.nodes.length); return c;
}

/* ------------------------------------------------------------------ the search (async, in slices so the page stays alive) */
function probeSim(sim, net) { const s = JSON.parse(JSON.stringify(sim || {})); s.probes = [net]; return s; }
async function diagnose(circuit, sim, vals, alias, symptom, opts) {
  opts = opts || {}; const maxSteps = opts.maxSteps || 3000; const net = symptom.net; if (!net) throw new Error("no net");
  const runOne = (circ) => { const r = SIM.run(circ, probeSim(sim, net), vals, alias, { maxSteps }); if (!r.ok || !r.traces.length) return null; return features(r.traces[0].v, r.t); };
  const B = runOne(circuit); if (!B) throw new Error("The healthy design does not simulate - fix the simulation section first.");
  let fine = B; try { const r = SIM.run(circuit, probeSim(sim, net), vals, alias, { maxSteps: 20000 }); if (r.ok && r.traces.length) fine = features(r.traces[0].v, r.t); } catch (e) { /* keep the coarse one */ }
  const list = faults(circuit); const hits = []; const t0 = Date.now(); let done = 0;
  for (const f of list) {
    let F = null; try { F = runOne(apply(circuit, f)); } catch (e) { F = null; }
    let s = symptom.kind === "level" || (symptom.measured !== null && symptom.kind !== "oscillating") ? Math.max(levelScore(F, symptom.measured, B), symptom.kind === "level" ? 0 : score(symptom.kind, symptom, F, B) * 0.7) : score(symptom.kind, symptom, F, B);
    if (s >= 0.5) hits.push(Object.assign({ score: s, sim: F }, f));
    done++; if (opts.onProgress) opts.onProgress(done, list.length); if (done % 6 === 0) await new Promise((r) => setTimeout(r, 0));
    if (opts.signal && opts.signal.aborted) break;
  }
  hits.sort((a, b) => b.score - a.score);
  return { baseline: fine, hits, tried: done, ms: Date.now() - t0 };
}
function describe(F) { if (!F) return "no solution"; const osc = F.pp > 0.5 * Math.max(Math.abs(F.mean), 0.5); const fq = F.freq ? " at about " + (F.freq >= 1000 ? (F.freq / 1000).toFixed(1) + " kHz" : Math.round(F.freq) + " Hz") : ""; return osc ? "swings " + F.lo.toFixed(2) + " to " + F.hi.toFixed(2) + " V" + fq : "settles at " + F.mean.toFixed(2) + " V" + (F.pp > 0.08 * Math.abs(F.mean) && F.pp > 0.05 ? " with " + F.pp.toFixed(2) + " V ripple" : ""); }
root.DS2K_DBG = { parseSymptom, features, faults, apply, diagnose, describe, score };
})(typeof window !== "undefined" ? window : globalThis);

/* Falstad CircuitJS export.  Every part is placed on a grid and each of its pins ends in a "labeled node" carrying the net name -
   CircuitJS joins equally named labels, so no wiring has to be routed.  Chips are the same stand-ins the page simulates with. */
(function (root) {
"use strict";
const SIM = root.DS2K_SIM;
const num = (x) => { const s = Number(x).toPrecision(6); return String(parseFloat(s)); };
const label = (s) => String(s).replace(/[^A-Za-z0-9_+\-]/g, "_");

function exportFalstad(circuit, sim, vals, alias, title) {
  const E = SIM.elements(circuit, sim, vals, alias); const lines = [], notes = E.notes.slice(); let n = 0;
  let states = {}; if (E.els.some((e) => e.t === "SWR")) { try { const r = SIM.run(circuit, sim, vals, alias, { maxSteps: 4000 }); if (r.ok) states = r.states || {}; } catch (e) { /* open loop then */ } }
  const railOf = {}; for (const e of E.els) if (e.t === "V" && e.b === "0" && e.w.kind === "dc") railOf[e.a] = e.w.value;
  const cell = () => { const col = n % 4, row = Math.floor(n / 4); n++; return [80 + col * 192, 64 + row * 96]; };
  const pin = (name, x, y, dir) => { if (name === "0") lines.push("g " + x + " " + y + " " + x + " " + (y + 24) + " 0 0"); else lines.push("207 " + x + " " + y + " " + (dir === "l" ? x - 32 : dir === "r" ? x + 32 : x) + " " + (dir === "u" ? y - 32 : dir === "d" ? y + 32 : y) + " 0 " + label(name)); };
  const two = (type, e, a, b, tail) => { const [x, y] = cell(); lines.push(type + " " + x + " " + y + " " + (x + 64) + " " + y + " " + tail); pin(a, x, y, "l"); pin(b, x + 64, y, "r"); };
  const wave = (w, x, y) => { const f = w.kind === "pulse" ? [2, w.freq, (w.high - w.low) / 2, (w.high + w.low) / 2, 0, w.duty] : w.kind === "sine" ? [1, w.freq, w.ampl, w.offset, 0, 0.5] : [0, 40, w.value, 0, 0, 0.5]; return f.map(num).join(" "); };
  for (const e of E.els) {
    if (e.t === "R") two("r", e, e.a, e.b, "0 " + num(e.v));
    else if (e.t === "C") two("c", e, e.a, e.b, "0 " + num(e.v) + " 0");
    else if (e.t === "L") two("l", e, e.a, e.b, "0 " + num(e.v) + " 0");
    else if (e.t === "D") { two("d", e, e.a, e.b, "1 default"); if (e.model === "DZ") notes.push(e.name + " is exported as a plain diode (no zener)"); }
    else if (e.t === "Q") { const [x, y] = cell(); const s = e.pnp ? -1 : 1; lines.push("t " + x + " " + y + " " + (x + 32) + " " + y + " 0 " + s + " 0 0 100"); pin(e.b, x, y, "l"); pin(e.c, x + 32, y - 16 * s, "r"); pin(e.e, x + 32, y + 16 * s, "r"); }
    else if (e.t === "M") { const [x, y] = cell(); lines.push("f " + x + " " + y + " " + (x + 32) + " " + y + " " + (e.pch ? 1 : 0) + " 1.5 0.02"); pin(e.g, x, y, "l"); pin(e.d, x + 32, y - 16, "r"); pin(e.s, x + 32, y + 16, "r"); }
    else if (e.t === "V") { if (e.b === "0") { const [x, y] = cell(); lines.push("R " + x + " " + y + " " + (x - 32) + " " + y + " 0 " + wave(e.w)); pin(e.a, x, y, "r"); if (e.rs > 0) notes.push(e.name + ": the source resistance (" + e.rs + " ohm) is left out"); } else { two("v", e, e.b, e.a, "0 " + wave(e.w)); } }
    else if (e.t === "REG") { const [x, y] = cell(); lines.push("R " + x + " " + y + " " + (x - 32) + " " + y + " 0 0 40 " + num(e.vout) + " 0 0 0.5"); pin(e.out, x, y, "r"); notes.push(e.name + " (regulator) is a fixed " + e.vout + " V source in Falstad - no dropout or current limit"); }
    else if (e.t === "SWR") { const [x, y] = cell(); const D = states[e.name] && states[e.name].duty > 0.01 ? states[e.name].duty : 0.3; const vin = railOf[e.in] !== undefined ? railOf[e.in] : 12; lines.push("R " + x + " " + y + " " + (x - 32) + " " + y + " 0 2 " + num(e.freq) + " " + num((vin + 0.3) / 2) + " " + num((vin - 0.3) / 2) + " 0 " + num(D)); pin(e.sw, x, y, "r"); notes.push(e.name + ": Falstad gets a fixed " + Math.round(D * 100) + " % square wave on the switch node (the loop is closed only here and in ngspice)"); }
    else if (e.t === "T555") { notes.push(e.name + " (555) is not exported - add Falstad's own 555 timer to the labels " + [e.trig, e.thr, e.out, e.dis].filter(Boolean).join(", ")); }
    else if (e.t === "OPA") { const [x, y] = cell(); const hi = e.vp && railOf[e.vp] !== undefined ? railOf[e.vp] : 5, lo = e.vn && e.vn !== "0" && railOf[e.vn] !== undefined ? railOf[e.vn] : 0; lines.push("a " + x + " " + y + " " + (x + 64) + " " + y + " 2 " + num(hi) + " " + num(lo) + " 1000000"); pin(e.n, x, y - 8, "l"); pin(e.p, x, y + 8, "l"); pin(e.out, x + 64, y, "r"); }
  }
  if (!lines.length) throw new Error("There is nothing to export.");
  const dt = E.fmax ? Math.min(5e-6, 1 / E.fmax / 40) : 5e-6;
  const head = "$ 1 " + num(dt) + " 10.20027730826997 50 5 43 5e-11";
  return { text: [head].concat(lines).join("\n") + "\n", notes, count: n, title: title || "circuit" };
}
function falstadUrl(text) { return "https://www.falstad.com/circuit/circuitjs.html?cct=" + encodeURIComponent(text); }
root.DS2K_FALSTAD = { exportFalstad, falstadUrl };
})(typeof window !== "undefined" ? window : globalThis);

/* minimal ZIP writer (stored, no compression) - enough for a handful of small text files */
(function (root) {
"use strict";
let TABLE = null;
function crc32(bytes) {
  if (!TABLE) { TABLE = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); TABLE[n] = c >>> 0; } }
  let crc = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(files, folder) {
  const enc = new TextEncoder(); const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const chunks = [], central = []; let offset = 0;
  for (const name of Object.keys(files)) {
    const nameBytes = enc.encode((folder ? folder + "/" : "") + name); const data = typeof files[name] === "string" ? enc.encode(files[name]) : files[name]; const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30)); local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    const cen = new DataView(new ArrayBuffer(46)); cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, nameBytes.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes); offset += 30 + nameBytes.length + data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0); const end = new DataView(new ArrayBuffer(22)); const count = Object.keys(files).length;
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true); end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  const all = chunks.concat(central, [new Uint8Array(end.buffer)]); const total = all.reduce((s, c) => s + c.length, 0); const out = new Uint8Array(total); let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}
root.DS2K_ZIP = { makeZip, crc32 };
if (typeof module !== "undefined" && module.exports) module.exports = root.DS2K_ZIP;
})(typeof window !== "undefined" ? window : globalThis);

window.DS2K_EXAMPLE = {"part":{"mpn":"TPS54331","manufacturer":"Texas Instruments","description":"3.5-V to 28-V input, 3-A step-down converter","package":"SOIC-8","datasheet_url":"https://www.ti.com/lit/ds/symlink/tps54331.pdf"},"design":{"title":"TPS54331 3.3 V / 3 A buck converter","page":17,"description":"Typical application: 7 V to 28 V input, 3.3 V output at up to 3 A, 570 kHz."},"components":[{"ref":"U1","type":"ic","value":"TPS54331","mpn":"TPS54331DR","manufacturer":"Texas Instruments","description":"3A 28V step-down converter","package":"SOIC-8","rating":"","tolerance":"","dnp":false,"pins":[{"number":"1","name":"BOOT","etype":"passive","side":"right"},{"number":"2","name":"VIN","etype":"power_in","side":"left"},{"number":"3","name":"EN","etype":"input","side":"left"},{"number":"4","name":"SS","etype":"passive","side":"left"},{"number":"5","name":"VSENSE","etype":"input","side":"right"},{"number":"6","name":"COMP","etype":"passive","side":"left"},{"number":"7","name":"GND","etype":"power_in","side":"bottom"},{"number":"8","name":"PH","etype":"output","side":"right"}]},{"ref":"C1","type":"capacitor","value":"4.7uF","mpn":"","manufacturer":"","description":"","package":"1206","rating":"50V X7R","tolerance":"","dnp":false,"pins":[]},{"ref":"C2","type":"capacitor","value":"4.7uF","mpn":"","manufacturer":"","description":"","package":"1206","rating":"50V X7R","tolerance":"","dnp":false,"pins":[]},{"ref":"C3","type":"capacitor","value":"0.01uF","mpn":"","manufacturer":"","description":"","package":"","rating":"50V","tolerance":"","dnp":false,"pins":[]},{"ref":"C4","type":"capacitor","value":"0.1uF","mpn":"","manufacturer":"","description":"","package":"","rating":"25V","tolerance":"","dnp":false,"pins":[]},{"ref":"C5","type":"capacitor","value":"0.015uF","mpn":"","manufacturer":"","description":"","package":"","rating":"","tolerance":"","dnp":false,"pins":[]},{"ref":"C6","type":"capacitor","value":"1000pF","mpn":"","manufacturer":"","description":"","package":"","rating":"","tolerance":"","dnp":false,"pins":[]},{"ref":"C7","type":"capacitor","value":"47pF","mpn":"","manufacturer":"","description":"","package":"","rating":"","tolerance":"","dnp":false,"pins":[]},{"ref":"C8","type":"capacitor","value":"47uF","mpn":"","manufacturer":"","description":"","package":"1210","rating":"10V X5R","tolerance":"","dnp":false,"pins":[]},{"ref":"C9","type":"capacitor","value":"47uF","mpn":"","manufacturer":"","description":"","package":"1210","rating":"10V X5R","tolerance":"","dnp":false,"pins":[]},{"ref":"R1","type":"resistor","value":"332k","mpn":"","manufacturer":"","description":"","package":"","rating":"","tolerance":"1%","dnp":false,"pins":[]},{"ref":"R2","type":"resistor","value":"68.1k","mpn":"","manufacturer":"","description":"","package":"","rating":"","tolerance":"1%","dnp":false,"pins":[]},{"ref":"R3","type":"resistor","value":"29.4k","mpn":"","manufacturer":"","description":"","package":"","rating":"","tolerance":"1%","dnp":false,"pins":[]},{"ref":"R5","type":"resistor","value":"10.2k","mpn":"","manufacturer":"","description":"","package":"","rating":"","tolerance":"1%","dnp":false,"pins":[]},{"ref":"R6","type":"resistor","value":"3.24k","mpn":"","manufacturer":"","description":"","package":"","rating":"","tolerance":"1%","dnp":false,"pins":[]},{"ref":"L1","type":"inductor","value":"6.8uH","mpn":"","manufacturer":"","description":"","package":"","rating":"4.5A","tolerance":"","dnp":false,"pins":[]},{"ref":"D1","type":"schottky_diode","value":"B340A","mpn":"B340A-13-F","manufacturer":"","description":"","package":"SMA","rating":"40V 3A","tolerance":"","dnp":false,"pins":[]}],"nets":[{"name":"VIN","kind":"power","port":"input","nodes":[{"ref":"U1","pin":"2"},{"ref":"C1","pin":"1"},{"ref":"C2","pin":"1"},{"ref":"C3","pin":"1"},{"ref":"R1","pin":"1"}]},{"name":"GND","kind":"ground","port":"none","nodes":[{"ref":"U1","pin":"7"},{"ref":"C1","pin":"2"},{"ref":"C2","pin":"2"},{"ref":"C3","pin":"2"},{"ref":"R2","pin":"2"},{"ref":"C5","pin":"2"},{"ref":"C6","pin":"2"},{"ref":"C7","pin":"2"},{"ref":"D1","pin":"A"},{"ref":"C8","pin":"2"},{"ref":"C9","pin":"2"},{"ref":"R6","pin":"2"}]},{"name":"EN","kind":"signal","port":"none","nodes":[{"ref":"U1","pin":"3"},{"ref":"R1","pin":"2"},{"ref":"R2","pin":"1"}]},{"name":"SS","kind":"signal","port":"none","nodes":[{"ref":"U1","pin":"4"},{"ref":"C5","pin":"1"}]},{"name":"BOOT","kind":"signal","port":"none","nodes":[{"ref":"U1","pin":"1"},{"ref":"C4","pin":"1"}]},{"name":"PH","kind":"signal","port":"none","nodes":[{"ref":"U1","pin":"8"},{"ref":"C4","pin":"2"},{"ref":"D1","pin":"K"},{"ref":"L1","pin":"1"}]},{"name":"VOUT","kind":"power","port":"output","nodes":[{"ref":"L1","pin":"2"},{"ref":"C8","pin":"1"},{"ref":"C9","pin":"1"},{"ref":"R5","pin":"1"}]},{"name":"VSENSE","kind":"signal","port":"none","nodes":[{"ref":"U1","pin":"5"},{"ref":"R5","pin":"2"},{"ref":"R6","pin":"1"}]},{"name":"COMP","kind":"signal","port":"none","nodes":[{"ref":"U1","pin":"6"},{"ref":"R3","pin":"1"},{"ref":"C7","pin":"1"}]},{"name":"","kind":"signal","port":"none","nodes":[{"ref":"R3","pin":"2"},{"ref":"C6","pin":"1"}]}],"no_connects":[],"notes":["VOUT = 0.8 V x (1 + R5/R6)","UVLO set by R1/R2: start 6.6 V, stop 5.5 V","Soft-start time set by C5"],"warnings":[],"confidence":null,"options":[{"id":"vout","label":"Output voltage","type":"number","unit":"V","default":3.3,"min":0.8,"max":15,"step":0.1,"help":"Sets R5. The inductor and compensation stay as designed for 3.3 V.","actual":"0.8 * (1 + R5 / R6)"},{"id":"tss","label":"Soft-start time","type":"number","unit":"ms","default":6,"min":1,"max":50,"step":1,"help":"Sets C5.","actual":"C5 * 0.8 / 2u * 1000"},{"id":"uvlo","label":"Under-voltage lockout","type":"choice","default":"divider","choices":[{"id":"divider","label":"R1 / R2 divider"},{"id":"off","label":"Off (EN left open)"}],"help":"EN has an internal pull-up, so the converter also starts with the pin open."}],"rules":[{"when":"","ref":"R5","set":"value","to":"R6 * (vout / 0.8 - 1)","series":"E96"},{"when":"","ref":"C5","set":"value","to":"tss * 1m * 2u / 0.8","series":"E12"},{"when":"uvlo == 'off'","ref":"R1","set":"remove"},{"when":"uvlo == 'off'","ref":"R2","set":"remove"},{"when":"uvlo == 'off'","ref":"U1","pin":"3","set":"net","to":"''"}],"sim":{"sources":[{"net":"VIN","kind":"dc","value":12}],"standins":[],"chips":[{"ref":"U1","model":"switcher","in":"2","sw":"8","fb":"5","gnd":"7","en":"3","ss":"4","vref":0.8,"freq":570000,"note":"buck controller: PH switches VIN, VSENSE regulated to 0.8 V, SS charged with 2 uA"}],"loads":[{"net":"VOUT","value":"vout / 1","note":"1 A load"}],"probes":["VOUT","SS"],"tstop":0.012}};
/* Datasheet to KiCad - page logic.  Works in two places:
   - as a published Claude artifact (asks Claude through the host, saves through the host)
   - as a plain local .html file (asks Claude with the user's own API key, saves as a normal download) */
(function () {
"use strict";
const $ = (s, r) => (r || document).querySelector(s);
const el = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), guard(v)); else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? "" : v); } for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(k)); return e; };
function guard(fn) { return function (ev) { try { const r = fn.call(this, ev); if (r && r.catch) r.catch(showError); } catch (e) { showError(e); } }; }
function showError(e) { const box = $("#errbox"); if (!box) return; box.hidden = false; box.textContent = "Something went wrong: " + ((e && (e.message || e.code)) || e) + ""; }
const DS2K = window.DS2K, OPT = window.DS2K_OPT, SIM = window.DS2K_SIM, CMP = window.DS2K_CMP, DBG = window.DS2K_DBG, FAL = window.DS2K_FALSTAD;
const IN_HOST = !!(window.claude && window.claude.use);
const store = { get(k) { try { return localStorage.getItem("ds2k." + k) || ""; } catch (e) { return ""; } }, set(k, v) { try { localStorage.setItem("ds2k." + k, v); } catch (e) { /* private window */ } } };
const state = { sample: null, downloads: null, imageLimits: null, capsReady: !IN_HOST, pdf: null, pdfName: "", pages: [], figurePage: 1, crop: [0, 0, 1, 1], library: [], currentId: null, picked: new Set(), base: null, alias: {}, chosen: {}, applied: null, circuit: null, isExample: true, result: null, figureCanvas: null, busy: null, sentImages: [], sentLayout: "whole", reviewChanges: [] };

/* ------------------------------------------------------------------ what is available here */
const hasKey = () => !IN_HOST && !!store.get("key");
const canAsk = () => !!state.sample || hasKey();
const canImages = () => (state.sample ? !!state.imageLimits : hasKey());
const maxImages = () => (state.sample ? ((state.imageLimits || {}).maxCount || 0) : 5);
async function initCapabilities() {
  if (IN_HOST) {
    try { state.sample = await window.claude.use("sample"); } catch (e) { state.sample = null; }
    try { state.downloads = await window.claude.use("downloads"); } catch (e) { state.downloads = null; }
    if (state.sample) { try { const lim = await state.sample.limits(); state.imageLimits = lim && lim.images ? lim.images : null; } catch (e) { state.imageLimits = null; } }
    state.capsReady = true;
  }
  renderDiag(); if (state.pdf) renderDatasheet(); renderResult(); renderParts(); renderDebug();
}
function renderDiag() {
  const d = $("#diag"); if (!d) return; d.innerHTML = ""; const bad = (text) => d.append(el("span", { class: "tag bad" }, text));
  if (state.pdfReady && !window.pdfjsLib) bad("The PDF reader could not start in this browser");
  if (IN_HOST && state.capsReady) { if (!state.sample) bad("Reading is not available in this view"); if (!state.downloads) bad("Saving files is not available here"); }
  const keyui = $("#keyui"); if (keyui) { keyui.hidden = IN_HOST; if (!IN_HOST && !keyui.dataset.init) { keyui.dataset.init = "1"; keyui.open = !hasKey(); } }
}

/* ------------------------------------------------------------------ page scoring (which pages matter) */
const APP_TERMS = [[/typical\s+application\s+(circuit|schematic|diagram)/, 12], [/typical\s+applications?/, 9], [/application\s+(circuit|schematic|diagram)s?/, 9], [/reference\s+design/, 8], [/simplified\s+schematic/, 8], [/simplified\s+application/, 8], [/typical\s+(operating|connection)\s+circuit/, 10], [/typical\s+circuit/, 8], [/test\s+circuit/, 3], [/design\s+example/, 6], [/detailed\s+design\s+procedure/, 6], [/design\s+requirements/, 5], [/application\s+information/, 5], [/evaluation\s+(board|module|kit)/, 4], [/bill\s+of\s+materials/, 6], [/component\s+selection/, 4], [/recommended\s+components?/, 4], [/external\s+components?/, 4], [/schematic/, 3]];
const PIN_TERMS = [[/pin\s+configuration/, 10], [/pin\s+functions?/, 10], [/pin\s+descriptions?/, 10], [/pin\s+assignments?/, 8], [/terminal\s+functions?/, 9], [/pin\s+definitions?/, 8], [/pinout/, 7], [/top\s+view/, 5], [/pin\s+no\.?/, 3], [/pin\s+name/, 3]];
function scorePage(text) {
  const low = text.toLowerCase(); let app = 0, pin = 0;
  for (const [rx, w] of APP_TERMS) if (rx.test(low)) app += w; for (const [rx, w] of PIN_TERMS) if (rx.test(low)) pin += w;
  const toc = (low.match(/\. \. \.|\.\.\.\./g) || []).length; if (toc > 8) { app *= 0.2; pin *= 0.2; }
  const des = new Set(text.match(/\b(?:R|C|L|D|Q|U|RT|CIN|COUT|CBOOT|RFB|CSS|CFF)\d{0,2}[A-Z]?\b/g) || []).size; if (des >= 5) app += Math.min(10, des);
  if (/figure\s+\d+[-.]?\d*\.?\s*[^\n]{0,60}(application|schematic|circuit)/.test(low)) app += 6;
  return { app, pin };
}

/* ------------------------------------------------------------------ PDF loading */
async function openPdf(file) {
  if (!file) return;
  if (!window.pdfjsLib) { toast("The PDF reader could not start in this browser. Use manual mode below, or open the page in a current Chrome, Edge, Safari or Firefox.", 9000); return; }
  if (!/\.pdf$/i.test(file.name || "") && file.type !== "application/pdf") { toast("That is not a PDF file."); return; }
  setStatus("s1status", "Opening " + file.name + "…", true);
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await window.pdfjsLib.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false }).promise;
    state.pdf = pdf; state.pdfName = file.name || "datasheet.pdf"; state.pages = []; state.crop = [0, 0, 1, 1];
    const n = pdf.numPages;
    for (let i = 1; i <= n; i++) {
      let text = "";
      try { const page = await pdf.getPage(i); const tc = await page.getTextContent(); let lastY = null; for (const it of tc.items) { const y = it.transform ? Math.round(it.transform[5]) : null; text += (lastY !== null && y !== null && Math.abs(y - lastY) > 2 ? "\n" : " ") + (it.str || ""); lastY = y; } page.cleanup(); } catch (e) { text = ""; }
      state.pages.push(Object.assign({ n: i, text: text.trim() }, scorePage(text)));
      if (i % 8 === 0 || i === n) { setStatus("s1status", "Reading page text " + i + " / " + n + "…", true); await new Promise((r) => setTimeout(r)); }
    }
    const byApp = state.pages.slice().sort((a, b) => b.app - a.app); state.figurePage = byApp[0] && byApp[0].app >= 6 ? byApp[0].n : 1;
    state.textPagesValue = defaultTextPages().join(", ");
    setStatus("s1status", ""); renderDatasheet(); $("#pdfui").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) { setStatus("s1status", ""); toast("This PDF could not be opened: " + ((e && e.message) || e), 9000); }
}
function defaultTextPages() {
  const n = state.pdf.numPages; const s = new Set([state.figurePage]);
  for (const p of state.pages.slice().sort((a, b) => b.pin - a.pin).slice(0, 3)) if (p.pin >= 8) { s.add(p.n); if (p.n < n) s.add(p.n + 1); }
  for (const d of [1, -1]) { const q = state.figurePage + d; if (q >= 1 && q <= n && state.pages[q - 1].app >= 5) s.add(q); }
  return [...s].sort((a, b) => a - b);
}
async function renderPageTo(canvas, n, targetWidth) {
  const page = await state.pdf.getPage(n); const base = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: targetWidth / base.width });
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise; return canvas;
}

/* ------------------------------------------------------------------ step 1 UI */
function setFigurePage(pn) { const tp = $("#textpages"); if (tp) state.textPagesValue = tp.value; const cur = parsePages(state.textPagesValue, state.pdf.numPages); if (!cur.includes(pn)) { cur.push(pn); cur.sort((a, b) => a - b); state.textPagesValue = cur.join(", "); } state.figurePage = pn; state.crop = [0, 0, 1, 1]; const h = $("#hint"); state.hintValue = h ? h.value : ""; renderDatasheet(); }
function renderDatasheet() {
  const box = $("#pdfui"); const keepHint = ($("#hint") || {}).value; const keepPages = ($("#textpages") || {}).value; box.innerHTML = ""; if (!state.pdf) { box.hidden = true; return; } box.hidden = false;
  if (keepHint !== undefined) state.hintValue = keepHint; if (keepPages !== undefined) state.textPagesValue = keepPages;
  const n = state.pdf.numPages;
  const cand = [...new Set([state.figurePage, ...state.pages.filter((p) => p.app >= 6 || p.pin >= 8).sort((a, b) => (b.app + b.pin) - (a.app + a.pin)).slice(0, 13).map((p) => p.n), 1])].sort((a, b) => a - b);
  box.append(el("p", { class: "small" }, "Pick the page, drag a box around the circuit."));
  const strip = el("div", { class: "strip" });
  for (const pn of cand) {
    const p = state.pages[pn - 1]; const c = el("canvas", { class: "thumbc" });
    strip.append(el("button", { class: "thumb" + (pn === state.figurePage ? " on" : ""), type: "button", "aria-pressed": pn === state.figurePage ? "true" : "false", "aria-label": "Use page " + pn, onclick: () => setFigurePage(pn) }, c, el("span", { class: "pno" }, "p. " + pn), p.app >= 9 ? el("span", { class: "kind" }, "circuit") : p.pin >= 8 ? el("span", { class: "kind pins" }, "pins") : null));
    renderPageTo(c, pn, 220).catch(() => {});
  }
  box.append(strip);
  const go = el("input", { type: "number", id: "gopage", min: 1, max: n, value: state.figurePage });
  box.append(el("div", { class: "row" }, el("label", { for: "gopage" }, "Page"), go, el("button", { type: "button", onclick: () => setFigurePage(Math.max(1, Math.min(n, parseInt(go.value, 10) || 1))) }, "Show page"),
    el("button", { type: "button", class: "quiet", onclick: () => { state.crop = [0, 0, 1, 1]; drawCrop(); } }, "Clear box")));
  const big = el("canvas", { id: "bigpage" }); const sel = el("div", { id: "cropsel", hidden: true }); const wrap = el("div", { id: "cropwrap" }, big, sel); box.append(wrap);
  renderPageTo(big, state.figurePage, 1300).then(drawCrop).catch(showError);
  let start = null;
  const norm = (ev) => { const r = wrap.getBoundingClientRect(); return [Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))]; };
  wrap.addEventListener("pointerdown", (ev) => { start = norm(ev); try { wrap.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } ev.preventDefault(); });
  wrap.addEventListener("pointermove", (ev) => { if (!start) return; const q = norm(ev); state.crop = [Math.min(start[0], q[0]), Math.min(start[1], q[1]), Math.max(start[0], q[0]), Math.max(start[1], q[1])]; drawCrop(); });
  const finish = () => { if (!start) return; start = null; if (state.crop[2] - state.crop[0] < 0.05 || state.crop[3] - state.crop[1] < 0.05) state.crop = [0, 0, 1, 1]; drawCrop(); };
  wrap.addEventListener("pointerup", finish); wrap.addEventListener("pointercancel", finish);
  box.append(el("details", { class: "more" }, el("summary", {}, "More"), el("div", {},
    el("div", { class: "field" }, el("label", { for: "textpages" }, "Pages whose text is sent too (pin table, parts list)"), el("input", { type: "text", id: "textpages", value: state.textPagesValue || "" })),
    el("label", { class: "check" }, el("input", { type: "checkbox", id: "twice", checked: state.readTwice !== false, onchange: (ev) => { state.readTwice = ev.target.checked; renderDatasheet(); } }), " Read twice and cross-check (safer, takes 2-3× longer)"),
    el("div", { class: "field" }, el("label", { for: "hint" }, "Notes for the reader"), el("input", { type: "text", id: "hint", value: state.hintValue || "", placeholder: "e.g. use the 5 V / 2 A design example, SOT-23-6 package" })))));
  let note;
  if (!state.capsReady) note = "Getting ready…";
  else if (!canAsk()) note = IN_HOST ? "Reading is not available here - use Import below." : "Add your API key above first.";
  else if (!canImages()) note = "Images cannot be used here - only the page text is read, expect gaps.";
  else note = state.readTwice !== false ? "Reads the figure twice and cross-checks · 3-8 minutes" : "Takes 1-3 minutes";
  box.append(el("div", { class: "row" }, el("button", { type: "button", class: "primary big", id: "readbtn", disabled: !canAsk(), onclick: readCircuit }, "Read the circuit"), el("span", { class: "muted", id: "readnote" }, note)));
  box.append(el("div", { id: "readstatus", class: "status", role: "status", "aria-live": "polite" }));
}
function drawCrop() { const s = $("#cropsel"); if (!s) return; const [a, b, c, d] = state.crop; s.hidden = (a === 0 && b === 0 && c === 1 && d === 1); s.style.left = a * 100 + "%"; s.style.top = b * 100 + "%"; s.style.width = (c - a) * 100 + "%"; s.style.height = (d - b) * 100 + "%"; }
function parsePages(v, n) { const out = new Set(); for (const part of String(v || "").split(/[,\s]+/)) { const m = /^(\d+)-(\d+)$/.exec(part); if (m) { for (let i = +m[1]; i <= +m[2] && i <= n; i++) if (i >= 1) out.add(i); } else if (/^\d+$/.test(part) && +part >= 1 && +part <= n) out.add(+part); } return [...out].sort((a, b) => a - b); }

/* ------------------------------------------------------------------ images for Claude */
function cut(src, x, y, w, h, maxSide) { const k = Math.min(1, maxSide / Math.max(w, h)); const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k)); const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height); return c; }
const toBlob = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("image encoding failed"))), "image/png"));
async function figureImages() {
  const page = await state.pdf.getPage(state.figurePage); const base = page.getViewport({ scale: 1 }); const [a, b, c, d] = state.crop;
  const cropLong = Math.max((c - a) * base.width, (d - b) * base.height); let scale = Math.min(2800 / cropLong, 6000 / Math.max(base.width, base.height)); scale = Math.min(scale, Math.sqrt(24e6 / (base.width * base.height)));
  const bigc = document.createElement("canvas"); const vp = page.getViewport({ scale }); bigc.width = Math.round(vp.width); bigc.height = Math.round(vp.height); const ctx = bigc.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, bigc.width, bigc.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const X = a * bigc.width, Y = b * bigc.height, W = (c - a) * bigc.width, H = (d - b) * bigc.height; const max = maxImages(); const canv = [cut(bigc, X, Y, W, H, 1568)]; let layout = "whole"; const ov = 0.12;
  if (max >= 5) { layout = "quadrants"; const w2 = W * (0.5 + ov), h2 = H * (0.5 + ov); for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) canv.push(cut(bigc, X + qx * (W - w2), Y + qy * (H - h2), w2, h2, 1568)); }
  else if (max >= 3) { if (W >= H) { layout = "halves-lr"; const w2 = W * (0.5 + ov); canv.push(cut(bigc, X, Y, w2, H, 1568), cut(bigc, X + W - w2, Y, w2, H, 1568)); } else { layout = "halves-tb"; const h2 = H * (0.5 + ov); canv.push(cut(bigc, X, Y, W, h2, 1568), cut(bigc, X, Y + H - h2, W, h2, 1568)); } }
  state.figureCanvas = canv[0]; const blobs = []; for (const cv of canv) blobs.push(await toBlob(cv));
  return { blobs, layout };
}

/* ------------------------------------------------------------------ prompts */
const JSON_SHAPE = '{"part":{"mpn":"","manufacturer":"","description":"","package":""},"design":{"title":"","page":0,"figure":"","description":""},' +
  '"components":[{"ref":"U1","type":"ic","value":"","mpn":"","suggested_mpn":"","manufacturer":"","description":"","package":"","rating":"","tolerance":"","dnp":false,"at":[0.42,0.37],"pins":[{"number":"1","name":"VIN","etype":"power_in","side":"left"}]}],' +
  '"nets":[{"name":"VIN","kind":"power","port":"input","nodes":[{"ref":"U1","pin":"1"},{"ref":"C1","pin":"1"}]}],"no_connects":[{"ref":"U1","pin":"5"}],' +
  '"options":[{"id":"vout","label":"Output voltage","type":"number","unit":"V","default":3.3,"min":0.8,"max":12,"step":0.1,"help":"Sets R1","actual":"0.8*(1+R1/R2)"},{"id":"bus","label":"Interface","type":"choice","default":"i2c","choices":[{"id":"i2c","label":"I2C"},{"id":"spi","label":"SPI"}],"help":""}],' +
  '"rules":[{"when":"","ref":"R1","set":"value","to":"R2*(vout/0.8-1)","series":"E96"},{"when":"bus==\'spi\'","ref":"R3","set":"remove"},{"when":"bus==\'spi\'","ref":"U1","pin":"5","set":"net","to":"\'CS\'"}],' +
  '"sim":{"sources":[{"net":"VIN","kind":"dc","value":12}],"standins":[{"ref":"U1","pin":"6","kind":"pulse","low":0,"high":3.3,"freq":1000000,"duty":0.5,"note":"clock output"}],"chips":[{"ref":"U2","model":"regulator","in":"3","out":"2","gnd":"1","vout":3.3,"dropout":0.3}],"loads":[{"net":"VOUT","value":33,"note":"100 mA"}],"probes":["VOUT"],"tstop":0.01},' +
  '"layout":["Place C1 within 5 mm of pin 2"],"notes":[],"warnings":[],"confidence":0.9}';
const RULES = [
  "You are a senior electronics engineer transcribing a reference design from a component datasheet into an exact machine-readable netlist. Accuracy matters more than anything: one wrong connection gives a board that does not work. Follow every wire to its end; a junction dot means connected, wires that merely cross are NOT connected; cross-check pin numbers against the pin table text. Never invent connections - put anything you cannot read into `warnings`.",
  "RULES",
  "1. Components: every external component drawn in the figure, with the datasheet's own designators (R1, CIN, CBOOT...). No designators in the figure -> assign R1.., C1.. in reading order. Do not add parts that are not drawn unless the text says they are required (say so in `description`). Optional / do-not-populate parts: dnp=true.",
  "2. `type` is one of: " + DS2K.COMPONENT_TYPES.join(", ") + ". Anything with 3+ pins that is not a transistor or potentiometer is \"ic\" (regulators, op-amps, modules, MCUs), \"connector\" or \"other\". Electrolytic/tantalum capacitors are \"capacitor_polarized\".",
  "3. Pin ids used in nets[].nodes[].pin: resistor, capacitor, inductor, ferrite_bead, fuse, crystal, switch, jumper, thermistor: \"1\" and \"2\". capacitor_polarized: \"+\" and \"-\". All diodes and LEDs: \"A\" (anode) and \"K\" (cathode). bjt: \"B\",\"C\",\"E\". mosfet: \"G\",\"D\",\"S\". potentiometer: \"1\",\"W\",\"3\". ic / connector / other: the PACKAGE PIN NUMBER as a string (\"1\", \"14\", \"EP\") - never the pin name.",
  "4. Main IC: choose the package the figure shows, otherwise the first (most common) one; put it in `package` (e.g. \"SOIC-8\", \"SOT-23-5\", \"QFN-16 3x3mm\"). Fill `pins` with EVERY pin of that package from the pin table: number, name, etype (input, output, bidirectional, passive, power_in, power_out, open_collector, no_connect) and side = the side of the IC rectangle where the figure draws the pin (left/right/top/bottom, \"\" if not drawn). Include an exposed/thermal pad if the table lists one. Pins the datasheet says to leave open go into `no_connects`; every other pin must be in exactly one net. For all non-IC parts `pins` is [].",
  "5. Nets: one entry per electrical node listing ALL pins on it. Every pin of every two-pin part must be in a net; a pin may be in only one net. Name nets after the figure's labels or the IC pin (VIN, VOUT, SW, FB, EN...); use \"\" for unnamed internal nodes. Ground is \"GND\" (AGND/PGND only if the datasheet separates them). Use KiCad rail names (+5V, +3V3, +12V, VCC, VDD, VBUS) only when the datasheet fixes that rail, otherwise VIN / VOUT. kind: ground | power | signal. port: input/output/bidirectional for nets that leave the design (supply input, regulated output, enable/logic inputs, status outputs), else \"none\".",
  "6. Values: from the figure, BOM table or design-example text (\"10k\", \"4.7uF\", \"6.8uH\"); voltage/current/dielectric needs go in `rating` (\"25V X7R\", \"3A\"), tolerance in `tolerance`. If the datasheet only gives equations, compute values for its own example conditions using E96/E24 values and explain in `notes`. Unknown -> \"TBD\" plus a warning. For the main IC `value` is the base part number.",
  "7. `mpn`: only part numbers printed in the datasheet. `suggested_mpn`: for diodes, transistors, inductors, crystals without a printed part number, one widely stocked part meeting the ratings (else \"\"). `package` for passives only if the datasheet states it.",
  "8. `notes`: up to 8 short lines a user wants on the schematic (design equations, conditions). `confidence`: 0-1 that the netlist is exactly right.",
  "9. `options`: the choices this reference design leaves to the person building it, as far as the datasheet documents them - an adjustable output voltage, current limit, frequency, timing, gain or threshold that is set by component values (type \"number\", with unit, min, max, step), and alternatives such as I2C or SPI, address or mode pins, fixed-voltage variants of the part, optional features (type \"choice\" with `choices`). At most 6, the most useful first; [] when the design has none. Every `default` must describe the netlist exactly as you wrote it. `help`: a few words on what changes and what the user must re-check themselves. `actual` (number options, optional): expression giving the value really obtained with the fitted standard parts.",
  "10. `rules`: how the choices change the netlist; they are applied in order on top of the netlist. Each rule: `when` = condition (\"\" = always), `ref` = component, `set` = one of \"value\" (`to` = expression in ohm / farad / henry, rounded to `series` E96, E24, E12 or E6; or a quoted text), \"mpn\" (`to` = quoted part number), \"dnp\" (`to` = condition), \"remove\" (part not fitted at all), \"net\" (connect `pin` of `ref` to the net named by `to`; '' = leave open). Expressions may use: numbers (10k, 4.7u, 1e-6), option ids, component designators (= that part's value in ohm / F / H), + - * / ^ ( ), == != < > <= >=, && || !, c ? a : b, min max sqrt abs ln log10 exp round par; texts in single quotes. Take the formulas from the datasheet. With all defaults the rules must leave the netlist unchanged.",
  "11. `sim`: how to simulate the design although the chip has no simulation model - replace what the chip does by simple stand-ins, from the datasheet's typical values. `sources`: what the outside world applies (supply, input signals) per net: kind dc (value in V), pulse (low, high, freq in Hz, duty 0-1) or sine (offset, value = amplitude, freq). `standins`: per chip pin that DRIVES something: kind dc / pulse / sine as above (a regulator or reference output = dc, a clock or PWM or switch node = pulse, an analog output = dc or sine), kind load (value = ohm to ground, for an input that loads the circuit) or open. `chips`: instead of pin stand-ins a whole chip may be one of these behavioural models (all pins as package pin numbers): {model:\"regulator\", in, out, gnd, vout, dropout, ilim} for linear regulators; {model:\"opamp\", units:[{inp, inn, out}], vp, vn} for op-amps and comparators; {model:\"switcher\", in, sw, fb, gnd, en, ss, vref, freq} for buck (step-down) converters and controllers - a closed loop that regulates the fb pin to vref with the external inductor / diode / capacitors / divider from the netlist, ss = soft-start pin (2 uA source) and en = enable pin, both optional, vref and freq from the datasheet; {model:\"timer555\", vcc, gnd, trig, thr, dis, out, cont, reset} for 555 timers. Prefer a chip model over pin stand-ins whenever one fits. `switches`: [{ref, closed:true/false}] for switches and jumpers in the figure. Inputs that only sense need nothing. `loads`: a typical load per output net in ohm. `probes`: up to 4 nets worth plotting. `tstop`: seconds to simulate (long enough to settle, at least 20 periods of the slowest source). Numbers may be expressions of option ids (duty: \"vout/12\"). Discrete parts (R, C, L, diodes, transistors) are simulated as they are.",
  "12. `at` (every component): where its symbol is drawn in image 1, as [x, y] fractions of the image width and height (0-1, centre of the symbol); omit it for parts that are not drawn. `layout`: up to 8 short PCB layout rules the datasheet gives for this design (placement distances, short loops, ground / thermal pad advice, trace widths), in the datasheet's own numbers; [] if it gives none.",
  "Before answering verify: every component in the figure is listed once; every two-pin part has both pins in nets; no pin is in two nets; every IC pin is in a net or in no_connects; feedback / compensation / bootstrap / enable networks match the figure wire by wire; diode and polarised-capacitor orientation is right.",
].join("\n");
function imagesNote(layout, count) { if (!count) return "NO IMAGE could be attached in this view: reconstruct the reference design from the text alone as far as the text allows, list every assumption in `warnings`, and set `confidence` low."; return layout === "quadrants" ? "Image 1 is the whole figure. Images 2-5 are enlarged, overlapping quadrants of the same figure (top-left, top-right, bottom-left, bottom-right) - use them to read pin numbers, values and junction dots." : layout.startsWith("halves") ? "Image 1 is the whole figure. Images 2-3 are enlarged, overlapping halves of the same figure (" + (layout === "halves-lr" ? "left, right" : "top, bottom") + ")." : "The image is the figure."; }
function pageTextBlock(limit) {
  const n = state.pdf ? state.pdf.numPages : 0; const pages = parsePages(($("#textpages") || {}).value || state.textPagesValue || "", n); let total = 0; const parts = [];
  for (const pn of pages) { let t = state.pages[pn - 1].text.replace(/[ \t]+/g, " "); if (t.length > 7000) t = t.slice(0, 7000) + " …"; if (total + t.length > (limit || 36000)) break; total += t.length; parts.push("=== TEXT OF DATASHEET PAGE " + pn + " ===\n" + t); }
  return parts.join("\n\n");
}
function extractPrompt(layout, count) {
  const hint = (($("#hint") || {}).value || "").trim();
  return RULES + "\n\nTASK\nThe reference design is on page " + state.figurePage + " of the datasheet \"" + state.pdfName + "\". " + imagesNote(layout, count) + " Transcribe this reference design into a complete netlist.\n" +
    (hint ? "Additional instructions from the user: " + hint + "\n" : "") + "\nText extracted from the datasheet (pin tables, parts lists; layout is lost, numbers are exact):\n\n" + pageTextBlock() +
    "\n\nAnswer with ONE JSON object only, no prose and no code fence, exactly in this shape (the values shown are examples):\n" + JSON_SHAPE;
}
function reviewPrompt(layout, count, circuit, issues) {
  return RULES + "\n\nTASK\nYou are REVIEWING a netlist that was transcribed from the reference design on datasheet page " + state.figurePage + ". " + imagesNote(layout, count) +
    "\nAutomatic checks reported:\n" + (issues.length ? issues.map((i) => "- " + i).join("\n") : "- none") + "\n\nNetlist under review:\n" + JSON.stringify(circuit) +
    "\n\nGo through the figure component by component and wire by wire. Look for missing or extra components, a pin on the wrong net, swapped diode/capacitor polarity, wrong pin numbers, IC pins left out, wrong values, nets that should be merged or split.\n\nText extracted from the datasheet:\n\n" + pageTextBlock(20000) +
    "\n\nAnswer with ONE JSON object only: {\"changes\":[\"each correction you made\"],\"circuit\":<the COMPLETE corrected netlist in the same shape as the one under review, including `options` and `rules` (correct those too)>}";
}
function changePrompt(layout, count, circuit, wish) {
  return RULES + "\n\nTASK\nBelow is the netlist of a reference design" + (state.pdf && !state.isExample ? " transcribed from datasheet page " + state.figurePage + ". " + imagesNote(layout, count) : ".") +
    "\nThe user wants this change: " + wish + "\nApply it the way the datasheet describes (recalculate component values with the datasheet's formulas, add / remove / rewire parts as needed). Leave everything else exactly as it is, keep `options` and `rules` consistent with the changed netlist (defaults = the new netlist), and mention anything the user must re-check in `warnings`.\n\nNetlist:\n" + JSON.stringify(circuit) +
    (state.pdf && !state.isExample ? "\n\nText extracted from the datasheet:\n\n" + pageTextBlock(20000) : "") +
    "\n\nAnswer with ONE JSON object only: {\"changes\":[\"each change you made\"],\"circuit\":<the COMPLETE new netlist in the same shape>}";
}
function settlePrompt(layout, count, a, b, diffs) {
  return RULES + "\n\nTASK\nThe reference design on datasheet page " + state.figurePage + " was transcribed twice, independently, and the two netlists disagree. " + imagesNote(layout, count) + "\nDisagreements:\n" + diffs.map((d) => "- " + d).join("\n") +
    "\n\nFor each disagreement look at the figure again (and the pin table text) and decide which reading is right - or neither. Everything the two readings agree on stays as it is.\n\nReading A:\n" + JSON.stringify(a) + "\n\nReading B:\n" + JSON.stringify(b) + "\n\nText extracted from the datasheet:\n\n" + pageTextBlock(16000) +
    "\n\nAnswer with ONE JSON object only: {\"changes\":[\"for each disagreement: what is right and why\"],\"circuit\":<the COMPLETE final netlist in the same shape as reading A>}";
}
function manualPrompt() { return RULES + "\n\nTASK\nThe attached PDF is a component datasheet. Find its main typical application / reference design and transcribe it into a complete netlist, using the pin configuration table for pin numbers.\n\nAnswer with ONE JSON object only, no prose and no code fence, exactly in this shape (the values shown are examples):\n" + JSON_SHAPE; }

/* ------------------------------------------------------------------ asking Claude (host capability, or the user's own API key) */
const ERR_COPY = { not_granted: "Access was not allowed for this page. Reload and allow it.", sampling_disabled: "Reading is not available for this account here. Import below still works.", rate_limited: "Busy, or the usage limit was reached. Try again in a little while.", session_expired: "Your session expired - sign in again, then retry.", image_rejected: "The page image was rejected. Drag a smaller box around the circuit and try again.", images_unavailable: "This view cannot use images.", refused: "This page could not be processed.", invalid_json: "The reading failed. Try again - if it keeps failing, drag a tighter box around the circuit.", prompt_too_large: "Too much page text was selected. Remove some pages from the text list.", empty_completion: "Nothing came back. Try again.", upstream_error: "The connection failed. Try again.", bad_key: "The API key was rejected. Check that it was pasted completely.", network: "api.anthropic.com could not be reached from this page." };
function parseLoose(raw) { raw = String(raw || "").trim(); try { return JSON.parse(raw); } catch (e) { /* fall through */ } const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw); if (m) { try { return JSON.parse(m[1]); } catch (e) { /* fall through */ } } const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch (e) { /* fall through */ } } throw { code: "invalid_json" }; }
const b64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = () => rej(new Error("could not read image")); fr.readAsDataURL(blob); });
async function askWithKey(prompt, blobs, onText, signal) {
  const content = []; for (const b of blobs) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: await b64(b) } }); content.push({ type: "text", text: prompt });
  const base = { model: store.get("model") || "claude-opus-5", max_tokens: 32000, stream: true, messages: [{ role: "user", content }] };
  for (const extra of [{ thinking: { type: "adaptive" } }, {}]) {
    let res;
    try { res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal, headers: { "content-type": "application/json", "x-api-key": store.get("key"), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, body: JSON.stringify(Object.assign({}, base, extra)) }); }
    catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled" }; throw { code: "network", message: String(e && e.message) }; }
    if (res.status === 401 || res.status === 403) throw { code: "bad_key" }; if (res.status === 429 || res.status === 529) throw { code: "rate_limited" };
    if (res.status === 400 && extra.thinking) continue;
    if (!res.ok) { let msg = "HTTP " + res.status; try { msg = (await res.json()).error.message || msg; } catch (e) { /* ignore */ } throw { code: "upstream_error", message: msg }; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "", text = "";
    for (;;) { let chunk; try { chunk = await reader.read(); } catch (e) { throw { code: signal.aborted ? "cancelled" : "upstream_error" }; } if (chunk.done) break; buf += dec.decode(chunk.value, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line.startsWith("data:")) continue; let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; } if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") { text += ev.delta.text; onText({ text }); } else if (ev.type === "error") throw { code: "upstream_error", message: (ev.error || {}).message }; } }
    return parseLoose(text);
  }
  throw { code: "upstream_error" };
}
async function askClaude(prompt, blobs, statusId, label) {
  const ctl = new AbortController(); state.busy = ctl; const t0 = Date.now(); let chars = 0;
  const show = () => { const s = Math.round((Date.now() - t0) / 1000); setStatus(statusId, (chars ? label + " - writing the netlist (" + chars + " characters)" : label + " - analysing the figure") + " · " + s + " s", true, () => ctl.abort()); };
  show(); const tick = setInterval(show, 1000); const onText = ({ text }) => { chars = text.length; };
  try {
    if (state.sample) { const opts = { modelTier: "complex", cache: false, signal: ctl.signal, onText }; if (blobs.length) opts.images = blobs; return await state.sample.json(prompt, opts); }
    return await askWithKey(prompt, blobs, onText, ctl.signal);
  } finally { clearInterval(tick); state.busy = null; }
}
function explain(e, what) { if (e && e.code === "cancelled") return; toast(ERR_COPY[e && e.code] ? ERR_COPY[e.code] + (e.message && e.code === "upstream_error" ? " (" + e.message + ")" : "") : (what + " failed: " + ((e && (e.message || e.code)) || e)), 10000); }
async function readCircuit() {
  if (state.busy) return; const btn = $("#readbtn"); btn.disabled = true;
  try {
    let blobs = [], layout = "whole";
    if (canImages()) { setStatus("readstatus", "Rendering the figure at high resolution…", true); const r = await figureImages(); blobs = r.blobs; layout = r.layout; }
    state.sentImages = blobs; state.sentLayout = layout;
    let data;
    try { data = await askClaude(extractPrompt(layout, blobs.length), blobs, "readstatus", "Reading the circuit"); }
    catch (e) { if (!(e && (e.code === "images_unavailable") && blobs.length)) throw e; blobs = []; state.sentImages = []; state.imageLimits = null; renderDiag(); data = await askClaude(extractPrompt(layout, 0), [], "readstatus", "Reading the circuit from the page text only"); }
    if (!data || !Array.isArray(data.components) || !Array.isArray(data.nets)) throw { code: "invalid_json" };
    let disagreements = [];
    if (state.readTwice !== false) {
      try {
        const second = await askClaude(extractPrompt(layout, blobs.length) + "\n\n(Independent second reading - start again from the figure.)", blobs, "readstatus", "Reading it a second time to cross-check");
        if (second && Array.isArray(second.components) && Array.isArray(second.nets)) { disagreements = CMP.diffReads(data, second);
          if (disagreements.length) { const fixed = await askClaude(settlePrompt(layout, blobs.length, data, second, disagreements), blobs, "readstatus", "The two readings differ in " + disagreements.length + " place(s) - checking those against the figure"); if (fixed && fixed.circuit && Array.isArray(fixed.circuit.components) && Array.isArray(fixed.circuit.nets)) { data = fixed.circuit; state.pendingChanges = (fixed.changes || []).map(String); } } }
      } catch (e) { if (e && e.code === "cancelled") throw e; disagreements.push("The cross-check reading failed (" + ((e && (e.code || e.message)) || e) + ") - only one reading was used."); }
    }
    data.disagreements = disagreements;
    if (!data.design) data.design = {}; if (!data.design.page) data.design.page = state.figurePage;
    state.isExample = false; state.reviewChanges = state.pendingChanges || []; state.pendingChanges = null; setStatus("readstatus", ""); state.currentId = null; setBase(data); saveCurrent(true); goTab("step2");
  } catch (e) { setStatus("readstatus", ""); explain(e, "Reading"); }
  finally { btn.disabled = false; }
}
function bakedCircuit() { const ap = state.applied; const options = JSON.parse(JSON.stringify(state.base.options || [])); for (const o of options) { const id = String(o.id || ""); for (const k of Object.keys(ap.values)) if (k.toLowerCase() === id.replace(/[^A-Za-z0-9_]+/g, "_").toLowerCase()) o.default = ap.values[k]; } return Object.assign({}, state.circuit, { options, rules: state.base.rules || [], sim: state.base.sim || undefined }); }
async function reviseCircuit(statusId, label, makePrompt, doneText) {
  if (state.busy || !canAsk()) return; collectEdits(); rebuild();
  try {
    const imgs = state.isExample ? [] : state.sentImages; const issues = state.result ? state.result.errors.concat(state.result.warnings) : []; const before = bakedCircuit();
    const data = await askClaude(makePrompt(state.sentLayout, imgs.length, before, issues), imgs, statusId, label); setStatus(statusId, "");
    if (data && data.circuit && Array.isArray(data.circuit.components) && Array.isArray(data.circuit.nets)) { if (!Array.isArray(data.circuit.options)) { data.circuit.options = before.options; data.circuit.rules = before.rules; } if (!data.circuit.sim) data.circuit.sim = state.base.sim; if (!data.circuit.layout) data.circuit.layout = state.base.layout; data.circuit.marks = state.base.marks; if (!Array.isArray(data.circuit.blocks)) data.circuit.blocks = state.base.blocks; state.reviewChanges = (data.changes || []).map(String); state.isExample = false; setBase(data.circuit, true); toast(doneText(state.reviewChanges.length)); return true; }
    toast(ERR_COPY.invalid_json);
  } catch (e) { setStatus(statusId, ""); explain(e, label); }
  return false;
}
const reviewCircuit = () => reviseCircuit("reviewstatus", "Double-checking", reviewPrompt, (n) => (n ? n + " correction(s) applied." : "Nothing to correct."));
async function changeCircuit() { const inp = $("#wish"); const wish = ((inp || {}).value || "").trim(); if (!wish) { if (inp) inp.focus(); return; } const ok = await reviseCircuit("wishstatus", "Changing the design", (l, n, c) => changePrompt(l, n, c, wish), () => "Done - the schematic is updated."); if (!ok && $("#wish")) $("#wish").value = wish; }

/* ------------------------------------------------------------------ live LCSC lookup (only where the page has network access) */
async function findParts() {
  if (IN_HOST || state.busy) return; collectEdits(); rebuild(); const live = new Set(state.circuit.components.map((c) => c.ref)); const comps = state.base.components.filter((c) => live.has(c.ref)); for (const c of comps) { const d = state.circuit.components.find((x) => x.ref === c.ref); c._v = c.value; c.value = d.value; c._m = c.mpn; c.mpn = d.mpn; } let found = 0, tried = 0; const cache = new Map();
  const get = async (url) => { if (cache.has(url)) return cache.get(url); const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status); const j = await r.json(); cache.set(url, j); return j; };
  const rank = (a) => a.filter((o) => o.stock > 0).sort((x, y) => (y.is_basic ? 1 : 0) - (x.is_basic ? 1 : 0) || (y.is_preferred ? 1 : 0) - (x.is_preferred ? 1 : 0) || y.stock - x.stock);
  const close = (a, b) => Math.abs(a - b) <= 0.011 * Math.max(Math.abs(a), Math.abs(b));
  try {
    for (const c of comps) {
      if (c.dnp || c.lcsc) continue; let best = null; tried++; setStatus("srcstatus", "Looking up " + c.ref + " (" + tried + "/" + comps.length + ")…", true);
      const pkg = (/(0201|0402|0603|0805|1206|1210|2010|2512)/.exec(c.package || "") || [])[1];
      if (c.type === "resistor") { const v = DS2K.parseValue(c.value, "ohm"); if (v) { const j = await get("https://jlcsearch.tscircuit.com/resistors/list.json?resistance=" + v + "&package=" + (pkg || "0603")); best = (c._cands = rank((j.resistors || []).filter((o) => close(o.resistance, v) && (o.tolerance_fraction || 1) <= 0.011)))[0]; } }
      else if (c.type === "capacitor") { const v = DS2K.parseValue(c.value, "F"); const need = parseFloat((/(\d+(?:\.\d+)?)\s*V/.exec(c.rating || "") || [])[1]) || 0; if (v) for (const p of pkg ? [pkg] : ["0603", "0805", "1206", "1210"]) { const j = await get("https://jlcsearch.tscircuit.com/capacitors/list.json?capacitance=" + v.toPrecision(6) + "&package=" + p); best = (c._cands = rank((j.capacitors || []).filter((o) => close(o.capacitance_farads, v) && (o.voltage_rating || 0) >= need)))[0]; if (best) break; } }
      else { const q = c.mpn || c.suggested_mpn || (/[A-Za-z].*\d|\d.*[A-Za-z]/.test(c.value || "") && !["inductor", "capacitor_polarized", "crystal", "led"].includes(c.type) ? c.value : ""); if (q) { const j = await get("https://jlcsearch.tscircuit.com/api/search?limit=10&q=" + encodeURIComponent(q)); const nq = q.toUpperCase().replace(/[^A-Z0-9]/g, ""); best = (c._cands = rank((j.components || []).filter((o) => { const m = String(o.mfr || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); return m.startsWith(nq) || (m.length >= 5 && nq.startsWith(m)); })))[0]; } }
      if (best) { const price = parseFloat(best.price !== undefined ? best.price : best.price1); c.buy = { price: isFinite(price) ? price : null, stock: best.stock || 0, basic: !!best.is_basic, alts: (c._cands || []).filter((o) => o !== best).slice(0, 2).map((o) => "C" + o.lcsc) }; c.lcsc = "C" + best.lcsc; c.lcscFor = c.value; if (!c.mpn && best.mfr) { c.suggested_mpn = best.mfr; c.lcscMpn = true; } found++; }
    }
    setStatus("srcstatus", ""); toast("LCSC parts found for " + found + " of " + tried + " parts.");
  } catch (e) { setStatus("srcstatus", ""); toast("The LCSC lookup could not be reached from this page (" + ((e && e.message) || e) + ").", 8000); }
  finally { for (const c of comps) { c.value = c._v; c.mpn = c._m; delete c._v; delete c._m; delete c._cands; } rebuild(); }
}

/* ------------------------------------------------------------------ circuit state: base netlist + chosen options -> drawn circuit */
function projectName() { const c = state.base || {}; if ((c.blocks || []).length > 1) return DS2K.safeName("combined_" + c.blocks.map((b) => b.tag).join("_"), "combined"); return DS2K.safeName(((c.part || {}).mpn || (state.pdfName || "design").replace(/\.pdf$/i, "")) + "_ref", "design"); }
function setBase(data, keepAlias) {
  const src = JSON.parse(JSON.stringify(data)); const circ = new DS2K.Circuit(src); circ.normalize(); const alias = keepAlias ? Object.assign({}, state.alias) : {};
  (src.components || []).filter((c) => c && typeof c === "object").forEach((c, i) => { const k = circ.components[i]; if (k && c.ref !== undefined) { alias[String(c.ref).trim()] = k.ref; alias[String(c.ref).trim().toUpperCase()] = k.ref; } });
  state.base = Object.assign(circ.toDict(), { options: Array.isArray(src.options) ? src.options : [], rules: Array.isArray(src.rules) ? src.rules : [], blocks: Array.isArray(src.blocks) ? src.blocks : [], sim: src.sim && typeof src.sim === "object" ? src.sim : null, layout: Array.isArray(src.layout) ? src.layout.map(String).slice(0, 8) : [], disagreements: Array.isArray(src.disagreements) ? src.disagreements.map(String) : [], marks: src.marks && typeof src.marks === "object" ? src.marks : {} });
  (src.components || []).filter((c) => c && typeof c === "object").forEach((c, i) => { const k = circ.components[i]; if (k && Array.isArray(c.at) && c.at.length === 2 && c.at.every((v) => typeof v === "number" && v >= 0 && v <= 1)) state.base.marks[k.ref] = c.at; }); state.alias = alias; state.chosen = {}; rebuild();
}
function normalizeBase() { const b = state.base; const c = new DS2K.Circuit(JSON.parse(JSON.stringify(b))); c.normalize(); const extra = {}; for (const k of b.components) extra[k.ref] = k; state.base = Object.assign(c.toDict(), { options: b.options, rules: b.rules, blocks: b.blocks, sim: b.sim, layout: b.layout, disagreements: b.disagreements, marks: b.marks }); for (const k of state.base.components) { const o = extra[k.ref]; if (o && o.lcscFor !== undefined) { k.lcscFor = o.lcscFor; k.lcscMpn = o.lcscMpn; k.buy = o.buy; } } }
function renameNet(oldName, newName) { newName = String(newName || "").trim(); const n = state.base.nets.find((x) => x.name === oldName); if (!n || !newName || newName === oldName) return; const tgt = state.base.nets.find((x) => x !== n && x.name.toUpperCase() === newName.toUpperCase()); const sm = state.base.sim;
  if (tgt && sm && Array.isArray(sm.sources) && [n, tgt].some((x) => x.port === "output")) sm.sources = sm.sources.filter((x) => ![oldName.toUpperCase(), newName.toUpperCase()].includes(String(x.net).toUpperCase()));      /* a block's output now feeds this net - the outside supply goes away */
  n.name = newName; if (sm) for (const k of ["sources", "loads"]) for (const x of sm[k] || []) if (String(x.net).toUpperCase() === oldName.toUpperCase()) x.net = newName; if (sm && Array.isArray(sm.probes)) sm.probes = sm.probes.map((p) => (String(p).toUpperCase() === oldName.toUpperCase() ? newName : p)); normalizeBase(); }
function rebuild() {
  try {
    const ap = OPT.applyOptions(state.base, state.chosen, state.alias); state.applied = ap;
    for (const d of ap.circuit.components) { const b = state.base.components.find((x) => x.ref === d.ref); if (b && b.lcsc && b.lcscFor !== undefined && b.lcscFor !== d.value) { d.lcsc = ""; if (b.lcscMpn) d.suggested_mpn = ""; } }
    const picked = ap.options.map((o) => o.label + ": " + (o.type === "choice" ? (o.choices.find((c) => c.id === ap.values[o.id]) || {}).label : ap.values[o.id] + (o.unit ? " " + o.unit : ""))); if (picked.length) ap.circuit.notes = ["Built for - " + picked.join(", ")].concat(ap.circuit.notes || []);
    const lay = state.base.layout || []; if (lay.length) ap.circuit.notes = (ap.circuit.notes || []).concat(lay.slice(0, 6).map((x) => "Layout: " + x));
    const r = DS2K.build(ap.circuit, projectName(), { source: state.isExample ? "built-in example" : (state.base.blocks || []).length > 1 ? "" : state.currentId && !state.pdf ? "" : state.pdfName }); state.result = r; state.circuit = r.circuit.toDict();
    r.files["circuit.json"] = JSON.stringify(Object.assign({}, state.circuit, { options: state.base.options, rules: state.base.rules, chosen: ap.values, sim: state.base.sim || undefined }), null, 1);
    if (lay.length) r.files["README.txt"] += "\nPCB layout rules from the datasheet:\n" + lay.map((x) => " - " + x).join("\n") + "\n";
    try { r.files[r.name + "_ngspice.cir"] = SIM.netlist(state.circuit, state.base.sim, ap.values, state.alias, (state.circuit.design || {}).title || r.name).text; } catch (e) { /* the project is still fine without it */ }
    if (state.currentId) saveCurrent(true);
  } catch (e) { state.result = null; toast("The schematic could not be drawn: " + e.message, 9000); }
  if (simState.on && state.result) { try { simState.result = SIM.run(state.circuit, state.base.sim, state.applied.values, state.alias); } catch (e) { simState.result = { ok: false, error: e.message, notes: [] }; } }
  dbg.sim = null; dbg.ai = null;
  renderResult(); renderParts(); renderLibrary(); renderSim(); renderDebug();
}
function collectEdits() {
  const base = state.base; if (!base) return;
  document.querySelectorAll("#circuitui [data-ref]").forEach((inp) => { if (inp.disabled) return; const k = base.components.find((c) => c.ref === inp.dataset.ref); if (!k) return; const f = inp.dataset.f; const v = inp.type === "checkbox" ? inp.checked : inp.value.trim(); if (v === inp.dataset.was || (inp.type === "checkbox" && String(v) === inp.dataset.was)) return; k[f] = v; if (f === "value" || f === "mpn") { k.lcsc = ""; delete k.buy; if (k.lcscMpn) { k.suggested_mpn = ""; k.lcscMpn = false; } } });
  const gone = state.applied ? state.applied.removed : new Set(); let renamed = false;
  document.querySelectorAll("#circuitui [data-net]").forEach((inp) => {
    if (inp.value.trim() === inp.dataset.was) return; let n = base.nets.find((x) => x.name === inp.dataset.net); if (!n) { n = { name: inp.dataset.net, kind: "signal", port: "none", nodes: [] }; base.nets.push(n); }
    if (inp.dataset.f === "name") { n.name = inp.value.trim(); renamed = true; document.querySelectorAll('#circuitui [data-net="' + inp.dataset.net.replace(/"/g, '\\"') + '"]').forEach((o) => { o.dataset.net = n.name; }); }
    else { const nodes = inp.value.split(/[,;\s]+/).filter((x) => x.includes(".")).map((x) => { const j = x.indexOf("."); return { ref: x.slice(0, j).trim().toUpperCase(), pin: x.slice(j + 1).trim() }; }); const has = (a) => nodes.some((b) => b.ref === a.ref && b.pin === String(a.pin));
      for (const o of base.nets) if (o !== n) o.nodes = o.nodes.filter((a) => !has(a)); n.nodes = nodes.concat(n.nodes.filter((a) => gone.has(a.ref) && !has(a))); }
  });
  if (renamed) normalizeBase();
}
/* run an edit, redraw, and put the cursor back where it was */
function liveEdit(fn) { return () => setTimeout(guard(() => { const a = document.activeElement; const id = a && a.id; fn(); rebuild(); if (id) { const e = document.getElementById(id); if (e && e !== document.activeElement) { e.focus(); if (e.select && e.type !== "checkbox" && e.type !== "radio") { try { e.select(); } catch (x) { /* number inputs */ } } } } }), 0); }

/* ------------------------------------------------------------------ schematic: options, preview, downloads */
function fmtNum(v) { return String(parseFloat(Number(v).toPrecision(3))); }
function renderOptions(box) {
  const ap = state.applied; if (!ap) return; const wrap = el("div", { class: "opts" });
  for (const o of ap.options) {
    const id = "opt_" + o.id; let ctl;
    if (o.type === "number") { const inp = el("input", { type: "number", id, value: ap.values[o.id], min: o.min, max: o.max, step: o.step || "any", onchange: liveEdit(() => { state.chosen[o.id] = inp.value; }) }); ctl = el("span", { class: "numwrap" }, inp, o.unit ? el("span", { class: "unit" }, o.unit) : null); }
    else if (o.choices.length <= 4) ctl = el("span", { class: "seg", role: "radiogroup", "aria-label": o.label }, o.choices.map((c, i) => el("button", { type: "button", id: id + "_" + i, role: "radio", "aria-checked": c.id === ap.values[o.id] ? "true" : "false", class: c.id === ap.values[o.id] ? "on" : "", onclick: liveEdit(() => { state.chosen[o.id] = c.id; }) }, c.label)));
    else { const sel = el("select", { id, onchange: liveEdit(() => { state.chosen[o.id] = sel.value; }) }, o.choices.map((c) => el("option", { value: c.id, selected: c.id === ap.values[o.id] }, c.label))); ctl = sel; }
    const got = ap.actual[o.id]; const info = [got !== undefined && Math.abs(got - ap.values[o.id]) > 1e-9 * Math.abs(got) ? "gives " + fmtNum(got) + (o.unit ? " " + o.unit : "") : ""].filter(Boolean).join(" · ");
    wrap.append(el("div", { class: "opt", title: o.help || null }, el("label", { for: o.type === "choice" && o.choices.length <= 4 ? null : id }, o.label), ctl, info ? el("small", {}, info) : null));
  }
  if (ap.options.length) box.append(wrap);
  const ch = ap.changes.map((c) => c.what === "removed" ? c.ref + " not fitted" : c.what === "pin" ? c.ref + " pin " + c.pin + " → " + c.to : c.what === "dnp" ? c.ref + (c.to ? " not populated" : " populated") : c.ref + " → " + c.to);
  if (ch.length) box.append(el("p", { class: "changes" }, ch.join("   ·   "), " ", el("button", { type: "button", class: "quiet", onclick: () => { state.chosen = {}; rebuild(); } }, "Reset")));
  if (canAsk()) { const wish = el("input", { type: "text", id: "wish", placeholder: ap.options.length ? "Something else? e.g. add a power LED, use the 5 V variant" : "Want a change? e.g. 5 V output, SPI instead of I2C, add a power LED", "aria-label": "Describe a change", onkeydown: (ev) => { if (ev.key === "Enter") changeCircuit(); } });
    box.append(el("div", { class: "row wishrow" }, wish, el("button", { type: "button", onclick: changeCircuit }, "Apply")), el("div", { id: "wishstatus", class: "status", role: "status", "aria-live": "polite" })); }
}
function renderResult() {
  const box = $("#resultui"); if (!box) return; const keepWish = ($("#wish") || {}).value; box.innerHTML = ""; const r = state.result, c = state.circuit; if (!r || !c) { box.append(el("p", { class: "muted" }, "The schematic appears here.")); return; }
  const title = (c.design || {}).title || ((c.part || {}).mpn || "Circuit");
  box.append(el("div", { class: "row head" }, el("h3", {}, title), state.isExample ? el("span", { class: "tag ex" }, "Example") : null));
  renderBlocks(box); renderOptions(box); if (keepWish && $("#wish")) $("#wish").value = keepWish;
  const errs = r.errors.concat(r.selfCheck.ok ? [] : r.selfCheck.errors.slice(0, 8)); if (errs.length) box.append(el("div", { class: "note bad" }, el("b", {}, "Needs fixing"), el("ul", {}, errs.map((x) => el("li", {}, x)))));
  const pv = el("div", { class: "preview", tabindex: "0", "aria-label": "Schematic preview" }); pv.innerHTML = r.svg; box.append(pv);
  if (state.figureCanvas && !state.isExample) { state.figureCanvas.className = "figure"; const marks = state.base.marks || {}; const refs = c.components.map((k) => k.ref); const lost = refs.filter((r) => !marks[r]);
    const pins = refs.filter((r) => marks[r]).map((r) => el("span", { class: "mark", style: "left:" + (marks[r][0] * 100).toFixed(1) + "%;top:" + (marks[r][1] * 100).toFixed(1) + "%" }, r));
    box.append(el("details", { class: "more", id: "figdet", open: !!state.figOpen, ontoggle: (ev) => { state.figOpen = ev.target.open; } }, el("summary", {}, "Compare with the datasheet"), el("div", { class: "figwrap" }, el("div", { class: "figinner" }, state.figureCanvas, pins)),
      el("p", { class: "small" }, pins.length ? "Each tag is a part that was found. A symbol without a tag was missed" + (lost.length ? "; not located in the figure: " + lost.join(", ") + "." : ".") : "No part positions for this design."))); }
  const missing = r.symbols.filter((s) => !s.footprint).map((s) => s.ref); const low = typeof c.confidence === "number" && c.confidence < 0.8 && !state.isExample;
  const dis = state.isExample ? [] : (state.base.disagreements || []); const pinc = CMP.pinChecks(c);
  const checks = [].concat(dis.length ? ["The two readings of the figure differed here (settled by a third look - worth your own check): " + dis.join(" · ")] : [], pinc, low ? ["Low confidence on this one (" + Math.round(c.confidence * 100) + " %) - compare it with the datasheet carefully."] : [], state.applied.problems, r.warnings, r.issues, c.warnings || [], missing.length ? ["No footprint yet for " + missing.join(", ") + " - assign it in KiCad once you know the exact part."] : []);
  if (checks.length) box.append(el("details", { class: "checks" }, el("summary", {}, checks.length + (checks.length === 1 ? " thing to check" : " things to check")), el("div", {}, el("ul", {}, checks.map((x) => el("li", {}, x))))));
  box.append(el("div", { class: "row" }, el("button", { type: "button", class: "primary big", id: "dlbtn", onclick: downloadProject }, "Download KiCad project"), el("button", { type: "button", class: "big", id: "bombtn", onclick: () => saveFile(r.name + "_bom.csv", r.files["bom.csv"], "text/csv") }, "Download BOM"),
    el("button", { type: "button", class: "quiet", id: "jlcbtn", onclick: () => saveFile(r.name + "_bom_jlcpcb.csv", r.files["bom_jlcpcb.csv"], "text/csv") }, "BOM for JLCPCB"),
    state.currentId ? el("span", { class: "small saved" }, "✓ In My designs") : el("button", { type: "button", class: "quiet", id: "savebtn", onclick: () => { saveCurrent(); renderResult(); renderLibrary(); goTab("step4"); } }, "Save to My designs")));
  box.append(el("div", { id: "dlfallback" }));
}

/* ------------------------------------------------------------------ combined designs: how the blocks connect */
function renderBlocks(box) {
  const blocks = (state.base || {}).blocks || []; if (blocks.length < 2 || !state.circuit) return; const names = state.circuit.nets.map((n) => n.name).filter((x) => !/^N\$/.test(x));
  const dl = el("datalist", { id: "netnames" }, names.map((x) => el("option", { value: x }))); const wrap = el("div", { class: "opts blocks" }, dl); let i = 0;
  for (const b of blocks) {
    const refs = new Set(b.refs); const rows = state.circuit.nets.filter((n) => n.kind !== "ground" && !/^N\$/.test(n.name) && (n.port !== "none" || n.kind === "power") && n.nodes.some((x) => refs.has(x.ref)));
    const shared = (n) => n.nodes.some((x) => !refs.has(x.ref));
    wrap.append(el("div", { class: "opt" }, el("label", {}, b.name), rows.length ? rows.map((n) => { const id = "blk" + (i++); const inp = el("input", { type: "text", id, list: "netnames", value: n.name, class: "mono" + (shared(n) ? " joined" : ""), "aria-label": b.name + " net " + n.name, title: n.nodes.filter((x) => refs.has(x.ref)).map((x) => x.ref + "." + x.pin).join(", "), onchange: liveEdit(() => renameNet(n.name, inp.value)) }); return inp; }) : el("small", {}, "no outside connections")));
  }
  box.append(el("p", { class: "small" }, "Same name = connected."), wrap);
}

/* ------------------------------------------------------------------ My designs: saved in this browser, export / import as files, combine */
const LIBKEY = "ds2k.lib";
function loadLibrary() { try { const l = JSON.parse(localStorage.getItem(LIBKEY) || "[]"); state.library = Array.isArray(l) ? l.filter((d) => d && d.id && d.base) : []; } catch (e) { state.library = []; } }
function storeLibrary() { try { localStorage.setItem(LIBKEY, JSON.stringify(state.library)); return true; } catch (e) { toast("This browser would not store the design - use Export to keep a copy.", 8000); return false; } }
function designName() { const c = state.base || {}; return (c.design || {}).title || (c.part || {}).mpn || (state.pdfName || "Design").replace(/\.pdf$/i, ""); }
function saveCurrent(quiet) {
  if (!state.base || !state.applied) return; let d = state.library.find((x) => x.id === state.currentId);
  if (!d) { d = { id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: designName() }; state.library.unshift(d); state.currentId = d.id; setTimeout(() => { renderLibrary(); renderResult(); }, 0); }
  Object.assign(d, { saved: Date.now(), base: state.base, alias: state.alias, chosen: state.applied.values, parts: state.circuit ? state.circuit.components.length : 0 }); const ok = storeLibrary(); if (ok && !quiet) toast("Saved.");
}
function openDesign(d) { state.isExample = false; state.figureCanvas = null; state.sentImages = []; state.reviewChanges = []; state.currentId = null; state.alias = d.alias || {}; setBase(d.base, true); state.chosen = Object.assign({}, d.chosen); state.currentId = d.id; rebuild(); goTab("step2"); }
function derivedOf(d) { const ap = OPT.applyOptions(d.base, d.chosen || {}, d.alias || {}); return ap.circuit; }
function combineSelected() {
  const picks = state.library.filter((d) => state.picked.has(d.id)); if (picks.length < 2) { toast("Tick two or more designs first."); return; }
  const merged = window.DS2K_COMBINE.combine(picks.map((d) => { const ap = OPT.applyOptions(d.base, d.chosen || {}, d.alias || {}); return { name: d.name, circuit: ap.circuit, sim: SIM.bake(d.base.sim, ap.values, ap.circuit, d.alias || {}) }; }).reverse());
  state.isExample = false; state.figureCanvas = null; state.sentImages = []; state.reviewChanges = []; state.currentId = null; state.picked = new Set(); setBase(merged); saveCurrent(true); renderResult(); renderLibrary(); goTab("step2");
}
function importDesign(file) {
  const fr = new FileReader(); fr.onload = guard(() => { let d; try { d = JSON.parse(String(fr.result)); } catch (e) { toast("That file is not a design (.json)."); return; } const base = d.base || d; if (!base || !Array.isArray(base.components) || !Array.isArray(base.nets)) { toast("That file is not a design (.json)."); return; }
    const entry = { id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: d.name || (base.design || {}).title || file.name.replace(/\.json$/i, ""), saved: Date.now(), base, alias: d.alias || {}, chosen: d.chosen || {}, parts: base.components.length }; state.library.unshift(entry); storeLibrary(); openDesign(entry); }); fr.readAsText(file);
}
function renderLibrary() {
  const box = $("#libui"); if (!box) return; box.innerHTML = ""; const list = state.library;
  if (!list.length) box.append(el("p", { class: "muted" }, "Nothing saved yet."));
  else {
    const t = el("table", { class: "lib" }); const tb = el("tbody", {});
    for (const d of list) { const cur = d.id === state.currentId; const name = el("input", { type: "text", id: "lib_" + d.id, value: d.name, "aria-label": "Design name", onchange: () => { d.name = name.value.trim() || d.name; storeLibrary(); } });
      const del = el("button", { type: "button", class: "quiet", onclick: () => { if (del.dataset.sure) { state.library = state.library.filter((x) => x !== d); state.picked.delete(d.id); if (cur) state.currentId = null; storeLibrary(); renderLibrary(); renderResult(); } else { del.dataset.sure = "1"; del.textContent = "Really delete?"; setTimeout(() => { delete del.dataset.sure; del.textContent = "Delete"; }, 3000); } } }, "Delete");
      tb.append(el("tr", { class: cur ? "cur" : "" }, el("td", { class: "pick" }, el("input", { type: "checkbox", checked: state.picked.has(d.id), "aria-label": "Select " + d.name, onchange: (ev) => { if (ev.target.checked) state.picked.add(d.id); else state.picked.delete(d.id); renderLibrary(); } })), el("td", {}, name),
        el("td", { class: "small nowrap" }, (d.parts || 0) + " parts" + ((d.base.blocks || []).length > 1 ? " · " + d.base.blocks.length + " blocks" : "")), el("td", { class: "nowrap" }, el("button", { type: "button", onclick: () => openDesign(d) }, cur ? "Open ✓" : "Open"), el("button", { type: "button", class: "quiet", onclick: () => saveFile(DS2K.safeName(d.name) + ".design.json", JSON.stringify({ name: d.name, base: d.base, alias: d.alias, chosen: d.chosen }, null, 1), "application/json") }, "Export"), del))); }
    t.append(tb); box.append(el("div", { class: "scroll wide" }, t));
  }
  const n = state.picked.size; const imp = el("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: () => { const f = imp.files[0]; imp.value = ""; if (f) importDesign(f); } });
  box.append(el("div", { class: "row" }, el("button", { type: "button", class: n >= 2 ? "primary" : "", id: "combinebtn", disabled: n < 2, onclick: combineSelected }, n >= 2 ? "Combine " + n + " into one schematic" : "Combine into one schematic"), el("button", { type: "button", onclick: () => imp.click() }, "Import…"), imp));
}

/* ------------------------------------------------------------------ simulation: stand-ins for the chips, quick run in the page, ngspice file */
const simState = { result: null, on: false };
function simModel() { if (!state.base.sim || typeof state.base.sim !== "object") state.base.sim = {}; const c = SIM.cleanSim(state.base.sim, state.circuit); Object.assign(state.base.sim, c); return state.base.sim; }
function runSim() { simState.on = true; try { simState.result = SIM.run(state.circuit, state.base.sim, state.applied.values, state.alias); } catch (e) { simState.result = { ok: false, error: e.message, notes: [] }; } renderSim(); }
function fmtSI(v, unit) { const a = Math.abs(v); const [k, p] = a >= 1 ? [1, ""] : a >= 1e-3 ? [1e3, "m"] : a >= 1e-6 ? [1e6, "µ"] : a === 0 ? [1, ""] : [1e9, "n"]; return fmtNum(v * k) + " " + p + unit; }
function simChart(res) {
  const W = 720, H = 300, L = 46, R = 14, T = 12, B = 30; const tmax = res.t[res.t.length - 1] || 1; let lo = 0, hi = 0; for (const tr of res.traces) for (const v of tr.v) { if (v < lo) lo = v; if (v > hi) hi = v; } if (hi - lo < 1e-9) hi = lo + 1; const pad = (hi - lo) * 0.08; hi += pad; if (lo < 0) lo -= pad;
  const X = (t) => L + (t / tmax) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B); const ns = "http://www.w3.org/2000/svg"; const mk = (tag, at, txt) => { const e = document.createElementNS(ns, tag); for (const k in at) e.setAttribute(k, at[k]); if (txt !== undefined) e.textContent = txt; return e; };
  const svg = mk("svg", { viewBox: "0 0 " + W + " " + H, class: "simchart", role: "img", "aria-label": "Simulated voltages over time" }); const step = Math.pow(10, Math.floor(Math.log10((hi - lo) / 4))); const tick = [1, 2, 5, 10].map((m) => m * step).find((s) => (hi - lo) / s <= 6);
  for (let v = Math.ceil(lo / tick) * tick; v <= hi; v += tick) { svg.append(mk("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: "grid" + (Math.abs(v) < tick / 1e6 ? " zero" : "") }), mk("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end", class: "axis" }, fmtNum(v) + " V")); }
  for (let i = 0; i <= 4; i++) svg.append(mk("text", { x: X(tmax * i / 4), y: H - 8, "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle", class: "axis" }, fmtSI(tmax * i / 4, "s")));
  res.traces.forEach((tr, j) => { let d = ""; tr.v.forEach((v, i) => { d += (i ? "L" : "M") + X(res.t[i]).toFixed(1) + " " + Y(v).toFixed(1); }); svg.append(mk("path", { d, class: "trace s" + (j + 1) })); });
  const cur = mk("line", { y1: T, y2: H - B, class: "cursor", visibility: "hidden" }); svg.append(cur); const tip = el("div", { class: "simtip", hidden: true }); const wrap = el("div", { class: "simwrap" }, svg, tip);
  const move = (ev) => { const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) / r.width * W; if (px < L || px > W - R) { cur.setAttribute("visibility", "hidden"); tip.hidden = true; return; } const t = (px - L) / (W - L - R) * tmax; let i = Math.min(res.t.length - 1, Math.max(0, Math.round(t / tmax * (res.t.length - 1)))); cur.setAttribute("x1", X(res.t[i])); cur.setAttribute("x2", X(res.t[i])); cur.setAttribute("visibility", "visible");
    tip.hidden = false; tip.innerHTML = ""; tip.append(el("b", {}, fmtSI(res.t[i], "s")), ...res.traces.map((tr, j) => el("span", {}, el("i", { class: "key s" + (j + 1) }), tr.label + "  " + tr.v[i].toFixed(3) + " V"))); tip.style.left = Math.min(r.width - 150, Math.max(0, (ev.clientX - r.left) + 12)) + "px"; };
  svg.addEventListener("pointermove", move); svg.addEventListener("pointerleave", () => { cur.setAttribute("visibility", "hidden"); tip.hidden = true; }); return wrap;
}
function renderSim() {
  const box = $("#simui"); if (!box) return; box.innerHTML = ""; if (!state.circuit || !state.applied) return; const sm = SIM.cleanSim(state.base.sim, state.circuit); const edit = (fn) => liveEdit(() => { const m = simModel(); fn(m); });
  const field = (id, val, ph, w, on) => { const i = el("input", { type: "text", id, value: val === undefined || val === null ? "" : String(val), placeholder: ph, style: "width:" + w + "px", "aria-label": ph, onchange: edit((m) => on(m, i.value.trim())) }); return i; };
  const waveRow = (list, idx, label, kinds) => { const s = sm[list][idx]; const id = "sim_" + list + idx; const kind = String(s.kind || "dc").toLowerCase(); const set = (k) => (m, v) => { m[list][idx][k] = v; };
    const sel = el("select", { id: id + "k", "aria-label": label + " kind", onchange: edit((m) => { m[list][idx].kind = sel.value; }) }, kinds.map((k) => el("option", { value: k, selected: k === kind }, { dc: "steady voltage", pulse: "clock / PWM", sine: "sine", load: "load to ground", open: "nothing" }[k])));
    const parts = kind === "pulse" ? [field(id + "l", s.low === undefined ? 0 : s.low, "low V", 64, set("low")), "to", field(id + "h", s.high !== undefined ? s.high : s.value, "high V", 64, set("high")), "V at", field(id + "f", s.freq, "Hz", 90, set("freq")), "Hz, duty", field(id + "d", s.duty === undefined ? 0.5 : s.duty, "0-1", 110, set("duty"))]
      : kind === "sine" ? [field(id + "v", s.ampl !== undefined ? s.ampl : s.value, "amplitude V", 70, set("value")), "V at", field(id + "f", s.freq, "Hz", 90, set("freq")), "Hz around", field(id + "o", s.offset || 0, "offset V", 64, set("offset")), "V"] : kind === "load" ? [field(id + "v", s.value, "ohm", 90, set("value")), "Ω"] : kind === "open" ? [] : [field(id + "v", s.value, "V", 90, set("value")), "V"];
    return el("div", { class: "simrow" }, el("span", { class: "mono what" }, label), sel, ...parts, s.note ? el("small", {}, s.note) : null); };
  const rows = [];
  sm.sources.forEach((s, i) => rows.push(waveRow("sources", i, s.net, ["dc", "pulse", "sine"])));
  sm.chips.forEach((c, i) => { const id = "sim_chip" + i; const m = String(c.model).toLowerCase(); const cf = (k, val, ph, w) => field(id + k, val, ph, w, (mm, v) => { mm.chips[i][k] = v; });
    rows.push(el("div", { class: "simrow" }, el("span", { class: "mono what" }, c.ref), m === "regulator" ? ["regulator,", cf("vout", c.vout, "V", 70), "V out,", cf("dropout", c.dropout === undefined ? 0.3 : c.dropout, "V", 56), "V drop-out,", cf("ilim", c.ilim === undefined ? "" : c.ilim, "no limit", 70), "A limit"]
      : m === "switcher" || m === "buck" ? ["buck controller, feedback to", cf("vref", c.vref === undefined ? 0.8 : c.vref, "V", 60), "V at", cf("freq", c.freq === undefined ? 500000 : c.freq, "Hz", 90), "Hz, loop", cf("fc", c.fc === undefined ? 300 : c.fc, "Hz", 60), "Hz"]
      : m === "timer555" || m === "555" ? ["555 timer"] : ["ideal op-amp"], c.note ? el("small", {}, c.note) : null)); });
  sm.switches.forEach((w, i) => rows.push(el("div", { class: "simrow" }, el("span", { class: "mono what" }, w.ref), el("select", { id: "sim_sw" + i, "aria-label": w.ref + " state", onchange: edit((m) => { m.switches[i].closed = $("#sim_sw" + i).value === "1"; }) }, el("option", { value: "1", selected: !!w.closed }, "closed"), el("option", { value: "0", selected: !w.closed }, "open")))));
  sm.standins.forEach((s, i) => { const comp = state.circuit.components.find((k) => k.ref === (state.alias[s.ref] || String(s.ref).toUpperCase())); const pn = comp && (comp.pins || []).find((p) => String(p.number) === String(s.pin)); rows.push(waveRow("standins", i, s.ref + " pin " + s.pin + (pn && pn.name ? " (" + pn.name + ")" : ""), ["dc", "pulse", "sine", "load", "open"])); });
  sm.loads.forEach((l, i) => rows.push(el("div", { class: "simrow" }, el("span", { class: "mono what" }, l.net), "load", field("sim_load" + i, l.value, "ohm", 110, (m, v) => { m.loads[i].value = v; }), "Ω", l.note ? el("small", {}, l.note) : null)));
  box.append(el("p", { class: "small" }, "Each chip is replaced by what it does:"));
  box.append(el("div", { class: "simrows" }, rows.length ? rows : el("p", { class: "muted" }, "Nothing drives this circuit yet.")));
  const nets = state.circuit.nets.filter((n) => n.kind !== "ground" && !/^N\$/.test(n.name)).map((n) => n.name); const on = new Set(sm.probes.map((p) => p.toUpperCase()));
  box.append(el("div", { class: "row" }, el("span", { class: "small" }, "Plot"), el("span", { class: "chips" }, nets.map((n, i) => el("button", { type: "button", id: "probe" + i, class: "chip" + (on.has(n.toUpperCase()) ? " on" : ""), "aria-pressed": on.has(n.toUpperCase()) ? "true" : "false", onclick: edit((m) => { const cur = m.probes.filter((p) => nets.includes(p)); m.probes = on.has(n.toUpperCase()) ? cur.filter((p) => p.toUpperCase() !== n.toUpperCase()) : cur.concat([n]).slice(-4); }) }, n)))));
  box.append(el("div", { class: "row" }, el("button", { type: "button", class: "primary big", id: "simbtn", onclick: runSim }, simState.on ? "Run again" : "Run simulation"), el("label", { for: "sim_t" }, "for"), field("sim_t", sm.tstop ? sm.tstop * 1000 : "", "auto", 70, (m, v) => { const x = parseFloat(v); m.tstop = x > 0 ? x / 1000 : undefined; }), el("span", { class: "small" }, "ms"),
    el("button", { type: "button", id: "cirbtn", onclick: () => { const r = state.result; const txt = r && r.files[r.name + "_ngspice.cir"]; if (txt) saveFile(r.name + (IN_HOST ? "_ngspice.cir.txt" : "_ngspice.cir"), txt, "text/plain"); } }, "Download ngspice file")));
  let fal = null; try { fal = FAL.exportFalstad(state.circuit, state.base.sim, state.applied.values, state.alias, projectName()); } catch (e) { fal = null; }
  if (fal) box.append(el("div", { class: "row" }, el("a", { class: "btn", id: "falopen", href: FAL.falstadUrl(fal.text), target: "_blank", rel: "noopener" }, "Open in Falstad"), el("button", { type: "button", id: "falbtn", onclick: () => saveFile(projectName() + "_falstad.txt", fal.text, "text/plain") }, "Download for Falstad"),
    el("span", { class: "small" }, "Falstad: File → Import From Text. Same stand-ins as here" + (fal.notes.length ? " · " + fal.notes.join(" · ") : "") + ".")));
  const res = simState.result; if (!simState.on || !res) return;
  if (!res.ok) { box.append(el("p", { class: "note bad" }, res.error)); return; }
  if (res.traces.length) { box.append(el("div", { class: "legend" }, res.traces.map((tr, j) => el("span", {}, el("i", { class: "key s" + (j + 1) }), tr.label, el("b", {}, " " + tr.v[tr.v.length - 1].toFixed(2) + " V")))), simChart(res)); } else box.append(el("p", { class: "muted" }, "Pick at least one net to plot."));
  const others = Object.entries(res.final).filter(([k]) => !/^nc_|^load_|^N_\d+$/.test(k)).slice(0, 24); box.append(el("details", { class: "more" }, el("summary", {}, "Voltages at the end"), el("div", { class: "endv mono" }, others.map(([k, v]) => el("span", {}, k + " " + v.toFixed(3) + " V")))));
  if (res.notes.length) box.append(el("details", { class: "checks" }, el("summary", {}, res.notes.length + " simulation note" + (res.notes.length > 1 ? "s" : "")), el("div", {}, el("ul", {}, res.notes.map((x) => el("li", {}, x))))));
}

/* ------------------------------------------------------------------ parts + advanced */
function buyOf(k) { const b = (state.base.components.find((x) => x.ref === k.ref) || {}); return k.lcsc && b.buy ? b.buy : null; }
function buyInfo(k) { const b = buyOf(k); if (!b) return null; const stock = b.stock >= 1000 ? Math.round(b.stock / 1000) + "k" : String(b.stock); return el("small", { class: b.stock < 100 ? "lowstock" : "" }, (b.price !== null ? "$" + (b.price < 0.1 ? b.price.toFixed(4) : b.price.toFixed(2)) + " · " : "") + stock + " in stock" + (b.basic ? " · basic" : "") + (b.alts && b.alts.length ? " · or " + b.alts.join(", ") : "")); }
let TAB = "nets";
function renderParts() {
  const box = $("#circuitui"); if (!box) return; const wasOpen = ($("#adv") || {}).open; box.innerHTML = ""; const c = state.circuit, r = state.result; if (!c || !r) return;
  const fp = {}; for (const s of r.symbols) fp[s.ref] = s.footprint; const rowOf = {}; for (const row of r.bom) for (const ref of row.refs) rowOf[ref] = row; const auto = state.applied.controlled;
  const t = el("table", {}, el("thead", {}, el("tr", {}, ...["", "Value", "Package", "Part number", "Footprint", "Buy"].map((h) => el("th", {}, h))))); const tb = el("tbody", {});
  c.components.forEach((k) => {
    const row = rowOf[k.ref] || {}; const cell = (f, ph, locked) => el("input", { type: "text", id: "p_" + k.ref + "_" + f, value: k[f] || "", placeholder: ph || "", disabled: locked, title: locked ? "Set by the options above" : null, "data-ref": k.ref, "data-f": f, "data-was": k[f] || "", "aria-label": k.ref + " " + f, onchange: liveEdit(collectEdits) });
    tb.append(el("tr", { class: k.dnp ? "dnp" : "" }, el("td", { class: "mono" }, k.ref), el("td", {}, cell("value", "", auto.has(k.ref)), k.rating ? el("small", {}, k.rating) : null), el("td", {}, cell("package", ["resistor", "capacitor", "ferrite_bead", "thermistor", "led"].includes(k.type) ? "0603" : "")), el("td", {}, cell("mpn", row.mpn || k.suggested_mpn || "", auto.has(k.ref + ".mpn"))),
      el("td", { class: "mono small" }, fp[k.ref] ? fp[k.ref].split(":").pop() : "-"),
      el("td", { class: "buy" }, buyInfo(k), k.lcsc ? el("a", { href: "https://www.lcsc.com/product-detail/" + k.lcsc + ".html", target: "_blank", rel: "noopener" }, k.lcsc) : el("a", { href: row.lcscUrl || "#", target: "_blank", rel: "noopener" }, "LCSC"), " ", el("a", { href: row.mouserUrl || "#", target: "_blank", rel: "noopener" }, "Mouser"))));
  });
  t.append(tb); box.append(el("div", { class: "scroll wide" }, t));
  let total = 0, priced = 0, fitted = 0; for (const k of c.components) { if (k.dnp) continue; fitted++; const b = buyOf(k); if (b && b.price !== null) { total += b.price; priced++; } }
  if (priced) box.append(el("p", { class: "small" }, "About $" + total.toFixed(2) + " per board for " + priced + " of " + fitted + " parts (LCSC price for one piece)."));
  if (!IN_HOST) box.append(el("div", { class: "row" }, el("button", { type: "button", onclick: findParts }, "Find LCSC parts, prices and stock"), el("div", { id: "srcstatus", class: "status", role: "status", "aria-live": "polite" })));

  const tabs = el("div", { class: "tabs" }); const notes = (state.reviewChanges || []).concat(c.notes || []);
  for (const [k, label] of [["nets", "Connections"], ["notes", "Notes"], ["json", "JSON"]]) { if (k === "notes" && !notes.length) continue; tabs.append(el("button", { type: "button", class: "tab" + (TAB === k ? " on" : ""), "aria-pressed": TAB === k ? "true" : "false", onclick: () => { TAB = k; renderParts(); } }, label)); }
  const body = el("div", { class: "scroll" });
  if (TAB === "notes" && !notes.length) TAB = "nets";
  if (TAB === "nets") {
    const nt = el("table", {}, el("thead", {}, el("tr", {}, ...["Net", "Pins (REF.PIN)"].map((h) => el("th", {}, h))))); const nb = el("tbody", {});
    c.nets.forEach((n, i) => { const pins = (n.nodes || []).map((x) => x.ref + "." + x.pin).join(", "); nb.append(el("tr", {}, el("td", { class: "netname" }, el("input", { type: "text", id: "n" + i + "name", value: n.name, "data-net": n.name, "data-f": "name", "data-was": n.name, "aria-label": "net name", onchange: liveEdit(collectEdits) })), el("td", {}, el("input", { type: "text", class: "mono", id: "n" + i + "nodes", value: pins, "data-net": n.name, "data-f": "nodes", "data-was": pins, "aria-label": "pins on " + n.name, onchange: liveEdit(collectEdits) })))); });
    nt.append(nb); body.append(nt);
  } else if (TAB === "notes") body.append(el("ul", { class: "plain" }, notes.map((x) => el("li", {}, x))));
  else body.append(el("textarea", { id: "rawjson", spellcheck: "false", "aria-label": "Circuit JSON" }, JSON.stringify(state.base, (k, v) => (k === "lcscFor" || k === "lcscMpn" ? undefined : v), 1)), el("div", { class: "row" }, el("button", { type: "button", onclick: applyJson }, "Apply JSON")));
  const canReview = canAsk() && !state.isExample && state.pdf;
  box.append(el("details", { id: "adv", open: !!wasOpen }, el("summary", {}, "Advanced"), el("div", {}, tabs, body,
    el("div", { class: "row" }, canReview ? el("button", { type: "button", onclick: reviewCircuit }, "Double-check") : null, el("button", { type: "button", class: "quiet", onclick: showSchematicText }, "Show .kicad_sch text")),
    el("div", { id: "reviewstatus", class: "status", role: "status", "aria-live": "polite" }), el("div", { id: "schbox" }))));
}
function applyJson() { const ta = $("#rawjson"); if (!ta) return; let d; try { d = JSON.parse(ta.value); } catch (e) { toast("That JSON is not valid."); return; } if (!d || !Array.isArray(d.components) || !Array.isArray(d.nets)) { toast("The JSON needs \"components\" and \"nets\" lists."); return; } const chosen = state.chosen; setBase(d, true); state.chosen = chosen; rebuild(); toast("Applied."); }
function showSchematicText(where) {
  const r = state.result; if (!r) return; const fb = $(typeof where === "string" ? where : "#schbox") || $("#dlfallback"); fb.innerHTML = ""; const txt = r.files[r.name + ".kicad_sch"];
  fb.append(el("p", { class: "small" }, "Save this text as " + r.name + ".kicad_sch - it opens in KiCad on its own."), el("textarea", { id: "schtext", readonly: true, "aria-label": "Schematic file contents" }, txt),
    el("div", { class: "row" }, el("button", { type: "button", onclick: async () => { try { await navigator.clipboard.writeText(txt); toast("Copied."); } catch (e) { $("#schtext").focus(); $("#schtext").select(); toast("Press Cmd+C to copy the selected text."); } } }, "Copy all")));
}
/* save through the host when published, as a normal browser download when opened as a local file */
async function saveFile(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || "application/octet-stream" });
  if (IN_HOST) {
    if (!state.downloads) return "unavailable";
    try { await state.downloads.save({ filename, data: blob }); toast("Saved " + filename); return "saved"; } catch (e) { if (e && e.code === "declined") return "declined"; toast("Saving was refused here (" + ((e && e.code) || "error") + ").", 7000); return "failed"; }
  }
  const url = URL.createObjectURL(blob); const a = el("a", { href: url, download: filename }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); toast("Downloaded " + filename); return "saved";
}
async function downloadProject() {
  const r = state.result; if (!r) return; const st = await saveFile(r.name + "_kicad.zip", new Blob([window.DS2K_ZIP.makeZip(r.files, r.name)], { type: "application/zip" }));
  if (st === "unavailable" || st === "failed") { if (st === "unavailable") toast("Saving files is not available in this view - the schematic text is shown instead.", 8000); showSchematicText("#dlfallback"); }
}

/* ------------------------------------------------------------------ tabs */
function goTab(id) { document.querySelectorAll(".tabpanel").forEach((p) => { p.hidden = window.__alltabs ? false : p.id !== id; }); document.querySelectorAll("#nav .tab").forEach((b) => { const on = b.dataset.tab === id; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); }); try { localStorage.setItem("ds2k.tab", id); } catch (e) { /* ignore */ } }

/* ------------------------------------------------------------------ debug: what is wrong with the built board? */
const dbg = { text: "", net: "", measured: {}, busy: null, sim: null, ai: null, progress: null };
function debugPrompt(symptom, simHits, circuit) {
  const meas = Object.entries(dbg.measured).filter(([, v]) => v !== "" && !isNaN(parseFloat(v))).map(([k, v]) => k + " = " + v + " V");
  return "You are a senior electronics engineer debugging a BUILT board. The board implements the reference design below (a netlist transcribed from the part's datasheet" + (state.pdf && !state.isExample ? ", datasheet text follows" : "") + ").\n\nWhat the engineer observes: " + dbg.text + (symptom.net ? "\nNet concerned: " + symptom.net : "") + (meas.length ? "\nMeasured with a meter / scope: " + meas.join(", ") : "") +
    "\n\nA fault-injection simulation (chips replaced by ideal stand-ins, so it cannot reproduce anything that happens inside the chip - loop stability, ESR sensitivity, thermal or current limits, start-up logic) " + (simHits.length ? "reproduces the symptom with these assembly faults:\n" + simHits.slice(0, 8).map((h) => "- " + h.text).join("\n") : "did not reproduce the symptom with any single assembly fault (wrong value, open, short, reversed part, lifted pin, bridge).") +
    "\n\nGive the most likely causes, INCLUDING the ones the simulation cannot see (output capacitor ESR / stability, input near dropout, thermal shutdown cycling, current limit, enable / soft-start pins, layout, wrong part variant, damaged part), each with a probability, why it fits this observation, and the quickest measurement that confirms or rules it out. Use the datasheet's own numbers where they matter (stable ESR range, minimum capacitance, dropout, limits). At most 7 causes, most likely first.\n\nNetlist:\n" + JSON.stringify(circuit) + (state.pdf && !state.isExample ? "\n\nDatasheet text:\n\n" + pageTextBlock(24000) : "") +
    "\n\nAnswer with ONE JSON object only: {\"causes\":[{\"cause\":\"\",\"probability\":0.0,\"why\":\"\",\"check\":\"\"}],\"note\":\"one line on what would settle it fastest\"}";
}
async function runDebug() {
  if (dbg.busy) { dbg.busy.abort(); return; } const text = (($("#dbgtext") || {}).value || "").trim(); if (!text) { toast("Describe what you see first."); return; } dbg.text = text;
  const nets = state.circuit.nets.map((n) => n.name).filter((x) => !/^N\$/.test(x)); const sym = DBG.parseSymptom(text, nets); sym.net = (($("#dbgnet") || {}).value || sym.net || "").trim(); if (!sym.net) sym.net = (state.circuit.nets.find((n) => n.port === "output") || state.circuit.nets.find((n) => n.kind === "power" && n.port !== "input") || {}).name || nets[0]; dbg.net = sym.net;
  if (!sym.kind) sym.kind = "low"; dbg.sim = null; dbg.ai = null; const ctl = new AbortController(); dbg.busy = ctl; dbg.progress = [0, 1]; renderDebug();
  try { dbg.sim = await DBG.diagnose(state.circuit, state.base.sim, state.applied.values, state.alias, sym, { signal: ctl.signal, onProgress: (d, n) => { dbg.progress = [d, n]; const b = $("#dbgbar"); if (b) b.style.width = (100 * d / n).toFixed(0) + "%"; const t = $("#dbgcount"); if (t) t.textContent = d + " / " + n; } }); dbg.sim.symptom = sym; }
  catch (e) { dbg.sim = { error: e.message, hits: [], tried: 0 }; }
  dbg.progress = null; dbg.busy = null; renderDebug();
  if (canAsk() && !ctl.signal.aborted) { try { const data = await askClaude(debugPrompt(sym, dbg.sim.hits || [], bakedCircuit()), [], "dbgstatus", "Thinking about causes the simulation cannot see"); setStatus("dbgstatus", ""); if (data && Array.isArray(data.causes)) dbg.ai = { causes: data.causes.filter((c) => c && c.cause).slice(0, 7), note: data.note || "" }; } catch (e) { setStatus("dbgstatus", ""); explain(e, "The analysis"); } renderDebug(); }
}
function renderDebug() {
  const box = $("#dbgui"); if (!box) return; const keep = ($("#dbgtext") || {}).value; box.innerHTML = ""; if (!state.circuit) return;
  const nets = state.circuit.nets.filter((n) => n.kind !== "ground" && !/^N\$/.test(n.name)).map((n) => n.name);
  const ta = el("input", { type: "text", id: "dbgtext", value: keep !== undefined ? keep : dbg.text, placeholder: "What do you see? e.g. VOUT is a square wave · 3V3 reads 2.1 V · LED stays off", "aria-label": "What do you see", onkeydown: (ev) => { if (ev.key === "Enter") runDebug(); } });
  const sel = el("select", { id: "dbgnet", "aria-label": "Net" }, el("option", { value: "" }, "net: from the text"), nets.map((n) => el("option", { value: n, selected: n === dbg.net }, n)));
  box.append(el("div", { class: "dbg" }, el("div", { class: "field" }, el("label", { for: "dbgtext" }, "Symptom"), ta), el("div", { class: "field" }, el("label", { for: "dbgnet" }, "Where"), sel), el("button", { type: "button", class: "primary big", id: "dbgbtn", onclick: runDebug }, dbg.busy ? "Stop" : "Find the cause")));
  box.append(el("details", { class: "more", open: Object.keys(dbg.measured).length > 0 }, el("summary", {}, "Measured voltages (optional)"), el("div", { class: "meas" }, nets.slice(0, 12).map((n) => el("label", {}, n, el("input", { type: "text", id: "meas_" + n.replace(/[^A-Za-z0-9]/g, "_"), value: dbg.measured[n] || "", placeholder: "V", onchange: (ev) => { dbg.measured[n] = ev.target.value.trim(); } }))))));
  if (dbg.progress) { box.append(el("div", { class: "stack" }, el("div", { class: "small" }, "Trying one fault at a time in the simulation… ", el("span", { id: "dbgcount" }, dbg.progress[0] + " / " + dbg.progress[1])), el("div", { class: "bar-progress" }, el("i", { id: "dbgbar", style: "width:" + (100 * dbg.progress[0] / dbg.progress[1]).toFixed(0) + "%" })))); return; }
  const r = dbg.sim; if (!r) { box.append(el("p", { class: "small" }, "Describe the misbehaviour of a built board. Every plausible assembly fault is tried in the simulation, then the causes the simulation cannot see are reasoned out from the datasheet.")); return; }
  if (r.error) box.append(el("p", { class: "note bad" }, r.error));
  else {
    const kind = { oscillating: "oscillating", zero: "at zero", low: "too low", high: "too high", ripple: "noisy", slow: "slow", level: "at " + r.symptom.measured + " V" }[r.symptom.kind] || r.symptom.kind;
    box.append(el("h3", {}, "Reproduced in simulation"), el("p", { class: "small" }, r.symptom.net + " " + kind + " · " + r.tried + " faults tried · healthy design gives " + DBG.describe(r.baseline)));
    if (!r.hits.length) box.append(el("p", { class: "muted" }, "No single assembly fault reproduces this in the simulation. That points at the chip itself or at something the stand-in cannot model - see below."));
    else box.append(el("div", { class: "causes" }, r.hits.slice(0, 8).map((h) => el("div", { class: "cause" }, el("span", { class: "pct" }, Math.round(h.score * 100) + "%"), el("div", {}, el("b", {}, h.text), el("small", {}, "Simulation then " + DBG.describe(h.sim) + " · Check: " + h.check))))));
  }
  if (dbg.ai) { box.append(el("h3", {}, "From the datasheet and experience"), el("div", { class: "causes" }, dbg.ai.causes.map((c) => el("div", { class: "cause" }, el("span", { class: "pct" }, Math.round(Math.max(0, Math.min(1, +c.probability || 0)) * 100) + "%"), el("div", {}, el("b", {}, c.cause), el("small", {}, c.why), c.check ? el("small", {}, "Check: " + c.check) : null))))); if (dbg.ai.note) box.append(el("p", { class: "note" }, dbg.ai.note)); }
  else if (!canAsk() && r && !r.error) box.append(el("p", { class: "small" }, "Causes inside the chip (stability, dropout, thermal, limits) need the reader - add the API key above."));
  box.append(el("div", { id: "dbgstatus", class: "status", role: "status", "aria-live": "polite" }));
}

/* ------------------------------------------------------------------ misc UI */
function setStatus(id, msg, spin, onStop) { const s = document.getElementById(id); if (!s) return; s.innerHTML = ""; if (!msg) return; if (spin) s.append(el("span", { class: "spin", "aria-hidden": "true" })); s.append(el("span", {}, msg)); if (onStop) s.append(el("button", { type: "button", class: "quiet", onclick: onStop }, "Stop")); }
function toast(msg, ms) { document.querySelectorAll(".toast").forEach((t) => t.remove()); const t = el("div", { class: "toast", role: "alert" }, msg); document.body.append(t); setTimeout(() => t.remove(), ms || 5000); }

function boot() {
  const benign = (e) => /ResizeObserver|Rendering cancelled|RenderingCancelled|Script error|AbortError|cancelled/i.test(String((e && (e.name + " " + (e.message || e.code || ""))) || e));
  window.addEventListener("error", (ev) => { const e = ev.error || ev.message; if (!benign(e)) showError(e); }); window.addEventListener("unhandledrejection", (ev) => { if (!benign(ev.reason)) showError(ev.reason); });
  window.addEventListener("ds2k-pdfready", () => { state.pdfReady = true; renderDiag(); });
  const drop = $("#drop"), file = $("#file");
  file.addEventListener("change", guard(() => { const f = file.files[0]; file.value = ""; return openPdf(f); }));
  $("#pick").addEventListener("click", guard((ev) => { ev.preventDefault(); file.click(); }));
  for (const ev of ["dragenter", "dragover"]) document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  document.addEventListener("drop", guard((e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) return openPdf(f); }));
  $("#copyprompt").addEventListener("click", guard(async () => { const p = manualPrompt(); try { await navigator.clipboard.writeText(p); toast("Prompt copied."); } catch (e) { const ta = $("#manualjson"); ta.value = p; ta.focus(); ta.select(); toast("The prompt is in the text box and selected - press Cmd+C to copy it.", 8000); } }));
  $("#usejson").addEventListener("click", guard(() => { let data; try { data = parseLoose($("#manualjson").value); } catch (e) { toast("That is not valid JSON."); return; } if (data && data.circuit && Array.isArray(data.circuit.components)) data = data.circuit; if (!data || !Array.isArray(data.components) || !Array.isArray(data.nets)) { toast("The JSON needs \"components\" and \"nets\" lists."); return; } state.isExample = false; state.figureCanvas = null; state.sentImages = []; state.reviewChanges = []; state.currentId = null; setBase(data); saveCurrent(true); goTab("step2"); }));
  const key = $("#apikey"), model = $("#model");
  if (key) { key.value = store.get("key"); model.value = store.get("model") || "claude-opus-5"; $("#savekey").addEventListener("click", guard(() => { store.set("key", key.value.trim()); store.set("model", model.value.trim() || "claude-opus-5"); renderDiag(); if (key.value.trim()) $("#keyui").open = false; if (state.pdf) renderDatasheet(); renderResult(); renderParts(); renderDebug(); toast(key.value.trim() ? "Key saved in this browser only." : "Key removed."); })); }
  document.querySelectorAll("#nav .tab").forEach((b) => b.addEventListener("click", () => goTab(b.dataset.tab)));
  loadLibrary(); setBase(window.DS2K_EXAMPLE); renderDiag(); initCapabilities(); let tab = "step2"; try { tab = localStorage.getItem("ds2k.tab") || tab; } catch (e) { /* ignore */ } if (!document.getElementById(tab)) tab = "step2"; goTab(tab);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

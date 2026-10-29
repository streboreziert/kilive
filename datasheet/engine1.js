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

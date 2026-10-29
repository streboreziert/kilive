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

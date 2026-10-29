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

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

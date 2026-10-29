/* KiLive — board model, geometry paths and texture baking */
(function () {
  'use strict';
  const N = window.Noeti;
  const rot = N.rot;

  // KiCad-ish layer palette tuned for a dark canvas
  const CU_COLORS = ['#d8544f', '#e0b73c', '#b865cf', '#3cb8a6', '#8fbf45', '#5f9be0', '#e0823c', '#cf5f96', '#6fc0d8', '#b0a060'];
  N.layerColor = function (name, cu) {
    if (name === 'F.Cu') return '#d8544f';
    if (name === 'B.Cu') return '#4f8fdc';
    const i = cu.indexOf(name);
    return CU_COLORS[1 + ((i - 1) % (CU_COLORS.length - 1))] || '#aaa';
  };

  class Board {
    constructor(data) {
      this.data = data;
      const pcb = (this.pcb = data.pcb);
      this.nets = pcb.nets;
      this.fps = pcb.fps;
      this.pads = pcb.pads;
      this.cu = pcb.meta.cu;
      this.meta = pcb.meta;
      this.bbox = pcb.meta.bbox;
      this.power = new Set(data.power || []);
      this.refIndex = new Map();
      this.fps.forEach((f, i) => { if (!this.refIndex.has(f.r)) this.refIndex.set(f.r, i); });
      this.netIndex = new Map();
      this.nets.forEach((n, i) => this.netIndex.set(n, i));
      this.shortNetIndex = new Map();
      this.nets.forEach((n, i) => { const s = N.fmt.shortNet(n); if (s && !this.shortNetIndex.has(s)) this.shortNetIndex.set(s, i); });
      this.padsByNet = new Map();
      this.pads.forEach((p, i) => {
        if (!p[10]) return;
        let a = this.padsByNet.get(p[10]);
        if (!a) this.padsByNet.set(p[10], (a = []));
        a.push(i);
      });
      // per-net track info
      this.netTracks = new Map();
      for (const L in pcb.tracks) {
        const a = pcb.tracks[L];
        for (let k = 0; k < a.length; k += 6) {
          const n = a[k + 5];
          let t = this.netTracks.get(n);
          if (!t) this.netTracks.set(n, (t = { len: 0, wmin: 1e9, wmax: 0, layers: new Set(), segs: 0 }));
          t.len += Math.hypot(a[k + 2] - a[k], a[k + 3] - a[k + 1]);
          t.wmin = Math.min(t.wmin, a[k + 4]);
          t.wmax = Math.max(t.wmax, a[k + 4]);
          t.layers.add(L);
          t.segs++;
        }
      }
      this.viaCount = new Map();
      for (const v of pcb.vias) this.viaCount.set(v[4], (this.viaCount.get(v[4]) || 0) + 1);
      // schematic lookup
      this.schParts = new Map();
      if (data.sch) for (const p of data.sch.parts) if (!this.schParts.has(p.r)) this.schParts.set(p.r, p);
      this.schSymbols = new Map(); // ref -> [{page, sym}]
      if (data.sch) data.sch.pages.forEach((pg, pi) => pg.syms.forEach((s, si) => {
        if (!s.r || s.r.startsWith('#')) return;
        let a = this.schSymbols.get(s.r);
        if (!a) this.schSymbols.set(s.r, (a = []));
        a.push({ page: pi, sym: si });
      }));
      this.checks = data.checks;
      this.bom = data.bom;
      this.stats = data.stats;
    }

    netName(i) { return this.nets[i] || ''; }
    findNet(name) {
      if (this.netIndex.has(name)) return this.netIndex.get(name);
      if (this.shortNetIndex.has(name)) return this.shortNetIndex.get(name);
      const s = N.fmt.shortNet(name);
      if (this.shortNetIndex.has(s)) return this.shortNetIndex.get(s);
      const lower = name.toLowerCase();
      for (const [n, i] of this.netIndex) if (n.toLowerCase() === lower || N.fmt.shortNet(n).toLowerCase() === lower) return i;
      return -1;
    }
    fp(ref) { const i = this.refIndex.get(ref); return i == null ? null : this.fps[i]; }
    fpIndex(ref) { const i = this.refIndex.get(ref); return i == null ? -1 : i; }
    padLabel(i) { const p = this.pads[i]; return this.fps[p[0]].r + '.' + p[1]; }
    padNet(ref, num) {
      const f = this.fp(ref);
      if (!f) return 0;
      for (const pi of f.pads) if (this.pads[pi][1] === num) return this.pads[pi][10];
      return 0;
    }
    isPower(n) { return this.power.has(n); }
    isGnd(n) { return /(^|[/_-])(A|D|P)?(GND|VSS)\w*$/i.test(N.fmt.shortNet(this.nets[n] || '')); }

    partInfo(ref) {
      const f = this.fp(ref);
      const s = this.schParts.get(ref);
      if (!f && !s) return null;
      const pins = [];
      if (f) for (const pi of f.pads) {
        const p = this.pads[pi];
        pins.push({ pin: p[1], fn: p[14], type: p[15], net: this.nets[p[10]] || '' });
      }
      return {
        ref, value: (f && f.v) || (s && s.v) || '', footprint: f ? f.fp : (s ? s.fp : ''), side: f ? (f.s ? 'bottom' : 'top') : '',
        x: f ? f.x : null, y: f ? f.y : null, desc: (s && s.desc) || (f && f.d) || '', fields: Object.assign({}, f && f.p, s && s.p),
        datasheet: s && s.ds || '', sheet: s && s.sheet || '', pins, dnp: !!((f && f.dnp) || (s && s.dnp)), cls: f && f.z ? f.z[0] : '',
      };
    }

    netInfo(n) {
      const pads = (this.padsByNet.get(n) || []).map(i => {
        const p = this.pads[i];
        return { ref: this.fps[p[0]].r, pin: p[1], fn: p[14], type: p[15], value: this.fps[p[0]].v };
      });
      const t = this.netTracks.get(n);
      return {
        name: this.nets[n], pads, padCount: pads.length, vias: this.viaCount.get(n) || 0,
        trackLen: t ? +t.len.toFixed(1) : 0, widthMin: t ? t.wmin : null, widthMax: t ? t.wmax : null,
        layers: t ? [...t.layers] : [], power: this.isPower(n), ground: this.isGnd(n),
        testpoints: pads.filter(p => /^TP\d/.test(p.ref)).map(p => p.ref),
      };
    }

    // world polygon (flat array) for a pad
    padPoly(p) {
      const [x, y, w, h, a, rr] = [p[4], p[5], p[6], p[7], p[8], p[13]];
      const shape = p[3];
      const pts = [];
      const push = (lx, ly) => { const r = rot(lx, ly, a); pts.push(x + r[0], y + r[1]); };
      if (shape === 0) {
        const r = w / 2;
        for (let i = 0; i < 20; i++) { const t = i / 20 * Math.PI * 2; pts.push(x + r * Math.cos(t), y + r * Math.sin(t)); }
        return [pts];
      }
      if (shape === 2 || shape === 3) {
        const rad = shape === 2 ? Math.min(w, h) / 2 : Math.min(w, h) * (rr || 0.25);
        const hw = w / 2, hh = h / 2;
        const corners = [[hw - rad, -hh + rad, -90], [hw - rad, hh - rad, 0], [-hw + rad, hh - rad, 90], [-hw + rad, -hh + rad, 180]];
        const seg = shape === 2 ? 8 : 4;
        for (const [cx, cy, a0] of corners) {
          for (let i = 0; i <= seg; i++) {
            const t = (a0 + 90 * i / seg) * Math.PI / 180;
            push(cx + rad * Math.cos(t), cy + rad * Math.sin(t));
          }
        }
        return [pts];
      }
      push(-w / 2, -h / 2); push(w / 2, -h / 2); push(w / 2, h / 2); push(-w / 2, h / 2);
      const out = [pts];
      if (shape === 4 && p[16]) {
        for (const poly of p[16]) {
          const q = [];
          for (let i = 0; i < poly.length; i += 2) { const r = rot(poly[i], poly[i + 1], a); q.push(x + r[0], y + r[1]); }
          out.push(q);
        }
      }
      return out;
    }

    // the drill of a pad as a closed flat polygon (world): a circle, or a slot (an oval drill) along the pad's angle
    drillPoly(p) {
      let dw = p[11] || 0, dh = p[12] || dw;
      if (!(dw > 0) && p[2] === 2) { dw = p[6]; dh = p[7] || p[6]; }
      if (!(dw > 0)) return null;
      if (Math.abs(dw - dh) < 1e-3) {
        const r = dw / 2, n = dw > 2 ? 28 : 16, pts = [];
        for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2; pts.push(p[4] + r * Math.cos(t), p[5] + r * Math.sin(t)); }
        return pts;
      }
      return this.padPoly([0, 0, 0, 2, p[4], p[5], dw, dh, p[8], 0, 0, 0, 0, 0.5])[0];
    }

    // oriented body rectangle corners (world) for a footprint
    bodyPoly(f) {
      const b = f.b;
      if (!b) return null;
      const out = [];
      for (const [lx, ly] of [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]) {
        const r = rot(lx, ly, f.a);
        out.push(f.x + r[0], f.y + r[1]);
      }
      return out;
    }

    // what the 3D views draw for every footprint: { z: [class, height, colour] | null, why }, computed once.
    // The importer guesses bodies from designator prefixes; a chip called C26 or F5 (crosspoint arrays on letter
    // designators) gets its body from the package instead. Parts parked off the board and bodies that would swallow
    // other parts (a module outline over the parts under it, an alternate footprint on top of another) are left out:
    // no model is better than a wrong one.
    bodies() {
      if (this._bodies) return this._bodies;
      const fps = this.fps, n = fps.length;
      const out = fps.map(f => ({ z: f.z && f.z[0] !== 'none' && f.z[1] ? f.z.slice() : null, why: null }));
      const NONE_KW = /mountinghole|mounting_hole|fiducial|logo|testpoint|test_point|tp_|nettie|net_tie|solderjumper|solder_jumper|jumper_sm|oshw|kibuzzard|symbol_|graphic|tag-?connect|tc20[35]0|mousebites|\blabel\b|\bqr\b/;
      const PKG = /bga|[lthv]?qfp|qfn|dfn|soic|ssop|tssop|msop|tsop|\bsop|[-_]sop|\bso-?\d|sot-?23-?[5-8]|sot-?363|sot-?353|sot-?223|\bdip-?\d|pdip|plcc|wson|uson|xson|vson|lfcsp|to-?252|to-?263|dpak/;
      const pkgH = s => /bga/.test(s) ? 1.2 : /wlcsp|csp/.test(s) ? 0.5 : /tssop|ssop|msop|tsop/.test(s) ? 1.1 : /qfp|soic|sop|so-?\d/.test(s) ? 1.5 : /qfn|dfn|son|lga/.test(s) ? 0.85 : /dip/.test(s) ? 3.3 : 1.0;
      const SMA = /(^|[^a-z])(rp-?)?sma([^a-z]|$)/;
      fps.forEach((f, i) => {
        const name = String(f.fp || '').toLowerCase(), all = name + ' ' + String(f.v || '').toLowerCase();
        const cls = f.z ? f.z[0] : 'none', np = (f.pads || []).length;
        const b = f.b, sx = b ? b[2] - b[0] : 0, sz = b ? b[3] - b[1] : 0;
        // a chip package under the wrong designator letter
        if (np >= 5 && !f.bo && PKG.test(name) && /^(cap|res|ind|diode|plastic|none)$/.test(cls) && !(cls === 'none' && NONE_KW.test(name))) out[i].z = ['ic', pkgH(name), '#1b1b1d'];
        // "smaller" is not an SMA connector
        else if (cls === 'gold' && /sma/.test(name) && !SMA.test(name)) out[i].z = /pin_?header|pin_?socket/.test(name) ? ['header', 2.5, '#1d1d20'] : ['plastic', Math.min(6, Math.max(1.2, Math.min(sx, sz) * 0.5)), '#2a2a2c'];
        if (/breadboard/.test(all) && Math.max(sx, sz) > 30) out[i].z = ['breadboard', 8.5, '#f1efe8'];
        // shield cans under their own designators: a fence, not a solid block over the parts inside
        if ((/^(SHLD|SHIELD|EMI|RFS)\d/i.test(String(f.r)) || /^SH\d/i.test(String(f.r)) && /shield|can|fence|frame|2118728/.test(name)) && out[i].z && out[i].z[0] !== 'frame' && Math.min(sx, sz) > 4) out[i].z = ['frame', Math.min(3, Math.max(1.2, out[i].z[1])), '#c3c7cc'];
        if (f.dnp) { out[i].z = null; out[i].why = 'dnp'; }
      });
      // parked outside the outline (spare parts, artwork, panel tabs)
      const loops = (this.pcb.outline && this.pcb.outline.outer) || [];
      const pip = (x, y, fl) => { let inside = false; for (let i = 0, j = fl.length - 2; i < fl.length; j = i, i += 2) { const xi = fl[i], yi = fl[i + 1], xj = fl[j], yj = fl[j + 1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
      const bb = this.bbox;
      const onBoard = (x, y) => loops.length ? loops.some(l => pip(x, y, l)) : x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3];
      // body centre and frame in world coordinates
      const geo = fps.map(f => {
        if (!f.b) return null;
        const b = f.b, bx = (b[0] + b[2]) / 2, by = (b[1] + b[3]) / 2, r = rot(bx, by, f.a);
        return { cx: f.x + r[0], cy: f.y + r[1], hx: (b[2] - b[0]) / 2, hy: (b[3] - b[1]) / 2, bx, by, a: f.a * Math.PI / 180, area: (b[2] - b[0]) * (b[3] - b[1]) };
      });
      // a part is on the board when any pad (or, without pads, its centre) is: mid-mount connectors hang over the edge
      const off = [];
      fps.forEach((f, i) => {
        if (!out[i].z || !geo[i]) return;
        const pads = (f.pads || []).map(pi => this.pads[pi]);
        const on = pads.length ? pads.some(p => onBoard(p[4], p[5]) || onBoard(p[4] + 0.4, p[5]) || onBoard(p[4] - 0.4, p[5]) || onBoard(p[4], p[5] + 0.4) || onBoard(p[4], p[5] - 0.4)) : onBoard(geo[i].cx, geo[i].cy);
        if (!on) off.push(i);
      });
      // many parts "off the board" means the outline is what is off (an unclosed or partial Edge.Cuts): keep them all
      if (off.length <= Math.max(2, n * 0.08)) for (const i of off) { out[i].z = null; out[i].why = 'off-board'; }
      // clashes, side by side: a body whose box holds the centre of another real part
      const REAL = /^(res|cap|ind|led|diode|ic|tant|xtal|elco|switch|metal|plastic|module|gold)$/;
      const inside = (gc, f, x, y, shrink) => {
        const dx = x - f.x, dy = y - f.y, ca = Math.cos(gc.a), sa = Math.sin(gc.a);
        const lx = dx * ca - dy * sa - gc.bx, ly = dx * sa + dy * ca - gc.by;
        return Math.abs(lx) < gc.hx * shrink && Math.abs(ly) < gc.hy * shrink;
      };
      for (const side of [0, 1]) {
        const list = [];
        for (let i = 0; i < n; i++) if (out[i].z && geo[i] && fps[i].s === side && geo[i].area > 0.3) list.push(i);
        list.sort((a, c) => geo[c].area - geo[a].area);
        for (let k = 0; k < list.length; k++) {
          const i = list[k], gi = geo[i];
          if (!out[i].z) continue;
          // fences, pin rows and key switches (the keycap outline over its diode) keep their place
          const ci = out[i].z[0];
          if (ci === 'frame' || ci === 'header' || ci === 'switch' || ci === 'breadboard' || /cherry|kailh|gateron|choc|\bmx\b|mx_|hotswap|keyswitch|\bulp/.test(String(fps[i].fp || '').toLowerCase())) continue;
          for (let q = k + 1; q < list.length; q++) {
            const j = list[q];
            if (!out[j].z || !REAL.test(out[j].z[0])) continue;
            const gj = geo[j];
            if (!inside(gi, fps[i], gj.cx, gj.cy, 0.92)) continue;
            if (gj.area * 4 <= gi.area) { out[i].z = null; out[i].why = 'covers ' + fps[j].r; break; }
            // two footprints for one place (alternates): keep the one with more pads, else the first
            if (inside(gj, fps[j], gi.cx, gi.cy, 0.92)) {
              const drop = (fps[j].pads || []).length > (fps[i].pads || []).length ? i : j;
              out[drop].z = null; out[drop].why = 'overlaps ' + fps[drop === i ? j : i].r;
              if (drop === i) break;
            }
          }
        }
      }
      return (this._bodies = out);
    }

    padOnLayer(p, li) {
      const m = p[9];
      const last = this.cu.length - 1;
      if (li === 0) return !!(m & 1);
      if (li === last) return !!(m & 2);
      return !!(m & 4);
    }
  }
  N.Board = Board;

  // ---------------------------------------------------------------------------------- Path building
  function polyPath(path, flat) {
    if (flat.length < 4) return;
    path.moveTo(flat[0], flat[1]);
    for (let i = 2; i < flat.length; i += 2) path.lineTo(flat[i], flat[i + 1]);
    path.closePath();
  }
  N.polyPath = polyPath;

  N.buildPaths = function (B) {
    if (B._paths) return B._paths;
    const pcb = B.pcb;
    const P = { zones: {}, tracks: {}, pads: {}, tht: new Path2D(), vias: new Path2D(), viaHoles: new Path2D(), holes: new Path2D(), npth: new Path2D(),
      gfx: {}, texts: {}, outline: new Path2D(), cuGfx: {}, maskOpen: { F: new Path2D(), B: new Path2D() } };
    for (const L of B.cu) { P.zones[L] = new Path2D(); P.tracks[L] = new Map(); P.pads[L] = new Path2D(); P.cuGfx[L] = new Path2D(); }
    for (const z of pcb.zones) { if (P.zones[z.l]) polyPath(P.zones[z.l], z.p); }
    for (const L in pcb.tracks) {
      if (!P.tracks[L]) continue;
      const a = pcb.tracks[L];
      const byW = P.tracks[L];
      for (let k = 0; k < a.length; k += 6) {
        const w = a[k + 4];
        let path = byW.get(w);
        if (!path) byW.set(w, (path = new Path2D()));
        path.moveTo(a[k], a[k + 1]);
        path.lineTo(a[k + 2], a[k + 3]);
      }
    }
    const last = B.cu.length - 1;
    B.pads.forEach(p => {
      const polys = B.padPoly(p);
      if (p[2] === 2) { // NPTH (round, or a slot)
        const dw = p[11] || p[6], dh = p[12] || dw;
        if (Math.abs(dw - dh) < 1e-3) { const r = dw / 2; P.npth.moveTo(p[4] + r, p[5]); P.npth.arc(p[4], p[5], r, 0, Math.PI * 2); }
        else { const dp = B.drillPoly(p); if (dp) polyPath(P.npth, dp); }
        if (!(p[9] & 3)) return;
      }
      const through = p[2] === 1 || (p[9] & 3) === 3;
      if (through) for (const poly of polys) polyPath(P.tht, poly);
      B.cu.forEach((L, li) => {
        if (B.padOnLayer(p, li)) for (const poly of polys) polyPath(P.pads[L], poly);
      });
      if (p[9] & 8) for (const poly of polys) polyPath(P.maskOpen.F, poly);
      if (p[9] & 16) for (const poly of polys) polyPath(P.maskOpen.B, poly);
      if (p[11] > 0 && p[2] !== 2) {
        const dw = p[11], dh = p[12] || p[11];
        if (Math.abs(dw - dh) < 1e-3) { const r = dw / 2; P.holes.moveTo(p[4] + r, p[5]); P.holes.arc(p[4], p[5], r, 0, Math.PI * 2); }
        else {
          const fake = [0, 0, 0, 2, p[4], p[5], dw, dh, p[8], 0, 0, 0, 0, 0.5];
          polyPath(P.holes, B.padPoly(fake)[0]);
        }
      }
    });
    for (const v of pcb.vias) {
      const r = v[2] / 2, d = v[3] / 2;
      P.vias.moveTo(v[0] + r, v[1]); P.vias.arc(v[0], v[1], r, 0, Math.PI * 2);
      P.viaHoles.moveTo(v[0] + d, v[1]); P.viaHoles.arc(v[0], v[1], d, 0, Math.PI * 2);
    }
    for (const L in pcb.gfx) {
      const g = pcb.gfx[L];
      const lines = new Map();
      const fills = new Path2D();
      const strokes = new Map();
      for (let k = 0; k < g.lines.length; k += 5) {
        const w = g.lines[k + 4] || 0.1;
        let path = lines.get(w);
        if (!path) lines.set(w, (path = new Path2D()));
        path.moveTo(g.lines[k], g.lines[k + 1]);
        path.lineTo(g.lines[k + 2], g.lines[k + 3]);
      }
      for (const poly of g.polys) {
        if (poly.f) polyPath(fills, poly.p);
        const w = poly.w || (poly.f ? 0 : 0.1);
        if (w > 0) {
          let path = strokes.get(w);
          if (!path) strokes.set(w, (path = new Path2D()));
          polyPath(path, poly.p);
        }
      }
      for (let k = 0; k < g.circles.length; k += 5) {
        const [cx, cy, r, w, f] = g.circles.slice(k, k + 5);
        if (f) { fills.moveTo(cx + r, cy); fills.arc(cx, cy, r, 0, Math.PI * 2); }
        const ww = w || 0.1;
        let path = strokes.get(ww);
        if (!path) strokes.set(ww, (path = new Path2D()));
        path.moveTo(cx + r, cy); path.arc(cx, cy, r, 0, Math.PI * 2);
      }
      P.gfx[L] = { lines, fills, strokes };
      P.texts[L] = g.texts;
      if (L.endsWith('.Cu') && P.cuGfx[L]) P.cuGfx[L].addPath(fills);
    }
    for (const l of pcb.outline.outer) polyPath(P.outline, l);
    for (const l of pcb.outline.holes) polyPath(P.outline, l);
    B._paths = P;
    return P;
  };

  N.strokeGfx = function (ctx, g, minW) {
    if (!g) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [w, path] of g.lines) { ctx.lineWidth = Math.max(w, minW || 0); ctx.stroke(path); }
    for (const [w, path] of g.strokes) { ctx.lineWidth = Math.max(w, minW || 0); ctx.stroke(path); }
    ctx.fill(g.fills);
  };

  N.strokeTracks = function (ctx, byW, minW) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [w, path] of byW) { ctx.lineWidth = Math.max(w, minW || 0); ctx.stroke(path); }
  };

  // Draw board text items in world space (ctx already transformed to world); mirrored for bottom-side silk
  N.drawTexts = function (ctx, texts, opts) {
    if (!texts) return;
    const scale = opts.scale || 1; // screen px per mm, for culling
    ctx.textBaseline = 'middle';
    for (const t of texts) {
      const [str, x, y, size, ang, just, mirror] = t;
      if (size * scale < (opts.minPx || 3)) continue;
      ctx.save();
      ctx.translate(x, y);
      let a = ang;
      // keep text upright (KiCad keeps silk text readable)
      a = ((a % 360) + 360) % 360;
      if (a > 90 && a <= 270) a -= 180;
      ctx.rotate(-a * Math.PI / 180);
      if (mirror || opts.mirror) ctx.scale(-1, 1);
      ctx.font = `500 ${size * 1.08}px ${opts.font || 'ui-monospace, Menlo, monospace'}`;
      ctx.textAlign = just.includes('l') ? 'left' : just.includes('r') ? 'right' : 'center';
      const lines = String(str).split('\n');
      lines.forEach((ln, i) => ctx.fillText(ln, 0, (i - (lines.length - 1) / 2) * size * 1.4));
      ctx.restore();
    }
  };

  // ---------------------------------------------------------------------------------- Texture baking for 3D
  function mix(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
    const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
    const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
  }
  N.mixColor = mix;

  N.finishColor = function (finish) {
    const f = (finish || '').toLowerCase();
    if (f.includes('enig') || f.includes('gold') || f.includes('enepig')) return '#d8b25a';
    if (f.includes('hasl') || f.includes('tin') || f.includes('silver') || f.includes('immersion')) return '#c9ccd0';
    return '#d8b25a';
  };

  /**
   * Bake a board side into canvases (color + material) sized to the board bbox.
   * opts: {side:'F'|'B', pxPerMm, highlightNets:Set, highlightRefs:Set}
   */
  N.bakeBoardTexture = function (B, opts) {
    const P = N.buildPaths(B);
    const side = opts.side;
    const bb = B.bbox;
    const pad = 0.5;
    const wmm = bb[2] - bb[0] + pad * 2, hmm = bb[3] - bb[1] + pad * 2;
    const s = opts.pxPerMm;
    const W = Math.max(64, Math.round(wmm * s)), H = Math.max(64, Math.round(hmm * s));
    const cv = opts.canvas || document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(W / wmm, 0, 0, H / hmm, (-bb[0] + pad) * W / wmm, (-bb[1] + pad) * H / hmm);
    const mask = B.meta.mask;
    const silk = B.meta.silk;
    const cuName = side === 'F' ? 'F.Cu' : 'B.Cu';
    const light = mask === '#ecebe6' ? true : parseInt(mask.slice(1, 3), 16) + parseInt(mask.slice(3, 5), 16) + parseInt(mask.slice(5, 7), 16) > 560;
    const underMask = light ? mix(mask, '#b8a27a', 0.35) : mix(mask, '#ffffff', 0.16);
    const planeMask = light ? mix(mask, '#b8a27a', 0.18) : mix(mask, '#ffffff', 0.07);
    const metal = N.finishColor(B.meta.finish);

    // board substrate + mask
    ctx.save();
    ctx.clip(P.outline, 'evenodd');
    ctx.fillStyle = mask;
    ctx.fillRect(bb[0] - 5, bb[1] - 5, wmm + 10, hmm + 10);
    // copper under mask
    ctx.fillStyle = planeMask;
    ctx.fill(P.zones[cuName]);
    ctx.strokeStyle = underMask;
    N.strokeTracks(ctx, P.tracks[cuName]);
    ctx.fillStyle = underMask;
    ctx.fill(P.pads[cuName]);
    ctx.fill(P.cuGfx[cuName]);
    ctx.fill(P.vias);
    // baked contact shadows of parts on this side
    const sideIdx = side === 'F' ? 0 : 1;
    if (opts.shadows !== false) {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      for (const f of B.fps) {
        if (f.s !== sideIdx || !f.z || f.z[0] === 'none' || !f.b) continue;
        const poly = B.bodyPoly(f);
        if (!poly) continue;
        const grow = Math.min(1.2, 0.25 + f.z[1] * 0.18);
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(-f.a * Math.PI / 180);
        ctx.globalAlpha = Math.min(0.55, 0.18 + f.z[1] * 0.05);
        const b = f.b;
        const r = Math.min(grow, (b[2] - b[0]) / 2);
        roundRect(ctx, b[0] - grow * 0.6, b[1] - grow * 0.6, b[2] - b[0] + grow * 1.2, b[3] - b[1] + grow * 1.2, r);
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    // exposed copper (mask openings)
    ctx.save();
    ctx.clip(P.maskOpen[side]);
    ctx.fillStyle = metal;
    ctx.fill(P.pads[cuName]);
    ctx.restore();
    // silkscreen
    ctx.fillStyle = silk;
    ctx.strokeStyle = silk;
    const silkL = side === 'F' ? 'F.SilkS' : 'B.SilkS';
    N.strokeGfx(ctx, P.gfx[silkL], 0.1);
    N.drawTexts(ctx, P.texts[silkL], { scale: s, minPx: 2, mirror: false });
    // re-expose pads over silk (silk is clipped by pads in fabrication)
    ctx.save();
    ctx.clip(P.maskOpen[side]);
    ctx.fillStyle = metal;
    ctx.fill(P.pads[cuName]);
    ctx.restore();
    // via holes (plugged look)
    ctx.fillStyle = light ? '#5a5144' : '#101214';
    ctx.fill(P.viaHoles);
    // highlight overlays
    if (opts.highlightNets && opts.highlightNets.size) {
      ctx.fillStyle = '#ffd21f';
      ctx.strokeStyle = '#ffd21f';
      drawNetCopper(ctx, B, opts.highlightNets, cuName);
    }
    if (opts.highlightRefs && opts.highlightRefs.size) {
      ctx.strokeStyle = '#ffd21f';
      ctx.lineWidth = Math.max(0.15, 2 / s);
      for (const r of opts.highlightRefs) {
        const f = B.fp(r);
        if (!f || f.s !== sideIdx) continue;
        const poly = f.c && f.c.length >= 6 ? f.c : B.bodyPoly(f);
        if (!poly) continue;
        const pth = new Path2D();
        polyPath(pth, poly);
        ctx.stroke(pth);
      }
    }
    ctx.restore();
    // punch drill holes
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fill(P.holes);
    ctx.fill(P.npth);
    ctx.globalCompositeOperation = 'source-over';

    // material map (R = metallic, G = roughness) at half resolution
    const mv = opts.matCanvas || document.createElement('canvas');
    const mW = Math.max(32, W >> 1), mH = Math.max(32, H >> 1);
    mv.width = mW; mv.height = mH;
    const m = mv.getContext('2d');
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.fillStyle = 'rgb(0,90,0)';
    m.fillRect(0, 0, mW, mH);
    m.setTransform(mW / wmm, 0, 0, mH / hmm, (-bb[0] + pad) * mW / wmm, (-bb[1] + pad) * mH / hmm);
    m.fillStyle = 'rgb(0,200,0)';
    N.strokeGfx(m, P.gfx[silkL], 0.1);
    m.strokeStyle = 'rgb(0,200,0)';
    m.save();
    m.clip(P.maskOpen[side]);
    m.fillStyle = 'rgb(255,70,0)';
    m.fill(P.pads[cuName]);
    m.restore();
    return { canvas: cv, mat: mv, wmm, hmm, x0: bb[0] - pad, y0: bb[1] - pad };
  };

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  N.roundRect = roundRect;

  function drawNetCopper(ctx, B, nets, layerName) {
    const pcb = B.pcb;
    const a = pcb.tracks[layerName] || [];
    ctx.lineCap = 'round';
    for (let k = 0; k < a.length; k += 6) {
      if (!nets.has(a[k + 5])) continue;
      ctx.lineWidth = a[k + 4];
      ctx.beginPath();
      ctx.moveTo(a[k], a[k + 1]);
      ctx.lineTo(a[k + 2], a[k + 3]);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.55;
    for (const z of pcb.zones) {
      if (z.l !== layerName || !nets.has(z.n)) continue;
      const pth = new Path2D();
      polyPath(pth, z.p);
      ctx.fill(pth);
    }
    ctx.globalAlpha = 1;
    const li = B.cu.indexOf(layerName);
    for (const n of nets) {
      for (const pi of B.padsByNet.get(n) || []) {
        const p = B.pads[pi];
        if (!B.padOnLayer(p, li)) continue;
        for (const poly of B.padPoly(p)) { const pth = new Path2D(); polyPath(pth, poly); ctx.fill(pth); }
      }
    }
    for (const v of pcb.vias) {
      if (!nets.has(v[4])) continue;
      ctx.beginPath();
      ctx.arc(v[0], v[1], v[2] / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  N.drawNetCopper = drawNetCopper;
})();

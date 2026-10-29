/* KiLive — live mode: runs the circuit continuously (N.LiveSim) and paints it on the schematic, PCB and 3D views,
   Falstad style: voltages as colours, currents as moving dots, controls and faults while it runs. */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const I = N.icons;

  // ------------------------------------------------------------------ colours and dot speed
  const hexRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const SCHEMES = {
    dark: { zero: hexRgb('#7c858d'), pos: hexRgb('#39e07f'), neg: hexRgb('#ff5c4d'), dot: '#ffd21f', dotEdge: 'rgba(0,0,0,0.55)' },
    light: { zero: hexRgb('#9aa0a6'), pos: hexRgb('#0c9f4d'), neg: hexRgb('#d6392c'), dot: '#f59b00', dotEdge: 'rgba(60,40,0,0.55)' },
  };
  N.liveScheme = name => SCHEMES[name] || SCHEMES.dark;
  N.liveColor = function (v, vmax, scheme, alpha) {
    const S = typeof scheme === 'string' ? SCHEMES[scheme] : scheme || SCHEMES.dark;
    const t = Math.max(-1, Math.min(1, v / (vmax || 1)));
    const c = t >= 0 ? S.pos : S.neg, k = Math.abs(t);
    const r = Math.round(S.zero[0] + (c[0] - S.zero[0]) * k), g = Math.round(S.zero[1] + (c[1] - S.zero[1]) * k), b = Math.round(S.zero[2] + (c[2] - S.zero[2]) * k);
    return alpha == null ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
  };
  // dot speed in "dot spacings per second": logarithmic so microamps and amps both move visibly
  N.liveRate = function (i) {
    const a = Math.abs(i);
    if (!(a > 2e-7)) return 0;
    return Math.sign(i) * Math.min(3.2, 0.25 + 0.55 * Math.log10(a / 2e-7));
  };
  const frac = p => p - Math.floor(p);
  // quantised palettes (129 steps from -vmax to +vmax) so a frame reuses colour strings
  const PAL = {};
  N.livePalette = function (name) {
    if (PAL[name]) return PAL[name];
    const a = [];
    for (let k = 0; k <= 128; k++) a.push(N.liveColor((k - 64) / 64, 1, name));
    a[254] = name === 'light' ? '#9c8cc4' : '#7d6aa8';   // floating nets
    a[253] = name === 'light' ? '#c3c9cf' : '#4b5866';   // not driven on this board: off-board, an idle processor pin, a chip not simulated
    return (PAL[name] = a);
  };
  N.liveIdx = (v, vmax) => Math.max(0, Math.min(128, Math.round(64 + 64 * v / (vmax || 1))));

  // ------------------------------------------------------------------ current flow on wire networks (tree flow)
  class FlowGraph {
    constructor() { this.keys = new Map(); this.x = []; this.y = []; this.ea = []; this.eb = []; this.eseg = []; this.adj = []; }
    node(key, x, y) {
      let i = this.keys.get(key);
      if (i === undefined) { i = this.x.length; this.keys.set(key, i); this.x.push(x); this.y.push(y); this.adj.push([]); }
      return i;
    }
    edge(a, b, seg) {
      if (a === b) return;
      const e = this.ea.length;
      this.ea.push(a); this.eb.push(b); this.eseg.push(seg);
      this.adj[a].push(e); this.adj[b].push(e);
    }
    finish() {
      const n = this.x.length;
      this.order = new Int32Array(n); this.parent = new Int32Array(n).fill(-1); this.pedge = new Int32Array(n).fill(-1);
      const seen = new Uint8Array(n);
      let o = 0;
      for (let s = 0; s < n; s++) {
        if (seen[s]) continue;
        seen[s] = 1; this.order[o++] = s;
        for (let h = o - 1; h < o; h++) {
          const u = this.order[h];
          for (const e of this.adj[u]) {
            const v = this.ea[e] === u ? this.eb[e] : this.ea[e];
            if (seen[v]) continue;
            seen[v] = 1; this.parent[v] = u; this.pedge[v] = e; this.order[o++] = v;
          }
        }
      }
      this.sub = new Float64Array(n);
      this.ecur = new Float64Array(this.ea.length);
      this.adj = null;
      return this;
    }
    // inj: current entering the network at each node; returns current along each edge from ea to eb
    solve(inj) {
      const sub = this.sub, ecur = this.ecur, order = this.order, parent = this.parent, pedge = this.pedge;
      sub.set(inj);
      ecur.fill(0);
      for (let k = order.length - 1; k >= 0; k--) {
        const v = order[k], p = parent[v];
        if (p < 0) continue;
        const e = pedge[v];
        ecur[e] = this.ea[e] === v ? sub[v] : -sub[v];
        sub[p] += sub[v];
      }
      return ecur;
    }
  }
  N.FlowGraph = FlowGraph;

  // PCB copper: N.pcbFlow / N.pcbFlowUpdate (copperflow.js) solve each net as a resistor network

  // schematic page: wires joined at ends (and T-junctions), pins and labels on wire ends
  N.schFlow = function (B, pg, dl) {
    const q = v => Math.round(v * 100);
    const w = pg.wires;
    const n = w.length / 4;
    // split wires at T-junction points
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([w[i * 4], w[i * 4 + 1]], [w[i * 4 + 2], w[i * 4 + 3]]);
    for (const p of dl.pins) pts.push([p.x, p.y]);
    for (const l of dl.labels) pts.push([l.x, l.y]);
    for (let i = 0; i < (pg.junctions || []).length; i += 2) pts.push([pg.junctions[i], pg.junctions[i + 1]]);
    const segs = [];
    for (let i = 0; i < n; i++) {
      const x1 = w[i * 4], y1 = w[i * 4 + 1], x2 = w[i * 4 + 2], y2 = w[i * 4 + 3];
      const L = Math.hypot(x2 - x1, y2 - y1);
      if (L < 1e-6) continue;
      const cuts = [0, 1];
      for (const [px, py] of pts) {
        const t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / (L * L);
        if (t <= 1e-4 || t >= 1 - 1e-4) continue;
        const cx = x1 + t * (x2 - x1), cy = y1 + t * (y2 - y1);
        if (Math.hypot(px - cx, py - cy) < 0.02) cuts.push(t);
      }
      cuts.sort((a, b) => a - b);
      for (let k = 0; k + 1 < cuts.length; k++) if (cuts[k + 1] - cuts[k] > 1e-6) segs.push(x1 + cuts[k] * (x2 - x1), y1 + cuts[k] * (y2 - y1), x1 + cuts[k + 1] * (x2 - x1), y1 + cuts[k + 1] * (y2 - y1));
    }
    const g = new FlowGraph();
    const ns = segs.length / 4;
    for (let s = 0; s < ns; s++) g.edge(g.node(q(segs[s * 4]) + ':' + q(segs[s * 4 + 1]), segs[s * 4], segs[s * 4 + 1]), g.node(q(segs[s * 4 + 2]) + ':' + q(segs[s * 4 + 3]), segs[s * 4 + 2], segs[s * 4 + 3]), s);
    const pinNodes = [];
    for (const p of dl.pins) { const k = q(p.x) + ':' + q(p.y); const nd = g.keys.get(k); if (nd != null) pinNodes.push([p, nd]); else pinNodes.push([p, -1]); }
    const portNodes = [];
    dl.labels.forEach(l => { const nd = g.keys.get(q(l.x) + ':' + q(l.y)); if (nd != null) portNodes.push(nd); });
    for (const sh of pg.sheets || []) for (const sp of sh.pins) { const nd = g.keys.get(q(sp[1]) + ':' + q(sp[2])); if (nd != null) portNodes.push(nd); }
    g.finish();
    // the net of each connected piece: from a pin that is on the PCB, else from a label
    const comp = new Int32Array(g.x.length).fill(-1);
    for (let k = 0; k < g.order.length; k++) { const v = g.order[k]; comp[v] = g.parent[v] < 0 ? v : comp[g.parent[v]]; }
    const compNet = new Map();
    for (const [p, nd] of pinNodes) { if (nd < 0 || compNet.has(comp[nd])) continue; const net = B.padNet(p.ref, p.num); if (net) compNet.set(comp[nd], net); }
    dl.labels.forEach(l => { const nd = g.keys.get(q(l.x) + ':' + q(l.y)); if (nd == null || compNet.has(comp[nd])) return; const net = B.findNet(l.txt); if (net > 0) compNet.set(comp[nd], net); });
    // power symbols act as labels: their pin joins the net by name
    for (const it of dl.syms) {
      if (!it.s.r || !it.s.r.startsWith('#')) continue;
      for (const p of it.pins) { const nd = g.keys.get(q(p.S[0]) + ':' + q(p.S[1])); if (nd == null) continue; portNodes.push(nd); if (!compNet.has(comp[nd])) { const net = B.findNet(it.s.v); if (net > 0) compNet.set(comp[nd], net); } }
    }
    const junc = [];
    for (let i = 0; i < (pg.junctions || []).length; i += 2) { const nd = g.keys.get(q(pg.junctions[i]) + ':' + q(pg.junctions[i + 1])); const net = nd != null ? compNet.get(comp[nd]) : 0; if (net) junc.push(pg.junctions[i], pg.junctions[i + 1], net); }
    const segNet = new Int32Array(ns);
    for (let e = 0; e < g.ea.length; e++) { const s = g.eseg[e]; if (s >= 0) segNet[s] = compNet.get(comp[g.ea[e]]) || 0; }
    // component pins: tip S -> body end E
    const legs = [];
    for (const it of dl.syms) { if (!it.s.r || it.s.r.startsWith('#')) continue; for (const p of it.pins) legs.push({ ref: it.s.r, num: p.num, S: p.S, E: p.E, net: B.padNet(it.s.r, p.num) }); }
    return { g, segs: Float32Array.from(segs), ns, segNet, segI: new Float32Array(ns), phase: new Float32Array(ns), pinNodes, portNodes, comp, compNet, inj: new Float64Array(g.x.length), legs, legPhase: new Float32Array(legs.length), legI: new Float32Array(legs.length), junc };
  };
  N.schFlowUpdate = function (F, live) {
    const inj = F.inj;
    inj.fill(0);
    for (const [p, nd] of F.pinNodes) if (nd >= 0 && !p.ref.startsWith('#')) inj[nd] -= live.padI(p.ref, p.num) || 0;
    // what a piece of wire does not balance flows through its labels / power symbols / sheet pins
    const bal = new Map(), ports = new Map();
    for (let v = 0; v < inj.length; v++) { const c = F.comp[v]; bal.set(c, (bal.get(c) || 0) + inj[v]); }
    for (const nd of F.portNodes) { const c = F.comp[nd]; ports.set(c, (ports.get(c) || 0) + 1); }
    for (const nd of F.portNodes) { const c = F.comp[nd]; inj[nd] -= bal.get(c) / ports.get(c); }
    const ec = F.g.solve(inj);
    F.segI.fill(0);
    for (let e = 0; e < ec.length; e++) { const s = F.g.eseg[e]; if (s >= 0) F.segI[s] = ec[e]; }
    F.legs.forEach((lg, k) => { F.legI[k] = live.padI(lg.ref, lg.num) || 0; });
  };

  // dots along a segment list: positions every `spacing` world units, advanced by `phase`
  N.drawDots = function (ctx, x1, y1, x2, y2, phase, spacing, r) {
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
    if (L < 1e-9) return;
    const ux = dx / L, uy = dy / L;
    for (let d = frac(phase) * spacing; d < L; d += spacing) { ctx.moveTo(x1 + ux * d + r, y1 + uy * d); ctx.arc(x1 + ux * d, y1 + uy * d, r, 0, Math.PI * 2); }
  };

  // ------------------------------------------------------------------ board painters (PCB view and the 3D texture share them)
  // copper of every net, per layer, as paths
  N.liveNetPaths = function (B) {
    if (B._liveNet) return B._liveNet;
    const pcb = B.pcb, nets = new Map();
    const get = n => { let o = nets.get(n); if (!o) nets.set(n, (o = { t: {}, z: {}, p: {}, v: null })); return o; };
    for (const L in pcb.tracks) {
      const a = pcb.tracks[L];
      for (let k = 0; k < a.length; k += 6) {
        const n = a[k + 5];
        if (!n) continue;
        const o = get(n);
        const m = o.t[L] || (o.t[L] = new Map());
        let pth = m.get(a[k + 4]);
        if (!pth) m.set(a[k + 4], (pth = new Path2D()));
        pth.moveTo(a[k], a[k + 1]); pth.lineTo(a[k + 2], a[k + 3]);
      }
    }
    for (const z of pcb.zones) { if (!z.n) continue; const o = get(z.n); N.polyPath(o.z[z.l] || (o.z[z.l] = new Path2D()), z.p); }
    B.pads.forEach(p => {
      if (!p[10]) return;
      const o = get(p[10]);
      const polys = B.padPoly(p);
      B.cu.forEach((L, li) => { if (!B.padOnLayer(p, li)) return; const pth = o.p[L] || (o.p[L] = new Path2D()); for (const poly of polys) N.polyPath(pth, poly); });
    });
    for (const v of pcb.vias) { if (!v[4]) continue; const o = get(v[4]); const pth = o.v || (o.v = new Path2D()); pth.moveTo(v[0] + v[2] / 2, v[1]); pth.arc(v[0], v[1], v[2] / 2, 0, Math.PI * 2); }
    const air = new Map();
    const A = pcb.air || [];
    for (let k = 0; k + 4 < A.length; k += 5) { let pth = air.get(A[k + 4]); if (!pth) air.set(A[k + 4], (pth = new Path2D())); pth.moveTo(A[k], A[k + 1]); pth.lineTo(A[k + 2], A[k + 3]); }
    B._liveNet = { nets, air };
    return B._liveNet;
  };

  // voltage-coloured copper; layers = [{name, alpha}] back to front; ctx is in board millimetres
  N.paintLiveCopper = function (ctx, B, live, layers, o) {
    const P = N.liveNetPaths(B);
    const pal = N.livePalette(o.scheme || 'dark');
    const vm = live.vmax, V = live.netV;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const CI = live.colIdx;
    const idx = n => { if (CI) return CI[n]; const v = V[n]; return v === v ? N.liveIdx(v, vm) : 255; };
    const fcol = N.liveFloatColor ? N.liveFloatColor(o.scheme) : '#7d6aa8';
    for (const { name, alpha } of layers) {
      for (const [n, np] of P.nets) {
        const k = idx(n);
        if (k === 255) continue;
        const col = k === 254 ? fcol : pal[k];
        const z = np.z[name], t = np.t[name], p = np.p[name];
        if (!z && !t && !p) continue;
        ctx.fillStyle = ctx.strokeStyle = col;
        if (z && o.zones !== false) { ctx.globalAlpha = alpha * (o.zoneAlpha || 0.34); ctx.fill(z); }
        ctx.globalAlpha = alpha;
        if (t && o.tracks !== false) for (const [w, pth] of t) { ctx.lineWidth = Math.max(w, o.minW || 0); ctx.stroke(pth); }
        if (p && o.pads !== false) ctx.fill(p);
      }
    }
    ctx.globalAlpha = 1;
    if (o.vias !== false) for (const [n, np] of P.nets) { if (!np.v) continue; const k = idx(n); if (k === 255) continue; ctx.fillStyle = k === 254 ? fcol : pal[k]; ctx.fill(np.v); }
    if (o.air && P.air.size) {
      ctx.lineWidth = o.airW || 0.2;
      for (const [n, pth] of P.air) { const k = idx(n); ctx.strokeStyle = k === 254 ? fcol : k !== 255 ? pal[k] : 'rgba(150,215,255,0.5)'; ctx.stroke(pth); }
    }
  };

  // advance the dot phases once per simulation frame
  function stepPhases(F, live) {
    if (F.frame === live.frameId) return;
    const first = F.frame == null;
    F.frame = live.frameId;
    if (F.gen !== live.gen) { F.gen = live.gen; }
    F.update(live);
    if (first) return;
    const w = live.running ? live.wall || 0 : 0;
    if (!w) return;
    const ph = F.phase, I = F.segI;
    for (let s = 0; s < ph.length; s++) if (I[s]) ph[s] += N.liveRate(I[s]) * w;
    if (F.legPhase) { const lp = F.legPhase, li = F.legI, ls = F.legSum, kd = F.legKind; for (let k = 0; k < lp.length; k++) { const I = kd && kd[k] === 1 ? ls[k] : li[k]; if (I) lp[k] += N.liveRate(I) * w; } }
  }
  N.liveStepPhases = stepPhases;

  // current dots along the copper and into the parts.
  // o: { layers: Set(layer index, -1 = unrouted lines), front: the layer nearest the viewer (others are drawn faint and smaller),
  //      side, spacing, r (world units), rect: [x0, y0, x1, y1], legs: false | true (two-terminal parts pad to pad; stubs: true adds pins of bigger parts), only: 'near' | 'far', min: smallest current shown (A) }
  N.paintLiveDots = function (ctx, B, live, o) {
    const F = N.pcbFlow(B);
    if (!F.update) F.update = l => N.pcbFlowUpdate(B, F, l);
    stepPhases(F, live);
    const S = F.segs, sp = o.spacing, r = o.r, R = o.rect, min = o.min || 1e-6;
    const near = new Path2D(), far = new Path2D();
    let n = 0, nFar = 0;
    for (let s = 0; s < F.nseg; s++) {
      const I = F.segI[s];
      if (!(Math.abs(I) >= min)) continue;
      const li = S[s * 6 + 5];
      if (!o.layers.has(li)) continue;
      const x1 = S[s * 6], y1 = S[s * 6 + 1], x2 = S[s * 6 + 2], y2 = S[s * 6 + 3];
      if (R && (Math.max(x1, x2) < R[0] || Math.min(x1, x2) > R[2] || Math.max(y1, y2) < R[1] || Math.min(y1, y2) > R[3])) continue;
      // straight unrouted links (a pour the file leaves unfilled, a ratsnest line) show faint; on a board drawn here they are the copper
      const front = li === -1 ? !!F.airOnly : o.front == null || li === o.front;
      // drawn in two passes: copper further from the viewer goes under the front copper, so it only shows through gaps
      if (o.only === 'far' ? front : o.only === 'near' && !front) continue;
      // a little bigger for more current: 1 µA 0.8×, 100 mA 1.25×
      const k = 0.8 + 0.09 * Math.max(0, Math.min(5, Math.log10(Math.abs(I) / 1e-6)));
      N.drawDots(front ? near : far, x1, y1, x2, y2, F.phase[s], sp, r * k * (front ? 1 : 0.7));
      if (front) n++; else nFar++;
      if (n + nFar > 9000) break;
    }
    if (o.legs !== false && o.only !== 'far') {
      const lg = F.legs, kd = F.legKind, mt = F.legMate, cuN = B.cu.length;
      for (let k = 0; k < F.legI.length; k++) {
        const K = kd ? kd[k] : 0;
        // a pin of a bigger part: its current stops at the pad (a line into the body would run across whatever copper is under it)
        if (K === 2 || (K === 0 && !o.stubs)) continue;
        const I = K === 1 ? F.legSum[k] : F.legI[k];
        if (!(Math.abs(I) >= min)) continue;
        const p = B.pads[lg[k * 2]], f = B.fps[lg[k * 2 + 1]];
        if (o.side != null && f.s !== o.side && p[2] !== 1) continue;
        // only where the pad's copper layer is shown
        if (p[2] !== 1 && !o.layers.has(f.s ? cuN - 1 : 0)) continue;
        if (R && (p[4] < R[0] || p[4] > R[2] || p[5] < R[1] || p[5] > R[3])) continue;
        if (K === 1) { const q = B.pads[lg[mt[k] * 2]]; N.drawDots(near, p[4], p[5], q[4], q[5], F.legPhase[k], sp * 0.6, r * 0.75); continue; }
        // a pin of a bigger part: a short stub into its body
        const dx = f.x - p[4], dy = f.y - p[5], d = Math.hypot(dx, dy) || 1, len = Math.min(d * 0.45, 1.2);
        N.drawDots(near, p[4], p[5], p[4] + dx / d * len, p[5] + dy / d * len, F.legPhase[k], sp * 0.45, r * 0.7);
      }
    }
    ctx.fillStyle = o.dot || '#ffd21f';
    if (nFar) { ctx.globalAlpha = o.farAlpha || 0.38; ctx.fill(far); ctx.globalAlpha = 1; }
    ctx.fill(near);
    if (o.edge) { ctx.lineWidth = r * 0.42; ctx.strokeStyle = o.edge; ctx.stroke(near); }
  };

  // probe markers in screen space: a coloured tip with the channel number
  N.paintProbeMarkers = function (ctx, list) {
    ctx.save();
    ctx.font = '700 10px ' + (N.cssVar('--font-mono') || 'monospace');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [p, [x, y]] of list) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 11, y - 15); ctx.stroke();
      ctx.strokeStyle = p.color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 11, y - 15); ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = '#0b0f11'; ctx.stroke();
      const r = 9;
      ctx.beginPath(); ctx.arc(x + 15, y - 20, r, 0, Math.PI * 2);
      ctx.fillStyle = p.color; ctx.fill(); ctx.strokeStyle = '#0b0f11'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#0b0f11'; ctx.fillText(String(p.ch + 1), x + 15, y - 19.5);
    }
    ctx.restore();
  };

  // LEDs light up with their current
  const LED_COL = [[/\b(red|rot)\b|\bRD\b|62\d\s*nm/i, [255, 60, 40]], [/green|\bGN\b|\bGR\b|5[23]\d\s*nm/i, [60, 255, 90]], [/blue|\bBL\b|4[67]\d\s*nm/i, [70, 130, 255]],
    [/yellow|\bYE\b|\bYL\b|59\d\s*nm/i, [255, 220, 40]], [/orange|amber|\bOR\b|60\d\s*nm/i, [255, 150, 30]], [/white|\bWH\b|\bWT\b/i, [255, 250, 235]]];
  N.ledColor = function (text) { for (const [rx, c] of LED_COL) if (rx.test(text || '')) return c; return [255, 70, 50]; };
  N.paintLiveLeds = function (ctx, B, live, o) {
    if (live.pix && live.pix.size) for (const [ref, c] of live.pix) {
      const lvl = Math.min(1, Math.max(c[0], c[1], c[2]) / 255 * (c[3] != null && c.length === 4 && c[3] <= 31 ? c[3] / 31 : 1));
      if (!(lvl > 0.02)) continue;
      const f = B.fp(ref);
      if (!f || (o.side != null && f.s !== o.side)) continue;
      const b = f.b || [-1, -1, 1, 1];
      const rad = Math.max(1.6, Math.hypot(b[2] - b[0], b[3] - b[1]) * 1.2) * (0.8 + lvl * 0.9);
      const m = Math.max(1, c[0], c[1], c[2]), r = Math.round(c[0] / m * 255), g = Math.round(c[1] / m * 255), bl = Math.round(c[2] / m * 255);
      const gr = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, rad);
      gr.addColorStop(0, `rgba(255,255,255,${0.8 * lvl})`);
      gr.addColorStop(0.2, `rgba(${r},${g},${bl},${0.95 * lvl})`);
      gr.addColorStop(1, `rgba(${r},${g},${bl},0)`);
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(f.x, f.y, rad, 0, Math.PI * 2); ctx.fill();
    }
    for (const d of live.leds || []) {
      const lvl = d.lvl;
      if (!(lvl > 0.02)) continue;
      const f = B.fp(d.ref);
      if (!f || (o.side != null && f.s !== o.side)) continue;
      const b = f.b || [-1, -1, 1, 1];
      const rad = Math.max(1.4, Math.hypot(b[2] - b[0], b[3] - b[1]) * 1.1) * (0.8 + lvl * 0.9);
      const [r, g, bl] = d.col;
      const gr = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, rad);
      gr.addColorStop(0, `rgba(255,255,255,${0.85 * lvl})`);
      gr.addColorStop(0.18, `rgba(${r},${g},${bl},${0.9 * lvl})`);
      gr.addColorStop(1, `rgba(${r},${g},${bl},0)`);
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(f.x, f.y, rad, 0, Math.PI * 2); ctx.fill();
    }
  };

  // ------------------------------------------------------------------ number formats
  const esc = s => N.esc(String(s));
  const fmtT = t => (t >= 1 ? t.toFixed(3) + ' s' : t >= 1e-3 ? (t * 1e3).toFixed(3) + ' ms' : t >= 1e-6 ? (t * 1e6).toFixed(1) + ' µs' : (t * 1e9).toFixed(0) + ' ns');
  const fmtV = v => (Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3)) + ' V';
  const fmtA = a => { const x = Math.abs(a); return (x >= 1 ? a.toFixed(2) + ' A' : x >= 1e-3 ? (a * 1e3).toFixed(x >= 0.1 ? 0 : 1) + ' mA' : x >= 1e-6 ? (a * 1e6).toFixed(0) + ' µA' : (a * 1e9).toFixed(0) + ' nA'); };
  const fmtHz = f => (f >= 1e6 ? (f / 1e6).toFixed(2) + ' MHz' : f >= 1e3 ? (f / 1e3).toFixed(2) + ' kHz' : f >= 10 ? f.toFixed(1) + ' Hz' : f.toFixed(2) + ' Hz');
  N.liveFmt = { V: fmtV, A: fmtA, T: fmtT, Hz: fmtHz };
  const FLOAT_COL = { dark: '#7d6aa8', light: '#9c8cc4' };
  N.liveFloatColor = scheme => FLOAT_COL[scheme] || FLOAT_COL.dark;

  // ------------------------------------------------------------------ tooltips (live values, refreshed while hovering)
  const MODE_TXT = { hi: 'drives HIGH', lo: 'drives LOW', pu: 'pull-up', pd: 'pull-down', od: 'pulls LOW (open drain)', z: 'input', half: 'switching (average)' };
  // one line of live value, the reason only where the value needs one, and what a click does
  const TIP_CLICK = '<br><span class="lv-tip muted small">click to select · probe it from the card</span>';
  N.liveTipNet = function (B, net, extra) {
    const L = N.live;
    if (!L.on || L.B !== B || !net) return '';
    const v = L.netVoltage(net);
    if (v == null) return '<br><span class="lv-tip muted">not in the simulation</span>';
    if (L.netFloating(net)) return `<br><span class="lv-tip"><i style="background:${N.liveFloatColor()}"></i>floating</span><br><span class="lv-tip muted">${esc(L.netWhy(net) || 'nothing drives it')}</span>` + TIP_CLICK;
    if (L.netIdle(net)) return `<br><span class="lv-tip"><i style="background:${N.livePalette('dark')[253]}"></i>not driven here</span><br><span class="lv-tip muted">${esc(L.netWhy(net))}</span>` + TIP_CLICK;
    const sw = L.switchNote(net);
    return `<br><span class="lv-tip"><i style="background:${N.liveColor(v, L.vmax)}"></i>${fmtV(v)}${extra ? ' · ' + extra : ''}</span>${sw ? `<br><span class="lv-tip muted">${esc(sw)}</span>` : ''}` + TIP_CLICK;
  };
  // a rail behind a power switch (a MOSFET the firmware or a controller works): say so, and whether it is on
  N.liveSwitchNote = function (net) {
    const L = N.live;
    if (!L.on || !L.engine || !L.base || !L.base.sim) return '';
    const name = typeof net === 'number' ? L.B.nets[net] : net;
    for (const ps of L.base.sim.powerSwitches || []) {
      if (ps.to !== name && ps.rail !== name) continue;
      const st = L.engine.fetOf(ps.name);
      if (!st) continue;
      return `behind power switch ${ps.ref}: ${st.on ? 'on' : 'off'}${st.state ? ' (held ' + st.state + ')' : ''} · switch it under Actions → Power`;
    }
    return '';
  };
  // the piece of copper of `net` nearest (x, y): on the given layer when there is one there, else on any layer.
  // The hover text, the selection card and a probe all use it, so they always name the same piece
  N.liveSegAt = function (B, net, x, y, layer) {
    const F = B._pcbFlow;
    if (!F || !N.segDist || x == null || !net) return -1;
    const li = layer == null ? -1 : typeof layer === 'number' ? layer : B.cu.indexOf(layer), S = F.segs;
    let best = -1, bd = 1e9, any = -1, ad = 1e9;
    for (let s = 0; s < F.nseg; s++) {
      if (F.segNet[s] !== net) continue;
      const d = N.segDist(x, y, S[s * 6], S[s * 6 + 1], S[s * 6 + 2], S[s * 6 + 3]);
      if (d < ad) { ad = d; any = s; }
      if (li >= 0 && S[s * 6 + 5] === li && d < bd) { bd = d; best = s; }
    }
    return best >= 0 && bd < ad + 1 ? best : any;
  };
  // a track: the voltage on it and the current along the piece under the cursor, on the same line
  N.liveTipTrack = function (B, net, x, y, layer) {
    const L = N.live;
    if (!L.on || L.B !== B || !net) return '';
    const F = B._pcbFlow;
    if (!F || L.netFloating(net) || L.netIdle(net) || x == null) return N.liveTipNet(B, net);
    const best = N.liveSegAt(B, net, x, y, layer);
    const i = best >= 0 ? F.segI[best] : 0;
    return N.liveTipNet(B, net, Math.abs(i) >= 1e-6 ? fmtA(Math.abs(i)) + ' here' : 'no current here');
  };
  N.liveTipPin = function (B, ref, num, net) {
    const L = N.live;
    if (!L.on || L.B !== B) return '';
    const v = net ? L.netVoltage(net) : null;
    const i = L.padI(ref, num);
    const parts = [];
    if (v != null && net && L.netFloating(net)) parts.push(`<i style="background:${N.liveFloatColor()}"></i>floating`);
    else if (v != null && net && L.netIdle(net)) parts.push(`<i style="background:${N.livePalette('dark')[253]}"></i>not driven here`);
    else if (v != null) parts.push(`<i style="background:${N.liveColor(v, L.vmax)}"></i>${fmtV(v)}`);
    if (Math.abs(i) > 1e-9) parts.push(`${fmtA(Math.abs(i))} ${i > 0 ? 'in' : 'out'}`);
    const d = L.pinDrive(ref, num);
    const lines = parts.length ? [`<span class="lv-tip">${parts.join(' · ')}</span>`] : [];
    if (d) lines.push(`<span class="lv-tip">${esc(d)}</span>`);
    else if (net && (L.netFloating(net) || L.netIdle(net)) && L.netWhy(net)) lines.push(`<span class="lv-tip muted">${esc(L.netWhy(net))}</span>`);
    const sw = net ? L.switchNote(net) : '';
    if (sw) lines.push(`<span class="lv-tip muted">${esc(sw)}</span>`);
    return '<br>' + lines.join('<br>') + TIP_CLICK;
  };
  N.liveTipPart = function (B, ref) {
    const L = N.live;
    if (!L.on || L.B !== B) return '';
    const r = L.readout(ref);
    const pr = (L.procs || []).find(p => p.ref === ref);
    const run = pr && L.fwm && L.fwm.get(ref);
    const bits = [];
    if (r && Math.abs(r.i) > 1e-9) bits.push(fmtA(Math.abs(r.i)));
    if (r && r.p > 1e-6) bits.push((r.p >= 1 ? r.p.toFixed(2) + ' W' : (r.p * 1e3).toFixed(1) + ' mW'));
    if (r && r.model) bits.push(esc(r.model));
    let s = bits.length ? `<br><span class="lv-tip">${bits.join(' · ')}</span>` : r ? '<br><span class="lv-tip muted">no current</span>' : pr ? '' : '<br><span class="lv-tip muted">not in the simulation</span>';
    if (pr) s += `<br><span class="lv-tip">${run ? (run.state === 'running' ? 'running ' + (run.kind === 'firmware' ? esc(run.imageName) : 'a program') : esc(run.state)) : 'no program · click Code to put one on'}</span>`;
    const dev = L.deviceStatus(ref);
    if (dev) s += `<br><span class="lv-tip">${esc(dev)}</span>`;
    return s;
  };

  // live values in the selection card. Built once per selection and refreshed in place, so its buttons stay clickable:
  // the value first, then what drives it, then what you can do (probe it, press it, switch it)
  N.liveCardFill = function (box, B, sel) {
    const L = N.live;
    if (!L.on || L.B !== B) { box.replaceChildren(); box._key = null; return; }
    const hit = sel.hit && sel.hit.hit ? sel.hit : null;
    const key = [...sel.refs].join(',') + '|' + [...sel.nets].join(',') + '|' + (hit ? hit.view + ':' + hit.hit.type + ':' + (hit.hit.i != null ? hit.hit.i : hit.hit.p ? hit.hit.p.ref + '.' + hit.hit.p.num : '') : '') + '|' + L.gen + '|' + L.probes.map(p => p.id + ':' + p.ch).join(',');
    if (box._key !== key) { box._key = key; box._upd = []; box.replaceChildren(...cardKids(L, B, sel, hit, box._upd)); }
    for (const u of box._upd || []) { try { u(); } catch (e) { /* a value that went away with a rebuild */ } }
  };
  const dotFor = (L, v, n) => (v == null ? 'transparent' : n && L.netFloating(n) ? N.liveFloatColor() : n && L.netIdle(n) ? N.livePalette('dark')[253] : N.liveColor(v, L.vmax));
  const vText = (L, v, n) => (v == null ? 'not simulated' : n && L.netFloating(n) ? 'floating' : n && L.netIdle(n) ? 'not driven here' : fmtV(v));
  // what a pin connects to, in words: the net's name, or for KiCad's automatic names (Net-(U7-SW)) the other pins on it
  function pinPeer(B, net, ref) {
    const nm = N.fmt.shortNet(B.nets[net] || '');
    if (/^unconnected-/i.test(nm)) return 'n/c';
    if (!/^Net-\(/.test(nm)) return nm.replace(/\{slash\}/g, '/');
    const other = [];
    for (const pi of (B.padsByNet && B.padsByNet.get(net)) || []) { const q = B.pads[pi], r = B.fps[q[0]].r; if (r === ref) continue; const k = r + '.' + q[1]; if (!other.includes(k)) other.push(k); if (other.length > 2) break; }
    return other.length ? '→ ' + other.slice(0, 2).join(', ') + (other.length > 2 ? '…' : '') : 'no other pin';
  }
  // the pin a click landed on (a pad on the PCB or in 3D, a pin on the schematic)
  function hitPin(B, hit) {
    if (!hit) return null;
    const h = hit.hit;
    if (h.type === 'pad' && B.pads[h.i]) { const p = B.pads[h.i]; return { ref: B.fps[p[0]].r, pin: String(p[1]), name: p[14] && p[14] !== '~' ? p[14] : '' }; }
    if (h.type === 'pin' && h.p) return { ref: h.p.ref, pin: String(h.p.num), name: h.p.name || '' };
    return null;
  }
  // the current along the piece of track a click landed on
  function hitTrackI(B, hit, net) {
    if (!hit || hit.hit.type !== 'track' || !hit.at) return null;
    const F = B._pcbFlow;
    if (!F) return null;
    const best = N.liveSegAt(B, net, hit.at[0], hit.at[1], hit.hit.L);
    return best >= 0 ? F.segI[best] : null;
  }
  function probeOf(L, net, pin) {
    const name = L.netName.get(net);
    return L.probes.find(p => p.kind !== 'decode' && (pin ? p.ref === pin.ref && String(p.pin) === pin.pin : p.name === name && !p.ref)) || null;
  }
  function probeButton(L, label, add, find) {
    const wrap = el('div', { class: 'scl-acts' });
    const p = find();
    if (p) wrap.append(el('span', { class: 'scl-ch', style: { '--c': p.color } }, el('i'), 'CH' + (p.ch + 1) + ' · on the scope'), el('button', { class: 'btn tiny ghost scl-rm', type: 'button', onclick: () => L.removeProbe(p.id) }, 'Remove'));
    else wrap.append(el('button', { class: 'btn tiny scl-probe', type: 'button', title: label + ' (P)', onclick: () => { const q = add(); if (!q) N.toast('The scope is full: remove a probe first, or pin the ones to keep.', 'warn'); } }, N.svg(I.probe || I.target), label));
    return wrap;
  }
  function cardKids(L, B, sel, hit, upd) {
    const kids = [el('div', { class: 'scl-head' }, el('span', { class: 'ld-pulse on' }), 'Live')];
    // ---- a part
    if (sel.refs.size === 1 && !sel.nets.size) {
      const ref = [...sel.refs][0];
      const f = B.fp(ref);
      const pr = (L.procs || []).find(p => p.ref === ref);
      const sum = el('div', { class: 'scl-big' }), state = el('div', { class: 'scl-why' });
      kids.push(sum, state);
      upd.push(() => {
        const r = L.readout(ref), run = pr && L.fwm && L.fwm.get(ref), bits = [];
        if (r && Math.abs(r.i) > 1e-9) bits.push(fmtA(Math.abs(r.i)));
        if (r && r.p > 1e-6) bits.push(r.p >= 1 ? r.p.toFixed(2) + ' W' : (r.p * 1e3).toFixed(1) + ' mW');
        sum.textContent = bits.join(' · ') || (r ? 'no current' : pr ? '' : 'not part of the simulation');
        const st = [];
        if (r && r.model) st.push(r.model);
        if (pr) st.push(run ? (run.state === 'running' ? 'running ' + (run.kind === 'firmware' ? run.imageName : 'a program') : run.state) : 'no program yet');
        const dev = L.deviceStatus(ref);
        if (dev) st.push(dev);
        const sw = L.engine.enableOf && L.engine.enableOf(ref);
        if (sw) st.push((sw.on ? 'on' : 'off') + (sw.force != null ? (sw.dflt ? ' (as on a running board)' : ' (held by hand)') : sw.hasEn ? ' (its enable pin)' : ''));
        state.textContent = st.join(' · ');
      });
      // its pins, busiest first: select one to see it, or probe it
      if (f) {
        const seen = new Set(), pins = [];
        for (const pi of f.pads) { const p = B.pads[pi]; const k = String(p[1]); if (!k || seen.has(k) || !p[10]) continue; seen.add(k); pins.push({ p, pi }); }
        const act = x => Math.abs(L.padI(ref, x.p[1])) + (Math.abs(L.netVoltage(x.p[10]) || 0) > 0.05 ? 1e-9 : 0);
        const shown = pins.slice().sort((a, b) => act(b) - act(a)).slice(0, 8);
        if (shown.length) {
          const rows = shown.map(x => {
            const p = x.p, v = el('b', { class: 'num' }), dot = el('i', { class: 'scl-dot' }), cur = el('span', { class: 'num muted scl-i' });
            const pin = { ref, pin: String(p[1]), name: p[14] && p[14] !== '~' ? p[14] : '' };
            const add = el('button', { class: 'scl-add', type: 'button', title: 'Probe ' + ref + '.' + p[1], 'aria-label': 'Probe ' + ref + '.' + p[1], onclick: () => L.probePad(x.pi) }, '+');
            const row = el('div', { class: 'scl-row' },
              el('button', { class: 'scl-sel', type: 'button', title: 'Select ' + N.fmt.shortNet(B.nets[p[10]]), onclick: () => N.select([], [p[10]], { hit: { view: 'pcb', hit: { type: 'pad', i: x.pi, net: p[10] }, at: [p[4], p[5]] } }) },
                el('span', { class: 'mono scl-pin' }, String(p[1]) + (pin.name && pin.name !== String(p[1]) ? ' ' + pin.name : '')), el('span', { class: 'mono scl-net' }, pinPeer(B, p[10], ref))),
              dot, v, cur, add);
            upd.push(() => {
              const vv = L.netVoltage(p[10]), i = L.padI(ref, p[1]);
              dot.style.background = dotFor(L, vv, p[10]);
              v.textContent = vv == null ? '—' : L.netFloating(p[10]) ? 'float' : L.netIdle(p[10]) ? 'idle' : fmtV(vv);
              v.title = L.netWhy(p[10]) || '';
              cur.textContent = Math.abs(i) > 1e-9 ? fmtA(Math.abs(i)) : '';
              const pb = probeOf(L, p[10], pin);
              add.classList.toggle('on', !!pb); add.textContent = pb ? 'CH' + (pb.ch + 1) : '+';
            });
            return row;
          });
          kids.push(el('div', { class: 'scl-sec' }, el('span', null, 'Pins'), el('span', { class: 'muted' }, pins.length > shown.length ? `busiest ${shown.length} of ${pins.length}` : '')), el('div', { class: 'scl-rows' }, rows));
        }
      }
      // what you can do with it
      const acts = el('div', { class: 'scl-acts' });
      const sws = L.engine.switches().filter(s => s.ref === ref && !s.auto);
      for (const s of sws.slice(0, 4)) {
        const b = el('button', { class: 'btn tiny', type: 'button', onclick: () => { const c = L.engine.switches().find(q => q.ref === ref && q.key === s.key); L.engine.setSwitch(ref, !(c && c.closed), s.key); if (L.ui) L.ui.refresh(); } });
        upd.push(() => { const c = L.engine.switches().find(q => q.ref === ref && q.key === s.key); b.textContent = (c && c.closed ? (s.jumper ? 'Open' : 'Release') : (s.jumper ? 'Bridge' : 'Press')) + (sws.length > 1 && s.key ? ' ' + s.key : ''); b.classList.toggle('on', !!(c && c.closed)); });
        acts.append(b);
      }
      const en = L.engine.enableOf && L.engine.enableOf(ref);
      if (en) acts.append(seg(['auto', 'on', 'off'], () => { const x = L.engine.enableOf(ref); return !x || x.force == null ? 'auto' : x.force ? 'on' : 'off'; }, v => { L.engine.setEnable(ref, v === 'auto' ? null : v === 'on'); if (L.ui) L.ui.refresh(); }, upd));
      const ps = ((L.base.sim || {}).powerSwitches || []).find(x => x.ref === ref);
      if (ps) acts.append(seg(['auto', 'on', 'off'], () => { const x = L.engine.fetOf(ps.name); return !x || !x.state ? 'auto' : x.state; }, v => { L.engine.setFet(ps.name, v === 'auto' ? null : v); if (L.ui) L.ui.refresh(); }, upd));
      if (f) acts.append(el('button', { class: 'btn tiny scl-probe', type: 'button', title: 'Probe the busiest pins of ' + ref, onclick: () => L.probePart(ref) }, N.svg(I.probe || I.target), 'Probe pins'));
      if (pr) acts.append(el('button', { class: 'btn tiny primary', type: 'button', onclick: () => L.openCode(ref) }, N.svg(I.code), 'Code'));
      if (acts.childNodes.length) kids.push(acts);
      return kids;
    }
    // ---- a net (a trace, a pad, a pin, a wire)
    if (sel.nets.size) {
      const nets = [...sel.nets].slice(0, 3);
      nets.forEach((n, idx) => {
        const h0 = idx === 0 && hit && (!hit.hit.net || hit.hit.net === n || hit.net === n || hit.hit.type === 'pin' || hit.hit.type === 'pad') ? hit : null;
        const pin = hitPin(B, h0);
        const where = pin ? `${pin.ref}.${pin.pin}${pin.name && pin.name !== pin.pin ? ' ' + pin.name : ''}` : h0 ? { track: 'this trace', via: 'this via', zone: 'this pour', wire: 'this wire', label: 'this label' }[h0.hit.type] || '' : '';
        const dot = el('i', { class: 'scl-dot big' }), big = el('b', { class: 'num' }), cur = el('span', { class: 'scl-cur num' });
        const why = el('div', { class: 'scl-why' }), note = el('div', { class: 'scl-why' });
        kids.push(el('div', { class: 'scl-big' }, dot, big, cur), why, note);
        let k = 0;
        upd.push(() => {
          const v = L.netVoltage(n);
          dot.style.background = dotFor(L, v, n);
          big.textContent = vText(L, v, n);
          const i = pin ? L.padI(pin.ref, pin.pin) : hitTrackI(B, h0, n);
          cur.textContent = i != null && Math.abs(i) > 1e-9 ? `${fmtA(Math.abs(i))} ${pin ? (i > 0 ? 'into ' : 'out of ') + where : 'along ' + (where || 'the net')}` : where ? where : '';
          if ((k++ & 3) === 0) {
            if (L.netFloating(n) || L.netIdle(n)) why.textContent = L.netWhy(n) || '';
            else { const ex = L.explain(L.netName.get(n)); const top = ex && ex.items.find(x => x.i != null && x.i > 0) || (ex && ex.items[0]); why.textContent = top ? 'Driven by ' + top.text + (top.i != null ? ' · ' + fmtA(Math.abs(top.i)) : '') : ''; }
            note.textContent = L.switchNote(n) || '';
          }
        });
        kids.push(probeButton(L, pin ? 'Probe ' + pin.ref + '.' + pin.pin : nets.length > 1 ? 'Probe ' + N.fmt.shortNet(B.nets[n]) : 'Probe', () => (h0 ? L.probeHit(h0) : L.addProbe({ net: n })), () => probeOf(L, n, pin)));
      });
      return kids;
    }
    return kids;
  }
  // a small Auto / On / Off control that follows the engine
  function seg(opts, get, set, upd) {
    const box = el('div', { class: 'scl-seg', role: 'group' });
    const btns = opts.map(o => el('button', { class: 'scl-sb', type: 'button', onclick: () => set(o) }, o === 'auto' ? 'Auto' : o === 'on' ? 'On' : 'Off'));
    box.append(...btns);
    upd.push(() => { const v = get(); btns.forEach((b, i) => b.classList.toggle('on', opts[i] === v)); });
    return box;
  }


  // ------------------------------------------------------------------ the controller
  const SPEEDS = [[1e-5, '10 µs / s'], [1e-4, '100 µs / s'], [1e-3, '1 ms / s'], [1e-2, '10 ms / s'], [0.1, '0.1 s / s'], [1, 'real time']];
  // 16 channels, like a small logic analyser; the first four keep the scope's classic colours
  const PROBE_COLORS = ['#ffd21f', '#4fc3ff', '#ff6bd6', '#7dff8a', '#ff9f43', '#b39dff', '#3fd6c6', '#ff6b6b',
    '#c6e04a', '#6aa8ff', '#ffb3d9', '#dcdcdc', '#e0b080', '#9fe8ff', '#f7768e', '#a8d08d'];
  const MAX_PROBES = PROBE_COLORS.length;
  const RING = 4096;
  const L = (N.live = { on: false, running: false, netV: null, vmax: 5, frameId: 0, SPEEDS, PROBE_COLORS, MAX_PROBES });

  L.start = function (ctx) {
    if (L.on) L.stop();
    L.ctx = ctx;
    L.B = ctx.B;
    L.base = ctx.model;
    L.fault = null;
    L.speed = ctx.model.speed || 0;
    L.userSpeed = !!ctx.model.speed;
    L.probes = [];
    L.pid = 0;
    L.netV = new Float64Array(L.B.nets.length).fill(NaN);
    L.flt = new Uint8Array(L.B.nets.length);
    L.pad = new Map();
    L.padI = (ref, num) => L.pad.get(ref + '\u0000' + num) || 0;
    L.scheme = 'dark';
    L.procs = null;
    L.pix = new Map();
    L.forced = new Map();
    L.timers = [];
    L.fwm = N.fw ? N.fw.manager(L) : null;
    if (L.fwm) L.fwm.listeners.add(p => { procLoads(); L.procGen = (L.procGen || 0) + 1; if (L.ui) L.ui.procChanged(p); });
    try { L.speed = L.speed || 1e-3; build(L.base.circuit, L.base.sim, null); if (!ctx.model.speed) L.setSpeed(autoSpeed(L.engine), true); }
    catch (e) { console.error(e); N.toast('Live simulation could not start: ' + (e.message || e), 'warn'); L.ctx = null; return false; }
    L.on = true;
    L.running = true;
    L.powerUp();
    if (N.livePanel) L.ui = N.livePanel.mount(L);
    L.last = performance.now();
    L.raf = requestAnimationFrame(loop);
    N.bus.emit('live', true);
    return true;
  };
  L.stop = function () {
    if (!L.on) return;
    cancelAnimationFrame(L.raf);
    if (L.fwm) L.fwm.stopAll();
    if (L.ui) { L.ui.destroy(); L.ui = null; }
    L.on = false; L.running = false;
    L.engine = null;
    L.probes = [];
    L.pix = new Map();
    const v = L.ctx && L.ctx.getViews();
    L.ctx = null;
    if (v) { v.pcb && v.pcb.draw(); v.sch && v.sch.draw(); v.v3d && v.v3d.setLive && v.v3d.setLive(null); }
    N.bus.emit('live', false);
  };
  // the design changed underneath a running simulation
  L.rebuild = function (model) {
    if (!L.on) return;
    L.base = model;
    L.procs = null;
    L.B = L.ctx.B = model.B || L.ctx.B;
    L.netV = new Float64Array(L.B.nets.length).fill(NaN);
    L.flt = new Uint8Array(L.B.nets.length);
    const snap = L.engine.snapshot();
    try { build(model.circuit, model.sim, snap); } catch (e) { console.error(e); }
    L.fault = null;
    if (L.ui) L.ui.rebuilt();
  };

  function build(circuit, sim, snap) {
    // processors on the board: their IO pins become drivers that code can switch; IO expanders drive their pins too
    if (!L.procs || L.procsFor !== L.base.circuit) { L.procs = N.fw ? N.fw.detect(L.base.circuit) : []; L.procsFor = L.base.circuit; L.analysis = new Map(); }
    const drivers = [], seenDrv = new Set();
    const addDrv = d => { const k = d.ref + '\u0000' + d.pin; if (seenDrv.has(k)) return; seenDrv.add(k); drivers.push(d); };
    for (const p of L.procs) for (const io of p.io) addDrv({ ref: p.ref, pin: io.number, vdd: p.vdd, vnom: p.vnom });
    if (N.fw && N.fw.deviceDrivers) for (const d of N.fw.deviceDrivers(L.base.circuit)) addDrv(d);
    // chips with a behaviour from the part model library drive their output pins too
    for (const d of (sim && sim.drivers) || []) addDrv(d);
    const eng = new N.LiveSim(circuit, Object.assign({}, sim, { drivers }), L.base.vals || {}, L.base.alias || {}, { rampTime: 0 });
    L.engine = eng;
    if (L.fwm) L.fwm.attach(eng);
    L.pm = N.partModels && sim && (sim.behaviours || []).length ? N.partModels.runtime(L, sim.behaviours) : null;
    eng.onStep = (t, dt) => { if (L.fwm) L.fwm.step(t, dt); if (L.pm) L.pm.step(t, dt); sampleStep(t); };
    for (const [k, mode] of L.forced) { const [ref, pin] = k.split('\u0000'); eng.setDrive(ref, pin, mode); }
    L.netIdx = new Map();
    for (const n of circuit.nets) { const i = n._i != null ? n._i : L.B.findNet(n.name); if (i > 0) L.netIdx.set(n.name, i); }
    L.netName = new Map([...L.netIdx].map(([nm, i]) => [i, nm]));
    L.fmax = Math.max(eng.fmax || 0, timerFreq(eng));
    L.gen = (L.gen || 0) + 1;
    L.colIdx = new Uint8Array(L.B.nets.length).fill(255);
    L.colGen = (L.colGen || 0) + 1;
    L.fltTopo = -1;
    L.netNode = new Map([...eng.nodeNet].map(([nd, net]) => [net, nd]));
    L.leds = circuit.components.filter(c => c.type === 'led' && !c.dnp).map(c => ({ ref: c.ref, col: N.ledColor([c.value, c.description, c.mpn, c.color].join(' ')), lvl: 0 }));
    // LEDs inside multi-pin parts (RGB LEDs, LEDs with unusual pins): their colours mix by current
    L.ledEls = new Map();
    for (const x of eng.els) if (x.t === 'D' && x.led) { let a = L.ledEls.get(x.ref); if (!a) L.ledEls.set(x.ref, (a = [])); a.push(x); }
    for (const [ref, list] of L.ledEls) { const c = circuit.components.find(q => q.ref === ref); L.leds.push({ ref, col: N.ledColor([c && c.value, c && c.description].join(' ')), lvl: 0, els: list }); }
    L.comp = new Map(circuit.components.map(c => [c.ref, c]));
    L.models = new Map();
    const MW = { REG: 'regulator model', SWR: 'buck converter model', OPA: 'op-amp model', T555: '555 timer model', LSW: 'load switch model' };
    for (const x of eng.els) { if (MW[x.t]) L.models.set(x.ref, x.t === 'REG' && x.boost ? 'boost converter model' : x.t === 'REG' && x.charger ? 'battery charger model' : MW[x.t]); else if (x.load && x.ref && !L.models.has(x.ref)) L.models.set(x.ref, 'modelled as its supply current'); else if (x.standin && x.ref) L.models.set(x.ref, 'pin driven by a stand-in source'); }
    for (const c of circuit.components) if (c.type === 'composite' && c.label && !L.models.has(c.ref)) L.models.set(c.ref, c.label);
    // part model library behaviours: what the chip's pins do
    L.partModels = (sim && sim.models) || {};
    for (const [ref, m] of Object.entries(L.partModels)) { const was = L.models.get(ref); L.models.set(ref, (m.familyName || 'behaviour') + (m.note ? ': ' + m.note : '') + (was && !/supply current/.test(was) ? ' · ' + was : was ? ' · plus its supply current' : '')); }
    L._ro = null;
    if (snap) eng.restore(snap);
    L.setSpeed(L.speed, true);
    let vm = 1;
    for (const s of eng.supplies()) vm = Math.max(vm, Math.abs(s.value || 0));
    for (const e of eng.els) if (e.t === 'REG') vm = Math.max(vm, e.vout);
    L.vmax = vm;
    L.info = eng.info();
    for (const p of L.probes) bindProbe(p);
    procLoads();
  }
  // a processor running code draws its full supply current; one held idle much less
  function procLoads() {
    if (!L.engine || !L.procs) return;
    for (const p of L.procs) { const r = L.fwm && L.fwm.get(p.ref); L.engine.setLoadScale(p.ref, r && r.state === 'running' ? 1 : 0.4); }
  }
  // a 555 astable: f = 1.44 / ((Ra + 2 Rb) C)
  function timerFreq(eng) {
    let f = 0;
    for (const t of eng.els) {
      if (t.t !== 'T555' || !t.thr) continue;
      const between = (a, b) => eng.els.filter(e => e.t === 'R' && !e.load && ((e.a === a && e.b === b) || (e.a === b && e.b === a))).reduce((s, e) => s + 1 / e.v, 0);
      const C = eng.els.filter(e => e.t === 'C' && (e.a === t.thr || e.b === t.thr) && (e.a === '0' || e.b === '0' || e.a === t.gnd || e.b === t.gnd)).reduce((s, e) => s + e.v, 0);
      const gb = t.dis && t.dis !== t.thr ? between(t.dis, t.thr) : 0, ga = between(t.vcc, t.dis || t.thr);
      if (!(C > 0) || !(ga > 0)) continue;
      const Ra = 1 / ga, Rb = gb > 0 ? 1 / gb : 0;
      f = Math.max(f, 1.44 / ((Ra + 2 * Rb) * C));
    }
    return f;
  }
  function autoSpeed(eng) {
    let s = 1e-3;
    const f = timerFreq(eng);
    if (f > 0) s = Math.max(s, 2.5 / f);
    for (const x of eng.els) if (x.t === 'V' && x.w && x.w.kind !== 'dc' && x.w.freq) s = Math.max(s, 2.5 / x.w.freq);
    s = Math.min(1, s);
    let best = SPEEDS[0][0];
    for (const [v] of SPEEDS) if (Math.abs(Math.log(v / s)) < Math.abs(Math.log(best / s))) best = v;
    return best;
  }
  L.setSpeed = function (s, quiet, byUser) {
    L.speed = s;
    if (byUser) L.userSpeed = true;
    let dt = Math.min(5e-4, Math.max(5e-9, s / 60 / 16));
    if (L.fmax) dt = Math.min(dt, 1 / (L.fmax * 40));
    L.engine.setDt(dt);
    if (!quiet && L.ui) L.ui.refresh();
  };
  L.powerUp = function () {
    const e = L.engine;
    e.powerCycle(Math.min(0.05, Math.max(e.dt * 40, L.speed * 1.2)));
    if (L.fwm) { e.releaseAll(); for (const [k, mode] of L.forced) { const [ref, pin] = k.split('\u0000'); e.setDrive(ref, pin, mode); } L.fwm.reset(0); }
    for (const p of L.probes) p.n = 0;
    L.running = true;
    L.upAt = null;
    if (L.ui) L.ui.refresh();
  };
  // the power-up transient plays slowly; once the rails have settled the board runs in real time
  function maybeRealTime() {
    if (L.userSpeed || L.speed >= 1 || !L.engine || L.fault) return;
    if (L.fmax > 400) return;
    const e = L.engine;
    if (e.t < Math.max(0.004, (e.opts.rampTime || 0) * 1.5)) return;
    const rails = L.rails();
    const sig = rails.map(r => (r.v === r.v ? r.v : 0));
    if (L._railsPrev && sig.length === L._railsPrev.length && sig.every((v, i) => Math.abs(v - L._railsPrev[i]) < 0.002)) L._stable = (L._stable || 0) + 1; else L._stable = 0;
    L._railsPrev = sig;
    if (L._stable < 20) return;
    L.setSpeed(1, false);
    N.toast('The rails have settled: running in real time now');
  }
  L.realTime = function () { if (L.speed >= 0.1) return; L.setSpeed(1); N.toast('Switched to real time so the program runs at its real pace'); };

  // ---------------------------------------------------------------- frame loop
  function loop(now) {
    if (!L.on) return;
    L.raf = requestAnimationFrame(loop);
    const wall = Math.min(0.05, Math.max(0, (now - L.last) / 1000));
    L.last = now;
    L.wall = wall;
    if (L.running && L.ctx.visible()) {
      const want = L.speed * wall;
      const t0 = L.engine.t;
      const r = L.engine.advance(want, 11);
      if (!r.ok) { L.running = false; N.toast('The simulation stopped: the circuit could not be solved at t = ' + fmtT(L.engine.t) + '.', 'warn'); if (L.ui) L.ui.refresh(); }
      const got = L.engine.t - t0;
      L.ratio = L.ratio == null ? got / Math.max(want, 1e-30) : L.ratio * 0.9 + 0.1 * got / Math.max(want, 1e-30);
      L.sps = L.sps == null ? r.steps / Math.max(wall, 1e-3) : L.sps * 0.9 + 0.1 * r.steps / Math.max(wall, 1e-3);
      publish();
      if ((L.frameId & 7) === 0) maybeRealTime();
    }
    if (L.timers && L.timers.length) runTimers(now);
    L.frameId++;
    if (L.ctx.visible()) {
      const v = L.ctx.getViews();
      if (v.tab === 'pcb' && v.pcb) v.pcb.draw();
      if (v.tab === 'sch' && v.sch) v.sch.draw();
      if (v.tab === '3d' && v.v3d && v.v3d.liveTick) v.v3d.liveTick(L, wall);
      if ((L.frameId & 3) === 0) { for (const p of L.probes) probeStats(p); if (L.ui) L.ui.tick(); }
      if ((L.frameId & 7) === 4) { const box = document.getElementById('sc-live'); if (box) N.liveCardFill(box, L.B, L.ctx.getSelection()); if (L.ctx.refreshTip) L.ctx.refreshTip(); }
    }
  }
  // later(simulated seconds, real milliseconds, fn): runs fn once both have passed (a button press, an encoder step)
  L.later = function (simDt, wallMs, fn) { (L.timers || (L.timers = [])).push({ t: (L.engine ? L.engine.t : 0) + simDt, w: performance.now() + wallMs, fn }); };
  function runTimers(now) {
    const t = L.engine ? L.engine.t : 0;
    for (let k = 0; k < L.timers.length; k++) {
      const x = L.timers[k];
      if (t < x.t || now < x.w) continue;
      L.timers.splice(k--, 1);
      try { x.fn(); } catch (e) { console.error(e); }
    }
  }
  // node voltages -> board nets, pin currents -> pads
  function publish() {
    const e = L.engine;
    const nv = e.netVoltages();
    L.netV.fill(NaN);
    for (const [name, v] of nv) { const i = L.netIdx.get(name); if (i) L.netV[i] = v; }
    for (const [name, i] of L.netIdx) if (!nv.has(name) && L.netV[i] !== L.netV[i]) L.netV[i] = 0;   // ground and nets folded into it
    // nets nothing drives: recomputed when the topology changes. Only a real problem (1, purple) when nothing would drive
    // them on the real board either; nets driven from a connector, by an idle processor pin or by a chip that is not
    // simulated pin by pin are "not driven here" (2, slate) with the reason in the tooltip
    if (L.fltTopo !== e.topo || L.fltProc !== L.procGen) {
      L.fltTopo = e.topo; L.fltProc = L.procGen;
      const fl = e.floatingNodes(), root = e._fltRoot;
      L.flt.fill(0);
      L.fltWhy = new Map();
      // nets that float together (joined by resistors, switches …) share one verdict: the strongest reason among them
      const groups = new Map();
      for (const [name, i] of L.netIdx) { const nd = L.netNode.get(name); if (!nd) continue; const k = e.nodeIndex(nd); if (k >= 0 && fl[k]) { const g = root ? root[k] : k; let a = groups.get(g); if (!a) groups.set(g, (a = [])); a.push([name, i]); } }
      for (const list of groups.values()) {
        const verdicts = list.map(([name]) => whyFloating(name));
        const ext = verdicts.findIndex(v => v[0] === 2 && v[2] !== 'passive'), inp = verdicts.findIndex(v => v[0] === 1);
        for (let j = 0; j < list.length; j++) {
          const [name, i] = list[j];
          let [lvl, why] = verdicts[j];
          if (ext >= 0 && j !== ext) { lvl = 2; why = verdicts[ext][1] + (list.length > 1 ? ' (through ' + N.fmt.shortNet(list[ext][0]) + ')' : ''); }
          else if (ext < 0 && inp >= 0) { lvl = 1; if (j !== inp) why = verdicts[inp][1] + ' (through ' + N.fmt.shortNet(list[inp][0]) + ')'; }
          L.flt[i] = lvl; L.fltWhy.set(i, why);
        }
      }
      L.colGen++;
      for (let i = 1; i < L.colIdx.length; i++) if (L.flt[i]) L.colIdx[i] = L.flt[i] === 1 ? 254 : 253; else if (L.colIdx[i] >= 253 && L.colIdx[i] !== 255) L.colIdx[i] = 255;
    }
    // colour index per net, with a little hysteresis so ripple does not repaint the copper every frame
    const CI = L.colIdx, V = L.netV, F = L.flt;
    let ch = false;
    for (let i = 1; i < CI.length; i++) {
      if (F[i]) continue;
      const v = V[i], k = v === v ? N.liveIdx(v, L.vmax) : 255, o = CI[i];
      if (k !== o && (o === 255 || o === 254 || k === 255 || Math.abs(k - o) >= 2 || (k === 64) !== (o === 64))) { CI[i] = k; ch = true; }
    }
    if (ch) L.colGen++;
    const pc = e.pinCurrents();
    L.pad.clear();
    const padsOf = L.base.padsOf;
    for (const [k, i] of pc) {
      const [ref, pin] = k.split('\u0000');
      const pm = padsOf && padsOf.get(ref);
      const pads = pm && pm.get(pin);
      if (pads && pads.length) for (const p of pads) L.pad.set(ref + '\u0000' + p, (L.pad.get(ref + '\u0000' + p) || 0) + i / pads.length);
      else L.pad.set(ref + '\u0000' + pin, (L.pad.get(ref + '\u0000' + pin) || 0) + i);
    }
    for (const d of L.leds) {
      let i;
      if (d.els) {
        // RGB and multi-chip LEDs: the brightest die sets the level, the colours mix by current
        let r = 0, g = 0, b = 0;
        i = 0;
        for (const x of d.els) { const ii = Math.max(0, x._i || 0); if (ii > i) i = ii; if (x.col && ii > 5e-5) { const w = Math.min(1, Math.sqrt(ii / 0.01)); r += x.col[0] * w; g += x.col[1] * w; b += x.col[2] * w; } }
        const m = Math.max(r, g, b);
        if (m > 0) { const col = [Math.round(r / m * 255), Math.round(g / m * 255), Math.round(b / m * 255)]; if (!d.col || col.some((v, k) => Math.abs(v - d.col[k]) > 6)) { d.col = col; d._q3 = undefined; } }
      } else i = pc.get(d.ref + '\u0000A') || 0;
      const target = i > 5e-5 ? Math.min(1, Math.sqrt(i / 0.01)) : 0;
      d.lvl = d.lvl * 0.5 + target * 0.5;
    }
    // addressable LEDs lit by programs
    if (L.fwm && L.pixSeen !== L.pixGen) { L.pixSeen = L.pixGen; L.pix = L.fwm.pixelColors(); }
  }
  L.readout = function (ref) {
    if (!L.engine) return null;
    if (!L._ro || L._roFrame !== L.frameId) { L._ro = L.engine.partReadout(); L._roFrame = L.frameId; }
    const r = L._ro[ref];
    const model = L.models && L.models.get(ref);
    if (!r && !model) return null;
    return { i: r ? r.i : 0, p: r ? r.p : 0, model };
  };
  L.netVoltage = function (netIdx) { return L.on && L.netV && L.netV[netIdx] === L.netV[netIdx] ? L.netV[netIdx] : null; };
  L.netFloating = netIdx => !!(L.on && L.flt && L.flt[netIdx] === 1);
  L.netIdle = netIdx => !!(L.on && L.flt && L.flt[netIdx] === 2);
  L.switchNote = net => { try { return N.liveSwitchNote(net); } catch (e) { return ''; } };
  // the nets the eye is on: what is selected (a net, or the pins of a selected part, ground left out) and what is probed
  L.focusNets = function () {
    const out = new Set(), B = L.B;
    const sel = L.ctx && L.ctx.getSelection ? L.ctx.getSelection() : null;
    if (sel) {
      for (const n of sel.nets) out.add(n);
      for (const r of sel.refs) { const f = B && B.fp(r); if (f) for (const pi of f.pads) { const n = B.pads[pi][10]; if (n && !B.isGnd(n)) out.add(n); } }
    }
    for (const p of L.probes) if (p.net) out.add(p.net);
    return out;
  };
  L.netWhy = netIdx => (L.fltWhy && L.fltWhy.get(netIdx)) || '';
  // why nothing drives a net in the simulation: [1, text] a real floating net, [2, text] driven off-board / idle / not simulated
  function whyFloating(name) {
    const circ = L.engine && L.engine.circuit || L.base.circuit;
    if (!L._netByName || L._netByNameFor !== circ) { L._netByName = new Map(circ.nets.map(n => [n.name, n])); L._netByNameFor = circ; }
    const n = L._netByName.get(name);
    if (!n || n.nodes.length <= 1) return [2, n && n.nodes.length ? `only ${n.nodes[0].ref} pin ${n.nodes[0].pin} is on this net` : 'not connected', 'stub'];
    const procs = new Set((L.procs || []).map(p => p.ref));
    let conn = null, proc = null, drv = null, inp = null;
    for (const x of n.nodes) {
      const c = L.comp && L.comp.get(x.ref);
      if (!c) continue;
      if (procs.has(x.ref)) { proc = proc || x; continue; }
      if (c.type === 'connector') { conn = conn || x; continue; }
      if ((c.type === 'mosfet_n' || c.type === 'mosfet_p') && x.pin === 'G') { inp = inp || x; continue; }
      if ((c.type === 'bjt_npn' || c.type === 'bjt_pnp') && x.pin === 'B') { inp = inp || x; continue; }
      if (c.type !== 'ic') continue;
      const p = (c.pins || []).find(q => String(q.number) === String(x.pin));
      const m = L.partModels && L.partModels[x.ref], r = m && m.roles && m.roles[String(x.pin)];
      if (r && N.partModels && N.partModels.DRIVE_ROLES.has(r.role)) continue;   // simulated: released open drain and the like
      const et = p ? p.etype : '';
      if (/^input/.test(et)) inp = inp || x;
      else if (!/power_in|no_connect/.test(et) && !drv) drv = x;
    }
    if (proc) {
      const run = L.fwm && L.fwm.get(proc.ref);
      const pm = run && run.pinModes && run.pinModes.get(String(proc.pin));
      if (run && run.state === 'running' && pm === 0) return [1, `${proc.ref} reads this pin but nothing drives it: on real hardware it reads noise (use INPUT_PULLUP or add a resistor)`];
      return [2, `${proc.ref} pin ${proc.pin} is an input ${run && run.state === 'running' ? '(the program does not use it)' : 'until a program runs on ' + proc.ref + ' (Code)'}`, 'proc'];
    }
    if (drv) { const c = L.comp.get(drv.ref); return [2, `${drv.ref}${c && c.value ? ' (' + c.value + ')' : ''} pin ${drv.pin} drives it on the real board; that chip is simulated as its supply current only`, 'chip']; }
    if (conn) return [2, `comes in on connector ${conn.ref} pin ${conn.pin}: whatever is plugged in there drives it`, 'conn'];
    if (inp) {
      // an input reached only through capacitors is AC-coupled: the chip biases it inside (audio, RF, crystal inputs)
      const others = n.nodes.filter(x => x !== inp && !(x.ref === inp.ref && x.pin === inp.pin));
      if (others.length && others.every(x => { const c = L.comp.get(x.ref); return c && /^capacitor/.test(c.type); })) return [2, `${inp.ref} pin ${inp.pin} is AC-coupled: the chip biases it inside (not simulated)`, 'chip'];
      return [1, `nothing drives ${inp.ref} pin ${inp.pin}: on the real board it picks up noise`];
    }
    return [2, 'only passive parts here, nothing drives it', 'passive'];
  }

  // what drives a processor pin right now: program, firmware, forced by hand
  L.pinDrive = function (ref, num) {
    const pr = (L.procs || []).find(p => p.ref === ref);
    if (!pr) {
      // a chip with a behaviour from the part model library
      const m = L.partModels && L.partModels[ref], o = m && m.roles && m.roles[String(num)];
      if (!o || !N.partModels || !N.partModels.DRIVE_ROLES.has(o.role)) return '';
      const md = L.engine && L.engine.driveOf(ref, String(num));
      return `${ref} ${N.partModels.roleText(o)}${md ? ' · now ' + (MODE_TXT[md] || md) : ''}${L.forced.has(ref + '\u0000' + num) ? ' (set by hand)' : ''}`;
    }
    const k = ref + '\u0000' + num;
    if (L.forced.has(k)) return `${ref} pin ${MODE_TXT[L.forced.get(k)] || L.forced.get(k)} (set by hand)`;
    const run = L.fwm && L.fwm.get(ref);
    if (run && run.state === 'running') { const pi = run.pinInfo && run.pinInfo(String(num)); if (pi) return `${ref} ${pi.mode === 'pwm' ? 'PWM ' + Math.round(pi.duty * 100) + '%' + (pi.freq ? ' at ' + fmtHz(pi.freq) : '') : MODE_TXT[pi.mode] || pi.mode} (${run.kind === 'firmware' ? 'firmware' : 'program'})`; return `${ref} input (${run.kind === 'firmware' ? 'firmware' : 'program'})`; }
    return `${ref} pin is an input: no program runs on ${ref}`;
  };
  L.deviceStatus = function (ref) {
    if (!L.fwm) return '';
    for (const p of L.fwm.procs.values()) if (p.hw) for (const d of p.hw.devs) if (d.ref === ref && d.status) { try { return d.status(); } catch (e) { return ''; } }
    return '';
  };

  // ---------------------------------------------------------------- probes
  function bindProbe(p) {
    const e = L.engine;
    const nd = p.name ? L.netNode.get(p.name) : null;
    p.idx = nd ? e.nodeIndex(nd) : -1;
    p.node = nd || null;
    p.gnd = !nd && p.name && L.netIdx.has(p.name);   // folded into ground
  }
  // a free channel; when all 16 are taken the oldest probe that is not pinned (and not in `keep`) makes room
  function freeChannel(keep) {
    if (L.probes.length >= MAX_PROBES) {
      const old = L.probes.find(p => !p.pinned && !(keep && keep.has(p.id)));
      if (!old) return -1;
      L.removeProbe(old.id, true);
    }
    const used = new Set(L.probes.map(p => p.ch));
    for (let c = 0; c < MAX_PROBES; c++) if (!used.has(c)) return c;
    return -1;
  }
  /** opt: { quiet (no panel refresh: bulk adds), keep (Set of probe ids not to evict) } */
  L.addProbe = function (o, opt) {
    opt = opt || {};
    const name = o.name || (o.net ? L.netName.get(o.net) : null);
    if (!name && !o.net) return null;
    const dup = L.probes.find(p => p.kind !== 'decode' && p.name === name && (p.ref || '') === (o.ref || '') && String(p.pin || '') === String(o.pin || ''));
    if (dup) { dup.at = o.at || dup.at; if (L.ui && !opt.quiet) L.ui.focusProbe(dup); return dup; }
    const ch = freeChannel(opt.keep);
    if (ch < 0) return null;
    const net = o.net || L.netIdx.get(name) || 0;
    const p = { id: ++L.pid, ch, color: PROBE_COLORS[ch], net, name, ref: o.ref || null, pin: o.pin != null ? String(o.pin) : null, pinName: o.pinName || '', kind: o.ref ? 'pin' : 'net', at: o.at || null, seg: o.seg != null ? o.seg : null,
      label: o.label || (o.ref ? `${o.ref}.${o.pin}${o.pinName ? ' ' + o.pinName : ''}` : N.fmt.shortNet(name || L.B.nets[net])),
      buf: new Float32Array(RING), tb: new Float64Array(RING), head: 0, n: 0, stats: null, ibuf: new Float32Array(512), ih: 0, in: 0 };
    bindProbe(p);
    L.probes.push(p);
    probeStats(p);
    if (L.ui && !opt.quiet) L.ui.probesChanged(p);
    return p;
  };
  // a protocol lane: the transfers a program makes on a bus, decoded from the bus models (o: { bus: 'i2c' | 'spi' | 'uart', proc, idx, label })
  L.addDecoder = function (o, opt) {
    opt = opt || {};
    const dup = L.probes.find(p => p.kind === 'decode' && p.bus === o.bus && p.proc === o.proc && p.idx === (o.idx || 0));
    if (dup) { if (L.ui && !opt.quiet) L.ui.focusProbe(dup); return dup; }
    const ch = freeChannel(opt.keep);
    if (ch < 0) return null;
    const p = { id: ++L.pid, ch, color: PROBE_COLORS[ch], kind: 'decode', bus: o.bus, proc: o.proc, idx: o.idx || 0, label: o.label || `${o.bus.toUpperCase()} · ${o.proc}`, net: 0, name: null, at: null, stats: null, n: 0 };
    L.probes.push(p);
    probeStats(p);
    if (L.ui && !opt.quiet) L.ui.probesChanged(p);
    return p;
  };
  // several signals at once; returns how many were added (or were there already)
  L.addSignals = function (sigs, decoders, opt) {
    const keep = new Set();
    let first = null, n = 0, full = false;
    for (const s of sigs || []) { const p = L.addProbe(s, { quiet: true, keep }); if (p) { keep.add(p.id); n++; first = first || p; } else full = true; }
    for (const d of decoders || []) { const p = L.addDecoder(d, { quiet: true, keep }); if (p) { keep.add(p.id); n++; first = first || p; } else full = true; }
    if (full) N.toast(`The scope has ${MAX_PROBES} channels: pin the probes you want to keep, or clear some.`, 'warn');
    if (L.ui) L.ui.probesChanged(opt && opt.stay ? null : first);
    return n;
  };
  L.removeProbe = function (id, quiet) {
    const i = L.probes.findIndex(p => p.id === id);
    if (i < 0) return;
    L.probes.splice(i, 1);
    if (!quiet && L.ui) L.ui.probesChanged(null);
  };
  L.clearProbes = function () { L.probes = []; if (L.ui) L.ui.probesChanged(null); };
  function sampleStep(t) {
    const P = L.probes;
    if (!P.length) return;
    const x = L.engine.x;
    for (let k = 0; k < P.length; k++) {
      const p = P[k];
      if (!p.buf) continue;
      const h = p.head;
      p.buf[h] = p.idx >= 0 ? x[p.idx] : 0;
      p.tb[h] = t;
      p.head = (h + 1) % RING;
      if (p.n < RING) p.n++;
    }
  }
  // samples of a probe from time t0 on: [t[], v[]]
  L.probeSeries = function (p, t0) {
    const n = p.n, T = [], V = [];
    if (!p.buf) return [T, V];
    for (let k = n; k > 0; k--) { const i = (p.head - k + RING) % RING; if (p.tb[i] < t0) continue; T.push(p.tb[i]); V.push(p.buf[i]); }
    return [T, V];
  };
  // readings over the scope window: level, min/max, frequency and duty of periodic signals, current
  function probeStats(p) {
    const e = L.engine;
    if (!e) return;
    const span = L.scopeSpan();
    if (p.kind === 'decode') {
      const ev = L.decodeEvents(p, e.t - span, e.t);
      p.stats = { n: ev.length, rate: ev.length / span, bad: ev.filter(x => x.bad).length, last: ev.length ? ev[ev.length - 1].text : '', live: !!decodeSource(p) };
      return;
    }
    const [T, V] = L.probeSeries(p, e.t - span);
    const st = { v: p.idx >= 0 ? e.x[p.idx] : 0, float: p.net ? L.netFloating(p.net) : false, idle: p.net ? L.netIdle(p.net) : false, n: V.length };
    if (V.length) {
      let lo = Infinity, hi = -Infinity, sum = 0;
      for (const v of V) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
      st.min = lo; st.max = hi; st.avg = sum / V.length; st.pp = hi - lo;
      if (st.pp > 0.2) {
        const mid = (hi + lo) / 2, hy = st.pp * 0.1;
        let state = V[0] > mid ? 1 : 0, first = -1, last = -1, edges = 0, high = 0, tot = 0;
        for (let i = 1; i < V.length; i++) {
          if (state === 0 && V[i] > mid + hy) { state = 1; if (first < 0) first = T[i]; last = T[i]; edges++; }
          else if (state === 1 && V[i] < mid - hy) state = 0;
          if (first >= 0) { const d = T[i] - T[i - 1]; tot += d; if (V[i] > mid) high += d; }
        }
        if (edges >= 2 && last > first) { st.freq = (edges - 1) / (last - first); st.duty = tot > 0 ? high / tot : 0; }
      }
    }
    // logic level against the IO supply of the processor on this net
    const vref = p.ref && (L.procs || []).find(q => q.ref === p.ref) ? (L.procs.find(q => q.ref === p.ref).vnom) : 3.3;
    st.logic = st.float ? 'floating' : st.idle ? 'not driven' : st.v > 0.7 * vref ? 'HIGH' : st.v < 0.3 * vref ? 'LOW' : 'between';
    if (p.ref) { st.i = L.padI(p.ref, p.pin); }
    else if (p.seg != null) { const F = L.B._pcbFlow; st.i = F && F.segI ? F.segI[p.seg] : null; }
    p.stats = st;
  }
  L.scopeSpan = function () {
    if (L.scopeFixed) return L.scopeFixed;
    const s = L.speed || 1e-3;
    return Math.min(2, Math.max(s * 1.2, (L.engine ? L.engine.dt : 1e-5) * 200));
  };

  // ---------------------------------------------------------------- protocol decoders (from the bus models' transaction logs)
  const hx2 = b => (b & 255).toString(16).padStart(2, '0').toUpperCase();
  const bytesTxt = (a, n) => a.slice(0, n).map(hx2).join(' ') + (a.length > n ? ' …' : '');
  function decodeSource(p) {
    const run = L.fwm && L.fwm.get(p.proc);
    if (!run) return null;
    if (p.bus === 'uart') return run.console ? { log: run.console.log || [], baud: run.console.baud || 115200 } : null;
    const hw = run.hw;
    if (!hw) return null;
    const b = p.bus === 'i2c' ? hw.i2c[p.idx] : hw.spi[p.idx];
    if (!b) return null;
    return p.bus === 'i2c' ? { log: b.wire.log || [], clock: b.wire.clock || 1e5 } : { log: b.spi.log || [], hz: b.spi.hz || 4e6, cur: b.spi.cur };
  }
  /** decoded transfers overlapping [t0, t1]: [{ t, dur, text, bad }] */
  L.decodeEvents = function (p, t0, t1) {
    const s = decodeSource(p), out = [];
    if (!s) return out;
    if (p.bus === 'i2c') {
      for (const x of s.log) {
        const w = x.write || [], r = x.read || [];
        const dur = ((1 + w.length + (r.length ? 1 + r.length : 0)) * 9 + 2) / s.clock;
        if (x.t + dur < t0 || x.t > t1) continue;
        out.push({ t: x.t, dur, bad: x.ack === false, text: `${hx2(x.addr)}${w.length ? ' W ' + bytesTxt(w, 6) : ''}${r.length ? ' R ' + bytesTxt(r, 6) : ''}${x.ack === false ? ' NACK' : ''}` });
      }
    } else if (p.bus === 'spi') {
      const run = L.fwm.get(p.proc), io = n => run && run.info.io.find(q => q.number === n);
      for (const x of s.cur ? s.log.concat([s.cur]) : s.log) {
        const dur = Math.max(1, x.n) * 8 / s.hz;
        if (x.t + dur < t0 || x.t > t1) continue;
        const cs = io(x.cs);
        out.push({ t: x.t, dur, text: `${cs ? N.fw.shortPin(cs) + ': ' : ''}${bytesTxt(x.out || [], 8)}${x.n > 8 ? ' (' + x.n + ' B)' : ''}` });
      }
    } else {
      // serial: writes close together form one frame of text
      const ct = 10 / s.baud;
      let cur = null;
      const flush = () => { if (cur && cur.t + cur.dur >= t0 && cur.t <= t1) out.push(cur); cur = null; };
      for (const x of s.log) {
        if (x.sys) { flush(); continue; }
        const txt = x.s.replace(/\r/g, '');
        if (!txt) continue;
        if (cur && x.t <= cur.t + cur.dur + ct * 4) { cur.text += txt; cur.dur = Math.max(cur.dur, x.t - cur.t) + txt.length * ct; }
        else { flush(); cur = { t: x.t, dur: txt.length * ct, text: txt }; }
      }
      flush();
      for (const e of out) e.text = e.text.replace(/\n+$/, '').replace(/\n/g, ' ⏎ ');
    }
    return out;
  };

  // groups of signals for "+ Signals": a processor's pins, each bus with its decoder, the serial port, LEDs, rails
  L.signalGroups = function () {
    const out = [];
    const sigOf = (proc, io) => ({ name: io.net, net: L.netIdx.get(io.net) || 0, ref: proc.ref, pin: io.number, pinName: N.fw ? N.fw.shortPin(io) : io.name });
    const okNet = io => io && io.net && L.netIdx.has(io.net) && !/^unconnected|^NC$/i.test(io.net);
    for (const pr of L.procs || []) {
      const run = L.fwm && L.fwm.get(pr.ref);
      const running = run && run.state === 'running';
      const used = running && run.drive ? [...run.drive.entries()].filter(([, m]) => m !== 'z').map(([n]) => pr.io.find(x => x.number === n)).filter(okNet) : [];
      const all = pr.io.filter(okNet);
      if (used.length) out.push({ label: `${pr.ref}: the pins the program drives`, hint: `${used.length} signal${used.length > 1 ? 's' : ''}`, add: () => L.addSignals(used.slice(0, MAX_PROBES).map(io => sigOf(pr, io))) });
      if (all.length) out.push({ label: `${pr.ref}: every IO pin`, hint: all.length > MAX_PROBES ? `first ${MAX_PROBES} of ${all.length}` : `${all.length} signals`, add: () => L.addSignals(all.slice(0, MAX_PROBES).map(io => sigOf(pr, io))) });
      let a = null;
      try { a = L.analysisFor(pr); } catch (e) { a = null; }
      const short = io => (N.fw ? N.fw.shortPin(io) : io.name);
      (a && a.i2c || []).forEach((b, i) => {
        const pins = [b.sdaIo, b.sclIo].filter(okNet);
        const devs = (b.devices || []).map(d => d.ref).slice(0, 4).join(', ');
        out.push({ label: `${pr.ref}: I2C ${pins.map(short).join(' / ')}${devs ? ' → ' + devs : ''}`, hint: 'pins + decoder', add: () => L.addSignals(pins.map(io => sigOf(pr, io)), [{ bus: 'i2c', proc: pr.ref, idx: i, label: `I2C ${pins.map(short).join('/')} · ${pr.ref}` }]) });
      });
      (a && a.spi || []).forEach((b, i) => {
        const io = n => pr.io.find(x => x.number === n);
        const pins = [io(b.sck), io(b.mosi), io(b.miso)].concat((b.devices || []).map(d => d.csIo)).filter(okNet).filter((x, k, arr) => arr.indexOf(x) === k);
        const devs = (b.devices || []).map(d => d.ref).slice(0, 4).join(', ');
        out.push({ label: `${pr.ref}: SPI ${pins.slice(0, 3).map(short).join(' / ')}${devs ? ' → ' + devs : ''}`, hint: 'pins + decoder', add: () => L.addSignals(pins.slice(0, MAX_PROBES - 1).map(x => sigOf(pr, x)), [{ bus: 'spi', proc: pr.ref, idx: i, label: `SPI · ${pr.ref}` }]) });
      });
      const ser = pr.chip && pr.chip.arduino && pr.chip.arduino.serial;
      const u0 = a && (a.uarts || []).find(u => u.txIo);
      const tx = u0 ? u0.txIo : ser && ser.tx ? pr.io.find(x => x.chipPin === ser.tx) : null;
      if (run || tx) out.push({ label: `${pr.ref}: Serial${tx && !(a && a.usb) ? ' ' + short(tx) : a && a.usb ? ' (USB)' : ''}`, hint: 'decoded text', add: () => L.addSignals(tx && okNet(tx) && !(a && a.usb) ? [sigOf(pr, tx)] : [], [{ bus: 'uart', proc: pr.ref, idx: 0, label: `Serial · ${pr.ref}` }]) });
    }
    // LEDs: the switched side of each one
    const ledSigs = [];
    for (const d of L.leds || []) {
      const c = L.comp && L.comp.get(d.ref);
      if (!c) continue;
      const nets = (c.pins || []).map(pn => { const n = L.B.padNet ? L.B.padNet(d.ref, pn.number) : null; return n ? L.netName.get(n) || L.B.nets[n] : null; }).filter(Boolean);
      const sw = nets.find(nm => L.netIdx.has(nm) && !/^(GND|VSS|AGND|DGND)$|^\+?\d+V\d*$|^\+?3V3$|^VCC|^VDD|^VBUS|^VSYS/i.test(N.fmt.shortNet(nm)));
      if (sw) ledSigs.push({ name: sw, net: L.netIdx.get(sw), label: `${d.ref} · ${N.fmt.shortNet(sw)}` });
    }
    if (ledSigs.length) out.push({ label: 'LEDs', hint: `${ledSigs.length} signal${ledSigs.length > 1 ? 's' : ''}`, add: () => L.addSignals(ledSigs.slice(0, MAX_PROBES)) });
    const rails = L.rails();
    if (rails.length) out.push({ label: 'Supply rails', hint: `${rails.length} rail${rails.length > 1 ? 's' : ''}`, add: () => L.addSignals(rails.slice(0, MAX_PROBES).map(r => ({ name: r.name }))) });
    return out;
  };

  // ---------------------------------------------------------------- "what drives this net"
  const valOf = ref => { const c = L.comp && L.comp.get(ref); return c ? c.value || '' : ''; };
  const nodeNetName = nd => (nd < 0 ? 'GND' : N.fmt.shortNet(L.engine.nodeNet.get([...L.engine.idx].find(([, i]) => i === nd)?.[0]) || ''));
  function describeEl(r) {
    const e = r.e, E = L.engine;
    const otherName = () => { if (!r.other.length) return ''; const o = r.other[0]; if (o < 0) return 'GND'; for (const [nm, i] of E.idx) if (i === o) return N.fmt.shortNet(E.nodeNet.get(nm) || nm.replace(/^n_/, '')); return ''; };
    switch (e.t) {
      case 'V': return e.supply ? `supply ${N.fmt.shortNet(e.net)} (${fmtV(e.w.kind === 'dc' ? e.w.value : e.w.high)})` : `${e.ref} (stand-in source)`;
      case 'REG': return r.k === 'out' ? `${e.ref} ${valOf(e.ref)} regulator output${e._on === 0 ? ' (switched off)' : ''}` : `${e.ref} regulator input`;
      case 'SWR': return r.k === 'sw' ? `${e.ref} ${valOf(e.ref)} switching regulator` : `${e.ref} converter input`;
      case 'LSW': return `${e.ref} ${valOf(e.ref)} load switch (${e.on ? (e.limited ? 'on, current limited' : 'on') : 'off'})`;
      case 'DRV': { const pr = (L.procs || []).find(p => p.ref === e.ref); const io = pr && pr.io.find(x => x.number === e.pin); return `${e.ref} ${io ? N.fw.shortPin(io) : 'pin ' + e.pin} ${MODE_TXT[e.mode] || e.mode}`; }
      case 'R': return e.load ? `${e.ref || N.fmt.shortNet(e.net || '')} supply current (modelled load)` : e.sw ? `${e.ref} switch (${e.closed ? 'closed' : 'open'}) to ${otherName()}` : `${e.ref} ${valOf(e.ref) || ''} to ${otherName()}`;
      case 'C': return `${e.ref} ${valOf(e.ref)} capacitor to ${otherName()}`;
      case 'L': return `${e.ref} ${valOf(e.ref)} inductor to ${otherName()}`;
      case 'D': return `${e.ref} ${valOf(e.ref)} ${e.model === 'DLED' ? 'LED' : 'diode'} to ${otherName()}`;
      case 'Q': return `${e.ref} transistor (${r.k === 'b' ? 'base' : r.k === 'c' ? 'collector' : 'emitter'})`;
      case 'M': return `${e.ref} MOSFET (${r.k === 'g' ? 'gate' : r.k === 'd' ? 'drain' : 'source'})`;
      case 'OPA': return `${e.ref} op-amp ${r.k === 'out' ? 'output' : 'input'}`;
      case 'T555': return `${e.ref} 555 ${r.k}`;
    }
    return e.ref || e.t;
  }
  void nodeNetName;
  L.explain = function (name) {
    const E = L.engine;
    if (!E) return null;
    const nd = L.netNode.get(name);
    const out = { floating: false, items: [], pins: [] };
    const cn = L.base.circuit.nets.find(n => n.name === name);
    if (cn) out.pins = cn.nodes.slice(0, 14).map(x => { const c = L.comp.get(x.ref); const pn = c && (c.pins || []).find(q => String(q.number) === String(x.pin)); return `${x.ref}.${x.pin}${pn && pn.name && pn.name !== String(x.pin) ? ' ' + pn.name : ''}`; });
    if (!nd) { out.ground = L.netIdx.has(name); return out; }
    const k = E.nodeIndex(nd);
    out.floating = k >= 0 && E.floatingNodes()[k] === 1;
    if (out.floating) { const ni = L.netIdx.get(name); out.idle = !!(ni && L.flt[ni] === 2); out.why = ni ? L.netWhy(ni) : ''; }
    const rep = E.nodeReport(k);
    const drives = rep.filter(r => r.i != null && Math.abs(r.i) > 1e-7);
    const passive = rep.filter(r => !drives.includes(r) && ['DRV', 'REG', 'SWR', 'LSW', 'V'].includes(r.e.t));
    out.items = drives.slice(0, 5).map(r => ({ text: describeEl(r), i: r.i })).concat(passive.slice(0, 3).map(r => ({ text: describeEl(r), i: null })));
    return out;
  };
  // rails of the board with their nominal voltage and, when one is off, why
  L.rails = function () {
    const out = [];
    for (const [name, i] of L.netIdx) {
      const n = L.base.circuit.nets.find(x => x.name === name);
      if (!n || n.kind !== 'power') continue;
      const guess = N.simtab.voltOf(name);
      const short = String(name).split('/').pop();
      if (guess == null && !/^[+-]|^V|VCC|VDD|VEE|VSS|VBAT|VBUS|VIN|VOUT|VREG|PWR|SUPPLY|LDO|BUCK|RAIL/i.test(short)) continue;
      if (/^(SW|LX|PH)(\d|_)|_(SW|LX)\d*$|^N\d+$/i.test(short)) continue;   // converter switch nodes are not rails
      // judge only rails whose name states the voltage (+3V3, 5V_USB); VCC / VDD / VIN are shown but not judged
      const nom = N.simtab.nominalOf ? N.simtab.nominalOf(name) : guess;
      const v = L.netV[i];
      const ok = nom == null ? (/VBUS/i.test(short) && (v === v ? v : 0) < 0.5 ? false : null) : Math.abs((v === v ? v : 0) - nom) <= 0.06 * Math.abs(nom) + 0.05;
      out.push({ name, i, v, nom, guess, ok, reason: ok === false ? L.railReason(name) : '' });
    }
    out.sort((a, b) => (b.nom || 0) - (a.nom || 0) || (a.name < b.name ? -1 : 1));
    return out.slice(0, 40);
  };
  L.railReason = function (name) {
    const E = L.engine;
    const nd = L.netNode.get(name);
    if (!E || !nd) return '';
    // walk from the rail through inductors, ferrites, fuses, 0 R links and diodes to whatever supplies it
    const isSrc = r => (r.e.t === 'REG' && r.k === 'out') || (r.e.t === 'SWR' && r.k === 'sw') || r.e.t === 'LSW' || (r.e.t === 'V' && r.e.supply);
    let src = null;
    const seen = new Set([E.nodeIndex(nd)]), q = [E.nodeIndex(nd)];
    while (q.length && !src && seen.size < 40) {
      const k = q.shift();
      for (const r of E.byNode.get(k) || []) {
        if (isSrc(r)) { src = r; break; }
        const e = r.e;
        const link = e.t === 'L' || (e.t === 'R' && !e.load && !e.sw && e.v <= 2) || e.t === 'D';
        if (!link) continue;
        for (const o of [e._a, e._b]) if (o >= 0 && !seen.has(o)) { seen.add(o); q.push(o); }
      }
    }
    const enWhy = e => {
      if (e._en == null || e._en < 0) return '';
      const enName = [...E.idx].find(([, i]) => i === e._en);
      const nm = enName ? E.nodeNet.get(enName[0]) || enName[0] : '';
      const v = E.x[e._en];
      const ex = nm ? L.explain(nm) : null;
      const drv = ex && ex.items.find(x => /pin|drives|pull/.test(x.text));
      return `EN (${N.fmt.shortNet(nm)}) is ${fmtV(v)}${ex && ex.floating ? ', floating' : ''}${drv ? ' - ' + drv.text : ''}`;
    };
    if (!src) return 'nothing on the board supplies it here (it comes from a connector, a module or a chip without a model)';
    const e = src.e;
    if (e.t === 'LSW' && !e.on) return `${e.ref} is off: ${enWhy(e)}`;
    if (e.t === 'REG' && e._on === 0) return `${e.ref} is switched off: ${enWhy(e)}`;
    if ((e.t === 'REG' || e.t === 'SWR') && e._in >= 0 && E.x[e._in] < 0.5) return `${e.ref} has no input (${fmtV(E.x[e._in])})`;
    if (e.t === 'LSW' && e._a >= 0 && E.x[e._a] < 0.5) return `${e.ref} has no input (${fmtV(E.x[e._a])})`;
    return '';
  };

  // ---------------------------------------------------------------- clicks on the board
  L.probePad = function (pi, at) {
    const B = L.B, p = B.pads[pi];
    if (!p) return null;
    const f = B.fps[p[0]];
    return L.addProbe({ net: p[10], ref: f.r, pin: p[1], pinName: p[14] && p[14] !== '~' ? p[14] : '', at: at || { view: 'pcb', x: p[4], y: p[5] } });
  };
  // a part: its busiest pins (up to six) on the scope
  L.probePart = function (ref) {
    const B = L.B, f = B.fp(ref);
    if (!f) return null;
    const seen = new Set(), list = [];
    for (const pi of f.pads) { const p = B.pads[pi]; const k = String(p[1]); if (!k || seen.has(k) || !p[10] || L.netIdx.get(L.netName.get(p[10])) == null) continue; seen.add(k); list.push(pi); }
    list.sort((a, b) => Math.abs(L.padI(ref, B.pads[b][1])) - Math.abs(L.padI(ref, B.pads[a][1])));
    const sigs = list.slice(0, 6).map(pi => { const p = B.pads[pi]; return { net: p[10], ref, pin: p[1], pinName: p[14] && p[14] !== '~' ? p[14] : '', at: { view: 'pcb', x: p[4], y: p[5] } }; });
    if (!sigs.length) return null;
    L.addSignals(sigs, []);
    return L.probes.find(p => p.ref === ref) || null;
  };
  // a click in a view while live: {view, hit, at}
  L.probeHit = function (o) {
    if (!L.on || !o || !o.hit) return;
    const h = o.hit, B = L.B;
    if (o.view === 'pcb' || o.view === '3d') {
      if (h.type === 'pad') return L.probePad(h.i, { view: o.view, x: B.pads[h.i][4], y: B.pads[h.i][5], side: o.side });
      if (h.type === 'via') { const v = B.pcb.vias[h.i]; return L.addProbe({ net: h.net, label: 'via · ' + N.fmt.shortNet(B.nets[h.net]), at: { view: o.view, x: v[0], y: v[1] } }); }
      if (h.type === 'track' && h.net) {
        N.pcbFlow(B);
        // the piece of this net's copper under the click (never a neighbour on another net or layer)
        const s = o.at ? N.liveSegAt(B, h.net, o.at[0], o.at[1], h.L) : -1;
        const seg = s >= 0 ? s : null;
        return L.addProbe({ net: h.net, seg, label: 'trace · ' + N.fmt.shortNet(B.nets[h.net]), at: { view: o.view, x: o.at ? o.at[0] : 0, y: o.at ? o.at[1] : 0 } });
      }
      if (h.type === 'zone' && h.net) return L.addProbe({ net: h.net, label: 'pour · ' + N.fmt.shortNet(B.nets[h.net]), at: o.at ? { view: o.view, x: o.at[0], y: o.at[1] } : null });
    }
    if (o.view === 'sch') {
      if (h.type === 'pin') { const net = B.padNet(h.p.ref, h.p.num); if (net) return L.addProbe({ net, ref: h.p.ref, pin: h.p.num, pinName: h.p.name || '', at: { view: 'sch', page: o.page, x: h.p.x, y: h.p.y } }); }
      if ((h.type === 'wire' || h.type === 'label') && o.net) return L.addProbe({ net: o.net, at: o.at ? { view: 'sch', page: o.page, x: o.at[0], y: o.at[1] } : null });
    }
    return null;
  };
  L.onSelection = function (sel) {
    if (!L.on) return;
    for (const r of sel.refs) {
      // a click presses a button; on a rotary encoder it presses the knob, on a DIP switch it flips the first contact
      const list = L.engine.switches().filter(s => s.ref === r && !s.auto);
      const sw = list.find(s => s.key === 'S') || list.find(s => s.key === '') || list[0];
      if (sw && sel.refs.size === 1 && !sel.nets.size) { L.engine.setSwitch(r, !sw.closed, sw.key); N.toast(`${r}${sw.key && list.length > 1 ? ' ' + sw.key : ''} ${sw.closed ? (sw.jumper ? 'opened' : 'released') : (sw.jumper ? 'bridged' : 'pressed / closed')}`); if (L.ui) L.ui.refresh(); }
    }
  };
  // drive a processor pin by hand (bring-up style), or let it go
  L.forcePin = function (ref, pin, mode) {
    const k = ref + '\u0000' + pin;
    if (!mode || mode === 'release') { L.forced.delete(k); const run = L.fwm && L.fwm.get(ref); const m = run && run.drive && run.drive.get(String(pin)); L.engine.setDrive(ref, pin, m || 'z'); }
    else { L.forced.set(k, mode); L.engine.setDrive(ref, pin, mode); }
    if (L.ui) L.ui.refresh();
  };
  L.injectFault = function (f) {
    const snap = L.engine.snapshot();
    const circ = window.DS2K_DBG.apply(L.base.circuit, f);
    try { build(circ, L.base.sim, snap); L.fault = f; N.toast('Fault injected: ' + f.text); }
    catch (e) { N.toast('Could not inject that fault: ' + e.message, 'warn'); }
    if (L.ui) L.ui.refresh();
  };
  L.clearFault = function () {
    const snap = L.engine.snapshot();
    build(L.base.circuit, L.base.sim, snap);
    L.fault = null;
    if (L.ui) L.ui.refresh();
  };
  L.faultsFor = function (sel) {
    const all = window.DS2K_DBG.faults(L.base.circuit);
    const refs = sel.refs, names = new Set([...sel.nets].map(n => L.netName.get(n)).filter(Boolean));
    let out = all.filter(f => (f.ref && refs.has(f.ref)) || (f.net && names.has(f.net)) || (f.a && (names.has(f.a) || names.has(f.b))));
    if (!out.length && !refs.size && !names.size) out = all.filter(f => f.kind === 'netgnd' || f.kind === 'bridge').slice(0, 12);
    return out.slice(0, 24);
  };
  L.analysisFor = function (proc) {
    if (!L.analysis) L.analysis = new Map();
    if (!L.analysis.has(proc.ref)) { let a = null; try { a = N.analysis.forProc(L.base.circuit, proc); } catch (e) { console.error(e); } L.analysis.set(proc.ref, a); }
    return L.analysis.get(proc.ref);
  };
  L.openCode = ref => { if (L.on && L.ui) L.ui.open('code', ref || (L.procs && L.procs[0] && L.procs[0].ref)); };

})();

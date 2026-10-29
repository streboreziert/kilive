/* KiLive — current on the copper.
   Each net's tracks, vias, pads and pours are a resistor network (35 µm copper: 0.5 mΩ per square). The pin currents of
   the circuit simulation go in at the pads and the network is solved exactly: a sparse LDLᵀ factorisation (minimum-degree
   order, factored once per net) and two triangular solves per update. Current divides between parallel tracks and through
   pours as on the real board, and every junction balances (Kirchhoff's current law).
   N.pcbFlow(B) -> { segs: Float32Array [x1, y1, x2, y2, width, layer] per piece of track, nseg, segI (A, from (x1, y1) to (x2, y2)),
   phase, legs (pad, footprint) for the dots through parts, legI, legPhase, padShare, nets, check() } */
(function () {
  'use strict';
  const N = window.Noeti;
  const RS = 0.5e-3;            // Ω per square of 1 oz copper
  const G_VIA = 1 / 0.6e-3;     // through a via barrel
  const G_PAD = 1 / 0.15e-3;    // a pad and the track end or via on it
  const G_ZONE = 1 / RS;        // neighbouring contacts in a pour: about one square apart
  const hyp = Math.hypot;

  // ---------------------------------------------------------------- geometry
  function segProj(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
    const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2));
    return [t, hyp(px - (x1 + t * dx), py - (y1 + t * dy))];
  }
  function rot(x, y, deg) { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [x * c + y * s, -x * s + y * c]; }
  // distance from a point to a pad's copper (0 inside); custom pads by their extent
  function padDist(p, x, y) {
    const r = rot(x - p[4], y - p[5], -(p[8] || 0)), lx = r[0], ly = r[1];
    if (p[3] === 0) return Math.max(0, hyp(lx, ly) - p[6] / 2);
    const ox = Math.max(0, Math.abs(lx) - p[6] / 2), oy = Math.max(0, Math.abs(ly) - p[7] / 2);
    return hyp(ox, oy);
  }
  function pip(x, y, f) {
    let ins = false;
    for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
      const xi = f[i], yi = f[i + 1], xj = f[j], yj = f[j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  }
  // a hash grid of points or boxes (cell in mm)
  class Grid {
    constructor(cell) { this.c = cell; this.m = new Map(); }
    key(gx, gy) { return (gx + 32768) * 65536 + (gy + 32768); }
    addBox(id, x0, y0, x1, y1) {
      const c = this.c, ax = Math.floor(x0 / c), bx = Math.floor(x1 / c), ay = Math.floor(y0 / c), by = Math.floor(y1 / c);
      for (let gx = ax; gx <= bx; gx++) for (let gy = ay; gy <= by; gy++) { const k = this.key(gx, gy); const l = this.m.get(k); if (l) l.push(id); else this.m.set(k, [id]); }
    }
    add(id, x, y) { this.addBox(id, x, y, x, y); }
    near(x, y, r, out) {
      out.length = 0;
      const c = this.c, ax = Math.floor((x - r) / c), bx = Math.floor((x + r) / c), ay = Math.floor((y - r) / c), by = Math.floor((y + r) / c);
      for (let gx = ax; gx <= bx; gx++) for (let gy = ay; gy <= by; gy++) { const l = this.m.get(this.key(gx, gy)); if (l) for (const id of l) if (!out.includes(id)) out.push(id); }
      return out;
    }
  }

  // ---------------------------------------------------------------- one net's network
  class Net {
    constructor(net) { this.net = net; this.n = 0; this.x = []; this.y = []; this.ea = []; this.eb = []; this.eg = []; this.eseg = []; this.pads = []; }
    node(x, y) { this.x.push(x); this.y.push(y); return this.n++; }
    edge(a, b, g, seg) { if (a === b || !(g > 0)) return; this.ea.push(a); this.eb.push(b); this.eg.push(g); this.eseg.push(seg == null ? -1 : seg); }
  }

  function buildNet(B, net, d, disp) {
    const W = new Net(net), cuN = B.cu.length;
    const tmp = [];
    // track ends: one node per place a track ends, per layer (ends closer than a quarter width are one node)
    const ends = new Map();   // layer -> Grid of end nodes
    const endW = [], endL = [];
    const endAt = (li, x, y, w) => {
      let g = ends.get(li);
      if (!g) ends.set(li, (g = new Grid(0.5)));
      const tol = Math.max(0.001, Math.min(0.05, w / 4));
      for (const id of g.near(x, y, tol, tmp)) if (hyp(W.x[id] - x, W.y[id] - y) <= tol) { if (w > endW[id]) endW[id] = w; return id; }
      const id = W.node(x, y);
      endW[id] = w; endL[id] = li;
      g.add(id, x, y);
      return id;
    };
    const segs = d.segs.map(s => ({ li: s[0], x1: s[1], y1: s[2], x2: s[3], y2: s[4], w: s[5], a: endAt(s[0], s[1], s[2], s[5]), b: endAt(s[0], s[3], s[4], s[5]), splits: [] }));
    // tracks by layer, for T-junctions and things landing on a track
    const segGrid = new Map();
    segs.forEach((s, i) => { let g = segGrid.get(s.li); if (!g) segGrid.set(s.li, (g = new Grid(1))); const r = s.w / 2; g.addBox(i, Math.min(s.x1, s.x2) - r, Math.min(s.y1, s.y2) - r, Math.max(s.x1, s.x2) + r, Math.max(s.y1, s.y2) + r); });
    const splitOn = (li, x, y, reach, node, skip) => {
      const g = segGrid.get(li);
      if (!g) return false;
      let hit = false;
      for (const si of g.near(x, y, reach, tmp.slice(0, 0))) {
        const s = segs[si];
        if (s.a === node || s.b === node || si === skip) continue;
        const [t, dd] = segProj(x, y, s.x1, s.y1, s.x2, s.y2);
        if (dd > reach + s.w / 2 - 0.002) continue;
        const L = hyp(s.x2 - s.x1, s.y2 - s.y1);
        if (t * L < s.w / 2 || (1 - t) * L < s.w / 2) continue;   // at an end: that end is (or joins) the node already
        if (!s.splits.some(q => q.node === node)) s.splits.push({ t, node });
        hit = true;
      }
      return hit;
    };
    // a track ending on the middle of another one
    for (let id = 0; id < W.n; id++) splitOn(endL[id], W.x[id], W.y[id], endW[id] / 2, id, -1);
    // vias: one node each, joined to the track ends on them and to tracks running over them
    const viaNode = d.vias.map(v => W.node(v[0], v[1]));
    const viaGrid = new Grid(1);
    d.vias.forEach((v, k) => viaGrid.add(k, v[0], v[1]));
    d.vias.forEach((v, k) => {
      const l0 = v[6] != null ? v[6] : 0, l1 = v[7] != null ? v[7] : cuN - 1, r = v[2] / 2;
      for (const [li, g] of ends) {
        if (li < l0 || li > l1) continue;
        for (const id of g.near(v[0], v[1], r + 0.5, tmp)) if (hyp(W.x[id] - v[0], W.y[id] - v[1]) <= r + endW[id] / 2 - 0.002) W.edge(viaNode[k], id, G_VIA);
      }
      for (let li = l0; li <= l1; li++) splitOn(li, v[0], v[1], r, viaNode[k], -1);
    });
    // pads: one node each, joined to track ends on them, tracks crossing them, vias in them and pads on top of them
    const padLayers = p => { const m = p[9], s = []; if (m & 1) s.push(0); if (m & 2) s.push(cuN - 1); if (m & 4) for (let l = 1; l < cuN - 1; l++) s.push(l); return s; };
    const padNode = new Map();
    for (const pi of d.pads) {
      const p = B.pads[pi], pn = W.node(p[4], p[5]);
      padNode.set(pi, pn);
      W.pads.push([pi, pn]);
      const ls = padLayers(p), R = Math.max(p[6], p[7]) / 2 + 0.5;
      // the track ends on the pad (layer -1: the straight unrouted connections of boards drawn here)
      for (const li of ls.concat([-1])) {
        const g = ends.get(li);
        if (g) for (const id of g.near(p[4], p[5], R, tmp)) if (padDist(p, W.x[id], W.y[id]) <= Math.max(0.01, endW[id] / 2 - 0.002)) W.edge(pn, id, G_PAD);
        if (li >= 0) splitOn(li, p[4], p[5], Math.min(p[6], p[7]) / 2, pn, -1);
      }
      for (const k of viaGrid.near(p[4], p[5], R, tmp)) { const v = d.vias[k], l0 = v[6] != null ? v[6] : 0, l1 = v[7] != null ? v[7] : cuN - 1; if (ls.some(l => l >= l0 && l <= l1) && padDist(p, v[0], v[1]) <= v[2] / 2 - 0.002) W.edge(pn, viaNode[k], G_PAD); }
    }
    // pads lying on pads of the same net
    const padGrid = new Grid(2);
    d.pads.forEach((pi, i) => padGrid.add(i, B.pads[pi][4], B.pads[pi][5]));
    for (let i = 0; i < d.pads.length; i++) {
      const p = B.pads[d.pads[i]];
      for (const j of padGrid.near(p[4], p[5], Math.max(p[6], p[7]) / 2 + 3, tmp)) {
        if (j <= i) continue;
        const q = B.pads[d.pads[j]];
        if (hyp(p[4] - q[4], p[5] - q[5]) > (Math.max(p[6], p[7]) + Math.max(q[6], q[7])) / 2) continue;
        if (padDist(p, q[4], q[5]) <= 0.01 || padDist(q, p[4], p[5]) <= 0.01) { const a = padLayers(p), b = padLayers(q); if (a.some(l => b.includes(l))) W.edge(padNode.get(d.pads[i]), padNode.get(d.pads[j]), G_PAD); }
      }
    }
    // the pieces of every track between its ends and the points where things join it
    for (const s of segs) {
      s.splits.sort((u, v) => u.t - v.t);
      const pts = [{ t: 0, node: s.a }].concat(s.splits, [{ t: 1, node: s.b }]);
      const L = hyp(s.x2 - s.x1, s.y2 - s.y1);
      for (let k = 0; k + 1 < pts.length; k++) {
        const p = pts[k], q = pts[k + 1];
        if (p.node === q.node) continue;
        const len = Math.max(0.005, (q.t - p.t) * L);
        const sx = s.x1 + (s.x2 - s.x1) * p.t, sy = s.y1 + (s.y2 - s.y1) * p.t, ex = s.x1 + (s.x2 - s.x1) * q.t, ey = s.y1 + (s.y2 - s.y1) * q.t;
        const seg = disp.length / 6;
        disp.push(sx, sy, ex, ey, s.w, s.li);
        if (disp.nets) disp.nets.push(net);
        W.edge(p.node, q.node, s.w / (RS * len), seg);
      }
    }
    // pours: the pads, vias and track ends inside each filled area, joined to their nearest neighbours in it
    for (const z of d.zones) {
      const li = z.li, f = z.p;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < f.length; i += 2) { if (f[i] < x0) x0 = f[i]; if (f[i] > x1) x1 = f[i]; if (f[i + 1] < y0) y0 = f[i + 1]; if (f[i + 1] > y1) y1 = f[i + 1]; }
      // polygon corners near a point: a pad in a thermal-relief cut-out still touches the spokes
      const vg = new Grid(0.5);
      for (let i = 0; i < f.length; i += 2) vg.add(i, f[i], f[i + 1]);
      const touches = (x, y, r, test) => { for (const i of vg.near(x, y, r, tmp)) if (test(f[i], f[i + 1])) return true; return false; };
      const att = [];
      for (const pi of d.pads) {
        const p = B.pads[pi];
        if (!padLayers(p).includes(li) || p[4] < x0 - 3 || p[4] > x1 + 3 || p[5] < y0 - 3 || p[5] > y1 + 3) continue;
        const R = Math.max(p[6], p[7]) / 2 + 0.05;
        if (pip(p[4], p[5], f) || touches(p[4], p[5], R, (qx, qy) => padDist(p, qx, qy) <= 0.05)) att.push(padNode.get(pi));
      }
      d.vias.forEach((v, k) => {
        const l0 = v[6] != null ? v[6] : 0, l1 = v[7] != null ? v[7] : cuN - 1;
        if (li < l0 || li > l1 || v[0] < x0 - 1 || v[0] > x1 + 1 || v[1] < y0 - 1 || v[1] > y1 + 1) return;
        const r = v[2] / 2 + 0.05;
        if (pip(v[0], v[1], f) || touches(v[0], v[1], r, (qx, qy) => hyp(qx - v[0], qy - v[1]) <= r)) att.push(viaNode[k]);
      });
      const g = ends.get(li);
      if (g) for (let id = 0; id < W.n; id++) if (endL[id] === li && W.x[id] >= x0 && W.x[id] <= x1 && W.y[id] >= y0 && W.y[id] <= y1 && pip(W.x[id], W.y[id], f)) att.push(id);
      zoneMesh(W, [...new Set(att)]);
    }
    return W;
  }
  // join the contacts of one pour: each to its nearest neighbours, then the clusters to each other
  function zoneMesh(W, pts) {
    const m = pts.length;
    if (m < 2) return;
    const K = 4, g = new Grid(2);
    pts.forEach((id, i) => g.add(i, W.x[id], W.y[id]));
    const par = Int32Array.from({ length: m }, (_, i) => i);
    const f = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const seen = new Set(), tmp = [];
    const link = (i, j) => { const a = Math.min(i, j), b = Math.max(i, j), k = a * m + b; if (seen.has(k)) return; seen.add(k); W.edge(pts[a], pts[b], G_ZONE); par[f(a)] = f(b); };
    for (let i = 0; i < m; i++) {
      const xi = W.x[pts[i]], yi = W.y[pts[i]];
      let r = 2, best = [];
      for (let it = 0; it < 6 && best.length < K; it++, r *= 2) {
        best = g.near(xi, yi, r, tmp).filter(j => j !== i).map(j => [j, hyp(W.x[pts[j]] - xi, W.y[pts[j]] - yi)]).filter(q => q[1] <= r).sort((a, b) => a[1] - b[1]).slice(0, K);
      }
      for (const [j] of best) link(i, j);
    }
    // clusters left apart (sparse pours): the closest pair between a cluster and the rest, until all are one
    for (let guard = 0; guard < m; guard++) {
      const roots = new Map();
      for (let i = 0; i < m; i++) { const r = f(i); if (!roots.has(r)) roots.set(r, []); roots.get(r).push(i); }
      if (roots.size < 2) break;
      const groups = [...roots.values()].sort((a, b) => a.length - b.length);
      const small = groups[0];
      let bi = -1, bj = -1, bd = Infinity;
      for (const i of small) for (let j = 0; j < m; j++) { if (f(j) === f(i)) continue; const dd = hyp(W.x[pts[j]] - W.x[pts[i]], W.y[pts[j]] - W.y[pts[i]]); if (dd < bd) { bd = dd; bi = i; bj = j; } }
      if (bi < 0) break;
      link(bi, bj);
    }
  }

  // ---------------------------------------------------------------- exact solve: LDLᵀ with a minimum-degree order
  // returns per connected component { nodes, perm, cp, ci, cv, dk } on network node ids
  function factorNet(W) {
    const n = W.n;
    const adj = Array.from({ length: n }, () => new Map());
    const D = new Float64Array(n);
    let gmax = 0;
    for (let e = 0; e < W.ea.length; e++) {
      const a = W.ea[e], b = W.eb[e], g = W.eg[e];
      adj[a].set(b, (adj[a].get(b) || 0) - g); adj[b].set(a, (adj[b].get(a) || 0) - g);
      D[a] += g; D[b] += g; if (g > gmax) gmax = g;
    }
    const eps = Math.max(1e-12, gmax * 1e-11);
    for (let i = 0; i < n; i++) D[i] += eps;
    // connected components
    const comp = new Int32Array(n).fill(-1), comps = [];
    for (let s = 0; s < n; s++) {
      if (comp[s] >= 0) continue;
      const ci = comps.length, list = [s];
      comp[s] = ci;
      for (let h = 0; h < list.length; h++) for (const j of adj[list[h]].keys()) if (comp[j] < 0) { comp[j] = ci; list.push(j); }
      comps.push(list);
    }
    const out = [];
    for (const nodes of comps) {
      if (nodes.length < 2) { out.push({ nodes, single: true }); continue; }
      // min-degree elimination with a lazy heap
      const m = nodes.length;
      const heap = [];
      const push = (deg, v) => { heap.push([deg, v]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; } } return top; };
      for (const v of nodes) push(adj[v].size, v);
      const done = new Uint8Array(n);
      const perm = new Int32Array(m), dk = new Float64Array(m), cp = new Int32Array(m + 1);
      const ci = [], cv = [];
      let k = 0;
      while (k < m) {
        const [deg, p] = pop();
        if (done[p] || deg !== adj[p].size) continue;
        done[p] = 1;
        const d = D[p];
        perm[k] = p; dk[k] = d; cp[k] = ci.length;
        const nb = [...adj[p]];
        for (const [i, a] of nb) { ci.push(i); cv.push(a / d); }
        for (let u = 0; u < nb.length; u++) {
          const [i, ai] = nb[u];
          const ri = adj[i];
          ri.delete(p);
          D[i] -= ai * ai / d;
          for (let w = u + 1; w < nb.length; w++) {
            const [j, aj] = nb[w], dv = ai * aj / d;
            ri.set(j, (ri.get(j) || 0) - dv);
            adj[j].set(i, (adj[j].get(i) || 0) - dv);
          }
        }
        for (const [i] of nb) push(adj[i].size, i);
        adj[p].clear();
        k++;
      }
      cp[m] = ci.length;
      out.push({ nodes, perm, dk, cp, ci: Int32Array.from(ci), cv: Float64Array.from(cv) });
    }
    out.comp = comp;
    out.pads = out.map(() => []);
    for (const [, nd] of W.pads) out.pads[comp[nd]].push(nd);
    return out;
  }
  // x = A⁻¹ b on one component (b holds the injections at network node ids and is overwritten)
  function solveComp(C, b) {
    const { perm, dk, cp, ci, cv } = C, m = perm.length;
    for (let k = 0; k < m; k++) { const bp = b[perm[k]]; if (bp !== 0) for (let e = cp[k]; e < cp[k + 1]; e++) b[ci[e]] -= cv[e] * bp; }
    for (let k = 0; k < m; k++) b[perm[k]] /= dk[k];
    for (let k = m - 1; k >= 0; k--) { let s = b[perm[k]]; for (let e = cp[k]; e < cp[k + 1]; e++) s -= cv[e] * b[ci[e]]; b[perm[k]] = s; }
  }

  // ---------------------------------------------------------------- the board
  N.pcbFlow = function (B) {
    if (B._pcbFlow) return B._pcbFlow;
    const pcb = B.pcb, li = new Map(B.cu.map((n, i) => [n, i]));
    const per = new Map();
    const get = n => { let o = per.get(n); if (!o) per.set(n, (o = { segs: [], pads: [], vias: [], zones: [] })); return o; };
    for (const L of Object.keys(pcb.tracks)) {
      const l = li.get(L);
      if (l == null) continue;
      const a = pcb.tracks[L];
      for (let k = 0; k + 5 < a.length; k += 6) if (a[k + 5]) get(a[k + 5]).segs.push([l, a[k], a[k + 1], a[k + 2], a[k + 3], a[k + 4]]);
    }
    B.pads.forEach((p, i) => { if (p[10] && p[2] !== 2) get(p[10]).pads.push(i); });
    for (const v of pcb.vias) if (v[4]) get(v[4]).vias.push(v);
    for (const z of pcb.zones) { const l = li.get(z.l); if (l != null && z.n && z.p && z.p.length >= 6) get(z.n).zones.push({ li: l, p: z.p }); }
    // unrouted connections of boards drawn here: straight lines, as thin tracks on no layer
    const air = pcb.air || [];
    for (let k = 0; k + 4 < air.length; k += 5) if (air[k + 4]) get(air[k + 4]).segs.push([-1, air[k], air[k + 1], air[k + 2], air[k + 3], 0.15]);
    const disp = [];
    disp.nets = [];
    const byNet = new Map();
    for (const [net, d] of per) {
      if (!d.pads.length) continue;
      byNet.set(net, { d, W: null, fac: null, x: null });
    }
    // build the networks now (geometry only); factor each net the first time current flows on it
    for (const [net, o] of byNet) o.W = buildNet(B, net, o.d, disp);
    const out = { byNet, segs: Float32Array.from(disp), segNet: Int32Array.from(disp.nets), nseg: disp.length / 6, nets: [...byNet.keys()] };
    out.segI = new Float32Array(out.nseg);
    out.phase = new Float32Array(out.nseg);
    for (let s = 0; s < out.nseg; s++) out.phase[s] = Math.random();
    // current through the parts: a two-terminal part (resistor, LED, diode, capacitor, inductor, fuse) shows it crossing its
    // body pad to pad (kind 1 on the first pad, 2 on the rest); a pin of a bigger part a short stub into the body (kind 0)
    const legs = [], kind = [], mate = [], head = [];
    B.fps.forEach((f, fi) => {
      if (!f.z || f.z[0] === 'none') return;
      const first = new Map(), ks = [];
      for (const pi of f.pads) {
        const p = B.pads[pi];
        if (!p[10]) continue;
        const k = legs.length / 2, num = String(p[1]);
        legs.push(pi, fi); kind.push(0); mate.push(-1);
        if (!first.has(num)) first.set(num, k);
        head.push(first.get(num)); ks.push(k);
      }
      if (first.size === 2) { const [a, b] = [...first.values()]; for (const k of ks) kind[k] = 2; kind[a] = 1; mate[a] = b; }
    });
    out.legs = Int32Array.from(legs);
    out.legKind = Uint8Array.from(kind); out.legMate = Int32Array.from(mate); out.legHead = Int32Array.from(head);
    out.legPhase = new Float32Array(legs.length / 2);
    out.legI = new Float32Array(legs.length / 2);
    out.legSum = new Float32Array(legs.length / 2);
    // boards drawn here have no tracks: their straight connections are the copper
    out.airOnly = !Object.values(pcb.tracks || {}).some(a => a && a.length);
    const cnt = new Map();
    B.pads.forEach(p => { const k = p[0] + ':' + p[1]; cnt.set(k, (cnt.get(k) || 0) + 1); });
    out.padShare = cnt;
    B._pcbFlow = out;
    return out;
  };

  // pad currents from the simulation -> current in every piece of copper
  N.pcbFlowUpdate = function (B, F, live) {
    const padI = pi => { const p = B.pads[pi], f = B.fps[p[0]]; const i = live.padI(f.r, p[1]); return i ? i / (F.padShare.get(p[0] + ':' + p[1]) || 1) : 0; };
    F.segI.fill(0);
    let worst = 0;
    for (const [net, o] of F.byNet) {
      const W = o.W;
      if (!W || !W.pads.length) continue;
      let any = false;
      const inj = o.inj || (o.inj = new Float64Array(W.n));
      inj.fill(0);
      for (const [pi, nd] of W.pads) { const i = -padI(pi); if (i) { inj[nd] += i; any = true; } }
      if (!any) continue;
      if (!o.fac) o.fac = factorNet(W);
      const x = o.x || (o.x = new Float64Array(W.n));
      x.set(inj);
      const fac = o.fac;
      for (let c = 0; c < fac.length; c++) {
        const C = fac[c], pads = fac.pads[c];
        if (C.single) { x[C.nodes[0]] = 0; continue; }
        if (!pads.length) { for (const v of C.nodes) x[v] = 0; continue; }
        // what goes in at the pads of one piece of copper comes out of it; a piece the copper data leaves open is balanced
        // over its pads, so no current is drawn towards a made-up point
        let s = 0;
        for (const nd of pads) s += inj[nd];
        if (Math.abs(s) > 1e-12) { for (const nd of pads) x[nd] -= s / pads.length; worst = Math.max(worst, Math.abs(s)); }
        solveComp(C, x);
      }
      for (let e = 0; e < W.ea.length; e++) { const s = W.eseg[e]; if (s >= 0) F.segI[s] = W.eg[e] * (x[W.ea[e]] - x[W.eb[e]]); }
      void net;
    }
    F.unbalanced = worst;
    for (let k = 0; k < F.legI.length; k++) F.legI[k] = padI(F.legs[k * 2]);
    if (F.legSum) { F.legSum.fill(0); for (let k = 0; k < F.legI.length; k++) F.legSum[F.legHead[k]] += F.legI[k]; }
  };

  // Kirchhoff check for tests: largest |sum of currents| at a node, and the current in versus out per net
  N.pcbFlowCheck = function (B, F, live) {
    let worst = 0, worstNet = 0;
    for (const [net, o] of F.byNet) {
      const W = o.W;
      if (!W || !o.x) continue;
      const bal = new Float64Array(W.n);
      for (const [pi, nd] of W.pads) { const p = B.pads[pi], f = B.fps[p[0]]; bal[nd] += -(live.padI(f.r, p[1]) || 0) / (F.padShare.get(p[0] + ':' + p[1]) || 1); }
      for (let e = 0; e < W.ea.length; e++) { const i = W.eg[e] * (o.x[W.ea[e]] - o.x[W.eb[e]]); bal[W.ea[e]] -= i; bal[W.eb[e]] += i; }
      let tot = 0;
      for (const [, nd] of W.pads) tot += Math.abs(bal[nd]);
      for (let v = 0; v < W.n; v++) if (Math.abs(bal[v]) > worst) { worst = Math.abs(bal[v]); worstNet = net; }
      void tot;
    }
    return { worst, worstNet, unbalanced: F.unbalanced || 0 };
  };
})();

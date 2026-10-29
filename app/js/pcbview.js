/* KiLive — interactive 2D PCB viewer */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;

  const PROBE = '#ffd21f';

  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  N.segDist = segDist;

  function pip(x, y, flat) {
    let inside = false;
    for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
      const xi = flat[i], yi = flat[i + 1], xj = flat[j], yj = flat[j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  N.pip = pip;

  function padExt(p) {
    let ex = p[6] / 2, ey = p[7] / 2;
    if (p[16]) for (const poly of p[16]) for (let i = 0; i < poly.length; i += 2) { ex = Math.max(ex, Math.abs(poly[i])); ey = Math.max(ey, Math.abs(poly[i + 1])); }
    return [ex, ey];
  }
  function padDist(p, x, y) {
    const [lx, ly] = N.rot(x - p[4], y - p[5], -p[8]);
    if (p[3] === 0 && !p[16]) return Math.max(0, Math.hypot(lx, ly) - p[6] / 2);
    const [ex, ey] = padExt(p);
    return Math.hypot(Math.max(0, Math.abs(lx) - ex), Math.max(0, Math.abs(ly) - ey));
  }
  N.padDist = padDist;

  class Grid {
    constructor(cell) { this.c = cell; this.g = new Map(); }
    key(x, y) { return x * 73856093 ^ y * 19349663; }
    add(item, x0, y0, x1, y1) {
      const c = this.c;
      for (let gx = Math.floor(x0 / c); gx <= Math.floor(x1 / c); gx++)
        for (let gy = Math.floor(y0 / c); gy <= Math.floor(y1 / c); gy++) {
          const k = gx + ',' + gy;
          let a = this.g.get(k);
          if (!a) this.g.set(k, (a = []));
          a.push(item);
        }
    }
    at(x, y) { return this.g.get(Math.floor(x / this.c) + ',' + Math.floor(y / this.c)) || []; }
  }

  // Board-level hit testing shared by PCB and 3D views
  N.boardIndex = function (B) {
    if (B._index) return B._index;
    const pads = new Grid(1.5), segs = new Grid(1.5), vias = new Grid(1.5);
    B.pads.forEach((p, i) => { const r = Math.max(...padExt(p)); pads.add(i, p[4] - r, p[5] - r, p[4] + r, p[5] + r); });
    for (const L in B.pcb.tracks) {
      const a = B.pcb.tracks[L];
      for (let k = 0; k < a.length; k += 6) {
        const w = a[k + 4] / 2;
        segs.add([L, k], Math.min(a[k], a[k + 2]) - w, Math.min(a[k + 1], a[k + 3]) - w, Math.max(a[k], a[k + 2]) + w, Math.max(a[k + 1], a[k + 3]) + w);
      }
    }
    B.pcb.vias.forEach((v, i) => { const r = v[2] / 2; vias.add(i, v[0] - r, v[1] - r, v[0] + r, v[1] + r); });
    const fpPolys = B.fps.map(f => (f.c && f.c.length >= 6 ? f.c : B.bodyPoly(f)));
    B._index = { pads, segs, vias, fpPolys };
    return B._index;
  };

  N.hitTest = function (B, x, y, opts) {
    const idx = N.boardIndex(B);
    const tol = opts.tol || 0.05;
    const layers = opts.layers; // array of layer names in priority order
    const side = opts.side || 0;
    const cu = B.cu;
    // pads
    let best = null;
    for (const i of idx.pads.at(x, y)) {
      const p = B.pads[i];
      if (padDist(p, x, y) > tol) continue;
      const li = layers.findIndex(L => B.padOnLayer(p, cu.indexOf(L)));
      if (li < 0) continue;
      if (!best || li < best.li) best = { type: 'pad', i, li, net: p[10], fi: p[0] };
    }
    if (best) return best;
    for (const i of idx.vias.at(x, y)) {
      const v = B.pcb.vias[i];
      if (Math.hypot(x - v[0], y - v[1]) <= v[2] / 2 + tol) return { type: 'via', i, net: v[4] };
    }
    for (const [L, k] of idx.segs.at(x, y)) {
      const li = layers.indexOf(L);
      if (li < 0) continue;
      const a = B.pcb.tracks[L];
      if (segDist(x, y, a[k], a[k + 1], a[k + 2], a[k + 3]) <= a[k + 4] / 2 + tol) {
        if (!best || li < best.li) best = { type: 'track', L, k, li, net: a[k + 5], w: a[k + 4] };
      }
    }
    if (best) return best;
    // footprints on the viewed side first, smallest first
    let fb = null;
    B.fps.forEach((f, fi) => {
      const poly = idx.fpPolys[fi];
      if (!poly || !pip(x, y, poly)) return;
      const b = f.b || [0, 0, 1, 1];
      const area = (b[2] - b[0]) * (b[3] - b[1]) + (f.s === side ? 0 : 1e6);
      if (!fb || area < fb.area) fb = { type: 'fp', fi, area };
    });
    if (fb) return fb;
    if (opts.zones !== false) {
      for (const L of layers) {
        for (const z of B.pcb.zones) {
          if (z.l !== L) continue;
          if (pip(x, y, z.p)) return { type: 'zone', L, net: z.n };
        }
      }
    }
    return null;
  };

  const layer = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

  class PCBView {
    constructor(host) {
      this.host = host;
      this.root = el('div', { class: 'pcb-view' });
      this.canvas = el('canvas', { class: 'pcb-canvas', tabindex: '0', 'aria-label': 'PCB layout. Drag to pan, scroll to zoom, click a pad or track to trace its net.' });
      this.tip = el('div', { class: 'viewer-tip', hidden: true });
      this.status = el('div', { class: 'pcb-status' });
      this.root.append(this.canvas, this.tip, this.status);
      host.append(this.root);
      this.ctx = this.canvas.getContext('2d');
      this.view = { s: 5, ox: 0, oy: 0 };
      this.flip = false;
      this.vis = { zones: true, tracks: true, pads: true, vias: true, silk: true, fab: false, crtyd: false, edge: true, text: true };
      this.layerVis = {};
      this.sel = { refs: new Set(), nets: new Set() };
      this.hoverHit = null;
      this.measure = null;
      this.listeners = {};
      this.bind();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.root);
    }
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, d) { (this.listeners[ev] || []).forEach(f => f(d)); }

    setBoard(B) {
      this.B = B;
      N.buildPaths(B);
      N.boardIndex(B);
      this.layerVis = {};
      for (const L of B.cu) this.layerVis[L] = true;
      this.resize();
      this.fit();
    }
    setFlip(f) {
      if (this.flip === f) return;
      // keep the same world point centered
      const cx = this.root.clientWidth / 2, cy = this.root.clientHeight / 2;
      const w = this.toWorld(cx, cy);
      this.flip = f;
      this.view.ox = cx - (this.flip ? -w[0] : w[0]) * this.view.s;
      this.draw();
    }
    layerOrder() {
      // back-to-front order for drawing
      const cu = this.B.cu.slice();
      const order = [cu[cu.length - 1], ...cu.slice(1, -1).reverse(), cu[0]];
      return this.flip ? order.reverse() : order;
    }
    priority() { return this.layerOrder().slice().reverse().filter(L => this.layerVis[L]); }

    fit(bbox) {
      if (!this.B) return;
      const bb = bbox || this.B.bbox;
      const W = this.root.clientWidth || 800, H = this.root.clientHeight || 600;
      const w = Math.max(1, bb[2] - bb[0]), h = Math.max(1, bb[3] - bb[1]);
      const top = 64, bottom = 64;
      const s = Math.min((W - 48) / w, (H - top - bottom) / h);
      this.view.s = Math.max(0.5, Math.min(400, s));
      const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
      this.view.ox = W / 2 - (this.flip ? -cx : cx) * this.view.s;
      this.view.oy = top + (H - top - bottom) / 2 - cy * this.view.s;
      this.draw();
      this.updateStatus();
    }
    zoomTo(x, y, span) {
      const r = (span || 12) / 2;
      this.fit([x - r, y - r, x + r, y + r]);
    }
    toWorld(sx, sy) { return [((sx - this.view.ox) / this.view.s) * (this.flip ? -1 : 1), (sy - this.view.oy) / this.view.s]; }
    toScreen(x, y) { return [this.view.ox + (this.flip ? -x : x) * this.view.s, this.view.oy + y * this.view.s]; }

    setSelection(refs, nets) {
      this.sel = { refs: new Set(refs || []), nets: new Set(nets || []) };
      this.draw();
      this.updateStatus();
    }

    resize() {
      const r = this.root.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      // the point in the middle of the view stays in the middle when the view changes size (a side panel opening)
      const w0 = this.canvas.clientWidth, h0 = this.canvas.clientHeight;
      const mid = this.B && w0 > 10 && h0 > 10 ? this.toWorld(w0 / 2, h0 / 2) : null;
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
      this.canvas.style.width = r.width + 'px';
      this.canvas.style.height = r.height + 'px';
      if (mid && (Math.abs(r.width - w0) > 1 || Math.abs(r.height - h0) > 1)) {
        const fx = this.flip ? -1 : 1;
        this.view.ox = r.width / 2 - mid[0] * fx * this.view.s;
        this.view.oy = r.height / 2 - mid[1] * this.view.s;
      }
      this.draw();
    }

    draw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this.paint(); });
    }

    paint() {
      const B = this.B;
      const live = B && N.live && N.live.on && N.live.B === B ? N.live : null;
      if (!live) { this._lc = null; this.paintBase(this.ctx, null); if (B) this.paintOver(this.ctx, null); return; }
      // live: two cached layers (voltage-coloured copper; silkscreen and edges on top) and moving dots each frame
      const W = this.canvas.width, H = this.canvas.height;
      const vkey = [W, H, this.view.s, this.view.ox, this.view.oy, this.flip, JSON.stringify(this.layerVis), JSON.stringify(this.vis), N.cssVar('--pcb-bg')].join('|');
      const c = this._lc && this._lc.W === W && this._lc.H === H ? this._lc : (this._lc = { W, H, cu: layer(W, H), front: layer(W, H), top: layer(W, H) });
      const now = performance.now();
      let fresh = false;
      if (c.vkey !== vkey) { this.paintLiveTopLayer(c.top.getContext('2d')); c.vkey = vkey; fresh = true; }
      const ckey = vkey + '|' + live.gen + '|' + live.colGen;
      if (c.ckey !== ckey && (fresh || c.gen !== live.gen || now - (c.cT || 0) > 70)) {
        this.paintLiveCopperLayer(c.cu.getContext('2d'), c.front.getContext('2d'), live);
        c.ckey = ckey; c.cT = now; c.gen = live.gen;
      }
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(c.cu, 0, 0);
      // current on the layers below shows only where the top copper leaves them uncovered, as on the real board: dots on an
      // inner track never run across the pads and tracks on top of it
      this.paintLiveFar(ctx, live);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(c.front, 0, 0);
      ctx.drawImage(c.top, 0, 0);
      this.paintOver(ctx, live);
    }
    worldTransform(ctx) {
      const dpr = this.dpr || 1, s = this.view.s;
      ctx.setTransform(dpr * s * (this.flip ? -1 : 1), 0, 0, dpr * s, dpr * this.view.ox, dpr * this.view.oy);
    }
    // two cached layers: the board and the copper below (ctx), the copper on top with the vias and holes (fctx, transparent
    // elsewhere), so the current dots of the layers below can be drawn between them
    paintLiveCopperLayer(ctx, fctx, L) {
      const B = this.B, P = N.buildPaths(B);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = N.cssVar('--pcb-bg') || '#0b1014';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      fctx.setTransform(1, 0, 0, 1, 0, 0);
      fctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.worldTransform(ctx); this.worldTransform(fctx);
      const px = 1 / this.view.s;
      ctx.fillStyle = '#0d1317';
      ctx.fill(P.outline, 'evenodd');
      const order = this.layerOrder();
      const vis = order.filter(n => this.layerVis[n]);
      const topL = vis.length ? vis[vis.length - 1] : order[order.length - 1];
      // copper that is on no net stays faintly visible
      ctx.globalAlpha = 0.25; ctx.fillStyle = '#6d747a';
      ctx.fill(P.cuGfx[topL]);
      ctx.globalAlpha = 1;
      const o = { scheme: 'dark', minW: px * 0.9, zones: this.vis.zones, tracks: this.vis.tracks, pads: this.vis.pads };
      const below = vis.filter(n => n !== topL).map(n => ({ name: n, alpha: 0.4 }));
      if (below.length) N.paintLiveCopper(ctx, B, L, below, Object.assign({}, o, { vias: false, air: false }));
      N.paintLiveCopper(fctx, B, L, vis.includes(topL) ? [{ name: topL, alpha: 1 }] : [], Object.assign({}, o, { vias: this.vis.vias, air: true, airW: px * 1.6 }));
      fctx.fillStyle = '#0a0d10';
      fctx.fill(P.viaHoles); fctx.fill(P.holes);
      fctx.fillStyle = '#05080a';
      fctx.fill(P.npth);
    }
    // what the dots need: the shown copper layers, the one on top, the side and the part of the board in view
    liveDotView() {
      const B = this.B, order = this.layerOrder();
      const W = this.root.clientWidth, H = this.root.clientHeight;
      const a = this.toWorld(0, 0), b = this.toWorld(W, H);
      const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      const visOrder = order.filter(n => this.layerVis[n]);
      const layers = new Set(visOrder.map(n => B.cu.indexOf(n)));
      layers.add(-1);
      const front = visOrder.length ? B.cu.indexOf(visOrder[visOrder.length - 1]) : null;
      const s = this.view.s, px = 1 / s, rpx = s < 7 ? 1.6 : s < 14 ? 2 : 2.4;
      return { layers, front, side: this.flip ? 1 : 0, rect, spacing: (s < 7 ? 13 : 17) * px, r: rpx * px, s };
    }
    // current on the copper below the top layer (drawn under the top copper)
    paintLiveFar(ctx, L) {
      const v = this.liveDotView();
      this.worldTransform(ctx);
      N.paintLiveDots(ctx, this.B, L, { layers: v.layers, front: v.front, side: v.side, spacing: v.spacing, r: v.r, rect: v.rect, dot: '#ffd21f', only: 'far', farAlpha: 0.55, legs: false });
    }
    paintLiveTopLayer(ctx) {
      const B = this.B, P = N.buildPaths(B);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.worldTransform(ctx);
      const px = 1 / this.view.s;
      if (this.vis.edge) { ctx.strokeStyle = '#e9e2c6'; ctx.fillStyle = 'rgba(0,0,0,0)'; N.strokeGfx(ctx, P.gfx['Edge.Cuts'], Math.max(px * 1.2, 0.05)); }
      const silkNear = this.flip ? 'B.SilkS' : 'F.SilkS';
      if (this.vis.silk) { ctx.globalAlpha = 0.34; ctx.fillStyle = ctx.strokeStyle = '#efe9c8'; N.strokeGfx(ctx, P.gfx[silkNear], px); if (this.vis.text) N.drawTexts(ctx, P.texts[silkNear], { scale: this.view.s, minPx: 7 }); ctx.globalAlpha = 1; }
    }

    paintBase(ctx, live) {
      const B = this.B;
      const dpr = this.dpr || 1;
      const W = this.canvas.width, H = this.canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = N.cssVar('--pcb-bg') || '#0b1014';
      ctx.fillRect(0, 0, W, H);
      if (!B) return;
      const P = N.buildPaths(B);
      const s = this.view.s;
      const fx = this.flip ? -1 : 1;
      ctx.setTransform(dpr * s * fx, 0, 0, dpr * s, dpr * this.view.ox, dpr * this.view.oy);
      const px = 1 / s; // one screen pixel in mm
      // board body
      ctx.fillStyle = N.cssVar('--pcb-board') || '#121a20';
      ctx.fill(P.outline, 'evenodd');
      const order = this.layerOrder();
      const topL = order[order.length - 1];
      if (!live) for (const L of order) {
        if (!this.layerVis[L]) continue;
        const col = N.layerColor(L, B.cu);
        const isTop = L === topL;
        const base = isTop ? 1 : (L === 'F.Cu' || L === 'B.Cu') ? 0.62 : 0.5;
        ctx.globalAlpha = isTop ? 0.24 : base * 0.2;
        ctx.fillStyle = col;
        if (this.vis.zones) ctx.fill(P.zones[L]);
        ctx.globalAlpha = base * 0.95;
        ctx.strokeStyle = col;
        if (this.vis.tracks) N.strokeTracks(ctx, P.tracks[L], px * 0.8);
        ctx.fillStyle = col;
        ctx.fill(P.cuGfx[L]);
        if (this.vis.pads) { ctx.globalAlpha = base; ctx.fillStyle = N.mixColor(col, '#ffffff', 0.18); ctx.fill(P.pads[L]); }
      }
      ctx.globalAlpha = 1;
      if (this.vis.pads && !live) { ctx.fillStyle = '#d6a94a'; ctx.fill(P.tht); }
      if (this.vis.vias && !live) {
        ctx.fillStyle = '#a9adb3';
        ctx.fill(P.vias);
        ctx.fillStyle = '#0a0d10';
        ctx.fill(P.viaHoles);
      }
      ctx.fillStyle = '#0a0d10';
      ctx.fill(P.holes);
      ctx.fillStyle = '#05080a';
      ctx.fill(P.npth);
      // silkscreen for the viewed side (and faint for the other)
      const silkNear = this.flip ? 'B.SilkS' : 'F.SilkS';
      const silkFar = this.flip ? 'F.SilkS' : 'B.SilkS';
      if (this.vis.silk && !live) {
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = ctx.strokeStyle = '#d7a79c';
        N.strokeGfx(ctx, P.gfx[silkFar], px);
        ctx.globalAlpha = 1;
        ctx.fillStyle = ctx.strokeStyle = '#efe9c8';
        N.strokeGfx(ctx, P.gfx[silkNear], px);
        if (this.vis.text) N.drawTexts(ctx, P.texts[silkNear], { scale: s, minPx: 5 });
      }
      if (this.vis.fab) {
        const fab = this.flip ? 'B.Fab' : 'F.Fab';
        ctx.fillStyle = ctx.strokeStyle = '#8f9aa8';
        N.strokeGfx(ctx, P.gfx[fab], px);
        N.drawTexts(ctx, P.texts[fab], { scale: s, minPx: 6 });
      }
      if (this.vis.crtyd) {
        const c = this.flip ? 'B.CrtYd' : 'F.CrtYd';
        ctx.strokeStyle = '#e05ad0';
        ctx.fillStyle = 'transparent';
        N.strokeGfx(ctx, P.gfx[c], px);
      }
      if (this.vis.edge) {
        ctx.strokeStyle = '#e9e2c6';
        ctx.fillStyle = 'rgba(0,0,0,0)';
        N.strokeGfx(ctx, P.gfx['Edge.Cuts'], Math.max(px * 1.2, 0.05));
      }
      // ratsnest: unrouted connections of generated boards (pcb.air = [x1, y1, x2, y2, net, ...])
      const air = B.pcb.air;
      const airPath = (only) => {
        const pth = new Path2D();
        for (let k = 0; k + 4 < air.length; k += 5) if (!only || only.has(air[k + 4])) { pth.moveTo(air[k], air[k + 1]); pth.lineTo(air[k + 2], air[k + 3]); }
        return pth;
      };
      if (air && air.length && !live) { ctx.lineWidth = px * 1.1; ctx.strokeStyle = 'rgba(150, 215, 255, 0.5)'; ctx.stroke(airPath(null)); }
    }

    paintOver(ctx, live) {
      const B = this.B;
      const dpr = this.dpr || 1;
      const s = this.view.s;
      const fx = this.flip ? -1 : 1;
      ctx.setTransform(dpr * s * fx, 0, 0, dpr * s, dpr * this.view.ox, dpr * this.view.oy);
      const px = 1 / s;
      const order = this.layerOrder();
      const topL = order[order.length - 1];
      const hlActive = this.sel.nets.size > 0 || this.sel.refs.size > 0;
      const air = B.pcb.air;
      const airPath = (only) => {
        const pth = new Path2D();
        for (let k = 0; k + 4 < air.length; k += 5) if (!only || only.has(air[k + 4])) { pth.moveTo(air[k], air[k + 1]); pth.lineTo(air[k + 2], air[k + 3]); }
        return pth;
      };
      // highlight
      if (hlActive) {
        if (!live) {
          ctx.fillStyle = 'rgba(6,9,12,0.58)';
          ctx.fillRect(B.bbox[0] - 50, B.bbox[1] - 50, B.bbox[2] - B.bbox[0] + 100, B.bbox[3] - B.bbox[1] + 100);
        }
        if (this.sel.nets.size) {
          for (const L of order) {
            if (!this.layerVis[L]) continue;
            ctx.globalAlpha = (L === topL ? 1 : 0.7) * (live ? 0.45 : 1);
            ctx.fillStyle = ctx.strokeStyle = L === topL ? PROBE : '#e0a800';
            N.drawNetCopper(ctx, B, this.sel.nets, L);
          }
          ctx.globalAlpha = 1;
          if (air && air.length) { ctx.lineWidth = px * 2; ctx.strokeStyle = PROBE; ctx.stroke(airPath(this.sel.nets)); }
        }
        for (const r of this.sel.refs) {
          const f = B.fp(r);
          if (!f) continue;
          ctx.fillStyle = PROBE;
          if (!live) for (const pi of f.pads) for (const poly of B.padPoly(B.pads[pi])) { const pth = new Path2D(); N.polyPath(pth, poly); ctx.fill(pth); }
          const poly = f.c && f.c.length >= 6 ? f.c : B.bodyPoly(f);
          if (poly) {
            const pth = new Path2D(); N.polyPath(pth, poly);
            ctx.lineWidth = px * 2; ctx.strokeStyle = PROBE; ctx.stroke(pth);
            ctx.globalAlpha = 0.14; ctx.fillStyle = PROBE; ctx.fill(pth); ctx.globalAlpha = 1;
          }
        }
      }
      if (live) this.paintLiveTop(ctx, live, order, px);
      // the probe tool: the copper under the cursor lights up before the click
      const h = this.hoverHit;
      if (this.probeMode && h && h.net && !(this.sel.nets.size === 1 && this.sel.nets.has(h.net))) {
        for (const L of order) {
          if (!this.layerVis[L]) continue;
          ctx.globalAlpha = L === topL ? 0.55 : 0.3;
          ctx.fillStyle = ctx.strokeStyle = PROBE;
          N.drawNetCopper(ctx, B, new Set([h.net]), L);
        }
        ctx.globalAlpha = 1;
      }
      // hover outline
      if (h && (h.type === 'fp' || h.type === 'pad')) {
        const f = B.fps[h.fi];
        const poly = f && (f.c && f.c.length >= 6 ? f.c : B.bodyPoly(f));
        if (poly) { const pth = new Path2D(); N.polyPath(pth, poly); ctx.lineWidth = px * 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.stroke(pth); }
      }
      // screen-space overlays
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.probeMode && this.cursor && this.hoverOn) {
        const [cx, cy] = this.toScreen(this.cursor[0], this.cursor[1]);
        ctx.lineWidth = 1.5; ctx.strokeStyle = h && (h.net || h.type === 'fp' || h.type === 'pad') ? PROBE : 'rgba(255,255,255,0.55)';
        ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx - 11, cy); ctx.lineTo(cx - 4, cy); ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 11, cy); ctx.moveTo(cx, cy - 11); ctx.lineTo(cx, cy - 4); ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 11); ctx.stroke();
      }
      if (live && live.probes && live.probes.length && N.paintProbeMarkers) N.paintProbeMarkers(ctx, live.probes.filter(p => p.at && (p.at.view === 'pcb' || p.at.view === '3d')).map(p => [p, this.toScreen(p.at.x, p.at.y)]));
      this.paintRefLabels(ctx);
      if (this.measure && this.measure.a) this.paintMeasure(ctx);
    }

    // live simulation: current dots and lit LEDs over the cached layers
    paintLiveTop(ctx, L, order, px) {
      const B = this.B;
      const v = this.liveDotView();
      N.paintLiveLeds(ctx, B, L, { side: v.side });
      // dots keep their size on screen at every zoom; current through the parts only when zoomed in. The layers below were drawn
      // under the top copper already
      N.paintLiveDots(ctx, B, L, { layers: v.layers, front: v.front, side: v.side, spacing: v.spacing, r: v.r, rect: v.rect, dot: '#ffd21f', edge: 'rgba(0,0,0,0.55)', legs: v.s >= 6, only: 'near' });
      const front = v.front, layers = v.layers;
      this.paintLiveLabels(ctx, L, front, layers);
      if (this.hoverHit && !this.tip.hidden && (L.frameId % 12) === 0) this.tip.innerHTML = this.describe(this.hoverHit);
    }
    // zoomed in: the voltage and the current (with its direction) on the pieces of track that carry the most
    // labels go on what the eye is on (the selection and the probes) unless every value is asked for
    paintLiveLabels(ctx, L, front, layers) {
      const B = this.B, s = this.view.s;
      const mode = L.labelMode || 'focus';
      if (mode === 'off' || L.labels === false) return;
      const focus = mode === 'focus' && L.focusNets ? L.focusNets() : null;
      if (focus ? !focus.size || s < 2.5 : s < 8) return;
      const F = B._pcbFlow;
      if (!F) return;
      const S = F.segs, f = N.liveFmt, dpr = this.dpr || 1, W = this.root.clientWidth, H = this.root.clientHeight;
      const cand = [];
      for (let k = 0; k < F.nseg; k++) {
        const I = F.segI[k];
        if (!(Math.abs(I) >= (focus ? 1e-6 : 1e-4))) continue;
        if (focus && !focus.has(F.segNet[k])) continue;
        const li = S[k * 6 + 5];
        if (!layers.has(li)) continue;
        const a = this.toScreen(S[k * 6], S[k * 6 + 1]), b = this.toScreen(S[k * 6 + 2], S[k * 6 + 3]);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < (focus ? 24 : 40)) continue;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        if (mx < 20 || my < 20 || mx > W - 20 || my > H - 20) continue;
        cand.push({ k, I, a, b, mx, my, len, fr: li === front || li === -1 ? 1 : 0 });
      }
      if (!cand.length) return;
      cand.sort((p, q) => q.fr - p.fr || Math.abs(q.I) - Math.abs(p.I) || q.len - p.len);
      const mono = N.cssVar('--font-mono') || 'monospace';
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '600 10.5px ' + mono;
      ctx.textBaseline = 'middle';
      const placed = [], netAt = new Map();
      const pal = N.livePalette('dark');
      let n = 0;
      for (const c of cand) {
        if (n >= 24) break;
        const net = F.segNet[c.k];
        const v = L.netVoltage(net);
        const txt = (v != null ? f.V(v) + ' · ' : '') + f.A(Math.abs(c.I));
        const tw = ctx.measureText(txt).width, bw = tw + 22, bh = 17;
        const x0 = c.mx - bw / 2, y0 = c.my - bh / 2;
        if (placed.some(r => x0 < r[2] + 6 && x0 + bw > r[0] - 6 && y0 < r[3] + 4 && y0 + bh > r[1] - 4)) continue;
        const seen = netAt.get(net) || [];
        if (seen.some(([x, y]) => Math.hypot(x - c.mx, y - c.my) < 170)) continue;
        seen.push([c.mx, c.my]); netAt.set(net, seen);
        placed.push([x0, y0, x0 + bw, y0 + bh]);
        n++;
        const ci = L.colIdx ? L.colIdx[net] : 64;
        ctx.globalAlpha = c.fr ? 1 : 0.6;
        ctx.fillStyle = 'rgba(8,12,14,0.86)';
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y0, bw, bh, 8.5); else ctx.rect(x0, y0, bw, bh); ctx.fill();
        ctx.strokeStyle = ci === 254 ? N.liveFloatColor() : pal[ci] || '#7c858d'; ctx.lineWidth = 1.2; ctx.stroke();
        // the arrow points the way the (conventional) current flows along the track
        const dx = (c.b[0] - c.a[0]) * Math.sign(c.I), dy = (c.b[1] - c.a[1]) * Math.sign(c.I), dl = Math.hypot(dx, dy) || 1;
        const ux = dx / dl, uy = dy / dl, ax = x0 + 10, ay = c.my;
        ctx.fillStyle = '#ffd21f';
        ctx.beginPath(); ctx.moveTo(ax + ux * 5, ay + uy * 5); ctx.lineTo(ax - ux * 4 - uy * 3.6, ay - uy * 4 + ux * 3.6); ctx.lineTo(ax - ux * 4 + uy * 3.6, ay - uy * 4 - ux * 3.6); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#eef5f1'; ctx.textAlign = 'left';
        ctx.fillText(txt, x0 + 18, c.my + 0.5);
      }
      ctx.restore();
    }

    paintRefLabels(ctx) {
      // designators on selected parts
      const B = this.B;
      ctx.font = '600 11px ' + (N.cssVar('--font-mono') || 'monospace');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const r of this.sel.refs) {
        const f = B.fp(r);
        if (!f) continue;
        const [x, y] = this.toScreen(f.x, f.y);
        const w = ctx.measureText(r).width + 10;
        ctx.fillStyle = PROBE;
        N.roundRect(ctx, x - w / 2, y - 18 - 9, w, 18, 4);
        ctx.fill();
        ctx.fillStyle = '#1a1400';
        ctx.fillText(r, x, y - 18);
      }
    }

    paintMeasure(ctx) {
      const m = this.measure;
      const a = this.toScreen(...m.a), b = this.toScreen(...(m.b || m.cur || m.a));
      ctx.strokeStyle = '#7fe3ff';
      ctx.fillStyle = '#7fe3ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.setLineDash([]);
      for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, Math.PI * 2); ctx.fill(); }
      const e = m.b || m.cur;
      if (e) {
        const dx = e[0] - m.a[0], dy = e[1] - m.a[1];
        const txt = `${Math.hypot(dx, dy).toFixed(3)} mm   Δx ${Math.abs(dx).toFixed(2)}  Δy ${Math.abs(dy).toFixed(2)}`;
        ctx.font = '500 12px ' + (N.cssVar('--font-mono') || 'monospace');
        const w = ctx.measureText(txt).width + 14;
        const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2 - 18;
        ctx.fillStyle = 'rgba(8,20,26,0.9)';
        N.roundRect(ctx, x - w / 2, y - 11, w, 22, 5); ctx.fill();
        ctx.fillStyle = '#bff1ff';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, x, y);
      }
    }

    hit(sx, sy) {
      const [x, y] = this.toWorld(sx, sy);
      return N.hitTest(this.B, x, y, { layers: this.priority(), tol: 3 / this.view.s, side: this.flip ? 1 : 0 });
    }

    // what is under the cursor: its name first, then the physical detail, then the live line
    describe(h) {
      const B = this.B;
      if (!h) return '';
      const net = h.net ? N.fmt.shortNet(B.nets[h.net]) : '';
      const lv = N.liveTipNet ? N.liveTipNet(B, h.net) : '';
      const sub = t => `<span class="tip-sub">${t}</span>`;
      if (h.type === 'pad') {
        const p = B.pads[h.i], f = B.fps[p[0]];
        return `<b>${N.esc(f.r)}.${N.esc(p[1])}</b>${p[14] && p[14] !== '~' && p[14] !== p[1] ? ' ' + N.esc(p[14]) : ''} ${sub(net ? N.esc(net) : 'no net')}${N.liveTipPin ? N.liveTipPin(B, f.r, p[1], h.net) : ''}`;
      }
      if (h.type === 'via') { const v = B.pcb.vias[h.i]; return `<b>${N.esc(net || 'Via')}</b> ${sub('via ⌀' + v[2] + ' / ' + v[3] + ' mm')}${lv}`; }
      if (h.type === 'track') return `<b>${N.esc(net || 'Track')}</b> ${sub('track ' + h.w + ' mm · ' + N.esc(h.L))}${N.liveTipTrack && this.cursor ? N.liveTipTrack(B, h.net, this.cursor[0], this.cursor[1], h.L) : lv}`;
      if (h.type === 'zone') return `<b>${N.esc(net || 'Pour')}</b> ${sub('pour · ' + N.esc(h.L))}${lv}`;
      if (h.type === 'fp') { const f = B.fps[h.fi]; return `<b>${N.esc(f.r)}</b> ${N.esc(f.v)} ${sub(N.esc(f.fp) + ' · ' + (f.s ? 'bottom' : 'top'))}${N.liveTipPart ? N.liveTipPart(B, f.r) : ''}`; }
      return '';
    }

    bind() {
      const cv = this.canvas;
      const ptrs = new Map();
      let drag = null, moved = 0, pinch = 0;
      cv.addEventListener('contextmenu', e => e.preventDefault());
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId);
        ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
        moved = 0;
        if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
        drag = { x: e.offsetX, y: e.offsetY };
      });
      cv.addEventListener('pointermove', e => {
        const r = cv.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        if (ptrs.has(e.pointerId)) {
          ptrs.set(e.pointerId, [sx, sy]);
          if (ptrs.size === 2) {
            const [a, b] = [...ptrs.values()];
            const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
            if (pinch) this.zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / pinch);
            pinch = d;
            moved += 10;
            return;
          }
          const dx = sx - drag.x, dy = sy - drag.y;
          moved += Math.abs(dx) + Math.abs(dy);
          if (moved > 3) { this.view.ox += dx; this.view.oy += dy; this.draw(); }
          drag = { x: sx, y: sy };
          this.tip.hidden = true;
          return;
        }
        this.onHover(sx, sy);
      });
      const end = e => {
        const wasDown = ptrs.has(e.pointerId);
        ptrs.delete(e.pointerId);
        if (wasDown && moved <= 3 && e.type === 'pointerup' && ptrs.size === 0) {
          const r = cv.getBoundingClientRect();
          this.onClick(e.clientX - r.left, e.clientY - r.top, e);
        }
        if (ptrs.size < 2) pinch = 0;
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      cv.addEventListener('pointerleave', () => { this.tip.hidden = true; this.hoverHit = null; this.hoverOn = false; this.draw(); });
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        const k = Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0015);
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, k);
      }, { passive: false });
      cv.addEventListener('dblclick', e => {
        const r = cv.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, 2.2);
      });
      cv.addEventListener('keydown', e => {
        if (e.key === 'Escape') { if (this.probeMode) { this.emit('probe-tool', false); return; } this.measure = null; this.emit('select', { refs: [], nets: [] }); }
        if ((e.key === 'p' || e.key === 'P') && !(N.live && N.live.on)) { e.preventDefault(); this.emit('probe-tool', !this.probeMode); }
        if (e.key === 'f' || e.key === 'F') this.fit();
        if (e.key === 'b' || e.key === 'B') this.emit('flip', !this.flip);
        if (e.key === 'm' || e.key === 'M') this.emit('measure');
        const step = 60;
        if (e.key === 'ArrowLeft') { this.view.ox += step; this.draw(); }
        if (e.key === 'ArrowRight') { this.view.ox -= step; this.draw(); }
        if (e.key === 'ArrowUp') { this.view.oy += step; this.draw(); }
        if (e.key === 'ArrowDown') { this.view.oy -= step; this.draw(); }
        if (e.key === '+' || e.key === '=') this.zoomAt(this.root.clientWidth / 2, this.root.clientHeight / 2, 1.4);
        if (e.key === '-') this.zoomAt(this.root.clientWidth / 2, this.root.clientHeight / 2, 1 / 1.4);
      });
    }

    zoomAt(sx, sy, k) {
      const s0 = this.view.s;
      const s1 = Math.max(0.3, Math.min(600, s0 * k));
      const f = s1 / s0;
      this.view.ox = sx - (sx - this.view.ox) * f;
      this.view.oy = sy - (sy - this.view.oy) * f;
      this.view.s = s1;
      this.draw();
      this.updateStatus();
    }

    onHover(sx, sy) {
      if (!this.B) return;
      const w = this.toWorld(sx, sy);
      this.cursor = w;
      if (this.measure && this.measure.a && !this.measure.b) { this.measure.cur = w; this.draw(); }
      const h = this.hit(sx, sy);
      const changed = JSON.stringify(h) !== JSON.stringify(this.hoverHit);
      this.hoverHit = h;
      this.hoverOn = true;
      if (h) {
        this.tip.innerHTML = this.describe(h);
        this.tip.hidden = false;
        const W = this.root.clientWidth;
        this.tip.style.left = Math.min(sx + 14, W - 220) + 'px';
        this.tip.style.top = sy + 16 + 'px';
      } else this.tip.hidden = true;
      if (changed || this.probeMode) this.draw();
      this.updateStatus();
    }

    // the probe tool: a click on copper (or a part) places a probe there and the simulation runs
    setProbeTool(on) {
      this.probeMode = !!on;
      if (on) this.measure = null;
      this.canvas.style.cursor = on ? 'crosshair' : '';
      this.canvas.classList.toggle('probe-tool', !!on);
      this.draw(); this.updateStatus();
    }
    onClick(sx, sy, e) {
      if (!this.B) return;
      if (this.probeMode) {
        const h = this.hit(sx, sy);
        this.canvas.focus({ preventScroll: true });
        if (h && (h.net || h.type === 'fp' || h.type === 'pad')) this.emit('probe', { hit: h, at: this.toWorld(sx, sy), side: this.flip ? 1 : 0 });
        return;
      }
      if (this.measure) {
        const w = this.toWorld(sx, sy);
        const h = this.hit(sx, sy);
        let pt = w;
        if (h && h.type === 'pad') pt = [this.B.pads[h.i][4], this.B.pads[h.i][5]];
        if (h && h.type === 'via') pt = [this.B.pcb.vias[h.i][0], this.B.pcb.vias[h.i][1]];
        if (!this.measure.a || this.measure.b) this.measure = { a: pt };
        else this.measure.b = pt;
        this.draw();
        return;
      }
      const h = this.hit(sx, sy);
      this.canvas.focus({ preventScroll: true });
      if (!h) { this.emit('select', { refs: [], nets: [] }); return; }
      const add = e.shiftKey;
      const refs = add ? new Set(this.sel.refs) : new Set();
      const nets = add ? new Set(this.sel.nets) : new Set();
      if (h.type === 'fp') refs.add(this.B.fps[h.fi].r);
      else if (h.net) nets.add(h.net);
      else if (h.type === 'pad') refs.add(this.B.fps[h.fi].r);
      this.emit('select', { refs: [...refs], nets: [...nets], hit: h, at: this.toWorld(sx, sy) });
    }
    // live mode: the hover tooltip follows the changing values
    refreshTip() { if (this.hoverHit && !this.tip.hidden) this.tip.innerHTML = this.describe(this.hoverHit); }

    updateStatus() {
      if (!this.B) return;
      const c = this.cursor;
      const parts = [];
      if (c) parts.push(`X ${c[0].toFixed(2)}  Y ${c[1].toFixed(2)} mm`);
      parts.push(`${(this.view.s).toFixed(1)} px/mm`);
      parts.push(this.flip ? 'Bottom view (mirrored)' : 'Top view');
      if (this.measure) parts.push('Measure: click two points · Esc to stop');
      if (this.probeMode) parts.push('Probe: click a trace, pad, via or part · Esc to stop');
      this.status.textContent = parts.join('   ·   ');
    }

    destroy() { this.ro.disconnect(); this.root.remove(); }
  }
  N.PCBView = PCBView;
})();

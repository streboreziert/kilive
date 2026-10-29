/* KiLive — schematic viewer (KiCad 6+ data) */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const PROBE = '#e3a600';

  function symMatrix(a, m) {
    // maps sheet-frame offsets (lib y already negated) to displayed offsets: rotate, then mirror
    const r = ((Math.round(a) % 360) + 360) % 360;
    const c = Math.round(Math.cos(r * Math.PI / 180)), s = Math.round(Math.sin(r * Math.PI / 180));
    let M = [c, s, -s, c]; // x' = c x + s y ; y' = -s x + c y
    if (m === 'x') M = [M[0], M[1], -M[2], -M[3]];
    if (m === 'y') M = [-M[0], -M[1], M[2], M[3]];
    return M;
  }
  const apply = (M, x, y) => [M[0] * x + M[1] * y, M[2] * x + M[3] * y];
  const swapsAxes = M => M[0] === 0;

  const measureCtx = document.createElement('canvas').getContext('2d');
  function textW(str, size, font) {
    measureCtx.font = `100px ${font}`;
    const lines = String(str).split('\n');
    return Math.max(...lines.map(l => measureCtx.measureText(l).width)) * size * 1.3 / 100;
  }

  class SchView {
    constructor(host) {
      this.host = host;
      this.root = el('div', { class: 'sch-view' });
      this.side = el('nav', { class: 'sch-sheets', 'aria-label': 'Schematic sheets' });
      this.stage = el('div', { class: 'sch-stage' });
      this.canvas = el('canvas', { class: 'sch-canvas', tabindex: '0', 'aria-label': 'Schematic sheet. Drag to pan, scroll to zoom, click a part or wire.' });
      this.tip = el('div', { class: 'viewer-tip', hidden: true });
      this.empty = el('div', { class: 'viewer-empty', hidden: true });
      this.stage.append(this.canvas, this.tip, this.empty);
      this.root.append(this.side, this.stage);
      host.append(this.root);
      this.ctx = this.canvas.getContext('2d');
      this.view = { s: 3, ox: 0, oy: 0 };
      this.page = 0;
      this.sel = { refs: new Set(), nets: new Set() };
      this.listeners = {};
      this.font = '"IBM Plex Sans Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
      this.bind();
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.stage);
    }
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, d) { (this.listeners[ev] || []).forEach(f => f(d)); }

    setBoard(B) {
      this.B = B;
      this.sch = B.data.sch;
      this.dl = [];
      this.side.innerHTML = '';
      if (!this.sch || !this.sch.pages.length) {
        this.empty.hidden = false;
        this.empty.textContent = 'This board has no KiCad 6+ schematic in the repository.';
        this.side.hidden = true;
        return;
      }
      this.empty.hidden = true;
      // one sheet: no list to pick from, the drawing gets the room
      this.side.hidden = this.sch.pages.length < 2;
      const depth = i => { let d = 0, p = this.sch.pages[i].parent; while (p != null && d < 10) { d++; p = this.sch.pages[p].parent; } return d; };
      // the sheet list folds away to give the drawing the room; a tab at the stage edge brings it back
      const fold = on => { this.root.classList.toggle('sheets-folded', on); try { N.store.set('schSheets', on ? 'folded' : 'open'); } catch (e) { /* private mode */ } this.resize(); this.fit(); };
      let folded = false; try { folded = N.store.get('schSheets', 'open') === 'folded'; } catch (e) { folded = false; }
      this.root.classList.toggle('sheets-folded', folded && !this.side.hidden);
      if (!this.unfoldBtn) { this.unfoldBtn = el('button', { class: 'sch-unfold', title: 'Show the sheet list', 'aria-label': 'Show the sheet list', onclick: () => fold(false) }, 'Sheets ›'); this.stage.append(this.unfoldBtn); }
      this.unfoldBtn.hidden = !!this.side.hidden;
      this.side.append(el('div', { class: 'sch-sheets-head' }, el('span', null, `${this.sch.pages.length} sheet${this.sch.pages.length > 1 ? 's' : ''}`),
        el('button', { class: 'sch-fold', title: 'Hide the sheet list', 'aria-label': 'Hide the sheet list', onclick: () => fold(true) }, '‹')));
      this.sheetBtns = this.sch.pages.map((pg, i) => {
        const b = el('button', { class: 'sch-sheet', style: { paddingLeft: 10 + depth(i) * 12 + 'px' }, onclick: () => this.showPage(i, true) },
          el('span', { class: 'sch-sheet-no' }, String(i + 1)), el('span', { class: 'sch-sheet-name' }, pg.name === 'Root' ? (pg.tb.title || 'Root') : pg.name));
        this.side.append(b);
        return b;
      });
      this.showPage(0, true);
    }

    showPage(i, fit) {
      if (!this.sch) return;
      this.page = Math.max(0, Math.min(this.sch.pages.length - 1, i));
      this.sheetBtns.forEach((b, k) => b.classList.toggle('active', k === this.page));
      if (!this.dl[this.page]) this.dl[this.page] = this.build(this.sch.pages[this.page]);
      this.netCache = null;
      if (fit) this.fit();
      this.draw();
      this.emit('page', this.page);
    }

    // ------------------------------------------------------------- display list
    build(pg) {
      const lib = this.sch.lib;
      const out = { syms: [], labels: [], pins: [] };
      const font = this.font;
      for (const s of pg.syms) {
        const L = lib[s.l];
        const M = symMatrix(s.a, s.m);
        const T = (lx, ly) => { const r = apply(M, lx, -ly); return [s.x + r[0], s.y + r[1]]; };
        const item = { s, strokes: [], fills: [], bgFills: [], circles: [], texts: [], pins: [], bbox: [1e9, 1e9, -1e9, -1e9] };
        const grow = (x, y) => { const b = item.bbox; b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); };
        if (L) {
          for (const key in L.u) {
            const [u, st] = key.split('_').map(Number);
            if ((u !== 0 && u !== s.u) || (st !== 0 && st !== 1)) continue;
            for (const p of L.u[key]) {
              if (p[0] === 'r') {
                const pts = [T(p[1], p[2]), T(p[3], p[2]), T(p[3], p[4]), T(p[1], p[4])];
                pts.forEach(q => grow(...q));
                const poly = { pts, closed: true, w: p[5], fill: p[6] };
                item.strokes.push(poly);
              } else if (p[0] === 'p') {
                const pts = [];
                for (let k = 0; k < p[1].length; k += 2) pts.push(T(p[1][k], p[1][k + 1]));
                pts.forEach(q => grow(...q));
                item.strokes.push({ pts, closed: false, w: p[2], fill: p[3] });
              } else if (p[0] === 'c') {
                const c = T(p[1], p[2]);
                grow(c[0] - p[3], c[1] - p[3]); grow(c[0] + p[3], c[1] + p[3]);
                item.circles.push({ c, r: p[3], w: p[4], fill: p[5] });
              } else if (p[0] === 't') {
                const c = T(p[2], p[3]);
                let ang = p[5] || 0;
                if (swapsAxes(M)) ang = ang ? 0 : 90;
                item.texts.push({ str: p[1], x: c[0], y: c[1], size: p[4], ang, h: 'center', v: 'middle', kind: 'lib' });
              } else if (p[0] === 'P') {
                if (p[9]) continue; // hidden pin
                const [, x, y, a, len, name, num, , shape, , nsize, usize] = p;
                const d = [Math.round(Math.cos(a * Math.PI / 180)), Math.round(Math.sin(a * Math.PI / 180))];
                const S = T(x, y), E = T(x + d[0] * len, y + d[1] * len);
                grow(...S); grow(...E);
                const pin = { S, E, name, num, shape, nsize, usize };
                item.pins.push(pin);
                out.pins.push({ ref: s.r, num, x: S[0], y: S[1] });
                const dx = E[0] - S[0], dy = E[1] - S[1];
                const Ln = Math.hypot(dx, dy) || 1;
                const ux = dx / Ln, uy = dy / Ln;
                const vertical = Math.abs(uy) > 0.5;
                const po = L.po == null ? 0.508 : L.po;
                const showName = !L.hpn && name && name !== '~';
                const showNum = !L.hpnum && num && !L.pw;
                if (showNum) {
                  const mx = (S[0] + E[0]) / 2, my = (S[1] + E[1]) / 2;
                  const off = usize * 0.3 + 0.15;
                  if (vertical) item.texts.push({ str: num, x: mx - off, y: my, size: usize, ang: 90, h: 'center', v: 'bottom', kind: 'pinnum' });
                  else item.texts.push({ str: num, x: mx, y: my - off, size: usize, ang: 0, h: 'center', v: 'bottom', kind: 'pinnum' });
                }
                if (showName) {
                  if (po > 0) {
                    const nx = E[0] + ux * po, ny = E[1] + uy * po;
                    if (vertical) item.texts.push({ str: name, x: nx, y: ny, size: nsize, ang: 90, h: uy < 0 ? 'left' : 'right', v: 'middle', kind: 'pinname' });
                    else item.texts.push({ str: name, x: nx, y: ny, size: nsize, ang: 0, h: ux > 0 ? 'left' : 'right', v: 'middle', kind: 'pinname' });
                  } else {
                    const mx = (S[0] + E[0]) / 2, my = (S[1] + E[1]) / 2;
                    if (vertical) item.texts.push({ str: name, x: mx - 0.35, y: my, size: nsize, ang: 90, h: 'center', v: 'bottom', kind: 'pinname' });
                    else item.texts.push({ str: name, x: mx, y: my - 0.35, size: nsize, ang: 0, h: 'center', v: 'bottom', kind: 'pinname' });
                  }
                }
              }
            }
          }
        }
        // fields
        for (const f of s.f) {
          const [txt, fx, fy, fa, size, just, kind] = f;
          if (!txt) continue;
          const O = [s.x, s.y];
          const Mi = [M[0], M[2], M[1], M[3]]; // inverse of orthonormal = transpose
          const rel = apply(Mi, fx - O[0], fy - O[1]);
          const W = textW(txt, size, font), H = size;
          const h = just.includes('l') ? 'l' : just.includes('r') ? 'r' : 'c';
          const v = just.includes('t') ? 't' : just.includes('b') ? 'b' : 'c';
          const x0 = h === 'l' ? 0 : h === 'r' ? -W : -W / 2, y0 = v === 't' ? 0 : v === 'b' ? -H : -H / 2;
          const A = ((Math.round(fa) % 180) + 180) % 180;
          const corners = [[x0, y0], [x0 + W, y0], [x0 + W, y0 + H], [x0, y0 + H]].map(([cx, cy]) => {
            const r = A === 90 ? [cy, -cx] : [cx, cy];
            const q = apply(M, rel[0] + r[0], rel[1] + r[1]);
            return [O[0] + q[0], O[1] + q[1]];
          });
          const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
          const C = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
          let ang = A;
          if (swapsAxes(M)) ang = A === 0 ? 90 : 0;
          item.texts.push({ str: txt, x: C[0], y: C[1], size, ang, h: 'center', v: 'middle', kind: kind === 'r' ? 'ref' : kind === 'v' ? 'value' : 'field' });
          grow(Math.min(...xs), Math.min(...ys)); grow(Math.max(...xs), Math.max(...ys));
        }
        if (item.bbox[0] > item.bbox[2]) item.bbox = [s.x - 1, s.y - 1, s.x + 1, s.y + 1];
        out.syms.push(item);
      }
      // labels
      for (const l of pg.labels) {
        const [txt, x, y, a, kind, shape, size, just] = l;
        const W = textW(txt, size, font);
        const ar = ((Math.round(a) % 360) + 360) % 360;
        const D = [Math.round(Math.cos(ar * Math.PI / 180)), -Math.round(Math.sin(ar * Math.PI / 180))];
        const lab = { txt, x, y, kind, shape, size, D, W, bbox: null };
        const hh = size * 0.72;
        if (kind === 'g' || kind === 'd') {
          const L = W + size * 1.6;
          const pts = [];
          const tip = size * 0.6;
          const leftPoint = shape === 'input' || shape === 'bidirectional' || shape === 'tri_state';
          const rightPoint = shape === 'output' || shape === 'bidirectional' || shape === 'tri_state';
          // build in local frame: along +u from anchor
          const loc = [];
          loc.push(leftPoint ? [0, 0] : [0, -hh]);
          loc.push([leftPoint ? tip : 0, -hh]);
          loc.push([rightPoint ? L - tip : L, -hh]);
          loc.push(rightPoint ? [L, 0] : [L, -hh]);
          if (!rightPoint) loc.push([L, hh]);
          loc.push([rightPoint ? L - tip : L, hh]);
          loc.push([leftPoint ? tip : 0, hh]);
          if (!leftPoint) loc.push([0, hh]);
          for (const [u, w] of loc) pts.push([x + D[0] * u - D[1] * w, y + D[1] * u + D[0] * w]);
          lab.poly = pts;
          lab.tx = x + D[0] * L / 2; lab.ty = y + D[1] * L / 2;
          lab.ang = D[0] === 0 ? 90 : 0;
          lab.h = 'center';
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
          lab.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        } else if (kind === 'h') {
          const tip = size;
          const loc = [[0, 0], [tip * 0.5, -hh * 0.8], [tip, -hh * 0.8], [tip, hh * 0.8], [tip * 0.5, hh * 0.8]];
          lab.poly = loc.map(([u, w]) => [x + D[0] * u - D[1] * w, y + D[1] * u + D[0] * w]);
          const off = tip + size * 0.4;
          lab.tx = x + D[0] * off; lab.ty = y + D[1] * off;
          lab.ang = D[0] === 0 ? 90 : 0;
          lab.h = (D[0] > 0 || D[1] < 0) ? 'left' : 'right';
          const ex = x + D[0] * (off + W), ey = y + D[1] * (off + W);
          lab.bbox = [Math.min(x, ex) - hh, Math.min(y, ey) - hh, Math.max(x, ex) + hh, Math.max(y, ey) + hh];
        } else {
          // local label sits above the wire
          const off = size * 0.25;
          if (ar === 0) { lab.tx = x; lab.ty = y - off; lab.ang = 0; lab.h = 'left'; }
          else if (ar === 180) { lab.tx = x; lab.ty = y - off; lab.ang = 0; lab.h = 'right'; }
          else if (ar === 90) { lab.tx = x - off; lab.ty = y; lab.ang = 90; lab.h = 'left'; }
          else { lab.tx = x - off; lab.ty = y; lab.ang = 90; lab.h = 'right'; }
          lab.v = 'bottom';
          const ex = lab.ang ? x : (lab.h === 'left' ? x + W : x - W);
          const ey = lab.ang ? (lab.h === 'left' ? y - W : y + W) : y;
          lab.bbox = [Math.min(x, ex) - size * 0.4, Math.min(y, ey) - size * 1.2, Math.max(x, ex) + size * 0.4, Math.max(y, ey) + size * 0.4];
          if (lab.ang) lab.bbox = [x - size * 1.3, Math.min(y, ey), x + size * 0.3, Math.max(y, ey)];
        }
        out.labels.push(lab);
      }
      // wire graph
      out.wires = pg.wires;
      // what is drawn (not the empty paper around it): the view fits this
      const cb = [1e9, 1e9, -1e9, -1e9];
      const add = (x, y) => { if (!isFinite(x) || !isFinite(y)) return; if (x < cb[0]) cb[0] = x; if (y < cb[1]) cb[1] = y; if (x > cb[2]) cb[2] = x; if (y > cb[3]) cb[3] = y; };
      for (const it of out.syms) if (it.bbox[2] > it.bbox[0]) { add(it.bbox[0], it.bbox[1]); add(it.bbox[2], it.bbox[3]); }
      for (const arr of [pg.wires, pg.buses || []]) for (let i = 0; i < arr.length; i += 4) { add(arr[i], arr[i + 1]); add(arr[i + 2], arr[i + 3]); }
      for (const l of out.labels) if (l.bbox) { add(l.bbox[0], l.bbox[1]); add(l.bbox[2], l.bbox[3]); }
      for (const sh of pg.sheets) { add(sh.x, sh.y - 3); add(sh.x + sh.w, sh.y + sh.h + 3); }
      for (const t of pg.texts) add(t[1], t[2]);
      for (const g of pg.gfx) if (g[0] === 'r') { add(g[1], g[2]); add(g[3], g[4]); }
      out.content = cb[2] > cb[0] ? cb : null;
      return out;
    }

    // ------------------------------------------------------------- view
    // the drawing fills the view: fit what is drawn, the whole paper only when the drawing covers most of it
    fit() {
      if (!this.sch) return;
      const pg = this.sch.pages[this.page];
      const W = this.stage.clientWidth || 800, H = this.stage.clientHeight || 600;
      const [pw, ph] = pg.paper;
      const dl = this.dl[this.page], c = dl && dl.content;
      let box = [0, 0, pw, ph];
      if (c && (c[2] - c[0]) * (c[3] - c[1]) < 0.62 * pw * ph) {
        const m = Math.max(4, Math.max(c[2] - c[0], c[3] - c[1]) * 0.04);
        box = [c[0] - m, c[1] - m, c[2] + m, c[3] + m];
      }
      const bw = box[2] - box[0], bh = box[3] - box[1];
      const s = Math.min((W - 24) / bw, (H - 24) / bh);
      this.view.s = s;
      this.view.ox = (W - bw * s) / 2 - box[0] * s;
      this.view.oy = (H - bh * s) / 2 - box[1] * s;
      this.draw();
    }
    toWorld(sx, sy) { return [(sx - this.view.ox) / this.view.s, (sy - this.view.oy) / this.view.s]; }
    toScreen(x, y) { return [this.view.ox + x * this.view.s, this.view.oy + y * this.view.s]; }
    zoomAt(sx, sy, k) {
      const s0 = this.view.s, s1 = Math.max(0.5, Math.min(120, s0 * k)), f = s1 / s0;
      this.view.ox = sx - (sx - this.view.ox) * f;
      this.view.oy = sy - (sy - this.view.oy) * f;
      this.view.s = s1;
      this.draw();
    }
    resize() {
      const r = this.stage.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.dpr = dpr;
      const first = !this.canvas.width || this.canvas.width < 10;
      const w0 = this.canvas.clientWidth, h0 = this.canvas.clientHeight;
      const mid = !first && this.sch && w0 > 10 && h0 > 10 ? this.toWorld(w0 / 2, h0 / 2) : null;
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
      this.canvas.style.width = r.width + 'px';
      this.canvas.style.height = r.height + 'px';
      if (mid && (Math.abs(r.width - w0) > 1 || Math.abs(r.height - h0) > 1)) { this.view.ox = r.width / 2 - mid[0] * this.view.s; this.view.oy = r.height / 2 - mid[1] * this.view.s; }
      if (first) this.fit(); else this.draw();
    }
    setSelection(refs, nets) {
      this.sel = { refs: new Set(refs || []), nets: new Set(nets || []) };
      this.netCache = null;
      this._selVer = (this._selVer || 0) + 1;
      this.draw();
    }
    focusRef(ref) {
      if (!this.sch || !this.B) return false;
      const loc = (this.B.schSymbols.get(ref) || [])[0];
      if (!loc) return false;
      if (loc.page !== this.page) this.showPage(loc.page, false);
      const item = this.dl[this.page].syms[loc.sym];
      if (!item) return false;
      const b = item.bbox;
      const W = this.stage.clientWidth, H = this.stage.clientHeight;
      const span = Math.max(b[2] - b[0], b[3] - b[1], 20) * 2.2;
      this.view.s = Math.min(W, H) / span;
      this.view.ox = W / 2 - (b[0] + b[2]) / 2 * this.view.s;
      this.view.oy = H / 2 - (b[1] + b[3]) / 2 * this.view.s;
      this.draw();
      return true;
    }
    focusPoint(x, y) {
      const W = this.stage.clientWidth, H = this.stage.clientHeight;
      this.view.s = Math.max(this.view.s, 6);
      this.view.ox = W / 2 - x * this.view.s;
      this.view.oy = H / 2 - y * this.view.s;
      this.draw();
    }
    // pages that mention a net (for cross-probing)
    pagesForNet(n) {
      const B = this.B;
      const name = N.fmt.shortNet(B.nets[n] || '');
      const pads = B.padsByNet.get(n) || [];
      const refs = new Set(pads.map(i => B.fps[B.pads[i][0]].r));
      const res = [];
      this.sch.pages.forEach((pg, i) => {
        if (pg.labels.some(l => l[0] === name) || pg.syms.some(s => refs.has(s.r))) res.push(i);
      });
      return res;
    }

    // highlighted wires for the selected nets on this page
    netWires() {
      if (this.netCache) return this.netCache;
      const B = this.B, dl = this.dl[this.page];
      const res = { wires: new Set(), pins: [], labels: new Set() };
      if (!this.sel.nets.size) return (this.netCache = res);
      const names = new Set([...this.sel.nets].map(n => N.fmt.shortNet(B.nets[n])));
      const seeds = [];
      for (const p of dl.pins) {
        const net = B.padNet(p.ref, p.num);
        if (net && this.sel.nets.has(net)) { seeds.push([p.x, p.y]); res.pins.push(p); }
      }
      dl.labels.forEach((l, i) => { if (names.has(l.txt)) { seeds.push([l.x, l.y]); res.labels.add(i); } });
      const w = dl.wires;
      const n = w.length / 4;
      const pts = seeds.slice();
      const eps = 0.02;
      let changed = true, guard = 0;
      while (changed && guard++ < 60) {
        changed = false;
        for (let i = 0; i < n; i++) {
          if (res.wires.has(i)) continue;
          const x1 = w[i * 4], y1 = w[i * 4 + 1], x2 = w[i * 4 + 2], y2 = w[i * 4 + 3];
          for (const [px, py] of pts) {
            if (N.segDist(px, py, x1, y1, x2, y2) < eps || N.segDist(x1, y1, px, py, px, py) < eps) {
              res.wires.add(i); pts.push([x1, y1], [x2, y2]); changed = true; break;
            }
          }
        }
        // wires whose endpoint lies on a highlighted wire (T-junction)
        for (let i = 0; i < n; i++) {
          if (res.wires.has(i)) continue;
          const x1 = w[i * 4], y1 = w[i * 4 + 1], x2 = w[i * 4 + 2], y2 = w[i * 4 + 3];
          for (const j of res.wires) {
            const a = w.slice(j * 4, j * 4 + 4);
            if (N.segDist(x1, y1, ...a) < eps || N.segDist(x2, y2, ...a) < eps) { res.wires.add(i); pts.push([x1, y1], [x2, y2]); changed = true; break; }
          }
        }
      }
      return (this.netCache = res);
    }

    draw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this.paint(); });
    }
    colors() {
      const v = n => N.cssVar(n);
      return {
        bg: v('--sch-bg'), paper: v('--sch-paper'), frame: v('--sch-frame'), wire: v('--sch-wire'), bus: v('--sch-bus'), body: v('--sch-body'),
        fill: v('--sch-fill'), pin: v('--sch-pin'), pinname: v('--sch-pinname'), ref: v('--sch-ref'), text: v('--sch-text'), note: v('--sch-note'),
        sheet: v('--sch-sheet'), sheetFill: v('--sch-sheet-fill'), nc: v('--sch-nc'), label: v('--sch-label'),
      };
    }
    paint() {
      const live = this.sch && N.live && N.live.on && N.live.B === this.B ? N.live : null;
      if (!live) { this._lc = null; this.paintBase(this.ctx, null); return; }
      // live: the drawing (cached until the view changes), a layer of voltage-coloured wires (throttled), dots every frame
      const W = this.canvas.width, H = this.canvas.height;
      const mk = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
      const c = this._lc && this._lc.W === W && this._lc.H === H ? this._lc : (this._lc = { W, H, base: mk(), wires: mk() });
      const vkey = [W, H, this.view.s, this.view.ox, this.view.oy, this.page, this._selVer || 0, N.cssVar('--sch-paper')].join('|');
      const dpr = this.dpr || 1, s = this.view.s;
      const world = g => g.setTransform(dpr * s, 0, 0, dpr * s, dpr * this.view.ox, dpr * this.view.oy);
      let fresh = false;
      if (c.vkey !== vkey) { this.paintBase(c.base.getContext('2d'), live); c.vkey = vkey; c.scheme = this.liveScheme(this.colors()); fresh = true; }
      const flow = this.liveFlow();
      const ckey = vkey + '|' + live.gen + '|' + live.colGen;
      const now = performance.now();
      if (c.ckey !== ckey && (fresh || c.gen !== live.gen || now - (c.cT || 0) > 70)) {
        const g = c.wires.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, W, H);
        world(g);
        g.lineCap = 'round'; g.lineJoin = 'round';
        this.paintLiveWires(g, live, flow, c.scheme, 1 / s);
        this.paintLivePins(g, live, flow, c.scheme, 1 / s);
        const hl = this.netWires(), w = this.sch.pages[this.page].wires;
        if (hl.wires.size) {
          g.strokeStyle = PROBE; g.lineWidth = Math.max(0.45, 3 / s); g.globalAlpha = 0.45;
          g.beginPath();
          for (const i of hl.wires) { g.moveTo(w[i * 4], w[i * 4 + 1]); g.lineTo(w[i * 4 + 2], w[i * 4 + 3]); }
          g.stroke(); g.globalAlpha = 1;
        }
        c.ckey = ckey; c.cT = now; c.gen = live.gen;
      }
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(c.base, 0, 0);
      ctx.drawImage(c.wires, 0, 0);
      world(ctx);
      this.paintLiveDyn(ctx, live, flow, c.scheme, 1 / s, this.dl[this.page]);
    }
    paintBase(ctx, live) {
      const dpr = this.dpr || 1;
      const C = this.colors();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = C.bg || '#e9ebe6';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.sch) return;
      const pg = this.sch.pages[this.page];
      const dl = this.dl[this.page];
      const s = this.view.s;
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * this.view.ox, dpr * this.view.oy);
      const px = 1 / s;
      const [pw, ph] = pg.paper;
      ctx.fillStyle = C.paper;
      ctx.shadowColor = 'rgba(0,0,0,0.18)';
      ctx.shadowBlur = 10 * dpr;
      ctx.fillRect(0, 0, pw, ph);
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      this.paintFrame(ctx, pg, C, px);
      const txt = (t, color, weight) => this.text(ctx, t, color, weight);
      const hl = this.netWires();
      // graphics & notes
      ctx.strokeStyle = C.note;
      ctx.lineWidth = Math.max(0.15, px);
      for (const g of pg.gfx) {
        ctx.beginPath();
        if (g[0] === 'r') ctx.rect(g[1], g[2], g[3] - g[1], g[4] - g[2]);
        else if (g[0] === 'p') { const p = g[1]; ctx.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]); }
        else if (g[0] === 'c') ctx.arc(g[1], g[2], g[3], 0, Math.PI * 2);
        ctx.stroke();
      }
      // sheets
      for (const sh of pg.sheets) {
        ctx.fillStyle = C.sheetFill; ctx.strokeStyle = C.sheet; ctx.lineWidth = Math.max(0.25, px * 1.2);
        ctx.fillRect(sh.x, sh.y, sh.w, sh.h); ctx.strokeRect(sh.x, sh.y, sh.w, sh.h);
        txt({ str: sh.name, x: sh.x, y: sh.y - 0.6, size: 1.5, ang: 0, h: 'left', v: 'bottom' }, C.sheet, 600);
        txt({ str: 'File: ' + sh.file, x: sh.x, y: sh.y + sh.h + 0.6, size: 1.1, ang: 0, h: 'left', v: 'top' }, C.sheet);
        for (const [name, x, y, a] of sh.pins) {
          const right = Math.round(a) === 0;
          const D = right ? -1 : 1;
          ctx.beginPath();
          ctx.moveTo(x, y); ctx.lineTo(x + D * 0.8, y - 0.6); ctx.lineTo(x + D * 1.6, y - 0.6); ctx.lineTo(x + D * 1.6, y + 0.6); ctx.lineTo(x + D * 0.8, y + 0.6); ctx.closePath();
          ctx.stroke();
          txt({ str: name, x: x + D * 2.1, y, size: 1.27, ang: 0, h: right ? 'right' : 'left', v: 'middle' }, C.sheet);
        }
      }
      // wires & buses
      const w = pg.wires;
      if (live) C.wire = this.liveScheme(C) === 'dark' ? '#5c646b' : '#a3a8ad';
      ctx.strokeStyle = C.wire; ctx.lineWidth = Math.max(0.16, px * 1.3);
      ctx.beginPath();
      for (let i = 0; i < w.length; i += 4) { ctx.moveTo(w[i], w[i + 1]); ctx.lineTo(w[i + 2], w[i + 3]); }
      ctx.stroke();
      ctx.strokeStyle = C.bus; ctx.lineWidth = Math.max(0.35, px * 2);
      ctx.beginPath();
      for (const arr of [pg.buses, pg.entries || []]) for (let i = 0; i < arr.length; i += 4) { ctx.moveTo(arr[i], arr[i + 1]); ctx.lineTo(arr[i + 2], arr[i + 3]); }
      ctx.stroke();
      if (hl.wires.size && !live) {
        ctx.strokeStyle = PROBE; ctx.lineWidth = Math.max(0.45, px * 3);
        ctx.beginPath();
        for (const i of hl.wires) { ctx.moveTo(w[i * 4], w[i * 4 + 1]); ctx.lineTo(w[i * 4 + 2], w[i * 4 + 3]); }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = C.wire;
      for (let i = 0; i < pg.junctions.length; i += 2) { ctx.beginPath(); ctx.arc(pg.junctions[i], pg.junctions[i + 1], 0.46, 0, Math.PI * 2); ctx.fill(); }
      ctx.strokeStyle = C.nc; ctx.lineWidth = Math.max(0.16, px);
      for (let i = 0; i < pg.nc.length; i += 2) {
        const x = pg.nc[i], y = pg.nc[i + 1], r = 0.64;
        ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
      }
      // symbols
      for (const it of dl.syms) {
        const selected = this.sel.refs.has(it.s.r);
        const bb = it.bbox;
        if (selected) {
          ctx.fillStyle = 'rgba(227,166,0,0.16)';
          ctx.fillRect(bb[0] - 1, bb[1] - 1, bb[2] - bb[0] + 2, bb[3] - bb[1] + 2);
          ctx.strokeStyle = PROBE; ctx.lineWidth = Math.max(0.25, px * 1.5);
          ctx.setLineDash([1, 0.6]);
          ctx.strokeRect(bb[0] - 1, bb[1] - 1, bb[2] - bb[0] + 2, bb[3] - bb[1] + 2);
          ctx.setLineDash([]);
        }
        for (const p of it.strokes) {
          ctx.beginPath();
          ctx.moveTo(p.pts[0][0], p.pts[0][1]);
          for (let k = 1; k < p.pts.length; k++) ctx.lineTo(p.pts[k][0], p.pts[k][1]);
          if (p.closed) ctx.closePath();
          if (p.fill === 2) { ctx.fillStyle = C.fill; ctx.fill(); }
          else if (p.fill === 1) { ctx.fillStyle = C.body; ctx.fill(); }
          ctx.strokeStyle = C.body; ctx.lineWidth = Math.max(p.w || 0.2, px * 1.15);
          ctx.stroke();
        }
        for (const c of it.circles) {
          ctx.beginPath(); ctx.arc(c.c[0], c.c[1], c.r, 0, Math.PI * 2);
          if (c.fill === 2) { ctx.fillStyle = C.fill; ctx.fill(); } else if (c.fill === 1) { ctx.fillStyle = C.body; ctx.fill(); }
          ctx.strokeStyle = C.body; ctx.lineWidth = Math.max(c.w || 0.2, px * 0.9); ctx.stroke();
        }
        ctx.strokeStyle = C.pin; ctx.lineWidth = Math.max(0.16, px * 0.9);
        ctx.beginPath();
        for (const p of it.pins) { ctx.moveTo(p.S[0], p.S[1]); ctx.lineTo(p.E[0], p.E[1]); }
        ctx.stroke();
        for (const p of it.pins) {
          if (p.shape === 'inverted' || p.shape === 'inverted_clock') {
            const dx = p.E[0] - p.S[0], dy = p.E[1] - p.S[1], L = Math.hypot(dx, dy) || 1;
            ctx.beginPath(); ctx.arc(p.E[0] - dx / L * 0.5, p.E[1] - dy / L * 0.5, 0.5, 0, Math.PI * 2); ctx.stroke();
          }
        }
        for (const t of it.texts) {
          const col = t.kind === 'ref' ? C.ref : t.kind === 'value' ? C.ref : t.kind === 'pinname' ? C.pinname : t.kind === 'pinnum' ? C.pin : C.text;
          txt(t, selected && t.kind === 'ref' ? '#9a6b00' : col, t.kind === 'ref' ? 600 : 400);
        }
      }
      // pins on highlighted net
      if (hl.pins.length) {
        ctx.fillStyle = PROBE;
        for (const p of hl.pins) { ctx.beginPath(); ctx.arc(p.x, p.y, 0.55, 0, Math.PI * 2); ctx.fill(); }
      }
      // labels
      dl.labels.forEach((l, i) => {
        const on = hl.labels.has(i);
        if (l.poly) {
          ctx.beginPath();
          ctx.moveTo(l.poly[0][0], l.poly[0][1]);
          for (const p of l.poly.slice(1)) ctx.lineTo(p[0], p[1]);
          ctx.closePath();
          if (on) { ctx.fillStyle = 'rgba(227,166,0,0.35)'; ctx.fill(); }
          ctx.strokeStyle = l.kind === 'h' ? C.sheet : C.label;
          ctx.lineWidth = Math.max(0.16, px);
          ctx.stroke();
        } else if (on) {
          const b = l.bbox;
          ctx.fillStyle = 'rgba(227,166,0,0.35)';
          ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
        }
        txt({ str: l.txt, x: l.tx, y: l.ty, size: l.size, ang: l.ang, h: l.h, v: l.v || 'middle' }, l.kind === 'h' ? C.sheet : C.label, 500);
      });
      // notes
      for (const t of pg.texts) {
        const [str, x, y, a, size, just] = t;
        txt({ str, x, y, size, ang: ((Math.round(a) % 180) + 180) % 180, h: just.includes('l') ? 'left' : just.includes('r') ? 'right' : 'center', v: just.includes('t') ? 'top' : just.includes('b') ? 'bottom' : 'middle' }, C.note);
      }
      this.paintOverview(ctx, dl, pg, C);
    }
    // zoomed out, the drawing's own text is too small to read: name the bigger parts and the sheets on top of it, at a
    // readable size, biggest first, never on top of each other
    paintOverview(ctx, dl, pg, C) {
      const s = this.view.s, dpr = this.dpr || 1;
      if (s * 1.27 >= 7.5) return;
      const W = this.canvas.width / dpr, H = this.canvas.height / dpr;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // fade out as the drawing's own text becomes readable
      const fade = Math.max(0, Math.min(1, (7.5 - s * 1.27) / 3));
      const A = a => a * fade;
      const placed = [];
      const free = (x0, y0, x1, y1) => !placed.some(r => x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]);
      const tag = (lines, cx, cy, maxW, colour, bold) => {
        const fs = bold ? 12 : 11;
        ctx.font = `600 ${fs}px ${this.font}`;
        const w0 = ctx.measureText(lines[0]).width;
        ctx.font = `400 ${fs - 1}px ${this.font}`;
        const w1 = lines[1] ? ctx.measureText(lines[1]).width : 0;
        if (lines[1] && w1 > maxW * 1.5) lines = [lines[0]];
        const w = Math.max(w0, lines[1] ? w1 : 0) + 10, h = lines.length * (fs + 2) + 5;
        if (w0 + 10 > maxW * 2.2) return false;
        const x0 = cx - w / 2, y0 = cy - h / 2;
        if (x0 + w < 0 || y0 + h < 0 || x0 > W || y0 > H || !free(x0 - 2, y0 - 2, x0 + w + 2, y0 + h + 2)) return false;
        placed.push([x0, y0, x0 + w, y0 + h]);
        ctx.fillStyle = C.paper; ctx.globalAlpha = A(0.9);
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y0, w, h, 4); else ctx.rect(x0, y0, w, h); ctx.fill();
        ctx.strokeStyle = colour; ctx.lineWidth = 1; ctx.globalAlpha = A(0.35); ctx.stroke(); ctx.globalAlpha = A(1);
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = colour;
        ctx.font = `600 ${fs}px ${this.font}`; ctx.fillText(lines[0], cx, y0 + 3);
        if (lines[1]) { ctx.font = `400 ${fs - 1}px ${this.font}`; ctx.fillStyle = C.text; ctx.fillText(lines[1], cx, y0 + 3 + fs + 2); }
        return true;
      };
      // sheet blocks first, then parts by size
      for (const sh of pg.sheets) {
        const a = this.toScreen(sh.x, sh.y), b = this.toScreen(sh.x + sh.w, sh.y + sh.h);
        if (b[0] - a[0] < 24 || b[1] - a[1] < 14) continue;
        tag([sh.name], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, b[0] - a[0], C.sheet, true);
      }
      const items = dl.syms.filter(it => it.s.r && !String(it.s.r).startsWith('#') && it.bbox[2] > it.bbox[0])
        .map(it => { const a = this.toScreen(it.bbox[0], it.bbox[1]), b = this.toScreen(it.bbox[2], it.bbox[3]); return { it, a, b, w: b[0] - a[0], h: b[1] - a[1] }; })
        .filter(q => { const small = /^(R|C|L|FB|D|TP|JP|NT)\d/i.test(q.it.s.r) || q.it.pins.length <= 2; return (small ? q.w >= 48 && q.h >= 26 : q.w >= 22 && q.h >= 12) && q.b[0] > 0 && q.b[1] > 0 && q.a[0] < W && q.a[1] < H; })
        .sort((p, q) => q.w * q.h - p.w * p.h);
      for (const q of items.slice(0, 400)) {
        const v = String(q.it.s.v || '').replace(/_/g, ' ');
        tag(v && v.length <= 22 && v !== q.it.s.r ? [q.it.s.r, v] : [q.it.s.r], (q.a[0] + q.b[0]) / 2, (q.a[1] + q.b[1]) / 2, q.w, C.ref, false);
      }
      ctx.restore();
    }

    // ------------------------------------------------------------- live simulation overlay
    liveScheme(C) {
      const m = /^#([0-9a-f]{6})$/i.exec((C.paper || '').trim());
      if (!m) return 'light';
      const n = parseInt(m[1], 16);
      return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255) > 380 ? 'light' : 'dark';
    }
    liveFlow() {
      const dl = this.dl[this.page];
      if (!dl.flow) {
        const F = N.schFlow(this.B, this.sch.pages[this.page], dl);
        F.update = l => N.schFlowUpdate(F, l);
        dl.flow = F;
      }
      return dl.flow;
    }
    paintLiveWires(ctx, L, F, scheme, px) {
      const pal = N.livePalette(scheme);
      const S = F.segs, CI = L.colIdx;
      const byCol = new Map();
      for (let s = 0; s < F.ns; s++) {
        const n = F.segNet[s];
        if (!n) continue;
        const k = CI[n];
        if (k === 255) continue;
        let pth = byCol.get(k);
        if (!pth) byCol.set(k, (pth = new Path2D()));
        pth.moveTo(S[s * 4], S[s * 4 + 1]); pth.lineTo(S[s * 4 + 2], S[s * 4 + 3]);
      }
      ctx.lineWidth = Math.max(0.3, px * 2.4);
      for (const [k, pth] of byCol) { ctx.strokeStyle = pal[k]; ctx.stroke(pth); }
      const J = F.junc || [];
      for (let i = 0; i < J.length; i += 3) { const k = CI[J[i + 2]]; if (k === 255) continue; ctx.fillStyle = pal[k]; ctx.beginPath(); ctx.arc(J[i], J[i + 1], 0.55, 0, Math.PI * 2); ctx.fill(); }
    }
    paintLivePins(ctx, L, F, scheme, px) {
      const pal = N.livePalette(scheme), CI = L.colIdx;
      // pins in their net colour
      ctx.lineWidth = Math.max(0.24, px * 2);
      for (const lg of F.legs) {
        if (!lg.net) continue;
        const k = CI[lg.net];
        if (k === 255) continue;
        ctx.strokeStyle = pal[k];
        ctx.beginPath(); ctx.moveTo(lg.S[0], lg.S[1]); ctx.lineTo(lg.E[0], lg.E[1]); ctx.stroke();
      }
    }
    paintLiveDyn(ctx, L, F, scheme, px, dl) {
      const B = this.B;
      // LEDs glow on the drawing too
      for (const d of L.leds || []) {
        if (!(d.lvl > 0.02)) continue;
        for (const it of dl.syms) {
          if (it.s.r !== d.ref) continue;
          const b = it.bbox, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
          const rad = Math.max(3, Math.min(9, Math.hypot(b[2] - b[0], b[3] - b[1]) * 0.45)) * (0.7 + d.lvl * 0.6);
          const [r, g, bl] = d.col;
          const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
          gr.addColorStop(0, `rgba(${r},${g},${bl},${0.55 * d.lvl})`);
          gr.addColorStop(1, `rgba(${r},${g},${bl},0)`);
          ctx.fillStyle = gr;
          ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
        }
      }
      // current dots
      N.liveStepPhases(F, L);
      const sp = Math.max(1.0, 15 * px), r = Math.max(0.22, 2.3 * px);
      const pth = new Path2D();
      const S = F.segs;
      for (let s = 0; s < F.ns; s++) if (Math.abs(F.segI[s]) >= 2e-7) N.drawDots(pth, S[s * 4], S[s * 4 + 1], S[s * 4 + 2], S[s * 4 + 3], F.phase[s], sp, r);
      F.legs.forEach((lg, k) => { if (Math.abs(F.legI[k]) >= 2e-7) N.drawDots(pth, lg.S[0], lg.S[1], lg.E[0], lg.E[1], F.legPhase[k], sp * 0.6, r * 0.85); });
      const Sc = N.liveScheme(scheme);
      ctx.fillStyle = Sc.dot; ctx.fill(pth);
      ctx.lineWidth = r * 0.35; ctx.strokeStyle = Sc.dotEdge; ctx.stroke(pth);
      if (this.hoverHit && !this.tip.hidden && (L.frameId % 12) === 0) this.tip.innerHTML = this.describe(this.hoverHit);
      // probe markers dropped on this sheet
      const pr = (L.probes || []).filter(p => p.at && p.at.view === 'sch' && p.at.page === this.page);
      if (pr.length && N.paintProbeMarkers) { ctx.save(); const dpr = this.dpr || 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); N.paintProbeMarkers(ctx, pr.map(p => [p, this.toScreen(p.at.x, p.at.y)])); ctx.restore(); }
      void B;
    }

    text(ctx, t, color, weight) {
      const s = this.view.s;
      if (t.size * s < 2.2) return;
      ctx.save();
      ctx.translate(t.x, t.y);
      if (t.ang) ctx.rotate(-t.ang * Math.PI / 180);
      ctx.fillStyle = color;
      ctx.font = `${weight || 400} ${t.size * 1.3}px ${this.font}`;
      ctx.textAlign = t.h === 'left' ? 'left' : t.h === 'right' ? 'right' : 'center';
      ctx.textBaseline = t.v === 'top' ? 'top' : t.v === 'bottom' ? 'alphabetic' : 'middle';
      const lines = String(t.str).split('\n');
      const lh = t.size * 1.5;
      lines.forEach((ln, i) => ctx.fillText(ln.replace(/~\{([^}]*)\}/g, '$1'), 0, (i - (t.v === 'top' ? 0 : t.v === 'bottom' ? lines.length - 1 : (lines.length - 1) / 2)) * lh));
      ctx.restore();
    }

    paintFrame(ctx, pg, C, px) {
      const [pw, ph] = pg.paper;
      ctx.strokeStyle = C.frame;
      ctx.lineWidth = Math.max(0.15, px);
      const m = 10;
      ctx.strokeRect(m, m, pw - 2 * m, ph - 2 * m);
      ctx.strokeRect(m - 2, m - 2, pw - 2 * m + 4, ph - 2 * m + 4);
      // zone ticks
      const cols = Math.round((pw - 2 * m) / 50), rows = Math.round((ph - 2 * m) / 50);
      ctx.fillStyle = C.frame;
      for (let i = 0; i < cols; i++) {
        const x = m + (pw - 2 * m) * (i + 0.5) / cols;
        this.text(ctx, { str: String(i + 1), x, y: m - 1, size: 1.3, ang: 0, h: 'center', v: 'middle' }, C.frame);
        this.text(ctx, { str: String(i + 1), x, y: ph - m + 1, size: 1.3, ang: 0, h: 'center', v: 'middle' }, C.frame);
      }
      for (let j = 0; j < rows; j++) {
        const y = m + (ph - 2 * m) * (j + 0.5) / rows;
        const L = String.fromCharCode(65 + j);
        this.text(ctx, { str: L, x: m - 1, y, size: 1.3, ang: 0, h: 'center', v: 'middle' }, C.frame);
        this.text(ctx, { str: L, x: pw - m + 1, y, size: 1.3, ang: 0, h: 'center', v: 'middle' }, C.frame);
      }
      // title block
      const tbw = 110, tbh = 30;
      const x0 = pw - m - tbw, y0 = ph - m - tbh;
      ctx.strokeRect(x0, y0, tbw, tbh);
      ctx.beginPath();
      ctx.moveTo(x0, y0 + 8); ctx.lineTo(x0 + tbw, y0 + 8);
      ctx.moveTo(x0, y0 + 16); ctx.lineTo(x0 + tbw, y0 + 16);
      ctx.moveTo(x0, y0 + 23); ctx.lineTo(x0 + tbw, y0 + 23);
      ctx.stroke();
      const tb = pg.tb || {};
      const rootTb = this.sch.pages[0].tb || {};
      const T = (str, x, y, size, bold) => this.text(ctx, { str, x, y, size, ang: 0, h: 'left', v: 'middle' }, C.frame, bold ? 600 : 400);
      T('Sheet: /' + (pg.name === 'Root' ? '' : pg.name + '/'), x0 + 1.5, y0 + 3, 1.3);
      T('File: ' + pg.file, x0 + 1.5, y0 + 6, 1.3);
      T(tb.title || rootTb.title || this.B.data.key.split('__')[1], x0 + 1.5, y0 + 12, 2.2, true);
      T('Size: ' + (pg.paper[0] === 297 ? 'A4' : pg.paper[0] === 420 ? 'A3' : pg.paper[0] + '×' + pg.paper[1]) + '   Date: ' + (tb.date || rootTb.date || '—') + '   Rev: ' + (tb.rev || rootTb.rev || '—'), x0 + 1.5, y0 + 19.5, 1.3);
      T((tb.company || rootTb.company || '') + '', x0 + 1.5, y0 + 26.5, 1.3);
      this.text(ctx, { str: `Id: ${this.page + 1}/${this.sch.pages.length}`, x: x0 + tbw - 1.5, y: y0 + 26.5, size: 1.3, ang: 0, h: 'right', v: 'middle' }, C.frame);
    }

    // ------------------------------------------------------------- input
    hit(sx, sy) {
      if (!this.sch) return null;
      const [x, y] = this.toWorld(sx, sy);
      const dl = this.dl[this.page];
      const pg = this.sch.pages[this.page];
      for (let i = dl.labels.length - 1; i >= 0; i--) {
        const b = dl.labels[i].bbox;
        if (b && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) return { type: 'label', i, name: dl.labels[i].txt };
      }
      let best = null;
      for (const it of dl.syms) {
        const b = it.bbox;
        if (x >= b[0] - 0.5 && x <= b[2] + 0.5 && y >= b[1] - 0.5 && y <= b[3] + 0.5) {
          const area = (b[2] - b[0]) * (b[3] - b[1]);
          if (!best || area < best.area) best = { type: 'sym', it, area };
        }
      }
      // pins first when hovering near a pin end
      const tol = 4 / this.view.s;
      for (const p of dl.pins) if (Math.hypot(p.x - x, p.y - y) < tol) return { type: 'pin', p };
      const w = pg.wires;
      for (let i = 0; i < w.length; i += 4) if (N.segDist(x, y, w[i], w[i + 1], w[i + 2], w[i + 3]) < tol) return { type: 'wire', i: i / 4 };
      if (best) return best;
      for (const sh of pg.sheets) if (x >= sh.x && x <= sh.x + sh.w && y >= sh.y && y <= sh.y + sh.h) return { type: 'sheet', sh };
      return null;
    }
    netOfWire(i) {
      // flood from wire i to find a pin with a PCB net, or a label
      const B = this.B, dl = this.dl[this.page];
      const w = dl.wires;
      const n = w.length / 4;
      const set = new Set([i]);
      const pts = [[w[i * 4], w[i * 4 + 1]], [w[i * 4 + 2], w[i * 4 + 3]]];
      let changed = true, guard = 0;
      while (changed && guard++ < 50) {
        changed = false;
        for (let j = 0; j < n; j++) {
          if (set.has(j)) continue;
          for (const [px, py] of pts) {
            if (N.segDist(px, py, w[j * 4], w[j * 4 + 1], w[j * 4 + 2], w[j * 4 + 3]) < 0.02) { set.add(j); pts.push([w[j * 4], w[j * 4 + 1]], [w[j * 4 + 2], w[j * 4 + 3]]); changed = true; break; }
          }
        }
      }
      for (const p of dl.pins) for (const [px, py] of pts) if (Math.hypot(p.x - px, p.y - py) < 0.02) { const net = B.padNet(p.ref, p.num); if (net) return net; }
      for (const l of dl.labels) for (const [px, py] of pts) if (Math.hypot(l.x - px, l.y - py) < 0.05) { const net = B.findNet(l.txt); if (net > 0) return net; }
      return 0;
    }
    describe(h) {
      const B = this.B;
      const live = N.live && N.live.on && N.live.B === B;
      if (h.type === 'sym') {
        const s = h.it.s;
        const part = B.schParts.get(s.r);
        return `<b>${N.esc(s.r)}</b> · ${N.esc(s.v)}<br><span>${N.esc((part && part.desc) || s.l.split(':').pop())}</span>${live && s.r && !s.r.startsWith('#') ? N.liveTipPart(B, s.r) : ''}`;
      }
      if (h.type === 'pin') {
        const net = B.padNet(h.p.ref, h.p.num);
        return `<b>${N.esc(h.p.ref)}.${N.esc(h.p.num)}</b>${h.p.name && h.p.name !== String(h.p.num) ? ' ' + N.esc(h.p.name) : ''} <span class="tip-sub">${net ? N.esc(N.fmt.shortNet(B.nets[net])) : 'not on the PCB'}</span>${live ? N.liveTipPin(B, h.p.ref, h.p.num, net) : ''}`;
      }
      if (h.type === 'label') return live ? `<b>${N.esc(h.name)}</b> <span class="tip-sub">net label</span>${N.liveTipNet(B, B.findNet(h.name))}` : `<b>${N.esc(h.name)}</b><br><span>net label · click to trace</span>`;
      if (h.type === 'wire') { if (!live) return '<b>Wire</b><br><span>click to trace its net</span>'; const n = this.netOfWire(h.i); return `<b>${n ? N.esc(N.fmt.shortNet(B.nets[n])) : 'Wire'}</b> <span class="tip-sub">wire</span>${N.liveTipNet(B, n)}`; }
      if (h.type === 'sheet') return `<b>${N.esc(h.sh.name)}</b><br><span>click to open sheet</span>`;
      return '';
    }
    bind() {
      const cv = this.canvas;
      let drag = null, moved = 0;
      const ptrs = new Map();
      let pinch = 0;
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId);
        ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
        if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
        drag = { x: e.clientX, y: e.clientY }; moved = 0;
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
            pinch = d; moved += 10;
            return;
          }
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          moved += Math.abs(dx) + Math.abs(dy);
          if (moved > 3) { this.view.ox += dx; this.view.oy += dy; this.draw(); this.tip.hidden = true; }
          drag = { x: e.clientX, y: e.clientY };
          return;
        }
        const h = this.hit(sx, sy);
        this.hoverHit = h;
        if (h) {
          this.tip.innerHTML = this.describe(h);
          this.tip.hidden = false;
          this.tip.style.left = Math.min(sx + 14, this.stage.clientWidth - 220) + 'px';
          this.tip.style.top = sy + 16 + 'px';
          cv.style.cursor = 'pointer';
        } else { this.tip.hidden = true; cv.style.cursor = ''; }
      });
      const end = e => {
        const was = ptrs.has(e.pointerId);
        ptrs.delete(e.pointerId);
        if (ptrs.size < 2) pinch = 0;
        if (!was || moved > 3 || e.type !== 'pointerup' || ptrs.size) return;
        const r = cv.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        const h = this.hit(sx, sy);
        cv.focus({ preventScroll: true });
        if (this.probeMode) {
          if (!h) return;
          const at = this.toWorld(sx, sy), page = this.page;
          const net = h.type === 'pin' ? this.B.padNet(h.p.ref, h.p.num) : h.type === 'label' ? Math.max(0, this.B.findNet(h.name)) : h.type === 'wire' ? this.netOfWire(h.i) : 0;
          if (h.type === 'sym') this.emit('probe', { hit: h, at, page, ref: h.it.s.r });
          else if (net) this.emit('probe', { hit: h, at, page, net });
          return;
        }
        if (!h) { this.emit('select', { refs: [], nets: [] }); return; }
        const at = this.toWorld(sx, sy), page = this.page;
        if (h.type === 'sym') this.emit('select', { refs: [h.it.s.r], nets: [] });
        else if (h.type === 'pin') { const n = this.B.padNet(h.p.ref, h.p.num); this.emit('select', { refs: [], nets: n ? [n] : [], hit: h, at, page }); }
        else if (h.type === 'label') { const n = this.B.findNet(h.name); this.emit('select', { refs: [], nets: n > 0 ? [n] : [], label: h.name, hit: h, at, page, net: n > 0 ? n : 0 }); }
        else if (h.type === 'wire') { const n = this.netOfWire(h.i); this.emit('select', { refs: [], nets: n ? [n] : [], hit: h, at, page, net: n }); }
        else if (h.type === 'sheet') { const i = this.sch.pages.findIndex(p => p.file === h.sh.file && p.name === h.sh.name); if (i >= 0) this.showPage(i, true); }
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      cv.addEventListener('pointerleave', () => { this.tip.hidden = true; this.hoverHit = null; });
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0015));
      }, { passive: false });
      // double-click: into the drawn box (a block the designer framed) under the cursor, else closer
      cv.addEventListener('dblclick', e => {
        const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
        const pg = this.sch && this.sch.pages[this.page];
        if (pg) {
          const [x, y] = this.toWorld(sx, sy), W = this.stage.clientWidth, H = this.stage.clientHeight;
          let best = null;
          for (const g of pg.gfx) if (g[0] === 'r') { const x0 = Math.min(g[1], g[3]), x1 = Math.max(g[1], g[3]), y0 = Math.min(g[2], g[4]), y1 = Math.max(g[2], g[4]); if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && (!best || (x1 - x0) * (y1 - y0) < best[4])) best = [x0, y0, x1, y1, (x1 - x0) * (y1 - y0)]; }
          for (const sh of pg.sheets) if (x >= sh.x && x <= sh.x + sh.w && y >= sh.y && y <= sh.y + sh.h) best = null;
          if (best) {
            const m = 3, s1 = Math.min((W - 30) / (best[2] - best[0] + 2 * m), (H - 30) / (best[3] - best[1] + 2 * m));
            if (s1 > this.view.s * 1.25) { this.view.s = s1; this.view.ox = W / 2 - (best[0] + best[2]) / 2 * s1; this.view.oy = H / 2 - (best[1] + best[3]) / 2 * s1; this.draw(); return; }
          }
        }
        this.zoomAt(sx, sy, 2);
      });
      cv.addEventListener('keydown', e => {
        if (e.key === 'Escape' && this.probeMode) { this.emit('probe-tool', false); return; }
        if ((e.key === 'p' || e.key === 'P') && !(N.live && N.live.on)) { e.preventDefault(); this.emit('probe-tool', !this.probeMode); }
        if (e.key === 'f' || e.key === 'F' || e.key === '0') this.fit();
        if (e.key === '+' || e.key === '=') this.zoomAt(this.stage.clientWidth / 2, this.stage.clientHeight / 2, 1.4);
        if (e.key === '-' || e.key === '_') this.zoomAt(this.stage.clientWidth / 2, this.stage.clientHeight / 2, 1 / 1.4);
        if (e.key === 'PageDown' || e.key === ']') this.showPage(this.page + 1, true);
        if (e.key === 'PageUp' || e.key === '[') this.showPage(this.page - 1, true);
        if (e.key === 'Escape') this.emit('select', { refs: [], nets: [] });
      });
    }
    setProbeTool(on) { this.probeMode = !!on; this.canvas.style.cursor = on ? 'crosshair' : ''; this.draw(); }
    destroy() { this.ro.disconnect(); this.root.remove(); }
  }
  N.SchView = SchView;
})();

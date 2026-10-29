/* KiLive — netlist to auto-placed, unrouted PCB (board data in the parse_pcb format + a KiCad 8 .kicad_pcb)
 *
 * N.layoutgen.footprint(fpId, opts) -> local footprint geometry
 * N.layoutgen.generate(circuit, symbols, opts) -> {pcb, kicadPcb, warnings, power}
 *
 * Conventions follow tools/kicad_pcb.py: mm, y down, KiCad angles (CCW on screen), pad angles absolute,
 * pad layer mask bits 1=F.Cu 2=B.Cu 4=inner 8=F.Mask 16=B.Mask. Plain ES2020, no dependencies.
 */
(function (root) {
  'use strict';
  const N = (root.Noeti = root.Noeti || {});

  // ------------------------------------------------------------------------------------------ small helpers
  const R = (v) => (v < 0 ? -1 : 1) * Math.round(Math.abs(v) * 1000) / 1000 + 0; // like the importer's round(v, 3); +0 drops -0
  const GRID = 0.25;
  const snap = (v, g) => Math.round(v / (g || GRID)) * (g || GRID);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function rot(x, y, deg) { // same as N.rot / kicad_pcb.rot
    if (!deg) return [x, y];
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const rx = x * c + y * s, ry = -x * s + y * c;
    return [Math.abs(rx) < 1e-12 ? 0 : rx, Math.abs(ry) < 1e-12 ? 0 : ry];
  }
  const normAngle = (a) => ((Math.round(a) % 360) + 360) % 360;
  const fmt = (v) => { const r = R(v); return Object.is(r, -0) ? '0' : String(r); };
  const natKey = (r) => { const m = /^([A-Za-z_#]*)(\d*)(.*)$/.exec(r || ''); return [m[1], m[2] ? +m[2] : 0, m[3]]; };
  const natCmp = (a, b) => { const x = natKey(a), y = natKey(b); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : (x[1] - y[1]) || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); };
  const pinCmp = (a, b) => { const na = /^\d+$/.test(a), nb = /^\d+$/.test(b); if (na && nb) return +a - +b; if (na !== nb) return na ? -1 : 1; return natCmp(a, b); };

  // deterministic v4-layout uuids (FNV-1a seed + mulberry32)
  function uuidGen(seed) {
    let h = 2166136261;
    for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    let a = h >>> 0;
    const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.floor(rnd() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16); });
  }

  // port of kicad_pcb.convex_hull (same rounding and ordering)
  function convexHull(points) {
    const seen = new Set(), P = [];
    for (const [x, y] of points) {
      const q = [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4];
      const k = q[0] + ',' + q[1];
      if (!seen.has(k)) { seen.add(k); P.push(q); }
    }
    P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (P.length <= 2) return P;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  // port of sexpr.arc_points (start, mid, end -> polyline, 10 degree steps)
  function arcPoints(s, m, e, maxSeg) {
    maxSeg = maxSeg || 10;
    const [x1, y1] = s, [x2, y2] = m, [x3, y3] = e;
    const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
    if (Math.abs(d) < 1e-12) return [s, e];
    const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
    const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
    const r = Math.hypot(x1 - ux, y1 - uy);
    const a1 = Math.atan2(y1 - uy, x1 - ux), a2 = Math.atan2(y2 - uy, x2 - ux), a3 = Math.atan2(y3 - uy, x3 - ux);
    const norm = (a) => { while (a < 0) a += 2 * Math.PI; while (a >= 2 * Math.PI) a -= 2 * Math.PI; return a; };
    const ccw = norm(a3 - a1);
    const sweep = norm(a2 - a1) <= ccw ? ccw : ccw - 2 * Math.PI;
    const n = Math.max(2, Math.floor(Math.abs(sweep * (180 / Math.PI)) / maxSeg) + 1);
    const out = [];
    for (let i = 0; i <= n; i++) out.push([ux + r * Math.cos(a1 + sweep * i / n), uy + r * Math.sin(a1 + sweep * i / n)]);
    return out;
  }

  // ------------------------------------------------------------------------------------------ classify.py port
  const CHIP_H = { '0201': 0.3, '0402': 0.4, '0603': 0.5, '0805': 0.6, '1206': 0.65, '1210': 0.7, '2010': 0.7, '2512': 0.7 };
  const CAP_H = { '0201': 0.3, '0402': 0.5, '0603': 0.8, '0805': 1.0, '1206': 1.2, '1210': 1.5, '2010': 1.5, '2512': 1.8 };
  function classify(fp) {
    const ref = fp.r || '';
    const name = ((fp.fp || '') + ' ' + (fp.m || '')).toLowerCase();
    const val = (fp.v || '').toLowerCase();
    const pre = (/^[A-Za-z_#]*/.exec(ref)[0] || '').toUpperCase();
    const b = fp.b || [0, 0, 0, 0];
    const w = Math.abs(b[2] - b[0]), h = Math.abs(b[3] - b[1]);
    const small = w && h ? Math.min(w, h) : 1;
    const big = w && h ? Math.max(w, h) : 0;
    const has = (s) => name.includes(s);
    const inPre = (...a) => a.includes(pre);
    const m0 = /(?<!\d)(0201|0402|0603|0805|1206|1210|2010|2512)(?!\d)/.exec(name);
    const sc = m0 ? m0[1] : null;
    if (big > 30 && /cm3588|cm4|cm5|compute.?module|som|core.?board/.test(name + ' ' + val)) return ['module', 2.9, '#1c3a52'];
    if (has('shield') || val.includes('shield') || has('rf-can')) return ['frame', 2.2, '#c3c7cc'];
    const noneKw = ['mountinghole', 'mounting_hole', 'fiducial', 'logo', 'testpoint', 'test_point', 'tp_', 'nettie', 'net_tie',
      'solderjumper', 'solder_jumper', 'jumper_sm', 'hole', 'oshw', 'kibuzzard', 'symbol_', 'graphic', 'tag-connect',
      'tagconnect', 'tc2030', 'tc2050', 'pad_', 'mousebites', 'label', 'qr', 'jlc', 'version'];
    if (fp.bo || noneKw.some(has) || inPre('H', 'MH', 'FID', 'LOGO', 'TP', 'JP', 'NT', 'G', 'REF**', 'KB', 'MK')) return ['none', 0, null];
    if (inPre('R', 'RN', 'RA') || name.startsWith('r_') || has(' r_')) {
      if (has('array') || inPre('RN', 'RA')) return ['res', 0.5, '#1a1a1a'];
      return ['res', CHIP_H[sc] != null ? CHIP_H[sc] : 0.55, '#1c1c1e'];
    }
    if (inPre('C') || name.startsWith('c_') || has('cp_elec') || has('cp_radial')) {
      let m = /cp_elec_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/.exec(name);
      if (m) return ['elco', parseFloat(m[2]), '#b7bcc4'];
      m = /cp_radial_d(\d+(?:\.\d+)?)mm/.exec(name);
      if (m) return ['elco', 11.0, '#1d2a4a'];
      if (has('tantal') || has('cp_')) return ['tant', 1.6, '#c6962c'];
      return ['cap', CAP_H[sc] != null ? CAP_H[sc] : Math.min(1.2, Math.max(0.5, small * 0.6)), '#b88a5a'];
    }
    if (inPre('L', 'FB', 'FL')) {
      if (pre === 'FB' || has('ferrite') || has('bead')) return ['ind', CHIP_H[sc] != null ? CHIP_H[sc] : 0.6, '#3a3a3c'];
      return ['ind', !sc ? Math.min(4.5, Math.max(0.8, small * 0.55)) : (CAP_H[sc] != null ? CAP_H[sc] : 0.8), '#343436'];
    }
    if (inPre('LED', 'D') && (has('led') || pre === 'LED')) return ['led', sc ? 0.55 : 1.0, '#f2efe4'];
    if (inPre('D', 'TVS', 'Z', 'ZD')) return ['diode', has('sod-323') || has('sod-523') || sc ? 0.9 : 1.1, '#1b1b1d'];
    if (inPre('Y', 'X', 'XTAL', 'OSC') || has('crystal') || has('oscillator')) {
      if (has('hc49') || has('hc-49')) return ['xtal', 3.5, '#c9ccd1'];
      if (has('mc306') || has('fc-135') || has('2012') || has('3215')) return ['xtal', 0.8, '#2b2b2d'];
      return ['xtal', 0.9, '#c7cacf'];
    }
    if (inPre('SW', 'S', 'BTN', 'KEY') || has('button') || has('switch') || has('sw_')) {
      if (has('kailh') || has('mx') || has('choc') || has('hotswap')) return ['switch', 3.0, '#e8e3d6'];
      if (has('slide') || has('spdt')) return ['switch', 1.6, '#c9ccd1'];
      return ['switch', Math.min(3.5, Math.max(1.0, small * 0.5)), '#2a2a2c'];
    }
    if (inPre('J', 'P', 'CN', 'CON', 'USB', 'X') || has('connector') || has('conn') || has('usb') || has('header') || has('socket')) {
      if (has('usb_c') || has('usb-c') || has('type-c') || has('typec')) return ['metal', 3.2, '#c3c7cc'];
      if (has('usb_a') || has('usb-a')) return ['metal', 7.0, '#c3c7cc'];
      if (has('micro') && has('usb')) return ['metal', 2.6, '#c3c7cc'];
      if (has('rj45') || has('ethernet')) return ['metal', 13.0, '#c3c7cc'];
      if (has('sma') && !has('u.fl')) return ['gold', 6.0, '#d4a64a'];
      if ((has('u.fl') || has('ufl') || has('ipex') || has('mhf')) && big < 5) return ['gold', 1.2, '#d9b25c'];
      if (has('ipex') || has('20455') || has('20453')) return ['metal', 1.1, '#aeb3b9'];
      if (has('m.2') || has('m2_') || has('ngff')) return ['plastic', 4.2, '#1f1f22'];
      if (has('sodimm') || has('dimm')) return ['plastic', 5.2, '#1f1f22'];
      if (has('sd') && (has('card') || has('micro'))) return ['metal', 1.9, '#c3c7cc'];
      if (has('pinheader') || has('pin_header') || has('pinsocket') || has('pin_socket')) {
        if (has('socket')) return ['plastic', 8.5, '#1d1d20'];
        return ['header', 2.5, '#1d1d20'];
      }
      if (has('jst') || has('molex') || has('picoblade') || has('pico') || has('ph_') || has('sh_') || has('zh_')) return ['plastic', !has('sh_') ? 4.0 : 2.9, '#efe7d4'];
      if (has('fpc') || has('ffc') || has('hirose_fh') || has('fh12') || has('fh19')) return ['plastic', 1.2, '#2a2a2c'];
      if (has('audio') || has('jack') || has('pj-')) return ['plastic', 5.0, '#1d1d20'];
      if (has('b2b') || has('board_to_board') || has('df40') || has('bm')) return ['plastic', 1.5, '#e6dcc3'];
      if (has('barrel') || has('dc_')) return ['plastic', 11.0, '#1d1d20'];
      if (has('terminal')) return ['plastic', 10.0, '#2f6f3f'];
      return ['plastic', Math.min(6.0, Math.max(1.2, small * 0.5)), '#2a2a2c'];
    }
    if (inPre('BT', 'BAT') || has('battery') || has('cr2032')) return ['metal', 3.2, '#c3c7cc'];
    if (inPre('F') || has('fuse') || has('polyfuse')) return ['ind', CHIP_H[sc] != null ? CHIP_H[sc] : 0.8, '#6b6f75'];
    if (inPre('Q') || has('sot') || has('to-252') || has('dpak')) {
      if (has('to-252') || has('dpak') || has('to-263')) return ['ic', 2.3, '#1b1b1d'];
      return ['ic', 1.0, '#1b1b1d'];
    }
    if (inPre('BZ', 'LS', 'SP', 'BUZ') || has('buzzer') || has('speaker')) return ['plastic', 3.0, '#1d1d20'];
    if (inPre('ANT', 'AE') || has('antenna')) return ['plastic', 0.8, '#e7e7e7'];
    if (has('shield') || inPre('SH', 'SC')) return ['metal', 1.8, '#c3c7cc'];
    if (has('module') || has('esp32-') || has('wroom') || has('wrover') || has('som') || has('core')) return ['module', 3.0, '#23272e'];
    if (inPre('U', 'IC', 'M', 'MOD', 'Z', 'VR', 'REG', 'A', 'PS', 'N') || /qfn|qfp|bga|soic|ssop|tssop|msop|dfn|lga|wlcsp|csp|son|sop|qfp|plcc|lqfp|tqfp|vqfn|wson|uson|xson/.test(name)) {
      if (has('bga') || has('fbga')) return ['ic', 1.2, '#1b1b1d'];
      if (has('wlcsp') || has('csp')) return ['ic', 0.5, '#2a2c30'];
      if (has('qfp') || has('soic') || (has('sop') && !has('ssop') && !has('tssop'))) return ['ic', 1.5, '#1b1b1d'];
      if (has('tssop') || has('ssop') || has('msop')) return ['ic', 1.1, '#1b1b1d'];
      if (has('qfn') || has('dfn') || has('son') || has('lga')) return ['ic', 0.85, '#1b1b1d'];
      return ['ic', 1.0, '#1b1b1d'];
    }
    if (inPre('T', 'TR')) return ['ind', 3.0, '#343436'];
    if (inPre('K', 'RL', 'RLY')) return ['plastic', 10.0, '#1d1d20'];
    if (inPre('RV', 'VR', 'POT')) return ['plastic', 4.0, '#1d1d20'];
    if (inPre('MIC')) return ['metal', 1.1, '#c3c7cc'];
    return ['ic', Math.min(2.0, Math.max(0.6, small * 0.3)), '#232326'];
  }

  // ------------------------------------------------------------------------------------------ footprint library
  // All geometry in footprint-local coordinates, sized after the KiCad 8 standard libraries (IPC-7351 nominal).
  const SILK_W = 0.12, FAB_W = 0.1, CRT_W = 0.05, SILK_CL = 0.15; // silk edge to pad edge >= 0.15 mm
  const MODEL_DIR = '${KICAD8_3DMODEL_DIR}';

  function newFp(lib, name) {
    return { id: lib ? lib + ':' + name : name, lib: lib || '', name, kind: 'smd', attr: 'smd', family: '', pads: [], body: null, courtyard: null,
      silk: [], silkCircles: [], fab: [], fabCircles: [], crtCircle: null, pin1: null, placeholder: false, descr: '', tags: '', model: true };
  }
  function P(num, type, shape, x, y, w, h, extra) {
    return Object.assign({ num: String(num), type, shape, x, y, w, h, angle: 0, rr: 0.25 }, extra || {});
  }
  const smdP = (num, x, y, w, h) => P(num, 'smd', 'roundrect', x, y, w, h);
  const thP = (num, x, y, w, h, drill, shape) => P(num, 'thru_hole', shape || (num === '1' || num === 1 ? 'rect' : 'circle'), x, y, w, h, { drill });
  const rectSegs = (b) => [[b[0], b[1], b[2], b[1]], [b[2], b[1], b[2], b[3]], [b[2], b[3], b[0], b[3]], [b[0], b[3], b[0], b[1]]];
  const polySegs = (pts, closed) => { const o = []; for (let i = 0; i + 1 < pts.length; i++) o.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]); if (closed && pts.length > 2) o.push([pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]]); return o; };
  const grow = (b, d) => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
  const union = (a, b) => (!a ? b.slice() : !b ? a.slice() : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  const r2 = (v) => (v < 0 ? -1 : 1) * Math.round(Math.abs(v) * 100) / 100 + 0;
  // pad bounding box in local coordinates (pads here only use local angles 0/90)
  function padBox(p, extra) {
    const e = extra || 0;
    const sw = normAngle(p.angle) % 180 === 90;
    const hw = (sw ? p.h : p.w) / 2 + e, hh = (sw ? p.w : p.h) / 2 + e;
    return [p.x - hw, p.y - hh, p.x + hw, p.y + hh];
  }
  function padsBox(g) { let b = null; for (const p of g.pads) b = union(b, padBox(p)); return b; }
  function chamferRect(b, c) { return polySegs([[b[0] + c, b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1] + c]], true); }

  // Liang-Barsky: parameter interval of segment inside rect
  function segInRect(s, r) {
    let t0 = 0, t1 = 1;
    const dx = s[2] - s[0], dy = s[3] - s[1];
    const pq = [[-dx, s[0] - r[0]], [dx, r[2] - s[0]], [-dy, s[1] - r[1]], [dy, r[3] - s[1]]];
    for (const [p, q] of pq) {
      if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    return t1 - t0 > 1e-9 ? [t0, t1] : null;
  }
  function clipSeg(s, rects, minLen) {
    let iv = [[0, 1]];
    for (const r of rects) {
      const cut = segInRect(s, r);
      if (!cut) continue;
      const next = [];
      for (const [a, b] of iv) {
        if (cut[1] <= a || cut[0] >= b) { next.push([a, b]); continue; }
        if (cut[0] > a) next.push([a, cut[0]]);
        if (cut[1] < b) next.push([cut[1], b]);
      }
      iv = next;
    }
    const L = Math.hypot(s[2] - s[0], s[3] - s[1]);
    const whole = iv.length === 1 && iv[0][0] === 0 && iv[0][1] === 1;
    return iv.filter(([a, b]) => whole || (b - a) * L >= minLen).map(([a, b]) => [s[0] + (s[2] - s[0]) * a, s[1] + (s[3] - s[1]) * a, s[0] + (s[2] - s[0]) * b, s[1] + (s[3] - s[1]) * b]);
  }
  function circleHitsRect(c, r) {
    const x = clamp(c[0], r[0], r[2]), y = clamp(c[1], r[1], r[3]);
    return Math.hypot(c[0] - x, c[1] - y) < c[2] + SILK_W / 2;
  }
  // silk never touches pads; courtyard always contains pads and body
  function finish(g) {
    const keep = g.pads.map((p) => padBox(p, SILK_CL + SILK_W / 2));
    const out = [];
    for (const s of g.silk) out.push(...clipSeg(s, keep, 0.3));
    g.silk = out.map((s) => s.map(r2));
    const keepC = g.pads.map((p) => padBox(p, SILK_CL));
    g.silkCircles = g.silkCircles.filter((c) => !keepC.some((k) => circleHitsRect(c, k)));
    if (!g.body) g.body = padsBox(g);
    const need = union(g.body, padsBox(g));
    g.courtyard = g.courtyard ? union(g.courtyard, grow(need, 0.1)) : grow(need, 0.25);
    for (const c of g.silkCircles) g.courtyard = union(g.courtyard, grow([c[0] - c[2], c[1] - c[2], c[0] + c[2], c[1] + c[2]], 0.05));
    g.courtyard = g.courtyard.map(r2);
    g.body = g.body.map(R);
    for (const p of g.pads) { p.x = R(p.x); p.y = R(p.y); p.w = R(p.w); p.h = R(p.h); }
    g.fab = g.fab.map((s) => s.map(R));
    if (!g.pin1) { const p1 = g.pads.find((p) => p.num === '1') || g.pads[0]; g.pin1 = p1 ? [p1.x, p1.y] : [0, 0]; }
    if (g.pads.some((p) => p.type === 'thru_hole' || p.type === 'np_thru_hole')) { g.kind = 'th'; if (g.attr === 'smd') g.attr = 'through_hole'; }
    return g;
  }

  // ---- 2-terminal chips (R, C, L, LED, Fuse, D)
  const CHIP = {
    '01005': { px: 0.2, pw: 0.22, ph: 0.25, bw: 0.4, bh: 0.2 },
    '0201': { px: 0.32, pw: 0.46, ph: 0.4, bw: 0.6, bh: 0.3 },
    '0402': { px: 0.51, pw: 0.54, ph: 0.64, bw: 1.0, bh: 0.5 },
    '0603': { px: 0.825, pw: 0.8, ph: 0.95, bw: 1.6, bh: 0.8 },
    '0805': { px: 0.9125, pw: 1.025, ph: 1.4, bw: 2.0, bh: 1.25 },
    '1206': { px: 1.4625, pw: 1.125, ph: 1.75, bw: 3.2, bh: 1.6 },
    '1210': { px: 1.4625, pw: 1.125, ph: 2.65, bw: 3.2, bh: 2.5 },
    '1812': { px: 2.1, pw: 1.3, ph: 3.4, bw: 4.5, bh: 3.2 },
    '2010': { px: 2.3, pw: 1.25, ph: 2.65, bw: 5.0, bh: 2.5 },
    '2220': { px: 2.6, pw: 1.5, ph: 5.2, bw: 5.7, bh: 5.0 },
    '2512': { px: 2.9, pw: 1.4, ph: 3.35, bw: 6.3, bh: 3.2 },
  };
  const CHIP_C = { '0201': { px: 0.32, pw: 0.46, ph: 0.4 }, '0402': { px: 0.48, pw: 0.56, ph: 0.62 }, '0603': { px: 0.775, pw: 0.9, ph: 0.95 },
    '0805': { px: 0.95, pw: 1.0, ph: 1.45 }, '1206': { px: 1.475, pw: 1.15, ph: 1.8 }, '1210': { px: 1.475, pw: 1.15, ph: 2.7 } };
  const CHIP_LED = { '0402': { px: 0.485, pw: 0.59, ph: 0.64 }, '0603': { px: 0.7875, pw: 0.875, ph: 0.95 }, '0805': { px: 0.9375, pw: 0.975, ph: 1.4 },
    '1206': { px: 1.4, pw: 1.25, ph: 1.8 }, '1210': { px: 1.4, pw: 1.25, ph: 2.7 } };
  const METRIC = { '01005': '0402', '0201': '0603', '0402': '1005', '0603': '1608', '0805': '2012', '1206': '3216', '1210': '3225', '1812': '4532', '2010': '5025', '2220': '5750', '2512': '6332' };
  const CHIP_WORD = { R: 'Resistor', C: 'Capacitor', L: 'Inductor', LED: 'LED', Fuse: 'Fuse', D: 'Diode' };

  // generic polarised or plain 2-terminal SMD body: pads at +-px along x, pad 1 left
  function twoTerminal(g, d, polar) {
    const { px, pw, ph, bw, bh } = d;
    g.pads.push(smdP('1', -px, 0, pw, ph), smdP('2', px, 0, pw, ph));
    g.body = [-bw / 2, -bh / 2, bw / 2, bh / 2];
    const tiny = px + pw / 2 < 1.0;
    const m = tiny ? 0.15 : 0.25;
    g.courtyard = [-(px + pw / 2 + m), -(Math.max(ph, bh) / 2 + m), px + pw / 2 + m, Math.max(ph, bh) / 2 + m].map(r2);
    const yl = Math.max(bh / 2 + 0.11, ph / 2 + 0.25);
    if (polar) {
      const xb = -(px + pw / 2 + 0.25);
      const xe = Math.max(bw / 2, px - pw / 2);
      g.silk.push([xb, -yl, xe, -yl], [xb, yl, xe, yl], [xb, -yl, xb, yl]);
      g.courtyard[0] = Math.min(g.courtyard[0], r2(xb - 0.12));
      g.courtyard[1] = Math.min(g.courtyard[1], -r2(yl + 0.1)); g.courtyard[3] = Math.max(g.courtyard[3], r2(yl + 0.1));
      g.pin1 = [xb, 0];
      const cb = -bw / 2 + Math.min(0.35, bw * 0.2);
      g.fab.push([cb, -bh / 2, cb, bh / 2]);
    } else if (!tiny) {
      const xi = px - pw / 2 - SILK_CL - SILK_W / 2 - 0.01;
      if (xi >= 0.1) { g.silk.push([-xi, -yl, xi, -yl], [-xi, yl, xi, yl]); g.courtyard[1] = Math.min(g.courtyard[1], -r2(yl + 0.1)); g.courtyard[3] = Math.max(g.courtyard[3], r2(yl + 0.1)); }
    }
    g.fab.push(...rectSegs(g.body));
    g.family = 'chip2';
  }

  function chipFp(lib, name, pref, size) {
    const g = newFp(lib, name);
    const d = Object.assign({}, CHIP[size], (pref === 'C' ? CHIP_C[size] : (pref === 'LED' || pref === 'L') ? CHIP_LED[size] : null) || {});
    twoTerminal(g, d, pref === 'LED' || pref === 'D');
    g.descr = (CHIP_WORD[pref] || pref) + ' SMD ' + size + ' (' + METRIC[size] + ' Metric), square (rectangular) end terminal, IPC_7351 nominal';
    g.tags = (CHIP_WORD[pref] || pref).toLowerCase();
    return finish(g);
  }

  // ---- diodes / tantalum / electrolytic
  const DIODE = {
    'SOD-123': { px: 1.65, pw: 0.9, ph: 1.2, bw: 2.8, bh: 1.8, d: 'SOD-123' },
    'SOD-123F': { px: 1.4, pw: 1.1, ph: 1.1, bw: 2.8, bh: 1.8, d: 'SOD-123F' },
    'SOD-323': { px: 1.05, pw: 0.6, ph: 0.45, bw: 1.7, bh: 1.3, d: 'SOD-323' },
    'SOD-523': { px: 0.7, pw: 0.6, ph: 0.7, bw: 1.2, bh: 0.8, d: 'SOD-523' },
    SMA: { px: 2.0, pw: 2.5, ph: 1.8, bw: 4.3, bh: 2.6, d: 'Diode SMA (DO-214AC)' },
    SMB: { px: 2.15, pw: 2.5, ph: 2.3, bw: 4.3, bh: 3.6, d: 'Diode SMB (DO-214AA)' },
    SMC: { px: 3.4, pw: 2.5, ph: 3.3, bw: 6.9, bh: 5.9, d: 'Diode SMC (DO-214AB)' },
    MiniMELF: { px: 1.75, pw: 1.3, ph: 1.7, bw: 3.5, bh: 1.6, d: 'Diode Mini-MELF (SOD-80)' },
    MELF: { px: 2.4, pw: 1.5, ph: 2.6, bw: 5.0, bh: 2.5, d: 'Diode MELF (SOD-106)' },
  };
  const TANT = { '3216': { px: 1.4, pw: 1.6, ph: 1.35, bw: 3.2, bh: 1.6 }, '3528': { px: 1.5375, pw: 1.625, ph: 2.35, bw: 3.5, bh: 2.8 },
    '6032': { px: 2.55, pw: 2.25, ph: 2.35, bw: 6.0, bh: 3.2 }, '7343': { px: 3.1, pw: 2.25, ph: 2.55, bw: 7.3, bh: 4.3 } };

  function elcoFp(lib, name, D, H) {
    const g = newFp(lib, name);
    const px = r2(D * 0.44), pw = r2(0.3 * D + 1.5), ph = D < 8 ? 1.6 : 2.5, s = D + 0.3;
    g.pads.push(smdP('1', -px, 0, pw, ph), smdP('2', px, 0, pw, ph));
    g.body = [-s / 2, -s / 2, s / 2, s / 2];
    const c = D * 0.25;
    g.fab.push(...chamferRect(g.body, c)); g.fabCircles.push([0, 0, D / 2]);
    g.silk.push(...chamferRect(grow(g.body, 0.11), c + 0.05));
    g.courtyard = [-(px + pw / 2 + 0.25), -(s / 2 + 0.25), px + pw / 2 + 0.25, s / 2 + 0.25];
    g.pin1 = [-(s / 2) - 0.11, -(s / 2) + c];
    g.descr = 'SMD capacitor, aluminum electrolytic, ' + D + 'x' + H + 'mm'; g.tags = 'capacitor electrolytic'; g.family = 'elco';
    return finish(g);
  }

  // ---- axial THT (resistors, DO-35, DO-41)
  function axialFp(lib, name, L, Dd, pitch, drill, isDiode) {
    const g = newFp(lib, name);
    const pd = r2(drill * 2);
    g.pads.push(P('1', 'thru_hole', isDiode ? 'rect' : 'circle', 0, 0, pd, pd, { drill }), P('2', 'thru_hole', isDiode ? 'oval' : 'circle', pitch, 0, pd, pd, { drill }));
    const x0 = (pitch - L) / 2, x1 = (pitch + L) / 2;
    g.body = [x0, -Dd / 2, x1, Dd / 2];
    g.fab.push(...rectSegs(g.body), [0, 0, x0, 0], [pitch, 0, x1, 0]);
    g.silk.push(...rectSegs(grow(g.body, 0.12)), [pd / 2 + 0.3, 0, x0 - 0.12, 0], [pitch - pd / 2 - 0.3, 0, x1 + 0.12, 0]);
    if (isDiode) { const xb = x0 + L * 0.15; g.fab.push([xb, -Dd / 2, xb, Dd / 2]); g.silk.push([xb, -Dd / 2 - 0.12, xb, Dd / 2 + 0.12], [xb + 0.15, -Dd / 2 - 0.12, xb + 0.15, Dd / 2 + 0.12]); }
    g.courtyard = [-pd / 2 - 0.25, -Math.max(Dd, pd) / 2 - 0.25, pitch + pd / 2 + 0.25, Math.max(Dd, pd) / 2 + 0.25];
    g.descr = (isDiode ? 'Diode' : 'Resistor') + ', axial, length ' + L + 'mm, diameter ' + Dd + 'mm, pitch ' + pitch + 'mm, horizontal';
    g.tags = isDiode ? 'diode axial' : 'resistor axial'; g.family = 'axial';
    return finish(g);
  }

  // ---- SOT / TO packages
  function sidePins(g, nums, x, pitch, w, h, topDown) {
    const n = nums.length;
    nums.forEach((num, i) => { const k = topDown ? i : n - 1 - i; g.pads.push(smdP(num, x, (k - (n - 1) / 2) * pitch, w, h)); });
  }
  // KiCad style: body outline top/bottom lines plus a pin-1 extension at the top left
  function sotSilk(g, x1Pad) {
    const b = grow(g.body, 0.11);
    g.silk.push(...rectSegs(b));
    g.silk.push([b[0], b[1], x1Pad, b[1]]);
    g.pin1 = [x1Pad, b[1]];
  }
  // filled silk dot just outside pad 1, on the side the pad points to
  function pin1Dot(g) {
    const p = g.pads.find((q) => q.num === '1');
    if (!p) return;
    const bb = padBox(p), r = 0.15, gap = SILK_CL + SILK_W / 2 + r + 0.02;
    const b = g.body, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    const nx = (p.x - cx) / Math.max(0.3, (b[2] - b[0]) / 2), ny = (p.y - cy) / Math.max(0.3, (b[3] - b[1]) / 2);
    const dot = Math.abs(nx) >= Math.abs(ny) ? [nx < 0 ? bb[0] - gap : bb[2] + gap, p.y, r] : [p.x, ny < 0 ? bb[1] - gap : bb[3] + gap, r];
    g.silkCircles.push(dot.map(r2));
    g.pin1 = [dot[0], dot[1]];
  }
  function sotFp(lib, name, kind) {
    const g = newFp(lib, name);
    let d = '';
    if (kind === 'SOT-23') {
      g.pads.push(smdP('1', -0.9375, -0.95, 1.475, 0.6), smdP('2', -0.9375, 0.95, 1.475, 0.6), smdP('3', 0.9375, 0, 1.475, 0.6));
      g.body = [-0.65, -1.45, 0.65, 1.45]; g.courtyard = [-1.92, -1.7, 1.92, 1.7]; d = 'SOT, 3 Pin (JEDEC TO-236)'; sotSilk(g, -1.675);
    } else if (/^(T?SOT-23)-(5|6|8)$/.test(kind)) {
      const n = +kind.slice(-1);
      const pitch = n === 8 ? 0.65 : 0.95, h = n === 8 ? 0.42 : 0.6;
      const left = [], right = [];
      for (let i = 1; i <= Math.ceil(n / 2); i++) left.push(String(i));
      for (let i = Math.ceil(n / 2) + 1; i <= n; i++) right.push(String(i));
      sidePins(g, left, -1.1375, pitch, 1.325, h, true);
      if (n === 5) { g.pads.push(smdP('4', 1.1375, 0.95, 1.325, 0.6), smdP('5', 1.1375, -0.95, 1.325, 0.6)); } else sidePins(g, right, 1.1375, pitch, 1.325, h, false);
      g.body = [-0.8, -1.45, 0.8, 1.45]; g.courtyard = [-2.05, -1.7, 2.05, 1.7]; d = kind.replace('T', 'Thin ') + ', ' + n + ' Pin'; sotSilk(g, -1.8);
    } else if (kind === 'SOT-323' || kind === 'SOT-353' || kind === 'SOT-363') {
      if (kind === 'SOT-323') g.pads.push(smdP('1', -0.9, -0.65, 0.9, 0.4), smdP('2', -0.9, 0.65, 0.9, 0.4), smdP('3', 0.9, 0, 0.9, 0.4));
      else if (kind === 'SOT-353') { sidePins(g, ['1', '2', '3'], -0.9, 0.65, 0.9, 0.4, true); g.pads.push(smdP('4', 0.9, 0.65, 0.9, 0.4), smdP('5', 0.9, -0.65, 0.9, 0.4)); }
      else { sidePins(g, ['1', '2', '3'], -0.9, 0.65, 0.9, 0.4, true); sidePins(g, ['4', '5', '6'], 0.9, 0.65, 0.9, 0.4, false); }
      g.body = [-0.625, -1.0, 0.625, 1.0]; g.courtyard = [-1.7, -1.28, 1.7, 1.28]; d = kind + ' (SC-70)'; sotSilk(g, -1.35);
    } else if (kind === 'SOT-223') {
      sidePins(g, ['1', '2', '3'], -3.15, 2.3, 2.0, 1.5, true);
      g.pads.push(smdP('2', 3.15, 0, 2.0, 3.8));
      g.body = [-1.75, -3.25, 1.75, 3.25]; g.courtyard = [-4.4, -3.6, 4.4, 3.6]; d = 'module CMS SOT223 4 pins'; sotSilk(g, -4.15);
    } else if (kind === 'SOT-89') {
      sidePins(g, ['1', '2', '3'], -1.65, 1.5, 1.4, 0.9, true);
      g.pads.push(smdP('2', 0.55, 0, 2.2, 2.0));
      g.body = [-0.9, -2.25, 1.6, 2.25]; g.courtyard = [-2.6, -2.5, 2.1, 2.5]; d = 'SOT-89-3'; sotSilk(g, -2.35);
    } else if (kind === 'TO-252-2') {
      g.pads.push(smdP('1', -4.2, -2.28, 2.2, 1.2), smdP('3', -4.2, 2.28, 2.2, 1.2), smdP('2', 2.1, 0, 6.4, 5.8));
      g.body = [-2.7, -3.25, 3.4, 3.25]; g.courtyard = [-5.55, -3.55, 5.55, 3.55]; d = 'TO-252 / DPAK SMD package'; sotSilk(g, -5.3);
    } else if (kind === 'TO-263-2' || kind === 'TO-263-5') {
      if (kind === 'TO-263-2') g.pads.push(smdP('1', -5.8, -2.54, 4.2, 1.05), smdP('3', -5.8, 2.54, 4.2, 1.05));
      else sidePins(g, ['1', '2', '3', '4', '5'], -5.8, 1.7, 4.2, 0.8, true);
      g.pads.push(smdP(kind === 'TO-263-2' ? '2' : '3', 3.3, 0, 9.4, 10.8));
      g.body = [-4.1, -5.1, 5.1, 5.1]; g.courtyard = [-8.15, -5.65, 8.25, 5.65]; d = 'TO-263 / D2PAK SMD package'; sotSilk(g, -7.9);
    }
    g.fab.push(...chamferRect(g.body, Math.min(0.5, (g.body[2] - g.body[0]) * 0.3)));
    pin1Dot(g);
    g.descr = d; g.tags = kind; g.family = /^TO-2/.test(kind) || kind === 'SOT-223' ? 'power' : 'sot';
    return finish(g);
  }

  function toThtFp(lib, name, kind) {
    const g = newFp(lib, name);
    if (kind === 'TO-92') {
      [0, 1.27, 2.54].forEach((x, i) => g.pads.push(P(String(i + 1), 'thru_hole', i ? 'oval' : 'rect', x, 0, 1.05, 1.5, { drill: 0.75 })));
      g.body = [-1.23, -2.5, 3.77, 1.85];
      const arc = arcPoints([-0.53, 1.85], [1.27, -2.5], [3.07, 1.85], 20);
      g.fab.push([-0.53, 1.85, 3.07, 1.85], ...polySegs(arc));
      const arcS = arcPoints([-0.63, 1.96], [1.27, -2.62], [3.17, 1.96], 20);
      g.silk.push([-0.63, 1.96, 3.17, 1.96], ...polySegs(arcS));
      g.courtyard = [-1.53, -2.73, 4.07, 2.01]; g.descr = 'TO-92 leads in-line, narrow, oval pads, drill 0.75mm'; g.pin1 = [-0.63, 1.96];
    } else {
      const five = kind === 'TO-220-5';
      const xs = five ? [0, 1.7, 3.4, 5.1, 6.8] : [0, 2.54, 5.08];
      xs.forEach((x, i) => g.pads.push(P(String(i + 1), 'thru_hole', i ? 'oval' : 'rect', x, 0, five ? 1.5 : 1.905, 2.0, { drill: five ? 1.0 : 1.1 })));
      const cx = xs[xs.length - 1] / 2;
      g.body = [cx - 5, -3.19, cx + 5, 1.25];
      g.fab.push(...rectSegs(g.body), [g.body[0], -1.88, g.body[2], -1.88]);
      const sb = grow(g.body, 0.12);
      g.silk.push(...rectSegs(sb), [sb[0], -1.88, sb[2], -1.88], [cx - 0.7, -3.31, cx - 0.7, -1.88], [cx + 0.7, -3.31, cx + 0.7, -1.88]);
      g.courtyard = [g.body[0] - 0.25, -3.44, g.body[2] + 0.25, 1.51]; g.descr = kind + ', vertical, RM ' + (five ? '1.7' : '2.54') + 'mm'; g.pin1 = [0, 0];
    }
    g.kind = 'th'; g.attr = 'through_hole'; g.tags = kind; g.family = 'tht';
    return finish(g);
  }

  // ---- gull-wing dual rows: SOIC / SO / TSSOP / MSOP / SSOP
  const LEAD_SPAN = { SOIC: { 3.9: 6.0, 5.3: 7.9, 7.5: 10.3 }, SO: { 3.9: 6.0, 5.3: 7.9, 7.5: 10.3 }, TSSOP: { 3: 4.9, 4.4: 6.4, 6.1: 8.1 },
    MSOP: { 3: 4.9 }, VSSOP: { 3: 4.9, 2: 3.1 }, SSOP: { 3.9: 6.0, 4.4: 6.4, 5.3: 7.8, 7.5: 10.3 } };
  const padH = (pitch) => pitch >= 1.2 ? 0.6 : pitch >= 0.95 ? 0.55 : pitch >= 0.75 ? 0.5 : pitch >= 0.6 ? 0.4 : pitch >= 0.45 ? 0.3 : 0.25;
  function gullWing(lib, name, fam, n, W, L, pitch, ep) {
    const g = newFp(lib, name);
    const base = fam.replace(/^H/, '');
    const E = (LEAD_SPAN[base] && LEAD_SPAN[base][W]) || (W + (pitch >= 1.2 ? 2.2 : 2.0));
    const pw = pitch >= 1.2 ? (W > 5 ? 2.0 : 1.95) : pitch >= 0.6 ? 1.475 : 1.4;
    const ph = padH(pitch);
    const toe = pitch >= 1.2 ? 0.45 : 0.4;
    const x = r2(E / 2 + toe - pw / 2);
    const k = n / 2;
    for (let i = 0; i < k; i++) g.pads.push(smdP(String(i + 1), -x, R((i - (k - 1) / 2) * pitch), pw, ph));
    for (let i = 0; i < k; i++) g.pads.push(smdP(String(n - i), x, R((i - (k - 1) / 2) * pitch), pw, ph));
    if (ep) g.pads.push(P(String(n + 1), 'smd', 'rect', 0, 0, ep[0], ep[1]));
    g.body = [-W / 2, -L / 2, W / 2, L / 2];
    const extY = (k - 1) / 2 * pitch + ph / 2;
    g.courtyard = [-(x + pw / 2 + 0.25), -(Math.max(L / 2, extY) + 0.25), x + pw / 2 + 0.25, Math.max(L / 2, extY) + 0.25].map(r2);
    g.fab.push(...chamferRect(g.body, Math.min(1, W * 0.25)));
    const sb = grow(g.body, 0.11);
    g.silk.push(...rectSegs(sb));
    if (sb[1] < -extY - SILK_CL - 0.06) g.silk.push([sb[0], sb[1], -(x + pw / 2), sb[1]]);
    pin1Dot(g);
    g.descr = fam + ', ' + n + ' Pin, body ' + W + 'x' + L + 'mm, pitch ' + pitch + 'mm' + (ep ? ', exposed pad' : '');
    g.tags = fam + ' ' + pitch; g.family = 'gullwing';
    return finish(g);
  }

  function dipFp(lib, name, n, W) {
    const g = newFp(lib, name);
    const k = n / 2, pd = 1.6, dr = 0.8;
    for (let i = 0; i < k; i++) g.pads.push(P(String(i + 1), 'thru_hole', i ? 'oval' : 'rect', 0, R(i * 2.54), pd, pd, { drill: dr }));
    for (let i = 0; i < k; i++) g.pads.push(P(String(n - i), 'thru_hole', 'oval', W, R(i * 2.54), pd, pd, { drill: dr }));
    const yb = (k - 1) * 2.54;
    g.body = [0.635, -1.27, W - 0.635, yb + 1.27];
    g.fab.push(...chamferRect(g.body, 1));
    const sx0 = 1.16, sx1 = W - 1.16, sy0 = -1.33, sy1 = yb + 1.33, cx = W / 2;
    const notch = arcPoints([cx - 1, sy0], [cx, sy0 + 1], [cx + 1, sy0], 30);
    g.silk.push([sx0, sy0, cx - 1, sy0], [cx + 1, sy0, sx1, sy0], [sx1, sy0, sx1, sy1], [sx1, sy1, sx0, sy1], [sx0, sy1, sx0, sy0], ...polySegs(notch));
    g.courtyard = [-1.1, -1.55, W + 1.1, yb + 1.55];
    g.pin1 = [cx, sy0 + 1];
    g.kind = 'th'; g.attr = 'through_hole';
    g.descr = n + '-lead though-hole mounted DIP package, row spacing ' + W + 'mm'; g.tags = 'THT DIP DIL PDIP 2.54mm ' + W + 'mm'; g.family = 'dip';
    return finish(g);
  }

  // four-sided (QFP) or QFN/DFN leadless; pins counter-clockwise from the top of the left side
  function quadPads(g, n, sideCounts, pos, pitch, w, h) {
    let num = 1;
    const [nl, nb, nr, nt] = sideCounts;
    for (let i = 0; i < nl && num <= n; i++) g.pads.push(smdP(String(num++), -pos, R((i - (nl - 1) / 2) * pitch), w, h));
    for (let i = 0; i < nb && num <= n; i++) g.pads.push(smdP(String(num++), R((i - (nb - 1) / 2) * pitch), pos, h, w));
    for (let i = 0; i < nr && num <= n; i++) g.pads.push(smdP(String(num++), pos, R(((nr - 1) / 2 - i) * pitch), w, h));
    for (let i = 0; i < nt && num <= n; i++) g.pads.push(smdP(String(num++), R(((nt - 1) / 2 - i) * pitch), -pos, h, w));
  }
  function qfpFp(lib, name, fam, n, W, pitch, ep) {
    const g = newFp(lib, name);
    const k = Math.ceil(n / 4), E = W + 2.0, pw = 1.475, ph = padH(pitch);
    const pos = r2(E / 2 + 0.4 - pw / 2);
    quadPads(g, n, [k, k, k, k], pos, pitch, pw, ph);
    if (ep) g.pads.push(P(String(n + 1), 'smd', 'rect', 0, 0, ep[0], ep[1]));
    g.body = [-W / 2, -W / 2, W / 2, W / 2];
    const c = r2(E / 2 + 0.4 + 0.25);
    g.courtyard = [-c, -c, c, c];
    g.fab.push(...chamferRect(g.body, 1));
    const sb = grow(g.body, 0.11);
    g.silk.push(...rectSegs(sb), [sb[0], sb[1], -(pos + pw / 2), sb[1]]);
    pin1Dot(g);
    g.descr = fam + ', ' + n + ' Pin, ' + W + 'x' + W + 'mm body, pitch ' + pitch + 'mm'; g.tags = fam; g.family = 'qfp';
    return finish(g);
  }
  function qfnFp(lib, name, fam, n, W, L, pitch, ep, twoSided) {
    const g = newFp(lib, name);
    const pl = 0.85, ph = Math.min(0.3, r2(pitch * 0.5));
    if (twoSided) {
      const k = Math.ceil(n / 2), pos = r2(W / 2 - 0.05);
      quadPads(g, n, [k, 0, k, 0], pos, pitch, pl, ph);
    } else {
      const k = Math.ceil(n / 4);
      const posX = r2(W / 2 - 0.05), posY = r2(L / 2 - 0.05);
      let num = 1;
      for (let i = 0; i < k && num <= n; i++) g.pads.push(smdP(String(num++), -posX, R((i - (k - 1) / 2) * pitch), pl, ph));
      for (let i = 0; i < k && num <= n; i++) g.pads.push(smdP(String(num++), R((i - (k - 1) / 2) * pitch), posY, ph, pl));
      for (let i = 0; i < k && num <= n; i++) g.pads.push(smdP(String(num++), posX, R(((k - 1) / 2 - i) * pitch), pl, ph));
      for (let i = 0; i < k && num <= n; i++) g.pads.push(smdP(String(num++), R(((k - 1) / 2 - i) * pitch), -posY, ph, pl));
    }
    if (ep) g.pads.push(P(ep[2] || String(n + 1), 'smd', 'rect', 0, 0, ep[0], ep[1]));
    g.body = [-W / 2, -L / 2, W / 2, L / 2];
    g.courtyard = [-(W / 2 + 0.625), -(L / 2 + (twoSided ? 0.25 : 0.625)), W / 2 + 0.625, L / 2 + (twoSided ? 0.25 : 0.625)].map(r2);
    g.fab.push(...chamferRect(g.body, Math.min(0.75, W * 0.2)));
    g.silk.push(...rectSegs(grow(g.body, 0.11)));
    const dot = [-(W / 2 + 0.45), -(L / 2 + 0.45), 0.15];
    g.silkCircles.push(dot); g.pin1 = [dot[0], dot[1]];
    g.descr = fam + ', ' + n + ' Pin, ' + W + 'x' + L + 'mm body, pitch ' + pitch + 'mm' + (ep ? ', exposed pad' : ''); g.tags = fam; g.family = 'qfn';
    return finish(g);
  }

  function headerFp(lib, name, rows, n, pitch, socket) {
    const g = newFp(lib, name);
    const pd = pitch >= 2.5 ? 1.7 : pitch >= 1.9 ? 1.35 : 1.0, dr = pitch >= 2.5 ? 1.0 : pitch >= 1.9 ? 0.8 : 0.65;
    for (let i = 0; i < n; i++) for (let c = 0; c < rows; c++) {
      const num = rows === 1 ? i + 1 : i * 2 + c + 1;
      g.pads.push(P(String(num), 'thru_hole', num === 1 ? 'rect' : 'oval', R(c * pitch), R(i * pitch), pd, pd, { drill: dr }));
    }
    g.pads.sort((a, b) => +a.num - +b.num);
    const h = pitch / 2, xr = (rows - 1) * pitch, yb = (n - 1) * pitch;
    g.body = [-h, -h, xr + h, yb + h];
    g.fab.push(...chamferRect(g.body, h / 2));
    const s = h + 0.06;
    g.silk.push([-s, h, -s, yb + s], [-s, yb + s, xr + s, yb + s], [xr + s, yb + s, xr + s, -s], [xr + s, -s, h, -s], [h, -s, h, h], [h, h, -s, h], [-s, 0, -s, -s], [-s, -s, 0, -s]);
    if (rows === 1) { g.silk.length = 0; g.silk.push([-s, h, -s, yb + s], [-s, yb + s, s, yb + s], [s, yb + s, s, h], [-s, h, s, h], [-s, 0, -s, -s], [-s, -s, 0, -s]); }
    g.courtyard = [-h - 0.53, -h - 0.53, xr + h + 0.53, yb + h + 0.48].map(r2);
    g.pin1 = [-s, -s];
    g.kind = 'th'; g.attr = 'through_hole';
    g.descr = 'Through hole straight ' + (socket ? 'socket strip' : 'pin header') + ', ' + rows + 'x' + String(n).padStart(2, '0') + ', ' + pitch + 'mm pitch, ' + (rows === 1 ? 'single' : 'double') + ' row';
    g.tags = 'Through hole ' + (socket ? 'socket strip' : 'pin header') + ' THT ' + rows + 'x' + String(n).padStart(2, '0') + ' ' + pitch + 'mm'; g.family = 'header';
    return finish(g);
  }

  function testPointFp(lib, name, D) {
    const g = newFp(lib, name);
    g.pads.push(P('1', 'smd', 'circle', 0, 0, D, D, { layers: ['F.Cu', 'F.Mask'] }));
    g.body = [-D / 2, -D / 2, D / 2, D / 2];
    g.fabCircles.push([0, 0, D / 2]);
    g.crtCircle = [0, 0, D / 2 + 0.5];
    g.courtyard = [-(D / 2 + 0.5), -(D / 2 + 0.5), D / 2 + 0.5, D / 2 + 0.5];
    g.attr = 'exclude'; g.kind = 'smd'; g.model = false; g.family = 'tp';
    g.descr = 'SMD pad as test Point, diameter ' + D + 'mm'; g.tags = 'test point SMD pad';
    finish(g);
    g.silkCircles = [[0, 0, D / 2 + 0.2 + SILK_W / 2, 0]];
    g.pin1 = [0, 0];
    return g;
  }
  function holeFp() {
    const g = newFp('MountingHole', 'MountingHole_3.2mm_M3');
    g.pads.push(P('', 'np_thru_hole', 'circle', 0, 0, 3.2, 3.2, { drill: 3.2 }));
    g.body = [-3.2, -3.2, 3.2, 3.2]; g.fabCircles.push([0, 0, 3.2]); g.crtCircle = [0, 0, 3.45];
    g.courtyard = [-3.45, -3.45, 3.45, 3.45]; g.attr = 'exclude'; g.kind = 'th'; g.model = false; g.family = 'hole';
    g.descr = 'Mounting Hole 3.2mm, no annular, M3'; g.tags = 'mounting hole 3.2mm no annular m3'; g.pin1 = [0, 0];
    return g;
  }

  function crystalFp(lib, name, pins, W, L) {
    const g = newFp(lib, name);
    if (pins === 2) { g.pads.push(smdP('1', -(W / 2 - 0.35), 0, 1.0, Math.min(1.8, L + 0.3)), smdP('2', W / 2 - 0.35, 0, 1.0, Math.min(1.8, L + 0.3))); }
    else { const px = r2(W / 2 - 0.5), py = r2(L / 2 - 0.4); g.pads.push(smdP('1', -px, py, 1.4, 1.15), smdP('2', px, py, 1.4, 1.15), smdP('3', px, -py, 1.4, 1.15), smdP('4', -px, -py, 1.4, 1.15)); }
    g.body = [-W / 2, -L / 2, W / 2, L / 2];
    g.fab.push(...rectSegs(g.body));
    g.silk.push(...rectSegs(grow(g.body, 0.11)));
    if (pins === 4) { const b = grow(g.body, 0.11); g.silk.push([b[0] - 0.4, b[3], b[0] - 0.4, b[3] - 1.0]); g.pin1 = [b[0] - 0.4, b[3]]; }
    g.descr = 'SMD Crystal ' + W + 'x' + L + 'mm, ' + pins + ' pads'; g.tags = 'SMD SMT crystal'; g.family = 'xtal';
    return finish(g);
  }

  // generic 2-terminal SMD placeholder body (e.g. power inductor)
  function blockFp(lib, name, W, L, pw, ph, px, family, descr) {
    const g = newFp(lib, name);
    twoTerminal(g, { px, pw, ph, bw: W, bh: L }, false);
    const sb = grow(g.body, 0.11);
    g.silk.length = 0; g.silk.push(...rectSegs(sb));
    g.family = family || 'chip2'; g.descr = descr || ''; g.model = false;
    return finish(g);
  }

  // ------------------------------------------------------------------------------------------ id parsing
  function parseFootprint(id) {
    const j = id.indexOf(':');
    const lib = j >= 0 ? id.slice(0, j) : '', name = j >= 0 ? id.slice(j + 1) : id;
    let m;
    if ((m = /^(R|C|L|LED|Fuse|D)_(01005|0201|0402|0603|0805|1206|1210|1812|2010|2220|2512)_\d+Metric/.exec(name))) return chipFp(lib, name, m[1], m[2]);
    if ((m = /^CP_EIA-(\d{4})-(\d+)/.exec(name))) {
      const t = TANT[m[1]] || (() => { const Lm = +m[1].slice(0, 2) / 10, Wm = +m[1].slice(2) / 10; return { px: r2(Lm / 2 - 0.2), pw: r2(Lm * 0.45), ph: r2(Wm * 0.85), bw: Lm, bh: Wm }; })();
      const g = newFp(lib, name); twoTerminal(g, t, true);
      g.descr = 'Tantalum Capacitor SMD EIA-' + m[1] + ', IPC_7351 nominal'; g.tags = 'capacitor tantalum'; return finish(g);
    }
    if ((m = /^CP_Elec_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/.exec(name))) return elcoFp(lib, name, +m[1], +m[2]);
    if ((m = /^D_(SOD-123F|SOD-123|SOD-323|SOD-523|SMA|SMB|SMC|MiniMELF|MELF)(?![A-Za-z0-9])/.exec(name))) {
      const d = DIODE[m[1]]; const g = newFp(lib, name); twoTerminal(g, d, true);
      g.descr = d.d; g.tags = 'diode ' + m[1]; return finish(g);
    }
    if ((m = /^D_DO-(41|35|15|201)/.exec(name))) {
      const t = { 41: [5.2, 2.7, 10.16, 1.1], 35: [4.0, 2.0, 7.62, 0.8], 15: [7.6, 3.6, 12.7, 1.2], 201: [9.5, 5.3, 15.24, 1.5] }[m[1]];
      const pm = /_P([\d.]+)mm/.exec(name);
      return axialFp(lib, name, t[0], t[1], pm ? +pm[1] : t[2], t[3], true);
    }
    if ((m = /_Axial_.*?_L([\d.]+)mm_D([\d.]+)mm_P([\d.]+)mm/.exec(name))) return axialFp(lib, name, +m[1], +m[2], +m[3], +m[2] >= 3.5 ? 1.0 : 0.8, /^D_/.test(name));
    if ((m = /^(SOT-23)(?:-3)?$|^SOT-23W?$/.exec(name))) return sotFp(lib, name, 'SOT-23');
    if ((m = /^(T?SOT-23)-(5|6|8)/.exec(name))) return sotFp(lib, name, m[1] + '-' + m[2]);
    if (/^SOT-323|^SC-70(?!-)/.test(name)) return sotFp(lib, name, 'SOT-323');
    if (/^SOT-353|^SC-70-5/.test(name)) return sotFp(lib, name, 'SOT-353');
    if (/^SOT-363|^SC-70-6/.test(name)) return sotFp(lib, name, 'SOT-363');
    if (/^SOT-223/.test(name)) return sotFp(lib, name, 'SOT-223');
    if (/^SOT-89/.test(name)) return sotFp(lib, name, 'SOT-89');
    if (/^TO-252/.test(name)) return sotFp(lib, name, 'TO-252-2');
    if (/^TO-263-5/.test(name)) return sotFp(lib, name, 'TO-263-5');
    if (/^TO-263/.test(name)) return sotFp(lib, name, 'TO-263-2');
    if (/^TO-220-5/.test(name)) return toThtFp(lib, name, 'TO-220-5');
    if (/^TO-220/.test(name)) return toThtFp(lib, name, 'TO-220-3');
    if (/^TO-92/.test(name)) return toThtFp(lib, name, 'TO-92');
    if ((m = /^Pin(Header|Socket)_(\d)x(\d+)_P([\d.]+)mm/.exec(name))) return headerFp(lib, name, +m[2], +m[3], +m[4], m[1] === 'Socket');
    if ((m = /^TestPoint_Pad_D([\d.]+)mm/.exec(name))) return testPointFp(lib, name, +m[1]);
    if ((m = /^TestPoint_Pad_([\d.]+)x([\d.]+)mm/.exec(name))) return testPointFp(lib, name, Math.min(+m[1], +m[2]));
    if (/^MountingHole_3\.2mm_M3/.test(name)) return holeFp();
    if ((m = /^(H?SOIC|SO|H?TSSOP|MSOP|VSSOP|HVSSOP|SSOP|SOP)-(\d+)(?:-1EP)?_([\d.]+)x([\d.]+)mm_P([\d.]+)mm(?:_EP([\d.]+)x([\d.]+)mm)?/.exec(name)))
      return gullWing(lib, name, m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? [+m[6], +m[7]] : null);
    if ((m = /^DIP-(\d+)_W([\d.]+)mm/.exec(name))) return dipFp(lib, name, +m[1], +m[2]);
    if ((m = /^(LQFP|TQFP|VQFP|QFP|HTQFP)-(\d+)(?:-1EP)?_([\d.]+)x([\d.]+)mm_P([\d.]+)mm(?:_EP([\d.]+)x([\d.]+)mm)?/.exec(name)))
      return qfpFp(lib, name, m[1], +m[2], +m[3], +m[5], m[6] ? [+m[6], +m[7]] : null);
    if ((m = /^(V?W?U?T?QFN|DFN|UDFN|WDFN|TDFN|VSON|WSON|USON|SON|MLF)-(\d+)(-1EP)?_([\d.]+)x([\d.]+)mm_P([\d.]+)mm(?:_EP([\d.]+)x([\d.]+)mm)?/.exec(name))) {
      const two = /DFN|SON/.test(m[1]);
      const W = +m[4], L = +m[5];
      const ep = m[3] ? (m[7] ? [+m[7], +m[8]] : [r2(W - 1.4), r2(L - 1.4)]) : null;
      return qfnFp(lib, name, m[1], +m[2], W, L, +m[6], ep, two);
    }
    if ((m = /^Crystal_SMD_(\d{4})-(2|4)Pin_([\d.]+)x([\d.]+)mm/.exec(name))) return crystalFp(lib, name, +m[2], +m[3], +m[4]);
    return null;
  }

  // ------------------------------------------------------------------------------------------ placeholders
  const PH_LIB = 'Noeti_Placeholder';
  function placeholder(opts) {
    opts = opts || {};
    const type = String(opts.type || '').toLowerCase();
    const pkg = String(opts.package || '').toUpperCase();
    const nums = (opts.pinNumbers && opts.pinNumbers.length ? opts.pinNumbers.map(String) : null) || Array.from({ length: Math.max(1, opts.pinCount || 2) }, (_, i) => String(i + 1));
    const names = opts.pinNames || {};
    nums.sort(pinCmp);
    const n = nums.length;
    let g, why;
    const renumber = (geo, list) => { // map positional pads 1..k onto the real pin numbers
      const by = new Map(geo.pads.map((p) => [p.num, p]));
      const keep = [];
      list.forEach((num, i) => { const p = by.get(String(i + 1)); if (p) { p.num = num; keep.push(p); } });
      geo.pads = keep;
      return geo;
    };
    if (type === 'test_point' || n === 1) {
      g = testPointFp(PH_LIB, 'TestPoint_Pad_D1.5mm', 1.5); why = 'test pad'; renumber(g, nums);
    } else if (type === 'connector') {
      const maxNum = Math.max(...nums.map((x) => (/^\d+$/.test(x) ? +x : 0)), n);
      g = headerFp(PH_LIB, 'PinHeader_1x' + String(maxNum).padStart(2, '0') + '_P2.54mm_Vertical', 1, maxNum, 2.54, false); why = '1x' + maxNum + ' 2.54 mm header';
    } else if (n === 2) {
      if (type === 'crystal') { g = crystalFp(PH_LIB, 'Crystal_SMD_3215-2Pin_3.2x1.5mm', 2, 3.2, 1.5); why = '3.2x1.5 mm 2-pad crystal'; }
      else if (type === 'inductor' && opts.power) { g = blockFp(PH_LIB, 'L_Power_6.0x6.0mm', 6.0, 6.0, 1.6, 5.4, 2.4, 'chip2', 'Power inductor placeholder, 6.0x6.0mm'); why = '6x6 mm power inductor'; }
      else if (type === 'inductor' || type === 'ferrite_bead') { g = chipFp(PH_LIB, 'L_1210_3225Metric', 'L', '1210'); why = '1210'; }
      else if (type === 'capacitor_polarized') { g = elcoFp(PH_LIB, 'CP_Elec_5x5.4', 5, 5.4); why = '5x5.4 mm electrolytic'; }
      else {
        const pref = { resistor: 'R', thermistor: 'R', capacitor: 'C', led: 'LED', fuse: 'Fuse', diode: 'D', schottky_diode: 'D', zener_diode: 'D', tvs_diode: 'D' }[type];
        g = pref ? chipFp(PH_LIB, pref + '_1206_3216Metric', pref, '1206') : blockFp(PH_LIB, 'SMD_2Pin_3.2x1.6mm', 3.2, 1.6, 1.125, 1.75, 1.4625, 'chip2', 'Generic 2-terminal SMD placeholder, 3.2x1.6mm body');
        why = '1206-size';
      }
      renumber(g, nums);
    } else if (n === 3 && !/QFN|DFN|SON|SOIC|SOP|QFP/.test(pkg)) {
      g = sotFp(PH_LIB, 'SOT-23', 'SOT-23'); why = 'SOT-23'; renumber(g, nums);
    } else {
      const leadless = /QFN|DFN|SON|MLF|LFCSP|LGA/.test(pkg);
      if (leadless) {
        const two = /DFN|SON/.test(pkg) && !/QFN/.test(pkg);
        let epNum = nums.find((x) => /^(EP|EPAD|PAD|TAB|THERMAL|PAD\d*)$/i.test(x) || /^(EP|EPAD|PAD|THERMAL(_?PAD)?|EXP(OSED)?_?PAD)$/i.test(names[x] || ''));
        if (!epNum && n % (two ? 2 : 4) === 1) epNum = nums[n - 1];
        const per = nums.filter((x) => x !== epNum);
        const m = per.length;
        const k = Math.ceil(m / (two ? 2 : 4)), pitch = two ? (k > 6 ? 0.5 : 0.65) : (k > 12 ? 0.4 : 0.5);
        const W = two ? 3 : Math.max(2, Math.ceil((k * pitch + 1.0) * 2) / 2);
        const L = two ? Math.max(2, Math.ceil((k * pitch + 0.6) * 2) / 2) : W;
        const fam = two ? 'DFN' : 'QFN';
        g = qfnFp(PH_LIB, fam + '-' + m + (epNum ? '-1EP' : '') + '_' + W + 'x' + L + 'mm_P' + pitch + 'mm', fam, m, W, L, pitch, epNum ? [r2(W - 1.4), r2(L - 1.4), 'EP#'] : null, two);
        why = fam + '-' + m + ' ' + W + 'x' + L + ' mm';
        const by = new Map(g.pads.map((p) => [p.num, p]));
        const keep = [];
        per.forEach((num, i) => { const p = by.get(String(i + 1)); if (p) { p.num = num; keep.push(p); } });
        if (epNum) { const p = by.get('EP#'); p.num = epNum; keep.push(p); }
        g.pads = keep;
      } else {
        const m = n % 2 ? n + 1 : n;
        if (m <= 16) { const L = r2(m / 2 * 1.27 - 0.2); g = gullWing(PH_LIB, 'SOIC-' + m + '_3.9x' + L + 'mm_P1.27mm', 'SOIC', m, 3.9, L, 1.27, null); why = 'SOIC-' + m; }
        else if (m <= 28) { const L = r2(Math.max(3, m / 2 * 0.65 + 0.3)); g = gullWing(PH_LIB, 'TSSOP-' + m + '_4.4x' + L + 'mm_P0.65mm', 'TSSOP', m, 4.4, L, 0.65, null); why = 'TSSOP-' + m; }
        else { const q = Math.ceil(m / 4) * 4, W = Math.ceil(q / 4 * 0.5 + 1.0); g = qfpFp(PH_LIB, 'LQFP-' + q + '_' + W + 'x' + W + 'mm_P0.5mm', 'LQFP', q, W, 0.5, null); why = 'LQFP-' + q; }
        renumber(g, nums);
      }
    }
    g.placeholder = true; g.model = false;
    g.placeholderWhat = why;
    if (!g.descr) g.descr = 'Placeholder footprint';
    g.descr = 'PLACEHOLDER (' + why + ') - ' + g.descr;
    return g;
  }

  // public: footprint geometry for a KiCad library id (or a placeholder for '' / unknown ids)
  function footprint(fpId, opts) {
    const id = String(fpId || '').trim();
    let g = id ? parseFootprint(id) : null;
    if (!g) {
      g = placeholder(opts || {});
      if (id) { // keep the caller's library id so KiCad can swap in the real footprint
        const j = id.indexOf(':');
        g.lib = j >= 0 ? id.slice(0, j) : ''; g.name = j >= 0 ? id.slice(j + 1) : id; g.id = id;
      }
    }
    return g;
  }

  // ------------------------------------------------------------------------------------------ placement
  const CLEAR = 0.25;          // courtyard to courtyard
  const REF_SIZE = 1.0, REF_THICK = 0.15;
  const textW = (s, size) => size * (0.78 * String(s).length + 0.1);
  const GND_RE = /^(?:[ADPS]?GND[A-Z0-9_]*|GND[A-Z0-9_]*|VSS[A-Z0-9_]*|EARTH|0V|VEE_GND)$/i;
  const PWR_RE = /^(?:[+-]\d|V(CC|DD|IN|OUT|BUS|BAT|REF|EE|SS|PP|M|S)|AVDD|DVDD|VIO|\+?BATT|VDC|VSYS)/i;
  const W_LEN = 0.5;   // cost per mm of distance to the other placed pads of the part's (non-ground) nets
  const W_PULL = 0.1;  // cost per mm of distance from the cluster anchor (keeps clusters compact)
  const LABEL_MODES = [['above', 0], ['below', 0.15], ['right', 0.4], ['left', 0.4]];

  function boxOf(part, x, y, a, b) {
    const c = [rot(b[0], b[1], a), rot(b[2], b[1], a), rot(b[2], b[3], a), rot(b[0], b[3], a)];
    return [x + Math.min(...c.map((q) => q[0])), y + Math.min(...c.map((q) => q[1])), x + Math.max(...c.map((q) => q[0])), y + Math.max(...c.map((q) => q[1]))];
  }
  const hits = (a, b, cl) => a[0] < b[2] + cl && b[0] < a[2] + cl && a[1] < b[3] + cl && b[1] < a[3] + cl;
  const shift = (b, x, y) => [b[0] + x, b[1] + y, b[2] + x, b[3] + y];

  // can the reference sit inside the body (relative to the footprint origin, world orientation a)?
  function insideLabel(part, a) {
    const g = part.geo, b = g.body;
    if (!part.refInside || Math.min(b[2] - b[0], b[3] - b[1]) < 2.2 || g.family === 'header' || g.family === 'tp' || g.family === 'hole') return null;
    const bw = boxOf(part, 0, 0, a, b);
    const tw = textW(part.ref, REF_SIZE);
    const pads = g.pads.map((p) => boxOf(part, 0, 0, a, padBox(p, SILK_CL + 0.05)));
    const cx0 = (bw[0] + bw[2]) / 2, cy0 = (bw[1] + bw[3]) / 2;
    const tries = [[0, 0], [0, -(bw[3] - bw[1]) / 4], [0, (bw[3] - bw[1]) / 4], [-(bw[2] - bw[0]) / 4, 0], [(bw[2] - bw[0]) / 4, 0]];
    for (const [ox, oy] of tries) {
      const cx = cx0 + ox, cy = cy0 + oy;
      const t = [cx - tw / 2, cy - REF_SIZE / 2 - 0.05, cx + tw / 2, cy + REF_SIZE / 2 + 0.05];
      if (t[0] < bw[0] + 0.05 || t[2] > bw[2] - 0.05 || t[1] < bw[1] + 0.05 || t[3] > bw[3] - 0.05) continue;
      if (pads.some((p) => hits(p, t, 0))) continue;
      return [cx, cy];
    }
    return null;
  }
  // per-rotation cache: courtyard box and the reference placements relative to the footprint origin
  function geomAt(part, a) {
    part._g = part._g || {};
    if (part._g[a]) return part._g[a];
    const crt = boxOf(part, 0, 0, a, part.geo.courtyard);
    const opts = [];
    if (part.noLabel) opts.push({ mode: 'none', pen: 0, box: crt, label: null });
    else {
      const ins = insideLabel(part, a);
      if (ins) opts.push({ mode: 'in', pen: 0, box: crt, label: ins });
      else {
        const tw = textW(part.ref, REF_SIZE), h = REF_SIZE / 2 + 0.05, cx = (crt[0] + crt[2]) / 2, cy = (crt[1] + crt[3]) / 2;
        for (const [mode, pen] of LABEL_MODES) {
          let lab;
          if (mode === 'above') lab = [cx, crt[1] - 0.15 - REF_SIZE / 2];
          else if (mode === 'below') lab = [cx, crt[3] + 0.15 + REF_SIZE / 2];
          else if (mode === 'right') lab = [crt[2] + 0.15 + tw / 2, cy];
          else lab = [crt[0] - 0.15 - tw / 2, cy];
          opts.push({ mode, pen, box: union(crt, [lab[0] - tw / 2, lab[1] - h, lab[0] + tw / 2, lab[1] + h]), label: lab });
        }
      }
    }
    part._g[a] = { crt, opts };
    return part._g[a];
  }
  // occupied area of a placed part: courtyard plus its reference text
  function occupancy(part, x, y, a, mode) {
    const G = geomAt(part, a);
    const o = G.opts.find((q) => q.mode === mode) || G.opts[0];
    return { box: shift(o.box, x, y), crt: shift(G.crt, x, y), label: o.label ? [x + o.label[0], y + o.label[1], o.mode] : null, mode: o.mode };
  }

  // candidate offsets (outward k, lateral s) sorted by cost: moving outward costs a little more than sliding along the side
  const CANDS = new Map();
  function candidates(kw) {
    kw = kw || 1.6;
    if (CANDS.has(kw)) return CANDS.get(kw);
    const K = 90, S = 90, out = [];
    for (let k = 0; k <= K; k++) for (let s = -S; s <= S; s++) out.push([k, s, kw * k * GRID + Math.abs(s) * GRID + (s < 0 ? 1e-4 : 0) + k * 1e-6]);
    out.sort((p, q) => p[2] - q[2]);
    CANDS.set(kw, out);
    return out;
  }

  // world outward direction of a pad (from the part body centre, snapped to an axis)
  function padDir(part, pi) {
    const g = part.geo, p = g.pads[pi], b = g.body;
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    const hw = Math.max(0.3, (b[2] - b[0]) / 2), hh = Math.max(0.3, (b[3] - b[1]) / 2);
    const nx = (p.x - cx) / hw, ny = (p.y - cy) / hh;
    let d;
    if (Math.abs(nx) < 0.05 && Math.abs(ny) < 0.05) d = [0, 1];
    else d = Math.abs(nx) >= Math.abs(ny) ? [Math.sign(nx), 0] : [0, Math.sign(ny)];
    const r = rot(d[0], d[1], part.a);
    return [Math.round(r[0]), Math.round(r[1])];
  }
  const padWorld = (part, pi) => { const p = part.geo.pads[pi]; const r = rot(p.x, p.y, part.a); return [part.x + r[0], part.y + r[1]]; };

  // rotations ranked by how well the connected pad faces the target (penalty added to the search cost)
  function rotationChoices(part, pi, d) {
    const g = part.geo, p = g.pads[pi];
    let v;
    if (g.pads.length === 2) { const o = g.pads[1 - pi]; v = [p.x - o.x, p.y - o.y]; }
    else { const b = g.body; v = [p.x - (b[0] + b[2]) / 2, p.y - (b[1] + b[3]) / 2]; }
    const L = Math.hypot(v[0], v[1]) || 1;
    const out = [];
    for (const a of [0, 90, 180, 270]) {
      const w = rot(v[0] / L, v[1] / L, a);
      const dot = -(w[0] * d[0] + w[1] * d[1]);
      out.push([a, dot > 0.7 ? 0 : dot > -0.3 ? 2.0 : 5.0]);
    }
    out.sort((x, y) => x[1] - y[1] || x[0] - y[0]);
    return out;
  }

  // pad positions of the part's nets already placed in a frame (ground excluded: it goes to a pour)
  function netPoints(nets, frameParts) {
    const m = new Map();
    for (const tp of frameParts) tp.geo.pads.forEach((pad, pi) => {
      const ni = tp.padNet[pi];
      if (!ni || nets[ni].ground) return;
      if (!m.has(ni)) m.set(ni, []);
      m.get(ni).push(padWorld(tp, pi));
    });
    return m;
  }

  // cheapest free spot for `part` with pad `pi` next to world point T, stepping outward along d.
  // cost = displacement (outward/lateral) + rotation and label penalties + wire length to placed pads + pull to the anchor
  function placeNear(part, boxes, T, d, pi, rots, opt) {
    opt = opt || {};
    const cands = candidates(opt.kw);
    const t = [-d[1], d[0]];
    const pts = opt.pts || null, center = opt.center || null;
    let best = null;
    for (const [a, pen] of rots) {
      if (best && pen >= best.cost) continue;
      const G = geomAt(part, a);
      const p = pi >= 0 ? part.geo.pads[pi] : null;
      const o = p ? rot(p.x, p.y, a) : [0, 0];
      const bx = T[0] - o[0], by = T[1] - o[1];
      const lp = pts ? part.geo.pads.map((pad, j) => { const ni = part.padNet[j]; return ni && pts.has(ni) ? [rot(pad.x, pad.y, a), pts.get(ni)] : null; }).filter(Boolean) : [];
      const bc = [(G.crt[0] + G.crt[2]) / 2, (G.crt[1] + G.crt[3]) / 2];
      for (const [k, s, c] of cands) {
        if (best && c + pen >= best.cost) break;
        const x = snap(bx + d[0] * k * GRID + t[0] * s * GRID), y = snap(by + d[1] * k * GRID + t[1] * s * GRID);
        let lab = null;
        for (const L of G.opts) {
          if (best && c + pen + L.pen >= best.cost) break;
          const b = shift(L.box, x, y);
          if (!boxes.some((q) => hits(q, b, CLEAR))) { lab = L; break; }
        }
        if (!lab) continue;
        let wl = 0;
        for (const [r, list] of lp) { let m = Infinity; for (const w of list) m = Math.min(m, Math.hypot(x + r[0] - w[0], y + r[1] - w[1])); wl += m; }
        const pull = center ? Math.hypot(x + bc[0] - center[0], y + bc[1] - center[1]) : 0;
        const cost = c + pen + lab.pen + W_LEN * wl + W_PULL * pull;
        if (!best || cost < best.cost) best = { x, y, a, cost, mode: lab.mode };
      }
    }
    if (best) best.occ = occupancy(part, best.x, best.y, best.a, best.mode);
    return best;
  }

  function netClass(net) { return net.ground ? 2 : net.power ? 1 : 0; }

  function placeAll(ctx) {
    const { parts, nets } = ctx;
    const clusters = [];
    let order = 0;
    const attach = new Map();
    const commit = (part, cl, spot) => {
      part.x = spot.x; part.y = spot.y; part.a = spot.a; part.placed = true; part.cluster = cl; part.order = order++; part.labelMode = spot.mode;
      part.occ = spot.occ; cl.boxes.push(spot.occ.box); cl.parts.push(part);
    };
    const movable = parts.filter((p) => p.role !== 'conn' && p.role !== 'tp');
    const area = (p) => (p.geo.courtyard[2] - p.geo.courtyard[0]) * (p.geo.courtyard[3] - p.geo.courtyard[1]);
    const anchorsIC = movable.filter((p) => p.role === 'ic').sort((a, b) => area(b) - area(a) || natCmp(a.ref, b.ref));
    const newCluster = (anchor) => {
      const cl = { boxes: [], parts: [], anchor, ox: 0, oy: 0 };
      clusters.push(cl);
      const mode = geomAt(anchor, 0).opts[0].mode;
      commit(anchor, cl, { x: 0, y: 0, a: 0, cost: 0, mode, occ: occupancy(anchor, 0, 0, 0, mode) });
      const b = anchor.geo.body;
      cl.center = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      anchor.isAnchor = true;
      return cl;
    };
    for (const a of anchorsIC) newCluster(a);

    // best attachment of an unplaced part to already placed pads
    const attachment = (part) => {
      let best = null;
      const capLike = (part.type === 'capacitor' || part.type === 'capacitor_polarized') && part.geo.pads.length === 2;
      part.geo.pads.forEach((pad, pi) => {
        const ni = part.padNet[pi];
        if (!ni) return;
        const net = nets[ni];
        for (const m of net.members) {
          const tp = m.part;
          if (tp === part || !tp.placed || tp.role === 'conn' || tp.role === 'tp') continue;
          const key = tp.ref + '|' + tp.geo.pads[m.pi].num;
          const roleRank = part.role === 'q' ? ({ C: 0, D: 0, B: 1, G: 1, E: 2, S: 2 }[String(part.pinOfPad[pi] || '').toUpperCase()] ?? 1) : 0;
          const supplyRank = capLike && net.power ? ((tp.pinTypeOfPad && tp.pinTypeOfPad[m.pi]) === 'power_in' ? 0 : 1) : 0;   // decoupling caps go to supply pins first
          const k = [netClass(net), roleRank, supplyRank, tp.isAnchor ? 0 : 1, attach.get(key) || 0, tp.order, m.pi, pi];
          if (!best || cmpArr(k, best.key) < 0) best = { key: k, pi, tp, tpi: m.pi, net, akey: key };
        }
      });
      if (!best) return null;
      const netsOf = new Set(part.padNet.filter(Boolean));
      const decoupling = (part.type === 'capacitor' || part.type === 'capacitor_polarized') && part.geo.pads.length === 2 &&
        [...netsOf].some((n) => nets[n].ground) && [...netsOf].some((n) => nets[n].power);
      let cls;
      if (best.net.ground) cls = 3;
      else if (best.tp.isAnchor) cls = decoupling ? 0 : 1;
      else cls = 2;
      best.cls = cls;
      best.sort = [cls, cls === 0 ? part.capValue : 0, best.tp.order, best.tpi, ...natKey(part.ref).slice(0, 2)];
      return best;
    };
    for (;;) {
      const todo = movable.filter((p) => !p.placed);
      if (!todo.length) break;
      let pick = null;
      for (const p of todo) {
        const at = attachment(p);
        if (!at) continue;
        const c = pick ? cmpArr(at.sort, pick.at.sort) : -1;
        if (c < 0 || (c === 0 && natCmp(p.ref, pick.p.ref) < 0)) pick = { p, at };
      }
      if (!pick) {
        // nothing attaches: start a new cluster around the best-connected remaining part
        const nNets = (p) => new Set(p.padNet.filter(Boolean)).size;
        const multi = (p) => (p.role === 'q' || p.role === 'multi' ? 1 : 0);
        todo.sort((a, b) => multi(b) - multi(a) || nNets(b) - nNets(a) || b.geo.pads.length - a.geo.pads.length || natCmp(a.ref, b.ref));
        newCluster(todo[0]);
        continue;
      }
      const { p, at } = pick;
      const cl = at.tp.cluster;
      const T = padWorld(at.tp, at.tpi), d = padDir(at.tp, at.tpi);
      const spot = placeNear(p, cl.boxes, T, d, at.pi, rotationChoices(p, at.pi, d), { pts: netPoints(nets, cl.parts), center: cl.center });
      attach.set(at.akey, (attach.get(at.akey) || 0) + 1);
      if (!spot) { p.unplaceable = true; p.placed = true; continue; }
      commit(p, cl, spot);
    }

    // clusters in a row, anchors on one horizontal line
    let cursor = 0;
    ctx.globalBoxes = [];
    clusters.forEach((cl, i) => {
      if (!cl.boxes.length) return;
      let bb = null;
      for (const b of cl.boxes) bb = union(bb, b);
      const ox = i === 0 ? 0 : Math.ceil((cursor + 1.5 - bb[0]) / GRID - 1e-9) * GRID;
      cl.ox = ox;
      for (const p of cl.parts) { p.x = R(p.x + ox); p.occ = occupancy(p, p.x, p.y, p.a, p.labelMode); ctx.globalBoxes.push(p.occ.box); }
      cursor = bb[2] + ox;
    });
    const gbox = () => { let b = null; for (const x of ctx.globalBoxes) b = union(b, x); return b || [0, 0, 0, 0]; };
    const placedParts = () => parts.filter((p) => p.placed && !p.unplaceable);
    const commitGlobal = (p, spot) => { p.x = spot.x; p.y = spot.y; p.a = spot.a; p.labelMode = spot.mode; p.occ = spot.occ; p.placed = true; p.unplaceable = false; ctx.globalBoxes.push(spot.occ.box); };

    // connectors on the board edges: inputs / power-in left, outputs right (ties: the side their pads are on)
    const conns = parts.filter((p) => p.role === 'conn').sort((a, b) => natCmp(a.ref, b.ref));
    let lastSide = 1;
    const G0 = gbox(), midX = (G0[0] + G0[2]) / 2;
    for (const c of conns) {
      let score = 0, geo = 0;
      const tgt = [];
      c.geo.pads.forEach((pad, pi) => {
        const ni = c.padNet[pi];
        if (!ni) return;
        const net = nets[ni];
        if (net.port === 'input') score -= 2;
        if (net.port === 'output') score += 2;
        for (const m of net.members) {
          if (m.part === c) continue;
          const et = m.part.pinTypeOfPad[m.pi] || '';
          if (!net.ground && (m.part.role === 'ic' || m.part.role === 'q')) {
            if (et === 'power_in' || et === 'input') score -= 1;
            if (et === 'output' || et === 'power_out') score += 1;
          }
          if (m.part.placed && !m.part.unplaceable && m.part.role !== 'conn' && m.part.role !== 'tp') {
            const w = padWorld(m.part, m.pi);
            tgt.push({ pi, net, w });
            if (!net.ground) geo += Math.sign(w[0] - midX);
          }
        }
      });
      const side = score < 0 ? -1 : score > 0 ? 1 : geo < 0 ? -1 : geo > 0 ? 1 : -lastSide;
      lastSide = side;
      c.side = side;
      const nonG = tgt.filter((t) => !t.net.ground);
      const use = nonG.length ? nonG : tgt;
      const pi = use.length ? use[0].pi : 0;
      const sel = use.filter((t) => t.pi === pi);
      const ty = sel.length ? sel.reduce((s, t) => s + t.w[1], 0) / sel.length : (G0[1] + G0[3]) / 2;
      const pp = c.geo.pads[pi] || { x: 0, y: 0 };
      const cg = geomAt(c, 0);
      let spot;
      if (cg.crt[3] - cg.crt[1] > Math.max(25, 1.5 * (G0[3] - G0[1]))) {
        // long connector: lay it along the bottom edge, pin 1 on the left
        const cr = geomAt(c, 90), o = rot(pp.x, pp.y, 90);
        const T = [G0[0] + o[0] - cr.crt[0], G0[3] + CLEAR + 0.25 + o[1] - cr.crt[1]];
        spot = placeNear(c, ctx.globalBoxes, T, [0, 1], pi, [[90, 0]], { pts: netPoints(nets, placedParts()), kw: 4 });
      } else {
        // edge x such that, with pad `pi` at T, the courtyard just clears the clustered parts
        const T = [side < 0 ? G0[0] - CLEAR - 0.25 - (cg.crt[2] - pp.x) : G0[2] + CLEAR + 0.25 + (pp.x - cg.crt[0]), ty];
        spot = placeNear(c, ctx.globalBoxes, T, [side, 0], pi, [[0, 0]], { pts: netPoints(nets, placedParts()), kw: 4 });
      }
      if (spot) commitGlobal(c, spot);
    }
    // test points next to their net; anything left (no nets) goes below
    for (const p of parts.filter((q) => !q.placed || q.unplaceable).sort((a, b) => natCmp(a.ref, b.ref))) {
      let T = null, d = [0, 1], pi = 0;
      const ni = p.padNet.find(Boolean);
      if (ni) {
        const ms = nets[ni].members.filter((m) => m.part !== p && m.part.placed && !m.part.unplaceable);
        ms.sort((a, b) => (a.part.role === 'conn') - (b.part.role === 'conn') || (a.part.order ?? 1e9) - (b.part.order ?? 1e9));
        if (ms.length) { T = padWorld(ms[0].part, ms[0].pi); d = padDir(ms[0].part, ms[0].pi); pi = p.padNet.indexOf(ni); }
      }
      if (!T) { const G = gbox(); T = [G[0], G[3] + 1.0]; d = [0, 1]; pi = -1; }
      const spot = placeNear(p, ctx.globalBoxes, T, d, pi, pi >= 0 ? rotationChoices(p, pi, d) : [[0, 0]], { pts: netPoints(nets, placedParts()) });
      if (spot) commitGlobal(p, spot);
      else p.placed = false;
    }
    return clusters;
  }
  function cmpArr(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i], y = b[i];
      if (x === y) continue;
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      return x < y ? -1 : 1;
    }
    return 0;
  }

  // ------------------------------------------------------------------------------------------ board model
  function parseCap(v) {
    const m = /^\s*(\d+(?:[.,]\d+)?)\s*([pnuµμm]?)/.exec(String(v || ''));
    if (!m) return 1;
    return parseFloat(m[1].replace(',', '.')) * ({ p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3 }[m[2]] || 1);
  }
  const TYPE_WORD = { resistor: 'resistor', capacitor: 'capacitor', capacitor_polarized: 'polarised capacitor', inductor: 'inductor', ferrite_bead: 'ferrite bead',
    diode: 'diode', schottky_diode: 'diode', zener_diode: 'diode', tvs_diode: 'TVS diode', led: 'LED', crystal: 'crystal', connector: 'connector', ic: 'IC', other: 'part',
    bjt_npn: 'transistor', bjt_pnp: 'transistor', mosfet_n: 'MOSFET', mosfet_p: 'MOSFET', switch: 'switch', fuse: 'fuse', test_point: 'test point' };
  const DESC = { resistor: 'Resistor', capacitor: 'Unpolarized capacitor', capacitor_polarized: 'Polarized capacitor', inductor: 'Inductor', ferrite_bead: 'Ferrite bead',
    diode: 'Diode', schottky_diode: 'Schottky diode', zener_diode: 'Zener diode', tvs_diode: 'TVS diode', led: 'Light emitting diode', crystal: 'Two pin crystal',
    connector: 'Generic connector', test_point: 'Test point', bjt_npn: 'NPN transistor', bjt_pnp: 'PNP transistor', mosfet_n: 'N-MOSFET transistor', mosfet_p: 'P-MOSFET transistor',
    fuse: 'Fuse', switch: 'Push button switch', potentiometer: 'Potentiometer', thermistor: 'Thermistor' };

  function buildModel(circuit, symbols, opts, warnings) {
    const symByRef = new Map((symbols || []).map((s) => [s.ref, s]));
    // nets (index 0 = no net)
    const nets = [{ name: '', members: [], ground: false, power: false, kind: 'signal', port: 'none' }];
    const netIdx = new Map();
    const pinNet = new Map(); // ref \0 pin -> net index
    (circuit.nets || []).forEach((n, i) => {
      let name = String(n.name || '').trim() || 'Net-' + (i + 1);
      let idx = netIdx.get(name);
      if (idx == null) {
        idx = nets.length; netIdx.set(name, idx);
        nets.push({ name, members: [], kind: n.kind || 'signal', port: n.port || 'none', ground: n.kind === 'ground' || GND_RE.test(name), power: false });
      }
      for (const nd of n.nodes || []) {
        const ref = Array.isArray(nd) ? nd[0] : nd.ref, pin = Array.isArray(nd) ? nd[1] : nd.pin;
        pinNet.set(ref + '\0' + pin, idx);
      }
    });
    const parts = [];
    for (const comp of circuit.components || []) {
      const ref = comp.ref, sym = symByRef.get(ref) || {};
      const type = String(comp.type || 'other').toLowerCase();
      const pinMap = sym.pinMap || {};
      const symPins = (sym.pins && sym.pins.length ? sym.pins : (comp.pins || [])).map((p) => ({ number: String(p.number), name: p.name || '', etype: p.etype || '' }));
      const used = [];
      for (const [k, ni] of pinNet) { const j = k.indexOf('\0'); if (k.slice(0, j) === ref) used.push([k.slice(j + 1), ni]); }
      const padOfPin = (pin) => String(pinMap[pin] != null ? pinMap[pin] : pin);
      const numbers = [...new Set(symPins.map((p) => p.number).concat(used.map(([pin]) => padOfPin(pin))))].filter(Boolean);
      const pinNames = {}; for (const p of symPins) pinNames[p.number] = p.name;
      const fpId = sym.footprint != null ? sym.footprint : (comp.footprint || '');
      const rating = String(comp.rating || '');
      const amps = /(\d+(?:\.\d+)?)\s*(m?)A\b/.exec(rating);
      const ind = parseCap(comp.value);
      const power = (amps && parseFloat(amps[1]) * (amps[2] ? 1e-3 : 1) >= 0.3) || (type === 'inductor' && /[uµμm]H?/i.test(String(comp.value || '')) && ind >= 1e-6);
      const geo = footprint(fpId, { type, package: comp.package || '', pinNumbers: numbers, pinNames, pinCount: numbers.length, power });
      if (geo.placeholder) {
        if (!fpId) warnings.push(ref + ': no footprint chosen — placeholder ' + geo.placeholderWhat + ' used; pick the real ' + (TYPE_WORD[type] || 'part') + ' footprint in KiCad' + (sym.footprintNote ? ' (' + sym.footprintNote + ')' : ''));
        else warnings.push(ref + ': footprint ' + fpId + ' is not in the built-in set — placeholder ' + geo.placeholderWhat + ' geometry used; update it from the KiCad library');
      } else if (sym.footprintNote && /verify/i.test(sym.footprintNote)) warnings.push(ref + ': ' + geo.name + ' — ' + sym.footprintNote);
      let role = 'two';
      const nPads = new Set(geo.pads.map((p) => p.num)).size;
      if (type === 'connector') role = 'conn';
      else if (type === 'test_point') role = 'tp';
      else if (/^(bjt|mosfet)/.test(type)) role = 'q';
      else if (nPads >= 3 && (type === 'ic' || type === 'other' || type === 'relay' || type === 'transformer')) role = 'ic';
      else if (nPads >= 3) role = 'multi';
      const part = { ref, comp, sym, type, geo, role, padNet: [], pinOfPad: [], pinTypeOfPad: [], pinFnOfPad: [], x: 0, y: 0, a: 0, placed: false,
        capValue: parseCap(comp.value), noLabel: false, refInside: !!opts.refInside };
      const symByNum = new Map(symPins.map((p) => [p.number, p]));
      geo.pads.forEach((pad, pi) => {
        part.padNet[pi] = 0; part.pinOfPad[pi] = '';
        const sp = symByNum.get(pad.num);
        part.pinTypeOfPad[pi] = sp ? sp.etype : '';
        part.pinFnOfPad[pi] = sp && sp.name && sp.name !== '~' ? sp.name : '';
      });
      for (const [pin, ni] of used) {
        const num = padOfPin(pin);
        let hit = 0;
        geo.pads.forEach((pad, pi) => { if (pad.num === num) { part.padNet[pi] = ni; part.pinOfPad[pi] = pin; hit++; } });
        if (!hit) warnings.push(ref + ': pin ' + pin + ' (pad ' + num + ') has no pad on ' + geo.name + ' — net ' + nets[ni].name + ' is not connected to it on the board');
      }
      parts.push(part);
    }
    parts.forEach((part) => part.padNet.forEach((ni, pi) => { if (ni) nets[ni].members.push({ part, pi }); }));
    for (const n of nets.slice(1)) {
      n.power = !n.ground && (n.kind === 'power' || PWR_RE.test(n.name) || n.members.some((m) => /^power_(in|out)$/.test(m.part.pinTypeOfPad[m.pi] || '')));
    }
    return { parts, nets };
  }

  function boardOutline(ctx) {
    let bb = null;
    for (const p of ctx.parts) if (p.placed && p.occ) bb = union(bb, p.occ.box);
    if (!bb) bb = [0, 0, 0, 0];
    bb = grow(bb, 2.5);
    const minW = 20, minH = 15;
    if (bb[2] - bb[0] < minW) { const d = (minW - (bb[2] - bb[0])) / 2; bb[0] -= d; bb[2] += d; }
    if (bb[3] - bb[1] < minH) { const d = (minH - (bb[3] - bb[1])) / 2; bb[1] -= d; bb[3] += d; }
    bb = [Math.floor(bb[0] / GRID + 1e-9) * GRID, Math.floor(bb[1] / GRID + 1e-9) * GRID, Math.ceil(bb[2] / GRID - 1e-9) * GRID, Math.ceil(bb[3] / GRID - 1e-9) * GRID];
    const holes = [];
    if (bb[2] - bb[0] >= 40 && bb[3] - bb[1] >= 30) {
      const INS = 3.5, KO = 3.45;
      const occ = ctx.parts.filter((p) => p.placed && p.occ).map((p) => p.occ.box);
      // per blocked corner, push out only the edge that needs the smaller move
      for (let it = 0; it < 40; it++) {
        const cs = [[0, 1, -1, -1], [2, 1, 1, -1], [2, 3, 1, 1], [0, 3, -1, 1]];
        let moved = false;
        for (const [ex, ey, sx, sy] of cs) {
          const cx = bb[ex] - sx * INS, cy = bb[ey] - sy * INS;
          const k = [cx - KO, cy - KO, cx + KO, cy + KO];
          const blockers = occ.filter((b) => hits(b, k, CLEAR));
          if (!blockers.length) continue;
          // distance the hole must travel outward in x (keeping y) or in y (keeping x) to clear every box
          const needX = (y0, y1) => Math.max(0, ...occ.filter((b) => b[1] < y1 + CLEAR && y0 < b[3] + CLEAR).map((b) => (sx < 0 ? (cx + KO + CLEAR) - b[0] : b[2] - (cx - KO - CLEAR))));
          const needY = (x0, x1) => Math.max(0, ...occ.filter((b) => b[0] < x1 + CLEAR && x0 < b[2] + CLEAR).map((b) => (sy < 0 ? (cy + KO + CLEAR) - b[1] : b[3] - (cy - KO - CLEAR))));
          const tx = needX(k[1], k[3]), ty = needY(k[0], k[2]);
          const step = (v) => Math.max(GRID, Math.ceil(v / GRID - 1e-9) * GRID);
          if (tx <= ty) bb[ex] += sx * step(tx); else bb[ey] += sy * step(ty);
          moved = true;
        }
        if (!moved) {
          for (const [ex, ey, sx, sy] of [[0, 1, -1, -1], [2, 1, 1, -1], [2, 3, 1, 1], [0, 3, -1, 1]]) holes.push([bb[ex] - sx * INS, bb[ey] - sy * INS]);
          break;
        }
      }
    }
    return { box: bb, holes };
  }

  // ------------------------------------------------------------------------------------------ output
  const q = (s) => '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  const PAD_T = { smd: 0, thru_hole: 1, np_thru_hole: 2 };
  const PAD_S = { circle: 0, rect: 1, oval: 2, roundrect: 3 };
  function padLayers(g, p) {
    if (p.layers) return p.layers;
    if (p.type === 'smd') return ['F.Cu', 'F.Paste', 'F.Mask'];
    return ['*.Cu', '*.Mask'];
  }
  function layerMask(ls) {
    let m = 0;
    for (const L of ls) {
      if (L === '*.Cu' || L === 'F&B.Cu') m |= 7; else if (L === 'F.Cu') m |= 1; else if (L === 'B.Cu') m |= 2;
      else if (L === '*.Mask') m |= 24; else if (L === 'F.Mask') m |= 8; else if (L === 'B.Mask') m |= 16;
    }
    return m;
  }
  // Prim's minimum spanning tree over pad centres of each net
  function ratsnest(pads) {
    const byNet = new Map();
    pads.forEach((p, i) => { if (p[10]) { if (!byNet.has(p[10])) byNet.set(p[10], []); byNet.get(p[10]).push(i); } });
    const air = [];
    for (const ni of [...byNet.keys()].sort((a, b) => a - b)) {
      const ids = byNet.get(ni);
      if (ids.length < 2) continue;
      const n = ids.length, inT = new Array(n).fill(false), dist = new Array(n).fill(Infinity), from = new Array(n).fill(-1);
      dist[0] = 0;
      for (let it = 0; it < n; it++) {
        let u = -1;
        for (let i = 0; i < n; i++) if (!inT[i] && (u < 0 || dist[i] < dist[u])) u = i;
        inT[u] = true;
        if (from[u] >= 0) { const a = pads[ids[from[u]]], b = pads[ids[u]]; air.push(a[4], a[5], b[4], b[5], ni); }
        for (let v = 0; v < n; v++) {
          if (inT[v]) continue;
          const d = Math.hypot(pads[ids[u]][4] - pads[ids[v]][4], pads[ids[u]][5] - pads[ids[v]][5]);
          if (d < dist[v]) { dist[v] = d; from[v] = u; }
        }
      }
    }
    return air;
  }

  function schematicUuids(text) {
    const out = new Map();
    const E = root.DS2K_P1;
    if (!text || !E) return out;
    const tree = E.parse(text);
    for (const s of E.children(tree, 'symbol')) {
      let ref = '';
      for (const p of E.children(s, 'property')) if (E.str(p[1]) === 'Reference') ref = E.str(p[2]);
      const u = E.child(s, 'uuid');
      if (ref && !ref.startsWith('#') && u && !out.has(ref)) out.set(ref, E.str(u[1]));
    }
    return out;
  }

  function generate(circuitIn, symbols, opts) {
    opts = opts || {};
    const circuit = circuitIn && typeof circuitIn.toDict === 'function' ? circuitIn.toDict() : (circuitIn || {});
    const warnings = [];
    const ctx = buildModel(circuit, symbols, opts, warnings);
    placeAll(ctx);
    for (const p of ctx.parts) if (!p.placed) warnings.push(p.ref + ': could not be placed');
    const ob = boardOutline(ctx);
    const dx = 100 - ob.box[0], dy = 100 - ob.box[1];
    for (const p of ctx.parts) if (p.placed) { p.x = R(p.x + dx); p.y = R(p.y + dy); p.occ = occupancy(p, p.x, p.y, p.a, p.labelMode); }
    const BB = [100, 100, R(ob.box[2] + dx), R(ob.box[3] + dy)];
    const usedRefs = new Set(ctx.parts.map((p) => p.ref));
    let hn = 1;
    const holes = ob.holes.map(([x, y]) => {
      while (usedRefs.has('H' + hn)) hn++;
      const g = holeFp();
      return { ref: 'H' + hn++, comp: { value: 'MountingHole', type: 'other' }, type: 'hole', geo: g, role: 'hole', padNet: [0], pinFnOfPad: [''], pinTypeOfPad: [''],
        x: R(x + dx), y: R(y + dy), a: 0, placed: true, noLabel: true };
    });
    const title = String(opts.title || (circuit.design && circuit.design.title) || (circuit.part && circuit.part.mpn) || '').trim();
    const project = String(opts.name || title || 'design').replace(/[^A-Za-z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'design';
    const sheetfile = opts.sheetfile || project + '.kicad_sch';
    const schUuid = schematicUuids(opts.schematic);
    const uuid = uuidGen(project + '|kicad_pcb');
    const finishIn = String(opts.finish || 'ENIG').toUpperCase();
    const hasl = /HASL|HAL/.test(finishIn);

    const gfx = {};
    const G = (L) => gfx[L] || (gfx[L] = { lines: [], polys: [], circles: [], texts: [] });
    const fps = [], pads = [];
    const kfps = [];
    const all = ctx.parts.filter((p) => p.placed).sort((a, b) => natCmp(a.ref, b.ref)).concat(holes);

    for (const part of all) {
      const g = part.geo, x = part.x, y = part.y, a = normAngle(part.a);
      const fi = fps.length;
      const T = (lx, ly) => { const r = rot(lx, ly, a); return [R(x + r[0]), R(y + r[1])]; };
      const K = { part, g, a, lines: [], circles: [], texts: [], pads: [] };
      // graphics (local for KiCad, world for the viewer)
      const seg = (L, s, w) => { const p1 = T(s[0], s[1]), p2 = T(s[2], s[3]); G(L).lines.push(p1[0], p1[1], p2[0], p2[1], w); K.lines.push([L, s, w]); };
      const circ = (L, c, w, filled) => { const cc = T(c[0], c[1]); G(L).circles.push(cc[0], cc[1], R(c[2]), w, filled ? 1 : 0); K.circles.push([L, c, w, filled]); };
      for (const s of g.silk) seg('F.SilkS', s, SILK_W);
      for (const c of g.silkCircles) circ('F.SilkS', c, SILK_W, c[3] !== 0);
      for (const s of g.fab) seg('F.Fab', s, FAB_W);
      for (const c of g.fabCircles) circ('F.Fab', c, FAB_W, false);
      if (g.crtCircle) circ('F.CrtYd', g.crtCircle, CRT_W, false);
      else for (const s of rectSegs(g.courtyard)) seg('F.CrtYd', s, CRT_W);
      // texts
      const comp = part.comp || {};
      const value = String(comp.value || part.type || '');
      const bd = g.body, bw = bd[2] - bd[0], bh = bd[3] - bd[1];
      const bcx = (bd[0] + bd[2]) / 2, bcy = (bd[1] + bd[3]) / 2;
      let refPos = null;
      if (!part.noLabel && part.occ && part.occ.label) { refPos = [R(part.occ.label[0]), R(part.occ.label[1])]; G('F.SilkS').texts.push([part.ref, refPos[0], refPos[1], REF_SIZE, 0, '', 0, REF_THICK]); }
      const fs = R(clamp(Math.min(bw * 0.8 / (0.78 * part.ref.length + 0.1), bh * 0.7), 0.25, 1.0));
      const fpos = T(bcx, bcy);
      G('F.Fab').texts.push([part.ref, fpos[0], fpos[1], fs, a, '', 0, R(fs * 0.15)]);
      const vs = R(clamp(Math.max(bw, bh) / 3, 0.6, 1.0));
      const vloc = [bcx, g.courtyard[3] + vs / 2 + 0.25];
      const vpos = T(vloc[0], vloc[1]);
      G('F.Fab').texts.push([value, vpos[0], vpos[1], vs, a, '', 0, R(vs * 0.15)]);
      K.texts = { refPos, fs, fabLocal: [bcx, bcy], vs, vloc, value };
      // pads
      const padIds = [];
      g.pads.forEach((p, pi) => {
        const w = T(p.x, p.y);
        const ni = part.padNet[pi] || 0;
        const ls = padLayers(g, p);
        const row = [fi, p.num, PAD_T[p.type], PAD_S[p.shape], w[0], w[1], R(p.w), R(p.h), R(normAngle(a + p.angle)), layerMask(ls), ni,
          R(p.drill || 0), R(p.drill || 0), p.rr != null ? p.rr : 0.25, part.pinFnOfPad[pi] || '', part.pinTypeOfPad[pi] || ''];
        padIds.push(pads.length); pads.push(row); K.pads.push({ p, ni, ls, fn: row[14], pt: row[15] });
      });
      // body box = bbox of fab graphics (as the importer computes it)
      const fp = [];
      for (const s of g.fab) fp.push([s[0], s[1]], [s[2], s[3]]);
      for (const c of g.fabCircles) fp.push([c[0] - c[2], c[1] - c[2]], [c[0] + c[2], c[1] + c[2]]);
      let body = bd.map(R);
      if (fp.length) { const xs = fp.map((v) => v[0]), ys = fp.map((v) => v[1]); body = [R(Math.min(...xs)), R(Math.min(...ys)), R(Math.max(...xs)), R(Math.max(...ys))]; }
      // courtyard polygon (convex hull, world)
      const crtLocal = g.crtCircle ? [[g.crtCircle[0] - g.crtCircle[2], g.crtCircle[1] - g.crtCircle[2]], [g.crtCircle[0] + g.crtCircle[2], g.crtCircle[1] + g.crtCircle[2]]]
        : [[g.courtyard[0], g.courtyard[1]], [g.courtyard[2], g.courtyard[1]], [g.courtyard[2], g.courtyard[3]], [g.courtyard[0], g.courtyard[3]]];
      const hull = convexHull(crtLocal.map(([lx, ly]) => { const r = rot(lx, ly, a); return [x + r[0], y + r[1]]; }));
      // properties
      const ds = circuit.part && circuit.part.datasheet_url && ((comp.mpn && circuit.part.mpn && String(comp.mpn).toUpperCase().startsWith(String(circuit.part.mpn).toUpperCase())) || comp.value === circuit.part.mpn) ? circuit.part.datasheet_url : '~';
      const props = [['Datasheet', ds], ['Description', part.role === 'hole' ? '' : (comp.description || DESC[part.type] || '')],
        ['MPN', comp.mpn || comp.suggested_mpn || ''], ['Manufacturer', comp.manufacturer || ''], ['LCSC', comp.lcsc || '']];
      if (part.role === 'hole') props.length = 1;
      const pobj = {};
      for (const [k, v] of props) if (v && v !== '~') pobj[k] = String(v);
      const rec = { r: part.ref, v: value, fp: g.name, lib: g.lib, s: 0, x, y, a, k: g.attr === 'smd' ? 'smd' : g.attr === 'through_hole' ? 'th' : '', b: body, bs: 'fab', pads: padIds };
      if (hull.length) rec.c = hull.flat().map(R);
      if (comp.dnp) rec.dnp = 1;
      if (g.attr === 'exclude') rec.nb = 1;
      if (g.model) rec.m = g.name + '.wrl';
      if (g.descr) rec.d = g.descr.slice(0, 160);
      if (Object.keys(pobj).length) rec.p = pobj;
      const z = classify(rec);
      rec.z = [z[0], z[1], z[2]];
      fps.push(rec);
      K.props = props; K.rec = rec; K.path = schUuid.get(part.ref) || null;
      kfps.push(K);
    }
    // board title in a free margin strip
    if (title) {
      const occ = all.filter((p) => p.occ).map((p) => p.occ.box).concat(holes.map((h) => [h.x - 3.45, h.y - 3.45, h.x + 3.45, h.y + 3.45]));
      let placedTitle = false;
      for (const size of [0.8, 0.6]) {
        for (const yy of [BB[3] - 1.25, BB[1] + 1.25]) {
          const hl = holes.filter((h) => Math.abs(h.y - yy) < 4);
          const xl = BB[0] + 1.5 + (hl.some((h) => h.x < (BB[0] + BB[2]) / 2) ? 6.5 : 0);
          const xr = BB[2] - 1.5 - (hl.some((h) => h.x > (BB[0] + BB[2]) / 2) ? 6.5 : 0);
          let txt = title;
          while (txt.length > 4 && textW(txt, size) > xr - xl) txt = txt.slice(0, -4).trimEnd() + '...';
          const box = [xl, yy - size / 2 - 0.1, xl + textW(txt, size), yy + size / 2 + 0.1];
          if (textW(txt, size) > xr - xl || occ.some((b) => hits(b, box, 0.2))) continue;
          G('F.SilkS').texts.push([txt, R(xl), R(yy), size, 0, 'l', 0, R(size * 0.15)]);
          ctx.titleText = [txt, R(xl), R(yy), size];
          placedTitle = true; break;
        }
        if (placedTitle) break;
      }
    }
    // outline: rectangle with r = 1 mm corners
    const r = 1, s45 = Math.SQRT1_2, [x0, y0, x1, y1] = BB;
    const arcs = [
      [[x1 - r, y0], [x1 - r + r * s45, y0 + r - r * s45], [x1, y0 + r]],
      [[x1, y1 - r], [x1 - r + r * s45, y1 - r + r * s45], [x1 - r, y1]],
      [[x0 + r, y1], [x0 + r - r * s45, y1 - r + r * s45], [x0, y1 - r]],
      [[x0, y0 + r], [x0 + r - r * s45, y0 + r - r * s45], [x0 + r, y0]],
    ].map((arc) => arc.map((pt) => [R(pt[0]), R(pt[1])])); // tessellate exactly what the file says
    const edgeLines = [[x0 + r, y0, x1 - r, y0], [x1, y0 + r, x1, y1 - r], [x1 - r, y1, x0 + r, y1], [x0, y1 - r, x0, y0 + r]];
    const EW = 0.05;
    const outer = [];
    for (const [s, m, e] of arcs) for (const pt of arcPoints(s, m, e)) outer.push(R(pt[0]), R(pt[1]));
    for (const l of edgeLines) G('Edge.Cuts').lines.push(R(l[0]), R(l[1]), R(l[2]), R(l[3]), EW);
    for (const [s, m, e] of arcs) { const ps = arcPoints(s, m, e); for (let i = 0; i + 1 < ps.length; i++) G('Edge.Cuts').lines.push(R(ps[i][0]), R(ps[i][1]), R(ps[i + 1][0]), R(ps[i + 1][1]), EW); }

    const nets = ctx.nets.map((n) => n.name);
    const pcb = {
      meta: { kicad: '20240108', gen: '8.0', thickness: 1.6, cu: ['F.Cu', 'B.Cu'], bbox: BB.slice(), w: R(x1 - x0), h: R(y1 - y0),
        mask: '#1f6b3a', maskName: 'Green', silk: '#f4f4f0', finish: hasl ? 'HASL (lead-free)' : 'ENIG', minTrack: 0.2, minDrill: 0.3, zonePts: [0, 0] },
      outline: { outer: [outer], holes: [] },
      nets, fps, pads, tracks: {}, vias: [], zones: [], zoneOutlines: [], gfx, trackLen: {},
      air: ratsnest(pads),
    };
    const power = ctx.nets.map((n, i) => (i && (n.power || n.ground) ? i : 0)).filter(Boolean);
    const kicadPcb = writeKicad({ pcb, kfps, nets, title, project, sheetfile, uuid, arcs, edgeLines, EW, hasl, opts, titleText: ctx.titleText });
    return { pcb, kicadPcb, warnings, power };
  }

  // ------------------------------------------------------------------------------------------ KiCad 8 writer
  function writeKicad(o) {
    const { kfps, nets, uuid } = o;
    const out = [];
    const L = (depth, s) => out.push('\t'.repeat(depth) + s);
    const stroke = (w, t) => '(stroke (width ' + fmt(w) + ') (type ' + (t || 'solid') + '))';
    const font = (size, th) => '(effects (font (size ' + fmt(size) + ' ' + fmt(size) + ') (thickness ' + fmt(th) + ')))';
    const date = o.opts.date || new Date().toISOString().slice(0, 10);
    L(0, '(kicad_pcb');
    L(1, '(version 20240108)');
    L(1, '(generator "noeti")');
    L(1, '(generator_version "8.0")');
    L(1, '(general (thickness 1.6) (legacy_teardrops no))');
    L(1, '(paper "A4")');
    L(1, '(title_block (title ' + q(o.title) + ') (date ' + q(date) + ') (rev "1") (company "") (comment 1 "Generated by KiLive: parts auto-placed, not routed"))');
    L(1, '(layers');
    for (const l of ['(0 "F.Cu" signal)', '(31 "B.Cu" signal)', '(32 "B.Adhes" user "B.Adhesive")', '(33 "F.Adhes" user "F.Adhesive")', '(34 "B.Paste" user)', '(35 "F.Paste" user)',
      '(36 "B.SilkS" user "B.Silkscreen")', '(37 "F.SilkS" user "F.Silkscreen")', '(38 "B.Mask" user)', '(39 "F.Mask" user)', '(40 "Dwgs.User" user "User.Drawings")',
      '(41 "Cmts.User" user "User.Comments")', '(42 "Eco1.User" user "User.Eco1")', '(43 "Eco2.User" user "User.Eco2")', '(44 "Edge.Cuts" user)', '(45 "Margin" user)',
      '(46 "B.CrtYd" user "B.Courtyard")', '(47 "F.CrtYd" user "F.Courtyard")', '(48 "B.Fab" user)', '(49 "F.Fab" user)']) L(2, l);
    L(1, ')');
    L(1, '(setup');
    L(2, '(stackup');
    L(3, '(layer "F.SilkS" (type "Top Silk Screen") (color "White"))');
    L(3, '(layer "F.Paste" (type "Top Solder Paste"))');
    L(3, '(layer "F.Mask" (type "Top Solder Mask") (color "Green") (thickness 0.01))');
    L(3, '(layer "F.Cu" (type "copper") (thickness 0.035))');
    L(3, '(layer "dielectric 1" (type "core") (thickness 1.51) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))');
    L(3, '(layer "B.Cu" (type "copper") (thickness 0.035))');
    L(3, '(layer "B.Mask" (type "Bottom Solder Mask") (color "Green") (thickness 0.01))');
    L(3, '(layer "B.Paste" (type "Bottom Solder Paste"))');
    L(3, '(layer "B.SilkS" (type "Bottom Silk Screen") (color "White"))');
    L(3, '(copper_finish ' + q(o.hasl ? 'HAL lead-free' : 'ENIG') + ')');
    L(3, '(dielectric_constraints no)');
    L(2, ')');
    L(2, '(pad_to_mask_clearance 0)');
    L(2, '(allow_soldermask_bridges_in_footprints no)');
    L(2, '(pcbplotparams');
    for (const l of ['(layerselection 0x00010fc_ffffffff)', '(plot_on_all_layers_selection 0x0000000_00000000)', '(disableapertmacros no)', '(usegerberextensions no)',
      '(usegerberattributes yes)', '(usegerberadvancedattributes yes)', '(creategerberjobfile yes)', '(dashed_line_dash_ratio 12.000000)', '(dashed_line_gap_ratio 3.000000)',
      '(svgprecision 4)', '(plotframeref no)', '(viasonmask no)', '(mode 1)', '(useauxorigin no)', '(hpglpennumber 1)', '(hpglpenspeed 20)', '(hpglpendiameter 15.000000)',
      '(pdf_front_fp_property_popups yes)', '(pdf_back_fp_property_popups yes)', '(dxfpolygonmode yes)', '(dxfimperialunits yes)', '(dxfusepcbnewfont yes)', '(psnegative no)',
      '(psa4output no)', '(plotreference yes)', '(plotvalue yes)', '(plotfptext yes)', '(plotinvisibletext no)', '(sketchpadsonfab no)', '(subtractmaskfromsilk no)',
      '(outputformat 1)', '(mirror no)', '(drillshape 1)', '(scaleselection 1)', '(outputdirectory "")']) L(3, l);
    L(2, ')');
    L(1, ')');
    nets.forEach((n, i) => L(1, '(net ' + i + ' ' + q(n) + ')'));
    for (const K of kfps) {
      const { part, g, a } = K;
      const loc = (wx, wy) => rot(wx - part.x, wy - part.y, -a);
      L(1, '(footprint ' + q(g.id));
      L(2, '(layer "F.Cu")');
      L(2, '(uuid ' + q(uuid()) + ')');
      L(2, '(at ' + fmt(part.x) + ' ' + fmt(part.y) + (a ? ' ' + a : '') + ')');
      if (g.descr) L(2, '(descr ' + q(g.descr) + ')');
      if (g.tags) L(2, '(tags ' + q(g.tags) + ')');
      const rp = K.texts.refPos ? loc(K.texts.refPos[0], K.texts.refPos[1]) : [0, g.courtyard[1] - 0.8];
      L(2, '(property "Reference" ' + q(part.ref) + ' (at ' + fmt(rp[0]) + ' ' + fmt(rp[1]) + ' 0) (layer "F.SilkS")' + (K.texts.refPos ? '' : ' (hide yes)') + ' (uuid ' + q(uuid()) + ') ' + font(REF_SIZE, REF_THICK) + ')');
      L(2, '(property "Value" ' + q(K.texts.value) + ' (at ' + fmt(K.texts.vloc[0]) + ' ' + fmt(K.texts.vloc[1]) + ' ' + a + ') (layer "F.Fab") (uuid ' + q(uuid()) + ') ' + font(K.texts.vs, K.texts.vs * 0.15) + ')');
      L(2, '(property "Footprint" ' + q(g.id) + ' (at 0 0 ' + a + ') (unlocked yes) (layer "F.Fab") (hide yes) (uuid ' + q(uuid()) + ') ' + font(1.27, 0.15) + ')');
      for (const [k, v] of K.props) L(2, '(property ' + q(k) + ' ' + q(v) + ' (at 0 0 ' + a + ') (unlocked yes) (layer "F.Fab") (hide yes) (uuid ' + q(uuid()) + ') ' + font(1.27, 0.15) + ')');
      if (K.path) { L(2, '(path ' + q('/' + K.path) + ')'); L(2, '(sheetname "Root")'); L(2, '(sheetfile ' + q(o.sheetfile) + ')'); }
      const attr = g.attr === 'exclude' ? 'exclude_from_pos_files exclude_from_bom' : g.attr;
      L(2, '(attr ' + attr + (part.comp && part.comp.dnp ? ' dnp' : '') + ')');
      for (const [Ly, s, w] of K.lines) L(2, '(fp_line (start ' + fmt(s[0]) + ' ' + fmt(s[1]) + ') (end ' + fmt(s[2]) + ' ' + fmt(s[3]) + ') ' + stroke(w) + ' (layer ' + q(Ly) + ') (uuid ' + q(uuid()) + '))');
      for (const [Ly, c, w, filled] of K.circles) L(2, '(fp_circle (center ' + fmt(c[0]) + ' ' + fmt(c[1]) + ') (end ' + fmt(c[0] + c[2]) + ' ' + fmt(c[1]) + ') ' + stroke(w) + ' (fill ' + (filled ? 'solid' : 'none') + ') (layer ' + q(Ly) + ') (uuid ' + q(uuid()) + '))');
      L(2, '(fp_text user "${REFERENCE}" (at ' + fmt(K.texts.fabLocal[0]) + ' ' + fmt(K.texts.fabLocal[1]) + ' ' + a + ') (layer "F.Fab") (uuid ' + q(uuid()) + ') ' + font(K.texts.fs, K.texts.fs * 0.15) + ')');
      for (const { p, ni, ls, fn, pt } of K.pads) {
        const pa = normAngle(a + p.angle);
        let s = '(pad ' + q(p.num) + ' ' + p.type + ' ' + p.shape + ' (at ' + fmt(p.x) + ' ' + fmt(p.y) + (pa ? ' ' + pa : '') + ') (size ' + fmt(p.w) + ' ' + fmt(p.h) + ')';
        if (p.drill) s += ' (drill ' + fmt(p.drill) + ')';
        s += ' (layers ' + ls.map(q).join(' ') + ')';
        if (p.type === 'thru_hole') s += ' (remove_unused_layers no)';
        if (p.shape === 'roundrect') s += ' (roundrect_rratio ' + fmt(p.rr) + ')';
        if (ni) s += ' (net ' + ni + ' ' + q(nets[ni]) + ')';
        if (fn) s += ' (pinfunction ' + q(fn) + ')';
        if (pt) s += ' (pintype ' + q(pt) + ')';
        s += ' (uuid ' + q(uuid()) + '))';
        L(2, s);
      }
      if (g.model && g.lib) L(2, '(model ' + q(MODEL_DIR + '/' + g.lib + '.3dshapes/' + g.name + '.wrl') + ' (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))');
      L(1, ')');
    }
    for (const l of o.edgeLines) L(1, '(gr_line (start ' + fmt(l[0]) + ' ' + fmt(l[1]) + ') (end ' + fmt(l[2]) + ' ' + fmt(l[3]) + ') ' + stroke(o.EW, 'default') + ' (layer "Edge.Cuts") (uuid ' + q(uuid()) + '))');
    for (const [s, m, e] of o.arcs) L(1, '(gr_arc (start ' + fmt(s[0]) + ' ' + fmt(s[1]) + ') (mid ' + fmt(m[0]) + ' ' + fmt(m[1]) + ') (end ' + fmt(e[0]) + ' ' + fmt(e[1]) + ') ' + stroke(o.EW, 'default') + ' (layer "Edge.Cuts") (uuid ' + q(uuid()) + '))');
    if (o.titleText) {
      const [txt, x, y, size] = o.titleText;
      L(1, '(gr_text ' + q(txt) + ' (at ' + fmt(x) + ' ' + fmt(y) + ' 0) (layer "F.SilkS") (uuid ' + q(uuid()) + ') (effects (font (size ' + fmt(size) + ' ' + fmt(size) + ') (thickness ' + fmt(size * 0.15) + ')) (justify left)))');
    }
    L(0, ')');
    return out.join('\n') + '\n';
  }

  N.layoutgen = { footprint, generate, classify, version: 1, _internal: { parseFootprint, placeholder, convexHull, arcPoints, rot } };
})(typeof window !== 'undefined' ? window : globalThis);

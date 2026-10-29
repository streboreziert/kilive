/* KiLive — what changed between two versions of a board: parts, connections, nets, checks, the board itself */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;

  const short = n => (N.fmt && N.fmt.shortNet ? N.fmt.shortNet(n || '') : String(n || '').split('/').pop());
  const auto = n => /^(Net-\(|unconnected-|N\$|\$)/i.test(String(n || '').split('/').pop());

  function index(d) {
    const pcb = d.pcb, nets = pcb.nets || [];
    const fps = new Map();
    pcb.fps.forEach(f => { if (f.r && !/^#/.test(f.r) && !fps.has(f.r)) fps.set(f.r, f); });
    // pin -> net name, net name -> pins (pins as REF.NUMBER; a pad number used twice in one part is one pin)
    const pinNet = new Map(), netPins = new Map();
    for (const p of pcb.pads) {
      const f = pcb.fps[p[0]];
      if (!f || !f.r || /^#/.test(f.r) || p[1] === '' || p[1] == null || !p[10]) continue;
      const k = f.r + '.' + p[1], nm = nets[p[10]] || '';
      if (pinNet.has(k)) continue;
      pinNet.set(k, nm);
      let s = netPins.get(nm); if (!s) netPins.set(nm, (s = new Set())); s.add(k);
    }
    let len = 0, segs = 0;
    for (const L in pcb.tracks || {}) { const a = pcb.tracks[L]; for (let k = 0; k + 5 < a.length; k += 6) { len += Math.hypot(a[k + 2] - a[k], a[k + 3] - a[k + 1]); segs++; } }
    const bb = pcb.meta && pcb.meta.bbox ? pcb.meta.bbox : [0, 0, 0, 0];
    const checks = new Map((d.checks || []).map(c => [c.id, c]));
    return { fps, pinNet, netPins, len, segs, vias: (pcb.vias || []).length, w: bb[2] - bb[0], h: bb[3] - bb[1], layers: (pcb.meta.cu || []).length, checks };
  }

  /** a = before, b = after (board data as stored) */
  N.boardDiff = function (a, b) {
    const A = index(a), B = index(b);
    const added = [], removed = [], changed = [], moved = [];
    for (const [r, f] of B.fps) if (!A.fps.has(r)) added.push({ ref: r, v: f.v, fp: f.fp });
    for (const [r, f] of A.fps) {
      const g = B.fps.get(r);
      if (!g) { removed.push({ ref: r, v: f.v, fp: f.fp }); continue; }
      const what = [];
      if (String(f.v || '') !== String(g.v || '')) what.push(['value', f.v, g.v]);
      if (String(f.fp || '') !== String(g.fp || '')) what.push(['footprint', f.fp, g.fp]);
      if (!!f.dnp !== !!g.dnp) what.push(['fitted', f.dnp ? 'not fitted' : 'fitted', g.dnp ? 'not fitted' : 'fitted']);
      if ((f.s || 0) !== (g.s || 0)) what.push(['side', f.s ? 'bottom' : 'top', g.s ? 'bottom' : 'top']);
      if (what.length) changed.push({ ref: r, v: g.v, what });
      const dd = Math.hypot((g.x || 0) - (f.x || 0), (g.y || 0) - (f.y || 0)), da = Math.abs((((g.a || 0) - (f.a || 0)) % 360 + 540) % 360 - 180);
      if (dd > 0.05 || da > 0.5) moved.push({ ref: r, d: dd, a: da });
    }
    // connections: a pin whose set of neighbours (among pins both versions have) is different
    const common = new Set([...A.pinNet.keys()].filter(k => B.pinNet.has(k)));
    const sig = (I, nm) => { const s = I.netPins.get(nm); return s ? [...s].filter(k => common.has(k)).sort().join(',') : ''; };
    const sa = new Map(), sb = new Map();
    const conn = [];
    for (const k of common) {
      const na = A.pinNet.get(k), nb = B.pinNet.get(k);
      let x = sa.get(na); if (x === undefined) sa.set(na, (x = sig(A, na)));
      let y = sb.get(nb); if (y === undefined) sb.set(nb, (y = sig(B, nb)));
      if (x !== y) conn.push({ pin: k, from: na, to: nb });
    }
    // nets by name (auto-named nets follow their pins, so only named ones count)
    const named = I => new Set([...I.netPins.keys()].filter(n => n && !auto(n)));
    const nA = named(A), nB = named(B);
    const netsAdded = [...nB].filter(n => !nA.has(n)).map(short), netsRemoved = [...nA].filter(n => !nB.has(n)).map(short);
    // checks that changed their verdict
    const checks = [];
    for (const [id, c] of B.checks) { const o = A.checks.get(id); if (!o || o.status !== c.status) checks.push({ id, title: c.title || c.name || id, from: o ? o.status : 'new', to: c.status }); }
    for (const [id, c] of A.checks) if (!B.checks.has(id)) checks.push({ id, title: c.title || c.name || id, from: c.status, to: 'gone' });
    const board = [];
    const num = (x, d) => (+x).toFixed(d);
    if (Math.abs(A.w - B.w) > 0.05 || Math.abs(A.h - B.h) > 0.05) board.push(['size', num(A.w, 1) + ' × ' + num(A.h, 1) + ' mm', num(B.w, 1) + ' × ' + num(B.h, 1) + ' mm']);
    if (A.layers !== B.layers) board.push(['copper layers', A.layers, B.layers]);
    if (Math.abs(A.len - B.len) > 0.5 || A.segs !== B.segs) board.push(['tracks', Math.round(A.len) + ' mm in ' + A.segs + ' pieces', Math.round(B.len) + ' mm in ' + B.segs + ' pieces']);
    if (A.vias !== B.vias) board.push(['vias', A.vias, B.vias]);
    const sortRef = (p, q) => String(p.ref || p.pin).localeCompare(String(q.ref || q.pin), undefined, { numeric: true });
    [added, removed, changed, moved, conn].forEach(l => l.sort(sortRef));
    const n = added.length + removed.length + changed.length + conn.length + netsAdded.length + netsRemoved.length + checks.length + board.length + (moved.length ? 1 : 0);
    return { added, removed, changed, moved, conn, netsAdded, netsRemoved, checks, board, count: n, parts: [A.fps.size, B.fps.size] };
  };

  N.diffSummary = function (d) {
    if (!d.count) return 'nothing changed';
    const bits = [];
    if (d.added.length) bits.push(d.added.length + ' part' + (d.added.length > 1 ? 's' : '') + ' added');
    if (d.removed.length) bits.push(d.removed.length + ' removed');
    if (d.changed.length) bits.push(d.changed.length + ' changed');
    if (d.conn.length) bits.push(d.conn.length + ' pin' + (d.conn.length > 1 ? 's' : '') + ' rewired');
    if (d.moved.length) bits.push(d.moved.length + ' moved');
    const worse = d.checks.filter(c => c.to === 'fail').length, better = d.checks.filter(c => c.from === 'fail' && c.to !== 'fail').length;
    if (worse) bits.push(worse + ' check' + (worse > 1 ? 's' : '') + ' now failing');
    if (better) bits.push(better + ' fixed');
    if (!bits.length && d.board.length) bits.push('layout changed');
    return bits.join(' · ');
  };

  /** opts: { title, from, to, onPick(ref) } */
  N.showBoardDiff = function (d, opts) {
    opts = opts || {};
    const pick = r => el('button', { class: 'linkish mono df-ref', title: 'Show ' + r + ' on the board', onclick: () => { if (opts.onPick) { m.close(); opts.onPick(r); } } }, r);
    const LIM = 120;
    const sec = (title, n, rows, open) => n ? el('details', { class: 'df-sec', open: open || null }, el('summary', null, el('b', null, title), el('span', { class: 'muted' }, ' ' + n)),
      el('div', { class: 'df-rows' }, rows.slice(0, LIM), n > LIM ? el('div', { class: 'muted small' }, '… and ' + (n - LIM) + ' more') : null)) : null;
    const row = (...kids) => el('div', { class: 'df-row' }, ...kids);
    const was = (a, b) => el('span', { class: 'df-was' }, el('s', { class: 'muted' }, String(a == null ? '—' : a)), ' → ', el('span', null, String(b == null ? '—' : b)));
    const verdict = s => el('span', { class: 'df-v ' + (s === 'fail' ? 'bad' : s === 'pass' ? 'good' : s === 'warn' ? 'warn' : '') }, s);
    const body = el('div', { class: 'df' },
      el('p', { class: 'df-head' }, opts.from ? el('span', { class: 'muted' }, opts.from + ' → ' + (opts.to || 'now') + ': ') : null, el('b', null, N.diffSummary(d))),
      d.count ? null : el('p', { class: 'muted' }, 'The parts, connections, checks and layout are the same.'),
      sec('Checks', d.checks.length, d.checks.map(c => row(el('span', null, c.title), el('span', { class: 'df-was' }, verdict(c.from), ' → ', verdict(c.to)))), true),
      sec('Parts added', d.added.length, d.added.map(p => row(pick(p.ref), el('span', null, p.v || ''), el('span', { class: 'muted small mono' }, String(p.fp || '').split(':').pop()))), true),
      sec('Parts removed', d.removed.length, d.removed.map(p => row(el('span', { class: 'mono' }, p.ref), el('span', null, p.v || ''), el('span', { class: 'muted small mono' }, String(p.fp || '').split(':').pop()))), true),
      sec('Parts changed', d.changed.length, d.changed.map(p => row(pick(p.ref), el('span', null, p.what.map(([k, a, b]) => el('span', { class: 'df-chg' }, el('span', { class: 'muted' }, k + ' '), was(k === 'footprint' ? String(a || '').split(':').pop() : a, k === 'footprint' ? String(b || '').split(':').pop() : b)))))), true),
      sec('Rewired pins', d.conn.length, d.conn.map(c => row(pick(c.pin.split('.')[0]), el('span', { class: 'mono small' }, c.pin), was(short(c.from) || 'not connected', short(c.to) || 'not connected'))), d.conn.length < 30),
      sec('Nets', d.netsAdded.length + d.netsRemoved.length, d.netsAdded.map(n => row(el('span', { class: 'df-plus' }, '+'), el('span', { class: 'mono' }, n))).concat(d.netsRemoved.map(n => row(el('span', { class: 'df-minus' }, '−'), el('span', { class: 'mono' }, n)))), false),
      sec('Moved or turned', d.moved.length, d.moved.map(p => row(pick(p.ref), el('span', { class: 'muted small' }, (p.d > 0.05 ? p.d.toFixed(2) + ' mm' : '') + (p.a > 0.5 ? (p.d > 0.05 ? ', ' : '') + Math.round(p.a) + '°' : '')))), false),
      sec('Board', d.board.length, d.board.map(([k, a, b]) => row(el('span', null, k), was(a, b))), true));
    const m = N.modal(opts.title || 'What changed', body, [el('button', { class: 'btn primary', onclick: () => m.close() }, 'Done')]);
    m.el.classList.add('me-wide');
    return m;
  };
})();

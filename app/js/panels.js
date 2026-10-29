/* KiLive — BOM, Checks and Files panels */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const I = N.icons;

  const STATUS = {
    pass: { label: 'Pass', cls: 'pass' }, warn: { label: 'Review', cls: 'warn' }, fail: { label: 'Fail', cls: 'fail' }, info: { label: 'Info', cls: 'info' },
  };

  function pill(status, text) {
    const s = STATUS[status] || STATUS.info;
    return el('span', { class: 'pill ' + s.cls }, el('span', { class: 'dot' }), text || s.label);
  }
  N.statusPill = pill;

  // ------------------------------------------------------------------ exports
  N.exporters = {
    bom(B) {
      const rows = [['Line', 'Qty', 'References', 'Value', 'Footprint', 'Manufacturer', 'MPN', 'Description', 'DNP']];
      B.bom.forEach((l, i) => rows.push([i + 1, l.q, l.refs.join(' '), l.v, l.fp, l.mfr, l.mpn || Object.values(l.src || {})[0] || '', l.desc, l.dnp ? 'DNP' : '']));
      return N.csv(rows);
    },
    pnp(B) {
      const rows = [['Designator', 'Value', 'Footprint', 'Mid X (mm)', 'Mid Y (mm)', 'Rotation', 'Layer']];
      const [x0, , , y1] = B.bbox;
      for (const f of B.fps) {
        if (f.bo || !f.z || f.z[0] === 'none') continue;
        rows.push([f.r, f.v, f.fp, (f.x - x0).toFixed(3), (y1 - f.y).toFixed(3), f.a, f.s ? 'Bottom' : 'Top']);
      }
      return N.csv(rows);
    },
    netlist(B) {
      const rows = [['Net', 'Reference', 'Pin', 'Pin function', 'Pin type']];
      const nets = [...B.padsByNet.keys()].sort((a, b) => (B.nets[a] < B.nets[b] ? -1 : 1));
      for (const n of nets) for (const pi of B.padsByNet.get(n)) {
        const p = B.pads[pi];
        rows.push([B.nets[n], B.fps[p[0]].r, p[1], p[14], p[15]]);
      }
      return N.csv(rows);
    },
  };

  N.saveFile = async function (filename, text, onCounted) {
    const dl = await N.caps.use('downloads');
    if (dl) {
      try {
        await dl.save({ filename, data: text });
        N.toast('Saved ' + filename);
        onCounted && onCounted();
        return;
      } catch (e) {
        if (e && (e.code === 'cancelled' || e.code === 'declined' || e.code === 'user_declined')) return;
      }
    }
    if (typeof text !== 'string') { N.toast('Saving files is not available in this view. Open the page in Claude to download ' + filename + '.', 'warn'); return; }
    const ok = await N.copyText(text);
    N.toast(ok ? `Copied ${filename} to the clipboard (file saving is not available here)` : 'Could not save the file in this view', ok ? '' : 'warn');
    if (ok) onCounted && onCounted();
  };

  // ------------------------------------------------------------------ BOM
  N.renderBOM = function (host, ctx) {
    const B = ctx.B;
    host.innerHTML = '';
    const lines = B.bom;
    const parts = lines.reduce((a, l) => a + l.q, 0);
    const smd = lines.filter(l => l.smd).reduce((a, l) => a + l.q, 0);
    const dnp = lines.filter(l => l.dnp).reduce((a, l) => a + l.q, 0);
    const sourced = lines.filter(l => Object.keys(l.src || {}).length).length;
    const state = { q: '', grouped: true, sort: null, dir: 1 };
    const head = el('div', { class: 'panel-head' },
      el('div', { class: 'stat-row' },
        stat(lines.length, 'BOM lines'), stat(parts, 'placements'), stat(smd, 'SMD'), stat(parts - smd, 'THT / other'), stat(dnp, 'DNP'),
        stat(lines.length ? Math.round(100 * sourced / lines.length) + '%' : '—', 'with part numbers')),
    );
    const search = el('input', { class: 'input', type: 'search', id: 'bom-search', placeholder: 'Filter by reference, value, MPN…', 'aria-label': 'Filter BOM' });
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'BOM layout' },
      el('button', { class: 'active', onclick: e => setGroup(true, e.currentTarget) }, 'Grouped'),
      el('button', { onclick: e => setGroup(false, e.currentTarget) }, 'Per part'));
    const tools = el('div', { class: 'panel-tools' }, el('div', { class: 'search-wrap' }, N.svg(I.search), search), seg);
    if (ctx.versions && ctx.versions.length > 1) {
      tools.append(el('button', { class: 'btn ghost', onclick: e => compareMenu(e.currentTarget) }, N.svg(I.compare), 'Compare revisions'));
    }
    tools.append(el('button', { class: 'btn ghost', onclick: () => N.saveFile(`${ctx.fileBase}-bom.csv`, N.exporters.bom(B), ctx.onDownload) }, N.svg(I.download), 'Export CSV'));
    const tableWrap = el('div', { class: 'table-wrap scroll' });
    const diffHost = el('div', { class: 'diff-host' });
    host.append(head, tools, diffHost, tableWrap);
    search.addEventListener('input', N.debounce(() => { state.q = search.value.trim().toLowerCase(); draw(); }, 120));

    function setGroup(g, btn) {
      state.grouped = g;
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      draw();
    }
    function stat(v, label) { return el('div', { class: 'stat' }, el('div', { class: 'stat-v' }, typeof v === 'number' ? N.fmt.num(v) : v), el('div', { class: 'stat-l' }, label)); }

    function rowsData() {
      let rows;
      if (state.grouped) rows = lines.map((l, i) => ({ i: i + 1, q: l.q, refs: l.refs, v: l.v, fp: l.fp, mfr: l.mfr, mpn: l.mpn || Object.values(l.src || {})[0] || '', desc: l.desc, dnp: l.dnp, ds: l.ds }));
      else {
        rows = [];
        lines.forEach(l => l.refs.forEach(r => rows.push({ i: 0, q: 1, refs: [r], v: l.v, fp: l.fp, mfr: l.mfr, mpn: l.mpn || Object.values(l.src || {})[0] || '', desc: l.desc, dnp: l.dnp, ds: l.ds })));
        rows.sort((a, b) => N.refCmp(a.refs[0], b.refs[0]));
        rows.forEach((r, i) => (r.i = i + 1));
      }
      if (state.q) rows = rows.filter(r => [r.refs.join(' '), r.v, r.fp, r.mfr, r.mpn, r.desc].join(' ').toLowerCase().includes(state.q));
      if (state.sort) {
        const k = state.sort;
        rows.sort((a, b) => {
          const x = k === 'refs' ? a.refs[0] : a[k], y = k === 'refs' ? b.refs[0] : b[k];
          if (k === 'refs') return N.refCmp(x, y) * state.dir;
          return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * state.dir;
        });
      }
      return rows;
    }
    function draw() {
      const rows = rowsData();
      const cols = [['i', '#'], ['q', 'Qty'], ['refs', 'References'], ['v', 'Value'], ['fp', 'Footprint'], ['mpn', 'Manufacturer part'], ['desc', 'Description']];
      const thead = el('thead', null, el('tr', null, cols.map(([k, t]) => el('th', {
        class: 'sortable' + (state.sort === k ? ' sorted' : ''), scope: 'col', tabindex: '0',
        'aria-sort': state.sort === k ? (state.dir > 0 ? 'ascending' : 'descending') : 'none',
        onclick: () => { state.dir = state.sort === k ? -state.dir : 1; state.sort = k; draw(); },
        onkeydown: e => { if (e.key === 'Enter') e.currentTarget.click(); },
      }, t)), el('th', { scope: 'col' }, el('span', { class: 'sr' }, 'Actions'))));
      const tbody = el('tbody');
      const sel = ctx.getSelection();
      for (const r of rows.slice(0, 1500)) {
        const selected = r.refs.some(x => sel.refs.has(x));
        const tr = el('tr', { class: (selected ? 'selected ' : '') + (r.dnp ? 'dnp' : ''), onclick: () => ctx.onSelect(r.refs) },
          el('td', { class: 'num' }, r.i),
          el('td', { class: 'num' }, r.q),
          el('td', { class: 'refs' }, refList(r.refs)),
          el('td', null, el('span', { class: 'val' }, r.v), r.dnp ? el('span', { class: 'tag muted' }, 'DNP') : null),
          el('td', { class: 'mono small' }, r.fp),
          el('td', null, r.mpn ? el('div', { class: 'mpn' }, el('span', { class: 'mono' }, r.mpn), r.mfr ? el('span', { class: 'muted small' }, r.mfr) : null) : el('span', { class: 'missing' }, 'none')),
          el('td', { class: 'desc', title: r.desc || '' }, el('div', { class: 'desc-t' }, r.desc || ''), r.ds && /^https?:/.test(r.ds) ? el('a', { href: r.ds, target: '_blank', rel: 'noopener', class: 'ds', onclick: e => e.stopPropagation() }, 'datasheet') : null),
          el('td', { class: 'act' }, el('button', { class: 'icon-btn', title: 'Show on PCB', 'aria-label': 'Show ' + r.refs.slice(0, 3).join(', ') + ' on PCB', onclick: e => { e.stopPropagation(); ctx.onLocate(r.refs); } }, N.svg(I.target))),
        );
        tbody.append(tr);
      }
      tableWrap.innerHTML = '';
      tableWrap.append(el('table', { class: 'data bom' }, thead, tbody));
      if (!rows.length) tableWrap.append(el('div', { class: 'empty-note' }, 'No parts match that filter.'));
    }
    function refList(refs) {
      const shown = refs.slice(0, 14);
      return el('span', { class: 'mono' }, shown.join(', '), refs.length > 14 ? el('span', { class: 'muted' }, ` +${refs.length - 14}`) : null);
    }
    function compareMenu(btn) {
      N.menu(btn, ctx.versions.filter(v => v.id !== ctx.version.id).map(v => ({ label: v.label, onClick: () => runCompare(v) })), {});
    }
    async function runCompare(v) {
      diffHost.innerHTML = '';
      diffHost.append(el('div', { class: 'loading-line' }, 'Loading ' + v.label + '…'));
      try {
        const other = await N.loadJSON(v.file);
        const a = new Map(), b = new Map();
        for (const f of other.pcb.fps) if (f.r && !f.bo && f.z && f.z[0] !== 'none') a.set(f.r, f);
        for (const f of B.fps) if (f.r && !f.bo && f.z && f.z[0] !== 'none') b.set(f.r, f);
        const added = [...b.keys()].filter(r => !a.has(r)).sort(N.refCmp);
        const removed = [...a.keys()].filter(r => !b.has(r)).sort(N.refCmp);
        const changed = [...b.keys()].filter(r => a.has(r) && (a.get(r).v !== b.get(r).v || a.get(r).fp !== b.get(r).fp)).sort(N.refCmp);
        const netsA = new Set(other.pcb.nets.map(N.fmt.shortNet)), netsB = new Set(B.nets.map(N.fmt.shortNet));
        const netAdd = [...netsB].filter(n => n && !netsA.has(n) && !/^(Net-|unconnected)/.test(n));
        const netDel = [...netsA].filter(n => n && !netsB.has(n) && !/^(Net-|unconnected)/.test(n));
        diffHost.innerHTML = '';
        const card = el('div', { class: 'diff card-inset' },
          el('div', { class: 'diff-head' }, el('strong', null, `${ctx.version.label} compared with ${v.label}`),
            el('button', { class: 'icon-btn', 'aria-label': 'Close comparison', onclick: () => (diffHost.innerHTML = '') }, N.svg(I.close))),
          el('div', { class: 'diff-grid' },
            diffCol('Added parts', added.map(r => `${r} · ${b.get(r).v}`), 'pass', added),
            diffCol('Removed parts', removed.map(r => `${r} · ${a.get(r).v}`), 'fail', []),
            diffCol('Changed value or footprint', changed.map(r => `${r}: ${a.get(r).v} → ${b.get(r).v}${a.get(r).fp !== b.get(r).fp ? ' (' + b.get(r).fp + ')' : ''}`), 'warn', changed),
            diffCol('Named nets added / removed', netAdd.map(n => '+ ' + n).concat(netDel.map(n => '− ' + n)), 'info', [])));
        diffHost.append(card);
      } catch (e) {
        diffHost.innerHTML = '';
        diffHost.append(el('div', { class: 'empty-note' }, 'Could not load that revision: ' + e.message));
      }
    }
    function diffCol(title, items, kind, refs) {
      return el('div', { class: 'diff-col' },
        el('div', { class: 'diff-title' }, pill(kind, String(items.length)), title),
        el('ul', { class: 'diff-list' }, items.slice(0, 80).map((t, i) => el('li', null, refs[i] ? el('button', { class: 'linkish', onclick: () => ctx.onLocate([refs[i]]) }, t) : t)),
          items.length > 80 ? el('li', { class: 'muted' }, `+${items.length - 80} more`) : null, !items.length ? el('li', { class: 'muted' }, 'None') : null));
    }
    draw();
    return { redraw: draw };
  };

  // ------------------------------------------------------------------ Checks
  N.renderChecks = function (host, ctx) {
    const B = ctx.B;
    host.innerHTML = '';
    const checks = B.checks;
    const count = s => checks.filter(c => c.status === s).length;
    const score = id => { const c = checks.find(x => x.id === id); return c && c.score != null ? c.score : null; };
    const readiness = [
      ['Test points on rails', score('testpoints'), 'Supply rails you can probe without lifting a part'],
      ['Named nets', score('naming'), 'Nets you can find by name in the schematic and layout'],
      ['Orderable parts', score('sourcing'), 'BOM lines with a manufacturer or supplier number'],
    ];
    const head = el('div', { class: 'checks-head' },
      el('div', { class: 'checks-summary' },
        el('div', { class: 'big-counts' },
          count('fail') ? el('div', { class: 'bc fail' }, el('b', null, count('fail')), 'failing') : null,
          el('div', { class: 'bc warn' }, el('b', null, count('warn')), 'to review'),
          el('div', { class: 'bc pass' }, el('b', null, count('pass')), 'passing'),
          count('info') ? el('div', { class: 'bc info' }, el('b', null, count('info')), 'notes') : null),
        el('p', { class: 'muted small' }, `${checks.length} checks ran on ${ctx.repo.user ? (ctx.repo.kind === 'design' ? 'the KiCad project generated from this drawing' : 'the uploaded KiCad files') : 'the KiCad files pulled from GitHub'}. They approximate KiCad DRC and ERC and add rules that matter when you are bringing a board up or chasing a fault.`)),
      el('div', { class: 'readiness' },
        el('div', { class: 'readiness-title' }, N.svg(I.probe), 'Debug readiness'),
        readiness.map(([t, v, hint]) => el('div', { class: 'meter', title: hint },
          el('div', { class: 'meter-top' }, el('span', null, t), el('b', { class: 'num' }, v == null ? '—' : v + '%')),
          el('div', { class: 'meter-bar', role: 'meter', 'aria-valuenow': v || 0, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': t },
            el('span', { style: { width: (v || 0) + '%' }, class: v >= 80 ? 'good' : v >= 40 ? 'mid' : 'low' }))))),
    );
    host.append(head);
    // what needs a look first (failing, to review, notes), each under its category; the passing ones folded away below
    const order = { fail: 0, warn: 1, info: 2, pass: 3 };
    const byCat = items => {
      const out = [];
      for (const cat of [...new Set(items.map(c => c.cat))]) {
        out.push(el('h3', { class: 'check-cat' }, cat));
        for (const c of items.filter(x => x.cat === cat).sort((a, b) => order[a.status] - order[b.status])) out.push(checkRow(c));
      }
      return out;
    };
    const list = el('div', { class: 'check-list' });
    const open = checks.filter(c => c.status !== 'pass'), passed = checks.filter(c => c.status === 'pass');
    if (open.length) list.append(...byCat(open));
    else list.append(el('p', { class: 'checks-clean' }, N.svg(I.checks), 'Every check passes on this board.'));
    if (passed.length) {
      const d = el('details', { class: 'check-passed' }, el('summary', null, N.svg(I.chevron, 'chev'), el('span', null, `${passed.length} passing check${passed.length > 1 ? 's' : ''}`), el('span', { class: 'muted small' }, 'nothing to do here')));
      d.append(...byCat(passed));
      list.append(d);
    }
    host.append(list);

    function checkRow(c) {
      const open = c.status === 'fail';
      if (!c.items.length && c.status === 'pass') {
        return el('div', { class: 'check static ' + c.status }, el('div', { class: 'check-sumrow' }, pill(c.status),
          el('div', { class: 'check-main' }, el('div', { class: 'check-title' }, c.title), el('div', { class: 'check-sum' }, c.summary))));
      }
      const det = el('details', { class: 'check ' + c.status, open: open || null });
      const sum = el('summary', null,
        pill(c.status),
        el('div', { class: 'check-main' }, el('div', { class: 'check-title' }, c.title), el('div', { class: 'check-sum' }, c.summary)),
        c.items.length ? el('span', { class: 'check-n num' }, c.items.length) : null,
        N.svg(I.chevron, 'chev'));
      det.append(sum);
      const body = el('div', { class: 'check-body' });
      if (c.items.length) {
        const ul = el('ul', { class: 'finding-list' });
        for (const it of c.items) {
          const canLocate = it.xy || (it.refs && it.refs.length) || (it.nets && it.nets.length) || it.sheet;
          ul.append(el('li', null,
            el('span', { class: 'finding-t' }, it.t),
            canLocate ? el('button', { class: 'btn tiny ghost', onclick: () => ctx.onFinding(it, c) }, N.svg(I.target), it.sheet ? 'Show in schematic' : 'Locate') : null));
        }
        body.append(ul);
      }
      det.append(body);
      return det;
    }
  };

  // ------------------------------------------------------------------ Files
  N.renderFiles = function (host, ctx) {
    const { repo, version, B } = ctx;
    host.innerHTML = '';
    const base = `${repo.url}/blob/${repo.branch}/`;
    const files = version.files || [];
    const tree = el('div', { class: 'files card-inset' },
      el('div', { class: 'files-head' }, N.svg(I.folder), el('span', { class: 'mono' }, version.folder || '/'), el('span', { class: 'muted small' }, `${files.length} files`)),
      el('ul', { class: 'file-list' }, files.map(([p, size]) => {
        const rel = version.folder ? p.slice(version.folder.length + 1) : p;
        const kind = /\.kicad_pcb$/.test(p) ? 'pcb' : /\.kicad_sch$/.test(p) ? 'sch' : /\.kicad_pro$/.test(p) ? 'pro' : /\.(step|stp|wrl)$/i.test(p) ? '3d' : /\.(pdf)$/i.test(p) ? 'pdf' : '';
        return el('li', null,
          el('a', { href: base + p.split('/').map(encodeURIComponent).join('/'), target: '_blank', rel: 'noopener', class: 'file-link' },
            N.svg(kind === 'pcb' ? I.pcb : kind === 'sch' ? I.sch : kind === '3d' ? I.cube : I.files), el('span', { class: 'mono' }, rel)),
          kind ? el('span', { class: 'tag' }, { pcb: 'layout', sch: 'schematic', pro: 'project', '3d': '3D model', pdf: 'PDF' }[kind]) : null,
          el('span', { class: 'muted small num' }, N.fmt.bytes(size)));
      })));
    const exportsCard = el('div', { class: 'exports card-inset' },
      el('div', { class: 'files-head' }, N.svg(I.download), 'Generated from this revision'),
      el('div', { class: 'export-grid' },
        exp('Bill of materials', 'CSV grouped by value and footprint', () => N.saveFile(`${ctx.fileBase}-bom.csv`, N.exporters.bom(B), ctx.onDownload)),
        exp('Pick and place', 'Centroids in mm from the lower-left corner', () => N.saveFile(`${ctx.fileBase}-pnp.csv`, N.exporters.pnp(B), ctx.onDownload)),
        exp('Netlist', 'Every pad with its net, pin function and type', () => N.saveFile(`${ctx.fileBase}-netlist.csv`, N.exporters.netlist(B), ctx.onDownload)),
        el('a', { class: 'export', href: `${repo.url}/archive/refs/heads/${repo.branch}.zip`, target: '_blank', rel: 'noopener' },
          el('b', null, 'Source archive'), el('span', { class: 'muted small' }, `${repo.owner}/${repo.name} · ${repo.branch}.zip on GitHub`))));
    const hist = el('div', { class: 'history card-inset' },
      el('div', { class: 'files-head' }, N.svg(I.history), 'Recent commits to this board'),
      el('ul', { class: 'commit-list' }, (version.history || []).map(c => el('li', null,
        el('a', { href: `${repo.url}/commit/${c.h}`, target: '_blank', rel: 'noopener', class: 'mono small' }, c.h),
        el('span', { class: 'commit-msg' }, c.m),
        el('span', { class: 'muted small' }, c.a + ' · ' + N.fmt.date(c.d))))));
    const readme = el('article', { class: 'readme card-inset' },
      el('div', { class: 'files-head' }, N.svg(I.files), 'README'),
      el('div', { class: 'md', html: repo.readme ? N.markdown(repo.readme, { base: `${repo.url}/blob/${repo.branch}/` }) : '<p class="muted">No README.</p>' }));
    host.append(el('div', { class: 'files-grid' }, el('div', { class: 'files-col' }, tree, exportsCard, hist), readme));
    function exp(title, sub, fn) {
      return el('button', { class: 'export', onclick: fn }, el('b', null, title), el('span', { class: 'muted small' }, sub));
    }
  };
})();

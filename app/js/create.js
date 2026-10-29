/* KiLive — create a board: draw it, or upload KiCad files */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const I = N.icons;
  const C = (N.create = {});
  const $ = (s, r) => (r || document).querySelector(s);

  I.plus = I.plus || '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';
  I.pen = I.pen || '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z"/><path d="M9.5 4l2.5 2.5"/></svg>';
  I.upload = I.upload || '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 11V3M4.5 6.2L8 2.7l3.5 3.5M2.5 13.5h11"/></svg>';
  I.doc = I.doc || '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3M6 8.5h4M6 11h4"/></svg>';

  // ------------------------------------------------------------------ modal helper
  N.modal = function (title, body, actions, opts) {
    document.querySelectorAll('.modal-wrap').forEach(m => m.remove());
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); opts && opts.onClose && opts.onClose(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    const dlg = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-h' },
      el('div', { class: 'modal-head' }, el('h2', { id: 'modal-h' }, title), el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, N.svg(I.close))),
      el('div', { class: 'modal-body' }, body),
      actions ? el('div', { class: 'modal-foot' }, actions) : null);
    const wrap = el('div', { class: 'modal-wrap', onclick: e => { if (e.target === wrap) close(); } }, dlg);
    document.body.append(wrap);
    document.addEventListener('keydown', onKey);
    const f = dlg.querySelector('input,textarea,select,button.primary');
    if (f) setTimeout(() => f.focus(), 30);
    return { close, el: dlg };
  };

  // ------------------------------------------------------------------ starter circuits for "Draw"
  const node = s => { const [ref, pin] = s.split('.'); return { ref, pin }; };
  const net = (name, kind, port, nodes) => ({ name, kind, port, nodes: nodes.map(node) });
  const P = (number, name, etype, side) => ({ number, name, etype, side });
  C.TEMPLATES = {
    led: {
      title: 'LED indicator', sub: 'resistor + LED on a 5 V header',
      circuit: { design: { title: 'LED indicator' }, components: [
        { ref: 'J1', type: 'connector', value: 'Power in', pins: [P('1', 'Pin_1', 'passive'), P('2', 'Pin_2', 'passive')] },
        { ref: 'R1', type: 'resistor', value: '330', package: '0603' }, { ref: 'D1', type: 'led', value: 'Red', package: '0603' }],
      nets: [net('+5V', 'power', 'input', ['J1.1', 'R1.1']), net('LED_A', 'signal', 'none', ['R1.2', 'D1.A']), net('GND', 'ground', 'none', ['D1.K', 'J1.2'])] },
      sim: { sources: [{ net: '+5V', kind: 'dc', value: 5 }], probes: ['+5V', 'LED_A'], tstop: 0.002 },
    },
    blinker: {
      title: '555 LED blinker', sub: 'astable NE555, about 1.5 Hz',
      circuit: { design: { title: '555 LED blinker' }, components: [
        { ref: 'U1', type: 'ic', value: 'NE555', mpn: 'NE555P', package: 'DIP-8', pins: [P('8', 'VCC', 'power_in', 'top'), P('4', 'R', 'input', 'top'), P('2', 'TR', 'input', 'left'), P('6', 'THR', 'input', 'left'), P('5', 'CV', 'input', 'left'), P('3', 'Q', 'output', 'right'), P('7', 'DIS', 'open_collector', 'right'), P('1', 'GND', 'power_in', 'bottom')] },
        { ref: 'R1', type: 'resistor', value: '1k' }, { ref: 'R2', type: 'resistor', value: '47k' }, { ref: 'C1', type: 'capacitor', value: '10uF', package: '0805' },
        { ref: 'C2', type: 'capacitor', value: '10nF' }, { ref: 'C3', type: 'capacitor', value: '100nF' }, { ref: 'R3', type: 'resistor', value: '470' }, { ref: 'D1', type: 'led', value: 'Green' },
        { ref: 'J1', type: 'connector', value: 'Power in', pins: [P('1', 'Pin_1', 'passive'), P('2', 'Pin_2', 'passive')] }],
      nets: [net('+5V', 'power', 'input', ['U1.8', 'U1.4', 'R1.1', 'C3.1', 'J1.1']), net('DIS', 'signal', 'none', ['U1.7', 'R1.2', 'R2.1']), net('TIMING', 'signal', 'none', ['U1.2', 'U1.6', 'R2.2', 'C1.1']),
        net('CV', 'signal', 'none', ['U1.5', 'C2.1']), net('OUT', 'signal', 'none', ['U1.3', 'R3.1']), net('LED', 'signal', 'none', ['R3.2', 'D1.A']),
        net('GND', 'ground', 'none', ['U1.1', 'C1.2', 'C2.2', 'C3.2', 'D1.K', 'J1.2'])] },
      sim: { sources: [{ net: '+5V', kind: 'dc', value: 5 }], chips: [{ ref: 'U1', model: '555', vcc: '8', gnd: '1', trig: '2', thr: '6', dis: '7', out: '3', cont: '5', reset: '4' }], probes: ['OUT', 'TIMING'], tstop: 2 },
    },
    ldo: {
      title: '3.3 V regulator', sub: 'AMS1117-3.3 from 5 V with a power LED',
      circuit: { design: { title: '3.3 V regulator' }, components: [
        { ref: 'J1', type: 'connector', value: '5 V in', pins: [P('1', 'Pin_1', 'passive'), P('2', 'Pin_2', 'passive')] },
        { ref: 'U1', type: 'ic', value: 'AMS1117-3.3', mpn: 'AMS1117-3.3', package: 'SOT-223', pins: [P('3', 'VIN', 'power_in', 'left'), P('2', 'VOUT', 'power_out', 'right'), P('1', 'GND/ADJ', 'power_in', 'bottom')] },
        { ref: 'C1', type: 'capacitor', value: '10uF', package: '0805', rating: '16V X5R' }, { ref: 'C2', type: 'capacitor', value: '22uF', package: '0805', rating: '10V X5R' },
        { ref: 'R1', type: 'resistor', value: '1k' }, { ref: 'D1', type: 'led', value: 'Green' },
        { ref: 'J2', type: 'connector', value: '3.3 V out', pins: [P('1', 'Pin_1', 'passive'), P('2', 'Pin_2', 'passive')] }],
      nets: [net('+5V', 'power', 'input', ['J1.1', 'U1.3', 'C1.1']), net('+3V3', 'power', 'output', ['U1.2', 'C2.1', 'R1.1', 'J2.1']), net('PWR_LED', 'signal', 'none', ['R1.2', 'D1.A']),
        net('GND', 'ground', 'none', ['J1.2', 'U1.1', 'C1.2', 'C2.2', 'D1.K', 'J2.2'])] },
      sim: { sources: [{ net: '+5V', kind: 'dc', value: 5 }], chips: [{ ref: 'U1', model: 'regulator', in: '3', out: '2', gnd: '1', vout: 3.3, dropout: 1.1 }], loads: [{ net: '+3V3', value: 33, note: '100 mA' }], probes: ['+5V', '+3V3'], tstop: 0.002 },
    },
  };

  C.newDesignDraft = function (tplKey) {
    let design, title;
    const tpl = tplKey && C.TEMPLATES[tplKey];
    if (tpl) {
      design = N.designer.fromCircuit(tpl.circuit, { type: 'draw' });
      design.sim = JSON.parse(JSON.stringify(tpl.sim));
      design.doc.title = title = tpl.title;
    } else {
      design = N.designer.blank('Untitled board');
      title = 'Untitled board';
    }
    const d = N.lib.putDraft({ id: N.lib.newId('d'), kind: 'design', meta: { title, desc: '', tags: [], license: 'CC-BY-4.0', kind: 'design', origin: 'design', src: { label: 'Drawn in KiLive' } }, design });
    location.hash = N.lib.draftRepoId(d.id) + '~main~design';
  };

  // ------------------------------------------------------------------ the page
  C.render = function (main, sub) {
    main.innerHTML = '';
    main.className = 'create';
    document.title = 'New board · KiLive';
    const head = el('section', { class: 'create-head' },
      el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, el('a', { href: '#explore' }, 'Explore'), el('span', null, '/'), el('span', null, 'New board')),
      el('h1', null, 'New board'),
      el('p', { class: 'lede' }, 'Three ways in. Whichever you pick, you end up with a KiCad project, the PCB, the schematic, a 3D view, the checks and a live simulation, saved under your name.'));
    const grid = el('div', { class: 'create-grid' });
    grid.append(
      card('draw', I.pen, 'Draw a schematic', 'Place parts and wire them up here. The PCB is placed for you and the circuit runs as you draw.',
        el('div', { class: 'cc-acts' }, el('button', { class: 'btn primary', onclick: () => C.newDesignDraft() }, N.svg(I.plus), 'Blank schematic')),
        el('div', { class: 'cc-tpls' }, el('span', { class: 'eyebrow' }, 'Templates'), Object.entries(C.TEMPLATES).map(([k, t]) => el('button', { class: 'tpl', onclick: () => C.newDesignDraft(k) }, el('b', null, t.title), el('span', { class: 'muted small' }, t.sub))))),
      card('upload', I.upload, 'Upload KiCad files', 'A project folder, a .zip or the .kicad_pcb and .kicad_sch files. KiCad 5 to 10, parsed in the browser, nothing uploaded anywhere.',
        el('div', { class: 'cc-acts' }, el('button', { class: 'btn primary', onclick: () => pickFiles(false) }, N.svg(I.upload), 'Choose files or .zip'), el('button', { class: 'btn', onclick: () => pickFiles(true) }, N.svg(I.folder), 'Choose folder')),
        el('div', { class: 'drop-hint muted small' }, 'or drop them anywhere on this card'),
        el('div', { class: 'cc-kicad' },
          el('button', { class: 'btn small', onclick: () => linkNew(), title: 'Pick your KiCad project folder: every save in KiCad updates the board here (Chrome, Edge)' }, N.svg(I.link), 'Link a folder (live)'),
          el('button', { class: 'btn small ghost', onclick: () => N.kicadLink.pluginDialog() }, N.svg(I.chip), 'KiCad plugin'),
          el('span', { class: 'muted small' }, 'Sent from KiCad? Press Ctrl+V.'))),
      card('datasheet', I.doc, 'Read a datasheet', 'Give the reader a datasheet PDF or a part number. The application circuit comes back as a schematic you can edit, then placed and simulated like any other board.',
        el('div', { class: 'cc-acts' }, el('button', { class: 'btn primary', onclick: () => N.datasheetWin.open() }, N.svg(I.doc), 'Open the reader')),
        el('div', { class: 'muted small' }, 'Opens in a window here. Pick the reference design, check the parts, then send it over as a board.')),
      );
    const work = el('section', { class: 'create-work', id: 'create-work' });
    const mine = el('section', { class: 'create-mine', id: 'create-mine' });
    main.append(head, grid, work, mine);
    renderMine();
    wireDrop($('.cc-upload', grid), items => readDropped(items).then(importFiles));
    if (sub === 'upload') setTimeout(() => $('.cc-upload').scrollIntoView({ block: 'center' }), 0);
  };
  function card(kind, icon, title, text, ...kids) {
    return el('article', { class: 'create-card cc-' + kind },
      el('div', { class: 'cc-ico' }, N.svg(icon)), el('h2', null, title), el('p', { class: 'muted' }, text), ...kids);
  }
  function renderMine() {
    const host = $('#create-mine');
    if (!host) return;
    host.innerHTML = '';
    const drafts = [...N.lib.drafts.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
    const mine = N.lib.list().filter(e => N.lib.isMine(e));
    if (!drafts.length && !mine.length) return;
    if (drafts.length) host.append(el('h3', { class: 'eyebrow' }, 'Drafts in this browser'), el('ul', { class: 'mine-list' }, drafts.map(d => el('li', null,
      el('a', { href: '#' + N.lib.draftRepoId(d.id) + '~main~' + (d.kind === 'design' ? 'design' : '3d') }, d.meta.title || 'Untitled board'),
      el('span', { class: 'muted small' }, (d.kind === 'design' ? 'drawing' : 'KiCad upload') + ' · ' + (d.at ? N.fmt.ago(d.at) : '')),
      el('button', { class: 'icon-btn small', 'aria-label': 'Discard draft ' + (d.meta.title || ''), title: 'Discard draft', onclick: () => { N.lib.dropDraft(d.id); renderMine(); } }, N.svg(I.trash))))));
    if (mine.length) host.append(el('h3', { class: 'eyebrow' }, 'Your boards in the library'), el('ul', { class: 'mine-list' }, mine.map(e => el('li', null,
      el('a', { href: '#' + N.lib.repoId(e.bid) }, e.meta.title), el('span', { class: 'muted small' }, N.lib.kindLabel(e.meta) + ' · updated ' + N.fmt.ago(e.meta.updated))))));
  }
  C.renderMine = renderMine;

  // ------------------------------------------------------------------ drag & drop, pickers
  function wireDrop(target, onItems) {
    if (!target) return;
    ['dragenter', 'dragover'].forEach(ev => target.addEventListener(ev, e => { e.preventDefault(); target.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => target.addEventListener(ev, e => { e.preventDefault(); if (ev === 'dragleave' && target.contains(e.relatedTarget)) return; target.classList.remove('over'); }));
    target.addEventListener('drop', e => { const dt = e.dataTransfer; if (dt) onItems(dt); });
  }
  async function readDropped(dt) {
    const out = {};
    const items = dt.items ? [...dt.items] : [];
    const entries = items.map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (entries.length) {
      const walk = async (entry, prefix) => {
        if (entry.isFile) { const f = await new Promise((res, rej) => entry.file(res, rej)); out[prefix + f.name] = f; return; }
        if (entry.isDirectory) {
          const reader = entry.createReader();
          let batch;
          do { batch = await new Promise((res, rej) => reader.readEntries(res, rej)); for (const e of batch) await walk(e, prefix + entry.name + '/'); } while (batch.length);
        }
      };
      for (const e of entries) await walk(e, '');
    } else for (const f of dt.files || []) out[f.name] = f;
    return out;
  }
  function pickFiles(folder) {
    const inp = el('input', { type: 'file', multiple: true, accept: folder ? null : '.zip,.kicad_pcb,.kicad_sch,.kicad_pro,.noeti', hidden: true });
    if (folder) { inp.webkitdirectory = true; inp.setAttribute('webkitdirectory', ''); }
    inp.addEventListener('change', () => { const files = {}; for (const f of inp.files) files[f.webkitRelativePath || f.name] = f; inp.remove(); importFiles(files); });
    document.body.append(inp);
    inp.click();
  }

  // ------------------------------------------------------------------ KiCad upload
  function workArea(title) {
    const w = $('#create-work');
    w.innerHTML = '';
    const body = el('div', { class: 'work-body' });
    w.append(el('div', { class: 'work-card card-inset' }, el('div', { class: 'files-head' }, title, el('button', { class: 'icon-btn small', 'aria-label': 'Close', onclick: () => { w.innerHTML = ''; } }, N.svg(I.close))), body));
    w.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return body;
  }
  function progress(body, label, frac) {
    let p = $('.imp-prog', body);
    if (!p) { p = el('div', { class: 'imp-prog' }, el('div', { class: 'imp-label small' }), el('div', { class: 'meter-bar' }, el('span', { class: 'good' }))); body.append(p); }
    $('.imp-label', p).replaceChildren(el('span', { class: 'spinner small' }), ' ', label);
    $('.meter-bar span', p).style.width = Math.round((frac || 0) * 100) + '%';
  }
  // a KiCad project folder, watched: each save in KiCad updates the board
  async function linkNew() {
    const K = N.kicadLink;
    let L;
    try { L = await K.linkFolder(); } catch (e) { K.linkBlockedDialog(e); return; }
    if (!L) return;
    const body = workArea('Linked folder: ' + L.name);
    let r;
    try { r = await K.importFiles(L.files, { onProgress: (label, f) => progress(body, label, 0.1 + 0.85 * (f || 0)) }); }
    catch (e) { body.innerHTML = ''; body.append(el('p', { class: 'err' }, 'Could not read ' + L.name + ': ' + (e.message || e))); return; }
    body.innerHTML = '';
    const d = K.newDraft(r);
    if (N.app.watchLinked) N.app.watchLinked(L, N.lib.draftRepoId(d.id));
  }
  async function importFiles(files, opts) {
    opts = opts || {};
    let names0 = Object.keys(files);
    // a project sent by the KiCad plugin, saved as a file
    const noeti = names0.find(n => /\.noeti$/i.test(n));
    if (noeti) { N.kicadLink.receiveText(await files[noeti].text()); return; }
    const body = workArea(opts.title || 'Upload KiCad files');
    try {
      let names = names0;
      if (!names.length) return;
      const zips = names.filter(n => /\.zip$/i.test(n));
      const sizes = {};
      if (zips.length) {
        progress(body, 'Unpacking ' + zips[0].split('/').pop() + '…', 0.05);
        const buf = await files[zips[0]].arrayBuffer();
        const un = await N.kicad.unzip(buf, { filter: p => /\.kicad_(pcb|sch|pro)$/i.test(p), sizes });
        files = un;
        names = Object.keys(files);
      } else for (const n of names) sizes[n] = files[n].size || 0;
      const allPaths = Object.keys(sizes).length ? Object.keys(sizes).map(p => [p, sizes[p]]) : names.map(n => [n, 0]);
      const projects = N.kicad.findProjects(allPaths.filter(([p]) => /\.kicad_(pcb|sch|pro)$/i.test(p)));
      if (!projects.length) { body.innerHTML = ''; body.append(el('p', { class: 'err' }, 'No KiCad board or schematic in there. Upload the .kicad_pcb and .kicad_sch files (KiCad 5 or newer), their folder, or a .zip of the project.')); return; }
      const total = names.reduce((a, n) => a + (sizes[n] || (files[n] && (files[n].size || files[n].length)) || 0), 0);
      if (total > 80e6) { body.innerHTML = ''; body.append(el('p', { class: 'err' }, 'That is more than 80 MB of KiCad files, too much to process in the browser.')); return; }
      if (projects.length > 1) {
        body.innerHTML = '';
        body.append(el('p', null, `Found ${projects.length} projects. Which one?`), el('div', { class: 'proj-list' }, projects.slice(0, 30).map(p => el('button', { class: 'proj', onclick: () => runImport(body, files, p, sizes, allPaths, opts) },
          el('b', { class: 'mono' }, p.name), el('span', { class: 'muted small mono' }, [p.pcb && 'board', p.sch && 'schematic'].filter(Boolean).join(' + ') + ' · ' + (p.folder || '/'))))));
        return;
      }
      await runImport(body, files, projects[0], sizes, allPaths, opts);
    } catch (e) {
      body.innerHTML = '';
      body.append(el('p', { class: 'err' }, 'Could not read those files: ' + (e.message || e)));
    }
  }
  async function runImport(body, files, proj, sizes, allPaths, opts) {
    opts = opts || {};
    body.innerHTML = '';
    progress(body, 'Reading ' + proj.name + '…', 0.1);
    const t0 = performance.now();
    let res;
    try {
      res = await N.kicad.importProject(files, proj, { sizes, onProgress: (label, frac) => progress(body, label, 0.1 + 0.85 * (frac || 0)) });
    } catch (e) {
      body.innerHTML = '';
      body.append(el('p', { class: 'err' }, 'Could not import ' + proj.name + ': ' + (e.message || e)));
      return;
    }
    if (!res.pcb) {
      body.innerHTML = '';
      body.append(el('p', null, 'This project has a schematic but no PCB layout.'), el('p', { class: 'muted small' }, 'KiLive shows boards; add the .kicad_pcb, or draw the circuit with "Draw a schematic" to get a placed PCB generated for you.'));
      return;
    }
    progress(body, 'Keeping a copy of the source files…', 0.97);
    const folder = proj.folder ? proj.folder + '/' : '';
    const source = {};
    for (const [p] of allPaths) {
      if (!/\.kicad_(pcb|sch|pro)$/i.test(p) || (folder && !p.startsWith(folder))) continue;
      const v = files[p];
      if (v == null) continue;
      source[p.slice(folder.length)] = typeof v === 'string' ? v : v instanceof Uint8Array ? N.kicad.decodeText(v) : await v.text();
    }
    const key = 'upload__' + N.lib.slug(proj.name);
    const data = { key, pcb: res.pcb, sch: res.sch, bom: res.bom, checks: res.checks, power: res.power, stats: res.stats };
    const meta = { title: proj.name, desc: '', tags: ['kicad'], license: 'CC-BY-4.0', kind: 'kicad', origin: 'kicad', kicad: res.kicad, mask: res.pcb.meta.mask, files: res.files, stats: res.stats, checks: Object.fromEntries(res.checks.map(c => [c.id, c.status])), src: { label: 'KiCad ' + res.kicad + ' upload', pcb: proj.pcb, name: proj.name } };
    if (opts.source && opts.source.spec) {
      const g = opts.source;
      Object.assign(meta, { license: 'See source repository', homepage: g.url, repoUrl: 'https://github.com/' + g.spec.owner + '/' + g.spec.repo, branch: g.spec.ref || 'HEAD',
        src: Object.assign({}, meta.src, { label: 'From GitHub', github: N.gh.hashFor(g.spec) }), desc: meta.desc || ('Opened from github.com/' + g.spec.owner + '/' + g.spec.repo + (g.spec.path ? '/' + g.spec.path : '') + '.') });
    }
    const d = N.lib.putDraft({ id: N.lib.newId('d'), kind: 'kicad', meta, data, source, ms: Math.round(performance.now() - t0) });
    body.innerHTML = '';
    location.hash = N.lib.draftRepoId(d.id) + '~main~3d';
  }

  C.importFiles = importFiles;
  C.workArea = workArea;
  C.progress = progress;
})();

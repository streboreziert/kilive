/* KiLive — KiCad link: the "Send to KiLive" plugin and its clipboard / .noeti payload, KiCad files into a board
   (new or a new revision of the open one), a live link to a project folder, and the simulation back out to KiCad */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const K = (N.kicadLink = {});
  const MARK = 'NOETI-KICAD/1';
  K.RELEASES_URL = 'https://github.com/streboreziert/kilive/releases/latest';
  K.APP_URL = window.NOETI_APP_URL || 'https://streboreziert.github.io/kilive/';  // the static build sets NOETI_APP_URL
  const app = () => N.app || {};

  // ------------------------------------------------------------------ the plugin's payload
  K.isPayload = t => typeof t === 'string' && t.trimStart().slice(0, MARK.length) === MARK;
  K.decode = async function (text) {
    const b64 = text.trim().slice(MARK.length).replace(/\s+/g, '');
    let o;
    try { o = JSON.parse(await N.lib.gunzip(N.lib.fromB64(b64))); } catch (e) { throw new Error('That clipboard text is cut off or damaged. Send it from KiCad again.'); }
    if (!o || o.format !== 'noeti-kicad' || !o.files || typeof o.files !== 'object') throw new Error('Not a project sent from KiCad.');
    for (const k of Object.keys(o.files)) if (typeof o.files[k] !== 'string' || /(^|\/)\.\.(\/|$)/.test(k)) delete o.files[k];
    return o;
  };
  K.encode = async function (project, files) {
    const doc = { format: 'noeti-kicad', version: 1, project, sent: new Date().toISOString(), kicad: '', tool: 'noeti-web', files };
    return MARK + ' ' + N.lib.toB64(await N.lib.gzip(JSON.stringify(doc)));
  };

  // ------------------------------------------------------------------ KiCad files -> board data
  /** files: {path: string | Uint8Array | File}; opts: {onProgress(label, frac), project: preferred name}. */
  K.importFiles = async function (files, opts) {
    opts = opts || {};
    const sizes = {};
    for (const [k, v] of Object.entries(files)) sizes[k] = typeof v === 'string' ? v.length : (v && (v.size || v.length)) || 0;
    const allPaths = Object.keys(sizes).map(p => [p, sizes[p]]);
    const projects = N.kicad.findProjects(allPaths.filter(([p]) => /\.kicad_(pcb|sch|pro)$/i.test(p)));
    if (!projects.length) throw new Error('No KiCad board or schematic in there.');
    const want = String(opts.project || '').toLowerCase();
    const proj = projects.find(p => p.pcb && p.name.toLowerCase() === want) || projects.find(p => p.pcb) || projects[0];
    const t0 = performance.now();
    const res = await N.kicad.importProject(files, proj, { sizes, onProgress: opts.onProgress });
    if (!res.pcb) throw Object.assign(new Error('This project has a schematic but no PCB layout.'), { code: 'no_pcb' });
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
    return { proj, res, data, meta, source, ms: Math.round(performance.now() - t0) };
  };
  K.newDraft = function (r, extra) {
    const d = N.lib.putDraft(Object.assign({ id: N.lib.newId('d'), kind: 'kicad', meta: r.meta, data: r.data, source: r.source, ms: r.ms }, extra || {}));
    location.hash = N.lib.draftRepoId(d.id) + '~main~3d';
    return d;
  };

  // ------------------------------------------------------------------ receiving a project from the plugin (paste or drop)
  // the board on screen that KiCad files can update: a KiCad upload that is yours (or a draft in this browser)
  K.target = function () {
    const A = app(), u = A.cur && A.cur.user;
    if (!u || u.design || !u.data || (A.isMine && !A.isMine()) || u.readonly) return null;
    return { title: (u.meta && u.meta.title) || A.cur.repo.title, project: u.meta && u.meta.src && u.meta.src.name, draft: !!u.draft };
  };
  K.receiveText = async function (text) {
    let o;
    try { o = await K.decode(text); } catch (e) { N.toast(e.message, 'warn'); return; }
    return K.receive(o.files, { project: o.project, from: 'KiCad' + (o.kicad ? ' ' + String(o.kicad).replace(/^\(|\)$/g, '').split(/[\s-]/)[0] : ''), sent: o.sent });
  };
  /** files from the plugin, a drop or a folder; asks whether they update the open board or start a new one */
  K.receive = async function (files, info) {
    info = info || {};
    const tg = K.target();
    const status = el('div', { class: 'small muted', role: 'status' });
    const bar = el('div', { class: 'meter-bar' }, el('span', { class: 'good', style: { width: '0%' } }));
    const run = async mode => {
      body.replaceChildren(el('p', null, 'Reading ' + (info.project || 'the project') + '…'), bar, status);
      foot.forEach(b => { b.disabled = true; });
      let r;
      try { r = await K.importFiles(files, { project: info.project, onProgress: (label, f) => { status.textContent = label; bar.firstChild.style.width = Math.round((f || 0) * 100) + '%'; } }); }
      catch (e) { m.close(); N.toast('Could not read the project: ' + (e.message || e), 'warn'); return; }
      m.close();
      if (mode === 'update' && app().kicadUpdate) app().kicadUpdate(r, { from: info.from || 'KiCad' });
      else K.newDraft(r);
    };
    const named = tg && tg.project && info.project && tg.project.toLowerCase() === String(info.project).toLowerCase();
    const nSch = Object.keys(files).filter(k => /\.kicad_sch$/i.test(k)).length, hasPcb = Object.keys(files).some(k => /\.kicad_pcb$/i.test(k));
    const body = el('div', null,
      el('p', null, el('b', null, info.project || 'A KiCad project'), el('span', { class: 'muted' }, ' · ' + [hasPcb ? 'board' : '', nSch ? nSch + ' schematic sheet' + (nSch === 1 ? '' : 's') : ''].filter(Boolean).join(' + ') + (info.from ? ' from ' + info.from : '') + (info.sent ? ', sent ' + N.fmt.ago(Date.parse(info.sent)) : ''))),
      tg ? el('p', { class: 'muted small' }, named ? 'It is the project this board was made from: updating keeps the board and shows what changed.' : 'This board was made from ' + (tg.project ? 'another project (' + tg.project + ')' : 'other files') + '. Updating it replaces its design with this one.') : el('p', { class: 'muted small' }, 'KiLive makes a new board from it: 3D, design checks and live simulation.'));
    const foot = tg
      ? [el('button', { class: 'btn ghost', onclick: () => run('new') }, 'New board'), el('button', { class: 'btn ' + (named ? 'primary' : ''), onclick: () => run('update') }, 'Update ' + (tg.title.length > 26 ? 'this board' : tg.title))]
      : [el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => run('new') }, 'Make the board')];
    if (tg && !named) foot.reverse();
    const m = N.modal('From KiCad', body, foot);
    return m;
  };

  // anywhere on the page: Ctrl+V with the plugin's text, or a dropped .noeti file
  document.addEventListener('paste', e => {
    const t = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!K.isPayload(t)) return;
    e.preventDefault();
    K.receiveText(t);
  });
  const hasNoeti = dt => dt && [...(dt.items || [])].some(it => it.kind === 'file') ;
  window.addEventListener('dragover', e => { if (hasNoeti(e.dataTransfer) && !e.target.closest('.create-card')) e.preventDefault(); });
  window.addEventListener('drop', async e => {
    if (e.target.closest && e.target.closest('.create-card')) return;
    const f = [...((e.dataTransfer && e.dataTransfer.files) || [])].find(x => /\.noeti$/i.test(x.name));
    if (!f) return;
    e.preventDefault();
    K.receiveText(await f.text());
  });
  K.readNoetiFile = async file => { const o = await K.decode(await file.text()); return o; };

  // ------------------------------------------------------------------ the plugin itself, zipped in the browser
  async function icon(px, dark) {
    const c = document.createElement('canvas'); c.width = c.height = px;
    const g = c.getContext('2d'), r = px * 0.22;
    g.fillStyle = dark ? '#e9eee8' : '#14171a';
    g.beginPath(); if (g.roundRect) g.roundRect(px * 0.06, px * 0.06, px * 0.88, px * 0.88, r); else g.rect(px * 0.06, px * 0.06, px * 0.88, px * 0.88); g.fill();
    g.strokeStyle = '#f2c230'; g.lineWidth = Math.max(2, px * 0.12); g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(px * 0.32, px * 0.7); g.lineTo(px * 0.32, px * 0.3); g.lineTo(px * 0.68, px * 0.7); g.lineTo(px * 0.68, px * 0.3); g.stroke();
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }
  const withUrl = s => s.replace(/__NOETI_URL__/g, K.APP_URL);
  /** the Plugin and Content Manager package (KiCad 6 to 10): Install from File… */
  K.pluginZip = async function () {
    const S = N.kicadPluginSrc;
    const meta = {
      $schema: 'https://go.kicad.org/pcm/schemas/v1', name: 'Send to KiLive', identifier: 'com.noeticompute.send-to-kilive', type: 'plugin',
      description: 'One click: copy this project for KiLive (3D, checks, live simulation)',
      description_full: 'Adds a Send to KiLive button to the PCB Editor. It copies the open project - the board as it is in the editor, its schematics and project file - to the clipboard. In KiLive press Ctrl+V (Cmd+V on a Mac): KiLive updates the board you have open with it, showing what changed, or makes a new board with 3D, design checks and a live circuit simulation. The same text is saved as a .noeti file you can drag onto Noeti.',
      author: { name: 'KiLive', contact: { web: 'https://noeticompute.com' } }, license: 'MIT',
      resources: { homepage: 'https://noeticompute.com' }, tags: ['simulation', 'viewer', 'export'],
      versions: [{ version: '1.0.0', status: 'stable', kicad_version: '6.0' }],
    };
    const files = {
      'metadata.json': JSON.stringify(meta, null, 2),
      'plugins/__init__.py': S['swig/__init__.py'],
      'plugins/noeti_send.py': withUrl(S['swig/noeti_send.py']),
      'plugins/noeti_common.py': S['swig/noeti_common.py'],
      'plugins/noeti.png': await icon(24, false),
      'plugins/noeti_dark.png': await icon(24, true),
      'resources/icon.png': await icon(64, false),
    };
    return DS2K_ZIP.makeZip(files, '');
  };
  /** the IPC API flavour (KiCad 9 and later): a folder for the plugins directory */
  K.pluginIpcZip = async function () {
    const S = N.kicadPluginSrc;
    const files = {
      'plugin.json': S['ipc/plugin.json'], 'main.py': withUrl(S['ipc/main.py']), 'noeti_common.py': S['ipc/noeti_common.py'], 'requirements.txt': S['ipc/requirements.txt'],
      'icon-24.png': await icon(24, false), 'icon-48.png': await icon(48, false), 'icon-24-dark.png': await icon(24, true), 'icon-48-dark.png': await icon(48, true),
    };
    return DS2K_ZIP.makeZip(files, 'com.noeticompute.send-to-kilive');
  };
  K.pluginDialog = function () {
    const dl = async (name, make) => { try { N.saveFile(name, new Blob([await make()], { type: 'application/zip' })); } catch (e) { N.toast('Could not build the plugin: ' + (e.message || e), 'warn'); } };
    const step = (n, ...kids) => el('li', null, el('span', { class: 'kp-n' }, String(n)), el('div', null, ...kids));
    const body = el('div', { class: 'kp' },
      el('p', null, el('b', null, 'KiLive for KiCad'), ' runs this whole app from a toolbar button in the PCB Editor, offline, and updates it on every save. ',
        el('a', { href: K.RELEASES_URL, target: '_blank', rel: 'noopener' }, 'Download it from GitHub Releases'), ' (kilive-kicad-*.zip, KiCad 7 to 9).'),
      el('p', null, 'Or the small ', el('b', null, 'Send to KiLive'), ' button below: it copies the project you have open - the board as it is right now, its schematics and project file - and this page picks it up with Ctrl+V.'),
      el('ol', { class: 'kp-steps' },
        step(1, el('b', null, 'Download the plugin'), el('div', { class: 'kp-acts' },
          el('button', { class: 'btn primary', onclick: () => dl('send-to-kilive-kicad.zip', K.pluginZip) }, N.svg(N.icons.download || ''), 'KiCad 6 to 10'),
          el('button', { class: 'btn', onclick: () => dl('send-to-kilive-kicad-ipc.zip', K.pluginIpcZip) }, N.svg(N.icons.download || ''), 'IPC API version')),
          el('div', { class: 'muted small' }, 'The IPC version is for KiCad 9 and later, the way KiCad plugins will work from KiCad 11 on.')),
        step(2, el('b', null, 'Install it'), el('div', { class: 'muted small' }, 'KiCad 6 to 10: Plugin and Content Manager → Install from File… → choose the zip. IPC version: unzip it into Documents/KiCad/<version>/plugins (on Linux ~/.local/share/KiCad/<version>/plugins) and turn on Preferences → Plugins → Enable KiCad API.')),
        step(3, el('b', null, 'Send'), el('div', { class: 'muted small' }, 'In the PCB Editor click the KiLive button (also under Tools → External Plugins). Then come back here and press ', el('kbd', null, 'Ctrl'), '+', el('kbd', null, 'V'), ' (', el('kbd', null, '⌘'), el('kbd', null, 'V'), ' on a Mac) on any page. With one of your KiCad boards open, KiLive offers to update it and shows what changed.'))),
      el('p', { class: 'muted small' }, 'Where the clipboard is not an option, the plugin also saves the project as a .noeti file: drag it onto this page.'));
    let m = null;
    m = N.modal('KiCad plugin', body, [el('button', { class: 'btn', onclick: () => m && m.close() }, 'Done')]);
  };

  // ------------------------------------------------------------------ live link to a project folder
  // (File System Access API: Chrome and Edge. Inside an embedded frame the browser can refuse it.)
  K.link = null;
  K.canLink = () => typeof window.showDirectoryPicker === 'function';
  async function scan(dir, prefix, out, depth) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') { if (depth < 3 && !/^\.|-backups$|^__pycache__$|^node_modules$/i.test(name)) await scan(h, prefix + name + '/', out, depth + 1); }
      else if (/\.kicad_(pcb|sch|pro)$/i.test(name)) out.set(prefix + name, h);
    }
  }
  async function readAll(handles) {
    const files = {}, stamp = new Map();
    for (const [p, h] of handles) { const f = await h.getFile(); files[p] = await f.text(); stamp.set(p, f.lastModified + ':' + f.size); }
    return { files, stamp };
  }
  K.linkFolder = async function (opts) {
    opts = opts || {};
    if (!K.canLink()) throw Object.assign(new Error('This browser cannot watch a folder (Chrome and Edge can).'), { code: 'unsupported' });
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'noeti-kicad', mode: 'read' }); }
    catch (e) {
      if (e && e.name === 'AbortError') return null;
      throw Object.assign(new Error('The browser does not allow folder access on this page' + (e && e.name === 'SecurityError' ? ' (it is shown inside another site)' : '') + '.'), { code: 'blocked' });
    }
    const handles = new Map();
    await scan(dir, '', handles, 0);
    if (![...handles.keys()].some(p => /\.kicad_pcb$/i.test(p))) throw new Error('No .kicad_pcb in that folder.');
    const { files, stamp } = await readAll(handles);
    return { dir, handles, files, stamp, name: dir.name };
  };
  /** watch a linked folder; onChange(files) after each save in KiCad (debounced until the files stop changing) */
  K.watch = function (L, target, onChange) {
    K.unlink();
    const link = K.link = Object.assign(L, { target, onChange, at: Date.now(), busy: false, tick: 0, pending: null, last: null });
    const check = async () => {
      if (link !== K.link || link.busy || document.hidden) return;
      link.busy = true;
      try {
        if (++link.tick % 8 === 0) { const h = new Map(); await scan(link.dir, '', h, 0); if (h.size !== link.handles.size || [...h.keys()].some(k => !link.handles.has(k))) link.handles = h; }
        const now = new Map();
        for (const [p, h] of link.handles) { try { const f = await h.getFile(); now.set(p, f.lastModified + ':' + f.size); } catch (e) { now.set(p, 'gone'); } }
        const key = [...now].sort().map(x => x.join('=')).join('|');
        const was = [...link.stamp].sort().map(x => x.join('=')).join('|');
        if (key === was) { link.pending = null; return; }
        // KiCad writes several files: wait until two checks in a row agree
        if (link.pending !== key) { link.pending = key; return; }
        link.pending = null;
        const { files, stamp } = await readAll(new Map([...link.handles].filter(([p]) => now.get(p) !== 'gone')));
        link.stamp = stamp;
        link.last = Date.now();
        await link.onChange(files);
      } catch (e) { console.warn('KiCad folder link:', e); }
      finally { link.busy = false; }
    };
    link.timer = setInterval(check, 1200);
    N.bus.emit('kicadlink', link);
    return link;
  };
  K.unlink = function () {
    if (!K.link) return;
    clearInterval(K.link.timer);
    K.link = null;
    N.bus.emit('kicadlink', null);
  };
  // ------------------------------------------------------------------ served by the KiLive KiCad plugin (/_kicad/*)
  K.server = {
    async rev() { const r = await fetch('/_kicad/rev', { cache: 'no-store' }); if (!r.ok) throw new Error('KiCad is not serving a project'); return r.json(); },
    async project() {
      const r = await fetch('/_kicad/project', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'KiCad is not serving a project');
      return j;
    },
  };
  /** follow the project KiCad serves: onChange(files, info) after each press of the plugin button or save in KiCad */
  K.watchServer = function (first, target, onChange) {
    K.unlink();
    const link = K.link = { server: true, name: first.name, target, rev: first.rev, at: Date.now(), last: null, busy: false, lost: 0 };
    link.timer = setInterval(async () => {
      if (link !== K.link || link.busy) return;
      link.busy = true;
      try {
        const r = await K.server.rev();
        link.lost = 0;
        if (r.rev !== link.rev) {
          const p = await K.server.project();
          link.rev = p.rev; link.name = p.name; link.last = Date.now();
          await onChange(p.files, p);
        }
      } catch (e) {
        if (++link.lost === 3) N.toast('Lost the connection to KiCad. Press KiLive in the PCB Editor again.', 'warn');
      } finally { link.busy = false; }
    }, 1000);
    N.bus.emit('kicadlink', link);
    return link;
  };

  K.linkBlockedDialog = function (err) {
    let m = null;
    m = N.modal('Live folder link', el('div', null,
      el('p', null, err && err.message ? err.message : 'This browser cannot watch a folder.'),
      el('p', { class: 'muted small' }, 'The KiCad plugin does the same job from the other side: one click in KiCad, Ctrl+V here, and the board updates with a list of what changed.'),
      el('p', { class: 'muted small' }, 'You can also drop the project folder (or its .kicad_pcb and .kicad_sch files) on the upload card again; on one of your boards, More → Update from KiCad files.')),
      [el('button', { class: 'btn', onclick: () => m && m.close() }, 'Close'), el('button', { class: 'btn primary', onclick: () => K.pluginDialog() }, 'Get the KiCad plugin')]);
  };

  // ------------------------------------------------------------------ the simulation, back to KiCad (ngspice)
  const spNode = (() => {
    const map = new Map(), used = new Set(['0']);
    return { reset() { map.clear(); used.clear(); used.add('0'); }, get(n) {
      if (n == null || n === '0') return '0';
      if (map.has(n)) return map.get(n);
      let s = String(n).replace(/^n_/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '') || 'n';
      if (/^[0-9]/.test(s)) s = 'n' + s;
      let t = s, i = 2;
      while (used.has(t.toLowerCase())) t = s + '_' + i++;
      used.add(t.toLowerCase()); map.set(n, t);
      return t;
    } };
  })();
  const eng = x => { if (!isFinite(x)) return '0'; const a = Math.abs(x); if (a === 0) return '0'; const u = [[1e9, 'G'], [1e6, 'Meg'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p']].find(([k]) => a >= k) || [1e-15, 'f']; return +(x / u[0]).toPrecision(5) + u[1]; };
  /** model: {circuit, sim, vals, alias}; engine: a LiveSim that has run (for the voltages it settled at) */
  K.spiceDeck = function (engine, title) {
    spNode.reset();
    const used = new Set();
    const nm = (pre, s) => { let t = pre + String(s).replace(/[^A-Za-z0-9_]/g, '_'); let u = t, i = 2; while (used.has(u.toLowerCase())) u = t + '_' + i++; used.add(u.toLowerCase()); return u; };
    const n = x => spNode.get(x);
    const V = (a, b) => 'V(' + n(a) + (b && b !== '0' ? ',' + n(b) : '') + ')';
    const L = [], notes = [], models = new Set();
    const src = w => !w || w.kind === 'dc' ? 'DC ' + eng(w ? w.value : 0) : w.kind === 'pulse' ? 'DC ' + eng(w.low) + ' PULSE(' + [w.low, w.high, 0, 1 / w.freq / 200, 1 / w.freq / 200, w.duty / w.freq, 1 / w.freq].map(eng).join(' ') + ')' : 'DC ' + eng(w.offset) + ' SIN(' + [w.offset, w.ampl, w.freq].map(eng).join(' ') + ')';
    for (const e of engine.els) {
      switch (e.t) {
        case 'R': if (e.v > 0) L.push(nm('R', e.name) + ' ' + n(e.a) + ' ' + n(e.b) + ' ' + eng(e.sw ? (e.closed ? e.ron || 0.01 : 1e9) : e.v) + (e.sw ? ' ; switch ' + (e.closed ? 'closed' : 'open') : '')); break;
        case 'C': L.push(nm('C', e.name) + ' ' + n(e.a) + ' ' + n(e.b) + ' ' + eng(e.v)); break;
        case 'L': L.push(nm('L', e.name) + ' ' + n(e.a) + ' ' + n(e.b) + ' ' + eng(e.v)); break;
        case 'D': {
          let m = e.model;
          if (m === 'DZ') { m = 'DZ_' + String(+(e.bv || 5.1).toFixed(2)).replace('.', 'p'); models.add(m + ':' + (e.bv || 5.1)); } else models.add(m);
          if (e.bidir && e.bv) { const x = nm('x', e.name); L.push(nm('D', e.name + '_a') + ' ' + n(e.a) + ' ' + x + ' ' + m, nm('D', e.name + '_b') + ' ' + n(e.b) + ' ' + x + ' ' + m); }
          else L.push(nm('D', e.name) + ' ' + n(e.a) + ' ' + n(e.b) + ' ' + m);
          break;
        }
        case 'Q': models.add(e.pnp ? 'QP' : 'QN'); L.push(nm('Q', e.name) + ' ' + n(e.c) + ' ' + n(e.b) + ' ' + n(e.e) + ' ' + (e.pnp ? 'QP' : 'QN') + (e.fet === 'off' ? ' off' : '')); break;
        case 'M': models.add(e.pch ? 'MP' : 'MN'); L.push(nm('M', e.name) + ' ' + n(e.d) + ' ' + n(e.g) + ' ' + n(e.s) + ' ' + n(e.s) + ' ' + (e.pch ? 'MP' : 'MN') + ' W=1 L=1'); break;
        case 'V': L.push(nm('V', e.name) + ' ' + n(e.a) + ' ' + n(e.b) + ' ' + src(e.w) + (e.supply ? ' ; supply' + (e.net ? ' ' + e.net : '') : e.standin ? ' ; stand-in for a chip pin' : '')); break;
        case 'LSW': L.push(nm('R', e.name) + ' ' + n(e.a) + ' ' + n(e.b) + ' ' + eng(e.on ? e.ron : 1e8) + ' ; load switch ' + (e.on ? 'on' : 'off')); break;
        case 'DRV': {
          if (e.mode === 'z' || !(e.g > 0)) break;
          const hi = e.vdd || (() => { const s = nm('vio_', e.name); L.push(nm('V', s) + ' ' + s + ' 0 DC ' + eng(e.vnom || 3.3)); return s; })();
          if (e.kh > 0) L.push(nm('R', e.name + '_h') + ' ' + n(e.a) + ' ' + (e.vdd ? n(hi) : hi) + ' ' + eng(1 / (e.g * e.kh)) + ' ; ' + e.ref + ' pin ' + e.pin + ' driven ' + (e.kh >= 1 ? 'high' : 'by a pull-up'));
          if (e.kh < 1) L.push(nm('R', e.name + '_l') + ' ' + n(e.a) + ' 0 ' + eng(1 / (e.g * (1 - e.kh))) + (e.kh <= 0 ? ' ; ' + e.ref + ' pin ' + e.pin + ' driven low' : ''));
          break;
        }
        case 'REG': {
          const on = e._on == null ? 1 : e._on, g = e.gnd || '0', k = nm('', e.name), vs = nm('Vs_', e.name);
          if (on < 0.5) { L.push('* ' + e.name + ': regulator off'); break; }
          const vout = eng(e.vout * on);
          const vo = e.boost ? vout + '*(' + V(e.in, g) + '>0.75?1:0)' : 'min(max(' + V(e.in, g) + '-' + eng(e.drop || 0.3) + ',0),' + vout + ')';
          L.push('* ' + e.name + ': ' + (e.boost ? 'boost converter' : e.sw ? 'switching regulator' : 'linear regulator') + ', ' + vout + ' V' + (e.ilim ? ', ' + eng(e.ilim) + ' A limit' : ''),
            nm('B', e.name) + ' ' + k + '_r ' + n(g) + ' V=' + vo, vs + ' ' + k + '_r ' + n(e.out) + ' DC 0',
            nm('B', e.name + '_in') + ' ' + n(e.in) + ' ' + n(g) + ' I=' + (e.boost || e.sw ? 'max(i(' + vs + '),0)*' + V(e.out, g) + '/max(' + V(e.in, g) + ',0.5)/0.9' : 'max(i(' + vs + '),0)+1m'));
          break;
        }
        case 'SWR': {
          const g = e.gnd || '0', k = nm('', e.name), vs = nm('Vs_', e.name);
          L.push('* ' + e.name + ': buck converter, averaged (duty set by a high-gain loop on FB, Vref ' + eng(e.vref) + ' V)',
            nm('B', e.name + '_d') + ' ' + k + '_d 0 V=max(0,min(' + eng(e.dmax || 0.95) + ',0.5+300*(' + eng(e.vref) + '-' + V(e.fb, g) + ')))' + (e.en ? '*(' + V(e.en, g) + (e.enLow ? '<' : '>') + eng(e.ven || 1.1) + '?1:0)' : ''),
            nm('B', e.name) + ' ' + k + '_s ' + n(g) + ' V=V(' + k + '_d)*' + V(e.in, g), vs + ' ' + k + '_s ' + n(e.sw) + ' DC 0',
            nm('B', e.name + '_in') + ' ' + n(e.in) + ' ' + n(g) + ' I=V(' + k + '_d)*i(' + vs + ')');
          break;
        }
        case 'OPA': {
          const hi = e.vp ? V(e.vp) : '5', lo = e.vn && e.vn !== '0' ? V(e.vn) : '0';
          L.push('* ' + e.name + ': op-amp, rail to rail', nm('B', e.name) + ' ' + n(e.out) + ' 0 V=(' + hi + '+' + lo + ')/2+(' + hi + '-' + lo + ')/2*tanh(1e4*' + V(e.p, e.n) + '/((' + hi + '-' + lo + ')/2+1e-9))');
          break;
        }
        case 'T555': {
          const g = e.gnd || '0', k = nm('', e.name);
          L.push('* ' + e.name + ': 555 timer (comparators, latch, output, discharge)',
            nm('B', e.name + '_q') + ' ' + k + '_qn ' + n(g) + ' V=' + (e.reset ? '(' + V(e.reset, g) + '<0.7)?0:' : '') + '(' + V(e.thr, g) + '>' + V(e.cont, g) + ')?0:(' + V(e.trig, g) + '<' + V(e.cont, g) + '/2)?1:(V(' + k + '_q)>0.5?1:0)',
            nm('R', e.name + '_q') + ' ' + k + '_qn ' + k + '_q 1', nm('C', e.name + '_q') + ' ' + k + '_q 0 1n',
            nm('B', e.name) + ' ' + n(e.out) + ' ' + n(g) + ' V=(V(' + k + '_q)>0.5)?max(' + V(e.vcc, g) + '-1.2,0):0.05');
          if (e.dis) L.push(nm('B', e.name + '_dd') + ' ' + k + '_dd 0 V=(V(' + k + '_q)>0.5)?0:1', nm('S', e.name) + ' ' + n(e.dis) + ' ' + n(g) + ' ' + k + '_dd 0 SW555', '.model SW555 SW(Ron=10 Roff=1e7 Vt=0.5 Vh=0.1)');
          break;
        }
        default: notes.push(e.name + ': ' + e.t + ' left out');
      }
    }
    const MODELS = { DGEN: 'D(Is=1e-14 N=1 Rs=0.05)', DSCH: 'D(Is=1e-6 N=1.05 Rs=0.03)', DLED: 'D(Is=1e-18 N=2 Rs=5)', DIR: 'D(Is=1e-20 N=1.2 Rs=1)', DIDEAL: 'D(Is=1e-9 N=0.2 Rs=0.01)', QN: 'NPN(Bf=200 Br=2 Is=1e-14)', QP: 'PNP(Bf=200 Br=2 Is=1e-14)', MN: 'NMOS(Level=1 Vto=2 Kp=2)', MP: 'PMOS(Level=1 Vto=-2 Kp=2)' };
    for (const m of models) { const [k, bv] = m.split(':'); L.push('.model ' + k + ' ' + (bv ? 'D(Is=1e-14 Rs=0.5 BV=' + eng(+bv) + ' IBV=1m)' : MODELS[k] || 'D')); }
    // what KiLive found, net by net
    const found = [];
    for (const [node, net] of engine.nodeNet) { const v = engine.V(node); if (isFinite(v)) found.push([net, n(node), v]); }
    found.sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
    const head = ['* ' + (title || 'board') + ' - circuit model exported from KiLive, ' + new Date().toISOString().slice(0, 10),
      '* Passives, diodes and transistors as on the board; chips are the stand-ins KiLive simulates them with',
      '* (regulators, converters, op-amps, timers, processor pins as they were driven). Ground is node 0.'];
    const lib = head.concat([''], L, notes.map(x => '* ' + x), ['']).join('\n');
    const volts = found.map(([net, node, v]) => '* ' + net + ' (' + node + '): ' + v.toFixed(4) + ' V');
    const cir = head.concat(['', '.include "' + (title || 'board').replace(/[^\w.-]+/g, '_') + '.lib"', '.options reltol=1e-3 gmin=1e-12 itl1=400', '.op', '',
      '* KiLive settled at these voltages:', ...volts, '',
      '.control', 'op', 'print ' + (found.slice(0, 60).map(f => 'v(' + f[1] + ')').join(' ') || 'all'), '.endc', '.end', '']).join('\n');
    return { lib, cir, volts: found, notes };
  };
  function uuid() { const h = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32); }
  /** a zip: <name>.lib + <name>.cir for ngspice, and a KiCad project whose schematic includes them (Inspect → Simulator → Run) */
  K.simPackage = function (engine, title) {
    const base = String(title || 'board').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'board';
    const d = K.spiceDeck(engine, base);
    const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const directive = '.include "' + base + '.lib"\n.op';
    const sch = '(kicad_sch (version 20230121) (generator eeschema)\n  (uuid ' + uuid() + ')\n  (paper "A4")\n' +
      '  (title_block (title "' + esc(String(title || base)) + ' - simulation model") (comment 1 "Exported from KiLive"))\n  (lib_symbols)\n' +
      '  (text "' + esc(directive) + '" (at 30.48 30.48 0)\n    (effects (font (size 1.524 1.524)) (justify left bottom))\n    (uuid ' + uuid() + ')\n  )\n' +
      '  (text "' + esc('The circuit is in ' + base + '.lib (KiLive\'s model of the board). Inspect > Simulator > Run shows the operating point.\nCompare with the voltages KiLive found, listed in ' + base + '.cir.') + '" (at 30.48 45.72 0)\n    (effects (font (size 1.27 1.27)) (justify left bottom))\n    (uuid ' + uuid() + ')\n  )\n' +
      '  (sheet_instances (path "/" (page "1")))\n)\n';
    const pro = JSON.stringify({ meta: { filename: base + '-sim.kicad_pro', version: 1 }, schematic: {}, sheets: [], text_variables: {} }, null, 2);
    const readme = [title + ' - simulation from KiLive', '',
      'KiCad (7 or later): open ' + base + '-sim.kicad_pro, open the schematic, then Inspect > Simulator > Run.',
      '  The schematic only holds the directives; the circuit is in ' + base + '.lib.',
      'ngspice: ngspice ' + base + '.cir   (prints the operating point next to the values KiLive found)', '',
      'Chips are modelled the way KiLive simulates them: regulators and converters as ideal controlled sources,',
      'op-amps and timers as behavioural blocks, processor pins as the drivers they were in Noeti. Passives,',
      'diodes, transistors and MOSFETs are as on the board.', ''].join('\n');
    return { zip: DS2K_ZIP.makeZip({ [base + '.lib']: d.lib, [base + '.cir']: d.cir, [base + '-sim.kicad_pro']: pro, [base + '-sim.kicad_sch']: sch, 'README.txt': readme }, base + '-sim'), name: base + '-sim.zip', deck: d };
  };
  /** export the board's simulation; uses the running live engine, or settles a fresh one */
  K.exportSim = async function (model, title) {
    let engine = N.live && N.live.on && N.live.engine && N.live.B === model.B ? N.live.engine : null;
    if (!engine) {
      N.toast('Settling the circuit…', 'info');
      await new Promise(r => setTimeout(r, 30));
      engine = new N.LiveSim(model.circuit, model.sim, model.vals || {}, model.alias || {}, { rampTime: 0 });
      for (let i = 0; i < 40 && engine.t < 0.05; i++) { const r = engine.advance(0.005, 60); if (!r.ok) break; await new Promise(res => setTimeout(res, 0)); }
    }
    const p = K.simPackage(engine, title);
    N.saveFile(p.name, new Blob([p.zip], { type: 'application/zip' }));
    return p;
  };
})();

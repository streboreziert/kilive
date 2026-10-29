/* KiLive — application shell: explore page, board page, cross-probing */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const I = N.icons;
  const $ = (s, r) => (r || document).querySelector(s);

  const App = (N.app = {
    index: [],
    sel: { refs: new Set(), nets: new Set() },
    cur: null, // {repo, board, version, B, tab}
    views: {},
    tab: '3d',
  });

  const TAB_DEFS = {
    design: ['design', 'Design', I.pen], '3d': ['3d', '3D', I.cube], pcb: ['pcb', 'PCB', I.pcb], sch: ['sch', 'Schematic', I.sch], bom: ['bom', 'BOM', I.bom],
    checks: ['checks', 'Checks', I.checks], files: ['files', 'Files', I.files],
  };
  function tabsFor(repo) {
    const ids = ['3d', 'pcb', 'sch', 'bom', 'checks', 'files'];
    if (repo && repo.user && repo.kind === 'design') ids.unshift('design');
    return ids.map(id => TAB_DEFS[id]);
  }
  let TABS = tabsFor(null);

  const LOGO = `<svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true"><rect x="1" y="1" width="26" height="26" rx="7" fill="var(--ink)"/><path d="M5 15.5h5l2.2-6 3.6 11 2.2-5H23" fill="none" stroke="var(--probe)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="23" cy="15.5" r="1.9" fill="var(--bg)"/></svg>`;

  // ------------------------------------------------------------------ boot
  async function boot() {
    const root = $('#app');
    root.innerHTML = '';
    const header = el('header', { class: 'topbar' },
      el('a', { class: 'brand', href: '#explore', 'aria-label': 'KiLive home' }, N.svg(LOGO, 'logo'), el('span', { class: 'brand-name' }, 'KiLive')),
      el('div', { class: 'top-search' }, N.svg(I.search), el('input', { id: 'top-search', type: 'search', placeholder: 'Search boards, chips and topics', 'aria-label': 'Search boards' })),
      el('nav', { class: 'top-nav' }, el('a', { href: '#explore' }, 'Explore'), el('a', { href: 'https://noeticompute.com', target: '_blank', rel: 'noopener' }, 'noeticompute.com', N.svg(I.ext, 'tiny'))),
      el('a', { class: 'btn tiny primary nav-new', href: '#new' }, N.svg(I.plus), el('span', null, 'New board')));
    const main = el('main', { id: 'main' });
    root.append(header, main);
    $('#top-search').addEventListener('input', N.debounce(e => {
      App.query = e.target.value.trim().toLowerCase();
      // on the explore page only the results change (the filter bar keeps its focus and state)
      if (!location.hash || location.hash === '#explore') { if ($('#ex-results')) { renderResults(); renderCommunity(); } else renderExplore(); } else location.hash = 'explore';
    }, 150));
    try {
      App.index = await N.loadJSON('data/index.json');
      App.more = await N.loadJSON('data/github.json').catch(() => []);
    } catch (e) {
      main.append(el('div', { class: 'fatal' }, el('h1', null, 'Could not load the board library'), el('p', null, e.message)));
      return;
    }
    N.social.init();
    N.lib.init();
    N.bus.on('social', () => { updateSocial(); if (!App.cur) updateExploreCounts(); });
    N.bus.on('library', () => {
      if (App.waitingRoute) { App.waitingRoute = false; route(); return; }
      if (!App.cur && (!location.hash || location.hash === '#explore')) renderCommunity();
      if (!App.cur && /^#new/.test(location.hash)) N.create.renderMine();
      if (App.cur && App.cur.repo.user) updateUserBits();
    });
    window.addEventListener('hashchange', route);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { App.views.pcb && App.views.pcb.draw(); App.views.sch && App.views.sch.draw(); });
    new MutationObserver(() => { App.views.pcb && App.views.pcb.draw(); App.views.sch && App.views.sch.draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    route();
  }

  function parseHash() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!h || h === 'explore') return null;
    const [repo, board, tab, version] = h.split('~');
    return { repo, board, tab, version };
  }
  function setHash(r) {
    const tok = [r.repo, r.board, r.tab, r.version].filter(Boolean).join('~');
    if (location.hash.slice(1) !== tok) history.replaceState(null, '', '#' + tok);
  }

  function route() {
    const r = parseHash();
    App.waitingRoute = false;
    if (!r) { App.cur = null; teardownViews(); renderExplore(); return; }
    if (r.repo === 'new') { App.cur = null; teardownViews(); N.create.render($('#main'), r.board); return; }
    if (r.repo.startsWith('gh/')) { App.cur = null; teardownViews(); N.gh.open(r.repo); return; }
    if (r.repo === 'kicad') { App.cur = null; teardownViews(); openFromKiCad(); return; }
    let repo = null;
    if (r.repo.startsWith('draft-')) {
      const d = N.lib.getDraft(r.repo.slice(6));
      if (!d) { App.cur = null; teardownViews(); notFound('This draft is no longer here', 'Drawings are kept in this browser until you save or discard them. Uploaded KiCad files are only held until the page reloads, so upload them again and save them to the library.'); return; }
      repo = draftRepo(d);
    } else if (r.repo.startsWith('u-')) {
      const entry = N.lib.find(r.repo.slice(2));
      if (!entry) {
        if (!N.lib.ready) { App.waitingRoute = true; App.cur = null; teardownViews(); waitingPage(); return; }
        App.cur = null; teardownViews(); notFound('Board not found', N.lib.db ? 'It may have been deleted by its author.' : 'Boards made on KiLive live in the shared library, which opens when this page is viewed in Claude.'); return;
      }
      repo = userRepo(entry);
    } else repo = App.index.find(x => x.id === r.repo);
    if (!repo) { App.cur = null; teardownViews(); renderExplore(); return; }
    const board = repo.boards.find(b => b.id === r.board) || repo.boards[0];
    const version = board.versions.find(v => v.id === r.version) || board.versions.find(v => v.id === board.default) || board.versions[0];
    const tabs = tabsFor(repo);
    const tab = tabs.some(t => t[0] === r.tab) ? r.tab : (repo.user && repo.kind === 'design' && repo.draft ? 'design' : '3d');
    openBoard(repo, board, version, tab);
  }
  function notFound(title, text) {
    const main = $('#main');
    main.className = 'explore';
    main.replaceChildren(el('div', { class: 'fatal' }, el('h1', null, title), el('p', { class: 'muted' }, text), el('p', null, el('a', { class: 'btn', href: '#explore' }, 'Back to Explore'), ' ', el('a', { class: 'btn primary', href: '#new' }, N.svg(I.plus), 'New board'))));
  }
  function waitingPage() {
    const main = $('#main');
    main.className = 'explore';
    main.replaceChildren(el('div', { class: 'fatal' }, el('div', { class: 'spinner' }), el('p', { class: 'muted' }, 'Opening the shared library…')));
  }
  // repo-shaped records for boards in the shared library and for local drafts (cached so the page is not rebuilt needlessly)
  const repoCache = new Map();
  function userRepo(entry) {
    const k = 'u:' + entry.bid;
    const c = repoCache.get(k);
    if (c && c.meta === entry.meta) return c;
    const repo = N.lib.toRepo(entry);
    if (c && App.pageBuilt === c.id) { Object.assign(c, repo, { boards: c.boards }); c.boards[0].versions[0] = Object.assign(c.boards[0].versions[0], repo.boards[0].versions[0]); return c; }
    repoCache.set(k, repo);
    return repo;
  }
  function draftRepo(d) {
    const k = 'd:' + d.id;
    let c = repoCache.get(k);
    if (!c) { c = N.lib.toRepo({ uid: N.lib.uid, bid: d.id, meta: d.meta }, { draft: true }); c.draftObj = d; repoCache.set(k, c); }
    return c;
  }

  // ------------------------------------------------------------------ explore
  function repoTotals(repo) {
    let parts = 0, nets = 0, revs = 0, layers = 0, kicad = new Set();
    const st = { fail: 0, warn: 0 };
    for (const b of repo.boards) {
      const v = b.versions.find(x => x.id === b.default) || b.versions[0];
      parts += v.stats.parts; nets += v.stats.nets;
      layers = Math.max(layers, v.stats.layers || 0);
      revs += b.versions.length;
      for (const x of b.versions) kicad.add(String(x.kicad).split('.')[0]);
      for (const s of Object.values(v.checks)) if (s in st) st[s]++;
    }
    return { parts, nets, revs, layers, st, kicad: [...kicad] };
  }
  const CATS = [['mcu', 'Microcontroller boards', 'Microcontrollers'], ['instrument', 'Instruments and test gear', 'Instruments'], ['fpga', 'FPGA boards', 'FPGA'], ['robotics', 'Robotics and motion', 'Robotics'],
    ['power', 'Power', 'Power'], ['audio', 'Audio', 'Audio'], ['usb', 'USB gadgets', 'USB'], ['badge', 'Badges', 'Badges'], ['keyboard', 'Keyboards', 'Keyboards'], ['other', 'Everything else', 'Other']];
  const CHIP_FAMS = [['rp2040', 'RP2040'], ['rp2350', 'RP2350'], ['esp32', 'ESP32'], ['stm32', 'STM32'], ['nrf52', 'nRF52'], ['samd', 'Microchip SAM'], ['avr', 'AVR'], ['risc-v', 'RISC-V'], ['fpga', 'FPGA'], ['lora', 'LoRa']];
  const FEATURED = ['hackrf', 'thunderscope', 'glasgow', 'librevna', 'jetson-orin-baseboard', 'anyon-e', 'smartknob', 'bus-pirate', 'jumperlessv5', 'cynthion-hardware', 'duet3-mainboard-6hc', 'butterstick', 'the-open-book', 'mch2022-badge-hardware', 'moteus', 'sensor-watch'];
  const SORTS = [['featured', 'Featured'], ['updated', 'Recently updated'], ['added', 'Recently added'], ['parts', 'Most parts'], ['name', 'Name']];
  // everything the explore page needs about a repo, worked out once
  const infoCache = new Map();
  function info(r) {
    let x = infoCache.get(r);
    if (x) return x;
    const t = repoTotals(r);
    const newest = App.index.reduce((m, q) => (q.added && q.added > m ? q.added : m), '');
    const isNew = !!(r.added && newest && (Date.parse(newest) - Date.parse(r.added)) < 21 * 864e5);
    const fams = new Set(r.topics || []);
    if ((r.category || 'other') === 'fpga' || fams.has('ice40') || fams.has('ecp5')) fams.add('fpga');
    const emu = r.code && r.code.emu.length ? r.code.emu : [];
    let chip = emu[0] || '';
    if (!chip && r.mcu && !/^none\b/i.test(r.mcu)) chip = r.mcu.split(/\s*[(/,]|\s+(?=[a-z])/)[0].trim();
    if (chip.length > 16) chip = chip.slice(0, 15) + '…';
    const rank = FEATURED.indexOf(r.id);
    const score = rank >= 0 ? 100 - rank : (emu.length ? 2 : 0) + (r.code && r.code.procs ? 1 : 0) + Math.log10(t.parts + 1) + (isNew ? 0.3 : 0);
    const text = [r.title, r.name, r.owner, r.desc, r.mcu || '', r.category || '', ...r.topics, ...r.boards.flatMap(b => b.versions.flatMap(v => v.stats.ics.map(i => i[1])))].join(' ').toLowerCase();
    x = Object.assign(t, { isNew, fams, chip, emu, score, text, cat: r.category || 'other' });
    infoCache.set(r, x);
    return x;
  }
  const exState = () => (App.ex = App.ex || { cat: 'all', chip: '', fw: false, sort: N.store.get('ex-sort', 'featured'), view: N.store.get('ex-view', 'cards') });
  function exMatch(r, ex, q, skip) {
    const t = info(r);
    if (skip !== 'cat' && ex.cat === 'new' && !t.isNew) return false;
    if (skip !== 'cat' && ex.cat !== 'all' && ex.cat !== 'new' && t.cat !== ex.cat) return false;
    if (skip !== 'chip' && ex.chip && !t.fams.has(ex.chip)) return false;
    if (skip !== 'fw' && ex.fw && !t.emu.length) return false;
    return !q || q.split(/\s+/).every(w => t.text.includes(w));
  }
  function exSort(list, how) {
    const by = {
      featured: (a, b) => info(b).score - info(a).score,
      updated: (a, b) => String(b.updated || '').localeCompare(String(a.updated || '')),
      added: (a, b) => String(b.added || '').localeCompare(String(a.added || '')) || info(b).score - info(a).score,
      parts: (a, b) => info(b).parts - info(a).parts,
      name: (a, b) => String(a.title).localeCompare(String(b.title)),
    }[how] || (() => 0);
    return list.slice().sort(by);
  }

  function renderExplore() {
    const main = $('#main');
    document.title = 'KiLive';
    main.innerHTML = '';
    main.className = 'explore';
    const ex = exState();
    // a topic chip on a board page lands here: a category, a chip family, or a word to search for
    if (App.topic && App.topic !== 'all') {
      const t = App.topic;
      if (CATS.some(c => c[0] === t)) { ex.cat = t; ex.chip = ''; }
      else if (CHIP_FAMS.some(c => c[0] === t) || ['ice40', 'ecp5'].includes(t)) { ex.chip = ['ice40', 'ecp5'].includes(t) ? 'fpga' : t; ex.cat = 'all'; }
      else { App.query = t; const ts = $('#top-search'); if (ts) ts.value = t; }
      App.topic = null;
    }
    const totals = App.index.reduce((a, r) => { const t = info(r); a.parts += t.parts; a.revs += t.revs; return a; }, { parts: 0, revs: 0 });
    const head = el('section', { class: 'ex-hero' },
      el('h1', null, 'Open a KiCad project'),
      el('p', { class: 'ex-lede' }, 'PCB, schematic and 3D in the browser, with a live circuit simulation and firmware emulation. Files are processed locally and never uploaded.'),
      N.gh.form({ big: true }),
      el('div', { class: 'ex-hero-alt' },
        el('a', { class: 'btn', href: '#new~upload' }, N.svg(I.upload), 'Upload files or .zip'),
        el('a', { class: 'btn', href: '#new' }, N.svg(I.pen || I.plus), 'Draw a schematic'),
        el('button', { class: 'btn ghost', type: 'button', onclick: () => N.kicadLink.pluginDialog() }, N.svg(I.chip || I.plus), 'KiCad plugin')),
      el('p', { class: 'muted small ex-hero-note' }, 'Link format: ', el('code', null, location.origin + location.pathname + '#gh/owner/repo'), '. Works as an "Open in KiLive" link in any README.'));
    const exH = el('div', { class: 'ex-sec-head' }, el('h2', null, 'Examples'), el('p', { class: 'muted small' }, `${App.index.length} boards, ${N.fmt.num(totals.parts)} parts, bundled with the app.`));
    const side = el('aside', { class: 'ex-side', 'aria-label': 'Filters' });
    const community = el('section', { class: 'community', id: 'community', 'aria-labelledby': 'community-h' });
    const mainCol = el('div', { class: 'ex-main' }, exTools(), community, el('div', { class: 'ex-results', id: 'ex-results', 'aria-live': 'polite' }));
    main.append(head, exH, el('div', { class: 'ex-layout' }, side, mainCol), el('section', { class: 'ex-more', id: 'ex-more' }),
      el('footer', { class: 'foot' }, el('p', null, 'Board files belong to their authors and are shown under their open licenses. Checks and simulations are aids; confirm findings in KiCad and on the bench.')));
    renderResults();
    renderCommunity();
  }

  // the toolbar above the results: search, sort, view. The categories and chip filters live in the sidebar
  function exTools() {
    const ex = exState();
    const search = el('input', { class: 'ex-search', type: 'search', placeholder: 'Search by name, chip or part number', 'aria-label': 'Search boards', value: App.query || '', autocomplete: 'off' });
    search.addEventListener('input', N.debounce(() => { App.query = search.value.trim().toLowerCase(); const ts = $('#top-search'); if (ts && ts.value.trim().toLowerCase() !== App.query) ts.value = search.value; renderResults(); }, 120));
    const sortSel = el('select', { class: 'ex-sel', 'aria-label': 'Sort boards', onchange: e => { ex.sort = e.target.value; N.store.set('ex-sort', ex.sort); renderResults(); } },
      SORTS.map(([k, l]) => el('option', { value: k, selected: ex.sort === k || null }, l)));
    const view = el('div', { class: 'ex-view', role: 'group', 'aria-label': 'View' },
      [['cards', 'Cards', I.grid], ['list', 'List', I.list]].map(([k, l, ic]) => el('button', { type: 'button', class: 'ex-vb', dataset: { v: k }, title: l, 'aria-label': l, onclick: () => { ex.view = k; N.store.set('ex-view', k); renderResults(); } }, N.svg(ic))));
    const count = el('span', { class: 'ex-count muted small' });
    const clear = el('button', { class: 'lnk ex-clear', type: 'button', hidden: true, onclick: () => { Object.assign(ex, { cat: 'all', chip: '', fw: false }); App.query = ''; search.value = ''; const ts = $('#top-search'); if (ts) ts.value = ''; renderResults(); } }, 'Clear filters');
    const bar = el('div', { class: 'ex-tools' }, el('label', { class: 'ex-sw' }, N.svg(I.search), search), count, clear, el('span', { class: 'ex-spacer' }), el('label', { class: 'ex-sort' }, el('span', { class: 'muted small' }, 'Sort'), sortSel), view);
    bar._parts = { search, sortSel, view, count, clear };
    return bar;
  }
  // the sidebar: categories as a list, the chip family, firmware; on a phone the same three as a row of controls
  function syncTools(list) {
    const bar = $('.ex-tools'), side = $('.ex-side');
    if (!bar || !bar._parts || !side) return;
    const ex = exState(), q = App.query || '', P = bar._parts;
    const inCat = App.index.filter(r => exMatch(r, ex, q, 'cat'));
    const cats = [['all', 'All boards', inCat.length], ['new', 'Added recently', inCat.filter(r => info(r).isNew).length]].concat(CATS.map(([k, , short]) => [k, short, inCat.filter(r => info(r).cat === k).length]));
    const inChip = App.index.filter(r => exMatch(r, ex, q, 'chip'));
    const chips = CHIP_FAMS.map(([k, l]) => [k, l, inChip.filter(r => info(r).fams.has(k)).length]).filter(c => c[2] || c[0] === ex.chip);
    const nFw = App.index.filter(r => exMatch(r, ex, q, 'fw') && info(r).emu.length).length;
    const catSel = el('select', { class: 'ex-sel', 'aria-label': 'Category', onchange: e => { ex.cat = e.target.value; renderResults(); } }, cats.map(([k, l, n]) => el('option', { value: k, selected: ex.cat === k || null }, `${l} (${n})`)));
    const chipSel = el('select', { class: 'ex-sel', 'aria-label': 'Chip family', onchange: e => { ex.chip = e.target.value; renderResults(); } },
      el('option', { value: '' }, 'Any chip'), ...chips.map(([k, l, n]) => el('option', { value: k, selected: ex.chip === k || null }, `${l} (${n})`)));
    const fwBox = el('label', { class: 'ex-check' }, el('input', { type: 'checkbox', checked: ex.fw || null, onchange: e => { ex.fw = e.target.checked; renderResults(); } }), el('span', null, 'Runs real firmware'), el('span', { class: 'muted' }, ` ${nFw}`));
    const mine = N.lib.list().length;
    side.replaceChildren(
      el('div', { class: 'ex-side-sec' }, el('h2', null, 'Category'),
        el('ul', { class: 'ex-cat-list' }, cats.filter(c => c[2] || c[0] === ex.cat || c[0] === 'all').map(([k, l, n]) => el('li', null, el('button', { type: 'button', class: ex.cat === k ? 'on' : '', 'aria-pressed': ex.cat === k ? 'true' : 'false', onclick: () => { ex.cat = k; renderResults(); } }, el('span', null, l), el('span', { class: 'n' }, String(n)))))),
        el('div', { class: 'ex-side-row' }, catSel)),
      el('div', { class: 'ex-side-sec' }, el('h2', null, 'Chip'), chipSel),
      el('div', { class: 'ex-side-sec' }, fwBox),
      el('div', { class: 'ex-side-sec ex-mine' }, el('h2', null, 'Made here'),
        el('p', { class: 'muted small' }, mine ? `${mine} board${mine === 1 ? '' : 's'} drawn or uploaded on KiLive, listed first below.` : N.lib.db ? ((window.claude && window.claude.local) ? 'Nothing yet. Boards you draw or upload are kept in your library on this device and listed here.' : 'Nothing shared yet. Boards you draw or upload are listed here for everyone.') : (window.claude && window.claude.local) ? 'Boards you draw or upload are kept in your library on this device and listed here.' : 'Boards made here appear when this page is opened in Claude.'),
        el('a', { class: 'lnk', href: '#new' }, 'New board', N.svg(I.right))));
    P.view.querySelectorAll('.ex-vb').forEach(b => b.classList.toggle('on', b.dataset.v === ex.view));
    P.count.textContent = list.length === App.index.length ? `${list.length} boards` : `${list.length} of ${App.index.length} boards`;
    P.clear.hidden = !(ex.cat !== 'all' || ex.chip || ex.fw || q);
    if (document.activeElement !== P.search && P.search.value.trim().toLowerCase() !== q) P.search.value = App.query || '';
  }
  function renderResults() {
    const host = $('#ex-results');
    if (!host) return;
    const ex = exState(), q = App.query || '';
    const list = exSort(App.index.filter(r => exMatch(r, ex, q)), ex.sort);
    syncTools(list);
    host.replaceChildren();
    if (!list.length) {
      host.append(el('div', { class: 'empty-note' }, el('p', null, q ? `No boards match “${q}” with these filters.` : 'No boards match these filters.'),
        el('button', { class: 'btn', type: 'button', onclick: () => $('.ex-clear') && $('.ex-clear').click() }, 'Clear filters')));
      return;
    }
    host.append(ex.view === 'list' ? repoList(list) : el('div', { class: 'repo-grid' }, list.map(repoCard)));
    renderMore();
  }
  // open-hardware projects that are not bundled: opened live from GitHub
  function renderMore() {
    const host = $('#ex-more');
    if (!host) return;
    const q = App.query || '';
    const all = App.more || [];
    const list = all.filter(m => !q || [m.title, m.desc, m.owner, m.repo, ...(m.topics || [])].join(' ').toLowerCase().includes(q));
    host.replaceChildren();
    if (!all.length) return;
    host.append(el('div', { class: 'ex-sec-head' }, el('h2', null, 'Open-hardware projects on GitHub'),
      el('p', { class: 'muted small' }, `${list.length} KiCad repositories, opened directly from GitHub. Licenses as stated by each repository.`)));
    if (!list.length) return;
    host.append(el('table', { class: 'more-table' },
      el('thead', null, el('tr', null, ['Project', 'Repository', 'Category', 'License', ''].map(h => el('th', null, h)))),
      el('tbody', null, list.map(m => el('tr', null,
        el('td', null, el('b', null, m.title), m.desc ? el('div', { class: 'muted small' }, m.desc.length > 110 ? m.desc.slice(0, 108) + '…' : m.desc) : null),
        el('td', { class: 'mono small' }, el('a', { href: m.url, target: '_blank', rel: 'noopener' }, m.owner + '/' + m.repo)),
        el('td', { class: 'small' }, m.category || ''),
        el('td', { class: 'small' }, m.license || '—'),
        el('td', null, el('a', { class: 'btn small', href: '#' + m.hash }, 'Open')))))));
  }

  // boards people made on KiLive (shared library): listed before the imported ones
  function renderCommunity() {
    const host = $('#community');
    if (!host) return;
    const q = App.query || '';
    const all = N.lib.list();
    const list = all.filter(e => !q || [e.meta.title, e.meta.desc, ...(e.meta.tags || []), ...((e.meta.stats && e.meta.stats.ics) || []).map(i => i[1])].join(' ').toLowerCase().includes(q));
    host.innerHTML = '';
    if (!list.length) return;
    host.append(el('h2', { class: 'ex-h2', id: 'community-h' }, 'Made on KiLive', el('span', { class: 'muted small' }, ` ${list.length}`)));
    const grid = el('div', { class: 'repo-grid' });
    for (const e of list.slice(0, 60)) grid.append(communityCard(e));
    host.append(grid, el('h2', { class: 'ex-h2' }, 'From GitHub'));
    const uids = [...new Set(list.slice(0, 60).map(e => e.uid))];
    N.social.names(uids).then(names => {
      host.querySelectorAll('[data-author]').forEach(n => { const p = names[n.dataset.author] || {}; n.textContent = p.name || (n.dataset.author === N.lib.uid ? 'You' : 'Someone'); });
    });
  }
  function communityCard(e) {
    const m = e.meta, st = m.stats || {};
    const repoId = N.lib.repoId(e.bid);
    const img = el('img', { alt: `${m.title} rendered in 3D`, loading: 'lazy', hidden: true });
    if (m.hasThumb) N.lib.thumb(e.uid, e.bid).then(src => { if (src) { img.src = src; img.hidden = false; } });
    const fails = Object.values(m.checks || {}).filter(s => s === 'fail').length;
    return el('a', { class: 'repo-card user-card', href: '#' + repoId + (m.kind === 'design' ? '~main~3d' : '') },
      el('div', { class: 'thumb' }, img),
      el('div', { class: 'rc-body' },
        el('h3', null, m.title),
        m.desc ? el('p', { class: 'rc-desc' }, m.desc) : null,
        el('div', { class: 'rc-facts' }, el('span', null, N.lib.kindLabel(m)), el('span', null, N.fmt.num(st.parts || 0) + ' parts'), st.w ? el('span', null, `${(+st.w).toFixed(0)} × ${(+st.h).toFixed(0)} mm`) : null),
        el('div', { class: 'rc-foot' }, el('span', null, 'by ', el('span', { dataset: { author: e.uid } }, '…')), el('span', null, N.fmt.ago(m.updated)),
          el('span', { class: 'stars-count' }, N.svg(I.star), el('span', { class: 'num', dataset: { stars: repoId } }, N.fmt.k(N.social.starCount(repoId)))),
          fails ? el('span', { class: 'rc-fail' }, fails + ' failing') : null)));
  }

  function repoCard(r) {
    const t = info(r);
    const b0 = r.boards[0];
    const href = '#' + [r.id, b0.id].join('~');
    const multi = r.boards.length > 1 || t.revs > 1;
    return el('a', { class: 'repo-card', href, dataset: { repo: r.id } },
      el('div', { class: 'thumb' }, el('img', { src: `thumbs/${r.id}.webp`, alt: `${r.title} rendered in 3D`, loading: 'lazy', decoding: 'async', onerror: e => { e.target.remove(); } })),
      el('div', { class: 'rc-body' },
        el('h3', null, r.title),
        el('p', { class: 'rc-desc' }, r.desc),
        el('div', { class: 'rc-facts' },
          t.chip ? el('span', null, t.chip) : null,
          el('span', null, N.fmt.num(t.parts) + ' parts'),
          t.layers ? el('span', null, t.layers + ' layers') : null,
          multi ? el('span', null, `${r.boards.length > 1 ? r.boards.length + ' boards, ' : ''}${t.revs} revision${t.revs > 1 ? 's' : ''}`) : null,
          t.emu.length ? el('span', { class: 'rc-fw', title: `${t.emu.join(' + ')} emulated: compiled firmware runs on this board` }, 'runs firmware') : null),
        el('div', { class: 'rc-foot' },
          el('span', { class: 'rc-owner' }, r.owner),
          r.license ? el('span', null, r.license) : null,
          t.isNew && r.added ? el('span', null, 'added ' + N.fmt.date(r.added)) : null,
          el('span', { class: 'stars-count' }, N.svg(I.star), el('span', { class: 'num', dataset: { stars: r.id } }, N.fmt.k(r.stars + N.social.starCount(r.id)))),
          t.st.fail ? el('span', { class: 'rc-fail', title: t.st.fail + ' design check' + (t.st.fail > 1 ? 's' : '') + ' failing: see Checks on the board page' }, t.st.fail + ' failing') : null)));
  }
  // the list view: one row a board, sortable by the same sort menu
  function repoList(list) {
    const catName = k => (CATS.find(c => c[0] === k) || [k, k, k])[2];
    const head = el('div', { class: 'rl-row rl-head', role: 'row' }, el('span'), el('span', null, 'Board'), el('span', null, 'Category'), el('span', null, 'Chip'), el('span', { class: 'num' }, 'Parts'), el('span', { class: 'num' }, 'Layers'), el('span', null, 'Updated'));
    return el('div', { class: 'repo-list', role: 'table', 'aria-label': 'Boards' }, head, list.map(r => {
      const t = info(r);
      return el('a', { class: 'rl-row', role: 'row', href: '#' + [r.id, r.boards[0].id].join('~') },
        el('span', { class: 'rl-thumb' }, el('img', { src: `thumbs/${r.id}.webp`, alt: '', loading: 'lazy', decoding: 'async', onerror: e => { e.target.remove(); } })),
        el('span', { class: 'rl-main' }, el('b', null, r.title), el('span', { class: 'muted small rl-desc' }, r.owner + ' · ' + r.desc + (t.emu.length ? ' · runs firmware' : ''))),
        el('span', { class: 'small' }, catName(t.cat)),
        el('span', { class: 'small' }, t.chip || '—'),
        el('span', { class: 'num small' }, N.fmt.num(t.parts)),
        el('span', { class: 'num small' }, t.layers || '—'),
        el('span', { class: 'muted small' }, r.updated ? N.fmt.date(r.updated) : '—'));
    }));
  }
  function updateExploreCounts() {
    document.querySelectorAll('[data-stars]').forEach(n => {
      const r = App.index.find(x => x.id === n.dataset.stars);
      if (r) n.textContent = N.fmt.k(r.stars + N.social.starCount(r.id));
      else if (/^u-/.test(n.dataset.stars)) n.textContent = N.fmt.k(N.social.starCount(n.dataset.stars));
    });
  }

  // ------------------------------------------------------------------ board page
  function teardownViews() {
    App.probeTool = false;
    if (N.live && N.live.on) N.live.stop();
    for (const k of Object.keys(App.views)) { try { App.views[k].destroy(); } catch (e) { /* ignore */ } }
    App.views = {};
    App.pageBuilt = null;
    if (App.designUI) { App.designUI.destroy(); App.designUI = null; }
  }

  async function openBoard(repo, board, version, tab) {
    const sameRepo = App.pageBuilt === repo.id;
    const key = `${repo.id}__${board.id}__${version.id}`;
    const same = App.cur && App.cur.key === key;
    App.tab = tab;
    setHash({ repo: repo.id, board: board.id, tab, version: version.id === board.default || board.versions.length === 1 ? '' : version.id });
    if (!sameRepo) buildPage(repo);
    App.cur = Object.assign(App.cur && same ? App.cur : {}, { repo, board, version, key });
    document.title = repo.user ? `${repo.title} · KiLive` : `${repo.title || repo.name} · ${board.name} · KiLive`;
    updateHeaderBits();
    if (!sameRepo) updateSocial();
    showTab(tab, true);
    if (same && App.cur.B) return;
    if (N.live && N.live.on) N.live.stop();
    App.cur.B = null;
    setLoading(true, repo.user ? `Opening ${repo.title}…` : `Loading ${board.name} ${version.label}…`);
    let data;
    try {
      data = repo.user ? (version.rev ? await loadRevision(repo, version) : await loadUserBoard(repo)) : await N.loadJSON(version.file);
    } catch (e) {
      setLoading(true, 'Could not load this board: ' + e.message);
      return;
    }
    if (!App.cur || App.cur.key !== key) return;
    const B = new N.Board(data);
    App.cur.B = B;
    App.sel = { refs: new Set(), nets: new Set() };
    for (const k of ['v3d', 'pcb', 'sch']) if (App.views[k]) App.views[k]._board = null;
    App.dirtyPanels = new Set(['bom', 'checks', 'files']);
    setLoading(false);
    showTab(App.tab, true);
    updateSelectionUI();
    if (repo.user) updateUserBits();
  }

  // ------------------------------------------------------------------ boards from the shared library and drafts
  async function loadUserBoard(repo) {
    const u = App.cur.user = { repo, draft: repo.draft ? repo.draftObj : null, dirty: false, design: null, data: null, built: null, meta: repo.meta };
    const hand = App.handoff && App.handoff.repoId === repo.id ? App.handoff : null;
    App.handoff = null;
    if (hand) { Object.assign(u, hand.user, { repo, draft: null, dirty: false, meta: repo.meta }); return hand.data; }
    if (u.draft) {
      if (u.draft.kind === 'design') { u.design = u.draft.design; return buildDesign(u); }
      u.data = u.draft.data;
      u.source = u.draft.source;
      return u.data;
    }
    const rec = await N.lib.loadBoard(repo.uid, repo.bid);
    u.meta = rec.meta || repo.meta;
    if (rec.design) { u.design = rec.design; return buildDesign(u); }
    u.data = rec.data;
    return u.data;
  }
  function buildDesign(u) {
    try {
      u.built = N.designer.build(u.design, { title: u.meta.title });
      u.buildError = null;
      return u.built.data;
    } catch (e) {
      console.error(e);
      u.buildError = e.message || String(e);
      if (u.built) return u.built.data;
      const empty = N.designer.build(N.designer.blank(u.meta.title), { title: u.meta.title });
      return empty.data;
    }
  }
  const isMine = () => { const u = App.cur && App.cur.user; return !!(u && !u.readonly && (u.draft || (N.lib.uid && App.cur.repo.uid === N.lib.uid))); };
  App.isMine = isMine;
  // an earlier revision of a library board: read-only
  async function loadRevision(repo, version) {
    const u = App.cur.user = { repo, draft: null, dirty: false, design: null, data: null, built: null, meta: repo.meta, readonly: true, rev: version.rev };
    u.data = await N.lib.loadRevision(repo.uid, repo.bid, version.rev);
    return u.data;
  }

  // ------------------------------------------------------------------ KiCad: new files for the open board, what changed, the live folder link
  App.kicadUpdate = function (r, opts) {
    opts = opts || {};
    const u = App.cur && App.cur.user;
    if (!u || u.readonly) return;
    const prev = u.data, prevB = App.cur.B;
    if (N.live && N.live.on) N.live.stop();
    u.data = r.data; u.source = r.source;
    u.meta = Object.assign({}, u.meta, { kicad: r.meta.kicad, mask: r.meta.mask, files: r.meta.files, stats: r.meta.stats, checks: r.meta.checks, src: Object.assign({}, u.meta.src || {}, r.meta.src) });
    if (u.draft) { u.draft.data = r.data; u.draft.source = r.source; u.draft.meta = u.meta; N.lib.putDraft(u.draft); }
    else { u.dirty = true; u.pendingRev = true; }
    const B = new N.Board(r.data);
    const keepRefs = [...App.sel.refs].filter(x => B.fp(x)), keepNets = [...App.sel.nets].map(n => prevB && prevB.nets[n]).map(nm => nm ? B.findNet(nm) : -1).filter(n => n > 0);
    App.cur.B = B;
    for (const k of ['v3d', 'pcb', 'sch']) if (App.views[k]) App.views[k]._board = null;
    App.dirtyPanels = new Set(['bom', 'checks', 'files']);
    App.sel = { refs: new Set(keepRefs), nets: new Set(keepNets) };
    App.cur.version.stats = Object.assign({}, App.cur.version.stats, B.stats);
    App.cur.version.checks = Object.fromEntries(B.checks.map(c => [c.id, c.status]));
    updateHeaderBits();
    showTab(App.tab, true);
    updateSelectionUI();
    const d = prev ? N.boardDiff(prev, r.data) : null;
    u.lastDiff = d ? { d, from: opts.prevLabel || 'Before', to: 'after the update' + (opts.from ? ' from ' + opts.from : ''), at: Date.now() } : null;
    updateUserBits();
    N.toast((opts.from ? 'Updated from ' + opts.from : 'Updated') + (d ? ': ' + N.diffSummary(d) : ''));
  };
  function showLastDiff() {
    const u = App.cur && App.cur.user;
    if (!u || !u.lastDiff) return;
    N.showBoardDiff(u.lastDiff.d, { title: 'What changed', from: u.lastDiff.from, to: u.lastDiff.to, onPick: pickFromDiff });
  }
  function pickFromDiff(ref) {
    select([ref], []);
    if (!['3d', 'pcb', 'sch'].includes(App.tab)) selectTab('pcb');
    requestAnimationFrame(() => focusSelectionIn(App.tab));
  }
  // the board data of a version (library revisions and GitHub history alike)
  async function versionData(repo, v) {
    if (v === App.cur.version && App.cur.B) return App.cur.B.data;
    if (repo.user) return v.rev ? N.lib.loadRevision(repo.uid, repo.bid, v.rev) : (App.cur.user && App.cur.user.data) || (await N.lib.loadBoard(repo.uid, repo.bid)).data;
    return N.loadJSON(v.file);
  }
  async function compareVersions(older, newer) {
    const { repo } = App.cur;
    N.toast('Comparing ' + older.label + ' with ' + newer.label + '…', 'info');
    try {
      const [a, b] = await Promise.all([versionData(repo, older), versionData(repo, newer)]);
      const d = N.boardDiff(a, b);
      N.showBoardDiff(d, { title: 'What changed', from: older.label, to: newer.label, onPick: newer === App.cur.version ? pickFromDiff : null });
    } catch (e) { N.toast('Could not compare: ' + (e.message || e), 'warn'); }
  }
  // the revisions before and after one: library boards list them newest first, repositories oldest first
  function neighbours(board, v, user) {
    const i = board.versions.indexOf(v), a = board.versions[i + 1], b = board.versions[i - 1];
    return user ? { older: a, newer: b } : { older: b, newer: a };
  }
  function pickKiCadFiles(folder) {
    const inp = el('input', { type: 'file', multiple: true, accept: folder ? null : '.zip,.kicad_pcb,.kicad_sch,.kicad_pro,.noeti', hidden: true });
    if (folder) { inp.webkitdirectory = true; inp.setAttribute('webkitdirectory', ''); }
    inp.addEventListener('change', async () => {
      const list = [...inp.files]; inp.remove();
      const noeti = list.find(f => /\.noeti$/i.test(f.name));
      if (noeti) { N.kicadLink.receiveText(await noeti.text()); return; }
      let files = {};
      const zip = list.find(f => /\.zip$/i.test(f.name));
      if (zip) files = await N.kicad.unzip(await zip.arrayBuffer(), { filter: p => /\.kicad_(pcb|sch|pro)$/i.test(p) });
      else for (const f of list) files[f.webkitRelativePath || f.name] = f;
      const pcb = Object.keys(files).map(k => k.split('/').pop()).find(k => /\.kicad_pcb$/i.test(k));
      N.kicadLink.receive(files, { project: pcb ? pcb.replace(/\.kicad_pcb$/i, '') : '', from: 'files' });
    });
    document.body.append(inp);
    inp.click();
  }
  // a project folder on this computer, re-read whenever KiCad saves
  async function linkFolder() {
    const K = N.kicadLink;
    let L;
    try { L = await K.linkFolder(); } catch (e) { K.linkBlockedDialog(e); return; }
    if (!L) return;
    const repo = App.cur.repo;
    let r;
    try { r = await K.importFiles(L.files, { project: App.cur.user && App.cur.user.meta.src && App.cur.user.meta.src.name }); } catch (e) { N.toast('Could not read that folder: ' + (e.message || e), 'warn'); return; }
    App.kicadUpdate(r, { from: 'folder ' + L.name });
    watchLinked(L, repo.id);
  }
  function watchLinked(L, repoId) {
    N.kicadLink.watch(L, repoId, linkedUpdate(repoId));
  }
  // the board KiCad serves (KiLive KiCad plugin): open it, then follow every update
  async function openFromKiCad() {
    const main = $('#main');
    main.className = 'explore';
    main.replaceChildren(el('div', { class: 'fatal' }, el('div', { class: 'spinner' }), el('p', { class: 'muted' }, 'Opening the board from KiCad…')));
    const K = N.kicadLink;
    let p, r;
    try { p = await K.server.project(); r = await K.importFiles(p.files, { project: p.name }); }
    catch (e) { notFound('No board from KiCad', (e.message || String(e)) + '. This address works when the page is opened by the KiLive button in the KiCad PCB Editor.'); return; }
    r.meta.src = Object.assign({}, r.meta.src, { label: 'Live from KiCad' });
    const d = K.newDraft(r);
    K.watchServer(p, N.lib.draftRepoId(d.id), linkedUpdate(N.lib.draftRepoId(d.id)));
  }
  function linkedUpdate(repoId) {
    return async files => {
      let r;
      try { r = await N.kicadLink.importFiles(files); } catch (e) { N.toast('KiCad: ' + (e.message || e), 'warn'); return; }
      if (App.cur && App.cur.repo.id === repoId) App.kicadUpdate(r, { from: 'KiCad (saved ' + new Date().toTimeString().slice(0, 5) + ')' });
      else { const d = /^draft-/.test(repoId) && N.lib.getDraft(repoId.slice(6)); if (d) { d.data = r.data; d.source = r.source; Object.assign(d.meta, { stats: r.meta.stats, checks: r.meta.checks, files: r.meta.files }); N.lib.putDraft(d); } }
    };
  }
  App.watchLinked = watchLinked;
  N.bus.on('kicadlink', () => updateUserBits());
  async function exportSimForKiCad() {
    if (!App.cur || !App.cur.B) return;
    try { await N.kicadLink.exportSim(liveModel(), panelCtx().fileBase); }
    catch (e) { console.error(e); N.toast('Could not export the simulation: ' + (e.message || e), 'warn'); }
  }
  function kicadMenu(btn) {
    const { repo, B } = App.cur;
    const u = App.cur.user, K = N.kicadLink;
    const mineKicad = repo.user && u && !u.design && !u.readonly && isMine();
    const linked = K.link && K.link.target === repo.id;
    const versions = App.cur.board.versions;
    N.menu(btn, [
      { header: 'KiCad' },
      mineKicad ? { label: 'Update from KiCad files…', hint: 'new revision', icon: I.upload, onClick: () => pickKiCadFiles(false) } : null,
      mineKicad ? { label: 'Update from a project folder…', icon: I.folder, onClick: () => pickKiCadFiles(true) } : null,
      mineKicad ? (linked ? { label: 'Stop the live link to ' + K.link.name, icon: I.close, onClick: () => K.unlink() } : { label: 'Link a KiCad folder (live)…', hint: 'Chrome, Edge', icon: I.folder, onClick: linkFolder }) : null,
      mineKicad ? { node: el('div', { class: 'menu-note small muted' }, 'Or press Ctrl+V after Send to KiLive in KiCad') } : null,
      u && u.lastDiff ? { label: 'What changed in the last update', icon: I.history, onClick: showLastDiff } : null,
      versions.length > 1 ? (() => { const nb = neighbours(App.cur.board, App.cur.version, !!repo.user); const o = nb.older || App.cur.version, n = nb.older ? App.cur.version : nb.newer; return { label: 'Compare ' + o.label + ' with ' + n.label, icon: I.compare, onClick: () => compareVersions(o, n) }; })() : null,
      '-',
      B ? { label: 'Simulation for KiCad (.zip)', hint: 'ngspice', icon: I.probe, onClick: exportSimForKiCad } : null,
      { label: 'Get the KiCad plugin…', hint: 'Send to KiLive', icon: I.download, onClick: () => K.pluginDialog() },
    ].filter(Boolean), { alignRight: true, cls: 'wide' });
  }
  const canEditDesign = () => isMine();

  // rebuild the board from the drawing (debounced while drawing)
  const rebuildSoon = N.debounce(() => rebuildDesign(), 450);
  function rebuildDesign() {
    const u = App.cur && App.cur.user;
    if (!u || !u.design) return;
    const t0 = performance.now();
    const data = buildDesign(u);
    const B = new N.Board(data);
    const keepRefs = [...App.sel.refs].filter(r => B.fp(r)), keepNets = [...App.sel.nets].map(n => App.cur.B && App.cur.B.nets[n]).map(nm => nm ? B.findNet(nm) : -1).filter(n => n > 0);
    App.cur.B = B;
    for (const k of ['v3d', 'pcb', 'sch']) if (App.views[k]) App.views[k]._board = null;
    App.dirtyPanels = new Set(['bom', 'checks', 'files']);
    App.sel = { refs: new Set(keepRefs), nets: new Set(keepNets) };
    const st = B.stats;
    App.cur.version.stats = Object.assign({}, App.cur.version.stats, st);
    App.cur.version.checks = Object.fromEntries(B.checks.map(c => [c.id, c.status]));
    updateHeaderBits();
    if (N.live && N.live.on) { try { N.live.rebuild(liveModel()); } catch (e) { console.error(e); N.live.stop(); } }
    if (App.designUI) {
      const fails = B.checks.filter(c => c.status === 'fail').length, warns = B.checks.filter(c => c.status === 'warn').length;
      if (u.buildError) App.designUI.setStatus('bad', 'Could not build the board: ' + u.buildError);
      else App.designUI.setStatus(fails ? 'bad' : 'ok', `${st.parts} part${st.parts === 1 ? '' : 's'} · ${st.nets} net${st.nets === 1 ? '' : 's'} · board ${st.w.toFixed(0)} × ${st.h.toFixed(0)} mm · ${fails ? fails + ' failing, ' : ''}${warns} to review · ${Math.round(performance.now() - t0)} ms`);
      App.designUI.refreshOptions();
    }
    if (App.tab !== 'design') showTab(App.tab, true);
  }
  function designEdited(design, what) {
    const u = App.cur && App.cur.user;
    if (!u) return;
    u.design = design;
    const t = (design.doc && design.doc.title || '').trim();
    if (t && t !== u.meta.title) { u.meta = Object.assign({}, u.meta, { title: t.slice(0, 80) }); App.cur.repo.title = App.cur.repo.name = u.meta.title; refreshUserHeader(); }
    markDirty();
    if (what === 'options') rebuildDesign(); else rebuildSoon();
  }
  function markDirty() {
    const u = App.cur && App.cur.user;
    if (!u) return;
    if (u.draft) { u.draft.design = u.design; u.draft.meta = u.meta; N.lib.putDraft(u.draft); }
    else if (isMine()) { u.dirty = true; updateUserBits(); }
  }

  // ------------------------------------------------------------------ Design tab
  function ensureDesign() {
    const pane = $('#pane-design');
    const u = App.cur && App.cur.user;
    if (!pane || !u || !u.design) return;
    if (App.designUI && App.designUI._for === u) return;
    if (App.designUI) App.designUI.destroy();
    App.designUI = N.designer.mountDesignTab(pane, {
      design: u.design, readOnly: !canEditDesign(),
      onEdit: designEdited,
      onRemix: () => remixBoard(),
      applied: () => u.built && u.built.comp && u.built.comp.ap,
    });
    App.designUI._for = u;
    const B = App.cur.B;
    if (u.buildError) App.designUI.setStatus('bad', 'Could not build the board: ' + u.buildError);
    else if (B) App.designUI.setStatus('ok', `${B.stats.parts} part${B.stats.parts === 1 ? '' : 's'} · ${B.stats.nets} nets · board ${B.meta.w.toFixed(0)} × ${B.meta.h.toFixed(0)} mm`);
  }

  // ------------------------------------------------------------------ Live simulation of the whole board
  function liveModel() {
    const B = App.cur.B, u = App.cur.user;
    if (u && u.design && u.built) {
      const b = u.built;
      const padsOf = new Map();
      for (const s of b.r.symbols || []) {
        const m = new Map();
        for (const [pin, num] of Object.entries(s.pinMap || {})) m.set(String(pin), [String(num)]);
        padsOf.set(s.ref, m);
      }
      return { B, circuit: b.circuit, sim: N.designer.effectiveSim(u.design, b.circuit), vals: b.comp.ap.values, alias: u.design.alias || {}, padsOf };
    }
    const wb = N.simtab.wholeBoard(B);
    return { B, circuit: wb.circuit, sim: wb.sim, vals: {}, alias: {}, padsOf: wb.padsOf };
  }
  function toggleLive() {
    if (N.live.on) { N.live.stop(); return; }
    const B = App.cur && App.cur.B;
    if (!B) return;
    if (!['3d', 'pcb', 'sch'].includes(App.tab)) selectTab(App.tab === 'design' ? 'sch' : 'pcb');
    let model;
    const btn = $('#live-btn');
    try {
      if (btn) btn.classList.add('busy');
      model = liveModel();
    } catch (e) {
      console.error(e);
      N.toast('This board could not be set up for simulation: ' + (e.message || e), 'warn');
      return;
    } finally { if (btn) btn.classList.remove('busy'); }
    if (!model.circuit.components.length) { N.toast('There is nothing to simulate on this board yet. Draw a circuit in the Design tab first.'); return; }
    N.live.start({
      B, model, host: $('#vc-body'),
      remodel: () => { if (B._simFull) delete B._simFull; return liveModel(); },
      getViews: () => ({ tab: App.tab, pcb: App.views.pcb, sch: App.views.sch, v3d: App.views.v3d }),
      visible: () => !document.hidden && ['3d', 'pcb', 'sch'].includes(App.tab),
      onSelect: (refs, nets) => select(refs, nets),
      getSelection: () => App.sel,
      refreshTip: () => { if (App.tab === 'pcb' && App.views.pcb && App.views.pcb.refreshTip) App.views.pcb.refreshTip(); if (App.tab === '3d' && App.last3DHover && App.v3dUI && !App.v3dUI.tip.hidden) hover3D(App.last3DHover); },
    });
  }
  N.bus.on('live', on => {
    const b = $('#live-btn');
    if (!b) return;
    b.classList.toggle('on', !!on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = on ? 'Stop the live simulation' : 'Run the whole board live: voltages as colours, currents as moving dots';
  });
  N.startLive = () => { if (!N.live.on) toggleLive(); };

  // ------------------------------------------------------------------ save, remix, delete, details
  function boardMetaFromCurrent(fields) {
    const u = App.cur.user, B = App.cur.B;
    const meta = Object.assign({}, u.meta, fields || {});
    meta.stats = Object.assign({}, B.stats);
    meta.checks = Object.fromEntries(B.checks.map(c => [c.id, c.status]));
    meta.mask = B.meta.mask;
    meta.kicad = u.design ? '8' : (u.meta.kicad || '8');
    if (u.design && u.built) meta.files = Object.entries(u.built.files).map(([k, v]) => [k, typeof v === 'string' ? new Blob([v]).size : v.length]);
    return meta;
  }
  function detailsForm(meta, submitLabel, onSubmit, note) {
    const title = el('input', { class: 'input', id: 'bd-title', value: meta.title || '', maxlength: '80', required: true });
    const desc = el('textarea', { class: 'input', id: 'bd-desc', rows: '3', maxlength: '600', placeholder: 'What the board does, what is special about it, what you would like feedback on' });
    desc.value = meta.desc || '';
    const tags = el('input', { class: 'input', id: 'bd-tags', value: (meta.tags || []).join(', '), placeholder: 'e.g. power, usb-c, rp2040' });
    const lic = el('select', { class: 'input', id: 'bd-lic' }, ['CC-BY-4.0', 'CC-BY-SA-4.0', 'CERN-OHL-S-2.0', 'CERN-OHL-P-2.0', 'MIT', 'All rights reserved'].map(l => el('option', { value: l, selected: l === (meta.license || 'CC-BY-4.0') || null }, l)));
    const status = el('div', { class: 'small muted', role: 'status', 'aria-live': 'polite' });
    const btn = el('button', { class: 'btn primary', type: 'submit' }, submitLabel);
    const form = el('form', { class: 'bd-form' },
      el('label', { for: 'bd-title' }, 'Title'), title,
      el('label', { for: 'bd-desc' }, 'Description'), desc,
      el('div', { class: 'bd-row' }, el('div', null, el('label', { for: 'bd-tags' }, 'Tags'), tags), el('div', null, el('label', { for: 'bd-lic' }, 'License'), lic)),
      note ? el('p', { class: 'muted small' }, note) : null, status);
    const m = N.modal(submitLabel, form, [el('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, 'Cancel'), btn]);
    const submit = async e => {
      e && e.preventDefault();
      if (!title.value.trim()) { title.focus(); return; }
      btn.disabled = true;
      try {
        await onSubmit({ title: title.value.trim().slice(0, 80), desc: desc.value.trim().slice(0, 600), tags: tags.value.split(/[,\s]+/).map(t => t.trim().toLowerCase().replace(/[^a-z0-9.+-]/g, '')).filter(Boolean).slice(0, 8), license: lic.value }, t => { status.textContent = t; });
        m.close();
      } catch (err) {
        status.textContent = '';
        status.append(el('span', { class: 'err' }, saveError(err)));
        btn.disabled = false;
      }
    };
    form.addEventListener('submit', submit);
    btn.addEventListener('click', submit);
    return m;
  }
  function saveError(e) {
    if (e && e.code === 'offline') return 'Saving to the shared library needs this page to be open in Claude while you are signed in.';
    if (e && e.code === 'too_large') return 'This board is too large for the shared library (' + N.fmt.bytes(e.bytes || 0) + ' compressed).';
    if (e && e.code === 'quota_exceeded') return 'The shared library is full. Delete a board you no longer need, then try again.';
    if (e && e.code === 'invalid_argument') return 'Your access to this page is view-only, so you cannot save boards.';
    return 'Could not save: ' + ((e && (e.message || e.code)) || e);
  }
  async function saveBoard() {
    const u = App.cur && App.cur.user;
    if (!u) return;
    if (!N.lib.live) { N.toast(saveError({ code: 'offline' }), 'warn'); return; }
    const first = !!u.draft;
    const doSave = async (fields, step) => {
      const meta = boardMetaFromCurrent(fields);
      if (u.design) u.design.doc.title = meta.title;
      step('Rendering a preview…');
      const thumb = await N.designer.thumbnail(App.cur.B);
      let source = null;
      if (u.source) source = await N.lib.gzip(JSON.stringify(u.source));
      const res = await N.lib.save({ bid: first ? null : App.cur.repo.bid, meta, design: u.design || null, data: u.design ? null : u.data, source, thumb, keepRevision: !first && !!u.pendingRev }, step);
      if (first) {
        const d = u.draft;
        N.lib.dropDraft(d.id);
        App.handoff = { repoId: N.lib.repoId(res.bid), data: App.cur.B.data, user: { design: u.design, data: u.data, built: u.built, source: u.source } };
        N.toast('Saved to the shared library');
        location.hash = N.lib.repoId(res.bid) + '~main~' + (App.tab || '3d');
      } else {
        u.dirty = false;
        const kept = u.pendingRev && res.meta.revs && res.meta.revs.length;
        u.pendingRev = false;
        u.meta = res.meta;
        // the version menu lists the revision just kept
        const fresh = N.lib.toRepo({ uid: App.cur.repo.uid, bid: App.cur.repo.bid, meta: res.meta });
        App.cur.board.versions = fresh.boards[0].versions; App.cur.version = App.cur.board.versions[0];
        N.toast(kept ? 'Saved as rev ' + res.meta.rev + ' · rev ' + (res.meta.rev - 1) + ' is kept for comparing' : 'Changes saved');
        updateHeaderBits();
        updateUserBits();
      }
    };
    if (first) detailsForm(u.meta, (window.claude && window.claude.local) ? 'Save to your library' : 'Save to the shared library', doSave, (window.claude && window.claude.local) ? 'The board is kept in your library on this device, with every revision. You can change or delete it later.' : 'Everyone who opens this page will see the board in the library, with your name as the author. You can change or delete it later.');
    else {
      const btn = $('#save-btn');
      if (btn) btn.disabled = true;
      try { await doSave({}, t => { if (btn) btn.lastChild.textContent = t.replace(/…$/, '…'); }); }
      catch (e) { N.toast(saveError(e), 'warn'); }
      finally { if (btn) { btn.disabled = false; } updateUserBits(); }
    }
  }
  function editDetails() {
    const u = App.cur.user;
    detailsForm(u.meta, u.draft ? 'Board details' : 'Edit details', async fields => {
      Object.assign(u.meta, fields);
      App.cur.repo.title = App.cur.repo.name = u.meta.title;
      App.cur.repo.desc = u.meta.desc;
      if (u.design) u.design.doc.title = u.meta.title;
      if (u.draft) { u.draft.meta = u.meta; N.lib.putDraft(u.draft); }
      else u.dirty = true;
      refreshUserHeader();
      updateUserBits();
    });
  }
  function remixBoard() {
    const u = App.cur.user;
    if (!u || !u.design) return;
    const design = JSON.parse(JSON.stringify(u.design));
    design.source = Object.assign({}, design.source, { remixOf: { uid: App.cur.repo.uid, bid: App.cur.repo.bid, title: u.meta.title } });
    const meta = { title: u.meta.title + ' (remix)', desc: u.meta.desc || '', tags: (u.meta.tags || []).slice(), license: u.meta.license, kind: 'design', origin: u.meta.origin || 'design', src: { label: 'Remix of ' + u.meta.title }, remixOf: { uid: App.cur.repo.uid, bid: App.cur.repo.bid } };
    const d = N.lib.putDraft({ id: N.lib.newId('d'), kind: 'design', meta, design });
    location.hash = N.lib.draftRepoId(d.id) + '~main~design';
  }
  async function deleteBoard(btn) {
    const u = App.cur.user;
    if (u.draft) { N.lib.dropDraft(u.draft.id); location.hash = 'new'; return; }
    N.menu(btn, [{ header: 'Delete this board?' }, { node: el('p', { class: 'small muted menu-note' }, 'It disappears from the shared library for everyone. Stars and comments on it stay hidden.') },
      { label: 'Delete for good', icon: I.trash, onClick: async () => {
        try { await N.lib.remove(App.cur.repo.bid); N.toast('Board deleted'); location.hash = 'explore'; }
        catch (e) { N.toast('Could not delete the board: ' + ((e && (e.message || e.code)) || e), 'warn'); }
      } }], { alignRight: true });
  }
  async function projectZip() {
    const u = App.cur.user;
    if (u.design && u.built) return N.designer.zip(u.built.files, u.built.name);
    let src = u.source;
    if (!src && App.cur.repo.meta && App.cur.repo.meta.hasSource && !App.cur.repo.draft) {
      const rec = await N.lib.db.doc(`library/${App.cur.repo.uid}/boards/${App.cur.repo.bid}`).get();
      const n = rec.exists ? rec.data().srcChunks : 0;
      if (n) { src = JSON.parse(await N.lib.gunzip(await N.lib.loadSource(App.cur.repo.uid, App.cur.repo.bid, n))); u.source = src; }
    }
    if (!src) return null;
    return DS2K_ZIP.makeZip(src, N.lib.slug(App.cur.repo.title) || 'board');
  }
  async function downloadProject() {
    const z = await projectZip().catch(() => null);
    if (!z) { N.toast('The KiCad source files were not stored with this board.', 'warn'); return; }
    N.saveFile((N.lib.slug(App.cur.repo.title) || 'board') + '-kicad.zip', new Blob([z], { type: 'application/zip' }), () => N.social.countDownload(App.cur.repo.id));
  }

  // the facts under a board's name: its chip, size and whether real firmware runs on it
  function bpFacts(repo) {
    const t = info(repo);
    return el('div', { class: 'bp-facts' },
      t.chip ? el('span', null, t.chip) : null,
      el('span', null, N.fmt.num(t.parts) + ' parts'),
      t.layers ? el('span', null, t.layers + ' layers') : null,
      el('span', null, 'KiCad ' + t.kicad.join('/')),
      t.emu.length ? el('span', { class: 'code-pill emu', title: 'Its processor is emulated: upload real compiled firmware and it runs on the board' }, N.svg(I.code), t.emu.join(' + ') + ' firmware') : null,
      t.isNew && repo.added ? el('span', { class: 'muted' }, 'added ' + N.fmt.date(repo.added)) : null);
  }
  function buildPage(repo) {
    teardownViews();
    App.pageBuilt = repo.id;
    TABS = tabsFor(repo);
    const main = $('#main');
    main.innerHTML = '';
    main.className = 'board';
    const starBtn = el('button', { class: 'btn', id: 'star-btn', onclick: () => N.social.toggleStar(repo.id) }, el('span', { class: 'star-ico' }), el('span', { class: 'star-label' }, 'Star'), el('span', { class: 'count num', id: 'star-count' }));
    const dlBtn = el('button', { class: 'btn', onclick: e => downloadMenu(e.currentTarget) }, N.svg(I.download), 'Download', N.svg(I.chevron, 'tiny'));
    const shareBtn = el('button', { class: 'btn', onclick: e => shareMenu(e.currentTarget) }, N.svg(I.share), 'Share');
    const kicadBtn = el('button', { class: 'btn', id: 'kicad-btn', title: 'KiCad: plugin, updates, compare, simulation export', onclick: e => kicadMenu(e.currentTarget) }, N.svg(I.chip), 'KiCad', N.svg(I.chevron, 'tiny'));
    const head = repo.user ? userHead(repo, starBtn, dlBtn, shareBtn, kicadBtn) : el('div', { class: 'bp-head' },
      el('div', { class: 'bp-title' },
        el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, el('a', { href: '#explore' }, 'Explore'), el('span', null, '/'),
          el('a', { href: '#explore', onclick: () => { App.topic = repo.category || 'other'; } }, (CATS.find(c => c[0] === (repo.category || 'other')) || CATS[CATS.length - 1])[2]), el('span', null, '/'),
          el('a', { class: 'mono', href: repo.url, target: '_blank', rel: 'noopener' }, repo.owner + '/' + repo.name)),
        el('div', { class: 'bp-h1row' }, el('h1', null, repo.title || repo.name)),
        bpFacts(repo)),
      el('div', { class: 'bp-actions' }, starBtn, kicadBtn, dlBtn, shareBtn));
    const tabs = el('div', { class: 'vc-tabs', role: 'tablist', 'aria-label': 'Board views' },
      TABS.map(([id, label, icon]) => el('button', { role: 'tab', class: 'vc-tab', id: 'tab-' + id, 'aria-controls': 'vc-body', dataset: { tab: id }, onclick: () => selectTab(id) }, N.svg(icon), el('span', null, label), id === 'checks' ? el('span', { class: 'tab-badge', id: 'checks-badge' }) : null)),
      el('div', { class: 'vc-right' },
        el('button', { class: 'btn live-btn', id: 'live-btn', 'aria-pressed': 'false', title: 'Run the whole board live: voltages as colours, currents as moving dots', onclick: toggleLive }, el('span', { class: 'lb-dot' }), el('span', { class: 'lb-label' }, 'Live')),
        el('button', { class: 'btn ver-btn', id: 'ver-btn', onclick: e => versionMenu(e.currentTarget) }, N.svg(I.history), el('span', { id: 'ver-label' }), N.svg(I.chevron, 'tiny')),
        el('button', { class: 'icon-btn', 'aria-label': 'Board details', onclick: e => infoPop(e.currentTarget) }, N.svg(I.info)),
        el('span', { class: 'vsep' }),
        el('button', { class: 'icon-btn', 'aria-label': 'Full screen', onclick: toggleFull }, N.svg(I.expand))));
    const body = el('div', { class: 'vc-body', id: 'vc-body', role: 'tabpanel' },
      repo.user && repo.kind === 'design' ? el('div', { class: 'pane pane-design', id: 'pane-design' }) : null,
      el('div', { class: 'pane pane-3d', id: 'pane-3d' }),
      el('div', { class: 'pane pane-pcb', id: 'pane-pcb' }),
      el('div', { class: 'pane pane-sch', id: 'pane-sch' }),
      el('div', { class: 'pane pane-panel', id: 'pane-bom' }),
      el('div', { class: 'pane pane-panel', id: 'pane-checks' }),
      el('div', { class: 'pane pane-panel', id: 'pane-files' }),
      el('div', { class: 'selcard', id: 'selcard', hidden: true }),
      el('div', { class: 'loading', id: 'loading' }, el('div', { class: 'spinner' }), el('span', { id: 'loading-text' }, 'Loading…')));
    const viewer = el('section', { class: 'viewer-card', id: 'viewer-card', 'aria-label': 'Board viewer' }, tabs, body);
    const photoUrl = repo.user ? null : `photos/${repo.id}.webp`;
    const photo = photoUrl ? el('figure', { class: 'about-photo' },
      el('button', { class: 'ap-btn', type: 'button', 'aria-label': 'Open the 2K photo of ' + repo.title, onclick: () => {
        const B = App.cur && App.cur.B;
        if (N.photoDialog && B) N.photoDialog(B, { name: repo.id, prerendered: photoUrl, viewer: App.views.v3d || null });
      } }, el('img', { src: photoUrl, alt: 'Rendered photo of ' + repo.title, loading: 'lazy', decoding: 'async', onerror: e => { const f = e.currentTarget.closest('figure'); if (f) f.hidden = true; } })),
      el('figcaption', { class: 'muted small' }, N.svg(I.camera || I.cube), `${repo.boards[0] ? repo.boards[0].name : repo.title} · 2K render from the KiCad files`)) : null;
    const about = repo.user ? userAbout(repo) : el('section', { class: 'about', 'aria-labelledby': 'about-h' },
      el('h2', { id: 'about-h' }, 'About'),
      photo,
      el('p', { class: 'about-desc' }, repo.desc),
      repo.homepage ? el('a', { class: 'about-link', href: repo.homepage, target: '_blank', rel: 'noopener' }, N.svg(I.link), repo.homepage.replace(/^https?:\/\//, '')) : null,
      el('a', { class: 'about-link', href: repo.url, target: '_blank', rel: 'noopener' }, N.svg(I.link), repo.url.replace(/^https?:\/\//, '')),
      el('div', { class: 'tags' }, repo.topics.map(t => el('a', { class: 'tag-chip mono', href: '#explore', onclick: () => { App.topic = t; } }, t))),
      el('div', { class: 'lic-chip mono' }, N.svg(I.law), repo.license + ' license'),
      el('ul', { class: 'about-stats' },
        el('li', null, N.svg(I.star), el('span', { id: 'about-stars' })),
        el('li', null, N.svg(I.comment), el('span', { id: 'about-comments' })),
        el('li', null, N.svg(I.download), el('span', { id: 'about-downloads' }))),
      el('p', { class: 'muted small' }, 'Updated ' + N.fmt.date(repo.updated) + ' · commit ', el('a', { class: 'mono', href: `${repo.url}/commit/${repo.head}`, target: '_blank', rel: 'noopener' }, repo.head)));
    const comments = el('section', { class: 'comments', id: 'comments', 'aria-labelledby': 'comments-h' });
    main.append(el('div', { class: 'board-page' }, head, el('div', { class: 'bp-grid' }, el('div', { class: 'bp-main' }, viewer, comments), el('aside', { class: 'bp-side' }, about))));
    renderComments();
    updateSocial();
    // keyboard shortcuts for tabs
    tabs.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = TABS.findIndex(t => t[0] === App.tab);
      const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
      selectTab(n);
      $('#tab-' + n).focus();
    });
  }

  // header + about sidebar for boards made on KiLive
  function userHead(repo, starBtn, dlBtn, shareBtn, kicadBtn) {
    const mine = repo.draft || (N.lib.uid && repo.uid === N.lib.uid);
    const actions = el('div', { class: 'bp-actions', id: 'bp-actions' });
    if (repo.draft) {
      actions.append(linkChip(), diffBtn(), el('button', { class: 'btn primary', id: 'save-btn', onclick: saveBoard }, N.svg(I.upload), el('span', null, 'Save to library')), kicadBtn, dlBtn,
        el('button', { class: 'btn ghost', onclick: e => deleteBoard(e.currentTarget), title: 'Discard this draft' }, N.svg(I.trash), 'Discard'));
    } else {
      putKids(actions, linkChip(), diffBtn(), el('button', { class: 'btn primary', id: 'save-btn', hidden: true, onclick: saveBoard }, N.svg(I.upload), el('span', null, 'Save changes')), starBtn, kicadBtn, dlBtn,
        repo.kind === 'design' && !mine ? el('button', { class: 'btn', onclick: remixBoard, title: 'Copy this design into a draft of your own' }, N.svg(I.copy), 'Remix') : null, shareBtn,
        mine ? el('button', { class: 'btn icon-only', 'aria-label': 'More actions', onclick: e => N.menu(e.currentTarget, [
          { label: 'Edit title, description and tags', icon: I.pen, onClick: editDetails },
          repo.kind === 'design' ? { label: 'Remix into a new draft', icon: I.copy, onClick: remixBoard } : null,
          '-', { label: 'Delete this board…', icon: I.trash, onClick: () => deleteBoard(e.target.closest('button')) }].filter(Boolean), { alignRight: true }) }, '⋯') : null);
    }
    return el('div', { class: 'bp-head' },
      el('div', { class: 'bp-title' },
        el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, el('a', { href: '#explore' }, 'Explore'), el('span', null, '/'), el('span', null, repo.draft ? 'Drafts' : 'Made on KiLive')),
        el('div', { class: 'bp-h1row' }, el('h1', { id: 'bp-h1' }, repo.title), repo.draft ? el('button', { class: 'public draft-chip', onclick: editDetails, title: 'Edit the title and description' }, 'Draft') : null,
          repo.draft ? el('button', { class: 'icon-btn small', 'aria-label': 'Rename', onclick: editDetails }, N.svg(I.pen)) : null),
        el('div', { class: 'bp-owner' }, el('span', { class: 'kind-chip' }, N.lib.kindLabel(repo.meta)), ' ', el('span', { class: 'muted', id: 'bp-author' }, repo.draft ? 'by you' : ''))),
      actions);
  }
  // the live folder link, while one is running for this board
  function linkChip() {
    return el('button', { class: 'link-chip', id: 'link-chip', hidden: true, title: 'Linked to a KiCad project folder: each save in KiCad updates this board. Click to stop.', onclick: () => N.kicadLink.unlink() },
      el('span', { class: 'lc-dot' }), el('span', { class: 'lc-t' }));
  }
  function diffBtn() {
    return el('button', { class: 'btn', id: 'diff-btn', hidden: true, onclick: showLastDiff }, N.svg(I.compare), el('span', null, 'What changed'));
  }
  function userAbout(repo) {
    const m = repo.meta;
    return el('section', { class: 'about', 'aria-labelledby': 'about-h' },
      el('h2', { id: 'about-h' }, 'About'),
      el('p', { class: 'about-desc', id: 'about-desc' }, m.desc || (repo.draft ? 'No description yet. Add one when you save the board.' : 'No description.')),
      el('div', { class: 'about-author', id: 'about-author' }),
      m.src && m.src.pdf ? el('div', { class: 'about-link' }, N.svg(I.doc), el('span', null, m.src.pdf + (m.src.page ? ' · page ' + m.src.page : ''))) : null,
      m.homepage ? el('a', { class: 'about-link', href: m.homepage, target: '_blank', rel: 'noopener' }, N.svg(I.link), m.homepage.replace(/^https?:\/\//, '')) : null,
      m.src && m.src.github ? el('a', { class: 'about-link', href: '#' + m.src.github, title: 'Link that opens this project from GitHub' }, N.svg(I.copy), 'Shareable link') : null,
      m.remixOf ? el('a', { class: 'about-link', href: '#' + N.lib.repoId(m.remixOf.bid) }, N.svg(I.copy), 'Remixed from another board') : null,
      el('div', { class: 'tags', id: 'about-tags' }, (m.tags || []).map(t => el('span', { class: 'tag-chip mono' }, t))),
      el('div', { class: 'lic-chip mono' }, N.svg(I.law), (m.license || 'CC-BY-4.0') + (/rights/.test(m.license || '') ? '' : ' license')),
      el('ul', { class: 'about-stats', hidden: repo.draft || null },
        el('li', null, N.svg(I.star), el('span', { id: 'about-stars' })),
        el('li', null, N.svg(I.comment), el('span', { id: 'about-comments' })),
        el('li', null, N.svg(I.download), el('span', { id: 'about-downloads' }))),
      el('p', { class: 'muted small', id: 'about-dates' }));
  }
  function refreshUserHeader() {
    const repo = App.cur.repo, m = (App.cur.user && App.cur.user.meta) || repo.meta;
    const h = $('#bp-h1');
    if (h) h.textContent = m.title;
    const d = $('#about-desc');
    if (d) d.textContent = m.desc || 'No description.';
    const t = $('#about-tags');
    if (t) t.replaceChildren(...(m.tags || []).map(x => el('span', { class: 'tag-chip mono' }, x)));
    document.title = `${m.title} · KiLive`;
  }
  let authorToken = 0;
  async function updateUserBits() {
    if (!App.cur || !App.cur.repo.user) return;
    const repo = App.cur.repo, u = App.cur.user;
    const save = $('#save-btn');
    if (save && !repo.draft) save.hidden = !(u && u.dirty);
    if (save && u && u.pendingRev && !repo.draft) save.lastChild.textContent = 'Save as rev ' + (((u.meta && u.meta.rev) || 1) + 1);
    const db = $('#diff-btn');
    if (db) { db.hidden = !(u && u.lastDiff); if (u && u.lastDiff) db.title = N.diffSummary(u.lastDiff.d); }
    const lc = $('#link-chip'), K = N.kicadLink;
    if (lc) { const on = !!(K && K.link && K.link.target === repo.id); lc.hidden = !on; if (on) lc.querySelector('.lc-t').textContent = 'Live: ' + K.link.name + (K.link.last ? ' · ' + new Date(K.link.last).toTimeString().slice(0, 5) : ''); }
    const dates = $('#about-dates');
    const m = (u && u.meta) || repo.meta;
    if (dates) dates.textContent = repo.draft ? 'Draft in this browser' + (u && u.draft && u.draft.at ? ' · edited ' + N.fmt.ago(u.draft.at) : '') : `Created ${N.fmt.date(new Date(m.created || m.updated).toISOString().slice(0, 10))} · updated ${N.fmt.ago(m.updated)} · rev ${m.rev || 1}`;
    if (repo.draft) return;
    const tok = ++authorToken;
    const names = await N.social.names([repo.uid]);
    if (tok !== authorToken) return;
    const p = names[repo.uid] || {};
    const nm = p.name || (repo.uid === N.lib.uid ? 'You' : 'Someone');
    const a = $('#bp-author');
    if (a) a.textContent = 'by ' + nm;
    const box = $('#about-author');
    if (box) box.replaceChildren(p.avatarUrl ? el('img', { class: 'avatar', src: p.avatarUrl, alt: '' }) : el('span', { class: 'avatar' }), el('div', null, el('b', { text: nm }), el('div', { class: 'muted small' }, repo.uid === N.lib.uid ? 'You made this board' : 'Author')));
  }

  function setLoading(on, text) {
    const l = $('#loading');
    if (!l) return;
    l.hidden = !on;
    if (text) $('#loading-text').textContent = text;
  }

  function updateHeaderBits() {
    const { repo, board, version } = App.cur;
    $('#ver-label').textContent = repo.draft ? 'draft' : board.versions.length > 1 ? version.id : version.label.length > 14 ? version.id : version.label;
    const fails = Object.values(version.checks).filter(s => s === 'fail').length;
    const warns = Object.values(version.checks).filter(s => s === 'warn').length;
    const badge = $('#checks-badge');
    badge.textContent = fails || warns || '';
    badge.className = 'tab-badge ' + (fails ? 'fail' : warns ? 'warn' : '');
    badge.hidden = !(fails || warns);
    badge.setAttribute('aria-label', `${fails} failing, ${warns} to review`);
  }

  function selectTab(id) {
    const { repo, board, version } = App.cur;
    App.tab = id;
    setHash({ repo: repo.id, board: board.id, tab: id, version: version.id === board.default || board.versions.length === 1 ? '' : version.id });
    showTab(id);
  }

  function showTab(id, force) {
    document.querySelectorAll('.vc-tab').forEach(b => { const on = b.dataset.tab === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + id));
    const body = $('#vc-body');
    body.dataset.tab = id;
    const B = App.cur && App.cur.B;
    if (!B) return;
    if (id === 'design') ensureDesign();
    if (id === '3d') ensure3D();
    if (id === 'pcb') ensurePCB();
    if (id === 'sch') ensureSch();
    if ((id === 'bom' || id === 'checks' || id === 'files') && (App.dirtyPanels.has(id) || force)) { renderPanel(id); App.dirtyPanels.delete(id); }
    updateSelectionUI();
  }

  // ------------------------------------------------------------------ board chooser overlay (shared)
  function boardChooser() {
    const { repo, board } = App.cur;
    const i = repo.boards.indexOf(board);
    const b = el('button', { class: 'board-chooser', onclick: e => {
      N.menu(e.currentTarget, repo.boards.map((x, k) => {
        const v = x.versions.find(y => y.id === x.default) || x.versions[0];
        return { label: x.name, hint: `${k + 1}/${repo.boards.length} · ${v.stats.parts} parts`, active: x === board, onClick: () => openBoard(repo, x, x.versions.find(y => y.id === x.default) || x.versions[0], App.tab) };
      }), {});
    } }, el('span', { class: 'mono bc-name' }, board.name), el('span', { class: 'mono muted' }, `${i + 1}/${repo.boards.length}`), N.svg(I.chevron, 'tiny'));
    b.setAttribute('aria-label', `Board: ${board.name}, ${i + 1} of ${repo.boards.length}. Choose another board`);
    return b;
  }

  // ------------------------------------------------------------------ the probe tool: click copper, get a probe on the scope (and the board running live)
  App.probeTool = false;
  function setProbeTool(on) {
    on = !!on;
    App.probeTool = on;
    for (const k of ['pcb', 'sch']) if (App.views[k] && App.views[k].setProbeTool) App.views[k].setProbeTool(on);
    if (App.views.v3d) { App.views.v3d.canvas.style.cursor = on ? 'crosshair' : ''; }
    if (on && App.views.pcb && App.views.pcb.measure) { App.views.pcb.measure = null; if (App.pcbUI) { App.pcbUI.measureBtn.classList.remove('on'); App.pcbUI.measureBtn.setAttribute('aria-pressed', 'false'); } }
    for (const b of document.querySelectorAll('.probe-tool-btn')) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    if (on && !N.store.get('probeHint', false)) { N.store.set('probeHint', true); N.toast('Click a trace, pad or pin to put it on the scope. The board runs live as you probe. Esc stops the tool.', 'info'); }
  }
  App.setProbeTool = setProbeTool;
  App.toggleProbeTool = () => setProbeTool(!App.probeTool);
  function probeToolBtn(labelled) {
    return el('button', { class: 'tb probe-tool-btn' + (App.probeTool ? ' on' : ''), 'aria-pressed': App.probeTool ? 'true' : 'false', title: 'Probe tool (P): click a trace, pad or pin to put it on the scope', onclick: () => setProbeTool(!App.probeTool) },
      N.svg(I.probe), labelled ? el('span', { class: 'tb-l' }, 'Probe') : 'Probe');
  }
  // o: {view, hit, at, side, page, net}
  function placeProbe(o) {
    const B = App.cur && App.cur.B;
    if (!B || !o || !o.hit) return;
    const L = N.live;
    const was = L.on;
    if (!L.on) { L.keepView = true; N.startLive(); L.keepView = false; if (!L.on) return; }
    const h = o.hit;
    let p = null;
    const ref = o.ref || (h.type === 'fp' ? B.fps[h.fi].r : null);
    if (ref) { p = L.probePart(ref); if (p) select([ref], []); }
    else {
      p = L.probeHit({ view: o.view, hit: h, at: o.at, side: o.side, page: o.page, net: o.net });
      if (p) select([], [p.net || o.net || h.net].filter(Boolean), { hit: { view: o.view, hit: h, at: o.at, side: o.side, page: o.page, net: o.net } });
    }
    if (!p) { N.toast(ref ? 'Nothing to probe on ' + ref + ': its pins are not part of the simulation.' : 'The scope is full: remove a probe first, or pin the ones to keep.', 'warn'); return; }
    if (!was) N.toast('Running live · ' + (p.label || p.name || 'probe') + ' on CH' + (p.ch + 1));
  }

  // ------------------------------------------------------------------ 3D
  function ensure3D() {
    const pane = $('#pane-3d');
    let v = App.views.v3d;
    if (!v) {
      pane.innerHTML = '';
      const host = el('div', { class: 'gl-host' });
      pane.append(host);
      try {
        v = App.views.v3d = new N.Viewer3D(host);
      } catch (e) {
        pane.innerHTML = '';
        pane.append(el('div', { class: 'viewer-empty' }, el('p', null, '3D needs WebGL 2, which this browser does not provide.'), el('button', { class: 'btn', onclick: () => selectTab('pcb') }, 'Open the PCB view')));
        return;
      }
      v.light = N.store.get('light', 'studio');
      const realPref = N.store.get('real3d', null);
      if (realPref != null && v.real) v.setReal(realPref === 'on', true);
      v.on('quality', q => N.toast(q.real ? 'Soft shadows are off to keep the 3D view smooth on this device.' : 'Showing simple part shapes to keep the 3D view smooth. Light → Realistic parts brings them back.', 'info'));
      App.v3dUI = build3DOverlay(pane, v);
      v.on('hover', h => hover3D(h));
      v.on('pick', p => pick3D(p));
      v.on('camera', () => syncCube());
      if (N.PhotoScene) photoStills(pane, v);
    }
    if (v._board !== App.cur.B) {
      v._board = App.cur.B;
      App.v3dUI.chooserSlot.innerHTML = '';
      App.v3dUI.chooserSlot.append(boardChooser());
      requestAnimationFrame(() => {
        v.setBoard(App.cur.B);
        v.setHighlight([...App.sel.refs], [...App.sel.nets]);
        v.pendingHL = false;
      });
    } else if (v.pendingHL) {
      v.setHighlight([...App.sel.refs], [...App.sel.nets]);
      v.pendingHL = false;
    }
  }

  // Photo-real light: when the camera rests, a physically based still of the same view (N.PhotoScene, built once per board side)
  // fades in over the interactive model; any movement shows the live model again.
  function photoStills(pane, v) {
    const host = v.canvas.parentElement;
    const still = el('canvas', { class: 'gl-still', 'aria-hidden': 'true' });
    const status = el('div', { class: 'ov-photo-status', hidden: true }, el('div', { class: 'spinner small' }), el('span', null, 'Preparing the photo-real view…'));
    host.append(still); pane.append(status);
    let timer = 0, gen = 0;
    v._photo = { B: null, top: null, bottom: null };
    const want = () => pane.dataset.light === 'photo' && !N.live.on && App.tab === '3d' && v.assembled && !v.showRuler && !v.hl.refs.size && !v.hl.nets.size && document.visibilityState === 'visible';
    const hide = () => { gen++; clearTimeout(timer); still.classList.remove('on'); };
    async function shoot(g) {
      const B = App.cur && App.cur.B;
      if (!B || !want() || g !== gen) return;
      const P = v._photo;
      if (P.B !== B) { for (const k of ['top', 'bottom']) if (P[k]) P[k].dispose(); Object.assign(P, { B, top: null, bottom: null }); }
      const under = v.cam.pitch < 0, key = under ? 'bottom' : 'top';
      try {
        if (!P[key]) {
          status.hidden = false;
          await new Promise(r => setTimeout(r, 30));
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
          P[key] = new N.PhotoScene(B, { under, outMax: 2048 });
          status.hidden = true;
          if (g !== gen) return;
        }
        let yaw = v.cam.yaw, pitch = v.cam.pitch;
        if (under) { yaw = Math.PI - yaw; pitch = -pitch; }
        // at most ~2.4 MP: the still is a soft photo, and a smaller one keeps the stop after each move short
        const W0 = v.fullW || v.canvas.width, H0 = v.fullH || v.canvas.height, k = Math.min(1, Math.sqrt(2.4e6 / (W0 * H0)));
        const W = Math.round(W0 * k), H = Math.round(H0 * k);
        const cv = P[key].render({ width: W, height: H, ss: 1, camera: v.cam, exact: true, yaw, pitch, fov: v.cam.fov, dof: 0.35, floor: !under, rotate180: under, msaa: W * H < 1.8e6 });
        if (g !== gen || !want()) return;
        still.width = cv.width; still.height = cv.height;
        still.getContext('2d').drawImage(cv, 0, 0);
        still.classList.add('on');
      } catch (e) { status.hidden = true; console.warn('photo-real view:', e); }
    }
    v.on('camera', () => { hide(); if (want()) { const g = gen; timer = setTimeout(() => shoot(g), 650); } });
    v.photoRefresh = () => { hide(); if (want()) { const g = gen; timer = setTimeout(() => shoot(g), 60); } };
  }

  function build3DOverlay(pane, v) {
    const chooserSlot = el('div', { class: 'ov-tl' });
    const cube = el('div', { class: 'ocube-wrap', title: 'Click a face to look from that side' },
      el('div', { class: 'ocube', id: 'ocube' },
        ['top', 'bottom', 'front', 'back', 'left', 'right'].map(f => el('button', { class: 'oface ' + f, 'aria-label': 'View from ' + f, onclick: () => v.view(f) }, f.toUpperCase()))));
    chooserSlot.append();
    const tl = el('div', { class: 'ov-tl-stack' }, chooserSlot, cube);
    const seg = el('div', { class: 'seg overlay', role: 'group', 'aria-label': 'Assembly' },
      el('button', { class: 'active', onclick: e => { v.setAssembled(true); segOn(seg, e.currentTarget); } }, 'Assembled'),
      el('button', { onclick: e => { v.setAssembled(false); segOn(seg, e.currentTarget); } }, 'Bare board'));
    const lightNames = { studio: 'Studio', bench: 'Bench lamp', inspect: 'Flat inspection', night: 'Night' };
    if (N.PhotoScene) lightNames.photo = 'Photo-real (renders when you stop)';
    let rulerOn = false;
    const scaleBtn = el('button', { class: 'tb', 'aria-label': 'Scale', title: 'Show a ruler', 'aria-pressed': 'false', onclick: e => { rulerOn = !rulerOn; v.setRuler(rulerOn); e.currentTarget.setAttribute('aria-pressed', rulerOn); e.currentTarget.classList.toggle('on', rulerOn); v.fit(false); } }, N.svg(I.scale), el('span', { class: 'tb-l' }, 'Scale'));
    const bar = el('div', { class: 'ov-bottom toolbar' },
      el('button', { class: 'tb', title: 'Fit the board in view', 'aria-label': 'Fit', onclick: () => v.fit(true) }, N.svg(I.fit), el('span', { class: 'tb-l' }, 'Fit')),
      el('span', { class: 'tb-sep' }),
      el('button', { class: 'tb', 'aria-label': 'View', title: 'Camera views', onclick: e => N.menu(e.currentTarget, [
        { label: 'Isometric', onClick: () => v.view('iso') }, { label: 'Top', hint: 'T', onClick: () => v.view('top') }, { label: 'Bottom', hint: 'B', onClick: () => v.view('bottom') },
        { label: 'Front', onClick: () => v.view('front') }, { label: 'Back', onClick: () => v.view('back') }, { label: 'Left', onClick: () => v.view('left') }, { label: 'Right', onClick: () => v.view('right') }], { up: true }) }, N.svg(I.view), el('span', { class: 'tb-l' }, 'View')),
      el('button', { class: 'tb', 'aria-label': 'Light', title: 'Lighting and parts', onclick: e => N.menu(e.currentTarget, Object.keys(lightNames).map(k => ({ label: lightNames[k], active: v.light === k, onClick: () => { v.setLight(k); pane.dataset.light = k; N.store.set('light', k); if (v.photoRefresh) v.photoRefresh(); } }))
        .concat(v.real ? ['-', { header: 'Parts' },
          { label: 'Realistic parts', hint: 'shadows, materials', active: v.realOn, onClick: () => { v.setReal(true, true); N.store.set('real3d', 'on'); } },
          { label: 'Simple shapes', hint: 'fastest', active: !v.realOn, onClick: () => { v.setReal(false, true); N.store.set('real3d', 'off'); } }] : []), { up: true }) }, N.svg(I.light), el('span', { class: 'tb-l' }, 'Light')),
      scaleBtn,
      probeToolBtn(true),
      N.photoDialog ? el('button', { class: 'tb', title: 'Render a realistic 2K photo of this view', onclick: () => { const B = App.cur && App.cur.B; if (B) N.photoDialog(B, { viewer: v, name: (App.cur.repo && App.cur.repo.id || 'board') + (App.cur.board ? '-' + App.cur.board.id : '') }); } }, N.svg(I.camera), el('span', { class: 'tb-l' }, 'Photo')) : null);
    pane.dataset.light = v.light;
    const tip = el('div', { class: 'viewer-tip', hidden: true });
    const help = el('div', { class: 'ov-help muted' }, 'Drag to orbit · right-drag to pan · scroll to zoom');
    pane.append(tl, el('div', { class: 'ov-tr' }, seg), bar, tip, help);
    pane.addEventListener('keydown', e => {
      if (e.target.closest('input,textarea')) return;
      if (e.key === 't' || e.key === 'T') v.view('top');
      if (e.key === 'b' || e.key === 'B') v.view('bottom');
      if (e.key === 'f' || e.key === 'F') v.fit(true);
      if ((e.key === 'p' || e.key === 'P') && !(N.live && N.live.on)) { e.preventDefault(); setProbeTool(!App.probeTool); }
      if (e.key === 'Escape') { if (App.probeTool) setProbeTool(false); else select([], []); }
    });
    return { chooserSlot, tip, cube };
  }
  function segOn(seg, btn) { seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn)); }
  function syncCube() {
    const v = App.views.v3d;
    const c = $('#ocube');
    if (!v || !c) return;
    c.style.transform = `rotateX(${(-v.cam.pitch * 180 / Math.PI).toFixed(2)}deg) rotateY(${(-v.cam.yaw * 180 / Math.PI).toFixed(2)}deg)`;
  }
  function hover3D(h) {
    App.last3DHover = h;
    const tip = App.v3dUI && App.v3dUI.tip;
    if (!tip) return;
    const B = App.cur && App.cur.B;
    if (!h || !B) { tip.hidden = true; return; }
    if (h.fi != null) {
      const f = B.fps[h.fi];
      const sp = B.schParts.get(f.r);
      tip.innerHTML = `<b>${N.esc(f.r)}</b> ${N.esc(f.v)} <span class="tip-sub">${N.esc(f.fp)}</span>${N.liveTipPart(B, f.r)}`;
    } else if (h.board) {
      const hit = N.hitTest(B, h.board.bx, h.board.by, { layers: h.board.side ? [B.cu[B.cu.length - 1]] : [B.cu[0]], tol: 0.1, side: h.board.side, zones: true });
      if (!hit || hit.type === 'fp') { tip.hidden = true; return; }
      tip.innerHTML = App.views.pcb ? App.views.pcb.describe(hit) : describeHit(B, hit);
    }
    tip.hidden = false;
    tip.style.left = Math.min(h.x + 14, $('#pane-3d').clientWidth - 230) + 'px';
    tip.style.top = h.y + 16 + 'px';
  }
  function describeHit(B, h) {
    const net = h.net ? N.fmt.shortNet(B.nets[h.net]) : '';
    if (h.type === 'pad') { const p = B.pads[h.i]; return `<b>${N.esc(B.fps[p[0]].r)}.${N.esc(p[1])}</b> <span class="tip-sub">${N.esc(net)}</span>${N.liveTipPin(B, B.fps[p[0]].r, p[1], h.net)}`; }
    return `<b>${N.esc(net)}</b> <span class="tip-sub">${h.type === 'track' ? 'track' : h.type === 'via' ? 'via' : 'pour'}</span>${N.liveTipNet(B, h.net)}`;
  }
  function pick3D(p) {
    const B = App.cur && App.cur.B;
    if (!B) return;
    if (App.probeTool) {
      if (!p) return;
      if (p.fi != null) { placeProbe({ view: '3d', hit: { type: 'fp', fi: p.fi }, at: null }); return; }
      const hit = N.hitTest(B, p.board.bx, p.board.by, { layers: p.board.side ? [B.cu[B.cu.length - 1]] : [B.cu[0]], tol: 0.1, side: p.board.side });
      if (hit && (hit.net || hit.type === 'fp' || hit.type === 'pad')) placeProbe({ view: '3d', hit, at: [p.board.bx, p.board.by], side: p.board.side });
      return;
    }
    if (!p) { select([], []); return; }
    if (p.fi != null) { select([B.fps[p.fi].r], []); return; }
    const hit = N.hitTest(B, p.board.bx, p.board.by, { layers: p.board.side ? [B.cu[B.cu.length - 1]] : [B.cu[0]], tol: 0.1, side: p.board.side });
    // a click selects; probing is a button on the selection card (it keeps where the click landed)
    if (hit && hit.net) select([], [hit.net], { hit: { view: '3d', hit, at: [p.board.bx, p.board.by], side: p.board.side } });
    else if (hit && hit.type === 'fp') select([B.fps[hit.fi].r], []);
    else select([], []);
  }

  // ------------------------------------------------------------------ PCB
  function ensurePCB() {
    const pane = $('#pane-pcb');
    let v = App.views.pcb;
    if (!v) {
      pane.innerHTML = '';
      v = App.views.pcb = new N.PCBView(pane);
      App.pcbUI = buildPCBOverlay(pane, v);
      v.on('select', s => select(s.refs, s.nets, { hit: s.hit && s.hit.type !== 'fp' ? { view: 'pcb', hit: s.hit, at: s.at } : null }));
      v.on('flip', f => setFlip(f));
      v.on('measure', () => toggleMeasure());
      v.on('probe', o => placeProbe(Object.assign({ view: 'pcb' }, o)));
      v.on('probe-tool', on => setProbeTool(on));
      if (App.probeTool) v.setProbeTool(true);
    }
    if (v._board !== App.cur.B) {
      v._board = App.cur.B;
      App.pcbUI.chooserSlot.innerHTML = '';
      App.pcbUI.chooserSlot.append(boardChooser());
      v.setBoard(App.cur.B);
      requestAnimationFrame(() => { v.fit(); v.setSelection([...App.sel.refs], [...App.sel.nets]); focusSelectionIn('pcb'); });
      buildLayerList();
    } else v.setSelection([...App.sel.refs], [...App.sel.nets]);
  }
  function setFlip(f) {
    const v = App.views.pcb;
    v.setFlip(f);
    App.pcbUI.flipSeg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', i === (f ? 1 : 0)));
    v.updateStatus();
  }
  function toggleMeasure() {
    const v = App.views.pcb;
    v.measure = v.measure ? null : {};
    if (v.measure && App.probeTool) setProbeTool(false);
    App.pcbUI.measureBtn.classList.toggle('on', !!v.measure);
    App.pcbUI.measureBtn.setAttribute('aria-pressed', !!v.measure);
    v.draw(); v.updateStatus();
  }
  function buildPCBOverlay(pane, v) {
    const chooserSlot = el('div', { class: 'ov-inline' });
    const search = finder(res => {
      if (res.ref) select([res.ref], [], { focus: 'pcb' });
      else if (res.net) select([], [res.net], { focus: 'pcb' });
    });
    const flipSeg = el('div', { class: 'seg overlay', role: 'group', 'aria-label': 'Board side' },
      el('button', { class: 'active', onclick: () => setFlip(false) }, 'Top'),
      el('button', { onclick: () => setFlip(true) }, 'Bottom'));
    const measureBtn = el('button', { class: 'tb', 'aria-pressed': 'false', title: 'Measure (M)', onclick: toggleMeasure }, N.svg(I.ruler), 'Measure');
    const layersBtn = el('button', { class: 'tb', onclick: e => layerMenu(e.currentTarget) }, N.svg(I.layers), 'Layers');
    const bar = el('div', { class: 'ov-top toolbar' }, chooserSlot, search, el('span', { class: 'grow' }), flipSeg, layersBtn, measureBtn, probeToolBtn(), el('button', { class: 'tb', title: 'Fit (F)', onclick: () => v.fit() }, N.svg(I.fit), 'Fit'));
    const legend = el('div', { class: 'layer-legend', id: 'layer-legend' });
    pane.append(bar, legend);
    return { chooserSlot, flipSeg, measureBtn, legend };
  }
  function buildLayerList() {
    const v = App.views.pcb, B = App.cur.B;
    const lg = App.pcbUI.legend;
    lg.innerHTML = '';
    for (const L of B.cu) {
      lg.append(el('button', { class: 'lg' + (v.layerVis[L] ? '' : ' off'), title: 'Show or hide ' + L, onclick: e => { v.layerVis[L] = !v.layerVis[L]; e.currentTarget.classList.toggle('off', !v.layerVis[L]); v.draw(); } },
        el('span', { class: 'sw', style: { background: N.layerColor(L, B.cu) } }), L));
    }
  }
  function layerMenu(btn) {
    const v = App.views.pcb;
    const opts = [['zones', 'Copper pours'], ['tracks', 'Tracks'], ['pads', 'Pads'], ['vias', 'Vias'], ['silk', 'Silkscreen'], ['text', 'Silkscreen text'], ['fab', 'Fabrication outlines'], ['crtyd', 'Courtyards'], ['edge', 'Board edge']];
    const node = el('div', { class: 'menu-checks' }, opts.map(([k, label]) => el('label', { class: 'menu-check' },
      el('input', { type: 'checkbox', checked: v.vis[k] || null, onchange: e => { v.vis[k] = e.target.checked; v.draw(); } }), label)));
    N.menu(btn, [{ header: 'Show' }, { node }], { alignRight: true });
  }

  // part / net finder with suggestions
  function finder(onPick) {
    const wrap = el('div', { class: 'finder' });
    const input = el('input', { class: 'input small', type: 'search', placeholder: 'Find part or net', 'aria-label': 'Find a part or net', autocomplete: 'off' });
    const list = el('div', { class: 'finder-list', role: 'listbox', hidden: true });
    wrap.append(N.svg(I.search), input, list);
    let items = [], active = 0;
    const render = () => {
      list.innerHTML = '';
      items.forEach((it, i) => list.append(el('button', { class: 'finder-item' + (i === active ? ' active' : ''), role: 'option', onmousedown: e => { e.preventDefault(); pick(it); } },
        el('span', { class: 'fi-kind ' + (it.ref ? 'ref' : 'net') }, it.ref ? 'part' : 'net'), el('span', { class: 'mono' }, it.label), el('span', { class: 'muted small' }, it.sub))));
      list.hidden = !items.length;
    };
    const pick = it => { list.hidden = true; input.value = it.label; onPick(it); };
    input.addEventListener('input', () => {
      const B = App.cur && App.cur.B;
      const q = input.value.trim().toLowerCase();
      if (!B || !q) { items = []; render(); return; }
      const res = [];
      for (const f of B.fps) {
        if (res.length > 8) break;
        if (f.r.toLowerCase().startsWith(q) || (q.length > 2 && f.v.toLowerCase().includes(q))) res.push({ ref: f.r, label: f.r, sub: f.v });
      }
      const nres = [];
      B.nets.forEach((n, i) => { if (i && nres.length < 8 && N.fmt.shortNet(n).toLowerCase().includes(q)) nres.push({ net: i, label: N.fmt.shortNet(n), sub: (B.padsByNet.get(i) || []).length + ' pads' }); });
      items = res.slice(0, 7).concat(nres.slice(0, 7));
      active = 0;
      render();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      if (e.key === 'Enter' && items[active]) pick(items[active]);
      if (e.key === 'Escape') { list.hidden = true; }
    });
    input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 120));
    return wrap;
  }

  // ------------------------------------------------------------------ Schematic
  function ensureSch() {
    const pane = $('#pane-sch');
    let v = App.views.sch;
    if (!v) {
      pane.innerHTML = '';
      const bar = el('div', { class: 'ov-top toolbar sch-bar' });
      const host = el('div', { class: 'sch-host' });
      pane.append(bar, host);
      v = App.views.sch = new N.SchView(host);
      App.schUI = { bar };
      v.on('select', s => select(s.refs, s.nets, { hit: s.hit ? { view: 'sch', hit: s.hit, at: s.at, page: s.page, net: s.net } : null }));
      v.on('probe', o => placeProbe(Object.assign({ view: 'sch' }, o)));
      v.on('probe-tool', on => setProbeTool(on));
      if (App.probeTool) v.setProbeTool(true);
    }
    if (v._board !== App.cur.B) {
      v._board = App.cur.B;
      const bar = App.schUI.bar;
      bar.innerHTML = '';
      bar.append(boardChooser(), finder(res => res.ref ? select([res.ref], [], { focus: 'sch' }) : select([], [res.net], { focus: 'sch' })), el('span', { class: 'grow' }),
        ...(App.cur.B.data.sch && App.cur.B.data.sch.pages.length > 1 ? [
          el('button', { class: 'tb', onclick: () => v.showPage(v.page - 1, true) }, 'Prev sheet'),
          el('button', { class: 'tb', onclick: () => v.showPage(v.page + 1, true) }, 'Next sheet')] : []),
        probeToolBtn(),
        el('button', { class: 'tb', onclick: () => v.fit() }, N.svg(I.fit), 'Fit'));
      v.setBoard(App.cur.B);
      v.setSelection([...App.sel.refs], [...App.sel.nets]);
      requestAnimationFrame(() => { v.fit(); focusSelectionIn('sch'); });
    } else v.setSelection([...App.sel.refs], [...App.sel.nets]);
  }

  // ------------------------------------------------------------------ panels
  function renderPanel(id) {
    const host = $('#pane-' + id);
    const ctx = panelCtx();
    if (id === 'bom') App.bomPanel = N.renderBOM(host, ctx);
    if (id === 'checks') N.renderChecks(host, ctx);
    if (id === 'files') (App.cur.repo.user ? renderUserFiles : N.renderFiles)(host, ctx);
  }
  function panelCtx() {
    const { repo, board, version, B } = App.cur;
    return {
      B, repo, board, version, versions: board.versions,
      fileBase: (repo.user ? (N.lib.slug(repo.title) || 'board') : `${repo.name}-${board.name}-${version.id}`).replace(/[^\w.-]+/g, '_'),
      getSelection: () => App.sel,
      onSelect: refs => select(refs, []),
      onLocate: refs => { select(refs, [], { focus: 'pcb' }); selectTab('pcb'); },
      onDownload: () => N.social.countDownload(repo.id),
      onFinding: (it) => {
        if (it.sheet && it.sxy) {
          selectTab('sch');
          const v = App.views.sch;
          const pi = B.data.sch.pages.findIndex(p => p.name === it.sheet);
          if (pi >= 0) { v.showPage(pi, false); v.focusPoint(it.sxy[0], it.sxy[1]); }
          const n = (it.nets || []).map(x => B.findNet(x)).filter(x => x > 0);
          select([], n);
          return;
        }
        const refs = (it.refs || []).filter(r => B.fp(r));
        const nets = (it.nets || []).map(x => B.findNet(x)).filter(x => x > 0);
        select(refs, nets);
        selectTab('pcb');
        requestAnimationFrame(() => {
          if (it.xy) App.views.pcb.zoomTo(it.xy[0], it.xy[1], 14);
          else focusSelectionIn('pcb');
        });
      },
    };
  }

  // ------------------------------------------------------------------ selection / cross-probing
  function select(refs, nets, opts = {}) {
    App.sel = { refs: new Set(refs || []), nets: new Set((nets || []).filter(Boolean)) };
    // where the click landed (a pad, a pin, a piece of track): the selection card probes exactly there
    App.selHit = opts.hit || null;
    App.sel.hit = App.selHit;
    const { v3d, pcb, sch } = App.views;
    if (pcb && pcb._board === App.cur.B) pcb.setSelection([...App.sel.refs], [...App.sel.nets]);
    if (sch && sch._board === App.cur.B) sch.setSelection([...App.sel.refs], [...App.sel.nets]);
    if (v3d && v3d._board === App.cur.B) {
      if (App.tab === '3d') v3d.setHighlight([...App.sel.refs], [...App.sel.nets]);
      else v3d.pendingHL = true;
    }
    if (App.bomPanel && App.tab === 'bom') App.bomPanel.redraw();
    else App.dirtyPanels && App.dirtyPanels.add('bom');
    if (App.designUI) App.designUI.highlight([...App.sel.refs], [...App.sel.nets].map(n => N.fmt.shortNet(App.cur.B.nets[n])));
    if (opts.focus) focusSelectionIn(opts.focus);
    updateSelectionUI();
    N.bus.emit('selection', App.sel);
  }
  N.select = select;

  function focusSelectionIn(where) {
    const B = App.cur && App.cur.B;
    if (!B) return;
    if (where === 'pcb' && App.views.pcb) {
      const pts = [];
      for (const r of App.sel.refs) {
        const f = B.fp(r);
        if (!f) continue;
        const poly = f.c && f.c.length >= 6 ? f.c : B.bodyPoly(f);
        if (poly) for (let i = 0; i < poly.length; i += 2) pts.push([poly[i], poly[i + 1]]);
        pts.push([f.x, f.y]);
      }
      for (const n of App.sel.nets) for (const pi of (B.padsByNet.get(n) || []).slice(0, 400)) pts.push([B.pads[pi][4], B.pads[pi][5]]);
      if (!pts.length) return;
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      const pad = Math.max(4, (22 - span) / 2);
      const side = [...App.sel.refs].map(r => B.fp(r)).filter(Boolean);
      if (side.length && side.every(f => f.s === 1) && !App.views.pcb.flip) setFlip(true);
      else if (side.length && side.every(f => f.s === 0) && App.views.pcb.flip) setFlip(false);
      App.views.pcb.fit([Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]);
    }
    if (where === 'sch' && App.views.sch) {
      const r = [...App.sel.refs][0];
      if (r) { App.views.sch.focusRef(r); return; }
      const n = [...App.sel.nets][0];
      if (n) {
        const pages = App.views.sch.pagesForNet(n);
        if (pages.length && !pages.includes(App.views.sch.page)) App.views.sch.showPage(pages[0], true);
      }
    }
  }

  function putKids(node, ...kids) { node.append(...kids.flat(Infinity).filter(k => k != null && k !== false && k !== '')); }

  function updateSelectionUI() {
    const card = $('#selcard');
    if (!card) return;
    const B = App.cur && App.cur.B;
    const n = App.sel.refs.size + App.sel.nets.size;
    const onViewer = ['3d', 'pcb', 'sch'].includes(App.tab);
    if (!B || !n || !onViewer) { card.hidden = true; return; }
    card.hidden = false;
    card.innerHTML = '';
    // under the view's toolbar, however many lines it wraps to
    const pane = $('#pane-' + App.tab), tbar = pane && pane.querySelector('.ov-top');
    card.style.top = tbar && window.innerWidth > 720 ? Math.round(tbar.offsetTop + tbar.offsetHeight + 10) + 'px' : '';
    const close = el('button', { class: 'icon-btn sc-close', 'aria-label': 'Clear selection', onclick: () => select([], []) }, N.svg(I.close));
    const acts = el('div', { class: 'sc-acts' },
      App.tab !== '3d' ? el('button', { class: 'btn tiny ghost', onclick: () => selectTab('3d') }, N.svg(I.cube), '3D') : null,
      App.tab !== 'pcb' ? el('button', { class: 'btn tiny ghost', onclick: () => { selectTab('pcb'); requestAnimationFrame(() => focusSelectionIn('pcb')); } }, N.svg(I.pcb), 'PCB') : null,
      App.tab !== 'sch' && B.data.sch ? el('button', { class: 'btn tiny ghost', onclick: () => { selectTab('sch'); requestAnimationFrame(() => focusSelectionIn('sch')); } }, N.svg(I.sch), 'Schematic') : null);
    // while the simulation runs the live values come first and the static facts fold away under Details
    const live = !!(N.live && N.live.on && N.live.B === B);
    const details = (...kids) => {
      const list = kids.flat(Infinity).filter(k => k != null && k !== false && k !== '');
      if (!live) return list;
      const d = el('details', { class: 'sc-details' }, el('summary', null, 'Details'), ...list);
      if (App.scDetails) d.open = true;
      d.addEventListener('toggle', () => { App.scDetails = d.open; });
      return d;
    };
    if (App.sel.refs.size === 1 && !App.sel.nets.size) {
      const p = B.partInfo([...App.sel.refs][0]);
      if (!p) { card.hidden = true; return; }
      const mpn = Object.entries(p.fields).find(([k]) => /mpn|part|mfr|lcsc/i.test(k));
      const nets = [...new Set(p.pins.map(x => x.net).filter(Boolean))];
      putKids(card, close,
        el('div', { class: 'sc-top' }, el('span', { class: 'sc-ref mono' }, p.ref), el('span', { class: 'sc-val' }, p.value), p.dnp ? el('span', { class: 'tag muted' }, 'DNP') : null),
        el('div', { class: 'sc-sub mono' }, `${p.footprint} · ${p.side}`),
        liveBox(),
        details(
          p.desc ? el('p', { class: 'sc-desc' }, p.desc) : null,
          mpn ? el('div', { class: 'sc-kv' }, el('span', null, mpn[0]), el('b', { class: 'mono' }, mpn[1])) : null,
          el('div', { class: 'sc-kv' }, el('span', null, 'Pins'), el('b', null, `${p.pins.length} on ${nets.length} nets`)),
          nets.length ? el('div', { class: 'sc-chips' }, nets.slice(0, 10).map(nm => el('button', { class: 'probe-chip net', onclick: () => select([p.ref], [B.findNet(nm)]) }, N.fmt.shortNet(nm))), nets.length > 10 ? el('span', { class: 'muted small' }, '+' + (nets.length - 10)) : null) : null,
          p.datasheet && /^https?:/.test(p.datasheet) ? el('a', { class: 'sc-link small', href: p.datasheet, target: '_blank', rel: 'noopener' }, 'Datasheet', N.svg(I.ext, 'tiny')) : null),
        !live && N.fw && N.fw.looksLikeProcessor(p.value + ' ' + p.desc) ? el('button', { class: 'btn tiny primary sc-code', onclick: () => { const ref = p.ref; if (!N.live.on) toggleLive(); requestAnimationFrame(() => N.live.openCode && N.live.openCode(ref)); } }, N.svg(I.code), 'Put code on ' + p.ref) : null,
        acts);
    } else if (App.sel.nets.size === 1 && App.sel.refs.size <= 1) {
      const ni = B.netInfo([...App.sel.nets][0]);
      const refs = [...new Set(ni.pads.map(x => x.ref))].sort(N.refCmp);
      putKids(card, close,
        el('div', { class: 'sc-top' }, el('span', { class: 'sc-kind' }, 'Net'), el('span', { class: 'sc-ref mono' }, N.fmt.shortNet(ni.name)), ni.power ? el('span', { class: 'tag pwr' }, 'supply') : ni.ground ? el('span', { class: 'tag' }, 'ground') : null),
        ni.name.includes('/') ? el('div', { class: 'sc-sub mono' }, ni.name) : null,
        liveBox(),
        details(
          el('div', { class: 'sc-grid' },
            kv('Pads', ni.padCount), kv('Vias', ni.vias), kv('Track', ni.trackLen ? ni.trackLen + ' mm' : 'pour only'),
            kv('Width', ni.widthMin ? (ni.widthMin === ni.widthMax ? ni.widthMin : ni.widthMin + '–' + ni.widthMax) + ' mm' : '—'),
            kv('Layers', ni.layers.map(l => l.replace('.Cu', '')).join(' ') || '—'), kv('Test points', ni.testpoints.join(' ') || 'none')),
          el('div', { class: 'sc-chips' }, refs.slice(0, 16).map(r => el('button', { class: 'probe-chip ref', onclick: () => select([r], []) }, r)), refs.length > 16 ? el('span', { class: 'muted small' }, '+' + (refs.length - 16)) : null)),
        acts);
    } else {
      putKids(card, close, el('div', { class: 'sc-top' }, el('span', { class: 'sc-val' }, `${App.sel.refs.size} parts, ${App.sel.nets.size} nets selected`)),
        el('div', { class: 'sc-chips' }, [...App.sel.refs].slice(0, 16).map(r => el('span', { class: 'probe-chip ref static' }, r)), [...App.sel.nets].slice(0, 8).map(x => el('span', { class: 'probe-chip net static' }, N.fmt.shortNet(B.nets[x])))), acts);
    }
    function kv(k, v) { return el('div', { class: 'sc-kv' }, el('span', null, k), el('b', { class: 'num' }, String(v))); }
    function liveBox() {
      if (!N.live.on || N.live.B !== B) return null;
      const box = el('div', { class: 'sc-live', id: 'sc-live' });
      N.liveCardFill(box, B, App.sel);
      return box;
    }
  }
  N.bus.on('live', () => updateSelectionUI());

  // ------------------------------------------------------------------ menus & popovers
  function renderUserFiles(host, ctx) {
    const { repo, B } = ctx;
    const u = App.cur.user || {};
    host.innerHTML = '';
    const exp = (title, sub, fn) => el('button', { class: 'export', onclick: fn }, el('b', null, title), el('span', { class: 'muted small' }, sub));
    const cards = [];
    if (u.design && u.built) {
      const files = u.built.files;
      const kind = n => /\.kicad_pcb$/.test(n) ? 'layout' : /\.kicad_sch$/.test(n) ? 'schematic' : /\.kicad_pro$/.test(n) ? 'project' : /\.kicad_sym$/.test(n) ? 'symbols' : /ngspice/.test(n) ? 'spice' : /\.csv$/.test(n) ? 'BOM' : '';
      cards.push(el('div', { class: 'files card-inset' },
        el('div', { class: 'files-head' }, N.svg(I.folder), el('span', { class: 'mono' }, u.built.name + '/'), el('span', { class: 'muted small' }, 'KiCad 8 project · generated from the drawing')),
        el('ul', { class: 'file-list' }, Object.keys(files).map(n => el('li', null,
          el('button', { class: 'file-link linkish', onclick: () => N.saveFile(n.replace(/\.(kicad_\w+|cir)$/, m => m + '.txt').replace(/sym-lib-table$/, 'sym-lib-table.txt'), files[n], ctx.onDownload), title: 'Save ' + n },
            N.svg(/\.kicad_pcb$/.test(n) ? I.pcb : /\.kicad_sch$/.test(n) ? I.sch : I.files), el('span', { class: 'mono' }, n)),
          kind(n) ? el('span', { class: 'tag' }, kind(n)) : null,
          el('span', { class: 'muted small num' }, N.fmt.bytes(new Blob([files[n]]).size)))))));
    } else if ((repo.meta.files || []).length) {
      const folder = (repo.meta.src && repo.meta.src.pcb || '').split('/').slice(0, -1).join('/');
      cards.push(el('div', { class: 'files card-inset' },
        el('div', { class: 'files-head' }, N.svg(I.folder), el('span', { class: 'mono' }, folder || '/'), el('span', { class: 'muted small' }, `${repo.meta.files.length} files uploaded`)),
        el('ul', { class: 'file-list' }, repo.meta.files.map(([p, size]) => el('li', null, el('span', { class: 'file-link' }, N.svg(/\.kicad_pcb$/.test(p) ? I.pcb : /\.kicad_sch$/.test(p) ? I.sch : I.files), el('span', { class: 'mono' }, folder && p.startsWith(folder + '/') ? p.slice(folder.length + 1) : p)), el('span', { class: 'muted small num' }, N.fmt.bytes(size)))))));
    }
    const canZip = !!(u.design || u.source || repo.meta.hasSource);
    cards.push(el('div', { class: 'exports card-inset' },
      el('div', { class: 'files-head' }, N.svg(I.download), 'Downloads'),
      el('div', { class: 'export-grid' },
        canZip ? exp('KiCad project (.zip)', u.design ? 'Schematic, placed PCB, symbol library, BOM' : 'The uploaded KiCad files', downloadProject) : null,
        exp('Bill of materials', 'CSV grouped by value and footprint', () => N.saveFile(`${ctx.fileBase}-bom.csv`, N.exporters.bom(B), ctx.onDownload)),
        exp('Pick and place', 'Centroids in mm from the lower-left corner', () => N.saveFile(`${ctx.fileBase}-pnp.csv`, N.exporters.pnp(B), ctx.onDownload)),
        exp('Netlist', 'Every pad with its net, pin function and type', () => N.saveFile(`${ctx.fileBase}-netlist.csv`, N.exporters.netlist(B), ctx.onDownload)),
        u.design ? exp('Circuit JSON', 'The netlist with options and simulation setup', () => N.saveFile(`${ctx.fileBase}-circuit.json`, u.built.files['circuit.json'], ctx.onDownload)) : null)));
    const notes = [];
    if (u.design) {
      const d = u.design;
      if (d.source && d.source.pdf) notes.push('Read from ' + d.source.pdf + (d.source.page ? ', page ' + d.source.page : '') + '.');
      for (const n of (d.notes || []).slice(0, 8)) notes.push(n);
      for (const n of (d.layout || []).slice(0, 8)) notes.push('Layout: ' + n);
      for (const n of (d.warnings || []).slice(0, 6)) notes.push('Check: ' + n);
    }
    const readme = el('article', { class: 'readme card-inset' },
      el('div', { class: 'files-head' }, N.svg(I.files), 'Notes'),
      el('div', { class: 'md' }, el('p', null, repo.meta.desc || 'No description yet.'), notes.length ? el('ul', null, notes.map(n => el('li', null, n))) : null,
        u.design ? el('p', { class: 'muted small' }, 'The PCB is placed but not routed: open the project in KiCad 8 or newer, route the ratsnest, and run DRC before ordering boards.') : null));
    host.append(el('div', { class: 'files-grid' }, el('div', { class: 'files-col' }, cards), readme));
  }

  function versionMenu(btn) {
    const { repo, board, version } = App.cur;
    if (repo.user) {
      const m = (App.cur.user && App.cur.user.meta) || repo.meta;
      const u = App.cur.user;
      const items = [{ header: repo.draft ? 'Draft' : 'Revisions' }];
      if (repo.draft) items.push({ label: 'Not saved to the library yet', active: true, onClick: () => {} }, { label: 'Save to library…', icon: I.upload, onClick: saveBoard });
      else for (const v of board.versions) items.push({ label: v.latest ? 'rev ' + (m.rev || 1) + ' · latest' : v.label, hint: v.latest ? N.fmt.ago(m.updated) : v.at ? N.fmt.ago(v.at) : '', active: v === version, onClick: () => openBoard(repo, board, v, App.tab) });
      if (u && u.lastDiff) items.push('-', { label: 'What changed in the last update', icon: I.compare, onClick: showLastDiff });
      if (board.versions.length > 1) {
        items.push('-', { header: 'Compare' });
        for (const v of board.versions) if (v !== version) items.push({ label: (version.latest ? 'This revision' : version.label) + ' with ' + (v.latest ? 'the latest' : v.label), icon: I.compare, onClick: () => { const iv = board.versions.indexOf(v), ic = board.versions.indexOf(version); compareVersions(iv > ic ? v : version, iv > ic ? version : v); } });
      }
      if (!repo.draft && board.versions.length < 2) items.push({ node: el('div', { class: 'menu-note small muted' }, 'Updating the board from KiCad keeps the earlier revision here, to compare with.') });
      N.menu(btn, items, { alignRight: true, cls: 'wide' });
      return;
    }
    const items = [];
    if (board.versions.length > 1) {
      items.push({ header: 'Revisions' });
      for (const v of board.versions) items.push({ label: v.label, hint: 'KiCad ' + v.kicad, active: v === version, onClick: () => openBoard(repo, board, v, App.tab) });
      // what changed from one revision to the next (repository revisions are listed oldest first)
      const { older, newer } = neighbours(board, version, false);
      if (older) items.push({ label: 'Compare with ' + older.label, hint: 'what changed', icon: I.compare, onClick: () => compareVersions(older, version) });
      if (newer) items.push({ label: 'Compare with ' + newer.label, hint: 'what changed next', icon: I.compare, onClick: () => compareVersions(version, newer) });
      items.push('-');
    } else {
      items.push({ header: 'Revision' }, { label: version.label, hint: 'KiCad ' + version.kicad, active: true, onClick: () => {} }, '-');
    }
    items.push({ header: 'History' });
    for (const c of (version.history || []).slice(0, 6)) items.push({ label: c.m.length > 48 ? c.m.slice(0, 46) + '…' : c.m, hint: c.h + ' · ' + N.fmt.date(c.d), href: `${repo.url}/commit/${c.h}` });
    if (!(version.history || []).length) items.push({ label: 'No commits in the imported history', onClick: () => {} });
    N.menu(btn, items, { alignRight: true, cls: 'wide' });
  }

  function infoPop(btn) {
    const { repo, version, B } = App.cur;
    if (!B) return;
    const m = B.meta, s = B.stats;
    const rows = [
      ['Dimensions', `${m.w.toFixed(1)} × ${m.h.toFixed(1)} mm`], ['Copper layers', `${m.cu.length} (${m.cu.join(', ')})`], ['Thickness', m.thickness + ' mm'],
      ['Surface finish', m.finish], ['Solder mask', m.maskName], ['Parts', `${s.parts} (${s.top} top, ${s.bottom} bottom)`], ['BOM lines', s.lines],
      ['Nets', N.fmt.num(s.nets)], ['Vias', N.fmt.num(s.vias)], ['Routed track', N.fmt.num(s.trackLen) + ' mm'], ['Min track / drill', `${m.minTrack} / ${m.minDrill} mm`],
      ['Schematic sheets', s.sheets], ['KiCad', version.kicad],
    ];
    const node = el('div', { class: 'info-pop' },
      el('table', { class: 'kv-table' }, rows.map(([k, v]) => el('tr', null, el('th', { scope: 'row' }, k), el('td', { class: 'num' }, String(v))))),
      repo.user ? el('span', { class: 'small mono muted' }, N.lib.kindLabel(repo.meta)) : el('a', { class: 'small mono', href: `${repo.url}/blob/${repo.branch}/${version.pcbPath}`, target: '_blank', rel: 'noopener' }, version.pcbPath, N.svg(I.ext, 'tiny')));
    N.menu(btn, [{ header: 'Board details' }, { node }], { alignRight: true, cls: 'wide' });
  }

  function downloadMenu(btn) {
    const { repo, board, version, B } = App.cur;
    const base = panelCtx().fileBase;
    const count = () => N.social.countDownload(repo.id);
    if (repo.user) {
      const u = App.cur.user || {};
      N.menu(btn, [
        { header: repo.title },
        u.design || u.source || repo.meta.hasSource ? { label: 'KiCad project (.zip)', icon: I.folder, onClick: downloadProject } : null,
        { label: 'Bill of materials (CSV)', icon: I.bom, onClick: () => B && N.saveFile(base + '-bom.csv', N.exporters.bom(B), count) },
        { label: 'Pick and place (CSV)', icon: I.target, onClick: () => B && N.saveFile(base + '-pnp.csv', N.exporters.pnp(B), count) },
        { label: 'Netlist (CSV)', icon: I.pcb, onClick: () => B && N.saveFile(base + '-netlist.csv', N.exporters.netlist(B), count) },
        { label: 'Simulation for KiCad (.zip)', icon: I.probe, onClick: exportSimForKiCad },
      ].filter(Boolean), { alignRight: true });
      return;
    }
    N.menu(btn, [
      { header: `${board.name} · ${version.label}` },
      { label: 'Bill of materials (CSV)', icon: I.bom, onClick: () => B && N.saveFile(base + '-bom.csv', N.exporters.bom(B), count) },
      { label: 'Pick and place (CSV)', icon: I.target, onClick: () => B && N.saveFile(base + '-pnp.csv', N.exporters.pnp(B), count) },
      { label: 'Netlist (CSV)', icon: I.pcb, onClick: () => B && N.saveFile(base + '-netlist.csv', N.exporters.netlist(B), count) },
      { label: 'Simulation for KiCad (.zip)', icon: I.probe, onClick: exportSimForKiCad },
      '-',
      { label: 'Source archive on GitHub', icon: I.ext, href: `${repo.url}/archive/refs/heads/${repo.branch}.zip` },
    ], { alignRight: true });
  }

  function shareMenu(btn) {
    const { repo, board } = App.cur;
    const localHost = !!(window.claude && window.claude.local);
    const pageLink = location.href.split('#')[0];
    if (repo.user) {
      const anchor = '#' + repo.id + '~main~' + App.tab;
      const code = el('code', { class: 'share-code' }, anchor);
      N.menu(btn, [{ header: 'Share' }, { node: el('div', { class: 'share-pop' },
        el('p', { class: 'small' }, localHost ? 'This board is in your library on this device. To share it, use Download → KiCad files and send those, or export it and let others open it with New board → Upload.' : 'This board is in the shared library, so everyone who opens this page can find it on Explore. To send someone straight to it, share the page from Claude’s share menu and add this anchor to the link:'),
        el('div', { class: 'share-line' }, code, el('button', { class: 'btn tiny', onclick: async () => { const ok = await N.copyText(anchor, code); N.toast(ok ? 'Copied' : 'Select the text and copy it'); } }, N.svg(I.copy), 'Copy'))) }], { alignRight: true, cls: 'wide' });
      return;
    }
    const anchor = '#' + [repo.id, board.id, App.tab].join('~');
    const row = (label, text) => {
      const code = el('code', { class: 'share-code' }, text);
      return el('div', { class: 'share-row' }, el('div', { class: 'small muted' }, label), el('div', { class: 'share-line' }, code,
        el('button', { class: 'btn tiny', onclick: async () => { const ok = await N.copyText(text, code); N.toast(ok ? 'Copied' : 'Select the text and copy it'); } }, N.svg(I.copy), 'Copy')));
    };
    const node = el('div', { class: 'share-pop' },
      el('p', { class: 'small' }, localHost ? 'Link to this board and tab:' : 'Share this page from Claude’s share menu. To land people on this board and tab, add this anchor to the end of the page link:'),
      localHost && /^https?:/.test(pageLink) && !/localhost|127\.0\.0\.1/.test(pageLink) ? row('Link', pageLink + anchor) : row('Anchor', anchor), row('Source repository', repo.url));
    N.menu(btn, [{ header: 'Share' }, { node }], { alignRight: true, cls: 'wide' });
  }

  function toggleFull() {
    const card = $('#viewer-card');
    const done = () => requestAnimationFrame(() => { for (const k in App.views) App.views[k].resize && App.views[k].resize(); });
    if (document.fullscreenElement) { document.exitFullscreen().then(done, done); return; }
    if (card.classList.contains('maximized')) { card.classList.remove('maximized'); done(); return; }
    const p = card.requestFullscreen ? card.requestFullscreen() : Promise.reject();
    p.then(done, () => { card.classList.add('maximized'); done(); });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { const c = $('#viewer-card.maximized'); if (c) { c.classList.remove('maximized'); } }
  });

  // ------------------------------------------------------------------ social UI
  function updateSocial() {
    if (!App.cur || !$('#about-stars')) return;
    const repo = App.cur.repo;
    const S = N.social;
    const starred = S.isStarred(repo.id);
    const total = repo.stars + S.starCount(repo.id);
    const btn = $('#star-btn');
    if (btn) {
      btn.classList.toggle('starred', starred);
      btn.setAttribute('aria-pressed', starred);
      btn.querySelector('.star-ico').innerHTML = starred ? I.starFill : I.star;
      btn.querySelector('.star-label').textContent = starred ? 'Starred' : 'Star';
      $('#star-count').textContent = N.fmt.k(total);
      btn.title = repo.user ? `${S.starCount(repo.id)} on KiLive` : `${N.fmt.num(repo.stars)} on GitHub · ${S.starCount(repo.id)} on KiLive`;
    }
    $('#about-stars').textContent = `${N.fmt.num(total)} stars`;
    const cc = S.commentsFor(repo.id).length;
    $('#about-comments').textContent = `${cc} comment${cc === 1 ? '' : 's'}`;
    const dc = S.downloadCount(repo.id);
    $('#about-downloads').textContent = `${dc} download${dc === 1 ? '' : 's'}`;
    renderComments();
  }

  let commentsToken = 0;
  async function renderComments() {
    const host = $('#comments');
    if (!host || !App.cur) return;
    host.hidden = !!App.cur.repo.draft;
    if (App.cur.repo.draft) return;
    const token = ++commentsToken;
    const repo = App.cur.repo;
    const S = N.social;
    const list = S.commentsFor(repo.id);
    const names = await S.names([...new Set(list.map(c => c.uid))]);
    if (token !== commentsToken || !App.cur || App.cur.repo !== repo) return;
    const prevTa = $('#comment-input');
    const draft = prevTa ? prevTa.value : N.store.get('draft:' + repo.id, '');
    const focused = document.activeElement === prevTa;
    const frag = document.createDocumentFragment();
    frag.append(el('h2', { id: 'comments-h', class: 'eyebrow' }, `Comments · ${list.length}`));
    const ul = el('ul', { class: 'comment-list' });
    for (const c of list) {
      const p = names[c.uid] || {};
      const mine = c.uid === S.uid;
      const board = repo.boards.find(b => b.id === c.board);
      ul.append(el('li', { class: 'comment' },
        p.avatarUrl ? el('img', { class: 'avatar', src: p.avatarUrl, alt: '' }) : el('span', { class: 'avatar' }),
        el('div', { class: 'c-body' },
          el('div', { class: 'c-meta' }, el('b', { text: p.name || (mine ? 'You' : 'Someone') }), el('span', { class: 'muted small' }, N.fmt.ago(c.at)), board ? el('span', { class: 'tag mono' }, board.name) : null,
            mine ? el('button', { class: 'icon-btn small', 'aria-label': 'Delete your comment', onclick: async () => { try { await S.deleteComment(c.id); } catch (e) { N.toast('Could not delete the comment.', 'warn'); } } }, N.svg(I.trash)) : null),
          el('p', { class: 'c-text', text: c.text }))));
    }
    if (!list.length) ul.append(el('li', { class: 'muted small empty-c' }, 'No comments yet. Notes about bring-up, errata and fixes help the next person.'));
    frag.append(ul);
    let ta = null;
    if (S.live() && S.canWrite) {
      ta = el('textarea', { class: 'input', id: 'comment-input', rows: '2', placeholder: `Leave a note on ${repo.name} (what you measured, what you fixed)`, 'aria-label': 'Write a comment' });
      ta.value = draft;
      ta.addEventListener('input', N.debounce(() => N.store.set('draft:' + repo.id, ta.value), 300));
      const post = el('button', { class: 'btn primary', onclick: async () => {
        const t = ta.value.trim();
        if (!t) { ta.focus(); return; }
        post.disabled = true;
        try { await S.addComment(repo.id, App.cur.board.id, t); ta.value = ''; N.store.set('draft:' + repo.id, ''); N.toast('Comment posted'); }
        catch (e) { N.toast(e && e.code === 'invalid_argument' ? 'Your access to this page is view-only, so you cannot comment.' : 'Could not post the comment. Try again.', 'warn'); }
        finally { post.disabled = false; }
      } }, 'Post comment');
      frag.append(el('div', { class: 'comment-compose' }, ta, post));
    } else if (S.ready) {
      frag.append(el('p', { class: 'muted small' }, S.db ? 'Comments are read-only for your access level.' : 'Comments, stars and download counts are shared when this page is opened in Claude by a signed-in viewer.'));
    }
    host.replaceChildren(frag);
    if (ta && focused) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  N.bootApp = boot;
})();

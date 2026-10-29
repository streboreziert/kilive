/* KiLive — the live mode interface: the control bar, the side panel (Probes · Code · Board), the colour legend,
   the screens programs draw on. The simulation itself lives in liveview.js (N.live). */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const I = N.icons;
  const fmt = () => N.liveFmt;
  const store = { get: (k, d) => N.store.get(k, d), set: (k, v) => N.store.set(k, v) };
  const SPANS = [[0, 'Auto'], [1e-4, '100 µs'], [1e-3, '1 ms'], [1e-2, '10 ms'], [0.1, '100 ms'], [1, '1 s'], [2, '2 s']];
  const MODE_BTN = [['hi', 'High'], ['lo', 'Low'], ['pu', 'Pull-up'], ['release', 'Release']];
  const svgPath = (d, fill) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    pause: '<svg viewBox="0 0 16 16" width="16" height="16"><rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M5 3l8 5-8 5z" fill="currentColor"/></svg>',
    step: svgPath('<path d="M4 3l6 5-6 5z" fill="currentColor" stroke="none"/><path d="M12.5 3v10"/>'),
    power: svgPath('<path d="M8 2v6"/><path d="M4.6 4.4a5 5 0 106.8 0"/>'),
    probe: svgPath('<path d="M10.5 2.5l3 3-6 6-3-3z"/><path d="M4.5 11.5L2 14"/><path d="M9 4l3 3"/>'),
    rail: svgPath('<path d="M9 1.5L4 9h4l-1 5.5L12 7H8z"/>'),
    board: svgPath('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5.5 5.5h2v2h-2zM9.5 9.5h1M5.5 10.5h1M10.5 5.5v1"/>'),
    chev: svgPath('<path d="M6 3.5L10.5 8 6 12.5"/>'),
    help: svgPath('<circle cx="8" cy="8" r="6"/><path d="M6.4 6.3a1.7 1.7 0 113 1.1c-.6.5-1.4.8-1.4 1.8"/><circle cx="8" cy="11.6" r=".6" fill="currentColor" stroke="none"/>'),
    send: svgPath('<path d="M2.5 8h9"/><path d="M8 4.5L11.5 8 8 11.5"/>'),
    pin: svgPath('<path d="M6 2.5h4l-.8 4 2.3 2.2H4.5l2.3-2.2z"/><path d="M8 8.7v4.8"/>'),
    act: svgPath('<path d="M3 4.5h6M11.5 4.5h1.5M3 11.5h1.5M7 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/>'),
    more: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="3.5" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="12.5" cy="8" r="1.4" fill="currentColor"/></svg>',
  };

  N.livePanel = { mount: L => new Panel(L) };

  class Panel {
    constructor(L) {
      this.L = L;
      this.host = L.ctx.host;
      this.tab = store.get('live-tab', 'probes');
      this.side = store.get('live-side', !matchMedia('(max-width: 760px)').matches);   // phones start with the board, not the panel
      this.codeRef = null;
      this.boardRef = null;
      this.frame = 0;
      this.bar = el('div', { class: 'live-bar', role: 'toolbar', 'aria-label': 'Live simulation' });
      this.sideEl = el('aside', { class: 'live-side', 'aria-label': 'Live panel' });
      this.legend = el('div', { class: 'live-legend' });
      this.screens = el('div', { class: 'live-screens' });
      this.host.append(this.bar, this.sideEl, this.legend, this.screens);
      this.host.classList.add('live-on');
      this.host.classList.toggle('side-open', !!this.side);
      this.keys = e => {
        if (!L.on || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.target.closest && e.target.closest('input,textarea,select,button,[contenteditable]')) return;
        if (!L.ctx.visible()) return;
        if (e.key === ' ') { e.preventDefault(); L.running = !L.running; L.last = performance.now(); this.renderBar(); }
        // P: probe what is selected (the Probe button on its card); . : one step
        else if (e.key === 'p' || e.key === 'P') { const b = document.querySelector('.selcard:not([hidden]) .scl-probe'); e.preventDefault(); if (b) b.click(); else if (N.app && N.app.toggleProbeTool) N.app.toggleProbeTool(); }
        else if (e.key === '.') { e.preventDefault(); L.running = false; L.engine.step(); this.renderBar(); }
      };
      document.addEventListener('keydown', this.keys);
      this.renderBar();
      this.renderSide();
      this.renderLegend();
      this.renderScreens();
      // started by placing a probe: the view stays where the user was looking
      this.resized(!L.keepView); L.keepView = false;
      // bring the whole viewer into view: the board, the bar and the panel fit the window
      requestAnimationFrame(() => { const card = this.host.closest('.viewer-card') || this.host; const r = card.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight + 40) card.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    }
    destroy() {
      document.removeEventListener('keydown', this.keys);
      for (const x of [this.bar, this.sideEl, this.legend, this.screens]) x.remove();
      this.host.classList.remove('live-on', 'side-open', 'side-wide');
      if (this.conListener) this.conListener.c.listeners.delete(this.conListener.f);
      this.resized();
    }
    resized(fit) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
        if (fit !== false) requestAnimationFrame(() => { const v = this.L.ctx && this.L.ctx.getViews(); if (!v) return; if (v.tab === 'pcb' && v.pcb) v.pcb.fit(); if (v.tab === 'sch' && v.sch) v.sch.fit(); });
      });
    }

    // ---------------------------------------------------------------- hooks from the controller
    // cheap refresh (speed, run state, faults): the bar and legend; the side panel keeps its state
    refresh() { this.renderBar(); this.renderLegend(); if (this.tab === 'probes') this.renderSide(); else if (this.codeUI) this.codeUI.refresh(); else if (this.actionsUI) this.actionsUI.tick(); }
    rebuilt() { this.renderBar(); this.renderLegend(); this.renderSide(); }
    procChanged() {
      this.renderScreens();
      this.updateBarCounts();
      if (this.tab === 'code' && this.codeUI) this.codeUI.refresh();
      if (this.tab === 'board' && this.boardUI) this.boardUI.refreshParts();
      if (this.tab === 'actions' && this.actionsUI) this.actionsUI.tick();
    }
    probesChanged(p) {
      if (p && (!this.side || this.tab !== 'probes')) { this.open('probes'); return; }
      if (this.tab === 'probes') this.renderSide();
      this.updateBarCounts();
      if (p) this.focusProbe(p);
    }
    focusProbe(p) { const c = this.sideEl.querySelector(`.pb-card[data-id="${p.id}"]`); if (c) { c.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); } }
    open(tab, ref) {
      if (tab === 'code' && ref) this.codeRef = ref;
      this.tab = tab;
      store.set('live-tab', tab);
      if (!this.side) { this.side = true; store.set('live-side', true); this.host.classList.add('side-open'); this.resized(); }
      this.renderSide();
      this.renderBar();
    }
    toggleSide(force) {
      this.side = force == null ? !this.side : force;
      store.set('live-side', this.side);
      this.host.classList.toggle('side-open', this.side);
      this.renderBar();
      this.resized();
    }
    tick() {
      this.frame++;
      this.updateBarValues();
      if (this.side) {
        if (this.tab === 'probes') this.updateProbes();
        else if (this.tab === 'board' && this.boardUI && (this.frame & 3) === 0) this.boardUI.refreshParts();
        else if (this.tab === 'actions' && this.actionsUI && (this.frame & 1) === 0) this.actionsUI.tick();
      }
      this.updateScreens();
    }

    // ---------------------------------------------------------------- the bar
    renderBar() {
      const L = this.L, e = L.engine, f = fmt();
      if (!e) return;
      const b = (cls, title, icon, label, onclick, extra) => el('button', Object.assign({ class: 'lb ' + cls, type: 'button', title, 'aria-label': title, onclick }, extra || {}), icon ? N.svg(icon) : null, label != null ? el('span', { class: 'lbl' }, label) : null);
      const play = b('lb-play' + (L.running ? '' : ' paused'), L.running ? 'Pause (space)' : 'Run (space)', L.running ? ICON.pause : ICON.play, null, () => { L.running = !L.running; L.last = performance.now(); this.renderBar(); });
      const step = b('', 'Single step (.)', ICON.step, null, () => { L.running = false; e.step(); this.renderBar(); });
      const pwr = b('', 'Switch everything off and power the board up again', ICON.power, 'Power up', () => L.powerUp());
      const speed = el('select', { class: 'lb-sel', 'aria-label': 'Simulation speed', title: 'Simulated time per second of real time' }, L.SPEEDS.map(([v, t]) => el('option', { value: v, selected: v === L.speed || null }, t)));
      speed.addEventListener('change', () => L.setSpeed(+speed.value, false, true));
      const time = el('span', { class: 'lb-time mono', 'data-k': 'time' }, 't = ' + f.T(e.t));
      const perf = el('span', { class: 'lb-perf', 'data-k': 'perf' });
      const tabBtn = (tab, icon, label, title, count) => b('lb-tab' + (this.side && this.tab === tab ? ' on' : ''), title, icon, label, () => { if (this.side && this.tab === tab) this.toggleSide(false); else this.open(tab); }, { 'data-tab': tab, 'aria-pressed': this.side && this.tab === tab ? 'true' : 'false' });
      const rails = L.rails();
      const bad = rails.filter(r => r.ok === false).length, good = rails.filter(r => r.ok).length;
      const railBtn = b('lb-rails' + (bad ? ' warn' : ''), bad ? `${bad} rail${bad > 1 ? 's are' : ' is'} not at the nominal voltage` : 'Supply rails', ICON.rail, null, () => { this.open('probes'); requestAnimationFrame(() => { const r = this.sideEl.querySelector('.pb-rails'); if (r) r.scrollIntoView({ block: 'start', behavior: 'smooth' }); }); }, { 'data-k': 'rails' });
      railBtn.append(el('span', { class: 'lb-rc' }, `${good}✓${bad ? ' ' + bad + '!' : ''}`));
      const probes = tabBtn('probes', ICON.probe, 'Probes', 'Probes and supply rails');
      probes.append(el('span', { class: 'lb-count', 'data-k': 'pcount' }, String(L.probes.length)));
      const acts = N.actions ? tabBtn('actions', ICON.act, 'Actions', 'What you can do with this board: power, buttons, chips talking to each other') : null;
      const nProc = (L.procs || []).length;
      const code = nProc ? tabBtn('code', I.code, 'Code', 'Put code on the processors') : null;
      if (code) code.append(el('span', { class: 'lb-count', 'data-k': 'ccount' }));
      const board = nProc ? tabBtn('board', ICON.board, 'Board', 'What this board does, and the world its sensors see') : null;
      const more = b('lb-more' + (L.fault ? ' on' : ''), 'More: break a part, supplies and switches', ICON.more, L.fault ? 'Fault on' : 'More', ev => {
        const btn = ev.currentTarget;
        N.menu(btn, [
          { label: L.fault ? 'Change the fault…' : 'Break a part or net…', hint: 'see how the board fails', onClick: () => this.faultMenu(btn) },
          { label: 'Supplies, switches and knobs…', hint: 'also under Actions', onClick: () => this.controlsMenu(btn) },
        ], { cls: 'pb-menu' });
      });
      const help = b('lb-help' + (this.legend.hidden ? '' : ' on'), 'What the colours and dots mean', ICON.help, null, () => { this.legend.hidden = !this.legend.hidden; store.set('live-legend', !this.legend.hidden); this.renderBar(); });
      const close = b('', 'Stop live simulation', I.close, null, () => { const c = L.ctx; L.stop(); if (c && c.onStopped) c.onStopped(); });
      const badge = el('span', { class: 'lb-badge' }, el('span', { class: 'ld-pulse' + (L.running ? ' on' : '') }), 'LIVE');
      this.bar.replaceChildren(badge, play, step, pwr, el('span', { class: 'lb-sep' }), speed, time, perf, el('span', { class: 'grow' }), railBtn, probes, acts, code, board, el('span', { class: 'lb-sep' }), more, help, close);
      if (L.fault) this.bar.append(el('div', { class: 'lb-fault' }, N.svg(I.bug), el('span', null, L.fault.text), el('button', { class: 'lb', type: 'button', onclick: () => L.clearFault() }, 'Clear fault')));
      this.updateBarCounts();
      this.updateBarValues();
    }
    updateBarCounts() {
      const L = this.L;
      const pc = this.bar.querySelector('[data-k="pcount"]');
      if (pc) { pc.textContent = String(L.probes.length); pc.classList.toggle('on', L.probes.length > 0); }
      const cc = this.bar.querySelector('[data-k="ccount"]');
      if (cc && L.fwm) { const n = L.fwm.running(), tot = (L.procs || []).length; cc.textContent = n ? n + ' running' : String(tot); cc.classList.toggle('on', !!n); }
    }
    updateBarValues() {
      const L = this.L, e = L.engine, f = fmt();
      if (!e) return;
      const t = this.bar.querySelector('[data-k="time"]');
      if (t) { t.textContent = 't = ' + f.T(e.t); t.title = `${L.info.unknowns} unknowns · ${L.info.elements} elements · time step ${f.T(e.dt)}`; }
      const p = this.bar.querySelector('[data-k="perf"]');
      if (p) p.textContent = L.running && L.sps ? `${N.fmt.num(Math.round(L.sps))} steps/s${L.ratio < 0.95 ? ' · ' + Math.round(L.ratio * 100) + '% speed' : ''}` : L.running ? '' : 'paused';
      const sel = this.bar.querySelector('.lb-sel');
      if (sel && +sel.value !== L.speed) sel.value = L.speed;
      if ((this.frame & 15) === 0) {
        const rb = this.bar.querySelector('[data-k="rails"]');
        if (rb) { const rails = L.rails(); const bad = rails.filter(r => r.ok === false).length, good = rails.filter(r => r.ok).length; rb.classList.toggle('warn', !!bad); rb.querySelector('.lb-rc').textContent = `${good}✓${bad ? ' ' + bad + '!' : ''}`; }
      }
    }

    // ---------------------------------------------------------------- legend and screens
    // the colour key: one line for the voltage scale, one for the three marks, and where values are written on the copper
    renderLegend() {
      const L = this.L;
      if (L.labelMode == null) L.labelMode = store.get('live-labelmode', store.get('live-labels', true) === false ? 'off' : 'focus');
      if (this.legend.hidden === undefined || this._legendInit !== true) { this.legend.hidden = !store.get('live-legend', true); this._legendInit = true; }
      const vm = L.vmax || 5;
      const neg = L.engine && L.engine.supplies().some(s => s.value < 0);
      const bar = el('canvas', { class: 'lg-bar', width: 160, height: 10 });
      const g = bar.getContext('2d');
      const pal = N.livePalette('dark');
      for (let x = 0; x < 160; x++) { const v = neg ? (x / 159 * 2 - 1) : x / 159; g.fillStyle = pal[N.liveIdx(v, 1)]; g.fillRect(x, 0, 1, 10); }
      const modes = [['focus', 'Selected', 'Values on the selected and probed nets'], ['all', 'All', 'Values on the busiest tracks everywhere (when zoomed in)'], ['off', 'Off', 'No values on the copper']];
      const seg = el('div', { class: 'lg-seg', role: 'group', 'aria-label': 'Values on the copper' }, modes.map(([m, t, title]) => el('button', { class: 'lg-sb' + (L.labelMode === m ? ' on' : ''), type: 'button', title, 'aria-pressed': L.labelMode === m ? 'true' : 'false', onclick: () => { L.labelMode = m; store.set('live-labelmode', m); this.renderLegend(); } }, t)));
      this.legend.replaceChildren(
        el('div', { class: 'lg-row' }, el('span', { class: 'lg-k' }, 'Voltage'), el('div', { class: 'lg-scale' }, bar, el('div', { class: 'lg-ticks' }, el('span', null, neg ? '−' + vm.toFixed(vm < 10 ? 1 : 0) : '0'), neg ? el('span', null, '0') : null, el('span', null, '+' + vm.toFixed(vm < 10 ? 1 : 0) + ' V')))),
        el('div', { class: 'lg-row lg-keys' },
          el('span', { class: 'lg-key', title: 'Nothing would drive this net on the real board either, so it reads noise' }, el('i', { class: 'lg-sw', style: { background: N.liveFloatColor() } }), 'floating'),
          el('span', { class: 'lg-key', title: 'Driven from somewhere the simulation does not cover: a connector, a processor pin no program uses yet, a chip simulated only as its supply current' }, el('i', { class: 'lg-sw', style: { background: N.livePalette('dark')[253] } }), 'not driven here'),
          el('span', { class: 'lg-key', title: 'Dots move with the current: faster dots, more current' }, el('i', { class: 'lg-dot' }), 'current')),
        el('div', { class: 'lg-row lg-opt' }, el('span', { class: 'lg-k' }, 'Values'), seg));
    }
    renderScreens() {
      const L = this.L;
      const list = [];
      if (L.fwm) for (const [ref, arr] of L.fwm.screens) for (const s of arr) list.push(Object.assign({ owner: ref }, s));
      this.screenList = list;
      this.screens.replaceChildren(...list.map(s => {
        const w = s.dev.width, h = s.dev.height;
        const fit = 200 / Math.max(w, h * 1.1), k = fit >= 1 ? Math.min(3, Math.floor(fit)) : fit;   // big panels shrink (smoothly), small ones grow by whole pixels
        const cv = el('canvas', { class: 'scr-cv' + (k < 1 ? ' smooth' : ''), width: w, height: h, style: { width: Math.round(w * k) + 'px', height: Math.round(h * k) + 'px' } });
        s.cv = cv; s.ver = -1;
        const box = el('div', { class: 'scr' + (this.minScr && this.minScr.has(s.ref) ? ' min' : '') });
        const head = el('div', { class: 'scr-head', title: 'Click to fold or unfold the screen', onclick: () => { this.minScr = this.minScr || new Set(); box.classList.toggle('min') ? this.minScr.add(s.ref) : this.minScr.delete(s.ref); } }, el('b', null, s.ref), el('span', null, `${s.name} · ${w}×${h}`));
        box.append(head, cv);
        return box;
      }));
      this.screens.hidden = !list.length;
      this.updateScreens();
    }
    updateScreens() {
      for (const s of this.screenList || []) {
        if (s.dev.version === s.ver) continue;
        s.ver = s.dev.version;
        const g = s.cv.getContext('2d');
        const px = s.dev.rgba();
        if (!px) continue;
        g.putImageData(new ImageData(new Uint8ClampedArray(px.buffer ? px : px), s.dev.width, s.dev.height), 0, 0);
        if (s.dev.on === false) { g.fillStyle = 'rgba(0,0,0,0.85)'; g.fillRect(0, 0, s.dev.width, s.dev.height); }
      }
    }

    // ---------------------------------------------------------------- the side panel
    renderSide() {
      const L = this.L;
      const nProc = (L.procs || []).length;
      if (!nProc && (this.tab === 'code' || this.tab === 'board')) this.tab = 'probes';
      if (this.tab === 'actions' && !N.actions) this.tab = 'probes';
      const tabs = [['probes', 'Probes'], N.actions ? ['actions', 'Actions'] : null, nProc ? ['code', 'Code'] : null, nProc ? ['board', 'Board'] : null].filter(Boolean);
      const head = el('div', { class: 'ls-head', role: 'tablist' },
        tabs.map(([id, label]) => el('button', { class: 'ls-tab' + (this.tab === id ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': this.tab === id ? 'true' : 'false', onclick: () => this.open(id) }, label)),
        el('span', { class: 'grow' }),
        el('button', { class: 'lb', type: 'button', title: 'Hide the panel', 'aria-label': 'Hide the panel', onclick: () => this.toggleSide(false) }, N.svg(ICON.chev)));
      const body = el('div', { class: 'ls-body' });
      if (this.conListener) { this.conListener.c.listeners.delete(this.conListener.f); this.conListener = null; }
      this.codeUI = null; this.boardUI = null; this.actionsUI = null;
      this.host.classList.toggle('side-wide', this.tab === 'code');
      if (this.tab === 'probes') this.buildProbes(body);
      else if (this.tab === 'code') this.codeUI = this.buildCode(body);
      else if (this.tab === 'board') this.boardUI = this.buildBoard(body);
      else if (this.tab === 'actions') this.actionsUI = N.actions.build(this, body);
      this.sideEl.replaceChildren(head, body);
    }

    // ================================================================ Probes
    buildProbes(body) {
      const L = this.L;
      // scope
      const span = el('select', { class: 'lb-sel tiny', 'aria-label': 'Time span' }, SPANS.map(([v, t]) => el('option', { value: v, selected: (L.scopeFixed || 0) === v || null }, t)));
      span.addEventListener('change', () => { L.scopeFixed = +span.value || 0; });
      const trig = el('button', { class: 'lb tiny' + (this.trigger ? ' on' : ''), type: 'button', title: 'Hold periodic signals still: trigger on the first channel\'s rising edges', onclick: e => { this.trigger = !this.trigger; e.currentTarget.classList.toggle('on', this.trigger); } }, 'Trigger');
      const lanes = el('button', { class: 'lb tiny' + (this.lanesOn() ? ' on' : ''), type: 'button', 'aria-pressed': this.lanesOn() ? 'true' : 'false', title: 'One lane per signal with its own scale, like a logic analyser (on its own from 5 signals)', onclick: () => { this.scopeMode = this.lanesOn() ? 'overlay' : 'lanes'; store.set('scope-mode', this.scopeMode); this.renderSide(); } }, 'Lanes');
      const add = el('button', { class: 'lb tiny pb-add', type: 'button', title: 'Add a group of signals: a processor\'s pins, a bus with its decoder, the serial port, LEDs, rails', onclick: e => this.signalsMenu(e.currentTarget) }, '+ Signals');
      const clear = L.probes.length ? el('button', { class: 'lb tiny', type: 'button', onclick: () => L.clearProbes() }, 'Clear') : null;
      body.append(el('div', { class: 'ls-sec pb-scopehead' }, el('span', null, 'Scope'), el('span', { class: 'pb-nch muted' }, L.probes.length ? `${L.probes.length}/${L.MAX_PROBES || 16}` : ''), el('span', { class: 'grow' }), add, span, trig, lanes, clear));
      this.scope = el('canvas', { class: 'pb-scope', height: 150 });
      this.scope.addEventListener('pointermove', e => { this.cursor = e.offsetX; this.drawScope(); });
      this.scope.addEventListener('pointerleave', () => { this.cursor = null; this.drawScope(); });
      body.append(this.scope);
      if (!L.probes.length) body.append(el('div', { class: 'pb-empty' }, N.svg(ICON.probe), el('div', null, el('b', null, 'No probes yet'),
        el('p', null, 'Press ', el('b', null, 'Probe'), ' in the board toolbar (or P) and click a trace, pad or pin. Or select something and press Probe on its card. + Signals adds a whole group at once.'),
        N.app && N.app.toggleProbeTool ? el('button', { class: 'lb', type: 'button', onclick: () => N.app.setProbeTool(true) }, N.svg(ICON.probe), 'Probe tool') : null)));
      this.cards = new Map();
      for (const p of L.probes) { const c = this.probeCard(p); this.cards.set(p.id, c); body.append(c.root); }
      // rails
      const rails = L.rails();
      const rs = el('div', { class: 'pb-rails' });
      rs.append(el('div', { class: 'ls-sec' }, el('span', null, 'Supply rails'), el('span', { class: 'grow' }), el('span', { class: 'muted small' }, rails.length ? 'click to select · + to probe' : '')));
      if (!rails.length) rs.append(el('p', { class: 'muted small' }, 'No supply rails in this circuit.'));
      this.railRows = rails.map(r => {
        const sel = el('button', { class: 'pr-main', type: 'button', onclick: () => { const ni = L.netIdx.get(r.name); if (ni && N.select) N.select([], [ni]); } },
          el('i', { class: 'pr-dot' }), el('span', { class: 'mono pr-name' }, N.fmt.shortNet(r.name)), el('b', { class: 'num' }), el('span', { class: 'pr-ok' }), el('span', { class: 'pr-why' }));
        const add = el('button', { class: 'pr-add', type: 'button', title: 'Probe ' + N.fmt.shortNet(r.name), 'aria-label': 'Probe ' + N.fmt.shortNet(r.name), onclick: () => L.addProbe({ name: r.name }) }, '+');
        const row = el('div', { class: 'pr-row' }, sel, add);
        rs.append(row);
        return { r, row };
      });
      body.append(rs);
      // how to read it all, folded away until asked for
      body.append(el('details', { class: 'pb-help' }, el('summary', null, 'How to read the live view'),
        el('ul', null,
          el('li', null, 'Copper and wires take the colour of their voltage: grey is 0 V, green positive, red negative. Purple is floating (nothing would drive it on the real board either); dark slate is driven from outside what is simulated (a connector, an unused processor pin, a chip modelled only as its supply current).'),
          el('li', null, 'Yellow dots move with the current: the faster, the more.'),
          el('li', null, 'Click a trace, pad, pin or part to select it. Its card shows the live value, what drives it and a Probe button; probes go on the scope, up to 16.'),
          el('li', null, '+ Signals adds a group at once (a bus with its decoder, a serial port, LEDs, rails). Lanes stacks them like a logic analyser.'),
          el('li', null, 'Values on the copper follow the selection and the probes; the key at the bottom left switches them to all or off.'),
          el('li', null, 'Keys: Space runs or pauses, . steps once, P probes what is selected.'))));
      this.updateProbes(true);
    }
    // with many probes the cards fold to one line each (click the chevron for the details)
    isOpen(p) { return p.open != null ? p.open : this.L.probes.length <= 4; }
    lanesOn() {
      const m = this.scopeMode || (this.scopeMode = store.get('scope-mode', 'auto'));
      const P = this.L.probes;
      return m === 'lanes' || (m === 'auto' && (P.length > 4 || P.some(p => p.kind === 'decode')));
    }
    signalsMenu(btn) {
      const L = this.L;
      let groups = [];
      try { groups = L.signalGroups(); } catch (e) { console.error(e); }
      const items = groups.length ? [{ header: `Add a group · ${L.MAX_PROBES || 16} channels` }].concat(groups.map(g => ({ label: g.label, hint: g.hint, onClick: () => g.add() })))
        : [{ header: 'Nothing to add here yet' }];
      N.menu(btn, items, { cls: 'pb-menu' });
    }
    cardTop(p, root, extra) {
      const L = this.L;
      const pinBtn = el('button', { class: 'lb tiny icon' + (p.pinned ? ' on' : ''), type: 'button', title: 'Keep this probe when new ones are added', onclick: e => { p.pinned = !p.pinned; e.currentTarget.classList.toggle('on', p.pinned); } }, N.svg(ICON.pin));
      const rm = el('button', { class: 'lb tiny icon', type: 'button', title: 'Remove probe', 'aria-label': 'Remove probe ' + p.label, onclick: () => L.removeProbe(p.id) }, N.svg(I.close));
      const tog = el('button', { class: 'lb tiny icon pb-tog', type: 'button', title: 'Details', 'aria-label': 'Details of ' + p.label, 'aria-expanded': this.isOpen(p) ? 'true' : 'false', onclick: e => { p.open = !this.isOpen(p); root.classList.toggle('collapsed', !p.open); e.currentTarget.setAttribute('aria-expanded', p.open ? 'true' : 'false'); } }, N.svg(ICON.chev));
      return el('div', { class: 'pb-top' }, el('span', { class: 'pb-ch' }, 'CH' + (p.ch + 1)), el('span', { class: 'pb-label mono', title: p.label }, p.label), extra, el('span', { class: 'grow' }), tog, pinBtn, rm);
    }
    decodeCard(p) {
      const root = el('div', { class: 'pb-card pb-dec' + (this.isOpen(p) ? '' : ' collapsed'), 'data-id': p.id, style: { '--c': p.color } });
      const vi = el('span', { class: 'pb-vi num' }), stats = el('div', { class: 'pb-stats num' }), bus = el('pre', { class: 'pb-bus' });
      root.append(this.cardTop(p, root, vi), stats, bus);
      return { root, vi, stats, bus, p };
    }
    probeCard(p) {
      const L = this.L;
      if (p.kind === 'decode') return this.decodeCard(p);
      const pr = p.ref && (L.procs || []).find(q => q.ref === p.ref);
      const isIO = pr && pr.io.some(x => x.number === p.pin);
      const root = el('div', { class: 'pb-card' + (this.isOpen(p) ? '' : ' collapsed'), 'data-id': p.id, style: { '--c': p.color } });
      const v = el('b', { class: 'pb-v num' }), logic = el('span', { class: 'pb-logic' }), stats = el('div', { class: 'pb-stats num' }), cur = el('div', { class: 'pb-cur num' });
      const drive = el('div', { class: 'pb-drive' }), conn = el('div', { class: 'pb-conn' }), bus = el('pre', { class: 'pb-bus', hidden: true });
      const vi = el('span', { class: 'pb-vi num' });
      root.append(this.cardTop(p, root, vi),
        el('div', { class: 'pb-main' }, v, logic), stats, cur, drive, conn, bus);
      let force = null;
      if (isIO) {
        force = el('div', { class: 'pb-force' }, el('span', { class: 'muted small' }, 'Drive by hand:'), MODE_BTN.map(([m, t]) => el('button', { class: 'lb tiny', type: 'button', 'data-m': m, onclick: () => L.forcePin(p.ref, p.pin, m) }, t)));
        root.append(force);
      }
      return { root, v, logic, stats, cur, drive, conn, bus, force, vi, p };
    }
    updateProbes(full) {
      const L = this.L, f = fmt();
      if (!this.cards) return;
      for (const [, c] of this.cards) {
        const p = c.p, st = p.stats || {};
        if (p.kind === 'decode') {
          c.vi.textContent = st.n ? `${st.n} in view` : '';
          if (full || (this.frame % 3) === 0) {
            const rate = st.rate > 0 ? (st.rate >= 1 ? `${st.rate >= 100 ? Math.round(st.rate) : st.rate.toFixed(1)} per second` : `${st.n} in ${f.T(L.scopeSpan())}`) : '';
            c.stats.textContent = !st.live ? `Nothing yet: run a program on ${p.proc} (Code) and its ${p.bus === 'uart' ? 'serial output' : p.bus.toUpperCase() + ' transfers'} show here and on the scope.` : [rate, st.bad ? `${st.bad} not acknowledged` : ''].filter(Boolean).join(' · ') || 'No transfers in the scope window.';
            const ev = L.decodeEvents(p, -Infinity, Infinity).slice(-8);
            c.bus.textContent = ev.length ? ev.map(x => `${f.T(x.t).padStart(9)}  ${x.text}`).join('\n') : '';
            c.bus.hidden = !ev.length;
          }
          continue;
        }
        const vtxt = st.float ? 'floating' : st.idle ? 'not driven here' : p.gnd ? '0 V (ground)' : f.V(st.v || 0);
        c.v.textContent = vtxt;
        c.vi.textContent = st.float ? 'float' : st.idle ? 'idle' : f.V(st.v || 0) + (st.freq ? ' · ' + f.Hz(st.freq) : '');
        c.logic.textContent = st.float || st.idle ? '' : st.logic || '';
        c.logic.className = 'pb-logic ' + (st.logic || '').toLowerCase();
        const bits = [];
        if (st.n > 2 && st.pp > 0.02) bits.push(`${f.V(st.min)} … ${f.V(st.max)}`, `avg ${f.V(st.avg)}`);
        if (st.freq) bits.push(f.Hz(st.freq), `duty ${Math.round(st.duty * 100)}%`);
        c.stats.textContent = bits.join(' · ');
        c.cur.textContent = st.i != null && Math.abs(st.i) > 1e-9 ? `${f.A(Math.abs(st.i))} ${p.ref ? (st.i > 0 ? 'into ' : 'out of ') + p.ref + '.' + p.pin : 'along the trace'}` : '';
        if (full || (this.frame % 3) === 0) {
          const ex = L.explain(p.name);
          if (ex) {
            const lines = ex.floating ? [el('div', { class: 'pb-d' + (ex.idle ? '' : ' flt') }, ex.why ? ex.why.replace(/^./, ch => ch.toUpperCase()) + '.' : 'Nothing drives this net.')] : ex.items.slice(0, 4).map(x => el('div', { class: 'pb-d' }, el('span', null, x.text), x.i != null ? el('span', { class: 'num muted' }, (x.i > 0 ? '→ ' : '← ') + f.A(Math.abs(x.i))) : null));
            c.drive.replaceChildren(...(lines.length ? [el('span', { class: 'pb-dk' }, ex.floating ? (ex.idle ? 'Not driven here' : 'Floating') : 'Driven by')].concat(lines) : []));
            if (full) c.conn.textContent = ex.pins.length ? 'On this net: ' + ex.pins.join(', ') : '';
          }
          if (c.force) { const k = p.ref + '\u0000' + p.pin; const m = L.forced.get(k); for (const b of c.force.querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === m); }
          // bus traffic on this net
          const log = this.busLog(p);
          c.bus.hidden = !log;
          if (log) c.bus.textContent = log;
        }
      }
      if (this.railRows) for (const { r, row } of this.railRows) {
        const v = L.netV[r.i], vv = v === v ? v : 0;
        const fl = L.netFloating(r.i);
        row.querySelector('.pr-dot').style.background = fl ? N.liveFloatColor() : N.liveColor(vv, L.vmax, 'dark');
        row.querySelector('b').textContent = fl ? 'float' : f.V(vv);
        const ok = r.nom == null ? (/VBUS/i.test(r.name.split('/').pop()) && vv < 0.5 ? false : null) : Math.abs(vv - r.nom) <= 0.06 * Math.abs(r.nom) + 0.05;
        const s = row.querySelector('.pr-ok');
        s.textContent = ok == null ? '' : ok ? '✓' : '!';
        s.className = 'pr-ok ' + (ok == null ? '' : ok ? 'good' : 'bad');
        if (full || (this.frame % 8) === 0) row.querySelector('.pr-why').textContent = ok === false ? L.railReason(r.name) || (r.nom != null ? `expected ${r.nom} V` : 'no voltage') : '';
        row.title = `${r.name}: ${f.V(vv)}${r.nom != null ? ' (nominal ' + r.nom + ' V)' : r.guess != null ? ' (usually about ' + r.guess + ' V)' : ''}`;
      }
      this.drawScope();
    }
    busLog(p) {
      const L = this.L;
      if (!L.fwm) return '';
      const hx = b => b.toString(16).padStart(2, '0').toUpperCase();
      for (const pr of L.fwm.procs.values()) {
        if (!pr.hw) continue;
        for (const b of pr.hw.i2c) {
          if (b.sdaIo.net !== p.name && b.sclIo.net !== p.name) continue;
          const lg = (b.wire.log || []).slice(-6);
          if (!lg.length) return `I2C (${pr.ref}): no traffic yet`;
          return `I2C (${pr.ref}), last transfers:\n` + lg.map(x => `0x${hx(x.addr)} ${x.write && x.write.length ? 'W ' + x.write.slice(0, 8).map(hx).join(' ') : ''}${x.read && x.read.length ? ' R ' + x.read.slice(0, 8).map(hx).join(' ') : ''}${x.ack === false || x.nack ? '  NACK' : ''}`).join('\n');
        }
        for (const b of pr.hw.spi) {
          const io = pr.info.io.find(x => x.number === b.sck), mo = pr.info.io.find(x => x.number === b.mosi);
          if (!(io && io.net === p.name) && !(mo && mo.net === p.name)) continue;
          const lg = (b.spi.log || []).slice(-5);
          if (!lg.length) return `SPI (${pr.ref}): no traffic yet`;
          return `SPI (${pr.ref}), last transfers:\n` + lg.map(x => `CS ${x.cs}: ${(x.out || []).slice(0, 10).map(hx).join(' ')}${x.n > 10 ? ' … ' + x.n + ' bytes' : ''}`).join('\n');
        }
      }
      return '';
    }
    drawScope() {
      const L = this.L, cv = this.scope, f = fmt();
      if (!cv || !cv.isConnected) return;
      const e = L.engine;
      const P = L.probes, lanes = this.lanesOn();
      const ana = P.filter(p => p.kind !== 'decode'), dec = P.filter(p => p.kind === 'decode');
      const LANE = 30, DLANE = 24, AX = 16;
      // overlay: the analog traces share one axis (decoders below); lanes: every signal on its own scale
      const overH = lanes || !ana.length ? 0 : 150 - AX;
      const H = lanes ? Math.max(96, ana.length * LANE + dec.length * DLANE + AX + 4) : Math.max(150, overH + dec.length * DLANE + AX + 4);
      if (cv.style.height !== H + 'px') cv.style.height = H + 'px';
      const w = cv.clientWidth || 300, h = H, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#060909'; g.fillRect(0, 0, w, h);
      if (!e) return;
      const mono = N.cssVar('--font-mono') || 'monospace';
      const span = L.scopeSpan();
      let t1 = e.t, t0 = t1 - span;
      // trigger on the first analog channel's rising edges through the middle of its range
      const ch1 = ana[0];
      if (this.trigger && ch1 && ch1.stats && ch1.stats.freq && ch1.stats.pp > 0.2) {
        const mid = (ch1.stats.max + ch1.stats.min) / 2;
        const [T, V] = L.probeSeries(ch1, e.t - Math.min(4, span * 4));
        for (let i = V.length - 1; i > 0; i--) { if (T[i] > e.t - span * 0.9) continue; if (V[i - 1] <= mid && V[i] > mid) { t0 = T[i] - span * 0.1; t1 = t0 + span; break; } }
      }
      const GUT = lanes || dec.length ? 78 : 34, X0 = GUT, X1 = w - 2;
      const X = t => X0 + ((t - t0) / (t1 - t0)) * (X1 - X0);
      const series = new Map(ana.map(p => [p, L.probeSeries(p, t0)]));
      const cx = this.cursor != null && this.cursor >= X0 && this.cursor <= X1 ? this.cursor : null;
      const tc = cx != null ? t0 + (cx - X0) / (X1 - X0) * (t1 - t0) : null;
      const valueAt = (T, V, t) => { let lo = 0, hi = T.length - 1; if (hi < 0) return null; if (t <= T[0]) return V[0]; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; } return T[hi] <= t ? V[hi] : V[lo]; };
      const plotH = (lanes ? ana.length * LANE : overH) + dec.length * DLANE;
      // grid
      g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
      for (let k = 0; k <= 10; k++) { const x = Math.round(X0 + (X1 - X0) * k / 10) + 0.5; g.beginPath(); g.moveTo(x, 4); g.lineTo(x, 4 + plotH); g.stroke(); }
      g.font = '10px ' + mono;
      const trace = (p, T, V, Y) => {
        if (!T.length) return;
        g.strokeStyle = p.color; g.lineWidth = 1.5;
        g.beginPath();
        const step = Math.max(1, Math.floor(T.length / (w * 1.5)));
        for (let i = 0; i < T.length; i += step) { const x = X(T[i]), y = Y(V[i]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
        const k = T.length - 1; if (k % step) g.lineTo(X(T[k]), Y(V[k]));
        g.stroke();
      };
      let y = 4;
      if (!lanes && ana.length) {
        let lo = 0, hi = 0.5;
        for (const [, [, V]] of series) for (const v of V) { if (v < lo) lo = v; if (v > hi) hi = v; }
        const pad = (hi - lo) * 0.08 || 0.1; hi += pad; if (lo < 0) lo -= pad;
        const Y = v => y + 2 + (1 - (v - lo) / (hi - lo)) * (overH - 4);
        g.strokeStyle = 'rgba(255,255,255,0.07)';
        for (let k = 0; k <= 4; k++) { const yy = Math.round(y + (overH) * k / 4) + 0.5; g.beginPath(); g.moveTo(X0, yy); g.lineTo(X1, yy); g.stroke(); }
        if (lo < 0 && hi > 0) { g.strokeStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.moveTo(X0, Y(0)); g.lineTo(X1, Y(0)); g.stroke(); }
        g.fillStyle = 'rgba(220,228,224,0.6)'; g.textAlign = 'right';
        g.fillText(hi.toFixed(hi >= 10 ? 0 : 1), GUT - 4, y + 8); g.fillText(lo.toFixed(Math.abs(lo) >= 10 ? 0 : 1), GUT - 4, y + overH - 2); g.fillText('V', GUT - 4, y + overH / 2 + 4);
        for (const p of ana) { const [T, V] = series.get(p); trace(p, T, V, Y); }
        if (tc != null) {
          let k = 0;
          for (const p of ana) { const [T, V] = series.get(p); const v = valueAt(T, V, tc); if (v == null) continue; const yy = Y(v); g.fillStyle = p.color; g.beginPath(); g.arc(cx, yy, 2.6, 0, 7); g.fill(); this.tag(g, cx, y + 10 + k * 13, f.V(v), p.color, X1); k++; }
        }
        y += overH;
      }
      const order = lanes ? P : dec;
      for (const p of order) {
        if (p.kind === 'decode') { y = this.decodeLane(g, p, y, DLANE, GUT, X, X0, X1, t0, t1, tc, cx, mono); continue; }
        const [T, V] = series.get(p), st = p.stats || {};
        let lo = Infinity, hi = -Infinity;
        for (const v of V) { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (!(hi >= lo)) { lo = 0; hi = 1; }
        if (hi - lo < 0.05) { const m = (hi + lo) / 2; lo = Math.min(0, m - 0.5); hi = Math.max(m + 0.5, lo + 1); }
        else { const pd = (hi - lo) * 0.14; lo -= pd; hi += pd; }
        const Y = v => y + 3 + (1 - (v - lo) / (hi - lo)) * (LANE - 7);
        const hiZ = (st.float || st.idle) && st.pp < 0.05, zc = st.idle ? N.livePalette('dark')[253] : N.liveFloatColor();
        this.laneLabel(g, p, y, LANE, GUT, st.float ? 'float' : st.idle ? 'idle' : f.V(st.v || 0), mono);
        if (hiZ) {
          // nothing drives the net: a dashed mid-level line, as a logic analyser shows Z
          g.strokeStyle = zc; g.lineWidth = 1.5; g.setLineDash([4, 3]);
          g.beginPath(); g.moveTo(X0, y + LANE / 2); g.lineTo(X1, y + LANE / 2); g.stroke(); g.setLineDash([]);
        } else trace(p, T, V, Y);
        if (tc != null) { const v = valueAt(T, V, tc); if (v != null) { g.fillStyle = hiZ ? zc : p.color; g.beginPath(); g.arc(cx, hiZ ? y + LANE / 2 : Y(v), 2.4, 0, 7); g.fill(); this.tag(g, cx, y + LANE / 2 + 4, hiZ ? (st.idle ? 'not driven' : 'floating') : f.V(v), p.color, X1); } }
        g.strokeStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.moveTo(0, y + LANE - 0.5); g.lineTo(w, y + LANE - 0.5); g.stroke();
        y += LANE;
      }
      // time axis and the cursor
      const dv = span / 10, dvt = dv >= 1 ? +dv.toPrecision(2) + ' s' : dv >= 1e-3 ? +(dv * 1e3).toPrecision(2) + ' ms' : dv >= 1e-6 ? +(dv * 1e6).toPrecision(2) + ' µs' : +(dv * 1e9).toPrecision(2) + ' ns';
      g.fillStyle = 'rgba(220,228,224,0.6)'; g.font = '10px ' + mono; g.textBaseline = 'alphabetic';
      g.textAlign = 'left'; g.fillText(dvt + '/div', X0 + 2, h - 4);
      if (tc != null) {
        g.strokeStyle = 'rgba(255,255,255,0.55)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(cx + 0.5, 4); g.lineTo(cx + 0.5, 4 + plotH); g.stroke(); g.setLineDash([]);
        g.textAlign = 'right'; g.fillStyle = 'rgba(233,242,238,0.9)'; g.fillText(`t = ${f.T(tc)}  (−${f.T(Math.max(0, t1 - tc))})`, X1, h - 4);
      } else if (P.length) { g.textAlign = 'right'; g.fillStyle = 'rgba(220,228,224,0.4)'; g.fillText('hover to read every signal', X1, h - 4); }
      if (!P.length) { g.fillStyle = 'rgba(220,228,224,0.35)'; g.textAlign = 'center'; g.fillText('select a trace or pin, then Probe it', w / 2, h / 2); }
    }
    decodeLane(g, p, y, DLANE, GUT, X, X0, X1, t0, t1, tc, cx, mono) {
      const L = this.L, ev = L.decodeEvents(p, t0, t1), st = p.stats || {};
      this.laneLabel(g, p, y, DLANE, GUT, st.live ? `${ev.length} in view` : 'idle', mono, true);
      g.save(); g.beginPath(); g.rect(X0, y, X1 - X0, DLANE); g.clip();
      let lastX = -1e9, hit = null;
      g.font = '10px ' + mono; g.textBaseline = 'middle'; g.textAlign = 'left';
      for (const x of ev) {
        const a = X(x.t), b = Math.max(a + 3, X(x.t + x.dur));
        if (b < X0 || a > X1) continue;
        g.fillStyle = x.bad ? 'rgba(255,92,77,0.35)' : this.alpha(p.color, 0.22);
        g.strokeStyle = x.bad ? '#ff5c4d' : p.color; g.lineWidth = 1;
        const r = Math.min(4, (b - a) / 2);
        g.beginPath(); g.moveTo(a + r, y + 4); g.lineTo(b - r, y + 4); g.lineTo(b, y + DLANE / 2); g.lineTo(b - r, y + DLANE - 4); g.lineTo(a + r, y + DLANE - 4); g.lineTo(a, y + DLANE / 2); g.closePath(); g.fill(); g.stroke();
        // the text inside the box when it fits, else after it while the lane is free
        const tw = g.measureText(x.text).width;
        if (b - a > tw + 10) { g.fillStyle = '#e9f2ee'; g.fillText(x.text, a + 5, y + DLANE / 2 + 0.5); lastX = b; }
        else if (a > lastX + 4) { const room = Math.max(0, Math.min(tw, X1 - b - 4)); if (room > 24) { g.fillStyle = 'rgba(233,242,238,0.8)'; g.fillText(this.fit(g, x.text, room), b + 3, y + DLANE / 2 + 0.5); } lastX = b + 3 + room; }
        if (tc != null && tc >= x.t - (t1 - t0) * 2 / (X1 - X0) && tc <= x.t + Math.max(x.dur, (t1 - t0) * 3 / (X1 - X0))) hit = x;
      }
      g.restore();
      if (hit) this.tag(g, cx, y + DLANE / 2 + 4, hit.text, p.color, X1);
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.moveTo(0, y + DLANE - 0.5); g.lineTo(g.canvas.width, y + DLANE - 0.5); g.stroke();
      return y + DLANE;
    }
    // text cut to a width with an ellipsis
    fit(g, text, w) {
      if (g.measureText(text).width <= w) return text;
      let lo = 0, hi = text.length;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (g.measureText(text.slice(0, m) + '…').width <= w) lo = m; else hi = m; }
      return text.slice(0, lo) + '…';
    }
    laneLabel(g, p, y, lh, gut, val, mono, dec) {
      g.fillStyle = p.color; g.fillRect(2, y + 3, 3, lh - 6);
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.font = '700 10px ' + mono; g.fillText(String(p.ch + 1), 8, y + 12);
      g.font = '10px ' + mono; g.fillStyle = 'rgba(225,233,229,0.85)';
      const lab = p.kind === 'decode' ? ({ i2c: 'I2C', spi: 'SPI', uart: 'Serial' }[p.bus] || p.bus) : p.ref ? (p.pinName || p.pin) : p.label;
      g.fillText(this.fit(g, lab, gut - 26), 22, y + 12);
      g.fillStyle = 'rgba(160,176,168,0.85)'; g.fillText(this.fit(g, val, gut - 12), 8, y + Math.min(lh - 4, 24));
      if (!dec) { g.strokeStyle = 'rgba(255,255,255,0.05)'; g.beginPath(); g.moveTo(gut - 0.5, y); g.lineTo(gut - 0.5, y + lh); g.stroke(); }
    }
    // a small value tag next to the cursor (flips left near the right edge)
    tag(g, x, y, text, col, xmax) {
      g.font = '10px ' + (N.cssVar('--font-mono') || 'monospace'); g.textBaseline = 'alphabetic';
      const tw = Math.min(g.measureText(text).width, 200) + 8, left = x + 6 + tw > xmax;
      const x0 = left ? x - 6 - tw : x + 6;
      g.fillStyle = 'rgba(6,9,9,0.85)'; g.fillRect(x0, y - 10, tw, 13);
      g.strokeStyle = col; g.lineWidth = 1; g.strokeRect(x0 + 0.5, y - 9.5, tw - 1, 12);
      g.fillStyle = '#eef5f1'; g.textAlign = 'left'; g.fillText(text, x0 + 4, y, 200);
    }
    alpha(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }

    // ================================================================ Code
    buildCode(body) {
      const L = this.L, self = this;
      const procs = L.procs || [];
      let cur = procs.find(p => p.ref === this.codeRef) || procs[0];
      const running0 = cur && L.fwm.get(cur.ref);
      let tab = this.codeTab && this.codeTab.ref === (cur && cur.ref) ? this.codeTab.tab : running0 && running0.kind === 'firmware' ? 'firmware' : 'program';
      const root = el('div', { class: 'cd' });
      const sel = el('select', { class: 'lb-sel cd-sel', 'aria-label': 'Processor' }, procs.map(p => el('option', { value: p.ref, selected: p === cur || null }, `${p.ref} · ${p.chip ? p.chip.name : p.value}`)));
      sel.addEventListener('change', () => { cur = procs.find(p => p.ref === sel.value) || procs[0]; this.codeRef = cur.ref; const r = L.fwm.get(cur.ref); tab = r && r.kind === 'firmware' ? 'firmware' : 'program'; render(); L.ctx.onSelect([cur.ref], []); });
      const sub = el('div', { class: 'cd-sub' });
      const tabs = el('div', { class: 'cd-tabs', role: 'tablist' });
      const pane = el('div', { class: 'cd-pane' });
      const status = el('div', { class: 'cd-status' });
      const pins = el('div', { class: 'cd-pins' });
      const conOut = el('pre', { class: 'cd-console', 'aria-label': 'Serial console', tabindex: '0' });
      const conIn = el('input', { class: 'cd-in', type: 'text', placeholder: 'Send to the serial port and press Enter', 'aria-label': 'Serial input' });
      conIn.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        const p = L.fwm.get(cur.ref);
        const txt = conIn.value + '\n';
        conIn.value = '';
        if (!p) return;
        const bytes = [...txt].map(ch => ch.charCodeAt(0) & 255);
        L.fwm.feed(p, bytes);
        p.console.write('› ' + txt);
      });
      const conHead = el('div', { class: 'cd-conhead' }, el('span', null, 'Serial'), el('span', { class: 'grow' }), el('button', { class: 'lb tiny', type: 'button', onclick: () => { const p = L.fwm.get(cur.ref); if (p) p.console.clear(); else conOut.textContent = ''; } }, 'Clear'));
      root.append(el('div', { class: 'cd-head' }, N.svg(I.chip), sel), sub, tabs, pane, status, pins, el('div', { class: 'cd-con' }, conHead, conOut, conIn));
      body.append(root);
      const emuFam = p => ['rp2040', 'avr', 'arm', 'riscv'].includes(p.family);
      function render() {
        const p = cur;
        if (!p) { root.replaceChildren(el('p', { class: 'muted' }, 'No processors on this board.')); return; }
        self.codeTab = { ref: p.ref, tab };
        self.codeRef = p.ref;
        const chip = p.chip;
        const emu = emuFam(p);
        sub.replaceChildren(
          el('span', { class: 'cd-kind' }, p.kind),
          el('span', null, `${chip ? chip.core + (chip.clockHz ? ' · ' + Math.round(chip.clockHz / 1e6) + ' MHz' : '') : p.value} · ${p.io.length} IO${p.vnom ? ' at ' + p.vnom + ' V' : ''}`),
          el('span', { class: 'cd-tag' + (emu ? ' emu' : '') }, emu ? N.fw.emuName(p) + ' · real firmware' : 'Arduino-style programs'));
        tabs.replaceChildren(...[['program', 'Program'], emu ? ['firmware', 'Firmware file'] : null].filter(Boolean).map(([id, label]) =>
          el('button', { class: 'cd-tab' + (tab === id ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': tab === id ? 'true' : 'false', onclick: () => { tab = id; render(); } }, label)));
        pane.replaceChildren(tab === 'program' ? programTab(p) : firmwareTab(p));
        bindConsole();
        refresh();
      }
      const codeKey = ref => 'code:' + ((L.B && L.B.data && L.B.data.key) || 'board') + ':' + ref;
      let ed = null;
      function runProgram(p, src) {
        store.set(codeKey(p.ref), src);
        const pr = L.fwm.runScript(p, src);
        if (!L.running) { L.running = true; L.last = performance.now(); }
        if (pr.state === 'error') N.toast(pr.error, 'warn'); else L.realTime();
        return pr;
      }
      function programTab(p) {
        const a = L.analysisFor(p);
        let text = store.get(codeKey(p.ref), null);
        if (!text) text = a ? N.analysis.program(a) : N.fw.starter(L.base.circuit, p).text;
        ed = el('textarea', { class: 'cd-ed', spellcheck: 'false', 'aria-label': 'Program for ' + p.ref, wrap: 'off' });
        ed.value = text;
        ed.addEventListener('input', () => store.set(codeKey(p.ref), ed.value));
        ed.addEventListener('keydown', e => {
          if (e.key === 'Tab') { e.preventDefault(); const s0 = ed.selectionStart; ed.setRangeText('  ', s0, ed.selectionEnd, 'end'); store.set(codeKey(p.ref), ed.value); }
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runProgram(p, ed.value); }
        });
        const running = L.fwm.get(p.ref);
        const bar = el('div', { class: 'cd-bar' },
          el('button', { class: 'lb lb-run', type: 'button', title: 'Run (Ctrl+Enter)', onclick: () => runProgram(p, ed.value) }, N.svg(ICON.play), running && running.kind === 'script' ? 'Restart' : 'Run'),
          el('button', { class: 'lb', type: 'button', disabled: !running || null, onclick: () => { L.fwm.stop(p.ref); render(); } }, 'Stop'),
          el('span', { class: 'grow' }),
          el('button', { class: 'lb', type: 'button', title: 'Replace with the program written from this board\'s netlist (Ctrl+Z in the editor undoes it)', onclick: () => { if (!a) return; ed.focus(); ed.select(); document.execCommand && document.execCommand('insertText', false, N.analysis.program(a)) || (ed.value = N.analysis.program(a)); store.set(codeKey(p.ref), ed.value); } }, N.svg(ICON.board), 'Auto program'));
        return el('div', { class: 'cd-prog' }, bar, ed);
      }
      function firmwareTab(p) {
        const wrap = el('div', { class: 'cd-fw' });
        const fam = p.family;
        const draw = () => {
          const ex = N.fw.exampleFor(p);
          const file = el('input', { type: 'file', accept: '.uf2,.hex,.bin,.elf', hidden: true });
          const runBytes = async (bytes, name) => {
            try {
              await L.fwm.runImage(p, bytes, name);
              if (!L.running) { L.running = true; L.last = performance.now(); }
              N.toast(`${p.ref} is running ${name}`);
              L.realTime();
            } catch (e) { N.toast('Could not run that firmware: ' + (e.message || e), 'warn'); }
            render();
          };
          file.addEventListener('change', async () => { const f = file.files[0]; if (f) runBytes(new Uint8Array(await f.arrayBuffer()), f.name); file.value = ''; });
          const hint = { rp2040: '.uf2 from the Pico SDK, Arduino-Pico, MicroPython or CircuitPython; .hex, .elf or .bin', avr: '.hex from the Arduino IDE (Sketch → Export compiled binary) or avr-gcc; .bin', arm: '.elf, .hex, .bin or .uf2 (STM32CubeIDE, PlatformIO, Arduino, Zephyr, Pico SDK …)', riscv: '.elf, .hex or .bin (MounRiver, ch32fun, GD32 firmware library, Pico SDK; ESP32 chips: bare-metal only)' }[fam] || '';
          const drop = el('div', { class: 'cd-drop', tabindex: '0', role: 'button', onclick: () => file.click(), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } } },
            N.svg(I.upload), el('b', null, 'Drop a compiled firmware file'), el('span', null, hint));
          drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
          drop.addEventListener('dragleave', () => drop.classList.remove('over'));
          drop.addEventListener('drop', async e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) runBytes(new Uint8Array(await f.arrayBuffer()), f.name); });
          const running = L.fwm.get(p.ref);
          const srcBox = el('pre', { class: 'cd-src', hidden: true }, ex ? ex.src() : '');
          const notes = running && running.notes ? running.notes() : [];
          wrap.replaceChildren(drop, file,
            el('div', { class: 'cd-bar' },
              ex ? el('button', { class: 'lb lb-run', type: 'button', onclick: () => runBytes(ex.data(), ex.name) }, N.svg(ICON.play), 'Run the example') : null,
              running && running.kind === 'firmware' ? el('button', { class: 'lb', type: 'button', onclick: () => { running.start(L.engine.t); } }, 'Reset') : null,
              running ? el('button', { class: 'lb', type: 'button', onclick: () => { L.fwm.stop(p.ref); render(); } }, 'Stop') : null,
              el('span', { class: 'grow' }),
              ex ? el('button', { class: 'lb', type: 'button', onclick: () => { srcBox.hidden = !srcBox.hidden; } }, 'Example source') : null),
            ex ? el('p', { class: 'cd-hint' }, ex.label + '. The chip is emulated instruction by instruction and its pins drive the board; it starts once its supply is up.') : el('p', { class: 'cd-hint' }, 'Loading the emulator…'),
            notes.length ? el('p', { class: 'cd-hint muted' }, 'Emulator notes: ' + notes.join(' · ')) : null,
            srcBox);
        };
        if (N.fw.emuLoaded(fam)) draw();
        else { wrap.append(el('p', { class: 'cd-hint' }, 'Loading the emulator…')); N.fw.loadEmu(fam).then(draw, e => wrap.replaceChildren(el('p', { class: 'cd-hint' }, 'The emulator did not load: ' + e.message))); }
        return wrap;
      }
      function bindConsole() {
        const p = cur && L.fwm.get(cur.ref);
        if (self.conListener) { self.conListener.c.listeners.delete(self.conListener.f); self.conListener = null; }
        if (!p) { conOut.textContent = ''; return; }
        const f = () => { if (conOut.textContent.length !== p.console.text.length) { const stick = conOut.scrollTop + conOut.clientHeight >= conOut.scrollHeight - 8; conOut.textContent = p.console.text; if (stick) conOut.scrollTop = conOut.scrollHeight; } };
        p.console.listeners.add(f);
        self.conListener = { c: p.console, f };
        f();
      }
      function refresh() {
        if (!cur) return;
        const p = L.fwm.get(cur.ref);
        if (p && (!self.conListener || self.conListener.c !== p.console)) bindConsole();
        const st = !p ? ['idle', 'Not running. Its pins are inputs (high impedance), as after reset.'] : p.state === 'running' ? (p.brownout ? ['wait', 'Waiting for its supply to come up.'] : ['run', p.kind === 'firmware' ? `Running ${p.imageName}.` : 'Running your program.']) :
          p.state === 'error' ? ['err', p.error + (p.errorLine ? ` (around line ${p.errorLine})` : '')] : p.state === 'finished' ? ['idle', 'The program finished.'] : ['idle', 'Stopped.'];
        status.className = 'cd-status ' + st[0];
        status.replaceChildren(el('i'), el('span', null, st[1]));
        const ps = p ? p.pinsSummary() : [];
        pins.replaceChildren(...(ps.length ? [el('span', { class: 'muted' }, 'Driving:')].concat(ps.slice(0, 18).map(x => el('span', { class: 'cd-pin ' + x.mode.replace(/\W.*/g, '').toLowerCase() }, `${x.pin}${x.net && x.net !== x.pin ? ' · ' + x.net : ''} ${x.mode}`))) : []));
      }
      let lastRefresh = 0, timer = 0;
      render();
      return {
        refresh() { const now = performance.now(); if (now - lastRefresh < 120) { clearTimeout(timer); timer = setTimeout(() => { lastRefresh = performance.now(); refresh(); }, 130); return; } lastRefresh = now; refresh(); },
        select(ref) { cur = procs.find(p => p.ref === ref) || cur; render(); },
      };
    }

    // ================================================================ Board
    buildBoard(body) {
      const L = this.L, self = this;
      const procs = L.procs || [];
      let cur = procs.find(p => p.ref === this.boardRef) || procs[0];
      const root = el('div', { class: 'bd' });
      body.append(root);
      const partsBox = el('div', { class: 'bd-parts' }), partsHead = el('div', { class: 'bd-sec' }, 'Parts it talks to');
      function render() {
        const p = cur;
        const a = L.analysisFor(p);
        const sel = procs.length > 1 ? el('select', { class: 'lb-sel', 'aria-label': 'Processor' }, procs.map(q => el('option', { value: q.ref, selected: q === p || null }, `${q.ref} · ${q.chip ? q.chip.name : q.value}`))) : null;
        if (sel) sel.addEventListener('change', () => { cur = procs.find(q => q.ref === sel.value); self.boardRef = cur.ref; render(); });
        const lines = a ? N.analysis.describe(a) : [`${p.ref} (${p.value})`];
        const gen = el('button', { class: 'lb lb-run', type: 'button', title: 'Write a program that exercises everything found on this board and run it', onclick: () => {
          if (!a) return;
          const src = N.analysis.program(a);
          N.store.set('code:' + ((L.B && L.B.data && L.B.data.key) || 'board') + ':' + p.ref, src);
          const pr = L.fwm.runScript(p, src);
          if (!L.running) { L.running = true; L.last = performance.now(); }
          if (pr.state === 'error') N.toast(pr.error, 'warn'); else L.realTime();
          self.open('code', p.ref);
        } }, N.svg(ICON.play), 'Generate and run a program');
        // pins that do something first, one row each; pins that only go to a header, and free pins, one row per group
        const rows = [], groups = new Map(), free = [];
        if (a) for (const io of p.io) {
          const r = a.pins.get(io.number);
          const cap = io.cap || {};
          const tags = [cap.adc ? 'ADC' : '', cap.pwm || (cap.tim && cap.tim.length) ? 'PWM' : '', cap.inputOnly ? 'in only' : '', cap.strap ? 'strap' : '', cap.swd ? 'SWD' : '', cap.usb ? 'USB' : ''].filter(Boolean);
          if (!r && !tags.length) continue;
          if (r && r.role === 'header') { const g = groups.get(r.text) || []; g.push(io); groups.set(r.text, g); continue; }
          if (!r) { free.push(io); continue; }
          rows.push(el('div', { class: 'bd-pin' },
            el('span', { class: 'mono bd-pn' }, N.fw.shortPin(io)),
            el('span', { class: 'bd-role' }, r.text),
            el('span', { class: 'bd-tags' }, tags.map(t => el('i', null, t)))));
        }
        const grpRow = (label, ios, cls) => el('div', { class: 'bd-pin grp' + (cls ? ' ' + cls : '') },
          el('span', { class: 'mono bd-pn' }, ios.length + (ios.length > 1 ? ' pins' : ' pin')),
          el('span', { class: 'bd-role' }, el('span', null, label), el('span', { class: 'mono bd-list' }, ios.map(io => N.fw.shortPin(io)).join(' · '))), el('span'));
        for (const [txt, ios] of groups) rows.push(grpRow(txt.replace(/^to /, 'go to '), ios));
        if (free.length) rows.push(grpRow('free', free, 'free'));
        const env = envBox(a);
        partsHead.hidden = true;
        root.replaceChildren(...[
          sel ? el('div', { class: 'bd-sel' }, sel) : null,
          el('div', { class: 'bd-sec' }, 'What this board does'),
          el('div', { class: 'bd-desc' }, lines.map(t => el('p', null, t))),
          el('div', { class: 'cd-bar' }, gen),
          partsHead, partsBox,
          env ? el('div', { class: 'bd-sec', title: 'What the sensors on this board measure. Move a slider and a running program reads the new value.' }, 'What its sensors measure') : null, env,
          rows.length ? el('div', { class: 'bd-sec' }, 'Pins') : null,
          rows.length ? el('div', { class: 'bd-pins' }, rows) : null,
          p.chip && (p.chip.notes || []).length ? el('div', { class: 'bd-sec' }, 'Chip notes') : null,
          p.chip && (p.chip.notes || []).length ? el('ul', { class: 'bd-notes' }, p.chip.notes.slice(0, 6).map(n => el('li', null, n))) : null].filter(Boolean));
        refreshParts();
      }
      function refreshParts() {
        const p = cur;
        const a = L.analysisFor(p);
        const run = L.fwm && L.fwm.get(p.ref);
        const live = new Map();
        if (run && run.hw) for (const d of run.hw.devs) { try { live.set(d.ref, d.status ? d.status() : ''); } catch (e) { /* ignore */ } }
        const items = [];
        if (a) {
          for (const b of a.i2c) for (const d of b.devices) items.push([d.ref, `${d.spec.name} · I2C 0x${d.address.toString(16)}`, live.get(d.ref)]);
          for (const b of a.spi) for (const d of b.devices) items.push([d.ref, `${d.spec.name} · SPI`, live.get(d.ref)]);
          for (const c of a.chains) items.push([c.leds[0], `${c.leds.length}× ${c.part || c.type} addressable LEDs`, '']);
          if (a.eth && a.eth.phy) items.push([a.eth.phy.ref, `${a.eth.phy.value || 'PHY'} · Ethernet`, '']);
          for (const u of a.uarts) { const m = /^(?:connector |USB serial bridge )?(\S+)(?: \((.*)\))?$/.exec(u.peer || ''); if (m && !items.some(x => x[0] === m[1])) items.push([m[1], `${/^connector/.test(u.peer) ? 'connector' : m[2] || 'chip'} · UART`, '']); }
        }
        const key = items.map(x => x.join('|')).join('\n') + '|' + !!run;
        if (key === partsBox._key) return;
        partsBox._key = key;
        // nothing on a bus: no section at all
        partsHead.hidden = !items.length;
        partsBox.replaceChildren(...items.map(([ref, what, st]) => el('button', { class: 'bd-part', type: 'button', title: 'Select ' + ref, onclick: () => L.ctx.onSelect([ref], []) }, el('b', { class: 'mono' }, ref), el('span', null, what), st ? el('span', { class: 'bd-st mono' }, st) : null)));
        if (!run && items.some(x => / · (I2C|SPI)/.test(x[1]))) partsBox.append(el('p', { class: 'muted small' }, 'Run a program to bring these parts to life: they answer on their bus with realistic readings.'));
      }
      // only the quantities the parts on this board can sense (no sliders for sensors it does not have)
      function envBox(a) {
        const W = L.fwm ? L.fwm.world() : {};
        const ids = a ? [...a.i2c.flatMap(b => b.devices), ...a.spi.flatMap(b => b.devices)].map(d => (d.spec.id || '') + ' ' + (d.spec.name || '')).join(' ').toLowerCase() : '';
        const has = re => re.test(ids);
        const want = {
          t: has(/\b(bme|bmp|sht|aht|tmp1|lm75|hdc|si70|htu|mcp98|ds18|adt7|stts|max318|emc2|xgzp|icm|bno|bmi|lis3|lsm|mpu)/),
          h: has(/\b(bme2|bme6|sht|aht|hdc|si70|htu)/),
          p: has(/\b(bme|bmp|lps|ms56|dps3|spl0)/),
          l: has(/\b(bh1750|veml|tsl2|opt3|ltr|apds|max4400)/),
          b: has(/\b(max1704|bq27|bq25|bq24|bq769|lc709)/),
          a: has(/\b(icm|bno|lis3|bmi|mpu|lsm|adxl|bma|mma|kx)/),
          k: has(/\b(as5[06]|mt67|tle5|ma7)/),
        };
        if (!Object.values(want).some(Boolean)) return null;
        const sl = (key, label, min, max, step, unit, get, set) => {
          const out = el('b', { class: 'num' });
          const r = el('input', { type: 'range', min, max, step, value: get(), 'aria-label': label });
          const upd = () => { out.textContent = (+r.value).toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0) + ' ' + unit; };
          r.addEventListener('input', () => { set(+r.value); upd(); });
          upd();
          return el('label', { class: 'bd-env-row' }, el('span', null, label), r, out);
        };
        return el('div', { class: 'bd-env' }, [
          want.t && sl('t', 'Temperature', -20, 60, 0.5, '°C', () => W.tempC, v => { W.tempC = v; }),
          want.h && sl('h', 'Humidity', 0, 100, 1, '%', () => W.humidity, v => { W.humidity = v; }),
          want.p && sl('p', 'Pressure', 900, 1100, 1, 'hPa', () => W.pressurePa / 100, v => { W.pressurePa = v * 100; }),
          want.l && sl('l', 'Light', 0, 2000, 10, 'lx', () => W.lux, v => { W.lux = v; }),
          want.b && sl('b', 'Battery', 3.0, 4.3, 0.01, 'V', () => W.batteryV || 3.9, v => { W.batteryV = v; }),
          want.a && sl('a', 'Tilt', -90, 90, 1, '°', () => Math.round(Math.asin(Math.max(-1, Math.min(1, (W.accel || [0, 0, 9.81])[0] / 9.81))) * 180 / Math.PI), v => { const r = v * Math.PI / 180; W.accel = [9.81 * Math.sin(r), 0, 9.81 * Math.cos(r)]; }),
          want.k && sl('k', 'Knob angle', 0, 359, 1, '°', () => W.angleDeg || 0, v => { W.angleDeg = v; })].filter(Boolean));
      }
      render();
      return { refreshParts };
    }

    // ---------------------------------------------------------------- menus
    controlsMenu(btn) {
      const L = this.L, e = L.engine;
      const node = el('div', { class: 'ld-controls' });
      const sup = e.supplies();
      if (sup.length) node.append(el('div', { class: 'menu-head' }, 'Supplies'));
      for (const s of sup) {
        const inp = el('input', { class: 'input small', type: 'number', step: '0.1', value: s.value, 'aria-label': s.net + ' voltage' });
        inp.addEventListener('change', () => { e.setSupply(s.net, +inp.value); });
        node.append(el('label', { class: 'ld-ctl' }, el('span', { class: 'mono' }, N.fmt.shortNet(s.net)), inp, 'V'));
      }
      const sws = e.switches();
      if (sws.length) node.append(el('div', { class: 'menu-head' }, 'Switches and buttons'));
      for (const s of sws) {
        const b = el('button', { class: 'btn tiny' + (s.closed ? ' primary' : '') }, s.closed ? 'closed' : 'open');
        b.addEventListener('click', () => { e.setSwitch(s.ref, !s.closed); s.closed = !s.closed; b.textContent = s.closed ? 'closed' : 'open'; b.classList.toggle('primary', s.closed); });
        node.append(el('label', { class: 'ld-ctl' }, el('span', { class: 'mono' }, s.ref), b));
      }
      const pots = e.pots();
      if (pots.length) node.append(el('div', { class: 'menu-head' }, 'Potentiometers'));
      for (const p of pots) {
        const r = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: p.frac, 'aria-label': p.ref + ' position' });
        r.addEventListener('input', () => e.setPot(p.ref, +r.value));
        node.append(el('label', { class: 'ld-ctl' }, el('span', { class: 'mono' }, p.ref), r));
      }
      if (!sup.length && !sws.length && !pots.length) node.append(el('p', { class: 'muted small', style: { margin: '6px 10px' } }, 'No supplies, switches or potentiometers to change.'));
      node.append(el('p', { class: 'muted small', style: { margin: '8px 10px 2px' } }, 'Tip: click a switch or button on the board to select it, then Press it on its card.'));
      N.menu(btn, [{ header: 'Change while it runs' }, { node }], { up: true, alignRight: true, cls: 'wide' });
    }
    faultMenu(btn) {
      const L = this.L;
      const sel = L.ctx.getSelection();
      const items = [];
      if (L.fault) items.push({ header: 'Active fault' }, { label: L.fault.text, active: true, onClick: () => {} }, { label: 'Clear the fault', icon: I.close, onClick: () => L.clearFault() }, '-');
      const list = L.faultsFor(sel);
      items.push({ header: sel.refs.size || sel.nets.size ? 'Faults for the selection' : 'Select a part or net for its faults' });
      for (const f of list) items.push({ label: f.text, onClick: () => L.injectFault(f) });
      if (!list.length) items.push({ node: el('p', { class: 'muted small menu-note' }, 'Nothing to break there. Select a resistor, capacitor, diode, chip or net.') });
      N.menu(btn, items, { up: true, alignRight: true, cls: 'wide' });
    }
  }
})();

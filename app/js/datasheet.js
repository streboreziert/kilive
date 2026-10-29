/* KiLive — the datasheet reader window: datasheet.html (the datasheet → reference design tool) shown in a window
   over the app; the circuit it extracts comes back here and becomes a drawn board (Design tab, PCB, 3D, live simulation). */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const I = N.icons;
  const PAGE = 'datasheet.html';

  const W = (N.datasheetWin = {});
  let win = null;

  W.open = function () {
    if (win) { win.frame.focus(); return; }
    const frame = el('iframe', { class: 'dsw-frame', src: PAGE + '?embed=1', title: 'Datasheet to reference design' });
    const close = el('button', { class: 'btn small ghost', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close the datasheet reader', onclick: () => W.close() }, N.svg(I.close));
    const tab = el('a', { class: 'btn small ghost', href: PAGE, target: '_blank', rel: 'noopener', title: 'Open the reader in its own browser tab' }, 'Open in a tab');
    const head = el('div', { class: 'dsw-head' },
      el('b', null, 'Datasheet → reference design'),
      el('span', { class: 'muted small dsw-hint' }, 'Drop a datasheet PDF, pick the application circuit, then “Open as a board in KiLive”.'),
      el('span', { class: 'grow' }), tab, close);
    const box = el('div', { class: 'dsw', role: 'dialog', 'aria-label': 'Datasheet reader' }, head, frame);
    const back = el('div', { class: 'dsw-back' }, box);
    back.addEventListener('click', e => { if (e.target === back) W.close(); });
    document.body.append(back);
    document.body.classList.add('dsw-open');
    win = { back, frame };
    frame.focus();
  };
  W.close = function () {
    if (!win) return;
    win.back.remove();
    document.body.classList.remove('dsw-open');
    win = null;
  };
  W.isOpen = () => !!win;

  // the circuit the reader hands over: a drawn board in the library, opened on its Design tab
  W.fromCircuit = function (msg) {
    const data = msg && msg.circuit;
    if (!data || !Array.isArray(data.components) || !Array.isArray(data.nets)) { N.toast('The reader sent nothing usable.', 'warn'); return; }
    let design;
    try { design = N.designer.fromCircuit(data, { type: 'datasheet', file: msg.source || '', example: !!msg.example }); }
    catch (e) { console.error(e); N.toast('This circuit could not be turned into a drawing: ' + (e.message || e), 'warn'); return; }
    const mpn = (data.part && data.part.mpn) || '';
    const title = design.doc.title || (mpn ? mpn + ' reference design' : 'Reference design');
    const d = N.lib.putDraft({ id: N.lib.newId('d'), kind: 'design', meta: { title, desc: mpn ? 'Reference design of the ' + mpn + (msg.source ? ', read from ' + msg.source : '') : '', tags: ['reference-design'].concat(mpn ? [mpn.toLowerCase()] : []), license: 'CC-BY-4.0', kind: 'design', origin: 'design', src: { label: msg.source ? 'Read from ' + msg.source : 'From a datasheet' } }, design });
    W.close();
    location.hash = N.lib.draftRepoId(d.id) + '~main~design';
    N.toast(`${title}: ${data.components.length} parts placed. Fix anything on the drawing, then look at the PCB, 3D and Live.`);
  };

  window.addEventListener('message', e => {
    if (!win || e.source !== win.frame.contentWindow || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'noeti-circuit') W.fromCircuit(m);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && win && !e.defaultPrevented) { e.preventDefault(); W.close(); } });
})();

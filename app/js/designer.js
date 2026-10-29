/* KiLive — designed boards: drawing → circuit → KiCad project, auto-placed PCB, checks; the Design tab */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const I = N.icons;

  const D = (N.designer = {});

  // ------------------------------------------------------------------ design records
  D.blank = function (title) {
    return { v: 1, doc: { v: 1, title: title || 'Untitled board', parts: [], power: [], labels: [], wires: [], nc: [] }, sim: null, options: [], rules: [], chosen: {}, alias: {}, notes: [], layout: [], part: {}, source: { type: 'draw' } };
  };

  // A circuit read from a datasheet (Debug AI JSON shape) → a design with a drawing laid out from it
  D.fromCircuit = function (data, source) {
    const src = JSON.parse(JSON.stringify(data));
    const circ = new DS2K.Circuit(src);
    circ.normalize();
    const alias = {};
    (src.components || []).filter(c => c && typeof c === 'object').forEach((c, i) => {
      const k = circ.components[i];
      if (k && c.ref !== undefined) { alias[String(c.ref).trim()] = k.ref; alias[String(c.ref).trim().toUpperCase()] = k.ref; }
    });
    const dict = circ.toDict();
    const doc = N.SchEditor.fromCircuit(dict);
    doc.title = (dict.design && dict.design.title) || (dict.part && dict.part.mpn ? dict.part.mpn + ' reference design' : 'Reference design');
    return {
      v: 1, doc, sim: src.sim && typeof src.sim === 'object' ? src.sim : null,
      options: Array.isArray(src.options) ? src.options : [], rules: Array.isArray(src.rules) ? src.rules : [], chosen: {}, alias,
      notes: (dict.notes || []).slice(0, 12), layout: Array.isArray(src.layout) ? src.layout.map(String).slice(0, 8) : [],
      part: dict.part || {}, warnings: (src.warnings || []).map(String).slice(0, 12), disagreements: Array.isArray(src.disagreements) ? src.disagreements.map(String) : [],
      source: Object.assign({ type: 'datasheet' }, source || {}),
    };
  };

  // ------------------------------------------------------------------ drawing → circuit (options applied)
  D.compile = function (design) {
    const c0 = N.SchEditor.docToCircuit(design.doc);
    c0.part = Object.assign({}, design.part || {});
    c0.notes = (design.notes || []).slice();
    c0.design = Object.assign({}, c0.design, { title: design.doc.title || c0.design.title || '' });
    const base = Object.assign({}, c0, { options: design.options || [], rules: design.rules || [] });
    const ap = DS2K_OPT.applyOptions(base, design.chosen || {}, design.alias || {});
    const picked = ap.options.map(o => o.label + ': ' + (o.type === 'choice' ? (o.choices.find(c => c.id === ap.values[o.id]) || {}).label : ap.values[o.id] + (o.unit ? ' ' + o.unit : '')));
    if (picked.length) ap.circuit.notes = ['Built for - ' + picked.join(', ')].concat(ap.circuit.notes || []);
    if ((design.layout || []).length) ap.circuit.notes = (ap.circuit.notes || []).concat(design.layout.slice(0, 6).map(x => 'Layout: ' + x));
    return { base: c0, ap, circuit: ap.circuit };
  };

  // the simulation section: what the design carries, else sensible defaults + chip models of the templates used
  D.effectiveSim = function (design, circuitDict) {
    if (design.sim && typeof design.sim === 'object') return DS2K_SIM.cleanSim(design.sim, circuitDict);
    const s = DS2K_SIM.cleanSim(null, circuitDict);
    const chips = N.SchEditor.simChipsOf ? N.SchEditor.simChipsOf(design.doc) : [];
    if (chips.length) {
      s.chips = chips;
      const driven = new Set();
      for (const ch of chips) for (const k of ['out', 'sw']) if (ch[k] !== undefined) { const net = circuitDict.nets.find(n => n.nodes.some(x => x.ref === ch.ref && String(x.pin) === String(ch[k]))); if (net) driven.add(net.name); }
      s.sources = s.sources.filter(x => !driven.has(x.net));
      if (!s.sources.length) {
        const n = circuitDict.nets.find(x => x.kind === 'power' && !driven.has(x.name));
        if (n) s.sources.push({ net: n.name, kind: 'dc', value: DS2K_SIM.guessVolt(n.name) == null ? 5 : DS2K_SIM.guessVolt(n.name) });
      }
      for (const ch of chips) if (ch.model === '555') {
        const out = circuitDict.nets.find(n => n.nodes.some(x => x.ref === ch.ref && String(x.pin) === '3'));
        const thr = circuitDict.nets.find(n => n.nodes.some(x => x.ref === ch.ref && String(x.pin) === '6'));
        s.probes = [out, thr].filter(Boolean).map(n => n.name);
        s.tstop = s.tstop || 3;
      }
    }
    return s;
  };

  // ------------------------------------------------------------------ full build: KiCad project + board data
  D.build = function (design, meta) {
    const t0 = performance.now();
    const title = (meta && meta.title) || design.doc.title || 'Untitled board';
    const name = DS2K.safeName(L_slug(title) || 'noeti_board', 'noeti_board');
    const comp = D.compile(design);
    const circuit = comp.circuit;
    const empty = !circuit.components.length;
    const r = DS2K.build(circuit, name, { source: design.source && design.source.pdf ? design.source.pdf : '' });
    const schName = r.name + '.kicad_sch';
    const lay = N.layoutgen.generate(r.circuit, r.symbols, { title, name: r.name, schematic: r.files[schName], finish: 'ENIG' });
    const pcb = lay.pcb;
    const sch = N.kicad.parseSchematic({ [schName]: r.files[schName] }, schName, r.name);
    const classes = pcb.fps.map(f => f.z || N.kicad.classify(f));
    const circDict = r.circuit.toDict();
    let checks = N.kicad.runChecks(pcb, sch, classes);
    checks = adaptChecks(checks, circDict, r, lay, comp.ap);
    const bom = N.kicad.bomLines(pcb, sch);
    const stats = N.kicad.stats(pcb, sch, bom, classes);
    const power = N.kicad.powerNets(pcb);
    const files = Object.assign({}, r.files);
    files[r.name + '.kicad_pcb'] = lay.kicadPcb;
    files['circuit.json'] = JSON.stringify(Object.assign({}, circDict, { options: design.options || [], rules: design.rules || [], chosen: comp.ap.values, sim: design.sim || undefined }), null, 1);
    try { files[r.name + '_ngspice.cir'] = DS2K_SIM.netlist(circDict, D.effectiveSim(design, circDict), comp.ap.values, design.alias || {}, title).text; } catch (e) { /* optional */ }
    files['README.txt'] = (files['README.txt'] || '') + '\n' + r.name + '.kicad_pcb holds every footprint placed and the nets assigned; it is not routed yet (the ratsnest shows what to connect).\n' +
      ((design.layout || []).length ? '\nPCB layout rules from the datasheet:\n' + design.layout.map(x => ' - ' + x).join('\n') + '\n' : '');
    const data = { key: 'design__' + name, pcb, sch, bom, checks, power, stats };
    return { data, files, name: r.name, r, comp, circuit: circDict, layoutWarnings: lay.warnings, ms: Math.round(performance.now() - t0), title, empty };
  };
  function L_slug(s) { return String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); }

  // Turn the generic KiCad checks into what makes sense for a board that has only just been drawn
  function adaptChecks(checks, circ, r, lay, ap) {
    const ports = new Set(circ.nets.filter(n => n.port && n.port !== 'none').map(n => n.name));
    const out = [];
    for (const c of checks) {
      if (c.id === 'unrouted') {
        const air = (lay.pcb.air || []).length / 5;
        out.push(Object.assign({}, c, { title: 'Routing', status: 'info', summary: `Parts are placed and every pad carries its net; ${air} connection${air === 1 ? '' : 's'} are waiting in the ratsnest. Download the KiCad project and route it in KiCad.`, items: [] }));
        continue;
      }
      if (c.id === 'labels') {
        const items = c.items.filter(it => !(it.nets || []).some(n => ports.has(n)));
        const iface = c.items.length - items.length;
        if (!items.length) { out.push(Object.assign({}, c, { status: 'pass', summary: iface ? `Every label joins something; ${iface} interface label${iface === 1 ? '' : 's'} mark where the board connects to the outside.` : c.summary, items: [] })); continue; }
        out.push(Object.assign({}, c, { items, summary: `${items.length} net label${items.length === 1 ? '' : 's'} join nothing.` }));
        continue;
      }
      out.push(c);
    }
    if (!circ.components.length) {
      out.unshift({ id: 'design', cat: 'Design', title: 'Schematic self-check', status: 'info', summary: 'Nothing drawn yet. Place parts in the Design tab and the checks run on every change.', items: [] });
      return out.filter(c => c.id !== 'footprints');
    }
    const errs = r.errors.concat(r.selfCheck.ok ? [] : r.selfCheck.errors.slice(0, 8));
    const warns = [].concat(DS2K_CMP.pinChecks(circ), ap.problems || [], r.warnings || []).filter(Boolean);
    out.unshift({
      id: 'design', cat: 'Design', title: 'Schematic self-check', status: errs.length ? 'fail' : warns.length ? 'warn' : 'pass',
      summary: errs.length ? `${errs.length} problem${errs.length === 1 ? '' : 's'} in the drawn circuit must be fixed before the board is usable.` : warns.length ? `${warns.length} thing${warns.length === 1 ? '' : 's'} in the circuit to review.` : 'The written schematic re-reads to exactly the drawn netlist, and every part pin is connected or marked not-connected.',
      items: errs.concat(warns).slice(0, 40).map(t => ({ t: String(t), refs: refsIn(String(t)) })),
    });
    const fpw = (lay.warnings || []);
    const noFp = r.symbols.filter(s => !s.footprint).map(s => s.ref);
    out.splice(1, 0, {
      id: 'footprints', cat: 'Design', title: 'Footprints', status: fpw.length || noFp.length ? 'warn' : 'pass',
      summary: fpw.length || noFp.length ? `${Math.max(fpw.length, noFp.length)} part${Math.max(fpw.length, noFp.length) === 1 ? '' : 's'} use a stand-in footprint until you pick the real package.` : 'Every part has a KiCad library footprint from its package.',
      items: fpw.slice(0, 30).map(t => ({ t, refs: refsIn(t) })),
    });
    return out;
  }
  function refsIn(t) { const m = /^([A-Z#]+[A-Z]*\d+[A-Z_\d]*)\b/.exec(t) || /\b([A-Z]{1,3}\d{1,3})\b/.exec(t); return m ? [m[1]] : []; }

  // ------------------------------------------------------------------ files
  D.zip = function (files, folder) { return DS2K_ZIP.makeZip(files, folder); };

  // ------------------------------------------------------------------ thumbnail (3D render, transparent webp)
  D.thumbnail = async function (B) {
    let host = null, v = null;
    try {
      host = el('div', { style: { position: 'fixed', left: '-10000px', top: '0', width: '800px', height: '500px', pointerEvents: 'none' } });
      host.dataset.snapshot = '1';
      document.body.append(host);
      v = new N.Viewer3D(host);
      v.setBoard(B);
      v.fit(true);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const src = v.snapshot('image/png');
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      const c = document.createElement('canvas');
      c.width = 480; c.height = 300;
      c.getContext('2d').drawImage(img, 0, 0, 480, 300);
      let out = c.toDataURL('image/webp', 0.82);
      if (!/^data:image\/webp/.test(out)) out = c.toDataURL('image/png');
      return out.length < 200000 ? out : null;
    } catch (e) {
      return null;
    } finally {
      try { v && v.destroy(); } catch (e) { /* ignore */ }
      host && host.remove();
    }
  };

  // ------------------------------------------------------------------ Design tab
  /**
   * ctx: {design, readOnly, onEdit(design, what), onRemix(), status}
   * returns {setStatus(html|node), setDesign(design), highlight(refs, nets), destroy()}
   */
  D.mountDesignTab = function (host, ctx) {
    host.innerHTML = '';
    const bar = el('div', { class: 'dz-bar' });
    const status = el('div', { class: 'dz-status', role: 'status', 'aria-live': 'polite' });
    const optsBox = el('div', { class: 'dz-opts' });
    const edHost = el('div', { class: 'dz-editor' });
    host.append(bar, edHost);
    let design = ctx.design;
    const ed = new N.SchEditor(edHost, {
      doc: design.doc, readOnly: !!ctx.readOnly, title: design.doc.title,
      onChange: doc => { design.doc = doc; ctx.onEdit && ctx.onEdit(design, 'doc'); },
    });
    function renderBar() {
      bar.innerHTML = '';
      const left = el('div', { class: 'dz-left' });
      if (ctx.readOnly) {
        left.append(el('span', { class: 'tag' }, 'View only'),
          el('span', { class: 'muted small' }, 'This drawing belongs to its author. Remix it to change it and save your own board.'));
      } else {
        left.append(el('span', { class: 'dz-live' }, el('span', { class: 'dz-dot' }), 'Live'), el('span', { class: 'muted small' }, 'Every change rebuilds the schematic, PCB, 3D view, BOM and checks.'));
      }
      bar.append(left, status);
      if (ctx.readOnly && ctx.onRemix) bar.append(el('button', { class: 'btn tiny', onclick: () => ctx.onRemix() }, N.svg(I.copy), 'Remix'));
      renderOptions();
    }
    function renderOptions() {
      optsBox.innerHTML = '';
      const ap = ctx.applied && ctx.applied();
      if (!ap || !ap.options.length) { optsBox.remove(); return; }
      const wrap = el('div', { class: 'dz-optrow' }, el('span', { class: 'eyebrow' }, 'Design options'));
      for (const o of ap.options) {
        const id = 'dzopt_' + o.id;
        let ctl;
        const set = v => { design.chosen = Object.assign({}, design.chosen, { [o.id]: v }); ctx.onEdit && ctx.onEdit(design, 'options'); };
        if (o.type === 'number') {
          const inp = el('input', { class: 'input small', type: 'number', id, value: ap.values[o.id], min: o.min, max: o.max, step: o.step || 'any', disabled: ctx.readOnly || null, style: { width: '90px' } });
          inp.addEventListener('change', () => set(inp.value));
          ctl = el('span', { class: 'dz-num' }, inp, o.unit ? el('span', { class: 'muted small' }, o.unit) : null);
        } else {
          ctl = el('div', { class: 'seg small' }, o.choices.map(c => el('button', { class: c.id === ap.values[o.id] ? 'active' : '', disabled: ctx.readOnly || null, onclick: () => set(c.id) }, c.label)));
        }
        const got = ap.actual[o.id];
        wrap.append(el('label', { class: 'dz-opt', for: id, title: o.help || '' }, el('span', null, o.label), ctl,
          got !== undefined && Math.abs(got - ap.values[o.id]) > 1e-9 * Math.abs(got) ? el('span', { class: 'muted small' }, 'gives ' + (+got.toPrecision(3)) + (o.unit ? ' ' + o.unit : '')) : null));
      }
      if (ap.changes.length) wrap.append(el('span', { class: 'muted small dz-changes' }, ap.changes.slice(0, 6).map(c => c.what === 'removed' ? c.ref + ' not fitted' : c.what === 'pin' ? c.ref + '.' + c.pin + ' → ' + c.to : c.what === 'dnp' ? c.ref + (c.to ? ' DNP' : ' fitted') : c.ref + ' → ' + c.to).join(' · ')));
      optsBox.append(wrap);
      host.insertBefore(optsBox, edHost);
    }
    renderBar();
    return {
      editor: ed,
      setStatus(kind, text) {
        status.className = 'dz-status ' + (kind || '');
        status.textContent = text || '';
      },
      setDesign(d) { design = d; ed.setDoc(d.doc); renderBar(); },
      refreshOptions: renderOptions,
      highlight(refs, nets) {
        try {
          if (nets && nets.length) ed.highlightNet(nets[0]);
          else if (refs && refs.length) ed.highlightRefs(refs);
          else { ed.highlightNet(null); ed.highlightRefs([]); }
        } catch (e) { /* editor may not know the net */ }
      },
      fit() { ed.fit(); },
      destroy() { try { ed.destroy(); } catch (e) { /* ignore */ } },
    };
  };
})();

/* KiLive — open a KiCad project straight from a public GitHub repository.
   N.gh.parse(text)  -> { owner, repo, ref, path } or null   (github.com links, owner/repo, owner/repo/sub/folder)
   N.gh.open(text)   -> lists the repository, picks the project (asks when there are several), fetches only that
                        project's KiCad files from raw.githubusercontent.com and imports them like an upload.
   Link format for sharing:  <app>#gh/owner/repo[@ref][/sub/folder]
   Uses one GitHub API call per open (60 per hour without sign-in); file contents come from raw.githubusercontent.com. */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const G = (N.gh = {});
  const KICAD = /\.kicad_(pcb|sch|pro)$/i;
  const MAX_BYTES = 80e6;

  G.parse = function (text) {
    let s = String(text || '').trim();
    if (!s) return null;
    s = s.replace(/^git@github\.com:/i, 'https://github.com/').replace(/\.git$/i, '');
    s = s.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/^gh\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (/^https?:/i.test(s)) return null;
    const parts = s.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    let [owner, repo, ...rest] = parts;
    let ref = '';
    const at = repo.indexOf('@');
    if (at > 0) { ref = repo.slice(at + 1); repo = repo.slice(0, at); }
    if ((rest[0] === 'tree' || rest[0] === 'blob') && rest.length > 1) { ref = rest[1]; rest = rest.slice(2); }
    let path = rest.join('/');
    if (KICAD.test(path)) path = path.replace(/\/?[^/]*$/, '');      // a link to a file: open its folder
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
    return { owner, repo, ref, path };
  };

  G.hashFor = function (spec) {
    return 'gh/' + spec.owner + '/' + spec.repo + (spec.ref ? '@' + spec.ref : '') + (spec.path ? '/' + spec.path : '');
  };
  G.linkFor = spec => location.origin + location.pathname + '#' + G.hashFor(spec);

  async function api(url) {
    const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (r.status === 403 || r.status === 429) throw new Error('GitHub limits requests without sign-in to 60 an hour, and that limit is used up. Try again later, or download the repository as a .zip and upload it.');
    if (r.status === 404) throw new Error('Repository or branch not found. Private repositories cannot be opened by link: download them as a .zip and upload it.');
    if (!r.ok) throw new Error('GitHub answered ' + r.status + '.');
    return r.json();
  }
  async function raw(spec, ref, path) {
    const url = 'https://raw.githubusercontent.com/' + spec.owner + '/' + spec.repo + '/' + encodeURIComponent(ref) + '/' + path.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(url);
    if (!r.ok) throw new Error('Could not download ' + path + ' (' + r.status + ').');
    return r.text();
  }
  async function pool(items, n, fn) {
    let i = 0;
    const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  }

  /** list the KiCad files of the repository (one API call) */
  G.list = async function (spec) {
    const ref = spec.ref || 'HEAD';
    const t = await api('https://api.github.com/repos/' + spec.owner + '/' + spec.repo + '/git/trees/' + encodeURIComponent(ref) + '?recursive=1');
    const pre = spec.path ? spec.path.replace(/\/+$/, '') + '/' : '';
    const files = (t.tree || []).filter(x => x.type === 'blob' && KICAD.test(x.path) && (!pre || x.path.startsWith(pre)));
    return { ref: t.sha || ref, files, truncated: !!t.truncated };
  };

  G.open = async function (text) {
    const spec = typeof text === 'string' ? G.parse(text) : text;
    if (!spec) { N.toast('That is not a GitHub repository link.', 'warn'); return; }
    if (!document.getElementById('create-work')) N.create.render(document.getElementById('main'));
    history.replaceState(null, '', '#' + G.hashFor(spec));
    const body = N.create.workArea('From GitHub · ' + spec.owner + '/' + spec.repo + (spec.path ? '/' + spec.path : ''));
    const fail = msg => { body.innerHTML = ''; body.append(el('p', { class: 'err' }, msg)); };
    try {
      N.create.progress(body, 'Listing the repository…', 0.03);
      const L = await G.list(spec);
      if (!L.files.length) return fail('No KiCad 6+ board or schematic (.kicad_pcb, .kicad_sch) ' + (spec.path ? 'under ' + spec.path : 'in this repository') + (L.truncated ? '. The repository is too large to list completely; link to the folder that holds the project.' : '.'));
      const projects = N.kicad.findProjects(L.files.map(f => [f.path, f.size || 0])).filter(p => p.pcb);
      if (!projects.length) return fail('The repository has KiCad schematics but no board layout (.kicad_pcb).');
      const go = p => fetchAndImport(spec, L, p, body);
      if (projects.length > 1) {
        body.innerHTML = '';
        body.append(el('p', null, `${projects.length} boards in this repository. Which one?`),
          el('div', { class: 'proj-list' }, projects.slice(0, 40).map(p => el('button', { class: 'proj', onclick: () => go(p) },
            el('b', { class: 'mono' }, p.name), el('span', { class: 'muted small mono' }, (p.sch ? 'board + schematic' : 'board') + ' · ' + (p.folder || '/'))))));
        return;
      }
      await go(projects[0]);
    } catch (e) { fail(e.message || String(e)); }
  };

  async function fetchAndImport(spec, L, proj, body) {
    try {
      const pre = proj.folder ? proj.folder + '/' : '';
      // the project's folder and everything below it (hierarchical sheets may sit in sub-folders)
      const want = L.files.filter(f => !pre || f.path.startsWith(pre));
      const bytes = want.reduce((a, f) => a + (f.size || 0), 0);
      if (bytes > MAX_BYTES) throw new Error('This project is ' + Math.round(bytes / 1e6) + ' MB of KiCad files, more than the browser can process.');
      body.innerHTML = '';
      const files = {};
      let done = 0;
      N.create.progress(body, 'Downloading ' + want.length + ' file' + (want.length === 1 ? '' : 's') + '…', 0.05);
      await pool(want, 6, async f => {
        files[f.path] = await raw(spec, L.ref, f.path);
        done++;
        N.create.progress(body, 'Downloading ' + done + ' of ' + want.length + '…', 0.05 + 0.25 * done / want.length);
      });
      G.last = { spec, url: 'https://github.com/' + spec.owner + '/' + spec.repo + (pre ? '/tree/' + (spec.ref || 'HEAD') + '/' + proj.folder : ''), project: proj.name };
      await N.create.importFiles(files, { title: 'From GitHub · ' + spec.owner + '/' + spec.repo, source: G.last });
    } catch (e) { body.innerHTML = ''; body.append(el('p', { class: 'err' }, e.message || String(e))); }
  }

  /** the "Open from GitHub" form: an input and a button */
  G.form = function (opts) {
    opts = opts || {};
    const inp = el('input', { class: 'input gh-input', type: 'text', placeholder: 'github.com/owner/repo or a link to a project folder', 'aria-label': 'GitHub repository link', spellcheck: 'false', autocomplete: 'off' });
    const go = () => { const s = G.parse(inp.value); if (!s) { inp.setCustomValidity('Paste a GitHub repository link'); inp.reportValidity(); return; } inp.setCustomValidity(''); location.hash = G.hashFor(s); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    inp.addEventListener('input', () => inp.setCustomValidity(''));
    return el('div', { class: 'gh-form' + (opts.big ? ' big' : '') }, inp, el('button', { class: 'btn primary', type: 'button', onclick: go }, 'Open'));
  };
})();

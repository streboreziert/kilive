/* KiLive on the desktop: what the page gets from claude.ai when published, done by the local server instead.
   db -> JSON files under local-data/db (scripts/serve.py), user -> you, downloads -> ordinary downloads. */
(function () {
  'use strict';
  const J = (url, body) => fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || r.statusText); e.code = r.status === 404 ? 'not_found' : 'invalid_argument'; throw e; } return j; });
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const subs = new Set();
  let rev = -1;
  const meta = { fromCache: false, hasPendingWrites: false };
  const docSnapOf = (path, r) => ({ id: path.split('/').pop(), exists: !!r.exists, data: () => (r.exists ? clone(r.data) : undefined), metadata: meta });
  const colSnapOf = r => { const docs = r.docs.map(d => ({ id: d.id, exists: true, data: () => clone(d.data), metadata: meta })); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta }; };
  async function refresh(all) {
    for (const s of [...subs]) {
      if (!all && !s.dirty) continue;
      s.dirty = false;
      try { s.fn(s.kind === 'col' ? colSnapOf(await J('/_db/list?col=' + encodeURIComponent(s.path))) : docSnapOf(s.path, await J('/_db/get?path=' + encodeURIComponent(s.path)))); }
      catch (e) { if (s.err) s.err(e); }
    }
  }
  const touched = () => { for (const s of subs) s.dirty = true; setTimeout(() => refresh(false), 20); };
  function docRef(path) {
    return {
      id: path.split('/').pop(), path,
      async get() { return docSnapOf(path, await J('/_db/get?path=' + encodeURIComponent(path))); },
      async set(d) { await J('/_db/set', { path, data: d }); touched(); },
      async update(d) { await J('/_db/set', { path, data: d, merge: true }); touched(); },
      async delete() { await J('/_db/delete', { path }); touched(); },
      onSnapshot(fn, err) { const s = { kind: 'doc', path, fn, err, dirty: true }; subs.add(s); setTimeout(() => refresh(false), 0); return () => subs.delete(s); },
      collection(sub) { return colRef(path + '/' + sub); },
    };
  }
  function colRef(col) {
    const self = {
      path: col,
      async get() { return colSnapOf(await J('/_db/list?col=' + encodeURIComponent(col))); },
      doc(id) { return docRef(col + '/' + (id || Math.random().toString(36).slice(2, 10))); },
      async add(d) { const r = self.doc(); await r.set(d); return r; },
      onSnapshot(fn, err) { const s = { kind: 'col', path: col, fn, err, dirty: true }; subs.add(s); setTimeout(() => refresh(false), 0); return () => subs.delete(s); },
      where() { return self; }, orderBy() { return self; }, limit() { return self; },
    };
    return self;
  }
  const db = { collection: colRef, doc: docRef, acquire: async () => ({ release() {} }) };

  let prof = null;
  const profile = async () => prof || (prof = await J('/_local/profile').catch(() => ({ id: 'local', name: 'You' })));
  const user = {
    async id() { return (await profile()).id || 'local'; },
    async me() { const p = await profile(); return { id: p.id || 'local', name: p.name || 'You', isMe: true }; },
    async can() { return true; }, isOwner() { return true; }, canEdit() { return true; },
    async profiles(ids) { const p = await profile(); const o = {}; for (const i of [].concat(ids || [])) o[i] = { id: i, name: i === (p.id || 'local') ? p.name || 'You' : i, isMe: i === (p.id || 'local'), color: '#0e7656' }; return o; },
    async search() { return []; },
    async rename(name) { await J('/_local/profile', { name }); prof = null; },
  };
  const downloads = {
    async save(r) {
      const blob = r.data instanceof Blob ? r.data : new Blob([r.data], { type: typeof r.data === 'string' ? 'text/plain' : 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = r.filename || 'file'; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { status: 'saved' };
    },
  };
  window.claude = { use: async name => ({ db, user, downloads })[name] || null, local: true };

  // keep the server alive while a window is open, and pick up changes made from another window
  const ping = () => fetch('/_local/ping', { method: 'POST', keepalive: true }).then(r => r.json()).then(j => { if (rev >= 0 && j.rev !== rev) refresh(true); rev = j.rev; }).catch(() => {});
  ping(); setInterval(ping, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
})();

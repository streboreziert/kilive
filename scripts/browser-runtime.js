/* KiLive in a plain browser (GitHub Pages or any static host): what the page gets from claude.ai when published,
   done inside the browser instead.
     db        -> IndexedDB in this browser (your library, stars and comments stay on this device)
     user      -> you, the one local user
     downloads -> ordinary file downloads
   Same interface as scripts/local-runtime.js (the desktop server version). Loaded only by the static build
   (scripts/build_site.py); the claude.ai artifact and the desktop app do not use it. */
(function () {
  'use strict';
  if (window.claude) return;

  // The KiCad plugin opens this address after "Send to KiLive"
  window.NOETI_APP_URL = location.origin + location.pathname.replace(/index\.html$/, '');

  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const meta = { fromCache: false, hasPendingWrites: false };
  const MAX_DOC = 4 * 1024 * 1024;

  // ------------------------------------------------------------------ storage: one IndexedDB object store, key = document path
  let mem = null;                                  // fallback when IndexedDB is unavailable (private windows in some browsers)
  const dbp = new Promise(res => {
    try {
      const rq = indexedDB.open('kilive', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('docs');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => { mem = new Map(); res(null); };
    } catch (e) { mem = new Map(); res(null); }
  });
  function tx(mode, fn) {
    return dbp.then(idb => {
      if (!idb) return fn(null);
      return new Promise((res, rej) => {
        const t = idb.transaction('docs', mode); const st = t.objectStore('docs'); let out;
        Promise.resolve(fn(st)).then(v => { out = v; });
        t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    });
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const getRaw = path => tx('readonly', st => (st ? req(st.get(path)) : mem.get(path)));
  const putRaw = (path, v) => tx('readwrite', st => (st ? req(st.put(v, path)) : mem.set(path, v)));
  const delRaw = path => tx('readwrite', st => (st ? req(st.delete(path)) : mem.delete(path)));
  const segs = p => p.split('/').length;
  async function listRaw(col) {
    const lo = col + '/', hi = col + '/￿', n = segs(col) + 1;
    const rows = await tx('readonly', st => {
      if (!st) return [...mem.entries()].filter(([k]) => k >= lo && k < hi);
      return new Promise((res, rej) => {
        const out = []; const c = st.openCursor(IDBKeyRange.bound(lo, hi));
        c.onsuccess = () => { const cur = c.result; if (!cur) return res(out); out.push([cur.key, cur.value]); cur.continue(); };
        c.onerror = () => rej(c.error);
      });
    });
    return rows.filter(([k]) => segs(k) === n).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  // ------------------------------------------------------------------ the document API the app expects
  const subs = new Set();
  const docSnap = (path, v) => ({ id: path.split('/').pop(), exists: v != null, data: () => clone(v == null ? undefined : v), metadata: meta });
  const colSnap = rows => { const docs = rows.map(([k, v]) => ({ id: k.split('/').pop(), exists: true, data: () => clone(v), metadata: meta })); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta }; };
  async function fire(s) {
    try { s.fn(s.kind === 'col' ? colSnap(await listRaw(s.path)) : docSnap(s.path, await getRaw(s.path))); }
    catch (e) { if (s.err) s.err(e); }
  }
  let pending = null, bc = null;
  try { bc = new BroadcastChannel('kilive'); bc.onmessage = () => { for (const s of subs) fire(s); }; } catch (e) {}
  const touched = () => { try { bc && bc.postMessage(1); } catch (e) {} if (pending) return; pending = setTimeout(() => { pending = null; for (const s of subs) fire(s); }, 15); };
  const check = path => { if (!/^[A-Za-z0-9_~.\-]+(\/[A-Za-z0-9_~.\-]+)*$/.test(path) || segs(path) % 2) { const e = new Error('bad document path ' + path); e.code = 'invalid_argument'; throw e; } };
  const sized = d => { if (JSON.stringify(d).length > MAX_DOC) { const e = new Error('document too large'); e.code = 'invalid_argument'; throw e; } };

  function docRef(path) {
    check(path);
    return {
      id: path.split('/').pop(), path,
      async get() { return docSnap(path, await getRaw(path)); },
      async set(d) { sized(d); await putRaw(path, clone(d)); touched(); },
      async update(d) {
        const cur = await getRaw(path);
        if (cur == null) { const e = new Error('not found'); e.code = 'not_found'; throw e; }
        const nx = Object.assign(cur, clone(d)); sized(nx); await putRaw(path, nx); touched();
      },
      async delete() { await delRaw(path); touched(); },
      onSnapshot(fn, err) { const s = { kind: 'doc', path, fn, err }; subs.add(s); setTimeout(() => fire(s), 0); return () => subs.delete(s); },
      collection(sub) { return colRef(path + '/' + sub); },
    };
  }
  function colRef(col) {
    const self = {
      path: col,
      async get() { return colSnap(await listRaw(col)); },
      doc(id) { return docRef(col + '/' + (id || Math.random().toString(36).slice(2, 10))); },
      async add(d) { const r = self.doc(); await r.set(d); return r; },
      onSnapshot(fn, err) { const s = { kind: 'col', path: col, fn, err }; subs.add(s); setTimeout(() => fire(s), 0); return () => subs.delete(s); },
      where() { return self; }, orderBy() { return self; }, limit() { return self; },
    };
    return self;
  }
  const db = { collection: colRef, doc: docRef, acquire: async () => ({ release() {} }) };

  // ------------------------------------------------------------------ you
  const NAME_KEY = 'noeti.localName';
  const myName = () => { try { return localStorage.getItem(NAME_KEY) || 'You'; } catch (e) { return 'You'; } };
  const ME = 'local';
  const user = {
    async id() { return ME; },
    async me() { return { id: ME, name: myName(), isMe: true }; },
    async can() { return true; }, isOwner() { return true; }, canEdit() { return true; },
    async profiles(ids) { const o = {}; for (const i of [].concat(ids || [])) o[i] = { id: i, name: i === ME ? myName() : i, isMe: i === ME, color: '#0e7656' }; return o; },
    async search() { return []; },
    async rename(name) { try { localStorage.setItem(NAME_KEY, String(name || '').slice(0, 60)); } catch (e) {} },
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

  window.claude = { use: async name => ({ db, user, downloads })[name] || null, local: true, browser: true };
})();

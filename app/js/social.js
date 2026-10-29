/* KiLive — runtime capabilities: stars, comments and download counts */
(function () {
  'use strict';
  const N = window.Noeti;

  // Capability access with graceful absence
  const memo = {};
  N.caps = {
    use(name) {
      if (memo[name]) return memo[name];
      const c = window.claude;
      if (!c || typeof c.use !== 'function') return (memo[name] = Promise.resolve(null));
      memo[name] = Promise.race([
        c.use(name).catch(() => null),
        new Promise(r => setTimeout(() => r(null), 12000)),
      ]);
      return memo[name];
    },
  };

  const S = (N.social = {
    ready: false,
    db: null, user: null, uid: null, canWrite: false,
    stars: new Map(),       // uid -> Set(repoId)
    comments: [],           // flattened {uid, id, repo, board, text, at}
    downloads: new Map(),   // uid -> {repo: n}
    localStars: new Set(N.store.get('stars', [])),
  });

  S.init = async function () {
    const [db, user] = await Promise.all([N.caps.use('db'), N.caps.use('user')]);
    S.db = db;
    S.user = user;
    if (user) {
      try { S.uid = await user.id(); } catch (e) { S.uid = null; }
      try {
        const w = await user.can('data.write');
        S.canWrite = w !== false;
      } catch (e) { S.canWrite = true; }
    }
    if (db) {
      const sub = (col, fn) => {
        try {
          db.collection(col).onSnapshot(snap => { fn(snap); N.bus.emit('social'); }, err => console.warn(col, err && err.code));
        } catch (e) { console.warn('subscribe', col, e); }
      };
      sub('stars', snap => {
        S.stars = new Map();
        for (const d of snap.docs) { const b = d.data() || {}; S.stars.set(d.id, new Set(Object.keys(b.repos || {}).filter(k => b.repos[k]))); }
      });
      sub('comments', snap => {
        const all = [];
        for (const d of snap.docs) {
          const b = d.data() || {};
          for (const c of b.items || []) if (c && c.text) all.push(Object.assign({ uid: d.id }, c));
        }
        all.sort((a, b) => a.at - b.at);
        S.comments = all;
      });
      sub('downloads', snap => {
        S.downloads = new Map();
        for (const d of snap.docs) S.downloads.set(d.id, (d.data() || {}).counts || {});
      });
    }
    S.ready = true;
    N.bus.emit('social');
  };

  S.live = () => !!(S.db && S.uid);
  S.starCount = function (repoId) {
    let n = 0;
    for (const set of S.stars.values()) if (set.has(repoId)) n++;
    if (!S.live() && S.localStars.has(repoId)) n++;
    return n;
  };
  S.isStarred = function (repoId) {
    if (S.live()) return !!(S.stars.get(S.uid) && S.stars.get(S.uid).has(repoId));
    return S.localStars.has(repoId);
  };
  S.toggleStar = async function (repoId) {
    if (!S.live()) {
      if (S.localStars.has(repoId)) S.localStars.delete(repoId); else S.localStars.add(repoId);
      N.store.set('stars', [...S.localStars]);
      N.bus.emit('social');
      return;
    }
    const mine = new Set(S.stars.get(S.uid) || []);
    if (mine.has(repoId)) mine.delete(repoId); else mine.add(repoId);
    const repos = {};
    for (const r of mine) repos[r] = true;
    S.stars.set(S.uid, mine);
    N.bus.emit('social');
    try { await S.db.doc('stars/' + S.uid).set({ repos, at: Date.now() }); }
    catch (e) { N.toast(e && e.code === 'invalid_argument' ? 'Your access to this page is view-only, so stars are not saved.' : 'Could not save your star. Try again in a moment.', 'warn'); }
  };

  S.commentsFor = repoId => S.comments.filter(c => c.repo === repoId);
  S.myItems = function () {
    return S.comments.filter(c => c.uid === S.uid).map(({ uid, ...rest }) => rest);
  };
  S.addComment = async function (repoId, boardId, text) {
    if (!S.live()) throw new Error('offline');
    const items = S.myItems();
    items.push({ id: Math.random().toString(36).slice(2, 10), repo: repoId, board: boardId, text: text.slice(0, 2000), at: Date.now() });
    while (items.length > 150) items.shift();
    await S.db.doc('comments/' + S.uid).set({ items });
  };
  S.deleteComment = async function (id) {
    const items = S.myItems().filter(c => c.id !== id);
    await S.db.doc('comments/' + S.uid).set({ items });
  };

  S.downloadCount = function (repoId) {
    let n = 0;
    for (const c of S.downloads.values()) n += +c[repoId] || 0;
    return n;
  };
  S.countDownload = async function (repoId) {
    if (!S.live()) return;
    const mine = Object.assign({}, S.downloads.get(S.uid) || {});
    mine[repoId] = (+mine[repoId] || 0) + 1;
    S.downloads.set(S.uid, mine);
    N.bus.emit('social');
    try { await S.db.doc('downloads/' + S.uid).set({ counts: mine }); } catch (e) { /* view-only viewers cannot write */ }
  };

  S.names = async function (ids) {
    if (!S.user || !ids.length) return {};
    try { return await S.user.profiles(ids); } catch (e) { return {}; }
  };
})();

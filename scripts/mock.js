// Local test double for the Claude artifact runtime (never published)
(function(){
  const store = new Map(); const subs = [];
  const segs = p => p.split('/').length;
  const clone = v => JSON.parse(JSON.stringify(v));
  function colSnap(col){ const n = segs(col) + 1; const docs=[...store.entries()].filter(([k])=>k.startsWith(col+'/')&&segs(k)===n).sort((a,b)=>a[0]<b[0]?-1:1).map(([k,v])=>({id:k.split('/').pop(),exists:true,data:()=>clone(v),metadata:{fromCache:false,hasPendingWrites:false}})); return {docs,size:docs.length,empty:!docs.length,docChanges:()=>[],metadata:{}}; }
  function docSnap(path){ const v=store.get(path); return {id:path.split('/').pop(),exists:!!v,data:()=>v?clone(v):undefined,metadata:{}}; }
  function notify(){ for (const s of subs) s.kind==='col' ? s.fn(colSnap(s.path)) : s.fn(docSnap(s.path)); }
  const sizeOf = d => JSON.stringify(d).length;
  function docRef(path){ return {
    id: path.split('/').pop(), path,
    async set(d){ if (sizeOf(d) > 262144) throw {code:'invalid_argument', message:'document over 256 KiB'}; store.set(path, clone(d)); window.__writes=(window.__writes||0)+1; setTimeout(notify, 5); },
    async update(d){ if (!store.has(path)) throw {code:'invalid_argument'}; store.set(path, Object.assign(store.get(path), clone(d))); setTimeout(notify,5); },
    async delete(){ store.delete(path); setTimeout(notify,5); },
    async get(){ return docSnap(path); },
    onSnapshot(fn){ subs.push({kind:'doc',path,fn}); setTimeout(()=>fn(docSnap(path)),10); return ()=>{}; },
    collection(sub){ return colRef(path+'/'+sub); },
  }; }
  function colRef(col){ return {
    path: col,
    onSnapshot(fn){ subs.push({kind:'col',path:col,fn}); setTimeout(()=>fn(colSnap(col)),10); return ()=>{}; },
    async get(){ return colSnap(col); },
    doc(id){ return docRef(col+'/'+(id||Math.random().toString(36).slice(2,10))); },
    async add(d){ const r=this.doc(); await r.set(d); return r; },
    where(){ return this; }, orderBy(){ return this; }, limit(){ return this; },
  }; }
  const db = { collection: colRef, doc: docRef };
  window.__store = store;
  store.set('comments/u_other', {items:[{id:'a1',repo:'hackrf',board:'hackrf-one',text:'Measured VCC at 3.29 V on C113 after swapping U21. TX works again.',at:Date.now()-3600e3*5}]});
  store.set('stars/u_other', {repos:{hackrf:true}});
  const user = { async id(){return 'u_test';}, async can(){return true;}, async profiles(ids){ const o={}; for (const i of [].concat(ids)) o[i]={id:i,name:i==='u_test'?'Roberts':'Marta K.',avatarUrl:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="'+(i==='u_test'?'#0e7656':'#8a5cf6')+'"/></svg>'),color:'#888',isMe:i==='u_test'}; return o; } };
  const downloads = { async save(r){ window.__saved=(window.__saved||[]).concat(r.filename); window.__savedData = r.data; return {status:'saved'}; } };
  window.claude = { use: async (n)=> ({db, user, downloads})[n] || null };
})();

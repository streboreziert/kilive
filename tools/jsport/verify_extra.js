// Compare JS importProject against Python for every project found in the repos (ref_extra/).
'use strict';
const fs = require('fs');
const path = require('path');
require('/home/claude/noeti/app/js/kicad-import.js');
const K = globalThis.Noeti.kicad;
const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'ref_extra/_list.json'), 'utf8'));
function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(p, r, out);
    else if (/\.kicad_(pcb|sch|pro)$/.test(e.name)) out.push(r);
  }
  return out;
}
function cmp(a, b, p, out) {
  if (out.length >= 1000) return;
  if (typeof a === 'number' && typeof b === 'number') {
    const d = Math.abs(a - b);
    if (d > 1e-3 && d > 1e-6 * Math.max(Math.abs(a), Math.abs(b))) out.push(`${p}: js=${a} py=${b}`);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (a !== b) out.push(`${p}: js=${JSON.stringify(a)} py=${JSON.stringify(b)}`); return; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${p}: length js=${a.length} py=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) cmp(a[i], b[i], `${p}[${i}]`, out);
    return;
  }
  const ka = Object.keys(a), kb = new Set(Object.keys(b));
  for (const k of ka) if (!kb.has(k)) out.push(`${p}.${k}: extra key in js`);
  for (const k of kb) if (!(k in a)) out.push(`${p}.${k}: missing key in js`);
  for (const k of ka) if (kb.has(k)) cmp(a[k], b[k], `${p}.${k}`, out);
}
(async () => {
  let n = 0, bad = 0;
  for (const rec of list) {
    const rdir = path.join('/home/claude/boards', rec.dir);
    const folder = rec.proj.folder;
    const files = {};
    for (const rel of walk(path.join(rdir, folder), folder, [])) files[rel] = new Uint8Array(fs.readFileSync(path.join(rdir, rel)));
    let res, err = null;
    const t0 = Date.now();
    try { res = await K.importProject(files, rec.proj); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    if (!rec.ok) { console.log(`PY-ERR ${rec.key}: python ${rec.error}; js ${err ? 'threw ' + err.message : 'ok (' + res.stats.fps + ' fps)'}`); continue; }
    n++;
    if (err) { bad++; console.log(`JS-ERR ${rec.key}: ${err.stack}`); continue; }
    const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'ref_extra', rec.key + '.json'), 'utf8'));
    const mism = [];
    for (const k of ['pcb', 'sch', 'bom', 'checks', 'power', 'stats', 'kicad']) cmp(res[k], ref[k], k, mism);
    if (mism.length) bad++;
    console.log(`${mism.length ? 'DIFF ' : 'MATCH'} ${rec.key} ${ms}ms kicad ${res.kicad} ${mism.length ? mism.length + ' mismatches' : ''}`);
    for (const m of mism.slice(0, 8)) console.log('     ' + m);
  }
  console.log(`${n - bad}/${n} match`);
})();

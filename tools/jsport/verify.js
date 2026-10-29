// Verify app/js/kicad-import.js against the Python pipeline output (app/data/<key>.json).
// usage: node verify.js [keySubstring...]
'use strict';
const fs = require('fs');
const path = require('path');
require('/home/claude/noeti/app/js/kicad-import.js');
const K = globalThis.Noeti.kicad;

const BOARDS = '/home/claude/boards';
const DATA = process.env.REF_DIR || '/home/claude/noeti/app/data';
const versions = JSON.parse(fs.readFileSync(path.join(__dirname, 'repos.json'), 'utf8'));
const only = process.argv.slice(2);

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(p, r, out);
    else if (/\.kicad_(pcb|sch|pro)$/.test(e.name)) out.push(r);
  }
  return out;
}

function cmp(a, b, p, out, stat) {
  if (out.length >= 10000) return;
  if (typeof a === 'number' && typeof b === 'number') {
    const d = Math.abs(a - b);
    if (d > 1e-9) stat.numDiff++;
    if (d > 1e-3 && d > 1e-6 * Math.max(Math.abs(a), Math.abs(b))) out.push(`${p}: js=${a} py=${b}`);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) out.push(`${p}: js=${JSON.stringify(a)} py=${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${p}: type js=${Array.isArray(a) ? 'array' : 'object'}`); return; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${p}: length js=${a.length} py=${b.length}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) cmp(a[i], b[i], `${p}[${i}]`, out, stat);
    return;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  const sb = new Set(kb), sa = new Set(ka);
  for (const k of ka) if (!sb.has(k)) out.push(`${p}.${k}: extra key in js`);
  for (const k of kb) if (!sa.has(k)) out.push(`${p}.${k}: missing key in js`);
  for (const k of ka) if (sb.has(k)) cmp(a[k], b[k], `${p}.${k}`, out, stat);
}

(async () => {
  let allOk = true;
  const summary = [];
  for (const v of versions) {
    if (only.length && !only.some((o) => v.key.includes(o))) continue;
    const rdir = path.join(BOARDS, v.dir);
    const folder = path.posix.dirname(v.pcb);
    const files = {};
    for (const rel of walk(path.join(rdir, folder), folder, [])) files[rel] = new Uint8Array(fs.readFileSync(path.join(rdir, rel)));
    const pro = v.pcb.slice(0, -'.kicad_pcb'.length) + '.kicad_pro';
    const proj = { name: path.posix.basename(v.pcb, '.kicad_pcb'), folder, pcb: v.pcb, sch: v.sch || null, pro: files[pro] ? pro : null };
    const t0 = process.hrtime.bigint();
    const stages = [];
    let last = t0;
    const res = await K.importProject(files, proj, {
      onProgress: (label, f) => { const now = process.hrtime.bigint(); stages.push(`${label}@${Number(now - last) / 1e6 | 0}ms`); last = now; },
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const ref = JSON.parse(fs.readFileSync(path.join(DATA, v.key + '.json'), 'utf8'));
    const mism = [];
    const stat = { numDiff: 0 };
    for (const k of ['pcb', 'sch', 'bom', 'checks', 'power', 'stats']) cmp(res[k], ref[k], k, mism, stat);
    const pcbMB = (files[v.pcb].length / 1e6).toFixed(1);
    const ok = mism.length === 0;
    allOk = allOk && ok;
    const line = `${ok ? 'MATCH' : 'DIFF '} ${v.key.padEnd(36)} ${ms.toFixed(0).padStart(6)} ms  pcb ${pcbMB} MB  mismatches ${mism.length}  tiny-num-diffs ${stat.numDiff}  kicad ${res.kicad}  files ${res.files.length}`;
    console.log(line);
    if (process.env.STAGES) console.log('   ', stages.join(' '));
    for (const m of mism.slice(0, 10)) console.log('    ' + m);
    summary.push({ key: v.key, ms: Math.round(ms), ok, mismatches: mism.length, tinyNumDiffs: stat.numDiff });
  }
  fs.writeFileSync(path.join(__dirname, 'verify-result.json'), JSON.stringify(summary, null, 1));
  console.log(allOk ? 'ALL MATCH' : 'SOME DIFFER');
  process.exitCode = allOk ? 0 : 1;
})();

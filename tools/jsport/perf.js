'use strict';
const fs = require('fs'), path = require('path');
require('/home/claude/noeti/app/js/kicad-import.js');
const K = globalThis.Noeti.kicad;
const versions = JSON.parse(fs.readFileSync(path.join(__dirname, 'repos.json'), 'utf8'));
const key = process.argv[2];
const v = versions.find((x) => x.key.includes(key));
const rdir = path.join('/home/claude/boards', v.dir), folder = path.posix.dirname(v.pcb);
const files = {};
for (const f of fs.readdirSync(path.join(rdir, folder))) if (/\.kicad_(pcb|sch|pro)$/.test(f)) files[folder + '/' + f] = fs.readFileSync(path.join(rdir, folder, f), 'utf8');
(async () => {
  global.gc(); const h0 = process.memoryUsage().heapUsed;
  let peak = 0; const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 0);
  const runs = [];
  let res;
  for (let i = 0; i < 3; i++) { const t = Date.now(); res = await K.importProject(files, K.findProjects(Object.keys(files))[0]); runs.push(Date.now() - t); }
  clearInterval(iv);
  global.gc(); const h1 = process.memoryUsage().heapUsed;
  const outMB = JSON.stringify({ pcb: res.pcb, sch: res.sch, bom: res.bom, checks: res.checks }).length / 1e6;
  console.log(`${v.key}: runs ${runs.join('/')} ms; heap peak ~${((peak - h0) / 1e6).toFixed(0)} MB above baseline; retained result ${((h1 - h0) / 1e6).toFixed(0)} MB; result JSON ${outMB.toFixed(1)} MB; maxRSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`);
})();

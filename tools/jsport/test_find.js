'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('/home/claude/noeti/app/js/kicad-import.js');
const K = globalThis.Noeti.kicad;
const versions = JSON.parse(fs.readFileSync(path.join(__dirname, 'repos.json'), 'utf8'));
const dirs = [...new Set(versions.map((v) => v.dir))];
let ok = true;
const all = {};
for (const d of dirs) {
  const rdir = path.join('/home/claude/boards', d);
  const files = execFileSync('git', ['-C', rdir, 'ls-files'], { encoding: 'utf8' }).trim().split('\n');
  const withSize = files.map((f) => { let s = 0; try { s = fs.statSync(path.join(rdir, f)).size; } catch (e) {} return [f, s]; });
  // also inject noise that must be ignored
  withSize.push(['x/foo-backups/foo-2024.kicad_pcb', 5], ['x/_autosave-foo.kicad_sch', 5], ['x/~foo.kicad_pcb.lck', 1], ['__MACOSX/x/foo.kicad_pcb', 9]);
  const projs = K.findProjects(withSize);
  all[d] = projs;
  console.log(`== ${d}: ${files.length} files -> ${projs.length} projects`);
  for (const p of projs) console.log(`   ${p.pcb ? 'PCB' : '   '} ${p.sch ? 'SCH' : '   '} ${p.pro ? 'PRO' : '   '}  ${p.folder}/${p.name}`);
  for (const v of versions.filter((x) => x.dir === d)) {
    const hit = projs.find((p) => p.pcb === v.pcb && p.sch === v.sch);
    console.log(`   expected ${v.key}: ${hit ? 'FOUND' : 'MISSING'}`);
    if (!hit) ok = false;
  }
  if (projs.some((p) => /backups|autosave|MACOSX|lck/.test(JSON.stringify(p)))) { console.log('   ignored file leaked!'); ok = false; }
}
// string-only input + pro/sch stem pairing cases
const t1 = K.findProjects(['a/board.kicad_pcb', 'a/proj.kicad_pro', 'a/proj.kicad_sch', 'a/sub.kicad_sch']);
console.log('pairing test', JSON.stringify(t1));
if (!(t1.length === 1 && t1[0].sch === 'a/proj.kicad_sch' && t1[0].pro === 'a/proj.kicad_pro')) ok = false;
const t2 = K.findProjects(['s/only.kicad_pro', 's/only.kicad_sch', 's/child.kicad_sch', 'solo/x.kicad_sch']);
console.log('sch-only test', JSON.stringify(t2));
if (!(t2.length === 2 && t2[0].pcb === null)) ok = false;
fs.writeFileSync(path.join(__dirname, 'projects.json'), JSON.stringify(all, null, 1));
console.log(ok ? 'FINDPROJECTS OK' : 'FINDPROJECTS FAIL');

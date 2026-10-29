'use strict';
const fs = require('fs');
require('/home/claude/noeti/app/js/kicad-import.js');
const K = globalThis.Noeti.kicad;
const base = '/home/claude/boards/RP2040-designguide/PCB/';
const pcb = fs.readFileSync(base + 'RP2040-Guide.kicad_pcb', 'utf8');
const sch = fs.readFileSync(base + 'RP2040-Guide.kicad_sch', 'utf8');
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const errs = {};
let ok = 0, n = 0;
(async () => {
  const cases = [];
  for (let i = 0; i < 40; i++) cases.push(['trunc-pcb', pcb.slice(0, Math.floor(rnd() * pcb.length)), sch]);
  for (let i = 0; i < 40; i++) cases.push(['trunc-sch', pcb, sch.slice(0, Math.floor(rnd() * sch.length))]);
  for (let i = 0; i < 40; i++) { const a = pcb.split(''); for (let k = 0; k < 30; k++) a[Math.floor(rnd() * a.length)] = '()" x\\'[Math.floor(rnd() * 6)]; cases.push(['corrupt-pcb', a.join(''), sch]); }
  cases.push(['empty', '', ''], ['garbage', 'hello world', 'foo'], ['no-root', ')))', '(((']);
  for (const [kind, p, s] of cases) {
    n++;
    const files = { 'P/x.kicad_pcb': p, 'P/x.kicad_sch': s };
    try { await K.importProject(files, { name: 'x', folder: 'P', pcb: 'P/x.kicad_pcb', sch: 'P/x.kicad_sch', pro: null }); ok++; }
    catch (e) { const k = kind + ': ' + (e && e.message || e).toString().slice(0, 90); errs[k] = (errs[k] || 0) + 1; }
  }
  console.log(`fuzz: ${ok}/${n} imports completed without throwing`);
  for (const [k, c] of Object.entries(errs)) console.log('  ', c, 'x', k);
})();

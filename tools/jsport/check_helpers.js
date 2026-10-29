'use strict';
const fs = require('fs');
require('/home/claude/noeti/app/js/kicad-import.js');
const P = globalThis.Noeti.kicad._py;
const E = JSON.parse(fs.readFileSync(__dirname + '/helpers_expected.json', 'utf8').replace(/(?<!")\bNaN\b(?!")/g, 'null').replace(/-?Infinity/g, 'null'));
const bad = {};
const note = (k, msg) => { (bad[k] = bad[k] || []).push(msg); };
for (const [v, r1, r2, r3, r4, r0] of E.round) {
  if (P.pyRound(v, 1) !== r1) note('round1', `${v}: ${P.pyRound(v, 1)} vs ${r1}`);
  if (P.pyRound(v, 2) !== r2) note('round2', `${v}: ${P.pyRound(v, 2)} vs ${r2}`);
  if (P.pyRound(v, 3) !== r3) note('round3', `${v}: ${P.pyRound(v, 3)} vs ${r3}`);
  if (P.pyRound(v, 4) !== r4) note('round4', `${v}: ${P.pyRound(v, 4)} vs ${r4}`);
  if (P.round0(v) !== r0) note('round0', `${v}: ${P.round0(v)} vs ${r0}`);
}
for (const [v, f1, f2, f3] of E.fmt) {
  if (P.fmtF(v, 1) !== f1) note('fmt1', `${v}: ${P.fmtF(v, 1)} vs ${f1}`);
  if (P.fmtF(v, 2) !== f2) note('fmt2', `${v}: ${P.fmtF(v, 2)} vs ${f2}`);
  if (P.fmtF(v, 3) !== f3) note('fmt3', `${v}: ${P.fmtF(v, 3)} vs ${f3}`);
}
for (const [v, r] of E.repr) if (v !== null && P.floatRepr(v) !== r) note('repr', `${v}: ${P.floatRepr(v)} vs ${r}`);
let hmis = 0;
for (const [a, b, h] of E.hypot) { const j = P.hypot(a, b); if (j !== h) { hmis++; if (hmis < 5) note('hypot', `${a},${b}: ${j} vs ${h} (Math.hypot ${Math.hypot(a, b)})`); } }
let mathHypotMis = 0;
for (const [a, b, h] of E.hypot) if (Math.hypot(a, b) !== h) mathHypotMis++;
for (const [seq, order] of E.sets) {
  const s = new P.PySet(seq);
  const got = s.toArray();
  if (JSON.stringify(got) !== JSON.stringify(order)) note('set', `${JSON.stringify(seq).slice(0, 80)}: ${JSON.stringify(got).slice(0, 80)} vs ${JSON.stringify(order).slice(0, 80)}`);
}
for (const [s, v] of E.float) {
  const got = P.fnum(s, null);
  const g = got !== got ? 'nan' : got;
  const exp = v === 'nan' ? 'nan' : v;
  if (!(g === exp || (s.toLowerCase().includes('inf') && got === (s[0] === '-' ? -Infinity : Infinity)) || (s === '1e1000' && got === Infinity)))
    note('float', `${JSON.stringify(s)}: ${g} vs ${exp}`);
}
console.log('round cases', E.round.length, 'fmt', E.fmt.length, 'repr', E.repr.length, 'hypot', E.hypot.length, 'sets', E.sets.length, 'float', E.float.length);
console.log('hypot mismatches:', hmis, ' (plain Math.hypot would mismatch', mathHypotMis + ')');
for (const k of Object.keys(bad)) { console.log(k, bad[k].length); for (const m of bad[k].slice(0, 6)) console.log('   ', m); }
if (!Object.keys(bad).length) console.log('ALL HELPERS MATCH CPYTHON');

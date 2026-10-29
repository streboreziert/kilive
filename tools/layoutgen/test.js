/* node tools/layoutgen/test.js — builds the test circuits with DS2K.build, runs N.layoutgen.generate and checks:
   pins -> pads/nets, courtyard overlaps, parts inside the outline, ratsnest edge count, silk refs clear of pads,
   and a round-trip of every .kicad_pcb through tools/kicad_pcb.py (fps / pads / nets / z must match). */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const APP = path.join(__dirname, '../../app');
require(path.join(APP, 'js/ds2k-engine.js'));
require(path.join(APP, 'js/layout-gen.js'));
const L = globalThis.Noeti.layoutgen;

const html = fs.readFileSync(path.join(APP, 'test-layout.html'), 'utf8');
const CIRCUITS = JSON.parse(/<script id="circuits" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
CIRCUITS.example = globalThis.DS2K_EXAMPLE;
const ORDER = ['example', 'ldo', '555', 'opamp', 'npn', 'mcu', 'unknown', 'stm32'];
const OUT = process.env.OUT || '/tmp/claude-0/layoutgen';
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const fail = (name, msg) => { failures++; console.log('  FAIL ' + name + ': ' + msg); };
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-3);
const bboxOf = (flat) => { const xs = [], ys = []; for (let i = 0; i < flat.length; i += 2) { xs.push(flat[i]); ys.push(flat[i + 1]); } return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };

const results = {};
for (const name of ORDER) {
  const r = globalThis.DS2K.build(CIRCUITS[name], name, {});
  const t0 = Date.now();
  const out = L.generate(r.circuit, r.symbols, { title: r.circuit.design.title || name, schematic: r.files[r.name + '.kicad_sch'], name: r.name, date: '2026-09-30' });
  const ms = Date.now() - t0;
  const pcb = out.pcb;
  const file = path.join(OUT, name + '.kicad_pcb');
  fs.writeFileSync(file, out.kicadPcb);
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(pcb));
  results[name] = { out, file, r };
  console.log(`${name}: ${pcb.fps.length} fps, ${pcb.pads.length} pads, ${pcb.nets.length - 1} nets, board ${pcb.meta.w} x ${pcb.meta.h} mm, ${pcb.air.length / 5} airwires, ${ms} ms`);
  for (const w of out.warnings) console.log('  warning: ' + w);

  // 1. every circuit pin on its pad(s) with the right net
  const circ = r.circuit.toDict();
  const symBy = new Map(r.symbols.map((s) => [s.ref, s]));
  const fpBy = new Map(pcb.fps.map((f, i) => [f.r, i]));
  let pins = 0, multi = [];
  for (const n of circ.nets) for (const { ref, pin } of n.nodes) {
    pins++;
    const s = symBy.get(ref) || {};
    const num = String((s.pinMap || {})[pin] != null ? s.pinMap[pin] : pin);
    const fi = fpBy.get(ref);
    if (fi == null) { fail(name, ref + ' has no footprint'); continue; }
    const pads = pcb.fps[fi].pads.map((i) => pcb.pads[i]).filter((p) => p[1] === num);
    if (!pads.length) { fail(name, `${ref}.${pin} -> pad ${num} missing`); continue; }
    if (pads.length > 1) multi.push(`${ref}.${pin} (${pads.length} pads "${num}")`);
    for (const p of pads) if (pcb.nets[p[10]] !== n.name) fail(name, `${ref}.${pin} pad ${num} on net ${pcb.nets[p[10]]}, expected ${n.name}`);
  }
  // pads that carry a net must come from the circuit
  const expected = new Set(); for (const n of circ.nets) for (const { ref, pin } of n.nodes) { const s = symBy.get(ref) || {}; expected.add(ref + '.' + String((s.pinMap || {})[pin] != null ? s.pinMap[pin] : pin)); }
  for (const p of pcb.pads) if (p[10] && !expected.has(pcb.fps[p[0]].r + '.' + p[1])) fail(name, `pad ${pcb.fps[p[0]].r}.${p[1]} has unexpected net ${pcb.nets[p[10]]}`);
  console.log(`  pins: ${pins} circuit pins on pads with the right net` + (multi.length ? `; multi-pad pins (tab + lead): ${multi.join(', ')}` : ''));

  // 2. courtyards: no overlap, >= 0.25 mm apart
  const crt = pcb.fps.map((f) => bboxOf(f.c));
  let minGap = Infinity;
  for (let i = 0; i < crt.length; i++) for (let j = i + 1; j < crt.length; j++) {
    const a = crt[i], b = crt[j];
    const gx = Math.max(b[0] - a[2], a[0] - b[2]), gy = Math.max(b[1] - a[3], a[1] - b[3]);
    const gap = Math.max(gx, gy);
    minGap = Math.min(minGap, gap);
    if (gap < 0.25 - 1e-6) fail(name, `courtyards ${pcb.fps[i].r} / ${pcb.fps[j].r} only ${gap.toFixed(3)} mm apart`);
  }
  // 3. inside the outline (courtyards, pads and silk texts)
  const bb = pcb.meta.bbox;
  for (let i = 0; i < crt.length; i++) { if (pcb.fps[i].fp === 'MountingHole_3.2mm_M3') { const f = pcb.fps[i]; if (f.x - 1.6 < bb[0] + 1 || f.y - 1.6 < bb[1] + 1 || f.x + 1.6 > bb[2] - 1 || f.y + 1.6 > bb[3] - 1) fail(name, f.r + ' hole too close to the edge'); continue; } const c = crt[i]; if (c[0] < bb[0] + 0.5 || c[1] < bb[1] + 0.5 || c[2] > bb[2] - 0.5 || c[3] > bb[3] - 0.5) fail(name, `${pcb.fps[i].r} courtyard outside the board`); }
  const tw = (s, size) => size * (0.78 * s.length + 0.1);
  const texts = pcb.gfx['F.SilkS'].texts;
  for (const t of texts) { const w = tw(t[0], t[3]); const x0 = t[5] === 'l' ? t[1] : t[1] - w / 2; if (x0 < bb[0] + 0.3 || x0 + w > bb[2] - 0.3 || t[2] - t[3] / 2 < bb[1] + 0.3 || t[2] + t[3] / 2 > bb[3] - 0.3) fail(name, `silk text ${t[0]} off the board`); }
  // 4. silk texts clear of pads and of each other
  const padBoxes = pcb.pads.map((p) => { const sw = Math.round(p[8]) % 180 === 90; const hw = (sw ? p[7] : p[6]) / 2, hh = (sw ? p[6] : p[7]) / 2; return [p[4] - hw, p[5] - hh, p[4] + hw, p[5] + hh]; });
  const tBoxes = texts.map((t) => { const w = tw(t[0], t[3]); const x0 = t[5] === 'l' ? t[1] : t[1] - w / 2; return [x0, t[2] - t[3] / 2, x0 + w, t[2] + t[3] / 2, t[0]]; });
  const ov = (a, b, cl) => a[0] < b[2] + cl && b[0] < a[2] + cl && a[1] < b[3] + cl && b[1] < a[3] + cl;
  for (const t of tBoxes) for (let i = 0; i < padBoxes.length; i++) if (ov(t, padBoxes[i], 0.1)) fail(name, `silk text ${t[4]} over pad ${pcb.fps[pcb.pads[i][0]].r}.${pcb.pads[i][1]}`);
  for (let i = 0; i < tBoxes.length; i++) for (let j = i + 1; j < tBoxes.length; j++) if (ov(tBoxes[i], tBoxes[j], 0)) fail(name, `silk texts ${tBoxes[i][4]} / ${tBoxes[j][4]} overlap`);
  // silk lines clear of pads (0.15 mm incl. half line width)
  const sl = pcb.gfx['F.SilkS'].lines;
  const segHitsBox = (x1, y1, x2, y2, b) => { for (let k = 0; k <= 20; k++) { const x = x1 + (x2 - x1) * k / 20, y = y1 + (y2 - y1) * k / 20; if (x > b[0] && x < b[2] && y > b[1] && y < b[3]) return true; } return false; };
  for (let k = 0; k < sl.length; k += 5) for (let i = 0; i < padBoxes.length; i++) { const b = padBoxes[i]; if (segHitsBox(sl[k], sl[k + 1], sl[k + 2], sl[k + 3], [b[0] - 0.15, b[1] - 0.15, b[2] + 0.15, b[3] + 0.15])) { fail(name, `silk line over pad ${pcb.fps[pcb.pads[i][0]].r}.${pcb.pads[i][1]}`); break; } }
  const sc = pcb.gfx['F.SilkS'].circles;
  for (let k = 0; k < sc.length; k += 5) for (let i = 0; i < padBoxes.length; i++) {
    const b = padBoxes[i], cx = Math.max(b[0], Math.min(b[2], sc[k])), cy = Math.max(b[1], Math.min(b[3], sc[k + 1]));
    const d = Math.hypot(sc[k] - cx, sc[k + 1] - cy) - sc[k + 2] - sc[k + 3] / 2;
    const own = sc[k + 4] === 0 && d < 0 && Math.hypot(sc[k] - pcb.pads[i][4], sc[k + 1] - pcb.pads[i][5]) < 1e-3; // test-point ring around its own pad
    if (!own && d < 0.15 - 1e-3) { fail(name, `silk circle at ${sc[k]},${sc[k + 1]} ${d.toFixed(3)} mm from pad ${pcb.fps[pcb.pads[i][0]].r}.${pcb.pads[i][1]}`); break; }
  }
  // 5. ratsnest = spanning tree per net
  const cnt = new Map(); for (const p of pcb.pads) if (p[10]) cnt.set(p[10], (cnt.get(p[10]) || 0) + 1);
  let want = 0; for (const c of cnt.values()) if (c >= 2) want += c - 1;
  if (pcb.air.length / 5 !== want) fail(name, `ratsnest ${pcb.air.length / 5} edges, expected ${want}`); 
  // grid + angles
  for (const f of pcb.fps) { if (Math.abs(f.x * 4 - Math.round(f.x * 4)) > 1e-6 || Math.abs(f.y * 4 - Math.round(f.y * 4)) > 1e-6) fail(name, `${f.r} off the 0.25 mm grid`); if (f.a % 90) fail(name, `${f.r} angle ${f.a}`); }
  console.log(`  courtyards: min gap ${minGap.toFixed(2)} mm; ratsnest ${pcb.air.length / 5} = sum(pads-1) ${want}`);
}

// round-trip through the Python importer
const files = ORDER.map((n) => results[n].file);
const parsed = JSON.parse(execFileSync('python3', [path.join(__dirname, 'roundtrip.py'), ...files], { maxBuffer: 1 << 28 }).toString());
for (const name of ORDER) {
  const mine = results[name].out.pcb, got = parsed[results[name].file].pcb, gz = parsed[results[name].file].z;
  const before = failures;
  if (got.meta.kicad !== '20240108' || got.meta.gen !== '8.0') fail(name, 'version ' + got.meta.kicad + ' / ' + got.meta.gen);
  if (JSON.stringify(got.nets) !== JSON.stringify(mine.nets)) fail(name, 'nets differ: ' + JSON.stringify(got.nets) + ' vs ' + JSON.stringify(mine.nets));
  if (got.fps.length !== mine.fps.length) fail(name, `fps ${got.fps.length} vs ${mine.fps.length}`);
  mine.fps.forEach((f, i) => {
    const g = got.fps[i];
    if (!g) return;
    for (const k of ['r', 'v', 'fp', 'lib', 's', 'k', 'bs', 'm', 'd', 'nb', 'dnp']) if (JSON.stringify(f[k]) !== JSON.stringify(g[k])) fail(name, `${f.r}.${k}: ${JSON.stringify(g[k])} vs ${JSON.stringify(f[k])}`);
    for (const k of ['x', 'y', 'a']) if (!near(f[k], g[k])) fail(name, `${f.r}.${k}: ${g[k]} vs ${f[k]}`);
    for (const k of ['b', 'c']) if (!f[k] || !g[k] || f[k].length !== g[k].length || f[k].some((v, j) => !near(v, g[k][j], 2e-3))) fail(name, `${f.r}.${k}: ${JSON.stringify(g[k])} vs ${JSON.stringify(f[k])}`);
    if (JSON.stringify(f.p || {}) !== JSON.stringify(g.p || {})) fail(name, `${f.r}.p: ${JSON.stringify(g.p)} vs ${JSON.stringify(f.p)}`);
    if (JSON.stringify(f.pads) !== JSON.stringify(g.pads)) fail(name, `${f.r}.pads index lists differ`);
    const z = gz[i];
    if (z[0] !== f.z[0] || !near(z[1], f.z[1]) || z[2] !== f.z[2]) fail(name, `${f.r}.z: ${JSON.stringify(z)} vs ${JSON.stringify(f.z)}`);
  });
  if (got.pads.length !== mine.pads.length) fail(name, `pads ${got.pads.length} vs ${mine.pads.length}`);
  mine.pads.forEach((p, i) => {
    const g = got.pads[i];
    if (!g) return;
    const lbl = mine.fps[p[0]].r + '.' + p[1];
    [0, 1, 2, 3, 9, 14, 15].forEach((k) => { if (p[k] !== g[k]) fail(name, `pad ${lbl}[${k}]: ${JSON.stringify(g[k])} vs ${JSON.stringify(p[k])}`); });
    [4, 5, 6, 7, 8, 11, 12, 13].forEach((k) => { if (!near(p[k], g[k])) fail(name, `pad ${lbl}[${k}]: ${g[k]} vs ${p[k]}`); });
    if (got.nets[g[10]] !== mine.nets[p[10]]) fail(name, `pad ${lbl} net ${got.nets[g[10]]} vs ${mine.nets[p[10]]}`);
  });
  // graphics that the importer reads back: silk/fab/courtyard/edge line + circle counts, silk texts
  for (const Lr of ['F.SilkS', 'F.Fab', 'F.CrtYd', 'Edge.Cuts']) {
    const a = mine.gfx[Lr] || {}, b = got.gfx[Lr] || {};
    for (const k of ['lines', 'circles']) {
      const x = a[k] || [], y = b[k] || [];
      if (x.length !== y.length || x.some((v, j) => typeof v === 'number' && !near(v, y[j], 2e-3))) fail(name, `gfx ${Lr}.${k} differ (${y.length} vs ${x.length})`);
    }
  }
  const st = (t) => t.map((x) => x.slice(0, 5).map((v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)).join('|')).sort().join('\n');
  if (st(mine.gfx['F.SilkS'].texts) !== st(got.gfx['F.SilkS'].texts)) fail(name, 'silk texts differ');
  const ob = got.meta.bbox; if (ob.some((v, j) => !near(v, mine.meta.bbox[j]))) fail(name, `outline bbox ${ob} vs ${mine.meta.bbox}`);
  if (got.outline.outer.length !== 1 || got.outline.holes.length !== mine.outline.holes.length) fail(name, 'outline loops differ');
  console.log(`${name}: round-trip ${failures === before ? 'OK' : 'FAILED'} (${got.fps.length} fps, ${got.pads.length} pads, ${got.nets.length - 1} nets)`);
}
// the schematic link: every footprint has (path "/<uuid of the schematic symbol>")
for (const name of ORDER) {
  const { out, r } = results[name];
  const sch = r.files[r.name + '.kicad_sch'];
  const paths = [...out.kicadPcb.matchAll(/\(property "Reference" "([^"]+)"[\s\S]*?\(path "\/([0-9a-f-]+)"\)/g)];
  const miss = out.pcb.fps.filter((f) => !/^H\d/.test(f.r) && !paths.some((m) => m[1] === f.r));
  if (miss.length) fail(name, 'no (path) for ' + miss.map((f) => f.r).join(','));
  for (const m of paths) if (!sch.includes('(uuid "' + m[2] + '")')) fail(name, `path uuid of ${m[1]} not found in the schematic`);
  // determinism
  const again = L.generate(r.circuit, r.symbols, { title: r.circuit.design.title || name, schematic: sch, name: r.name, date: '2026-09-30' });
  if (again.kicadPcb !== out.kicadPcb) fail(name, 'output is not deterministic');
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);

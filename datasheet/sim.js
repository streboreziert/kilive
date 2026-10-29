/* Simulation: turns a circuit + "stand-ins" for the chips into (a) an ngspice netlist and (b) a quick transient run in the page.
   Chips have no model here, so each chip pin that drives something is replaced by what the datasheet says it does:
   a DC level, a clock, a sine, a load - or the whole chip by a behavioural regulator / op-amp. */
(function (root) {
"use strict";
const P2 = root.DS2K_P2, OPT = root.DS2K_OPT;
const UNIT = { resistor: "ohm", thermistor: "ohm", potentiometer: "ohm", capacitor: "F", capacitor_polarized: "F", inductor: "H" };
const DIODES = { diode: "DGEN", schottky_diode: "DSCH", zener_diode: "DZ", tvs_diode: "DZ", led: "DLED" };
const MODELS = { DGEN: { is: 1e-14, n: 1, rs: 0.05 }, DSCH: { is: 1e-6, n: 1.05, rs: 0.03 }, DLED: { is: 1e-18, n: 2, rs: 5 }, DZ: { is: 1e-14, n: 1, rs: 0.5 } };
const node = (name) => { const s = String(name || ""); if (/^(A|D|P)?GND$|^VSS$|^0V?$/i.test(s)) return "0"; return s.replace(/^\+/, "P").replace(/^-/, "N").replace(/[^A-Za-z0-9_]/g, "_") || "n"; };
const guessVolt = (name) => { const s = String(name || "").toUpperCase(); let m = /^\+?(\d+)V(\d+)$/.exec(s); if (m) return parseFloat(m[1] + "." + m[2]); m = /^\+?(\d+(?:\.\d+)?)V?$/.exec(s); if (m) return parseFloat(m[1]); if (/VBUS|USB/.test(s)) return 5; if (/VBAT/.test(s)) return 3.7; if (/^VIN/.test(s)) return 12; if (/^VCC|^VDD|^AVDD|^DVDD/.test(s)) return 3.3; return null; };

/* what to assume when the design carries no `sim` section */
function defaultSim(circuit) {
  const sources = [], standins = [], probes = [];
  for (const n of circuit.nets) { if (n.kind === "ground") continue; if (n.kind === "power" && n.port === "input") { const v = guessVolt(n.name); sources.push({ net: n.name, kind: "dc", value: v === null ? 5 : v }); } if (n.port === "output" || (n.kind === "power" && n.port !== "input")) probes.push(n.name); }
  for (const c of circuit.components) if (c.type === "ic") for (const p of c.pins || []) if (p.etype === "power_out") { const net = circuit.nets.find((n) => n.nodes.some((x) => x.ref === c.ref && String(x.pin) === String(p.number))); const v = net ? guessVolt(net.name) : null; if (net && v !== null) standins.push({ ref: c.ref, pin: String(p.number), kind: "dc", value: v }); }
  if (!sources.length) { const n = circuit.nets.find((x) => x.kind === "power" && !standins.some((s) => circuit.nets.find((m) => m === x && m.nodes.some((y) => y.ref === s.ref && String(y.pin) === s.pin)))); if (n) sources.push({ net: n.name, kind: "dc", value: guessVolt(n.name) === null ? 5 : guessVolt(n.name) }); }
  return { sources, standins, chips: [], loads: [], probes: probes.slice(0, 4), tstop: 0.005 };
}
function cleanSim(sim, circuit) {
  const d = defaultSim(circuit); if (!sim || typeof sim !== "object") return d; const arr = (x) => (Array.isArray(x) ? x.filter((y) => y && typeof y === "object") : []);
  const out = { sources: arr(sim.sources), standins: arr(sim.standins), chips: arr(sim.chips), loads: arr(sim.loads), probes: Array.isArray(sim.probes) ? sim.probes.map(String).filter((p, i, a) => a.findIndex((q) => q.toUpperCase() === p.toUpperCase()) === i) : [], tstop: sim.tstop };
  if (!out.sources.length && !out.standins.length && !out.chips.length) { out.sources = d.sources; out.standins = d.standins; } if (!out.probes.length) out.probes = d.probes; return out;
}

/* Builds the flat element list both back-ends use. `vals` = chosen option values (stand-in numbers may be expressions of them). */
function elements(circuit, simIn, vals, alias) {
  const sim = cleanSim(simIn, circuit); const els = [], notes = [], netOf = new Map(); const used = new Set(["0"]);
  for (const n of circuit.nets) { let nm = node(n.name); if (nm !== "0") { let k = nm, i = 2; while (used.has(k.toUpperCase()) && ![...netOf.values()].includes(k)) k = nm + "_" + i++; nm = k; used.add(nm.toUpperCase()); } for (const x of n.nodes) netOf.set(x.ref + "\u0000" + x.pin, nm); n._node = nm; }
  let open = 0; const at = (ref, pin) => netOf.get(ref + "\u0000" + pin) || ("nc_" + ref + "_" + String(pin).replace(/[^A-Za-z0-9]/g, "") + (open++ ? "" : ""));
  const refOf = (r) => { const k = String(r || "").trim(); return (alias && (alias[k] || alias[k.toUpperCase()])) || k.toUpperCase(); };
  const num = (x, dflt) => { if (typeof x === "number") return x; if (x === undefined || x === null || x === "") return dflt; try { const v = OPT.evaluate(String(x), (name) => { for (const k of Object.keys(vals || {})) if (k.toLowerCase() === name.toLowerCase()) return vals[k]; const c = circuit.components.find((q) => q.ref === refOf(name)); if (c) { const pv = P2.parseValue(c.value, UNIT[c.type]); if (pv !== null) return pv; } throw new Error("unknown name " + name); }); return typeof v === "number" && isFinite(v) ? v : dflt; } catch (e) { notes.push("Could not work out '" + x + "': " + e.message); return dflt; } };
  const wave = (s) => { const k = String(s.kind || "dc").toLowerCase(); if (k === "pulse" || k === "clock") { const f = num(s.freq, 1000); return { kind: "pulse", low: num(s.low, 0), high: num(s.high !== undefined ? s.high : s.value, 3.3), freq: f, duty: Math.min(0.99, Math.max(0.01, num(s.duty, 0.5))) }; } if (k === "sine") return { kind: "sine", offset: num(s.offset, 0), ampl: num(s.ampl !== undefined ? s.ampl : s.value, 1), freq: num(s.freq, 1000) }; return { kind: "dc", value: num(s.value, 0) }; };
  const driven = new Map(); const drive = (nd, who) => { if (nd === "0") { notes.push(who + " would drive ground - skipped"); return false; } if (driven.has(nd)) { notes.push(who + " skipped: " + nd + " is already driven by " + driven.get(nd)); return false; } driven.set(nd, who); return true; };

  for (const c of circuit.components) {
    if (c.dnp) continue; const p = (x) => at(c.ref, x); const t = c.type;
    if (UNIT[t] && t !== "potentiometer") { let v = P2.parseValue(c.value, UNIT[t]); if (v === null || !(v > 0)) { notes.push(c.ref + ": no usable value ('" + c.value + "') - left out"); continue; } els.push({ t: t === "inductor" ? "L" : t.startsWith("capacitor") ? "C" : "R", name: c.ref, a: p(t === "capacitor_polarized" ? "+" : "1"), b: p(t === "capacitor_polarized" ? "-" : "2"), v }); }
    else if (t === "potentiometer") { const v = P2.parseValue(c.value, "ohm") || 10e3; els.push({ t: "R", name: c.ref + "a", a: p("1"), b: p("W"), v: v / 2 }, { t: "R", name: c.ref + "b", a: p("W"), b: p("3"), v: v / 2 }); }
    else if (t === "ferrite_bead" || t === "fuse" || t === "jumper") els.push({ t: "R", name: c.ref, a: p("1"), b: p("2"), v: t === "ferrite_bead" ? 0.1 : 0.01 });
    else if (DIODES[t]) { const m = DIODES[t]; const bv = m === "DZ" ? (P2.parseValue(c.value, "") || parseFloat((/(\d+(?:\.\d+)?)\s*V/i.exec(c.value + " " + c.rating) || [])[1]) || 5.1) : 0; els.push({ t: "D", name: c.ref, a: p("A"), b: p("K"), model: m, bv }); }
    else if (t === "bjt_npn" || t === "bjt_pnp") els.push({ t: "Q", name: c.ref, c: p("C"), b: p("B"), e: p("E"), pnp: t === "bjt_pnp" });
    else if (t === "mosfet_n" || t === "mosfet_p") els.push({ t: "M", name: c.ref, d: p("D"), g: p("G"), s: p("S"), pch: t === "mosfet_p" });
    else if (t === "ic" || t === "other") { /* handled by chips / stand-ins below */ }
    else if (t !== "test_point" && t !== "connector" && t !== "switch" && t !== "crystal") notes.push(c.ref + " (" + t.replace(/_/g, " ") + ") is left open in the simulation");
  }
  const has = (ref) => circuit.components.some((c) => c.ref === ref && !c.dnp);
  for (const ch of sim.chips) {
    const ref = refOf(ch.ref); if (!has(ref)) continue; const m = String(ch.model || "").toLowerCase();
    if (m === "regulator") { const o = at(ref, String(ch.out)); if (drive(o, ref + " regulator")) els.push({ t: "REG", name: ref, in: at(ref, String(ch.in)), out: o, gnd: ch.gnd !== undefined ? at(ref, String(ch.gnd)) : "0", vout: num(ch.vout, 3.3), drop: num(ch.dropout, 0.3) }); }
    else if (m === "opamp") { (Array.isArray(ch.units) ? ch.units : [ch]).forEach((u, i) => { const o = at(ref, String(u.out)); if (drive(o, ref + " op-amp")) els.push({ t: "OPA", name: ref + (i ? "_" + (i + 1) : ""), p: at(ref, String(u.inp)), n: at(ref, String(u.inn)), out: o, vp: ch.vp !== undefined ? at(ref, String(ch.vp)) : null, vn: ch.vn !== undefined ? at(ref, String(ch.vn)) : "0" }); }); }
    else notes.push(ref + ": unknown chip model '" + ch.model + "'");
  }
  for (const s of sim.standins) {
    const ref = refOf(s.ref); if (!has(ref)) continue; const nd = at(ref, String(s.pin)); const k = String(s.kind || "dc").toLowerCase();
    if (k === "open") continue; if (k === "load") { els.push({ t: "R", name: "load_" + ref + "_" + s.pin, a: nd, b: "0", v: Math.max(1e-3, num(s.value !== undefined ? s.value : s.r, 10e3)) }); continue; }
    if (drive(nd, ref + " pin " + s.pin)) els.push({ t: "V", name: ref + "_" + String(s.pin).replace(/[^A-Za-z0-9]/g, ""), a: nd, b: "0", w: wave(s), rs: num(s.r, 0) });
  }
  for (const s of sim.sources) { const n = circuit.nets.find((x) => x.name.toUpperCase() === String(s.net || "").toUpperCase()); if (!n) { notes.push("Source on '" + s.net + "': no such net"); continue; } if (driven.has(n._node)) continue; if (drive(n._node, "supply " + n.name)) els.push({ t: "V", name: "src_" + n._node, a: n._node, b: "0", w: wave(s), rs: 0 }); }
  for (const l of sim.loads) { const n = circuit.nets.find((x) => x.name.toUpperCase() === String(l.net || "").toUpperCase()); if (!n) { notes.push("Load on '" + l.net + "': no such net"); continue; } els.push({ t: "R", name: "load_" + n._node, a: n._node, b: "0", v: Math.max(1e-3, num(l.value, 1e3)) }); }
  const probes = sim.probes.map((p) => circuit.nets.find((x) => x.name.toUpperCase() === String(p).toUpperCase())).filter((n) => n && n._node !== "0").slice(0, 4).map((n) => ({ label: n.name, node: n._node }));
  let fmax = 0; for (const e of els) if (e.t === "V" && e.w.freq) fmax = Math.max(fmax, e.w.freq);
  let tstop = num(sim.tstop, 0); if (!(tstop > 0)) tstop = fmax ? Math.max(20 / fmax, 0.002) : 0.005; tstop = Math.min(tstop, 10);
  for (const n of circuit.nets) delete n._node;
  return { els, probes, tstop, fmax, notes, sim };
}

/* ------------------------------------------------------------------ ngspice netlist */
const eng = (x) => String(parseFloat(Number(x).toPrecision(6)));
function netlist(circuit, simIn, vals, alias, title) {
  const E = elements(circuit, simIn, vals, alias); const L = ["* " + (title || "reference design") + " - generated by Debug AI", "* Chips are replaced by stand-ins (see the V/B sources named after them). Run:  ngspice thisfile.cir"]; const models = new Set();
  const src = (w) => w.kind === "pulse" ? "PULSE(" + [w.low, w.high, 0, 1 / w.freq / 200, 1 / w.freq / 200, w.duty / w.freq, 1 / w.freq].map(eng).join(" ") + ")" : w.kind === "sine" ? "SIN(" + [w.offset, w.ampl, w.freq].map(eng).join(" ") + ")" : "DC " + eng(w.value);
  for (const e of E.els) {
    if (e.t === "R" || e.t === "C" || e.t === "L") L.push(e.t + e.name + " " + e.a + " " + e.b + " " + eng(e.v));
    else if (e.t === "D") { const m = e.model === "DZ" ? "DZ_" + e.name : e.model; if (e.model === "DZ") L.push(".model " + m + " D(Is=1e-14 Rs=0.5 BV=" + eng(e.bv) + " IBV=1m)"); else models.add(e.model); L.push("D" + e.name + " " + e.a + " " + e.b + " " + m); }
    else if (e.t === "Q") { models.add(e.pnp ? "QP" : "QN"); L.push("Q" + e.name + " " + e.c + " " + e.b + " " + e.e + " " + (e.pnp ? "QP" : "QN")); }
    else if (e.t === "M") { models.add(e.pch ? "MP" : "MN"); L.push("M" + e.name + " " + e.d + " " + e.g + " " + e.s + " " + e.s + " " + (e.pch ? "MP" : "MN") + " W=1 L=1"); }
    else if (e.t === "V") { if (e.rs > 0) { L.push("V" + e.name + " " + e.a + "_i " + e.b + " " + src(e.w), "Rs_" + e.name + " " + e.a + "_i " + e.a + " " + eng(e.rs)); } else L.push("V" + e.name + " " + e.a + " " + e.b + " " + src(e.w)); }
    else if (e.t === "REG") L.push("* " + e.name + ": ideal regulator, " + e.vout + " V, " + e.drop + " V dropout", "B" + e.name + " " + e.out + "_r " + e.gnd + " V=min(max(V(" + e.in + "," + e.gnd + ")-" + eng(e.drop) + ",0)," + eng(e.vout) + ")", "Vs_" + e.name + " " + e.out + "_r " + e.out + " DC 0", "F" + e.name + " " + e.in + " " + e.gnd + " Vs_" + e.name + " 1");
    else if (e.t === "OPA") { const hi = e.vp ? "V(" + e.vp + ")" : "5", lo = e.vn && e.vn !== "0" ? "V(" + e.vn + ")" : "0"; L.push("* " + e.name + ": ideal rail-to-rail op-amp", "B" + e.name + " " + e.out + "_o 0 V=(" + hi + "+" + lo + ")/2+(" + hi + "-" + lo + ")/2*tanh(1e5*V(" + e.p + "," + e.n + ")/((" + hi + "-" + lo + ")/2+1e-9))", "Ro_" + e.name + " " + e.out + "_o " + e.out + " 10"); }
  }
  const M = { DGEN: ".model DGEN D(Is=1e-14 N=1 Rs=0.05)", DSCH: ".model DSCH D(Is=1e-6 N=1.05 Rs=0.03)", DLED: ".model DLED D(Is=1e-18 N=2 Rs=5)", QN: ".model QN NPN(Bf=200 Is=1e-14)", QP: ".model QP PNP(Bf=200 Is=1e-14)", MN: ".model MN NMOS(Level=1 Vto=2 Kp=2)", MP: ".model MP PMOS(Level=1 Vto=-2 Kp=2)" };
  for (const m of models) L.push(M[m]);
  const dt = E.fmax ? Math.min(E.tstop / 2000, 1 / E.fmax / 50) : E.tstop / 2000; const pl = E.probes.map((p) => "v(" + p.node + ")").join(" ");
  L.push(".options reltol=1e-3", ".control", "tran " + eng(dt) + " " + eng(E.tstop) + " uic", pl ? "plot " + pl : "* no probes chosen", ".endc", ".end", "");
  return { text: L.join("\n"), notes: E.notes, probes: E.probes };
}

/* ------------------------------------------------------------------ quick transient solver (modified nodal analysis, backward Euler, Newton) */
function solve(A, b, n) {
  for (let i = 0; i < n; i++) { let p = i, m = Math.abs(A[i * n + i]); for (let r = i + 1; r < n; r++) { const v = Math.abs(A[r * n + i]); if (v > m) { m = v; p = r; } } if (m < 1e-300) return false;
    if (p !== i) { for (let c = 0; c < n; c++) { const t = A[i * n + c]; A[i * n + c] = A[p * n + c]; A[p * n + c] = t; } const t = b[i]; b[i] = b[p]; b[p] = t; }
    const d = A[i * n + i]; for (let r = i + 1; r < n; r++) { const f = A[r * n + i] / d; if (f === 0) continue; for (let c = i; c < n; c++) A[r * n + c] -= f * A[i * n + c]; b[r] -= f * b[i]; } }
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i * n + c] * b[c]; b[i] = s / A[i * n + i]; } return true;
}
function run(circuit, simIn, vals, alias, opts) {
  const E = elements(circuit, simIn, vals, alias); const idx = new Map(); const id = (nm) => { if (nm === "0") return -1; if (!idx.has(nm)) idx.set(nm, idx.size); return idx.get(nm); };
  const els = []; for (const e of E.els) { if (e.t === "V" && e.rs > 0) { els.push(Object.assign({}, e, { a: e.a + "_i", rs: 0 }), { t: "R", name: "rs_" + e.name, a: e.a + "_i", b: e.a, v: e.rs }); } else if (e.t === "OPA") { els.push(Object.assign({}, e, { out: e.out + "_o" }), { t: "R", name: "ro_" + e.name, a: e.out + "_o", b: e.out, v: 10 }); } else if (e.t === "D" && MODELS[e.model].rs) { els.push(Object.assign({}, e, { a: e.a + "_d" + e.name }), { t: "R", name: "rd_" + e.name, a: e.a, b: e.a + "_d" + e.name, v: MODELS[e.model].rs }); } else els.push(e); }
  for (const e of els) for (const k of ["a", "b", "c", "e", "d", "g", "s", "p", "n", "out", "in", "gnd", "vp", "vn"]) if (typeof e[k] === "string") e["_" + k] = id(e[k]);
  const nn = idx.size; let nb = 0; for (const e of els) if (e.t === "V" || e.t === "L" || e.t === "REG" || e.t === "OPA") e._br = nn + nb++; const N = nn + nb;
  if (!N) return { ok: false, error: "There is nothing to simulate.", notes: E.notes };
  const limit = (opts && opts.maxSteps) || 40000; let dt = E.fmax ? Math.min(E.tstop / 2000, 1 / E.fmax / 40) : E.tstop / 2000; let steps = Math.ceil(E.tstop / dt); const notes = E.notes.slice(); if (steps > limit) { steps = limit; dt = E.tstop / steps; if (E.fmax && dt > 1 / E.fmax / 12) notes.push("The run is long compared with the fastest clock, so switching edges are coarse - shorten the time for detail."); }
  const x = new Float64Array(N), xo = new Float64Array(N), A = new Float64Array(N * N), b = new Float64Array(N), xn = new Float64Array(N);
  const V = (arr, i) => (i < 0 ? 0 : arr[i]); const G = (i, j, g) => { if (i >= 0 && j >= 0) A[i * N + j] += g; }; const g2 = (a, c, g) => { G(a, a, g); G(c, c, g); G(a, c, -g); G(c, a, -g); }; const I = (i, v) => { if (i >= 0) b[i] += v; };
  const wv = (w, t) => w.kind === "pulse" ? (((t * w.freq) % 1) < w.duty ? w.high : w.low) : w.kind === "sine" ? w.offset + w.ampl * Math.sin(2 * Math.PI * w.freq * t) : w.value;
  const VT = 0.02585; const pn = (v, is, n) => { const vt = n * VT, vc = vt * Math.log(vt / (1.414 * is)); if (v > vc + 10 * vt) { const ec = Math.exp((vc + 10 * vt) / vt); return [is * (ec - 1) + is / vt * ec * (v - vc - 10 * vt), is / vt * ec]; } const ev = Math.exp(v / vt); return [is * (ev - 1), is / vt * ev + 1e-12]; };
  const nonlinear = els.some((e) => "DQMOPAREG".includes(e.t) && e.t !== "R"); const keep = Math.max(1, Math.ceil(steps / 1500)); const T = [], traces = E.probes.map(() => []); const pi = E.probes.map((p) => (idx.has(p.node) ? idx.get(p.node) : -1));
  let limited = false;
  const stamp = (t) => {
    limited = false; A.fill(0); b.fill(0); for (let i = 0; i < nn; i++) A[i * N + i] += 1e-12;
    for (const e of els) {
      if (e.t === "R") g2(e._a, e._b, 1 / e.v);
      else if (e.t === "C") { const g = e.v / dt; g2(e._a, e._b, g); const vo = V(xo, e._a) - V(xo, e._b); I(e._a, g * vo); I(e._b, -g * vo); }
      else if (e.t === "L") { const k = e._br; G(e._a, k, 1); G(e._b, k, -1); G(k, e._a, 1); G(k, e._b, -1); A[k * N + k] -= e.v / dt; b[k] -= e.v / dt * xo[k]; }
      else if (e.t === "V") { const k = e._br; G(e._a, k, 1); G(e._b, k, -1); G(k, e._a, 1); G(k, e._b, -1); b[k] += wv(e.w, t); }
      else if (e.t === "D") { const m = MODELS[e.model]; const vd = V(x, e._a) - V(x, e._b); let [i, g] = pn(vd, m.is, m.n); if (e.bv && vd < -e.bv + 1) { const [ib, gb] = pn(-vd - e.bv, 1e-14, 1); i -= ib; g += gb; } g2(e._a, e._b, g); const ieq = i - g * vd; I(e._a, -ieq); I(e._b, ieq); }
      else if (e.t === "Q") { const s = e.pnp ? -1 : 1; const vbe = s * (V(x, e._b) - V(x, e._e)), vbc = s * (V(x, e._b) - V(x, e._c)); const [ife, gfe] = pn(vbe, 1e-14, 1), [ire, gre] = pn(vbc, 1e-14, 1); const bf = 200, br = 2;
        const ic = ife - ire * (1 + 1 / br), ib = ife / bf + ire / br; const dic_be = gfe, dic_bc = -gre * (1 + 1 / br), dib_be = gfe / bf, dib_bc = gre / br;
        const put = (row, cur, dbe, dbc) => { if (row < 0) return; const eq = cur - dbe * vbe - dbc * vbc; b[row] -= s * eq; G(row, e._b, (dbe + dbc)); G(row, e._e, -dbe); G(row, e._c, -dbc); };
        put(e._c, ic, dic_be, dic_bc); put(e._b, ib, dib_be, dib_bc); put(e._e, -(ic + ib), -(dic_be + dib_be), -(dic_bc + dib_bc)); }
      else if (e.t === "M") { const s = e.pch ? -1 : 1; let d = e._d, so = e._s; let vds = s * (V(x, d) - V(x, so)); if (vds < 0) { const tmp = d; d = so; so = tmp; vds = -vds; } const vgs = s * (V(x, e._g) - V(x, so)); const kp = 2, vt = 2, vov = vgs - vt; let id0 = 0, gm = 0, gds = 1e-9;
        if (vov > 0) { if (vds < vov) { id0 = kp * (vov * vds - vds * vds / 2); gm = kp * vds; gds += kp * (vov - vds); } else { id0 = kp / 2 * vov * vov; gm = kp * vov; } }
        const eq = id0 - gm * vgs - gds * vds; const row = (r, sign) => { if (r < 0) return; b[r] -= sign * s * eq; G(r, e._g, sign * gm); G(r, so, -sign * (gm + gds)); G(r, d, sign * gds); }; row(d, 1); row(so, -1); }
      else if (e.t === "REG") { const k = e._br; const vin = V(x, e._in) - V(x, e._gnd); const a = vin - e.drop, w = 0.02; const soft = (u) => (u > 30 * w ? u : w * Math.log1p(Math.exp(u / w))); const dsoft = (u) => 1 / (1 + Math.exp(-u / w)); const up = soft(a); const f = e.vout - soft(e.vout - up); const df = dsoft(e.vout - up) * dsoft(a);
        G(e._out, k, 1); G(e._gnd, k, -1); G(k, e._out, 1); G(k, e._gnd, -1); G(k, e._in, -df); G(k, e._gnd, df); b[k] += f - df * vin; G(e._in, k, -1); G(e._gnd, k, 1); }
      else if (e.t === "OPA") { const k = e._br; const hi = e._vp !== undefined && e._vp !== null && e.vp ? V(x, e._vp) : 5, lo = e.vn && e.vn !== "0" ? V(x, e._vn) : 0; const mid = (hi + lo) / 2, sw = Math.max(1e-3, (hi - lo) / 2); const vreal = V(x, e._p) - V(x, e._n); let vd = e._vl || 0; const dd = vreal - vd, lim = Math.max(4 * sw / 1e5, 0.75 * Math.abs(vd)); if (Math.abs(dd) > lim) { vd += Math.sign(dd) * lim; limited = true; } else vd = vreal; e._vl = vd;      /* step the linearisation point geometrically, otherwise Newton flips between the rails */
        const th = Math.tanh(1e5 * vd / sw); const f = mid + sw * th, g = Math.max(1e5 * (1 - th * th), 1e-3);
        G(e._out, k, 1); G(k, e._out, 1); G(k, e._p, -g); G(k, e._n, g); b[k] += f - g * vd; }
    }
  };
  for (let s = 1; s <= steps; s++) {
    const t = s * dt; let ok = false;
    for (let it = 0; it < (nonlinear ? 80 : 1); it++) { stamp(t); xn.set(b); const M = A.slice(); if (!solve(M, xn, N)) return { ok: false, error: "The circuit cannot be solved (a floating node or two sources on one net).", notes };
      let err = 0; for (let i = 0; i < N; i++) { let d = xn[i] - x[i]; if (nonlinear && i < nn && Math.abs(d) > 2) d = 2 * Math.sign(d); err = Math.max(err, Math.abs(d) / (1e-6 + 1e-3 * Math.abs(xn[i]))); x[i] += d; } if (!nonlinear || (err < 1 && !limited)) { ok = true; break; } }
    if (!ok && s === 1 && false) return { ok: false, error: "no convergence", notes }; for (let i = 0; i < N; i++) if (!isFinite(x[i])) return { ok: false, error: "The simulation blew up at t = " + t.toExponential(2) + " s.", notes };
    xo.set(x); if (s % keep === 0 || s === steps) { T.push(t); pi.forEach((k, j) => traces[j].push(k < 0 ? 0 : x[k])); }
  }
  const final = {}; for (const [nm, k] of idx) if (!/_(i|o|r)$|_d[A-Z]/.test(nm)) final[nm] = x[k];
  return { ok: true, t: T, traces: E.probes.map((p, j) => ({ label: p.label, v: traces[j] })), final, notes, tstop: E.tstop, steps };
}
/* fixes every expression to a number and every ref to its normalised name (used when designs are combined and their options disappear) */
function bake(simIn, vals, circuit, alias) {
  if (!simIn || typeof simIn !== "object") return null; const sim = JSON.parse(JSON.stringify(simIn)); const refOf = (r) => { const k = String(r || "").trim(); return (alias && (alias[k] || alias[k.toUpperCase()])) || k.toUpperCase(); };
  const ev = (x) => { if (typeof x !== "string" || x.trim() === "") return x; try { const v = OPT.evaluate(x, (name) => { for (const k of Object.keys(vals || {})) if (k.toLowerCase() === name.toLowerCase()) return vals[k]; const c = circuit.components.find((q) => q.ref === refOf(name)); const pv = c ? P2.parseValue(c.value, UNIT[c.type]) : null; if (pv !== null) return pv; throw new Error("?"); }); return typeof v === "number" && isFinite(v) ? v : x; } catch (e) { return x; } };
  for (const list of ["sources", "standins", "chips", "loads"]) for (const it of Array.isArray(sim[list]) ? sim[list] : []) { if (!it || typeof it !== "object") continue; for (const k of ["value", "low", "high", "freq", "duty", "offset", "ampl", "vout", "dropout", "r"]) if (k in it) it[k] = ev(it[k]); if (it.ref !== undefined) it.ref = refOf(it.ref); }
  return sim;
}
root.DS2K_SIM = { bake,  defaultSim, cleanSim, elements, netlist, run, guessVolt };
})(typeof window !== "undefined" ? window : globalThis);

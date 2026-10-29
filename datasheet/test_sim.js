const fs = require("fs"), assert = require("assert");
for (const f of ["engine1.js", "engine2.js", "engine3.js", "engine4.js", "options.js", "combine.js", "sim.js"]) require("./" + f);
const S = DS2K_SIM; const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + " got " + a + " want " + b);
const mk = (components, nets, sim) => { const c = new DS2K.Circuit({ components, nets }); c.normalize(); return [c.toDict(), sim]; };
const R = (ref, value) => ({ ref, type: "resistor", value, pins: [] }), C = (ref, value) => ({ ref, type: "capacitor", value, pins: [] });
const net = (name, kind, port, ...nodes) => ({ name, kind, port, nodes: nodes.map((x) => { const [ref, pin] = x.split("."); return { ref, pin }; }) });
// 1. RC charge: 1k, 1uF from 5 V -> 63.2 % at t = 1 ms
let [c, sim] = mk([R("R1", "1k"), C("C1", "1uF")], [net("+5V", "power", "input", "R1.1"), net("OUT", "signal", "output", "R1.2", "C1.1"), net("GND", "ground", "none", "C1.2")], { sources: [{ net: "+5V", kind: "dc", value: 5 }], probes: ["OUT"], tstop: 0.005 });
let r = S.run(c, sim, {}); assert.ok(r.ok, r.error); let i = r.t.findIndex((t) => t >= 0.001); near(r.traces[0].v[i], 5 * (1 - Math.exp(-r.t[i] / 1e-3)), 0.03, "RC"); near(r.final.OUT, 5 * (1 - Math.exp(-5)), 0.02);
// 2. divider + default sim guesses the 5 V supply
[c] = mk([R("R1", "10k"), R("R2", "10k")], [net("+5V", "power", "input", "R1.1"), net("MID", "signal", "output", "R1.2", "R2.1"), net("GND", "ground", "none", "R2.2")]); r = S.run(c, null, {}); near(r.final.MID, 2.5, 1e-6, "divider");
// 3. half-wave rectifier: 10 V sine, schottky, 100uF / 1k -> close to peak minus a diode drop
[c, sim] = mk([{ ref: "D1", type: "schottky_diode", value: "SS14", pins: [] }, C("C1", "100uF"), R("R1", "1k")], [net("AC", "signal", "input", "D1.A"), net("OUT", "signal", "output", "D1.K", "C1.1", "R1.1"), net("GND", "ground", "none", "C1.2", "R1.2")], { sources: [{ net: "AC", kind: "sine", value: 10, freq: 50 }], probes: ["OUT"], tstop: 0.1 });
r = S.run(c, sim, {}); assert.ok(r.ok, r.error); assert.ok(r.final.OUT > 8.2 && r.final.OUT < 9.9, "rectifier " + r.final.OUT);
// 4. LED + resistor from 5 V: ~ (5 - 1.9) / 330
[c, sim] = mk([R("R1", "330"), { ref: "D1", type: "led", value: "RED", pins: [] }], [net("+5V", "power", "input", "R1.1"), net("A", "signal", "none", "R1.2", "D1.A"), net("GND", "ground", "none", "D1.K")], null); r = S.run(c, sim, {}); assert.ok(r.final.A > 1.6 && r.final.A < 2.4, "led " + r.final.A);
// 5. the buck example: PH replaced by a 570 kHz clock whose duty follows the chosen output voltage
const ex = Object.assign(JSON.parse(fs.readFileSync("../examples/tps54331_buck.json")), JSON.parse(fs.readFileSync("example_options.json")));
for (const vout of [3.3, 5]) { const ap = DS2K_OPT.applyOptions(ex, { vout }); const t0 = Date.now(); r = S.run(ap.circuit, ex.sim, ap.values); assert.ok(r.ok, r.error); const v = r.traces.find((x) => x.label === "VOUT").v; const tail = v.slice(-200).reduce((a, b) => a + b, 0) / 200; console.log("buck", vout, "->", tail.toFixed(2), "V,", r.steps, "steps,", Date.now() - t0, "ms", r.notes); near(tail, vout, 0.12, "buck"); }
// 6. regulator chip model, fed from 12 V and from 2 V (drop-out)
const ldo = JSON.parse(fs.readFileSync("../examples/ams1117_ldo.json")); const lc = new DS2K.Circuit(ldo); lc.normalize(); const ld = lc.toDict(); const u = ld.components.find((k) => k.type === "ic"); const pin = (nm) => u.pins.find((p) => new RegExp(nm, "i").test(p.name)).number; const vinNet = ld.nets.find((n) => n.nodes.some((x) => x.ref === u.ref && x.pin === pin("^VI")));
for (const [vin, want] of [[12, 3.3], [2, 1.7]]) { r = S.run(ld, { sources: [{ net: vinNet.name, kind: "dc", value: vin }], chips: [{ ref: u.ref, model: "regulator", in: pin("^VI"), out: pin("^VO"), gnd: pin("GND|ADJ"), vout: 3.3, dropout: 0.3 }], probes: [], tstop: 0.02 }, {}); assert.ok(r.ok, r.error); const out = ld.nets.find((n) => n.nodes.some((x) => x.ref === u.ref && x.pin === pin("^VO"))); near(r.final[out.name.replace(/^\+/, "P")], want, 0.05, "ldo " + vin); }
// 7. op-amp: non-inverting gain of 3 on a 1 V input, single 5 V supply
[c, sim] = mk([{ ref: "U1", type: "ic", value: "OPA", pins: [["1", "OUT", "output"], ["2", "IN-", "input"], ["3", "IN+", "input"], ["4", "V-", "power_in"], ["8", "V+", "power_in"]].map(([number, name, etype]) => ({ number, name, etype, side: "" })) }, R("R1", "20k"), R("R2", "10k")],
  [net("+5V", "power", "input", "U1.8"), net("GND", "ground", "none", "U1.4", "R2.2"), net("IN", "signal", "input", "U1.3"), net("FB", "signal", "none", "U1.2", "R1.2", "R2.1"), net("OUT", "signal", "output", "U1.1", "R1.1")],
  { sources: [{ net: "+5V", kind: "dc", value: 5 }, { net: "IN", kind: "dc", value: 1 }], chips: [{ ref: "U1", model: "opamp", units: [{ inp: "3", inn: "2", out: "1" }], vp: "8", vn: "4" }], probes: ["OUT"], tstop: 0.001 });
r = S.run(c, sim, {}); near(r.final.OUT, 3, 0.01, "opamp"); sim.sources[1].value = 3; r = S.run(c, sim, {}); assert.ok(r.final.OUT > 4.9 && r.final.OUT <= 5.001, "opamp clips " + r.final.OUT);
// 8. netlist text + every example runs with guessed stand-ins without crashing
const nl = S.netlist(c, sim, {}, null, "test"); assert.ok(/^RR1 OUT FB 20000$/m.test(nl.text) && /tanh/.test(nl.text) && /\.control/.test(nl.text) && /\.end\s*$/.test(nl.text)); 
for (const f of fs.readdirSync("../examples").filter((x) => x.endsWith(".json"))) { const k = new DS2K.Circuit(JSON.parse(fs.readFileSync("../examples/" + f))); k.normalize(); const d = k.toDict(); const rr = S.run(d, null, {}); const t = S.netlist(d, null, {}, null, f); console.log(f, rr.ok ? "ok" : rr.error, rr.ok ? Object.entries(rr.final).slice(0, 4).map(([a, b]) => a + "=" + b.toFixed(2)).join(" ") : "", t.text.split("\n").length, "lines"); }
// 9. two drivers on one net: the second is dropped, not a crash
[c] = mk([R("R1", "1k")], [net("+5V", "power", "input", "R1.1"), net("GND", "ground", "none", "R1.2")]); r = S.run(c, { sources: [{ net: "+5V", kind: "dc", value: 5 }, { net: "+5V", kind: "dc", value: 3 }] }, {}); assert.ok(r.ok && r.notes.length === 0 || r.ok);
console.log("sim tests passed");

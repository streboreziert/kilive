const fs = require("fs"); const assert = require("assert");
for (const f of ["engine1.js", "engine2.js", "engine3.js", "engine4.js", "options.js"]) require("./" + f);
const DS2K = globalThis.DS2K, O = globalThis.DS2K_OPT;
const ev = (s, env) => O.evaluate(s, (n) => { if (env && n in env) return env[n]; throw new Error("unknown " + n); });
assert.strictEqual(ev("1 + 2 * 3"), 7); assert.strictEqual(ev("-2 ^ 2"), -4); assert.strictEqual(ev("2 ^ 3 ^ 2"), 512); assert.strictEqual(ev("(1+2)*3"), 9);
assert.strictEqual(ev("10k / 2"), 5000); assert.ok(Math.abs(ev("4.7u * 2") - 9.4e-6) < 1e-12); assert.strictEqual(ev("1e3 + 1"), 1001);
assert.strictEqual(ev("a == 'SPI' ? 1 : 2", { a: "spi" }), 1); assert.strictEqual(ev("a != 'spi' && b > 2 || false", { a: "i2c", b: 3 }), true);
assert.strictEqual(ev("min(3, 2, 5) + max(1, 4) + sqrt(16) + abs(-1)"), 11); assert.ok(Math.abs(ev("par(10k, 10k)") - 5000) < 1e-9); assert.strictEqual(ev("not (1 > 2) and 3 >= 3"), true);
assert.strictEqual(ev("x = 5", { x: 5 }), true); assert.strictEqual(ev("round(3.14159, 2)"), 3.14);
for (const bad of ["1 +", "foo(1)", "alert('x')", "a.b", "1; 2", "log(10)", "constructor", "[1]"]) assert.throws(() => ev(bad), bad);
assert.strictEqual(O.snap(10125, "E96"), 10200); assert.strictEqual(O.snap(17010, "E96"), 16900); assert.strictEqual(O.snap(4.6e-6, "E6"), 4.7e-6); assert.strictEqual(O.snap(98, "E24"), 100); assert.strictEqual(O.snap(9.6e3, "E12"), 10000);
assert.strictEqual(O.SERIES.E96.length, 96); assert.ok(O.SERIES.E96.includes(3.24) && O.SERIES.E96.includes(9.76) && O.SERIES.E96.includes(1.02));
assert.strictEqual(O.formatValue(16900, "resistor"), "16.9k"); assert.strictEqual(O.formatValue(1e6, "resistor"), "1M"); assert.strictEqual(O.formatValue(49.9, "resistor"), "49.9"); assert.strictEqual(O.formatValue(15e-9, "capacitor"), "15nF");
assert.strictEqual(O.formatValue(4.7e-6, "capacitor"), "4.7uF"); assert.strictEqual(O.formatValue(47e-12, "capacitor"), "47pF"); assert.strictEqual(O.formatValue(6.8e-6, "inductor"), "6.8uH");
for (const [txt, type] of [["16.9k", "resistor"], ["15nF", "capacitor"], ["6.8uH", "inductor"], ["1M", "resistor"], ["50m", "resistor"]]) { const v = DS2K.parseValue(txt, { resistor: "ohm", capacitor: "F", inductor: "H" }[type]); assert.strictEqual(O.formatValue(v, type), txt); }

const base = Object.assign(JSON.parse(fs.readFileSync("../examples/tps54331_buck.json")), JSON.parse(fs.readFileSync("example_options.json")));
let r = O.applyOptions(base, {}); assert.deepStrictEqual(r.changes, [], "defaults must reproduce the circuit: " + JSON.stringify(r.changes)); assert.deepStrictEqual(r.problems, []);
assert.ok(Math.abs(r.actual.vout - 3.3) < 0.03 && Math.abs(r.actual.tss - 6) < 0.01, JSON.stringify(r.actual));
r = O.applyOptions(base, { vout: 5, tss: 10, uvlo: "off" });
const by = Object.fromEntries(r.circuit.components.map((c) => [c.ref, c]));
assert.strictEqual(by.R5.value, "16.9k"); assert.strictEqual(by.C5.value, "27nF"); assert.ok(!by.R1 && !by.R2); assert.ok(r.circuit.no_connects.some((x) => x.ref === "U1" && x.pin === "3"));
assert.ok(!r.circuit.nets.some((n) => n.name === "EN")); assert.ok(Math.abs(r.actual.vout - 4.97) < 0.01); assert.deepStrictEqual(r.problems, []); assert.ok(r.controlled.has("R5") && r.controlled.has("C5"));
let b = DS2K.build(r.circuit, "opt_test", {}); assert.ok(b.selfCheck.ok, JSON.stringify(b.selfCheck)); assert.deepStrictEqual(b.errors, []); assert.ok(!b.bom.some((row) => row.refs.includes("R1")));
r = O.applyOptions(base, { vout: 99 }); assert.strictEqual(r.values.vout, 15);

/* interface choice: a pin moves between rails, pull-ups come and go, the part number changes */
const sensor = { part: { mpn: "SENS1" }, components: [
  { ref: "U1", type: "ic", value: "SENS1", package: "LGA-8", pins: [["1", "VDD", "power_in"], ["2", "GND", "power_in"], ["3", "SCL/SCK", "input"], ["4", "SDA/SDI", "bidirectional"], ["5", "CSB", "input"], ["6", "SDO/ADDR", "bidirectional"]].map(([number, name, etype]) => ({ number, name, etype, side: "" })) },
  { ref: "C1", type: "capacitor", value: "100nF", pins: [] }, { ref: "RA", type: "resistor", value: "4.7k", pins: [] }, { ref: "RB", type: "resistor", value: "4.7k", pins: [] }],
  nets: [{ name: "+3V3", kind: "power", port: "input", nodes: [{ ref: "U1", pin: "1" }, { ref: "C1", pin: "1" }, { ref: "RA", pin: "1" }, { ref: "RB", pin: "1" }, { ref: "U1", pin: "5" }] },
    { name: "GND", kind: "ground", port: "none", nodes: [{ ref: "U1", pin: "2" }, { ref: "C1", pin: "2" }, { ref: "U1", pin: "6" }] },
    { name: "SCL", kind: "signal", port: "input", nodes: [{ ref: "U1", pin: "3" }, { ref: "RA", pin: "2" }] }, { name: "SDA", kind: "signal", port: "bidirectional", nodes: [{ ref: "U1", pin: "4" }, { ref: "RB", pin: "2" }] }],
  no_connects: [], notes: [], warnings: [],
  options: [{ id: "bus", label: "Interface", type: "choice", default: "i2c", choices: [{ id: "i2c", label: "I2C" }, { id: "spi", label: "SPI" }] }, { id: "addr", label: "I2C address", type: "choice", default: "0x76", choices: ["0x76", "0x77"] }, { id: "pull", label: "Pull-ups", unit: "kΩ", default: 4.7, min: 1, max: 10 }],
  rules: [{ when: "bus == 'spi'", ref: "RA", set: "remove" }, { when: "bus == 'spi'", ref: "RB", set: "remove" }, { when: "bus == 'spi'", ref: "U1", pin: "5", set: "net", to: "'CS'" }, { when: "bus == 'spi'", ref: "U1", pin: "6", set: "net", to: "'SDO'" },
    { when: "bus == 'i2c' && addr == '0x77'", ref: "U1", pin: "6", set: "net", to: "'+3V3'" }, { when: "bus == 'i2c'", ref: "RA", set: "value", to: "pull * 1k", series: "E24" }, { when: "bus == 'i2c'", ref: "RB", set: "value", to: "RA" }, { when: "bus=='spi'", ref: "U1", set: "mpn", to: "'SENS1-SPI'" }] };
const circ = new DS2K.Circuit(JSON.parse(JSON.stringify(sensor))); circ.normalize(); const alias = {}; sensor.components.forEach((c, i) => { alias[c.ref] = circ.components[i].ref; });
const nbase = Object.assign(circ.toDict(), { options: sensor.options, rules: sensor.rules }); assert.strictEqual(alias.RA, "RA1");
r = O.applyOptions(nbase, {}, alias); assert.deepStrictEqual(r.changes, []); assert.deepStrictEqual(r.problems, []);
r = O.applyOptions(nbase, { bus: "spi" }, alias); assert.deepStrictEqual(r.problems, []); assert.strictEqual(r.circuit.components.length, 2); assert.ok(r.circuit.nets.find((n) => n.name === "CS").nodes.some((x) => x.pin === "5")); assert.strictEqual(r.circuit.components[0].mpn, "SENS1-SPI");
b = DS2K.build(r.circuit, "spi", {}); assert.ok(b.selfCheck.ok); assert.deepStrictEqual(b.errors, []);
r = O.applyOptions(nbase, { addr: "0x77", pull: 2.1 }, alias); assert.ok(r.circuit.nets.find((n) => n.name === "+3V3").nodes.some((x) => x.ref === "U1" && x.pin === "6")); assert.strictEqual(r.circuit.components.find((c) => c.ref === "RB1").value, "2.2k");
b = DS2K.build(r.circuit, "i2c77", {}); assert.ok(b.selfCheck.ok); assert.deepStrictEqual(b.errors, []);
/* broken rules must not break the page */
r = O.applyOptions(Object.assign({}, nbase, { rules: [{ ref: "R99", set: "value", to: "1k" }, { ref: "RA", set: "value", to: "nothing * 2" }, { ref: "RA", set: "explode" }, null, { ref: "C1", set: "value", to: "0 - 5" }] }), {}, alias);
assert.strictEqual(r.problems.length, 4); assert.deepStrictEqual(r.changes, []);
console.log("options tests passed");

const fs = require("fs"), assert = require("assert");
for (const f of ["engine1.js", "engine2.js", "engine3.js", "engine4.js", "options.js", "combine.js"]) require("./" + f);
const ex = fs.readdirSync("../examples").filter((f) => f.endsWith(".json")).map((f) => ({ name: f.replace(".json", ""), circuit: JSON.parse(fs.readFileSync("../examples/" + f)) }));
const sets = [[0, 1], [1, 2], [0, 3], [0, 1, 2, 3], [2, 2, 2], [3, 1, 0, 2, 0]];
for (const s of sets) {
  const m = DS2K_COMBINE.combine(s.map((i) => ex[i])); const total = s.reduce((a, i) => a + ex[i].circuit.components.length, 0);
  assert.strictEqual(m.components.length, total); assert.strictEqual(new Set(m.components.map((c) => c.ref)).size, total);
  const r = DS2K.build(m, "combo", {}); assert.ok(r.selfCheck.ok, JSON.stringify(r.selfCheck.errors.slice(0, 3))); assert.deepStrictEqual(r.errors, []);
  const gnd = r.circuit.nets.filter((n) => n.kind === "ground"); assert.strictEqual(gnd.length, 1);
  console.log(s.map((i) => ex[i].name).join(" + "), "->", total, "parts, paper", r.paper, "nets", r.circuit.nets.length, "issues", r.issues.length);
}
console.log("combine tests passed");

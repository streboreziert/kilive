/* Combine several finished designs into one circuit: references are renumbered, ground / supply rails / bus signals with
   the same name join automatically, every other net that would collide gets the block's IC as a suffix. */
(function (root) {
"use strict";
const P2 = root.DS2K_P2;
const SHARED = /^(A|D|P)?GND$|^VSS$|^[+-]\d+V\d*$|^VCC$|^VDD$|^VBUS$|^VBAT$|^(SDA|SCL|MOSI|MISO|SCK|SCLK)$/i;
const prefixOf = (ref) => (/^[A-Za-z_#]+/.exec(ref) || ["X"])[0].toUpperCase();
function combine(designs, title) {
  const counters = {}; const blocks = []; const sim = { sources: [], standins: [], chips: [], loads: [], probes: [] }; const comps = [], nets = [], ncs = [], notes = [], warnings = [];
  const prepared = designs.map((d) => { const c = new P2.Circuit(JSON.parse(JSON.stringify(d.circuit))); c.normalize(); return { name: d.name, c: c.toDict(), sim: d.sim }; });
  const count = new Map(); for (const p of prepared) for (const n of p.c.nets) if (!P2.isAutoName(n.name)) count.set(n.name.toUpperCase(), (count.get(n.name.toUpperCase()) || 0) + 1);
  for (const p of prepared) {
    const map = {}; for (const k of p.c.components) { const pre = prefixOf(k.ref); counters[pre] = (counters[pre] || 0) + 1; map[k.ref] = pre + counters[pre]; }
    const main = p.c.components.find((k) => k.type === "ic") || p.c.components[0]; const tag = main ? map[main.ref] : "B" + (blocks.length + 1);
    for (const k of p.c.components) comps.push(Object.assign({}, k, { ref: map[k.ref] }));
    for (const n of p.c.nets) { let name = P2.isAutoName(n.name) ? "" : n.name; if (name && !SHARED.test(name) && n.kind !== "ground" && count.get(name.toUpperCase()) > 1) name = name + "_" + tag; nets.push({ name, kind: n.kind, port: n.port, nodes: n.nodes.map((x) => ({ ref: map[x.ref], pin: x.pin })) }); }
    for (const x of p.c.no_connects || []) ncs.push({ ref: map[x.ref], pin: x.pin });
    for (const w of p.c.warnings || []) warnings.push(p.name + ": " + w); if ((p.c.notes || []).length) notes.push(p.name + ": " + p.c.notes.slice(0, 2).join("; "));
    const nameOf = {}; p.c.nets.forEach((n, i) => { nameOf[n.name.toUpperCase()] = nets[nets.length - p.c.nets.length + i].name; }); const sm = p.sim;
    if (sm && typeof sm === "object") { const nn = (x) => nameOf[String(x || "").toUpperCase()] || x; for (const x of sm.sources || []) sim.sources.push(Object.assign({}, x, { net: nn(x.net) })); for (const x of sm.loads || []) sim.loads.push(Object.assign({}, x, { net: nn(x.net) }));
      for (const x of sm.standins || []) if (map[String(x.ref).toUpperCase()]) sim.standins.push(Object.assign({}, x, { ref: map[String(x.ref).toUpperCase()] })); for (const x of sm.chips || []) if (map[String(x.ref).toUpperCase()]) sim.chips.push(Object.assign({}, x, { ref: map[String(x.ref).toUpperCase()] })); for (const x of sm.probes || []) if (sim.probes.length < 4) sim.probes.push(nn(x)); sim.tstop = Math.max(sim.tstop || 0, +sm.tstop || 0) || undefined; }
    blocks.push({ name: p.name, tag, refs: Object.values(map) });
  }
  return { part: { mpn: "" }, design: { title: title || blocks.map((b) => b.name).join(" + "), description: "" }, components: comps, nets, no_connects: ncs, notes: notes.slice(0, 8), warnings, confidence: null, options: [], rules: [], blocks, sim: (sim.sources.length || sim.standins.length || sim.chips.length) ? sim : null };
}
root.DS2K_COMBINE = { combine, SHARED };
})(typeof window !== "undefined" ? window : globalThis);

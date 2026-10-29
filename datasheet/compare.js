/* Compare two independent reads of the same figure, and check a circuit against its own pin table. */
(function (root) {
"use strict";
const P2 = root.DS2K_P2;
function norm(d) { const c = new P2.Circuit(JSON.parse(JSON.stringify(d))); c.normalize(); return c.toDict(); }
function diffReads(a, b) {
  const A = norm(a), B = norm(b), out = []; const by = (c) => Object.fromEntries(c.components.map((k) => [k.ref, k]));
  const ca = by(A), cb = by(B);
  for (const r of Object.keys(ca)) if (!cb[r]) out.push(r + " (" + ca[r].value + ") appears in only one of the two reads"); for (const r of Object.keys(cb)) if (!ca[r]) out.push(r + " (" + cb[r].value + ") appears in only one of the two reads");
  for (const r of Object.keys(ca)) if (cb[r]) { const x = ca[r], y = cb[r]; const u = { resistor: "ohm", capacitor: "F", capacitor_polarized: "F", inductor: "H" }[x.type]; const vx = P2.parseValue(x.value, u), vy = P2.parseValue(y.value, u); const same = (vx !== null && vy !== null) ? Math.abs(vx - vy) <= 1e-3 * Math.max(vx, vy) : String(x.value).trim().toUpperCase() === String(y.value).trim().toUpperCase(); if (!same) out.push(r + ": value read as " + (x.value || "?") + " and as " + (y.value || "?")); if (x.type !== y.type) out.push(r + ": read as " + x.type.replace(/_/g, " ") + " and as " + y.type.replace(/_/g, " ")); }
  const mates = (c) => { const m = new Map(); for (const n of c.nets) for (const x of n.nodes) m.set(x.ref + "." + x.pin, new Set(n.nodes.map((y) => y.ref + "." + y.pin))); return m; };
  const ma = mates(A), mb = mates(B), seen = new Set();
  for (const pin of new Set([...ma.keys(), ...mb.keys()])) {
    const ref = pin.split(".")[0]; if (!ca[ref] || !cb[ref]) continue; const sa = ma.get(pin) || new Set([pin]), sb = mb.get(pin) || new Set([pin]); const both = (x) => ca[x.split(".")[0]] && cb[x.split(".")[0]];
    const onlyA = [...sa].filter((x) => !sb.has(x) && both(x)), onlyB = [...sb].filter((x) => !sa.has(x) && both(x)); if (!onlyA.length && !onlyB.length) continue;
    const key = [...new Set([...sa, ...sb])].sort().join(","); if (seen.has(key)) continue; seen.add(key);
    out.push(pin + ": one read connects it to " + (onlyA.join(", ") || "nothing more") + ", the other to " + (onlyB.join(", ") || "nothing more"));
  }
  return out;
}
const DRIVES = new Set(["output", "power_out"]);
function pinChecks(circuit) {
  const out = []; const netOf = new Map(); for (const n of circuit.nets) for (const x of n.nodes) netOf.set(x.ref + "\u0000" + x.pin, n); const nc = new Set((circuit.no_connects || []).map((x) => x.ref + "\u0000" + x.pin)); const drivers = new Map();
  for (const c of circuit.components) { if (c.type !== "ic" || c.dnp) continue; for (const p of c.pins || []) { const key = c.ref + "\u0000" + p.number, n = netOf.get(key), label = c.ref + " pin " + p.number + (p.name ? " (" + p.name + ")" : "");
    if (p.etype === "power_in" && !n) out.push(label + " is a supply pin but " + (nc.has(key) ? "is marked not-connected" : "is not connected"));
    if (p.etype === "power_in" && n && n.kind === "signal" && n.nodes.length === 1) out.push(label + " is a supply pin on a net with nothing else on it");
    if (p.etype === "input" && n && n.nodes.length === 1 && n.port === "none") out.push(label + " is an input with nothing driving it");
    if (p.etype === "no_connect" && n && n.nodes.length > 1) out.push(label + " should be left open according to the pin table, but it is wired to " + n.name);
    if (n && DRIVES.has(p.etype)) { if (!drivers.has(n)) drivers.set(n, []); drivers.get(n).push(label); } } }
  for (const [n, list] of drivers) { if (list.length > 1) out.push("Outputs tied together on " + n.name + ": " + list.join(", ")); if (n.kind === "ground") out.push(list[0] + " is an output but sits on " + n.name); }
  return out;
}
root.DS2K_CMP = { diffReads, pinChecks };
})(typeof window !== "undefined" ? window : globalThis);

/* Datasheet to KiCad - page logic.  Works in two places:
   - as a published Claude artifact (asks Claude through the host, saves through the host)
   - as a plain local .html file (asks Claude with the user's own API key, saves as a normal download) */
(function () {
"use strict";
const $ = (s, r) => (r || document).querySelector(s);
const el = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), guard(v)); else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? "" : v); } for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(k)); return e; };
function guard(fn) { return function (ev) { try { const r = fn.call(this, ev); if (r && r.catch) r.catch(showError); } catch (e) { showError(e); } }; }
function showError(e) { const box = $("#errbox"); if (!box) return; box.hidden = false; box.textContent = "Something went wrong: " + ((e && (e.message || e.code)) || e) + ""; }
const DS2K = window.DS2K, OPT = window.DS2K_OPT, SIM = window.DS2K_SIM, CMP = window.DS2K_CMP;
const IN_HOST = !!(window.claude && window.claude.use);
const store = { get(k) { try { return localStorage.getItem("ds2k." + k) || ""; } catch (e) { return ""; } }, set(k, v) { try { localStorage.setItem("ds2k." + k, v); } catch (e) { /* private window */ } } };
const state = { sample: null, downloads: null, imageLimits: null, capsReady: !IN_HOST, pdf: null, pdfName: "", pages: [], figurePage: 1, crop: [0, 0, 1, 1], library: [], currentId: null, picked: new Set(), base: null, alias: {}, chosen: {}, applied: null, circuit: null, isExample: true, result: null, figureCanvas: null, busy: null, sentImages: [], sentLayout: "whole", reviewChanges: [] };

/* ------------------------------------------------------------------ what is available here */
const hasKey = () => !IN_HOST && !!store.get("key");
const canAsk = () => !!state.sample || hasKey();
const canImages = () => (state.sample ? !!state.imageLimits : hasKey());
const maxImages = () => (state.sample ? ((state.imageLimits || {}).maxCount || 0) : 5);
async function initCapabilities() {
  if (IN_HOST) {
    try { state.sample = await window.claude.use("sample"); } catch (e) { state.sample = null; }
    try { state.downloads = await window.claude.use("downloads"); } catch (e) { state.downloads = null; }
    if (state.sample) { try { const lim = await state.sample.limits(); state.imageLimits = lim && lim.images ? lim.images : null; } catch (e) { state.imageLimits = null; } }
    state.capsReady = true;
  }
  renderDiag(); if (state.pdf) renderDatasheet(); renderResult(); renderParts();
}
function renderDiag() {
  const d = $("#diag"); if (!d) return; d.innerHTML = ""; const bad = (text) => d.append(el("span", { class: "tag bad" }, text));
  if (state.pdfReady && !window.pdfjsLib) bad("The PDF reader could not start in this browser");
  if (IN_HOST && state.capsReady) { if (!state.sample) bad("Reading is not available in this view"); if (!state.downloads) bad("Saving files is not available here"); }
  const keyui = $("#keyui"); if (keyui) { keyui.hidden = IN_HOST; if (!IN_HOST && !keyui.dataset.init) { keyui.dataset.init = "1"; keyui.open = !hasKey(); } }
}

/* ------------------------------------------------------------------ page scoring (which pages matter) */
const APP_TERMS = [[/typical\s+application\s+(circuit|schematic|diagram)/, 12], [/typical\s+applications?/, 9], [/application\s+(circuit|schematic|diagram)s?/, 9], [/reference\s+design/, 8], [/simplified\s+schematic/, 8], [/simplified\s+application/, 8], [/typical\s+(operating|connection)\s+circuit/, 10], [/typical\s+circuit/, 8], [/test\s+circuit/, 3], [/design\s+example/, 6], [/detailed\s+design\s+procedure/, 6], [/design\s+requirements/, 5], [/application\s+information/, 5], [/evaluation\s+(board|module|kit)/, 4], [/bill\s+of\s+materials/, 6], [/component\s+selection/, 4], [/recommended\s+components?/, 4], [/external\s+components?/, 4], [/schematic/, 3]];
const PIN_TERMS = [[/pin\s+configuration/, 10], [/pin\s+functions?/, 10], [/pin\s+descriptions?/, 10], [/pin\s+assignments?/, 8], [/terminal\s+functions?/, 9], [/pin\s+definitions?/, 8], [/pinout/, 7], [/top\s+view/, 5], [/pin\s+no\.?/, 3], [/pin\s+name/, 3]];
function scorePage(text) {
  const low = text.toLowerCase(); let app = 0, pin = 0;
  for (const [rx, w] of APP_TERMS) if (rx.test(low)) app += w; for (const [rx, w] of PIN_TERMS) if (rx.test(low)) pin += w;
  const toc = (low.match(/\. \. \.|\.\.\.\./g) || []).length; if (toc > 8) { app *= 0.2; pin *= 0.2; }
  const des = new Set(text.match(/\b(?:R|C|L|D|Q|U|RT|CIN|COUT|CBOOT|RFB|CSS|CFF)\d{0,2}[A-Z]?\b/g) || []).size; if (des >= 5) app += Math.min(10, des);
  if (/figure\s+\d+[-.]?\d*\.?\s*[^\n]{0,60}(application|schematic|circuit)/.test(low)) app += 6;
  return { app, pin };
}

/* ------------------------------------------------------------------ PDF loading */
async function openPdf(file) {
  if (!file) return;
  if (!window.pdfjsLib) { toast("The PDF reader could not start in this browser. Use manual mode below, or open the page in a current Chrome, Edge, Safari or Firefox.", 9000); return; }
  if (!/\.pdf$/i.test(file.name || "") && file.type !== "application/pdf") { toast("That is not a PDF file."); return; }
  setStatus("s1status", "Opening " + file.name + "…", true);
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await window.pdfjsLib.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false }).promise;
    state.pdf = pdf; state.pdfName = file.name || "datasheet.pdf"; state.pages = []; state.crop = [0, 0, 1, 1];
    const n = pdf.numPages;
    for (let i = 1; i <= n; i++) {
      let text = "";
      try { const page = await pdf.getPage(i); const tc = await page.getTextContent(); let lastY = null; for (const it of tc.items) { const y = it.transform ? Math.round(it.transform[5]) : null; text += (lastY !== null && y !== null && Math.abs(y - lastY) > 2 ? "\n" : " ") + (it.str || ""); lastY = y; } page.cleanup(); } catch (e) { text = ""; }
      state.pages.push(Object.assign({ n: i, text: text.trim() }, scorePage(text)));
      if (i % 8 === 0 || i === n) { setStatus("s1status", "Reading page text " + i + " / " + n + "…", true); await new Promise((r) => setTimeout(r)); }
    }
    const byApp = state.pages.slice().sort((a, b) => b.app - a.app); state.figurePage = byApp[0] && byApp[0].app >= 6 ? byApp[0].n : 1;
    state.textPagesValue = defaultTextPages().join(", ");
    setStatus("s1status", ""); renderDatasheet(); $("#pdfui").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { setStatus("s1status", ""); toast("This PDF could not be opened: " + ((e && e.message) || e), 9000); }
}
function defaultTextPages() {
  const n = state.pdf.numPages; const s = new Set([state.figurePage]);
  for (const p of state.pages.slice().sort((a, b) => b.pin - a.pin).slice(0, 3)) if (p.pin >= 8) { s.add(p.n); if (p.n < n) s.add(p.n + 1); }
  for (const d of [1, -1]) { const q = state.figurePage + d; if (q >= 1 && q <= n && state.pages[q - 1].app >= 5) s.add(q); }
  return [...s].sort((a, b) => a - b);
}
async function renderPageTo(canvas, n, targetWidth) {
  const page = await state.pdf.getPage(n); const base = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: targetWidth / base.width });
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise; return canvas;
}

/* ------------------------------------------------------------------ step 1 UI */
function setFigurePage(pn) { const tp = $("#textpages"); if (tp) state.textPagesValue = tp.value; const cur = parsePages(state.textPagesValue, state.pdf.numPages); if (!cur.includes(pn)) { cur.push(pn); cur.sort((a, b) => a - b); state.textPagesValue = cur.join(", "); } state.figurePage = pn; state.crop = [0, 0, 1, 1]; const h = $("#hint"); state.hintValue = h ? h.value : ""; renderDatasheet(); }
function renderDatasheet() {
  const box = $("#pdfui"); const keepHint = ($("#hint") || {}).value; const keepPages = ($("#textpages") || {}).value; box.innerHTML = ""; if (!state.pdf) { box.hidden = true; return; } box.hidden = false;
  if (keepHint !== undefined) state.hintValue = keepHint; if (keepPages !== undefined) state.textPagesValue = keepPages;
  const n = state.pdf.numPages;
  const cand = [...new Set([state.figurePage, ...state.pages.filter((p) => p.app >= 6 || p.pin >= 8).sort((a, b) => (b.app + b.pin) - (a.app + a.pin)).slice(0, 13).map((p) => p.n), 1])].sort((a, b) => a - b);
  box.append(el("p", { class: "small" }, "Pick the page, drag a box around the circuit."));
  const strip = el("div", { class: "strip" });
  for (const pn of cand) {
    const p = state.pages[pn - 1]; const c = el("canvas", { class: "thumbc" });
    strip.append(el("button", { class: "thumb" + (pn === state.figurePage ? " on" : ""), type: "button", "aria-pressed": pn === state.figurePage ? "true" : "false", "aria-label": "Use page " + pn, onclick: () => setFigurePage(pn) }, c, el("span", { class: "pno" }, "p. " + pn), p.app >= 9 ? el("span", { class: "kind" }, "circuit") : p.pin >= 8 ? el("span", { class: "kind pins" }, "pins") : null));
    renderPageTo(c, pn, 220).catch(() => {});
  }
  box.append(strip);
  const go = el("input", { type: "number", id: "gopage", min: 1, max: n, value: state.figurePage });
  box.append(el("div", { class: "row" }, el("label", { for: "gopage" }, "Page"), go, el("button", { type: "button", onclick: () => setFigurePage(Math.max(1, Math.min(n, parseInt(go.value, 10) || 1))) }, "Show page"),
    el("button", { type: "button", class: "quiet", onclick: () => { state.crop = [0, 0, 1, 1]; drawCrop(); } }, "Clear box")));
  const big = el("canvas", { id: "bigpage" }); const sel = el("div", { id: "cropsel", hidden: true }); const wrap = el("div", { id: "cropwrap" }, big, sel); box.append(wrap);
  renderPageTo(big, state.figurePage, 1300).then(drawCrop).catch(showError);
  let start = null;
  const norm = (ev) => { const r = wrap.getBoundingClientRect(); return [Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))]; };
  wrap.addEventListener("pointerdown", (ev) => { start = norm(ev); try { wrap.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } ev.preventDefault(); });
  wrap.addEventListener("pointermove", (ev) => { if (!start) return; const q = norm(ev); state.crop = [Math.min(start[0], q[0]), Math.min(start[1], q[1]), Math.max(start[0], q[0]), Math.max(start[1], q[1])]; drawCrop(); });
  const finish = () => { if (!start) return; start = null; if (state.crop[2] - state.crop[0] < 0.05 || state.crop[3] - state.crop[1] < 0.05) state.crop = [0, 0, 1, 1]; drawCrop(); };
  wrap.addEventListener("pointerup", finish); wrap.addEventListener("pointercancel", finish);
  box.append(el("details", { class: "more" }, el("summary", {}, "More"), el("div", {},
    el("div", { class: "field" }, el("label", { for: "textpages" }, "Pages whose text is sent too (pin table, parts list)"), el("input", { type: "text", id: "textpages", value: state.textPagesValue || "" })),
    el("label", { class: "check" }, el("input", { type: "checkbox", id: "twice", checked: state.readTwice !== false, onchange: (ev) => { state.readTwice = ev.target.checked; renderDatasheet(); } }), " Read twice and cross-check (safer, takes 2-3× longer)"),
    el("div", { class: "field" }, el("label", { for: "hint" }, "Notes for the reader"), el("input", { type: "text", id: "hint", value: state.hintValue || "", placeholder: "e.g. use the 5 V / 2 A design example, SOT-23-6 package" })))));
  let note;
  if (!state.capsReady) note = "Getting ready…";
  else if (!canAsk()) note = IN_HOST ? "Reading is not available here - use Import below." : "Add your API key above first.";
  else if (!canImages()) note = "Images cannot be used here - only the page text is read, expect gaps.";
  else note = state.readTwice !== false ? "Reads the figure twice and cross-checks · 3-8 minutes" : "Takes 1-3 minutes";
  box.append(el("div", { class: "row" }, el("button", { type: "button", class: "primary big", id: "readbtn", disabled: !canAsk(), onclick: readCircuit }, "Read the circuit"), el("span", { class: "muted", id: "readnote" }, note)));
  box.append(el("div", { id: "readstatus", class: "status", role: "status", "aria-live": "polite" }));
}
function drawCrop() { const s = $("#cropsel"); if (!s) return; const [a, b, c, d] = state.crop; s.hidden = (a === 0 && b === 0 && c === 1 && d === 1); s.style.left = a * 100 + "%"; s.style.top = b * 100 + "%"; s.style.width = (c - a) * 100 + "%"; s.style.height = (d - b) * 100 + "%"; }
function parsePages(v, n) { const out = new Set(); for (const part of String(v || "").split(/[,\s]+/)) { const m = /^(\d+)-(\d+)$/.exec(part); if (m) { for (let i = +m[1]; i <= +m[2] && i <= n; i++) if (i >= 1) out.add(i); } else if (/^\d+$/.test(part) && +part >= 1 && +part <= n) out.add(+part); } return [...out].sort((a, b) => a - b); }

/* ------------------------------------------------------------------ images for Claude */
function cut(src, x, y, w, h, maxSide) { const k = Math.min(1, maxSide / Math.max(w, h)); const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k)); const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height); return c; }
const toBlob = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("image encoding failed"))), "image/png"));
async function figureImages() {
  const page = await state.pdf.getPage(state.figurePage); const base = page.getViewport({ scale: 1 }); const [a, b, c, d] = state.crop;
  const cropLong = Math.max((c - a) * base.width, (d - b) * base.height); let scale = Math.min(2800 / cropLong, 6000 / Math.max(base.width, base.height)); scale = Math.min(scale, Math.sqrt(24e6 / (base.width * base.height)));
  const bigc = document.createElement("canvas"); const vp = page.getViewport({ scale }); bigc.width = Math.round(vp.width); bigc.height = Math.round(vp.height); const ctx = bigc.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, bigc.width, bigc.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const X = a * bigc.width, Y = b * bigc.height, W = (c - a) * bigc.width, H = (d - b) * bigc.height; const max = maxImages(); const canv = [cut(bigc, X, Y, W, H, 1568)]; let layout = "whole"; const ov = 0.12;
  if (max >= 5) { layout = "quadrants"; const w2 = W * (0.5 + ov), h2 = H * (0.5 + ov); for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) canv.push(cut(bigc, X + qx * (W - w2), Y + qy * (H - h2), w2, h2, 1568)); }
  else if (max >= 3) { if (W >= H) { layout = "halves-lr"; const w2 = W * (0.5 + ov); canv.push(cut(bigc, X, Y, w2, H, 1568), cut(bigc, X + W - w2, Y, w2, H, 1568)); } else { layout = "halves-tb"; const h2 = H * (0.5 + ov); canv.push(cut(bigc, X, Y, W, h2, 1568), cut(bigc, X, Y + H - h2, W, h2, 1568)); } }
  state.figureCanvas = canv[0]; const blobs = []; for (const cv of canv) blobs.push(await toBlob(cv));
  return { blobs, layout };
}

/* ------------------------------------------------------------------ prompts */
const JSON_SHAPE = '{"part":{"mpn":"","manufacturer":"","description":"","package":""},"design":{"title":"","page":0,"figure":"","description":""},' +
  '"components":[{"ref":"U1","type":"ic","value":"","mpn":"","suggested_mpn":"","manufacturer":"","description":"","package":"","rating":"","tolerance":"","dnp":false,"at":[0.42,0.37],"pins":[{"number":"1","name":"VIN","etype":"power_in","side":"left"}]}],' +
  '"nets":[{"name":"VIN","kind":"power","port":"input","nodes":[{"ref":"U1","pin":"1"},{"ref":"C1","pin":"1"}]}],"no_connects":[{"ref":"U1","pin":"5"}],' +
  '"options":[{"id":"vout","label":"Output voltage","type":"number","unit":"V","default":3.3,"min":0.8,"max":12,"step":0.1,"help":"Sets R1","actual":"0.8*(1+R1/R2)"},{"id":"bus","label":"Interface","type":"choice","default":"i2c","choices":[{"id":"i2c","label":"I2C"},{"id":"spi","label":"SPI"}],"help":""}],' +
  '"rules":[{"when":"","ref":"R1","set":"value","to":"R2*(vout/0.8-1)","series":"E96"},{"when":"bus==\'spi\'","ref":"R3","set":"remove"},{"when":"bus==\'spi\'","ref":"U1","pin":"5","set":"net","to":"\'CS\'"}],' +
  '"sim":{"sources":[{"net":"VIN","kind":"dc","value":12}],"standins":[{"ref":"U1","pin":"6","kind":"pulse","low":0,"high":3.3,"freq":1000000,"duty":0.5,"note":"clock output"}],"chips":[{"ref":"U2","model":"regulator","in":"3","out":"2","gnd":"1","vout":3.3,"dropout":0.3}],"loads":[{"net":"VOUT","value":33,"note":"100 mA"}],"probes":["VOUT"],"tstop":0.01},' +
  '"layout":["Place C1 within 5 mm of pin 2"],"notes":[],"warnings":[],"confidence":0.9}';
const RULES = [
  "You are a senior electronics engineer transcribing a reference design from a component datasheet into an exact machine-readable netlist. Accuracy matters more than anything: one wrong connection gives a board that does not work. Follow every wire to its end; a junction dot means connected, wires that merely cross are NOT connected; cross-check pin numbers against the pin table text. Never invent connections - put anything you cannot read into `warnings`.",
  "RULES",
  "1. Components: every external component drawn in the figure, with the datasheet's own designators (R1, CIN, CBOOT...). No designators in the figure -> assign R1.., C1.. in reading order. Do not add parts that are not drawn unless the text says they are required (say so in `description`). Optional / do-not-populate parts: dnp=true.",
  "2. `type` is one of: " + DS2K.COMPONENT_TYPES.join(", ") + ". Anything with 3+ pins that is not a transistor or potentiometer is \"ic\" (regulators, op-amps, modules, MCUs), \"connector\" or \"other\". Electrolytic/tantalum capacitors are \"capacitor_polarized\".",
  "3. Pin ids used in nets[].nodes[].pin: resistor, capacitor, inductor, ferrite_bead, fuse, crystal, switch, jumper, thermistor: \"1\" and \"2\". capacitor_polarized: \"+\" and \"-\". All diodes and LEDs: \"A\" (anode) and \"K\" (cathode). bjt: \"B\",\"C\",\"E\". mosfet: \"G\",\"D\",\"S\". potentiometer: \"1\",\"W\",\"3\". ic / connector / other: the PACKAGE PIN NUMBER as a string (\"1\", \"14\", \"EP\") - never the pin name.",
  "4. Main IC: choose the package the figure shows, otherwise the first (most common) one; put it in `package` (e.g. \"SOIC-8\", \"SOT-23-5\", \"QFN-16 3x3mm\"). Fill `pins` with EVERY pin of that package from the pin table: number, name, etype (input, output, bidirectional, passive, power_in, power_out, open_collector, no_connect) and side = the side of the IC rectangle where the figure draws the pin (left/right/top/bottom, \"\" if not drawn). Include an exposed/thermal pad if the table lists one. Pins the datasheet says to leave open go into `no_connects`; every other pin must be in exactly one net. For all non-IC parts `pins` is [].",
  "5. Nets: one entry per electrical node listing ALL pins on it. Every pin of every two-pin part must be in a net; a pin may be in only one net. Name nets after the figure's labels or the IC pin (VIN, VOUT, SW, FB, EN...); use \"\" for unnamed internal nodes. Ground is \"GND\" (AGND/PGND only if the datasheet separates them). Use KiCad rail names (+5V, +3V3, +12V, VCC, VDD, VBUS) only when the datasheet fixes that rail, otherwise VIN / VOUT. kind: ground | power | signal. port: input/output/bidirectional for nets that leave the design (supply input, regulated output, enable/logic inputs, status outputs), else \"none\".",
  "6. Values: from the figure, BOM table or design-example text (\"10k\", \"4.7uF\", \"6.8uH\"); voltage/current/dielectric needs go in `rating` (\"25V X7R\", \"3A\"), tolerance in `tolerance`. If the datasheet only gives equations, compute values for its own example conditions using E96/E24 values and explain in `notes`. Unknown -> \"TBD\" plus a warning. For the main IC `value` is the base part number.",
  "7. `mpn`: only part numbers printed in the datasheet. `suggested_mpn`: for diodes, transistors, inductors, crystals without a printed part number, one widely stocked part meeting the ratings (else \"\"). `package` for passives only if the datasheet states it.",
  "8. `notes`: up to 8 short lines a user wants on the schematic (design equations, conditions). `confidence`: 0-1 that the netlist is exactly right.",
  "9. `options`: the choices this reference design leaves to the person building it, as far as the datasheet documents them - an adjustable output voltage, current limit, frequency, timing, gain or threshold that is set by component values (type \"number\", with unit, min, max, step), and alternatives such as I2C or SPI, address or mode pins, fixed-voltage variants of the part, optional features (type \"choice\" with `choices`). At most 6, the most useful first; [] when the design has none. Every `default` must describe the netlist exactly as you wrote it. `help`: a few words on what changes and what the user must re-check themselves. `actual` (number options, optional): expression giving the value really obtained with the fitted standard parts.",
  "10. `rules`: how the choices change the netlist; they are applied in order on top of the netlist. Each rule: `when` = condition (\"\" = always), `ref` = component, `set` = one of \"value\" (`to` = expression in ohm / farad / henry, rounded to `series` E96, E24, E12 or E6; or a quoted text), \"mpn\" (`to` = quoted part number), \"dnp\" (`to` = condition), \"remove\" (part not fitted at all), \"net\" (connect `pin` of `ref` to the net named by `to`; '' = leave open). Expressions may use: numbers (10k, 4.7u, 1e-6), option ids, component designators (= that part's value in ohm / F / H), + - * / ^ ( ), == != < > <= >=, && || !, c ? a : b, min max sqrt abs ln log10 exp round par; texts in single quotes. Take the formulas from the datasheet. With all defaults the rules must leave the netlist unchanged.",
  "11. `sim`: how to simulate the design although the chip has no simulation model - replace what the chip does by simple stand-ins, from the datasheet's typical values. `sources`: what the outside world applies (supply, input signals) per net: kind dc (value in V), pulse (low, high, freq in Hz, duty 0-1) or sine (offset, value = amplitude, freq). `standins`: per chip pin that DRIVES something: kind dc / pulse / sine as above (a regulator or reference output = dc, a clock or PWM or switch node = pulse, an analog output = dc or sine), kind load (value = ohm to ground, for an input that loads the circuit) or open. `chips`: instead of pin stand-ins a whole chip may be {model:\"regulator\", in, out, gnd, vout, dropout} or {model:\"opamp\", units:[{inp, inn, out}], vp, vn} (pin numbers) - use these for linear regulators and op-amps / comparators. Inputs that only sense need nothing. `loads`: a typical load per output net in ohm. `probes`: up to 4 nets worth plotting. `tstop`: seconds to simulate (long enough to settle, at least 20 periods of the slowest source). Numbers may be expressions of option ids (duty: \"vout/12\"). Discrete parts (R, C, L, diodes, transistors) are simulated as they are.",
  "12. `at` (every component): where its symbol is drawn in image 1, as [x, y] fractions of the image width and height (0-1, centre of the symbol); omit it for parts that are not drawn. `layout`: up to 8 short PCB layout rules the datasheet gives for this design (placement distances, short loops, ground / thermal pad advice, trace widths), in the datasheet's own numbers; [] if it gives none.",
  "Before answering verify: every component in the figure is listed once; every two-pin part has both pins in nets; no pin is in two nets; every IC pin is in a net or in no_connects; feedback / compensation / bootstrap / enable networks match the figure wire by wire; diode and polarised-capacitor orientation is right.",
].join("\n");
function imagesNote(layout, count) { if (!count) return "NO IMAGE could be attached in this view: reconstruct the reference design from the text alone as far as the text allows, list every assumption in `warnings`, and set `confidence` low."; return layout === "quadrants" ? "Image 1 is the whole figure. Images 2-5 are enlarged, overlapping quadrants of the same figure (top-left, top-right, bottom-left, bottom-right) - use them to read pin numbers, values and junction dots." : layout.startsWith("halves") ? "Image 1 is the whole figure. Images 2-3 are enlarged, overlapping halves of the same figure (" + (layout === "halves-lr" ? "left, right" : "top, bottom") + ")." : "The image is the figure."; }
function pageTextBlock(limit) {
  const n = state.pdf ? state.pdf.numPages : 0; const pages = parsePages(($("#textpages") || {}).value || state.textPagesValue || "", n); let total = 0; const parts = [];
  for (const pn of pages) { let t = state.pages[pn - 1].text.replace(/[ \t]+/g, " "); if (t.length > 7000) t = t.slice(0, 7000) + " …"; if (total + t.length > (limit || 36000)) break; total += t.length; parts.push("=== TEXT OF DATASHEET PAGE " + pn + " ===\n" + t); }
  return parts.join("\n\n");
}
function extractPrompt(layout, count) {
  const hint = (($("#hint") || {}).value || "").trim();
  return RULES + "\n\nTASK\nThe reference design is on page " + state.figurePage + " of the datasheet \"" + state.pdfName + "\". " + imagesNote(layout, count) + " Transcribe this reference design into a complete netlist.\n" +
    (hint ? "Additional instructions from the user: " + hint + "\n" : "") + "\nText extracted from the datasheet (pin tables, parts lists; layout is lost, numbers are exact):\n\n" + pageTextBlock() +
    "\n\nAnswer with ONE JSON object only, no prose and no code fence, exactly in this shape (the values shown are examples):\n" + JSON_SHAPE;
}
function reviewPrompt(layout, count, circuit, issues) {
  return RULES + "\n\nTASK\nYou are REVIEWING a netlist that was transcribed from the reference design on datasheet page " + state.figurePage + ". " + imagesNote(layout, count) +
    "\nAutomatic checks reported:\n" + (issues.length ? issues.map((i) => "- " + i).join("\n") : "- none") + "\n\nNetlist under review:\n" + JSON.stringify(circuit) +
    "\n\nGo through the figure component by component and wire by wire. Look for missing or extra components, a pin on the wrong net, swapped diode/capacitor polarity, wrong pin numbers, IC pins left out, wrong values, nets that should be merged or split.\n\nText extracted from the datasheet:\n\n" + pageTextBlock(20000) +
    "\n\nAnswer with ONE JSON object only: {\"changes\":[\"each correction you made\"],\"circuit\":<the COMPLETE corrected netlist in the same shape as the one under review, including `options` and `rules` (correct those too)>}";
}
function changePrompt(layout, count, circuit, wish) {
  return RULES + "\n\nTASK\nBelow is the netlist of a reference design" + (state.pdf && !state.isExample ? " transcribed from datasheet page " + state.figurePage + ". " + imagesNote(layout, count) : ".") +
    "\nThe user wants this change: " + wish + "\nApply it the way the datasheet describes (recalculate component values with the datasheet's formulas, add / remove / rewire parts as needed). Leave everything else exactly as it is, keep `options` and `rules` consistent with the changed netlist (defaults = the new netlist), and mention anything the user must re-check in `warnings`.\n\nNetlist:\n" + JSON.stringify(circuit) +
    (state.pdf && !state.isExample ? "\n\nText extracted from the datasheet:\n\n" + pageTextBlock(20000) : "") +
    "\n\nAnswer with ONE JSON object only: {\"changes\":[\"each change you made\"],\"circuit\":<the COMPLETE new netlist in the same shape>}";
}
function settlePrompt(layout, count, a, b, diffs) {
  return RULES + "\n\nTASK\nThe reference design on datasheet page " + state.figurePage + " was transcribed twice, independently, and the two netlists disagree. " + imagesNote(layout, count) + "\nDisagreements:\n" + diffs.map((d) => "- " + d).join("\n") +
    "\n\nFor each disagreement look at the figure again (and the pin table text) and decide which reading is right - or neither. Everything the two readings agree on stays as it is.\n\nReading A:\n" + JSON.stringify(a) + "\n\nReading B:\n" + JSON.stringify(b) + "\n\nText extracted from the datasheet:\n\n" + pageTextBlock(16000) +
    "\n\nAnswer with ONE JSON object only: {\"changes\":[\"for each disagreement: what is right and why\"],\"circuit\":<the COMPLETE final netlist in the same shape as reading A>}";
}
function manualPrompt() { return RULES + "\n\nTASK\nThe attached PDF is a component datasheet. Find its main typical application / reference design and transcribe it into a complete netlist, using the pin configuration table for pin numbers.\n\nAnswer with ONE JSON object only, no prose and no code fence, exactly in this shape (the values shown are examples):\n" + JSON_SHAPE; }

/* ------------------------------------------------------------------ asking Claude (host capability, or the user's own API key) */
const ERR_COPY = { not_granted: "Access was not allowed for this page. Reload and allow it.", sampling_disabled: "Reading is not available for this account here. Import below still works.", rate_limited: "Busy, or the usage limit was reached. Try again in a little while.", session_expired: "Your session expired - sign in again, then retry.", image_rejected: "The page image was rejected. Drag a smaller box around the circuit and try again.", images_unavailable: "This view cannot use images.", refused: "This page could not be processed.", invalid_json: "The reading failed. Try again - if it keeps failing, drag a tighter box around the circuit.", prompt_too_large: "Too much page text was selected. Remove some pages from the text list.", empty_completion: "Nothing came back. Try again.", upstream_error: "The connection failed. Try again.", bad_key: "The API key was rejected. Check that it was pasted completely.", network: "api.anthropic.com could not be reached from this page." };
function parseLoose(raw) { raw = String(raw || "").trim(); try { return JSON.parse(raw); } catch (e) { /* fall through */ } const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw); if (m) { try { return JSON.parse(m[1]); } catch (e) { /* fall through */ } } const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch (e) { /* fall through */ } } throw { code: "invalid_json" }; }
const b64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = () => rej(new Error("could not read image")); fr.readAsDataURL(blob); });
async function askWithKey(prompt, blobs, onText, signal) {
  const content = []; for (const b of blobs) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: await b64(b) } }); content.push({ type: "text", text: prompt });
  const base = { model: store.get("model") || "claude-opus-5", max_tokens: 32000, stream: true, messages: [{ role: "user", content }] };
  for (const extra of [{ thinking: { type: "adaptive" } }, {}]) {
    let res;
    try { res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal, headers: { "content-type": "application/json", "x-api-key": store.get("key"), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, body: JSON.stringify(Object.assign({}, base, extra)) }); }
    catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled" }; throw { code: "network", message: String(e && e.message) }; }
    if (res.status === 401 || res.status === 403) throw { code: "bad_key" }; if (res.status === 429 || res.status === 529) throw { code: "rate_limited" };
    if (res.status === 400 && extra.thinking) continue;
    if (!res.ok) { let msg = "HTTP " + res.status; try { msg = (await res.json()).error.message || msg; } catch (e) { /* ignore */ } throw { code: "upstream_error", message: msg }; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "", text = "";
    for (;;) { let chunk; try { chunk = await reader.read(); } catch (e) { throw { code: signal.aborted ? "cancelled" : "upstream_error" }; } if (chunk.done) break; buf += dec.decode(chunk.value, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line.startsWith("data:")) continue; let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; } if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") { text += ev.delta.text; onText({ text }); } else if (ev.type === "error") throw { code: "upstream_error", message: (ev.error || {}).message }; } }
    return parseLoose(text);
  }
  throw { code: "upstream_error" };
}
async function askClaude(prompt, blobs, statusId, label) {
  const ctl = new AbortController(); state.busy = ctl; const t0 = Date.now(); let chars = 0;
  const show = () => { const s = Math.round((Date.now() - t0) / 1000); setStatus(statusId, (chars ? label + " - writing the netlist (" + chars + " characters)" : label + " - analysing the figure") + " · " + s + " s", true, () => ctl.abort()); };
  show(); const tick = setInterval(show, 1000); const onText = ({ text }) => { chars = text.length; };
  try {
    if (state.sample) { const opts = { modelTier: "complex", cache: false, signal: ctl.signal, onText }; if (blobs.length) opts.images = blobs; return await state.sample.json(prompt, opts); }
    return await askWithKey(prompt, blobs, onText, ctl.signal);
  } finally { clearInterval(tick); state.busy = null; }
}
function explain(e, what) { if (e && e.code === "cancelled") return; toast(ERR_COPY[e && e.code] ? ERR_COPY[e.code] + (e.message && e.code === "upstream_error" ? " (" + e.message + ")" : "") : (what + " failed: " + ((e && (e.message || e.code)) || e)), 10000); }
async function readCircuit() {
  if (state.busy) return; const btn = $("#readbtn"); btn.disabled = true;
  try {
    let blobs = [], layout = "whole";
    if (canImages()) { setStatus("readstatus", "Rendering the figure at high resolution…", true); const r = await figureImages(); blobs = r.blobs; layout = r.layout; }
    state.sentImages = blobs; state.sentLayout = layout;
    let data;
    try { data = await askClaude(extractPrompt(layout, blobs.length), blobs, "readstatus", "Reading the circuit"); }
    catch (e) { if (!(e && (e.code === "images_unavailable") && blobs.length)) throw e; blobs = []; state.sentImages = []; state.imageLimits = null; renderDiag(); data = await askClaude(extractPrompt(layout, 0), [], "readstatus", "Reading the circuit from the page text only"); }
    if (!data || !Array.isArray(data.components) || !Array.isArray(data.nets)) throw { code: "invalid_json" };
    let disagreements = [];
    if (state.readTwice !== false) {
      try {
        const second = await askClaude(extractPrompt(layout, blobs.length) + "\n\n(Independent second reading - start again from the figure.)", blobs, "readstatus", "Reading it a second time to cross-check");
        if (second && Array.isArray(second.components) && Array.isArray(second.nets)) { disagreements = CMP.diffReads(data, second);
          if (disagreements.length) { const fixed = await askClaude(settlePrompt(layout, blobs.length, data, second, disagreements), blobs, "readstatus", "The two readings differ in " + disagreements.length + " place(s) - checking those against the figure"); if (fixed && fixed.circuit && Array.isArray(fixed.circuit.components) && Array.isArray(fixed.circuit.nets)) { data = fixed.circuit; state.pendingChanges = (fixed.changes || []).map(String); } } }
      } catch (e) { if (e && e.code === "cancelled") throw e; disagreements.push("The cross-check reading failed (" + ((e && (e.code || e.message)) || e) + ") - only one reading was used."); }
    }
    data.disagreements = disagreements;
    if (!data.design) data.design = {}; if (!data.design.page) data.design.page = state.figurePage;
    state.isExample = false; state.reviewChanges = state.pendingChanges || []; state.pendingChanges = null; setStatus("readstatus", ""); state.currentId = null; setBase(data); saveCurrent(true); $("#step2").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { setStatus("readstatus", ""); explain(e, "Reading"); }
  finally { btn.disabled = false; }
}
function bakedCircuit() { const ap = state.applied; const options = JSON.parse(JSON.stringify(state.base.options || [])); for (const o of options) { const id = String(o.id || ""); for (const k of Object.keys(ap.values)) if (k.toLowerCase() === id.replace(/[^A-Za-z0-9_]+/g, "_").toLowerCase()) o.default = ap.values[k]; } return Object.assign({}, state.circuit, { options, rules: state.base.rules || [], sim: state.base.sim || undefined }); }
async function reviseCircuit(statusId, label, makePrompt, doneText) {
  if (state.busy || !canAsk()) return; collectEdits(); rebuild();
  try {
    const imgs = state.isExample ? [] : state.sentImages; const issues = state.result ? state.result.errors.concat(state.result.warnings) : []; const before = bakedCircuit();
    const data = await askClaude(makePrompt(state.sentLayout, imgs.length, before, issues), imgs, statusId, label); setStatus(statusId, "");
    if (data && data.circuit && Array.isArray(data.circuit.components) && Array.isArray(data.circuit.nets)) { if (!Array.isArray(data.circuit.options)) { data.circuit.options = before.options; data.circuit.rules = before.rules; } if (!data.circuit.sim) data.circuit.sim = state.base.sim; if (!data.circuit.layout) data.circuit.layout = state.base.layout; data.circuit.marks = state.base.marks; if (!Array.isArray(data.circuit.blocks)) data.circuit.blocks = state.base.blocks; state.reviewChanges = (data.changes || []).map(String); state.isExample = false; setBase(data.circuit, true); toast(doneText(state.reviewChanges.length)); return true; }
    toast(ERR_COPY.invalid_json);
  } catch (e) { setStatus(statusId, ""); explain(e, label); }
  return false;
}
const reviewCircuit = () => reviseCircuit("reviewstatus", "Double-checking", reviewPrompt, (n) => (n ? n + " correction(s) applied." : "Nothing to correct."));
async function changeCircuit() { const inp = $("#wish"); const wish = ((inp || {}).value || "").trim(); if (!wish) { if (inp) inp.focus(); return; } const ok = await reviseCircuit("wishstatus", "Changing the design", (l, n, c) => changePrompt(l, n, c, wish), () => "Done - the schematic is updated."); if (!ok && $("#wish")) $("#wish").value = wish; }

/* ------------------------------------------------------------------ live LCSC lookup (only where the page has network access) */
async function findParts() {
  if (IN_HOST || state.busy) return; collectEdits(); rebuild(); const live = new Set(state.circuit.components.map((c) => c.ref)); const comps = state.base.components.filter((c) => live.has(c.ref)); for (const c of comps) { const d = state.circuit.components.find((x) => x.ref === c.ref); c._v = c.value; c.value = d.value; c._m = c.mpn; c.mpn = d.mpn; } let found = 0, tried = 0; const cache = new Map();
  const get = async (url) => { if (cache.has(url)) return cache.get(url); const r = await fetch(url); if (!r.ok) throw new Error("HTTP " + r.status); const j = await r.json(); cache.set(url, j); return j; };
  const rank = (a) => a.filter((o) => o.stock > 0).sort((x, y) => (y.is_basic ? 1 : 0) - (x.is_basic ? 1 : 0) || (y.is_preferred ? 1 : 0) - (x.is_preferred ? 1 : 0) || y.stock - x.stock);
  const close = (a, b) => Math.abs(a - b) <= 0.011 * Math.max(Math.abs(a), Math.abs(b));
  try {
    for (const c of comps) {
      if (c.dnp || c.lcsc) continue; let best = null; tried++; setStatus("srcstatus", "Looking up " + c.ref + " (" + tried + "/" + comps.length + ")…", true);
      const pkg = (/(0201|0402|0603|0805|1206|1210|2010|2512)/.exec(c.package || "") || [])[1];
      if (c.type === "resistor") { const v = DS2K.parseValue(c.value, "ohm"); if (v) { const j = await get("https://jlcsearch.tscircuit.com/resistors/list.json?resistance=" + v + "&package=" + (pkg || "0603")); best = (c._cands = rank((j.resistors || []).filter((o) => close(o.resistance, v) && (o.tolerance_fraction || 1) <= 0.011)))[0]; } }
      else if (c.type === "capacitor") { const v = DS2K.parseValue(c.value, "F"); const need = parseFloat((/(\d+(?:\.\d+)?)\s*V/.exec(c.rating || "") || [])[1]) || 0; if (v) for (const p of pkg ? [pkg] : ["0603", "0805", "1206", "1210"]) { const j = await get("https://jlcsearch.tscircuit.com/capacitors/list.json?capacitance=" + v.toPrecision(6) + "&package=" + p); best = (c._cands = rank((j.capacitors || []).filter((o) => close(o.capacitance_farads, v) && (o.voltage_rating || 0) >= need)))[0]; if (best) break; } }
      else { const q = c.mpn || c.suggested_mpn || (/[A-Za-z].*\d|\d.*[A-Za-z]/.test(c.value || "") && !["inductor", "capacitor_polarized", "crystal", "led"].includes(c.type) ? c.value : ""); if (q) { const j = await get("https://jlcsearch.tscircuit.com/api/search?limit=10&q=" + encodeURIComponent(q)); const nq = q.toUpperCase().replace(/[^A-Z0-9]/g, ""); best = (c._cands = rank((j.components || []).filter((o) => { const m = String(o.mfr || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); return m.startsWith(nq) || (m.length >= 5 && nq.startsWith(m)); })))[0]; } }
      if (best) { const price = parseFloat(best.price !== undefined ? best.price : best.price1); c.buy = { price: isFinite(price) ? price : null, stock: best.stock || 0, basic: !!best.is_basic, alts: (c._cands || []).filter((o) => o !== best).slice(0, 2).map((o) => "C" + o.lcsc) }; c.lcsc = "C" + best.lcsc; c.lcscFor = c.value; if (!c.mpn && best.mfr) { c.suggested_mpn = best.mfr; c.lcscMpn = true; } found++; }
    }
    setStatus("srcstatus", ""); toast("LCSC parts found for " + found + " of " + tried + " parts.");
  } catch (e) { setStatus("srcstatus", ""); toast("The LCSC lookup could not be reached from this page (" + ((e && e.message) || e) + ").", 8000); }
  finally { for (const c of comps) { c.value = c._v; c.mpn = c._m; delete c._v; delete c._m; delete c._cands; } rebuild(); }
}

/* ------------------------------------------------------------------ circuit state: base netlist + chosen options -> drawn circuit */
function projectName() { const c = state.base || {}; if ((c.blocks || []).length > 1) return DS2K.safeName("combined_" + c.blocks.map((b) => b.tag).join("_"), "combined"); return DS2K.safeName(((c.part || {}).mpn || (state.pdfName || "design").replace(/\.pdf$/i, "")) + "_ref", "design"); }
function setBase(data, keepAlias) {
  const src = JSON.parse(JSON.stringify(data)); const circ = new DS2K.Circuit(src); circ.normalize(); const alias = keepAlias ? Object.assign({}, state.alias) : {};
  (src.components || []).filter((c) => c && typeof c === "object").forEach((c, i) => { const k = circ.components[i]; if (k && c.ref !== undefined) { alias[String(c.ref).trim()] = k.ref; alias[String(c.ref).trim().toUpperCase()] = k.ref; } });
  state.base = Object.assign(circ.toDict(), { options: Array.isArray(src.options) ? src.options : [], rules: Array.isArray(src.rules) ? src.rules : [], blocks: Array.isArray(src.blocks) ? src.blocks : [], sim: src.sim && typeof src.sim === "object" ? src.sim : null, layout: Array.isArray(src.layout) ? src.layout.map(String).slice(0, 8) : [], disagreements: Array.isArray(src.disagreements) ? src.disagreements.map(String) : [], marks: src.marks && typeof src.marks === "object" ? src.marks : {} });
  (src.components || []).filter((c) => c && typeof c === "object").forEach((c, i) => { const k = circ.components[i]; if (k && Array.isArray(c.at) && c.at.length === 2 && c.at.every((v) => typeof v === "number" && v >= 0 && v <= 1)) state.base.marks[k.ref] = c.at; }); state.alias = alias; state.chosen = {}; rebuild();
}
function normalizeBase() { const b = state.base; const c = new DS2K.Circuit(JSON.parse(JSON.stringify(b))); c.normalize(); const extra = {}; for (const k of b.components) extra[k.ref] = k; state.base = Object.assign(c.toDict(), { options: b.options, rules: b.rules, blocks: b.blocks, sim: b.sim, layout: b.layout, disagreements: b.disagreements, marks: b.marks }); for (const k of state.base.components) { const o = extra[k.ref]; if (o && o.lcscFor !== undefined) { k.lcscFor = o.lcscFor; k.lcscMpn = o.lcscMpn; k.buy = o.buy; } } }
function renameNet(oldName, newName) { newName = String(newName || "").trim(); const n = state.base.nets.find((x) => x.name === oldName); if (!n || !newName || newName === oldName) return; const tgt = state.base.nets.find((x) => x !== n && x.name.toUpperCase() === newName.toUpperCase()); const sm = state.base.sim;
  if (tgt && sm && Array.isArray(sm.sources) && [n, tgt].some((x) => x.port === "output")) sm.sources = sm.sources.filter((x) => ![oldName.toUpperCase(), newName.toUpperCase()].includes(String(x.net).toUpperCase()));      /* a block's output now feeds this net - the outside supply goes away */
  n.name = newName; if (sm) for (const k of ["sources", "loads"]) for (const x of sm[k] || []) if (String(x.net).toUpperCase() === oldName.toUpperCase()) x.net = newName; if (sm && Array.isArray(sm.probes)) sm.probes = sm.probes.map((p) => (String(p).toUpperCase() === oldName.toUpperCase() ? newName : p)); normalizeBase(); }
function rebuild() {
  try {
    const ap = OPT.applyOptions(state.base, state.chosen, state.alias); state.applied = ap;
    for (const d of ap.circuit.components) { const b = state.base.components.find((x) => x.ref === d.ref); if (b && b.lcsc && b.lcscFor !== undefined && b.lcscFor !== d.value) { d.lcsc = ""; if (b.lcscMpn) d.suggested_mpn = ""; } }
    const picked = ap.options.map((o) => o.label + ": " + (o.type === "choice" ? (o.choices.find((c) => c.id === ap.values[o.id]) || {}).label : ap.values[o.id] + (o.unit ? " " + o.unit : ""))); if (picked.length) ap.circuit.notes = ["Built for - " + picked.join(", ")].concat(ap.circuit.notes || []);
    const lay = state.base.layout || []; if (lay.length) ap.circuit.notes = (ap.circuit.notes || []).concat(lay.slice(0, 6).map((x) => "Layout: " + x));
    const r = DS2K.build(ap.circuit, projectName(), { source: state.isExample ? "built-in example" : (state.base.blocks || []).length > 1 ? "" : state.currentId && !state.pdf ? "" : state.pdfName }); state.result = r; state.circuit = r.circuit.toDict();
    r.files["circuit.json"] = JSON.stringify(Object.assign({}, state.circuit, { options: state.base.options, rules: state.base.rules, chosen: ap.values, sim: state.base.sim || undefined }), null, 1);
    if (lay.length) r.files["README.txt"] += "\nPCB layout rules from the datasheet:\n" + lay.map((x) => " - " + x).join("\n") + "\n";
    try { r.files[r.name + "_ngspice.cir"] = SIM.netlist(state.circuit, state.base.sim, ap.values, state.alias, (state.circuit.design || {}).title || r.name).text; } catch (e) { /* the project is still fine without it */ }
    if (state.currentId) saveCurrent(true);
  } catch (e) { state.result = null; toast("The schematic could not be drawn: " + e.message, 9000); }
  if (simState.on && state.result) { try { simState.result = SIM.run(state.circuit, state.base.sim, state.applied.values, state.alias); } catch (e) { simState.result = { ok: false, error: e.message, notes: [] }; } }
  renderResult(); renderParts(); renderLibrary(); renderSim();
}
function collectEdits() {
  const base = state.base; if (!base) return;
  document.querySelectorAll("#circuitui [data-ref]").forEach((inp) => { if (inp.disabled) return; const k = base.components.find((c) => c.ref === inp.dataset.ref); if (!k) return; const f = inp.dataset.f; const v = inp.type === "checkbox" ? inp.checked : inp.value.trim(); if (v === inp.dataset.was || (inp.type === "checkbox" && String(v) === inp.dataset.was)) return; k[f] = v; if (f === "value" || f === "mpn") { k.lcsc = ""; delete k.buy; if (k.lcscMpn) { k.suggested_mpn = ""; k.lcscMpn = false; } } });
  const gone = state.applied ? state.applied.removed : new Set(); let renamed = false;
  document.querySelectorAll("#circuitui [data-net]").forEach((inp) => {
    if (inp.value.trim() === inp.dataset.was) return; let n = base.nets.find((x) => x.name === inp.dataset.net); if (!n) { n = { name: inp.dataset.net, kind: "signal", port: "none", nodes: [] }; base.nets.push(n); }
    if (inp.dataset.f === "name") { n.name = inp.value.trim(); renamed = true; document.querySelectorAll('#circuitui [data-net="' + inp.dataset.net.replace(/"/g, '\\"') + '"]').forEach((o) => { o.dataset.net = n.name; }); }
    else { const nodes = inp.value.split(/[,;\s]+/).filter((x) => x.includes(".")).map((x) => { const j = x.indexOf("."); return { ref: x.slice(0, j).trim().toUpperCase(), pin: x.slice(j + 1).trim() }; }); const has = (a) => nodes.some((b) => b.ref === a.ref && b.pin === String(a.pin));
      for (const o of base.nets) if (o !== n) o.nodes = o.nodes.filter((a) => !has(a)); n.nodes = nodes.concat(n.nodes.filter((a) => gone.has(a.ref) && !has(a))); }
  });
  if (renamed) normalizeBase();
}
/* run an edit, redraw, and put the cursor back where it was */
function liveEdit(fn) { return () => setTimeout(guard(() => { const a = document.activeElement; const id = a && a.id; fn(); rebuild(); if (id) { const e = document.getElementById(id); if (e && e !== document.activeElement) { e.focus(); if (e.select && e.type !== "checkbox" && e.type !== "radio") { try { e.select(); } catch (x) { /* number inputs */ } } } } }), 0); }

/* ------------------------------------------------------------------ schematic: options, preview, downloads */
function fmtNum(v) { return String(parseFloat(Number(v).toPrecision(3))); }
function renderOptions(box) {
  const ap = state.applied; if (!ap) return; const wrap = el("div", { class: "opts" });
  for (const o of ap.options) {
    const id = "opt_" + o.id; let ctl;
    if (o.type === "number") { const inp = el("input", { type: "number", id, value: ap.values[o.id], min: o.min, max: o.max, step: o.step || "any", onchange: liveEdit(() => { state.chosen[o.id] = inp.value; }) }); ctl = el("span", { class: "numwrap" }, inp, o.unit ? el("span", { class: "unit" }, o.unit) : null); }
    else if (o.choices.length <= 4) ctl = el("span", { class: "seg", role: "radiogroup", "aria-label": o.label }, o.choices.map((c, i) => el("button", { type: "button", id: id + "_" + i, role: "radio", "aria-checked": c.id === ap.values[o.id] ? "true" : "false", class: c.id === ap.values[o.id] ? "on" : "", onclick: liveEdit(() => { state.chosen[o.id] = c.id; }) }, c.label)));
    else { const sel = el("select", { id, onchange: liveEdit(() => { state.chosen[o.id] = sel.value; }) }, o.choices.map((c) => el("option", { value: c.id, selected: c.id === ap.values[o.id] }, c.label))); ctl = sel; }
    const got = ap.actual[o.id]; const info = [got !== undefined && Math.abs(got - ap.values[o.id]) > 1e-9 * Math.abs(got) ? "gives " + fmtNum(got) + (o.unit ? " " + o.unit : "") : ""].filter(Boolean).join(" · ");
    wrap.append(el("div", { class: "opt", title: o.help || null }, el("label", { for: o.type === "choice" && o.choices.length <= 4 ? null : id }, o.label), ctl, info ? el("small", {}, info) : null));
  }
  if (ap.options.length) box.append(wrap);
  const ch = ap.changes.map((c) => c.what === "removed" ? c.ref + " not fitted" : c.what === "pin" ? c.ref + " pin " + c.pin + " → " + c.to : c.what === "dnp" ? c.ref + (c.to ? " not populated" : " populated") : c.ref + " → " + c.to);
  if (ch.length) box.append(el("p", { class: "changes" }, ch.join("   ·   "), " ", el("button", { type: "button", class: "quiet", onclick: () => { state.chosen = {}; rebuild(); } }, "Reset")));
  if (canAsk()) { const wish = el("input", { type: "text", id: "wish", placeholder: ap.options.length ? "Something else? e.g. add a power LED, use the 5 V variant" : "Want a change? e.g. 5 V output, SPI instead of I2C, add a power LED", "aria-label": "Describe a change", onkeydown: (ev) => { if (ev.key === "Enter") changeCircuit(); } });
    box.append(el("div", { class: "row wishrow" }, wish, el("button", { type: "button", onclick: changeCircuit }, "Apply")), el("div", { id: "wishstatus", class: "status", role: "status", "aria-live": "polite" })); }
}
function renderResult() {
  const box = $("#resultui"); if (!box) return; const keepWish = ($("#wish") || {}).value; box.innerHTML = ""; const r = state.result, c = state.circuit; if (!r || !c) { box.append(el("p", { class: "muted" }, "The schematic appears here.")); return; }
  const title = (c.design || {}).title || ((c.part || {}).mpn || "Circuit");
  box.append(el("div", { class: "row head" }, el("h3", {}, title), state.isExample ? el("span", { class: "tag ex" }, "Example") : null));
  renderBlocks(box); renderOptions(box); if (keepWish && $("#wish")) $("#wish").value = keepWish;
  const errs = r.errors.concat(r.selfCheck.ok ? [] : r.selfCheck.errors.slice(0, 8)); if (errs.length) box.append(el("div", { class: "note bad" }, el("b", {}, "Needs fixing"), el("ul", {}, errs.map((x) => el("li", {}, x)))));
  const pv = el("div", { class: "preview", tabindex: "0", "aria-label": "Schematic preview" }); pv.innerHTML = r.svg; box.append(pv);
  if (state.figureCanvas && !state.isExample) { state.figureCanvas.className = "figure"; const marks = state.base.marks || {}; const refs = c.components.map((k) => k.ref); const lost = refs.filter((r) => !marks[r]);
    const pins = refs.filter((r) => marks[r]).map((r) => el("span", { class: "mark", style: "left:" + (marks[r][0] * 100).toFixed(1) + "%;top:" + (marks[r][1] * 100).toFixed(1) + "%" }, r));
    box.append(el("details", { class: "more", id: "figdet", open: !!state.figOpen, ontoggle: (ev) => { state.figOpen = ev.target.open; } }, el("summary", {}, "Compare with the datasheet"), el("div", { class: "figwrap" }, el("div", { class: "figinner" }, state.figureCanvas, pins)),
      el("p", { class: "small" }, pins.length ? "Each tag is a part that was found. A symbol without a tag was missed" + (lost.length ? "; not located in the figure: " + lost.join(", ") + "." : ".") : "No part positions for this design."))); }
  const missing = r.symbols.filter((s) => !s.footprint).map((s) => s.ref); const low = typeof c.confidence === "number" && c.confidence < 0.8 && !state.isExample;
  const dis = state.isExample ? [] : (state.base.disagreements || []); const pinc = CMP.pinChecks(c);
  const checks = [].concat(dis.length ? ["The two readings of the figure differed here (settled by a third look - worth your own check): " + dis.join(" · ")] : [], pinc, low ? ["Low confidence on this one (" + Math.round(c.confidence * 100) + " %) - compare it with the datasheet carefully."] : [], state.applied.problems, r.warnings, r.issues, c.warnings || [], missing.length ? ["No footprint yet for " + missing.join(", ") + " - assign it in KiCad once you know the exact part."] : []);
  if (checks.length) box.append(el("details", { class: "checks" }, el("summary", {}, checks.length + (checks.length === 1 ? " thing to check" : " things to check")), el("div", {}, el("ul", {}, checks.map((x) => el("li", {}, x))))));
  box.append(el("div", { class: "row" }, el("button", { type: "button", class: "primary big", id: "dlbtn", onclick: downloadProject }, "Download KiCad project"), el("button", { type: "button", class: "big", id: "bombtn", onclick: () => saveFile(r.name + "_bom.csv", r.files["bom.csv"], "text/csv") }, "Download BOM"),
    el("button", { type: "button", class: "quiet", id: "jlcbtn", onclick: () => saveFile(r.name + "_bom_jlcpcb.csv", r.files["bom_jlcpcb.csv"], "text/csv") }, "BOM for JLCPCB"),
    state.currentId ? el("span", { class: "small saved" }, "✓ In My designs") : el("button", { type: "button", class: "quiet", id: "savebtn", onclick: () => { saveCurrent(); renderResult(); renderLibrary(); $("#step4").open = true; $("#step4").scrollIntoView({ behavior: "smooth", block: "nearest" }); } }, "Save to My designs")));
  box.append(el("div", { id: "dlfallback" }));
}

/* ------------------------------------------------------------------ combined designs: how the blocks connect */
function renderBlocks(box) {
  const blocks = (state.base || {}).blocks || []; if (blocks.length < 2 || !state.circuit) return; const names = state.circuit.nets.map((n) => n.name).filter((x) => !/^N\$/.test(x));
  const dl = el("datalist", { id: "netnames" }, names.map((x) => el("option", { value: x }))); const wrap = el("div", { class: "opts blocks" }, dl); let i = 0;
  for (const b of blocks) {
    const refs = new Set(b.refs); const rows = state.circuit.nets.filter((n) => n.kind !== "ground" && !/^N\$/.test(n.name) && (n.port !== "none" || n.kind === "power") && n.nodes.some((x) => refs.has(x.ref)));
    const shared = (n) => n.nodes.some((x) => !refs.has(x.ref));
    wrap.append(el("div", { class: "opt" }, el("label", {}, b.name), rows.length ? rows.map((n) => { const id = "blk" + (i++); const inp = el("input", { type: "text", id, list: "netnames", value: n.name, class: "mono" + (shared(n) ? " joined" : ""), "aria-label": b.name + " net " + n.name, title: n.nodes.filter((x) => refs.has(x.ref)).map((x) => x.ref + "." + x.pin).join(", "), onchange: liveEdit(() => renameNet(n.name, inp.value)) }); return inp; }) : el("small", {}, "no outside connections")));
  }
  box.append(el("p", { class: "small" }, "Same name = connected."), wrap);
}

/* ------------------------------------------------------------------ My designs: saved in this browser, export / import as files, combine */
const LIBKEY = "ds2k.lib";
function loadLibrary() { try { const l = JSON.parse(localStorage.getItem(LIBKEY) || "[]"); state.library = Array.isArray(l) ? l.filter((d) => d && d.id && d.base) : []; } catch (e) { state.library = []; } }
function storeLibrary() { try { localStorage.setItem(LIBKEY, JSON.stringify(state.library)); return true; } catch (e) { toast("This browser would not store the design - use Export to keep a copy.", 8000); return false; } }
function designName() { const c = state.base || {}; return (c.design || {}).title || (c.part || {}).mpn || (state.pdfName || "Design").replace(/\.pdf$/i, ""); }
function saveCurrent(quiet) {
  if (!state.base || !state.applied) return; let d = state.library.find((x) => x.id === state.currentId);
  if (!d) { d = { id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: designName() }; state.library.unshift(d); state.currentId = d.id; setTimeout(() => { renderLibrary(); renderResult(); }, 0); }
  Object.assign(d, { saved: Date.now(), base: state.base, alias: state.alias, chosen: state.applied.values, parts: state.circuit ? state.circuit.components.length : 0 }); const ok = storeLibrary(); if (ok && !quiet) toast("Saved.");
}
function openDesign(d) { state.isExample = false; state.figureCanvas = null; state.sentImages = []; state.reviewChanges = []; state.currentId = null; state.alias = d.alias || {}; setBase(d.base, true); state.chosen = Object.assign({}, d.chosen); state.currentId = d.id; rebuild(); $("#step2").scrollIntoView({ behavior: "smooth", block: "start" }); }
function derivedOf(d) { const ap = OPT.applyOptions(d.base, d.chosen || {}, d.alias || {}); return ap.circuit; }
function combineSelected() {
  const picks = state.library.filter((d) => state.picked.has(d.id)); if (picks.length < 2) { toast("Tick two or more designs first."); return; }
  const merged = window.DS2K_COMBINE.combine(picks.map((d) => { const ap = OPT.applyOptions(d.base, d.chosen || {}, d.alias || {}); return { name: d.name, circuit: ap.circuit, sim: SIM.bake(d.base.sim, ap.values, ap.circuit, d.alias || {}) }; }).reverse());
  state.isExample = false; state.figureCanvas = null; state.sentImages = []; state.reviewChanges = []; state.currentId = null; state.picked = new Set(); setBase(merged); saveCurrent(true); renderResult(); renderLibrary(); $("#step2").scrollIntoView({ behavior: "smooth", block: "start" });
}
function importDesign(file) {
  const fr = new FileReader(); fr.onload = guard(() => { let d; try { d = JSON.parse(String(fr.result)); } catch (e) { toast("That file is not a design (.json)."); return; } const base = d.base || d; if (!base || !Array.isArray(base.components) || !Array.isArray(base.nets)) { toast("That file is not a design (.json)."); return; }
    const entry = { id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: d.name || (base.design || {}).title || file.name.replace(/\.json$/i, ""), saved: Date.now(), base, alias: d.alias || {}, chosen: d.chosen || {}, parts: base.components.length }; state.library.unshift(entry); storeLibrary(); openDesign(entry); }); fr.readAsText(file);
}
function renderLibrary() {
  const box = $("#libui"); if (!box) return; box.innerHTML = ""; const list = state.library;
  if (!list.length) box.append(el("p", { class: "muted" }, "Nothing saved yet."));
  else {
    const t = el("table", { class: "lib" }); const tb = el("tbody", {});
    for (const d of list) { const cur = d.id === state.currentId; const name = el("input", { type: "text", id: "lib_" + d.id, value: d.name, "aria-label": "Design name", onchange: () => { d.name = name.value.trim() || d.name; storeLibrary(); } });
      const del = el("button", { type: "button", class: "quiet", onclick: () => { if (del.dataset.sure) { state.library = state.library.filter((x) => x !== d); state.picked.delete(d.id); if (cur) state.currentId = null; storeLibrary(); renderLibrary(); renderResult(); } else { del.dataset.sure = "1"; del.textContent = "Really delete?"; setTimeout(() => { delete del.dataset.sure; del.textContent = "Delete"; }, 3000); } } }, "Delete");
      tb.append(el("tr", { class: cur ? "cur" : "" }, el("td", { class: "pick" }, el("input", { type: "checkbox", checked: state.picked.has(d.id), "aria-label": "Select " + d.name, onchange: (ev) => { if (ev.target.checked) state.picked.add(d.id); else state.picked.delete(d.id); renderLibrary(); } })), el("td", {}, name),
        el("td", { class: "small nowrap" }, (d.parts || 0) + " parts" + ((d.base.blocks || []).length > 1 ? " · " + d.base.blocks.length + " blocks" : "")), el("td", { class: "nowrap" }, el("button", { type: "button", onclick: () => openDesign(d) }, cur ? "Open ✓" : "Open"), el("button", { type: "button", class: "quiet", onclick: () => saveFile(DS2K.safeName(d.name) + ".design.json", JSON.stringify({ name: d.name, base: d.base, alias: d.alias, chosen: d.chosen }, null, 1), "application/json") }, "Export"), del))); }
    t.append(tb); box.append(el("div", { class: "scroll wide" }, t));
  }
  const n = state.picked.size; const imp = el("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: () => { const f = imp.files[0]; imp.value = ""; if (f) importDesign(f); } });
  box.append(el("div", { class: "row" }, el("button", { type: "button", class: n >= 2 ? "primary" : "", id: "combinebtn", disabled: n < 2, onclick: combineSelected }, n >= 2 ? "Combine " + n + " into one schematic" : "Combine into one schematic"), el("button", { type: "button", onclick: () => imp.click() }, "Import…"), imp));
}

/* ------------------------------------------------------------------ simulation: stand-ins for the chips, quick run in the page, ngspice file */
const simState = { result: null, on: false };
function simModel() { if (!state.base.sim || typeof state.base.sim !== "object") state.base.sim = {}; const c = SIM.cleanSim(state.base.sim, state.circuit); Object.assign(state.base.sim, c); return state.base.sim; }
function runSim() { simState.on = true; try { simState.result = SIM.run(state.circuit, state.base.sim, state.applied.values, state.alias); } catch (e) { simState.result = { ok: false, error: e.message, notes: [] }; } renderSim(); }
function fmtSI(v, unit) { const a = Math.abs(v); const [k, p] = a >= 1 ? [1, ""] : a >= 1e-3 ? [1e3, "m"] : a >= 1e-6 ? [1e6, "µ"] : a === 0 ? [1, ""] : [1e9, "n"]; return fmtNum(v * k) + " " + p + unit; }
function simChart(res) {
  const W = 720, H = 300, L = 46, R = 14, T = 12, B = 30; const tmax = res.t[res.t.length - 1] || 1; let lo = 0, hi = 0; for (const tr of res.traces) for (const v of tr.v) { if (v < lo) lo = v; if (v > hi) hi = v; } if (hi - lo < 1e-9) hi = lo + 1; const pad = (hi - lo) * 0.08; hi += pad; if (lo < 0) lo -= pad;
  const X = (t) => L + (t / tmax) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B); const ns = "http://www.w3.org/2000/svg"; const mk = (tag, at, txt) => { const e = document.createElementNS(ns, tag); for (const k in at) e.setAttribute(k, at[k]); if (txt !== undefined) e.textContent = txt; return e; };
  const svg = mk("svg", { viewBox: "0 0 " + W + " " + H, class: "simchart", role: "img", "aria-label": "Simulated voltages over time" }); const step = Math.pow(10, Math.floor(Math.log10((hi - lo) / 4))); const tick = [1, 2, 5, 10].map((m) => m * step).find((s) => (hi - lo) / s <= 6);
  for (let v = Math.ceil(lo / tick) * tick; v <= hi; v += tick) { svg.append(mk("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: "grid" + (Math.abs(v) < tick / 1e6 ? " zero" : "") }), mk("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end", class: "axis" }, fmtNum(v) + " V")); }
  for (let i = 0; i <= 4; i++) svg.append(mk("text", { x: X(tmax * i / 4), y: H - 8, "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle", class: "axis" }, fmtSI(tmax * i / 4, "s")));
  res.traces.forEach((tr, j) => { let d = ""; tr.v.forEach((v, i) => { d += (i ? "L" : "M") + X(res.t[i]).toFixed(1) + " " + Y(v).toFixed(1); }); svg.append(mk("path", { d, class: "trace s" + (j + 1) })); });
  const cur = mk("line", { y1: T, y2: H - B, class: "cursor", visibility: "hidden" }); svg.append(cur); const tip = el("div", { class: "simtip", hidden: true }); const wrap = el("div", { class: "simwrap" }, svg, tip);
  const move = (ev) => { const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) / r.width * W; if (px < L || px > W - R) { cur.setAttribute("visibility", "hidden"); tip.hidden = true; return; } const t = (px - L) / (W - L - R) * tmax; let i = Math.min(res.t.length - 1, Math.max(0, Math.round(t / tmax * (res.t.length - 1)))); cur.setAttribute("x1", X(res.t[i])); cur.setAttribute("x2", X(res.t[i])); cur.setAttribute("visibility", "visible");
    tip.hidden = false; tip.innerHTML = ""; tip.append(el("b", {}, fmtSI(res.t[i], "s")), ...res.traces.map((tr, j) => el("span", {}, el("i", { class: "key s" + (j + 1) }), tr.label + "  " + tr.v[i].toFixed(3) + " V"))); tip.style.left = Math.min(r.width - 150, Math.max(0, (ev.clientX - r.left) + 12)) + "px"; };
  svg.addEventListener("pointermove", move); svg.addEventListener("pointerleave", () => { cur.setAttribute("visibility", "hidden"); tip.hidden = true; }); return wrap;
}
function renderSim() {
  const box = $("#simui"); if (!box) return; box.innerHTML = ""; if (!state.circuit || !state.applied) return; const sm = SIM.cleanSim(state.base.sim, state.circuit); const edit = (fn) => liveEdit(() => { const m = simModel(); fn(m); });
  const field = (id, val, ph, w, on) => { const i = el("input", { type: "text", id, value: val === undefined || val === null ? "" : String(val), placeholder: ph, style: "width:" + w + "px", "aria-label": ph, onchange: edit((m) => on(m, i.value.trim())) }); return i; };
  const waveRow = (list, idx, label, kinds) => { const s = sm[list][idx]; const id = "sim_" + list + idx; const kind = String(s.kind || "dc").toLowerCase(); const set = (k) => (m, v) => { m[list][idx][k] = v; };
    const sel = el("select", { id: id + "k", "aria-label": label + " kind", onchange: edit((m) => { m[list][idx].kind = sel.value; }) }, kinds.map((k) => el("option", { value: k, selected: k === kind }, { dc: "steady voltage", pulse: "clock / PWM", sine: "sine", load: "load to ground", open: "nothing" }[k])));
    const parts = kind === "pulse" ? [field(id + "l", s.low === undefined ? 0 : s.low, "low V", 64, set("low")), "to", field(id + "h", s.high !== undefined ? s.high : s.value, "high V", 64, set("high")), "V at", field(id + "f", s.freq, "Hz", 90, set("freq")), "Hz, duty", field(id + "d", s.duty === undefined ? 0.5 : s.duty, "0-1", 110, set("duty"))]
      : kind === "sine" ? [field(id + "v", s.ampl !== undefined ? s.ampl : s.value, "amplitude V", 70, set("value")), "V at", field(id + "f", s.freq, "Hz", 90, set("freq")), "Hz around", field(id + "o", s.offset || 0, "offset V", 64, set("offset")), "V"] : kind === "load" ? [field(id + "v", s.value, "ohm", 90, set("value")), "Ω"] : kind === "open" ? [] : [field(id + "v", s.value, "V", 90, set("value")), "V"];
    return el("div", { class: "simrow" }, el("span", { class: "mono what" }, label), sel, ...parts, s.note ? el("small", {}, s.note) : null); };
  const rows = [];
  sm.sources.forEach((s, i) => rows.push(waveRow("sources", i, s.net, ["dc", "pulse", "sine"]))); sm.chips.forEach((c, i) => { const id = "sim_chip" + i; rows.push(el("div", { class: "simrow" }, el("span", { class: "mono what" }, c.ref), String(c.model).toLowerCase() === "regulator" ? ["ideal regulator,", field(id + "v", c.vout, "V", 70, (m, v) => { m.chips[i].vout = v; }), "V out,", field(id + "d", c.dropout === undefined ? 0.3 : c.dropout, "V", 56, (m, v) => { m.chips[i].dropout = v; }), "V drop-out"] : ["ideal op-amp"])); });
  sm.standins.forEach((s, i) => { const comp = state.circuit.components.find((k) => k.ref === (state.alias[s.ref] || String(s.ref).toUpperCase())); const pn = comp && (comp.pins || []).find((p) => String(p.number) === String(s.pin)); rows.push(waveRow("standins", i, s.ref + " pin " + s.pin + (pn && pn.name ? " (" + pn.name + ")" : ""), ["dc", "pulse", "sine", "load", "open"])); });
  sm.loads.forEach((l, i) => rows.push(el("div", { class: "simrow" }, el("span", { class: "mono what" }, l.net), "load", field("sim_load" + i, l.value, "ohm", 110, (m, v) => { m.loads[i].value = v; }), "Ω", l.note ? el("small", {}, l.note) : null)));
  box.append(el("p", { class: "small" }, "Each chip is replaced by what it does:"));
  box.append(el("div", { class: "simrows" }, rows.length ? rows : el("p", { class: "muted" }, "Nothing drives this circuit yet.")));
  const nets = state.circuit.nets.filter((n) => n.kind !== "ground" && !/^N\$/.test(n.name)).map((n) => n.name); const on = new Set(sm.probes.map((p) => p.toUpperCase()));
  box.append(el("div", { class: "row" }, el("span", { class: "small" }, "Plot"), el("span", { class: "chips" }, nets.map((n, i) => el("button", { type: "button", id: "probe" + i, class: "chip" + (on.has(n.toUpperCase()) ? " on" : ""), "aria-pressed": on.has(n.toUpperCase()) ? "true" : "false", onclick: edit((m) => { const cur = m.probes.filter((p) => nets.includes(p)); m.probes = on.has(n.toUpperCase()) ? cur.filter((p) => p.toUpperCase() !== n.toUpperCase()) : cur.concat([n]).slice(-4); }) }, n)))));
  box.append(el("div", { class: "row" }, el("button", { type: "button", class: "primary big", id: "simbtn", onclick: runSim }, simState.on ? "Run again" : "Run simulation"), el("label", { for: "sim_t" }, "for"), field("sim_t", sm.tstop ? sm.tstop * 1000 : "", "auto", 70, (m, v) => { const x = parseFloat(v); m.tstop = x > 0 ? x / 1000 : undefined; }), el("span", { class: "small" }, "ms"),
    el("button", { type: "button", id: "cirbtn", onclick: () => { const r = state.result; const txt = r && r.files[r.name + "_ngspice.cir"]; if (txt) saveFile(r.name + (IN_HOST ? "_ngspice.cir.txt" : "_ngspice.cir"), txt, "text/plain"); } }, "Download ngspice file")));
  const res = simState.result; if (!simState.on || !res) return;
  if (!res.ok) { box.append(el("p", { class: "note bad" }, res.error)); return; }
  if (res.traces.length) { box.append(el("div", { class: "legend" }, res.traces.map((tr, j) => el("span", {}, el("i", { class: "key s" + (j + 1) }), tr.label, el("b", {}, " " + tr.v[tr.v.length - 1].toFixed(2) + " V")))), simChart(res)); } else box.append(el("p", { class: "muted" }, "Pick at least one net to plot."));
  const others = Object.entries(res.final).filter(([k]) => !/^nc_|^load_|^N_\d+$/.test(k)).slice(0, 24); box.append(el("details", { class: "more" }, el("summary", {}, "Voltages at the end"), el("div", { class: "endv mono" }, others.map(([k, v]) => el("span", {}, k + " " + v.toFixed(3) + " V")))));
  if (res.notes.length) box.append(el("details", { class: "checks" }, el("summary", {}, res.notes.length + " simulation note" + (res.notes.length > 1 ? "s" : "")), el("div", {}, el("ul", {}, res.notes.map((x) => el("li", {}, x))))));
}

/* ------------------------------------------------------------------ parts + advanced */
function buyOf(k) { const b = (state.base.components.find((x) => x.ref === k.ref) || {}); return k.lcsc && b.buy ? b.buy : null; }
function buyInfo(k) { const b = buyOf(k); if (!b) return null; const stock = b.stock >= 1000 ? Math.round(b.stock / 1000) + "k" : String(b.stock); return el("small", { class: b.stock < 100 ? "lowstock" : "" }, (b.price !== null ? "$" + (b.price < 0.1 ? b.price.toFixed(4) : b.price.toFixed(2)) + " · " : "") + stock + " in stock" + (b.basic ? " · basic" : "") + (b.alts && b.alts.length ? " · or " + b.alts.join(", ") : "")); }
let TAB = "nets";
function renderParts() {
  const box = $("#circuitui"); if (!box) return; const wasOpen = ($("#adv") || {}).open; box.innerHTML = ""; const c = state.circuit, r = state.result; if (!c || !r) return;
  const fp = {}; for (const s of r.symbols) fp[s.ref] = s.footprint; const rowOf = {}; for (const row of r.bom) for (const ref of row.refs) rowOf[ref] = row; const auto = state.applied.controlled;
  const t = el("table", {}, el("thead", {}, el("tr", {}, ...["", "Value", "Package", "Part number", "Footprint", "Buy"].map((h) => el("th", {}, h))))); const tb = el("tbody", {});
  c.components.forEach((k) => {
    const row = rowOf[k.ref] || {}; const cell = (f, ph, locked) => el("input", { type: "text", id: "p_" + k.ref + "_" + f, value: k[f] || "", placeholder: ph || "", disabled: locked, title: locked ? "Set by the options above" : null, "data-ref": k.ref, "data-f": f, "data-was": k[f] || "", "aria-label": k.ref + " " + f, onchange: liveEdit(collectEdits) });
    tb.append(el("tr", { class: k.dnp ? "dnp" : "" }, el("td", { class: "mono" }, k.ref), el("td", {}, cell("value", "", auto.has(k.ref)), k.rating ? el("small", {}, k.rating) : null), el("td", {}, cell("package", ["resistor", "capacitor", "ferrite_bead", "thermistor", "led"].includes(k.type) ? "0603" : "")), el("td", {}, cell("mpn", row.mpn || k.suggested_mpn || "", auto.has(k.ref + ".mpn"))),
      el("td", { class: "mono small" }, fp[k.ref] ? fp[k.ref].split(":").pop() : "-"),
      el("td", { class: "buy" }, buyInfo(k), k.lcsc ? el("a", { href: "https://www.lcsc.com/product-detail/" + k.lcsc + ".html", target: "_blank", rel: "noopener" }, k.lcsc) : el("a", { href: row.lcscUrl || "#", target: "_blank", rel: "noopener" }, "LCSC"), " ", el("a", { href: row.mouserUrl || "#", target: "_blank", rel: "noopener" }, "Mouser"))));
  });
  t.append(tb); box.append(el("div", { class: "scroll wide" }, t));
  let total = 0, priced = 0, fitted = 0; for (const k of c.components) { if (k.dnp) continue; fitted++; const b = buyOf(k); if (b && b.price !== null) { total += b.price; priced++; } }
  if (priced) box.append(el("p", { class: "small" }, "About $" + total.toFixed(2) + " per board for " + priced + " of " + fitted + " parts (LCSC price for one piece)."));
  if (!IN_HOST) box.append(el("div", { class: "row" }, el("button", { type: "button", onclick: findParts }, "Find LCSC parts, prices and stock"), el("div", { id: "srcstatus", class: "status", role: "status", "aria-live": "polite" })));

  const tabs = el("div", { class: "tabs" }); const notes = (state.reviewChanges || []).concat(c.notes || []);
  for (const [k, label] of [["nets", "Connections"], ["notes", "Notes"], ["json", "JSON"]]) { if (k === "notes" && !notes.length) continue; tabs.append(el("button", { type: "button", class: "tab" + (TAB === k ? " on" : ""), "aria-pressed": TAB === k ? "true" : "false", onclick: () => { TAB = k; renderParts(); } }, label)); }
  const body = el("div", { class: "scroll" });
  if (TAB === "notes" && !notes.length) TAB = "nets";
  if (TAB === "nets") {
    const nt = el("table", {}, el("thead", {}, el("tr", {}, ...["Net", "Pins (REF.PIN)"].map((h) => el("th", {}, h))))); const nb = el("tbody", {});
    c.nets.forEach((n, i) => { const pins = (n.nodes || []).map((x) => x.ref + "." + x.pin).join(", "); nb.append(el("tr", {}, el("td", { class: "netname" }, el("input", { type: "text", id: "n" + i + "name", value: n.name, "data-net": n.name, "data-f": "name", "data-was": n.name, "aria-label": "net name", onchange: liveEdit(collectEdits) })), el("td", {}, el("input", { type: "text", class: "mono", id: "n" + i + "nodes", value: pins, "data-net": n.name, "data-f": "nodes", "data-was": pins, "aria-label": "pins on " + n.name, onchange: liveEdit(collectEdits) })))); });
    nt.append(nb); body.append(nt);
  } else if (TAB === "notes") body.append(el("ul", { class: "plain" }, notes.map((x) => el("li", {}, x))));
  else body.append(el("textarea", { id: "rawjson", spellcheck: "false", "aria-label": "Circuit JSON" }, JSON.stringify(state.base, (k, v) => (k === "lcscFor" || k === "lcscMpn" ? undefined : v), 1)), el("div", { class: "row" }, el("button", { type: "button", onclick: applyJson }, "Apply JSON")));
  const canReview = canAsk() && !state.isExample && state.pdf;
  box.append(el("details", { id: "adv", open: !!wasOpen }, el("summary", {}, "Advanced"), el("div", {}, tabs, body,
    el("div", { class: "row" }, canReview ? el("button", { type: "button", onclick: reviewCircuit }, "Double-check") : null, el("button", { type: "button", class: "quiet", onclick: showSchematicText }, "Show .kicad_sch text")),
    el("div", { id: "reviewstatus", class: "status", role: "status", "aria-live": "polite" }), el("div", { id: "schbox" }))));
}
function applyJson() { const ta = $("#rawjson"); if (!ta) return; let d; try { d = JSON.parse(ta.value); } catch (e) { toast("That JSON is not valid."); return; } if (!d || !Array.isArray(d.components) || !Array.isArray(d.nets)) { toast("The JSON needs \"components\" and \"nets\" lists."); return; } const chosen = state.chosen; setBase(d, true); state.chosen = chosen; rebuild(); toast("Applied."); }
function showSchematicText(where) {
  const r = state.result; if (!r) return; const fb = $(typeof where === "string" ? where : "#schbox") || $("#dlfallback"); fb.innerHTML = ""; const txt = r.files[r.name + ".kicad_sch"];
  fb.append(el("p", { class: "small" }, "Save this text as " + r.name + ".kicad_sch - it opens in KiCad on its own."), el("textarea", { id: "schtext", readonly: true, "aria-label": "Schematic file contents" }, txt),
    el("div", { class: "row" }, el("button", { type: "button", onclick: async () => { try { await navigator.clipboard.writeText(txt); toast("Copied."); } catch (e) { $("#schtext").focus(); $("#schtext").select(); toast("Press Cmd+C to copy the selected text."); } } }, "Copy all")));
}
/* save through the host when published, as a normal browser download when opened as a local file */
async function saveFile(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || "application/octet-stream" });
  if (IN_HOST) {
    if (!state.downloads) return "unavailable";
    try { await state.downloads.save({ filename, data: blob }); toast("Saved " + filename); return "saved"; } catch (e) { if (e && e.code === "declined") return "declined"; toast("Saving was refused here (" + ((e && e.code) || "error") + ").", 7000); return "failed"; }
  }
  const url = URL.createObjectURL(blob); const a = el("a", { href: url, download: filename }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); toast("Downloaded " + filename); return "saved";
}
async function downloadProject() {
  const r = state.result; if (!r) return; const st = await saveFile(r.name + "_kicad.zip", new Blob([window.DS2K_ZIP.makeZip(r.files, r.name)], { type: "application/zip" }));
  if (st === "unavailable" || st === "failed") { if (st === "unavailable") toast("Saving files is not available in this view - the schematic text is shown instead.", 8000); showSchematicText("#dlfallback"); }
}

/* ------------------------------------------------------------------ misc UI */
function setStatus(id, msg, spin, onStop) { const s = document.getElementById(id); if (!s) return; s.innerHTML = ""; if (!msg) return; if (spin) s.append(el("span", { class: "spin", "aria-hidden": "true" })); s.append(el("span", {}, msg)); if (onStop) s.append(el("button", { type: "button", class: "quiet", onclick: onStop }, "Stop")); }
function toast(msg, ms) { document.querySelectorAll(".toast").forEach((t) => t.remove()); const t = el("div", { class: "toast", role: "alert" }, msg); document.body.append(t); setTimeout(() => t.remove(), ms || 5000); }

function boot() {
  const benign = (e) => /ResizeObserver|Rendering cancelled|RenderingCancelled|Script error|AbortError|cancelled/i.test(String((e && (e.name + " " + (e.message || e.code || ""))) || e));
  window.addEventListener("error", (ev) => { const e = ev.error || ev.message; if (!benign(e)) showError(e); }); window.addEventListener("unhandledrejection", (ev) => { if (!benign(ev.reason)) showError(ev.reason); });
  window.addEventListener("ds2k-pdfready", () => { state.pdfReady = true; renderDiag(); });
  const drop = $("#drop"), file = $("#file");
  file.addEventListener("change", guard(() => { const f = file.files[0]; file.value = ""; return openPdf(f); }));
  $("#pick").addEventListener("click", guard((ev) => { ev.preventDefault(); file.click(); }));
  for (const ev of ["dragenter", "dragover"]) document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  document.addEventListener("drop", guard((e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) return openPdf(f); }));
  $("#copyprompt").addEventListener("click", guard(async () => { const p = manualPrompt(); try { await navigator.clipboard.writeText(p); toast("Prompt copied."); } catch (e) { const ta = $("#manualjson"); ta.value = p; ta.focus(); ta.select(); toast("The prompt is in the text box and selected - press Cmd+C to copy it.", 8000); } }));
  $("#usejson").addEventListener("click", guard(() => { let data; try { data = parseLoose($("#manualjson").value); } catch (e) { toast("That is not valid JSON."); return; } if (data && data.circuit && Array.isArray(data.circuit.components)) data = data.circuit; if (!data || !Array.isArray(data.components) || !Array.isArray(data.nets)) { toast("The JSON needs \"components\" and \"nets\" lists."); return; } state.isExample = false; state.figureCanvas = null; state.sentImages = []; state.reviewChanges = []; state.currentId = null; setBase(data); saveCurrent(true); $("#step2").scrollIntoView({ behavior: "smooth", block: "start" }); }));
  const key = $("#apikey"), model = $("#model");
  if (key) { key.value = store.get("key"); model.value = store.get("model") || "claude-opus-5"; $("#savekey").addEventListener("click", guard(() => { store.set("key", key.value.trim()); store.set("model", model.value.trim() || "claude-opus-5"); renderDiag(); if (key.value.trim()) $("#keyui").open = false; if (state.pdf) renderDatasheet(); renderResult(); renderParts(); toast(key.value.trim() ? "Key saved in this browser only." : "Key removed."); })); }
  loadLibrary(); setBase(window.DS2K_EXAMPLE); renderDiag(); initCapabilities();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

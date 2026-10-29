/* KiLive — board actions: what can be done with a board while it runs, worked out from its netlist.
   Power inputs plugged in or out, regulators / converters / load switches forced on or off, processors' programs,
   buttons, switches, encoders and potentiometers, conversations between chips (I2C, SPI, UART, processor to processor,
   LED chains, power enables), resets and clocks, and the part models behind the simulation (with an editor that saves
   new models to the shared library). N.actions = { build(panel, body), groups(L), program(a, act) } */
(function () {
  'use strict';
  const N = window.Noeti;
  const el = N.el;
  const I = N.icons;
  const A = (N.actions = {});
  const fmt = () => N.liveFmt;
  const sn = n => (N.fmt && N.fmt.shortNet ? N.fmt.shortNet(n) : String(n || ''));
  const up = s => String(s == null ? '' : s).toUpperCase();
  const hex = a => '0x' + a.toString(16).toUpperCase().padStart(2, '0');

  // ------------------------------------------------------------------ programs for one conversation
  // a: the processor's analysis (N.analysis.forProc); act: { kind, bus, dev, u, link, chain, en, on }
  const q = io => JSON.stringify(N.fw.shortPin(io));
  function wireBegin(a, bus) {
    const ard = a.proc.chip && a.proc.chip.arduino && a.proc.chip.arduino.wire;
    const def = ard && ard.sda === bus.sdaIo.chipPin && ard.scl === bus.sclIo.chipPin;
    return def ? '  Wire.begin();' : `  Wire.begin(${q(bus.sdaIo)}, ${q(bus.sclIo)});   // the I2C pins on this board`;
  }
  const head = (a, what) => [`// ${what}`, `// Written for ${a.proc.ref} (${a.proc.chip ? a.proc.chip.name : a.proc.value}) from this board's netlist. Edit it freely.`, ''];
  A.program = function (a, act) {
    const p = a.proc, L = [];
    const k = act.kind;
    if (k === 'i2c-scan') {
      const b = act.bus;
      L.push(...head(a, `Scan the I2C bus on ${N.fw.shortPin(b.sdaIo)} / ${N.fw.shortPin(b.sclIo)}: every address that answers.`), '#include <Wire.h>', '',
        'void setup() {', '  Serial.begin(115200);', wireBegin(a, b), '}', '',
        'void loop() {', `  Serial.println("Scanning the I2C bus (${b.devices.length} part${b.devices.length === 1 ? '' : 's'} expected) ...");`, '  int n = 0;',
        '  for (int addr = 1; addr < 127; addr++) {', '    Wire.beginTransmission(addr);', '    if (Wire.endTransmission() == 0) { Serial.printf("  0x%02X answers\\n", addr); n++; }', '  }',
        '  Serial.printf("%d device(s) found\\n\\n", n);', '  delay(2000);', '}');
    } else if (k === 'i2c-dev') {
      const b = act.bus, d = act.dev, addr = hex(d.address);
      const lib = N.analysis.SENSOR_LIBS && N.analysis.SENSOR_LIBS[d.spec.id];
      const idr = N.analysis.ID_REGS && N.analysis.ID_REGS[d.spec.id];
      L.push(...head(a, `Talk to ${d.ref} (${d.spec.name}) over I2C at ${addr}.`), '#include <Wire.h>');
      if (lib) {
        L.push(`#include <${/^RTC_/.test(lib.cls) ? 'RTClib' : lib.cls}.h>`, '', `${lib.cls} ${lib.v}${lib.ctor ? lib.ctor(addr) : ''};`, 'bool ok = false;', '',
          'void setup() {', '  Serial.begin(115200);', wireBegin(a, b), `  ok = ${lib.begin(addr)};`, `  Serial.println(ok ? "${d.spec.name} ${d.ref} answered at ${addr}" : "${d.spec.name} ${d.ref} did not answer at ${addr}");`, '}', '',
          'void loop() {', '  if (ok) {', `    String NAME = "${d.spec.name}";`, ...lib.read(lib.v).map(x => '    ' + x), '  }', '  delay(1000);', '}');
      } else {
        L.push('', 'int readReg(int addr, int reg) {', '  Wire.beginTransmission(addr);', '  Wire.write(reg);', '  if (Wire.endTransmission(false) != 0) return -1;', '  Wire.requestFrom(addr, 1);', '  return Wire.available() ? Wire.read() : -1;', '}', '',
          'void setup() {', '  Serial.begin(115200);', wireBegin(a, b), '}', '', 'void loop() {');
        if (idr) L.push(`  int id = readReg(${addr}, ${hex(idr[0])});`, `  if (id < 0) Serial.println("${d.ref} ${d.spec.name} did not answer at ${addr}");`, `  else Serial.printf("${d.ref} ${d.spec.name}: ID register ${hex(idr[0])} = 0x%02X (the datasheet says ${hex(idr[1])})\\n", id);`);
        else L.push(`  Wire.beginTransmission(${addr});`, '  Wire.write(0);', '  if (Wire.endTransmission(false) != 0) {', `    Serial.println("${d.ref} ${d.spec.name} did not answer at ${addr}");`, '  } else {', `    Wire.requestFrom(${addr}, 8);`, `    Serial.print("${d.ref} ${d.spec.name} registers 0x00-0x07:");`, '    while (Wire.available()) Serial.printf(" %02X", Wire.read());', '    Serial.println();', '  }');
        L.push('  delay(1000);', '}');
      }
    } else if (k === 'spi-dev') {
      const d = act.dev, cs = d.csIo;
      const id = d.spec.id;
      L.push(...head(a, `Talk to ${d.ref} (${d.spec.name}) over SPI${cs ? ', chip select ' + N.fw.shortPin(cs) : ''}.`), '#include <SPI.h>', '');
      const CS = cs ? q(cs) : null;
      const sel = v => (CS ? `  digitalWrite(${CS}, ${v});` : '');
      L.push('void setup() {', '  Serial.begin(115200);', CS ? `  pinMode(${CS}, OUTPUT);` : '', CS ? `  digitalWrite(${CS}, HIGH);` : '', '  SPI.begin();');
      if (id === 'mcp2515') L.push(sel('LOW'), '  SPI.transfer(0xC0);   // RESET', sel('HIGH'), '  delay(5);');
      L.push('}', '', 'void loop() {');
      if (id === 'spiflash' || id === 'psram') L.push(sel('LOW'), '  SPI.transfer(0x9F);   // read JEDEC ID', ...(id === 'psram' ? ['  SPI.transfer(0); SPI.transfer(0); SPI.transfer(0);'] : []), '  int m = SPI.transfer(0), t = SPI.transfer(0), c = SPI.transfer(0);', sel('HIGH'), `  Serial.printf("${d.ref} ${d.spec.name}: JEDEC ID %02X %02X %02X\\n", m, t, c);`);
      else if (id === 'mcp2515') L.push(sel('LOW'), '  SPI.transfer(0x03); SPI.transfer(0x0E);   // READ CANSTAT', '  int st = SPI.transfer(0);', sel('HIGH'), `  Serial.printf("${d.ref} MCP2515 CANSTAT = 0x%02X (0x80 after reset: configuration mode)\\n", st);`);
      else if (id === 'adc081s021') L.push(sel('LOW'), '  int hi = SPI.transfer(0), lo = SPI.transfer(0);', sel('HIGH'), '  int v = ((hi << 8) | lo) >> 4 & 0xFF;', `  Serial.printf("${d.ref} ADC: %d / 255\\n", v);`);
      else if (id === '74hc595') L.push('  static int n = 0;', '  n = (n + 1) & 0xFF;', sel('LOW'), '  SPI.transfer(n);', sel('HIGH'), `  Serial.printf("${d.ref} 74HC595 outputs = 0x%02X\\n", n);`);
      else if (id === 'sdcard') L.push(sel('HIGH'), '  for (int i = 0; i < 10; i++) SPI.transfer(0xFF);   // 80 clocks with CS high', sel('LOW'), '  SPI.transfer(0x40); SPI.transfer(0); SPI.transfer(0); SPI.transfer(0); SPI.transfer(0); SPI.transfer(0x95);   // CMD0', '  int r = 0xFF;', '  for (int i = 0; i < 8 && r == 0xFF; i++) r = SPI.transfer(0xFF);', sel('HIGH'), `  Serial.printf("${d.ref} microSD: CMD0 answer 0x%02X (0x01 = idle, a card is there)\\n", r);`);
      else L.push(sel('LOW'), '  int r = SPI.transfer(0);', sel('HIGH'), `  Serial.printf("${d.ref} ${d.spec.name}: read 0x%02X\\n", r);`);
      L.push('  delay(1000);', '}');
    } else if (k === 'uart') {
      const u = act.u;
      L.push(...head(a, `Talk on the serial port to the ${u.peer}: a line every second, and whatever comes back.`), '', 'void setup() {', '  Serial.begin(115200);', '}', '', 'int n = 0;', 'unsigned long last = 0;', '',
        'void loop() {', '  if (n == 0 || millis() - last >= 1000) {', '    last = millis();', `    Serial.printf("hello from ${p.ref} (%d)\\n", n++);`, '  }', '  while (Serial.available()) {', '    int c = Serial.read();', '    Serial.print("got: ");', '    Serial.write(c);', '    Serial.println();', '  }', '  delay(5);', '}');
    } else if (k === 'link-send' || k === 'link-echo') {
      const lk = act.link;
      if (k === 'link-send') L.push(...head(a, `Talk to ${lk.to} over the UART (${N.fw.shortPin(lk.tx)} → ${lk.to} ${N.fw.shortPin(lk.rx)}): "ping" twice a second; ${lk.to} answers "pong".`), '', 'void setup() {', '  Serial.begin(115200);', '}', '', 'int n = 0;', 'unsigned long last = 0;', '',
        'void loop() {', '  if (n == 0 || millis() - last >= 500) {', '    last = millis();', '    Serial.printf("ping %d\\n", n++);', '  }', '  while (Serial.available()) Serial.read();   // the answers', '  delay(5);', '}');
      else L.push(...head(a, `Answer ${lk.from} on the UART: every "ping" line that arrives gets a "pong" back.`), '', 'void setup() {', '  Serial.begin(115200);', '}', '',
        'void loop() {', '  if (Serial.available()) {', '    String line = Serial.readStringUntil(\'\\n\');', '    if (line.startsWith("ping")) Serial.println("pong" + line.substring(4));', '  }', '  delay(2);', '}');
    } else if (k === 'pixels') {
      const ch = act.chain;
      L.push(...head(a, `A rainbow on the ${ch.leds.length} addressable LED${ch.leds.length > 1 ? 's' : ''} on ${N.fw.shortPin(ch.io)}.`), '#include <Adafruit_NeoPixel.h>', '', `Adafruit_NeoPixel strip(${ch.leds.length}, ${q(ch.io)}, NEO_GRB + NEO_KHZ800);`, 'long hue = 0;', '',
        'void setup() {', '  strip.begin();', '  strip.setBrightness(60);', '}', '', 'void loop() {', '  hue += 512;', '  for (int i = 0; i < strip.numPixels(); i++) strip.setPixelColor(i, strip.ColorHSV(hue + i * 65536 / strip.numPixels()));', '  strip.show();', '  delay(30);', '}');
    } else if (k === 'leds') {
      const leds = a.leds.slice(0, 8);
      L.push(...head(a, `Blink ${leds.map(l => l.ref).join(', ')} one after the other.`), '', 'void setup() {', ...leds.map(l => `  pinMode(${q(l.io)}, OUTPUT);`), '}', '', 'void loop() {');
      for (const l of leds) L.push(`  digitalWrite(${q(l.io)}, ${l.activeHigh ? 'HIGH' : 'LOW'});   // ${l.ref} on`, '  delay(250);', `  digitalWrite(${q(l.io)}, ${l.activeHigh ? 'LOW' : 'HIGH'});`);
      L.push('  delay(250);', '}');
    } else if (k === 'enable') {
      const e = act.en, lvl = (act.on ? e.activeHigh : !e.activeHigh) ? 'HIGH' : 'LOW';
      L.push(...head(a, `Switch ${e.ref} (${e.value}) ${act.on ? 'on' : 'off'} from ${N.fw.shortPin(e.io)}.`), '', 'void setup() {', '  Serial.begin(115200);', `  pinMode(${q(e.io)}, OUTPUT);`, `  digitalWrite(${q(e.io)}, ${lvl});   // ${e.ref} ${act.on ? 'on' : 'off'}`, `  Serial.println("${e.ref} switched ${act.on ? 'on' : 'off'}");`, '}', '', 'void loop() {', '  delay(1000);', '}');
    } else if (k === 'analog') {
      const chip = p.chip, bits = (chip && chip.adc && (chip.adc.arduinoBits || chip.adc.bits)) || 10, vref = (chip && chip.adc && chip.adc.vref) || p.vnom || 3.3;
      L.push(...head(a, 'Read the analog inputs every half second.'), '', 'void setup() {', '  Serial.begin(115200);', '}', '', 'void loop() {');
      for (const x of a.analog.slice(0, 6)) L.push(`  Serial.printf("${N.fw.shortPin(x.io)} (${x.what.replace(/"/g, '')}): %.3f V\\n", analogRead(${q(x.io)}) * ${vref} / ${(1 << bits) - 1}.0${x.ratio ? ' / ' + x.ratio.toFixed(4) : ''});`);
      L.push('  Serial.println();', '  delay(500);', '}');
    } else if (k === 'buttons') {
      const bs = a.buttons.slice(0, 8);
      L.push(...head(a, `Report presses of ${bs.map(b => b.ref).join(', ')}.`), '', ...bs.map((b, i) => `int last${i} = HIGH;`), '', 'void setup() {', '  Serial.begin(115200);', ...bs.map(b => `  pinMode(${q(b.io)}, INPUT_PULLUP);`), '}', '', 'void loop() {');
      bs.forEach((b, i) => L.push(`  int s${i} = digitalRead(${q(b.io)});`, `  if (s${i} != last${i}) Serial.println(s${i} == LOW ? "${b.ref} pressed" : "${b.ref} released");`, `  last${i} = s${i};`));
      L.push('  delay(10);', '}');
    }
    return L.filter(x => x !== '').length ? L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n' : '';
  };

  // ------------------------------------------------------------------ running one
  function boardKey(L) { return (L.B && L.B.data && L.B.data.key) || 'board'; }
  function runOn(L, panel, p, src, sigs, decoders) {
    if (!src || !L.fwm) return null;
    const key = 'code:' + boardKey(L) + ':' + p.ref, prev = N.store.get(key, null);
    N.store.set(key, src);
    // the program it replaces stays one click away (Code tab: Undo on the note)
    if (prev && prev.trim() && prev !== src && panel && panel.chats) {
      const ck = 'chat:' + boardKey(L) + ':' + p.ref;
      const c = panel.chats.get(p.ref) || (N.store.get(ck, []) || []);
      const first = (src.split('\n')[0] || '').replace(/^\/\/\s*/, '');
      c.push({ role: 'note', text: 'Actions replaced the program: ' + first, undo: prev });
      while (c.length > 24) c.shift();
      panel.chats.set(p.ref, c);
      N.store.set(ck, c.map(x => ({ role: x.role, text: x.text })));
    }
    const pr = L.fwm.runScript(p, src);
    if (!L.running) { L.running = true; L.last = performance.now(); }
    if (pr.state === 'error') { N.toast(pr.error, 'warn'); return pr; }
    L.realTime();
    if ((sigs && sigs.length) || (decoders && decoders.length)) L.addSignals(sigs || [], decoders || [], { stay: true });
    return pr;
  }
  const sigOf = (L, proc, io) => ({ name: io.net, net: L.netIdx.get(io.net) || 0, ref: proc.ref, pin: io.number, pinName: N.fw.shortPin(io) });
  const okNet = (L, io) => io && io.net && L.netIdx.has(io.net) && !/^unconnected|^NC$/i.test(io.net);

  // ------------------------------------------------------------------ the list
  // groups: [{ id, title, hint, items: [{ id, title, sub, status(), controls: [...] }] }]
  A.groups = function (L, panel) {
    const E = () => L.engine;
    const f = fmt();
    const groups = [];
    const comp = ref => L.comp && L.comp.get(ref);
    const val = ref => { const c = comp(ref); return c && c.value ? c.value : ''; };
    const V = node => { const e = E(); const i = e ? e.nodeIndex(node) : -1; return i >= 0 ? e.x[i] : 0; };

    // ---- power
    const power = [];
    const sim = L.base.sim || {};
    for (const s of E().supplies()) {
      const src = (sim.sources || []).find(x => x.net === s.net) || {};
      const refs = s.refs || [];
      const title = s.battery ? `${s.ref} battery` : refs.length ? `${refs.slice(0, 2).join(', ')} → ${sn(s.net)}` : sn(s.net);
      const sub = s.battery ? `${s.value} V cell` : /VBUS|USB/i.test(s.net) ? 'USB power in' : refs.length ? 'power coming in on the connector' : 'rail held at its nominal voltage: nothing on the board makes it';
      const cur = () => E().supplies().find(x => x.net === s.net);
      power.push({ id: 'sup:' + s.net, icon: 'plug', title, sub: sub + (src.note && !/^from the connector$|held at its nominal/.test(src.note) ? ' · ' + src.note : ''),
        status: () => {
          const x = cur(); if (!x) return '';
          if (!x.on) return 'unplugged: the board runs without it';
          const i = x.i || 0;
          if (Math.abs(i) < 1e-6) return `${f.V(x.value)} · no current${s.battery ? '' : ' (another supply carries the load)'}`;
          return s.battery ? (i < 0 ? `${f.V(x.value)} · charging, ${f.A(-i)} in` : `${f.V(x.value)} · powering the board, ${f.A(i)} out`) : `${f.V(x.value)} · ${f.A(Math.abs(i))} ${i > 0 ? 'out' : 'in'}`;
        },
        state: () => { const x = cur(); return x && x.on ? 'on' : 'off'; },
        controls: [
          { type: 'toggle', label: s.battery ? 'Fitted' : 'Plugged in', get: () => { const x = cur(); return !!(x && x.on); }, set: on => { E().setSupplyOn(s.net, on); N.toast(`${title}: ${on ? 'plugged in' : 'unplugged'}`); } },
          { type: 'volts', get: () => { const x = cur(); return x ? x.value : 0; }, set: v => E().setSupply(s.net, v), label: sn(s.net) + ' voltage' },
        ] });
    }
    const seenReg = new Set();
    for (const x of E().els) {
      if (!['REG', 'SWR', 'LSW'].includes(x.t) || seenReg.has(x.ref)) continue;
      seenReg.add(x.ref);
      const ref = x.ref, t = x.t;
      const el0 = () => E().els.find(q => q.t === t && q.ref === ref);
      // the output node: the regulator's output (a charger's after its diode), a buck's after its inductor, a switch's output
      const outNode = () => {
        const e = el0(); if (!e) return null;
        if (t === 'REG') { if (e.charger) { const d = E().els.find(q => q.name === 'dchg_' + ref); return d ? d.b : e.out; } return e.out; }
        if (t === 'SWR') { const l = E().els.find(q => q.t === 'L' && (q.a === e.sw || q.b === e.sw)); return l ? (l.a === e.sw ? l.b : l.a) : e.sw; }
        return e.b;
      };
      const onode = outNode();
      const outNet = onode ? E().nodeNet.get(onode) : '';
      const kind = t === 'REG' ? (x.boost ? 'boost converter' : x.charger ? 'battery charger' : 'linear regulator') : t === 'SWR' ? 'buck converter' : 'load switch';
      const en = E().enableOf(ref);
      const enPin = x.en ? E().nodeNet.get(x.en) : null;
      const inPin = x.t === 'LSW' ? x.a : x.in;
      const enTxt = en && en.hasEn ? (x.en === inPin ? ' · enable tied to its input' : ' · enable on ' + (enPin ? sn(enPin) : 'its EN pin')) : '';
      power.push({ id: 'en:' + ref, icon: 'reg', title: `${ref} ${val(ref)}`.trim(), sub: `${kind}${outNet ? ' → ' + sn(outNet) : ''}${t === 'REG' && x.vout ? ' (' + x.vout + ' V)' : ''}${enTxt}`,
        status: () => {
          const e = el0(), s2 = E().enableOf(ref);
          if (!e || !s2) return '';
          const node = outNode(), v = node ? V(node) : 0;
          let i = 0;
          if (t === 'REG' || t === 'SWR') i = -E().x[e._br];
          else i = Math.abs(((e._a >= 0 ? E().x[e._a] : 0) - (e._b >= 0 ? E().x[e._b] : 0)) / (e.on ? e.ron : 1e8));
          return `${s2.on ? 'on' : 'off'}${s2.force != null ? (s2.dflt ? ' (as on a running board)' : ' (held by hand)') : s2.hasEn ? ' (its enable pin)' : ''} · ${f.V(v)}${Math.abs(i) > 2e-6 ? ' · ' + f.A(Math.abs(i)) : ''}`;
        },
        state: () => { const s2 = E().enableOf(ref); return s2 && s2.on ? 'on' : 'off'; },
        controls: [{ type: 'seg', options: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], label: 'Power ' + ref, get: () => { const s2 = E().enableOf(ref); return !s2 || s2.force == null ? 'auto' : s2.force ? 'on' : 'off'; }, set: v => { E().setEnable(ref, v === 'auto' ? null : v === 'on'); N.toast(v === 'auto' ? `${ref} follows its enable pin again` : `${ref} held ${v} by hand`); } }] });
      if (en && en.dflt) power[power.length - 1].sub += ' · starts on, as on a running board';
    }
    // power switches: the MOSFETs (and pass transistors) between a supply and a rail that relies on them
    for (const ps of sim.powerSwitches || []) {
      const st = () => E().fetOf(ps.name);
      const s0 = st();
      if (!s0) continue;
      const kind = ps.kind === 'M' ? (ps.pch ? 'P-MOSFET' : 'N-MOSFET') : 'transistor';
      const who = ps.ctl === 'chip' ? 'gate driven by a chip' : 'gate driven by the circuit';
      const railNode = () => E().nodeOf(ps.rail);
      power.push({ id: 'fet:' + ps.name, icon: 'reg', title: `${ps.ref} ${val(ps.ref)}`.trim() + ' · power switch', sub: `${kind}, ${sn(ps.from)} → ${sn(ps.to)}${ps.to !== ps.rail ? ' (feeds ' + sn(ps.rail) + ')' : ''} · ${who}${s0.dflt === 'on' ? ' · starts on, as on a running board' : ''}`,
        status: () => {
          const s = st(); if (!s) return '';
          const nd = railNode(), v = nd ? V(nd) : 0;
          const held = s.state && s.state !== s.dflt ? ' (held by hand)' : s.state ? ' (assumed on)' : '';
          return `${s.on ? 'on' : 'off'}${held} · ${sn(ps.rail)} ${f.V(v)}${Math.abs(s.i) > 2e-6 ? ' · ' + f.A(Math.abs(s.i)) : ''}`;
        },
        state: () => { const s = st(); return s && s.on ? 'on' : 'off'; },
        controls: [{ type: 'seg', options: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], label: 'Switch ' + ps.ref, get: () => { const s = st(); return !s || !s.state ? 'auto' : s.state; },
          set: v => { E().setFet(ps.name, v === 'auto' ? null : v); N.toast(v === 'auto' ? `${ps.ref} follows its gate again` : `${ps.ref} switched ${v} by hand: ${sn(ps.rail)} ${v === 'on' ? 'powered' : 'cut off'}`); } }] });
    }
    power.push({ id: 'cycle', icon: 'power', title: 'Power cycle the whole board', sub: 'everything off, then the rails come up again and the programs restart', controls: [{ type: 'button', label: 'Power up', run: () => L.powerUp() }] });
    groups.push({ id: 'power', title: 'Power', items: power });

    // ---- processors
    const procs = L.procs || [];
    if (procs.length) {
      const items = procs.map(p => {
        const run = () => L.fwm && L.fwm.get(p.ref);
        return { id: 'proc:' + p.ref, icon: 'chip', title: `${p.ref} ${p.chip ? p.chip.name : p.value}`, sub: p.chip && p.chip.core ? p.chip.core : p.kind || 'processor',
          status: () => { const r = run(); if (!r) return 'no program yet: its pins are inputs, as when held in reset'; if (r.state === 'running') return (r.kind === 'firmware' ? 'running firmware ' + (r.imageName || '') : 'running a program') + (r.console && r.console.text ? ' · last: ' + r.console.text.trim().split('\n').pop().slice(0, 48) : ''); if (r.state === 'error') return 'stopped by an error: ' + r.error; return r.state; },
          state: () => { const r = run(); return r && r.state === 'running' ? 'on' : 'off'; },
          controls: [
            { type: 'button', label: () => (run() && run().state === 'running' ? 'Restart' : 'Run'), title: 'Run its program (the auto program if none was written)', run: () => {
              const r = run();
              if (r && r.kind === 'script' && r.src) { L.fwm.runScript(p, r.src); L.realTime(); return; }
              if (r && r.start) { r.start(L.engine.t); return; }
              const saved = N.store.get('code:' + boardKey(L) + ':' + p.ref, '');
              const a = L.analysisFor(p);
              const src = saved || (a ? N.analysis.program(a) : N.fw.starter(L.base.circuit, p).text);
              runOn(L, panel, p, src);
            } },
            { type: 'button', label: 'Stop', title: 'Stop the program: the pins go back to inputs', show: () => !!run(), run: () => { L.fwm.stop(p.ref); } },
            { type: 'button', label: 'Code', title: 'Open the code panel', run: () => panel.open('code', p.ref) },
          ] };
      });
      groups.push({ id: 'procs', title: 'Processors', items });
    }

    // ---- buttons, switches, knobs
    const inputs = [];
    const byRef = new Map();
    for (const s of E().switches()) { if (s.auto) continue; if (!byRef.has(s.ref)) byRef.set(s.ref, []); byRef.get(s.ref).push(s); }
    for (const [ref, list] of byRef) {
      const c = comp(ref), kind = c && c.kind;
      const cur = key => E().switches().find(x => x.ref === ref && x.key === key);
      if (kind === 'encoder') {
        // quadrature: A and B close and open a quarter step apart; one detent is the four states
        const step = dir => {
          const seq = dir > 0 ? [[1, 0], [1, 1], [0, 1], [0, 0]] : [[0, 1], [1, 1], [1, 0], [0, 0]];
          seq.forEach(([a, b], k) => L.later(0.004 * (k + 1), 45 * (k + 1), () => { E().setSwitch(ref, !!a, 'A'); E().setSwitch(ref, !!b, 'B'); }));
        };
        inputs.push({ id: 'sw:' + ref, icon: 'knob', title: `${ref} rotary encoder`, sub: list.some(x => x.key === 'S') ? 'turn it, or press the knob' : 'turn it',
          status: () => list.map(x => `${x.key} ${cur(x.key) && cur(x.key).closed ? 'closed' : 'open'}`).join(' · '),
          controls: [{ type: 'button', label: '⟲', title: 'One step anticlockwise', run: () => step(-1) }, { type: 'button', label: '⟳', title: 'One step clockwise', run: () => step(1) }].concat(list.some(x => x.key === 'S') ? [press(L, ref, 'S')] : []) });
        continue;
      }
      if (list.length > 1 && !list.every(x => x.spdt)) {
        for (const s of list) inputs.push({ id: 'sw:' + ref + ':' + s.key, icon: 'switch', title: `${ref} ${kind === 'dip' ? 'switch ' : ''}${s.key}`, sub: c && c.label ? c.label : 'switch',
          status: () => (cur(s.key) && cur(s.key).closed ? 'closed' : 'open'), controls: [{ type: 'toggle', label: 'Closed', get: () => !!(cur(s.key) && cur(s.key).closed), set: on => E().setSwitch(ref, on, s.key) }] });
        continue;
      }
      const s = list[0];
      const isButton = !s.jumper && !s.spdt && (!kind || kind === 'switch') && !/SLIDE|TOGGLE|DIP|SPDT/i.test((c && (c.value + ' ' + c.description)) || '');
      const what = s.jumper ? 'solder jumper' : s.spdt ? 'changeover switch' : c && c.label ? c.label : isButton ? 'push button' : 'switch';
      inputs.push({ id: 'sw:' + ref, icon: isButton ? 'button' : 'switch', title: `${ref}${c && c.value && !/^SW_|^~$/.test(c.value) ? ' ' + c.value : ''}`, sub: what + wiredTo(L, ref),
        status: () => { const x = cur(s.key); return x ? (s.spdt ? (x.closed ? 'position A' : 'position B') : x.closed ? (s.jumper ? 'bridged' : isButton ? 'pressed' : 'closed') : (s.jumper ? 'open' : isButton ? 'released' : 'open')) : ''; },
        controls: isButton ? [press(L, ref, s.key), { type: 'toggle', label: 'Hold', get: () => !!(cur(s.key) && cur(s.key).closed), set: on => E().setSwitch(ref, on, s.key) }]
          : [{ type: 'toggle', label: s.jumper ? 'Bridged' : s.spdt ? 'A' : 'Closed', get: () => !!(cur(s.key) && cur(s.key).closed), set: on => E().setSwitch(ref, on, s.key) }] });
    }
    for (const pt of E().pots()) inputs.push({ id: 'pot:' + pt.ref, icon: 'knob', title: `${pt.ref} ${val(pt.ref)}`.trim(), sub: 'potentiometer',
      status: () => { const x = E().pots().find(y => y.ref === pt.ref); return x ? Math.round(x.frac * 100) + '% turned' : ''; },
      controls: [{ type: 'slider', label: pt.ref + ' position', get: () => { const x = E().pots().find(y => y.ref === pt.ref); return x ? x.frac : 0.5; }, set: v => E().setPot(pt.ref, v) }] });
    if (inputs.length) groups.push({ id: 'inputs', title: 'Buttons, switches and knobs', items: inputs });

    // ---- conversations between chips
    const talk = [];
    for (const p of procs) {
      let a = null;
      try { a = L.analysisFor(p); } catch (e) { a = null; }
      if (!a) continue;
      a.i2c.forEach((b, bi) => {
        const pins = [b.sdaIo, b.sclIo].filter(io => okNet(L, io));
        const sigs = () => pins.map(io => sigOf(L, p, io)), dec = [{ bus: 'i2c', proc: p.ref, idx: bi, label: `I2C ${pins.map(io => N.fw.shortPin(io)).join('/')} · ${p.ref}` }];
        talk.push({ id: `i2cscan:${p.ref}:${bi}`, icon: 'bus', title: `${p.ref} scans its I2C bus`, sub: `${N.fw.shortPin(b.sdaIo)} / ${N.fw.shortPin(b.sclIo)} · ${b.devices.length} part${b.devices.length > 1 ? 's' : ''} on it`,
          controls: [{ type: 'button', label: 'Scan', run: () => runOn(L, panel, p, A.program(a, { kind: 'i2c-scan', bus: b }), sigs(), dec) }] });
        for (const d of b.devices) talk.push({ id: `i2c:${p.ref}:${d.ref}`, icon: 'bus', title: `${p.ref} ↔ ${d.ref} ${d.spec.name}`, sub: `I2C at ${hex(d.address)}${d.via ? ' behind ' + d.via.ref : ''} · ${N.analysis.SENSOR_LIBS && N.analysis.SENSOR_LIBS[d.spec.id] ? 'reads ' + N.analysis.SENSOR_LIBS[d.spec.id].say : N.analysis.ID_REGS && N.analysis.ID_REGS[d.spec.id] ? 'reads its ID register' : 'reads its first registers'}`,
          status: () => L.deviceStatus(d.ref) || '',
          controls: [{ type: 'button', label: 'Talk', run: () => runOn(L, panel, p, A.program(a, { kind: 'i2c-dev', bus: b, dev: d }), sigs(), dec) }] });
      });
      a.spi.forEach((b, bi) => {
        const io = n => p.io.find(x => x.number === n);
        for (const d of b.devices) {
          const pins = [io(b.sck), io(b.mosi), io(b.miso), d.csIo].filter(x => okNet(L, x)).filter((x, k, arr) => arr.indexOf(x) === k);
          const screen = d.spec.display || /st77|ili9|gc9a01|ssd1|epd/.test(d.spec.id);
          talk.push({ id: `spi:${p.ref}:${d.ref}`, icon: 'bus', title: `${p.ref} ↔ ${d.ref} ${d.spec.name}`, sub: `SPI${d.csIo ? ', CS ' + N.fw.shortPin(d.csIo) : ''}${screen ? ' · a screen: the auto program draws on it' : ''}`,
            status: () => L.deviceStatus(d.ref) || '',
            controls: [{ type: 'button', label: screen ? 'Draw' : 'Talk', run: () => { const src = screen ? N.analysis.program(a) : A.program(a, { kind: 'spi-dev', bus: b, dev: d }); runOn(L, panel, p, src, pins.map(x => sigOf(L, p, x)), [{ bus: 'spi', proc: p.ref, idx: bi, label: `SPI · ${p.ref}` }]); } }] });
        }
      });
      for (const u of a.uarts.slice(0, 3)) {
        const isProc = procs.some(q => u.peer && u.peer.includes(q.ref + ' ') || u.peer === q.ref);
        if (isProc) continue;   // processor to processor: below
        talk.push({ id: `uart:${p.ref}:${u.peer}`, icon: 'serial', title: `${p.ref} ↔ ${u.peer}`, sub: `UART${u.txIo ? ' TX ' + N.fw.shortPin(u.txIo) : ''}${u.rxIo ? ' RX ' + N.fw.shortPin(u.rxIo) : ''} · type in the Code panel's serial box to answer`,
          controls: [{ type: 'button', label: 'Say hello', run: () => { runOn(L, panel, p, A.program(a, { kind: 'uart', u }), u.txIo && okNet(L, u.txIo) ? [sigOf(L, p, u.txIo)] : [], [{ bus: 'uart', proc: p.ref, idx: 0, label: `Serial · ${p.ref}` }]); } }] });
      }
      if (a.chains.length) { const ch = a.chains[0]; talk.push({ id: `pix:${p.ref}`, icon: 'led', title: `${p.ref} → ${ch.leds.length} addressable LED${ch.leds.length > 1 ? 's' : ''}`, sub: `${ch.part || ch.type} on ${N.fw.shortPin(ch.io)}`, controls: [{ type: 'button', label: 'Rainbow', run: () => runOn(L, panel, p, A.program(a, { kind: 'pixels', chain: ch }), okNet(L, ch.io) ? [sigOf(L, p, ch.io)] : []) }] }); }
      if (a.leds.length) talk.push({ id: `leds:${p.ref}`, icon: 'led', title: `${p.ref} → LED${a.leds.length > 1 ? 's' : ''} ${a.leds.slice(0, 4).map(l => l.ref).join(', ')}${a.leds.length > 4 ? '…' : ''}`, sub: a.leds.slice(0, 3).map(l => `${l.ref} on ${N.fw.shortPin(l.io)}`).join(', '), controls: [{ type: 'button', label: 'Blink', run: () => runOn(L, panel, p, A.program(a, { kind: 'leds' }), a.leds.slice(0, 8).filter(l => okNet(L, l.io)).map(l => sigOf(L, p, l.io))) }] });
      for (const e of a.enables.slice(0, 6)) talk.push({ id: `ena:${p.ref}:${e.ref}`, icon: 'reg', title: `${p.ref} switches ${e.ref} ${e.value || ''}`.trim(), sub: `enable on ${N.fw.shortPin(e.io)}, active ${e.activeHigh ? 'high' : 'low'}`,
        controls: [{ type: 'button', label: 'On', run: () => runOn(L, panel, p, A.program(a, { kind: 'enable', en: e, on: true }), okNet(L, e.io) ? [sigOf(L, p, e.io)] : []) }, { type: 'button', label: 'Off', run: () => runOn(L, panel, p, A.program(a, { kind: 'enable', en: e, on: false }), okNet(L, e.io) ? [sigOf(L, p, e.io)] : []) }] });
      if (a.analog.length) talk.push({ id: `adc:${p.ref}`, icon: 'meter', title: `${p.ref} reads ${a.analog.length} analog input${a.analog.length > 1 ? 's' : ''}`, sub: a.analog.slice(0, 2).map(x => `${N.fw.shortPin(x.io)}: ${x.what}`).join('; '), controls: [{ type: 'button', label: 'Measure', run: () => runOn(L, panel, p, A.program(a, { kind: 'analog' }), a.analog.slice(0, 6).filter(x => okNet(L, x.io)).map(x => sigOf(L, p, x.io))) }] });
      if (a.buttons.length) talk.push({ id: `btn:${p.ref}`, icon: 'button', title: `${p.ref} watches ${a.buttons.slice(0, 4).map(b => b.ref).join(', ')}`, sub: 'reports every press on its serial port', controls: [{ type: 'button', label: 'Watch', run: () => runOn(L, panel, p, A.program(a, { kind: 'buttons' }), a.buttons.slice(0, 8).filter(b => okNet(L, b.io)).map(b => sigOf(L, p, b.io))) }] });
    }
    // processor to processor over a UART
    const links = L.fwm ? L.fwm.links() : [];
    for (const lk of links) {
      const pa = procs.find(x => x.ref === lk.from), pb = procs.find(x => x.ref === lk.to);
      if (!pa || !pb) continue;
      const back = links.some(k => k.from === lk.to && k.to === lk.from);
      talk.push({ id: `link:${lk.from}:${lk.to}`, icon: 'serial', title: `${lk.from} → ${lk.to} over a UART`, sub: `${N.fw.shortPin(lk.tx)} → ${lk.to} ${N.fw.shortPin(lk.rx)}${back ? ' (and back)' : ''}: ping ${back ? 'and pong' : ''}`,
        status: () => (lk.bytes ? `${lk.bytes} byte${lk.bytes > 1 ? 's' : ''} sent` : ''),
        controls: [{ type: 'button', label: 'Ping', run: () => {
          const aa = L.analysisFor(pa) || { proc: pa, leds: [], buttons: [], analog: [], i2c: [], spi: [], uarts: [], chains: [], enables: [] }, ab = L.analysisFor(pb) || { proc: pb, leds: [], buttons: [], analog: [], i2c: [], spi: [], uarts: [], chains: [], enables: [] };
          runOn(L, panel, pb, A.program(ab, { kind: 'link-echo', link: lk }));
          runOn(L, panel, pa, A.program(aa, { kind: 'link-send', link: lk }), okNet(L, lk.tx) ? [sigOf(L, pa, lk.tx)] : [], [{ bus: 'uart', proc: pa.ref, idx: 0, label: `Serial · ${pa.ref}` }, { bus: 'uart', proc: pb.ref, idx: 0, label: `Serial · ${pb.ref}` }]);
          N.toast(`${lk.from} sends "ping" to ${lk.to}; open Code to watch both serial ports`);
        } }] });
    }
    if (talk.length) groups.push({ id: 'talk', title: 'Talk between chips', items: talk });

    // ---- chips with behaviours: resets, clocks, chargers
    const beh = [];
    for (const it of (L.pm && L.pm.items) || []) {
      const b = it.b, ref = b.ref;
      const roles = Object.entries(b.roles);
      const rst = roles.find(([, o]) => o.role === 'reset'), clk = roles.filter(([, o]) => o.role === 'clk'), stat = roles.filter(([, o]) => o.role === 'stat');
      const force = (pins, mode, ms) => { for (const [pin] of pins) L.pm.forced.set(ref + '\u0000' + pin, mode); if (ms) L.later(ms / 1000, ms, () => { for (const [pin] of pins) L.pm.forced.delete(ref + '\u0000' + pin); }); };
      if (rst) beh.push({ id: 'rst:' + ref, icon: 'reset', title: `${ref} ${val(ref)} reset`.trim(), sub: N.partModels.roleText(rst[1]) + wiredTo(L, ref, rst[0]),
        status: () => { const m = E().driveOf(ref, rst[0]); return m === 'od' || m === 'lo' ? 'reset asserted (low)' : m === 'hi' || m === 'z' ? 'released' : m || ''; },
        controls: [{ type: 'button', label: 'Press reset', run: () => { force([rst], rst[1].od ? 'od' : 'lo', 300); N.toast(`${ref} pulls reset low for 0.3 s`); } }] });
      if (clk.length) beh.push({ id: 'clk:' + ref, icon: 'clock', title: `${ref} ${val(ref)} clock`.trim(), sub: clk.slice(0, 2).map(([pin, o]) => 'pin ' + pin + ' ' + N.partModels.roleText(o)).join(', '),
        status: () => (L.pm.forced.has(ref + '\u0000' + clk[0][0]) ? 'stopped by hand' : 'running'),
        controls: [{ type: 'toggle', label: 'Running', get: () => !L.pm.forced.has(ref + '\u0000' + clk[0][0]), set: on => { if (on) for (const [pin] of clk) L.pm.forced.delete(ref + '\u0000' + pin); else force(clk, 'lo'); } }] });
      if (stat.length && b.family === 'charger') beh.push({ id: 'chg:' + ref, icon: 'battery', title: `${ref} ${val(ref)} charging`.trim(), sub: 'status pins: ' + stat.map(([pin]) => pin).join(', '),
        status: () => { const r = E().els.find(q => q.t === 'REG' && q.ref === ref && q.charger); const i = r ? -E().x[r._br] : 0; return i > 2e-4 ? `charging at ${f.A(i)}` : 'not charging'; } });
    }
    if (beh.length) groups.push({ id: 'chips', title: 'Resets, clocks and chargers', items: beh });
    return groups;
  };
  // where a part's pin leads (for a button: to which processor pin)
  function wiredTo(L, ref, pin) {
    const circ = L.base.circuit;
    const nets = circ.nets.filter(n => n.nodes.some(x => x.ref === ref && (pin == null || String(x.pin) === String(pin))) && n.kind !== 'ground');
    for (const n of nets) for (const x of n.nodes) { if (x.ref === ref) continue; const pr = (L.procs || []).find(p => p.ref === x.ref); if (pr) { const io = pr.io.find(i => i.number === String(x.pin)); return ` · to ${pr.ref} ${io ? N.fw.shortPin(io) : 'pin ' + x.pin}`; } }
    return '';
  }
  // a momentary press: closed for a moment of simulated and real time
  function press(L, ref, key) {
    return { type: 'button', label: 'Press', title: 'Press and release', run: () => {
      L.engine.setSwitch(ref, true, key);
      L.later(0.08, 250, () => { if (L.engine) L.engine.setSwitch(ref, false, key); });
    } };
  }

  // ------------------------------------------------------------------ the panel
  const ICO = {
    plug: '<path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 01-7 0zM8 11v3"/>', reg: '<rect x="3" y="4" width="10" height="8" rx="1.5"/><path d="M1 8h2M13 8h2M6 8h4"/>', power: '<path d="M8 2v6"/><path d="M4.6 4.4a5 5 0 106.8 0"/>',
    chip: '<rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2"/>', button: '<circle cx="8" cy="8" r="3.2"/><rect x="2.5" y="2.5" width="11" height="11" rx="2"/>',
    switch: '<rect x="2" y="5" width="12" height="6" rx="3"/><circle cx="11" cy="8" r="1.8"/>', knob: '<circle cx="8" cy="8" r="5"/><path d="M8 8l2.5-2.5"/>', bus: '<path d="M2 5h12M2 11h12M5 5v6M11 5v6"/>',
    serial: '<path d="M2 8h3l1.5-3 3 6L11 8h3"/>', led: '<path d="M5 10V6a3 3 0 016 0v4zM4 10h8M6.5 10v3M9.5 10v3"/>', meter: '<path d="M2.5 11a5.5 5.5 0 0111 0"/><path d="M8 11l2.5-3.5"/>',
    reset: '<path d="M3 8a5 5 0 109-3"/><path d="M12 2v3H9"/>', clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>', battery: '<rect x="2" y="5" width="11" height="6" rx="1"/><path d="M13 7v2M4 7v2M6 7v2"/>',
    model: '<path d="M3 4.5L8 2l5 2.5v7L8 14l-5-2.5z"/><path d="M3 4.5L8 7l5-2.5M8 7v7"/>',
  };
  const ico = k => N.svg(`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICO[k] || ICO.chip}</svg>`);

  A.build = function (panel, body) {
    const L = panel.L;
    const root = el('div', { class: 'ac' });
    body.append(root);
    const open = panel.acOpen || (panel.acOpen = new Set(['power', 'procs', 'inputs', 'talk', 'chips']));
    let rows = [];
    function render() {
      let groups = [];
      try { groups = A.groups(L, panel); } catch (e) { console.error(e); }
      rows = [];
      const kids = [el('p', { class: 'ac-intro' }, 'What you can do with this board while it runs, worked out from its netlist. Changes act on the simulation at once.')];
      for (const g of groups) {
        const isOpen = open.has(g.id);
        const head = el('button', { class: 'ac-head', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => { if (open.has(g.id)) open.delete(g.id); else open.add(g.id); render(); } }, el('span', { class: 'ac-chev' + (isOpen ? ' open' : '') }, '›'), el('span', null, g.title), el('span', { class: 'ac-n' }, String(g.items.length)));
        kids.push(head);
        if (!isOpen) continue;
        const box = el('div', { class: 'ac-list' });
        for (const it of g.items) { const r = card(it); rows.push(r); box.append(r.root); }
        kids.push(box);
      }
      kids.push(modelsSection(panel));
      root.replaceChildren(...kids);
      tick();
    }
    function card(it) {
      const st = el('span', { class: 'ac-st' });
      const ctl = el('div', { class: 'ac-ctl' });
      const refresh = [];
      for (const c of it.controls || []) {
        if (c.type === 'button') {
          const b = el('button', { class: 'lb tiny', type: 'button', title: c.title || '', onclick: () => { try { c.run(); } catch (e) { console.error(e); N.toast(String(e.message || e), 'warn'); } setTimeout(tick, 60); } }, typeof c.label === 'function' ? c.label() : c.label);
          ctl.append(b);
          refresh.push(() => { if (typeof c.label === 'function') b.textContent = c.label(); if (c.show) b.hidden = !c.show(); });
        } else if (c.type === 'toggle') {
          const b = el('button', { class: 'ac-tog', type: 'button', role: 'switch', onclick: () => { c.set(!c.get()); setTimeout(tick, 30); } }, el('i'), el('span', null, c.label));
          ctl.append(b);
          refresh.push(() => { const on = !!c.get(); b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
        } else if (c.type === 'seg') {
          const seg = el('div', { class: 'ac-seg', role: 'radiogroup', 'aria-label': c.label || '' }, c.options.map(([v, t]) => el('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => { c.set(v); setTimeout(tick, 30); } }, t)));
          ctl.append(seg);
          refresh.push(() => { const v = c.get(); for (const b of seg.children) { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); } });
        } else if (c.type === 'volts') {
          const inp = el('input', { class: 'ac-v', type: 'number', step: '0.1', 'aria-label': c.label || 'voltage' });
          inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (isFinite(v)) c.set(v); });
          ctl.append(el('label', { class: 'ac-vl' }, inp, 'V'));
          refresh.push(() => { if (document.activeElement !== inp) inp.value = String(+(+c.get()).toFixed(3)); });
        } else if (c.type === 'slider') {
          const r = el('input', { class: 'ac-sl', type: 'range', min: '0', max: '1', step: '0.01', 'aria-label': c.label || '' });
          r.addEventListener('input', () => c.set(+r.value));
          ctl.append(r);
          refresh.push(() => { if (document.activeElement !== r) r.value = String(c.get()); });
        }
      }
      const root = el('div', { class: 'ac-card', 'data-id': it.id },
        el('div', { class: 'ac-ic' }, ico(it.icon)),
        el('div', { class: 'ac-main' }, el('div', { class: 'ac-t' }, it.title), it.sub ? el('div', { class: 'ac-sub' }, it.sub) : null, st),
        ctl);
      return { root, it, st, refresh };
    }
    function tick() {
      for (const r of rows) {
        if (r.it.status) { let s = ''; try { s = r.it.status() || ''; } catch (e) { s = ''; } if (r.st.textContent !== s) r.st.textContent = s; }
        if (r.it.state) { let s = ''; try { s = r.it.state(); } catch (e) { s = ''; } r.root.classList.toggle('on', s === 'on'); }
        for (const f of r.refresh) { try { f(); } catch (e) { /* the engine was rebuilt */ } }
      }
    }
    render();
    return { tick, render };
  };

  // ------------------------------------------------------------------ part models: what the simulation does with every chip
  function modelsSection(panel) {
    const L = panel.L;
    const circ = L.base.circuit;
    const procs = new Set((L.procs || []).map(p => p.ref));
    const chips = (L.base.sim && L.base.sim.chips) || [];
    const pmods = L.partModels || {};
    const rows = [];
    const counts = { chip: 0, beh: 0, lib: 0, comp: 0, bare: 0, proc: 0, dev: 0 };
    for (const c of circ.components) {
      if (c.type === 'composite') { counts.comp++; continue; }
      if (c.type !== 'ic' && c.type !== 'other') continue;
      let what = '', src = '', cls = '';
      const ch = chips.find(x => x.ref === c.ref);
      let dev = null;
      try { dev = N.devices && N.devices.match(c); } catch (e) { dev = null; }
      if (procs.has(c.ref)) { what = 'processor: runs programs and firmware'; src = 'processor'; counts.proc++; cls = 'proc'; }
      else if (ch && !pmods[c.ref]) { what = ch.model === 'regulator' ? (ch.boost ? 'boost converter' : ch.series ? 'charger' : 'regulator ' + ch.vout + ' V') : ch.model === 'switcher' ? 'buck converter' : ch.model === 'opamp' ? 'op-amp ×' + (ch.units || []).length : ch.model === 'switch' ? 'load switch' : ch.model; src = 'circuit model'; counts.chip++; cls = 'chip'; }
      else if (pmods[c.ref]) { const m = pmods[c.ref]; what = m.familyName + (m.note ? ': ' + m.note : ''); src = m.source === 'library' ? 'library' : m.source === 'built-in' ? 'built-in' : 'from its pins'; if (m.source === 'library') counts.lib++; else counts.beh++; cls = m.source === 'inferred' ? 'inf' : 'beh'; }
      else if (dev) { what = dev.name + ': answers on its bus'; src = 'device'; counts.dev++; cls = 'dev'; }
      else { what = 'supply current only'; src = 'no model'; counts.bare++; cls = 'bare'; }
      rows.push({ c, what, src, cls });
    }
    rows.sort((a, b) => ['bare', 'inf', 'beh', 'chip', 'dev', 'proc'].indexOf(a.cls) - ['bare', 'inf', 'beh', 'chip', 'dev', 'proc'].indexOf(b.cls) || N.refCmp(a.c.ref, b.c.ref));
    const open = panel.acOpen.has('models');
    const head = el('button', { class: 'ac-head', type: 'button', 'aria-expanded': open ? 'true' : 'false', onclick: () => { if (panel.acOpen.has('models')) panel.acOpen.delete('models'); else panel.acOpen.add('models'); panel.renderSide(); } },
      el('span', { class: 'ac-chev' + (open ? ' open' : '') }, '›'), el('span', null, 'Part models'), el('span', { class: 'ac-n' }, String(rows.length)));
    if (!open) return el('div', null, head);
    const sum = el('p', { class: 'ac-intro' }, `${counts.proc} processor${counts.proc === 1 ? '' : 's'}, ${counts.chip} chip${counts.chip === 1 ? '' : 's'} with a circuit model, ${counts.beh + counts.lib} with a pin behaviour (${counts.lib} from the library), ${counts.dev} bus device${counts.dev === 1 ? '' : 's'}, ${counts.bare} only as supply current; ${counts.comp} multi-pin part${counts.comp === 1 ? '' : 's'} (switches, arrays, dual transistors …) split into simple elements. Edit a model and save it to the shared library: every board with that part uses it.`);
    const list = el('div', { class: 'ac-models' }, rows.map(r => el('div', { class: 'ac-m ' + r.cls },
      el('button', { class: 'ac-mref mono', type: 'button', title: 'Select ' + r.c.ref, onclick: () => L.ctx.onSelect([r.c.ref], []) }, r.c.ref),
      el('span', { class: 'ac-mv' }, r.c.value || ''),
      el('span', { class: 'ac-mw' }, r.what),
      el('span', { class: 'ac-src' }, r.src),
      r.cls === 'proc' || r.cls === 'dev' ? el('span') : el('button', { class: 'lb tiny', type: 'button', onclick: () => A.editModel(L, r.c) }, r.cls === 'bare' ? 'Make' : 'Edit'))));
    return el('div', null, head, sum, list);
  }

  // ------------------------------------------------------------------ the model editor
  const ROLE_OPTS = [['in', 'input'], ['vdd', 'supply'], ['gnd', 'ground'], ['nc', 'not connected'], ['hi', 'drives high'], ['lo', 'drives low'], ['pu', 'weak pull-up'], ['pd', 'weak pull-down'],
    ['od', 'open drain (released)'], ['odlo', 'open drain (pulls low)'], ['clk', 'clock output'], ['follow', 'follows a pin'], ['gate', 'logic gate'], ['reset', 'reset output'], ['reg', 'regulated output'], ['half', 'switching (average)'], ['sink', 'current sink']];
  A.editModel = function (L, c) {
    const PM = N.partModels;
    const circ = L.base.circuit;
    const P = PM.ctxOf(c, circ);
    let base = null;
    try { base = PM.model(c, circ); } catch (e) { base = null; }
    const roles = {};
    for (const p of P.pins) roles[p.num] = Object.assign({}, base && base.roles[p.num] ? base.roles[p.num] : { role: p.nc ? 'nc' : p.kind === 'ground' ? 'gnd' : p.etype === 'power_in' ? 'vdd' : 'in' });
    const name = el('input', { class: 'input', type: 'text', value: base && base.familyName && base.source !== 'inferred' ? base.familyName : (c.value || c.ref), 'aria-label': 'Model name' });
    const note = el('input', { class: 'input', type: 'text', value: base && base.note || '', placeholder: 'One line: what the chip does here', 'aria-label': 'Note' });
    const pinOpts = () => P.pins.map(p => el('option', { value: p.num }, `${p.num} ${p.name || ''}`.trim()));
    const tbody = el('tbody');
    const rowFor = p => {
      const o = roles[p.num];
      const sel = el('select', { class: 'me-sel', 'aria-label': 'Role of pin ' + p.num }, ROLE_OPTS.map(([v, t]) => el('option', { value: v, selected: o.role === v || null }, t)));
      const par = el('span', { class: 'me-par' });
      const fill = () => {
        par.replaceChildren();
        const num = (key, label, step, dflt) => { const i = el('input', { class: 'me-n', type: 'number', step: String(step), value: o[key] != null ? o[key] : dflt, 'aria-label': label }); i.addEventListener('change', () => { o[key] = parseFloat(i.value); }); if (o[key] == null) o[key] = dflt; return el('label', null, label, i); };
        if (o.role === 'follow') { const s = el('select', { class: 'me-sel', 'aria-label': 'Follows pin' }, pinOpts()); s.value = o.from || (P.pins.find(q => q.num !== p.num) || {}).num || ''; o.from = s.value; s.addEventListener('change', () => { o.from = s.value; }); const inv = el('input', { type: 'checkbox', checked: o.invert || null }); inv.addEventListener('change', () => { o.invert = inv.checked; }); par.append('pin', s, el('label', null, inv, 'inverted')); }
        else if (o.role === 'gate') { const fn = el('select', { class: 'me-sel', 'aria-label': 'Function' }, ['and', 'nand', 'or', 'nor', 'xor', 'xnor'].map(x => el('option', { value: x, selected: o.fn === x || null }, x.toUpperCase()))); o.fn = o.fn || 'and'; fn.addEventListener('change', () => { o.fn = fn.value; }); const ins = el('input', { class: 'me-t', type: 'text', value: (o.from || []).join(','), placeholder: '1,2', 'aria-label': 'Input pins' }); ins.addEventListener('change', () => { o.from = ins.value.split(/[\s,]+/).filter(Boolean); }); par.append(fn, 'of pins', ins); }
        else if (o.role === 'clk') par.append(num('hz', 'Hz', 1000, 1e6));
        else if (o.role === 'reg') par.append(num('v', 'V', 0.1, 3.3));
        else if (o.role === 'sink') par.append(num('mA', 'mA', 1, 20));
        else if (o.role === 'reset') { const vs = el('select', { class: 'me-sel', 'aria-label': 'Watches pin' }, pinOpts()); vs.value = o.vdd || (P.pins.find(q => q.kind === 'power') || P.pins[0]).num; o.vdd = vs.value; vs.addEventListener('change', () => { o.vdd = vs.value; }); par.append('watches', vs, num('vth', 'below V', 0.05, 2.9)); o.low = o.low !== false; }
      };
      sel.addEventListener('change', () => { const v = sel.value; for (const k of Object.keys(o)) delete o[k]; o.role = v; fill(); });
      fill();
      return el('tr', null, el('td', { class: 'mono' }, p.num), el('td', { class: 'mono' }, p.name || ''), el('td', { class: 'mono muted' }, sn(p.net) || '—'), el('td', null, sel), el('td', null, par));
    };
    const redraw = () => tbody.replaceChildren(...P.pins.map(rowFor));
    redraw();
    const status = el('p', { class: 'muted small' }, base ? `Starting from: ${base.familyName} (${base.source === 'inferred' ? 'guessed from the pin names' : base.source}).` : 'No model yet: every pin starts as an input.');
    const save = async shared => {
      const m = { id: 'm' + Date.now().toString(36), match: up(c.value).trim(), name: name.value.trim() || c.value, note: note.value.trim(), roles: JSON.parse(JSON.stringify(roles)), at: Date.now(), pins: P.pins.length };
      A.addUserModel(m);
      let where = 'on this device';
      if (shared && N.lib && N.lib.saveModel) { try { await N.lib.saveModel(m); where = 'in the shared library'; } catch (e) { N.toast('Could not save to the library: ' + (e.message || e), 'warn'); } }
      dlg.close();
      // the simulation picks it up at once
      if (L.ctx && L.ctx.remodel) { try { L.rebuild(L.ctx.remodel()); } catch (e) { console.error(e); } }
      N.toast(`Model for ${c.value} saved ${where}${L.on ? ' and applied' : ''}`);
    };
    const canShare = !!(N.lib && N.lib.live && N.lib.canWrite);
    const body = el('div', { class: 'me' },
      el('div', { class: 'me-h' }, el('label', null, 'Name', name), el('label', null, 'Note', note)),
      status,
      el('div', { class: 'me-scroll' }, el('table', { class: 'me-t' }, el('thead', null, el('tr', null, ['Pin', 'Name', 'Net', 'Role', ''].map(t => el('th', null, t)))), tbody)),
      el('p', { class: 'muted small' }, `Applies to every part with the value "${c.value}". Supplies and grounds only power the chip; inputs read their net; the other roles drive their pin while the chip is powered.`));
    const dlg = N.modal(`Model for ${c.ref} · ${c.value}`, body, [el('span', { class: 'grow' }),
      el('button', { class: 'btn', type: 'button', onclick: () => save(false) }, 'Save on this device'),
      canShare ? el('button', { class: 'btn primary', type: 'button', onclick: () => save(true) }, 'Save to the library') : null].filter(Boolean));
    if (dlg.el) dlg.el.classList.add('me-wide');
  };

  // ------------------------------------------------------------------ models saved here and in the shared library
  A.addUserModel = function (m) {
    if (!N.partModels) return;
    for (const [k, x] of N.partModels.user) if (x.match === m.match) N.partModels.user.delete(k);
    N.partModels.user.set(m.id, m);
    const local = (N.store.get('pm-models', []) || []).filter(x => x.match !== m.match);
    local.push(m);
    N.store.set('pm-models', local.slice(-200));
  };
  function loadModels() {
    if (!N.partModels) return;
    const all = [];
    for (const m of N.store.get('pm-models', []) || []) all.push(m);
    if (N.lib && N.lib.models) for (const m of N.lib.models()) all.push(m);
    all.sort((a, b) => (a.at || 0) - (b.at || 0));
    for (const m of all) if (m && m.match && m.roles) { for (const [k, x] of N.partModels.user) if (x.match === m.match) N.partModels.user.delete(k); N.partModels.user.set(m.id || m.match, m); }
  }
  A.loadModels = loadModels;
  loadModels();
  if (N.bus && N.bus.on) N.bus.on('library', loadModels);
})();

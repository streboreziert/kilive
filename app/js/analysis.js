/* KiLive — what a board does around each processor: LEDs, buttons, enables, I2C / SPI buses and the parts on them,
   LED chains, UARTs, analog inputs, drivers. Used by the live code runtime (Wire/SPI/NeoPixel reach the real parts),
   by the "What this board does" panel, by the self-generated firmware and by KiLive's prompts. */
(function () {
  'use strict';
  const N = window.Noeti;
  const A = (N.analysis = {});
  const up = s => String(s || '').toUpperCase();
  const short = n => (n ? String(n).split('/').pop().replace(/\{slash\}/g, '/') : '');

  // ------------------------------------------------------------------ netlist index
  function index(circ) {
    if (circ._ix) return circ._ix;
    const comp = new Map(circ.components.map(c => [c.ref, c]));
    const netOf = new Map(), net = new Map();
    const pinsOf = new Map();   // pins as the netlist has them (some parts list no pins of their own)
    for (const n of circ.nets) { net.set(n.name, n); for (const x of n.nodes) { netOf.set(x.ref + '\u0000' + x.pin, n); (pinsOf.get(x.ref) || pinsOf.set(x.ref, new Set()).get(x.ref)).add(String(x.pin)); } }
    const pinList = c => (c.pins && c.pins.length ? c.pins.map(p => String(p.number)) : [...(pinsOf.get(c.ref) || [])]);
    const pinName = (ref, pin) => { const c = comp.get(ref); const p = c && (c.pins || []).find(q => String(q.number) === String(pin)); return p ? String(p.name || '') : ''; };
    const ohms = c => {
      if (!c || (c.type !== 'resistor' && c.type !== 'thermistor')) return null;
      try { const v = window.DS2K_P2 && window.DS2K_P2.parseValue(c.value, 'ohm'); if (v != null && isFinite(v)) return v; } catch (e) { /* fall through */ }
      const m = /^\s*(\d+(?:\.\d+)?)\s*([RKM]?)(\d*)/i.exec(String(c.value || '').replace(',', '.'));
      if (!m) return null;
      const mult = { '': 1, R: 1, K: 1e3, M: 1e6 }[m[2].toUpperCase()] || 1;
      return parseFloat(m[1] + (m[3] ? '.' + m[3] : '')) * mult;
    };
    const ix = { comp, netOf, net, pinName, ohms,
      at: (ref, pin) => netOf.get(ref + '\u0000' + pin) || null,
      // the other net of a two-pin part
      other(c, n) { for (const p of pinList(c)) { const m = netOf.get(c.ref + '\u0000' + p); if (m && m !== n) return m; } return null; }, pinList,
      isGnd: n => !!n && (n.kind === 'ground' || /^(A|D|P)?GND\d*$|^VSS$/i.test(short(n.name))),
      isPwr: n => !!n && n.kind === 'power' };
    // nets reachable through small series resistors (and 0 R links / jumpers): data lines often go through 22-470 R
    ix.hop = function (n0, maxR) {
      maxR = maxR || 1000;
      const seen = new Set([n0]), q = [n0];
      while (q.length) {
        const n = q.shift();
        for (const x of n.nodes) {
          const c = comp.get(x.ref);
          if (!c || pinList(c).length !== 2) continue;
          const r = c.type === 'resistor' ? ohms(c) : c.type === 'jumper' || /^(JP|SJ)/i.test(c.ref) ? 0 : null;
          if (r == null || r > maxR) continue;
          const o = ix.other(c, n);
          if (o && !seen.has(o) && !ix.isGnd(o) && !ix.isPwr(o)) { seen.add(o); q.push(o); }
        }
      }
      return seen;
    };
    circ._ix = ix;
    return ix;
  }
  A.index = index;

  // ------------------------------------------------------------------ one processor
  A.forProc = function (circ, proc) {
    const ix = index(circ);
    const D = N.devices;
    const out = { proc, pins: new Map(), i2c: [], spi: [], chains: [], uarts: [], leds: [], buttons: [], enables: [], analog: [], drivers: [], usb: null, notes: [] };
    const ioByNet = new Map();
    for (const io of proc.io) { const n = ix.net.get(io.net); if (!n) continue; for (const m of ix.hop(n, 100)) if (!ioByNet.has(m.name)) ioByNet.set(m.name, io); }
    const ioOn = (netName, maxR) => { if (!netName) return null; const n = ix.net.get(netName); if (!n) return null; if (ioByNet.has(n.name)) return ioByNet.get(n.name); for (const m of ix.hop(n, maxR || 100)) if (ioByNet.has(m.name)) return ioByNet.get(m.name); return null; };
    const role = (io, r, detail) => { if (!io) return; const cur = out.pins.get(io.number); if (!cur || (cur.weak && !detail.weak)) out.pins.set(io.number, Object.assign({ role: r }, detail)); };
    const partName = c => `${c.ref}${c.value ? ' (' + c.value + ')' : ''}`;

    // LEDs, enables, buttons
    const w = N.fw.wiring(circ, proc);
    const seenLed = new Set();
    for (const x of w) {
      if (x.enable) { out.enables.push({ io: x.pin, ref: x.enable.ref, value: x.enable.value, activeHigh: x.enable.activeHigh }); role(x.pin, 'enable', { text: `enables ${x.enable.ref} (${x.enable.value}), active ${x.enable.activeHigh ? 'high' : 'low'}` }); }
      // an LED on an input-only pin is a status line the chip reads (a charger's CHRG LED), not one it lights
      else if (x.led && x.pin && x.pin.cap && x.pin.cap.inputOnly) { if (!seenLed.has(x.led.ref)) { seenLed.add(x.led.ref); role(x.pin, 'status', { text: `reads the ${x.led.ref} LED line (input only)` }); } }
      else if (x.led && !seenLed.has(x.led.ref)) { seenLed.add(x.led.ref); const c = ix.comp.get(x.led.ref); const col = c ? N.ledColor([c.value, c.description].join(' ')) : null; out.leds.push({ io: x.pin, ref: x.led.ref, activeHigh: x.led.activeHigh, via: x.led.via, color: col }); role(x.pin, 'led', { text: `LED ${x.led.ref}${x.led.via ? ' via ' + x.led.via : ''}, on when ${x.led.activeHigh ? 'HIGH' : 'LOW'}` }); }
      else if (x.button) { out.buttons.push({ io: x.pin, ref: x.button.ref }); role(x.pin, 'button', { text: `button ${x.button.ref}` }); }
    }

    if (D) {
      // I2C: pair the processor's SDA/SCL-like pins, then ask the device models who is on that bus
      const cand = io => {
        const nm = up(short(io.net) + ' ' + io.name + ' ' + (io.chipPin || ''));
        const cap = io.cap && io.cap.i2c ? io.cap.i2c.join(' ') : '';
        return { sda: /SDA|SDI2C|I2C\d?_?D/.test(nm) || /SDA/.test(cap), scl: /SCL|I2C\d?_?C/.test(nm) || /SCL/.test(cap) };
      };
      const sdas = proc.io.filter(io => cand(io).sda && !cand(io).scl), scls = proc.io.filter(io => cand(io).scl && !cand(io).sda);
      const tried = new Set();
      const tryBus = (a, b) => {
        const k = a.net + '|' + b.net;
        if (tried.has(k)) return; tried.add(k);
        let devs = [];
        try { devs = D.findOnBus(circ, a.net, b.net) || []; } catch (e) { devs = []; }
        if (!devs.length) return;
        if (devs.every(d => out.i2c.some(bb => bb.devices.some(x => x.ref === d.ref)))) return;
        out.i2c.push({ sda: a.number, scl: b.number, sdaIo: a, sclIo: b, sdaNet: a.net, sclNet: b.net, devices: devs });
        role(a, 'i2c', { text: `I2C SDA: ${devs.map(d => d.spec.name + ' @0x' + d.address.toString(16)).join(', ')}` });
        role(b, 'i2c', { text: `I2C SCL (${devs.length} device${devs.length > 1 ? 's' : ''})` });
      };
      const sim = (x, y) => { const p = s => up(short(s.net)).replace(/SDA|SCL/g, ''); return p(x) === p(y) ? 2 : 0; };
      for (const a of sdas) for (const b of [...scls].sort((p, q) => sim(a, q) - sim(a, p))) tryBus(a, b);
      // devices whose bus nets reach the processor but whose nets are not named SDA/SCL
      for (const c of circ.components) {
        const spec = D.match(c);
        if (!spec || !/i2c/.test(spec.bus || '')) continue;
        if (out.i2c.some(b => b.devices.some(d => d.ref === c.ref))) continue;
        const rp = D.rolePins(spec, c) || {};
        const nsda = rp.sda && ix.at(c.ref, rp.sda[0]), nscl = rp.scl && ix.at(c.ref, rp.scl[0]);
        const a = nsda && ioOn(nsda.name), b = nscl && ioOn(nscl.name);
        if (a && b) tryBus(a, b);
      }
      // SPI
      const spiSeen = new Set();
      for (const c of circ.components) {
        const spec = D.match(c);
        if (!spec || !/spi/.test(spec.bus || '') || spec.kind === 'ws2812') continue;
        const rp = D.rolePins(spec, c) || {};
        const pick = (...rs) => { for (const r of rs) if (rp[r] && rp[r].length) { const n = ix.at(c.ref, rp[r][0]); if (n) return n; } return null; };
        const nsck = pick('sck', 'scl', 'clk', 'sclk'), nmosi = pick('mosi', 'sdi', 'sda', 'din', 'si', 'dq0');
        if (!nsck || !nmosi) continue;
        const sck = ioOn(nsck.name), mosi = ioOn(nmosi.name);
        if (!sck || !mosi) continue;
        const k = sck.net + '|' + mosi.net;
        if (spiSeen.has(k)) continue; spiSeen.add(k);
        let devs = [];
        try { devs = D.findOnSPI(circ, sck.net, mosi.net) || []; } catch (e) { devs = []; }
        // parts that speak I2C and SPI and already sit on an I2C bus are in I2C mode
        devs = devs.filter(d => !out.i2c.some(bb => bb.devices.some(x => x.ref === d.ref)));
        if (!devs.length) continue;
        const nmiso = pick('miso', 'sdo', 'dout', 'so', 'dq1');
        const miso = nmiso ? ioOn(nmiso.name) : null;
        const bus = { sck: sck.number, mosi: mosi.number, miso: miso ? miso.number : null, sckNet: sck.net, mosiNet: mosi.net, devices: devs.map(d => Object.assign({}, d, { csIo: ioOn(d.cs, 1000), dcIo: ioOn(d.dc, 1000), rstIo: ioOn(d.rst, 1000), latchIo: ioOn(d.latch, 1000) })) };
        out.spi.push(bus);
        role(sck, 'spi', { text: `SPI SCK: ${bus.devices.map(d => d.spec.name).join(', ')}` });
        role(mosi, 'spi', { text: 'SPI MOSI' });
        if (miso) role(miso, 'spi', { text: 'SPI MISO' });
        for (const d of bus.devices) { if (d.csIo) role(d.csIo, 'spi-cs', { text: `chip select of ${d.ref} (${d.spec.name})` }); if (d.dcIo) role(d.dcIo, 'spi-dc', { text: `data/command of ${d.ref}` }); if (d.rstIo) role(d.rstIo, 'reset', { text: `reset of ${d.ref}` }); }
      }
      // addressable LED chains (through a series resistor or a one-gate level shifter)
      let chains = [];
      try { chains = D.ledChains(circ) || []; } catch (e) { chains = []; }
      for (const ch of chains) {
        if (ch.skip) continue;
        let io = ioOn(ch.dataNet, 1000);
        if (!io) {
          const dn0 = ix.net.get(ch.dataNet);
          // through a buffer / level shifter: the pin on the other side of the same channel (A1 ↔ B1 / Y1 by name, pin 20 − n on
          // '244 / '245 / '541 octal parts, any pin on one-gate parts)
          for (const dn of dn0 ? ix.hop(dn0, 1000) : []) for (const x of dn.nodes) {
            if (io) break;
            const c = ix.comp.get(x.ref), np = (c && c.pins || []).length;
            if (!c || c.type !== 'ic' || np > 24 || !/74|1T45|1T34|1G1[27]|1G125|LVC|AHCT|HCT|TXB|TXS|BUF|245|244|541/i.test([c.value, c.mpn].join(' '))) continue;
            const here = c.pins.find(p => String(p.number) === String(x.pin));
            const nm = here ? String(here.name || '').toUpperCase().replace(/[~{}]/g, '') : '';
            const mm = /^(\d?)([ABY])(\d*)$/.exec(nm);
            let cand = [];
            if (mm) cand = c.pins.filter(p => { const o = /^(\d?)([ABY])(\d*)$/.exec(String(p.name || '').toUpperCase().replace(/[~{}]/g, '')); return o && o[1] === mm[1] && o[3] === mm[3] && o[2] !== mm[2]; });
            if (!cand.length && (np === 20 || np === 21) && here) cand = c.pins.filter(p => +p.number === 20 - +here.number);
            if (!cand.length && np <= 8) cand = c.pins;
            for (const p of cand) { const m = ix.at(c.ref, p.number); const hit = m && m !== dn && !ix.isGnd(m) && !ix.isPwr(m) ? ioOn(m.name, 1000) : null; if (hit) { io = hit; break; } }
            if (io) break;
          }
        }
        if (!io) continue;
        const clockIo = ch.clockNet ? ioOn(ch.clockNet, 1000) : null;
        out.chains.push({ io, pin: io.number, dataNet: ch.dataNet, leds: ch.leds, type: ch.type, part: ch.part, clockIo });
        role(io, 'leds', { text: `data of ${ch.leds.length} addressable LED${ch.leds.length > 1 ? 's' : ''} (${ch.part || ch.type})` });
      }
      // UART to a USB serial bridge
      for (const c of circ.components) {
        const spec = D.match(c);
        if (!spec || spec.bus !== 'uart') continue;
        const rp = D.rolePins(spec, c) || {};
        const ntx = rp.tx && ix.at(c.ref, rp.tx[0]), nrx = rp.rx && ix.at(c.ref, rp.rx[0]);
        const rxIo = ntx && ioOn(ntx.name, 1000), txIo = nrx && ioOn(nrx.name, 1000);   // bridge TX -> MCU RX
        if (!rxIo && !txIo) continue;
        out.uarts.push({ tx: txIo && txIo.number, rx: rxIo && rxIo.number, txIo, rxIo, peer: `USB serial bridge ${partName(c)}` });
        if (txIo) role(txIo, 'uart', { text: `UART TX to the USB serial bridge ${c.ref}` });
        if (rxIo) role(rxIo, 'uart', { text: `UART RX from the USB serial bridge ${c.ref}` });
      }
    }
    // native USB
    const dp = proc.io.find(io => /USB_?D(P|\+)|^D\+$|USB_DP|DP$/i.test(io.name) || (io.cap && /D\+|DP/.test(io.cap.usb || '')));
    const dm = proc.io.find(io => /USB_?D(M|N|-)|^D-$|USB_DM|DM$/i.test(io.name) || (io.cap && /D-|DM/.test(io.cap.usb || '')));
    if (dp && dm) { out.usb = { dp: dp.number, dm: dm.number }; role(dp, 'usb', { text: 'USB D+' }); role(dm, 'usb', { text: 'USB D-' }); }
    // Ethernet: RMII / MII lines to a PHY (their TXD / RXD names are not a UART)
    const ETH_NM = /EMAC|RMII|(^|[^A-Z])R?G?MII|ETH|ENET|MDIO|(^|[^A-Z])MDC($|[^A-Z])/;
    const PHY_RX = /LAN8[67]\d|LAN9\d{3}|KSZ8|KSZ9|DP838|RTL8[12]\d{2}|IP10[01]|IP17\d|ENC28J60|ENC424|W5[1-5]00|W6100|88E1|AR803|YT85|JL1101|DM916|BCM54|VSC8|ADIN1/i;
    const eth = { phy: null, pins: [] };
    for (const io of proc.io) {
      if (out.pins.has(io.number)) continue;
      const nm = up(short(io.net));
      const n = ix.net.get(io.net);
      let phy = null;
      if (n) for (const m of ix.hop(n, 100)) { for (const x of m.nodes) { const c = ix.comp.get(x.ref); if (c && c.ref !== proc.ref && c.type === 'ic' && PHY_RX.test([c.value, c.mpn].join(' '))) { phy = c; break; } } if (phy) break; }
      if (!phy && !ETH_NM.test(nm)) continue;
      if (phy && !ETH_NM.test(nm) && !/TXD|RXD|TX_?EN|CRS|RX_?DV|RX_?ER|REF_?CLK|MDC|MDIO|CLK/.test(nm)) continue;
      eth.phy = eth.phy || phy;
      eth.pins.push(io);
      const sig = (/(TXD\d|RXD\d|TX_?EN|CRS_?DV|RX_?CRS_?DV|RX_?ER|RX_?DV|MDIO|MDC|REF_?CLK|CLK_?OUT|RX_?CLK|TX_?CLK)/.exec(nm) || [])[1];
      role(io, 'eth', { text: `Ethernet${sig ? ' ' + sig.replace(/^RX_?CRS/, 'CRS') : ''}${phy ? ' → PHY ' + phy.ref : ''}` });
    }
    if (eth.pins.length >= 2) { out.eth = eth; if (!eth.phy) eth.phy = circ.components.find(c => c.type === 'ic' && PHY_RX.test([c.value, c.mpn].join(' '))) || null; }
    // named UART pins going to connectors or other chips
    for (const io of proc.io) {
      if (out.pins.has(io.number)) continue;
      const nm = up(short(io.net));
      if (!/(^|[_\W])(U?TXD?\d?|U?RXD?\d?)($|[_\W])|UART|SERIAL/.test(nm)) continue;
      // a differential pair (TX2+ / RXN) or an RF switch's TX / RX control is no UART
      if (/(TX|RX)\d*_?([+-]|[PN])$/.test(nm)) continue;
      const n = ix.net.get(io.net);
      const peers = n ? n.nodes.filter(x => x.ref !== proc.ref).map(x => ix.comp.get(x.ref)).filter(Boolean) : [];
      if (peers.some(c => c.type === 'ic' && /SKY1\d|PE42\d|BGS1\d|HMC\d|AS21\d|RFSW|SPDT|SP[34]T/i.test([c.value, c.mpn].join(' ')))) continue;
      const conn = peers.find(c => c.type === 'connector'), chip = peers.find(c => c.type === 'ic');
      const peer = conn ? `connector ${conn.ref}` : chip ? partName(chip) : null;
      const tx = /TX/.test(nm);
      if (peer) {
        let u = out.uarts.find(x => x.peer === peer && (tx ? x.tx == null : x.rx == null));
        if (!u) out.uarts.push((u = { tx: null, rx: null, peer }));
        if (tx) { u.tx = io.number; u.txIo = io; } else { u.rx = io.number; u.rxIo = io; }
      }
      role(io, 'uart', { text: `${tx ? 'UART TX' : 'UART RX'} to ${peer || 'a pad'}`, weak: true });
    }
    // analog inputs: dividers, thermistors, potentiometers
    for (const io of proc.io) {
      if (out.pins.has(io.number)) continue;
      const n = ix.net.get(io.net);
      if (!n) continue;
      const rs = n.nodes.map(x => ix.comp.get(x.ref)).filter(c => c && (c.type === 'resistor' || c.type === 'thermistor' || c.type === 'potentiometer'));
      if (c2(rs)) continue;
      function c2(list) {
        const toG = list.find(c => c.type === 'resistor' && ix.isGnd(ix.other(c, n)));
        const toS = list.find(c => c !== toG && (c.type === 'resistor' || c.type === 'thermistor') && !ix.isGnd(ix.other(c, n)) && ix.other(c, n));
        const pot = list.find(c => c.type === 'potentiometer');
        if (pot) { out.analog.push({ io, what: `potentiometer ${pot.ref}` }); role(io, 'analog', { text: `wiper of potentiometer ${pot.ref}` }); return true; }
        if (!toG || !toS) return false;
        const src = ix.other(toS, n);
        // a pin without an ADC on a known chip, or a divider that level-shifts a digital line, is no analog input
        if (proc.chip && io.cap && !io.cap.adc) return false;
        const sn = short(src.name);
        if (!/BAT|VBUS|VSYS|VIN|VCC|VDD|SENS|SNS|ADC|MEAS|VOUT|VREF|TEMP|NTC|LIGHT|LDR|POT|[+]?\d+V\d*|^V[A-Z]/i.test(sn) && /INT|IRQ|RST|RESET|EN\b|_EN|CS\b|SCL|SDA|TX|RX|USB|D[+-]$|DP$|DM$|CC\d|BOOT|PWM|LED|BTN|KEY|CLK|DATA|MOSI|MISO|SCK|HP|SPK|SPEAKER|HEADPHONE|LOUT|ROUT|AUDIO/i.test(sn)) return false;
        const ra = ix.ohms(toS), rb = ix.ohms(toG);
        const therm = toS.type === 'thermistor' || toG.type === 'thermistor' || /NTC|THERM/i.test(toS.value + toG.value);
        const ratio = ra && rb ? rb / (ra + rb) : null;
        const what = therm ? `thermistor divider (${toS.ref}/${toG.ref})` : ratio && ratio > 0.95 ? `${sn} through ${toS.ref} (${toG.ref} pulls it down)` : `${sn} through the ${toS.ref}/${toG.ref} divider${ratio ? ' (×' + ratio.toFixed(3) + ')' : ''}`;
        out.analog.push({ io, what, ratio, source: src.name, therm });
        role(io, 'analog', { text: 'reads ' + what, adc: !!(io.cap && io.cap.adc) });
        return true;
      }
    }
    // drivers: MOSFET gates, motor driver inputs, buzzers
    for (const io of proc.io) {
      if (out.pins.has(io.number)) continue;
      const n = ix.net.get(io.net);
      if (!n) continue;
      for (const m of ix.hop(n, 1000)) {
        for (const x of m.nodes) {
          const c = ix.comp.get(x.ref);
          if (!c || c.ref === proc.ref) continue;
          if ((c.type === 'mosfet_n' || c.type === 'mosfet_p') && up(ix.pinName(c.ref, x.pin)).startsWith('G')) { out.drivers.push({ io, ref: c.ref, what: `switches ${partName(c)}` }); role(io, 'driver', { text: `gate of ${partName(c)}` }); break; }
          if ((c.type === 'bjt_npn' || c.type === 'bjt_pnp') && up(ix.pinName(c.ref, x.pin)).startsWith('B')) { out.drivers.push({ io, ref: c.ref, what: `switches ${partName(c)}` }); role(io, 'driver', { text: `base of ${partName(c)}` }); break; }
          if (c.type === 'ic' && /DRV8|TB66|L298|L293|A4988|TMC2|DRV2|MP6550|BTS|VNH|IRS2|DRV83/i.test(c.value || '')) { out.drivers.push({ io, ref: c.ref, what: `motor driver ${partName(c)} input ${ix.pinName(c.ref, x.pin) || x.pin}` }); role(io, 'driver', { text: `${ix.pinName(c.ref, x.pin) || 'input'} of ${partName(c)}` }); break; }
          if (/BUZZ|SPEAKER|PIEZO/i.test(c.value + ' ' + (c.description || ''))) { out.drivers.push({ io, ref: c.ref, what: `buzzer ${c.ref}` }); role(io, 'buzzer', { text: `buzzer ${c.ref}` }); break; }
        }
        if (out.pins.has(io.number)) break;
      }
    }
    // header / connector pins (external IO)
    for (const io of proc.io) {
      if (out.pins.has(io.number)) continue;
      const n = ix.net.get(io.net);
      const conn = n && n.nodes.map(x => ix.comp.get(x.ref)).find(c => c && c.type === 'connector' && c.ref !== proc.ref);
      if (conn) role(io, 'header', { text: `to connector ${conn.ref}`, weak: true });
    }
    return out;
  };

  // ------------------------------------------------------------------ words
  const hex = a => '0x' + a.toString(16).padStart(2, '0');
  const partName0 = c => `${c.ref}${c.value ? ' (' + c.value + ')' : ''}`;
  A.describe = function (a) {
    const p = a.proc, L = [];
    const pin = io => (N.fw.shortPin ? N.fw.shortPin(io) : io.name);
    const chip = p.chip;
    const art = w => (/^[AEIOU]/i.test(w) || /^[AEFHILMNORSX][A-Z0-9]/.test(w) || /^i[A-Z]/.test(w) ? 'an ' : 'a ') + w;
    L.push(`${p.ref} is ${art(chip ? chip.name : p.value)} ${p.kind === 'microcontroller' ? '' : p.kind + ' '}${chip && chip.core ? '(' + chip.core + ')' : ''}${p.vnom ? `, IO at ${p.vnom} V` : ''}.`.replace(/\s+/g, ' ').replace(' .', '.'));
    if (a.enables.length) L.push(`It switches power: ${a.enables.map(e => `${pin(e.io)} enables ${e.ref} (${e.value})`).join('; ')}.`);
    if (a.leds.length) L.push(`LEDs: ${a.leds.map(l => `${pin(l.io)} → ${l.ref}`).join(', ')}.`);
    if (a.chains.length) L.push(`Addressable LEDs: ${a.chains.map(c => `${c.leds.length}× ${c.part || c.type} on ${pin(c.io)}`).join('; ')}.`);
    if (a.buttons.length) L.push(`Buttons: ${a.buttons.map(b => `${b.ref} on ${pin(b.io)}`).join(', ')}.`);
    for (const b of a.i2c) L.push(`I2C bus on ${pin(b.sdaIo)}/${pin(b.sclIo)}: ${b.devices.map(d => `${d.spec.name} ${d.ref} at ${hex(d.address)}${d.via ? ' behind mux ' + d.via.ref + ' ch' + d.via.channel : ''}`).join(', ')}.`);
    for (const b of a.spi) L.push(`SPI bus: ${b.devices.map(d => `${d.spec.name} ${d.ref}${d.csIo ? ' (CS ' + pin(d.csIo) + ')' : ''}`).join(', ')}.`);
    if (a.usb) L.push('Native USB on the D+/D- pins.');
    if (a.eth) L.push(`Ethernet${a.eth.pins.some(io => /RMII/i.test(io.net)) ? ' (RMII)' : ''}${a.eth.phy ? ' through the PHY ' + partName0(a.eth.phy) : ''} on ${a.eth.pins.length} pins.`);
    for (const u of a.uarts.slice(0, 3)) L.push(`UART ${u.txIo ? 'TX ' + pin(u.txIo) : ''}${u.rxIo ? ' RX ' + pin(u.rxIo) : ''} to the ${u.peer}.`.replace('UART  ', 'UART '));
    if (a.analog.length) L.push(`Analog inputs: ${a.analog.map(x => `${pin(x.io)} reads ${x.what}`).join('; ')}.`);
    if (a.drivers.length) L.push(`Drives: ${a.drivers.slice(0, 6).map(x => `${pin(x.io)} ${x.what}`).join('; ')}.`);
    return L;
  };
  // ------------------------------------------------------------------ firmware written from the analysis
  // Arduino-style program that exercises what the board has: enables, LEDs, buttons, sensors on I2C, screens, LED chains, analog inputs
  const SENSOR_LIBS = {
    bme280: { cls: 'Adafruit_BME280', v: 'bme', begin: a => `bme.begin(${a})`, read: v => [`float t = ${v}.readTemperature(), h = ${v}.readHumidity(), pr = ${v}.readPressure() / 100.0;`, `Serial.printf("  %s: %.1f C  %.0f %%RH  %.1f hPa\\n", NAME, t, h, pr);`], say: 'temperature, humidity and pressure' },
    bmp280: { cls: 'Adafruit_BMP280', v: 'bmp', begin: a => `bmp.begin(${a})`, read: v => [`float t = ${v}.readTemperature(), pr = ${v}.readPressure() / 100.0;`, `Serial.printf("  %s: %.1f C  %.1f hPa\\n", NAME, t, pr);`], say: 'temperature and pressure' },
    sht3x: { cls: 'Adafruit_SHT31', v: 'sht31', begin: a => `sht31.begin(${a})`, read: v => [`float t = ${v}.readTemperature(), h = ${v}.readHumidity();`, `Serial.printf("  %s: %.1f C  %.0f %%RH\\n", NAME, t, h);`], say: 'temperature and humidity' },
    sht4x: { cls: 'Adafruit_SHT4x', v: 'sht4', begin: () => 'sht4.begin()', read: v => ['sensors_event_t hum, temp;', `${v}.getEvent(&hum, &temp);`, 'Serial.printf("  %s: %.1f C  %.0f %%RH\\n", NAME, temp.temperature, hum.relative_humidity);'], say: 'temperature and humidity' },
    aht20: { cls: 'Adafruit_AHTX0', v: 'aht', begin: () => 'aht.begin()', read: v => ['sensors_event_t hum, temp;', `${v}.getEvent(&hum, &temp);`, 'Serial.printf("  %s: %.1f C  %.0f %%RH\\n", NAME, temp.temperature, hum.relative_humidity);'], say: 'temperature and humidity' },
    mpu6050: { cls: 'Adafruit_MPU6050', v: 'mpu', begin: a => `mpu.begin(${a})`, read: v => ['sensors_event_t a, g, temp;', `${v}.getEvent(&a, &g, &temp);`, 'Serial.printf("  %s: accel %.2f %.2f %.2f m/s2\\n", NAME, a.acceleration.x, a.acceleration.y, a.acceleration.z);'], say: 'acceleration and rotation' },
    lis3dh: { cls: 'Adafruit_LIS3DH', v: 'lis', begin: a => `lis.begin(${a})`, read: v => ['sensors_event_t e;', `${v}.getEvent(&e);`, 'Serial.printf("  %s: accel %.2f %.2f %.2f m/s2\\n", NAME, e.acceleration.x, e.acceleration.y, e.acceleration.z);'], say: 'acceleration' },
    ina219: { cls: 'Adafruit_INA219', v: 'ina', ctor: a => `(${a})`, begin: () => 'ina.begin()', read: v => [`Serial.printf("  %s: %.2f V  %.1f mA\\n", NAME, ${v}.getBusVoltage_V(), ${v}.getCurrent_mA());`], say: 'bus voltage and current' },
    ads1115: { cls: 'Adafruit_ADS1115', v: 'ads', begin: a => `ads.begin(${a})`, read: v => [`int16_t raw = ${v}.readADC_SingleEnded(0);`, `Serial.printf("  %s: AIN0 = %.3f V\\n", NAME, ${v}.computeVolts(raw));`], say: 'an analog input' },
    ds3231: { cls: 'RTC_DS3231', v: 'rtc', begin: () => 'rtc.begin()', read: v => [`DateTime now = ${v}.now();`, 'Serial.printf("  %s: %02d:%02d:%02d\\n", NAME, now.hour(), now.minute(), now.second());'], say: 'the time' },
    ds1307: { cls: 'RTC_DS1307', v: 'rtc', begin: () => 'rtc.begin()', read: v => [`DateTime now = ${v}.now();`, 'Serial.printf("  %s: %02d:%02d:%02d\\n", NAME, now.hour(), now.minute(), now.second());'], say: 'the time' },
    pcf8563: { cls: 'RTC_PCF8563', v: 'rtc', begin: () => 'rtc.begin()', read: v => [`DateTime now = ${v}.now();`, 'Serial.printf("  %s: %02d:%02d:%02d\\n", NAME, now.hour(), now.minute(), now.second());'], say: 'the time' },
    max17048: { cls: 'Adafruit_MAX17048', v: 'gauge', begin: () => 'gauge.begin()', read: v => [`Serial.printf("  %s: battery %.2f V  %.0f %%\\n", NAME, ${v}.cellVoltage(), ${v}.cellPercent());`], say: 'the battery charge' },
    bh1750: { cls: 'BH1750', v: 'light', begin: () => 'light.begin()', read: v => [`Serial.printf("  %s: %.0f lx\\n", NAME, ${v}.readLightLevel());`], say: 'light' },
    veml7700: { cls: 'Adafruit_VEML7700', v: 'veml', begin: () => 'veml.begin()', read: v => [`Serial.printf("  %s: %.0f lx\\n", NAME, ${v}.readLux());`], say: 'light' },
  };
  SENSOR_LIBS.aht10 = SENSOR_LIBS.aht20;
  SENSOR_LIBS.ads1015 = Object.assign({}, SENSOR_LIBS.ads1115, { cls: 'Adafruit_ADS1015' });
  SENSOR_LIBS.max17043 = SENSOR_LIBS.max17048;
  // parts without a library here: the program reads their identity register over Wire (register, value the datasheet gives)
  const ID_REGS = { bme680: [0xd0, 0x61], bme688: [0xd0, 0x61], bno055: [0x00, 0xa0], mpu9250: [0x75, 0x71], icm20948: [0x00, 0xea], icm42670: [0x75, 0x67], lsm6dsox: [0x0f, 0x6c],
    lsm6ds3: [0x0f, 0x69], bmi270: [0x00, 0x24], emc2101: [0xfd, 0x16], emc2301: [0xfd, 0x37], es8311: [0xfd, 0x83], es8156: [0xfd, 0x81], ina228: [0x3e, 0x54] };
  A.SENSOR_LIBS = SENSOR_LIBS; A.ID_REGS = ID_REGS;
  A.program = function (a) {
    const p = a.proc, L = [], S = [], LOOP = [];
    const q = io => JSON.stringify(N.fw.shortPin(io));
    const chip = p.chip;
    // one entry per switch and per pin (a keyboard matrix puts one switch on two pins)
    const seenB = new Set(), btns = [];
    for (const b of a.buttons) { if (seenB.has(b.ref) || seenB.has('#' + b.io.number)) continue; seenB.add(b.ref); seenB.add('#' + b.io.number); btns.push(Object.assign({ v: 'last_' + b.ref.replace(/\W/g, '_') }, b)); if (btns.length >= 6) break; }
    const hdr = [`// Auto program for ${p.ref} (${chip ? chip.name : p.value}), written from what this board does.`, '// It exercises the board: everything below was found in the schematic and PCB netlist.'];
    const uses = [];
    const incs = new Set();
    // sensors and screens on I2C
    const i2cBus = a.i2c[0];
    const sensors = [], seenV = new Set();
    let oled = null;
    for (const b of a.i2c) for (const d of b.devices) {
      const lib = SENSOR_LIBS[d.spec.id];
      if (lib && !seenV.has(lib.v) && b === i2cBus) { seenV.add(lib.v); sensors.push({ d, lib }); }
      if (!oled && /ssd1306|sh1106/.test(d.spec.id) && b === i2cBus) oled = d;
    }
    const idParts = i2cBus ? i2cBus.devices.filter(d => ID_REGS[d.spec.id] && !sensors.some(x => x.d === d)).slice(0, 6) : [];
    const temps = i2cBus ? i2cBus.devices.filter(d => d.spec.id === 'tmp102').slice(0, 2) : [];
    const spiScreen = a.spi.flatMap(b => b.devices).find(d => /st7789|st7735|ili9341/.test(d.spec.id) && d.csIo && d.dcIo);
    const chain = a.chains.find(c => c.type !== 'apa102') || null;
    for (const e of a.enables) uses.push(`${N.fw.shortPin(e.io)} switches ${e.ref} (${e.value}) on`);
    for (const l of a.leds.slice(0, 6)) uses.push(`LED ${l.ref} on ${N.fw.shortPin(l.io)}`);
    for (const b of btns) uses.push(`button ${b.ref} on ${N.fw.shortPin(b.io)}`);
    if (a.i2c.length) uses.push(`I2C on ${N.fw.shortPin(i2cBus.sdaIo)}/${N.fw.shortPin(i2cBus.sclIo)}: ${i2cBus.devices.map(d => d.spec.name + ' 0x' + d.address.toString(16)).join(', ')}`);
    if (oled) uses.push(`${oled.spec.name} screen ${oled.ref}`);
    if (spiScreen) uses.push(`${spiScreen.spec.name} screen ${spiScreen.ref} on SPI`);
    if (chain) uses.push(`${chain.leds.length} addressable LED${chain.leds.length > 1 ? 's' : ''} on ${N.fw.shortPin(chain.io)}`);
    for (const x of a.analog.slice(0, 4)) uses.push(`${N.fw.shortPin(x.io)} reads ${x.what}`);
    for (const u of uses) hdr.push('//  - ' + u);
    if (a.drivers.length) hdr.push(`// Not driven on purpose: ${a.drivers.slice(0, 4).map(d => N.fw.shortPin(d.io) + ' (' + d.what + ')').join(', ')}. Add that yourself when it is safe.`);
    if (a.i2c.length || oled) incs.add('#include <Wire.h>');
    for (const s of sensors) incs.add(`#include <${s.lib.cls === 'RTC_DS3231' || /^RTC_/.test(s.lib.cls) ? 'RTClib' : s.lib.cls}.h>`);
    if (oled) incs.add('#include <Adafruit_SSD1306.h>');
    if (spiScreen) incs.add(`#include <Adafruit_${/st7789/.test(spiScreen.spec.id) ? 'ST7789' : /st7735/.test(spiScreen.spec.id) ? 'ST7735' : 'ILI9341'}.h>`);
    if (chain) incs.add('#include <Adafruit_NeoPixel.h>');
    L.push(...hdr, '', ...incs, '');
    for (const s of sensors) L.push(`${s.lib.cls} ${s.lib.v}${s.lib.ctor ? s.lib.ctor('0x' + s.d.address.toString(16)) : ''};   // ${s.d.ref} ${s.d.spec.name} at 0x${s.d.address.toString(16)}: ${s.lib.say}`);
    if (sensors.length) L.push(`bool ${sensors.map(s => s.lib.v + 'Ok = false').join(', ')};`);
    if (oled) L.push(`Adafruit_SSD1306 display(${oled.spec.display ? oled.spec.display.w : 128}, ${oled.spec.display ? oled.spec.display.h : 64}, &Wire, -1);   // ${oled.ref}`, 'bool displayOk = false;');
    if (spiScreen) {
      const cls = /st7789/.test(spiScreen.spec.id) ? 'Adafruit_ST7789' : /st7735/.test(spiScreen.spec.id) ? 'Adafruit_ST7735' : 'Adafruit_ILI9341';
      L.push(`${cls} tft(${q(spiScreen.csIo)}, ${q(spiScreen.dcIo)}, ${spiScreen.rstIo ? q(spiScreen.rstIo) : -1});   // ${spiScreen.ref}`);
    }
    if (chain) L.push(`Adafruit_NeoPixel strip(${chain.leds.length}, ${q(chain.io)}, NEO_GRB + NEO_KHZ800);   // ${chain.leds[0]}${chain.leds.length > 1 ? '..' + chain.leds[chain.leds.length - 1] : ''}`);
    L.push('unsigned long lastBlink = 0, lastReport = 0, lastPixels = 0;', 'bool ledOn = false;', 'int presses = 0, hue = 0;');
    if (idParts.length || temps.length) L.push('', '// one register over I2C: write the register number, then read the value back', 'int readReg(int addr, int reg) {', '  Wire.beginTransmission(addr);', '  Wire.write(reg);', '  if (Wire.endTransmission(false) != 0) return -1;', '  Wire.requestFrom(addr, 1);', '  return Wire.available() ? Wire.read() : -1;', '}');
    if (temps.length) L.push('float readTmp102(int addr) {   // 12-bit temperature, 0.0625 C per step', '  Wire.beginTransmission(addr);', '  Wire.write(0);', '  if (Wire.endTransmission(false) != 0) return -999;', '  Wire.requestFrom(addr, 2);', '  int raw = (Wire.read() << 8) | Wire.read();', '  if (raw & 0x8000) raw -= 65536;', '  return (raw >> 4) * 0.0625;', '}');
    for (const b of btns) L.push(`int ${b.v} = HIGH;`);
    L.push('');
    // setup
    S.push('void setup() {', '  Serial.begin(115200);', `  Serial.println("${p.ref} auto program: exercising the board");`);
    for (const e of a.enables) S.push(`  pinMode(${q(e.io)}, OUTPUT);`, `  digitalWrite(${q(e.io)}, ${e.activeHigh ? 'HIGH' : 'LOW'});   // ${e.ref} on`);
    for (const l of a.leds.slice(0, 6)) S.push(`  pinMode(${q(l.io)}, OUTPUT);`);
    for (const b of btns) S.push(`  pinMode(${q(b.io)}, INPUT_PULLUP);`);
    if (btns.length) { S.push('  delay(5);   // let the pull-ups charge any debounce capacitors'); for (const b of btns) S.push(`  ${b.v} = digitalRead(${q(b.io)});`); }
    if (a.i2c.length) {
      const ard = chip && chip.arduino && chip.arduino.wire;
      const def = ard && ard.sda === i2cBus.sdaIo.chipPin && ard.scl === i2cBus.sclIo.chipPin;
      S.push(def || !(chip && chip.arduino && chip.arduino.i2cAnyPin) ? '  Wire.begin();' : `  Wire.begin(${q(i2cBus.sdaIo)}, ${q(i2cBus.sclIo)});`);
      S.push('  Serial.println("I2C scan:");', '  for (int addr = 1; addr < 127; addr++) {', '    Wire.beginTransmission(addr);', '    if (Wire.endTransmission() == 0) Serial.printf("  found 0x%02X\\n", addr);', '  }');
    }
    for (const s of sensors) S.push(`  ${s.lib.v}Ok = ${s.lib.begin('0x' + s.d.address.toString(16))};`, `  Serial.println(${s.lib.v}Ok ? "${s.d.spec.name} ready" : "${s.d.spec.name} did not answer");`);
    for (const d of idParts) { const [r, v] = ID_REGS[d.spec.id]; S.push(`  Serial.printf("${d.ref} ${d.spec.name}: ID register 0x%02X = 0x%02X (datasheet: 0x${v.toString(16).toUpperCase().padStart(2, '0')})\\n", 0x${r.toString(16).toUpperCase().padStart(2, '0')}, readReg(0x${d.address.toString(16)}, 0x${r.toString(16).toUpperCase().padStart(2, '0')}));`); }
    if (oled) S.push(`  displayOk = display.begin(SSD1306_SWITCHCAPVCC, 0x${oled.address.toString(16)});`, '  if (displayOk) { display.clearDisplay(); display.setTextColor(SSD1306_WHITE); display.setTextSize(1); display.setCursor(0, 0); display.println("Hello from KiLive"); display.display(); }');
    if (spiScreen) {
      const init = /st7789/.test(spiScreen.spec.id) ? `tft.init(${spiScreen.spec.display ? spiScreen.spec.display.w + ', ' + spiScreen.spec.display.h : '240, 240'});` : /st7735/.test(spiScreen.spec.id) ? 'tft.initR(INITR_BLACKTAB);' : 'tft.begin();';
      S.push(`  ${init}`, '  tft.fillScreen(0x0000);', '  tft.setTextColor(0xFFFF, 0x0000);', '  tft.setTextSize(tft.width() >= 200 ? 2 : 1);', '  tft.setCursor(6, 6);', `  tft.println("${p.ref} on KiLive");`, `  tft.drawRect(0, 0, tft.width(), tft.height(), 0x07E0);`);
    }
    if (chain) S.push('  strip.begin();', '  strip.setBrightness(60);', '  strip.show();');
    S.push('}', '');
    // loop
    LOOP.push('void loop() {', '  unsigned long now = millis();');
    if (a.leds.length) {
      LOOP.push('  if (now - lastBlink >= 500) {   // heartbeat', '    lastBlink = now;', '    ledOn = !ledOn;');
      a.leds.slice(0, 6).forEach((l, i) => LOOP.push(`    digitalWrite(${q(l.io)}, ${i === 0 ? '' : '(presses % 2) ? '}${l.activeHigh ? 'ledOn' : '!ledOn'}${i === 0 ? '' : ' : ' + (l.activeHigh ? 'LOW' : 'HIGH')});   // ${l.ref}`));
      LOOP.push('  }');
    }
    for (const b of btns) {
      const v = b.v;
      LOOP.push(`  int s_${v} = digitalRead(${q(b.io)});`, `  if (s_${v} == LOW && ${v} == HIGH) { presses++; Serial.printf("${b.ref} pressed (%d)\\n", presses); }`, `  ${v} = s_${v};`);
    }
    if (chain) LOOP.push('  if (now - lastPixels >= 30) {   // rainbow', '    lastPixels = now;', '    hue += 256;', '    for (int i = 0; i < strip.numPixels(); i++) strip.setPixelColor(i, strip.ColorHSV(hue + i * 65536 / strip.numPixels()));', '    strip.show();', '  }');
    LOOP.push('  if (now - lastReport >= 1000) {   // report', '    lastReport = now;', '    Serial.printf("t = %lu ms\\n", now);');
    for (const x of a.analog.slice(0, 4)) {
      const bits = (chip && chip.adc && (chip.adc.arduinoBits || chip.adc.bits)) || 10, vref = (chip && chip.adc && chip.adc.vref) || p.vnom || 3.3;
      const scale = x.ratio ? ` / ${x.ratio.toFixed(4)}` : '';
      LOOP.push(`    float v_${x.io.number.replace(/\W/g, '_')} = analogRead(${q(x.io)}) * ${vref} / ${(1 << bits) - 1}.0${scale};`, `    Serial.printf("  ${N.fw.shortPin(x.io)} (${x.what.replace(/"/g, '')}): %.2f V\\n", v_${x.io.number.replace(/\W/g, '_')});`);
    }
    for (const d of temps) LOOP.push(`    Serial.printf("  ${d.ref} TMP102: %.2f C\\n", readTmp102(0x${d.address.toString(16)}));`);
    // parts read by their identity register: checked again every report (the transfers show on the scope's I2C decoder)
    for (const d of idParts) { const [r, v] = ID_REGS[d.spec.id]; LOOP.push(`    if (readReg(0x${d.address.toString(16)}, 0x${r.toString(16).toUpperCase().padStart(2, '0')}) != 0x${v.toString(16).toUpperCase().padStart(2, '0')}) Serial.println("  ${d.ref} ${d.spec.name} does not answer");`); }
    for (const s of sensors) LOOP.push(`    if (${s.lib.v}Ok) {`, `      String NAME = "${s.d.spec.name}";`, ...s.lib.read(s.lib.v).map(x => '      ' + x), '    }');
    if (oled) LOOP.push('    if (displayOk) {', '      display.clearDisplay();', '      display.setCursor(0, 0);', '      display.print("t = "); display.print(now / 1000); display.println(" s");', '      display.print("presses "); display.println(presses);', '      display.display();', '    }');
    if (spiScreen) LOOP.push('    int ts = tft.width() >= 200 ? 2 : 1;', '    tft.setCursor(6, 24 * ts);', '    tft.print("t = "); tft.print(now / 1000.0, 1); tft.print(" s  ");', '    tft.setCursor(6, 36 * ts);', '    tft.print("presses "); tft.print(presses); tft.print("  ");', '    tft.fillRect(6, 50 * ts, tft.width() - 12, 6, 0x0000);', '    tft.fillRect(6, 50 * ts, (now / 100) % (tft.width() - 12), 6, 0x07E0);');
    LOOP.push('  }', '  delay(10);', '}');
    return L.concat(S, LOOP).join('\n') + '\n';
  };

  // compact text for prompts
  A.promptText = function (a) {
    const pin = io => N.fw.shortPin(io);
    const rows = [];
    for (const io of a.proc.io) {
      const r = a.pins.get(io.number);
      const cap = io.cap ? [io.cap.adc ? 'ADC ' + io.cap.adc : '', io.cap.pwm ? 'PWM' : '', io.cap.inputOnly ? 'INPUT ONLY' : '', io.cap.strap ? 'strapping pin' : ''].filter(Boolean).join(', ') : '';
      if (!r && !cap) continue;
      rows.push(`"${pin(io)}"${io.chipPin && io.chipPin !== pin(io) ? ' (' + io.chipPin + ')' : ''} net ${short(io.net)}${r ? ': ' + r.text : ''}${cap ? ' [' + cap + ']' : ''}`);
    }
    return A.describe(a).join('\n') + '\n\nPins:\n' + rows.slice(0, 160).join('\n');
  };
})();

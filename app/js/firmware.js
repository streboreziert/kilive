/* KiLive — code on the processors of a live board.
   Real firmware on chips we emulate instruction by instruction (RP2040 via rp2040js, megaAVR via avr8js, both MIT, Wokwi),
   Arduino-style programs on every other processor (ESP32, STM32, nRF, SAM, CH32V, FPGAs, SoC modules). */
(function () {
  'use strict';
  const N = window.Noeti;
  const F = (N.fw = {});

  // ------------------------------------------------------------------ processors on a board
  const MCU_RX = /RP2040|RP2350|ATMEGA|ATTINY|AT90USB|ATXMEGA|ESP32|ESP8266|ESP-WROOM|WROOM|WROVER|STM32|GD32|NRF5\d|ATSAM|SAMD\d|SAML\d|SAME\d|SAMC\d|CH32V|CH55\d|PIC1[0268]F|PIC24|PIC32|DSPIC|MSP430|LPC\d{3,4}|EFM32|EFR32|MGM\d|CC13\d\d|CC26\d\d|W65C0|CY7C68|ICE40|LFE5|ECP5|XC7[AKSZ]|XC6S|ARTIX|SPARTAN|KINTEX|MACHXO|LCMXO|GW1N|I\.?MX\d|OSD33|AM335|KRIA|JETSON|CM3588|CM4\b|CM5\b|RK35\d\d|RASPBERRY PI PICO|\bPICO\b|PRO ?MICRO|XIAO|RAK4\d{3}|RAK3\d{3}|\bE73\b|ARDUINO|\bNANO\b|TEENSY|BLACK ?PILL|MICROMOD|FEATHER|STAMP|T-DISPLAY|T-MICRO|MODULE/i;
  const NOT_MCU = /LDO|REGULATOR|BUCK|BOOST|CHARGER|MOSFET|DIODE|LED\b|CRYSTAL|OSCILLATOR|FLASH|EEPROM|SRAM|DRAM|DDR|USB[- ]?C|CONN|HEADER|SOCKET|BUTTON|SWITCH|FUSE|TVS|ESD|ANTENNA|TRANSCEIVER|PHY\b|CODEC|AMPLIFIER|MUX|BUFFER|LEVEL|SHIFTER/i;
  const POWER_NAME = /^(VCC|VDD|VSS|GND|AVCC|AVDD|DVDD|DVCC|IOVDD|VDDIO|VDDA|VSSA|VREF|AREF|VBAT|VIN|VBUS|VUSB|3V3|3\.3V|5V|\+5V|\+3V3|VREG|VCORE|VDDCORE|DVDD_?\d*|VDD_?\w*|VCC_?\w*|AGND|DGND|PGND|EP|PAD|THERMAL|GND\d*|VSS\d*|NC|DNC|N\/C|VDDIO\w*|VDDA\w*|IOVCC|VPP|VCCIO\w*|VCCINT|VCCAUX|VCCPLL\w*|VCCO_?\w*|VCCBRAM|VCCPINT|VMID|UCAP|VDD_?SPI|VDD3P3\w*|VDDSDIO|LDO_?\w*)$/i;
  const SPECIAL_NAME = /^(XTAL|XIN|XOUT|XI\b|XO\b|OSC|RESET|~\{RESET\}|~\{RST\}|RST|NRST|RUN|BOOT|TEST|TESTEN|SWD|SWCLK|SWDIO|QSPI|USB_?D|USB_?DP|USB_?DM|D\+|D-|DP$|DM$|CHIP_?PU|EN$)/i;
  const up = s => String(s || '').toUpperCase();
  const shortNet = n => (n ? String(n).split('/').pop().replace(/\{slash\}/g, '/') : '');

  function netOfPin(circ, ref, pin) { pin = String(pin); for (const n of circ.nets) for (const x of n.nodes) if (x.ref === ref && String(x.pin) === pin) return n; return null; }
  const PICO_RX = /RASPBERRY ?PI ?PICO(?! ?2)|(^|[^A-Z0-9])PICO( ?W| ?H)?($|[^A-Z0-9])/;
  const NANO_RX = /ARDUINO[_ ]?NANO(?![_ ]?(33|ESP|EVERY|RP|BLE|MATTER))|^NANO$/;
  function family(c) {
    const t = up(c.value + ' ' + (c.description || '') + ' ' + (c.mpn || ''));
    const names = (c.pins || []).map(p => up(p.name));
    if ((/RP2040/.test(t) || PICO_RX.test(t)) && !/RP2350|PICO ?2|PICO2/.test(t) && names.some(n => /^(GPIO|GP)\d+/.test(n))) return 'rp2040';
    if (/ATMEGA|AT90USB/.test(t) && names.some(n => /\bP[A-L][0-7]\b/.test(n))) return 'avr';
    if (NANO_RX.test(up(c.value)) && names.some(n => /^D\d+/.test(n))) return 'avr';
    return 'script';
  }
  // Arduino pin numbers of the ATmega328P boards (Uno, Nano): D0-7 = PD0-7, D8-13 = PB0-5, D14-19 = A0-5 = PC0-5
  F.arduinoBit = function (name) {
    const m = /^(?:D(\d+)|A(\d))\b/i.exec(String(name || '').trim());
    if (!m) return null;
    const i = m[1] != null ? +m[1] : 14 + +m[2];
    if (i < 8) return ['D', i];
    if (i < 14) return ['B', i - 8];
    if (i < 20) return ['C', i - 14];
    return null;
  };
  // the RP2040 QFN-56 pinout, for symbols drawn without pin names
  const RP2040_PINS = { 1: 'IOVDD', 10: 'IOVDD', 19: 'TESTEN', 20: 'XIN', 21: 'XOUT', 22: 'IOVDD', 23: 'DVDD', 24: 'SWCLK', 25: 'SWD', 26: 'RUN', 33: 'IOVDD', 42: 'IOVDD', 43: 'ADC_AVDD', 44: 'VREG_IN', 45: 'VREG_VOUT', 46: 'USB_DM', 47: 'USB_DP', 48: 'USB_VDD', 49: 'IOVDD', 50: 'DVDD', 51: 'QSPI_SD3', 52: 'QSPI_SCLK', 53: 'QSPI_SD0', 54: 'QSPI_SD2', 55: 'QSPI_SD1', 56: 'QSPI_SS', 57: 'GND' };
  [2, 3, 4, 5, 6, 7, 8, 9].forEach((p, i) => { RP2040_PINS[p] = 'GPIO' + i; });
  [11, 12, 13, 14, 15, 16, 17, 18].forEach((p, i) => { RP2040_PINS[p] = 'GPIO' + (8 + i); });
  [27, 28, 29, 30, 31, 32].forEach((p, i) => { RP2040_PINS[p] = 'GPIO' + (16 + i); });
  [34, 35, 36, 37].forEach((p, i) => { RP2040_PINS[p] = 'GPIO' + (22 + i); });
  [38, 39, 40, 41].forEach((p, i) => { RP2040_PINS[p] = 'GPIO' + (26 + i) + '_ADC' + i; });
  const STRONG = /RP20|RP2350|ESP32|ESP8266|STM32|ATMEGA|AT90USB|ATTINY|NRF5|CM3588|JETSON|KRIA|RK35|CM4\b|CM5\b|I\.?MX\d|MX[678]|OSD33|ICE40|ECP5|LFE5|XC7|XC6S|ATSAM|SAMD|CH32V|PIC24|PIC32|LPC\d|CY7C68|W65C|XIAO|PRO ?MICRO|RAK4|T-MICRO|WROOM|WROVER|MACHXO|LCMXO|MGM\d|MSP430|GD32|EFR32|CC13\d|CC26\d/;
  F.looksLikeProcessor = v => !!(N.chipdb && N.chipdb.match(String(v || ''))) || STRONG.test(up(v)) || PICO_RX.test(up(v)) || NANO_RX.test(up(v));
  const NOT_PROC = /^(74|SN74)|PCA\d|PCF\d|TCA\d|TXS\d|TXB\d|MT4\d|IS6\d|IS4\d|W98\d|AS4C|MX25|W25|IS25|LED[_ ]?MATRIX|ICM-|MPU-|BMI\d|DRV\d|TPD\d|USB\d{4}|FT\d{3,4}|PMOD|UEXT|SH1\.0|HEADER|LOCKED|CH34\d|CP21\d|TPS\d|ADS\d|MCP\d|TLC\d|INA\d|AK4\d|PCM\d|MAX\d|LTC\d|TMC\d|BQ\d|FUSB|STUSB|HUB|GL85|MUX|4051|4052|SN65|DS90|TFP|PTN|ADV\d/;
  function avrModel(c) {
    const t = up(c.value + ' ' + (c.mpn || ''));
    if (/32U4|16U4|AT90USB/.test(t)) return 'm32u4';
    if (/2560|1280|640\b/.test(t)) return 'm2560';
    return 'm328';
  }
  // chips we can run real firmware on: chip database id -> emulator
  const EMU = {
    rp2040: ['rp2040'], pico: ['rp2040'], 'xiao-rp2040': ['rp2040'], 'promicro-rp2040': ['rp2040'], 'waveshare-rp2040-zero': ['rp2040'],
    atmega328p: ['avr'], 'arduino-nano': ['avr'], 'arduino-uno': ['avr'], atmega32u4: ['avr'], promicro: ['avr'], atmega2560: ['avr'], 'arduino-mega': ['avr'], at90usb646: ['avr'], at90usb1286: ['avr'],
    stm32f405: ['arm', 'stm32f405'], stm32f407: ['arm', 'stm32f407'], stm32f411: ['arm', 'stm32f405'], stm32g431: ['arm', 'stm32g431'], stm32g474: ['arm', 'stm32g474'], stm32f072: ['arm', 'stm32f072'],
    stm32f103: ['arm', 'stm32f103'], stm32g030: ['arm', 'stm32g030'], stm32g031: ['arm', 'stm32g030'], stm32h743: ['arm', 'stm32h743'], stm32h745: ['arm', 'stm32h745'],
    nrf52840: ['arm', 'nrf52840'], nrf52832: ['arm', 'nrf52832'], rak4630: ['arm', 'nrf52840'], 'xiao-nrf52840': ['arm', 'nrf52840'], 'e73-nrf52840': ['arm', 'nrf52840'],
    samd21: ['arm', 'samd21g18'], samd11: ['arm', 'samd11'], samd51: ['arm', 'samd51p20'], same54: ['arm', 'same54p20'], saml22: ['arm', 'saml22j18'],
    rp2350a: ['arm', 'rp2350'], rp2350b: ['arm', 'rp2350b'], pico2: ['arm', 'rp2350'], 'waveshare-rp2350-zero': ['arm', 'rp2350'],
    efr32mg24: ['arm', 'efr32mg24'], 'nano-matter': ['arm', 'efr32mg24'], cc1352p: ['arm', 'cc1352p'],
    ch32v003: ['riscv', 'ch32v003'], ch32v203: ['riscv', 'ch32v203'], ch32v307: ['riscv', 'ch32v307'], gd32vf103: ['riscv', 'gd32vf103'],
    esp32c3: ['riscv', 'esp32c3'], 'esp32c3-mini-1': ['riscv', 'esp32c3'], 'xiao-esp32c3': ['riscv', 'esp32c3'],
    esp32c6: ['riscv', 'esp32c6'], 'esp32c6-mini-1': ['riscv', 'esp32c6'], 'esp32c6-wroom-1': ['riscv', 'esp32c6'],
  };
  F.EMU = EMU;
  const EMU_NAME = { rp2040: 'RP2040 emulated', avr: 'AVR emulated', arm: 'ARM Cortex-M emulated', riscv: 'RISC-V emulated' };
  F.emuName = p => EMU_NAME[p.family] || '';
  const chipText = c => [c.value, c.description, c.mpn].filter(Boolean).join(' ');
  // which components run code: microcontrollers, SoCs, FPGAs and the modules / sockets that carry one
  F.detect = function (circ) {
    const out = [];
    const db = N.chipdb;
    for (const c0 of circ.components) {
      if (c0.dnp || !(c0.pins || []).length) continue;
      let c = c0;
      const t = up(chipText(c));
      const chipId = db ? (db.match(c.value || '') || (c.type !== 'connector' ? db.match(chipText(c)) : null)) : null;
      const chip = chipId ? db.get(chipId) : null;
      if (!chip && c.pins.length < 8) continue;
      if (/RP2040/.test(t) && c.pins.every(p => !p.name) && c.pins.length >= 56) c = Object.assign({}, c, { pins: c.pins.map(p => Object.assign({}, p, { name: RP2040_PINS[+p.number] || '' })) });
      if (!chip) {
        const gpioish = c.pins.filter(p => /^(GPIO|GP|IO|P[A-L]?\d|D\d|A\d|PIO|P\d\.\d)/i.test(p.name || '')).length;
        const strong = STRONG.test(t) || PICO_RX.test(t) || NANO_RX.test(up(c.value));
        if (NOT_PROC.test(up(c.value)) && !strong) continue;
        if (/PSRAM|APS6404|W956|HYPERRAM|PINOUT/i.test(t)) continue;
        const isMcu = strong || (c.type === 'ic' && gpioish >= 12 && MCU_RX.test(t)) || (c.type === 'ic' && gpioish >= 16);
        if (!isMcu) continue;
      }
      const emu = chip && EMU[chip.id];
      const fam = emu ? emu[0] : family(c);
      // supply pin: the one on a 1.8-5.5 V rail, 3.3 V preferred
      let vdd = null, vnom = chip && chip.ioVoltage ? chip.ioVoltage : 3.3, best = 99;
      for (const p of c.pins) {
        const n = netOfPin(circ, c.ref, p.number);
        if (!n || n.kind === 'ground') continue;
        if (!(p.etype === 'power_in' || /^(IOVDD|VDDIO|VCC|VDD|3V3|\+3V3|3\.3V|VIN|5V|\+5V|DVDD|VDD3P3|VDD_?IO\w*|VCCIO\w*|VCCO\w*)/i.test(p.name || ''))) continue;
        const v = N.simtab.voltOf(n.name);
        if (v == null || v < 1.6 || v > 5.6) continue;
        const score = Math.abs(v - (chip && chip.ioVoltage || 3.3)) + (/IO/i.test(p.name) ? -0.5 : 0);
        if (score < best) { best = score; vdd = p.number; vnom = v; }
      }
      const io = [];
      for (const p of c.pins) {
        if (p.etype === 'power_in' || p.etype === 'power_out' || p.etype === 'no_connect') continue;
        const nm = String(p.name || '').replace(/^~\{|\}$/g, '');
        const n = netOfPin(circ, c.ref, p.number);
        if (!n || n.kind === 'ground' || n.kind === 'power') continue;
        let cp = null;
        if (chip) {
          try { cp = db.pin(chip.id, nm || shortNet(n.name), { number: p.number, part: chipText(c), count: c.pins.length }); } catch (e) { cp = null; }
          if (cp && cp.info && cp.info.dedicated) continue;
          if (!cp && POWER_NAME.test(nm)) continue;
        } else {
          if (POWER_NAME.test(nm)) continue;
          if (SPECIAL_NAME.test(nm) && fam !== 'script') continue;
        }
        io.push({ number: String(p.number), name: p.name && p.name !== String(p.number) ? p.name : shortNet(n.name) || String(p.number), net: n.name, chipPin: cp ? cp.name : null, cap: cp ? cp.info || {} : null });
        if (io.length >= 240) break;
      }
      if (io.length < 2) continue;
      const kind = chip ? (chip.arch === 'fpga' ? 'FPGA' : chip.arch === 'soc' ? 'SoC module' : c.type === 'connector' ? 'module socket' : chip.module ? 'module' : 'microcontroller')
        : /ICE40|LFE5|ECP5|XC7|XC6S|ARTIX|SPARTAN|KINTEX|MACHXO|LCMXO|GW1N/.test(t) ? 'FPGA' : /CM3588|JETSON|KRIA|RK35|IMX|OSD33|AM335|CM4\b|CM5\b/.test(t) ? 'SoC module' : c.type === 'connector' ? 'module socket' : 'microcontroller';
      const avr = fam === 'avr' ? (chip && /32u4|promicro|at90usb/.test(chip.id) ? 'm32u4' : chip && /2560|mega/.test(chip.id) ? 'm2560' : chip ? 'm328' : avrModel(c)) : null;
      out.push({ ref: c.ref, value: c.value, description: c.description || '', family: fam, emuChip: emu && emu[1] || null, chipId: chip ? chip.id : null, chip,
        avr, arduino: fam === 'avr' && (chip ? /arduino|promicro/.test(chip.id) : NANO_RX.test(up(c.value))), vdd, vnom, io, clock: fam === 'avr' ? crystalHz(circ, c) : crystalHz(circ, c, 0), kind });
    }
    out.sort((a, b) => (a.family === 'script') - (b.family === 'script') || b.io.length - a.io.length);
    return out;
  };
  function crystalHz(circ, c, dflt) {
    const x1 = (c.pins || []).find(p => /XTAL1|XTAL2|XIN|XOUT|OSC_?IN|OSC_?OUT|XC1|XC2|PH0|PF0/i.test(p.name || ''));
    const n = x1 && netOfPin(circ, c.ref, x1.number);
    if (n) for (const x of n.nodes) {
      const k = circ.components.find(q => q.ref === x.ref);
      const m = k && /(\d+(?:\.\d+)?)\s*M(?:HZ)?/i.exec(k.value || '');
      if (m && /^(Y|X|XTAL|Q|CR)/i.test(k.ref)) return parseFloat(m[1]) * 1e6;
    }
    return dflt === undefined ? 16e6 : dflt;
  }

  // what hangs off each processor pin: LEDs, enables, buttons (for the starter program and for KiLive)
  F.wiring = function (circ, proc) {
    const comp = r => circ.components.find(c => c.ref === r);
    const res = [];
    for (const io of proc.io) {
      const n = circ.nets.find(x => x.name === io.net);
      if (!n) continue;
      const on = n.nodes.filter(x => x.ref !== proc.ref).map(x => ({ x, c: comp(x.ref) })).filter(o => o.c);
      const info = { pin: io, parts: on.map(o => `${o.c.ref}.${o.x.pin}${o.c.value ? ' (' + o.c.value + ')' : ''}`).slice(0, 8) };
      const busy = /CLK|_[PN]$|[PN]$(?<=_[DT]X[PN])|AUDIO|USB|PCIE|SATA|HDMI|MIPI|DDR|SDA|SCL|MOSI|MISO|SCK|UART|TX|RX|I2S|SPI/i.test(shortNet(n.name));
      const scan = (list, via) => {
        for (const { x, c } of list) {
          if (c.type === 'led' && !busy) {
            const other = circ.nets.find(m => m.nodes.some(y => y.ref === c.ref && y.pin !== x.pin));
            if (other && (other.kind === 'ground' || other.kind === 'power' || other.nodes.length <= 2)) { info.led = { ref: c.ref, activeHigh: x.pin === 'A', via }; return true; }
          }
          const pn = (c.pins || []).find(p => String(p.number) === String(x.pin));
          const nm = up(pn && pn.name).replace(/^~\{(.*)\}$/, '~$1');
          if (c.type === 'ic' && /^(EN|ENABLE|CE|ON|RUN|PWR_?EN|~SHDN|EN\/UVLO|~EN|SHDN|EN#|~CE)$/.test(nm) && !via) info.enable = { ref: c.ref, value: c.value, activeHigh: !/^~|SHDN$|#$/.test(nm) || nm === '~SHDN' };
          if ((c.type === 'switch') && !via) info.button = { ref: c.ref };
        }
        return false;
      };
      if (!scan(on, null)) {
        for (const { x, c } of on) {
          if (c.type !== 'resistor') continue;
          const other = circ.nets.find(m => m !== n && m.nodes.some(y => y.ref === c.ref));
          if (!other) continue;
          const hop = other.nodes.filter(y => y.ref !== c.ref).map(y => ({ x: y, c: comp(y.ref) })).filter(o => o.c);
          if (scan(hop, c.ref)) break;
          void x;
        }
      }
      res.push(info);
    }
    return res;
  };

  // pin names people will type: GPIO25, GP25, 25, PA5, PB5, D13, A0, IO2, P0.13, a net name or a package pin number
  F.pinResolver = function (proc) {
    const map = new Map();
    const add = (k, num) => { k = String(k).toLowerCase(); if (k && !map.has(k)) map.set(k, num); };
    for (const io of proc.io) {
      const nm = String(io.name || '');
      add(nm, io.number);
      for (const part of nm.split(/[\/,\s]+/)) add(part.replace(/[()~{}]/g, ''), io.number);
      for (const part of nm.split(/[\/,\s]+|_(?=[A-Z]*\d)/)) add(part.replace(/[()~{}]/g, ''), io.number);
      const g = /(?:GPIO|GP|IO)(\d+)/i.exec(nm);
      if (g) { add('gpio' + +g[1], io.number); add('gp' + +g[1], io.number); add('io' + +g[1], io.number); if (proc.family !== 'avr') add(String(+g[1]), io.number); }
      const pp = /\bP([A-L])([0-7])\b/i.exec(nm);
      if (pp) add('p' + pp[1].toLowerCase() + pp[2], io.number);
      const nr = /\bP(\d)\.(\d+)/i.exec(nm);
      if (nr) { add(`p${nr[1]}.${+nr[2]}`, io.number); add(`p${nr[1]}.${String(+nr[2]).padStart(2, '0')}`, io.number); }
      for (const part of nm.split(/[\/\s]+/)) { const d = /^D(\d+)$/i.exec(part); if (d) { add('d' + +d[1], io.number); if (proc.arduino) add(String(+d[1]), io.number); } const a = /^A(\d)$/i.exec(part); if (a) add('a' + a[1], io.number); }
      add(shortNet(io.net), io.number);
      add(io.number, io.number);
    }
    // Arduino numbering on the ATmega328P: D0-D7 = PD0-7, D8-D13 = PB0-5, A0-A5 = D14-D19 = PC0-5
    if (proc.family === 'avr' && proc.avr === 'm328') {
      const ard = ['pd0', 'pd1', 'pd2', 'pd3', 'pd4', 'pd5', 'pd6', 'pd7', 'pb0', 'pb1', 'pb2', 'pb3', 'pb4', 'pb5', 'pc0', 'pc1', 'pc2', 'pc3', 'pc4', 'pc5'];
      ard.forEach((k, i) => { if (map.has(k)) { map.set(String(i), map.get(k)); if (i >= 14) map.set('a' + (i - 14), map.get(k)); map.set('d' + i, map.get(k)); } });
    }
    if (proc.family === 'rp2040') [26, 27, 28, 29].forEach((g, i) => { if (map.has('gpio' + g)) map.set('a' + i, map.get('gpio' + g)); });
    for (let i = 0; i < 16; i++) if (!map.has('a' + i)) { const k = ['adc' + i, 'adc1_in' + i, 'adc_in' + i, 'ain' + i, 'adc1_ch' + i].find(x => map.has(x)); if (k) map.set('a' + i, map.get(k)); }
    return function (p) {
      if (p == null) return null;
      if (typeof p === 'object' && p.number) return p.number;
      const k = String(p).trim().toLowerCase();
      return map.get(k) || map.get(k.replace(/^pin_?/, '')) || null;
    };
  };

  // ------------------------------------------------------------------ Arduino C++ → JavaScript with resumable delay()
  const TYPES = '(?:unsigned\\s+long\\s+long|unsigned\\s+long|unsigned\\s+int|unsigned\\s+char|unsigned\\s+short|long\\s+long|unsigned|signed|long|int|short|float|double|bool|boolean|byte|char|String|uint8_t|uint16_t|uint32_t|uint64_t|int8_t|int16_t|int32_t|int64_t|word|size_t|auto|void)';
  function protect(src) {
    const keep = [];
    const out = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, m => {
      if (m.startsWith('//') || m.startsWith('/*')) return m.replace(/[^\n]/g, ' ');
      keep.push(m);
      return '\u0001' + (keep.length - 1) + '\u0002';
    });
    return { out, restore: s => s.replace(/\u0001(\d+)\u0002/g, (_, i) => keep[+i]) };
  }
  // Arduino library classes the device models provide (Adafruit_NeoPixel, Adafruit_SSD1306, RTClib, ...)
  F.libClasses = () => { const L = N.devices && N.devices.libs; return L ? Object.keys(L).filter(k => typeof L[k] === 'function' && /^[A-Z]/.test(k)) : []; };
  const LED_TOKENS = /^(WS28\d\dB?|WS2811|WS2812B?|WS2813|NEOPIXEL|SK68\d\d\w*|APA10[26]|APA104|SK9822|DOTSTAR|TM180\d|UCS1903|GS1903|LPD8806|P9813|[RGBW]{3,4})$/;
  F.translate = function (src) {
    const P = protect(String(src || '').replace(/\r\n?/g, '\n'));
    let s = P.out;
    s = s.replace(/^[ \t]*#\s*(include|pragma|ifndef|ifdef|endif|if|else|undef)\b[^\n]*$/gm, '');
    s = s.replace(/^[ \t]*#\s*define\s+([A-Za-z_]\w*)\s+([^\n]+)$/gm, (m, a, b) => `const ${a} = ${b.trim()};`);
    s = s.replace(/^[ \t]*#\s*define\s+([A-Za-z_]\w*)\s*$/gm, '');
    s = s.replace(/\bF\s*\(\s*(\u0001\d+\u0002)\s*\)/g, '$1');
    // C++ that JavaScript spells differently
    s = s.replace(/->/g, '.').replace(/\b(?:static|reinterpret|const|dynamic)_cast\s*<[^<>]*>\s*/g, '');
    s = s.replace(/([(,]\s*)&\s*(?=[A-Za-z_])/g, '$1');
    // FastLED.addLeds<WS2812B, PIN, GRB>(leds, n) -> FastLED.addLeds('WS2812B', PIN, 'GRB', leds, n)
    s = s.replace(/\.addLeds\s*<([^<>]*)>\s*\(\s*(\)?)/g, (m, args, close) => '.addLeds(' + args.split(',').map(a => a.trim()).filter(Boolean).map(a => (LED_TOKENS.test(a) ? `'${a}'` : a)).join(', ') + (close ? ')' : ', '));
    // library objects: Adafruit_NeoPixel strip(8, PIN, NEO_GRB); Adafruit_BME280 bme; CRGB leds[N]; DateTime now = rtc.now();
    const cls = F.libClasses().concat(['TwoWire', 'SPIClass', 'HardwareSerial']);
    if (cls.length) {
      const C = '(' + cls.join('|') + ')';
      s = s.replace(new RegExp('\\b' + C + '\\s*\\*\\s*([A-Za-z_]\\w*)\\s*=\\s*new\\s+', 'g'), 'let $2 = new ');
      s = s.replace(new RegExp('\\b' + C + '\\s+([A-Za-z_]\\w*)\\s*\\[([^\\]]+)\\]\\s*;', 'g'), 'let $2 = Array.from({ length: $3 }, () => new $1());');
      s = s.replace(new RegExp('(^|[;{}(\\n])([ \\t]*)(?:static\\s+)?' + C + '\\s+([A-Za-z_]\\w*)\\s*\\(([^;{}]*)\\)\\s*;', 'g'), (m, pre, ind, c, name, args) => `${pre}${ind}let ${name} = new ${c}(${args});`);
      s = s.replace(new RegExp('(^|[;{}(\\n])([ \\t]*)(?:static\\s+)?' + C + '\\s+([A-Za-z_]\\w*)\\s*;', 'g'), (m, pre, ind, c, name) => `${pre}${ind}let ${name} = new ${c}();`);
      s = s.replace(new RegExp('(^|[;{}(\\n])([ \\t]*)(?:const\\s+)?' + C + '\\s*&?\\s+([A-Za-z_]\\w*)\\s*=', 'g'), (m, pre, ind, c, name) => `${pre}${ind}let ${name} =`);
    }
    s = s.replace(/\bsensors_event_t\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*;/g, (m, names) => 'let ' + names.split(',').map(x => x.trim() + ' = (typeof sensors_event_t === "function" ? sensors_event_t() : {})').join(', ') + ';');
    const RET = cls.length ? '(?:' + TYPES.slice(3, -1) + '|' + cls.join('|') + '|sensors_event_t)' : TYPES;
    // prototypes and function definitions
    s = s.replace(new RegExp('^[ \\t]*(?:static\\s+|inline\\s+|extern\\s+)*' + RET + '\\s*[*&]?\\s+([A-Za-z_]\\w*)\\s*\\(([^()]*)\\)\\s*;', 'gm'), '');
    s = s.replace(new RegExp('(^|[;}\\n])([ \\t]*)(?:static\\s+|inline\\s+|IRAM_ATTR\\s+|ICACHE_RAM_ATTR\\s+)*(?:const\\s+)?' + RET + '\\s*[*&]?\\s+(?:IRAM_ATTR\\s+)?([A-Za-z_]\\w*)\\s*\\(([^()]*)\\)\\s*\\{', 'g'), (m, pre, ind, name, params) => {
      const ps = params.trim() === 'void' ? '' : params.split(',').map(x => { const q = x.replace(/=.*$/, '').replace(/\[[^\]]*\]/g, '').trim(); const mm = /([A-Za-z_]\w*)\s*$/.exec(q); return mm ? mm[1] : ''; }).filter(Boolean).join(', ');
      return `${pre}${ind}function ${name}(${ps}) {`;
    });
    // C zero-initialises globals and statics: int count; -> let count = 0;
    s = s.replace(new RegExp('\\b(?:(?:static|volatile|register)\\s+)*(' + TYPES + ')\\s+([A-Za-z_]\\w*(?:\\s*,\\s*[A-Za-z_]\\w*)*)\\s*;', 'g'), (m, type, names) => {
      if (/void/.test(type)) return m;
      const init = /String/.test(type) ? '""' : /bool/.test(type) ? 'false' : '0';
      return 'let ' + names.split(',').map(x => x.trim() + ' = ' + init).join(', ') + ';';
    });
    // declarations
    s = s.replace(new RegExp('\\b((?:static|volatile|const|constexpr|register)\\s+)*' + TYPES + '(?:\\s*[*&]\\s*|\\s+)(?=[A-Za-z_])', 'g'), (m, mods) => (/const/.test(m) ? 'const ' : 'let '));
    s = s.replace(/\b(let|const)\s+([A-Za-z_]\w*)\s*\[[^\]]*\](?:\s*\[[^\]]*\])?\s*=\s*\{([^{}]*)\}/g, '$1 $2 = [$3]');
    s = s.replace(/\b(let|const)\s+([A-Za-z_]\w*)\s*\[([^\]]+)\]\s*;/g, '$1 $2 = new Array($3).fill(0);');
    // casts
    s = s.replace(new RegExp('\\(\\s*' + TYPES + '\\s*\\*?\\s*\\)\\s*(?=[\\w(])', 'g'), '');
    s = s.replace(/\bNULL\b/g, 'null').replace(/\bnullptr\b/g, 'null');
    s = s.replace(/(\d)(?:UL|ul|L|l|U|u)\b/g, '$1');
    return P.restore(s);
  };
  // make every user function a generator and every call that can wait a yield*, and guard loops
  const BLOCKING = new Set(['delay', 'delayMicroseconds', 'pulseIn', 'waitFor']);
  F.generatorize = function (js) {
    const P = protect(js);
    let s = P.out;
    const fns = new Set(BLOCKING);
    s = s.replace(/\bfunction\s+([A-Za-z_]\w*)\s*\(/g, (m, n) => { fns.add(n); return `function* ${n}(`; });
    // calls
    let out = '', i = 0;
    const rx = /\b([A-Za-z_]\w*)\s*\(/g;
    let m;
    const closes = [];   // positions where a ')' must be added
    while ((m = rx.exec(s))) {
      const name = m[1];
      const before = s.slice(Math.max(0, m.index - 12), m.index);
      if (!fns.has(name) || /function\*?\s*$/.test(before) || /[.\w]\s*$/.test(before.slice(-1))) continue;
      // find the matching ')'
      let depth = 0, j = m.index + m[0].length - 1;
      for (; j < s.length; j++) { const ch = s[j]; if (ch === '(') depth++; else if (ch === ')') { depth--; if (!depth) break; } }
      closes.push([m.index, j]);
    }
    const ins = [];
    for (const [a, b] of closes) { ins.push([a, '(yield* ']); ins.push([b + 1, ')']); }
    ins.sort((x, y) => x[0] - y[0] || (x[1] === ')' ? -1 : 1));
    for (const [pos, txt] of ins) { out += s.slice(i, pos) + txt; i = pos; }
    out += s.slice(i);
    // loop guards: a loop that never waits must not freeze the page
    out = out.replace(/\b(for|while)\s*\(/g, (mm) => mm);
    let res = '', k = 0;
    const lrx = /\b(for|while)\s*\(|\bdo\s*\{/g;
    let q;
    const marks = [];
    while ((q = lrx.exec(out))) {
      if (q[0].startsWith('do')) { marks.push(q.index + q[0].length); continue; }
      let depth = 0, j = q.index + q[0].length - 1;
      for (; j < out.length; j++) { const ch = out[j]; if (ch === '(') depth++; else if (ch === ')') { depth--; if (!depth) break; } }
      let t = j + 1;
      while (t < out.length && /\s/.test(out[t])) t++;
      if (out[t] === '{') marks.push(t + 1);
    }
    marks.sort((a, b) => a - b);
    for (const pos of marks) { res += out.slice(k, pos) + '__g();'; k = pos; }
    res += out.slice(k);
    return P.restore(res);
  };

  // ------------------------------------------------------------------ runtimes
  const MODES = { z: 'input', hi: 'high', lo: 'low', pu: 'pull-up', pd: 'pull-down' };
  // serial output; with a clock (now) every write is also kept with its time, for the scope's serial decoder ([notes] are marked sys)
  const SYS_NOTE = /^\n?\[[^\]\n]*\][ \n]?$/;
  class Console {
    constructor() { this.text = ''; this.inq = []; this.listeners = new Set(); this.log = []; this.baud = 115200; this.now = null; }
    write(s) {
      this.text += s; if (this.text.length > 24000) this.text = this.text.slice(-18000);
      const sys = SYS_NOTE.test(s);
      if (this.now) {
        const t = this.now(), lg = this.log, last = lg[lg.length - 1];
        if (last && last.t === t && last.sys === sys) last.s += s; else { lg.push({ t, s, sys }); if (lg.length > 800) lg.splice(0, lg.length - 600); }
      }
      // what the program sends goes down the wire to whatever listens (another processor on the board)
      if (this.onOut && !sys && !/^› /.test(s)) this.onOut(s);
      for (const f of this.listeners) f();
    }
    clear() { this.text = ''; this.log = []; for (const f of this.listeners) f(); }
  }
  F.Console = Console;

  class Proc {
    constructor(mgr, info) { this.mgr = mgr; this.info = info; this.ref = info.ref; this.console = new Console(); this.console.now = () => { const e = this.engine; return e ? e.t : 0; }; this.console.onOut = s => { if (mgr.forward) mgr.forward(this, s); }; this.drive = new Map(); this.state = 'idle'; this.error = ''; }
    get engine() { return this.mgr.engine(); }
    setPin(num, mode) {
      const old = this.drive.get(num) || 'z';
      if (old === mode) return;
      const e = this.engine;
      // pins changed since the circuit last solved: reads in the same instant use the new drive (a pull-up acts in nanoseconds)
      if (!this.fresh) this.fresh = new Map();
      if (!this.fresh.has(num)) this.fresh.set(num, { old, flt: old === 'z' && (mode === 'pu' || mode === 'pd') && !!e && this.isFloating(num) });
      this.drive.set(num, mode);
      if (e) e.setDrive(this.ref, num, mode);
    }
    isFloating(num) { const e = this.engine, io = this.info.io.find(x => x.number === num), nd = io && e && e.nodeOf(io.net), i = nd != null ? e.nodeIndex(nd) : -1; return i >= 0 && e.floatingNodes()[i] === 1; }
    freshLevel(num) {
      const f = this.fresh && this.fresh.get(num), m = this.drive.get(num);
      if (!f) return null;
      if (m === 'hi') return 1; if (m === 'lo') return 0;
      if ((m === 'pu' || m === 'pd') && (f.old === 'hi' || f.old === 'lo' || f.flt)) return m === 'pu' ? 1 : 0;
      return null;
    }
    v(num) { const e = this.engine; return e ? e.pinV(this.ref, num) : 0; }
    vdd() { const e = this.engine; if (!e || !this.info.io.length) return this.info.vnom; return e.supplyV(this.ref, this.info.io[0].number); }
    powered() { return this.info.vdd == null || this.vdd() > 0.7 * this.info.vnom; }
    reapply() { const e = this.engine; if (!e) return; for (const [num, mode] of this.drive) e.setDrive(this.ref, num, mode); }
    releasePins() { const e = this.engine; for (const num of this.drive.keys()) if (e) e.setDrive(this.ref, num, 'z'); this.drive.clear(); }
    stop() { this.releasePins(); this.state = 'stopped'; this.mgr.changed(this); }
    pinsSummary() {
      return [...this.drive.entries()].filter(([, m]) => m !== 'z').map(([n, m]) => { const io = this.info.io.find(x => x.number === n); const pw = this.pwm && this.pwm.get(n); return { pin: io ? F.shortPin(io) : n, num: n, net: io ? shortNet(io.net) : '', mode: pw ? 'PWM ' + Math.round(pw.duty * 100) + '%' : MODES[m] || m }; });
    }
    // PWM outputs: sigma-delta at the simulation step so the average (and the LED brightness) follows the duty cycle
    pwmStep() { if (!this.pwm) return; for (const [num, p] of this.pwm) { p.acc += p.duty; if (p.acc >= 1) { p.acc -= 1; this.setPin(num, 'hi'); } else this.setPin(num, 'lo'); } }
    // what a pin does right now, for probes: {mode, duty?, freq?}
    pinInfo(num) { const pw = this.pwm && this.pwm.get(num); if (pw) return { mode: 'pwm', duty: pw.duty, freq: pw.freq || 0 }; const m = this.drive.get(num); return m ? { mode: m } : null; }
  }

  // ------------------------------------------------------------------ the parts around a processor, for programs
  // device instances on the processor's I2C / SPI buses (N.devices models), LED chains, screens; env ties them to the live circuit
  // the supply pin of a part; one tied to ground is skipped (an RTC that runs from VBAT with VCC grounded still answers)
  const devVddPin = (c, ix) => {
    const ps = (c.pins || []).filter(p => /^(VDD|VCC|V\+|VDDIO|VDD_?IO|VL|VS|VIN|3V3|VDDA|AVDD|DVDD|VBAT|VBACKUP)$/i.test(String(p.name || '').replace(/^~\{|\}$/g, '')));
    const onGnd = p => { const n = ix && ix.at(c.ref, p.number); return !!n && ix.isGnd(n); };
    return ps.find(p => !/BAT|BACKUP/i.test(p.name) && !onGnd(p)) || ps.find(p => !onGnd(p)) || ps[0];
  };
  function buildHardware(self) {
    const info = self.info, circ = self.mgr.circuit(), D = N.devices, L = self.mgr.live;
    const hw = { a: null, i2c: [], spi: [], sel: { i2c: [0, 1], spi: [0, 1] }, devs: [], screens: [], notes: new Set() };
    try { hw.a = N.analysis.forProc(circ, info); } catch (e) { hw.a = null; }
    if (!D || !hw.a) return hw;
    const ix = N.analysis.index(circ);
    const eng = () => self.engine;
    const netV = name => { const e = eng(); if (!e || !name) return 0; const nd = e.nodeOf(name); return nd ? e.V(nd) : 0; };
    let seed = 0x5eed;
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const boardKey = (L && L.B && L.B.data && L.B.data.key) || 'board';
    const netPin = new Map(); for (const io of info.io || []) if (io.net && !netPin.has(io.net)) netPin.set(io.net, io.number);
    const made = new Map();
    const create = (d, bus) => {
      if (made.has(d.ref + ':' + (d.address || ''))) return made.get(d.ref + ':' + (d.address || ''));
      const comp = ix.comp.get(d.ref);
      const rp = comp ? D.rolePins(d.spec, comp) || {} : {};
      const vp = comp && devVddPin(comp, ix);
      const vddNet = vp ? (ix.at(d.ref, vp.number) || {}).name : null;
      const roleNet = role => { const pins = rp[role]; if (!pins || !pins.length) return null; const n = ix.at(d.ref, pins[0]); return n ? n.name : null; };
      const env = {
        now: () => (eng() ? eng().t : 0), world: self.mgr.world(), rand, address: d.address, levels: d.levels, ref: d.ref, storeKey: boardKey + ':' + d.ref,
        supplyV: () => (vddNet ? netV(vddNet) : info.vnom),
        pinLevel: role => {
          const n = roleNet(role); if (!n) return null;
          // a net the program drives push-pull has its level at once (library code toggles reset / D-C faster than the circuit solves)
          const pn = netPin.get(n), m = pn != null ? self.drive.get(pn) : null;
          if (m === 'hi' || m === 'lo') return m === 'hi' ? 1 : 0;
          const f = pn != null && self.freshLevel ? self.freshLevel(pn) : null; if (f != null) return f;
          return netV(n) > 0.5 * (vddNet ? netV(vddNet) : info.vnom) ? 1 : 0;
        },
        volts: role => netV(roleNet(role)),
        setPin: (role, mode) => { const e = eng(); for (const pn of rp[role] || []) if (e) e.setDrive(d.ref, String(pn), mode); },
        setVolts() {}, setFreq() {},
      };
      let inst = null;
      try { inst = d.spec.create(env, d.address); } catch (e) { hw.notes.add(`${d.ref} (${d.spec.name}) could not be modelled: ${e.message}`); }
      if (!inst) return null;
      // an unpowered chip does not answer
      if (inst.i2cStart) { const st = inst.i2cStart.bind(inst); inst.i2cStart = (r, ad) => (vddNet && netV(vddNet) < 1.4 ? false : st(r, ad)); }
      inst.ref = d.ref; inst.bus = bus;
      made.set(d.ref + ':' + (d.address || ''), inst);
      hw.devs.push(inst);
      if (inst.width && inst.height && inst.rgba) hw.screens.push({ ref: d.ref, name: d.spec.name, dev: inst });
      return inst;
    };
    const now = () => (eng() ? eng().t : 0);
    for (const b of hw.a.i2c) {
      const insts = [];
      for (const d of b.devices) { const x = create(d, 'i2c'); if (x) insts.push([d, x]); }
      for (const [d, x] of insts) if (d.via) { const mux = insts.find(([m]) => m.ref === d.via.ref); if (mux) x.behind = { mux: mux[1], channel: d.via.channel }; }
      hw.i2c.push({ sda: b.sda, scl: b.scl, sdaIo: b.sdaIo, sclIo: b.sclIo, wire: D.makeWire(insts.map(y => y[1]), { now, logSize: 256 }), devices: b.devices });
    }
    for (const b of hw.a.spi) {
      const spi = D.makeSPI({ now, logSize: 256 });
      for (const d of b.devices) {
        const x = create(d, 'spi');
        if (!x) continue;
        const cs = d.csIo ? d.csIo.number : null;
        spi.attach(x, cs, { dc: d.dcIo ? d.dcIo.number : undefined, latch: d.latchIo ? d.latchIo.number : undefined, always: cs == null });
      }
      // the SPI peripheral drives SCK and MOSI once the program first talks on the bus (idle low, mode 0)
      if (self.setPin) {
        const own = () => { if (spi.pinsOut) return; spi.pinsOut = true; for (const n of [b.sck, b.mosi]) if (n != null && !self.drive.has(n)) self.setPin(n, 'lo'); };
        const xb = spi.xferByte.bind(spi), wb = spi.writeBytes.bind(spi);
        spi.xferByte = v => { own(); return xb(v); };
        spi.writeBytes = (buf, n) => { own(); return wb(buf, n); };
      }
      hw.spi.push({ sck: b.sck, mosi: b.mosi, miso: b.miso, spi, devices: b.devices });
    }
    // the chip's usual Arduino pins pick Wire / SPI
    const ard = info.chip && info.chip.arduino;
    const idxOf = (list, key, chipPin) => { const i = list.findIndex(b => b[key] && b[key].chipPin === chipPin); return i; };
    if (ard && ard.wire && hw.i2c.length > 1) { const i = idxOf(hw.i2c, 'sdaIo', ard.wire.sda); if (i > 0) hw.sel.i2c = [i, i === 0 ? 1 : 0]; }
    const empty = { i2c: D.makeWire([], { now }), spi: D.makeSPI({ now }) };
    hw.wire = k => { const b = hw.i2c[hw.sel.i2c[k]]; return b ? b.wire : empty.i2c; };
    hw.spiObj = k => { const b = hw.spi[hw.sel.spi[k]]; return b ? b.spi : empty.spi; };
    // Wire.begin(sda, scl): the bus on those pins (or nothing, as on real hardware)
    hw.pickI2C = (k, sda, scl) => { const i = hw.i2c.findIndex(b => b.sda === sda && b.scl === scl); hw.sel.i2c[k] = i >= 0 ? i : -1; };
    hw.pickSPI = (k, sck, mosi) => { const i = hw.spi.findIndex(b => b.sck === sck && b.mosi === mosi); hw.sel.spi[k] = i >= 0 ? i : -1; };
    return hw;
  }
  F.buildHardware = buildHardware;
  // UART wiring between processors: [{from, to, tx (io of from), rx (io of to)}]
  F.uartLinks = function (circ, procs) {
    if (!N.analysis || procs.length < 2) return [];
    const ix = N.analysis.index(circ);
    const TX = /(^|[^A-Z])(U\d?|UART\d?_?)?TXD?\d?($|[^A-Z])|UART\d?_?TX|\bTXD\d?\b|_TX\b|^TX/;
    const RX = /(^|[^A-Z])(U\d?|UART\d?_?)?RXD?\d?($|[^A-Z])|UART\d?_?RX|\bRXD\d?\b|_RX\b|^RX/;
    const txOf = p => {
      const out = [];
      const ard = p.chip && p.chip.arduino;
      for (const k of ['serial', 'serial1', 'serial2']) { const u = ard && ard[k]; if (u && u.tx) { const io = p.io.find(x => x.chipPin === u.tx); if (io && !out.includes(io)) out.push(io); } }
      for (const io of p.io) if (!out.includes(io) && (TX.test(String(io.name).toUpperCase()) || (TX.test(String(io.net).split('/').pop().toUpperCase()) && !RX.test(String(io.name).toUpperCase())))) out.push(io);
      return out;
    };
    const links = [];
    for (const a of procs) {
      for (const tx of txOf(a)) {
        const n0 = ix.net.get(tx.net);
        if (!n0 || ix.isGnd(n0) || ix.isPwr(n0)) continue;
        const reach = ix.hop(n0, 1000);
        for (const b of procs) {
          if (b === a) continue;
          const btx = new Set(txOf(b));
          for (const io of b.io) {
            if (btx.has(io) && !RX.test(String(io.name).toUpperCase())) continue;
            const n = ix.net.get(io.net);
            if (n && reach.has(n)) { if (!links.some(k => k.from === a.ref && k.to === b.ref)) links.push({ from: a.ref, to: b.ref, tx, rx: io }); }
          }
        }
      }
    }
    return links;
  };
  // device pins that drive the circuit (IO expander outputs, 74HC595 outputs, interrupt lines)
  F.deviceDrivers = function (circ) {
    const D = N.devices, out = [];
    if (!D) return out;
    for (const c of circ.components) {
      if (c.dnp || !(c.pins || []).length) continue;
      let spec = null;
      try { spec = D.match(c); } catch (e) { spec = null; }
      if (!spec || !/^(pca95|tca6|mcp230|pcf857|sx1509|74hc595|pca9557|pca9554)/.test(spec.id)) continue;
      const rp = D.rolePins(spec, c) || {};
      const vp = devVddPin(c);
      for (const [role, pins] of Object.entries(rp)) if (/^(p\d+|q[a-h]|int|inta|intb)$/.test(role)) for (const pn of pins) out.push({ ref: c.ref, pin: String(pn), vdd: vp ? vp.number : null, vnom: 3.3 });
    }
    return out;
  };

  // Arduino-style program on any processor
  // library shims reach the running program through one hal that points at whichever program is executing
  let CUR = null;
  const halCur = () => { if (!CUR) throw new Error('library used outside a program'); return CUR; };
  const HAL = {
    wire: i => halCur().hw.wire(i || 0), spi: i => halCur().hw.spiObj(i || 0),
    digitalWrite: (p, v) => halCur().apiObj.digitalWrite(p, v), pinMode: (p, m) => halCur().apiObj.pinMode(p, m), digitalRead: p => halCur().apiObj.digitalRead(p),
    now: () => { const c = CUR; return c ? c.now - c.t0 : 0; }, delayHint() {},
    neopixel: (pin, n, order) => halCur().ledSink(pin, n, order, 'ws2812'),
    apa102: (d, c, n) => halCur().ledSink(d, n, 'BGR', 'apa102'),
    servo: (pin, us) => halCur().servoOut(pin, us), pwm: (pin, duty, hz) => halCur().pwmOut(pin, duty, hz),
    tft: () => halCur().tftSetup(),
  };
  let halBound = false;
  const bindHal = () => { if (!halBound && N.devices && N.devices.bindHal) { N.devices.bindHal(HAL); halBound = true; } };
  class ScriptProc extends Proc {
    constructor(mgr, info, src) {
      super(mgr, info);
      this.kind = 'script';
      this.src = src;
      this.resolve = F.pinResolver(info);
      this.pinModes = new Map();
      this.pwm = new Map();
      this.isr = [];
      this.compile();
    }
    compile() {
      try {
        const js = F.generatorize(F.translate(this.src));
        this.js = js;
        this.factory = new Function('__api', 'with (__api) {\n' + js + '\n;return { setup: typeof setup === "function" ? setup : null, loop: typeof loop === "function" ? loop : null };\n}');
        this.error = '';
      } catch (e) {
        this.factory = null;
        this.error = 'The program does not compile: ' + (e.message || e);
      }
    }
    start(t) {
      this.releasePins();
      this.pinModes.clear(); this.pwm.clear(); this.isr = []; this.warned = new Set();
      this.t0 = t; this.now = t; this.state = 'running'; this.error = this.error && !this.factory ? this.error : '';
      if (!this.factory) { this.state = 'error'; this.mgr.changed(this); return; }
      bindHal();
      this.hw = buildHardware(this);
      for (const n of this.hw.notes) this.console.write('[' + n + ']\n');
      this.mgr.setScreens(this.ref, this.hw.screens);
      if (N.devices && N.devices.clock) N.devices.clock.skew = 0;
      const prev = CUR;
      CUR = this;
      try {
        const fns = this.factory(this.api());
        const self = this;
        this.gen = (function* () { if (fns.setup) yield* fns.setup(); if (!fns.loop) { self.console.write('\n[program finished: no loop()]\n'); return; } for (;;) { yield* fns.loop(); yield 0; } })();
      } catch (e) { this.fail(e); }
      CUR = prev;
      this.mgr.changed(this);
    }
    stop() { super.stop(); this.mgr.setScreens(this.ref, []); this.mgr.clearPixels(this.ref); }
    fail(e) {
      this.state = 'error';
      this.error = String(e && e.message || e).replace(/^.*?Error: /, '');
      const m = /<anonymous>:(\d+):(\d+)/.exec(String(e && e.stack || ''));
      this.errorLine = m ? +m[1] - 2 : null;
      this.console.write('\n[stopped: ' + this.error + ']\n');
      this.mgr.changed(this);
    }
    warnOnce(key, text) { if (this.warned.has(key)) return; this.warned.add(key); this.console.write('\n[' + text + ']\n'); }
    step(t, dt) {
      if (this.state !== 'running') return;
      if (!this.powered()) {
        if (!this.brownout) { this.brownout = true; this.releasePins(); if (!this.ran) this.console.write(`[waiting for power: the ${this.info.value || 'chip'} supply is at ${this.vdd().toFixed(2)} V]\n`); }
        return;
      }
      if (this.brownout) { this.brownout = false; this.console.write(this.ran ? '\n[power is back: restarting]\n' : '[power is up: starting]\n'); this.start(t); return; }
      this.ran = true;
      if (this.fresh) this.fresh.clear();
      this.pwmStep();
      const prev = CUR;
      CUR = this;
      // pin-change interrupts
      for (const h of this.isr) { const v = this.v(h.num) > 0.5 * this.vdd() ? 1 : 0; if (v !== h.last) { const fire = h.mode === 'CHANGE' || (h.mode === 'RISING' && v) || (h.mode === 'FALLING' && !v); h.last = v; if (fire) this.runIsr(h.fn); } }
      let budget = 4000;
      this.guard = 0;
      try {
        while (this.state === 'running' && this.now <= t && budget-- > 0) {
          const r = this.gen.next();
          if (r.done) { this.state = 'finished'; this.mgr.changed(this); break; }
          this.now += r.value > 0 ? r.value : 2e-6;
          this.guard = 0;
        }
      } catch (e) { this.fail(e); }
      CUR = prev;
      void dt;
    }
    runIsr(fn) { try { const g = fn(); if (g && g.next) { let n = 0; while (!g.next().done && n++ < 1000) { /* ISRs do not wait */ } } } catch (e) { this.fail(e); } }
    // addressable LEDs: the library shows bytes, the chain on that pin lights up
    ledSink(pin, n, order, type) {
      const num = this.resolve(pin);
      const ch = this.hw && this.hw.a && this.hw.a.chains.find(c => c.pin === num || (c.clockIo && type === 'apa102' && c.io.number === num));
      if (!ch) this.warnOnce('led' + pin, `no addressable LEDs are wired to ${pin} on this board: the colours go nowhere`);
      const mgr = this.mgr, ref = this.ref;
      return { show: bytes => { if (!ch) return; const cols = type === 'apa102' ? N.devices.decodeAPA102(bytes) : N.devices.decodeWS2812(bytes, order || 'GRB'); mgr.setPixels(ref, ch.leds, cols); } };
    }
    pwmOut(pin, duty, hz) { const n = this.resolve(pin); if (n == null) return; this.pinModes.set(n, 1); this.pwm.set(n, { duty: Math.max(0, Math.min(1, duty)), acc: 0, freq: hz || 50 }); }
    servoOut(pin, us) { const n = this.resolve(pin); if (n == null) return; this.pinModes.set(n, 1); this.pwm.set(n, { duty: Math.max(0, Math.min(1, us / 20000)), acc: 0, freq: 50, servo: us }); }
    tftSetup() {
      const sc = this.hw && this.hw.a && this.hw.a.spi.flatMap(b => b.devices).find(d => d.spec.display || /st77|ili9|gc9a01/.test(d.spec.id));
      if (!sc) return null;
      const nm = io => (io ? io.chipPin || F.shortPin(io) : -1);
      return { driver: sc.spec.id, width: sc.spec.display ? sc.spec.display.w : 240, height: sc.spec.display ? sc.spec.display.h : 240, cs: nm(sc.csIo), dc: nm(sc.dcIo), rst: nm(sc.rstIo), freq: 40e6 };
    }
    api() {
      const self = this, info = this.info, chip = info.chip || null;
      const pinOf = p => { const n = self.resolve(p); if (n == null) throw new Error(`there is no pin "${p}" on ${info.ref} (${info.value})`); return n; };
      const ioOf = n => info.io.find(x => x.number === n);
      const nameOf = n => { const io = ioOf(n); return io ? F.shortPin(io) : String(n); };
      const out = t => self.console.write(t);
      const fmt = (v, base) => (typeof v === 'number' && base === 16 ? v.toString(16).toUpperCase() : typeof v === 'number' && base === 2 ? v.toString(2) : typeof v === 'number' && base === 8 ? v.toString(8) : typeof v === 'number' && Number.isFinite(base) && base >= 0 && base <= 9 && !Number.isInteger(v) ? v.toFixed(base) : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v && typeof v === 'object' && typeof v.toString === 'function' && v.toString !== Object.prototype.toString ? v.toString() : String(v));
      let rnd = 1;
      // UART pins idle high once the port is open
      // with the chip's native USB wired to a connector, Serial is the USB CDC port (as on the Arduino cores) and leaves the UART pins alone
      const serialPins = key => { if (key === 'serial' && self.hw && self.hw.a && self.hw.a.usb) return; const u = chip && chip.arduino && chip.arduino[key]; if (!u || !u.tx) return; const io = info.io.find(x => x.chipPin === u.tx); if (io && !self.drive.has(io.number)) self.setPin(io.number, 'hi'); };
      const mkSerial = key => ({
        begin(baud) { if (+baud > 0) self.console.baud = +baud; serialPins(key); }, end() {}, setTimeout() {}, setRxBufferSize() {}, setTxBufferSize() {},
        print(v, b) { out(fmt(v, b)); return String(v).length; }, println(v, b) { out((v === undefined ? '' : fmt(v, b)) + '\n'); },
        printf(f, ...a) { let i = 0; out(String(f).replace(/%(-?\d*)(\.\d+)?(l{0,2})([dilufsxXc%])/g, (m, w, p, l, c) => { if (c === '%') return '%'; const x = a[i++]; let r; if (c === 'x' || c === 'X') r = (x >>> 0).toString(16)[c === 'X' ? 'toUpperCase' : 'toLowerCase'](); else if (c === 'f') r = (+x).toFixed(p ? +p.slice(1) : 6); else if (c === 'c') r = String.fromCharCode(x); else r = String(c === 'd' || c === 'i' || c === 'u' ? Math.trunc(x) : x); return w ? (w.startsWith('-') ? r.padEnd(+w.slice(1)) : r.padStart(+w, w.startsWith('0') ? '0' : ' ')) : r; })); },
        write(v) { out(typeof v === 'number' ? String.fromCharCode(v) : String(v)); return 1; },
        available() { return self.console.inq.length; }, read() { return self.console.inq.length ? self.console.inq.shift() : -1; }, peek() { return self.console.inq.length ? self.console.inq[0] : -1; },
        readString() { const s = String.fromCharCode(...self.console.inq); self.console.inq.length = 0; return s; },
        readStringUntil(c) { const code = typeof c === 'string' ? c.charCodeAt(0) : c; const i = self.console.inq.indexOf(code); const part = i < 0 ? self.console.inq.splice(0) : self.console.inq.splice(0, i + 1).slice(0, -1); return String.fromCharCode(...part); },
        parseInt() { const s = this.readStringUntil(10); return parseInt(s, 10) || 0; }, parseFloat() { const s = this.readStringUntil(10); return parseFloat(s) || 0; }, flush() {},
        availableForWrite() { return 64; }, toString() { return 'Serial'; },
      });
      const serial = mkSerial('serial');
      const adc = chip && chip.adc;
      const pwmCfg = chip && chip.pwm;
      const led = (F.wiring(self.mgr.circuit(), info).find(w => w.led) || {}).pin;
      const hw = self.hw;
      const spiCs = (n, v) => { if (!hw) return; for (const b of hw.spi) b.spi.onCs && b.spi.onCs(n, v); for (const d of hw.devs) if (d.pinChanged && d.bus === 'gpio') d.pinChanged(n, v); };
      const floatingInput = n => { const e = self.engine; if (!e) return false; const io = ioOf(n); const nd = io && e.nodeOf(io.net); const i = nd != null ? e.nodeIndex(nd) : -1; return i >= 0 && e.floatingNodes()[i] === 1; };
      const libs = (N.devices && N.devices.libs) || {};
      const api = Object.assign({}, libs, {
        HIGH: 1, LOW: 0, INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2, INPUT_PULLDOWN: 3, OUTPUT_OPEN_DRAIN: 4, CHANGE: 'CHANGE', RISING: 'RISING', FALLING: 'FALLING', true: true, false: false,
        LED_BUILTIN: led ? led.name : undefined, HEX: 16, BIN: 2, OCT: 8, DEC: 10, PI: Math.PI, HALF_PI: Math.PI / 2, TWO_PI: Math.PI * 2, DEG_TO_RAD: Math.PI / 180, RAD_TO_DEG: 180 / Math.PI,
        A0: 'A0', A1: 'A1', A2: 'A2', A3: 'A3', A4: 'A4', A5: 'A5', A6: 'A6', A7: 'A7',
        Serial: serial, Serial1: mkSerial('serial1'), Serial2: mkSerial('serial2'), SerialUSB: serial, USBSerial: serial, console: { log: (...a) => out(a.join(' ') + '\n') },
        Math, String, Number, Array, Object, JSON, parseInt, parseFloat, isNaN, Uint8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Boolean,
        __g() { if (++self.guard > 200000) throw new Error('a loop ran 200000 times without delay() - add a delay() inside it'); },
        pinMode(p, m) {
          const n = pinOf(p);
          const io = ioOf(n);
          self.pinModes.set(n, m); self.pwm.delete(n);
          if ((m === 1 || m === 4) && io && io.cap && io.cap.inputOnly) { self.warnOnce('io' + n, `${nameOf(n)} is input only on the ${chip ? chip.name : info.value}: it cannot drive`); self.setPin(n, 'z'); return; }
          if (m === 1) self.setPin(n, self.drive.get(n) === 'hi' ? 'hi' : 'lo');
          else if (m === 4) self.setPin(n, 'z');
          else self.setPin(n, m === 2 ? 'pu' : m === 3 ? 'pd' : 'z');
        },
        digitalWrite(p, v) {
          const n = pinOf(p);
          self.pwm.delete(n);
          const m = self.pinModes.get(n);
          const io = ioOf(n);
          if (io && io.cap && io.cap.inputOnly) return;
          if (m === 1) self.setPin(n, v ? 'hi' : 'lo');
          else if (m === 4) self.setPin(n, v ? 'z' : 'lo');
          else self.setPin(n, v ? 'pu' : 'z');
          spiCs(n, v ? 1 : 0);
        },
        digitalRead(p) {
          const n = pinOf(p);
          const fl = self.freshLevel(n);
          if (fl != null) return fl;
          if (!self.pinModes.has(n) || self.pinModes.get(n) === 0) { if (floatingInput(n)) { self.warnOnce('fl' + n, `${nameOf(n)} is floating (nothing drives it): on real hardware it reads random values - use INPUT_PULLUP or add a resistor`); return 0; } }
          return self.v(n) > 0.5 * self.vdd() ? 1 : 0;
        },
        analogRead(p) {
          const n = pinOf(p);
          const io = ioOf(n);
          if (chip && adc && io && io.cap && !io.cap.adc) { self.warnOnce('adc' + n, `${nameOf(n)} has no ADC channel on the ${chip.name}: analogRead returns 0`); return 0; }
          const bits = self.adcBits || (adc && (adc.arduinoBits || adc.bits)) || (info.family === 'rp2040' ? 12 : 10);
          const vref = self.vref || (adc && adc.vref) || info.vnom;
          return Math.max(0, Math.min((1 << bits) - 1, Math.round(self.v(n) / vref * ((1 << bits) - 1))));
        },
        analogReadResolution(b) { self.adcBits = b; }, analogReference(r) { if (typeof r === 'number' && r > 0.5 && r < 6) self.vref = r; }, analogWriteResolution(b) { self.pwmBits = b; }, analogWriteFrequency(f) { self.pwmFreq = f; }, analogWriteFreq(f) { self.pwmFreq = f; }, analogWriteRange(r) { self.pwmMax = r; },
        analogReadMilliVolts(p) { return Math.round(self.v(pinOf(p)) * 1000); },
        analogWrite(p, v) {
          const n = pinOf(p);
          const io = ioOf(n);
          const max = self.pwmMax || ((1 << (self.pwmBits || (pwmCfg && pwmCfg.arduinoBits) || 8)) - 1);
          const d = Math.max(0, Math.min(1, v / max));
          self.pinModes.set(n, 1);
          if (chip && pwmCfg && !pwmCfg.anyPin && io && io.cap && !io.cap.pwm && !(io.cap.tim && io.cap.tim.length) && !io.cap.dac) {
            self.warnOnce('pwm' + n, `${nameOf(n)} has no PWM on the ${chip.name}: analogWrite sets it ${d >= 0.5 ? 'HIGH' : 'LOW'}`);
            self.pwm.delete(n); self.setPin(n, d >= 0.5 ? 'hi' : 'lo'); return;
          }
          if (d <= 0) { self.pwm.delete(n); self.setPin(n, 'lo'); } else if (d >= 1) { self.pwm.delete(n); self.setPin(n, 'hi'); } else self.pwm.set(n, { duty: d, acc: 0, freq: self.pwmFreq || (pwmCfg && pwmCfg.freqHz) || 1000 });
        },
        ledcWrite(p, v) { api.analogWrite(p, v); }, ledcAttach(p, f, b) { if (f) self.pwmFreq = f; if (b) self.pwmBits = b; return true; }, ledcSetup(ch, f, b) { if (f) self.pwmFreq = f; if (b) self.pwmBits = b; return f; }, ledcAttachPin() {}, ledcWriteTone(p, f) { api.tone(p, f); },
        tone(p, f) { const n = pinOf(p); self.pinModes.set(n, 1); self.pwm.set(n, { duty: 0.5, acc: 0, freq: f || 1000 }); }, noTone(p) { api.analogWrite(p, 0); },
        attachInterrupt(p, fn, mode) { const n = pinOf(p); self.isr.push({ num: n, fn, mode, last: self.v(n) > 0.5 * self.vdd() ? 1 : 0 }); },
        detachInterrupt(p) { const n = pinOf(p); self.isr = self.isr.filter(h => h.num !== n); }, digitalPinToInterrupt(p) { return p; }, interrupts() {}, noInterrupts() {},
        millis() { return Math.floor((self.now - self.t0) * 1000); }, micros() { return Math.floor((self.now - self.t0) * 1e6); },
        *delay(ms) { yield Math.max(0, +ms || 0) / 1000; }, *delayMicroseconds(us) { yield Math.max(0, +us || 0) / 1e6; }, *pulseIn() { yield 0.001; return 0; },
        yield() {}, abs: Math.abs, min: Math.min, max: Math.max, pow: Math.pow, sqrt: Math.sqrt, sq: x => x * x, sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2, floor: Math.floor, ceil: Math.ceil, round: Math.round, fabs: Math.abs, log: Math.log, log10: Math.log10, exp: Math.exp,
        constrain: (x, a, b) => Math.min(b, Math.max(a, x)), map: (x, a, b, c, d) => Math.trunc((x - a) * (d - c) / (b - a) + c),
        random(a, b) { rnd = (rnd * 1103515245 + 12345) % 2147483648; const r = rnd / 2147483648; return b === undefined ? Math.floor(r * a) : Math.floor(a + r * (b - a)); }, randomSeed(s) { rnd = (+s || 1) % 2147483648; },
        bitRead: (x, b) => (x >> b) & 1, bitSet: (x, b) => x | (1 << b), bitClear: (x, b) => x & ~(1 << b), bitWrite: (x, b, v) => (v ? x | (1 << b) : x & ~(1 << b)), bit: b => 1 << b, lowByte: x => x & 0xff, highByte: x => (x >> 8) & 0xff,
        isDigit: c => /[0-9]/.test(typeof c === 'number' ? String.fromCharCode(c) : c),
        shiftOut(dp, cp, order, val) { for (let i = 0; i < 8; i++) { const bit = order === 0 ? (val >> i) & 1 : (val >> (7 - i)) & 1; api.digitalWrite(dp, bit); api.digitalWrite(cp, 1); api.digitalWrite(cp, 0); } },
      });
      // Wire / SPI: the buses of this board with their parts (Wire.begin(sda, scl) moves to the bus on those pins)
      const wrapWire = k => {
        const w = () => (hw && hw.sel.i2c[k] >= 0 ? hw.wire(k) : (hw ? hw.emptyWire || (hw.emptyWire = N.devices.makeWire([], {})) : null));
        return new Proxy({}, { get(o, prop) {
          if (prop === 'begin') return (sda, scl) => { if (hw && sda != null && scl != null) hw.pickI2C(k, pinOf(sda), pinOf(scl)); const x = w(); return x && x.begin ? x.begin() : undefined; };
          const x = w(); if (!x) return () => 0; const v = x[prop]; return typeof v === 'function' ? v.bind(x) : v;
        } });
      };
      const wrapSPI = k => new Proxy({}, { get(o, prop) {
        if (prop === 'begin') return (sck, miso, mosi) => { if (hw && sck != null && mosi != null) hw.pickSPI(k, pinOf(sck), pinOf(mosi)); const x = hw && hw.spiObj(k); return x && x.begin ? x.begin() : undefined; };
        const x = hw && (hw.sel.spi[k] >= 0 ? hw.spiObj(k) : null); if (!x) return () => 0xff; const v = x[prop]; return typeof v === 'function' ? v.bind(x) : v;
      } });
      if (N.devices) { api.Wire = wrapWire(0); api.Wire1 = wrapWire(1); api.SPI = wrapSPI(0); api.SPI1 = wrapSPI(1); }
      else { api.Wire = api.Wire1 = { begin() {}, beginTransmission() {}, write() { return 1; }, endTransmission() { return 2; }, requestFrom() { return 0; }, available() { return 0; }, read() { return -1; } }; api.SPI = { begin() {}, transfer() { return 0xff; } }; }
      this.apiObj = api;
      return api;
    }
  }

  // real firmware on the RP2040 (rp2040js)
  class RPProc extends Proc {
    constructor(mgr, info, image, name) {
      super(mgr, info); this.kind = 'firmware'; this.image = image; this.imageName = name;
      this.gpio = [];   // gpio index -> package pin number
      for (const io of info.io) { const m = /^(?:GPIO|GP)(\d+)/i.exec(io.chipPin || io.name || ''); if (m && +m[1] < 30) this.gpio[+m[1]] = io.number; }
    }
    start(t) {
      const R = window.NoetiRP2040;
      this.releasePins();
      this.t0 = t;
      const mcu = (this.mcu = new R.RP2040());
      mcu.loadBootrom(R.bootromB1);
      mcu.flash.set(this.image.subarray(0, Math.min(this.image.length, mcu.flash.length)));
      for (const u of mcu.uart) u.onByte = b => this.console.write(String.fromCharCode(b));
      mcu.core.PC = 0x10000000;
      this.state = 'running'; this.error = ''; this.instr = 0;
      this.console.write(`\n[${this.info.ref} reset: running ${this.imageName}]\n`);
      this.mgr.changed(this);
    }
    step(t) {
      if (this.state !== 'running') return;
      if (!this.powered()) { if (!this.brownout) { this.brownout = true; this.releasePins(); } return; }
      if (this.brownout) { this.brownout = false; this.start(t); return; }
      const mcu = this.mcu, clock = mcu.clock, vdd = this.vdd();
      for (let i = 0; i < 30; i++) { const n = this.gpio[i]; if (n) mcu.gpio[i].setInputValue(this.v(n) > 0.5 * vdd); }
      for (let c = 0; c < 4; c++) { const n = this.gpio[26 + c]; if (n) mcu.adc.channelValues[c] = Math.max(0, Math.min(4095, Math.round(this.v(n) / 3.3 * 4095))); }
      const target = (t - this.t0) * 1e9;
      let guard = 3e6;
      try {
        while (clock.nanos < target && guard-- > 0) {
          if (mcu.core.waiting) { const n = clock.nanosToNextAlarm; if (n <= 0) { clock.tick(Math.min(1000, target - clock.nanos)); } else clock.tick(Math.min(n, target - clock.nanos)); }
          else { const cyc = mcu.core.executeInstruction(); clock.tick(cyc * 8); this.instr++; }
        }
      } catch (e) { this.state = 'error'; this.error = 'the emulator stopped: ' + e.message; this.mgr.changed(this); return; }
      const S = window.NoetiRP2040.GPIOPinState;
      for (let i = 0; i < 30; i++) {
        const n = this.gpio[i];
        if (!n) continue;
        const v = mcu.gpio[i].value;
        this.setPin(n, v === S.High ? 'hi' : v === S.Low ? 'lo' : v === S.InputPullUp ? 'pu' : v === S.InputPullDown ? 'pd' : 'z');
      }
    }
  }

  // real firmware on megaAVR chips (avr8js)
  const USART1_32U4 = { rxCompleteInterrupt: 0x32, dataRegisterEmptyInterrupt: 0x34, txCompleteInterrupt: 0x36, UCSRA: 0xc8, UCSRB: 0xc9, UCSRC: 0xca, UBRRL: 0xcc, UBRRH: 0xcd, UDR: 0xce };
  class AVRProc extends Proc {
    constructor(mgr, info, image, name) {
      super(mgr, info); this.kind = 'firmware'; this.image = image; this.imageName = name;
      this.bits = [];   // [portLetter, bit, pin number]
      for (const io of info.io) {
        const m = /\bP([A-L])([0-7])\b/i.exec(io.chipPin || io.name || '');
        if (m) this.bits.push([m[1].toUpperCase(), +m[2], io.number]);
        else if (info.arduino) { const a = F.arduinoBit(io.name); if (a) this.bits.push([a[0], a[1], io.number]); }
      }
      this.freq = info.clock || 16e6;
    }
    start(t) {
      const A = window.NoetiAVR;
      this.releasePins();
      this.t0 = t;
      const words = new Uint16Array(Math.max(0x4000, Math.ceil(this.image.length / 2) + 64));
      new Uint8Array(words.buffer).set(this.image.subarray(0, words.length * 2));
      const m = this.info.avr;
      const cpu = (this.cpu = new A.CPU(words, m === 'm2560' ? 8192 : m === 'm32u4' ? 2560 : 2048));
      // the interrupt vectors move on the bigger megaAVRs
      const big = m !== 'm328';
      const t0 = big ? Object.assign({}, A.timer0Config, { compAInterrupt: 0x2a, compBInterrupt: 0x2c, ovfInterrupt: 0x2e }) : A.timer0Config;
      const t1 = big ? Object.assign({}, A.timer1Config, { captureInterrupt: 0x20, compAInterrupt: 0x22, compBInterrupt: 0x24, ovfInterrupt: 0x28 }) : A.timer1Config;
      this.timers = [new A.AVRTimer(cpu, t0), new A.AVRTimer(cpu, t1)];
      if (m === 'm328') this.timers.push(new A.AVRTimer(cpu, A.timer2Config));
      this.ports = {};
      for (const L of new Set(this.bits.map(b => b[0]))) { const cfg = A['port' + L + 'Config']; if (cfg) this.ports[L] = new A.AVRIOPort(cpu, cfg); }
      this.usart = new A.AVRUSART(cpu, m === 'm32u4' ? USART1_32U4 : m === 'm2560' ? Object.assign({}, A.usart0Config, { rxCompleteInterrupt: 0x32, dataRegisterEmptyInterrupt: 0x34, txCompleteInterrupt: 0x36 }) : A.usart0Config, this.freq);
      this.usart.onByteTransmit = b => this.console.write(String.fromCharCode(b));
      try { this.adc = new A.AVRADC(cpu, big ? Object.assign({}, A.adcConfig, { adcInterrupt: m === 'm32u4' ? 0x3a : 0x3a }) : A.adcConfig); } catch (e) { this.adc = null; }
      this.state = 'running'; this.error = '';
      this.console.write(`\n[${this.info.ref} reset: running ${this.imageName} at ${this.freq / 1e6} MHz]\n`);
      this.mgr.changed(this);
    }
    step(t) {
      if (this.state !== 'running') return;
      if (!this.powered()) { if (!this.brownout) { this.brownout = true; this.releasePins(); } return; }
      if (this.brownout) { this.brownout = false; this.start(t); return; }
      const A = window.NoetiAVR, cpu = this.cpu, vdd = this.vdd();
      for (const [L, b, n] of this.bits) { const p = this.ports[L]; if (p) p.setPin(b, this.v(n) > 0.5 * vdd); if (this.adc && L === 'C' && this.info.avr === 'm328') this.adc.channelValues[b] = this.v(n); if (this.adc && L === 'F' && this.info.avr !== 'm328') this.adc.channelValues[b] = this.v(n); }
      const target = (t - this.t0) * this.freq;
      let guard = 4e6;
      try { while (cpu.cycles < target && guard-- > 0) { A.avrInstruction(cpu); cpu.tick(); } } catch (e) { this.state = 'error'; this.error = 'the emulator stopped: ' + e.message; this.mgr.changed(this); return; }
      const S = A.PinState;
      for (const [L, b, n] of this.bits) {
        const p = this.ports[L];
        if (!p) continue;
        const st = p.pinState(b);
        this.setPin(n, st === S.High ? 'hi' : st === S.Low ? 'lo' : st === S.InputPullUp ? 'pu' : 'z');
      }
    }
  }

  // real firmware on ARM Cortex-M and RISC-V chips (emu-arm.js / emu-riscv.js, written for KiLive)
  const normPin = s => String(s || '').toUpperCase().replace(/[_\s]/g, '').replace(/^(P[A-Z])0+(\d)/, '$1$2').replace(/^(P\d)\.0*(\d)/, '$1.$2');
  class EmuProc extends Proc {
    constructor(mgr, info, image, name, api, chipId) {
      super(mgr, info); this.kind = 'firmware'; this.image = image; this.imageName = name; this.api = api; this.chipId = chipId;
      this.pwm = new Map();
    }
    start(t) {
      this.releasePins(); this.pwm.clear();
      this.t0 = t;
      const m = (this.m = new this.api.Machine(this.chipId, this.info.clock ? { hseHz: this.info.clock, xoscHz: this.info.clock } : {}));
      m.loadFile(this.image, this.imageName);
      this.lastUart = -1;
      m.onSerial = (u, b) => {
        if (u !== this.lastUart) { if (this.lastUart >= 0 || u > 0) this.console.write(`\n[${m.chip.uarts[u] || 'UART' + u}] `); this.lastUart = u; this.rxUart = u; }
        if (b !== 13) this.console.write(String.fromCharCode(b));
      };
      // chip pin names as the emulator spells them
      const names = new Map(m.pinNames().map(n => [normPin(n), n]));
      this.pins = [];
      for (const io of this.info.io) {
        const nm = names.get(normPin(io.chipPin)) || names.get(normPin(io.name));
        if (nm) this.pins.push([io.number, nm, !!(io.cap && io.cap.adc)]);
      }
      this.state = 'running'; this.error = ''; this.brownout = false;
      this.console.write(`\n[${this.info.ref} reset: running ${this.imageName} on the emulated ${m.chip.name} (${m.chip.core}), ${this.pins.length} pins wired]\n`);
      this.mgr.changed(this);
    }
    serialIn(bytes) { const u = this.rxUart >= 0 ? this.rxUart : 0; for (const b of bytes) this.m.serialWrite(u, b); }
    step(t) {
      if (this.state !== 'running') return;
      if (!this.powered()) { if (!this.brownout) { this.brownout = true; this.releasePins(); if (!this.ran) this.console.write(`[held in reset until the supply is up: ${this.vdd().toFixed(2)} V now]\n`); } return; }
      if (this.brownout) { this.brownout = false; this.console.write(this.ran ? '\n[power is back: reset]\n' : '[power is up: out of reset]\n'); this.start(t); return; }
      this.ran = true;
      const m = this.m, vdd = this.vdd(), half = 0.5 * vdd;
      for (const [num, nm, adc] of this.pins) { const v = this.v(num); m.setPinInput(nm, v > half); if (adc) m.setPinVoltage(nm, v); }
      try { m.runUntil(Math.max(0, (t - this.t0) * 1e9)); } catch (e) { this.state = 'error'; this.error = 'the emulator stopped: ' + (e.message || e); this.mgr.changed(this); return; }
      if (m.state === 'fault') { this.state = 'error'; this.error = m.fault || 'the processor faulted'; this.console.write('\n[stopped: ' + this.error + ']\n'); this.releasePins(); this.mgr.changed(this); return; }
      if (m.state === 'halted') { this.state = 'finished'; this.mgr.changed(this); return; }
      for (const [num, nm] of this.pins) {
        const st = m.pinState(nm);
        if (st && typeof st === 'object') {
          const d = Math.max(0, Math.min(1, st.duty || 0));
          if (d <= 0.002) { this.pwm.delete(num); this.setPin(num, 'lo'); }
          else if (d >= 0.998) { this.pwm.delete(num); this.setPin(num, 'hi'); }
          else { const p = this.pwm.get(num); if (p) { p.duty = d; p.freq = st.freq || 0; } else this.pwm.set(num, { duty: d, acc: 0, freq: st.freq || 0 }); }
        } else { if (this.pwm.has(num)) this.pwm.delete(num); this.setPin(num, st || 'z'); }
      }
      this.pwmStep();
      this.instr = m.stats && m.stats.instr;
    }
    notes() { return (this.m && this.m.log || []).slice(-6).map(x => (typeof x === 'string' ? x : x.msg || JSON.stringify(x))); }
  }

  // ------------------------------------------------------------------ firmware files
  F.parseImage = function (bytes, name, fam) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const txt = () => new TextDecoder().decode(u8);
    if (/\.uf2$/i.test(name) || (u8.length >= 512 && u8[0] === 0x55 && u8[1] === 0x46 && u8[2] === 0x32 && u8[3] === 0x0a)) {
      const img = new Uint8Array(2 * 1024 * 1024);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      let top = 0, blocks = 0;
      for (let o = 0; o + 512 <= u8.length; o += 512) {
        if (dv.getUint32(o, true) !== 0x0a324655) continue;
        const addr = dv.getUint32(o + 12, true), size = dv.getUint32(o + 16, true);
        if (addr < 0x10000000 || addr - 0x10000000 + size > img.length) continue;
        img.set(u8.subarray(o + 32, o + 32 + size), addr - 0x10000000);
        top = Math.max(top, addr - 0x10000000 + size); blocks++;
      }
      if (!blocks) throw new Error('no RP2040 flash blocks in this UF2 file');
      return { data: img.subarray(0, top), kind: 'uf2' };
    }
    if (/\.hex$/i.test(name) || /^:[0-9A-F]{8}/i.test(txt().slice(0, 12))) {
      const img = new Uint8Array(fam === 'rp2040' ? 2 * 1024 * 1024 : 256 * 1024);
      let base = 0, top = 0;
      for (const line of txt().split(/\r?\n/)) {
        if (line[0] !== ':') continue;
        const n = parseInt(line.substr(1, 2), 16), addr = parseInt(line.substr(3, 4), 16), type = parseInt(line.substr(7, 2), 16);
        if (type === 4) base = parseInt(line.substr(9, 4), 16) << 16;
        else if (type === 2) base = parseInt(line.substr(9, 4), 16) << 4;
        else if (type === 0) {
          let a = base + addr;
          if (fam === 'rp2040') a -= 0x10000000;
          if (a < 0 || a + n > img.length) continue;
          for (let i = 0; i < n; i++) img[a + i] = parseInt(line.substr(9 + i * 2, 2), 16);
          top = Math.max(top, a + n);
        }
      }
      if (!top) throw new Error('no data records in this HEX file');
      return { data: img.subarray(0, top), kind: 'hex' };
    }
    if (/\.elf$/i.test(name) || (u8[0] === 0x7f && u8[1] === 0x45)) throw new Error('ELF files are not supported yet: export a .uf2, .hex or .bin');
    return { data: u8, kind: 'bin' };
  };
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  F.EXAMPLES = {
    rp2040: { name: 'blink-all-gpio.uf2', label: 'Blink every GPIO + UART "hello" (bare metal, 1 KB)', data: () => b64(F.RP_BLINK_UF2) },
    avr: { name: 'blink-all-pins.hex', label: 'Blink every port pin + UART "hello" at 9600 baud (ATmega328P, 16 MHz)', data: () => new TextEncoder().encode(F.AVR_BLINK_HEX), src: () => F.AVR_BLINK_SRC },
    avrU4: { name: 'blink-all-pins-32u4.hex', label: 'Blink every port B–F pin + USART1 "hello" at 9600 baud (ATmega32U4 / AT90USB family, 16 MHz)', data: () => new TextEncoder().encode(F.AVR_U4_BLINK_HEX), src: () => F.AVR_U4_BLINK_SRC },
  };
  F.EXAMPLES.rp2040.src = () => F.RP_BLINK_SRC;
  // the example that suits this particular chip (the 328P build hangs on chips without USART0)
  F.exampleFor = p => {
    if (p.family === 'avr') return p.avr && p.avr !== 'm328' ? F.EXAMPLES.avrU4 : F.EXAMPLES.avr;
    if (p.family === 'arm' || p.family === 'riscv') {
      const X = p.family === 'arm' ? window.NoetiARMExamples : window.NoetiRVExamples;
      const ex = X && X[p.emuChip];
      if (!ex) return null;
      const name = ex.name;
      return { name, label: ex.label, data: () => { const d = b64(ex.data); return d; }, src: () => ex.src || '', toggles: ex.toggles || [] };
    }
    return F.EXAMPLES[p.family];
  };

  // load the emulator bundles only when someone runs firmware
  const loaded = {};
  const BUNDLES = { rp2040: [['js/emu-rp2040.js', 'NoetiRP2040']], avr: [['js/emu-avr.js', 'NoetiAVR']], arm: [['js/emu-arm.js', 'NoetiARM'], ['js/emu-arm-examples.js', 'NoetiARMExamples']], riscv: [['js/emu-riscv.js', 'NoetiRV'], ['js/emu-riscv-examples.js', 'NoetiRVExamples']] };
  const loadScript = (file, glob) => {
    if (window[glob]) return Promise.resolve();
    if (!loaded[file]) loaded[file] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = file; s.onload = () => (window[glob] ? res() : rej(new Error('emulator did not load'))); s.onerror = () => { loaded[file] = null; rej(new Error('could not load ' + file)); }; document.head.append(s); });
    return loaded[file];
  };
  F.loadEmu = fam => Promise.all((BUNDLES[fam] || []).map(([f, g]) => loadScript(f, g)));
  F.emuLoaded = fam => (BUNDLES[fam] || []).every(([, g]) => !!window[g]);
  // RP2350 images: Arm or RISC-V (Hazard3)? UF2 family id or ELF machine
  F.imageArch = function (u8) {
    if (u8.length >= 512 && u8[0] === 0x55 && u8[1] === 0x46 && u8[2] === 0x32 && u8[3] === 0x0a) { const fid = new DataView(u8.buffer, u8.byteOffset + 28, 4).getUint32(0, true); if (fid === 0xe48bff5a) return 'riscv'; if (fid === 0xe48bff59) return 'arm'; }
    if (u8[0] === 0x7f && u8[1] === 0x45 && u8[2] === 0x4c && u8[3] === 0x46) { const m = u8[18] | (u8[19] << 8); return m === 243 ? 'riscv' : m === 40 ? 'arm' : null; }
    return null;
  };

  // the short name people use for a pin: GPIO8 rather than IO8/GPIO8/ADC1_CH8
  F.shortPin = function (io) {
    const parts = String(io.name || io.number).split(/[\/\s]+/).map(x => x.replace(/[()~{}]/g, '')).filter(Boolean);
    return parts.find(x => /^GPIO\d+$/i.test(x)) || parts.find(x => /^(GP\d+|P[A-L]\d{1,2}|P\d\.\d+|IO\d+|D\d+|A\d+|PIO\d?_?\d+)$/i.test(x)) || parts[0] || String(io.number);
  };
  // ------------------------------------------------------------------ starter program from the wiring
  F.starter = function (circ, proc) {
    const w = F.wiring(circ, proc);
    const seen = new Set();
    const ens = w.filter(x => x.enable).slice(0, 6);
    const leds = w.filter(x => x.led && !x.enable && !seen.has(x.led.ref) && seen.add(x.led.ref)).slice(0, 6), btns = w.filter(x => x.button && !x.enable && !x.led).slice(0, 3);
    const q0 = s => JSON.stringify(s);
    const q = nm => { const io = proc.io.find(x => x.name === nm); return q0(io ? F.shortPin(io) : nm); };
    const L = [];
    L.push(`// Starter program for ${proc.ref} (${proc.value}), written from this board's wiring.`);
    L.push(`// Arduino style: setup() runs once, loop() forever. Pins can be named like ${q(proc.io[0].name)}, by number or by the net they drive.`);
    const sp = x => F.shortPin(x.pin);
    if (ens.length) L.push('// Enables: ' + ens.map(x => `${sp(x)} -> ${x.enable.ref} (${x.enable.value})`).join(', '));
    if (leds.length) L.push('// LEDs: ' + leds.map(x => `${sp(x)} -> ${x.led.ref}${x.led.via ? ' via ' + x.led.via : ''}`).join(', '));
    if (btns.length) L.push('// Buttons: ' + btns.map(x => `${sp(x)} -> ${x.button.ref}`).join(', '));
    L.push('');
    L.push('void setup() {');
    L.push('  Serial.begin(115200);');
    for (const x of ens) { L.push(`  pinMode(${q(x.pin.name)}, OUTPUT);`); L.push(`  digitalWrite(${q(x.pin.name)}, ${x.enable.activeHigh ? 'HIGH' : 'LOW'});   // switch ${x.enable.ref} on`); }
    for (const x of leds) L.push(`  pinMode(${q(x.pin.name)}, OUTPUT);`);
    for (const x of btns) L.push(`  pinMode(${q(x.pin.name)}, INPUT_PULLUP);`);
    L.push(`  Serial.println(${q0('Hello from ' + proc.ref + ' on KiLive')});`);
    L.push('}');
    L.push('');
    L.push('int n = 0;');
    L.push('void loop() {');
    if (leds.length) {
      for (const x of leds) L.push(`  digitalWrite(${q(x.pin.name)}, ${x.led.activeHigh ? 'HIGH' : 'LOW'});   // ${x.led.ref} on`);
      L.push('  delay(500);');
      for (const x of leds) L.push(`  digitalWrite(${q(x.pin.name)}, ${x.led.activeHigh ? 'LOW' : 'HIGH'});`);
      L.push('  delay(500);');
    } else L.push('  delay(1000);');
    for (const x of btns) L.push(`  if (digitalRead(${q(x.pin.name)}) == LOW) Serial.println(${q0(x.button.ref + ' pressed')});`);
    L.push('  Serial.print("tick "); Serial.println(n++);');
    L.push('}');
    return { text: L.join('\n') + '\n', leds: leds.length, enables: ens.length };
  };

  // ------------------------------------------------------------------ manager: the processors of one live board
  F.manager = function (L) {
    const M = { procs: new Map(), listeners: new Set(), live: L };
    M.engine = () => L.engine;
    M.circuit = () => L.base.circuit;
    // the environment the sensors on the board measure (the live panel changes it)
    M.world = () => L.world || (L.world = Object.assign({}, (N.devices && N.devices.WORLD) || {}, { tempC: 23, humidity: 45, pressurePa: 101325, lux: 300 }));
    // screens that programs draw on and addressable LED colours, for the painters
    M.screens = new Map(); M.pixels = new Map();
    M.setScreens = (ref, list) => { if (list && list.length) M.screens.set(ref, list); else M.screens.delete(ref); M.changed(null); };
    M.setPixels = (ref, leds, cols) => { let m = M.pixels.get(ref); if (!m) M.pixels.set(ref, (m = new Map())); leds.forEach((r, i) => { const c = cols[i]; if (c) m.set(r, c); }); L.pixGen = (L.pixGen || 0) + 1; };
    M.clearPixels = ref => { if (M.pixels.delete(ref)) L.pixGen = (L.pixGen || 0) + 1; };
    M.pixelColors = () => { const out = new Map(); for (const m of M.pixels.values()) for (const [r, c] of m) out.set(r, c); return out; };
    M.changed = p => { for (const f of M.listeners) f(p); };
    M.step = (t, dt) => { for (const p of M.procs.values()) if (p.state === 'running') p.step(t, dt); };
    M.attach = eng => { eng.onStep = M.step; for (const p of M.procs.values()) p.reapply(); };
    M.runScript = (info, src) => { M.stop(info.ref); const p = new ScriptProc(M, info, src); M.procs.set(info.ref, p); p.start(L.engine.t); return p; };
    M.runImage = async (info, bytes, name) => {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let fam = info.family, chip = info.emuChip;
      // RP2350 runs Arm or RISC-V images
      if (/^rp2350/.test(chip || '') && F.imageArch(u8) === 'riscv') { fam = 'riscv'; chip = 'rp2350-riscv'; }
      await F.loadEmu(fam);
      let p;
      if (fam === 'arm' || fam === 'riscv') {
        const api = fam === 'arm' ? window.NoetiARM : window.NoetiRV;
        if (fam === 'riscv' && F.imageArch(u8) === 'arm') throw new Error('this is an Arm image; ' + info.value + ' runs RISC-V code');
        M.stop(info.ref);
        p = new EmuProc(M, info, u8, name, api, chip);
      } else {
        const img = F.parseImage(u8, name, fam);
        M.stop(info.ref);
        p = fam === 'rp2040' ? new RPProc(M, info, img.data, name) : new AVRProc(M, info, img.data, name);
      }
      M.procs.set(info.ref, p);
      try { p.start(L.engine.t); } catch (e) { M.procs.delete(info.ref); throw e; }
      return p;
    };
    M.get = ref => M.procs.get(ref);
    // serial bytes into a processor: a program's Serial input, an emulated chip's UART
    M.feed = (p, bytes) => {
      if (!p || !bytes.length) return;
      if (p.kind === 'script') p.console.inq.push(...bytes);
      else if (p.serialIn) p.serialIn(bytes);
      else if (p.mcu && p.mcu.uart && p.mcu.uart[0]) for (const b of bytes) p.mcu.uart[0].feedByte(b);
      else if (p.usart) { let i = 0; const feed = () => { if (i < bytes.length && p.usart.writeByte(bytes[i])) i++; if (i < bytes.length) setTimeout(feed, 2); }; feed(); }
    };
    // UART links between the processors of this board (one's TX net reaches the other's RX): what one prints, the other reads
    M.links = () => {
      const c = L.base && L.base.circuit;
      if (M._lk && M._lkFor === c && M._lkProcs === L.procs) return M._lk;
      M._lkFor = c; M._lkProcs = L.procs;
      try { M._lk = c ? F.uartLinks(c, L.procs || []) : []; } catch (e) { M._lk = []; }
      return M._lk;
    };
    M.forward = (p, s) => {
      const links = M.links();
      if (!links.length) return;
      for (const k of links) {
        if (k.from !== p.ref) continue;
        const q = M.procs.get(k.to);
        if (!q || q.state !== 'running') continue;
        M.feed(q, [...String(s)].map(ch => ch.charCodeAt(0) & 255));
        k.bytes = (k.bytes || 0) + String(s).length;
      }
    };
    M.stop = ref => { const p = M.procs.get(ref); if (p) { p.stop(); M.procs.delete(ref); M.changed(p); } };
    M.reset = t => { for (const p of M.procs.values()) if (p.state !== 'idle') p.start(t); };
    M.stopAll = () => { for (const r of [...M.procs.keys()]) M.stop(r); };
    M.running = () => [...M.procs.values()].filter(p => p.state === 'running').length;
    return M;
  };

  // example firmware images (built with clang/lld from the sources shown in the Code panel)
  F.RP_BLINK_UF2 = "VUYyCldRXZ4AIAAAAAAAEAABAAAAAAAABAAAAFb/i+QDSARJCGABaIHzCIhBaAhHAAEAEAjtAOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADBvsQpVRjIKV1FdngAgAAAAAQAQAAEAAAEAAAAEAAAAVv+L5AAABCB1AwAQfQMAEH0DABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfQMAEAAAAAAAAAAAfQMAEH0DABANAgAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAED+/38BAAAAtgEAAAEAAADwtQOvgbAAkAAgHyMCRgCc3EABJSxAQAAmGHQaMEYA0yBGjkIB051AAOAAJSpDWx4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMG+xClVGMgpXUV2eACAAAAACABAAAQAAAgAAAAQAAABW/4vkXBzs0xBGAbDwvcBGAkgBIQFgAkgBYHBHNEAFQAAAACCAtQCvhrA3STdICGA3SQpoAkCCQvvRNkgCIQFggWA1S0MiWmI1IppicCLaYjJKGmMQMAAkMUoZKQbYBSMDYFYjE2ABI4tAHEMIMBIdSRweKQGU8NEqTWxhKkkBIIhiKkkIYCpJCGAqSADwXvgAIACQBkbsYCdIAPBX+AKWNUYAnAomKEYxRv/3k/9GQ6kbMCIKQwOpClVkHAktBUbw2BVKF01kHgOoAF2RaYkG/NQQYAAs9tEoaAGcIEIXSAKeANAWSADwMfgAIBVKEGANSYhpFEvAGAhgdhwQaAAoydEwvwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwb7EKVUYyCldRXZ4AIAAAAAMAEAABAAADAAAABAAAAFb/i+T658BGAPAAQCABYAAIwABABEABQABAA0ABAwAADMABQBAAANAQQAVAgOIA4ADhAOCEAwAQfgMAEK8DABC7AwAQAAAAICChBwAJSQJ4CioC0AAqBtEL4Ippkgb81A0iCmACeItpmwb81ApgQBzt53BHAEADQIC1AK//91L//ud0aWNrIAAKSGVsbG8gZnJvbSB0aGUgUlAyMDQwLCBydW5uaW5nIG9uIE5vZXRpLgoAICBwaW5zIGxvdwoAICBwaW5zIGhpZ2gKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADBvsQo=";
  F.AVR_BLINK_HEX = ":100000000C9436000C9434000C9434000C9434009E\n:100010000C9434000C9434000C9434000C94340090\n:100020000C9434000C9434000C9434000C94340080\n:100030000C9434000C9434000C9434000C94340070\n:100040000C9434000C9434000C9434000C94340060\n:100050000C9434000C9434000C9434000C94340050\n:100060000C9434000C9434000C94000011241FBE36\n:10007000CFEFD8E0DEBFCDBFA0E0B1E0ECEDF1E026\n:1000800088E591E0A817B90719F005900D92FACF0D\n:100090000E944C00FFCF00004F925F926F927F92C0\n:1000A0008F929F92AF92BF92CF92DF92EF92FF9288\n:1000B0000F931F9387E690E09093C5008093C40050\n:1000C00088E18093C10086E08093C2008FE384B909\n:1000D00087B98CEF8AB91092800081E19AE79093FA\n:1000E0008900809388008CE08093810086E091E015\n:1000F0000E94D40000E010E080E091E07C0181E00B\n:1001000090E06C0181E491E05C0185E391E04C01B9\n:10011000C8013C0185B19FE3892785B988B189274A\n:1001200088B98BB19CEF89278BB9C7010E94D40095\n:10013000C801A80123019301FC01EE0FFF1FE25B40\n:10014000FE4FA081B18160E32A173B0720F02A1BF4\n:100150003B0B6395F9CF8430910531F04115510582\n:1001600019F46033A80141F04091C0004072403062\n:10017000D9F36093C600A601FC0131968430910545\n:10018000CF0108F4D9CF85B180728030C40109F065\n:10019000C5010E94D40086B382708030E1F382E012\n:1001A00086BBC2010196B5CFDC018DE09C919A30EF\n:1001B00019F0903049F411C09091C00090729030C5\n:1001C000D9F38093C6009C912091C000207220300A\n:0C01D000D9F39093C6001196E9CF089572\n:1001DC007469636B20000A48656C6C6F2066726FE3\n:1001EC006D207468652041546D65676133323850F9\n:1001FC002C2072756E6E696E67206F6E204E6F6567\n:10020C0074692E0A00202070696E73206C6F770A57\n:10021C0000202070696E7320686967680A001027D7\n:08022C00E80364000A00010070\n:00000001FF\n";
  F.AVR_U4_BLINK_HEX = ":100000000C9458000C9456000C9456000C94560016\n:100010000C9456000C9456000C9456000C94560008\n:100020000C9456000C9456000C9456000C945600F8\n:100030000C9456000C9456000C9456000C945600E8\n:100040000C9456000C9456000C9456000C945600D8\n:100050000C9456000C9456000C9456000C945600C8\n:100060000C9456000C9456000C9456000C945600B8\n:100070000C9456000C9456000C9456000C945600A8\n:100080000C9456000C9456000C9456000C94560098\n:100090000C9456000C9456000C9456000C94560088\n:1000A0000C9456000C9456000C9456000C940000CE\n:1000B00011241FBECFEFDAE0DEBFCDBFA0E0B1E07C\n:1000C000E6E3F2E088E591E0A817B90719F005909A\n:1000D0000D92FACF0E946E00FFCF00004F925F9208\n:1000E0006F927F928F929F92AF92BF92CF92DF9248\n:1000F000EF92FF920F931F9387E690E09093CD00CD\n:100100008093CC0088E18093C90086E08093CA0088\n:100110008FEF84B980EC87B983EF8AB990E49DB9F9\n:1001200080BB1092800081E19AE7909389008093D0\n:1001300088008CE08093810086E091E00E940101BC\n:1001400000E010E080E091E07C0181E090E06C0153\n:1001500081E491E05C0185E391E04C01C8013C0140\n:1001600085B1809585B988B190EC892788B98BB124\n:1001700093EF89278BB98EB120E482278EB981B3A2\n:10018000892781BBC7010E940101C801A801230181\n:100190009301FC01EE0FFF1FE25BFE4FA081B181D6\n:1001A00060E32A173B0720F02A1B3B0B6395F9CF2E\n:1001B0008430910531F04115510519F46033A801DF\n:1001C00041F04091C80040724030D9F36093CE00B6\n:1001D000A601FC01319684309105CF0108F4D9CFF6\n:1001E00085B181708030C40109F0C5010E94010110\n:1001F00086B382708030E1F382E086BBC201019653\n:10020000AECFDC018DE09C919A3019F0903049F42A\n:1002100011C09091C80090729030D9F38093CE00B5\n:100220009C912091C80020722030D9F39093CE0089\n:060230001196E9CF0895CC\n:100236007469636B20000A48656C6C6F2066726F88\n:100246006D207468652041546D656761333255349D\n:100256002C2072756E6E696E67206F6E204E6F650C\n:1002660074692E0A00202070696E73206C6F770AFD\n:1002760000202070696E7320686967680A0010277D\n:08028600E80364000A00010016\n:00000001FF\n";
  F.AVR_U4_BLINK_SRC = "// KiLive example firmware for the ATmega32U4 / AT90USB family (16 MHz): blinks every port B-F pin except the UART1 pins, prints on UART1 at 9600 baud.\n#include <stdint.h>\n#define R8(a) (*(volatile uint8_t *)(a))\n#define R16(a) (*(volatile uint16_t *)(a))\n#define DDRB 0x24\n#define PORTB 0x25\n#define DDRC 0x27\n#define PORTC 0x28\n#define DDRD 0x2A\n#define PORTD 0x2B\n#define PIND 0x29\n#define TIFR1 0x36\n#define TCCR1A 0x80\n#define TCCR1B 0x81\n#define OCR1A 0x88\n#define UCSR0A 0xC8\n#define UCSR0B 0xC9\n#define UCSR0C 0xCA\n#define UBRR0 0xCC\n#define UDR0 0xCE\nstatic void putc_(char c) { while (!(R8(UCSR0A) & (1 << 5))) {} R8(UDR0) = c; }\nstatic void puts_(const char *s) { while (*s) { if (*s == '\\n') putc_('\\r'); putc_(*s++); } }\nstatic void putu(uint16_t v) { static const uint16_t p[5] = {10000, 1000, 100, 10, 1}; int started = 0; for (int i = 0; i < 5; i++) { char d = '0'; while (v >= p[i]) { v -= p[i]; d++; } if (d != '0' || started || i == 4) { putc_(d); started = 1; } } }\nint main(void) {\n  R16(UBRR0) = 103;                       /* 9600 baud at 16 MHz */\n  R8(UCSR0B) = (1 << 3) | (1 << 4);       /* TXEN RXEN */\n  R8(UCSR0C) = 3 << 1;                    /* 8N1 */\n  R8(DDRB) = 0xFF; R8(DDRC) = 0xC0; R8(DDRD) = 0xF3; R8(0x2D) = 0x40; R8(0x30) = 0xF3;\n  R8(TCCR1A) = 0; R16(OCR1A) = 31249; R8(TCCR1B) = (1 << 3) | 4;   /* CTC, clk/256: 0.5 s */\n  puts_(\"\\nHello from the ATmega32U4, running on Noeti.\\n\");\n  uint16_t n = 0;\n  for (;;) {\n    R8(PORTB) ^= 0xFF; R8(PORTC) ^= 0xC0; R8(PORTD) ^= 0xF3; R8(0x2E) ^= 0x40; R8(0x31) ^= 0xF3;\n    puts_(\"tick \"); putu(n++); puts_((R8(PORTB) & 0x01) ? \"  pins high\\n\" : \"  pins low\\n\");\n    while (!(R8(TIFR1) & (1 << 1))) {}\n    R8(TIFR1) = 1 << 1;\n  }\n}\n";
  F.RP_BLINK_SRC = "// KiLive example firmware for the RP2040: blinks every GPIO except the UART pins and prints on UART0 (GPIO0 TX, GPIO1 RX).\n#include <stdint.h>\n#define REG(a) (*(volatile uint32_t *)(a))\n#define RESETS 0x4000C000u\n#define IO_BANK0 0x40014000u\n#define PADS_BANK0 0x4001C000u\n#define SIO 0xD0000000u\n#define UART0 0x40034000u\n#define TIMER 0x40054000u\n#define NVIC_ISER 0xE000E100u\n#define NVIC_ICPR 0xE000E280u\nstatic volatile uint32_t tick_flag;\nunsigned __aeabi_uidiv(unsigned n, unsigned d) { unsigned q = 0, r = 0; for (int i = 31; i >= 0; i--) { r = (r << 1) | ((n >> i) & 1); if (r >= d) { r -= d; q |= 1u << i; } } return q; }\nvoid isr_timer0(void) { REG(TIMER + 0x34) = 1; tick_flag = 1; }          /* INTR: clear alarm 0 */\nstatic void uart_putc(char c) { while (REG(UART0 + 0x18) & (1u << 5)) {} REG(UART0) = (uint32_t)c; }\nstatic void uart_puts(const char *s) { while (*s) { if (*s == '\\n') uart_putc('\\r'); uart_putc(*s++); } }\nstatic void uart_putu(uint32_t v) { char b[12]; int i = 0; do { b[i++] = '0' + v % 10; v /= 10; } while (v); while (i) uart_putc(b[--i]); }\nstatic void sleep_us(uint32_t us) {\n  tick_flag = 0;\n  REG(TIMER + 0x10) = REG(TIMER + 0x28) + us;   /* ALARM0 = TIMERAWL + us */\n  while (!tick_flag) __asm volatile(\"wfi\");\n}\nint main(void) {\n  /* take IO, pads, UART0 and the timer out of reset */\n  uint32_t bits = (1u << 5) | (1u << 8) | (1u << 22) | (1u << 21);\n  REG(RESETS + 0x3000) = bits;                 /* atomic clear */\n  while ((REG(RESETS + 0x8) & bits) != bits) {}\n  /* UART0 on GPIO0/1 at 115200 (clk_peri 125 MHz) */\n  REG(IO_BANK0 + 0x04) = 2; REG(IO_BANK0 + 0x0C) = 2;\n  REG(UART0 + 0x24) = 67; REG(UART0 + 0x28) = 53;          /* IBRD / FBRD */\n  REG(UART0 + 0x2C) = (3u << 5) | (1u << 4);               /* 8 bits, FIFO */\n  REG(UART0 + 0x30) = (1u << 0) | (1u << 8) | (1u << 9);   /* UARTEN TXE RXE */\n  /* every other GPIO is a SIO output */\n  uint32_t mask = 0;\n  for (int i = 2; i < 30; i++) { if (i >= 26) continue; REG(IO_BANK0 + 0x04 + 8 * i) = 5; REG(PADS_BANK0 + 4 + 4 * i) = 0x56; mask |= 1u << i; }\n  REG(SIO + 0x24) = mask;                                   /* GPIO_OE_SET */\n  REG(TIMER + 0x38) = 1;                                    /* INTE alarm 0 */\n  REG(NVIC_ICPR) = 1; REG(NVIC_ISER) = 1;\n  uart_puts(\"\\nHello from the RP2040, running on Noeti.\\n\");\n  uint32_t n = 0;\n  for (;;) {\n    REG(SIO + 0x1C) = mask;                                 /* GPIO_OUT_XOR: toggle */\n    uart_puts(\"tick \"); uart_putu(n++); uart_puts((REG(SIO + 0x10) & mask) ? \"  pins high\\n\" : \"  pins low\\n\");\n    sleep_us(500000);\n  }\n}\nextern uint32_t __stack_top;\nvoid reset_handler(void) { main(); for (;;) {} }\nvoid default_handler(void) { for (;;) {} }\n__attribute__((section(\".vectors\"), used)) void *const vectors[48] = {\n  &__stack_top, reset_handler, default_handler, default_handler, 0, 0, 0, 0, 0, 0, 0, default_handler, 0, 0, default_handler, default_handler,\n  isr_timer0,  /* IRQ 0: TIMER_IRQ_0 */\n};\n";
  F.AVR_BLINK_SRC = "// KiLive example firmware for the ATmega328P (16 MHz): blinks every port B/C/D pin except the UART pins, prints on the UART at 9600 baud.\n#include <stdint.h>\n#define R8(a) (*(volatile uint8_t *)(a))\n#define R16(a) (*(volatile uint16_t *)(a))\n#define DDRB 0x24\n#define PORTB 0x25\n#define DDRC 0x27\n#define PORTC 0x28\n#define DDRD 0x2A\n#define PORTD 0x2B\n#define PIND 0x29\n#define TIFR1 0x36\n#define TCCR1A 0x80\n#define TCCR1B 0x81\n#define OCR1A 0x88\n#define UCSR0A 0xC0\n#define UCSR0B 0xC1\n#define UCSR0C 0xC2\n#define UBRR0 0xC4\n#define UDR0 0xC6\nstatic void putc_(char c) { while (!(R8(UCSR0A) & (1 << 5))) {} R8(UDR0) = c; }\nstatic void puts_(const char *s) { while (*s) { if (*s == '\\n') putc_('\\r'); putc_(*s++); } }\nstatic void putu(uint16_t v) { static const uint16_t p[5] = {10000, 1000, 100, 10, 1}; int started = 0; for (int i = 0; i < 5; i++) { char d = '0'; while (v >= p[i]) { v -= p[i]; d++; } if (d != '0' || started || i == 4) { putc_(d); started = 1; } } }\nint main(void) {\n  R16(UBRR0) = 103;                       /* 9600 baud at 16 MHz */\n  R8(UCSR0B) = (1 << 3) | (1 << 4);       /* TXEN RXEN */\n  R8(UCSR0C) = 3 << 1;                    /* 8N1 */\n  R8(DDRB) = 0x3F; R8(DDRC) = 0x3F; R8(DDRD) = 0xFC;\n  R8(TCCR1A) = 0; R16(OCR1A) = 31249; R8(TCCR1B) = (1 << 3) | 4;   /* CTC, clk/256: 0.5 s */\n  puts_(\"\\nHello from the ATmega328P, running on Noeti.\\n\");\n  uint16_t n = 0;\n  for (;;) {\n    R8(PORTB) ^= 0x3F; R8(PORTC) ^= 0x3F; R8(PORTD) ^= 0xFC;\n    puts_(\"tick \"); putu(n++); puts_((R8(PORTB) & 0x20) ? \"  pins high\\n\" : \"  pins low\\n\");\n    while (!(R8(TIFR1) & (1 << 1))) {}\n    R8(TIFR1) = 1 << 1;\n  }\n}\n";
})();

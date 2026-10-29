/* KiLive — more chip models for the device library (devices.js keeps to its size budget, so the newer ones live here):
   fuel gauges, 24-bit power monitors, a quad DAC, an NFC tag and a battery-pack monitor found on the boards.
   Same API as devices.js: each is a template in N.devices.templates, matched by part number, created per bus address. */
(function () {
  'use strict';
  const N = window.Noeti, D = N && N.devices;
  if (!D || !D._ || !D.templates) return;
  const { I2CDev, WordDev } = D._;
  const { clamp } = D.util;
  const fx = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
  const R = D.roles;
  const lvl4 = v => (v === 1 ? 1 : v === 'sda' ? 2 : v === 'scl' ? 3 : 0), lvl01 = v => (v === 1 ? 1 : 0);
  const range = (a, n) => Array.from({ length: n }, (_, i) => a + i);
  // a template as devices.js makes them (default I2C roles, then the part's own)
  const T = (id, name, match, addresses, create, x) => {
    const t = Object.assign({ id, name, kind: 'i2c', bus: 'i2c', match, addresses, create: create.prototype ? (e, p, a) => new create(e, p, a) : create }, x || {});
    t.roles = Object.assign({ sda: R.sda, scl: R.scl, int: R.int, rst: R.rst }, (x && x.roles) || {});
    D.templates.push(t);
    return t;
  };
  // state of charge of a lithium cell from its open-circuit voltage
  const soc = v => clamp(Math.round(v <= 3.3 ? 0 : v >= 4.18 ? 100 : v < 3.6 ? (v - 3.3) / 0.3 * 15 : v < 3.9 ? 15 + (v - 3.6) / 0.3 * 50 : 65 + (v - 3.9) / 0.28 * 35), 0, 100);

  // ==== TI Impedance Track fuel gauges (BQ27441, BQ27421, BQ27426, BQ27220): standard commands, little-endian words
  class BQ274xx extends WordDev {
    constructor(env, spec, address) { super(env, spec, address); this.le = true; this.sub = 0; this.cap = spec.capacity || 1000; }
    cur() { return -Math.round((this.w('currentA') || 0) * 1000); }
    rdw(r) {
      const V = this.w('batteryV'), s = soc(V), I = this.cur();
      switch (r) {
        case 0x00: return { 0x0001: this.spec.devType || 0x0421, 0x0002: 0x0109, 0x0003: 0x0109 }[this.sub] ?? 0x0000;   // Control(): DEVICE_TYPE, FW / DM versions, CONTROL_STATUS
        case 0x02: return Math.round((this.w('tempC') + 273.15) * 10);
        case 0x04: return Math.round(V * 1000);
        case 0x06: return (I < 0 ? 1 : 0) | (s >= 100 ? 0x0200 : 0) | 0x0010;   // DSG, FC, BAT_DET
        case 0x08: case 0x0a: case 0x0e: case 0x0c: return r === 0x0c ? Math.round(this.cap * s / 100) : this.cap;
        case 0x10: return I & 0xffff;
        case 0x18: return Math.round(I * V) & 0xffff;
        case 0x1c: return s;
        case 0x20: return 0x0164;   // StateOfHealth 100 %, status
      }
      return 0;
    }
    wrw(r, v) { if (r === 0x00) this.sub = v; }
    status() { const V = this.w('batteryV'); return `${this.name}${this.at()} · ${fx(V, 2)} V · ${soc(V)} %`; }
  }
  T('bq27441', 'BQ27441', /\bBQ2744[12]|\bBQ2742[16]|\bBQ27220|\bBQ27510|\bBQ27z?561/, [0x55], BQ274xx, { params: t => ({ name: (/BQ27[A-Z0-9]+/.exec(t) || ['BQ27441'])[0].replace(/-.*/, ''), devType: /27421/.test(t) ? 0x0421 : /27426/.test(t) ? 0x0426 : /27220/.test(t) ? 0x0220 : 0x0421 }) });

  // ==== TI 20-bit / 16-bit digital power monitors (INA228, INA238, INA237): 24-bit result registers, IDs
  const INA = { roles: { a0: ['A0'], a1: ['A1'], vinp: ['IN+', 'VIN+', 'VINP', 'INP', 'SENSE+'], vinm: ['IN-', 'VIN-', 'VINM', 'INM', 'SENSE-'], vbus: ['VBUS'], int: ['ALERT'] }, addr: L => 0x40 + 4 * lvl4(L.a1) + lvl4(L.a0) };
  class INA2x8 extends WordDev {
    constructor(env, spec, address) { super(env, spec, address); this.b20 = !!spec.b20; this.rs = spec.rshunt || 0.015; this.wide = this.b20 ? { 4: 3, 5: 3, 7: 3, 8: 3, 9: 5, 0x0a: 5 } : { 8: 3 }; this.reset(); }
    reset() { this.cfg = 0; this.adc = 0xfb68; this.cal = 0x1000; this.vs = 0; this.vb = 0; }
    meas() {
      const p = this.volts('vinp', null), m = this.volts('vinm', null);
      this.vs = p != null && m != null ? p - m : (this.w('currentA') || 0) * this.rs + this.nz(1e-6);
      this.vb = this.volts('vbus', this.volts('vinm', this.w('busV')));
      this.version++;
    }
    rdw(r) {
      if (r >= 4 && r <= 8) this.meas();
      // ADCRANGE (CONFIG bit 4) narrows the shunt range by 4; CURRENT_LSB follows from SHUNT_CAL and the shunt
      const rng = this.cfg & 0x10 ? 4 : 1, I = this.vs / this.rs, lsb = Math.max(1e-12, this.cal / (13107.2e6 * this.rs));
      const s24 = v => (v & 0xfffff) << 4;   // 20-bit two's complement, left aligned in 24 bits
      switch (r) {
        case 0x00: return this.cfg; case 0x01: return this.adc; case 0x02: return this.cal;
        case 0x04: return this.b20 ? s24(Math.round(this.vs / (312.5e-9 / rng))) : Math.round(this.vs / (5e-6 / rng)) & 0xffff;
        case 0x05: return this.b20 ? s24(Math.round(this.vb / 195.3125e-6)) : Math.round(this.vb / 3.125e-3) & 0xffff;
        case 0x06: return this.b20 ? (Math.round(this.w('tempC') / 7.8125e-3) & 0xffff) : (Math.round(this.w('tempC') / 0.125) << 4) & 0xffff;
        case 0x07: return this.b20 ? s24(Math.round(I / lsb)) : Math.round(I / lsb) & 0xffff;
        case 0x08: return Math.round(Math.abs(I * this.vb) / (3.2 * lsb)) & 0xffffff;
        case 0x0b: return 0x0001;   // DIAG_ALRT: conversion ready
        case 0x3e: return 0x5449;   // "TI"
        case 0x3f: return this.spec.devId || 0x2281;
      }
      return 0;
    }
    wrw(r, v) { if (r === 0) { if (v & 0x8000) this.reset(); else this.cfg = v; } else if (r === 1) this.adc = v; else if (r === 2) this.cal = v & 0x7fff; }
    status() { return `${this.name}${this.at()} · ${fx(this.vb, 2)} V · ${fx(this.vs / this.rs * 1000, 1)} mA`; }
  }
  T('ina228', 'INA228', /\bINA22[89]|\bINA23[78]|\bINA700|\bINA780/, range(0x40, 16), INA2x8, Object.assign({ params: t => { const m = /INA(22[89]|23[78]|700|780)/.exec(t); const id = m ? m[1] : '228'; return { name: 'INA' + id, b20: /22[89]|7[08]0/.test(id), devId: { 228: 0x2281, 229: 0x2291, 237: 0x2371, 238: 0x2381, 700: 0x7001, 780: 0x7801 }[id] }; } }, INA));

  // ==== Microchip MCP4728: four 12-bit DACs with EEPROM, fast write / multi-write / read-back
  class MCP4728 extends I2CDev {
    constructor(env, spec, address) { super(env, spec, address); this.ch = [0, 1, 2, 3].map(() => ({ code: 0, vref: 0, pd: 0, gain: 0 })); this.ee = this.ch.map(c => Object.assign({}, c)); this.b = []; this.oi = 0; }
    start(read) { this.b = []; this.oi = 0; return true; }
    upd() { const names = ['vouta', 'voutb', 'voutc', 'voutd']; this.ch.forEach((c, i) => { const vr = c.vref ? 2.048 * (c.gain ? 2 : 1) : this.vdd(); c.V = c.pd ? 0 : c.code / 4096 * vr; this.out(names[i], c.V); }); this.version++; }
    write(b) {
      const x = this.b; x.push(b);
      const c0 = x[0];
      if ((c0 & 0xc0) === 0) {   // fast write: two bytes per channel, A to D
        if (x.length % 2 === 0) { const k = x.length / 2 - 1; if (k < 4) { this.ch[k].pd = (x[x.length - 2] >> 4) & 3; this.ch[k].code = ((x[x.length - 2] & 15) << 8) | b; this.upd(); } }
      } else if ((c0 & 0xf8) === 0x40 || (c0 & 0xf8) === 0x58) {   // multi-write / single write with EEPROM: [cmd|ch|udac] [vref pd gain d11..8] [d7..0]
        if (x.length >= 3 && (x.length - 3) % 3 === 0) { const i = x.length - 3; const k = (x[i] >> 1) & 3, hi = x[i + 1], c = this.ch[k]; c.vref = hi >> 7; c.pd = (hi >> 5) & 3; c.gain = (hi >> 4) & 1; c.code = ((hi & 15) << 8) | b; if ((c0 & 0xf8) === 0x58) this.ee[k] = Object.assign({}, c); this.upd(); }
      }
      return true;
    }
    read() {
      const k = Math.floor(this.oi / 6) % 4, j = this.oi % 6, c = j < 3 ? this.ch[k] : this.ee[k]; this.oi++;
      if (j % 3 === 0) return 0x80 | 0x40 | (k << 4) | ((this.address & 7) << 1);   // RDY, POR, channel, address bits
      if (j % 3 === 1) return (c.vref << 7) | (c.pd << 5) | (c.gain << 4) | (c.code >> 8);
      return c.code & 255;
    }
    status() { return `MCP4728${this.at()} · ${this.ch.map(c => fx(c.V || 0, 2)).join(' / ')} V`; }
  }
  T('mcp4728', 'MCP4728', /\bMCP4728/, range(0x60, 8), MCP4728, { roles: { vouta: ['VOUTA', 'VA'], voutb: ['VOUTB', 'VB'], voutc: ['VOUTC', 'VC'], voutd: ['VOUTD', 'VD'], ldac: ['LDAC'], rdy: ['RDY/BSY', 'RDY'] } });

  // ==== NXP NTAG I2C plus (NT3H2111 / NT3H2211): the tag's memory in 16-byte blocks behind a block address
  class NTAG extends I2CDev {
    constructor(env, spec, address) {
      super(env, spec, address);
      const s = this.store(64 * 16, 0);
      if (!s.mem) { s.mem = new Uint8Array(64 * 16); const uid = [0x04, 0x6e, 0x3a, 0x92, 0x5c, 0x41, 0x80]; s.mem.set([0xaa].concat(uid, [0, 0, 0, 0, 0xe1, 0x10, 0x6d, 0x00]), 0); s.mem.set([0x03, 0x00, 0xfe], 16); }
      this.mem = s.mem; this.blk = 0; this.oi = 0;
    }
    start(read) { if (!read) this.wb = []; this.oi = 0; return true; }
    write(b, i) { if (i === 0) { this.blk = b; return true; } if (this.blk < 64 && i <= 16) { this.mem[this.blk * 16 + i - 1] = this.blk === 0 && i === 1 ? this.mem[0] : b; this.version++; } return true; }
    read() { const v = this.blk < 64 ? this.mem[this.blk * 16 + (this.oi % 16)] : 0; this.oi++; return v; }
    status() { return `${this.name}${this.at()} · NFC tag`; }
  }
  T('ntag', 'NTAG I2C plus', /\bNT3H2[12]11|\bNT3H1[12]01|\bNTAG.?I2C/, [0x55], NTAG, { params: t => ({ name: (/NT3H\d{4}/.exec(t) || ['NT3H2111'])[0] }) });

  // ==== TI BQ76952 / BQ76942 battery-pack monitor: direct commands (cell, stack, pack voltages, current), subcommands
  class BQ769x2 extends I2CDev {
    constructor(env, spec, address) { super(env, spec, address); this.ptr = 0; this.sub = 0; this.buf = new Uint8Array(32); this.cells = spec.cells || 16; }
    start(read) { if (read) this.fill(); this.oi = 0; return true; }
    write(b, i) { if (i === 0) { this.ptr = b; return true; } const a = this.ptr + i - 1; if (a === 0x3e) this.sub = (this.sub & 0xff00) | b; else if (a === 0x3f) { this.sub = (this.sub & 0xff) | (b << 8); this.subcmd(); } this.version++; return true; }
    subcmd() { this.buf.fill(0); const w = v => { this.buf[0] = v & 255; this.buf[1] = v >> 8; }; if (this.sub === 0x0001) w(this.spec.devNum || 0x7695); else if (this.sub === 0x0002) w(0x0100); else if (this.sub === 0x0003) w(0x0003); }
    fill() {
      const cell = Math.round((this.w('batteryV') || 3.7) * 1000), out = this.out16 = new Map();
      for (let n = 0; n < 16; n++) out.set(0x14 + 2 * n, n < this.cells ? cell : 0);
      out.set(0x34, Math.round(cell * this.cells / 10)); out.set(0x36, Math.round(cell * this.cells / 10)); out.set(0x38, Math.round(cell * this.cells / 10));
      out.set(0x3a, Math.round(-(this.w('currentA') || 0) * 1000) & 0xffff); out.set(0x00, 0x0000); out.set(0x12, 0x0181);
      out.set(0x68, Math.round((this.w('tempC') + 273.15) * 10));
    }
    read() {
      const a = this.ptr + this.oi++;
      if (a >= 0x40 && a < 0x60) return this.buf[a - 0x40];
      if (a === 0x3e) return this.sub & 255; if (a === 0x3f) return this.sub >> 8;
      const base = a & ~1, v = this.out16 && this.out16.get(base);
      return v == null ? 0 : (a & 1 ? v >> 8 : v) & 255;
    }
    status() { return `${this.name}${this.at()} · ${this.cells} cells at ${fx(this.w('batteryV') || 3.7, 2)} V`; }
  }
  T('bq76952', 'BQ76952', /\bBQ7695[02]|\bBQ7694[02]|\bBQ7692[02]/, [0x08], BQ769x2, { params: t => { const m = /BQ769(\d)(\d)/.exec(t); const n = m ? +m[1] : 5; return { name: m ? m[0] : 'BQ76952', cells: n === 5 ? 16 : n === 4 ? 10 : 5, devNum: m ? parseInt('769' + m[1], 16) : 0x7695 }; } });

  void lvl01;
})();

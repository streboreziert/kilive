/* KiLive — behavioural models of the chips around a microcontroller (sensors, memories, displays, LED chains,
 IO expanders, RTCs, fuel gauges …) and Arduino library shims that reach them through Wire / SPI.
 Plain browser script: attaches N.devices to window.Noeti (module.exports under node).
 Built from emu/devices/src/*.js by tools/build.js — API and device list in emu/devices/README.md.

 Sections: core · environmental sensors · IMUs · light/power/ADC/DAC · IO/LED drivers · memories · RTC & misc ·
					 displays · board helpers (match, findOnBus, ledChains) · buses (makeWire, makeSPI) · library shims   */
(function (root) {
'use strict';
const N = (root.Noeti = root.Noeti || {}), D = (N.devices = N.devices || {});
D.version = '1.0.0';

// ==== helpers
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const bcd = v => (((v / 10) | 0) << 4) | v % 10, unbcd = b => ((b >> 4) & 15) * 10 + (b & 15);
const hex = (v, n = 2) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
const s16 = v => ((v & 0xffff) ^ 0x8000) - 0x8000, s8 = v => ((v & 0xff) ^ 0x80) - 0x80;
const fx = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const toBytes = s => Array.from(String(s), c => c.charCodeAt(0) & 255);
const sat16 = v => clamp(Math.round(v), -32768, 32767) & 0xffff;
const put16 = (r, a, v, le) => { v &= 0xffff; r[a + (le ? 1 : 0)] = v >> 8; r[a + (le ? 0 : 1)] = v & 255; };
// Sensirion/Aosong CRC-8 (poly 0x31, init 0xFF)
function crc8(bytes, init = 0xff) { let c = init; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x31) & 255 : (c << 1) & 255; } return c; }
// integer x in [lo, hi] whose monotonic f(x) is closest to target (inverts compensation formulas)
function solve(f, target, lo, hi, up = true) {
	while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if ((f(m) < target) === up) lo = m; else hi = m; }
	return Math.abs(f(lo) - target) <= Math.abs(f(hi) - target) ? lo : hi;
}
D.util = { clamp, bcd, unbcd, hex, s16, s8, crc8, solve };

// ==== the shared, user-adjustable world
// tempC °C, humidity %RH, pressurePa, lux, accel m/s² (device frame), gyro °/s, mag µT, batteryV, angleDeg, currentA / busV (current monitors
// without circuit voltages), gasOhm (BME68x), gaugePa (differential pressure), loadKg (HX711)
D.WORLD = { tempC: 23, humidity: 45, pressurePa: 101325, lux: 300, accel: [0, 0, 9.81], gyro: [0, 0, 0], mag: [20, 0, -40],
	batteryV: 3.9, noise: true, angleDeg: 0, currentA: 0.1, busV: 5, gasOhm: 50000, gaugePa: 0, loadKg: 0 };
// Library shims cannot block, so their waits move this skew; devices see env.now() + skew (RTCs ignore it).
D.clock = { skew: 0 };
// Non-volatile contents (EEPROM, flash, FRAM, SD), keyed by env.storeKey || env.ref || spec id
D.storage = new Map();
let lcg = 12345;
const rand0 = () => (lcg = (lcg * 1103515245 + 12345) >>> 0) / 4294967296;

// ==== device base classes
class Dev {
	constructor(env, spec) { this.env = env || {}; this.spec = spec || { name: '?', id: '?' }; this.name = this.spec.name; this.version = 0; }
	t() { return (this.env.now ? this.env.now() : 0) + D.clock.skew; }
	w(k) { const w = this.env.world, v = w && w[k]; return v == null ? D.WORLD[k] : v; }
	wv(k, i) { const v = this.w(k); return Array.isArray(v) ? +v[i] || 0 : 0; }
	rnd() { return this.env.rand ? this.env.rand() : rand0(); }
	nz(s) { return this.w('noise') ? (this.rnd() + this.rnd() + this.rnd() - 1.5) * 2 * s : 0; }   // ≈ gaussian, σ ≈ s
	pin(role, mode) { if (this.env.setPin) this.env.setPin(role, mode); }
	lvl(role) { const v = this.env.pinLevel ? this.env.pinLevel(role) : null; return v == null ? null : v ? 1 : 0; }
	volts(role, dflt) { const v = this.env.volts ? this.env.volts(role) : null; return v == null || Number.isNaN(+v) ? dflt : +v; }
	out(role, v) { if (this.env.setVolts) this.env.setVolts(role, v); }
	vdd() { const v = this.env.supplyV ? this.env.supplyV() : null; return v > 0.5 ? v : 3.3; }
	store(size, fill = 0xff) {
		const key = this.env.storeKey || this.env.ref || this.spec.id; let s = D.storage.get(key);
		if (!s || s.size !== size) D.storage.set(key, (s = { size, fill, sectors: new Map() }));
		return s;
	}
	at() { return this.address != null ? ' @' + hex(this.address) : ''; }
	status() { return this.name + this.at(); }
}
// I2C slave with byte hooks: start(isRead, addr) / write(byte, index) return false to NACK; read(ack) → byte
class I2CDev extends Dev {
	constructor(env, spec, address) { super(env, spec); this.address = address; this.n = 0; }
	i2cStart(isRead, addr) { this.n = 0; return this.start(!!isRead, addr) !== false; }
	i2cWrite(b) { return this.write(b & 255, this.n++) !== false; }
	i2cRead(ack) { return this.read(ack !== false) & 255; }
	i2cStop() { this.stop(); }
	start() { return true; } write() { return true; } read() { return 0xff; } stop() {}
}
// 8-bit register file behind an auto-incrementing pointer; pairWrite = Bosch style (register, data) pairs
class RegDev extends I2CDev {
	constructor(env, spec, address, size = 256) { super(env, spec, address); this.regs = new Uint8Array(size); this.ptr = 0; }
	start(read) { if (read && this.refresh) this.refresh(this.ptr); return true; }
	write(b, i) {
		if (this.pairWrite ? i % 2 === 0 : i === 0) { this.ptr = this.sub(b); return true; }
		this.wr(this.ptr, b); if (!this.pairWrite) this.ptr = this.next(this.ptr); return true;
	}
	read() { const r = this.ptr, v = this.rd(r); this.ptr = this.next(r); return v; }
	sub(b) { return b % this.regs.length; }
	next(r) { return (r + 1) % this.regs.length; }
	rd(r) { return this.regs[r]; }
	wr(r, v) { this.regs[r] = v; this.version++; }
}
// registers wider than a byte behind an 8-bit pointer (TMP102, INA2xx, ADS1x15 …): rdw(reg) / wrw(reg, value),
// big-endian unless this.le; this.wide = { reg: bytes } for odd sizes
class WordDev extends I2CDev {
	constructor(env, spec, address) { super(env, spec, address); this.ptr = 0; this.buf = []; this.bi = 0; this.wbuf = []; }
	size(r) { return (this.wide && this.wide[r]) || 2; }
	start(read) { this.wbuf = []; if (read) this.fetch(); return true; }
	fetch() { const n = this.size(this.ptr), v = this.rdw(this.ptr); this.buf = []; for (let i = 0; i < n; i++) this.buf.push(Math.floor(v / 2 ** (8 * (this.le ? i : n - 1 - i))) & 255); this.bi = 0; }
	write(b, i) {
		if (i === 0) { this.ptr = b; return this.known ? this.known(b) : true; }
		this.wbuf.push(b); const n = this.wbuf.length;
		if (n === this.size(this.ptr)) { let v = 0; this.wbuf.forEach((x, k) => (v += x * 2 ** (8 * (this.le ? k : n - 1 - k)))); this.wbuf = []; this.wrw(this.ptr, v); this.version++; }
		return true;
	}
	read() { if (this.bi >= this.buf.length) this.fetch(); return this.buf[this.bi++]; }
	rdw() { return 0; } wrw() {}
}
// SPI slave: spiSelect(active), spiTransfer(byteOut, dcLevel) → byteIn
class SPIDev extends Dev {
	constructor(env, spec) { super(env, spec); this.sel = false; this.n = 0; }
	spiSelect(a) { a = !!a; if (a === this.sel) return; this.sel = a; if (a) { this.n = 0; this.begin(); } else this.end(); }
	spiTransfer(b, dc) { const r = this.xfer(b & 255, this.n++, dc); return r == null ? 0xff : r & 255; }
	begin() {} end() {} xfer() { return 0xff; }
}
// conversions started at t0 are ready at t0 + dt; status polls that find them busy finish them after a few polls
// (library code can not let time pass)
class Conv {
	constructor() { this.end = -1; this.polls = 0; }
	begin(now, dt) { this.end = now + dt; this.polls = 0; }
	busy(now, poll) { if (this.end < 0 || now >= this.end) return false; if (poll && ++this.polls > 25) { this.end = now; return false; } return true; }
}

// ==== spec templates
// { id, name, kind, bus?, match, generic?, roles, addresses, addr(levels, params)?, params(text)?, create(env, spec, addr) }
const TEMPLATES = (D.templates = []);
const R = {   // pin-role name lists (normalised: upper case, without ~{ } # / wrappers)
	sda: ['SDA', 'SDI', 'SDX', 'SDIO', 'SMDATA', 'SMBDATA', 'DATA'], scl: ['SCL', 'SCK', 'SCLK', 'SCX', 'SMCLK', 'SMBCLK', 'SPC', 'CLK'],
	cs: ['CS', 'CSB', 'CSN', 'NCS', 'NSS', 'SS', 'CE', 'SYNC', 'SEL'], mosi: ['MOSI', 'SDI', 'SI', 'DI', 'DIN', 'SDA', 'COPI', 'SDIN', 'IO0', 'SIO0', 'D0'],
	miso: ['MISO', 'SDO', 'SO', 'DO', 'DOUT', 'CIPO', 'IO1', 'SIO1', 'D1', 'SDATA'], sck: ['SCK', 'SCLK', 'CLK', 'SCL', 'SPC'],
	int: ['INT', 'INT1', 'INT2', 'IRQ', 'DRDY', 'ALERT', 'ALRT', 'INTB', 'INT_N', 'RDY', 'MFP', 'GPOUT'], rst: ['RST', 'RES', 'RESET', 'RSTN', 'NRST', 'XRES'],
};
D.roles = R;
function tpl(def) {
	const spi = def.kind === 'spi' || /spi/.test(def.bus || '') || def.kind === 'i2c+spi';
	def.roles = Object.assign({ sda: R.sda, scl: R.scl, int: R.int, rst: R.rst }, spi ? { cs: R.cs, mosi: R.mosi, miso: R.miso, sck: R.sck } : {}, def.roles || {});
	TEMPLATES.push(def); return def;
}
// T(id, name, kind, match, addresses, create, extra); create = (env, spec, address) → device, a device class, or [class, ...extra constructor arguments]
const T = (id, name, kind, match, addresses, c, x) => tpl(Object.assign({ id, name, kind, match, addresses, create: Array.isArray(c) ? (e, p, a) => new c[0](e, p, a, ...c.slice(1)) : c.prototype ? (e, p, a) => new c(e, p, a) : c }, x));
// address pin levels: 0 / 1 / null (floating) / 'sda' / 'scl'
const lvl01 = v => (v === 1 ? 1 : 0), lvl4 = v => (v === 1 ? 1 : v === 'sda' ? 2 : v === 'scl' ? 3 : 0);
const A1 = (base, dflt = 0, pin = 'addr') => L => base + (L && L[pin] != null ? lvl01(L[pin]) : dflt);
const A3 = base => (L = {}) => base + lvl01(L.a0) + 2 * lvl01(L.a1) + 4 * lvl01(L.a2);
const range = (a, n) => Array.from({ length: n }, (_, i) => a + i);
D._ = { Dev, I2CDev, RegDev, WordDev, SPIDev, Conv };

// ==== temperature / humidity / pressure
const wT = d => d.w('tempC') + d.nz(0.02), wH = d => clamp(d.w('humidity') + d.nz(0.1), 0, 100), wP = d => d.w('pressurePa') + d.nz(1.5);
const le16 = (r, a, v) => { r[a] = v & 255; r[a + 1] = (v >> 8) & 255; };
const put20 = (r, a, v) => { r[a] = (v >> 12) & 255; r[a + 1] = (v >> 4) & 255; r[a + 2] = (v & 15) << 4; };

// ---- Bosch BMP280 / BME280: calibration registers + raw ADC values that the Bosch compensation turns into world values
const BME_CAL = { T1: 27504, T2: 26435, T3: -1000, P1: 36477, P2: -10685, P3: 3024, P4: 2855, P5: 140, P6: -7, P7: 15500, P8: -14600, P9: 6000, H1: 75, H2: 362, H3: 0, H4: 331, H5: 50, H6: 30 };
const bmeTf = (adc, c) => { const d = Math.floor(adc / 16) - c.T1; return Math.floor(((Math.floor(adc / 8) - 2 * c.T1) * c.T2) / 2048) + Math.floor((Math.floor((d * d) / 4096) * c.T3) / 16384); };
const bmeP = (adc, tf, c) => {   // Bosch double-precision formula (Pa)
	let v1 = tf / 2 - 64000, v2 = (v1 * v1 * c.P6) / 32768 + v1 * c.P5 * 2; v2 = v2 / 4 + c.P4 * 65536;
	v1 = (1 + ((c.P3 * v1 * v1) / 524288 + c.P2 * v1) / 524288 / 32768) * c.P1; if (!v1) return 0;
	const p = ((1048576 - adc - v2 / 4096) * 6250) / v1; return p + ((c.P9 * p * p) / 2147483648 + (p * c.P8) / 32768 + c.P7) / 16;
};
const bmeH = (adc, tf, c) => { let h = tf - 76800; h = (adc - (c.H4 * 64 + (c.H5 / 16384) * h)) * ((c.H2 / 65536) * (1 + (c.H6 / 67108864) * h * (1 + (c.H3 / 67108864) * h))); return h * (1 - (c.H1 * h) / 524288); };
class BME280 extends RegDev {
	constructor(env, spec, address, hum) { super(env, spec, address); this.hum = hum; this.pairWrite = true; this.conv = new Conv(); this.reset(); }
	reset() {
		const r = this.regs, c = BME_CAL; r.fill(0);
		[c.T1, c.T2, c.T3, c.P1, c.P2, c.P3, c.P4, c.P5, c.P6, c.P7, c.P8, c.P9].forEach((v, i) => le16(r, 0x88 + 2 * i, v));
		r[0xd0] = this.hum ? 0x60 : 0x58;
		if (this.hum) { r[0xa1] = c.H1; le16(r, 0xe1, c.H2); r[0xe3] = c.H3; r[0xe4] = c.H4 >> 4; r[0xe5] = (c.H4 & 15) | ((c.H5 & 15) << 4); r[0xe6] = c.H5 >> 4; r[0xe7] = c.H6; }
		r[0xf7] = r[0xfa] = r[0xfd] = 0x80; this.last = -1e9; this.T = this.P = this.H = NaN;
	}
	wr(a, v) {
		if (a === 0xe0) { if (v === 0xb6) this.reset(); return; }
		if (a < 0xf2 || a > 0xf5 || a === 0xf3) return;
		this.regs[a] = v;
		if (a === 0xf4 && (v & 3) === 1) this.conv.begin(this.t(), this.tmeas());
	}
	tmeas() { const o = f => (f ? 1 << (f - 1) : 0), t = o(this.regs[0xf4] >> 5), p = o((this.regs[0xf4] >> 2) & 7), h = this.hum ? o(this.regs[0xf2] & 7) : 0; return (1.25 + 2.3 * t + (p && 2.3 * p + 0.575) + (h && 2.3 * h + 0.575)) / 1000; }
	rd(a) { if (a === 0xf3) { this.refresh(); return this.conv.busy(this.t(), true) ? 0x08 : 0; } return this.regs[a]; }
	refresh() {
		const now = this.t(), mode = this.regs[0xf4] & 3;
		if (mode === 1 && this.conv.end >= 0 && !this.conv.busy(now)) { this.sample(); this.regs[0xf4] &= ~3; this.conv.end = -1; }
		else if (mode === 3 && now - this.last >= this.tmeas() + [0.5, 62.5, 125, 250, 500, 1000, 10, 20][this.regs[0xf5] >> 5] / 1000) { this.sample(); this.last = now; }
	}
	sample() {
		const c = BME_CAL, r = this.regs, T = wT(this), P = wP(this), H = wH(this), m = r[0xf4];
		const adcT = solve(x => (bmeTf(x, c) * 5 + 128) >> 8, T * 100, 0, 0xfffff), tf = bmeTf(adcT, c);
		put20(r, 0xfa, m >> 5 ? adcT : 0x80000); put20(r, 0xf7, (m >> 2) & 7 ? solve(x => bmeP(x, tf, c), P, 0, 0xfffff, false) : 0x80000);
		if (this.hum) { const h = r[0xf2] & 7 ? solve(x => bmeH(x, tf, c), H, 0, 0xffff) : 0x8000; r[0xfd] = h >> 8; r[0xfe] = h & 255; }
		this.T = m >> 5 ? T : NaN; this.P = (m >> 2) & 7 ? P : NaN; this.H = this.hum && r[0xf2] & 7 ? H : NaN; this.version++;
	}
	status() { return `${this.name}${this.at()} · ${fx(this.T)} °C · ${fx(this.P / 100, 0)} hPa${this.hum ? ' · ' + fx(this.H, 0) + ' %RH' : ''}`; }
}

// ---- Bosch BME680 / BME688: float compensation of the bme68x API; gas resistance from world.gasOhm
const B68 = { t1: 26286, t2: 26380, t3: 3, p1: 36813, p2: -10404, p3: 88, p4: 7011, p5: -58, p6: 30, p7: 55, p8: -2548, p9: -3419, p10: 30, h1: 766, h2: 1021, h3: 0, h4: 45, h5: 20, h6: 120, h7: -100, gh1: -21, gh2: -13640, gh3: 18 };
const b68T = (a, c) => { const x = a / 16384 - c.t1 / 1024, y = a / 131072 - c.t1 / 8192; return x * c.t2 + y * y * c.t3 * 16; };
const b68P = (a, tf, c) => {
	let v1 = tf / 2 - 64000, v2 = v1 * v1 * (c.p6 / 131072) + v1 * c.p5 * 2; v2 = v2 / 4 + c.p4 * 65536;
	v1 = (1 + ((c.p3 * v1 * v1) / 16384 + c.p2 * v1) / 524288 / 32768) * c.p1;
	const p = ((1048576 - a - v2 / 4096) * 6250) / v1; return p + ((c.p9 * p * p) / 2147483648 + p * (c.p8 / 32768) + (p / 256) ** 3 * (c.p10 / 131072) + c.p7 * 128) / 16;
};
const b68H = (a, tf, c) => { const tc = tf / 5120, v2 = (a - (c.h1 * 16 + (c.h3 / 2) * tc)) * ((c.h2 / 262144) * (1 + (c.h4 / 16384) * tc + (c.h5 / 1048576) * tc * tc)); return v2 + (c.h6 / 16384 + (c.h7 / 2097152) * tc) * v2 * v2; };
const K1 = [0, 0, 0, 0, 0, -1, 0, -0.8, 0, 0, -0.2, -0.5, 0, -1, 0, 0], K2 = [0, 0, 0, 0, 0.1, 0.7, 0, -0.8, -0.1, 0, 0, 0, 0, 0, 0, 0];
const gasLo = (a, rg) => 1 / ((1 + K2[rg] / 100) * 0.000000125 * (1 << rg) * ((a - 512) / (1340 * (1 + K1[rg] / 100)) + 1)), gasHi = (a, rg) => (1e6 * (262144 >> rg)) / (4096 + (a - 512) * 3);
class BME680 extends RegDev {
	constructor(env, spec, address, v688) { super(env, spec, address); this.v688 = v688; this.pairWrite = true; this.conv = new Conv(); this.reset(); }
	reset() {
		const r = this.regs, c = B68; r.fill(0);
		le16(r, 0x8a, c.t2); r[0x8c] = c.t3; le16(r, 0x8e, c.p1); le16(r, 0x90, c.p2); r[0x92] = c.p3; le16(r, 0x94, c.p4); le16(r, 0x96, c.p5); r[0x98] = c.p7; r[0x99] = c.p6;
		le16(r, 0x9c, c.p8); le16(r, 0x9e, c.p9); r[0xa0] = c.p10; r[0xe1] = c.h2 >> 4; r[0xe2] = ((c.h2 & 15) << 4) | (c.h1 & 15); r[0xe3] = c.h1 >> 4;
		r[0xe4] = c.h3; r[0xe5] = c.h4; r[0xe6] = c.h5; r[0xe7] = c.h6; r[0xe8] = c.h7 & 255; le16(r, 0xe9, c.t1); le16(r, 0xeb, c.gh2); r[0xed] = c.gh1 & 255; r[0xee] = c.gh3;
		r[0x00] = 45; r[0x02] = 0x10; r[0xd0] = 0x61; r[0xf0] = this.v688 ? 1 : 0; r[0x1f] = r[0x22] = r[0x25] = 0x80; this.T = this.P = this.H = this.G = NaN;
	}
	gasOn() { return this.regs[0x71] & (this.v688 ? 0x30 : 0x10); }
	wr(a, v) {
		if (a === 0xe0) { if (v === 0xb6) this.reset(); return; }
		if (a < 0x50 || a > 0x75) return; this.regs[a] = v;
		if (a === 0x74 && (v & 3) === 1) {
			const o = f => (f ? 1 << (f - 1) : 0), gw = this.regs[0x64];
			this.conv.begin(this.t(), ((o(v >> 5) + o((v >> 2) & 7) + o(this.regs[0x72] & 7)) * 1963 + 5793) / 1e6 + (this.gasOn() ? ((gw & 63) * [1, 4, 16, 64][gw >> 6]) / 1000 : 0));
			this.regs[0x1d] = 0x20;
		}
	}
	rd(a) { if (a === 0x1d) { this.refresh(); return this.conv.busy(this.t(), true) ? 0x20 : this.regs[a]; } return this.regs[a]; }
	refresh() { if ((this.regs[0x74] & 3) === 1 && !this.conv.busy(this.t())) { this.sample(); this.regs[0x74] &= ~3; } }
	sample() {
		const c = B68, r = this.regs, T = wT(this), P = wP(this), H = wH(this), G = this.w('gasOhm') * (1 + this.nz(0.01));
		const aT = solve(x => b68T(x, c) / 5120, T, 0, 0xfffff), tf = b68T(aT, c);
		put20(r, 0x22, aT); put20(r, 0x1f, solve(x => b68P(x, tf, c), P, 0, 0xfffff, false)); const h = solve(x => b68H(x, tf, c), H, 0, 0xffff); r[0x25] = h >> 8; r[0x26] = h & 255;
		let rg = 0, a = 512; for (; rg < 15; rg++) { a = solve(x => (this.v688 ? gasHi : gasLo)(x, rg), G, 0, 1023, false); if (a > 0 && a < 1023) break; }
		r[this.v688 ? 0x2c : 0x2a] = a >> 2; r[this.v688 ? 0x2d : 0x2b] = ((a & 3) << 6) | (this.gasOn() ? 0x30 : 0) | rg; r[0x1d] = 0x80;
		Object.assign(this, { T, P, H, G: this.gasOn() ? G : NaN }); this.version++;
	}
	status() { return `${this.name}${this.at()} · ${fx(this.T)} °C · ${fx(this.P / 100, 0)} hPa · ${fx(this.H, 0)} %RH${this.G > 0 ? ' · ' + fx(this.G / 1000, 0) + ' kΩ' : ''}`; }
}

// ---- Sensirion SHT3x / SHT4x / SHTC3, Aosong AHT10/AHT20: commands in, CRC-protected words out
const shtWord = v => [v >> 8, v & 255, crc8([v >> 8, v & 255])];
const shtT = T => Math.round(clamp((T + 45) / 175, 0, 1) * 65535);
class SHT3x extends I2CDev {
	constructor(env, spec, address) { super(env, spec, address); this.conv = new Conv(); this.out = []; this.stat = 0x8010; this.heat = false; this.per = false; this.T = this.H = NaN; }
	measure() { const T = wT(this) + (this.heat ? 3 : 0), H = clamp(wH(this) - (this.heat ? 8 : 0), 0, 100); this.T = T; this.H = H; this.version++; return [...shtWord(shtT(T)), ...shtWord(Math.round((H / 100) * 65535))]; }
	start(read) { if (!read) { this.cmd = []; return true; } if (this.per || !this.conv.busy(this.t())) return true; if (this.stretch) { this.conv.end = this.t(); return true; } return false; }
	write(b) {
		this.cmd.push(b); if (this.cmd.length < 2) return true;
		const c = (this.cmd[0] << 8) | b, hi = c >> 8, lo = c & 255; this.out = [];
		if (hi === 0x24 || hi === 0x2c) { this.stretch = hi === 0x2c; this.per = false; this.pend = true; this.conv.begin(this.t(), lo === 0 || lo === 6 ? 0.0155 : lo === 0x0b || lo === 0x0d ? 0.0065 : 0.0045); }
		else if ((hi >= 0x20 && hi <= 0x27) || c === 0x2b32) this.per = true;
		else if (c === 0xe000) this.out = this.measure();
		else if (c === 0xf32d) this.out = shtWord(this.stat | (this.heat ? 0x2000 : 0));
		else if (c === 0x3041) this.stat &= ~0x8013;
		else if (c === 0x30a2) { this.heat = this.per = false; this.stat = 0x8010; }
		else if (c === 0x306d || c === 0x3066) this.heat = c === 0x306d;
		else if (c === 0x3093) this.per = false;
		else if (c === 0x3780 || c === 0x3682) this.out = [...shtWord(0x1234), ...shtWord(0x5678)];
		return true;
	}
	read() { if (this.pend) { this.out = this.measure(); this.pend = false; } return this.out.length ? this.out.shift() : 0xff; }
	status() { return `SHT3x${this.at()} · ${fx(this.T)} °C · ${fx(this.H, 0)} %RH${this.heat ? ' · heater' : ''}`; }
}
class SHT4x extends I2CDev {
	constructor(env, spec, address) { super(env, spec, address); this.conv = new Conv(); this.out = []; this.T = this.H = NaN; }
	start(read) { return !(read && this.conv.busy(this.t())); }
	write(b, i) {
		if (i) return true;
		const heat = { 0x39: [1.1, 10], 0x32: [0.11, 4], 0x2f: [1.1, 6], 0x24: [0.11, 2.5], 0x1e: [1.1, 2], 0x15: [0.11, 1] }[b];
		if (b === 0xfd || b === 0xf6 || b === 0xe0 || heat) {
			this.conv.begin(this.t(), heat ? heat[0] : b === 0xfd ? 0.0083 : b === 0xf6 ? 0.0045 : 0.0017);
			const dT = heat ? heat[1] : 0, T = wT(this) + dT, H = clamp(wH(this) - dT * 2.5, 0, 100); this.T = T; this.H = H; this.version++;
			this.out = [...shtWord(shtT(T)), ...shtWord(Math.round(clamp((H + 6) / 125, 0, 1) * 65535))];
		} else if (b === 0x89) this.out = [...shtWord(0x0a1b), ...shtWord(0x2c3d)];
		return true;
	}
	read() { return this.out.length ? this.out.shift() : 0xff; }
	status() { return `SHT4x${this.at()} · ${fx(this.T)} °C · ${fx(this.H, 0)} %RH`; }
}
class SHTC3 extends I2CDev {
	constructor(env, spec, address) { super(env, spec, address); this.awake = false; this.out = []; this.cmd = []; this.conv = new Conv(); this.T = this.H = NaN; }
	start(read) { if (!read) { this.cmd = []; return true; } return this.awake && (this.stretch || !this.conv.busy(this.t())); }
	write(b) {
		if (!this.awake && b !== (this.cmd.length ? 0x17 : 0x35)) return false;
		this.cmd.push(b); if (this.cmd.length < 2) return true;
		const c = (this.cmd[0] << 8) | b; this.cmd = [];
		if (c === 0x3517 || c === 0xb098) this.awake = c === 0x3517;
		else if (c === 0xefc8) this.out = shtWord(0x0807);
		else if ([0x7ca2, 0x7866, 0x5c24, 0x58e0, 0x6458, 0x609c, 0x44de, 0x401a].includes(c)) {
			const tFirst = [0x7ca2, 0x7866, 0x6458, 0x609c].includes(c); this.stretch = [0x7ca2, 0x5c24, 0x6458, 0x44de].includes(c);
			this.conv.begin(this.t(), c >> 12 === 6 || c >> 12 === 4 ? 0.0008 : 0.0121);
			const T = (this.T = wT(this)), H = (this.H = wH(this)), t = shtWord(shtT(T)), h = shtWord(Math.round((H / 100) * 65535)); this.version++;
			this.out = tFirst ? [...t, ...h] : [...h, ...t];
		}
		return true;
	}
	read() { return this.out.length ? this.out.shift() : 0xff; }
	status() { return `SHTC3${this.at()} · ${this.awake ? 'awake' : 'sleep'} · ${fx(this.T)} °C · ${fx(this.H, 0)} %RH`; }
}
class AHT extends I2CDev {
	constructor(env, spec, address, v20) { super(env, spec, address); this.v20 = v20; this.cal = !!v20; this.conv = new Conv(); this.data = [0, 0, 0, 0, 0, 0]; this.T = this.H = NaN; }
	start(read) { if (read) this.i = 0; else this.cmd = []; return true; }
	write(b) {
		const c = this.cmd; c.push(b);
		if (c.length === 1 && b === 0xba) this.cal = !!this.v20;
		if (c.length === 3 && c[0] === 0xac) { this.conv.begin(this.t(), 0.08); this.fresh = true; }
		if (c.length === 3 && (c[0] === 0xbe || c[0] === 0xe1)) this.cal = true;
		return true;
	}
	read() {
		const busy = this.conv.busy(this.t(), this.i === 0);
		if (this.i === 0 && !busy && this.fresh) {
			this.fresh = false; const T = (this.T = wT(this)), H = (this.H = wH(this)); this.version++;
			const h = Math.round((H / 100) * 1048576) & 0xfffff, t = Math.round(clamp((T + 50) / 200, 0, 1) * 1048575);
			this.data = [0, h >> 12, (h >> 4) & 255, ((h & 15) << 4) | (t >> 16), (t >> 8) & 255, t & 255];
		}
		const o = [(busy ? 0x80 : 0) | (this.cal ? 0x08 : 0) | 0x10, ...this.data.slice(1)]; o.push(crc8(o));
		return o[this.i++] ?? 0xff;
	}
	status() { return `${this.name}${this.at()} · ${fx(this.T)} °C · ${fx(this.H, 0)} %RH`; }
}
// ---- temperature sensors with 16-bit registers: TMP102/112, LM75 family
// o: { enc(T) → temperature register, regs: { reg: [reset value, writable mask] }, wide: { reg: bytes } }
class TempReg extends WordDev {
	constructor(env, spec, address, o) { super(env, spec, address); this.o = o; this.wide = o.wide; this.R = {}; for (const k in o.regs) this.R[k] = o.regs[k][0]; this.T = NaN; }
	rdw(r) { if (r === (this.o.treg || 0)) { this.T = this.w('tempC') + this.nz(0.03); this.version++; return this.o.enc(this.T, this) & 0xffff; } return this.R[r] ?? 0; }
	wrw(r, v) { const d = this.o.regs[r]; if (d) this.R[r] = (this.R[r] & ~d[1]) | (v & d[1]); }
	status() { return `${this.name}${this.at()} · ${fx(this.T, 2)} °C`; }
}
const TMP10X = { enc: T => Math.round(T * 16) << 4, regs: { 1: [0x60a0, 0x9f10], 2: [0x4b00, 0xfff0], 3: [0x5000, 0xfff0] } };
const LM75 = bits => ({ enc: T => Math.round(T * 2 ** (bits - 8)) << (16 - bits), wide: { 1: 1 }, regs: { 1: [0, 0x1f], 2: [0x4b00, 0xff80], 3: [0x5000, 0xff80] } });
// ---- CFSensor XGZP6857D gauge pressure (world.gaugePa): start 0x30 = 0x0A, poll Sco, read 24-bit pressure
class XGZP extends RegDev {
	constructor(env, spec, address) { super(env, spec, address); this.conv = new Conv(); this.P = NaN; }
	wr(a, v) { this.regs[a] = v; if (a === 0x30 && (v & 15) === 0x0a) { this.conv.begin(this.t(), 0.02); this.pend = true; } }
	rd(a) {
		if (a === 0x30) return this.regs[a] & (this.conv.busy(this.t(), true) ? 0xff : ~0x08);
		if (a >= 6 && a <= 10 && this.pend && !this.conv.busy(this.t())) { this.pend = false; this.P = this.w('gaugePa') + this.nz(2); const p = Math.round(this.P * 64) & 0xffffff, t = Math.round(this.w('tempC') * 256) & 0xffff; this.regs.set([p >> 16, (p >> 8) & 255, p & 255, t >> 8, t & 255], 6); this.version++; }
		return this.regs[a];
	}
	status() { return `XGZP6857D${this.at()} · ${fx(this.P / 1000, 2)} kPa`; }
}

// ---- templates
const TPH = { roles: { addr: ['SDO', 'SA0', 'ADDR', 'ADD0', 'A0', 'SDO/SA0', 'AD0', 'ADR'] }, addr: A1(0x76, 1) }, TPA = [0x76, 0x77];
T('bme280', 'BME280', 'i2c+spi', /\bBME280/, TPA, [BME280, true], TPH);
T('bmp280', 'BMP280', 'i2c+spi', /\bBMP280/, TPA, [BME280, false], TPH);
T('bme688', 'BME688', 'i2c+spi', /\bBME688/, TPA, [BME680, true], TPH);
T('bme680', 'BME680', 'i2c+spi', /\bBME680/, TPA, [BME680, false], TPH);
T('sht3x', 'SHT3x', 'i2c', /\bSHT3[015]|\bSHT85|\bGXHT3/, [0x44, 0x45], SHT3x, { roles: { addr: ['ADDR', 'ADR', 'A0'] }, addr: A1(0x44) });
T('shtc3', 'SHTC3', 'i2c', /\bSHTC[13]\b/, [0x70], SHTC3);
T('sht4x', 'SHT4x', 'i2c', /\bSHT4[0-5X]/, [0x44, 0x45, 0x46], SHT4x, { params: t => ({ b: /SHT4\d-?B/.test(t) }), addr: (L, p) => (p.b ? 0x45 : 0x44) });
T('aht20', 'AHT20', 'i2c', /\bAHT2\d|\bDHT20\b|\bAHT3\d/, [0x38], [AHT, true]);
T('aht10', 'AHT10', 'i2c', /\bAHT1\d/, [0x38, 0x39], [AHT, false], { roles: { addr: ['ADR', 'ADDR'] }, addr: A1(0x38) });
const ADD0 = { roles: { addr: ['ADD0', 'A0', 'ADDR', 'ADR'] }, addr: L => 0x48 + lvl4(L.addr) };
T('tmp102', 'TMP102', 'i2c', /\bTMP1(02|12)/, range(0x48, 4), [TempReg, TMP10X], Object.assign({ params: t => ({ name: /TMP112/.test(t) ? 'TMP112' : 'TMP102' }) }, ADD0));
T('lm75', 'LM75', 'i2c', /\b(LM75[AB]?|PCT2075|TMP75|TMP275|STLM75|DS75|AT30TS75|MAX7500)/, range(0x48, 8), (e, p, a) => new TempReg(e, p, a, LM75(p.bits)),
	{ params: t => ({ bits: /LM75B|PCT2075/.test(t) ? 11 : /LM75A?\b|STLM75/.test(t) ? 9 : 12, name: /(LM75[AB]?|PCT2075|TMP2?75|STLM75|DS75|AT30TS75|MAX7500)/.exec(t)[0] }), addr: A3(0x48) });
T('xgzp6857d', 'XGZP6857D', 'i2c', /\bXGZP\d{4}/, [0x6d], XGZP);

// ==== IMUs, magnetometers, angle sensors
const G0 = 9.80665;
// world → accel in g, rates in °/s, field in µT (device frame), die temperature; with noise
const imuRead = d => ({ a: [0, 1, 2].map(i => d.wv('accel', i) / G0 + d.nz(0.002)), r: [0, 1, 2].map(i => d.wv('gyro', i) + d.nz(0.03)),
	m: [0, 1, 2].map(i => d.wv('mag', i) + d.nz(0.15)), T: d.w('tempC') + d.nz(0.05) });
const putv = (r, a, v, k, le) => v.forEach((x, i) => put16(r, a + 2 * i, sat16(x * k), le));   // vector of s16 at a, a+2 …
const fmtA = a => a.map(v => fx(v, 2)).join(' ');
// register-file sensor: o.size registers (128), o.init reset values; subclasses sample on reads of their data block
class IMU extends RegDev {
	constructor(env, spec, address, o = {}) { super(env, spec, address, o.size || 128); this.o = o; this.reset(); }
	reset() { this.regs.fill(0); Object.assign(this.regs, this.o.init); this.s = null; }
	status() { return `${this.name}${this.at()}${this.s ? ' · a ' + fmtA(this.s.a) + ' g' : ''}`; }
}

// ---- InvenSense MPU-6000/6050 and MPU-9250/9255 (one register map; the 9250 magnetometer is not modelled)
class MPU6050 extends IMU {
	constructor(env, spec, address, o) { super(env, spec, address, Object.assign({ init: { 0x6b: 0x40, 0x75: o.who } }, o)); }
	wr(a, v) {
		if (a === 0x6b && v & 0x80) return this.reset();
		if (a !== 0x75 && (a < 0x3a || a > 0x48)) this.regs[a] = a === 0x68 ? 0 : a === 0x6a ? v & ~7 : v;   // reset bits self-clear
	}
	refresh(p) { if (p >= 0x3a && p <= 0x48 && !(this.regs[0x6b] & 0x40)) this.sample(); }
	sample() {
		const s = (this.s = imuRead(this)), r = this.regs;
		putv(r, 0x3b, s.a, 16384 >> ((r[0x1c] >> 3) & 3)); putv(r, 0x43, s.r, 131 / (1 << ((r[0x1b] >> 3) & 3)));
		put16(r, 0x41, sat16((s.T - this.o.t0) * this.o.ts)); r[0x3a] |= 1; this.version++;
	}
	rd(a) { const v = this.regs[a]; if (a === 0x3a) this.regs[a] &= ~1; return v; }
	status() { return super.status() + (this.regs[0x6b] & 0x40 ? ' · sleep' : ''); }
}
// ---- ICM-20948: 4 register banks (the AK09916 magnetometer behind its auxiliary I2C master is not modelled)
class ICM20948 extends IMU {
	reset() {
		const b = (this.banks = this.banks || [0, 1, 2, 3].map(() => new Uint8Array(128))); b.forEach(x => x.fill(0));
		Object.assign(b[0], { 0: 0xea, 5: 0x40, 6: 0x41 }); b[2][1] = b[2][0x14] = 1; this.bank = 0; this.regs = b[0]; this.s = null;
	}
	wr(a, v) {
		const B = this.banks;
		if (a === 0x7f) { this.bank = (v >> 4) & 3; this.regs = B[this.bank]; B.forEach(x => (x[0x7f] = v & 0x30)); return; }
		if (!this.bank) { if (a === 6 && v & 0x80) return this.reset(); if (!a || (a >= 0x2d && a <= 0x52)) return; if (a === 3) v &= ~0x0e; }
		this.regs[a] = v;
	}
	refresh(p) { if (!this.bank && p >= 0x2d && p <= 0x52 && !(this.regs[6] & 0x40)) this.sample(); }
	sample() {
		const [b0, , b2] = this.banks, s = (this.s = imuRead(this));
		putv(b0, 0x2d, s.a, 16384 >> ((b2[0x14] >> 1) & 3)); putv(b0, 0x33, s.r, 131 / (1 << ((b2[1] >> 1) & 3))); put16(b0, 0x39, sat16((s.T - 21) * 333.87)); b0[0x1a] |= 1; this.version++;
	}
}

// ---- TDK ICM-42670-P: WHO_AM_I 0x67, PWR_MGMT0 modes, ranges, big-endian data (-32768 while a sensor is off)
class ICM42670 extends IMU {
	reset() { super.reset(); Object.assign(this.regs, { 0x75: 0x67, 0x20: 6, 0x21: 6 }); }
	wr(a, v) { if (a === 2 && v & 0x10) this.reset(); else if (a !== 0x75 && (a < 9 || a > 0x16)) this.regs[a] = v; }
	refresh(p) {
		if (p < 9 || p > 0x16) return;
		const r = this.regs, pm = r[0x1f], s = (this.s = imuRead(this)), off = [-1, -1, -1];
		putv(r, 0x0b, pm & 3 ? s.a : off, pm & 3 ? 2048 << ((r[0x21] >> 5) & 3) : 32768);
		putv(r, 0x11, pm & 12 ? s.r : off, pm & 12 ? 16.4 * (1 << ((r[0x20] >> 5) & 3)) : 32768);
		put16(r, 9, sat16((s.T - 25) * 128)); r[0x39] |= 1; this.version++;
	}
}

// ---- Bosch BNO055: IDs, OPR_MODE, raw data (1 m/s² = 100, 1 µT = 16, 1 °/s = 16 LSB); fusion modes add Euler angles from world accel + mag (no quaternion)
class BNO055 extends IMU {
	reset() { super.reset(); Object.assign(this.regs, { 0: 0xa0, 1: 0xfb, 2: 0x32, 3: 0x0f, 4: 0x11, 5: 3, 0x36: 0x0f }); }
	wr(a, v) {
		const r = this.regs;
		if (a === 0x3f && v & 0x20) this.reset();
		else if (a === 0x3d) { r[a] = v &= 15; r[0x39] = v ? (v < 8 ? 6 : 5) : 0; r[0x35] = v < 8 ? 0 : 0xff; }
		else if (a > 0x3a) r[a] = v;
	}
	refresh(p) {
		if (p < 8 || p > 0x34) return;
		const r = this.regs, s = (this.s = imuRead(this)), a = s.a, m = s.m, k = 180 / Math.PI, C = Math.cos, S = Math.sin;
		const rl = Math.atan2(a[1], a[2]), pt = Math.atan2(-a[0], Math.hypot(a[1], a[2])), mx = m[0] * C(pt) + m[2] * S(pt), my = m[0] * S(rl) * S(pt) + m[1] * C(rl) - m[2] * S(rl) * C(pt);
		putv(r, 8, a, 100 * G0, true); putv(r, 0x0e, m, 16, true); putv(r, 0x14, s.r, 16, true);
		if (r[0x3d] >= 8) putv(r, 0x1a, [(Math.atan2(-my, mx) * k + 360) % 360, rl * k, pt * k], 16, true);
		r[0x34] = Math.round(s.T) & 255; this.version++;
	}
}

// ---- ST LSM6DS3 / DS33 / DSO / DSOX / DSO32 (little-endian, IF_INC in CTRL3_C)
class LSM6DS extends IMU {
	reset() { super.reset(); this.regs[0x0f] = this.o.who; this.regs[0x12] = 4; }
	next(r) { return this.regs[0x12] & 4 ? (r + 1) & 0x7f : r; }
	wr(a, v) { if (a === 0x12 && v & 1) this.reset(); else if (a !== 0x0f && (a < 0x1e || a > 0x2d)) this.regs[a] = a === 0x12 ? v & ~0x80 : v; }
	refresh(p) {
		if (p < 0x1e || p > 0x2d) return;
		const r = this.regs, s = (this.s = imuRead(this)), xl = r[0x10] >> 4, g = r[0x11] >> 4;
		if (xl) putv(r, 0x28, s.a, 2000 / (0.061 * [2, 16, 4, 8][(r[0x10] >> 2) & 3]), true);
		if (g) putv(r, 0x22, s.r, 250000 / (8.75 * (r[0x11] & 2 ? 125 : [250, 500, 1000, 2000][(r[0x11] >> 2) & 3])), true);
		put16(r, 0x20, sat16((s.T - 25) * this.o.ts), true); r[0x1e] = (xl ? 1 : 0) | (g ? 2 : 0) | 4; this.version++;
	}
}

// ---- ST LIS3DH / LIS2DH12 (sub-address bit 7 = auto-increment; LP 8 / normal 10 / HR 12 bit, left-justified)
class LIS3DH extends IMU {
	reset() { super.reset(); Object.assign(this.regs, { 0x0f: 0x33, 0x1e: 0x10, 0x20: 7 }); this.inc = false; }
	sub(b) { this.inc = !!(b & 0x80); return b & 0x7f; }
	next(r) { return this.inc ? (r + 1) & 0x7f : r; }
	wr(a, v) { if (a === 0x24 && v & 0x80) this.reset(); else if (a !== 0x0f && (a < 7 || a > 0x0d) && (a < 0x27 || a > 0x2d)) this.regs[a] = v; }
	refresh(p) {
		const r = this.regs; if (!((p >= 0x27 && p <= 0x2d) || (p >= 7 && p <= 0x0d)) || !(r[0x20] >> 4)) return;
		const s = (this.s = imuRead(this)), lp = r[0x20] & 8, hr = r[0x23] & 8, n = lp ? 8 : hr ? 12 : 10, M = 1 << (n - 1);
		const sens = (lp ? [16, 32, 64, 192] : hr ? [1, 2, 4, 12] : [4, 8, 16, 48])[(r[0x23] >> 4) & 3];   // mg / digit
		s.a.forEach((v, i) => put16(r, 0x28 + 2 * i, clamp(Math.round((v * 1000) / sens), -M, M - 1) << (16 - n), true));
		if ((r[0x1f] & 0xc0) === 0xc0) put16(r, 0x0c, clamp(Math.round(s.T - 25), -128, 127) << 8, true);
		r[0x27] = 0x0f; r[7] = 0x44; this.version++;
	}
}

// ---- Bosch BMI270 (config file upload → INTERNAL_STATUS init_ok)
class BMI270 extends IMU {
	reset() { super.reset(); Object.assign(this.regs, { 0: 0x24, 0x40: 0xa8, 0x41: 2, 0x42: 0xa9, 0x7c: 3 }); this.cfgBytes = 0; }
	next(r) { return r === 0x5e ? r : (r + 1) & 0x7f; }   // INIT_DATA burst stays on 0x5E
	wr(a, v) {
		if (a === 0x7e) { if (v === 0xb6) this.reset(); }
		else if (a === 0x5e) this.cfgBytes++;
		else if (a >= 0x40) { this.regs[a] = v; if (a === 0x59 && v & 1) this.regs[0x21] = 1; }
	}
	refresh(p) {
		if (p < 0x0c || p > 0x23) return;
		const r = this.regs, s = (this.s = imuRead(this)), pc = r[0x7d];
		if (pc & 4) putv(r, 0x0c, s.a, 32768 / [2, 4, 8, 16][r[0x41] & 3], true);
		if (pc & 2) putv(r, 0x12, s.r, 32768 / ([2000, 1000, 500, 250, 125][r[0x43] & 7] || 2000), true);
		put16(r, 0x22, sat16((s.T - 23) * 512), true); r[3] = (pc & 4 ? 0x80 : 0) | (pc & 2 ? 0x40 : 0) | 0x10; this.version++;
	}
	status() { return super.status() + (this.regs[0x21] & 1 ? '' : ' · no config'); }
}

// ---- magnetic angle sensors (world.angleDeg): AS5600 (I2C), MT6701 (I2C + SSI)
const angle = d => (((d.w('angleDeg') + d.nz(0.02)) % 360) + 360) % 360;
class AS5600 extends RegDev {
	constructor(env, spec, address) { super(env, spec, address); this.a = 0; }
	wr(a, v) { if (a <= 8) this.regs[a] = v; else if (a === 0xff && v === 0x80) this.regs[0] = Math.min(3, this.regs[0] + 1); }   // BURN_ANGLE counts ZMCO
	refresh() {
		const r = this.regs, raw = (this.a = Math.round((angle(this) / 360) * 4096) & 0xfff), g = a => ((r[a] & 15) << 8) | r[a + 1], zp = g(1), mp = g(3);
		const span = mp ? (mp - zp + 4096) % 4096 || 4096 : g(5) || 4096;
		put16(r, 0x0c, raw); put16(r, 0x0e, clamp(Math.round((((raw - zp + 4096) % 4096) / span) * 4096), 0, 4095)); r[0x0b] = 0x20; r[0x1a] = 0x80; put16(r, 0x1b, 1800);
	}
	status() { return `AS5600${this.at()} · ${fx((this.a * 360) / 4096, 1)}°`; }
}
class MT6701 extends RegDev {
	constructor(env, spec, address) { super(env, spec, address); this.a = 0; }
	raw() { return (this.a = Math.round((angle(this) / 360) * 16384) & 0x3fff); }
	refresh(p) { if (p === 3 || p === 4) { const v = this.raw(); this.regs[3] = v >> 6; this.regs[4] = (v & 0x3f) << 2; } }
	wr(a, v) { if (a > 4) this.regs[a] = v; }
	// SSI through the SPI object: CSN low, 24 clocks = 14-bit angle, 4 status bits, CRC-6 (x^6 + x + 1)
	spiSelect(on) {
		if (!on) return; const d = this.raw() << 4; let c = 0;
		for (let i = 17; i >= 0; i--) c = ((c << 1) & 0x3f) ^ (((d >> i) ^ (c >> 5)) & 1 ? 3 : 0);
		const f = (d << 6) | c; this.ssi = [f >> 16, (f >> 8) & 255, f & 255]; this.si = 0;
	}
	spiTransfer() { return this.ssi && this.si < 3 ? this.ssi[this.si++] : 0xff; }
	status() { return `MT6701${this.at()} · ${fx((this.a * 360) / 16384, 1)}°`; }
}
const SA0 = { roles: { addr: ['SDO/SA0', 'SA0', 'SDO', 'AD0', 'SDO/AD0', 'ADDR', 'AP_SDO/AP_AD0', 'AP_AD0', 'AP_SDO'] }, addr: A1(0x68) }, A68 = [0x68, 0x69];
const mpu = (id, name, re, o) => T(id, name, id === 'mpu6050' ? 'i2c' : 'i2c+spi', re, A68, [MPU6050, o], SA0);
mpu('mpu9250', 'MPU-9250', /\bMPU-?925[05]/, { who: 0x71, t0: 21, ts: 333.87 });
mpu('mpu6050', 'MPU-6050', /\bMPU-?60[05]0|\bGY-521\b/, { who: 0x68, t0: 36.53, ts: 340 });
T('icm20948', 'ICM-20948', 'i2c+spi', /\bICM-?2094[58]/, A68, ICM20948, { roles: SA0.roles, addr: A1(0x68, 1) });
T('icm42670', 'ICM-42670-P', 'i2c+spi', /\bICM-?42670/, A68, ICM42670, SA0);
T('bno055', 'BNO055', 'i2c', /\bBNO055/, [0x28, 0x29], BNO055, { roles: { addr: ['COM3', 'ADR', 'ADDR'], sda: ['COM0', 'SDA'], scl: ['COM1', 'SCL'] }, addr: A1(0x28) });
const lsm = (id, name, re, who, ts) => T(id, name, 'i2c+spi', re, [0x6a, 0x6b], (e, p, a) => new LSM6DS(e, p, a, { who, ts }), { roles: SA0.roles, addr: A1(0x6a) });
lsm('lsm6dsox', 'LSM6DSOX', /\bLSM6DSO(X|32)?\b|\bLSM6DSO[X3]/, 0x6c, 256);
lsm('lsm6ds3', 'LSM6DS3', /\bLSM6DS3|\bLSM6DS33/, 0x69, 16);
T('lis3dh', 'LIS3DH', 'i2c+spi', /\bLIS3DH|\bLIS2D[HX]12|\bLIS2DH\b/, [0x18, 0x19], LIS3DH,
	{ roles: SA0.roles, addr: A1(0x18, 1), params: t => ({ name: /LIS2D/.test(t) ? 'LIS2DH12' : 'LIS3DH' }) });
T('bmi270', 'BMI270', 'i2c+spi', /\bBMI270/, A68, BMI270, SA0);
T('as5600', 'AS5600', 'i2c', /\bAS5600/, [0x36], AS5600);
T('mt6701', 'MT6701', 'i2c+spi', /\bMT6701/, [0x06], MT6701,
	{ roles: { sda: ['A/U/SDA/DO', 'SDA'], scl: ['B/V/SCL/CLK', 'SCL'], miso: ['A/U/SDA/DO', 'DO'], sck: ['B/V/SCL/CLK', 'CLK'], cs: ['Z/W/CSN', 'CSN'] } });

// ==== light sensors
const luxOf = (d, n) => (d.L = Math.max(0, d.w('lux') * (1 + d.nz(n))));
class BH1750D extends I2CDev {   // opcodes: power, reset, continuous / one-time H, H2, L modes, MTreg (0x40 | hi3, 0x60 | lo5)
	constructor(env, spec, address) { super(env, spec, address); this.on = false; this.mode = 0; this.mt = 69; this.conv = new Conv(); this.val = 0; this.L = NaN; }
	tm() { return (((this.mode & 3) === 3 ? 0.016 : 0.12) * this.mt) / 69; }
	write(b) {
		if (b < 2) this.on = !!b;
		else if (b === 7) { if (this.on) this.val = 0; }
		else if ((b & 0xf8) === 0x40) this.mt = (this.mt & 0x1f) | ((b & 7) << 5);
		else if ((b & 0xe0) === 0x60) this.mt = (this.mt & 0xe0) | (b & 0x1f);
		else if ([0x10, 0x11, 0x13, 0x20, 0x21, 0x23].includes(b)) { this.mode = b; this.on = this.pend = true; this.conv.begin(this.t(), this.tm()); }
		return true;
	}
	start(read) {
		if (!read) return true; this.i = 0;
		if (this.pend && !this.conv.busy(this.t())) {
			const m = this.mode & 3, c = luxOf(this, 0.005) * 1.2 * (this.mt / 69) * (m === 1 ? 2 : 1);
			this.val = clamp(Math.round(m === 3 ? Math.floor(c / 4) * 4 : c), 0, 65535); this.version++;
			if (this.mode & 0x20) this.pend = this.on = false; else this.conv.begin(this.t(), this.tm());
		}
		return true;
	}
	read() { return this.i++ ? this.val & 255 : this.val >> 8; }
	status() { return `BH1750${this.at()} · ${this.on ? fx(this.L, 0) + ' lx' : 'power down'}`; }
}
class VEML7700 extends WordDev {   // little-endian words; ALS/WHITE counts need one integration time after power-on
	constructor(env, spec, address) { super(env, spec, address); this.le = true; this.R = [1, 0, 0, 0]; this.t0 = 0; this.L = NaN; }
	itms() { return { 12: 25, 8: 50, 0: 100, 1: 200, 2: 400, 3: 800 }[(this.R[0] >> 6) & 15] || 100; }
	rdw(r) {
		if (r === 7) return 0xc481;
		if (r !== 4 && r !== 5) return this.R[r] || 0;
		const c = this.R[0]; if (c & 1 || this.t() - this.t0 < this.itms() / 1000) return 0;
		const res = 0.0036 * (800 / this.itms()) * (2 / [1, 2, 0.125, 0.25][(c >> 11) & 3]); this.version++;
		return clamp(Math.round((luxOf(this, 0.005) / res) * (r === 5 ? 1.1 : 1)), 0, 65535);
	}
	wrw(r, v) { if (r === 0) { if (this.R[0] & 1 && !(v & 1)) this.t0 = this.t(); v &= 0x1bf3; } if (r === 3) v &= 7; if (r < 4) this.R[r] = v; }
	status() { return `VEML7700${this.at()} · ${this.R[0] & 1 ? 'shutdown' : fx(this.L, 1) + ' lx'}`; }
}
// ==== current / power monitors
// shunt voltage from the circuit (IN+ − IN−) when the runtime knows it, else world.currentA × Rshunt
const shuntV = (d, rs) => { const p = d.volts('vinp', null), m = d.volts('vinm', null); return p != null && m != null ? p - m : d.w('currentA') * rs + d.nz(2e-6); };
const pmStatus = d => `${d.name}${d.at()} · ${fx(d.vb, 2)} V · ${fx((d.vs / d.rs) * 1000, 1)} mA`;
class INA219 extends WordDev {
	constructor(env, spec, address) { super(env, spec, address); this.rs = spec.rshunt || 0.1; this.reset(); }
	reset() { this.cfg = 0x399f; this.cal = this.cnvr = this.vs = this.vb = 0; }
	rdw(r) {
		if (this.cfg & 7 && r <= 4) { this.vs = shuntV(this, this.rs); this.vb = this.volts('vinm', this.volts('vbus', this.w('busV'))); this.cnvr = 1; this.version++; }
		const lim = 4000 << ((this.cfg >> 11) & 3), sh = clamp(Math.round(this.vs / 10e-6), -lim, lim), cur = Math.trunc((sh * this.cal) / 4096), b = clamp(Math.round(this.vb / 0.004), 0, 8000);
		switch (r) {
			case 0: return this.cfg; case 1: return sh & 0xffff; case 4: return cur & 0xffff; case 5: return this.cal;
			case 2: return (b << 3) | (this.cnvr ? 2 : 0) | (this.vb > (this.cfg & 0x2000 ? 32 : 16) ? 1 : 0);
			case 3: this.cnvr = 0; return Math.trunc((Math.abs(cur) * b) / 5000) & 0xffff;
		}
		return 0;
	}
	wrw(r, v) { if (r === 0) { if (v & 0x8000) this.reset(); else this.cfg = v; } else if (r === 5) this.cal = v & 0xfffe; }
	status() { return pmStatus(this); }
}
class INA233 extends I2CDev {   // PMBus: little-endian words, block reads (count byte first), READ_EIN accumulator
	constructor(env, spec, address) { super(env, spec, address); this.rs = spec.rshunt || 0.01; this.reset(); }
	reset() { Object.assign(this, { cal: 1, adc: 0x4127, devcfg: 2, amask: 0xf0, lim: {}, vs: 0, vb: 0, acc: 0, cnt: 0, pmax: 0, st: 0, out: [] }); }
	start(read) { if (read) this.oi = 0; else this.cmd = []; return true; }
	write(b) {
		const x = this.cmd; x.push(b); const c = x[0], n = x.length, w = v => [v & 255, (v >> 8) & 255], txt = s => [s.length, ...toBytes(s)];
		if (n === 1) {
			this.vs = shuntV(this, this.rs); this.vb = this.volts('vbus', this.volts('vinm', this.w('busV')));
			const sh = clamp(Math.round(this.vs / 2.5e-6), -32768, 32767), bu = clamp(Math.round(this.vb / 0.00125), 0, 0x7fff);
			const i = clamp(Math.trunc((sh * this.cal) / 2048), -32768, 32767), pw = clamp(Math.trunc((Math.abs(i) * bu) / 20000), 0, 65535);
			this.acc += pw; this.cnt++; if (this.acc > 0xffffff) { this.acc -= 0x1000000; this.pmax = (this.pmax + 1) & 255; } this.version++;
			const R = { 0x19: [0xb0], 0x20: [0x1f], 0x79: w(this.st), 0x86: [6, this.acc & 255, (this.acc >> 8) & 255, this.pmax, this.cnt & 255, (this.cnt >> 8) & 255, (this.cnt >> 16) & 255],
				0x88: w(bu), 0x89: w(i), 0x8b: w(bu), 0x8c: w(i), 0x96: w(pw), 0x97: w(pw), 0x98: [0x22], 0x99: txt('TI'), 0x9a: txt('INA233'), 0x9b: txt('A0'),
				0xd0: w(this.adc), 0xd1: w(sh), 0xd2: [this.amask], 0xd4: w(this.cal), 0xd5: [this.devcfg], 0xe0: toBytes('TI'), 0xe1: toBytes('33'), 0xe2: toBytes('A0') };
			this.out = R[c] || (c in this.lim ? w(this.lim[c]) : { 0x4a: w(0x7ff8), 0x4f: w(0x7fff), 0x57: w(0x7fff) }[c] || (c >= 0x7a && c <= 0x80 ? [0] : []));
			if (c === 3) this.st = 0; else if (c === 0x12) this.reset(); else if (c === 0xd6) this.acc = this.cnt = this.pmax = 0;
		} else if (c === 0xd4 && n === 3) this.cal = (x[1] | (b << 8)) & 0x7fff;
		else if (c === 0xd0 && n === 3) { const v = x[1] | (b << 8); if (v & 0x8000) this.reset(); else this.adc = v; }
		else if (c === 0xd5 && n === 2) this.devcfg = b;
		else if (c === 0xd2 && n === 2) this.amask = b;
		else if ([0x4a, 0x4f, 0x57, 0x6b, 0x7a].includes(c) && n === 3) this.lim[c] = x[1] | (b << 8);
		return true;
	}
	read() { return this.oi < this.out.length ? this.out[this.oi++] : 0xff; }
	status() { return pmStatus(this); }
}

// ==== fuel gauges, chargers, USB-PD
const OCV = [[3.0, 0], [3.3, 3], [3.5, 8], [3.6, 14], [3.68, 25], [3.74, 36], [3.79, 46], [3.83, 56], [3.87, 65], [3.92, 75], [3.98, 85], [4.06, 94], [4.2, 100]];   // Li-ion open-circuit voltage → %
const socOf = v => { if (v <= 3) return 0; for (let i = 1; i < OCV.length; i++) if (v <= OCV[i][0]) { const [a, pa] = OCV[i - 1], [b, pb] = OCV[i]; return pa + ((v - a) / (b - a)) * (pb - pa); } return 100; };
class MAX17048 extends WordDev {   // also MAX17043 (12-bit VCELL); cell from world.batteryV
	constructor(env, spec, address, v48) { super(env, spec, address); this.v48 = v48; this.reset(); }
	reset() { Object.assign(this, { mode: 0, hib: 0x8030, cfg: 0x971c, valrt: 0xff, vreset: 0x9600, stat: 1, lastV: null, rate: 0 }); }
	cell() {
		const V = (this.V = Math.max(0, this.w('batteryV') + this.nz(0.001))), t = this.t();
		if (this.lastV == null) { this.lastV = V; this.lastT = t; } else if (t > this.lastT + 1) { this.rate = ((socOf(V) - socOf(this.lastV)) / (t - this.lastT)) * 3600; this.lastV = V; this.lastT = t; }
		this.version++; return V;
	}
	rdw(r) {
		switch (r) {
			case 2: { const V = this.cell(); return this.v48 ? clamp(Math.round(V / 78.125e-6), 0, 65535) : clamp(Math.round(V / 1.25e-3), 0, 4095) << 4; }
			case 4: return clamp(Math.round((this.soc = socOf(this.cell())) * 256), 0, 65535);
			case 6: return this.mode; case 8: return this.v48 ? 0x12 : 3; case 0x0a: return this.hib; case 0x0c: return this.cfg;
			case 0x14: return this.valrt; case 0x16: return sat16(this.rate / 0.208); case 0x18: return this.vreset; case 0x1a: return this.stat << 8;
		}
		return 0;
	}
	write(b, i) {   // power-on reset (0x5400 to CMD 0xFE) is not acknowledged
		if (i === 2 && this.ptr === 0xfe && ((this.wbuf[0] << 8) | b) === 0x5400) { this.reset(); this.wbuf = []; return false; }
		return super.write(b, i);
	}
	wrw(r, v) { if (r === 6) this.mode = v & 0x6000; else if (r === 0x0a) this.hib = v; else if (r === 0x0c) this.cfg = v; else if (r === 0x14) this.valrt = v; else if (r === 0x18) this.vreset = v & 0xff00; else if (r === 0x1a) this.stat &= (v >> 8) & 0x7f; }
	status() { return `${this.name}${this.at()} · ${fx(this.V, 3)} V · ${fx(this.soc != null ? this.soc : socOf(this.w('batteryV')), 0)} %`; }
}
// chargers, USB-C / PD and fan controllers: register files (init values, ro registers, reset [reg, bit], live: { reg: d → value })
class RegFile extends RegDev {
	constructor(env, spec, address, o) { super(env, spec, address); this.o = o; this.reset(); }
	reset() { this.regs.fill(0); Object.assign(this.regs, this.o.init); }
	wr(a, v) { const o = this.o; if (o.ro && o.ro.includes(a)) return; if (o.reset && a === o.reset[0] && v & o.reset[1]) return this.reset(); this.regs[a] = v; this.version++; }
	rd(a) { const f = this.o.live && this.o.live[a]; return f ? f(this) & 255 : this.regs[a]; }
	status() { return `${this.name}${this.at()}${this.o.st ? ' · ' + this.o.st(this) : ''}`; }
}
const q = (v, off, lsb, max = 127) => clamp(Math.round((v - off) / lsb), 0, max), bus5 = d => d.w('busV') > 4, charging = d => d.w('batteryV') < 4.15 && bus5(d);
const CHG = { st: d => 'bat ' + fx(d.w('batteryV'), 2) + ' V' };
const BQ25895 = Object.assign({ init: [0x3f, 6, 0x1d, 0x1a, 0x20, 0x13, 0x5e, 0x9d, 3, 0x44, 0x93, 0, 0, 0x12, 0, 0, 0x3f, 0, 0, 0, 0x39], reset: [0x14, 0x80], ro: [0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14],
	live: { 0x0b: d => (bus5(d) ? 0x16 : 0) | (charging(d) ? 0x0e : 0x1e), 0x0e: d => q(d.w('batteryV'), 2.304, 0.02), 0x0f: d => q(Math.max(d.w('batteryV'), 3.5), 2.304, 0.02),
		0x11: d => (bus5(d) ? 0x80 : 0) | q(d.w('busV'), 2.6, 0.1), 0x12: d => q(d.w('currentA'), 0, 0.05) } }, CHG);
const BQ25713 = Object.assign({ init: { 0x2e: 0x40, 0x2f: 0x88 }, ro: [0x2e, 0x2f], live: { 0x26: d => q(d.w('busV'), 3.2, 0.064, 255), 0x2c: d => q(d.w('batteryV'), 2.88, 0.064, 255), 0x2d: d => q(d.w('batteryV'), 2.88, 0.064, 255) } }, CHG);
const SGM41513 = Object.assign({ init: [0x17, 0x9a, 0x80, 0x11, 0x58, 0x9f, 0xe6, 0x4c, 0, 0, 0, 8], reset: [0x0b, 0x80], ro: [8, 9], live: { 0x0b: () => 8, 8: d => (bus5(d) ? 0x24 : 0) | 4 } }, CHG);
const FUSB302 = { init: { 1: 0x91, 2: 3, 3: 0x20, 4: 0x31, 5: 0x60, 6: 0x24, 8: 2, 9: 6, 0x0b: 1, 0x0d: 0x0f, 0x41: 0x28 }, ro: [1, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42], reset: [0x0c, 1], live: { 0x40: d => (bus5(d) ? 0x80 : 0) | 1 } };
const fanTach = (d, k) => { const rpm = d.w('fanRpm') || 0; return rpm > 0 ? Math.round(k / rpm) : 0xffff; }, FANST = { st: d => 'fan ' + (d.w('fanRpm') || 0) + ' rpm' };
const EMC2101 = Object.assign({ init: { 0xfd: 0x16, 0xfe: 0x5d, 0xff: 1 }, ro: [0xfd, 0xfe, 0xff],
	live: { 0: d => clamp(Math.round(d.w('tempC')), -64, 127), 1: d => clamp(Math.round(d.w('extTempC') ?? d.w('tempC')), -64, 127), 0x46: d => fanTach(d, 5400000), 0x47: d => fanTach(d, 5400000) >> 8 } }, FANST);
const EMC2301 = Object.assign({ init: { 0xfd: 0x37, 0xfe: 0x5d, 0xff: 0x80, 0x32: 0x2b }, ro: [0xfd, 0xfe, 0xff], live: { 0x3e: d => (fanTach(d, 3932160) << 3) >> 8, 0x3f: d => fanTach(d, 3932160) << 3 } }, FANST);

// ==== ADCs and DACs
class ADS1115 extends WordDev {   // also ADS1015 (12-bit, left-justified); single-shot (OS bit) and continuous modes
	constructor(env, spec, address, b12) { super(env, spec, address); this.b12 = b12; this.cfg = 0x8583; this.lo = 0x8000; this.hi = 0x7fff; this.conv = new Conv(); this.res = 0; this.V = NaN; this.lastc = -1e9; }
	sps() { return (this.b12 ? [128, 250, 490, 920, 1600, 2400, 3300, 3300] : [8, 16, 32, 64, 128, 250, 475, 860])[(this.cfg >> 5) & 7]; }
	convert() {
		const m = (this.cfg >> 12) & 7, a = i => this.volts('ain' + i, 0), fsr = [6.144, 4.096, 2.048, 1.024, 0.512, 0.256, 0.256, 0.256][(this.cfg >> 9) & 7];
		this.V = (m >= 4 ? a(m - 4) : [a(0) - a(1), a(0) - a(3), a(1) - a(3), a(2) - a(3)][m]) + this.nz(20e-6); this.version++;
		const c = clamp(Math.round((this.V / fsr) * 32768), -32768, 32767); this.res = (this.b12 ? c & ~15 : c) & 0xffff;
	}
	rdw(r) {
		const now = this.t();
		if (r === 1) { const busy = this.conv.busy(now, true); if (!busy && this.pend) { this.convert(); this.pend = false; } return (this.cfg & 0x7fff) | (busy ? 0 : 0x8000); }
		if (r) return r === 2 ? this.lo : this.hi;
		if (!(this.cfg & 0x100)) { if (now - this.lastc >= 1 / this.sps()) { this.convert(); this.lastc = now; } }
		else if (this.pend && !this.conv.busy(now)) { this.convert(); this.pend = false; }
		return this.res;
	}
	wrw(r, v) {
		if (r === 1) { this.cfg = (v & 0x7fff) | (this.cfg & 0x8000); if (v & 0x100 && v & 0x8000) { this.conv.begin(this.t(), 1 / this.sps() + 1e-4); this.pend = true; } if (!(v & 0x100)) this.lastc = -1e9; }
		else if (r === 2) this.lo = v; else if (r === 3) this.hi = v;
	}
	status() { return `${this.name}${this.at()} · ${fx(this.V, 4)} V`; }
}
class ADCxS021 extends SPIDev {   // ADC081S021 / 101 / 121: 16 clocks, 3 leading zeros, data MSB first
	begin() { const n = this.spec.bits, V = (this.V = this.volts('vin', 0)); this.version++; this.frame = clamp(Math.round((V / this.vdd()) * (1 << n)), 0, (1 << n) - 1) << (13 - n); }
	xfer(b, i) { return i === 0 ? this.frame >> 8 : i === 1 ? this.frame & 255 : 0; }
	status() { return `${this.name} · ${fx(this.V, 3)} V`; }
}
class MCP4725D extends I2CDev {   // fast / DAC / DAC+EEPROM writes; the EEPROM code persists in D.storage
	constructor(env, spec, address) { super(env, spec, address); this.nv = this.store(2, 0).sectors; if (!this.nv.has(0)) this.nv.set(0, { code: 2048, pd: 0 }); Object.assign(this, this.nv.get(0)); this.conv = new Conv(); this.upd(); }
	upd() { this.Vout = this.pd ? 0 : (this.code / 4096) * this.vdd(); this.out('vout', this.Vout); this.version++; }
	start() { this.b = []; this.oi = 0; return true; }
	write(b) {
		const x = this.b; x.push(b); const n = x.length, c = (x[0] >> 5) & 7;
		if (!(x[0] & 0xc0)) { if (n % 2 === 0) { this.pd = (x[n - 2] >> 4) & 3; this.code = ((x[n - 2] & 15) << 8) | b; this.upd(); } }
		else if (n === 3 && c >= 2) { this.pd = (x[0] >> 1) & 3; this.code = (x[1] << 4) | (b >> 4); this.upd(); if (c === 3) { this.nv.set(0, { code: this.code, pd: this.pd }); this.conv.begin(this.t(), 0.025); } }
		return true;
	}
	read() { const e = this.nv.get(0); return [(this.conv.busy(this.t(), true) ? 0 : 0x80) | 0x40 | (this.pd << 1), this.code >> 4, (this.code & 15) << 4, (e.pd << 5) | (e.code >> 8), e.code & 255][this.oi++] ?? 0xff; }
	status() { return `MCP4725${this.at()} · ${this.code} → ${fx(this.Vout, 3)} V`; }
}
class DACxC081 extends I2CDev {   // DAC081C081 / 101 / 121: two-byte words without pointer (PD1 PD0 D11..D0)
	constructor(env, spec, address) { super(env, spec, address); this.w12 = 0; this.upd(); }
	upd() { const n = this.spec.bits; this.V = this.w12 & 0x3000 ? 0 : (((this.w12 & 0xfff) >> (12 - n)) / (1 << n)) * this.volts('vref', this.vdd()); this.out('vout', this.V); this.version++; }
	start() { this.b = []; this.oi = 0; return true; }
	write(b) { const x = this.b; x.push(b); if (x.length % 2 === 0) { this.w12 = ((x[x.length - 2] << 8) | b) & 0x3fff; this.upd(); } return true; }
	read() { return this.oi++ % 2 ? this.w12 & 255 : this.w12 >> 8; }
	status() { return `${this.name}${this.at()} · ${fx(this.V, 3)} V`; }
}
class DAC43204 extends WordDev {   // TI smart DACs: DAC_DATA 0x19.., COMMON_CONFIG 0x1F power-down, VOUT_CMP_CONFIG gain/reference, DEVICE_ID 0x22
	constructor(env, spec, address) { super(env, spec, address); this.R = new Uint16Array(0x30); this.R[0x1f] = 0x0fff; [3, 9, 15, 21].forEach(r => (this.R[r] = 0x400)); this.upd(); }
	upd() {
		const n = this.spec.bits;
		this.V = [0, 1, 2, 3].map(i => {
			const code = (this.R[0x19 + i] >> (12 - n)) & ((1 << n) - 1), g = (this.R[3 + 6 * i] >> 10) & 7, fs = g === 1 ? this.vdd() : g >= 2 ? 1.212 * ([1.5, 2, 3, 4][g - 2] || 1) : this.volts('vref', 1.212);
			const v = (this.R[0x1f] >> (3 * (3 - i))) & 1 ? 0 : (code / ((1 << n) - 1)) * fs; this.out('out' + i, v); return v;
		});
		this.version++;
	}
	rdw(r) { return r === 0x22 ? (0x0c + (this.spec.bits - 8) / 2) << 2 : this.R[r] || 0; }
	wrw(r, v) { if (r < 0x30) this.R[r] = v; this.upd(); }
	status() { return `${this.name}${this.at()} · ${this.V.map(v => fx(v, 2)).join(' / ')} V`; }
}
class AD568x extends SPIDev {   // AD5683R–AD5686R: 24-bit frames (command, channel mask, data), internal 2.5 V reference
	constructor(env, spec) { super(env, spec); this.inreg = [0, 0, 0, 0]; this.dac = [0, 0, 0, 0]; this.intRef = true; this.upd(); }
	upd() { const vr = (this.intRef ? 2.5 : this.volts('vref', 2.5)) * (this.lvl('gain') ? 2 : 1); this.V = this.dac.map((c, i) => { const v = (c / (1 << this.spec.bits)) * vr; this.out('vout' + 'abcd'[i], v); return v; }); this.version++; }
	begin() { this.fr = []; }
	xfer(b) {
		const f = this.fr; f.push(b); if (f.length < 3) return 0;
		const cmd = f[0] >> 4, v = ((f[1] << 8) | f[2]) >> (16 - this.spec.bits); this.fr = [];
		for (let i = 0; i < 4; i++) if (f[0] & (1 << i)) { if (cmd === 1 || cmd === 3) this.inreg[i] = v; if (cmd === 2 || cmd === 3) this.dac[i] = this.inreg[i]; }
		if (cmd === 6) { this.inreg.fill(0); this.dac.fill(0); } if (cmd === 7) this.intRef = !(f[2] & 1);
		this.upd(); return 0;
	}
	status() { return `${this.name} · ${this.V.map(v => fx(v, 3)).join(' / ')} V`; }
}
class HX711 extends Dev {   // bit-level: the runtime calls pinChanged('sck', level); DOUT low = ready; 25/26/27 clocks select the next gain
	constructor(env, spec) { super(env, spec); this.gp = 25; this.ready(); }
	ready() {
		const v = this.volts('ina', null), mv = v != null ? v * 1000 : this.w('loadKg') * 0.5;   // load cell: 0.5 mV per kg
		this.val = clamp(Math.round((mv / 20) * 8388608 * ([1, 0.25, 0.5][this.gp - 25] || 1)), -8388608, 8388607) & 0xffffff; this.n = 0; this.pin('dout', 'lo'); this.version++;
	}
	pinChanged(role, level) {
		if (role !== 'sck' && role !== 'pd_sck') return;
		if (level) { this.n++; this.pin('dout', this.n > 24 || (this.val >> (24 - this.n)) & 1 ? 'hi' : 'lo'); }
		else if (this.n >= 25) { this.gp = this.n; this.ready(); }
	}
	status() { return `HX711 · ${s16(this.val >> 8)}`; }
}

// ---- templates
const INA = { roles: { a0: ['A0'], a1: ['A1'], vinp: ['IN+', 'VIN+', 'VINP', 'INP', 'SENSE+'], vinm: ['IN-', 'VIN-', 'VINM', 'INM', 'SENSE-'], vbus: ['VBUS'], int: ['ALERT'] }, addr: L => 0x40 + 4 * lvl4(L.a1) + lvl4(L.a0) }, A40 = range(0x40, 16);
T('bh1750', 'BH1750', 'i2c', /\bBH1750|\bGY-30\b|\bGY-302\b/, [0x23, 0x5c], BH1750D, { roles: { addr: ['ADDR', 'ADD'] }, addr: L => (L.addr === 1 ? 0x5c : 0x23) });
T('veml7700', 'VEML7700', 'i2c', /\bVEML77\d0|\bVEML6030/, [0x10], VEML7700, { params: t => ({ a48: /VEML6030/.test(t) }), addr: (L, p) => (p.a48 && L.addr === 1 ? 0x48 : 0x10) });
T('ina219', 'INA219', 'i2c', /\bINA219/, A40, INA219, INA);
T('ina233', 'INA233', 'i2c', /\bINA233/, A40, INA233, INA);
T('max17048', 'MAX17048', 'i2c', /\bMAX1704[89]/, [0x36], [MAX17048, true]);
T('max17043', 'MAX17043', 'i2c', /\bMAX1704[34]/, [0x36], [MAX17048, false]);
const rf = (id, name, re, addresses, o, x) => T(id, name, 'i2c', re, addresses, [RegFile, o], x);
rf('bq25895', 'BQ25895', /\bBQ2589[05]/, [0x6a], BQ25895);
rf('bq25713', 'BQ25713', /\bBQ2571[03]/, [0x6b], BQ25713);
rf('sgm41513', 'SGM41513', /\bSGM4151[0-3]/, [0x1a], SGM41513);
rf('fusb302', 'FUSB302', /\bFUSB302/, [0x22, 0x23, 0x24, 0x25], FUSB302, { params: t => ({ addr: { '01': 0x23, 10: 0x24, 11: 0x25 }[(/FUSB302B(01|10|11)/.exec(t) || [])[1]] || 0x22 }), addr: (L, p) => p.addr });
rf('husb238', 'HUSB238', /\bHUSB238/, [0x08], { init: [0x1a, 0x44, 0x8a, 0, 0x8a], ro: [0, 1] });
rf('ap33772', 'AP33772', /\bAP33772/, [0x51], { init: { 0x1c: 0x14, 0x1d: 3 }, ro: [0x1d], live: { 0x20: d => q(d.w('busV'), 0, 0.08, 255) } });
rf('emc2101', 'EMC2101', /\bEMC2101/, [0x4c], EMC2101);
rf('emc2301', 'EMC2301', /\bEMC230[1-5]/, [0x2f], EMC2301);
const AIN = { roles: { addr: ['ADDR'], ain0: ['AIN0', 'A0'], ain1: ['AIN1', 'A1'], ain2: ['AIN2', 'A2'], ain3: ['AIN3', 'A3'], int: ['ALERT/RDY', 'ALERT', 'RDY'] }, addr: L => 0x48 + lvl4(L.addr) }, A48 = range(0x48, 4);
T('ads1115', 'ADS1115', 'i2c', /\bADS111[345]/, A48, [ADS1115, false], AIN);
T('ads1015', 'ADS1015', 'i2c', /\bADS101[345]/, A48, [ADS1115, true], AIN);
T('adc081s021', 'ADC081S021', 'spi', /\bADC(08|10|12)1S0[25]1/, undefined, ADCxS021, { roles: { vin: ['VIN'], miso: ['SDATA', 'SDO'], sck: ['SCLK'], cs: ['CS'] }, params: t => ({ bits: +/ADC(08|10|12)/.exec(t)[1] }) });
T('mcp4725', 'MCP4725', 'i2c', /\bMCP4725/, range(0x60, 8), MCP4725D,
	{ roles: { addr: ['A0'], vout: ['VOUT'] }, params: t => ({ base: 0x60 + 2 * +((/MCP4725A([0-3])/.exec(t) || [0, 1])[1]) }), addr: (L, p) => p.base + lvl01(L.addr) });
T('dac081c081', 'DAC081C081', 'i2c', /\bDAC(08|10|12)1C08[15]/, [0x0c, 0x0d, 0x0e], DACxC081, { roles: { addr: ['ADR0'], vout: ['VOUT'], vref: ['VA', 'VREF'] },
	params: t => ({ bits: +/DAC(08|10|12)/.exec(t)[1], name: /DAC(08|10|12)1C08[15]/.exec(t)[0] }), addr: L => (L.addr === 0 ? 0x0c : L.addr === 1 ? 0x0e : 0x0d) });
T('dac43204', 'DAC43204', 'i2c', /\bDAC[456]3[24]0[24]/, A48, DAC43204, { roles: { addr: ['A0/SDI', 'A0'], out0: ['OUT0'], out1: ['OUT1'], out2: ['OUT2'], out3: ['OUT3'] },
	params: t => ({ bits: /DAC6/.test(t) ? 12 : /DAC5/.test(t) ? 10 : 8, name: /DAC[456]3[24]0[24]/.exec(t)[0] }), addr: L => 0x48 + lvl4(L.addr) });
T('ad5686', 'AD5686R', 'spi', /\bAD568[3-6]/, undefined, AD568x, { roles: { cs: ['SYNC', 'CS'], mosi: ['SDIN', 'DIN'], miso: ['SDO'], sck: ['SCLK'], gain: ['GAIN'], vouta: ['VOUTA'], voutb: ['VOUTB'], voutc: ['VOUTC'], voutd: ['VOUTD'] },
	params: t => ({ bits: /AD5686/.test(t) ? 16 : /AD5685/.test(t) ? 14 : 12, name: /AD568\d/.exec(t)[0] + 'R' }) });
T('hx711', 'HX711', 'gpio', /\bHX711|\bHX710/, undefined, HX711, { roles: { dout: ['DOUT', 'DT'], sck: ['PD_SCK', 'SCK'], ina: ['INA+', 'INP'] } });

// ==== IO expanders
// outputs → env.setPin('p0'..'p15', 'hi' | 'lo' | 'z' | 'od' | 'pu') (changes only); inputs ← env.pinLevel('pN');
// the runtime calls pinChanged(role, level) so interrupt outputs follow the inputs
class Expander extends RegDev {
	constructor(env, spec, address, n) { super(env, spec, address); this.np = n; this.drive = []; this.lastIn = null; }
	inputs(pull = 0) { let v = 0; for (let i = 0; i < this.np; i++) { const l = this.lvl('p' + i); if (l == null ? (pull >> i) & 1 : l) v |= 1 << i; } return v; }
	drivePin(i, m) { if (this.drive[i] !== m) this.pin('p' + i, (this.drive[i] = m)); }
	// dir: bit 1 = input · out: output latch · od: open-drain mask · pu: pull-up mask
	apply(dir, out, od = 0, pu = 0) { for (let i = 0; i < this.np; i++) { const b = 1 << i; this.drivePin(i, dir & b ? (pu & b ? 'pu' : 'z') : od & b ? (out & b ? 'z' : 'od') : out & b ? 'hi' : 'lo'); } this.version++; }
	pinChanged(role) { if (/^p\d+$/.test(role) && this.onInput) this.onInput(); }
	status() { const [d, o] = this.st(); let s = ''; for (let i = this.np - 1; i >= 0; i--) s += (d >> i) & 1 ? (this.lvl('p' + i) === 0 ? 'L' : 'H') : (o >> i) & 1 ? '1' : '0'; return `${this.name}${this.at()} · ${s}`; }
}
// PCA9535/9555, TCA6416, PCAL6416 (16 pins, register pairs) and PCA9554/9557, TCA6408 (8 pins): input, output, polarity, config
class PCA95xx extends Expander {
	constructor(env, spec, address, n, o = {}) {
		super(env, spec, address, n); this.o = o; const r = this.regs;
		if (n === 16) { r.fill(0xff, 2, 4); r.fill(0xff, 6, 8); if (o.pcal) { r.fill(0xff, 0x40, 0x46); r.fill(0xff, 0x4a, 0x4e); } }
		else { r[1] = r[3] = 0xff; r[2] = o.pol || 0; }
		this.irq = false; this.update();
	}
	next(r) { return this.np === 16 ? (r < 8 ? r ^ 1 : r + 1) & 255 : r; }
	g(k) { const r = this.regs; return this.np === 16 ? r[2 * k] | (r[2 * k + 1] << 8) : r[k]; }   // 0 input · 1 output · 2 polarity · 3 config
	st() { return [this.g(3), this.g(1)]; }
	update() { const r = this.regs, o = this.o; this.apply(this.g(3), this.g(1), o.od || 0, o.pu ? 0xffff : o.pcal ? (r[0x46] | (r[0x47] << 8)) & (r[0x48] | (r[0x49] << 8)) : 0); }
	readIn() { const d = this.g(3); return (((this.inputs(this.o.pu ? 0xffff : 0) & d) | (this.g(1) & ~d)) ^ (this.g(2) & d)) & ((1 << this.np) - 1); }
	rd(a) {
		if (a > this.np >> 4) return this.regs[a];
		const v = (this.lastIn = this.readIn()); if (this.irq) { this.irq = false; this.pin('int', 'z'); } return a ? v >> 8 : v & 255;
	}
	wr(a, v) { if (a > this.np >> 4) { this.regs[a] = v; this.update(); } }
	onInput() { const v = this.readIn(); if (this.lastIn != null && v !== this.lastIn && !this.irq) { this.irq = true; this.pin('int', 'od'); } }
}
// MCP23017/23S17 (16 pins), MCP23008/23S08 (8): IOCON BANK / MIRROR / SEQOP / HAEN / ODR / INTPOL, interrupts
class MCP23017 extends Expander {
	constructor(env, spec, address, n) { super(env, spec, address, n); this.p = [0, 1].map(() => new Uint8Array(11)); this.p[0][0] = this.p[1][0] = 0xff; this.iocon = 0; this.sn = -1; this.update(); }
	loc(a) { return this.np === 8 ? (a <= 10 ? [0, a] : null) : this.iocon & 0x80 ? (a < 11 ? [0, a] : a >= 16 && a < 27 ? [1, a - 16] : null) : a < 22 ? [a & 1, a >> 1] : null; }
	next(a) { const c = this.iocon; return c & 0x20 ? (this.np === 16 && !(c & 0x80) ? a ^ 1 : a) : this.np === 8 ? (a + 1) % 11 : c & 0x80 ? (a === 10 ? 16 : a === 26 ? 0 : a + 1) : (a + 1) % 22; }
	g(k) { return this.p[0][k] | (this.np === 16 ? this.p[1][k] << 8 : 0); }   // 0 IODIR 1 IPOL 2 GPINTEN 3 DEFVAL 4 INTCON 5 IOCON 6 GPPU 7 INTF 8 INTCAP 9 GPIO 10 OLAT
	st() { return [this.g(0), this.g(10)]; }
	update() { this.apply(this.g(0), this.g(10), 0, this.g(6)); }
	pins() { const d = this.g(0); return (this.inputs(this.g(6)) & d) | (this.g(10) & ~d); }
	rd(a) {
		const L = this.loc(a); if (!L) return 0; const [pt, k] = L;
		if (k === 5) return this.iocon;
		if (k === 9) { const v = this.pins() ^ (this.g(1) & this.g(0)); this.p[pt][7] = 0; this.clearInt(); this.lastIn = this.pins(); return pt ? v >> 8 : v & 255; }
		if (k === 8) { this.p[pt][7] = 0; this.clearInt(); }
		return this.p[pt][k];
	}
	wr(a, v) { const L = this.loc(a); if (!L) return; const [pt, k] = L; if (k === 5) this.iocon = v & 0xfe; else if (k < 7 || k > 8) { this.p[pt][k === 9 ? 10 : k] = v; this.update(); } }
	intLvl(on) { const c = this.iocon; return on ? (c & 4 ? 'od' : c & 2 ? 'hi' : 'lo') : c & 4 ? 'z' : c & 2 ? 'lo' : 'hi'; }
	onInput() {
		const now = this.pins(), was = this.lastIn ?? now, en = this.g(2) & this.g(0), con = this.g(4), def = this.g(3);
		for (let b = 0; b < this.np; b++) {
			const P = this.p[b >> 3], cur = (now >> b) & 1;
			if ((en >> b) & 1 && ((con >> b) & 1 ? cur !== ((def >> b) & 1) : cur !== ((was >> b) & 1)) && !P[7]) { P[7] |= 1 << (b & 7); P[8] = (now >> (b & 8)) & 255; }
		}
		this.lastIn = now;
		const a = !!this.p[0][7], b = this.np === 16 && !!this.p[1][7], m = this.iocon & 0x40;
		this.pin('inta', this.intLvl(m ? a || b : a)); this.pin('intb', this.intLvl(m ? a || b : b));
	}
	clearInt() { if (this.np === 8 || !(this.p[0][7] | this.p[1][7])) { this.pin('inta', this.intLvl(false)); this.pin('intb', this.intLvl(false)); } }
	spiSelect(on) { this.sn = on ? 0 : -1; }
	spiTransfer(b) {   // MCP23Sxx: opcode 0100 A2 A1 A0 R/W, register, data…
		if (this.sn < 0) return 0xff; const i = this.sn++;
		if (!i) { this.op = b; return 0; }
		if ((this.op & 0xf0) !== 0x40 || (this.iocon & 8 && ((this.op >> 1) & 7) !== (this.address & 7))) return 0xff;
		if (i === 1) { this.ptr = b; return 0; }
		const p = this.ptr; this.ptr = this.next(p); if (this.op & 1) return this.rd(p); this.wr(p, b); return 0;
	}
}
// PCF8574/8574A/8575: quasi-bidirectional, no registers (1 = weak pull-up, 0 = strong low)
class PCF8574 extends Expander {
	constructor(env, spec, address, n) { super(env, spec, address, n); this.o = (1 << n) - 1; this.update(); }
	st() { return [this.o, this.o]; }
	update() { this.apply(this.o, 0, -1, this.o); }
	start(read) { this.bi = 0; if (read) { this.lastIn = this.snap = this.inputs(this.o) & this.o; this.pin('int', 'z'); } return true; }
	write(b) { this.o = this.np === 8 ? b : this.bi++ % 2 ? (this.o & 0xff) | (b << 8) : (this.o & 0xff00) | b; this.update(); if (this.onByte) this.onByte(this.o); return true; }
	read() { return this.np === 8 ? this.snap : this.bi++ % 2 ? this.snap >> 8 : this.snap & 255; }
	onInput() { if (this.lastIn != null && (this.inputs(this.o) & this.o) !== this.lastIn) this.pin('int', 'od'); }
}
// SX1509 GPIO: DIR 0x0E, DATA 0x10, PULL_UP 0x06, OPEN_DRAIN 0x0A, POLARITY 0x0C (pairs); reset = 0x12, 0x34 to 0x7D
class SX1509 extends Expander {
	constructor(env, spec, address) { super(env, spec, address, 16); this.reset(); }
	reset() { this.regs.fill(0); this.regs.fill(0xff, 0x0e, 0x14); this.rs = 0; this.update(); }
	w16(a) { return this.regs[a + 1] | (this.regs[a] << 8); }
	st() { return [this.w16(0x0e), this.w16(0x10)]; }
	update() { this.apply(this.w16(0x0e), this.w16(0x10), this.w16(0x0a), this.w16(6)); }
	rd(a) { if (a !== 0x10 && a !== 0x11) return this.regs[a]; const d = this.w16(0x0e), v = ((this.inputs(this.w16(6)) & d) | (this.w16(0x10) & ~d)) ^ (this.w16(0x0c) & d); return a & 1 ? v & 255 : v >> 8; }
	wr(a, v) { if (a === 0x7d) { if (this.rs === 0x12 && v === 0x34) this.reset(); this.rs = v; } else { this.regs[a] = v; if (a <= 0x11) this.update(); } }
}

// ==== 74HC595: bit level (pinChanged SRCLK / RCLK / OE / SRCLR), SPI level (every
// byte on the bus, latched by a pin), or shift() / latch(); .next = the register behind QH'
class HC595 extends Dev {
	constructor(env, spec) { super(env, spec); this.sr = this.q = 0; this.oe = true; this.next = null; this.lv = {}; this.apply(); }
	apply() { for (let i = 0; i < 8; i++) this.pin('q' + 'abcdefgh'[i], this.oe ? ((this.q >> i) & 1 ? 'hi' : 'lo') : 'z'); this.version++; }
	clk(bit) { const out = this.sr >> 7; this.sr = ((this.sr << 1) | (bit ? 1 : 0)) & 255; return out; }
	clock(bit) { const out = this.clk(bit); this.pin('qh_', this.sr >> 7 ? 'hi' : 'lo'); if (this.next) this.next.clock(out); return out; }
	shift(byte, msb = true) { let o = 0; for (let i = 0; i < 8; i++) o = (o << 1) | this.clk((byte >> (msb ? 7 - i : i)) & 1); if (this.next) this.next.shift(o); return o; }
	latch() { this.q = this.sr; this.apply(); if (this.next && this.nextLatch !== false) this.next.latch(); }
	spiSelect() {}
	spiTransfer(b) { return this.shift(b); }
	spiLatch() { this.latch(); }
	pinChanged(role, level) {
		const was = this.lv[role]; this.lv[role] = level;
		if (role === 'srclk' && level && !was) { if (this.lvl('srclr') !== 0) this.clock(this.lvl('ser')); }
		else if (role === 'rclk' && level && !was) this.latch();
		else if (role === 'oe') { this.oe = !level; this.apply(); }
		else if (role === 'srclr' && !level) this.sr = 0;
	}
	status() { return `${this.name} · Q ${this.q.toString(2).padStart(8, '0')}${this.oe ? '' : ' · OE off'}`; }
}

// ==== LED matrix drivers (display devices: width, height, on, version, rgba())
const gridRGBA = (d, w, h, lit, col) => {   // lit(x, y) → 0..1
	const a = d._px && d._px.length === w * h * 4 ? d._px : (d._px = new Uint8ClampedArray(w * h * 4));
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = (y * w + x) * 4, v = lit(x, y); for (let c = 0; c < 3; c++) a[k + c] = 18 + (col[c] - 18) * v; a[k + 3] = 255; }
	return a;
};
class HT16K33 extends I2CDev {   // 16×8 display RAM, system setup / display on + blink / dimming commands, key RAM
	constructor(env, spec, address) { super(env, spec, address); this.ram = new Uint8Array(16); this.keys = new Uint8Array(6); this.osc = this.on = false; this.blink = 0; this.dim = 15; this.width = 16; this.height = 8; }
	write(b, i) {
		if (i) { if (this.mode === 1) { this.ram[this.ptr] = b; this.ptr = (this.ptr + 1) & 15; this.version++; } return true; }
		const c = b & 0xf0; this.mode = c ? (c === 0x40 ? 2 : 0) : 1; this.ptr = c ? 0 : b & 15;
		if (c === 0x20) this.osc = !!(b & 1); else if (c === 0x80) { this.on = !!(b & 1); this.blink = (b >> 1) & 3; } else if (c === 0xe0) this.dim = b & 15;
		this.version++; return true;
	}
	read() { return this.mode === 2 ? this.keys[this.ptr++ % 6] : this.ram[this.ptr++ & 15]; }
	led(x, y) { return ((this.ram[2 * y] | (this.ram[2 * y + 1] << 8)) >> x) & 1; }
	rgba() { const on = this.osc && this.on, k = 0.25 + (0.75 * (this.dim + 1)) / 16; return gridRGBA(this, 16, 8, (x, y) => (on && this.led(x, y) ? k : 0), [255, 40, 30]); }
	status() { let n = 0; for (const b of this.ram) for (let i = 0; i < 8; i++) n += (b >> i) & 1; return `HT16K33${this.at()} · ${this.osc && this.on ? 'on' : 'off'} · ${n} LEDs`; }
}
class IS31FL3731 extends I2CDev {   // 8 frames (LED on/off + PWM), function page 0x0B (picture frame, shutdown)
	constructor(env, spec, address) { super(env, spec, address); this.pages = Array.from({ length: 8 }, () => new Uint8Array(0xb4)); this.fn = new Uint8Array(16); this.page = 0; this.width = 16; this.height = 9; }
	write(b, i) {
		if (!i) this.ptr = b;
		else if (this.ptr === 0xfd) { this.page = b; this.ptr++; }
		else { if (this.page === 0x0b) { if (this.ptr < 16) this.fn[this.ptr] = b; } else if (this.page < 8 && this.ptr < 0xb4) this.pages[this.page][this.ptr] = b; this.ptr++; this.version++; }
		return true;
	}
	read() { const p = this.page, v = p === 0x0b ? this.fn[this.ptr & 15] : p < 8 ? this.pages[p][this.ptr] || 0 : 0; this.ptr++; return v; }
	get on() { return !!(this.fn[10] & 1); }
	rgba() { const f = this.pages[this.fn[1] & 7], on = this.on; return gridRGBA(this, 16, 9, (x, y) => { const i = y * 16 + x; return on && (f[i >> 3] >> (i & 7)) & 1 ? f[0x24 + i] / 255 : 0; }, [255, 250, 240]); }
	status() { return `IS31FL3731${this.at()} · ${this.on ? 'frame ' + (this.fn[1] & 7) : 'shutdown'}`; }
}
class MAX7219 extends SPIDev {   // 16-bit frames latched when LOAD rises; .next = the chip behind DOUT
	constructor(env, spec) { super(env, spec); this.reg = new Uint8Array(16); this.sr = 0; this.next = null; this.width = this.height = 8; }
	xfer(b) { const out = (this.sr >> 8) & 255; this.sr = ((this.sr << 8) | b) & 0xffff; if (this.next) this.next.xfer(out); return out; }
	end() { const a = (this.sr >> 8) & 15; if (a) this.reg[a] = this.sr & 255; this.version++; if (this.next) this.next.end(); }
	get on() { return !!(this.reg[12] & 1); }
	rgba() { const r = this.reg, test = r[15] & 1, on = this.on || test, k = 0.3 + (0.7 * (1 + (r[10] & 15))) / 16; return gridRGBA(this, 8, 8, (x, y) => (on && y <= (r[11] & 7) && (test || (r[1 + y] >> (7 - x)) & 1) ? k : 0), [255, 40, 30]); }
	status() { return `MAX7219 · ${this.on ? 'on' : 'shutdown'}`; }
}

// ==== I2C multiplexers (devices behind them carry .behind = { mux, channel })
class I2CMux extends I2CDev {   // PCA9548A/9546A channel mask, PCA9545A 4-bit mask, PCA9547 select + enable
	constructor(env, spec, address, kind) { super(env, spec, address); this.kind = kind; this.ctl = 0; }
	enabled(ch) { return this.kind === 'sel8' ? !!(this.ctl & 8) && (this.ctl & 7) === ch : !!((this.ctl >> ch) & 1); }
	write(b) { this.ctl = this.kind === 'mask4' ? b & 15 : b; this.version++; return true; }
	read() { return this.ctl; }
	status() { const on = range(0, 8).filter(c => this.enabled(c)); return `${this.name}${this.at()} · ${on.length ? 'ch ' + on.join(',') : 'all off'}`; }
}

// ---- templates
const pinR = (n, f, p = 'p') => Object.fromEntries(range(0, n).map(i => [p + i, f(i, i >> 3, i & 7)]));
const P16 = pinR(16, (i, pt, b) => ['P' + pt + b, 'P' + pt + '_' + b, 'P' + pt + '.' + b, 'IO' + pt + '_' + b, 'IO' + pt + '.' + b, 'P' + i, 'IO' + i]);
const P8 = pinR(8, i => ['P' + i, 'IO' + i, 'GP' + i, 'P0' + i, 'P0_' + i, 'IO0_' + i, 'GPIO' + i]);
const AR = { a0: ['A0'], a1: ['A1'], a2: ['A2'], int: ['INT', 'INTB'] }, A20 = range(0x20, 8), A70 = range(0x70, 8), A2038 = A20.concat(range(0x38, 8));
const x3 = (P, base, x) => Object.assign({ roles: Object.assign({}, AR, P), addr: A3(base) }, x), ADR = (P, x) => Object.assign({ roles: Object.assign({ addr: ['ADDR'], int: ['INT'] }, P), addr: A1(0x20) }, x);
const pca = (id, name, re, addresses, n, o, x) => T(id, name, 'i2c', re, addresses, (e, p, a) => new PCA95xx(e, p, a, n, typeof o === 'function' ? o(p) : o), x);
pca('pca9555', 'PCA9555', /\b(PCA|TCA)9555|\bPCAL9555/, A20, 16, { pu: true }, x3(P16, 0x20));
pca('pca9535', 'PCA9535', /\b(PCA|TCA|PCAL)9535|\bXL9535|\b(PCA|TCA)9539/, A20, 16, {}, x3(P16, 0x20));
pca('tca6416', 'TCA6416', /\b(TCA|PCA|PCAL)6416/, [0x20, 0x21], 16, p => ({ pcal: p.pcal }), ADR(P16, { params: t => ({ pcal: /PCAL/.test(t), name: /(TCA|PCA|PCAL)6416A?/.exec(t)[0] }) }));
pca('tca6408', 'TCA6408', /\b(TCA|PCA|PCAL)6408/, [0x20, 0x21], 8, {}, ADR(P8, { params: t => ({ name: /(TCA|PCA|PCAL)6408A?/.exec(t)[0] }) }));
pca('pca9557', 'PCA9557', /\b(PCA|TCA)9557|\bPCA953[68]/, range(0x18, 8), 8, p => (p.b9538 ? {} : { pol: 0xf0, od: 1 }), x3(P8, 0, { params: t => ({ b9538: /953[68]/.test(t) }), addr: (L, p) => A3(p.b9538 ? 0x70 : 0x18)(L) }));
pca('pca9554', 'PCA9554', /\b(PCA|TCA)95[35]4/, A2038, 8, { pu: true }, x3(P8, 0, { params: t => ({ a: /95[35]4A/.test(t) }), addr: (L, p) => A3(p.a ? 0x38 : 0x20)(L) }));
const GPAB = pinR(16, (i, pt, b) => ['GP' + 'AB'[pt] + b, 'GP' + 'AB'[pt] + '_' + b, 'P' + 'AB'[pt] + b]), mcpName = n => t => ({ name: (/MCP23S/.test(t) ? 'MCP23S' : 'MCP230') + n });
T('mcp23017', 'MCP23017', 'i2c+spi', /\bMCP23[0S]1[78]/, A20, [MCP23017, 16], x3(GPAB, 0x20, { roles: Object.assign({ inta: ['INTA'], intb: ['INTB'], rst: ['RESET'] }, AR, GPAB), params: mcpName(17) }));
T('mcp23008', 'MCP23008', 'i2c+spi', /\bMCP23[0S]0[89]/, A20, [MCP23017, 8], x3(P8, 0x20, { roles: Object.assign({}, AR, P8, { inta: ['INT'] }), params: mcpName('08') }));
T('pcf8575', 'PCF8575', 'i2c', /\bPC[FA]8575|\bTCA9535PCF/, A20, [PCF8574, 16], x3(P16, 0x20));
T('pcf8574', 'PCF8574', 'i2c', /\bPC[FA]8574|\bTCA9554PCF/, A2038, [PCF8574, 8], x3(P8, 0, { params: t => (/PCF8574A/.test(t) ? { a: 1, name: 'PCF8574A' } : {}), addr: (L, p) => A3(p.a ? 0x38 : 0x20)(L) }));
T('sx1509', 'SX1509', 'i2c', /\bSX150[89]/, [0x3e, 0x3f, 0x70, 0x71], SX1509,
	{ roles: Object.assign({ a0: ['ADDR0'], a1: ['ADDR1'], int: ['NINT', 'INT'] }, pinR(16, i => ['IO' + i, 'IO_' + i])), addr: L => [0x3e, 0x3f, 0x70, 0x71][lvl01(L.a0) + 2 * lvl01(L.a1)] });
T('74hc595', '74HC595', 'spi', /\b(SN)?74(HC|HCT|AHC|AHCT|LV|LVC|VHC)?595|\bAIP74HC595|\bHC595\b|\bTPIC6[BC]595/, undefined, HC595, {
	roles: Object.assign({ ser: ['SER', 'DS', 'SI', 'SDI', 'DATA', 'D'], srclk: ['SRCLK', 'SHCP', 'SH_CP', 'SCK', 'SRCK', 'CLK', 'SHIFT'], rclk: ['RCLK', 'STCP', 'ST_CP', 'RCK', 'LATCH', 'STROBE'], oe: ['OE', 'G'],
		srclr: ['SRCLR', 'MR', 'SCLR', 'CLR'], qh_: ["QH'", "Q7'", 'Q7S', 'QHS', 'SQH', 'SER_OUT'] }, Object.fromEntries(range(0, 8).map(i => ['q' + 'abcdefgh'[i], ['Q' + 'ABCDEFGH'[i], 'Q' + i]]))) });
const disp = (w, h, bus, x) => Object.assign({ bus, display: { w, h } }, x);
T('ht16k33', 'HT16K33', 'display', /\bHT16K33|\bVK16K33/, A70, HT16K33, disp(16, 8, 'i2c', { roles: { a0: ['ROW0/A0', 'ROW1/A0', 'A0'], a1: ['ROW0/A1', 'ROW1/A1', 'A1'], a2: ['ROW2/A2', 'A2'] }, addr: A3(0x70) }));
T('is31fl3731', 'IS31FL3731', 'display', /\bIS31FL3731/, range(0x74, 4), IS31FL3731, disp(16, 9, 'i2c', { roles: { addr: ['AD'] }, addr: L => 0x74 + ({ scl: 1, sda: 2, 1: 3 }[L.addr] || 0) }));
T('max7219', 'MAX7219', 'display', /\bMAX72(19|21)/, undefined, MAX7219, disp(8, 8, 'spi', { roles: { cs: ['LOAD', 'CS', 'LOAD/CS'], mosi: ['DIN'], miso: ['DOUT'], sck: ['CLK'] } }));
const MUX = { roles: Object.assign({ rst: ['RESET'] }, AR, pinR(8, i => ['SD' + i]), pinR(8, i => ['SC' + i], 'sc')), addr: A3(0x70) };
T('pca9548', 'PCA9548A', 'i2c', /\b(PCA|TCA)954[68]A?/, A70, [I2CMux, 'mask8'], Object.assign({ mux: 8, params: t => ({ name: /(PCA|TCA)954[68]A?/.exec(t)[0] }) }, MUX));
T('pca9545', 'PCA9545A', 'i2c', /\b(PCA|TCA)954[53]A?/, range(0x70, 4), [I2CMux, 'mask4'], Object.assign({ mux: 4, params: t => ({ name: /(PCA|TCA)954[53]A?/.exec(t)[0] }) }, MUX));
T('pca9547', 'PCA9547', 'i2c', /\bPCA9547/, A70, [I2CMux, 'sel8'], Object.assign({ mux: 8 }, MUX));

// ==== memories
// sparse bytes in 4 KB chunks (erased value `fill`) inside D.storage, keyed by the device's store key
class Mem {
	constructor(s) { this.s = s; this.size = s.size; this.fill = s.fill; }
	chunk(a, make) { let c = this.s.sectors.get(a >>> 12); if (!c && make) this.s.sectors.set(a >>> 12, (c = new Uint8Array(4096).fill(this.fill))); return c; }
	get(a) { a %= this.size; const c = this.chunk(a); return c ? c[a & 4095] : this.fill; }
	set(a, v, and) { a %= this.size; const c = this.chunk(a, 1); c[a & 4095] = and ? c[a & 4095] & v : v; }   // and: flash programming only clears bits
	erase(a, n) { for (let k = a >>> 12; k <= (a + n - 1) >>> 12; k++) this.s.sectors.delete(k); }
	used() { return this.s.sectors.size * 4096; }
}
const kb = n => (n >= 1048576 ? n / 1048576 + ' MB' : n >= 1024 ? n / 1024 + ' KB' : n + ' B');

// ---- I2C EEPROM (24Cxx) and FRAM (MB85RC / FM24): p = { size, page, abytes, blk (address bits in the device address), blkShift,
// fram, eui, devid }; 5 ms write cycle (address NACK = ack polling), page wrap, WP pin
class EEPROM24 extends I2CDev {
	constructor(env, spec, address) {
		super(env, spec, address); const p = (this.p = spec); this.mem = new Mem(this.store(p.size, p.fram ? 0 : 0xff));
		const m = (1 << p.blk) - 1, sh = p.blkShift || 0; this.addresses = range(0, m + 1).map(b => (address & ~(m << sh)) | (b << sh));
		this.addr = 0; this.conv = new Conv();
		if (p.eui) [0, 4, 0xa3, 0x12, 0x34, 0x56].forEach((v, i) => this.mem.set(0xfa + i, v));   // EUI-48 in the read-only upper half
		if (p.fram) this.subDevices = [new FRAMID(env, { name: this.name + ' ID', id: 'fram-id' }, 0x7c, this)];
	}
	start(read, a) { if (this.conv.busy(this.t(), true)) return false; this.cur = a ?? this.address; this.ab = []; this.buf = null; return true; }
	write(b) {
		const p = this.p;
		if (this.buf) this.buf.push(b);
		else if (this.ab.push(b) === p.abytes) { let a = 0; for (const x of this.ab) a = a * 256 + x; if (p.blk) a += ((this.cur >> (p.blkShift || 0)) & ((1 << p.blk) - 1)) << (8 * p.abytes); this.addr = a % p.size; this.buf = []; }
		return true;
	}
	read() { const v = this.mem.get(this.addr); this.addr = (this.addr + 1) % this.p.size; return v; }
	stop() {
		const p = this.p, buf = this.buf; this.buf = null;
		if (!buf || !buf.length || this.lvl('wp') === 1) return;
		if (p.fram) for (const b of buf) { this.mem.set(this.addr, b); this.addr = (this.addr + 1) % p.size; }
		else {
			const base = this.addr - (this.addr % p.page); let off = this.addr % p.page;
			for (const b of buf.slice(-p.page)) { if (!(p.eui && base + off >= 0x80)) this.mem.set(base + off, b); off = (off + 1) % p.page; }
			this.addr = base + off; this.conv.begin(this.t(), 0.005);
		}
		this.version++;
	}
	status() { return `${this.name}${this.at()} · ${kb(this.p.size)}${this.conv.busy(this.t()) ? ' · writing' : ''}`; }
}
class FRAMID extends I2CDev {   // FRAM device-ID address 0xF8 (7-bit 0x7C): write the FRAM's address, read 3 ID bytes
	constructor(env, spec, address, parent) { super(env, spec, address); this.parent = parent; }
	start(read) { if (!read) this.tgt = null; this.i = 0; return true; }
	write(b) { this.tgt = b >> 1; return true; }
	read() { return this.tgt === this.parent.address ? this.parent.p.devid[this.i++] ?? 0xff : 0xff; }
}

// ---- SPI NOR flash (W25Q, GD25, MX25, IS25, MT25, AT25SF …): JEDEC / legacy IDs, status registers with BUSY + WEL,
// reads (fast / dual / quad), page program (256-byte wrap), 4K/32K/64K/chip erase, SFDP, unique ID
class NORFlash extends SPIDev {
	constructor(env, spec) {
		super(env, spec); const p = (this.p = spec); this.mem = new Mem(this.store(p.size, 0xff)); this.sr = [0, p.qe ? 2 : 0, 0x60]; this.wel = false; this.bz = -1;
		let h = 0; for (const c of String(env.ref || env.storeKey || spec.id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
		this.uid = [0xd1, 0x6c, h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255, 0x2a, 0x17];
	}
	busy() { if (this.bz >= 0 && this.t() >= this.bz) this.bz = -1; return this.bz >= 0; }
	begin() { this.cmd = -1; this.ad = 0; this.data = null; }
	xfer(b, i) {
		const P = this.p;
		if (!i) {
			const c = (this.cmd = this.busy() && ![5, 0x35, 0x15].includes(b) ? -1 : b);
			if (c === 6 || c === 4) this.wel = c === 6;
			return 0xff;
		}
		const c = this.cmd, j = i - 1, na = P.size > 16777216 && [0x13, 0x0c, 0x12, 0x21, 0xdc].includes(c) ? 4 : 3;
		switch (c) {
			case 5: if (this.busy() && ++this.polls > 40) this.bz = -1; return (this.sr[0] & 0xfc) | (this.busy() ? 1 : 0) | (this.wel ? 2 : 0);   // polling lets time pass
			case 0x35: case 0x15: return this.sr[c === 0x35 ? 1 : 2];
			case 0x9f: return [P.mf, P.type, P.cap][j % 3];
			case 0x90: case 0x92: case 0x94: if (j === 2) this.idsw = b & 1; return j < 3 ? 0xff : [P.mf, P.did][(j - 3 + (this.idsw || 0)) % 2];
			case 0xab: return j < 3 ? 0xff : P.did;
			case 0x4b: return j < 4 ? 0xff : this.uid[(j - 4) % 8];
			case 0x5a: if (j < 3) this.ad = (this.ad << 8) | b; return j < 4 ? 0xff : this.sfdp()[(this.ad + j - 4) & 255];
			case 1: case 0x31: case 0x11: if (this.wel) (this.nsr = this.nsr || [])[c === 1 ? j : c === 0x31 ? 1 : 2] = b; return 0xff;
		}
		const rd = { 3: 0, 0x13: 0, 0x0b: 1, 0x0c: 1, 0x3b: 1, 0x3c: 1, 0x6b: 1, 0x6c: 1, 0xbb: 1, 0xeb: 3 }[c], prog = [2, 0x32, 0x12, 0x34, 0x42].includes(c);   // value = dummy bytes
		if (rd == null && !prog && ![0x20, 0x21, 0x52, 0xd8, 0xdc, 0x44].includes(c)) return 0xff;
		if (j < na) { this.ad = (this.ad * 256 + b) % P.size; return 0xff; }
		if (prog) (this.data = this.data || []).push(b);
		if (rd == null || j < na + rd) return 0xff;
		const v = this.mem.get(this.ad); this.ad = (this.ad + 1) % P.size; return v;
	}
	end() {
		const c = this.cmd, now = this.t();
		if (!this.wel) return;
		const done = (dt, what) => { this.wel = false; this.bz = now + dt; this.polls = 0; this.version++; this.last = what; };
		if ([2, 0x32, 0x12, 0x34].includes(c) && this.data) { const base = this.ad & ~255; let off = this.ad & 255; for (const b of this.data.slice(-256)) { this.mem.set(base + off, b, 1); off = (off + 1) & 255; } done(0.0007, 'program'); }
		else if (c === 0x20 || c === 0x21) { this.mem.erase(this.ad & ~4095, 4096); done(0.045, 'erase 4K'); }
		else if (c === 0x52) { this.mem.erase(this.ad & ~32767, 32768); done(0.12, 'erase 32K'); }
		else if (c === 0xd8 || c === 0xdc) { this.mem.erase(this.ad & ~65535, 65536); done(0.15, 'erase 64K'); }
		else if (c === 0xc7 || c === 0x60) { this.mem.s.sectors.clear(); done(Math.min(2, this.p.size / 8e6), 'chip erase'); }
		else if (this.nsr && [1, 0x31, 0x11].includes(c)) { this.nsr.forEach((v, k) => (this.sr[k] = k ? v : v & 0xfc)); this.nsr = null; done(0.001, 'status'); }
	}
	sfdp() {   // SFDP header + basic flash parameter table (density, fast-read opcodes, erase types)
		if (this._sfdp) return this._sfdp;
		const t = new Array(256).fill(0xff), n = this.p.size * 8 - 1, put = (a, v) => v.forEach((x, i) => (t[a + i] = x));
		put(0, [0x53, 0x46, 0x44, 0x50, 6, 1, 0, 0xff, 0, 6, 1, 0x10, 0x80, 0, 0, 0xff]);
		put(0x80, [0xe5, 0x20, 0xf1, 0xff, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24, 0x44, 0xeb, 8, 0x6b, 8, 0x3b, 0x42, 0xbb, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0xff, 0xff, 0xff, 0x44, 0xeb, 0x0c, 0x20, 0x0f, 0x52, 0x10, 0xd8, 0, 0xff]);
		return (this._sfdp = t);
	}
	status() { return `${this.name} · ${kb(this.p.size)} · ID ${hex(this.p.mf)} ${hex(this.p.type)} ${hex(this.p.cap)}${this.busy() ? ' · busy (' + this.last + ')' : ''} · ${kb(this.mem.used())} used`; }
}
class PSRAM extends SPIDev {   // APS6404L, ESP-PSRAM32/64, LY68L6400: read ID (MF, KGD 0x5D), read / fast / quad read, write, 1 KB wrap (0xC0 toggles 32 B)
	constructor(env, spec) { super(env, spec); this.p = spec; this.mem = new Mem({ size: spec.size, fill: 0, sectors: new Map() }); this.wrap = 1024; }
	begin() { this.cmd = -1; this.ad = 0; }
	xfer(b, i) {
		if (!i) { this.cmd = b; if (b === 0xc0) this.wrap ^= 1056; if (b === 0x99) this.wrap = 1024; return 0xff; }
		const c = this.cmd, j = i - 1, dummy = { 3: 0, 2: 0, 0x38: 0, 0x0b: 1, 0xeb: 3 }[c];
		if (c === 0x9f) return j < 3 ? 0xff : [this.p.mf, 0x5d, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc][(j - 3) % 8];
		if (dummy == null || j < 3 + dummy) { if (dummy != null && j < 3) this.ad = (this.ad * 256 + b) % this.p.size; return 0xff; }
		const a = this.ad, w = this.wrap - 1; this.ad = (a & ~w) | ((a + 1) & w);
		if (c !== 2 && c !== 0x38) return this.mem.get(a);
		this.mem.set(a, b); this.version++; return 0xff;
	}
	status() { return `${this.name} · ${kb(this.p.size)} PSRAM · ${kb(this.mem.used())} touched`; }
}
// SD / SDHC card in SPI mode: CMD0/1/8/9/10/12/13/16/17/18/24/25/55/58/59, ACMD13/23/41; 512-byte blocks
class SDCard extends SPIDev {
	constructor(env, spec) { super(env, spec); this.blocks = Math.floor(spec.size / 512); this.mem = new Mem(this.store(this.blocks * 512, 0)); this.idle = true; this.ready = this.acmd = false; this.q = []; this.cmdb = []; this.st = 'cmd'; this.a41 = 0; }
	end() { if (this.st === 'rdm') { this.st = 'cmd'; this.q = []; } }
	block(n) { return range(n * 512, 512).map(a => this.mem.get(a)); }
	xfer(b) {
		const out = this.q.length ? this.q.shift() : 0xff;
		if (this.st === 'rdm' && this.q.length < 4) this.q.push(0xff, 0xfe, ...this.block(this.rb++), 0xff, 0xff);
		if (this.st === 'wrwait') {
			if (b === 0xfe || b === 0xfc) { this.st = 'wr'; this.wbuf = []; }
			else if (b === 0xfd && this.multi) { this.st = 'cmd'; this.q.push(0xff, 0, 0, 0xff); }
			else this.cmdIn(b);
		} else if (this.st === 'wr') {
			if (this.wbuf.push(b) === 514) { const blk = this.wb++; for (let i = 0; i < 512; i++) this.mem.set(blk * 512 + i, this.wbuf[i]); this.version++; this.q.push(5, 0, 0, 0xff); this.st = this.multi ? 'wrwait' : 'cmd'; }
		} else this.cmdIn(b);
		return out;
	}
	cmdIn(b) {
		if (!this.cmdb.length && (b & 0xc0) !== 0x40) return;
		if (this.cmdb.push(b) < 6) return;
		const [c0, a, b1, c, d] = this.cmdb, cmd = c0 & 63, arg = ((a << 24) | (b1 << 16) | (c << 8) | d) >>> 0, r1 = this.idle ? 1 : 0, acmd = this.acmd;
		this.cmdb = []; this.acmd = false;
		if (this.st === 'rdm' && cmd !== 12) return;
		const R = (...x) => (this.q = [0xff, ...x]), data = v => R(0, 0xff, 0xfe, ...v, 0xff, 0xff), n = this.blocks / 1024 - 1;
		if (cmd === 0) { this.idle = true; this.ready = false; this.st = 'cmd'; R(1); }
		else if (cmd === 8) R(r1, 0, 0, (arg >> 8) & 15, arg & 255);
		else if (cmd === 55) { this.acmd = true; R(r1); }
		else if ((acmd && cmd === 41) || cmd === 1) { if (++this.a41 >= 2) { this.idle = false; this.ready = true; } R(r1); }
		else if (cmd === 58) R(r1, this.ready ? 0xc0 : 0, 0xff, 0x80, 0);
		else if (cmd === 59 || cmd === 16 || (acmd && cmd === 23)) R(r1);
		else if (cmd === 9) data([0x40, 0x0e, 0, 0x32, 0x5b, 0x59, 0, (n >> 16) & 0x3f, (n >> 8) & 255, n & 255, 0x7f, 0x80, 0x0a, 0x40, 0, 1]);   // CSD v2
		else if (cmd === 10) data([3, 0x53, 0x44, 0x4e, 0x4f, 0x45, 0x54, 0x49, 0x10, 0x12, 0x34, 0x56, 0x78, 1, 0x9a, 1]);   // CID "SDNOETI"
		else if (cmd === 13) { if (acmd) data(new Array(64).fill(0)); else R(0, 0); }
		else if (cmd === 17) { if (arg >= this.blocks) R(0x40); else data(this.block(arg)); }
		else if (cmd === 18) { this.rb = arg; R(0, 0xff); this.st = 'rdm'; this.q.push(0xfe, ...this.block(this.rb++), 0xff, 0xff); }
		else if (cmd === 12) { this.st = 'cmd'; R(0xff, 0, 0, 0xff); }
		else if (cmd === 24 || cmd === 25) { if (arg >= this.blocks) R(0x40); else { this.wb = arg; R(0); this.st = 'wrwait'; this.multi = cmd === 25; } }
		else R(r1 | 4);
	}
	status() { return `SD card · ${kb(this.blocks * 512)} · ${this.ready ? 'ready' : 'idle'}`; }
}

// ---- templates
function eeGeom(t) {   // 24x01 … 24xM02 → [size, page, address bytes, block bits, block shift]
	const m = /(?:24(?:[A-Z]{1,3})?|M24C?|BL24C|CAT24C?|AT24CS?|FT24C|K24C|HT24LC)(M0[12]|102[56]|512|256|128|64|32|16|0?[1248])(?![0-9])/.exec(t), k = m ? m[1].replace(/^0/, '') : 2;
	const [size, page, abytes, blk = 0, blkShift = 0] = { 1: [128, 8, 1], 2: [256, 8, 1], 4: [512, 16, 1, 1], 8: [1024, 16, 1, 2], 16: [2048, 16, 1, 3], 32: [4096, 32, 2], 64: [8192, 32, 2], 128: [16384, 64, 2], 256: [32768, 64, 2],
		512: [65536, 128, 2], M01: [131072, 256, 2, 1], 1025: [131072, 128, 2, 1, 2], 1026: [131072, 128, 2, 1], M02: [262144, 256, 2, 2] }[k] || [256, 8, 1];
	return { size, page, abytes, blk, blkShift, eui: /24AA025?E/.test(t) };
}
const eeAddr = (L, p) => (p.blkShift === 2 ? 0x50 | lvl01(L.a0) | (lvl01(L.a1) << 1) : [0, 1, 2].reduce((a, i) => (i < p.blk ? a : a | (lvl01(L['a' + i]) << i)), 0x50));
const EER = { roles: { a0: ['A0', 'E0'], a1: ['A1', 'E1'], a2: ['A2', 'E2', 'A2/NC'], wp: ['WP', 'WC'] }, addr: eeAddr }, A50 = range(0x50, 8), ee = EEPROM24;
T('fram-i2c', 'I2C FRAM', 'i2c', /\bMB85RC\d+|\bFM24(C?L?|V)\d+|\bCY15B\d+/, A50, ee, Object.assign({ params: t => {
	const m = /(MB85RC|FM24C?L?|FM24V|CY15B)(\d+)/.exec(t), n = +m[2], size = Math.max(512, (m[1] === 'FM24V' ? { 1: 128, 2: 256, 5: 512, 10: 1024 }[n] || 256 : m[1] === 'CY15B' ? 256 : n) * 128);
	return { size, page: size, abytes: size > 2048 ? 2 : 1, blk: size <= 2048 && size > 256 ? Math.log2(size / 256) : 0, fram: true, devid: /MB85RC/.test(t) ? [0, 0xa5, 0x10] : [0, 0x4a, 0x10], name: m[0] };
} }, EER));
T('eeprom24', '24Cxx EEPROM', 'i2c', /\b(24(AA|LC|FC|C|CW|CS|M)\d|AT24C[SM]?\d|CAT24[CM]?\d|M24C?\d|BL24C|FT24C|K24C|HT24LC|GT24C|24C\d+)/, A50, ee,
	Object.assign({ params: t => Object.assign(eeGeom(t), { name: (/\b[A-Z0-9]*24[A-Z]*\d+[A-Z0-9]*/.exec(t) || ['24Cxx'])[0].slice(0, 14) }) }, EER));
function flashGeom(t) {   // capacity from the part number; JEDEC manufacturer / memory type / capacity code (log2 bytes)
	let m, mbit = 16;
	if ((m = /MX25[LRUV](\d{2,4})/.exec(t))) mbit = /^(128|256|512)/.test(m[1]) ? +m[1].slice(0, 3) : m[1].startsWith('80') ? 8 : +m[1].slice(0, 2);
	else if ((m = /AT25[SD]F(\d{3})/.exec(t))) mbit = { '041': 4, '081': 8, 161: 16, 321: 32, 641: 64, 128: 128 }[m[1]] || 8;
	else if ((m = /(?:W25[QX]|GD25[A-Z]*|IS25[A-Z]{2}|MT25Q[LU]|N25Q|ZD25[A-Z]*|XM25Q[A-Z]*|P25Q|BY25Q|EN25QH?|XT25F|FM25Q|SST25VF|S25FL1?)(01G|\d+)/.exec(t))) mbit = { '01': 1024, '01G': 1024, 10: 1, 20: 2, 40: 4, 80: 8, '080': 8, '040': 4 }[m[1]] || +m[1];
	if ((m = /(\d+)\s*MB\b/.exec(t)) && !/W25Q|GD25|MX25|IS25|MT25|AT25|ZD25|XM25/.test(t)) mbit = +m[1] * 8;
	const size = mbit * 131072, cap = Math.round(Math.log2(size));
	if (/AT25[SD]F/.test(t)) return { size, mf: 0x1f, type: 0x84 + Math.round(Math.log2(mbit / 4)), cap: 1, did: cap - 1 };
	const V = [[/GD25(L[QE]|WQ)/, 0xc8, 0x60], [/GD25/, 0xc8, 0x40], [/MX25R/, 0xc2, 0x28], [/MX25U/, 0xc2, 0x25], [/MX25/, 0xc2, 0x20], [/IS25(WP|LE)/, 0x9d, 0x70], [/IS25/, 0x9d, 0x60], [/MT25QU/, 0x20, 0xbb], [/MT25|N25Q/, 0x20, 0xba],
		[/ZD25/, 0xba, 0x60], [/XM25/, 0x20, 0x70], [/P25Q/, 0x85, 0x60], [/BY25Q/, 0x68, 0x40], [/EN25Q/, 0x1c, 0x70], [/XT25F/, 0x0b, 0x40], [/FM25Q/, 0xa1, 0x40], [/W25Q\d+([A-Z]*J|[FN])W/, 0xef, 0x60], [/W25Q\d+JV\w*[IJ]M/, 0xef, 0x70], [/W25X/, 0xef, 0x30]].find(v => v[0].test(t)) || [0, 0xef, 0x40];
	return { size, mf: V[1], type: V[2], cap: cap === 29 ? 0x20 : cap, did: cap - 1, qe: /W25Q\d+JV\w*IQ/.test(t) };
}
const FL = { cs: ['CS', 'CE', 'SS', 'CSN', 'NCS'], mosi: ['DI', 'IO0', 'SI', 'D0', 'DI(IO0)', 'SIO0', 'MOSI'], miso: ['DO', 'IO1', 'SO', 'D1', 'DO(IO1)', 'SIO1', 'MISO'], sck: ['CLK', 'SCK', 'SCLK'], wp: ['WP', 'IO2'], hold: ['HOLD', 'IO3', 'RESET'] };
T('spiflash', 'SPI NOR flash', 'spi', /\b(W25[QX]\d+|GD25[A-Z]*\d+|MX25[LRUV]\d+|IS25[A-Z]{2}\d+|MT25Q[LU]\d+|N25Q\d+|AT25(SF|DF|XE|QF)\d+|ZD25[A-Z]*\d+|XM25Q[A-Z]*\d+|P25Q\d+|BY25Q\d+|EN25QH?\d+|XT25F\d+|FM25Q\d+|S25FL\d+|SST25VF\d+)/, undefined,
	NORFlash, { generic: /^(Q?SPI ?FLASH|NOR ?FLASH|SERIAL ?FLASH|FLASH)\b/, roles: FL,
		params: t => Object.assign(flashGeom(t), { name: (/\b(W25[QX]|GD25|MX25|IS25|MT25|N25Q|AT25|ZD25|XM25|P25Q|BY25|EN25|XT25|FM25Q|S25FL|SST25)[A-Z0-9]*/.exec(t) || ['SPI flash'])[0] }) });
T('psram', 'SPI PSRAM', 'spi', /\b(APS6404|APS1604|ESP-?PSRAM(32|64)|LY68L6400|IS6[26]WVS\d+|LY68L|APS256)/, undefined, PSRAM, { generic: /^(Q?SPI ?)?PSRAM|^HYPERRAM/,
	roles: Object.assign({}, FL, { mosi: ['SI/SIO', 'SI', 'MOSI/IO0', 'DI(IO0)', 'DI', 'SIO0', 'IO0'], miso: ['SO/SIO', 'SO', 'MISO/IO1', 'DO(IO1)', 'DO', 'SIO1', 'IO1'], sck: ['SCLK', 'SCK', 'CLK'] }),
	params: t => ({ size: /APS1604|PSRAM16/.test(t) ? 2097152 : /PSRAM32/.test(t) ? 4194304 : /APS256/.test(t) ? 33554432 : 8388608, mf: /IS6[26]/.test(t) ? 0x9d : 0x0d, name: (/\b(APS\d+[A-Z]*|ESP-?PSRAM\d+H?|LY68L\d+|IS6[26]WVS\d+)/.exec(t) || ['PSRAM'])[0] }) });
T('sdcard', 'microSD card', 'spi', /\b(MICRO_?SD|MICROSD|SD[ _]?CARD|TF[ _-]?CARD|MICRO[ -]SD|SDCARD)/, undefined, SDCard,
	{ roles: { cs: ['DAT3/CD', 'CD/DAT3', 'DAT3', 'CS'], mosi: ['CMD', 'DI', 'MOSI'], miso: ['DAT0', 'DO', 'MISO'], sck: ['CLK', 'SCLK'] }, params: () => ({ size: 1073741824 }) });

// ==== real-time clocks: run on env.now() (no library skew) from D.RTC_BASE
D.RTC_BASE = Date.UTC(2026, 0, 1) / 1000;   // 2026-01-01 00:00:00
const tfields = e => { const d = new Date(Math.floor(e) * 1000); return { s: d.getUTCSeconds(), m: d.getUTCMinutes(), h: d.getUTCHours(), dow: d.getUTCDay(), day: d.getUTCDate(), mon: d.getUTCMonth() + 1, year: d.getUTCFullYear() }; };
const hEnc = (h, h12) => (h12 ? 0x40 | (h >= 12 ? 0x20 : 0) | bcd(h % 12 || 12) : bcd(h)), hDec = v => (v & 0x40 ? (unbcd(v & 0x1f) % 12) + (v & 0x20 ? 12 : 0) : unbcd(v & 0x3f));
// m: { r: [sec, min, hour, weekday, day, month, year] registers, dowBase, cent (century bit in month), size, wrap }
class RTC extends RegDev {
	constructor(env, spec, address, m) { super(env, spec, address, m.size); this.m = m; this.base = D.RTC_BASE - this.tn(); this.stopped = false; this.dowOff = 0; this.frozen = D.RTC_BASE; }
	tn() { return this.env.now ? this.env.now() : 0; }
	epoch() { return this.stopped ? this.frozen : this.base + this.tn(); }
	run(on) { if (on === this.stopped) { if (on) this.base = this.frozen - this.tn(); else this.frozen = Math.floor(this.epoch()); this.stopped = !on; } }
	next(r) { return r >= this.m.wrap ? 0 : r + 1; }
	start(read) { this.snap(); if (!read) this.wset = new Set(); if (this.alarms) this.alarms(); return true; }
	snap() {   // time → BCD registers (keeping flag bits)
		const f = tfields(this.epoch()), [S, M, H, W, Dd, Mo, Y] = this.m.r, r = this.regs, c = this.m.cent;
		r[S] = (r[S] & 0x80) | bcd(f.s); r[M] = (r[M] & 0x80) | bcd(f.m); r[H] = (r[H] & 0x80) | hEnc(f.h, this.h12 && r[H] & 0x40);
		r[W] = (r[W] & ~7) | (((f.dow + this.dowOff) % 7) + this.m.dowBase); r[Dd] = bcd(f.day); r[Mo] = bcd(f.mon) | (c && f.year >= 2100 ? c : 0); r[Y] = bcd(f.year % 100);
		if (this.snapExtra) this.snapExtra(f);
	}
	wr(a, v) { this.regs[a] = v; if (this.m.r.includes(a)) this.wset.add(a); this.version++; }
	stop() {   // time registers written in this transaction → new epoch
		if (!this.wset || !this.wset.size) return;
		const [S, M, H, W, Dd, Mo, Y] = this.m.r, r = this.regs, c = this.m.cent && r[Mo] & this.m.cent ? 100 : 0;
		const e = Date.UTC(2000 + unbcd(r[Y]) + c, unbcd(r[Mo] & 0x1f) - 1, unbcd(r[Dd] & 0x3f), hDec(r[H] & 0x7f), unbcd(r[M] & 0x7f), unbcd(r[S] & 0x7f)) / 1000;
		if (this.stopped) this.frozen = e; else this.base = e - this.tn();
		if (this.wset.has(W)) this.dowOff = ((((r[W] & 7) - this.m.dowBase - tfields(e).dow) % 7) + 14) % 7;
		this.wset = null; this.version++;
	}
	ts() { const f = tfields(this.epoch()), p = n => String(n).padStart(2, '0'); return `${f.year}-${p(f.mon)}-${p(f.day)} ${p(f.h)}:${p(f.m)}:${p(f.s)}`; }
	status() { return `${this.name}${this.at()} · ${this.ts()}${this.stopped ? ' · stopped' : ''}`; }
}
const R7 = [0, 1, 2, 3, 4, 5, 6];
class DS3231 extends RTC {   // alarms 1/2 (flags, INTCN → INT/SQW low), OSF, temperature registers
	constructor(env, spec, address) { super(env, spec, address, { r: R7, dowBase: 1, cent: 0x80, size: 0x13, wrap: 0x12 }); this.h12 = true; this.regs[0x0e] = 0x1c; this.regs[0x0f] = 8; this.lastA = Math.floor(this.epoch()); }
	wr(a, v) { if (a === 0x0f) this.regs[a] = (this.regs[a] & v & 0x83) | (v & 8); else if (a < 0x11) super.wr(a, v); }
	snapExtra() { const T = Math.round((this.w('tempC') + this.nz(0.1)) * 4) / 4; this.regs[0x11] = Math.floor(T) & 255; this.regs[0x12] = ((T - Math.floor(T)) * 4) << 6; }
	alarms() {
		const now = Math.floor(this.epoch()), r = this.regs, from = Math.max(this.lastA + 1, now - 172800); this.lastA = now;
		const hit = (f, a, n) => {   // mask bits A1M1..A1M4 / A2M2..A2M4, DY/DT
			const x = n === 1 ? r.slice(a, a + 4) : [0x80, r[a], r[a + 1], r[a + 2]], d = x[3];
			return (n === 1 || f.s === 0) && (x[0] & 0x80 || unbcd(x[0] & 0x7f) === f.s) && (x[1] & 0x80 || unbcd(x[1] & 0x7f) === f.m) && (x[2] & 0x80 || hDec(x[2] & 0x7f) === f.h) &&
				(d & 0x80 || (d & 0x40 ? ((f.dow + this.dowOff) % 7) + 1 === (d & 15) : unbcd(d & 0x3f) === f.day));
		};
		for (let e = from; e <= now && (r[15] & 3) !== 3; e++) { const f = tfields(e); if (hit(f, 7, 1)) r[15] |= 1; if (hit(f, 11, 2)) r[15] |= 2; }
		this.pin('int', r[14] & 4 && r[15] & r[14] & 3 ? 'od' : 'z');
	}
	status() { return super.status() + (this.regs[15] & 3 ? ' · alarm' : ''); }
}
class DS1307 extends RTC {   // CH bit stops the clock; 56 bytes battery-backed RAM
	constructor(env, spec, address) { super(env, spec, address, { r: R7, dowBase: 1, size: 0x40, wrap: 0x3f }); this.h12 = true; this.regs[7] = 3; this.nv = new Mem(this.store(56, 0)); }
	rd(a) { return a >= 8 ? this.nv.get(a - 8) : this.regs[a]; }
	wr(a, v) { if (a >= 8) this.nv.set(a - 8, v); else { super.wr(a, v); if (!a) this.run(!(v & 0x80)); } }
	snap() { super.snap(); this.regs[0] = (this.stopped ? 0x80 : 0) | (this.regs[0] & 0x7f); }
}
class PCF8563 extends RTC {   // STOP bit in control 1, VL flag in the seconds register
	constructor(env, spec, address) { super(env, spec, address, { r: [2, 3, 4, 6, 5, 7, 8], dowBase: 0, cent: 0x80, size: 16, wrap: 15 }); this.regs.fill(0x80, 9, 14); }
	wr(a, v) { super.wr(a, a === 2 ? v & 0x7f : v); if (!a) this.run(!(v & 0x20)); }
	snap() { super.snap(); this.regs[2] &= 0x7f; }
}
class RV3028 extends RTC {   // UNIX time counter 0x1B..0x1E, EEPROM command interface (EEADDR 0x25, EEDATA 0x26, EECMD 0x27)
	constructor(env, spec, address) { super(env, spec, address, { r: R7, dowBase: 0, size: 0x40, wrap: 0x3f }); this.regs[0x28] = 0x30; this.regs[0x37] = 0x10; this.uoff = 0; }
	snapExtra() { const u = Math.floor(this.epoch() - this.uoff) >>> 0; for (let i = 0; i < 4; i++) this.regs[0x1b + i] = (u >>> (8 * i)) & 255; }
	wr(a, v) {
		super.wr(a, v); const r = this.regs;
		if (a === 0x1e) { let u = 0; for (let i = 3; i >= 0; i--) u = u * 256 + r[0x1b + i]; this.uoff = Math.floor(this.epoch()) - u; }
		if (a === 0x27) { if (v === 0x22 || v === 0x21) r[0x26] = r[0x30 + (r[0x25] & 15)] || 0; r[0x0e] &= ~0x80; }
	}
	rd(a) { return a === 0x0e ? this.regs[a] & ~0x80 : this.regs[a]; }
}
class MCP7940 extends RTC {   // ST bit runs the oscillator; OSCRUN in RTCWKDAY, LPYR in RTCMTH
	constructor(env, spec, address) { super(env, spec, address, { r: R7, dowBase: 1, size: 0x60, wrap: 0x5f }); this.h12 = true; Object.assign(this.regs, { 0: 0x80, 3: 8, 7: 0x80 }); }
	snap() { const r = this.regs, k0 = r[0] & 0x80, k3 = r[3] & 0x18; super.snap(); r[0] = k0 | (r[0] & 0x7f); r[3] = k3 | (this.stopped ? 0 : 0x20) | (r[3] & 7); if (tfields(this.epoch()).year % 4 === 0) r[5] |= 0x20; }
	wr(a, v) { super.wr(a, v); if (!a) this.run(!!(v & 0x80)); }
}

// ==== Si5351 clock generator: PLL A/B + multisynth dividers → output frequencies
// (env.setFreq('clkN', Hz)), PLL loss-of-lock bits in the status register
class SI5351 extends RegDev {
	constructor(env, spec, address) { super(env, spec, address); this.xtal = spec.xtal || 25e6; this.regs[3] = 0xff; this.regs.fill(0x80, 16, 24); this.regs[183] = 0xd2; this.f = []; }
	rd(a) { return a ? this.regs[a] : (this.pllOk(0) ? 0 : 0x20) | (this.pllOk(1) ? 0 : 0x40); }
	pllOk(i) { const r = this.regs, b = 26 + 8 * i; return !!(r[b + 1] | r[b + 2] | r[b + 3] | r[b + 4]); }
	ratio(b) { const r = this.regs, p1 = ((r[b + 2] & 3) << 16) | (r[b + 3] << 8) | r[b + 4], p2 = ((r[b + 5] & 15) << 16) | (r[b + 6] << 8) | r[b + 7], p3 = ((r[b + 5] >> 4) << 16) | (r[b] << 8) | r[b + 1]; return (p1 + 512 + (p3 ? p2 / p3 : 0)) / 128; }
	wr(a, v) { if (a > 1) { this.regs[a] = v; this.calc(); } }
	calc() {
		const r = this.regs, vco = [26, 34].map(b => this.xtal * this.ratio(b));
		for (let n = 0; n < 8; n++) {
			const c = r[16 + n], b = 42 + 8 * n, v = vco[(c >> 5) & 1];
			const hz = c & 0x80 || (r[3] >> n) & 1 ? 0 : n > 5 ? (r[84 + n] ? v / r[84 + n] : 0) : ((c >> 2) & 3) === 3 ? v / (((r[b + 2] >> 2) & 3) === 3 ? 4 : this.ratio(b)) / (1 << ((r[b + 2] >> 4) & 7)) : 0;
			if (this.f[n] !== hz && this.env.setFreq) this.env.setFreq('clk' + n, hz);
			this.f[n] = hz;
		}
		this.version++;
	}
	status() { const s = this.f.map((h, i) => h && `CLK${i} ${fx(h / 1e6, 3)} MHz`).filter(Boolean); return `Si5351${this.at()} · ${s.join(' · ') || 'outputs off'}`; }
}

// ==== MCP2515 CAN controller: SPI instructions (RESET, READ, WRITE, BIT MODIFY, READ STATUS), register file, modes (REQOP → CANSTAT); no frames
class MCP2515 extends SPIDev {
	constructor(env, spec) { super(env, spec); this.r = new Uint8Array(128); this.reset(); }
	reset() { const r = this.r; r.fill(0); for (let a = 0x0e; a < 0x80; a += 16) { r[a] = 0x80; r[a + 1] = 0x87; } this.version++; }
	set(a, v) {
		const r = this.r;
		if ((a & 15) === 15) for (let k = 0x0e; k < 0x80; k += 16) { r[k + 1] = v; r[k] = (r[k] & 0x1f) | (v & 0xe0); }   // CANCTRL (mirrored); the mode follows at once
		else if ((a & 15) !== 14) r[a] = v;
		this.version++;
	}
	xfer(b, i) {
		const r = this.r, c = this.cmd, j = i - 1, k = this.ad;
		if (!i) { this.cmd = b; if (b === 0xc0) this.reset(); return 0xff; }
		if (c === 2 || c === 3 || c === 5) { if (!j) { this.ad = b & 0x7f; return 0xff; } }
		if (c === 5) { if (j === 1) this.mask = b; else if (j === 2) this.set(k, (r[k] & ~this.mask) | (b & this.mask)); }
		else if (c === 3) { this.ad = (k + 1) & 0x7f; return r[k]; }
		else if (c === 2) { this.set(k, b); this.ad = (k + 1) & 0x7f; }
		else if (c === 0xa0) return (r[0x2c] & 3) | ((r[0x2c] << 1) & 8) | ((r[0x2c] << 2) & 32) | ((r[0x2c] << 3) & 128);
		return 0xff;
	}
	status() { const m = this.r[0x0e] >> 5; return `MCP2515 · ${['normal', 'sleep', 'loopback', 'listen-only', 'configuration'][m] || 'mode ' + m}`; }
}

// ==== basic register files (codecs, amplifiers, USB-C port controllers …)
// p: { init: { reg: value }, ro: [regs], a16 / d16 (16-bit address / data), wm (WM8731 7+9-bit words), writeOnly }
class SimpleRegs extends I2CDev {
	constructor(env, spec, address, p) { super(env, spec, address); this.p = p; this.r = new Map(Object.entries(p.init || {}).map(([k, v]) => [+k, v])); this.ptr = 0; }
	start(read) { if (read && this.p.writeOnly) return false; this.b = []; return true; }
	write(b) {
		const p = this.p, x = this.b, n = x.push(b), ab = p.a16 ? 2 : 1, db = p.d16 ? 2 : 1;
		if (p.wm) { if (n === 2) { this.r.set(x[0] >> 1, ((x[0] & 1) << 8) | b); this.version++; } }
		else if (n === ab) this.ptr = p.a16 ? (x[0] << 8) | b : b;
		else if (n > ab && (n - ab) % db === 0) { if (!(p.ro || []).includes(this.ptr)) this.r.set(this.ptr, db === 2 ? (x[n - 2] << 8) | b : b); this.ptr += p.a16 && db === 2 ? 2 : 1; this.version++; }
		return true;
	}
	read() {
		const p = this.p, v = this.r.get(this.ptr) || 0;
		if (!p.d16) { this.ptr = (this.ptr + 1) & (p.a16 ? 0xffff : 0xff); return v; }
		if ((this.hi = !this.hi)) return v >> 8;
		this.ptr += p.a16 ? 2 : 1; return v & 255;
	}
}

// ==== USB-UART bridges (kind 'uart': the UART pins lead to the USB port)
class Bridge extends Dev { status() { return `${this.name} · UART ↔ USB`; } }
// ---- templates
const RTCR = { roles: { int: ['INT/SQW', 'SQW/INT', 'INT', 'SQW', 'MFP', 'SQW/OUT'], vbat: ['VBAT'] } };
const rtc = (id, name, re, a, C) => T(id, name, 'i2c', re, [a], C, RTCR);
rtc('ds3231', 'DS3231', /\bDS323[12]/, 0x68, DS3231);
rtc('ds1307', 'DS1307', /\bDS1307|\bDS1338/, 0x68, DS1307);
rtc('pcf8563', 'PCF8563', /\b(PCF|BM|HYM|RTC)8563/, 0x51, PCF8563);
rtc('rv3028', 'RV-3028-C7', /\bRV-?3028/, 0x52, RV3028);
rtc('mcp7940', 'MCP7940N', /\bMCP794[01]/, 0x6f, MCP7940);
T('si5351', 'Si5351', 'i2c', /\bSI5351/, [0x60, 0x61], SI5351, { roles: { addr: ['A0'] }, params: t => ({ xtal: /27\s?MHZ/.test(t) ? 27e6 : 25e6 }), addr: A1(0x60) });
T('mcp2515', 'MCP2515', 'spi', /\bMCP25(15|625)/, undefined, MCP2515, { roles: { int: ['INT'], rst: ['RESET'], mosi: ['SI'], miso: ['SO'] } });
const SR = (id, name, re, addresses, p, addr) => T(id, name, 'i2c', re, addresses, [SimpleRegs, p], { roles: p.roles, addr });
SR('es8311', 'ES8311', /\bES8311/, [0x18, 0x19], { init: { 0: 0x1f, 0xfd: 0x83, 0xfe: 0x11, 0xff: 0 }, ro: [0xfd, 0xfe, 0xff], roles: { addr: ['CE'] } }, A1(0x18));
SR('es8156', 'ES8156', /\bES8156/, [0x08, 0x09], { init: { 0xfd: 0x81, 0xfe: 0x55, 0xff: 0x10 }, ro: [0xfd, 0xfe, 0xff], roles: { addr: ['AD0', 'CE'] } }, A1(0x08));
SR('wm8731', 'WM8731', /\bWM87(31|60)|\bWM8960/, [0x1a, 0x1b], { wm: true, writeOnly: true, roles: { addr: ['CSB'] } }, A1(0x1a));
SR('ak4619', 'AK4619', /\bAK4619/, [0x10, 0x11], { init: { 1: 0x0c, 2: 0x0c, 4: 0x22, 6: 0x18, 7: 0x18 }, roles: { addr: ['CAD'] } }, A1(0x10));
SR('tpa2016', 'TPA2016D2', /\bTPA20(16|28)/, [0x58], { init: { 1: 0xc3, 2: 5, 3: 0x0b, 5: 6, 6: 0x3a, 7: 0xc2 } });
SR('tusb320', 'TUSB320', /\bTUSB32[0-2]/, [0x47, 0x61], { init: toBytes('TUSB320').reverse(), ro: R7.concat(7), roles: { addr: ['ADDR'] } }, L => (L.addr === 1 ? 0x61 : 0x47));
SR('ltc2943', 'LTC2943', /\bLTC294[1-4]/, [0x64], { init: { 1: 0x3c, 2: 0x7f, 3: 0xff, 6: 0xff, 7: 0xff } });
SR('pn7150', 'PN7150', /\bPN71[56]0/, [0x28, 0x29, 0x2a, 0x2b], {});
const UART = /\b(CH34[0-3][A-Z]?|CH9102|CH910[134]|CP210[0-9][A-Z]?|FT232[RHB]?[LQ]?|FT23[01]X|FT[24]232H?P?|PL2303|CY7C65213|MCP22[02][01])/;
T('usb-uart', 'USB-UART bridge', 'uart', UART, undefined, Bridge,
	{ roles: { tx: ['TXD', 'TX', 'TXD0', 'ADBUS0', 'TXD_0', 'TX/'], rx: ['RXD', 'RX', 'RXD0', 'ADBUS1'], rts: ['RTS', 'RTS#'], dtr: ['DTR', 'DTR#'], cts: ['CTS'] }, params: t => ({ name: UART.exec(t)[0] }) });

// ==== bitmap data
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function unb64(s) { const out = []; let buf = 0, n = 0; for (const c of s) { const v = B64.indexOf(c); if (v < 0) continue; buf = ((buf << 6) | v) & 0xffffff; n += 6; if (n >= 8) { n -= 8; out.push((buf >> n) & 255); } } return new Uint8Array(out); }
// Adafruit GFX 'classic' 5x7 font (glcdfont.c, 256 glyphs × 5 column bytes, bit 0 = top row)
const FONT5X7 = unb64('AAAAAAA+W09bPj5rT2s+HD58PhwYPH48GBxXfVccHF5/XhwAGDwYAP/nw+f/ABgkGAD/59vn/zBIOgYOJil5KSZAfwUFB0B/BSU/WjznPFp/PhwcCAgcHD5/' +
	'FCJ/IhRfXwBfXwYJfwF/AGaJlWpgYGBgYJSi/6KUCAR+BAgQIH4gEAgIKhwICBwqCAgeEBAQEAweDB4MMDg+ODAGDj4OBgAAAAAAAABfAAAABwAHABR/FH8U' +
	'JCp/KhIjEwhkYjZJViBQAAgHAwAAHCJBAABBIhwAKhx/HCoICD4ICACAcDAACAgICAgAAGBgACAQCAQCPlFJRT4AQn9AAHJJSUlGIUFJTTMYFBJ/ECdFRUU5' +
	'PEpJSTFBIREJBzZJSUk2RklJKR4AABQAAABANAAAAAgUIkEUFBQUFABBIhQIAgFZCQY+QV1ZTnwSERJ8f0lJSTY+QUFBIn9BQUE+f0lJSUF/CQkJAT5BQVFz' +
	'fwgICH8AQX9BACBAQT8BfwgUIkF/QEBAQH8CHAJ/fwQIEH8+QUFBPn8JCQkGPkFRIV5/CRkpRiZJSUkyAwF/AQM/QEBAPx8gQCAfP0A4QD9jFAgUYwMEeAQD' +
	'YVlJTUMAf0FBQQIECBAgAEFBQX8EAgECBEBAQEBAAAMHCAAgVFR4QH8oREQ4OERERCg4REQofzhUVFQYAAh+CQIYpKSceH8IBAR4AER9QAAgQEA9AH8QKEQA' +
	'AEF/QAB8BHgEeHwIBAR4OERERDj8GCQkGBgkJBj8fAgEBAhIVFRUJAQEP0QkPEBAIHwcIEAgHDxAMEA8RCgQKERMkJCQfERkVExEAAg2QQAAAHcAAABBNggA' +
	'AgECBAI8JiMmPB6hoWESOkBAIHo4VFRVWSFVVXlBIlRUeEIhVVR4QCBUVXlADB5SchI5VVVVWTlUVFRZOVVUVFgAAEV8QQACRX1CAAFFfEB9EhESffAoJSjw' +
	'fFRVRQAgVFR8VHwKCX9JMklJSTI6REREOjJKSEgwOkFBIXo6QkAgeACdoKB9PUJCQj09QEBAPTwk/yQkSH5JQ2YrL/wvK/8JKfYgwIh+CQMgVFR5QQAARH1B' +
	'MEhISjI4QEAiegB6CgpyfQ0ZMX0mKSkvKCYpKSkmMEhNQCA4CAgICAgICAg4LxDIrLovECg0+gAAewAACBQqFCIiFCoUCFUAVQBVqlWqVar/Vf9V/wAAAP8A' +
	'EBAQ/wAUFBT/ABAQ/wD/EBDwEPAUFBT8ABQU9wD/AAD/AP8UFPQE/BQUFxAfEBAfEB8UFBQfABAQEPAAAAAAHxAQEBAfEBAQEPAQAAAA/xAQEBAQEBAQEP8Q' +
	'AAAA/xQAAP8A/wAAHxAXAAD8BPQUFBcQFxQU9AT0AAD/APcUFBQUFBQU9wD3FBQUFxQQEB8QHxQUFPQUEBDwEPAAAB8QHwAAAB8UAAAA/BQAAPAQ8BAQ/xD/' +
	'FBQU/xQQEBAfAAAAAPAQ///////w8PDw8P///wAAAAAA//8PDw8PDzhERDhE/EpKSjR+AgIGBgJ+An4CY1VJQWM4REQ8BEB+IB4gBgJ+AgKZpeelmRwqSSoc' +
	'THIBckwwSk1NMDBIeEgwvGJaRj0+SUlJAH4BAQF+KioqKipERF9EREBRSkRAQERKUUAAAP8BA+CA/wAACAhrawg2EjYkNgYPCQ8GAAAYGAAAABAQADBA/wEB' +
	'AB8BAR4AGR0XEgA8PDw8AAAAAAA=');
D._.FONT5X7 = FONT5X7;

// ==== displays: width, height, on, version (bumps when the picture changes), rgba() → Uint8ClampedArray
const pic = (d, f) => {   // f(x, y) → 0xRRGGBB; cached per version
	if (d._pv === d.version && d._px) return d._px;
	const w = d.width, h = d.height, a = d._px && d._px.length === w * h * 4 ? d._px : new Uint8ClampedArray(w * h * 4);
	for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) { const c = f(x, y); a[i] = c >> 16; a[i + 1] = (c >> 8) & 255; a[i + 2] = c & 255; a[i + 3] = 255; }
	d._pv = d.version; return (d._px = a);
};
const rgb = (c, k = 1) => (Math.round(c[0] * k) << 16) | (Math.round(c[1] * k) << 8) | Math.round(c[2] * k);

// ---- SSD1306 / SSD1309 / SH1106 / SH1107 OLEDs (I2C control bytes or SPI + D/C): addressing modes, remaps, COM pins, charge pump
const OLED_COL = { white: [230, 242, 255], blue: [90, 200, 255], yellow: [255, 220, 60] };
class SSD1306 extends I2CDev {
	constructor(env, spec, address) { super(env, spec, address); this.p = spec; this.width = spec.w; this.height = spec.h; this.sh = !!spec.sh1106; this.ramW = this.sh ? 132 : 128; this.ram = new Uint8Array(this.ramW * 8); this.reset(); }
	reset() { Object.assign(this, { contrast: 0x7f, on: false, inv: 0, allOn: 0, segRemap: 0, comRev: false, mux: 63, offset: 0, startLine: 0, comCfg: 0x12, pump: this.sh, mode: 2, col: 0, page: 0, c0: 0, c1: 127, p0: 0, p1: 7, args: null }); this.version++; }
	held() { return this.lvl('rst') === 0; }
	start() { this.ctl = true; return !this.held(); }
	write(b) { if (this.ctl) { this.co = b & 0x80; this.dc = b & 0x40; this.ctl = false; } else { if (this.dc) this.data(b); else this.command(b); if (this.co) this.ctl = true; } return true; }
	read() { return this.on ? 0 : 0x40; }
	spiSelect() {}
	spiTransfer(b, dc) { if (!this.held()) { if (dc ?? this.lvl('dc')) this.data(b); else this.command(b); } return 0xff; }
	spiBulk(bytes, dc) { for (const b of bytes) this.spiTransfer(b, dc); }
	command(b) {
		if (this.args) { this.args.push(b); if (this.args.length > this.need) { this.exec(this.args[0], this.args.slice(1)); this.args = null; } return; }
		const need = this.sh && b >= 0x20 && b <= 0x22 ? 0 : { 0x81: 1, 0x20: 1, 0x21: 2, 0x22: 2, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1, 0x8d: 1, 0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5, 0xa3: 2, 0xad: 1, 0xd8: 1, 0xdc: 1, 0xfd: 1 }[b];
		if (need) { this.args = [b]; this.need = need; } else this.exec(b, []);
	}
	exec(c, a) {
		if (c < 0x10) this.col = (this.col & 0xf0) | c;
		else if (c < 0x20) this.col = (this.col & 15) | ((c & 15) << 4);
		else if (c === 0x20) this.mode = a[0] & 3;
		else if (c === 0x21) { this.c0 = a[0] & 127; this.c1 = a[1] & 127; this.col = this.c0; }
		else if (c === 0x22) { this.p0 = a[0] & 7; this.p1 = a[1] & 7; this.page = this.p0; }
		else if (c >= 0x40 && c < 0x80) this.startLine = c & 63;
		else if (c === 0x81) this.contrast = a[0];
		else if (c === 0x8d || c === 0xad) this.pump = !!(a[0] & (c === 0x8d ? 4 : 1));
		else if (c === 0xa0 || c === 0xa1) this.segRemap = c & 1;
		else if (c === 0xa4 || c === 0xa5) this.allOn = c & 1;
		else if (c === 0xa6 || c === 0xa7) this.inv = c & 1;
		else if (c === 0xa8) this.mux = Math.max(15, a[0] & 63);
		else if (c === 0xae || c === 0xaf) this.on = c === 0xaf;
		else if (c >= 0xb0 && c <= 0xb7) this.page = c & 7;
		else if (c === 0xc0 || c === 0xc8) this.comRev = c === 0xc8;
		else if (c === 0xd3) this.offset = a[0] & 63;
		else if (c === 0xda) this.comCfg = a[0] & 0x32;
		this.version++;
	}
	data(b) {
		if (this.page < 8 && this.col < this.ramW) this.ram[this.page * this.ramW + this.col] = b;
		if (this.sh || this.mode === 2) this.col = (this.col + 1) % this.ramW;
		else if (this.mode === 0) { if (this.col >= this.c1) { this.col = this.c0; this.page = this.page >= this.p1 ? this.p0 : this.page + 1; } else this.col++; }
		else if (this.mode === 1) { if (this.page >= this.p1) { this.page = this.p0; this.col = this.col >= this.c1 ? this.c0 : this.col + 1; } else this.page++; }
		this.version++;
	}
	pixel(x, y) {   // panel pixel lit?
		if (!this.on || !this.pump) return 0;
		if (this.allOn) return 1;
		const native = this.height > 32 ? 0x12 : 0x02, rows = this.height, n = this.mux + 1; let k = y;
		if ((this.comCfg ^ native) & 0x10) k = native & 0x10 ? (y % 2 ? (rows >> 1) + (y >> 1) : y >> 1) : y < rows / 2 ? 2 * y : 2 * (y - rows / 2) + 1;
		if (k >= n) return 0;
		if (!this.comRev) k = n - 1 - k;
		const line = (k + this.startLine + this.offset) & 63, off = (this.ramW - this.width) >> 1, col = this.segRemap ? x + off : this.ramW - 1 - off - x;
		return ((this.ram[(line >> 3) * this.ramW + col] >> (line & 7)) & 1) ^ this.inv;
	}
	lit() { let n = 0; for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) n += this.pixel(x, y); return n; }
	rgba() { const k = 0.3 + (0.7 * this.contrast) / 255, c = this.p.color, C = rgb(OLED_COL[c] || OLED_COL.white, k), Y = rgb(OLED_COL.yellow, k), B = rgb(OLED_COL.blue, k); return pic(this, (x, y) => (this.pixel(x, y) ? (c === 'yellow-blue' ? (y < 16 ? Y : B) : C) : 0x06080c)); }
	status() { return `${this.name} ${this.width}x${this.height}${this.at()} · ${this.on && this.pump ? 'on' : this.on ? 'no charge pump' : 'off'} · ${this.lit()} px lit`; }
}

// ---- MIPI-DCS TFTs (ST7735/7789/7796, ILI9341/9488/9163, GC9A01), SPI + D/C: CASET/RASET/RAMWR, MADCTL MV/MX/MY/BGR relative
// to the rotation-0 value p.base, COLMOD 16/18-bit, INVON (p.inv: IPS panel), read IDs, scrolling; p.x0/y0 = visible window
class TFT extends SPIDev {
	constructor(env, spec) { super(env, spec); const p = (this.p = spec); this.width = p.w; this.height = p.h; this.fb = new Uint32Array(p.memW * p.memH); this.reset(); }
	reset() { Object.assign(this, { sleep: true, on: false, inv: false, madctl: 0, colmod: this.p.colmod || 0x66, xs: 0, xe: this.p.memW - 1, ys: 0, ye: this.p.memH - 1, cx: 0, cy: 0, cmd: -1, args: [], pix: [], rd: [], vsa: null, vsp: 0 }); this.version++; }
	ram() { return this.cmd === 0x2c || this.cmd === 0x3c; }
	xfer(b, i, dc) {
		if (this.lvl('rst') === 0) return 0xff;
		if (!(dc ?? this.lvl('dc') ?? 1)) this.command(b);
		else if (this.ram()) this.px(b);
		else if (this.rd.length) return this.rd.shift();
		else { this.args.push(b); this.param(); }
		return 0xff;
	}
	spiBulk(bytes, dc) { if ((dc ?? this.lvl('dc') ?? 1) && this.ram() && this.lvl('rst') !== 0) for (const b of bytes) this.px(b); else for (let i = 0; i < bytes.length; i++) this.xfer(bytes[i], i, dc); }
	command(c) {
		const ids = this.p.ids, id4 = ids[4];
		this.cmd = c; this.args = []; this.pix = [];
		this.rd = { 4: [0xff, ...id4], 9: [0xff, 0x80 | (this.madctl & 0x74), 0x60 | (this.colmod & 7), this.inv ? 0x20 : 0, 0], 0x0a: [0xff, 0x88 | (this.sleep ? 0 : 0x10) | (this.on ? 4 : 0)], 0x0b: [0xff, this.madctl],
			0x0c: [0xff, this.colmod], 0xda: [0xff, id4[0]], 0xdb: [0xff, id4[1]], 0xdc: [0xff, id4[2]] }[c] || (ids[c] ? [0xff, ...ids[c]] : []);
		if (c === 1) this.reset(); else if (c === 0x10 || c === 0x11) this.sleep = c === 0x10; else if (c === 0x20 || c === 0x21) this.inv = c === 0x21; else if (c === 0x28 || c === 0x29) this.on = c === 0x29;
		else if (c === 0x2c) { this.cx = this.xs; this.cy = this.ys; }
		if (this.rd.length && this.rdIdx != null) { this.rd = this.rd.slice(1 + this.rdIdx); this.rdIdx = null; }   // ILI934x 0xD9 index register
		this.version++;
	}
	param() {
		const a = this.args, c = this.cmd, n = a.length, w = i => (a[i] << 8) | a[i + 1];
		if (c === 0x2a && n === 4) { this.xs = w(0); this.xe = w(2); }
		else if (c === 0x2b && n === 4) { this.ys = w(0); this.ye = w(2); }
		else if (c === 0x36 && n === 1) this.madctl = a[0];
		else if (c === 0x3a && n === 1) this.colmod = a[0];
		else if (c === 0x33 && n === 6) this.vsa = [w(0), w(2), w(4)];
		else if (c === 0x37 && n === 2) this.vsp = w(0);
		else if (c === 0xd9 && n === 1) this.rdIdx = a[0] & 15;
		else return;
		this.version++;
	}
	px(b) {   // one pixel (2 bytes RGB565 or 3 bytes RGB666) into the frame memory, then advance inside the window
		const q = this.pix, n = (this.colmod & 7) >= 6 ? 3 : 2; q.push(b); if (q.length < n) return; this.pix = [];
		const e = (v, k) => (v << (8 - k)) | (v >> (2 * k - 8)), v = (q[0] << 8) | q[1];
		const c = n === 2 ? (e(v >> 11, 5) << 16) | (e((v >> 5) & 63, 6) << 8) | e(v & 31, 5) : (e(q[0] >> 2, 6) << 16) | (e(q[1] >> 2, 6) << 8) | e(q[2] >> 2, 6);
		const p = this.p, f = this.madctl ^ p.base, W = p.memW, H = p.memH; let x = this.cx, y = this.cy;
		if (f & 0x20) [x, y] = [y, x]; if (f & 0x40) x = W - 1 - x; if (f & 0x80) y = H - 1 - y;
		if (x >= 0 && x < W && y >= 0 && y < H) this.fb[y * W + x] = c;
		if (this.cx >= this.xe) { this.cx = this.xs; this.cy = this.cy >= this.ye ? this.ys : this.cy + 1; } else this.cx++;
		this.version++;
	}
	color(x, y) {   // panel pixel → 0xRRGGBB after scrolling, BGR and inversion
		const p = this.p; let yy = y + (p.y0 || 0);
		if (this.vsa && this.vsp) { const [t, h] = this.vsa; if (yy >= t && yy < t + h) yy = t + ((yy - 2 * t + this.vsp + h * 4) % h); }
		let v = this.fb[yy * p.memW + x + (p.x0 || 0)];
		if ((this.madctl ^ p.base) & 8) v = ((v & 255) << 16) | (v & 0xff00) | (v >> 16);
		return this.inv !== !!p.inv ? v ^ 0xffffff : v;
	}
	rgba() { const w = this.width, h = this.height, show = this.on && !this.sleep; return pic(this, (x, y) => (!show || (this.p.round && (x - w / 2 + 0.5) ** 2 + (y - h / 2 + 0.5) ** 2 > (w / 2) ** 2) ? 0 : this.color(x, y))); }
	status() { return `${this.name} ${this.width}x${this.height} · ${this.sleep ? 'sleep' : this.on ? 'on' : 'display off'} · MADCTL ${hex(this.madctl)} · ${(this.colmod & 7) === 5 ? 16 : 18}-bit`; }
}

// ---- e-paper: SSD1680/1681/1675/1608 (RAM windows, entry mode, master activation), UC8151/IL0373 (DTM1/DTM2, refresh)
class EPD extends SPIDev {
	constructor(env, spec) {
		super(env, spec); const p = (this.p = spec); this.width = p.w; this.height = p.h; this.uc = p.ctrl === 'uc8151'; this.rw = Math.ceil(p.w / 8);
		this.plane = [new Uint8Array(this.rw * 400).fill(0xff), new Uint8Array(this.rw * 400).fill(this.uc ? 0xff : 0)]; this.screen = this.plane.map(x => x.slice()); this.on = true; this.refreshes = 0; this.reset();
	}
	reset() { Object.assign(this, { cmd: -1, args: [], entry: 3, xs: 0, xe: this.rw - 1, ys: 0, ye: this.height - 1, x: 0, y: 0, sleep: false, bank: 0 }); this.pin('busy', this.uc ? 'hi' : 'lo'); }
	xfer(b, i, dc) {
		if (this.lvl('rst') === 0) return 0xff;
		const c = this.cmd, a = this.args;
		if (!(dc ?? this.lvl('dc') ?? 1)) {
			this.cmd = b; this.args = [];
			if (this.uc) { if (b === 0x10 || b === 0x13) { this.bank = b === 0x10 ? (this.p.red ? 0 : 2) : this.p.red ? 1 : 0; this.x = this.y = 0; } else if (b === 0x12) this.refresh(); }
			else if (b === 0x24 || b === 0x26) this.bank = b === 0x24 ? 0 : 1; else if (b === 0x20) this.refresh(); else if (b === 0x12) this.reset();
		} else if (this.uc ? c === 0x10 || c === 0x13 : c === 0x24 || c === 0x26) this.ram(b);
		else if (this.uc) { if (c === 7 && b === 0xa5) this.sleep = true; }
		else {
			a.push(b);
			if (c === 0x11) this.entry = b & 7;
			else if (c === 0x44 && a.length === 2) { this.xs = a[0]; this.xe = a[1]; }
			else if (c === 0x45 && a.length === 4) { this.ys = a[0] | (a[1] << 8); this.ye = a[2] | (a[3] << 8); }
			else if (c === 0x4e) this.x = b;
			else if (c === 0x4f && a.length === 2) this.y = a[0] | (a[1] << 8);
			else if (c === 0x10) this.sleep = b & 3;
		}
		return 0xff;
	}
	spiBulk(bytes, dc) { for (let i = 0; i < bytes.length; i++) this.xfer(bytes[i], i, dc); }
	ram(b) {
		if (this.bank === 2) { this.x++; return; }
		const pl = this.plane[this.bank], i = this.y * this.rw + this.x;
		if (this.uc) { if (i < pl.length) pl[i] = b; if (++this.x >= this.rw) { this.x = 0; this.y++; } return; }
		if (this.x < this.rw && i < pl.length) pl[i] = b;
		const E = this.entry, step = (k, s, e, inc) => { if (inc ? this[k] >= Math.max(s, e) : this[k] <= Math.min(s, e)) { this[k] = s; return true; } this[k] += inc ? 1 : -1; return false; };
		const sx = () => step('x', this.xs, this.xe, E & 1), sy = () => step('y', this.ys, this.ye, E & 2);
		if (E & 4) { if (sy()) sx(); } else if (sx()) sy();
	}
	refresh() { this.screen = this.plane.map(x => x.slice()); this.refreshes++; this.version++; }
	rgba() { const C = [0xeceae1, 0x1e1e20, 0xc81e1e]; return pic(this, (x, y) => { const i = y * this.rw + (x >> 3), m = 0x80 >> (x & 7), red = this.screen[1][i] & m; return C[this.p.red && (this.uc ? !red : red) ? 2 : this.screen[0][i] & m ? 0 : 1]; }); }
	status() { return `${this.name} ${this.width}x${this.height} e-paper · ${this.refreshes} refreshes${this.sleep ? ' · deep sleep' : ''}`; }
}

// ---- HD44780 character LCD; LCDI2C = PCF8574 "backpack" (P0 RS, P1 RW, P2 E, P3 backlight, P4–P7 D4–D7)
class HD44780 {
	constructor(cols, rows) { Object.assign(this, { cols, rows, dd: new Uint8Array(128).fill(32), cg: new Uint8Array(64), ac: 0, cgMode: false, id: 1, sh: 0, disp: false, cur: false, blink: false, dl8: true, n2: false, shift: 0, hi: null, version: 0 }); }
	strobe(rs, d) { if (this.dl8) this.exec(rs, d); else if (this.hi == null) this.hi = d & 0xf0; else { const v = this.hi | (d >> 4); this.hi = null; this.exec(rs, v); } }   // one E falling edge
	exec(rs, v) {
		if (rs) { if (this.cgMode) { this.cg[this.ac & 63] = v & 31; this.ac = (this.ac + (this.id ? 1 : -1)) & 63; } else { this.dd[this.ac & 127] = v; this.adv(); if (this.sh) this.shift += this.id ? 1 : -1; } }
		else if (v & 0x80) { this.cgMode = false; this.ac = v & 0x7f; }
		else if (v & 0x40) { this.cgMode = true; this.ac = v & 0x3f; }
		else if (v & 0x20) { this.dl8 = !!(v & 0x10); this.n2 = !!(v & 8); this.hi = null; }
		else if (v & 0x10) { if (v & 8) this.shift += v & 4 ? -1 : 1; else this.adv(v & 4 ? 1 : -1); }
		else if (v & 8) { this.disp = !!(v & 4); this.cur = !!(v & 2); this.blink = !!(v & 1); }
		else if (v & 4) { this.id = (v >> 1) & 1; this.sh = v & 1; }
		else if (v) { if (v & 1) { this.dd.fill(32); this.id = 1; } this.ac = this.shift = 0; this.cgMode = false; }   // clear / home
		this.version++;
	}
	adv(d = this.id ? 1 : -1) {
		if (!this.n2) { this.ac = (this.ac + d + 80) % 80; return; }
		let line = this.ac >> 6, pos = (this.ac & 0x3f) + d; if (pos > 39 || pos < 0) { pos = pos < 0 ? 39 : 0; line ^= 1; } this.ac = line * 0x40 + pos;
	}
	addrOf(col, row) { const base = [0, 0x40, this.cols, 0x40 + this.cols][row] || 0, n = this.n2 ? 40 : 80, o = (base & 0x3f) + col + this.shift; return (base & 0x40) + (((o % n) + n) % n); }
	text() { return range(0, this.rows).map(r => range(0, this.cols).map(c => { const ch = this.dd[this.addrOf(c, r)]; return ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ch < 16 ? '▯' : '?'; }).join('')); }
	glyphRow(ch, y) { if (ch < 16) return this.cg[(ch & 7) * 8 + y] & 31; let r = 0; if (y < 7) for (let x = 0; x < 5; x++) if ((FONT5X7[ch * 5 + x] >> y) & 1) r |= 16 >> x; return r; }   // bit 4 = left column
}
class LCDI2C extends PCF8574 {
	constructor(env, spec, address) { super(env, spec, address, 8); this.hd = new HD44780(spec.cols, spec.rows); this.width = spec.cols * 6 + 3; this.height = spec.rows * 9 + 3; this.bl = true; this.prevE = 0; this.on = true; }
	onByte(o) { const e = (o >> 2) & 1; this.bl = !!(o & 8); if (this.prevE && !e && !(o & 2)) this.hd.strobe(o & 1, o & 0xf0); this.prevE = e; this.version++; }
	get lines() { return this.hd.text(); }
	rgba() {
		const hd = this.hd, bl = this.bl, blink = Math.floor((this.env.now ? this.env.now() : 0) * 2) % 2 === 0, on = bl ? 0xebf0ff : 0x3c4664, off = bl ? 0x376ef5 : 0x121c3c;
		this._pv = -1; return pic(this, (x, y) => {
			const c = Math.floor((x - 2) / 6), r = Math.floor((y - 2) / 9), gx = (x - 2) % 6, gy = (y - 2) % 9;
			if (x < 2 || y < 2 || c >= hd.cols || r >= hd.rows || gx > 4 || gy > 7) return bl ? 0x285ae6 : 0x0e1632;
			const ad = hd.addrOf(c, r), atCur = ad === hd.ac && !hd.cgMode, row = !hd.disp ? 0 : atCur && ((hd.cur && gy === 7) || (hd.blink && blink)) ? 31 : hd.glyphRow(hd.dd[ad], gy);
			return (row >> (4 - gx)) & 1 ? on : off;
		});
	}
	status() { const t = this.lines; return `LCD ${this.hd.cols}x${this.hd.rows}${this.at()} · "${t[0].trimEnd()}"${t[1] ? ' / "' + t[1].trimEnd() + '"' : ''}${this.bl ? '' : ' · backlight off'}`; }
}

// ---- templates (resolution from the part value / description where known)
const res = (t, dw, dh) => { const m = /(\d{2,3})\s*[X×]\s*(\d{2,3})/.exec(t); return m ? [+m[1], +m[2]] : [dw, dh]; }, colorOf = t => (/YELLOW/.test(t) ? 'yellow-blue' : /BLUE/.test(t) ? 'blue' : 'white');
const OLED = { bus: 'i2c+spi', display: { w: 128, h: 64 }, addr: A1(0x3c), roles: { addr: ['SA0', 'D/C', 'DC', 'SA0/DC'], rst: ['RES', 'RST', 'RESET', 'RES#'], dc: ['D/C', 'DC', 'D/C#', 'A0'], cs: ['CS', 'CS#'], sda: ['SDA', 'D1', 'SDIN', 'DATA'], scl: ['SCL', 'D0', 'SCLK', 'CLK'] } };
T('sh1106', 'SH1106', 'display', /\bSH110[67]/, [0x3c, 0x3d], SSD1306, Object.assign({ params: t => { const [w, h] = res(t, 128, 64); return { w, h, sh1106: true, color: colorOf(t) }; } }, OLED));
T('ssd1306', 'SSD1306', 'display', /\bSSD130[569]/, [0x3c, 0x3d], SSD1306, Object.assign({ generic: /^OLED\b(?!.*(PWR|\bEL\b|IPEX|EDP))|\bOLED[ -]?(0\.9[16]|1\.3)|(0\.9[16]|1\.3)["' ]*OLED/,
	params: t => { const [w, h] = res(t, 128, /0\.91|128X32/.test(t) ? 32 : 64); return { w, h, color: colorOf(t), name: /SSD1309/.test(t) ? 'SSD1309' : 'SSD1306' }; } }, OLED));
const TFTR = { dc: ['DC', 'D/C', 'RS', 'A0', 'WR/SPI_A0', 'SPI_A0', 'DCX', 'TFT_DC', 'CMD', 'LCD_DC'], cs: ['CS', 'TFT_CS', 'CSX', 'LCD_CS'], rst: ['RESET', 'RST', 'RES', 'TFT_RESET', 'TFT_RST'],
	mosi: ['MOSI', 'SDA', 'SDI', 'SPI_SDA', 'TFT_MOSI', 'DIN', 'DATA'], miso: ['MISO', 'SDO', 'TFT_MISO'], sck: ['SCK', 'SCL', 'SCLK', 'CLK', 'RS/SPI_SCL', 'SPI_SCL', 'TFT_SCK'], bl: ['LED', 'BL', 'LITE', 'BLK', 'TFT_LED', 'LED-A'] };
const tft = (id, name, re, P) => T(id, name, 'display', re, undefined, TFT, { bus: 'spi', roles: TFTR, display: {}, params: t => Object.assign({}, typeof P === 'function' ? P(t) : P) });
const ID77 = { 4: [0x7c, 0x89, 0xf0] };
tft('st7789', 'ST7789', /\bST7789|\bTFT[_ ]?240X(240|280|320)|\bTFT_20_QT200|\bQT200H|\bTFT_?1\.(3|54|69|9)|\bTFT_?2\.0\b/, t => {
	const [w, h] = res(t, 240, /QT200|2\.0|1\.9/.test(t) ? 320 : /1\.69/.test(t) ? 280 : /1\.3\b|1\.54/.test(t) ? 240 : 320), rw = Math.min(w, h), rh = Math.max(w, h), sq = rw === 240 && rh === 240;
	return { memW: 240, memH: 320, w: rw, h: rh, x0: sq ? 0 : rw === 135 ? 53 : (240 - rw) >> 1, y0: sq ? 80 : (320 - rh) >> 1, base: 0xc0, inv: true, ids: { 4: [0x85, 0x85, 0x52] } };
});
tft('st7796', 'ST7796', /\bST7796/, { memW: 320, memH: 480, w: 320, h: 480, base: 0x40, ids: ID77 });
tft('st7735', 'ST7735', /\bST7735|\bADAFRUIT_TFT_ST7735|\bTFT_?1\.(8|44)/, t => {
	const sq = /128X128|1\.44/.test(t), mini = /160X80|80X160|0\.96/.test(t);
	return Object.assign({ memW: 132, memH: 162, base: 0xc0, ids: ID77 }, mini ? { w: 80, h: 160, x0: 26, y0: 1, inv: true } : { w: 128, h: sq ? 128 : 160, x0: sq ? 2 : 0, y0: sq ? 3 : 0 });
});
tft('ili9341', 'ILI9341', /\bILI934[012]|\bMSP2402|\bMSP2807|\bTFT[_ ]?2\.[48]/, { memW: 240, memH: 320, w: 240, h: 320, base: 0x48, ids: { 4: [0, 0x93, 0x41], 0xd3: [0, 0x93, 0x41] } });
tft('ili9488', 'ILI9488', /\bILI948[68]|\bTFT[_ ]?3\.5/, { memW: 320, memH: 480, w: 320, h: 480, base: 0x48, ids: { 4: [0, 0x94, 0x88], 0xd3: [0, 0x94, 0x88] } });
tft('ili9163', 'ILI9163', /\bILI9163/, { memW: 128, memH: 160, w: 128, h: 128, base: 0xc0, ids: { 4: [0x54, 0x80, 0x66] } });
tft('gc9a01', 'GC9A01', /\bGC9A01|\bTFT[_ ]?1\.28|\bROUND.?LCD/, { memW: 240, memH: 240, w: 240, h: 240, base: 0x48, inv: true, round: true, ids: { 4: [0, 0x9a, 0x01] } });
const EPD_ = { bus: 'spi', display: {}, roles: { dc: ['DC', 'D/C'], cs: ['CS'], rst: ['RST', 'RES', 'RESET'], busy: ['BUSY'], mosi: ['SDA', 'DIN', 'MOSI', 'SDI'], sck: ['SCL', 'CLK', 'SCK'] } };
const epd = (ctrl, t, dw, dh, red, re) => { let [w, h] = res(t, dw, dh); if (w > h) [w, h] = [h, w]; return { ctrl, w, h, red, name: (re.exec(t) || [ctrl.toUpperCase()])[0] }; };
T('ssd1680', 'SSD1680', 'display', /\bSSD16(80|81|75|08|19)|\bGDE[YH]\d/, undefined, EPD, Object.assign({ generic: /^E-?PAPER|^EPD\b|^E-?INK/,
	params: t => { const s81 = /SSD1681|200X200|1\.54/.test(t); return epd('ssd1680', t, s81 ? 200 : 122, s81 ? 200 : 250, /RED|TRI|BWR|3C/.test(t), /SSD16\d\d/); } }, EPD_));
T('uc8151', 'UC8151', 'display', /\bUC81(51|76|79)|\bIL0373|\bIL0398|\bIL91874|\bGDEW029/, undefined, EPD, Object.assign({
	params: t => { const il = /IL0373/.test(t); return epd('uc8151', t, il ? 104 : 128, il ? 212 : 296, il || /RED|TRI|BWR/.test(t), /UC81\d\d|IL0373|IL0398|IL91874/); } }, EPD_));
T('lcd-i2c', 'LCD1602 I2C', 'display', /\bLC[DM] ?1602|\bLCD ?2004|\b1602A\b|\bHD44780|\bCHARACTER LCD|\bLCD ?(16X2|20X4)/, [0x27, 0x3f, ...range(0x20, 7), ...range(0x38, 7)], LCDI2C, { bus: 'i2c', display: {},
	roles: { a0: ['A0'], a1: ['A1'], a2: ['A2'] }, params: t => { const big = /2004|20X4/.test(t); return { cols: big ? 20 : 16, rows: big ? 4 : 2, a: /PCF8574A|0X3F/.test(t) }; }, addr: (L, p) => (L.a0 != null || L.a1 != null || L.a2 != null ? A3(p.a ? 0x38 : 0x20)(L) : p.a ? 0x3f : 0x27) });

// ==== addressable LEDs (the runtime renders the colours it gets from hal.neopixel / hal.apa102)
class LEDDev extends Dev { status() { return this.name; } }
const LEDR = { din: ['DIN', 'DI', 'SDI', 'DATA IN', 'DATA_IN', 'IN', 'D_IN'], dout: ['DOUT', 'DO', 'SDO', 'DATA OUT', 'DATA_OUT', 'OUT', 'D_OUT'], vdd: ['VDD', 'VCC', 'V+'], gnd: ['VSS', 'GND'] };
const PIN5050 = { 1: 'vdd', 2: 'dout', 3: 'gnd', 4: 'din' }, PIN2020 = { 1: 'dout', 2: 'gnd', 3: 'din', 4: 'vdd' }, PINEC15 = { 1: 'din', 2: 'vdd', 3: 'dout', 4: 'gnd' };   // pin numbers when the symbol has no names
const led = (id, name, kind, re, roles, params) => T(id, name, kind, re, undefined, LEDDev, { roles, params });
led('sk6812rgbw', 'SK6812 RGBW', 'ws2812', /\bSK6812.{0,12}RGBW|\bSK6812WWA|\bSK6812-?W\b/, LEDR, () => ({ order: 'GRBW', pinmap: PIN5050 }));
led('apa106', 'APA106', 'ws2812', /\bAPA10[46]\b|\bPL9823|\bWS2811\b/, LEDR, () => ({ order: 'RGB', pinmap: PIN5050 }));
led('ws2812', 'WS2812B', 'ws2812', /\bWS281[2-5]|\bSK68(12|05|22)|\bXL-?(5050|1615)RGBC|\bIN-PI?(55|42|33|15)|\bNEOPIXEL|\bTX1812|\bYS-SK6812|\bUCS1903/, LEDR, t => ({ order: 'GRB',
	pinmap: /2020|SK6805-EC20|WS2812C/.test(t) ? PIN2020 : /EC15|SK6805-EC/.test(t) ? PINEC15 : PIN5050, name: (/\b(WS281[2-5][A-Z]?(-2020)?|SK68\d\d[A-Z0-9-]*|XL-?\d{4}RGBC|IN-PI\d\d|NEOPIXEL)/.exec(t) || ['WS2812B'])[0] }));
led('apa102', 'APA102', 'apa102', /\bAPA10[27]|\bSK9822|\bHD107S|\bDOTSTAR/, { din: ['SDI', 'DI', 'DIN', 'DATA IN'], dout: ['SDO', 'DO', 'DOUT'], cin: ['CKI', 'CI', 'CIN', 'CLK IN', 'CLKI'], cout: ['CKO', 'CO', 'COUT', 'CLK OUT', 'CLKO'], vdd: ['VDD', 'VCC'], gnd: ['GND', 'VSS'] },
	t => ({ order: 'BGR', name: (/APA10[27]|SK9822|HD107S/.exec(t) || ['APA102'])[0] }));

// WS2812 wire bytes in the given channel order → [[r, g, b(, w)], …]
D.decodeWS2812 = function (bytes, order = 'GRB') {
	const o = String(order).toUpperCase(), n = o.length, ix = [...'RGBW'].map(c => o.indexOf(c)), out = [];
	for (let i = 0; i + n <= bytes.length; i += n) out.push(ix.filter(k => k >= 0).map(k => bytes[i + k]));
	return out;
};
// APA102/SK9822 stream (start frame, 0b111bbbbb B G R per LED, end frame) → [[r, g, b, brightness 0..31], …]
D.decodeAPA102 = function (bytes) {
	const out = []; let i = 0;
	while (i < bytes.length && bytes[i] === 0) i++;
	for (; i + 3 < bytes.length && (bytes[i] & 0xe0) === 0xe0; i += 4) out.push([bytes[i + 3], bytes[i + 2], bytes[i + 1], bytes[i] & 31]);
	return out;
};

// ==== matching parts and pins
// pin names as they come from KiCad symbols: "~{CS}", "SCL_6" (pad-number suffix), "DO(IO1)", "SDA/SDI", "/CS", "CE#", "{slash}" …
function normPin(name, number) {
	let s = String(name || '').toUpperCase().replace(/\{SLASH\}/g, '/').replace(/[~{}#*]/g, '').replace(/^\//, '').trim();
	if (number != null && number !== '') s = s.replace(new RegExp('_' + String(number).toUpperCase().replace(/[^A-Z0-9]/g, '') + '$'), '');
	return s.replace(/^_+|_+$/g, '').replace(/^V_(?=[A-Z])/, 'V');
}
const pinAlts = (name, number) => { const s = normPin(name, number), set = new Set([s, s.replace(/_/g, '')]); for (const p of s.split(/[/(), ]+/)) if (p) set.add(p).add(p.replace(/_/g, '')); return set; };
// { role: [pin numbers] } from the template's role name lists (exact names win over one alternative of a combined name; pin-number map for unnamed pins)
function rolePins(spec, comp) {
	const full = {}, alt = {}, pins = (comp && comp.pins) || [], add = (o, r, n) => { (o[r] = o[r] || []).includes(n) || o[r].push(n); };
	const lists = Object.entries(spec.roles || {}).map(([r, l]) => [r, new Set(l.map(x => normPin(x)))]);
	const named = pins.some(p => { const n = normPin(p.name, p.number); return n && !/^(PIN_?)?\d+$/.test(n); });
	for (const p of pins) {
		const num = String(p.number), whole = normPin(p.name, p.number), alts = pinAlts(p.name, p.number);
		for (const [r, l] of lists) { if (l.has(whole)) add(full, r, num); else for (const a of alts) if (l.has(a)) { add(alt, r, num); break; } }
		if (!named && spec.pinmap && spec.pinmap[p.number]) add(full, spec.pinmap[p.number], num);
	}
	for (const r in alt) if (!full[r]) full[r] = alt[r];
	return full;
}
D.normPin = normPin;
D.rolePins = rolePins;

const cleanText = s => String(s || '').toUpperCase().replace(/\(?HTTPS?:\/\/\S*\)?/g, ' ').replace(/_/g, ' ');
function makeSpec(t, text, comp) {
	const p = Object.assign({}, t.params ? t.params(text, comp) : {}), td = t.display || {};
	const spec = {
		id: t.id, name: p.name || t.name, kind: t.kind, bus: t.bus || (/i2c|spi/.test(t.kind) ? t.kind : undefined), roles: t.roles, addresses: t.addresses && t.addresses.slice(), params: p, mux: t.mux,
		display: t.kind === 'display' ? { w: p.w || td.w, h: p.h || td.h } : undefined,
		address(levels) { return t.addr ? t.addr(levels || {}, p) : t.addresses ? t.addresses[0] : undefined; },
		create(env = {}, address) { const d = t.create(env, spec, address ?? env.address ?? this.address(env.levels)); d.spec = spec; d.name = d.name || spec.name; return d; },
	};
	for (const k in p) if (!(k in spec)) spec[k] = p[k];   // template parameters are readable on the spec (spec.size, spec.bits …)
	return spec;
}
const CONN_OK = new Set(['ssd1306', 'sh1106', 'sdcard', 'lcd-i2c', 'st7789', 'ili9341', 'st7735', 'gc9a01', 'ssd1680', 'uc8151']);
// comp: { ref, value, description, mpn, type, pins: [{ number, name }] } → Spec | null (value first, then MPN, then description; generic words only in the value)
D.match = function (comp) {
	if (!comp) return null;
	const type = comp.type || '', npins = (comp.pins || []).length, conn = type === 'connector';
	if (/^(resistor|capacitor|capacitor_polarized|inductor|ferrite_bead|fuse|crystal|switch|jumper|diode|schottky_diode|zener_diode|tvs_diode|led|bjt_npn|bjt_pnp|mosfet_n|mosfet_p|potentiometer|thermistor|test_point)$/.test(type)) return null;
	const fields = [comp.value, comp.mpn, comp.description];
	for (let k = 0; k < fields.length; k++) {
		const text = cleanText(fields[k]); if (!text.trim()) continue;
		for (const t of TEMPLATES) {
			if (conn && (!CONN_OK.has(t.id) || (t.id === 'ssd1306' && npins > 8))) continue;
			if ((t.kind === 'ws2812' || t.kind === 'apa102') && ((comp.pins && npins < 4) || /^(JP|SJ|TP)\d/i.test(comp.ref || ''))) continue;
			if (t.match.test(text) || (k === 0 && t.generic && t.generic.test(text.trim()))) return makeSpec(t, text, comp);
		}
	}
	return null;
};
// a Spec by template id (virtual devices, tests): D.spec('bme280'), D.spec('ssd1306', '128x32')
D.spec = (id, text) => { const t = TEMPLATES.find(x => x.id === id); return t ? makeSpec(t, cleanText(text || t.name), null) : null; };
D.list = () => TEMPLATES.map(t => ({ id: t.id, name: t.name, kind: t.kind, bus: t.bus, addresses: t.addresses }));

// ==== netlist helpers
function netIndex(circuit) {
	const byName = new Map(), ofPin = new Map(), comps = new Map();
	for (const c of circuit.components || []) comps.set(c.ref, c);
	for (const n of circuit.nets || []) { byName.set(n.name, n); for (const x of n.nodes || []) ofPin.set(x.ref + '.' + x.pin, n); }
	return { byName, ofPin, comps, net: (ref, pins) => (pins || []).map(k => ofPin.get(ref + '.' + k)).filter(Boolean)[0] };
}
const last = n => String(n.name).split('/').pop();
const isGndNet = n => n && (n.kind === 'ground' || /^(A|D|P)?(GND|VSS)\w*$/i.test(last(n)));
const isPwrNet = n => n && !isGndNet(n) && (n.kind === 'power' || /^\+?\d+V\d*|^\+?\d+\.\d+V|^(VCC|VDD|VBAT|VBUS|VIO|3V3|5V|VSYS|VREF|AVDD|DVDD|IOVDD|VDDIO|V3V3|P3V3|PWR3V3|\+3V|\+5V)/i.test(last(n)));
const ohms = v => { const m = /^([\d.]+)\s*([RKMΩ]?)(\d*)/i.exec(String(v || '').trim()); if (!m) return NaN; return parseFloat(m[1] + (m[3] ? '.' + m[3] : '')) * ({ K: 1e3, M: 1e6 }[m[2].toUpperCase()] || 1); };
// nets joined to the start nets through ≤ 100 Ω resistors, 2-pin jumpers and I2C buffers / level translators
const BRIDGE = /\b(PCA95(06|09|1[1-7]|08|15|600)|PCA9306|PCA9600|TCA9517|TCA9406|TCA4307|TCA980\d|LTC43(00|11|16)|NCA9306|GTL2002|P82B715|TX[SB]010[248]|NTS010[248]|NTB0102|NVT20(0\d|10)|LSF010[248]|ADUM125[01]|ISO154\d|CA-IS30[25]\d|SN74LVC2T45)/;
function joined(circuit, idx, startNames) {
	const set = new Set(startNames.filter(Boolean)), queue = [...set];
	while (queue.length) {
		const n = idx.byName.get(queue.shift()); if (!n || isGndNet(n) || isPwrNet(n)) continue;
		for (const x of n.nodes || []) {
			const c = idx.comps.get(x.ref); if (!c) continue;
			let others = [];
			if ((c.type === 'resistor' && ohms(c.value) <= 100) || c.type === 'jumper' || (/^(JP|SJ)\d/.test(c.ref) && (c.pins ? c.pins.length : 2) === 2)) others = (circuit.nets || []).filter(m => m !== n && m.nodes.some(y => y.ref === c.ref));
			else if (BRIDGE.test(cleanText(c.value + ' ' + (c.mpn || '')))) {   // the matching pin on the other side (SCLA ↔ SCLB, A1 ↔ B1, SDA1 ↔ SDA2 …)
				const me = (c.pins || []).find(p => String(p.number) === String(x.pin)); if (!me) continue;
				const nm = normPin(me.name, me.number), fam = /SCL|SC/.test(nm) ? 'SC' : /SDA|SD/.test(nm) ? 'SD' : null, ch = /(\d)$/.exec(nm.replace(/[AB]$/, '')), ab = /^([AB])(\d)$/.exec(nm);
				for (const p of c.pins || []) {
					if (String(p.number) === String(x.pin)) continue; const q = normPin(p.name, p.number);
					if (fam ? q.startsWith(fam) && /^(SCL|SDA|SC|SD)[AB12]?(IN|OUT)?$|^(SCL|SDA)_?[AB12]$/.test(q) : ab ? q === (ab[1] === 'A' ? 'B' : 'A') + ab[2] : ch && q.endsWith(ch[1]) && q !== nm) { const m = idx.ofPin.get(c.ref + '.' + p.number); if (m) others.push(m); }
				}
			}
			for (const m of others) if (!set.has(m.name) && !isGndNet(m) && !isPwrNet(m)) { set.add(m.name); queue.push(m.name); }
		}
	}
	return set;
}
// logic level of a pin as wired: 0 (ground), 1 (supply), 'sda' / 'scl' (tied to the bus), through a pull resistor or jumper, else null
function levelOf(idx, ref, pinNums, sda, scl) {
	for (const num of pinNums || []) {
		const n = idx.ofPin.get(ref + '.' + num); if (!n) continue;
		if (isGndNet(n)) return 0; if (isPwrNet(n)) return 1;
		if (sda && sda.has(n.name)) return 'sda'; if (scl && scl.has(n.name)) return 'scl';
		if (/^unconnected|^NC$/i.test(n.name)) return null;
		for (const x of n.nodes) {
			const c = idx.comps.get(x.ref); if (!c || x.ref === ref || !(c.type === 'resistor' || c.type === 'jumper' || /^(R|JP|SJ)\d/.test(x.ref))) continue;
			const other = [...idx.ofPin.entries()].find(([k, m]) => k.startsWith(c.ref + '.') && k !== c.ref + '.' + x.pin && m !== n);
			if (other) { if (isGndNet(other[1])) return 0; if (isPwrNet(other[1])) return 1; }
		}
	}
	return null;
}
// devices on an I2C bus → [{ ref, spec, address, levels, swapped?, via? }]; muxes (PCA954x) are searched downstream, their children carry via: { ref, channel }
D.findOnBus = function (circuit, sdaNet, sclNet, _via, _seen) {
	const idx = netIndex(circuit), out = [], seen = _seen || new Set(), sda = joined(circuit, idx, [].concat(sdaNet)), scl = joined(circuit, idx, [].concat(sclNet));
	for (const c of circuit.components || []) {
		if (seen.has(c.ref)) continue;
		const spec = D.match(c); if (!spec || !/i2c/.test(spec.bus || '')) continue;
		const rp = rolePins(spec, c), nets = (c.pins || []).map(p => idx.ofPin.get(c.ref + '.' + p.number)).filter(Boolean), on = (r, set) => (rp[r] || []).some(n => set.has((idx.ofPin.get(c.ref + '.' + n) || {}).name));
		const exact = on('sda', sda) && on('scl', scl); if (!exact && !(nets.some(n => sda.has(n.name)) && nets.some(n => scl.has(n.name)))) continue;
		const levels = {};
		for (const r of ['addr', 'a0', 'a1', 'a2']) if (rp[r]) { const own = rp[r].filter(n => !(rp.sda || []).includes(n) && !(rp.scl || []).includes(n)); levels[r] = levelOf(idx, c.ref, own.length ? own : rp[r], sda, scl); }
		const e = { ref: c.ref, spec, address: spec.address(levels), levels };
		if (!exact) e.swapped = true;
		if (_via) e.via = _via;
		out.push(e); seen.add(c.ref);
		for (let ch = 0; ch < (spec.mux || 0); ch++) {
			const sd = idx.net(c.ref, rp['p' + ch]), sc = idx.net(c.ref, rp['sc' + ch]);
			if (sd && sc && !/^unconnected/i.test(sd.name)) out.push(...D.findOnBus(circuit, sd.name, sc.name, { ref: c.ref, channel: ch }, seen));
		}
	}
	return out;
};
// devices on an SPI bus (by SCK net) → [{ ref, spec, cs, dc, rst, latch, mosiOk }] (net names)
D.findOnSPI = function (circuit, sckNet, mosiNet) {
	const idx = netIndex(circuit), out = [], sck = joined(circuit, idx, [].concat(sckNet)), mosi = joined(circuit, idx, [].concat(mosiNet || []));
	for (const c of circuit.components || []) {
		const spec = D.match(c); if (!spec || !/spi/.test(spec.bus || '')) continue;
		const rp = rolePins(spec, c), net = r => idx.net(c.ref, rp[r]), k = net('sck') || net('srclk'); if (!k || !sck.has(k.name)) continue;
		const d = net('mosi') || net('ser'), nm = r => (net(r) || {}).name;
		out.push({ ref: c.ref, spec, cs: nm('cs'), dc: nm('dc'), rst: nm('rst'), latch: nm('rclk'), mosiOk: !mosiNet || !!(d && mosi.has(d.name)) });
	}
	return out;
};
// WS2812 chains follow DOUT → DIN nets, APA102 chains also CKO → CKI → [{ dataNet, clockNet?, leds: [refs], type, part, skip? }] (longest first;
// a branch fed from the same net gets skip = the index where it starts)
D.ledChains = function (circuit) {
	const idx = netIndex(circuit), leds = [];
	for (const c of circuit.components || []) {
		const spec = D.match(c); if (!spec || (spec.kind !== 'ws2812' && spec.kind !== 'apa102')) continue;
		const rp = rolePins(spec, c), net = r => { const n = idx.net(c.ref, rp[r]); return n && !/^unconnected/i.test(n.name) ? n.name : null; };
		leds.push({ ref: c.ref, spec, din: net('din'), dout: net('dout'), cin: net('cin') });
	}
	const byDin = new Map(); for (const l of leds) if (l.din) (byDin.get(l.din) || byDin.set(l.din, []).get(l.din)).push(l);
	const douts = new Set(leds.map(l => l.dout).filter(Boolean)), used = new Set(), chains = [];
	const walk = (head, dataNet, clockNet, skip) => {
		const ch = { dataNet, clockNet: clockNet || undefined, leds: [], type: head.spec.kind === 'apa102' ? 'APA102' : head.spec.params.order, part: head.spec.name }; if (skip) ch.skip = skip;
		for (let cur = [head]; cur.length && !used.has(cur[0].ref); ) {
			const l = cur[0]; used.add(l.ref); ch.leds.push(l.ref);
			for (const x of cur.slice(1)) if (!used.has(x.ref)) walk(x, dataNet, clockNet, (skip || 0) + ch.leds.length - 1);
			cur = l.dout ? (byDin.get(l.dout) || []).filter(x => !used.has(x.ref)) : [];
		}
		chains.push(ch);
	};
	for (const l of leds) if (!used.has(l.ref) && (!l.din || !douts.has(l.din))) for (const h of l.din ? byDin.get(l.din) : [l]) if (!used.has(h.ref)) walk(h, l.din, h.cin, 0);
	for (const l of leds) if (!used.has(l.ref)) walk(l, l.din, l.cin, 0);   // loops
	return chains.sort((a, b) => b.leds.length - a.leds.length);
};
// 74HC595 cascades (SER ← QH' of the previous register, shared SRCLK / RCLK) → [{ dataNet, clockNet, latchNet, parts: [refs] }]
D.shiftChains = function (circuit) {
	const idx = netIndex(circuit), regs = [];
	for (const c of circuit.components || []) { const spec = D.match(c); if (!spec || spec.id !== '74hc595') continue; const rp = rolePins(spec, c), net = r => (idx.net(c.ref, rp[r]) || {}).name || null; regs.push({ ref: c.ref, ser: net('ser'), clk: net('srclk'), latch: net('rclk'), out: net('qh_') }); }
	const outs = new Set(regs.map(r => r.out).filter(Boolean)), chains = [];
	for (const r of regs) {
		if (r.ser && outs.has(r.ser)) continue;
		const ch = { dataNet: r.ser, clockNet: r.clk, latchNet: r.latch, parts: [] }, seen = new Set();
		for (let cur = r; cur && !seen.has(cur.ref); cur = regs.find(x => x.ser && x.ser === cur.out)) { seen.add(cur.ref); ch.parts.push(cur.ref); }
		chains.push(ch);
	}
	return chains;
};

// ==== buses
const toArr = (x, n) => (x == null ? [] : typeof x === 'string' ? toBytes(x) : typeof x === 'number' ? [x & 255] : Array.from(x).slice(0, n ?? Infinity));
const flatDevices = list => { const out = [], add = d => { if (d && !out.includes(d)) { out.push(d); (d.subDevices || []).forEach(add); } }; (list || []).forEach(add); return out; };
const busBase = { safe(fn, d) { try { return fn(); } catch (err) { this.stats.errors++; if (this.opts.onError) this.opts.onError(err); return d; } }, now() { return this.opts.now ? this.opts.now() : 0; },
	record(e) { this.log.push(e); if (this.log.length > this.maxLog) this.log.shift(); this.stats.transactions++; if (this.opts.onTransaction) this.opts.onTransaction(e); } };

// ---- Arduino TwoWire over device models; log: last 64 transactions { t, addr, write, read, ack, nack? } (a write + repeated-start read is one entry)
class TwoWire {
	constructor(devices, opts = {}) {
		Object.assign(this, { opts, devs: flatDevices(devices), clock: 100000, bufSize: opts.bufferSize || 128, tx: null, rx: [], rxi: 0, held: null, log: [], maxLog: opts.logSize || 64 });
		this.stats = { transactions: 0, written: 0, read: 0, nackAddr: 0, nackData: 0, errors: 0, collisions: 0 };
	}
	attach(d) { for (const x of flatDevices([d])) if (!this.devs.includes(x)) this.devs.push(x); }
	detach(d) { this.devs = this.devs.filter(x => x !== d && !(d.subDevices || []).includes(x)); }
	targets(a) { return this.devs.filter(d => (d.addresses ? d.addresses.includes(a) : d.address === a) && (!d.behind || (d.behind.mux && d.behind.mux.enabled(d.behind.channel)))); }
	scan() { return range(1, 126).filter(a => this.targets(a).length); }
	xfer(a, out, nread, stop) {   // → { ack, nack: 'addr' | 'data' | null, data }; several targets = wired AND
		const ts = this.targets(a), e = { t: this.now(), addr: a, write: out ? out.slice() : [], read: [], ack: true }; let nack = null;
		if (ts.length > 1) this.stats.collisions++;
		if (this.held && (this.held.length !== ts.length || this.held.some(d => !ts.includes(d)))) { for (const d of this.held) this.safe(() => d.i2cStop()); this.held = null; }
		const acked = ts.filter(d => this.safe(() => d.i2cStart(nread != null, a), false));
		if (!acked.length) { e.ack = false; e.nack = 'addr'; this.stats.nackAddr++; this.held = null; this.record(e); return { ack: false, nack: 'addr', data: [] }; }
		if (nread == null) { for (const b of out) { this.stats.written++; if (!acked.map(d => this.safe(() => d.i2cWrite(b), false)).some(Boolean)) { nack = e.nack = 'data'; e.ack = false; this.stats.nackData++; break; } } }
		else for (let i = 0; i < nread; i++) { let v = 0xff; for (const d of acked) v &= this.safe(() => d.i2cRead(i < nread - 1), 0xff); e.read.push(v & 255); this.stats.read++; }
		if (stop || nack) { for (const d of acked) this.safe(() => d.i2cStop()); this.held = null; } else this.held = acked;
		const last = this.log[this.log.length - 1];
		if (nread != null && last && last.addr === a && last.open && !last.read.length) { last.read = e.read; last.open = false; if (this.opts.onTransaction) this.opts.onTransaction(last); }
		else { if (nread == null && !stop && !nack) e.open = true; this.record(e); }
		return { ack: !nack, nack, data: e.read };
	}
	// Arduino API
	begin() {} end() {} setClock(hz) { this.clock = hz; } getClock() { return this.clock; } setTimeout() {} setWireTimeout() {} clearWireTimeoutFlag() {} getWireTimeoutFlag() { return false; }
	setPins() { return true; } setSDA() {} setSCL() {} flush() {} onReceive() {} onRequest() {}
	beginTransmission(a) { this.tx = { a: +a & 0x7f, b: [] }; }
	write(x, n) { if (!this.tx) return 0; let k = 0; for (const b of toArr(x, n)) { if (this.tx.b.length >= this.bufSize) break; this.tx.b.push(b & 255); k++; } return k; }
	endTransmission(stop = true) { if (!this.tx) return 4; const { a, b } = this.tx; this.tx = null; const r = this.xfer(a, b, null, !!stop); return r.nack === 'addr' ? 2 : r.nack === 'data' ? 3 : 0; }
	requestFrom(a, n, stop = true, isize, sendStop) {
		a = +a & 0x7f; n = clamp(n | 0, 0, this.bufSize);
		if (isize !== undefined) {   // requestFrom(address, quantity, iaddress, isize, sendStop)
			const sz = Math.min(4, isize | 0), ia = range(0, sz).map(i => (stop >>> (8 * (sz - 1 - i))) & 255);
			if (sz && !this.xfer(a, ia, null, false).ack) { this.rx = []; this.rxi = 0; return 0; }
			stop = sendStop ?? true;
		}
		const r = this.xfer(a, null, n, !!stop); this.rx = r.ack ? r.data : []; this.rxi = 0; return this.rx.length;
	}
	available() { return this.rx.length - this.rxi; }
	read() { return this.rxi < this.rx.length ? this.rx[this.rxi++] : -1; }
	peek() { return this.rxi < this.rx.length ? this.rx[this.rxi] : -1; }
	readBytes(buf, n) { let k = 0; while (k < n && this.available()) buf[k++] = this.read(); return k; }
}
Object.assign(TwoWire.prototype, busBase);
D.TwoWire = TwoWire;
D.makeWire = (devices, opts) => new TwoWire(devices, opts);

// ---- Arduino SPIClass: the runtime attaches devices with their chip-select pin and reports pin changes with onCs(pin, level); log: last 64 selections
const rev8 = b => { let r = 0; for (let i = 0; i < 8; i++) r = (r << 1) | ((b >> i) & 1); return r; };
class SPIClass {
	constructor(opts = {}) { Object.assign(this, { opts, ents: [], lv: new Map(), order: 1, mode: 0, hz: 4e6, log: [], maxLog: opts.logSize || 64, cur: null }); this.stats = { bytes: 0, transactions: 0, selects: 0, errors: 0 }; }
	// o: { dc: pin (level passed to spiTransfer), always: true (no chip select, e.g. shift registers), latch: pin (rising edge → device.spiLatch()), activeHigh }
	attach(dev, cs, o = {}) {
		const s = x => (x == null ? null : String(x)), e = { dev, cs: s(cs), dc: s(o.dc), always: !!o.always || cs == null, latch: s(o.latch), hi: !!o.activeHigh, act: false };
		this.ents.push(e); if (e.always && dev.spiSelect) dev.spiSelect(true);
		if (e.cs != null && this.lv.has(e.cs)) this.onCs(e.cs, this.lv.get(e.cs), true);
		return this;
	}
	detach(dev) { this.ents = this.ents.filter(e => e.dev !== dev); }
	level(pin) { return this.lv.get(String(pin)); }
	onCs(pin, level, force) {
		pin = String(pin); const v = level ? 1 : 0, prev = this.lv.get(pin); this.lv.set(pin, v);
		if (prev === v && !force) return;
		for (const e of this.ents) {
			const act = e.hi ? !!v : !v;
			if (e.cs === pin && act !== e.act) {
				e.act = act; this.safe(() => e.dev.spiSelect && e.dev.spiSelect(act));
				if (act) { this.stats.selects++; this.cur = { t: this.now(), cs: pin, out: [], in: [], n: 0 }; } else if (this.cur) { this.record(this.cur); this.cur = null; }
			}
			if (e.latch === pin && v && prev === 0) this.safe(() => (e.dev.spiLatch ? e.dev.spiLatch() : e.dev.latch && e.dev.latch()));
		}
	}
	onPin(pin, level) { this.onCs(pin, level); }
	active() { return this.ents.filter(e => e.always || e.act); }
	dcOf(e) { return e.dc != null ? this.lv.get(e.dc) : undefined; }
	xferByte(b) {
		b &= 255; let miso = 0xff;
		for (const e of this.active()) { const r = this.safe(() => e.dev.spiTransfer(this.order ? b : rev8(b), this.dcOf(e)), 0xff); if (!e.always || e.dev.drivesMiso) miso &= r ?? 0xff; }
		if (!this.order) miso = rev8(miso);
		this.stats.bytes++; if (this.cur) { this.cur.n++; if (this.cur.out.length < 32) { this.cur.out.push(b); this.cur.in.push(miso); } }
		return miso;
	}
	writeBytes(buf, n) {   // bulk writes (displays) go to device.spiBulk when a single selected device takes them
		const bytes = buf instanceof Uint8Array ? buf.subarray(0, n ?? buf.length) : Uint8Array.from(toArr(buf, n)), act = this.active(), e = act[0];
		if (act.length !== 1 || !e.dev.spiBulk || !this.order) { for (const b of bytes) this.xferByte(b); return; }
		this.safe(() => e.dev.spiBulk(bytes, this.dcOf(e))); this.stats.bytes += bytes.length; if (this.cur) this.cur.n += bytes.length;
	}
	// Arduino API
	begin() {} end() {} usingInterrupt() {} notUsingInterrupt() {} setHwCs() {} setSCK() {} setTX() {} setRX() {} setMOSI() {} setMISO() {} setCS() {} endTransaction() {}
	beginTransaction(s) { if (s) { this.hz = s.clock ?? this.hz; this.order = s.bitOrder ?? this.order; this.mode = s.dataMode ?? this.mode; } }
	setBitOrder(o) { this.order = o ? 1 : 0; } setDataMode(m) { this.mode = m; } setClockDivider(d) { this.hz = 16e6 / (d || 4); } setFrequency(f) { this.hz = f; }
	transfer(x, n) {
		if (typeof x === 'number' || typeof x === 'string') return this.xferByte(typeof x === 'string' ? x.charCodeAt(0) : x);
		if (!x) return 0; for (let i = 0; i < Math.min(n ?? x.length, x.length); i++) x[i] = this.xferByte(x[i]);
		return x;
	}
	transfer16(w) { if (this.order) { const h = this.xferByte(w >> 8); return (h << 8) | this.xferByte(w); } const l = this.xferByte(w); return (this.xferByte(w >> 8) << 8) | l; }
	transfer32(w) { const h = this.transfer16(w >>> 16); return ((h << 16) | this.transfer16(w & 0xffff)) >>> 0; }
	transferBytes(out, inp, n) { for (let i = 0; i < (n ?? out.length); i++) { const v = this.xferByte(out ? out[i] : 0xff); if (inp) inp[i] = v; } }
	write(b) { this.xferByte(b); } write16(w) { this.transfer16(w); } write32(w) { this.transfer32(w); } writePixels(buf, n) { this.writeBytes(buf, n); }
}
Object.assign(SPIClass.prototype, busBase);
D.SPIClass = SPIClass;
D.makeSPI = opts => new SPIClass(opts);

// ==== Arduino library shims (N.devices.libs)
// Programs construct them like the C++ libraries (new L.Adafruit_BME280(); bme.begin(0x76)). The runtime calls N.devices.bindHal(hal) before a program
// starts; shims reach the device models only through hal.wire(i) / hal.spi(i) and the hal pin functions, with the chips' real register protocols.
// Unknown u8g2_font_* / Free* font identifiers read from N.devices.libs return their own name.
const L = {};
D.libs = new Proxy(L, { get: (t, k) => (k in t || typeof k !== 'string' || !/^(u8g2_font_|Free[A-Z])/.test(k) ? t[k] : k) });
let HAL = null;
D.bindHal = h => { HAL = h; D.clock.skew = 0; };
const hal = () => { if (!HAL) throw new Error('N.devices.bindHal(hal) must be called before using library shims'); return HAL; };
const isWire = w => w && typeof w.beginTransmission === 'function', isSPI = s => s && typeof s.transfer === 'function' && typeof s.beginTransaction === 'function';
const WIRE = w => (isWire(w) ? w : hal().wire(0)), SPIB = s => (isSPI(s) ? s : hal().spi(0));
// library delays cannot block: they move the device clock (D.clock.skew) and tell the runtime (hal.delayHint)
const wait = ms => { D.clock.skew += ms / 1000; if (HAL && HAL.delayHint) HAL.delayHint(ms); };
const millis = () => ((HAL && HAL.now ? HAL.now() : 0) + D.clock.skew) * 1000;
const okPin = p => p != null && p !== -1 && p !== 255 && p !== '' && p !== false;
const dw = (p, v) => { if (okPin(p)) hal().digitalWrite(p, v ? 1 : 0); }, pm = (p, m) => { if (okPin(p) && HAL && HAL.pinMode) HAL.pinMode(p, m); };
// classes callable with or without new (C++ temporaries: CRGB(1, 2, 3), DateTime(…), SPISettings(…))
const callable = C => { const F = function (...a) { return new C(...a); }; F.prototype = C.prototype; Object.setPrototypeOf(F, C); Object.defineProperty(F, 'name', { value: C.name }); return F; };
Object.assign(L, { HIGH: 1, LOW: 0, INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2, INPUT_PULLDOWN: 3, MSBFIRST: 1, LSBFIRST: 0, SPI_MODE0: 0, SPI_MODE1: 1, SPI_MODE2: 2, SPI_MODE3: 3, DEC: 10, HEX: 16, OCT: 8, BIN: 2, CHANGE: 3, FALLING: 2, RISING: 1 });
L.SPISettings = callable(class SPISettings { constructor(clock = 4e6, bitOrder = 1, dataMode = 0) { Object.assign(this, { clock, bitOrder, dataMode }); } });

class I2C {   // the Wire transactions the Arduino libraries make
	constructor(a, w) { this.a = a; this.w = WIRE(w); }
	detect() { this.w.beginTransmission(this.a); return this.w.endTransmission() === 0; }
	write(bytes, stop = true) { this.w.beginTransmission(this.a); for (const b of bytes) this.w.write(b & 255); return this.w.endTransmission(stop) === 0; }
	read(n) { if (this.w.requestFrom(this.a, n) !== n) return null; const o = []; for (let i = 0; i < n; i++) o.push(this.w.read()); return o; }
	wr(bytes, n) { return this.write(bytes, false) ? this.read(n) : null; }
	rN(reg, n) { return this.wr([reg], n) || new Array(n).fill(0xff); }
	r8(reg) { return this.rN(reg, 1)[0]; }
	r16(reg, le) { const d = this.rN(reg, 2); return le ? d[0] | (d[1] << 8) : (d[0] << 8) | d[1]; }
	w8(reg, v) { return this.write([reg, v]); }
	w16(reg, v, le) { return this.write(le ? [reg, v & 255, (v >> 8) & 255] : [reg, (v >> 8) & 255, v & 255]); }
}
class SPIReg {   // Bosch / ST register access over SPI (read = reg | readBit), chip select through digitalWrite
	constructor(cs, spi, rb = 0x80) { this.cs = cs; this.s = SPIB(spi); this.rb = rb; pm(cs, 1); dw(cs, 1); }
	tx(fn) { this.s.beginTransaction(new L.SPISettings(1e6, 1, 0)); dw(this.cs, 0); try { return fn(this.s); } finally { dw(this.cs, 1); this.s.endTransaction(); } }
	rN(reg, n) { return this.tx(s => { s.transfer((reg | this.rb) & 255); return Array.from({ length: n }, () => s.transfer(0)); }); }
	r8(reg) { return this.rN(reg, 1)[0]; }
	w8(reg, v) { this.tx(s => { s.transfer(reg & ~this.rb & 255); s.transfer(v); }); return true; }
}

// ---- Arduino Print and printf formatting
function fmtNum(v, b) {
	if (v == null) return '';
	if (typeof v === 'string') return v;
	if (typeof v === 'boolean') return v ? '1' : '0';
	if (Array.isArray(v) || ArrayBuffer.isView(v)) { let s = ''; for (const c of v) { if (!c) break; s += typeof c === 'string' ? c : String.fromCharCode(c); } return s; }
	if (typeof v === 'object') return String(v);
	v = Number(v);
	if (b === 16 || b === 2 || b === 8) return (v < 0 ? v >>> 0 : Math.trunc(v)).toString(b).toUpperCase();
	if (!Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf';
	return Number.isInteger(v) && (b == null || b === 10) ? String(v) : v.toFixed(b == null || b === 10 ? 2 : Math.max(0, b));
}
const sprintf = (L.sprintf = (f, ...a) => {
	let i = 0;
	return String(f).replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?(hh|h|ll|l|z)?([diuxXoscfFeEgGp%])/g, (m, fl, w, pr, len, c) => {
		if (c === '%') return '%';
		if (w === '*') w = a[i++]; if (pr === '*') pr = a[i++];
		const x = a[i++], n = Math.trunc(+x || 0); let s;
		if (c === 'd' || c === 'i') s = (fl.includes('+') && n >= 0 ? '+' : '') + n;
		else if (c === 'u' || c === 'x' || c === 'X' || c === 'o') { s = (n >>> 0).toString(c === 'u' ? 10 : c === 'o' ? 8 : 16); if (c === 'X') s = s.toUpperCase(); }
		else if (c === 'c') s = typeof x === 'string' ? x[0] : String.fromCharCode(x);
		else if (c === 's') { s = fmtNum(x); if (pr != null) s = s.slice(0, +pr); }
		else if (c === 'e' || c === 'E') { s = (+x).toExponential(pr == null ? 6 : +pr); if (c === 'E') s = s.toUpperCase(); }
		else if (c === 'g' || c === 'G') s = String(+(+x).toPrecision(pr == null ? 6 : +pr || 1));
		else s = (fl.includes('+') && +x >= 0 ? '+' : '') + (+x).toFixed(pr == null ? 6 : +pr);
		if (w && s.length < +w) s = fl.includes('-') ? s.padEnd(+w) : fl.includes('0') && c !== 's' && c !== 'c' ? (s[0] === '-' ? '-' + s.slice(1).padStart(+w - 1, '0') : s.padStart(+w, '0')) : s.padStart(+w);
		return s;
	});
});
class Print {
	write() { return 1; }
	print(v, b) { const s = fmtNum(v, b); for (let i = 0; i < s.length; i++) this.write(s.charCodeAt(i)); return s.length; }
	println(v, b) { const n = v === undefined ? 0 : this.print(v, b); this.write(13); this.write(10); return n + 2; }
	printf(f, ...a) { return this.print(sprintf(f, ...a)); }
}

// ==== Adafruit_GFX (classic 5×7 font)
class Adafruit_GFX extends Print {
	constructor(w, h) { super(); Object.assign(this, { WIDTH: w, HEIGHT: h, _width: w, _height: h, rotation: 0, cursor_x: 0, cursor_y: 0, textcolor: 0xffff, textbgcolor: 0xffff, textsize_x: 1, textsize_y: 1, wrap: true, _cp437: false }); }
	width() { return this._width; } height() { return this._height; } getRotation() { return this.rotation; }
	setRotation(r) { this.rotation = r & 3; const s = r & 1; this._width = s ? this.HEIGHT : this.WIDTH; this._height = s ? this.WIDTH : this.HEIGHT; }
	drawPixel() {} startWrite() {} endWrite() {}
	writePixel(x, y, c) { this.drawPixel(x, y, c); }
	writeFastVLine(x, y, h, c) { this.drawFastVLine(x, y, h, c); } writeFastHLine(x, y, w, c) { this.drawFastHLine(x, y, w, c); } writeFillRect(x, y, w, h, c) { this.fillRect(x, y, w, h, c); }
	writeLine(x0, y0, x1, y1, c) {   // Bresenham
		const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
		if (steep) [x0, y0, x1, y1] = [y0, x0, y1, x1];
		if (x0 > x1) [x0, x1, y0, y1] = [x1, x0, y1, y0];
		const dx = x1 - x0, dy = Math.abs(y1 - y0), ys = y0 < y1 ? 1 : -1; let err = dx >> 1;
		for (; x0 <= x1; x0++) { if (steep) this.writePixel(y0, x0, c); else this.writePixel(x0, y0, c); if ((err -= dy) < 0) { y0 += ys; err += dx; } }
	}
	drawFastVLine(x, y, h, c) { this.startWrite(); this.writeLine(x, y, x, y + h - 1, c); this.endWrite(); }
	drawFastHLine(x, y, w, c) { this.startWrite(); this.writeLine(x, y, x + w - 1, y, c); this.endWrite(); }
	fillRect(x, y, w, h, c) { this.startWrite(); for (let i = x; i < x + w; i++) this.writeFastVLine(i, y, h, c); this.endWrite(); }
	fillScreen(c) { this.fillRect(0, 0, this._width, this._height, c); }
	drawLine(x0, y0, x1, y1, c) {
		x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
		if (x0 === x1) this.drawFastVLine(x0, Math.min(y0, y1), Math.abs(y1 - y0) + 1, c);
		else if (y0 === y1) this.drawFastHLine(Math.min(x0, x1), y0, Math.abs(x1 - x0) + 1, c);
		else { this.startWrite(); this.writeLine(x0, y0, x1, y1, c); this.endWrite(); }
	}
	circ(r, f) { let e = 1 - r, ddx = 1, ddy = -2 * r, x = 0, y = r; while (x < y) { if (e >= 0) { y--; ddy += 2; e += ddy; } x++; ddx += 2; e += ddx; f(x, y); } }   // midpoint circle
	drawCircle(x0, y0, r, c) {
		this.startWrite(); for (const [a, b] of [[0, r], [0, -r], [r, 0], [-r, 0]]) this.writePixel(x0 + a, y0 + b, c);
		this.circ(r, (x, y) => { for (const [a, b] of [[x, y], [-x, y], [x, -y], [-x, -y], [y, x], [-y, x], [y, -x], [-y, -x]]) this.writePixel(x0 + a, y0 + b, c); }); this.endWrite();
	}
	drawCircleHelper(x0, y0, r, cn, c) {
		this.circ(r, (x, y) => {
			if (cn & 4) { this.writePixel(x0 + x, y0 + y, c); this.writePixel(x0 + y, y0 + x, c); }
			if (cn & 2) { this.writePixel(x0 + x, y0 - y, c); this.writePixel(x0 + y, y0 - x, c); }
			if (cn & 8) { this.writePixel(x0 - y, y0 + x, c); this.writePixel(x0 - x, y0 + y, c); }
			if (cn & 1) { this.writePixel(x0 - y, y0 - x, c); this.writePixel(x0 - x, y0 - y, c); }
		});
	}
	fillCircle(x0, y0, r, c) { this.startWrite(); this.writeFastVLine(x0, y0 - r, 2 * r + 1, c); this.fillCircleHelper(x0, y0, r, 3, 0, c); this.endWrite(); }
	fillCircleHelper(x0, y0, r, cn, d, c) {
		let px = 0, py = r; d++;
		this.circ(r, (x, y) => {
			if (x < y + 1) { if (cn & 1) this.writeFastVLine(x0 + x, y0 - y, 2 * y + d, c); if (cn & 2) this.writeFastVLine(x0 - x, y0 - y, 2 * y + d, c); }
			if (y !== py) { if (cn & 1) this.writeFastVLine(x0 + py, y0 - px, 2 * px + d, c); if (cn & 2) this.writeFastVLine(x0 - py, y0 - px, 2 * px + d, c); py = y; }
			px = x;
		});
	}
	drawRect(x, y, w, h, c) { this.startWrite(); this.writeFastHLine(x, y, w, c); this.writeFastHLine(x, y + h - 1, w, c); this.writeFastVLine(x, y, h, c); this.writeFastVLine(x + w - 1, y, h, c); this.endWrite(); }
	drawRoundRect(x, y, w, h, r, c) {
		r = Math.min(r, Math.min(w, h) >> 1); this.startWrite();
		this.writeFastHLine(x + r, y, w - 2 * r, c); this.writeFastHLine(x + r, y + h - 1, w - 2 * r, c); this.writeFastVLine(x, y + r, h - 2 * r, c); this.writeFastVLine(x + w - 1, y + r, h - 2 * r, c);
		for (const [a, b, k] of [[x + r, y + r, 1], [x + w - r - 1, y + r, 2], [x + w - r - 1, y + h - r - 1, 4], [x + r, y + h - r - 1, 8]]) this.drawCircleHelper(a, b, r, k, c);
		this.endWrite();
	}
	fillRoundRect(x, y, w, h, r, c) { r = Math.min(r, Math.min(w, h) >> 1); this.startWrite(); this.writeFillRect(x + r, y, w - 2 * r, h, c); this.fillCircleHelper(x + w - r - 1, y + r, r, 1, h - 2 * r - 1, c); this.fillCircleHelper(x + r, y + r, r, 2, h - 2 * r - 1, c); this.endWrite(); }
	drawTriangle(x0, y0, x1, y1, x2, y2, c) { this.drawLine(x0, y0, x1, y1, c); this.drawLine(x1, y1, x2, y2, c); this.drawLine(x2, y2, x0, y0, c); }
	fillTriangle(x0, y0, x1, y1, x2, y2, c) {
		[[x0, y0], [x1, y1], [x2, y2]] = [[x0, y0], [x1, y1], [x2, y2]].sort((a, b) => a[1] - b[1]);
		const h = (a, b, y) => { if (a > b) [a, b] = [b, a]; this.writeFastHLine(a, y, b - a + 1, c); };
		this.startWrite();
		if (y0 === y2) { h(Math.min(x0, x1, x2), Math.max(x0, x1, x2), y0); return this.endWrite(); }
		const dx01 = x1 - x0, dy01 = y1 - y0, dx02 = x2 - x0, dy02 = y2 - y0, dx12 = x2 - x1, dy12 = y2 - y1; let sa = 0, sb = 0, y = y0;
		for (; y <= (y1 === y2 ? y1 : y1 - 1); y++) { h(x0 + Math.trunc(sa / dy01), x0 + Math.trunc(sb / dy02), y); sa += dx01; sb += dx02; }
		sa = dx12 * (y - y1); sb = dx02 * (y - y0);
		for (; y <= y2; y++) { h(x1 + Math.trunc(sa / dy12), x0 + Math.trunc(sb / dy02), y); sa += dx12; sb += dx02; }
		this.endWrite();
	}
	bits(x, y, bm, w, h, f, xbm) { const bw = (w + 7) >> 3; this.startWrite(); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const b = bm[j * bw + (i >> 3)] || 0; f(x + i, y + j, xbm ? (b >> (i & 7)) & 1 : (b << (i & 7)) & 0x80); } this.endWrite(); }
	drawBitmap(x, y, bm, w, h, c, bg) { this.bits(x, y, bm, w, h, (a, b, on) => (on ? this.writePixel(a, b, c) : bg !== undefined && this.writePixel(a, b, bg))); }
	drawXBitmap(x, y, bm, w, h, c) { this.bits(x, y, bm, w, h, (a, b, on) => on && this.writePixel(a, b, c), 1); }
	drawRGBBitmap(x, y, bm, w, h) { this.startWrite(); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.writePixel(x + i, y + j, bm[j * w + i]); this.endWrite(); }
	drawGrayscaleBitmap(x, y, bm, w, h) { this.drawRGBBitmap(x, y, bm, w, h); }
	drawChar(x, y, ch, color, bg, sx = 1, sy = sx) {
		if (typeof ch === 'string') ch = ch.charCodeAt(0);
		if (x >= this._width || y >= this._height || x + 6 * sx - 1 < 0 || y + 8 * sy - 1 < 0) return;
		if (!this._cp437 && ch >= 176) ch++;
		const px = (i, j, c) => (sx === 1 && sy === 1 ? this.writePixel(x + i, y + j, c) : this.writeFillRect(x + i * sx, y + j * sy, sx, sy, c));
		this.startWrite();
		for (let i = 0; i < 6; i++) for (let j = 0, line = i < 5 ? FONT5X7[(ch & 255) * 5 + i] : 0; j < 8; j++, line >>= 1) if (line & 1) px(i, j, color); else if (bg !== color) px(i, j, bg);
		this.endWrite();
	}
	write(c) {
		if (typeof c === 'string') { for (const ch of c) this.write(ch.charCodeAt(0)); return c.length; }
		const sx = this.textsize_x, sy = this.textsize_y;
		if (c === 10) { this.cursor_x = 0; this.cursor_y += sy * 8; }
		else if (c !== 13) { if (this.wrap && this.cursor_x + sx * 6 > this._width) { this.cursor_x = 0; this.cursor_y += sy * 8; } this.drawChar(this.cursor_x, this.cursor_y, c, this.textcolor, this.textbgcolor, sx, sy); this.cursor_x += sx * 6; }
		return 1;
	}
	setCursor(x, y) { this.cursor_x = x; this.cursor_y = y; } getCursorX() { return this.cursor_x; } getCursorY() { return this.cursor_y; }
	setTextSize(sx, sy) { this.textsize_x = sx > 0 ? sx : 1; this.textsize_y = sy > 0 ? sy : this.textsize_x; }
	setTextColor(c, bg = c) { this.textcolor = c; this.textbgcolor = bg; }
	setTextWrap(w) { this.wrap = !!w; } cp437(x = true) { this._cp437 = !!x; } setFont() {} invertDisplay() {}
	getTextBounds(str, x, y, out) {   // → { x1, y1, w, h } (also written into out)
		let x1 = 1e9, y1 = 1e9, x2 = -1, y2 = -1; const sx = this.textsize_x * 6, sy = this.textsize_y * 8;
		for (const ch of fmtNum(str)) {
			if (ch === '\n') { x = 0; y += sy; continue; } if (ch === '\r') continue;
			if (this.wrap && x + sx > this._width) { x = 0; y += sy; }
			x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x + sx - 1); y2 = Math.max(y2, y + sy - 1); x += sx;
		}
		const r = x2 >= x1 ? { x1, y1, w: x2 - x1 + 1, h: y2 - y1 + 1 } : { x1: x, y1: y, w: 0, h: 0 };
		if (out && typeof out === 'object') Object.assign(out, r);
		return r;
	}
	color565(r, g, b) { return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3); }
}
L.Adafruit_GFX = Adafruit_GFX;

// ==== monochrome OLEDs: Adafruit_SSD1306, Adafruit_SH1106G / SH1107 (page buffer, rotation;
// I2C 0x00 / 0x40 control bytes or SPI with D/C), U8g2 (minimal)
Object.assign(L, { SSD1306_BLACK: 0, SSD1306_WHITE: 1, SSD1306_INVERSE: 2, BLACK: 0, WHITE: 1, INVERSE: 2, SSD1306_EXTERNALVCC: 1, SSD1306_SWITCHCAPVCC: 2, SH110X_BLACK: 0, SH110X_WHITE: 1, SH110X_INVERSE: 2 });
class MonoOLED extends Adafruit_GFX {
	// (w, h, &Wire, rst) | (w, h, &SPI, dc, rst, cs) | (w, h, mosi, sclk, dc, rst, cs) | (w, h, rst)
	constructor(w = 128, h = 64, ...a) {
		super(w, h); this.buffer = new Uint8Array(w * ((h + 7) >> 3));
		if (isSPI(a[0])) [this.spi, this.dc, this.rst, this.cs] = a;
		else if (a.length >= 5) { this.soft = true; [, , this.dc, this.rst, this.cs] = a; }
		else if (isWire(a[0])) [this.wire, this.rst] = a; else this.rst = a[0];
	}
	get isSPI() { return !!(this.spi || this.soft); }
	bus() { return this.isSPI ? SPIB(this.spi) : WIRE(this.wire); }
	tx(fn) { if (!this.isSPI) return fn(); this.bus().beginTransaction(new L.SPISettings(8e6, 1, 0)); dw(this.cs, 0); fn(); dw(this.cs, 1); this.bus().endTransaction(); }
	out(list, dc) {   // commands (dc 0) or data (dc 1); over I2C in 31-byte chunks behind the control byte
		if (this.isSPI) { dw(this.dc, dc); this.bus().writeBytes(Uint8Array.from(list)); return; }
		const w = this.bus();
		for (let i = 0; i < list.length; i += 31) { w.beginTransmission(this.addr); w.write(dc ? 0x40 : 0); for (let k = i; k < Math.min(i + 31, list.length); k++) w.write(list[k]); w.endTransmission(); }
	}
	cmds(list) { this.out(list, 0); }
	ssd1306_command(c) { this.tx(() => this.cmds([c])); }
	hwReset() { if (okPin(this.rst)) { pm(this.rst, 1); dw(this.rst, 1); wait(1); dw(this.rst, 0); wait(10); dw(this.rst, 1); } }
	xy(x, y) { const W = this.WIDTH, H = this.HEIGHT; return [[x, y], [W - 1 - y, x], [W - 1 - x, H - 1 - y], [y, H - 1 - x]][this.rotation]; }
	drawPixel(x, y, c) {
		if (x < 0 || y < 0 || x >= this._width || y >= this._height) return;
		[x, y] = this.xy(x, y); const i = x + (y >> 3) * this.WIDTH, m = 1 << (y & 7);
		if (c === 1) this.buffer[i] |= m; else if (c === 0) this.buffer[i] &= ~m; else if (c === 2) this.buffer[i] ^= m;
	}
	getPixel(x, y) { if (x < 0 || y < 0 || x >= this._width || y >= this._height) return false; [x, y] = this.xy(x, y); return !!(this.buffer[x + (y >> 3) * this.WIDTH] & (1 << (y & 7))); }
	clearDisplay() { this.buffer.fill(0); } getBuffer() { return this.buffer; }
	begin0(addr) { this.buffer.fill(0); if (this.isSPI) { pm(this.dc, 1); pm(this.cs, 1); dw(this.cs, 1); } else this.addr = addr; }
	invertDisplay(i) { this.ssd1306_command(i ? 0xa7 : 0xa6); }
}
class Adafruit_SSD1306 extends MonoOLED {
	begin(vcs = 2, addr = 0, reset = true) {
		const W = this.WIDTH, H = this.HEIGHT, ext = vcs === 1, big = W === 128 && H === 64, s64 = W === 64 && H === 32;
		this.begin0(addr || (H === 32 ? 0x3c : 0x3d)); if (reset) this.hwReset();
		this.contrast = big ? (ext ? 0x9f : 0xcf) : W === 96 && H === 16 ? (ext ? 0x10 : 0xaf) : s64 ? (ext ? 0x10 : 0xcf) : 0x8f;
		this.tx(() => this.cmds([0xae, 0xd5, 0x80, 0xa8, H - 1, 0xd3, 0, 0x40, 0x8d, ext ? 0x10 : 0x14, 0x20, 0, 0xa1, 0xc8, 0xda, big || s64 ? 0x12 : 2, 0x81, this.contrast, 0xd9, ext ? 0x22 : 0xf1, 0xdb, 0x40, 0xa4, 0xa6, 0x2e, 0xaf]));
		return true;
	}
	display() { this.tx(() => { this.cmds([0x22, 0, 0xff, 0x21, ...(this.WIDTH === 64 ? [0x20, 0x5f] : [0, this.WIDTH - 1])]); this.out(this.buffer, 1); }); }
	dim(d) { this.tx(() => this.cmds([0x81, d ? 0 : this.contrast])); }
	scroll(c) { this.tx(() => this.cmds(c)); }
	startscrollright(a, b) { this.scroll([0x26, 0, a, 0, b, 0, 0xff, 0x2f]); } startscrollleft(a, b) { this.scroll([0x27, 0, a, 0, b, 0, 0xff, 0x2f]); }
	startscrolldiagright(a, b) { this.scroll([0xa3, 0, this.HEIGHT, 0x29, 0, a, 0, b, 1, 0x2f]); } startscrolldiagleft(a, b) { this.scroll([0xa3, 0, this.HEIGHT, 0x2a, 0, a, 0, b, 1, 0x2f]); }
	stopscroll() { this.ssd1306_command(0x2e); }
}
class Adafruit_SH110X extends MonoOLED {
	begin(addr = 0x3c, reset = true) {
		this.begin0(addr); if (reset) this.hwReset(); wait(100);
		this.tx(() => this.cmds(this.init)); wait(100); this.ssd1306_command(0xaf);
		return this.isSPI || new I2C(this.addr, this.wire).detect();
	}
	display() { const W = this.WIDTH, o = this.off || 0; for (let p = 0; p < (this.HEIGHT + 7) >> 3; p++) this.tx(() => { this.cmds([0xb0 + p, 0x10 + (o >> 4), o & 15]); this.out(this.buffer.subarray(p * W, (p + 1) * W), 1); }); }
	setContrast(c) { this.tx(() => this.cmds([0x81, c])); } oled_command(c) { this.ssd1306_command(c); }
}
L.Adafruit_SSD1306 = Adafruit_SSD1306;
L.Adafruit_SH1106G = class extends Adafruit_SH110X { constructor(...a) { super(...a); this.off = 2; this.init = [0xae, 0xd5, 0x80, 0xa8, 0x3f, 0xd3, 0, 0x40, 0xad, 0x8b, 0xa1, 0xc8, 0xda, 0x12, 0x81, 0xff, 0xd9, 0x1f, 0xdb, 0x40, 0x33, 0xa6, 0xa4]; } };
L.Adafruit_SH1107 = class extends Adafruit_SH110X { constructor(...a) { super(...a); this.init = [0xae, 0xd5, 0x51, 0x20, 0x81, 0x4f, 0xad, 0x8a, 0xa0, 0xc0, 0xdc, 0, 0xd3, 0x60, 0xd9, 0x22, 0xdb, 0x35, 0xa8, 0x3f, 0xa4, 0xa6]; } };

// U8g2 on the same page buffer: draw colour 0 / 1 / 2 (XOR), fonts drawn with the 5×7 font scaled by their nominal height, baseline positions
Object.assign(L, { U8G2_R0: 0, U8G2_R1: 1, U8G2_R2: 2, U8G2_R3: 3, U8G2_MIRROR: 4, U8X8_PIN_NONE: 255, U8G2_DRAW_UPPER_RIGHT: 1, U8G2_DRAW_UPPER_LEFT: 2, U8G2_DRAW_LOWER_LEFT: 4, U8G2_DRAW_LOWER_RIGHT: 8, U8G2_DRAW_ALL: 15 });
class U8G2 extends MonoOLED {
	constructor(sh, w, h, bus, a) {
		super(w, h); Object.assign(this, { sh, addr: 0x3c, color: 1, fs: 1, pos: 7 }); this.setRotation(a[0] & 3);
		if (bus === 'i2c') this.rst = a[1]; else if (bus === 'swi2c') this.rst = a[3]; else { this.soft = true; if (bus === 'spi') [, this.cs, this.dc, this.rst] = a; else [, , , this.cs, this.dc, this.rst] = a; }
	}
	begin() {
		this.hwReset(); if (this.isSPI) { pm(this.cs, 1); pm(this.dc, 1); dw(this.cs, 1); }
		const H = this.HEIGHT; this.tx(() => this.cmds([0xae, 0xd5, 0x80, 0xa8, H - 1, 0xd3, 0, 0x40, 0x8d, 0x14, 0x20, 0, 0xa1, 0xc8, 0xda, H === 32 ? 2 : 0x12, 0x81, 0xcf, 0xd9, 0xf1, 0xdb, 0x40, 0x2e, 0xa4, 0xa6]));
		this.clearDisplay(); this.setPowerSave(0); return true;
	}
	setI2CAddress(a) { this.addr = a >> 1; }
	getDisplayWidth() { return this._width; } getDisplayHeight() { return this._height; }
	setPowerSave(on) { this.ssd1306_command(on ? 0xae : 0xaf); } setContrast(v) { this.tx(() => this.cmds([0x81, v & 255])); } setFlipMode(m) { this.tx(() => this.cmds(m ? [0xa0, 0xc0] : [0xa1, 0xc8])); }
	sendBuffer() { const o = this.sh ? 2 : 0, W = this.WIDTH; for (let p = 0; p < this.HEIGHT >> 3; p++) this.tx(() => { this.cmds([0x10 | (o >> 4), o & 15, 0xb0 | p]); this.out(this.buffer.subarray(p * W, (p + 1) * W), 1); }); }
	updateDisplay() { this.sendBuffer(); } clearBuffer() { this.buffer.fill(0); } clearDisplay() { this.clearBuffer(); this.sendBuffer(); } clear() { this.home(); this.clearDisplay(); }
	firstPage() { this.clearBuffer(); } nextPage() { this.sendBuffer(); return false; }
	getBufferPtr() { return this.buffer; } setDisplayRotation(r) { this.setRotation(r & 3); } enableUTF8Print() {} home() { this.cursor_x = this.cursor_y = 0; }
	drawPixel(x, y, c = this.color) { super.drawPixel(x | 0, y | 0, c); }
	drawHLine(x, y, w) { this.drawFastHLine(x, y, w, this.color); } drawVLine(x, y, h) { this.drawFastVLine(x, y, h, this.color); }
	drawLine(x0, y0, x1, y1, c = this.color) { super.drawLine(x0, y0, x1, y1, c); }
	drawBox(x, y, w, h) { this.fillRect(x, y, w, h, this.color); } drawFrame(x, y, w, h) { this.drawRect(x, y, w, h, this.color); }
	drawRBox(x, y, w, h, r) { this.fillRoundRect(x, y, w, h, r, this.color); } drawRFrame(x, y, w, h, r) { this.drawRoundRect(x, y, w, h, r, this.color); }
	drawCircle(x, y, r, o = 15) { if (o === 15) super.drawCircle(x, y, r, this.color); else this.drawCircleHelper(x, y, r, ((o & 1) << 1) | ((o & 2) >> 1) | ((o & 4) << 1) | ((o & 8) >> 1), this.color); }
	drawDisc(x, y, r) { this.fillCircle(x, y, r, this.color); }
	drawTriangle(x0, y0, x1, y1, x2, y2) { this.fillTriangle(x0, y0, x1, y1, x2, y2, this.color); }
	drawXBM(x, y, w, h, bm) { this.drawXBitmap(x, y, bm, w, h, this.color); } drawXBMP(x, y, w, h, bm) { this.drawXBM(x, y, w, h, bm); }
	drawBitmap(x, y, cnt, h, bm) { super.drawBitmap(x, y, bm, cnt * 8, h, this.color); }
	setDrawColor(c) { this.color = c; } getDrawColor() { return this.color; } setBitmapMode() {} setFontMode() {} setFontDirection() {}
	setFont(f) { const m = /(\d+)x(\d+)|(\d{2})/.exec(String(f || '')); this.fs = Math.max(1, Math.round((m ? +(m[2] || m[3]) : 8) / 9)); }
	setFontPosBaseline() { this.pos = 7; } setFontPosTop() { this.pos = 0; } setFontPosBottom() { this.pos = 8; } setFontPosCenter() { this.pos = 4; }
	getAscent() { return 7 * this.fs; } getDescent() { return -this.fs; } getMaxCharHeight() { return 8 * this.fs; }
	getStrWidth(s) { return fmtNum(s).length * 6 * this.fs; } getUTF8Width(s) { return this.getStrWidth(s); }
	drawGlyph(x, y, c) { this.drawChar(x, y - this.pos * this.fs, typeof c === 'string' ? c.charCodeAt(0) : c, this.color, this.color, this.fs, this.fs); return 6 * this.fs; }
	drawStr(x, y, s) { let cx = x; for (const ch of fmtNum(s)) cx += this.drawGlyph(cx, y, ch); return cx - x; }
	drawUTF8(x, y, s) { return this.drawStr(x, y, s); }
	write(c) { if (c === 10) { this.cursor_x = 0; this.cursor_y += 8 * this.fs; } else if (c !== 13) this.cursor_x += this.drawGlyph(this.cursor_x, this.cursor_y, c); return 1; }
}
L.U8G2 = U8G2;
for (const k of 'SSD1306_128X64_NONAME SSD1306_128X64_VCOMH0 SSD1306_128X64_ALT0 SSD1306_128X32_UNIVISION SSD1306_64X48_ER SSD1306_72X40_ER SSD1309_128X64_NONAME0 SSD1309_128X64_NONAME2 SH1106_128X64_NONAME SH1106_128X64_VCOMH0 SH1106_128X64_WINSTAR'.split(' ')) {
	const [, w, h] = /(\d+)X(\d+)/.exec(k), sh = /^SH/.test(k);
	for (const b of 'F12') for (const [bn, bus] of [['HW_I2C', 'i2c'], ['SW_I2C', 'swi2c'], ['4W_HW_SPI', 'spi'], ['4W_SW_SPI', 'swspi']]) L[`U8G2_${k}_${b}_${bn}`] = class extends U8G2 { constructor(...a) { super(sh, +w, +h, bus, a); } };
}

// ==== SPI TFTs: Adafruit_ST7789 / ST7735 / ILI9341 / GC9A01A / ILI9488, TFT_eSPI (minimal)
const TFTDRV = {   // rot: rotation → MADCTL as in the Adafruit drivers (default 0x48 0x28 0x88 0xE8); init: [command, ...parameters, −delay ms]
	ST7789: { rot: [0xc0, 0xa0, 0, 0x60], w: 240, h: 320, init: [[1, -150], [0x11, -10], [0x3a, 0x55], [0x36, 8], [0x21], [0x13, -10], [0x29, -10]] },
	ST7735: { rot: [0xc0, 0xa0, 0, 0x60], w: 128, h: 160, init: [[1, -150], [0x11, -255], [0xb1, 1, 0x2c, 0x2d], [0x3a, 5], [0x36, 0xc8], [0x20], [0x13, -10], [0x29, -100]] },
	ILI9341: { w: 240, h: 320, init: [[1, -150], [0xc0, 0x23], [0xc1, 0x10], [0xc5, 0x3e, 0x28], [0x36, 0x48], [0x3a, 0x55], [0xb1, 0, 0x18], [0x11, -150], [0x29, -150]] },
	GC9A01A: { w: 240, h: 240, init: [[0xfe], [0xef], [0x36, 0x48], [0x3a, 5], [0x21], [0x11, -120], [0x29, -20]] },
	ILI9488: { w: 320, h: 480, bpp3: true, init: [[1, -150], [0x36, 0x48], [0x3a, 0x66], [0x11, -120], [0x29, -25]] },
	ST7796: { w: 320, h: 480, init: [[1, -120], [0x11, -120], [0x36, 0x48], [0x3a, 0x55], [0x29, -20]] },
};
class SPITFT extends Adafruit_GFX {
	// (cs, dc, rst) | (cs, dc, mosi, sclk, rst, miso) | (&SPI, cs, dc, rst)
	constructor(drv, a) {
		const c = TFTDRV[drv]; super(c.w, c.h); Object.assign(this, { drv, cfg: c, xs: 0, ys: 0, cs0: 0, rs0: 0, cs2: 0, rs2: 0, hz: 24e6, _tw: 0 });
		if (isSPI(a[0])) [this.spi, this.cs, this.dc, this.rst] = a; else [this.cs, this.dc, this.rst] = a.length >= 5 ? [a[0], a[1], a[4]] : a;
	}
	bus() { return SPIB(this.spi); }
	startWrite() { if (this._tw++) return; this.bus().beginTransaction(new L.SPISettings(this.hz, 1, 0)); dw(this.cs, 0); }
	endWrite() { if (--this._tw > 0) return; this._tw = 0; dw(this.cs, 1); this.bus().endTransaction(); }
	writeCommand(c) { dw(this.dc, 0); this.bus().transfer(c); dw(this.dc, 1); }
	spiWrite(b) { this.bus().transfer(b); }
	sendCommand(c, data = []) { this.startWrite(); this.writeCommand(c); for (const b of data) this.bus().transfer(b); this.endWrite(); }
	readcommand8(c, index = 0) { this.startWrite(); this.writeCommand(c); let v = 0; for (let i = 0; i <= index; i++) v = this.bus().transfer(0); this.endWrite(); return v; }
	hwInit(freq) {
		if (freq) this.hz = freq; pm(this.cs, 1); dw(this.cs, 1); pm(this.dc, 1); dw(this.dc, 1);
		if (okPin(this.rst)) { pm(this.rst, 1); dw(this.rst, 1); wait(100); dw(this.rst, 0); wait(100); dw(this.rst, 1); wait(200); }
		for (const [c, ...r] of this.cfg.init) { this.sendCommand(c, r.filter(x => x >= 0)); const d = r.find(x => x < 0); if (d) wait(-d); }
	}
	setAddrWindow(x, y, w, h) {
		x += this.xs; y += this.ys; const X = x + w - 1, Y = y + h - 1, s = this.bus();
		this.writeCommand(0x2a); for (const b of [x >> 8, x & 255, X >> 8, X & 255]) s.transfer(b);
		this.writeCommand(0x2b); for (const b of [y >> 8, y & 255, Y >> 8, Y & 255]) s.transfer(b);
		this.writeCommand(0x2c);
	}
	writeColor(c, n) {   // RGB565, or RGB666 bytes for 18-bit panels
		if (n <= 0) return; const p = this.cfg.bpp3 ? [(c >> 8) & 0xf8, (c >> 3) & 0xfc, (c << 3) & 0xf8] : [(c >> 8) & 255, c & 255], a = new Uint8Array(p.length * n);
		for (let i = 0; i < a.length; i++) a[i] = p[i % p.length]; this.bus().writeBytes(a);
	}
	writePixel(x, y, c) { if (x >= 0 && y >= 0 && x < this._width && y < this._height) { this.setAddrWindow(x, y, 1, 1); this.writeColor(c, 1); } }
	writeFillRect(x, y, w, h, c) {
		x |= 0; y |= 0; w |= 0; h |= 0; if (w < 0) { x += w + 1; w = -w; } if (h < 0) { y += h + 1; h = -h; }
		if (x < 0) { w += x; x = 0; } if (y < 0) { h += y; y = 0; } w = Math.min(w, this._width - x); h = Math.min(h, this._height - y);
		if (w > 0 && h > 0) { this.setAddrWindow(x, y, w, h); this.writeColor(c, w * h); }
	}
	writeFastHLine(x, y, w, c) { this.writeFillRect(x, y, w, 1, c); } writeFastVLine(x, y, h, c) { this.writeFillRect(x, y, 1, h, c); }
	drawPixel(x, y, c) { this.startWrite(); this.writePixel(x, y, c); this.endWrite(); }
	fillRect(x, y, w, h, c) { this.startWrite(); this.writeFillRect(x, y, w, h, c); this.endWrite(); }
	drawFastHLine(x, y, w, c) { this.fillRect(x, y, w, 1, c); } drawFastVLine(x, y, h, c) { this.fillRect(x, y, 1, h, c); }
	drawRGBBitmap(x, y, bm, w, h) {
		if (x < 0 || y < 0 || x + w > this._width || y + h > this._height || this.cfg.bpp3) return super.drawRGBBitmap(x, y, bm, w, h);
		this.startWrite(); this.setAddrWindow(x, y, w, h); const a = new Uint8Array(2 * w * h); for (let i = 0; i < w * h; i++) { a[2 * i] = bm[i] >> 8; a[2 * i + 1] = bm[i] & 255; } this.bus().writeBytes(a); this.endWrite();
	}
	pushColor(c) { this.startWrite(); this.writeColor(c, 1); this.endWrite(); }
	writePixels(cs, n) { for (let i = 0; i < n; i++) this.writeColor(cs[i], 1); }
	setRotation(m) {
		super.setRotation(m); const r = this.rotation; this.sendCommand(0x36, [(this.cfg.rot || [0x48, 0x28, 0x88, 0xe8])[r] | (this.bgr || 0)]);
		[this.xs, this.ys] = [[this.cs0, this.rs0], [this.rs0, this.cs2], [this.cs2, this.rs2], [this.rs2, this.cs0]][r];
	}
	invertDisplay(i) { this.sendCommand(i ? 0x21 : 0x20); }
	enableDisplay(on) { this.sendCommand(on ? 0x29 : 0x28); } enableSleep(on) { this.sendCommand(on ? 0x10 : 0x11); }
}
const C565 = { BLACK: 0, WHITE: 0xffff, RED: 0xf800, GREEN: 0x07e0, BLUE: 0x001f, CYAN: 0x07ff, MAGENTA: 0xf81f, YELLOW: 0xffe0, ORANGE: 0xfd20, NAVY: 0x000f, DARKGREEN: 0x03e0, DARKCYAN: 0x03ef, MAROON: 0x7800, PURPLE: 0x780f, OLIVE: 0x7be0, LIGHTGREY: 0xc618, DARKGREY: 0x7bef, GREENYELLOW: 0xafe5, PINK: 0xfc18 };
for (const k in C565) for (const p of ['ST77XX_', 'ST7735_', 'ILI9341_', 'GC9A01A_', 'ILI9488_']) L[p + k] = C565[k];
Object.assign(L, { ST77XX_ORANGE: 0xfc00, INITR_GREENTAB: 0, INITR_REDTAB: 1, INITR_BLACKTAB: 2, INITR_18GREENTAB: 0, INITR_18REDTAB: 1, INITR_18BLACKTAB: 2, INITR_144GREENTAB: 1, INITR_MINI160x80: 4, INITR_HALLOWING: 5, INITR_MINI160x80_PLUGIN: 6 });
class Adafruit_ST7789 extends SPITFT {
	constructor(...a) { super('ST7789', a); }
	init(w = 240, h = 320) {   // panel window inside the 240×320 controller memory
		this.WIDTH = w; this.HEIGHT = h;
		if (w === 240 && h === 240) Object.assign(this, { rs0: 80, rs2: 0, cs0: 0, cs2: 0 });
		else if (w === 135 && h === 240) Object.assign(this, { rs0: 40, rs2: 40, cs0: 53, cs2: 52 });
		else { this.rs0 = this.rs2 = (320 - h) >> 1; this.cs0 = this.cs2 = (240 - w) >> 1; }
		this.hwInit(); this.setRotation(0);
	}
	begin(freq) { if (freq) this.hz = freq; this.init(); }
}
class Adafruit_ST7735 extends SPITFT {
	constructor(...a) { super('ST7735', a); }
	initR(tab = 0) {
		const g = { 0: [128, 160, 2, 1], 1: [128, 128, 2, 3], 4: [80, 160, 26, 1], 6: [80, 160, 26, 1] }[tab] || [128, 160, 0, 0];
		this.bgr = tab === 2 || tab === 4 ? 0 : 8; [this.WIDTH, this.HEIGHT] = g; this.cs0 = this.cs2 = g[2]; this.rs0 = this.rs2 = g[3];
		this.hwInit(); if (tab === 2 || tab === 4) this.sendCommand(0x36, [0xc0]); this.setRotation(0);
	}
	initB() { this.initR(2); } begin() { this.initR(2); }
}
const tftClass = drv => class extends SPITFT { constructor(...a) { super(drv, a); } begin(f) { this.hwInit(f); this.setRotation(0); } };
class Adafruit_ILI9341 extends tftClass('ILI9341') { readcommand8(c, i = 0) { this.sendCommand(0xd9, [0x10 + i]); return super.readcommand8(c, 0); } }
const ILI9488 = tftClass('ILI9488');
Object.assign(L, { Adafruit_ST7789, Adafruit_ST7735, Adafruit_ILI9341, Adafruit_GC9A01A: tftClass('GC9A01A'), ILI9488, Adafruit_ILI9488: ILI9488, ILI9488_SPI: ILI9488 });

Object.assign(L, { TFT_BLACK: 0, TFT_NAVY: 0x000f, TFT_DARKGREEN: 0x03e0, TFT_DARKCYAN: 0x03ef, TFT_MAROON: 0x7800, TFT_PURPLE: 0x780f, TFT_OLIVE: 0x7be0, TFT_LIGHTGREY: 0xd69a, TFT_DARKGREY: 0x7bef, TFT_BLUE: 0x001f,
	TFT_GREEN: 0x07e0, TFT_CYAN: 0x07ff, TFT_RED: 0xf800, TFT_MAGENTA: 0xf81f, TFT_YELLOW: 0xffe0, TFT_WHITE: 0xffff, TFT_ORANGE: 0xfda0, TFT_PINK: 0xfe19, TFT_BROWN: 0x9a60,
	CL_DATUM: 3, CC_DATUM: 4, CR_DATUM: 5, L_BASELINE: 9, C_BASELINE: 10, R_BASELINE: 11 });
['TL', 'TC', 'TR', 'ML', 'MC', 'MR', 'BL', 'BC', 'BR'].forEach((k, i) => (L[k + '_DATUM'] = i));
class TFT_eSPI extends SPITFT {   // driver, size and pins from TFT_eSPI.setup or hal.tft(): { driver, width, height, cs, dc, rst, freq, xOffset, yOffset }
	constructor(w, h) {
		const s = Object.assign({ driver: 'ST7789', width: 240, height: 320, cs: 5, dc: 16, rst: -1 }, TFT_eSPI.setup, HAL && HAL.tft && HAL.tft()), d = String(s.driver).toUpperCase();
		super(TFTDRV[d] ? d : 'ST7789', [s.cs, s.dc, s.rst]); const W = (this.WIDTH = this._width = w || s.width), H = (this.HEIGHT = this._height = h || s.height);
		Object.assign(this, { setup: s, datum: 0, textfont: 1 });
		if (this.drv === 'ST7789') { this.cs0 = W === 135 ? 53 : (240 - W) >> 1; this.cs2 = W === 135 ? 52 : this.cs0; this.rs0 = W === 240 && H === 240 ? 80 : (320 - H) >> 1; this.rs2 = W === 240 && H === 240 ? 0 : this.rs0; }
		if (s.xOffset != null) this.cs0 = this.cs2 = s.xOffset; if (s.yOffset != null) this.rs0 = this.rs2 = s.yOffset;
	}
	init() { this.hwInit(this.setup.freq); if (this.drv === 'ST7789') this.sendCommand(0x21); this.setRotation(0); }
	begin() { this.init(); }
	setSwapBytes() {} setTextFont(f) { this.textfont = f; } setFreeFont() {} setTextPadding() {} setTextDatum(d) { this.datum = d; }
	fscale(f = this.textfont) { return ({ 2: 2, 4: 3, 6: 6, 7: 6, 8: 9 }[f] || 1) * this.textsize_x; }   // built-in fonts → scale of the 5×7 font
	textWidth(s, f) { return fmtNum(s).length * 6 * this.fscale(f); } fontHeight(f) { return 8 * this.fscale(f); }
	drawString(str, x, y, f) {
		const s = fmtNum(str), k = this.fscale(f), w = s.length * 6 * k, h = 8 * k, d = this.datum;
		x -= [0, w >> 1, w][d % 3]; y -= [0, h >> 1, h, 7 * k][Math.floor(d / 3)] || 0;
		this.startWrite(); for (const ch of s) { this.drawChar(x, y, ch.charCodeAt(0), this.textcolor, this.textbgcolor, k, k); x += 6 * k; } this.endWrite();
		return w;
	}
	drawCentreString(s, x, y, f) { const d = this.datum; this.datum = 1; const w = this.drawString(s, x, y, f); this.datum = d; return w; }
	drawNumber(n, x, y, f) { return this.drawString(String(Math.trunc(n)), x, y, f); }
	drawFloat(v, dp, x, y, f) { return this.drawString((+v).toFixed(dp), x, y, f); }
	pushImage(x, y, w, h, data) { this.drawRGBBitmap(x, y, data, w, h); }
}
TFT_eSPI.prototype.drawCenterString = TFT_eSPI.prototype.drawCentreString;
TFT_eSPI.setup = null; L.TFT_eSPI = TFT_eSPI;

// ==== LiquidCrystal_I2C (PCF8574 backpack: P0 RS, P1 RW, P2 E, P3 backlight, P4–P7 D4–D7; 4-bit HD44780 protocol)
class LiquidCrystal_I2C extends Print {
	constructor(addr = 0x27, cols = 16, rows = 2, charsize = 0) { super(); Object.assign(this, { addr, cols, rows, charsize, bl: 0, ctl: 4, mode: 2 }); }
	x(v) { const w = hal().wire(0); w.beginTransmission(this.addr); w.write((v | this.bl) & 255); return w.endTransmission(); }
	w4(v) { this.x(v); this.x(v | 4); this.x(v & ~4); }   // data lines, then an E pulse
	send(v, rs) { this.w4((v & 0xf0) | rs); this.w4(((v << 4) & 0xf0) | rs); }
	command(v) { this.send(v, 0); }
	write(v) { this.send(typeof v === 'string' ? v.charCodeAt(0) : v, 1); return 1; }
	init() { this.bl = 0; this.begin(); }
	begin(cols = this.cols, rows = this.rows, cs = this.charsize) {
		Object.assign(this, { cols, rows }); wait(50); this.x(0); wait(1000);
		for (const [v, t] of [[0x30, 4.5], [0x30, 4.5], [0x30, 0.15], [0x20, 0]]) { this.w4(v); wait(t); }
		this.command(0x20 | (rows > 1 ? 8 : 0) | (cs && rows === 1 ? 4 : 0)); this.ctl = 4; this.display(); this.clear(); this.mode = 2; this.command(4 | this.mode); this.home();
	}
	clear() { this.command(1); wait(2); } home() { this.command(2); wait(2); }
	setCursor(c, r) { this.command(0x80 | (c + [0, 0x40, 0x14, 0x54][Math.min(r, this.rows - 1)])); }
	dctl(bit, on) { this.ctl = on ? this.ctl | bit : this.ctl & ~bit; this.command(8 | this.ctl); }
	display() { this.dctl(4, 1); } noDisplay() { this.dctl(4, 0); } cursor() { this.dctl(2, 1); } noCursor() { this.dctl(2, 0); } blink() { this.dctl(1, 1); } noBlink() { this.dctl(1, 0); }
	emode(bit, on) { this.mode = on ? this.mode | bit : this.mode & ~bit; this.command(4 | this.mode); }
	leftToRight() { this.emode(2, 1); } rightToLeft() { this.emode(2, 0); } autoscroll() { this.emode(1, 1); } noAutoscroll() { this.emode(1, 0); }
	scrollDisplayLeft() { this.command(0x18); } scrollDisplayRight() { this.command(0x1c); }
	createChar(loc, map) { this.command(0x40 | ((loc & 7) << 3)); for (let i = 0; i < 8; i++) this.write(map[i] || 0); }
	backlight() { this.bl = 8; this.x(0); } noBacklight() { this.bl = 0; this.x(0); } setBacklight(v) { if (v) this.backlight(); else this.noBacklight(); } getBacklight() { return !!this.bl; }
}
Object.assign(L, { LiquidCrystal_I2C, LCD_5x8DOTS: 0, LCD_5x10DOTS: 4 });

// ==== Adafruit_NeoPixel: hal.neopixel(pin, count, order) → { show(bytes) }; bytes in wire order (N.devices.decodeWS2812)
Object.assign(L, { NEO_RGB: 6, NEO_RBG: 9, NEO_GRB: 0x52, NEO_GBR: 0xa1, NEO_BRG: 0x58, NEO_BGR: 0xa4, NEO_RGBW: 0xc6, NEO_GRBW: 0xd2, NEO_WRGB: 0x1b, NEO_KHZ800: 0, NEO_KHZ400: 0x100 });
const GAMMA = Uint8Array.from({ length: 256 }, (_, i) => Math.floor(Math.pow(i / 255, 2.6) * 255 + 0.5)), SINE = Uint8Array.from({ length: 256 }, (_, i) => Math.floor(Math.sin((i / 128) * Math.PI) * 127.5 + 128));
class Adafruit_NeoPixel {
	constructor(n = 0, pin = -1, type = 0x52) { this.pin = pin; this.brightness = 0; this.updateType(type); this.updateLength(n); }
	static Color(r, g, b, w) { return ((w === undefined ? 0 : (w & 255) << 24) | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0; }
	static ColorHSV(hue = 0, sat = 255, val = 255) {   // the library's integer rainbow
		let r, g, b; hue = Math.floor(((hue & 0xffff) * 1530 + 32768) / 65536);
		if (hue < 510) { b = 0; if (hue < 255) { r = 255; g = hue; } else { r = 510 - hue; g = 255; } }
		else if (hue < 1020) { r = 0; if (hue < 765) { g = 255; b = hue - 510; } else { g = 1020 - hue; b = 255; } }
		else if (hue < 1530) { g = 0; if (hue < 1275) { r = hue - 1020; b = 255; } else { r = 255; b = 1530 - hue; } }
		else { r = 255; g = b = 0; }
		const v1 = 1 + val, s1 = 1 + sat, s2 = 255 - sat, k = x => (((x * s1) >> 8) + s2) * v1;
		return (((k(r) & 0xff00) << 8) | (k(g) & 0xff00) | (k(b) >> 8)) >>> 0;
	}
	static gamma8(x) { return GAMMA[x & 255]; }
	static gamma32(c) { return ((GAMMA[c >>> 24] << 24) | (GAMMA[(c >> 16) & 255] << 16) | (GAMMA[(c >> 8) & 255] << 8) | GAMMA[c & 255]) >>> 0; }
	static sine8(x) { return SINE[x & 255]; }
	updateType(t) { const w = (t >> 6) & 3, r = (t >> 4) & 3, g = (t >> 2) & 3, b = t & 3, n = w === r ? 3 : 4, s = []; s[r] = 'R'; s[g] = 'G'; s[b] = 'B'; if (n === 4) s[w] = 'W'; this.type = t; this.o = { w, r, g, b, n, s: s.join('') }; if (this.numLEDs != null) this.updateLength(this.numLEDs); }
	updateLength(n) { this.numLEDs = n; this.pixels = new Uint8Array(n * this.o.n); this.np = null; }
	begin() { pm(this.pin, 1); } setPin(p) { this.pin = p; this.np = null; pm(p, 1); }
	getPin() { return this.pin; } numPixels() { return this.numLEDs; } getPixels() { return this.pixels; } getBrightness() { return (this.brightness - 1) & 255; } canShow() { return true; }
	show() { const h = hal(); if (!this.np) this.np = h.neopixel ? h.neopixel(this.pin, this.numLEDs, this.o.s + (this.type & 0x100 ? '@400' : '')) : { show() {} }; this.np.show(this.pixels.slice()); }
	setPixelColor(n, r, g, b, w) {
		if (n < 0 || n >= this.numLEDs) return;
		if (g === undefined) { const c = r >>> 0; w = c >>> 24; r = (c >> 16) & 255; g = (c >> 8) & 255; b = c & 255; }
		const br = this.brightness, o = this.o, p = n * o.n, P = this.pixels, k = v => (br ? ((v & 255) * br) >> 8 : v & 255);   // brightness is applied when the pixel is set (lossy, like the library)
		P[p + o.r] = k(r); P[p + o.g] = k(g); P[p + o.b] = k(b); if (o.n === 4) P[p + o.w] = k(w || 0);
	}
	fill(c = 0, first = 0, count = 0) { const end = count ? Math.min(this.numLEDs, first + count) : this.numLEDs; for (let i = first; i < end; i++) this.setPixelColor(i, c); }
	getPixelColor(n) {
		if (n < 0 || n >= this.numLEDs) return 0;
		const o = this.o, p = n * o.n, br = this.brightness, g = i => (br ? (this.pixels[p + i] << 8) / br : this.pixels[p + i]) & 255;
		return (((o.n === 4 ? g(o.w) : 0) << 24) | (g(o.r) << 16) | (g(o.g) << 8) | g(o.b)) >>> 0;
	}
	setBrightness(b) {
		const nb = (b + 1) & 255; if (nb === this.brightness) return;
		const old = (this.brightness - 1) & 255, s = !old ? 0 : b === 255 ? Math.floor(65535 / old) : Math.floor(((nb << 8) - 1) / old);
		for (let i = 0; i < this.pixels.length; i++) this.pixels[i] = (this.pixels[i] * s) >> 8;
		this.brightness = nb;
	}
	clear() { this.pixels.fill(0); }
	rainbow(first = 0, reps = 1, sat = 255, bri = 255, gam = true) { for (let i = 0; i < this.numLEDs; i++) { const c = Adafruit_NeoPixel.ColorHSV((first + Math.floor((i * reps * 65536) / this.numLEDs)) & 0xffff, sat, bri); this.setPixelColor(i, gam ? Adafruit_NeoPixel.gamma32(c) : c); } }
}
for (const k of ['Color', 'ColorHSV', 'gamma8', 'gamma32', 'sine8']) Adafruit_NeoPixel.prototype[k] = Adafruit_NeoPixel[k];   // strip.Color(...) in C++
L.Adafruit_NeoPixel = Adafruit_NeoPixel;

// ==== FastLED (minimal): CRGB / CHSV (rainbow hsv2rgb), addLeds<TYPE, DATA_PIN[, CLOCK_PIN][, ORDER]>(leds, n)
// → addLeds('TYPE', pin[, clk][, 'ORDER'], leds, n[, offset]); WS2812-type controllers go to hal.neopixel, APA102-type to hal.apa102
const scale8 = (i, s) => ((i & 255) * (1 + (s & 255))) >> 8, scale8v = (i, s) => (((i & 255) * (s & 255)) >> 8) + (i && s ? 1 : 0);
const qadd8 = (a, b) => Math.min(255, (a & 255) + (b & 255)), qsub8 = (a, b) => Math.max(0, (a & 255) - (b & 255));
function hsv2rgb(h, s, v) {
	h &= 255; s &= 255; v &= 255; const off8 = (h & 0x1f) << 3, third = scale8(off8, 85), two = scale8(off8, 170); let r, g, b;
	if (!(h & 0x80)) { if (!(h & 0x40)) { if (!(h & 0x20)) { r = 255 - third; g = third; b = 0; } else { r = 171; g = 85 + third; b = 0; } } else if (!(h & 0x20)) { r = 171 - two; g = 170 + third; b = 0; } else { r = 0; g = 255 - third; b = third; } }
	else if (!(h & 0x40)) { if (!(h & 0x20)) { r = 0; g = 171 - two; b = 85 + two; } else { r = third; g = 0; b = 255 - third; } }
	else if (!(h & 0x20)) { r = 85 + third; g = 0; b = 171 - third; } else { r = 170 + third; g = 0; b = 85 - third; }
	if (s !== 255) { if (!s) r = g = b = 255; else { const d = scale8v(255 - s, 255 - s), ss = 255 - d; r = scale8(r, ss) + d; g = scale8(g, ss) + d; b = scale8(b, ss) + d; } }
	if (v !== 255) { v = scale8v(v, v); if (!v) r = g = b = 0; else { r = scale8(r, v); g = scale8(g, v); b = scale8(b, v); } }
	return [r & 255, g & 255, b & 255];
}
class CHSV_ { constructor(h = 0, s = 0, v = 0) { this.h = this.hue = h & 255; this.s = this.sat = s & 255; this.v = this.val = v & 255; } }
class CRGB_ {
	constructor(r = 0, g, b) { if (r instanceof CRGB_) [r, g, b] = [r.r, r.g, r.b]; else if (r instanceof CHSV_) [r, g, b] = hsv2rgb(r.h, r.s, r.v); else if (g === undefined) [r, g, b] = [r >>> 16, r >> 8, r]; this.setRGB(r, g, b); }
	setRGB(r, g, b) { this.r = r & 255; this.g = g & 255; this.b = b & 255; return this; }
	setHSV(h, s, v) { return this.setRGB(...hsv2rgb(h, s, v)); } setHue(h) { return this.setHSV(h, 255, 255); } setColorCode(c) { return this.setRGB(c >> 16, c >> 8, c); }
	nscale8(s) { const o = s instanceof CRGB_ ? s : { r: s, g: s, b: s }; return this.setRGB(scale8(this.r, o.r), scale8(this.g, o.g), scale8(this.b, o.b)); }
	fadeToBlackBy(a) { return this.nscale8(255 - a); }
	add(o) { o = rgbOf(o); return this.setRGB(qadd8(this.r, o.r), qadd8(this.g, o.g), qadd8(this.b, o.b)); }
	equals(o) { o = rgbOf(o); return this.r === o.r && this.g === o.g && this.b === o.b; }
	valueOf() { return (this.r << 16) | (this.g << 8) | this.b; }
	get raw() { return [this.r, this.g, this.b]; }
	static array(n) { return Array.from({ length: n }, () => new CRGB_()); }
}
for (const [k, f] of [['red', 'r'], ['green', 'g'], ['blue', 'b']]) Object.defineProperty(CRGB_.prototype, k, { get() { return this[f]; }, set(v) { this[f] = v & 255; } });
const NAMED = { Black: 0, White: 0xffffff, Red: 0xff0000, Green: 0x008000, Lime: 0xff00, Blue: 0xff, Yellow: 0xffff00, Cyan: 0xffff, Aqua: 0xffff, Magenta: 0xff00ff, Orange: 0xffa500, Purple: 0x800080,
	Pink: 0xffc0cb, Gold: 0xffd700, Navy: 0x80, Teal: 0x8080, Maroon: 0x800000, Gray: 0x808080, Grey: 0x808080, Brown: 0xa52a2a, Violet: 0xee82ee, Indigo: 0x4b0082, SkyBlue: 0x87ceeb, DarkOrange: 0xff8c00 };
for (const k in NAMED) Object.defineProperty(CRGB_, k, { get: () => new CRGB_(NAMED[k]) });   // fresh objects
const CRGB = callable(CRGB_), CHSV = callable(CHSV_), rgbOf = x => (x instanceof CRGB_ ? x : x && typeof x === 'object' && 'r' in x ? new CRGB_(x.r, x.g, x.b) : new CRGB_(x || 0));
class FastLEDClass {
	constructor() { this.ctrls = []; this.bri = 255; }
	addLeds(type, ...a) {
		const k = a.findIndex(x => x && typeof x === 'object'), pre = k < 0 ? a : a.slice(0, k), [leds = [], n = 0, offset = 0] = k < 0 ? [] : a.slice(k), T = String(type).toUpperCase();
		const spi = /APA102|SK9822|DOTSTAR|HD107|LPD8806|WS2801|P9813/.test(T), ord = x => typeof x === 'string' && /^[RGB]{3}$/i.test(x), pins = pre.filter(x => !ord(x));
		for (let i = 0; i < n; i++) leds[offset + i] = rgbOf(leds[offset + i]);
		const c = { type: T, pin: pins[0], clk: spi ? pins[1] : undefined, order: (pre.find(ord) || (spi ? 'BGR' : /WS2811|APA106|PL9823/.test(T) && !/_400/.test(T) ? 'RGB' : 'GRB')).toUpperCase(), leds, n: n | 0, offset, corr: [255, 255, 255],
			setCorrection(x) { const q = rgbOf(x); this.corr = [q.r, q.g, q.b]; return this; }, setTemperature(x) { return this.setCorrection(x); }, setDither() { return this; }, size() { return this.n; } };
		this.ctrls.push(c); pm(c.pin, 1); return c;
	}
	show(bri = this.bri) {
		const h = hal();
		for (const c of this.ctrls) {
			const b = new Uint8Array(c.n * 3), ix = [...c.order].map(ch => 'RGB'.indexOf(ch));
			for (let i = 0; i < c.n; i++) { const p = rgbOf(c.leds[c.offset + i]).raw; ix.forEach((k, j) => (b[i * 3 + j] = scale8(scale8(p[k], c.corr[k]), bri))); }
			if (c.clk !== undefined) {   // start frame, 0xFF (full global brightness) + three colour bytes per LED, end frame
				const f = [0, 0, 0, 0]; for (let i = 0; i < c.n; i++) f.push(0xff, b[3 * i], b[3 * i + 1], b[3 * i + 2]); for (let i = 0; i < 4 + (c.n >> 4); i++) f.push(0xff);
				c.sink = c.sink || (h.apa102 ? h.apa102(c.pin, c.clk, c.n) : h.neopixel ? h.neopixel(c.pin, c.n, 'APA102') : { show() {} }); c.sink.show(Uint8Array.from(f));
			} else { c.sink = c.sink || (h.neopixel ? h.neopixel(c.pin, c.n, c.order) : { show() {} }); c.sink.show(b); }
		}
	}
	clear(write) { for (const c of this.ctrls) for (let i = 0; i < c.n; i++) c.leds[c.offset + i] = rgbOf(c.leds[c.offset + i]).setRGB(0, 0, 0); if (write) this.show(); }
	clearData() { this.clear(); }
	showColor(col, bri) { for (const c of this.ctrls) for (let i = 0; i < c.n; i++) c.leds[c.offset + i] = new CRGB_(rgbOf(col)); this.show(bri); }
	setBrightness(b) { this.bri = b & 255; } getBrightness() { return this.bri; }
	delay(ms) { this.show(); wait(ms); }
	setCorrection(x) { this.ctrls.forEach(c => c.setCorrection(x)); } setTemperature(x) { this.setCorrection(x); }
	setMaxPowerInVoltsAndMilliamps() {} setMaxPowerInMilliWatts() {} setMaxRefreshRate() {} setDither() {} countFPS() {}
	size() { return this.ctrls[0] ? this.ctrls[0].n : 0; } leds() { return this.ctrls[0] ? this.ctrls[0].leds : []; } count() { return this.ctrls.length; }
}
let rnd16 = 1337;
const random16 = (a, b) => { rnd16 = (rnd16 * 2053 + 13849) & 0xffff; return a === undefined ? rnd16 : b === undefined ? Math.floor((rnd16 * a) / 65536) : a + Math.floor((rnd16 * (b - a)) / 65536); };
const random8 = (a, b) => { const r = random16() >> 8; return a === undefined ? r : b === undefined ? (r * a) >> 8 : a + ((r * (b - a)) >> 8); };
const sin8 = t => Math.round(Math.sin(((t & 255) / 128) * Math.PI) * 127.5 + 127.5) & 255;
const beat16 = (bpm, tb = 0) => Math.floor(((millis() - tb) * (bpm < 256 ? bpm << 8 : bpm) * 280) / 65536) & 0xffff, beat8 = (bpm, tb) => beat16(bpm, tb) >> 8;
const PAL = { RainbowColors_p: [0xff0000, 0xd52a00, 0xab5500, 0xab7f00, 0xabab00, 0x56d500, 0x00ff00, 0x00d52a, 0x00ab55, 0x0056aa, 0x0000ff, 0x2a00d5, 0x5500ab, 0x7f0081, 0xab0055, 0xd5002b],
	PartyColors_p: [0x5500ab, 0x84007c, 0xb5004b, 0xe5001b, 0xe81700, 0xb84700, 0xab7700, 0xabab00, 0xab5500, 0xdd2200, 0xf2000e, 0xc2003e, 0x8f0071, 0x5f00a1, 0x2f00d0, 0x0007f9],
	HeatColors_p: [0, 0x330000, 0x660000, 0x990000, 0xcc0000, 0xff0000, 0xff3300, 0xff6600, 0xff9900, 0xffcc00, 0xffff00, 0xffff33, 0xffff66, 0xffff99, 0xffffcc, 0xffffff] };
class CRGBPalette16_ { constructor(...c) { const s = c.length === 1 && Array.isArray(c[0]) ? c[0] : c.length === 1 && c[0] instanceof CRGBPalette16_ ? c[0].e : c; this.e = range(0, 16).map(i => rgbOf(s[Math.floor((i * s.length) / 16)] ?? 0)); } }
function ColorFromPalette(pal, idx, bri = 255, blend = 1) {
	const e = (pal instanceof CRGBPalette16_ ? pal : new CRGBPalette16_(pal)).e, a = e[(idx >> 4) & 15].raw, b = e[((idx >> 4) + 1) & 15].raw, f2 = (idx & 15) << 4;
	return new CRGB_(...a.map((x, i) => (blend && f2 ? scale8(x, 255 - f2) + scale8(b[i], f2) : x)).map(v => (bri === 255 ? v : scale8v(v, bri))));
}
const blend = (a, b, amt) => { const p = rgbOf(a).raw, q = rgbOf(b).raw; return new CRGB_(...p.map((x, i) => scale8(x, 255 - amt) + scale8(q[i], amt))); };
Object.assign(L, PAL, { CRGB, CHSV, CRGBPalette16: callable(CRGBPalette16_), FastLED: new FastLEDClass(), FastLEDClass, ColorFromPalette, blend,
	hsv2rgb_rainbow: (hsv, out) => { const c = new CRGB_(hsv); if (out) out.setRGB(c.r, c.g, c.b); return c; },
	fill_solid: (leds, n, c) => { for (let i = 0; i < n; i++) leds[i] = new CRGB_(rgbOf(c)); },
	fill_rainbow: (leds, n, hue, dh = 5) => { for (let i = 0; i < n; i++) leds[i] = new CRGB_(new CHSV_(hue + i * dh, 240, 255)); },
	fill_gradient_RGB: (leds, a, b, c, d, e) => {
		if (typeof c === 'number' && d !== undefined && e === undefined) { for (let i = a; i <= c; i++) leds[i] = blend(b, d, Math.floor(((i - a) * 255) / Math.max(1, c - a))); return; }   // (start, colour, end, colour)
		const st = [b, c, d, e].filter(x => x !== undefined), seg = (a - 1) / (st.length - 1);   // (n, c1, c2[, c3[, c4]])
		for (let i = 0; i < a; i++) { const k = Math.min(st.length - 2, Math.floor(i / seg)); leds[i] = blend(st[k], st[k + 1], Math.round(((i - k * seg) / seg) * 255)); }
	},
	fill_palette: (leds, n, start, inc, pal, bri = 255) => { for (let i = 0; i < n; i++) leds[i] = ColorFromPalette(pal, (start + i * inc) & 255, bri); },
	fadeToBlackBy: (leds, n, a) => { for (let i = 0; i < n; i++) leds[i] = rgbOf(leds[i]).fadeToBlackBy(a); },
	nscale8: (leds, n, s) => { for (let i = 0; i < n; i++) leds[i] = rgbOf(leds[i]).nscale8(s); },
	nblend: (a, b, amt) => { const r = blend(a, b, amt); return a.setRGB(r.r, r.g, r.b); },
	scale8, scale8_video: scale8v, qadd8, qsub8, sin8, cos8: t => sin8(t + 64), random8, random16, random16_set_seed: s => { rnd16 = s & 0xffff; },
	map8: (v, a, b) => a + scale8(v, b - a), beat8, beat16, beatsin8: (bpm, lo = 0, hi = 255, tb = 0, ph = 0) => lo + scale8(sin8(beat8(bpm, tb) + ph), hi - lo),
	TypicalLEDStrip: 0xffb0f0, TypicalSMD5050: 0xffb0f0, UncorrectedColor: 0xffffff, LINEARBLEND: 1, NOBLEND: 0 });
for (const k of 'NEOPIXEL WS2812 WS2812B WS2811 WS2813 SK6812 APA102 SK9822 DOTSTAR APA106 GRB RGB BRG BGR RBG GBR'.split(' ')) L[k] = k;

// ==== Servo (pulse width → hal.servo(pin, µs), or hal.pwm(pin, duty, 50 Hz))
class Servo {
	constructor() { this.pin = null; this.min = 544; this.max = 2400; this.pulseUs = 1500; }
	attach(pin, min = 544, max = 2400) { Object.assign(this, { pin, min, max }); pm(pin, 1); if (!Servo.all.includes(this)) Servo.all.push(this); this.out(); return 0; }
	detach() { this.pin = null; Servo.all.splice(Servo.all.indexOf(this) >>> 0, 1); }
	attached() { return this.pin != null; }
	out() { const h = HAL; if (this.pin == null || !h) return; if (h.servo) h.servo(this.pin, this.pulseUs); else if (h.pwm) h.pwm(this.pin, this.pulseUs / 20000, 50); }
	write(v) { if (v < this.min) v = Math.round(this.min + ((this.max - this.min) * clamp(v, 0, 180)) / 180); this.writeMicroseconds(v); }   // < min: angle in degrees
	writeMicroseconds(us) { this.pulseUs = clamp(Math.round(us), this.min, this.max); this.out(); }
	readMicroseconds() { return this.pulseUs; }
	read() { return Math.trunc(((this.pulseUs + 1 - this.min) * 180) / (this.max - this.min)); }
}
Servo.all = [];
L.Servo = L.ESP32Servo = Servo;

// ==== Adafruit unified sensor types
const GRAV = 9.80665, DPS2RAD = 0.017453293, vec = () => ({ x: 0, y: 0, z: 0, roll: 0, pitch: 0, heading: 0, status: 0, v: [0, 0, 0] });
class sensors_event_t_ { constructor() { Object.assign(this, { version: 0, sensor_id: 0, type: 0, timestamp: 0, acceleration: vec(), gyro: vec(), magnetic: vec(), orientation: vec(), temperature: 0, relative_humidity: 0, pressure: 0, light: 0, current: 0, voltage: 0 }); } }
Object.assign(L, { sensors_event_t: callable(sensors_event_t_), sensor_t: callable(class sensor_t { constructor() { Object.assign(this, { name: '', version: 1, sensor_id: 0, type: 0, max_value: 0, min_value: 0, resolution: 0, min_delay: 0 }); } }),
	SENSORS_GRAVITY_STANDARD: GRAV, SENSORS_GRAVITY_EARTH: GRAV, SENSORS_DPS_TO_RADS: DPS2RAD, SENSORS_RADS_TO_DPS: 57.29577793, SENSORS_PRESSURE_SEALEVELHPA: 1013.25 });
const ev = e => (e && typeof e === 'object' ? e : new sensors_event_t_()), setXYZ = (o, v) => { [o.x, o.y, o.z] = v; o.v = v; };
const sub = fn => ({ getEvent(e) { e = ev(e); fn(e); e.timestamp = Math.floor(millis()); return true; }, getSensor(s) { return s; }, printSensorDetails() {} });   // bme.getTemperatureSensor()->getEvent(&e)

// ==== Bosch BME280 / BMP280 (Adafruit libraries: register sequence and integer compensation)
class Adafruit_BME280 {
	constructor(cs, mosi) { if (isSPI(mosi)) { this.cs = cs; this.spi = mosi; } else if (okPin(cs)) this.cs = cs; this.tfa = this.meas = this.hum = 0; }
	open(addr, w) { this.io = this.cs != null ? new SPIReg(this.cs, this.spi) : new I2C(addr, w); return this.cs != null || this.io.detect(); }
	begin(addr = 0x77, w) {
		if (!this.open(addr, w) || (this._sensorID = this.io.r8(0xd0)) !== 0x60) return false;
		this.io.w8(0xe0, 0xb6); wait(10); for (let i = 0; i < 100 && this.io.r8(0xf3) & 1; i++) wait(10);
		this.cal(); this.setSampling(); wait(100); return true;
	}
	u16(r) { const d = this.io.rN(r, 2); return d[0] | (d[1] << 8); }
	cal() {   // trimming parameters
		const r = x => this.io.r8(x), c = (this.c = { T1: this.u16(0x88), T2: s16(this.u16(0x8a)), T3: s16(this.u16(0x8c)), P1: this.u16(0x8e) });
		for (let i = 2; i <= 9; i++) c['P' + i] = s16(this.u16(0x8c + 2 * i));
		if (this.hasH !== false) Object.assign(c, { H1: r(0xa1), H2: s16(this.u16(0xe1)), H3: r(0xe3), H4: (s8(r(0xe4)) * 16) | (r(0xe5) & 15), H5: (s8(r(0xe6)) * 16) | (r(0xe5) >> 4), H6: s8(r(0xe7)) });
	}
	setSampling(mode = 3, t = 5, p = 5, h = 5, filter = 0, sb = 0) { this.meas = (t << 5) | (p << 2) | mode; this.hum = h; const w = (a, v) => this.io.w8(a, v); w(0xf4, 0); w(0xf2, h); w(0xf5, (sb << 5) | (filter << 2)); w(0xf4, this.meas); }
	takeForcedMeasurement() { if ((this.meas & 3) !== 1) return false; this.io.w8(0xf4, this.meas); const t0 = millis(); while (this.io.r8(0xf3) & 8) { if (millis() - t0 > 2000) return false; wait(1); } return true; }
	raw(r) { const d = this.io.rN(r, 3), v = (d[0] << 16) | (d[1] << 8) | d[2]; return v === 0x800000 ? NaN : v >> 4; }
	readTemperature() {
		const adc = this.raw(0xfa); if (!(this.meas >> 5) || Number.isNaN(adc)) return NaN;
		const c = this.c, T = Math.trunc, d = T(adc / 16) - c.T1; this.t_fine = T(((T(adc / 8) - c.T1 * 2) * c.T2) / 2048) + T((T((d * d) / 4096) * c.T3) / 16384) + this.tfa;
		return T((this.t_fine * 5 + 128) / 256) / 100;
	}
	readPressure() {   // 64-bit integer compensation (BigInt)
		if (!((this.meas >> 2) & 7)) return NaN; this.readTemperature(); const adc = this.raw(0xf7); if (Number.isNaN(adc)) return NaN;
		const c = this.c, B = BigInt; let v1 = B(this.t_fine) - 128000n; const v2 = v1 * v1 * B(c.P6) + v1 * B(c.P5) * 131072n + B(c.P4) * 34359738368n;
		v1 = (((v1 * v1 * B(c.P3)) / 256n + v1 * B(c.P2) * 4096n + 140737488355328n) * B(c.P1)) / 8589934592n;
		if (!v1) return 0;
		let p = (((1048576n - B(adc)) * 2147483648n - v2) * 3125n) / v1;
		p = (p + (B(c.P9) * (p / 8192n) * (p / 8192n)) / 33554432n + (B(c.P8) * p) / 524288n) / 256n + B(c.P7) * 16n;
		return Number(p) / 256;
	}
	readHumidity() {
		if (!this.hum) return NaN; this.readTemperature(); const d = this.io.rN(0xfd, 2), adc = (d[0] << 8) | d[1]; if (adc === 0x8000) return NaN;
		const c = this.c, T = Math.trunc, x = this.t_fine - 76800, a = T((adc * 16384 - c.H4 * 1048576 - c.H5 * x + 16384) / 32768);
		let v = a * T(((T((T((x * c.H6) / 1024) * (T((x * c.H3) / 2048) + 32768)) / 1024) + 2097152) * c.H2 + 8192) / 16384);
		v -= T((T((T(v / 32768) * T(v / 32768)) / 128) * c.H1) / 16);
		return T(clamp(v, 0, 419430400) / 4096) / 1024;
	}
	readAltitude(sea = 1013.25) { return 44330 * (1 - Math.pow(this.readPressure() / 100 / sea, 0.1903)); }
	seaLevelForAltitude(alt, p) { return p / Math.pow(1 - alt / 44330, 5.255); }
	sensorID() { return this._sensorID; }
	setTemperatureCompensation(adj) { this.tfa = Math.round((adj * 100 * 256 - 128) / 5); } getTemperatureCompensation() { return ((this.tfa * 5 + 128) >> 8) / 100; }
	getTemperatureSensor() { return sub(e => (e.temperature = this.readTemperature())); } getPressureSensor() { return sub(e => (e.pressure = this.readPressure() / 100)); } getHumiditySensor() { return sub(e => (e.relative_humidity = this.readHumidity())); }
}
class Adafruit_BMP280 extends Adafruit_BME280 {
	begin(addr = 0x77, chipid = 0x58, w) {
		if (isWire(chipid)) [w, chipid] = [chipid, 0x58];
		if (!this.open(addr, w) || (this._sensorID = this.io.r8(0xd0)) !== chipid) return false;
		this.hasH = false; this.cal(); this.setSampling(); wait(100); return true;
	}
	setSampling(mode = 3, t = 5, p = 5, filter = 0, sb = 0) { super.setSampling(mode, t, p, 0, filter, sb); }
	getStatus() { return this.io.r8(0xf3); }
}
const BK = { MODE_SLEEP: 0, MODE_FORCED: 1, MODE_NORMAL: 3 };
['NONE', 'X1', 'X2', 'X4', 'X8', 'X16'].forEach((k, i) => (BK['SAMPLING_' + k] = i)); ['OFF', 'X2', 'X4', 'X8', 'X16'].forEach((k, i) => (BK['FILTER_' + k] = i));
[['0_5', '1'], ['62_5', '63'], ['125'], ['250'], ['500'], ['1000'], ['10', '2000'], ['20', '4000']].forEach((ks, i) => ks.forEach(k => (BK['STANDBY_MS_' + k] = i)));
Object.assign(Adafruit_BME280, BK);
Object.assign(L, { Adafruit_BME280, Adafruit_BMP280, BME280_ADDRESS: 0x77, BME280_ADDRESS_ALTERNATE: 0x76, BMP280_ADDRESS: 0x77, BMP280_ADDRESS_ALT: 0x76, BMP280_CHIPID: 0x58 });

// ==== Sensirion / Aosong humidity sensors
const shtRead = i2c => { const d = i2c.read(6); return d && d[2] === crc8(d.slice(0, 2)) && d[5] === crc8(d.slice(3, 5)) ? [(d[0] << 8) | d[1], (d[3] << 8) | d[4]] : null; };   // two CRC-checked words
class Adafruit_SHT31 {
	constructor(w) { this.w = w; }
	begin(addr = 0x44) { this.i2c = new I2C(addr, this.w); if (!this.i2c.detect()) return false; this.reset(); return this.readStatus() !== 0xffff; }
	cmd(c) { return this.i2c.write([c >> 8, c & 255]); }
	reset() { this.cmd(0x30a2); wait(10); }
	readStatus() { this.cmd(0xf32d); const d = this.i2c.read(3); return d ? (d[0] << 8) | d[1] : 0xffff; }
	heater(on) { this.cmd(on ? 0x306d : 0x3066); wait(1); } isHeaterEnabled() { return !!(this.readStatus() & 0x2000); }
	readTempHum() { this.cmd(0x2400); wait(20); const d = shtRead(this.i2c); if (!d) { this.t = this.h = NaN; return false; } this.t = (((4375 * d[0]) >> 14) - 4500) / 100; this.h = ((625 * d[1]) >>> 12) / 100; return true; }
	readTemperature() { this.readTempHum(); return this.t; } readHumidity() { this.readTempHum(); return this.h; }
	readBoth(t, h) { const ok = this.readTempHum(); if (t && typeof t === 'object') t.value = this.t; if (h && typeof h === 'object') h.value = this.h; return ok; }
}
Object.assign(L, { Adafruit_SHT31, SHT4X_HIGH_PRECISION: 0, SHT4X_MED_PRECISION: 1, SHT4X_LOW_PRECISION: 2, SHT4X_NO_HEATER: 0, SHT4X_HIGH_HEATER_1S: 1, SHT4X_HIGH_HEATER_100MS: 2, SHT4X_MED_HEATER_1S: 3, SHT4X_MED_HEATER_100MS: 4, SHT4X_LOW_HEATER_1S: 5, SHT4X_LOW_HEATER_100MS: 6 });
L.Adafruit_SHT4x = class Adafruit_SHT4x {
	constructor() { this.prec = this.heat = 0; }
	begin(w) { this.i2c = new I2C(0x44, w); return this.i2c.detect() && this.reset(); }
	reset() { const ok = this.i2c.write([0x94]); wait(1); return ok; }
	readSerial() { this.i2c.write([0x89]); wait(10); const d = shtRead(this.i2c); return d ? ((d[0] << 16) | d[1]) >>> 0 : 0; }
	setPrecision(p) { this.prec = p; } getPrecision() { return this.prec; } setHeater(h) { this.heat = h; } getHeater() { return this.heat; }
	getEvent(hum, temp) {
		const [c, ms] = this.heat ? [[0x39, 1100], [0x32, 110], [0x2f, 1100], [0x24, 110], [0x1e, 1100], [0x15, 110]][this.heat - 1] : [[0xfd, 10], [0xf6, 5], [0xe0, 2]][this.prec];
		if (!this.i2c.write([c])) return false; wait(ms); const d = shtRead(this.i2c); if (!d) return false;
		this.t = -45 + (175 * d[0]) / 65535; this.h = clamp(-6 + (125 * d[1]) / 65535, 0, 100);
		if (temp) ev(temp).temperature = this.t; if (hum) ev(hum).relative_humidity = this.h; return true;
	}
	getTemperatureSensor() { return sub(e => this.getEvent(null, e)); } getHumiditySensor() { return sub(e => this.getEvent(e, null)); }
};
L.Adafruit_AHTX0 = class Adafruit_AHTX0 {
	begin(w, id = 0, addr = 0x38) {
		wait(20); this.i2c = new I2C(addr, w); if (!this.i2c.detect() || !this.i2c.write([0xba])) return false;
		wait(20); this.idle(); this.i2c.write([0xe1, 8, 0]); this.idle(); return !!(this.getStatus() & 8);   // calibrated
	}
	getStatus() { const d = this.i2c.read(1); return d ? d[0] : 0xff; }
	idle() { for (let i = 0; i < 100 && this.getStatus() & 0x80; i++) wait(10); }
	getEvent(hum, temp) {
		if (!this.i2c.write([0xac, 0x33, 0])) return false; this.idle(); const d = this.i2c.read(6); if (!d) return false;
		this.h = (((d[1] << 12) | (d[2] << 4) | (d[3] >> 4)) * 100) / 0x100000; this.t = ((((d[3] & 15) << 16) | (d[4] << 8) | d[5]) * 200) / 0x100000 - 50;
		if (hum) ev(hum).relative_humidity = this.h; if (temp) ev(temp).temperature = this.t; return true;
	}
	getTemperatureSensor() { return sub(e => this.getEvent(null, e)); } getHumiditySensor() { return sub(e => this.getEvent(e, null)); }
};

// ==== IMUs: Adafruit_MPU6050, Adafruit_LIS3DH
const consts = (pre, keys, post = '', f = i => i) => keys.forEach((k, i) => (L[pre + k + post] = f(i)));
consts('MPU6050_RANGE_', ['2_G', '4_G', '8_G', '16_G']); consts('MPU6050_RANGE_', [250, 500, 1000, 2000], '_DEG'); consts('MPU6050_BAND_', [260, 184, 94, 44, 21, 10, 5], '_HZ'); L.MPU6050_I2CADDR_DEFAULT = 0x68;
L.Adafruit_MPU6050 = class Adafruit_MPU6050 {
	begin(addr = 0x68, w) {
		const i2c = (this.i2c = new I2C(addr, w)); if (!i2c.detect() || i2c.r8(0x75) !== 0x68) return false;
		this.upd(0x6b, 1, 7, 1); for (let i = 0; i < 100 && i2c.r8(0x6b) & 0x80; i++) wait(1); wait(100); i2c.w8(0x68, 7); wait(100);   // device + signal path reset
		i2c.w8(0x19, 0); this.setFilterBandwidth(0); this.setGyroRange(1); this.setAccelerometerRange(0); i2c.w8(0x6b, 1); wait(100); return true;
	}
	upd(r, mask, sh, v) { const o = this.i2c.r8(r); this.i2c.w8(r, (o & ~(mask << sh)) | ((v & mask) << sh)); }
	setSampleRateDivisor(d) { this.i2c.w8(0x19, d); } setFilterBandwidth(b) { this.upd(0x1a, 7, 0, b); } getFilterBandwidth() { return this.i2c.r8(0x1a) & 7; }
	setGyroRange(r) { this.upd(0x1b, 3, 3, r); } getGyroRange() { return (this.i2c.r8(0x1b) >> 3) & 3; }
	setAccelerometerRange(r) { this.upd(0x1c, 3, 3, r); } getAccelerometerRange() { return (this.i2c.r8(0x1c) >> 3) & 3; }
	setHighPassFilter(b) { this.upd(0x1c, 7, 0, b); } enableSleep(e) { this.upd(0x6b, 1, 6, e ? 1 : 0); } setI2CBypass(b) { this.upd(0x37, 1, 1, b ? 1 : 0); }
	getEvent(a, g, t) {
		const d = this.i2c.rN(0x3b, 14), v = i => s16((d[i] << 8) | d[i + 1]), as = 16384 >> this.getAccelerometerRange(), gs = [131, 65.5, 32.8, 16.4][this.getGyroRange()], ts = Math.floor(millis());
		this.temperature = v(6) / 340 + 36.53;
		if (a) { a = ev(a); setXYZ(a.acceleration, [0, 2, 4].map(i => (v(i) / as) * GRAV)); a.timestamp = ts; a.type = 1; }
		if (g) { g = ev(g); setXYZ(g.gyro, [8, 10, 12].map(i => (v(i) / gs) * DPS2RAD)); g.timestamp = ts; g.type = 4; }
		if (t) { t = ev(t); t.temperature = this.temperature; t.timestamp = ts; t.type = 13; }
		return true;
	}
	getTemperatureSensor() { return sub(e => this.getEvent(null, null, e)); } getAccelerometerSensor() { return sub(e => this.getEvent(e)); } getGyroSensor() { return sub(e => this.getEvent(null, e)); }
};
consts('LIS3DH_RANGE_', ['2_G', '4_G', '8_G', '16_G']); consts('LIS3DH_DATARATE_', ['POWERDOWN', '1_HZ', '10_HZ', '25_HZ', '50_HZ', '100_HZ', '200_HZ', '400_HZ', 'LOWPOWER_1K6HZ', 'LOWPOWER_5KHZ']); L.LIS3DH_DEFAULT_ADDRESS = 0x18;
L.Adafruit_LIS3DH = class Adafruit_LIS3DH {
	constructor(a, b) { if (isWire(a)) this.w = a; else if (okPin(a)) { this.cs = a; if (isSPI(b)) this.spi = b; } }
	begin(addr = 0x18, wai = 0x33) {
		const io = (this.io = this.cs != null ? new SPIReg(this.cs, this.spi, 0xc0) : new I2C(addr, this.w));
		if ((this.cs == null && !io.detect()) || io.r8(0x0f) !== wai) return false;
		io.w8(0x20, 7); this.setDataRate(7); io.w8(0x23, 0x88); io.w8(0x22, 0x10); io.w8(0x1f, 0x80); return true;   // all axes, 400 Hz, BDU + HR, DRDY on INT1, ADCs on
	}
	setRange(r) { const o = this.io.r8(0x23); this.io.w8(0x23, (o & ~0x30) | ((r & 3) << 4)); } getRange() { return (this.io.r8(0x23) >> 4) & 3; }
	setDataRate(d) { const o = this.io.r8(0x20); this.io.w8(0x20, (o & 15) | ((d & 15) << 4)); } getDataRate() { return this.io.r8(0x20) >> 4; }
	read() { const d = this.io.rN(0x28 | 0x80, 6), div = [16380, 8190, 4096, 1365][this.getRange()]; [this.x, this.y, this.z] = [0, 2, 4].map(i => s16(d[i] | (d[i + 1] << 8))); [this.x_g, this.y_g, this.z_g] = [this.x / div, this.y / div, this.z / div]; }
	getEvent(e) { this.read(); e = ev(e); setXYZ(e.acceleration, [this.x_g, this.y_g, this.z_g].map(v => v * GRAV)); e.timestamp = Math.floor(millis()); e.type = 1; return true; }
	readADC(ch) { if (ch < 1 || ch > 3) return 0; const d = this.io.rN((6 + 2 * ch) | 0x80, 2); return s16(d[0] | (d[1] << 8)); }
};

// ==== power monitor, ADC, DAC: Adafruit_INA219, Adafruit_ADS1115 / ADS1015, Adafruit_MCP4725
L.Adafruit_INA219 = class Adafruit_INA219 {
	constructor(addr = 0x40) { this.addr = addr; }
	begin(w) { this.i2c = new I2C(this.addr, w); this.ok = this.i2c.detect(); this.setCalibration_32V_2A(); return this.ok; }
	success() { return this.ok; }
	cal(c, div, mul, cfg) { Object.assign(this, { c, div, mul }); this.i2c.w16(5, c); this.i2c.w16(0, cfg); }   // calibration register, current / power LSB divisors, config
	setCalibration_32V_2A() { this.cal(4096, 10, 2, 0x399f); } setCalibration_32V_1A() { this.cal(10240, 25, 0.8, 0x399f); } setCalibration_16V_400mA() { this.cal(8192, 20, 1, 0x019f); }
	powerSave(on) { const c = this.i2c.r16(0); this.i2c.w16(0, on ? c & ~7 : c | 7); }
	getBusVoltage_raw() { return s16((this.i2c.r16(2) >> 3) * 4); } getShuntVoltage_raw() { return s16(this.i2c.r16(1)); }
	getCurrent_raw() { this.i2c.w16(5, this.c); return s16(this.i2c.r16(4)); } getPower_raw() { this.i2c.w16(5, this.c); return s16(this.i2c.r16(3)); }
	getBusVoltage_V() { return this.getBusVoltage_raw() * 0.001; } getShuntVoltage_mV() { return this.getShuntVoltage_raw() * 0.01; }
	getCurrent_mA() { return this.getCurrent_raw() / this.div; } getPower_mW() { return this.getPower_raw() * this.mul; }
};
Object.assign(L, { GAIN_TWOTHIRDS: 0, GAIN_ONE: 0x200, GAIN_TWO: 0x400, GAIN_FOUR: 0x600, GAIN_EIGHT: 0x800, GAIN_SIXTEEN: 0xa00 });
consts('RATE_ADS1015_', [128, 250, 490, 920, 1600, 2400, 3300], 'SPS', i => i << 5); consts('RATE_ADS1115_', [8, 16, 32, 64, 128, 250, 475, 860], 'SPS', i => i << 5);
consts('ADS1X15_REG_CONFIG_MUX_', ['DIFF_0_1', 'DIFF_0_3', 'DIFF_1_3', 'DIFF_2_3', 'SINGLE_0', 'SINGLE_1', 'SINGLE_2', 'SINGLE_3'], '', i => i << 12);
class ADS1X15 {   // single-shot conversions, OS-bit polling
	constructor(shift) { this.shift = shift; this.gain = 0; this.rate = 0x80; }
	begin(addr = 0x48, w) { this.i2c = new I2C(addr, w); return this.i2c.detect(); }
	setGain(g) { this.gain = g; } getGain() { return this.gain; } setDataRate(r) { this.rate = r; } getDataRate() { return this.rate; }
	startADCReading(mux, cont) { this.i2c.w16(1, 0x8003 | (cont ? 0 : 0x100) | this.gain | this.rate | mux); this.i2c.w16(3, 0x8000); this.i2c.w16(2, 0); }
	conversionComplete() { return !!(this.i2c.r16(1) & 0x8000); }
	getLastConversionResults() { return s16(this.i2c.r16(0)) >> this.shift; }
	readADC_Differential(mux) { this.startADCReading(mux, false); for (let i = 0; i < 1000 && !this.conversionComplete(); i++); return this.getLastConversionResults(); }
	readADC_SingleEnded(ch) { return ch > 3 ? 0 : this.readADC_Differential(0x4000 + (ch << 12)); }
	readADC_Differential_0_1() { return this.readADC_Differential(0); } readADC_Differential_0_3() { return this.readADC_Differential(0x1000); } readADC_Differential_1_3() { return this.readADC_Differential(0x2000); } readADC_Differential_2_3() { return this.readADC_Differential(0x3000); }
	computeVolts(n) { return (n * ([6.144, 4.096, 2.048, 1.024, 0.512, 0.256][this.gain >> 9] || 6.144)) / (32768 >> this.shift); }
	startComparator_SingleEnded(ch, th) { this.i2c.w16(3, th << this.shift); this.i2c.w16(1, this.gain | this.rate | (0x4000 + (ch << 12))); }
}
L.Adafruit_ADS1115 = class Adafruit_ADS1115 extends ADS1X15 { constructor() { super(0); } }; L.Adafruit_ADS1015 = class Adafruit_ADS1015 extends ADS1X15 { constructor() { super(4); } };
L.Adafruit_MCP4725 = class Adafruit_MCP4725 { begin(addr = 0x62, w) { this.i2c = new I2C(addr, w); return this.i2c.detect(); } setVoltage(out, ee = false) { return this.i2c.write([ee ? 0x60 : 0x40, (out >> 4) & 255, (out & 15) << 4]); } };

// ==== IO expanders: Adafruit_MCP23X17 / MCP23X08 (I2C or SPI), Adafruit_PCF8574 / PCF8575
class MCP23X {
	constructor(n) { this.n = n; }
	begin_I2C(addr = 0x20, w) { this.io = new I2C(addr, w); return this.io.detect(); }
	begin_SPI(cs, spi, hw = 0) {   // opcode 0100 A2 A1 A0 R/W; a hardware address needs IOCON.HAEN
		const s = new SPIReg(cs, spi, 0), op = 0x40 | ((hw & 7) << 1);
		this.io = { r8: r => s.tx(b => { b.transfer(op | 1); b.transfer(r); return b.transfer(0); }), w8: (r, v) => s.tx(b => { b.transfer(op); b.transfer(r); b.transfer(v); }) };
		if (hw) this.io.w8(this.reg(5, 0), 8); return true;
	}
	reg(base, port) { return this.n === 16 ? (base << 1) | port : base; }   // IOCON.BANK = 0 addresses
	bit(base, pin, v) { const r = this.reg(base, pin >> 3), o = this.io.r8(r), m = 1 << (pin & 7); this.io.w8(r, v ? o | m : o & ~m); }
	pinMode(pin, mode) { this.bit(0, pin, mode !== 1); this.bit(6, pin, mode === 2); }
	digitalRead(pin) { return (this.io.r8(this.reg(9, pin >> 3)) >> (pin & 7)) & 1; }
	digitalWrite(pin, v) { const o = this.io.r8(this.reg(10, pin >> 3)), m = 1 << (pin & 7); this.io.w8(this.reg(9, pin >> 3), v ? o | m : o & ~m); }
	readGPIO(p = 0) { return this.io.r8(this.reg(9, p)); } readGPIOA() { return this.readGPIO(0); } readGPIOB() { return this.readGPIO(1); } readGPIOAB() { return this.readGPIO(0) | (this.readGPIO(1) << 8); }
	writeGPIO(v, p = 0) { this.io.w8(this.reg(9, p), v); } writeGPIOA(v) { this.writeGPIO(v, 0); } writeGPIOB(v) { this.writeGPIO(v, 1); } writeGPIOAB(v) { this.writeGPIO(v & 255, 0); this.writeGPIO(v >> 8, 1); }
	setupInterrupts(mirror, od, pol) { const r = this.reg(5, 0), o = this.io.r8(r); this.io.w8(r, (o & ~0x46) | (mirror ? 0x40 : 0) | (od ? 4 : 0) | (pol ? 2 : 0)); }
	setupInterruptPin(pin, mode = 3) { if (mode === 3) this.bit(4, pin, 0); else { this.bit(4, pin, 1); this.bit(3, pin, mode === 1 ? 0 : 1); } this.bit(2, pin, 1); }
	disableInterruptPin(pin) { this.bit(2, pin, 0); }
	getLastInterruptPin() { for (let p = 0; p < this.n / 8; p++) { const f = this.io.r8(this.reg(7, p)); for (let i = 0; i < 8; i++) if (f & (1 << i)) return p * 8 + i; } return 255; }
	getCapturedInterrupt() { return this.io.r8(this.reg(8, 0)) | (this.n === 16 ? this.io.r8(this.reg(8, 1)) << 8 : 0); }
	clearInterrupts() { this.getCapturedInterrupt(); }
}
L.Adafruit_MCP23X17 = class Adafruit_MCP23X17 extends MCP23X { constructor() { super(16); } }; L.Adafruit_MCP23X08 = class Adafruit_MCP23X08 extends MCP23X { constructor() { super(8); } };
class Adafruit_PCF8574 {
	constructor(n = 8) { this.n = n; this.buf = (1 << n) - 1; }
	begin(addr = 0x20, w) { this.i2c = new I2C(addr, w); return this.i2c.detect(); }
	flush() { return this.i2c.write(this.n === 8 ? [this.buf] : [this.buf & 255, this.buf >> 8]); }
	digitalWriteByte(v) { this.buf = v; return this.flush(); } digitalWriteWord(v) { this.buf = v; return this.flush(); }
	digitalReadByte() { const d = this.i2c.read(1); return d ? d[0] : 0; } digitalReadWord() { const d = this.i2c.read(2); return d ? d[0] | (d[1] << 8) : 0; }
	digitalWrite(p, v) { this.buf = v ? this.buf | (1 << p) : this.buf & ~(1 << p); return this.flush(); }
	digitalRead(p) { return ((this.n === 8 ? this.digitalReadByte() : this.digitalReadWord()) >> p) & 1; }
	pinMode(p, m) { if (m !== 1) this.buf |= 1 << p; return this.flush(); }   // inputs are weak highs
}
L.Adafruit_PCF8574 = Adafruit_PCF8574; L.Adafruit_PCF8575 = class Adafruit_PCF8575 extends Adafruit_PCF8574 { constructor() { super(16); } };

// ==== RTClib: DateTime, TimeSpan, RTC_DS3231, RTC_DS1307, RTC_PCF8563, RTC_Millis
const MONTHS = 'JanFebMarAprMayJunJulAugSepOctNovDec', DAYS = 'SunMonTueWedThuFriSat';
class DateTime_ {
	constructor(a, m, d, hh = 0, mm = 0, ss = 0) {
		if (a instanceof DateTime_) this.t = a.t;
		else if (a === undefined) this.t = 946684800;
		else if (typeof a === 'string' && typeof m === 'string') { const [H, M, S] = m.split(':').map(Number); this.t = Date.UTC(+a.slice(7), MONTHS.indexOf(a.slice(0, 3)) / 3, +a.slice(4, 6), H, M, S) / 1000; }   // __DATE__, __TIME__
		else if (typeof a === 'string') { const x = /(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)/.exec(a); this.t = x ? Date.UTC(x[1], x[2] - 1, x[3], x[4], x[5], x[6]) / 1000 : NaN; }
		else if (m === undefined) this.t = a >>> 0;
		else { this.t = Date.UTC(a < 100 ? a + 2000 : a, m - 1, d, hh, mm, ss) / 1000; this.valid = m >= 1 && m <= 12 && d >= 1 && d <= 31 && hh < 24 && mm < 60 && ss < 60; }
	}
	f() { return tfields(this.t); }
	year() { return this.f().year; } month() { return this.f().mon; } day() { return this.f().day; } hour() { return this.f().h; } minute() { return this.f().m; } second() { return this.f().s; }
	twelveHour() { return this.hour() % 12 || 12; } isPM() { return this.hour() >= 12; }
	dayOfTheWeek() { return this.f().dow; } unixtime() { return this.t >>> 0; } secondstime() { return this.t - 946684800; }
	isValid() { return this.valid !== false && Number.isFinite(this.t); }
	timestamp(opt = 0) { return [this.toString('YYYY-MM-DDThh:mm:ss'), this.toString('hh:mm:ss'), this.toString('YYYY-MM-DD')][opt]; }
	toString(buf) {   // RTClib format letters; a char buffer is filled in place
		const f = this.f(), p = n => String(n).padStart(2, '0'), fmt = typeof buf === 'string' ? buf : buf && typeof buf === 'object' ? fmtNum(buf) : 'YYYY-MM-DD hh:mm:ss';
		const s = fmt.replace(/YYYY|YY|MMM|MM|DDD|DD|hh|mm|ss|AP|ap/g, k => ({ YYYY: f.year, YY: p(f.year % 100), MMM: MONTHS.substr((f.mon - 1) * 3, 3), MM: p(f.mon), DDD: DAYS.substr(f.dow * 3, 3), DD: p(f.day), hh: p(f.h), mm: p(f.m), ss: p(f.s), AP: f.h >= 12 ? 'PM' : 'AM', ap: f.h >= 12 ? 'pm' : 'am' })[k]);
		if (buf && typeof buf === 'object') for (let i = 0; i < buf.length; i++) buf[i] = i < s.length ? s.charCodeAt(i) : 0;
		return s;
	}
	add(ts) { return new DateTime_(this.t + +ts); }
	sub(x) { return x instanceof DateTime_ ? new TimeSpan_(this.t - x.t) : new DateTime_(this.t - +x); }
	lt(o) { return this.t < o.t; } gt(o) { return this.t > o.t; } eq(o) { return this.t === o.t; } equals(o) { return this.t === o.t; }
	valueOf() { return this.t; }
}
class TimeSpan_ {
	constructor(a = 0, h, m, s) { this.s = h === undefined ? +a : a * 86400 + h * 3600 + m * 60 + s; }
	days() { return Math.trunc(this.s / 86400); } hours() { return Math.trunc(this.s / 3600) % 24; } minutes() { return Math.trunc(this.s / 60) % 60; } seconds() { return this.s % 60; } totalseconds() { return this.s; }
	add(o) { return new TimeSpan_(this.s + o.s); } sub(o) { return new TimeSpan_(this.s - o.s); } valueOf() { return this.s; }
}
const bcdTime = d => [bcd(d.second()), bcd(d.minute()), bcd(d.hour())], ymd = (b, s, mi, h, dd, mo, y) => new DateTime_(unbcd(b[y]) + 2000, unbcd(b[mo] & 0x1f), unbcd(b[dd] & 0x3f), unbcd(b[h] & 0x3f), unbcd(b[mi] & 0x7f), unbcd(b[s] & 0x7f));
class RTCBase {
	begin(w) { this.i2c = new I2C(this.addr, isWire(w) ? w : undefined); return this.i2c.detect(); }
	rr(r) { return this.i2c.r8(r); } wr(r, v) { this.i2c.w8(r, v); }
}
class RTC_DS3231 extends RTCBase {
	constructor() { super(); this.addr = 0x68; }
	now() { return ymd(this.i2c.rN(0, 7), 0, 1, 2, 4, 5, 6); }
	adjust(dt) { const d = new DateTime_(dt); this.i2c.write([0, ...bcdTime(d), bcd(d.dayOfTheWeek() || 7), bcd(d.day()), bcd(d.month()), bcd(d.year() - 2000)]); this.wr(0x0f, this.rr(0x0f) & ~0x80); }
	lostPower() { return this.rr(0x0f) >> 7; }
	getTemperature() { const b = this.i2c.rN(0x11, 2); return s8(b[0]) + (b[1] >> 6) * 0.25; }
	readSqwPinMode() { return this.rr(0x0e) & 0x1c; } writeSqwPinMode(m) { this.wr(0x0e, (this.rr(0x0e) & ~0x5c) | m); }
	setAlarm(n, dt, mode) {   // mode bits = mask bits A1M1..A1M4 (A2M2..A2M4), 0x10 (0x08) = day of week
		const ctrl = this.rr(0x0e); if (!(ctrl & 4)) return false;
		const d = new DateTime_(dt), dy = n === 1 ? (mode & 0x10) << 2 : (mode & 8) << 3, t = n === 1 ? [bcd(d.second())] : [], k = n === 1 ? 0 : 1;
		t.push(bcd(d.minute()), bcd(d.hour()), bcd(dy ? d.dayOfTheWeek() || 7 : d.day()) | dy);
		this.i2c.write([n === 1 ? 7 : 0x0b, ...t.map((v, i) => v | (((mode >> i) & 1) << 7))]); this.wr(0x0e, ctrl | n); return true;
	}
	setAlarm1(dt, mode) { return this.setAlarm(1, dt, mode); } setAlarm2(dt, mode) { return this.setAlarm(2, dt, mode); }
	disableAlarm(n) { this.wr(0x0e, this.rr(0x0e) & ~n); } clearAlarm(n) { this.wr(0x0f, this.rr(0x0f) & ~n); } alarmFired(n) { return (this.rr(0x0f) >> (n - 1)) & 1; }
}
class RTC_DS1307 extends RTCBase {
	constructor() { super(); this.addr = 0x68; }
	isrunning() { return !(this.rr(0) >> 7); }
	now() { return ymd(this.i2c.rN(0, 7), 0, 1, 2, 4, 5, 6); }
	adjust(dt) { const d = new DateTime_(dt); this.i2c.write([0, ...bcdTime(d), 0, bcd(d.day()), bcd(d.month()), bcd(d.year() - 2000)]); }
	readSqwPinMode() { return this.rr(7) & 0x93; } writeSqwPinMode(m) { this.wr(7, m); }
	readnvram(buf, n, a) { if (typeof buf === 'number') return this.rr(8 + buf); const d = this.i2c.rN(8 + a, n); for (let i = 0; i < n; i++) buf[i] = d[i]; }
	writenvram(a, buf, n) { if (typeof buf === 'number') this.wr(8 + a, buf); else this.i2c.write([8 + a, ...Array.from(buf).slice(0, n)]); }
}
class RTC_PCF8563 extends RTCBase {
	constructor() { super(); this.addr = 0x51; }
	lostPower() { return this.rr(2) >> 7; }
	adjust(dt) { const d = new DateTime_(dt); this.i2c.write([2, ...bcdTime(d), bcd(d.day()), 0, bcd(d.month()), bcd(d.year() - 2000)]); }
	now() { return ymd(this.i2c.rN(2, 7), 0, 1, 2, 3, 5, 6); }
	start() { const c = this.rr(0); if (c & 0x20) this.wr(0, c & ~0x20); } stop() { const c = this.rr(0); if (!(c & 0x20)) this.wr(0, c | 0x20); } isrunning() { return !((this.rr(0) >> 5) & 1); }
	readSqwPinMode() { return this.rr(0x0d) & 0x83; } writeSqwPinMode(m) { this.wr(0x0d, m); }
}
class RTC_Millis { begin(dt) { this.adjust(dt || new DateTime_(D.RTC_BASE)); return true; } adjust(dt) { this.off = new DateTime_(dt).t - Math.floor(millis() / 1000); } now() { return new DateTime_(this.off + Math.floor(millis() / 1000)); } }
Object.assign(L, { DateTime: callable(DateTime_), TimeSpan: callable(TimeSpan_), RTC_DS3231, RTC_DS1307, RTC_PCF8563, RTC_Millis, RTC_Micros: RTC_Millis, TIMESTAMP_FULL: 0, TIMESTAMP_TIME: 1, TIMESTAMP_DATE: 2,
	DS3231_OFF: 0x1c, DS3231_SquareWave1Hz: 0, DS3231_SquareWave1kHz: 8, DS3231_SquareWave4kHz: 0x10, DS3231_SquareWave8kHz: 0x18, DS1307_OFF: 0, DS1307_ON: 0x80, DS1307_SquareWave1HZ: 0x10, DS1307_SquareWave4kHz: 0x11, DS1307_SquareWave8kHz: 0x12, DS1307_SquareWave32kHz: 0x13,
	DS3231_A1_PerSecond: 0x0f, DS3231_A1_Second: 0x0e, DS3231_A1_Minute: 0x0c, DS3231_A1_Hour: 8, DS3231_A1_Date: 0, DS3231_A1_Day: 0x10, DS3231_A2_PerMinute: 7, DS3231_A2_Minute: 6, DS3231_A2_Hour: 4, DS3231_A2_Date: 0, DS3231_A2_Day: 8,
	PCF8563_SquareWaveOFF: 0, PCF8563_SquareWave1Hz: 0x83, PCF8563_SquareWave32Hz: 0x82, PCF8563_SquareWave1kHz: 0x81, PCF8563_SquareWave32kHz: 0x80 });

// ==== fuel gauge and light sensors: Adafruit_MAX17048, BH1750 (claws), Adafruit_VEML7700
L.Adafruit_MAX17048 = class Adafruit_MAX17048 {
	begin(w) { this.i2c = new I2C(0x36, w); if (!this.i2c.detect() || !this.isDeviceReady() || !this.reset()) return false; this.enableSleep(false); this.sleep(false); return true; }
	r16(r) { return this.i2c.r16(r); } w16(r, v) { return this.i2c.w16(r, v); } m16(r, set, bits) { const v = this.r16(r); this.w16(r, set ? v | bits : v & ~bits); }
	getICversion() { return this.r16(8); } getChipID() { return this.r16(0x18) & 255; } isDeviceReady() { return (this.getICversion() & 0xfff0) === 0x10; }
	reset() { if (this.w16(0xfe, 0x5400)) return false; for (let i = 0; i < 3; i++) if (this.clearAlertFlag(1)) return true; return false; }   // the chip does not acknowledge the reset command
	clearAlertFlag(f) { return this.w16(0x1a, this.r16(0x1a) & ~(f << 8)); } getAlertStatus() { return (this.r16(0x1a) >> 8) & 0x7f; }
	cellVoltage() { return this.isDeviceReady() ? (this.r16(2) * 78.125) / 1e6 : NaN; } cellPercent() { return this.isDeviceReady() ? this.r16(4) / 256 : NaN; } chargeRate() { return s16(this.r16(0x16)) * 0.208; }
	quickStart() { this.m16(6, 1, 0x4000); } enableSleep(on) { this.m16(6, on, 0x2000); } sleep(on) { this.m16(0x0c, on, 0x80); } hibernate() { this.w16(0x0a, 0xffff); } wake() { this.w16(0x0a, 0); }
};
class BH1750 {
	constructor(addr = 0x23) { this.addr = addr; this.mode = 0; this.mt = 69; this.last = 0; }
	begin(mode = 0x10, addr = 0, w) { if (addr) this.addr = addr; this.i2c = new I2C(this.addr, w); return this.configure(mode); }
	configure(mode) { if (![0x10, 0x11, 0x13, 0x20, 0x21, 0x23].includes(mode)) return false; const ok = this.i2c.write([mode]); wait(10); if (ok) this.mode = mode; this.last = millis(); return ok; }
	setMTreg(mt) { if (mt < 31 || mt > 254) return false; this.i2c.write([0x40 | (mt >> 5)]); this.i2c.write([0x60 | (mt & 31)]); this.i2c.write([this.mode]); wait(10); this.mt = mt; return true; }
	measurementReady(block = false) { const d = (((this.mode & 3) === 3 ? 24 : 180) * this.mt) / 69, left = d - (millis() - this.last); if (block && left > 0) wait(left); return block || left <= 0; }
	readLightLevel() {
		if (!this.mode) return -2; const d = this.i2c.read(2); this.last = millis(); if (!d) return -1;
		return (((d[0] << 8) | d[1]) * (69 / this.mt)) / ((this.mode & 3) === 1 ? 2 : 1) / 1.2;
	}
}
Object.assign(BH1750, { UNCONFIGURED: 0, CONTINUOUS_HIGH_RES_MODE: 0x10, CONTINUOUS_HIGH_RES_MODE_2: 0x11, CONTINUOUS_LOW_RES_MODE: 0x13, ONE_TIME_HIGH_RES_MODE: 0x20, ONE_TIME_HIGH_RES_MODE_2: 0x21, ONE_TIME_LOW_RES_MODE: 0x23 });
L.BH1750 = BH1750;
Object.assign(L, { VEML7700_GAIN_1: 0, VEML7700_GAIN_2: 1, VEML7700_GAIN_1_8: 2, VEML7700_GAIN_1_4: 3, VEML7700_IT_100MS: 0, VEML7700_IT_200MS: 1, VEML7700_IT_400MS: 2, VEML7700_IT_800MS: 3, VEML7700_IT_50MS: 8, VEML7700_IT_25MS: 12 });
consts('VEML_LUX_', ['NORMAL', 'CORRECTED', 'AUTO', 'NORMAL_NOWAIT', 'CORRECTED_NOWAIT']); consts('VEML7700_POWERSAVE_MODE', [1, 2, 3, 4]);
L.Adafruit_VEML7700 = class Adafruit_VEML7700 {
	begin(w) { this.i2c = new I2C(0x10, w); if (!this.i2c.detect()) return false; this.enable(false); this.interruptEnable(false); this.setPersistence(0); this.setGain(2); this.setIntegrationTime(0); this.powerSaveEnable(false); this.enable(true); this.last = millis(); return true; }
	cfg() { return this.i2c.r16(0, true); } setBits(n, sh, v, r = 0) { const c = this.i2c.r16(r, true), m = ((1 << n) - 1) << sh; this.i2c.w16(r, (c & ~m) | ((v << sh) & m), true); }   // LSB-first registers
	enable(on) { this.setBits(1, 0, on ? 0 : 1); } enabled() { return !(this.cfg() & 1); } interruptEnable(on) { this.setBits(1, 1, on ? 1 : 0); } setPersistence(p) { this.setBits(2, 4, p); }
	setIntegrationTime(it, wt = true) { this.setBits(4, 6, it); if (wt) wait(this.getIntegrationTimeValue() * 2); this.last = millis(); } getIntegrationTime() { return (this.cfg() >> 6) & 15; }
	setGain(g) { this.setBits(2, 11, g); this.last = millis(); } getGain() { return (this.cfg() >> 11) & 3; }
	getIntegrationTimeValue() { return { 12: 25, 8: 50, 0: 100, 1: 200, 2: 400, 3: 800 }[this.getIntegrationTime()] || -1; } getGainValue() { return [1, 2, 0.125, 0.25][this.getGain()]; }
	powerSaveEnable(on) { this.setBits(1, 0, on ? 1 : 0, 3); } setPowerSaveMode(m) { this.setBits(2, 1, m, 3); }
	getResolution() { return 0.0036 * (800 / this.getIntegrationTimeValue()) * (2 / this.getGainValue()); }
	readALS(w = false) { if (w) { const left = 2 * this.getIntegrationTimeValue() - (millis() - this.last); if (left > 0) wait(left); } this.last = millis(); return this.i2c.r16(4, true); }
	readWhite(w = false) { if (w) this.readALS(true); return this.i2c.r16(5, true); }
	computeLux(raw, corr = false) { const lux = this.getResolution() * raw; return corr ? (((6.0135e-13 * lux - 9.3924e-9) * lux + 8.1488e-5) * lux + 1.0023) * lux : lux; }
	readLux(method = 0) { return method === 2 ? this.autoLux() : this.computeLux(this.readALS(method < 2), method === 1 || method === 4); }
	autoLux() {   // the library's gain / integration-time search
		const gains = [2, 3, 0, 1], its = [12, 8, 0, 1, 2, 3]; let gi = 0, ii = 2, corr = false;
		this.setGain(gains[gi]); this.setIntegrationTime(its[ii]); let raw = this.readALS(true);
		if (raw <= 100) { while (raw <= 100 && !(gi === 3 && ii === 5)) { if (gi < 3) this.setGain(gains[++gi]); else this.setIntegrationTime(its[++ii]); raw = this.readALS(true); } }
		else { corr = true; while (raw > 10000 && ii > 0) { this.setIntegrationTime(its[--ii]); raw = this.readALS(true); } }
		return this.computeLux(raw, corr);
	}
};

// ==== memories: Adafruit_EEPROM_I2C (ack polling), SPIMemory SPIFlash (JEDEC flash commands)
L.Adafruit_EEPROM_I2C = class Adafruit_EEPROM_I2C {
	begin(addr = 0x50, w) { this.i2c = new I2C(addr, w); return this.i2c.detect(); }
	write(a, v, n) {
		if (v && typeof v === 'object') { for (let i = 0; i < (n ?? v.length); i++) if (!this.write(a + i, v[i])) return false; return true; }
		if (!this.i2c.write([(a >> 8) & 255, a & 255, v & 255])) return false;
		for (let t = 0; t < 100; t++) { if (this.i2c.detect()) return true; wait(1); }
		return false;
	}
	read(a, buf, n) {
		const d = this.i2c.wr([(a >> 8) & 255, a & 255], buf && typeof buf === 'object' ? n : 1);
		if (!(buf && typeof buf === 'object')) return d ? d[0] : 0;
		if (d) for (let i = 0; i < n; i++) buf[i] = d[i]; return !!d;
	}
};
class FlashIO {
	constructor(cs, spi) { this.cs = okPin(cs) ? cs : 10; this.spi = spi; }
	init() { pm(this.cs, 1); dw(this.cs, 1); return this.id(); }
	cmd(out, n = 0) { const s = SPIB(this.spi); s.beginTransaction(new L.SPISettings(8e6, 1, 0)); dw(this.cs, 0); for (const b of out) s.transfer(b); const r = []; for (let i = 0; i < n; i++) r.push(s.transfer(0)); dw(this.cs, 1); s.endTransaction(); return r; }
	busy() { return this.cmd([5], 1)[0] & 1; }
	idle(ms) { for (let i = 0; i < 2000 && this.busy(); i++) wait(ms / 20); }
	ad(a) { return this.cap > 16777216 ? [a >>> 24, (a >> 16) & 255, (a >> 8) & 255, a & 255] : [(a >> 16) & 255, (a >> 8) & 255, a & 255]; }
	read(a, n) { return this.cmd([this.cap > 16777216 ? 0x13 : 3, ...this.ad(a)], n); }
	program(a, bytes) { for (let i = 0; i < bytes.length; ) { const k = Math.min(256 - ((a + i) & 255), bytes.length - i); this.cmd([6]); this.cmd([this.cap > 16777216 ? 0x12 : 2, ...this.ad(a + i), ...bytes.slice(i, i + k)]); this.idle(1); i += k; } }
	erase(c, a, ms) { this.cmd([6]); this.cmd(a == null ? [c] : [c, ...this.ad(a)]); this.idle(ms); }
	id() { const d = this.cmd([0x9f], 3); this.cap = d[0] === 0x1f ? 2 ** (d[1] & 0x1f) * 32768 : d[2] >= 0x10 && d[2] <= 0x22 ? (d[2] === 0x20 ? 64 * 1048576 : 2 ** d[2]) : 0; return d; }
}
class SPIFlash {   // SPIMemory; multi-byte values little-endian, strings with a 16-bit length
	constructor(cs = 10, spi) { this.io = new FlashIO(cs, isSPI(spi) ? spi : undefined); this.err = 0; }
	begin(size = 0) { this.io.init(); this.io.cmd([0xab, 0, 0, 0], 1); const d = this.io.id(); if (!d[0] || d[0] === 0xff) { this.err = 4; return false; } if (size) this.io.cap = size; return true; }
	getJEDECID() { const d = this.io.id(); return ((d[0] << 16) | (d[1] << 8) | d[2]) >>> 0; }
	getCapacity() { return this.io.cap; } getMaxPage() { return this.io.cap / 256; } error() { return this.err; } functionRunTime() { return 0; }
	getUniqueID() { return this.io.cmd([0x4b, 0, 0, 0, 0], 8).reduce((v, b) => (v << 8n) | BigInt(b), 0n); }
	readBytes(a, n) { return this.io.read(a, n); }
	num(a, n, get) { return new DataView(Uint8Array.from(this.io.read(a, n)).buffer)[get](0, true); }
	readByte(a) { return this.num(a, 1, 'getUint8'); } readChar(a) { return this.num(a, 1, 'getInt8'); } readWord(a) { return this.num(a, 2, 'getUint16'); } readShort(a) { return this.num(a, 2, 'getInt16'); }
	readULong(a) { return this.num(a, 4, 'getUint32'); } readLong(a) { return this.num(a, 4, 'getInt32'); } readFloat(a) { return this.num(a, 4, 'getFloat32'); }
	readByteArray(a, buf, n) { this.io.read(a, n).forEach((b, i) => (buf[i] = b)); return true; } readCharArray(a, buf, n) { return this.readByteArray(a, buf, n); }
	readStr(a, out) { const s = String.fromCharCode(...this.io.read(a + 2, this.readWord(a))); if (out && typeof out === 'object') out.value = s; return s; }
	writeBytes(a, bytes, check = true) {   // refuses to write over non-erased bytes, verifies afterwards
		if (check && this.io.read(a, bytes.length).some(b => b !== 0xff)) { this.err = 0x0f; return false; }
		this.io.program(a, bytes); if (check && this.io.read(a, bytes.length).some((b, i) => b !== bytes[i])) { this.err = 0x0a; return false; } return true;
	}
	wnum(a, v, n, set, c) { const b = new Uint8Array(n); new DataView(b.buffer)[set](0, v, true); return this.writeBytes(a, [...b], c); }
	writeByte(a, v, c) { return this.writeBytes(a, [v & 255], c); } writeChar(a, v, c) { return this.writeByte(a, v, c); } writeWord(a, v, c) { return this.wnum(a, v, 2, 'setUint16', c); } writeShort(a, v, c) { return this.wnum(a, v, 2, 'setInt16', c); }
	writeULong(a, v, c) { return this.wnum(a, v, 4, 'setUint32', c); } writeLong(a, v, c) { return this.wnum(a, v, 4, 'setInt32', c); } writeFloat(a, v, c) { return this.wnum(a, v, 4, 'setFloat32', c); }
	writeByteArray(a, buf, n, c) { return this.writeBytes(a, Array.from(buf).slice(0, n ?? buf.length).map(b => b & 255), c); } writeCharArray(a, buf, n, c) { return this.writeByteArray(a, buf, n, c); }
	writeStr(a, s, c) { const b = toBytes(s); return this.writeBytes(a, [b.length & 255, b.length >> 8, ...b], c); }
	eraseSector(a) { this.io.erase(0x20, a, 60); return true; } eraseBlock32K(a) { this.io.erase(0x52, a, 200); return true; } eraseBlock64K(a) { this.io.erase(0xd8, a, 300); return true; }
	eraseChip() { this.io.erase(0xc7, null, 5000); return true; }
}
L.SPIFlash = SPIFlash;

if (typeof module !== 'undefined' && module.exports) module.exports = D;
})(typeof window !== 'undefined' ? window : globalThis);

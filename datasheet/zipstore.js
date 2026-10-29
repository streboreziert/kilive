/* minimal ZIP writer (stored, no compression) - enough for a handful of small text files */
(function (root) {
"use strict";
let TABLE = null;
function crc32(bytes) {
  if (!TABLE) { TABLE = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); TABLE[n] = c >>> 0; } }
  let crc = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(files, folder) {
  const enc = new TextEncoder(); const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const chunks = [], central = []; let offset = 0;
  for (const name of Object.keys(files)) {
    const nameBytes = enc.encode((folder ? folder + "/" : "") + name); const data = typeof files[name] === "string" ? enc.encode(files[name]) : files[name]; const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30)); local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    const cen = new DataView(new ArrayBuffer(46)); cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, nameBytes.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes); offset += 30 + nameBytes.length + data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0); const end = new DataView(new ArrayBuffer(22)); const count = Object.keys(files).length;
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true); end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  const all = chunks.concat(central, [new Uint8Array(end.buffer)]); const total = all.reduce((s, c) => s + c.length, 0); const out = new Uint8Array(total); let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}
root.DS2K_ZIP = { makeZip, crc32 };
if (typeof module !== "undefined" && module.exports) module.exports = root.DS2K_ZIP;
})(typeof window !== "undefined" ? window : globalThis);

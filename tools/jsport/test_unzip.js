'use strict';
const fs = require('fs');
const path = require('path');
require('/home/claude/noeti/app/js/kicad-import.js');
const K = globalThis.Noeti.kicad;
const rdir = '/home/claude/boards/glasgow';
const folder = 'hardware/boards/glasgow/revC3';
(async () => {
  // direct
  const direct = {};
  for (const f of fs.readdirSync(path.join(rdir, folder))) if (/\.kicad_(pcb|sch|pro)$/.test(f)) direct[folder + '/' + f] = new Uint8Array(fs.readFileSync(path.join(rdir, folder, f)));
  const dp = K.findProjects(Object.keys(direct))[0];
  const ref = await K.importProject(direct, dp);
  const refJson = JSON.stringify(['pcb', 'sch', 'bom', 'checks', 'power', 'stats', 'kicad'].map((k) => ref[k]));
  let ok = true;
  for (const z of ['revC3_stored.zip', 'revC3_deflated.zip', 'revC3_zip64.zip', 'revC3_zip64b.zip']) {
    const buf = fs.readFileSync(path.join(__dirname, 'zips', z));
    const t0 = Date.now();
    const files = await K.unzip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const tUnzip = Date.now() - t0;
    const keys = Object.keys(files);
    const sizes = keys.map((k) => [k, files[k].length]);
    const projs = K.findProjects(sizes);
    const p = projs[0];
    const res = await K.importProject(files, p);
    const same = JSON.stringify(['pcb', 'sch', 'bom', 'checks', 'power', 'stats', 'kicad'].map((k) => res[k])) === refJson;
    // byte-exact against disk
    let bytesOk = true;
    for (const k of keys) {
      const rel = k.replace(/^.*?revC3\//, '');
      const disk = fs.readFileSync(path.join(rdir, folder, rel));
      if (Buffer.compare(disk, Buffer.from(files[k])) !== 0) bytesOk = false;
    }
    console.log(`${z}: ${keys.length} entries in ${tUnzip} ms, project ${JSON.stringify(p)}; bytes identical: ${bytesOk}; import equals direct: ${same}; files listed ${res.files.length}`);
    ok = ok && same && bytesOk;
  }
  // filter option + error handling
  const buf = fs.readFileSync(path.join(__dirname, 'zips', 'revC3_deflated.zip'));
  const only = await K.unzip(new Uint8Array(buf), { filter: (n) => n.endsWith('.kicad_pro') });
  console.log('filter keeps', Object.keys(only));
  try { await K.unzip(new Uint8Array([1, 2, 3, 4])); ok = false; } catch (e) { console.log('garbage ->', e.message); }
  console.log('decodeText BOM strip:', JSON.stringify(K.decodeText(new Uint8Array([0xEF, 0xBB, 0xBF, 0x28, 0x61, 0x29]))));
  console.log(ok ? 'UNZIP OK' : 'UNZIP FAIL');
})();

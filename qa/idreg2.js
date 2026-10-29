global.window=global; global.self=global; window.Noeti={}; require('/home/claude/noeti/app/js/devices.js'); const D=Noeti.devices;
const T = { bme680:[0xd0,0x61], bme688:[0xd0,0x61], bno055:[0x00,0xa0], mpu9250:[0x75,0x71], icm20948:[0x00,0xea], icm42670:[0x75,0x67], lsm6dsox:[0x0f,0x6c], lsm6ds3:[0x0f,0x69], bmi270:[0x00,0x24], emc2101:[0xfd,0x16], es8311:[0xfd,0x83], tmp102:[0,0], lm75:[0,0], emc2301:[0xfd,0x37], rv3028:[0x28, 0x30], tusb320:[0x00,0x30], husb238:[0,0], ap33772:[0,0], max17043:[0x08,0], ina233:[0x99,0], es8156:[0xfd,0x81], wm8731:[0,0], ltc2943:[0,0], pn7150:[0,0] };
for (const [id, v] of Object.entries(T)) {
  const spec = (D.specs||D.templates).find(s=>s.id===id); if (!spec) { console.log(id, 'no spec'); continue; }
  const addr = (spec.addresses||[])[0];
  let dev; try { dev = spec.create({ now:()=>0, world:D.WORLD, rand:Math.random }, addr); } catch(e) { console.log(id,'create err',e.message); continue; }
  if (!dev || !dev.i2cStart) { console.log(id, 'no i2c'); continue; }
  dev.i2cStart(false, addr); dev.i2cWrite(v[0]); dev.i2cStop && dev.i2cStop(); dev.i2cStart(true, addr);
  const r = [dev.i2cRead(true), dev.i2cRead(false)]; dev.i2cStop && dev.i2cStop();
  console.log(id.padEnd(10), 'addr', addr && addr.toString(16), 'reg', v[0].toString(16), 'got', r.map(x=>x.toString(16)).join(' '), r[0]===v[1]?'OK':'');
}

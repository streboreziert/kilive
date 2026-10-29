global.window=global; global.self=global; window.Noeti={}; require('/home/claude/noeti/app/js/devices.js'); const D=Noeti.devices;
const T = { bme680:[0xd0,0x61], bno055:[0x00,0xa0], bme280:[0xd0,0x60], bmp280:[0xd0,0x58], bmp388:[0x00,0x50], bmp390:[0x00,0x60], mpu6050:[0x75,0x68], mpu9250:[0x75,0x71], icm20948:[0x00,0xea], icm42688:[0x75,0x47], lis3dh:[0x0f,0x33], lis2dh12:[0x0f,0x33], lsm6ds3:[0x0f,0x69], lsm6dso:[0x0f,0x6c], lsm6dsl:[0x0f,0x6a], lis3mdl:[0x0f,0x3d], lis2mdl:[0x4f,0x40], bmi160:[0x00,0xd1], bmi270:[0x00,0x24], bma400:[0x00,0x90], adxl345:[0x00,0xe5], mma8452:[0x0d,0x2a], qmc5883l:[0x0d,0xff], hmc5883l:[0x0a,0x48], ccs811:[0x20,0x81], veml6075:[0x0c,0x26], tmp117:[0x0f,0x0117], ina226:[0xff,0x2260], ina260:[0xfe,0x5449], max30102:[0xff,0x15], sgp30:null, apds9960:[0x92,0xab], vl53l0x:[0xc0,0xee], lps22hb:[0x0f,0xb1], lps22hh:[0x0f,0xb3], hts221:[0x0f,0xbc], bq27441:null, fusb302:[0x01,0x80], drv2605:[0x00,0xe0], pca9685:null, tca9548a:null, mcp9808:[0x07,0x0400], si7021:null, tsl2591:[0xb2,0x50], ltr390:[0x06,0xb2], as7341:[0x92,0x24], kx132:[0x13,0x3d], stc3115:null, ens160:null };
const ids = D.specs ? D.specs.map(s=>s.id) : (D.templates||[]).map(t=>t.id);
console.log('specs:', ids.length);
for (const [id, v] of Object.entries(T)) {
  if (!v) continue;
  const spec = (D.specs||D.templates).find(s=>s.id===id); if (!spec) { console.log(id, 'no spec'); continue; }
  const addr = (spec.addresses||[])[0];
  let dev; try { dev = spec.create({ now:()=>0, world:D.WORLD, rand:Math.random }, addr); } catch(e) { console.log(id,'create err',e.message); continue; }
  if (!dev || !dev.i2cStart) { console.log(id, 'no i2c'); continue; }
  const wide = v[1] > 255;
  dev.i2cStart(false, addr); dev.i2cWrite(v[0]); dev.i2cStop && dev.i2cStop(); dev.i2cStart(true, addr);
  let r = dev.i2cRead(true); if (wide) r = (r<<8) | dev.i2cRead(false); dev.i2cStop && dev.i2cStop();
  console.log(id.padEnd(10), 'reg', v[0].toString(16), 'got', r.toString(16), r===v[1]?'OK':'EXPECT '+v[1].toString(16));
}

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(size, r, g, b) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type);
    const crcBuf = Buffer.concat([t, data]);
    let crc = 0xFFFFFFFF;
    for (const byte of crcBuf) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    crc = (~crc) >>> 0;
    const crcOut = Buffer.alloc(4); crcOut.writeUInt32BE(crc);
    return Buffer.concat([len, t, data, crcOut]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Build raw scanlines (filter byte 0 + RGB pixels)
  const row = Buffer.alloc(1 + size * 3);
  row[0] = 0;
  for (let x = 0; x < size; x++) {
    const base = 1 + x * 3;
    // Draw a rounded feel: solid color with slight center gradient effect skipped — just solid
    row[base] = r; row[base+1] = g; row[base+2] = b;
  }
  const raw = Buffer.concat(Array.from({length: size}, () => row));
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const dir = path.join(__dirname, 'public', 'icons');
fs.mkdirSync(dir, { recursive: true });

// Purple: #534AB7 = 83, 74, 183
fs.writeFileSync(path.join(dir, 'icon-192.png'), createPNG(192, 83, 74, 183));
fs.writeFileSync(path.join(dir, 'icon-512.png'), createPNG(512, 83, 74, 183));

console.log('Icons generated in public/icons/');

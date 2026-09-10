'use strict';
// Export committed artwork into platform icon containers; no application build.
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const assets = path.join(__dirname, '..', 'assets');
const branding = path.join(assets, 'branding');

async function png(input, size) {
  return sharp(input).resize(size, size).png().toBuffer();
}

async function ico(input, sizes) {
  const frames = await Promise.all(sizes.map(size => png(input, size)));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16, size = sizes[index];
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  return Buffer.concat([header, ...frames]);
}

async function icns(input) {
  const formats = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
    ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
  const chunks = await Promise.all(Object.entries(formats).map(async ([type, size]) => {
    const data = await png(input, size), header = Buffer.alloc(8);
    header.write(type); header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  }));
  const header = Buffer.alloc(8);
  header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

async function main() {
  const art = await png(path.join(branding, 'angelina-master.png'), 944);
  const tile = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#fff8f0' } })
    .composite([{ input: art, left: 40, top: 40 }]).png().toBuffer();
  const mask = Buffer.from('<svg width="1024" height="1024"><rect width="1024" height="1024" rx="192" fill="white"/></svg>');
  const icon = await sharp(tile).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const tray = await fs.readFile(path.join(branding, 'tray.svg'));
  const template = await fs.readFile(path.join(branding, 'tray-template.svg'));
  const files = {
    'icon.png': icon,
    'icon.ico': await ico(icon, [16, 20, 24, 32, 40, 48, 64, 128, 256]),
    'icon.icns': await icns(icon),
    'tray.png': await png(tray, 64),
    'tray.ico': await ico(tray, [16, 20, 24, 32, 40, 48, 64]),
    'trayTemplate.png': await png(template, 18),
    'trayTemplate@2x.png': await png(template, 36)
  };
  for (const [name, buffer] of Object.entries(files)) {
    await fs.writeFile(path.join(assets, name), buffer);
    console.log(`${name}: ${buffer.length} bytes`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

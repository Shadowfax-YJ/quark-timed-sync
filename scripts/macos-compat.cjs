'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// Inspect the binaries themselves; Info.plist alone does not establish the
// deployment target of embedded command-line tools and frameworks.
async function verifyMacOS12(directory) {
  let checked = 0;
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) continue;
      const handle = await fs.open(file, 'r');
      try {
        const header = Buffer.alloc(32);
        const { bytesRead } = await handle.read(header, 0, 32, 0);
        if (bytesRead < 32 || header.readUInt32LE(0) !== 0xfeedfacf) continue;
        if (header.readUInt32LE(4) !== 0x0100000c) throw new Error(`Not an Apple Silicon executable: ${file}`);
        const length = header.readUInt32LE(20);
        if (length > 1024 * 1024) throw new Error(`Invalid Mach-O header: ${file}`);
        const commands = Buffer.alloc(length);
        await handle.read(commands, 0, length, 32);
        let minimum;
        for (let offset = 0; offset + 8 <= commands.length;) {
          const command = commands.readUInt32LE(offset), size = commands.readUInt32LE(offset + 4);
          if (size < 8 || offset + size > commands.length) throw new Error(`Invalid Mach-O command: ${file}`);
          if (command === 0x32) minimum = commands.readUInt32LE(offset + 12);
          if (command === 0x24) minimum = commands.readUInt32LE(offset + 8);
          offset += size;
        }
        if (minimum === undefined || minimum > (12 << 16)) throw new Error(`Binary requires macOS newer than 12: ${file}`);
        checked++;
      } finally { await handle.close(); }
    }
  }
  await walk(directory);
  if (checked < 4) throw new Error('Expected bundled app, Electron, OpenList and rclone Mach-O executables');
  console.log(`Verified ${checked} Apple Silicon binaries with deployment targets no newer than macOS 12`);
}
module.exports = { verifyMacOS12 };

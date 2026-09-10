'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const CPUS = { x64: 0x01000007, arm64: 0x0100000c };

// Inspect every Mach-O slice, including deployment targets in the embedded tools.
async function verifyMacOS12(directory, arch = process.arch) {
  const expected = arch === 'universal' ? Object.values(CPUS) : [CPUS[arch]];
  if (expected.some(x => !x)) throw new Error('Unsupported Mac architecture: ' + arch);
  let checked = 0;
  async function inspect(handle, file, size) {
    async function read(offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > size) throw new Error('Invalid Mach-O bounds: ' + file);
      const buffer = Buffer.alloc(length), result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead !== length) throw new Error('Truncated Mach-O: ' + file);
      return buffer;
    }
    if (size < 32) return;
    const header = await read(0, 32), magic = header.readUInt32BE(0);
    let slices;
    if (header.readUInt32LE(0) === 0xfeedfacf) slices = [{ offset: 0, size, cpu: header.readUInt32LE(4) }];
    else if ([0xcafebabe, 0xcafebabf].includes(magic)) {
      const count = header.readUInt32BE(4), wide = magic === 0xcafebabf, stride = wide ? 32 : 20;
      if (count < 1 || count > 8) throw new Error('Invalid Mach-O slice count: ' + file);
      const table = await read(8, count * stride); slices = [];
      for (let i = 0; i < count; i++) {
        const at = i * stride;
        slices.push({ cpu: table.readUInt32BE(at), offset: wide ? Number(table.readBigUInt64BE(at + 8)) : table.readUInt32BE(at + 8),
          size: wide ? Number(table.readBigUInt64BE(at + 16)) : table.readUInt32BE(at + 12) });
      }
      const sorted = [...slices].sort((a, b) => a.offset - b.offset); let end = 8 + count * stride;
      for (const slice of sorted) {
        if (!Number.isSafeInteger(slice.offset) || !Number.isSafeInteger(slice.size) || slice.size < 32 || slice.offset < end || slice.offset + slice.size > size) throw new Error('Invalid Mach-O slice bounds: ' + file);
        end = slice.offset + slice.size;
      }
    } else return;
    if (slices.length !== expected.length || expected.some(cpu => slices.filter(x => x.cpu === cpu).length !== 1)) throw new Error(`Not a ${arch} executable: ${file}`);
    for (const slice of slices) {
      const part = await read(slice.offset, 32);
      if (part.readUInt32LE(0) !== 0xfeedfacf || part.readUInt32LE(4) !== slice.cpu) throw new Error('Invalid Mach-O slice header: ' + file);
      const length = part.readUInt32LE(20), commandCount = part.readUInt32LE(16);
      if (length > 1024 * 1024 || length + 32 > slice.size) throw new Error('Invalid Mach-O header: ' + file);
      const commands = await read(slice.offset + 32, length); let minimum, offset = 0;
      for (let i = 0; i < commandCount; i++) {
        if (offset + 8 > length) throw new Error('Invalid Mach-O command: ' + file);
        const command = commands.readUInt32LE(offset), commandSize = commands.readUInt32LE(offset + 4);
        if (commandSize < 8 || offset + commandSize > length) throw new Error('Invalid Mach-O command: ' + file);
        if (command === 0x32 || command === 0x24) {
          if (commandSize < (command === 0x32 ? 24 : 16)) throw new Error('Invalid Mach-O version: ' + file);
          minimum = Math.max(minimum || 0, commands.readUInt32LE(offset + (command === 0x32 ? 12 : 8)));
        }
        offset += commandSize;
      }
      if (offset !== length) throw new Error('Invalid Mach-O command length: ' + file);
      if (minimum === undefined || minimum > (12 << 16)) throw new Error(`Binary requires macOS newer than 12: ${file}`);
    }
    checked++;
  }
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const handle = await fs.open(file, 'r');
        try { await inspect(handle, file, (await handle.stat()).size); } finally { await handle.close(); }
      }
    }
  }
  await walk(directory);
  if (checked < 4) throw new Error('Expected bundled app, Electron, OpenList and rclone Mach-O executables');
  console.log(`Verified ${checked} ${arch} binaries with deployment targets no newer than macOS 12`);
}
module.exports = { verifyMacOS12 };

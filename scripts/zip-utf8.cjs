'use strict';
const fs = require('node:fs/promises');
// ditto writes UTF-8 bytes without always setting ZIP's language flag. Declare
// the actual encoding so standard readers (including the updater) retain names.
// Older Windows .NET ZIP writers also need their backslash separators normalized.
async function markUtf8(file) {
  const bytes = await fs.readFile(file), utf8 = new TextDecoder('utf-8', { fatal: true });
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557)) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
    end--;
  }
  if (end < Math.max(0, bytes.length - 65557)) throw new Error('ZIP end record not found');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt32LE(end + 4) !== 0 || count === 0xffff || cursor + size !== end) throw new Error('Unsupported ZIP layout');
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize), local = bytes.readUInt32LE(cursor + 42);
    utf8.decode(name); utf8.decode(bytes.subarray(cursor + 46 + nameSize + extraSize, cursor + 46 + nameSize + extraSize + commentSize));
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 26) !== nameSize || !bytes.subarray(local + 30, local + 30 + nameSize).equals(name)) throw new Error('ZIP local filename mismatch');
    for (let j = 0; j < nameSize; j++) {
      if (name[j] === 0x5c) { name[j] = 0x2f; bytes[local + 30 + j] = 0x2f; }
    }
    bytes.writeUInt16LE(bytes.readUInt16LE(cursor + 8) | 0x800, cursor + 8);
    bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | 0x800, local + 6);
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  if (cursor !== end) throw new Error('ZIP directory length mismatch');
  await fs.writeFile(file, bytes);
}
module.exports = { markUtf8 };

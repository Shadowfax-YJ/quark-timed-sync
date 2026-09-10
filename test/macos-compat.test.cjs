'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { verifyMacOS12 } = require('../scripts/macos-compat.cjs');
test('Mac compatibility verification accepts the selected CPU and rejects newer OS requirements', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quark-macho-test-'));
  t.after(async () => {
    assert(path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('quark-macho-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function binaries(cpu, minimum) {
    const data = Buffer.alloc(56); data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(cpu, 4);
    data.writeUInt32LE(1, 16); data.writeUInt32LE(24, 20); data.writeUInt32LE(0x32, 32); data.writeUInt32LE(24, 36); data.writeUInt32LE(minimum << 16, 44);
    for (let i = 0; i < 4; i++) await fs.writeFile(path.join(root, 'binary-' + i), data);
  }
  await binaries(0x01000007, 12); await verifyMacOS12(root, 'x64');
  await assert.rejects(() => verifyMacOS12(root, 'arm64'), /Not an? arm64/);
  await binaries(0x0100000c, 12); await verifyMacOS12(root, 'arm64');
  await binaries(0x01000007, 13); await assert.rejects(() => verifyMacOS12(root, 'x64'), /newer than 12/);
});
test('Universal verification checks both slices and rejects missing CPUs, new OS targets and malformed fat headers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quark-macho-test-'));
  t.after(async () => { assert(path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('quark-macho-test-')); await fs.rm(root, { recursive: true, force: true }); });
  function fat(minimum = 12) {
    const data = Buffer.alloc(176); data.writeUInt32BE(0xcafebabe); data.writeUInt32BE(2, 4);
    for (const [i, cpu] of [0x01000007, 0x0100000c].entries()) {
      const table = 8 + 20 * i, offset = 64 + 56 * i;
      data.writeUInt32BE(cpu, table); data.writeUInt32BE(offset, table + 8); data.writeUInt32BE(56, table + 12);
      data.writeUInt32LE(0xfeedfacf, offset); data.writeUInt32LE(cpu, offset + 4); data.writeUInt32LE(1, offset + 16); data.writeUInt32LE(24, offset + 20);
      data.writeUInt32LE(0x32, offset + 32); data.writeUInt32LE(24, offset + 36); data.writeUInt32LE((i ? minimum : 12) << 16, offset + 44);
    }
    return data;
  }
  async function write(data) { for (let i = 0; i < 4; i++) await fs.writeFile(path.join(root, 'binary-' + i), data); }
  await write(fat()); await verifyMacOS12(root, 'universal');
  await write(fat(13)); await assert.rejects(() => verifyMacOS12(root, 'universal'), /newer than 12/);
  const missing = fat(); missing.writeUInt32BE(1, 4); await write(missing); await assert.rejects(() => verifyMacOS12(root, 'universal'), /Not a universal/);
  const malformed = fat(); malformed.writeUInt32BE(9999, 16); await write(malformed); await assert.rejects(() => verifyMacOS12(root, 'universal'), /bounds/);
});

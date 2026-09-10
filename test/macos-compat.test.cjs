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

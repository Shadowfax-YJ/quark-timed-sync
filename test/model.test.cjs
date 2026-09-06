'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { safeName, prepareFiles, reconcileShare, copyArgs } = require('../src/model.cjs');
const { parseShare, Quark } = require('../src/quark.cjs');
async function temp(t) { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'archive-unit-'))); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const folder = (fid, name) => ({ fid, file_name: name, file: false });
const file = (fid, name, size = 12) => ({ fid, file_name: name, file: true, size, share_fid_token: 'token-' + fid });

test('share parsing accepts full Chinese share message and embedded passcode', () => {
  assert.deepEqual(parseShare('给你分享： https://pan.quark.cn/s/ab123 提取码：X9aB'), { id: 'ab123', url: 'https://pan.quark.cn/s/ab123', passcode: 'X9aB' });
  assert.equal(parseShare('https://pan.quark.cn/s/ab123?pwd=abcd', 'zzzz').passcode, 'zzzz');
  assert.throws(() => parseShare('https://evil.example/s/ab123'));
  assert.throws(() => parseShare('https://pan.quark.cn.evil.example/s/ab123'));
});
test('cross-platform filenames reject traversal, separators and Windows collisions', () => {
  for (const name of ['..', '../escape', 'C:\\file', 'a\nb', 'NUL.zip', 'COM1', 'x.', 'a/b']) assert.throws(() => safeName(name));
  assert.equal(safeName('新的资料 2026.zip'), '新的资料 2026.zip');
});
test('append plan skips even changed existing files and finds deep new content', async t => {
  const dir = await temp(t); await fs.mkdir(path.join(dir, 'old'));
  await fs.writeFile(path.join(dir, 'old', 'present.zip'), 'local content');
  const before = await fs.stat(path.join(dir, 'old', 'present.zip'));
  const tree = { root: [folder('old', 'old')], old: [file('1', 'present.zip', 999), file('2', 'new.zip', 42), folder('newdir', 'newdir')], newdir: [file('3', 'data.zip', 56)] };
  const result = await prepareFiles({ list: async fid => tree[fid] }, 'root', dir);
  assert.deepEqual(result.files, ['old/new.zip', 'old/newdir/data.zip']); assert.equal(result.skipped, 1); assert.equal(result.totalBytes, 98);
  assert.equal(await fs.readFile(path.join(dir, 'old', 'present.zip'), 'utf8'), 'local content');
  assert.equal((await fs.stat(path.join(dir, 'old', 'present.zip'))).mtimeMs, before.mtimeMs);
});
test('append plan refuses source case collision and local symlink escape', async t => {
  const dir = await temp(t);
  await assert.rejects(() => prepareFiles({ list: async () => [file('1', 'data.zip'), file('2', 'DATA.zip')] }, 'root', dir), /重名/);
  const outside = await temp(t); await fs.symlink(outside, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => prepareFiles({ list: async () => [folder('f', 'link')] }, 'root', dir), /符号链接/);
});
test('share reconciliation revisits old subfolders, skips existing files and saves only missing', async () => {
  const writes = [];
  const src = { root: [folder('src-old', 'old'), file('src-new', 'new.zip')], 'src-old': [file('existing', 'same.zip', 999), file('inside-new', 'inside.zip')] };
  const dst = { target: [folder('dst-old', 'old')], 'dst-old': [file('dst-existing', 'same.zip', 1)] };
  const client = { list: async (fid, _signal, share) => (share ? src : dst)[fid], saveFiles: async (_share, items, target) => writes.push({ items: items.map(x => x.file_name), target }) };
  await reconcileShare(client, { id: 'share' }, 'root', 'target');
  assert.deepEqual(writes, [{ items: ['inside.zip'], target: 'dst-old' }, { items: ['new.zip'], target: 'target' }]);
});
test('failed share transfer does not continue submitting remaining batches', async () => {
  let calls = 0;
  const client = { list: async (_fid, _signal, share) => share ? Array.from({ length: 60 }, (_, i) => file('id' + i, i + '.zip')) : [], saveFiles: async () => { calls++; throw new Error('quota'); } };
  await assert.rejects(() => reconcileShare(client, { id: 's' }, 'root', 'target'), /quota/); assert.equal(calls, 1);
});
test('cancelled scan cannot produce a successful plan', async t => {
  const dir = await temp(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(() => prepareFiles({ list: async () => [] }, 'root', dir, controller.signal), { name: 'AbortError' });
});
test('copy command never enables overwrites, deletes, source moves or backups', () => {
  const args = copyArgs('remote:', '/local', '/manifest');
  assert.equal(args[0], 'copy'); assert(args.includes('--ignore-existing')); assert(args.includes('--files-from-raw'));
  assert(!args.some(x => ['sync', 'move', '--delete-before', '--delete-after', '--backup-dir', '--inplace', '--ignore-times'].includes(x)));
});
test('API pagination retrieves all entries and rejects duplicate pages', async () => {
  const client = new Quark(); let page = 0;
  client.request = async () => ({ data: { list: [file(String(++page), page + '.zip')] }, metadata: { _total: 2 } });
  assert.equal((await client.list('root')).length, 2);
  client.request = async () => ({ data: { list: [file('same', 'same.zip')] }, metadata: { _total: 2 } });
  await assert.rejects(() => client.list('root'), /正在变化/);
});

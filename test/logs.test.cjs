'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LogStore, sanitize } = require('../src/logs.cjs');
async function temporary(t, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quark-logs-test-'));
  const logs = await new LogStore(path.join(root, 'logs'), options).init();
  t.after(async () => { await logs.close(); assert(path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('quark-logs-test-')); await fs.rm(root, { recursive: true, force: true }); });
  return { logs, root };
}
test('persistent structured logs filter by level, source, subscription, search and dates with stable pagination', async t => {
  let now = Date.now() - 5000; const { logs } = await temporary(t, { clock: () => now });
  await logs.write('debug', 'service', 'hidden debug');
  const first = new Date(now).toISOString();
  for (let i = 0; i < 5; i++) { await logs.write(i % 2 ? 'warn' : 'info', 'download', '完成 ' + i, { jobId: 'archive', jobName: '测试订阅', details: { file: `目录/${i}.zip` } }); now += 1000; }
  await logs.write('error', 'account', '登录失败');
  const result = await logs.query({ limit: 2 }); assert.equal(result.total, 6); assert.equal(result.entries.length, 2); assert.equal(result.entries[0].message, '登录失败');
  assert.equal((await logs.query({ level: 'warn', source: 'download', jobId: 'archive' })).total, 2);
  assert.equal((await logs.query({ query: '目录/3.zip' })).entries[0].message, '完成 3');
  assert.equal((await logs.query({ from: first, to: first })).total, 1);
  const page = await logs.query({ offset: 2, limit: 2 }); assert.equal(page.entries[0].message, '完成 3');
  const reopened = await new LogStore(logs.directory).init(); assert.equal((await reopened.query()).total, 6); await reopened.close();
});
test('concurrent writes remain valid, exports include every filtered row, and clearing preserves settings and unrelated files', async t => {
  const { logs, root } = await temporary(t);
  await logs.configure({ level: 'debug', days: 7, maxMB: 2 });
  await Promise.all(Array.from({ length: 110 }, (_, i) => logs.write('info', 'app', '记录 ' + i)));
  await logs.write('debug', 'service', 'debug recorded');
  assert.equal((await logs.query()).total, 111);
  const file = path.join(root, 'export.jsonl');
  assert.equal((await logs.export(file, { level: 'info', limit: 1, offset: 10 })).count, 110);
  assert.equal((await fs.readFile(file, 'utf8')).trim().split('\n').length, 110);
  await logs.export(path.join(root, 'export.txt'), { level: 'debug' }, 'text');
  assert.match(await fs.readFile(path.join(root, 'export.txt'), 'utf8'), /\[DEBUG\].*debug recorded/);
  await fs.writeFile(path.join(logs.directory, 'keep.txt'), 'keep');
  await logs.clear(); assert.equal((await logs.query()).total, 0); assert.equal(await fs.readFile(path.join(logs.directory, 'keep.txt'), 'utf8'), 'keep');
  const reopened = await new LogStore(logs.directory).init(); assert.deepEqual(reopened.settings, { level: 'debug', days: 7, maxMB: 2 }); await reopened.close();
});
test('rotation enforces disk and age retention, and interrupted lines do not prevent reading other records', async t => {
  let now = Date.now(); const { logs } = await temporary(t, { clock: () => now, chunkBytes: 250000 });
  await logs.configure({ level: 'info', days: 1, maxMB: 1 });
  for (let i = 0; i < 240; i++) await logs.write('info', 'app', String(i) + 'x'.repeat(6000));
  const result = await logs.query(); assert(result.bytes <= 1024 ** 2); assert(result.total < 240 && result.total > 0); assert((await logs.files()).length > 1);
  await fs.appendFile(logs.active, '{"broken":'); assert.equal((await logs.query()).malformed, 1);
  now += 3 * 86400000; await logs.write('info', 'app', '新的一天');
  assert.equal((await logs.query()).total, 1);
});
test('logging redacts credentials and signed URLs recursively, including exceptions', async t => {
  const { logs } = await temporary(t);
  await logs.write('error', 'account', 'Cookie: __pus=secret-one; __puus=secret-two', { details: { token: 'secret-three', nested: { password: 'secret-four' },
    error: new Error('failed https://user:secret-five@example.org/file?sign=secret-six#secret-seven'), note: 'token=secret-eight; 提取码：secret-nine' } });
  const serialized = JSON.stringify(await logs.query()); assert(!serialized.includes('secret-')); assert(serialized.includes('https://example.org/file'));
  assert.equal(sanitize({ authorization: 'Bearer x' }).authorization, '[已隐藏]');
});
test('invalid filters and settings fail clearly; an unavailable log directory cannot fail a download', async t => {
  const { logs, root } = await temporary(t);
  assert.throws(() => logs.query({ from: 'bad-date' }), /时间/); assert.throws(() => logs.configure({ days: 0 }), /日志设置/);
  const file = path.join(root, 'not-directory'); await fs.writeFile(file, 'x');
  const failed = new LogStore(file); await failed.write('error', 'app', 'cannot write'); assert.match(failed.failure, /日志写入/);
});

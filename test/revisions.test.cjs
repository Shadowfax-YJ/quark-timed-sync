'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { revisionHeads, installRevision, hashFile, parseRecordBytes } = require('../src/revisions.cjs');
const { publishRevision } = require('../src/revision-publisher.cjs');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function record(old = 'original', next = 'corrected', id = 'r1') {
  return { format: 'quark-file-revision', schema_version: 1, revision_id: id, path: 'day/person/28.zip',
    previous_sha256: sha(old), sha256: sha(next), size: Buffer.byteLength(next), created_at: '2026-09-14T00:00:00Z',
    reason: 'Reviewed source image', content_path: '.sync-revisions/objects/' + sha(next),
    recycle_path: '.sync-recycle/' + sha(old) + '/day/person/28.zip' };
}
test('record reader accepts plain and CDN-gzipped JSON with a bounded expanded size', () => {
  const gzip = require('node:zlib').gzipSync, raw = Buffer.from(JSON.stringify(record()));
  assert.deepEqual(parseRecordBytes(raw), record());
  assert.deepEqual(parseRecordBytes(gzip(raw)), record());
  assert.throws(() => parseRecordBytes(gzip(Buffer.alloc(2 * 1024 * 1024, 32))));
  assert.throws(() => parseRecordBytes(gzip(raw).subarray(0, 12)));
});
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'revision-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
test('ordered hash chain accepts skipped local versions, refuses forks, cycles, paths and unknown schema', () => {
  const a = record(), b = record('corrected', 'second', 'r2');
  assert.equal(revisionHeads([b, a]).get(a.path).sha256, b.sha256);
  for (const records of [[a, record('original', 'fork', 'fork')], [a, record('corrected', 'original', 'loop')],
    [a, record('other', 'disconnected', 'r3')], [{ ...a, path: '../outside' }], [{ ...a, schema_version: 2 }],
    [{ ...a, content_path: '/etc/passwd' }], [{ ...a, path: '.SYNC-Revisions/record.json' }],
    [a, { ...b, path: a.path.toUpperCase() }]]) assert.throws(() => revisionHeads(records));
});
test('same-size revision uses hashes, retains local original, and repeated sync avoids download', async t => {
  const root = await temp(t), r = record('OLD BYTES', 'NEW BYTES');
  await fs.mkdir(path.join(root, 'day/person'), { recursive: true });
  const target = path.join(root, r.path); await fs.writeFile(target, 'OLD BYTES');
  let calls = 0;
  const download = async (_rel, file) => { calls++; await fs.writeFile(file, 'NEW BYTES'); };
  assert.equal((await installRevision(root, r, download)).updated, true);
  assert.equal(await hashFile(target), r.sha256);
  assert.equal(await fs.readFile(path.join(root, r.recycle_path), 'utf8'), 'OLD BYTES');
  assert.equal((await installRevision(root, r, download)).updated, false); assert.equal(calls, 1);
});
test('bad download, cancellation and concurrent local edits never replace existing bytes', async t => {
  for (const kind of ['bad', 'abort', 'changed']) {
    const root = await temp(t), r = record(); await fs.mkdir(path.join(root, 'day/person'), { recursive: true });
    const target = path.join(root, r.path); await fs.writeFile(target, 'original'); const abort = new AbortController();
    await assert.rejects(() => installRevision(root, r, async (_rel, file) => {
      await fs.writeFile(file, kind === 'bad' ? 'corrupted' : 'corrected');
      if (kind === 'abort') abort.abort();
      if (kind === 'changed') await fs.writeFile(target, 'user edit');
    }, abort.signal));
    assert.equal(await fs.readFile(target, 'utf8'), kind === 'changed' ? 'user edit' : 'original');
  }
});

test('crash after replacement repairs its audit journal without downloading again', async t => {
  const root = await temp(t), r = record();
  await fs.mkdir(path.join(root, 'day/person'), { recursive: true });
  await fs.writeFile(path.join(root, r.path), 'original');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === path.join(root, '.sync-revisions/applied/r1.json')) throw new Error('simulated interruption');
    return rename(from, to);
  };
  try { await assert.rejects(() => installRevision(root, r, (_rel, file) => fs.writeFile(file, 'corrected')), /simulated/); }
  finally { fs.rename = rename; }
  assert.equal(await hashFile(path.join(root, r.path)), r.sha256);
  assert.equal((await installRevision(root, r, () => { throw new Error('must not download'); })).updated, false);
  const audit = JSON.parse(await fs.readFile(path.join(root, '.sync-revisions/applied/r1.json'), 'utf8'));
  assert.equal(audit.local_previous_sha256, r.previous_sha256);
  assert.equal(await fs.readFile(path.join(root, audit.local_recycle_path), 'utf8'), 'original');
});
test('local corruption is repaired with the actual corrupt bytes retained separately', async t => {
  const root = await temp(t), r = record(); await fs.mkdir(path.join(root, 'day/person'), { recursive: true });
  await fs.writeFile(path.join(root, r.path), 'broken');
  const result = await installRevision(root, r, async (_rel, file) => fs.writeFile(file, 'corrected'));
  assert.equal(await fs.readFile(path.join(root, result.backup), 'utf8'), 'broken');
});
test('revision cannot follow local directory links', async t => {
  const root = await temp(t), outside = await temp(t); await fs.symlink(outside, path.join(root, 'day'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => installRevision(root, record(), async () => assert.fail('must not download')), /链接/);
});
function cloud(r) {
  const files = new Map([[r.path, Buffer.from('original')]]), records = [], operations = [];
  return { files, recordsList: records, operations, records: async () => records,
    hash: async key => files.has(key) ? sha(files.get(key)) : null, mkdir: async () => {},
    upload: async (file, key) => { operations.push(['upload', key]); files.set(key, await fs.readFile(file)); },
    move: async (src, dst) => { assert(files.has(src)); assert(!files.has(dst)); operations.push(['move', src, dst]); files.set(dst, files.get(src)); files.delete(src); },
    writeRecord: async (key, value) => { operations.push(['record', key]); if (!records.some(x => x.revision_id === value.revision_id)) records.push(value); } };
}
test('publication verifies cloud bytes, retains original, commits record last and resumes idempotently', async t => {
  const root = await temp(t), packageFile = path.join(root, 'new.zip'); await fs.writeFile(packageFile, 'corrected');
  const r = record(), store = cloud(r);
  assert.equal((await publishRevision(r, packageFile, store)).status, 'prepared'); assert.equal(store.operations.length, 0);
  await publishRevision(r, packageFile, store, { publish: true });
  assert.equal(await store.hash(r.path), r.sha256); assert.equal(await store.hash(r.recycle_path), r.previous_sha256);
  assert.equal(store.operations.at(-1)[0], 'record');
  await publishRevision(r, packageFile, store, { publish: true }); assert.equal(store.recordsList.length, 1);
  const count = store.operations.length;
  await assert.rejects(() => publishRevision({ ...r, revision_id: 'duplicate-content' }, packageFile, store, { publish: true }), /分叉/);
  assert.equal(store.operations.length, count);
});
test('publication interrupted after recycling resumes without losing either version', async t => {
  const root = await temp(t), packageFile = path.join(root, 'new.zip'); await fs.writeFile(packageFile, 'corrected');
  const r = record(), store = cloud(r), move = store.move;
  store.move = async (src, dst) => { if (dst === r.path) throw new Error('connection lost'); await move(src, dst); };
  await assert.rejects(() => publishRevision(r, packageFile, store, { publish: true }));
  assert.equal(store.recordsList.length, 0); assert.equal(await store.hash(r.recycle_path), r.previous_sha256);
  store.move = move; await publishRevision(r, packageFile, store, { publish: true }); assert.equal(await store.hash(r.path), r.sha256);
});
test('cloud corruption never publishes a record or moves the original', async t => {
  const root = await temp(t), packageFile = path.join(root, 'new.zip'); await fs.writeFile(packageFile, 'corrected');
  const r = record(), store = cloud(r); store.upload = async (_file, key) => store.files.set(key, Buffer.from('corrupt'));
  await assert.rejects(() => publishRevision(r, packageFile, store, { publish: true }));
  assert.equal(store.recordsList.length, 0); assert.equal(await store.hash(r.path), r.previous_sha256);
});

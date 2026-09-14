'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { Engine } = require('../src/engine.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'quark-copy-record-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'target'); await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, '28.zip'), 'OLD');
  const record = { format: 'quark-file-revision', schema_version: 1,
    revision_id: '20260913T195710Z-e201e363f1d0', path: '28.zip', previous_sha256: hash('OLD'),
    sha256: hash('NEW'), size: 3, reason: 'Reviewed fixture', created_at: '2026-09-14T00:00:00Z',
    content_path: '.sync-revisions/objects/' + hash('NEW') };
  const original = record.revision_id + '.json', copy = record.revision_id + '(1).json';
  const files = new Map([[copy, JSON.stringify(record)], [original, JSON.stringify(record)]]);
  const progress = [], downloads = [], logs = [];
  const engine = new Engine({ dataDir: root, update: (_id, state) => progress.push(state),
    log: (...args) => logs.push(args), persist: async () => {}, notify() {} });
  engine.mount = async () => '/fixture';
  engine.downloadFile = async (_mount, relative, file) => {
    downloads.push(relative);
    await fs.writeFile(file, relative === record.content_path ? 'NEW' : files.get(path.basename(relative)));
  };
  const client = { list: async fid => fid === 'root' ? [{file_name: '.sync-revisions', dir: true, fid: 'revisions'}]
    : fid === 'revisions' ? [{file_name: 'records', dir: true, fid: 'records'}]
    : [...files].map(([file_name, data]) => ({ file_name, size: Buffer.byteLength(data), file: true, file_type: 1, dir: false })) };
  const apply = () => engine.applyRevisions({id: 'fixture', destination}, 'root', client, new AbortController().signal);
  return { apply, record, files, original, copy, progress, downloads, logs, destination };
}

test('cloud conflict-copy filename is checked against the canonical record, without applying twice', async t => {
  const f = await fixture(t);
  assert.equal((await f.apply()).updated, 1);
  assert.equal(await fs.readFile(path.join(f.destination, '28.zip'), 'utf8'), 'NEW');
  assert.deepEqual(await fs.readdir(path.join(f.destination, '.sync-revisions/records')), [f.original]);
  assert(f.progress.some(p => p.current.includes('修订记录 1/2')));
  assert(f.progress.some(p => p.current.includes('修订记录 2/2')));
  assert(f.logs.some(args => args[2].includes('相同副本')));
  assert.equal((await f.apply()).updated, 0);
});

test('conflicting, orphaned and invalid cloud records never alter the local archive', async t => {
  for (const kind of ['conflict', 'orphan', 'invalid-name', 'wrong-id']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      if (kind === 'conflict') f.files.set(f.copy, JSON.stringify({...f.record, reason: 'different publication'}));
      if (kind === 'orphan') f.files.delete(f.original);
      if (kind === 'invalid-name') f.files.set('../bad.json', '{}');
      if (kind === 'wrong-id') f.files.set(f.copy, JSON.stringify({...f.record, revision_id: 'wrong'}));
      await assert.rejects(f.apply, kind === 'conflict' ? /副本内容冲突/ : kind === 'orphan' ? /副本缺少原记录/ : kind === 'wrong-id' ? /编号与文件名/ : /记录文件无效/);
      assert.equal(await fs.readFile(path.join(f.destination, '28.zip'), 'utf8'), 'OLD');
      await assert.rejects(fs.stat(path.join(f.destination, '.sync-revisions/records')), {code: 'ENOENT'});
      if (['orphan', 'invalid-name'].includes(kind)) assert.equal(f.downloads.length, 0);
    });
  }
});

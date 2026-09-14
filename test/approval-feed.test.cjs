'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {parseApproval, checkBatch, publishApproval} = require('../src/approval-feed.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function fixture(sequence = 1, previous = null) {
  const {privateKey, publicKey} = crypto.generateKeyPairSync('ed25519');
  const record = {format: 'quark-file-revision', schema_version: 1, revision_id: 'fixture', path: 'day/1.zip',
    previous_sha256: 'a'.repeat(64), sha256: 'b'.repeat(64), size: 99,
    content_path: '.sync-revisions/objects/' + 'b'.repeat(64), reason: '用户已审核', created_at: '2026-09-15T00:00:00Z'};
  const manifest = Buffer.from(JSON.stringify({items: [{path: record.path, sha256: record.sha256, previous_sha256: record.previous_sha256}]}));
  const payload = Buffer.from(JSON.stringify({stream_id: 'c'.repeat(32), sequence, previous_sha256: previous,
    public_key: publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('base64'),
    manifest_sha256: hash(manifest), manifest_base64: manifest.toString('base64')}));
  return {record, bytes: Buffer.from(JSON.stringify({format: 'quark-approved-revision-feed', schema_version: 1,
    payload_base64: payload.toString('base64'), signature: crypto.sign(null, payload, privateKey).toString('base64')}))};
}

test('signed approval binds exact batch bytes, paths and both hashes', () => {
  const {record, bytes} = fixture();
  const approval = parseApproval(bytes);
  checkBatch(approval, [record]);
  assert.throws(() => checkBatch(approval, [{...record, sha256: 'd'.repeat(64)}]), /摘要/);
  assert.throws(() => checkBatch(approval, []), /范围/);
  const forged = JSON.parse(bytes);
  forged.signature = Buffer.alloc(64).toString('base64');
  assert.throws(() => parseApproval(Buffer.from(JSON.stringify(forged))), /签名/);
});

test('approval commits after all revision records and retries without a second upload', async t => {
  const {record, bytes} = fixture(), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'approval-test-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'approval.json'); await fs.writeFile(file, bytes);
  const objects = new Map(), calls = []; let records = [];
  const store = {records: async () => records, hash: async rel => objects.has(rel) ? hash(objects.get(rel)) : null,
    mkdir: async rel => calls.push(['mkdir', rel]), upload: async (file, rel) => {calls.push(['upload', rel]); objects.set(rel, await fs.readFile(file));}};
  assert.equal((await publishApproval(file, store, {stagedRecords: [record]})).commit_after_all_records, true);
  await assert.rejects(publishApproval(file, store, {publish: true}), /未提交/);
  assert.equal(calls.length, 0);
  records = [record];
  assert.equal((await publishApproval(file, store)).status, 'approval_prepared');
  assert.equal(calls.length, 0);
  let loseResponse = true;
  const upload = store.upload;
  store.upload = async (...args) => {await upload(...args); if (loseResponse) {loseResponse = false; throw new Error('lost success response');}};
  await assert.rejects(publishApproval(file, store, {publish: true}), /lost/);
  assert.equal((await publishApproval(file, store, {publish: true})).reused, true);
  assert.equal(calls.filter(call => call[0] === 'upload').length, 1);
});

test('missing parent or corrupt immutable entry stops publication', async t => {
  const {record, bytes} = fixture(2, 'e'.repeat(64)), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'approval-test-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'approval.json'); await fs.writeFile(file, bytes);
  const store = {records: async () => [record], hash: async () => null, upload: async () => assert.fail('must not upload')};
  await assert.rejects(publishApproval(file, store, {publish: true}), /前一批/);
  store.hash = async rel => rel.endsWith('e'.repeat(64) + '.json') ? 'e'.repeat(64) : 'f'.repeat(64);
  await assert.rejects(publishApproval(file, store, {publish: true}), /冲突/);
});

test('Python publisher fixture verifies in the Node transport', async () => {
  const bytes = await fs.readFile(path.join(__dirname, 'fixtures', 'signed-approval.json'));
  const approval = parseApproval(bytes);
  assert.equal(approval.value.sequence, 1);
  const trusted = JSON.parse(await fs.readFile(path.join(__dirname, 'fixtures', 'approval-publisher-trust.json'), 'utf8'));
  assert.equal(approval.value.public_key, trusted.public_key);
  assert.equal(approval.manifest.approval.approval_id, 'cross-language-fixture');
  assert.equal(approval.manifest.items[0].path, '2026-09-15/fixture/1.zip');
});

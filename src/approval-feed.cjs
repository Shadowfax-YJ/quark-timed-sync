'use strict';
// Generic signed batch transport. The publisher's review workflow owns approval.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { relative, validateRecord } = require('./revisions.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const HEX = /^[a-f0-9]{64}$/;

function parseApproval(bytes) {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('批准记录超过大小限制');
  const envelope = JSON.parse(bytes.toString('utf8'));
  if (envelope.format !== 'quark-approved-revision-feed' || envelope.schema_version !== 1)
    throw new Error('批准记录格式不支持');
  const payload = Buffer.from(envelope.payload_base64, 'base64');
  const value = JSON.parse(payload.toString('utf8'));
  const raw = Buffer.from(value.public_key, 'base64');
  if (raw.length !== 32 || !/^[a-f0-9]{32}$/.test(value.stream_id)) throw new Error('批准发布端身份无效');
  const key = crypto.createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), type: 'spki', format: 'der'});
  if (!crypto.verify(null, payload, key, Buffer.from(envelope.signature, 'base64')))
    throw new Error('批准记录签名无效');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      (value.sequence === 1 ? value.previous_sha256 !== null : !HEX.test(value.previous_sha256 || '')))
    throw new Error('批准记录的前序链无效');
  const manifestBytes = Buffer.from(value.manifest_base64, 'base64');
  if (hash(manifestBytes) !== value.manifest_sha256) throw new Error('批准清单摘要不符');
  const manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(manifest.items) || !manifest.items.length) throw new Error('批准清单为空');
  const paths = new Set();
  for (const item of manifest.items) {
    relative(item.path);
    if (paths.has(item.path) || !HEX.test(item.sha256) || !HEX.test(item.previous_sha256))
      throw new Error('批准清单存在重复路径或无效摘要');
    paths.add(item.path);
  }
  const digest = hash(bytes), directory = `.sync-revisions/approval-feeds/${value.stream_id}`;
  return {value, manifest, digest, target: `${directory}/${digest}.json`, directory};
}

function checkBatch(approval, records) {
  if (records.length !== approval.manifest.items.length) throw new Error('发布批次与批准范围不同');
  for (const item of approval.manifest.items) {
    const matches = records.filter(row => row.path === item.path && row.sha256 === item.sha256 && row.previous_sha256 === item.previous_sha256);
    if (matches.length !== 1) throw new Error('发布批次与批准路径或摘要不同');
    validateRecord(matches[0]);
  }
}

async function publishApproval(file, store, {publish = false, stagedRecords} = {}) {
  const approval = parseApproval(await fs.readFile(file));
  if (!publish && stagedRecords) {
    checkBatch(approval, stagedRecords);
    return {status: 'approval_prepared', path: approval.target, sha256: approval.digest,
      sequence: approval.value.sequence, targets: stagedRecords.length, commit_after_all_records: true};
  }
  const records = await store.records();
  // Approval is committed only after every referenced revision record is visible.
  const selected = approval.manifest.items.map(item => records.find(row =>
    row.path === item.path && row.sha256 === item.sha256 && row.previous_sha256 === item.previous_sha256));
  if (selected.some(row => !row)) throw new Error('批准批次中仍有未提交的修订记录；重试同一批次');
  checkBatch(approval, selected);
  if (approval.value.previous_sha256 && await store.hash(`${approval.directory}/${approval.value.previous_sha256}.json`) !== approval.value.previous_sha256)
    throw new Error('前一批批准记录尚未完整发布');
  const current = await store.hash(approval.target);
  if (current !== null && current !== approval.digest) throw new Error('云端批准记录发生不可变对象冲突');
  if (publish && current === null) {
    await store.mkdir(path.posix.dirname(approval.target));
    await store.upload(file, approval.target);
  }
  if (publish && await store.hash(approval.target) !== approval.digest)
    throw new Error('批准记录上传回读尚未通过；可安全重试');
  return {status: publish ? 'approval_published' : 'approval_prepared',
    path: approval.target, sha256: approval.digest, sequence: approval.value.sequence, targets: selected.length, reused: current !== null};
}

module.exports = {parseApproval, checkBatch, publishApproval};

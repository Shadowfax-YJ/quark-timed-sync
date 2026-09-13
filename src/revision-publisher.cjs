'use strict';
const path = require('node:path');
const { validateRecord, relative, revisionHeads, hashFile, RECORDS } = require('./revisions.cjs');
const { delay } = require('./quark.cjs');

// The transport is scoped to one user-selected cloud root. No delete operation.
async function publishRevision(record, packageFile, store, { publish = false, signal, progress = () => {} } = {}) {
  validateRecord(record);
  const recycled = `.sync-recycle/${record.previous_sha256}/${record.path}`;
  if (record.recycle_path !== recycled) throw new Error('原包回收路径与 SHA256 不一致');
  if (await hashFile(packageFile, signal) !== record.sha256 || (await require('node:fs/promises').stat(packageFile)).size !== record.size)
    throw new Error('修订包与发布记录不一致');
  const records = await store.records(), heads = revisionHeads(records), head = heads.get(record.path);
  const existing = records.find(r => r.revision_id === record.revision_id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('同编号修订记录内容不同');
  revisionHeads(existing ? records : [...records, record]);
  if (head && head.sha256 !== record.previous_sha256 && head.sha256 !== record.sha256)
    throw new Error('云端已有另一份后续修订，请重新审核当前包');
  progress('核验云端原包');
  const current = await store.hash(record.path);
  if (current !== null && ![record.previous_sha256, record.sha256].includes(current))
    throw new Error('云端同名包的 SHA256 与审核原包不一致');
  if (current === null || current === record.sha256) {
    if (await store.hash(recycled) !== record.previous_sha256) throw new Error('云端原包缺失，不能发布修订');
  }
  if (!publish) return { status: 'prepared', path: record.path, sha256: record.sha256 };
  const ensureUpload = async (file, target, digest) => {
    const prior = await store.hash(target);
    if (prior !== null && prior !== digest) throw new Error('不可变云端对象发生冲突');
    if (prior === null) { await store.mkdir(path.posix.dirname(target)); await store.upload(file, target); }
    let uploaded = await store.hash(target);
    // A hash-reused upload can finish before its directory entry is visible.
    for (let retry = 0; uploaded === null && retry < 5; retry++) {
      await delay(1000, signal); uploaded = await store.hash(target);
    }
    if (uploaded !== digest) throw new Error(uploaded === null ? '云端上传尚未可见，可用同一修订重试' : '云端上传后的完整 SHA256 校验失败');
  };
  progress('上传并回读校验修订对象');
  await ensureUpload(packageFile, record.content_path, record.sha256);
  const stage = `.sync-revisions/staging/${record.revision_id}/${path.posix.basename(record.path)}`;
  if (current !== record.sha256) {
    progress('准备同名替换文件');
    await ensureUpload(packageFile, stage, record.sha256);
    if (current !== null) {
      const old = await store.hash(recycled);
      if (old !== null && old !== record.previous_sha256) throw new Error('回收目录中存在内容不同的原包');
      if (old !== null) throw new Error('原包与回收副本同时存在，请核对是否由备份程序重新上传');
      await store.mkdir(path.posix.dirname(recycled));
      progress('原包移入回收目录');
      await store.move(record.path, recycled);
      if (await store.hash(recycled) !== record.previous_sha256) throw new Error('回收原包的 SHA256 不匹配');
    }
    await store.mkdir(path.posix.dirname(record.path));
    await store.move(stage, record.path);
  }
  if (await store.hash(record.path) !== record.sha256) throw new Error('云端同名修订包校验失败');
  // Publish the immutable record last. Sync clients cannot see a partial revision.
  progress('提交修订记录');
  await store.writeRecord(`${RECORDS}/${record.revision_id}.json`, record);
  const committed = (await store.records()).find(r => r.revision_id === record.revision_id);
  if (!committed || JSON.stringify(committed) !== JSON.stringify(record)) throw new Error('云端修订记录回读不一致');
  return { status: 'published', path: record.path, sha256: record.sha256, recycle_path: recycled };
}
module.exports = { publishRevision };

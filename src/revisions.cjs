'use strict';
// Optional, domain-independent, content-verified replacement protocol.
const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeName, statOrNull, validateDestination, atomicJson } = require('./model.cjs');
const { abortError } = require('./quark.cjs');
const RECORDS = '.sync-revisions/records';
const RESERVED = new Set(['.sync-revisions', '.sync-recycle']);
const HEX = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 1024 * 1024;

function parseRecordBytes(bytes) {
  if (bytes.length > MAX_RECORD_BYTES) throw new Error('修订记录文件过大');
  // Some WebDAV/CDN paths retain gzip bytes but drop Content-Encoding.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b)
    bytes = require('node:zlib').gunzipSync(bytes, { maxOutputLength: MAX_RECORD_BYTES });
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

function relative(value) {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('\\')) throw new Error('修订路径无效');
  value.split('/').forEach(safeName);
  return value;
}
function validateRecord(record) {
  if (record?.format !== 'quark-file-revision' || record.schema_version !== 1) throw new Error('不支持的文件修订记录');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(record.revision_id) || !HEX.test(record.previous_sha256) || !HEX.test(record.sha256)
      || record.previous_sha256 === record.sha256 || !Number.isSafeInteger(record.size) || record.size <= 0
      || typeof record.reason !== 'string' || !record.reason.trim() || !Number.isFinite(Date.parse(record.created_at)))
    throw new Error('修订记录缺少有效的版本、原因或 SHA256');
  relative(record.path);
  if (RESERVED.has(record.path.split('/')[0].toLowerCase())) throw new Error('修订不能覆盖协议目录');
  if (record.content_path !== `.sync-revisions/objects/${record.sha256}`) throw new Error('修订内容必须使用按 SHA256 命名的对象');
  return record;
}
function revisionHeads(records) {
  const grouped = new Map(), ids = new Set(), spellings = new Map();
  for (const value of records) {
    const r = validateRecord(value), key = r.path.normalize('NFC').toLowerCase();
    if (ids.has(r.revision_id)) throw new Error('修订编号重复');
    ids.add(r.revision_id);
    if (spellings.has(key) && spellings.get(key) !== r.path) throw new Error('修订路径存在大小写或 Unicode 冲突');
    spellings.set(key, r.path);
    if (!grouped.has(r.path)) grouped.set(r.path, []);
    grouped.get(r.path).push(r);
  }
  const result = new Map();
  for (const [name, chain] of grouped) {
    const from = new Map(), to = new Map();
    for (const r of chain) {
      if (from.has(r.previous_sha256) || to.has(r.sha256)) throw new Error(`修订链发生分叉：${name}`);
      from.set(r.previous_sha256, r); to.set(r.sha256, r);
    }
    const starts = chain.filter(r => !to.has(r.previous_sha256));
    if (starts.length !== 1) throw new Error(`修订链不完整或循环：${name}`);
    let current = starts[0], count = 1;
    while (from.has(current.sha256)) { current = from.get(current.sha256); if (++count > chain.length) throw new Error('修订链循环'); }
    if (count !== chain.length) throw new Error(`修订链不连续：${name}`);
    result.set(name, current);
  }
  return result;
}
async function hashFile(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) { if (signal?.aborted) throw abortError(); hash.update(chunk); }
  return hash.digest('hex');
}
async function safeLocal(root, rel, createParents = false) {
  relative(rel); await validateDestination(root);
  let cursor = root;
  const pieces = rel.split('/');
  for (const part of pieces.slice(0, -1)) {
    cursor = path.join(cursor, part);
    if (createParents) await fs.mkdir(cursor).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const s = await statOrNull(cursor);
    if (!s && !createParents) break;
    if (!s?.isDirectory() || s.isSymbolicLink()) throw new Error('修订路径包含链接或非目录');
  }
  const target = path.join(root, ...pieces), s = await statOrNull(target);
  if (s && (!s.isFile() || s.isSymbolicLink())) throw new Error('修订目标不是普通文件');
  return target;
}
async function installRevision(root, record, download, signal, verification) {
  validateRecord(record);
  const destination = await safeLocal(root, record.path, true);
  const before = await statOrNull(destination);
  const checkedHash = () => verification ? verification.hash(destination, record.sha256, signal) : hashFile(destination, signal);
  const oldHash = before ? await checkedHash() : null;
  const pending = await safeLocal(root, `.sync-revisions/pending/${record.revision_id}.json`, true);
  const applied = await safeLocal(root, `.sync-revisions/applied/${record.revision_id}.json`, true);
  if (oldHash === record.sha256 && before.size === record.size) {
    // Recover a crash between the atomic file replacement and its audit commit.
    try {
      const journal = JSON.parse(await fs.readFile(pending, 'utf8'));
      if (journal.sha256 !== record.sha256 || journal.path !== record.path) throw new Error('待完成修订记录冲突');
      await atomicJson(applied, { ...journal, applied_at: new Date().toISOString() });
      await fs.unlink(pending);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { updated: false, path: record.path };
  }
  const temporary = await safeLocal(root, `.sync-revisions/staging/${crypto.randomUUID()}.part`, true);
  try {
    await download(record.content_path, temporary, signal);
    const downloaded = await fs.lstat(temporary);
    if (!downloaded.isFile() || downloaded.isSymbolicLink() || downloaded.size !== record.size
        || await hashFile(temporary, signal) !== record.sha256) throw new Error(`修订包 SHA256 校验失败，保留本地原文件：${record.path}`);
    await safeLocal(root, record.path);
    const now = await statOrNull(destination);
    if (Boolean(now) !== Boolean(before) || (now && await hashFile(destination, signal) !== oldHash))
      throw new Error(`下载期间本地文件发生变化，未替换：${record.path}`);
    let backup = null;
    if (before) {
      backup = `.sync-recycle/${oldHash}/${record.path}`;
      const saved = await safeLocal(root, backup, true);
      try { await fs.copyFile(destination, saved, constants.COPYFILE_EXCL); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (await hashFile(saved, signal) !== oldHash) throw new Error('本地回收副本校验失败，未替换原文件');
      const savedHandle = await fs.open(saved, 'r+'); try { await savedHandle.sync(); } finally { await savedHandle.close(); }
    }
    if (signal?.aborted) throw abortError();
    // Backup is already durable. A crash before/after rename is safe to retry.
    const handle = await fs.open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    const journal = { ...record, local_previous_sha256: oldHash, local_recycle_path: backup };
    await atomicJson(pending, journal);
    const journalHandle = await fs.open(pending, 'r+'); try { await journalHandle.sync(); } finally { await journalHandle.close(); }
    await fs.rename(temporary, destination);
    await atomicJson(applied, { ...journal, applied_at: new Date().toISOString() });
    await fs.unlink(pending);
    // Establish a receipt for the final file after rename, not for its staging
    // inode before installation. Concurrent edits cannot inherit verification.
    if (verification && await checkedHash() !== record.sha256) throw new Error('替换后本地文件发生变化，下次检查将重试');
    return { updated: true, path: record.path, backup };
  } finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
module.exports = { RECORDS, RESERVED, relative, validateRecord, revisionHeads, hashFile, safeLocal, installRevision, parseRecordBytes };

'use strict';
// Private, disposable verification receipts. Publication history remains in records/.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {atomicJson} = require('./model.cjs');
const {hashFile, validateRecord} = require('./revisions.cjs');
const {abortError} = require('./quark.cjs');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;

function remoteSignature(entry) {
  // Quark listings do not always expose content hashes. Require the provider's
  // file identity AND mutation timestamp, never merely the name/size/mtime.
  if (typeof entry.fid !== 'string' || !entry.fid || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !Number.isSafeInteger(entry.updated_at) || entry.updated_at <= 0) return null;
  for (const field of ['created_at', 'l_updated_at'])
    if (entry[field] != null && (!Number.isSafeInteger(entry[field]) || entry[field] <= 0)) return null;
  return JSON.stringify([entry.fid, entry.size, entry.updated_at, entry.created_at ?? null,
    entry.l_updated_at ?? null, entry.md5 ?? null, entry.sha1 ?? null, entry.sha256 ?? null]);
}
async function localSignature(file) {
  let s;
  try { s = await fs.lstat(file, {bigint:true}); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!s.isFile() || s.isSymbolicLink() || s.ino <= 0n || s.ctimeNs <= 0n) return null;
  // libuv exposes Windows ChangeTime as ctime, independent of birthtime. This
  // also invalidates same-size edits whose original mtime has been restored.
  return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs].map(String).join(':');
}
class RevisionCache {
  constructor(file, scope, force) {
    this.file = file; this.scope = scope; this.force = force; this.dirty = false;
    this.records = Object.create(null); this.files = Object.create(null);
    this.recordHits = 0; this.fileHits = 0;
  }
  static async open(dataDir, job, fid, {force = false} = {}) {
    const scope = digest(JSON.stringify([path.resolve(job.destination), fid, job.source?.kind,
      job.source?.fid, job.source?.share?.id]));
    const cache = new RevisionCache(path.join(dataDir, `revision-cache-${job.id}.json`), scope, force);
    if (force) {
      // A failed explicit full check must not revive receipts from before it.
      cache.dirty = true; await cache.save(); return cache;
    }
    try {
      const stat = await fs.lstat(cache.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) return cache;
      const {payload, sha256} = JSON.parse(await fs.readFile(cache.file, 'utf8')) ?? {};
      if (payload?.version === 1 && payload.scope === scope && sha256 === digest(JSON.stringify(payload))
          && payload.records && typeof payload.records === 'object' && !Array.isArray(payload.records)
          && payload.files && typeof payload.files === 'object' && !Array.isArray(payload.files)) {
        cache.records = payload.records; cache.files = payload.files;
      }
    } catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error; }
    return cache;
  }
  record(entry, id) {
    const signature = remoteSignature(entry), saved = own(this.records, entry.file_name);
    if (!this.force && signature && saved?.signature === signature) {
      try {
        validateRecord(saved.record);
        if (saved.record.revision_id === id) { this.recordHits++; return saved.record; }
      } catch { /* Invalid receipts fall back to the cloud publication. */ }
    }
    return null;
  }
  remember(entry, record) {
    const signature = remoteSignature(entry);
    if (signature) { this.records[entry.file_name] = {signature, record}; this.dirty = true; }
  }
  async hash(file, expected, signal) {
    if (signal?.aborted) throw abortError();
    const before = await localSignature(file), saved = own(this.files, file);
    if (!this.force && before && saved?.signature === before && saved.sha256 === expected) {
      this.fileHits++; return expected;
    }
    const actual = await hashFile(file, signal), after = await localSignature(file);
    if (signal?.aborted) throw abortError();
    if (before !== after) throw new Error('校验期间本地文件发生变化，下次检查将重试');
    if (before && actual === expected) {
      this.files[file] = {signature:before, sha256:actual}; this.dirty = true;
    }
    return actual;
  }
  async save() {
    if (!this.dirty) return;
    const payload = {version:1, scope:this.scope, records:this.records, files:this.files};
    await atomicJson(this.file, {payload, sha256:digest(JSON.stringify(payload))});
    this.dirty = false;
  }
}
module.exports = {RevisionCache, remoteSignature, localSignature};

'use strict';
// Host-owned revision transport. Callers receive file operations, never the
// authenticated client, local service API, or its credentials.
const fs = require('node:fs/promises'), syncFs = require('node:fs');
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { Quark, delay } = require('./quark.cjs');
const { Engine } = require('./engine.cjs');
const { RevisionCache, remoteSignature } = require('./revision-cache.cjs');
const { relative, hashFile, RECORDS, parseRecordBytes } = require('./revisions.cjs');
const { sanitize } = require('./logs.cjs');
const { uploadQuark } = require('./quark-upload.cjs');

// Electron must select its isolated profile before app.whenReady().
function prepareMaintenanceProfile(app) {
  const profile = path.join(app.getPath('appData'), 'Archive Subscriptions');
  const scratch = syncFs.mkdtempSync(path.join(os.tmpdir(), 'quark-revision-'));
  app.setPath('userData', scratch);
  syncFs.copyFileSync(path.join(profile, 'Local State'), path.join(scratch, 'Local State'));
  return Object.freeze({ profile, scratch });
}

async function openRevisionStore({ profile, scratch, jobId, safeStorage, write = false, nativeUpload = false,
  signal = new AbortController().signal, progress = () => {}, diagnostic = () => {} },
  { Engine: Service = Engine, Quark: Client = Quark } = {}) {
  const lifetime = new AbortController();
  signal = AbortSignal.any([signal, lifetime.signal]);
  let engine, closing, closed = false;
  const close = () => {
    closed = true; lifetime.abort();
    return closing ||= Promise.resolve().then(() => engine?.close());
  };
  const active = () => {
    if (closed) throw new Error('维护会话已关闭');
    signal.throwIfAborted();
  };
  const writable = () => {
    active();
    if (write !== true) throw new Error('维护会话为只读；写入需显式启用');
  };
  try {
    active();
    const cfg = JSON.parse(await fs.readFile(path.join(profile, 'subscriptions.json'), 'utf8'));
    const job = cfg.jobs.find(item => item.id === jobId);
    if (!job || job.source?.kind !== 'drive') throw new Error('发布需要本人网盘目录订阅');
    const quark = new Client(JSON.parse(safeStorage.decryptString(await fs.readFile(path.join(profile, 'credentials.bin')))));
    // The GUI owns this cache; maintenance only reads existing receipts.
    const approvedRecordCache = await RevisionCache.open(profile, job, job.source.fid);
    const dataDir = path.join(scratch, 'service-data');
    engine = new Service({ dataDir, vendorDir: path.join(__dirname, '..', 'vendor', `${process.platform}-${process.arch}`),
      quark, update() {}, async persist() {}, notify() {} });
    await fs.mkdir(dataDir, { recursive: true });
    const mount = await engine.mount(job, job.source.fid, signal);
    const redact = value => {
      let clean = sanitize(value);
      for (const secret of [engine.password, engine.auth]) if (secret) clean = clean.replaceAll(secret, '[已隐藏]');
      return clean;
    };
    const serviceError = chunk => {
      const line = chunk.toString();
      if (/\berror\b|\bfailed\b/i.test(line) && !/object not found/.test(line)) diagnostic(redact(line.split('\n')[0]));
    };
    engine.server.stdout.on('data', serviceError); engine.server.stderr.on('data', serviceError);
    const localUsers = await engine.localApi('/api/admin/user/list?page=1&per_page=100', undefined, signal);
    const localAdmin = localUsers.content?.find(user => user.username === 'admin');
    const diagnostics = { local_service_user: localAdmin?.username, role: localAdmin?.role, permission: localAdmin?.permission };
    if (write === true) {
      if (!localAdmin || localAdmin.role !== 2) throw new Error('本地维护服务管理员身份异常');
      await engine.localApi('/api/admin/user/update', { ...localAdmin, permission: localAdmin.permission | (1 << 9) }, signal);
      await engine.start(signal); // Permission updates invalidate the preceding JWT.
    }
    const folders = new Map([['', job.source.fid]]), creating = new Map();
    const recordCache = new Map(), verifiedFiles = new Map();
    const isDir = item => item.dir || item.file === false || item.file_type === 0;
    async function folder(rel, create = false) {
      active(); if (create) writable();
      if (!rel || rel === '.') return job.source.fid;
      relative(rel);
      if (folders.has(rel)) return folders.get(rel);
      if (creating.has(rel)) return creating.get(rel);
      const find = async () => {
        const parent = await folder(path.posix.dirname(rel), create);
        if (!parent) return null;
        const matches = (await quark.list(parent, signal)).filter(item => item.file_name === path.posix.basename(rel));
        if (matches.length > 1 || (matches.length && !isDir(matches[0]))) throw new Error('云端目录冲突');
        const fid = matches[0]?.fid || (create ? await quark.mkdir(parent, path.posix.basename(rel), signal) : null);
        if (fid) folders.set(rel, fid);
        return fid;
      };
      if (!create) return find();
      // Concurrent publications may share an as-yet uncreated parent.
      const pending = find(); creating.set(rel, pending);
      try { return await pending; } finally { creating.delete(rel); }
    }
    async function entry(rel) {
      active(); relative(rel);
      const fid = await folder(path.posix.dirname(rel)); if (!fid) return null;
      const found = (await quark.list(fid, signal)).filter(item => item.file_name === path.posix.basename(rel));
      if (found.length > 1 || (found.length && isDir(found[0]))) throw new Error('云端文件名冲突');
      return found[0] || null;
    }
    async function withDownload(rel, consume) {
      active(); relative(rel);
      const file = path.join(scratch, crypto.randomUUID());
      try { await engine.downloadFile(mount, rel, file, signal); return await consume(file); }
      finally { await fs.rm(file, { force: true }); }
    }
    async function upload(file, rel) {
      writable(); relative(rel);
      if (nativeUpload) return uploadQuark(quark, file, await folder(path.posix.dirname(rel), true),
        path.posix.basename(rel), signal, message => progress({ phase: 'upload', path: rel, message }));
      const password = await engine.command('rclone', ['obscure', '-'], { stdio: ['pipe', 'pipe', 'pipe'], inputPassword: engine.password });
      const env = { ...process.env, RCLONE_CONFIG_ARCHIVE_TYPE: 'webdav', RCLONE_CONFIG_ARCHIVE_URL: `http://127.0.0.1:${engine.port}/dav${mount}/`,
        RCLONE_CONFIG_ARCHIVE_VENDOR: 'other', RCLONE_CONFIG_ARCHIVE_USER: 'admin', RCLONE_CONFIG_ARCHIVE_PASS: password };
      active();
      await new Promise((resolve, reject) => {
        const child = engine.spawn('rclone', ['copyto', file, 'archive:' + rel, '--config', '', '--ignore-existing',
          '--retries', '2', '--low-level-retries', '2', '--timeout', '3m', '--max-duration', '8m', '--cutoff-mode', 'hard',
          '--no-gzip-encoding', '--header-upload', 'Accept-Encoding: identity'], { env, signal });
        let output = ''; child.stdout.resume();
        child.stderr.on('data', chunk => { if (output.length < 12000) output += chunk.toString(); });
        child.on('error', error => reject(error.name === 'AbortError' ? error : new Error('无法启动上传器')));
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`上传失败（${code}）：${redact(output).replaceAll(password, '[已隐藏]')}`)));
      });
    }
    return Object.freeze({
      records: async () => {
        active();
        const fid = await folder(RECORDS); if (!fid) return [];
        const result = [], entries = await quark.list(fid, signal);
        for (const item of entries) {
          if (!/^[a-zA-Z0-9_-]+\.json$/.test(item.file_name) || isDir(item) || item.size > 1024 * 1024)
            throw new Error(`修订记录文件异常：${item.file_name}`);
        }
        const readRecord = async item => {
          const signature = remoteSignature(item), key = signature && item.file_name + ':' + signature;
          const cached = (key && recordCache.get(key)) || approvedRecordCache.record(item, item.file_name.slice(0, -5));
          if (cached) return cached;
          return withDownload(RECORDS + '/' + item.file_name, async file => {
            const record = parseRecordBytes(await fs.readFile(file));
            if (key) recordCache.set(key, record);
            return record;
          });
        };
        for (let start = 0; start < entries.length; start += 4) {
          const values = await Promise.allSettled(entries.slice(start, start + 4).map(readRecord));
          const failed = values.find(value => value.status === 'rejected');
          if (failed) throw failed.reason;
          result.push(...values.map(value => value.value));
          if (result.length === entries.length || result.length % 40 === 0)
            progress({ phase: 'approval_records', verified: result.length, total: entries.length, reused: approvedRecordCache.recordHits });
        }
        return result;
      },
      hash: async rel => {
        const current = await entry(rel); if (!current) return null;
        const signature = remoteSignature(current), verified = verifiedFiles.get(rel);
        if (signature && verified?.signature === signature) return verified.sha256;
        return withDownload(rel, async file => {
          const sha256 = await hashFile(file, signal);
          if (signature !== remoteSignature(await entry(rel) || {})) throw new Error('校验期间云端文件发生变化');
          if (signature) verifiedFiles.set(rel, { signature, sha256 });
          return sha256;
        });
      },
      mkdir: async rel => { writable(); if (rel !== '.' && rel !== '') relative(rel); return folder(rel, true); },
      upload,
      move: async (src, dst) => {
        writable(); relative(src); relative(dst);
        if (path.posix.basename(src) !== path.posix.basename(dst) || await entry(dst)) throw new Error('云端移动目标必须为空且保持文件名');
        const original = await entry(src); if (!original) throw new Error('云端待移动文件不存在');
        await engine.localApi('/api/fs/move', { src_dir: mount + '/' + path.posix.dirname(src), dst_dir: mount + '/' + path.posix.dirname(dst),
          names: [path.posix.basename(src)], overwrite: false }, signal);
        for (let retry = 0; retry < 60; retry++) {
          const moved = await entry(dst);
          if (moved?.fid === original.fid && !await entry(src)) {
            const verified = verifiedFiles.get(src), originalSignature = remoteSignature(original), signature = remoteSignature(moved);
            if (originalSignature && signature && verified?.signature === originalSignature && original.size === moved.size)
              verifiedFiles.set(dst, { signature, sha256: verified.sha256 });
            verifiedFiles.delete(src);
            return;
          }
          await delay(1000, signal);
        }
        throw new Error('云端移动尚未确认完成，可用同一记录重试');
      },
      writeRecord: async (rel, value) => {
        writable(); relative(rel);
        await folder(path.posix.dirname(rel), true);
        const file = path.join(scratch, crypto.randomUUID());
        try { await fs.writeFile(file, JSON.stringify(value) + '\n'); await upload(file, rel); }
        finally { await fs.rm(file, { force: true }); }
      },
      diagnose: () => ({ ...diagnostics }), close
    });
  } catch (error) { await close(); throw error; }
}
module.exports = { prepareMaintenanceProfile, openRevisionStore };

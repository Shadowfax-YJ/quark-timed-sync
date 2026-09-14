'use strict';
// Maintenance entry point. Run with Electron; credentials stay in this process.
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises'), syncFs = require('node:fs');
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { Quark, delay } = require('../src/quark.cjs');
const { Engine } = require('../src/engine.cjs');
const { publishRevision } = require('../src/revision-publisher.cjs');
const { parseApproval, checkBatch, publishApproval } = require('../src/approval-feed.cjs');
const { relative, hashFile, RECORDS, parseRecordBytes } = require('../src/revisions.cjs');
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
// Scope optional proxy bypass to this maintenance process and the provider's
// API/object hosts; never change the user's system proxy or GUI profile.
if (args.includes('--direct-upload')) {
  const noProxy = [process.env.NO_PROXY || process.env.no_proxy || '',
    'localhost', '127.0.0.1', '.quark.cn', '.uc.cn', '.aliyuncs.com'].filter(Boolean).join(',');
  process.env.NO_PROXY = noProxy; process.env.no_proxy = noProxy;
}
const profile = path.join(app.getPath('appData'), 'Archive Subscriptions');
const scratch = syncFs.mkdtempSync(path.join(os.tmpdir(), 'quark-revision-'));
app.setPath('userData', scratch);
// Windows safeStorage uses this profile's encrypted OS key. Never print/decrypt it separately.
syncFs.copyFileSync(path.join(profile, 'Local State'), path.join(scratch, 'Local State'));
let engine;
app.whenReady().then(async () => {
  const approvalOnly = args.includes('--approval-only');
  if (!args.includes('--job') || (approvalOnly && !args.includes('--approval-feed')) ||
      (!approvalOnly && !args.includes('--batch') && (!args.includes('--record') || !args.includes('--package'))))
    throw new Error('用法：electron scripts/publish-revision.cjs --job 订阅ID (--batch 批次.json | --record 修订.json --package 修订.zip) [--publish]');
  const cfg = JSON.parse(await fs.readFile(path.join(profile, 'subscriptions.json'), 'utf8'));
  const job = cfg.jobs.find(j => j.id === arg('--job'));
  if (!job || job.source.kind !== 'drive') throw new Error('发布需要本人网盘目录订阅');
  const batch = approvalOnly ? {schema_version: 1, items: []} : args.includes('--batch') ? JSON.parse(await fs.readFile(arg('--batch'), 'utf8'))
    : { schema_version: 1, items: [{ record: arg('--record'), package: arg('--package') }] };
  if (batch.schema_version !== 1 || !Array.isArray(batch.items) || (!approvalOnly && !batch.items.length)) throw new Error('修订批次无效');
  const entries = await Promise.all(batch.items.map(async item => ({ ...item,
    revision: JSON.parse(await fs.readFile(item.record, 'utf8')) })));
  if (new Set(entries.map(item => item.revision.path)).size !== entries.length) throw new Error('同一批次的原包路径不能重复');
  if (args.includes('--approval-feed')) {
    const approval = parseApproval(await fs.readFile(arg('--approval-feed')));
    if (!approvalOnly) checkBatch(approval, entries.map(item => item.revision));
  }
  const quark = new Quark(JSON.parse(safeStorage.decryptString(await fs.readFile(path.join(profile, 'credentials.bin')))));
  engine = new Engine({ dataDir: path.join(scratch, 'service-data'), vendorDir: path.join(__dirname, '..', 'vendor', `${process.platform}-${process.arch}`),
    quark, update() {}, async persist() {}, notify() {} });
  await fs.mkdir(engine.dataDir, { recursive: true });
  const mount = await engine.mount(job, job.source.fid);
  const serviceError = chunk => {
    const line = chunk.toString();
    if (/\berror\b|\bfailed\b/i.test(line) && !/object not found/.test(line))
      console.error(require('../src/logs.cjs').sanitize(line.split('\n')[0]));
  };
  engine.server.stdout.on('data', serviceError); engine.server.stderr.on('data', serviceError);
  const localUsers = await engine.localApi('/api/admin/user/list?page=1&per_page=100');
  const localAdmin = localUsers.content?.find(user => user.username === 'admin');
  if (args.includes('--diagnose')) {
    console.log(JSON.stringify({ local_service_user: localAdmin?.username, role: localAdmin?.role, permission: localAdmin?.permission }));
    await engine.close(); app.exit(0); return;
  }
  // This is our isolated maintenance service, not the user's running sync
  // service. OpenList's initial admin has WebDAV read but not write (bit 9).
  // Grant that operation only for an explicitly requested publication.
  if (args.includes('--publish')) {
    if (!localAdmin || localAdmin.role !== 2) throw new Error('本地维护服务管理员身份异常');
    await engine.localApi('/api/admin/user/update', { ...localAdmin, permission: localAdmin.permission | (1 << 9) });
    await engine.start(); // Updating local permissions invalidates the preceding JWT.
  }
  const folders = new Map([['', job.source.fid]]), recordCache = new Map(), verifiedMoves = new Map();
  const isDir = item => item.dir || item.file === false || item.file_type === 0;
  async function folder(rel, create = false) {
    if (!rel || rel === '.') return job.source.fid;
    relative(rel);
    if (folders.has(rel)) return folders.get(rel);
    const parent = await folder(path.posix.dirname(rel), create);
    if (!parent) return null;
    const matches = (await quark.list(parent)).filter(e => e.file_name === path.posix.basename(rel));
    if (matches.length > 1 || (matches.length && !isDir(matches[0]))) throw new Error('云端目录冲突');
    const fid = matches[0]?.fid || (create ? await quark.mkdir(parent, path.posix.basename(rel)) : null);
    if (fid) folders.set(rel, fid);
    return fid;
  }
  async function entry(rel) {
    relative(rel); const fid = await folder(path.posix.dirname(rel)); if (!fid) return null;
    const found = (await quark.list(fid)).filter(e => e.file_name === path.posix.basename(rel));
    if (found.length > 1 || (found.length && isDir(found[0]))) throw new Error('云端文件名冲突');
    return found[0] || null;
  }
  async function download(rel) {
    const file = path.join(scratch, crypto.randomUUID());
    await engine.downloadFile(mount, rel, file, new AbortController().signal); return file;
  }
  async function upload(file, rel) {
    relative(rel);
    if (args.includes('--native-upload')) return require('./upload-quark.cjs').uploadQuark(quark, file,
      await folder(path.posix.dirname(rel), true), path.posix.basename(rel), new AbortController().signal,
      message => console.log(new Date().toISOString(), rel, message));
    const password = await engine.command('rclone', ['obscure', '-'], { stdio: ['pipe', 'pipe', 'pipe'], inputPassword: engine.password });
    const env = { ...process.env, RCLONE_CONFIG_ARCHIVE_TYPE: 'webdav', RCLONE_CONFIG_ARCHIVE_URL: `http://127.0.0.1:${engine.port}/dav${mount}/`,
      RCLONE_CONFIG_ARCHIVE_VENDOR: 'other', RCLONE_CONFIG_ARCHIVE_USER: 'admin', RCLONE_CONFIG_ARCHIVE_PASS: password };
    await new Promise((resolve, reject) => {
      const child = engine.spawn('rclone', ['copyto', file, 'archive:' + rel, '--config', '', '--ignore-existing',
        '--retries', '2', '--low-level-retries', '2', '--timeout', '3m', '--max-duration', '8m', '--cutoff-mode', 'hard',
        '--no-gzip-encoding', '--header-upload', 'Accept-Encoding: identity'], { env });
      let diagnostic = ''; child.stdout.resume();
      child.stderr.on('data', chunk => { if (diagnostic.length < 12000) diagnostic += chunk.toString(); });
      child.on('error', () => reject(new Error('无法启动上传器')));
      child.on('close', code => {
        if (!code) return resolve();
        const clean = require('../src/logs.cjs').sanitize(diagnostic)
          .replaceAll(engine.password, '[已隐藏]').replaceAll(password, '[已隐藏]').replaceAll(engine.auth, '[已隐藏]');
        reject(new Error(`上传失败（${code}）：${clean}`));
      });
    });
  }
  const store = {
    records: async () => {
      const fid = await folder(RECORDS); if (!fid) return [];
      const result = [], entries = await quark.list(fid);
      // Diagnose invalid metadata before downloading the complete history.
      for (const item of entries) {
        if (!/^[a-zA-Z0-9_-]+\.json$/.test(item.file_name) || isDir(item) || item.size > 1024 * 1024)
          throw new Error(`修订记录文件异常：${item.file_name}`);
      }
      for (const item of entries) {
        const key = item.fid + ':' + item.size + ':' + (item.updated_at || '');
        if (recordCache.has(key)) { result.push(recordCache.get(key)); continue; }
        const file = await download(RECORDS + '/' + item.file_name);
        try {
          const bytes = await fs.readFile(file);
          const record = parseRecordBytes(bytes); recordCache.set(key, record); result.push(record);
        } finally { await fs.unlink(file); }
      }
      return result;
    },
    hash: async rel => {
      const current = await entry(rel); if (!current) return null;
      const moved = verifiedMoves.get(rel);
      if (moved && moved.fid === current.fid && moved.size === current.size) return moved.sha256;
      const file = await download(rel);
      try {
        const sha256 = await hashFile(file);
        verifiedMoves.set(rel, { fid: current.fid, size: current.size, sha256 });
        return sha256;
      } finally { await fs.unlink(file); }
    },
    mkdir: rel => folder(rel, true), upload,
    move: async (src, dst) => {
      relative(src); relative(dst);
      if (path.posix.basename(src) !== path.posix.basename(dst) || await entry(dst)) throw new Error('云端移动目标必须为空且保持文件名');
      const original = await entry(src); if (!original) throw new Error('云端待移动文件不存在');
      await engine.localApi('/api/fs/move', { src_dir: mount + '/' + path.posix.dirname(src), dst_dir: mount + '/' + path.posix.dirname(dst),
        names: [path.posix.basename(src)], overwrite: false });
      for (let retry = 0; retry < 60; retry++) {
        const moved = await entry(dst);
        if (moved?.fid === original.fid && !await entry(src)) {
          // A verified cloud move preserves the exact object, including its bytes.
          const verified = verifiedMoves.get(src);
          if (verified?.fid === moved.fid && verified.size === moved.size) verifiedMoves.set(dst, verified);
          verifiedMoves.delete(src);
          return;
        }
        await delay(1000);
      }
      throw new Error('云端移动尚未确认完成，可用同一记录重试');
    },
    writeRecord: async (rel, value) => {
      await folder(path.posix.dirname(rel), true);
      const file = path.join(scratch, value.revision_id + '.json'); await fs.writeFile(file, JSON.stringify(value) + '\n');
      await upload(file, rel);
    }
  };
  if (args.includes('--publish') && !approvalOnly) {
    for (const folderName of ['.sync-revisions/objects', '.sync-revisions/staging', RECORDS, '.sync-recycle']) await folder(folderName, true);
  }
  const concurrency = args.includes('--workers') ? Number(arg('--workers')) : 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('发布并发需在 1 到 4 之间');
  let next = 0, completed = 0; const failures = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (next < entries.length) {
      const item = entries[next++];
      try {
        const result = await publishRevision(item.revision, item.package, store, { publish: args.includes('--publish'),
          progress: message => console.log(new Date().toISOString(), item.revision.path, message) });
        console.log(JSON.stringify({ ...result, completed: ++completed, total: entries.length }));
        if (args.includes('--journal')) await fs.appendFile(arg('--journal'), JSON.stringify(result) + '\n');
      } catch (error) {
        failures.push({ path: item.revision.path, error: error.message });
        console.error(JSON.stringify(failures.at(-1)));
      }
    }
  }));
  console.log(JSON.stringify({ completed, total: entries.length, failures }));
  if (failures.length) throw new Error(`${failures.length} 个修订未完成，可用相同批次重试`);
  if (args.includes('--approval-feed')) {
    console.log(JSON.stringify(await publishApproval(arg('--approval-feed'), store, {publish: args.includes('--publish'),
      stagedRecords: approvalOnly ? undefined : entries.map(item => item.revision)})));
  }
  await engine.close(); app.exit(0);
}).catch(async error => { console.error(error.message); await engine?.close(); app.exit(1); });

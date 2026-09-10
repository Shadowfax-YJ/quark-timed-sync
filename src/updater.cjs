'use strict';
const fs = require('./update-fs.cjs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PRODUCT, REPOSITORY, target, assetName } = require('./platforms.cjs');
const { inside, readLayout, removeOwned } = require('./update-layout.cjs');
const { extractZip } = require('./update-zip.cjs');
const RELEASES = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const PERIOD = 6 * 60 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function versionParts(value) {
  const match = /^v?(\d{1,8})\.(\d{1,8})\.(\d{1,8})$/.exec(value);
  if (!match) throw new Error('更新版本号无效'); return match.slice(1).map(Number);
}
function newer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function releaseAsset(release, current, platform, arch) {
  if (release.draft || release.prerelease || !newer(release.tag_name, current)) return null;
  const version = versionParts(release.tag_name).join('.');
  const packageArch = platform === 'darwin' && release.assets?.some(x => x.name === assetName(version, platform, 'universal')) ? 'universal' : arch;
  const name = assetName(version, platform, packageArch);
  const get = filename => {
    const asset = release.assets?.find(x => x.name === filename);
    const expected = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(filename)}`;
    if (!asset || new URL(asset.browser_download_url).href !== new URL(expected).href || !Number.isSafeInteger(asset.size) || asset.size < 1) throw new Error('最新版本尚未提供此平台的完整更新包和校验文件');
    return { url: expected, size: asset.size };
  };
  const archive = get(name), checksum = get(name + '.sha256');
  if (archive.size > 2 * 1024 ** 3 || checksum.size > 8192) throw new Error('更新文件大小异常');
  return { version, name, archive, checksum, packageArch };
}
function checksumValue(text, name) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 1) throw new Error('更新校验文件格式无效');
  const match = /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(lines[0]);
  if (!match || match[2] !== name) throw new Error('更新校验文件与安装包不匹配');
  return match[1].toLowerCase();
}
async function githubFetch(fetcher, url, signal) {
  for (let count = 0; count < 6; count++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw new Error('更新下载地址不属于 GitHub');
    const response = await fetcher(parsed.href, { redirect: 'manual', signal,
      headers: { 'User-Agent': 'quark-timed-sync', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('GitHub 下载重定向缺少地址');
      url = new URL(location, parsed).href; continue;
    }
    return response;
  }
  throw new Error('GitHub 下载重定向次数过多');
}
async function limitedText(response, limit) {
  if (!response.ok) throw new Error(`GitHub 请求失败（${response.status}），请稍后重试`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('GitHub 响应过大'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
class Updater extends EventEmitter {
  constructor({ dataDir, version, platform = process.platform, arch = process.arch, execPath = process.execPath, packaged = false, fetcher = fetch }) {
    super(); Object.assign(this, { version, platform, arch, execPath, packaged, fetcher });
    this.cache = path.join(dataDir, 'updates');
    this.installRoot = platform === 'darwin' ? path.resolve(path.dirname(execPath), '..', '..') : path.dirname(execPath);
    this.state = { phase: 'idle', version: '', progress: 0, error: '', packaged };
    this.enabled = false; this.nextCheck = 0; this.pending = null; this.ready = null;
  }
  set(patch) { Object.assign(this.state, patch); this.emit('state', { ...this.state }); }
  async init(updateId) {
    await fs.mkdir(this.cache, { recursive: true, mode: 0o700 });
    // Windows may report an 8.3 path for the same directory; normalize aliases
    // once before comparing paths or planning a directory replacement.
    this.cache = await fs.realpath(this.cache);
    this.installRoot = await fs.realpath(this.installRoot);
    if (updateId && /^[0-9a-f-]{36}$/.test(updateId)) {
      const work = path.join(this.cache, updateId);
      const plan = JSON.parse(await fs.readFile(path.join(work, 'plan.json'), 'utf8'));
      if (plan.installRoot === this.installRoot && plan.version === this.version) await fs.writeFile(path.join(work, 'boot-ok'), this.version);
    }
    try {
      const ready = JSON.parse(await fs.readFile(path.join(this.cache, 'ready.json'), 'utf8'));
      if (/^[0-9a-f-]{36}$/.test(ready.id) && newer(ready.version, this.version)) {
        const work = path.join(this.cache, ready.id), payload = this.payload(work, ready.packageArch);
        await readLayout(payload, this.platform, this.arch, ready.version);
        this.ready = { ...ready, work, payload }; this.set({ phase: 'ready', version: ready.version });
      }
    } catch { /* An incomplete or older download will be checked again. */ }
    // Workers exit before their runtime copies can be removed on Windows.
    for (const entry of await fs.readdir(this.cache, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name) || entry.name === this.ready?.id) continue;
      const work = path.join(this.cache, entry.name);
      try {
        const status = JSON.parse(await fs.readFile(path.join(work, 'status.json'), 'utf8'));
        if (status.phase === 'complete' && !alive(status.workerPid)) await removeOwned(this.cache, work);
        else if (['error', 'rolled-back'].includes(status.phase)) this.set({ phase: 'error', error: status.error || '上次更新没有完成，请重试' });
      } catch { /* Keep unfinished updates available for recovery. */ }
    }
  }
  payload(work, packageArch = this.arch) {
    if (packageArch !== this.arch && !(this.platform === 'darwin' && packageArch === 'universal')) throw new Error('更新包芯片信息不匹配');
    const root = path.join(work, 'extracted', target(this.platform, packageArch).folder);
    return this.platform === 'darwin' ? path.join(root, PRODUCT + '.app') : root;
  }
  enable(value) {
    this.enabled = Boolean(value); clearInterval(this.timer);
    if (!this.enabled) { this.controller?.abort(); return; }
    this.nextCheck = 0;
    this.timer = setInterval(() => { if (Date.now() >= this.nextCheck) this.check().catch(() => {}); }, 60000);
    this.timer.unref?.(); this.check().catch(() => {});
  }
  async stop() { clearInterval(this.timer); this.controller?.abort(); await this.pending?.catch(() => {}); }
  check() {
    if (this.pending) return this.pending;
    if (this.ready) return Promise.resolve();
    this.pending = this.performCheck().finally(() => { this.pending = null; }); return this.pending;
  }
  async performCheck() {
    const controller = new AbortController(); this.controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]);
    this.nextCheck = Date.now() + PERIOD; let work;
    this.set({ phase: 'checking', error: '', progress: 0 });
    try {
      const response = await githubFetch(this.fetcher, RELEASES, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
      if (response.status === 404) { this.set({ phase: 'current' }); return; }
      const release = JSON.parse(await limitedText(response, 2 * 1024 * 1024));
      const update = releaseAsset(release, this.version, this.platform, this.arch);
      if (!update) { this.set({ phase: 'current' }); return; }
      this.set({ version: update.version });
      if (!this.packaged) { this.set({ phase: 'error', error: '开发模式只能检查版本，请使用便携版下载和安装更新' }); return; }
      const id = crypto.randomUUID(); work = path.join(this.cache, id);
      await fs.mkdir(work, { mode: 0o700 });
      const expected = checksumValue(await limitedText(await githubFetch(this.fetcher, update.checksum.url, signal), 8192), update.name);
      this.set({ phase: 'downloading' });
      const download = await githubFetch(this.fetcher, update.archive.url, signal);
      if (!download.ok) throw new Error(`下载更新失败（${download.status}）`);
      const archive = path.join(work, 'download.zip'), handle = await fs.open(archive, 'wx', 0o600), hash = crypto.createHash('sha256');
      let size = 0, lastEmit = 0;
      try {
        for await (const chunk of download.body) {
          signal.throwIfAborted(); size += chunk.length;
          if (size > update.archive.size) throw new Error('更新包大小与发布信息不一致');
          hash.update(chunk); await handle.writeFile(chunk);
          if (Date.now() - lastEmit > 500) { this.set({ progress: Math.floor(size * 100 / update.archive.size) }); lastEmit = Date.now(); }
        }
      } finally { await handle.close(); }
      if (size !== update.archive.size || hash.digest('hex') !== expected) throw new Error('更新包 SHA-256 校验失败，已停止更新');
      this.set({ phase: 'verifying', progress: 100 });
      await extractZip(archive, path.join(work, 'extracted'), signal);
      const payload = this.payload(work, update.packageArch);
      await readLayout(payload, this.platform, this.arch, update.version); signal.throwIfAborted();
      await fs.writeFile(path.join(this.cache, 'ready.json'), JSON.stringify({ id, version: update.version, packageArch: update.packageArch }), { mode: 0o600 });
      this.ready = { id, version: update.version, packageArch: update.packageArch, work, payload };
      this.set({ phase: 'ready' });
    } catch (error) {
      if (work && !this.ready) await removeOwned(this.cache, work).catch(() => {});
      this.set({ phase: controller.signal.aborted ? 'idle' : 'error', error: controller.signal.aborted ? '' : error.message });
      if (!controller.signal.aborted) throw error;
    } finally { this.controller = null; }
  }
  async prepareInstall(protectedDirectories = []) {
    if (!this.packaged || !this.ready) throw new Error('尚无可安装的更新');
    const { id, version, work, payload } = this.ready;
    for (const dir of [this.cache, ...protectedDirectories]) {
      const resolved = await fs.realpath(dir).catch(() => path.resolve(dir));
      if (resolved === this.installRoot || inside(this.installRoot, resolved) || inside(resolved, this.installRoot)) throw new Error('程序目录与订阅或配置目录重叠，请先将程序移至独立目录');
    }
    await readLayout(this.installRoot, this.platform, this.arch, this.version);
    await readLayout(payload, this.platform, this.arch, version);
    const previousWorker = await fs.readFile(path.join(work, 'worker-ready'), 'utf8').then(JSON.parse).catch(() => null);
    if (previousWorker?.pid && alive(previousWorker.pid)) {
      await fs.writeFile(path.join(work, 'cancel'), 'cancel');
      for (let i = 0; i < 80 && alive(previousWorker.pid); i++) await sleep(100);
      if (alive(previousWorker.pid)) throw new Error('上次更新助手仍在退出，请稍后重试');
    }
    for (const name of ['cancel', 'worker-ready', 'boot-ok', 'status.json']) await fs.unlink(path.join(work, name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
    const parent = path.dirname(this.installRoot), incoming = path.join(parent, '.quark-update-next-' + id), backup = path.join(parent, '.quark-update-previous-' + id);
    // Also tests write permission without touching the running app.
    await fs.mkdir(incoming).catch(error => {
      if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw new Error('程序目录不可写，请将程序移至当前用户可写的独立文件夹后再更新');
      throw error;
    });
    try {
      await fs.cp(payload, incoming, { recursive: true, verbatimSymlinks: true });
      await readLayout(incoming, this.platform, this.arch, version);
      // Use a separate Electron runtime so the helper never locks the program being replaced.
      const runner = path.join(work, 'runner');
      await fs.cp(payload, runner, { recursive: true, verbatimSymlinks: true });
      for (const file of ['update-worker.cjs', 'update-layout.cjs', 'update-fs.cjs', 'platforms.cjs']) {
        const code = await require('node:fs/promises').readFile(path.join(__dirname, file));
        await fs.writeFile(path.join(work, file), code);
      }
      const plan = { id, version, oldVersion: this.version, platform: this.platform, arch: this.arch, parentPid: process.pid, installRoot: this.installRoot, incoming, backup, work };
      await fs.writeFile(path.join(work, 'plan.json'), JSON.stringify(plan), { mode: 0o600 });
      this.set({ phase: 'installing' });
      const child = spawn(path.join(runner, target(this.platform, this.arch).executable), [path.join(work, 'update-worker.cjs'), path.join(work, 'plan.json')],
        { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      for (let retry = 0; retry < 80; retry++) {
        const ready = await fs.readFile(path.join(work, 'worker-ready'), 'utf8').then(JSON.parse).catch(() => null);
        if (ready?.id === id && ready.pid === child.pid) return;
        await sleep(100);
      }
      await fs.writeFile(path.join(work, 'cancel'), 'cancel');
      throw new Error('更新助手没有启动，当前程序保持不变');
    } catch (error) {
      this.set({ phase: 'ready', error: error.message });
      // The worker, if it started, sees cancellation before any directory swap.
      await fs.writeFile(path.join(work, 'cancel'), 'cancel').catch(() => {});
      await removeOwned(parent, incoming).catch(() => {}); throw error;
    }
  }
}
module.exports = { Updater, newer, releaseAsset, checksumValue, githubFetch, RELEASES };

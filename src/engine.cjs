'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { atomicJson, prepareFiles, reconcileShare, copyArgs } = require('./model.cjs');
const { delay, abortError } = require('./quark.cjs');

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
class Engine {
  constructor({ dataDir, vendorDir, quark, update, persist, notify }) {
    Object.assign(this, { dataDir, vendorDir, quark, update, persist, notify });
    this.children = new Set(); this.controller = null; this.server = null; this.running = false;
    this.copyProcess = null; this.port = 0; this.auth = ''; this.password = ''; this.starting = null;
  }
  binary(name) { return path.join(this.vendorDir, name + (process.platform === 'win32' ? '.exe' : '')); }
  spawn(name, args, options = {}) {
    const child = spawn(this.binary(name), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    this.children.add(child); child.once('close', () => this.children.delete(child));
    return child;
  }
  async command(name, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(name, args, options); let stdout = '';
      if (options.inputPassword !== undefined) child.stdin.end(options.inputPassword + '\n');
      child.stdout.on('data', chunk => { if (stdout.length < 100000) stdout += chunk.toString(); });
      child.stderr.resume();
      child.on('error', () => reject(new Error(`无法启动内置 ${name}，请完整解压便携包`)));
      child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`内置 ${name} 启动失败（${code}）`)));
    });
  }
  async localApi(endpoint, body, signal) {
    const response = await fetch(`http://127.0.0.1:${this.port}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json',
        ...(endpoint === '/api/auth/login' ? {} : { Authorization: this.auth }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000)
    });
    const json = await response.json();
    if (json.code !== 200) throw new Error(`内置网盘服务请求失败（${json.code}），请重新登录后重试`);
    return json.data;
  }
  async start(signal) {
    if (this.server && this.server.exitCode === null && this.server.signalCode === null && this.auth) {
      // Refresh the local service token before each download, including after
      // the app has been left running beyond the token's 48-hour lifetime.
      const account = await this.localApi('/api/auth/login', { username: 'admin', password: this.password }, signal);
      this.auth = account.token; return;
    }
    if (this.starting) return this.starting;
    this.starting = this.startServer(signal).finally(() => { this.starting = null; });
    return this.starting;
  }
  async startServer(signal) {
    this.port = await availablePort();
    this.password = crypto.randomBytes(32).toString('base64url');
    const dir = path.join(this.dataDir, 'service');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const configPath = path.join(dir, 'config.json');
    let config = {};
    try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    Object.assign(config, { force: false, jwt_secret: crypto.randomBytes(32).toString('hex'), token_expires_in: 48,
      database: { type: 'sqlite3', db_file: path.join(dir, 'data.db'), table_prefix: 'x_' },
      scheme: { address: '127.0.0.1', http_port: this.port, https_port: -1 },
      temp_dir: path.join(dir, 'temp'), log: { enable: false },
      s3: { enable: false }, ftp: { enable: false }, sftp: { enable: false }, mcp: { enable: false },
      cors: { allow_origins: [`http://127.0.0.1:${this.port}`], allow_methods: ['GET', 'POST', 'HEAD', 'PROPFIND'], allow_headers: ['Authorization', 'Content-Type'] }
    });
    await atomicJson(configPath, config);
    await this.command('openlist', ['admin', 'set', '--data', dir, '--', this.password]);
    if (signal?.aborted) throw abortError();
    this.server = this.spawn('openlist', ['server', '--data', dir]);
    this.server.stdout.resume(); this.server.stderr.resume();
    let spawnError = false; this.server.on('error', () => { spawnError = true; });
    for (let i = 0; i < 50; i++) {
      await delay(300, signal);
      if (spawnError || this.server.exitCode !== null || this.server.signalCode !== null) throw new Error('内置网盘服务启动失败，请确认便携包已完整解压');
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/ping`, { signal: AbortSignal.timeout(500) });
        if (!res.ok) continue;
        const account = await this.localApi('/api/auth/login', { username: 'admin', password: this.password }, signal);
        this.auth = account.token; return;
      } catch (err) { if (signal?.aborted) throw abortError(); }
    }
    throw new Error('内置网盘服务未能及时启动');
  }
  async mount(job, fid, signal) {
    await this.start(signal);
    const mountPath = '/subscription-' + job.id;
    const current = await this.localApi('/api/admin/storage/list?page=1&per_page=1000', undefined, signal);
    const existing = current.content?.find(x => x.mount_path === mountPath);
    const storage = { mount_path: mountPath, order: 0, driver: 'Quark', cache_expiration: 0,
      disabled: false, web_proxy: true, webdav_policy: 'native_proxy', remark: 'Archive Subscriptions',
      addition: JSON.stringify({ cookie: await this.quark.cookieHeader(), root_folder_id: fid,
        order_by: 'file_name', order_direction: 'asc', use_transcoding_address: false, only_list_video_file: false }) };
    await this.localApi(existing ? '/api/admin/storage/update' : '/api/admin/storage/create', existing ? { ...storage, id: existing.id } : storage, signal);
    await this.localApi('/api/fs/list', { path: mountPath, password: '', page: 1, per_page: 1, refresh: true }, signal);
    return mountPath;
  }
  async shareRoot(job, signal) {
    const share = await this.quark.shareToken(job.source.share, signal);
    const sourceFid = job.source.fid || '0';
    const entries = await this.quark.list(sourceFid, signal, share);
    if (share.isOwner) {
      // A share's virtual root is not the account root. Only expose entries
      // actually present in the share, even when its real parent has siblings.
      let fid = sourceFid;
      if (sourceFid === '0' && entries.length) {
        const parents = new Set(entries.map(item => item.pdir_fid));
        if (parents.size !== 1 || typeof entries[0].pdir_fid !== 'string')
          throw new Error('这是自己的分享，请在来源选择中进入要订阅的文件夹后再选择');
        fid = entries[0].pdir_fid;
      }
      const client = { list: (parent, requestSignal) => parent === fid
        ? Promise.resolve(entries) : this.quark.list(parent, requestSignal, share) };
      return { fid, client };
    }
    if (!job.source.targetFid) {
      const rootName = 'Archive 订阅';
      const root = (await this.quark.list('0', signal)).find(x => x.file_name === rootName && (x.dir || x.file === false || x.file_type === 0));
      const parent = root?.fid || await this.quark.mkdir('0', rootName, signal);
      const name = '订阅-' + job.id;
      const children = await this.quark.list(parent, signal);
      const child = children.find(x => x.file_name === name && (x.dir || x.file === false || x.file_type === 0));
      job.source.targetFid = child?.fid || await this.quark.mkdir(parent, name, signal);
      await this.persist();
    }
    this.update(job.id, { phase: 'saving', current: '检查分享中的新增内容' });
    await reconcileShare(this.quark, share, job.source.fid || '0', job.source.targetFid, signal,
      progress => this.update(job.id, progress));
    return { fid: job.source.targetFid, client: this.quark };
  }
  async run(job) {
    if (this.running) throw new Error('已有订阅正在运行，请稍后再试');
    this.running = true; this.controller = new AbortController();
    const signal = this.controller.signal;
    let filesFile;
    try {
      this.update(job.id, { phase: 'checking', error: '', current: '连接夸克', discovered: 0, skipped: 0, transferred: 0, bytes: 0 });
      const { fid, client } = job.source.kind === 'share' ? await this.shareRoot(job, signal)
        : { fid: job.source.fid, client: this.quark };
      const plan = await prepareFiles(client, fid, job.destination, signal, progress => this.update(job.id, progress));
      if (plan.files.length) {
        const mountPath = await this.mount(job, fid, signal);
        filesFile = path.join(this.dataDir, 'files-' + job.id + '.txt');
        await fs.writeFile(filesFile, plan.files.join('\n') + '\n', { mode: 0o600 });
        const obscured = await this.command('rclone', ['obscure', '-'], { stdio: ['pipe', 'pipe', 'pipe'] , inputPassword: this.password });
        this.update(job.id, { phase: 'downloading', current: '下载新增文件', totalBytes: plan.totalBytes });
        await this.copy(job, mountPath, filesFile, obscured, signal);
      }
      if (signal.aborted) throw abortError();
      job.lastSuccess = new Date().toISOString(); job.lastCount = plan.files.length; job.lastError = '';
      this.update(job.id, { phase: 'idle', current: plan.files.length ? `已下载 ${plan.files.length} 个新文件` : `没有新增文件，已跳过 ${plan.skipped} 个已有文件`, transferred: plan.files.length });
      if (plan.files.length) this.notify('下载完成', `${job.name}：已下载 ${plan.files.length} 个新文件`);
    } catch (err) {
      if (signal.aborted || err.name === 'AbortError') this.update(job.id, { phase: 'paused', current: '已停止，未完成的下载下次继续' });
      else {
        const message = err.message || '下载失败，请稍后重试';
        this.update(job.id, { phase: 'error', error: message, current: message });
        if (job.lastError !== message) this.notify('订阅需要处理', `${job.name}：${message}`);
        job.lastError = message;
      }
    } finally {
      if (filesFile) await fs.unlink(filesFile).catch(() => {});
      job.nextRun = Date.now() + job.interval * 60000;
      this.running = false; this.controller = null; this.copyProcess = null;
      await this.persist();
    }
  }
  async copy(job, mountPath, filesFile, password, signal) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, RCLONE_CONFIG_ARCHIVE_TYPE: 'webdav',
        RCLONE_CONFIG_ARCHIVE_URL: `http://127.0.0.1:${this.port}/dav${mountPath}/`,
        RCLONE_CONFIG_ARCHIVE_VENDOR: 'other', RCLONE_CONFIG_ARCHIVE_USER: 'admin', RCLONE_CONFIG_ARCHIVE_PASS: password };
      const child = this.spawn('rclone', copyArgs('archive:', job.destination, filesFile), { env });
      this.copyProcess = child; let buffer = ''; let lastError = '';
      const consume = chunk => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const entry = JSON.parse(line);
            if (entry.stats) this.update(job.id, { phase: 'downloading', bytes: entry.stats.bytes || 0,
              speed: entry.stats.speed || 0, transferred: entry.stats.transfers || 0,
              current: entry.stats.transferring?.[0]?.name || '下载新增文件' });
            // Never forward raw network errors: they may contain signed URLs.
            if (entry.level === 'error') lastError = '部分文件下载失败，可能是网络、登录或磁盘空间问题；下次检查会重试';
          } catch {}
        }
        if (buffer.length > 1024 * 1024) buffer = '';
      };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      const stop = () => child.kill();
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      child.on('error', () => reject(new Error('无法启动内置下载器，请完整解压便携包')));
      child.on('close', code => {
        signal.removeEventListener('abort', stop);
        if (signal.aborted) reject(abortError());
        else if (code !== 0) reject(new Error(lastError || `下载器未完成（${code}），请检查网络和本地空间`));
        else resolve();
      });
    });
  }
  stop() { this.controller?.abort(); this.copyProcess?.kill(); }
  async close() {
    this.stop();
    const children = [...this.children];
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill();
    })));
    this.auth = ''; this.server = null;
  }
}
module.exports = { Engine };

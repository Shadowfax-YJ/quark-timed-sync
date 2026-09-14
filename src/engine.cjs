'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { atomicJson, prepareFiles, reconcileShare, copyArgs } = require('./model.cjs');
const { delay, abortError } = require('./quark.cjs');
const { revisionHeads, installRevision, safeLocal, RECORDS, parseRecordBytes } = require('./revisions.cjs');

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
class Engine {
  constructor({ dataDir, vendorDir, quark, update, persist, notify, log = () => {}, plugins }) {
    Object.assign(this, { dataDir, vendorDir, quark, update, persist, notify, log, plugins });
    this.children = new Set(); this.controller = null; this.server = null; this.running = false;
    this.copyProcess = null; this.port = 0; this.auth = ''; this.password = ''; this.starting = null;
  }
  binary(name) { return path.join(this.vendorDir, name + (process.platform === 'win32' ? '.exe' : '')); }
  spawn(name, args, options = {}) {
    const child = spawn(this.binary(name), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    this.children.add(child); child.once('close', () => this.children.delete(child));
    this.log('debug', 'service', `启动内置 ${name}`);
    child.once('close', code => this.log('debug', 'service', `内置 ${name} 已结束`, { details: { exitCode: code } }));
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
      progress => {
        this.update(job.id, progress);
        this.log('info', 'transfer', '分享文件已转存', { jobId: job.id, jobName: job.name, details: { file: progress.current, saved: progress.saved } });
      });
    return { fid: job.source.targetFid, client: this.quark };
  }
  async run(job) {
    if (this.running) throw new Error('已有订阅正在运行，请稍后再试');
    this.running = true; this.controller = new AbortController();
    const signal = this.controller.signal;
    const started = Date.now(), context = { jobId: job.id, jobName: job.name };
    const settlement = { run_id: crypto.randomUUID(), outcome: 'partial_failure' };
    this.log('info', 'subscription', '开始检查新增文件', context);
    let filesFile;
    try {
      this.update(job.id, { phase: 'checking', error: '', current: '连接夸克', discovered: 0, skipped: 0, transferred: 0, bytes: 0 });
      const { fid, client } = job.source.kind === 'share' ? await this.shareRoot(job, signal)
        : { fid: job.source.fid, client: this.quark };
      const revised = job.revisionUpdates ? await this.applyRevisions(job, fid, client, signal) : { paths: new Set(), updated: 0 };
      const plan = await prepareFiles(client, fid, job.destination, signal, progress => this.update(job.id, progress), revised.paths);
      this.log('info', 'subscription', `检查完成：新增 ${plan.files.length} 个，跳过 ${plan.skipped} 个已有文件`, { ...context, details: { added: plan.files.length, skipped: plan.skipped, totalBytes: plan.totalBytes } });
      if (plan.files.length) {
        const mountPath = await this.mount(job, fid, signal);
        filesFile = path.join(this.dataDir, 'files-' + job.id + '.txt');
        await fs.writeFile(filesFile, plan.files.join('\n') + '\n', { mode: 0o600 });
        const obscured = await this.command('rclone', ['obscure', '-'], { stdio: ['pipe', 'pipe', 'pipe'] , inputPassword: this.password });
        this.update(job.id, { phase: 'downloading', current: '下载新增文件', totalBytes: plan.totalBytes });
        await this.copy(job, mountPath, filesFile, obscured, signal);
      }
      if (signal.aborted) throw abortError();
      job.lastSuccess = new Date().toISOString(); job.lastCount = plan.files.length + revised.updated; job.lastError = '';
      settlement.outcome = 'success';
      this.update(job.id, { phase: 'idle', current: plan.files.length ? `已下载 ${plan.files.length} 个新文件` : `没有新增文件，已跳过 ${plan.skipped} 个已有文件`, transferred: plan.files.length });
      this.log('info', 'subscription', plan.files.length ? `订阅完成，已下载 ${plan.files.length} 个新文件` : '本次订阅检查完成，没有新增文件', { ...context, details: { downloaded: plan.files.length, durationMs: Date.now() - started } });
      if (plan.files.length) this.notify('下载完成', `${job.name}：已下载 ${plan.files.length} 个新文件`);
      if (revised.updated) {
        this.update(job.id, { phase: 'idle', current: `新增 ${plan.files.length} 个，已校验更新 ${revised.updated} 个文件`, transferred: job.lastCount });
        this.notify('修订同步完成', `${job.name}：已更新 ${revised.updated} 个文件，旧文件已留档`);
      }
    } catch (err) {
      if (signal.aborted || err.name === 'AbortError') settlement.outcome = 'cancelled';
      if (signal.aborted || err.name === 'AbortError') { this.update(job.id, { phase: 'paused', current: '已停止，未完成的下载下次继续' }); this.log('warn', 'subscription', '检查或下载已停止，未完成的文件下次继续', context); }
      else {
        const message = err.message || '下载失败，请稍后重试';
        this.update(job.id, { phase: 'error', error: message, current: message });
        if (job.lastError !== message) this.notify('订阅需要处理', `${job.name}：${message}`);
        job.lastError = message;
        this.log('error', 'subscription', message, { ...context, details: { error: err, durationMs: Date.now() - started } });
      }
    } finally {
      try { await this.plugins?.settled(job, settlement); }
      catch { this.log('error', 'plugin', '后处理事件登记失败，重启时将扫描补投', context); }
      if (filesFile) await fs.unlink(filesFile).catch(() => {});
      job.nextRun = Date.now() + job.interval * 60000;
      this.running = false; this.controller = null; this.copyProcess = null;
      await this.persist();
    }
  }
  async downloadFile(mountPath, relative, destination, signal) {
    const password = await this.command('rclone', ['obscure', '-'], { stdio: ['pipe', 'pipe', 'pipe'], inputPassword: this.password });
    const env = { ...process.env, RCLONE_CONFIG_ARCHIVE_TYPE: 'webdav',
      RCLONE_CONFIG_ARCHIVE_URL: `http://127.0.0.1:${this.port}/dav${mountPath}/`, RCLONE_CONFIG_ARCHIVE_VENDOR: 'other',
      RCLONE_CONFIG_ARCHIVE_USER: 'admin', RCLONE_CONFIG_ARCHIVE_PASS: password };
    // Preserve the stored bytes: Quark's CDN can compress JSON without updating
    // the WebDAV size, corrupting ranged downloads and their content hashes.
    await this.command('rclone', ['copyto', 'archive:' + relative, destination, '--config', '', '--retries', '2',
      '--low-level-retries', '2', '--contimeout', '20s', '--timeout', '2m',
      '--no-gzip-encoding', '--header-download', 'Accept-Encoding: identity'], { env, signal });
  }
  async applyRevisions(job, fid, client, signal) {
    this.update(job.id, { phase: 'checking', current: '读取云端修订目录' });
    // Local records also anchor history when the application profile is moved.
    const localRecordDirectory = path.dirname(await safeLocal(job.destination, RECORDS + '/probe.json'));
    const localNames = await fs.readdir(localRecordDirectory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    let parent = fid;
    for (const component of RECORDS.split('/')) {
      const entries = await client.list(parent, signal);
      const matches = entries.filter(item => item.file_name === component);
      if (!matches.length) {
        // Once applied, missing publication history must not silently roll back.
        if (localNames.length || await fs.stat(path.join(this.dataDir, `revision-heads-${job.id}.json`)).catch(() => null))
          throw new Error('云端修订记录缺失，保留已同步文件');
        return { paths: new Set(), updated: 0 };
      }
      if (matches.length !== 1 || !(matches[0].dir || matches[0].file === false || matches[0].file_type === 0))
        throw new Error('云端修订目录异常');
      parent = matches[0].fid;
    }
    const entries = await client.list(parent, signal);
    if (entries.length > 10000) throw new Error('修订记录过多，请缩小订阅范围');
    // Backup clients may add "(1)" to an identical publication. Require the
    // canonical record too, and compare all decoded fields before deduplicating.
    // Preflight the entire listing before starting potentially slow downloads.
    const names = new Set(), publications = entries.map(entry => {
      const match = typeof entry.file_name === 'string'
        && /^([a-zA-Z0-9_-]{1,100})( ?\([1-9][0-9]{0,5}\))?\.json$/.exec(entry.file_name);
      if (!match || entry.size > 1024 * 1024 || entry.dir || entry.file === false || entry.file_type === 0)
        throw new Error(`云端修订记录文件无效：${entry.file_name}`);
      if (names.has(entry.file_name)) throw new Error(`云端修订记录文件名重复：${entry.file_name}`);
      names.add(entry.file_name);
      return { entry, id: match[1], copy: Boolean(match[2]) };
    });
    for (const item of publications)
      if (item.copy && !names.has(item.id + '.json')) throw new Error(`修订副本缺少原记录：${item.entry.file_name}`);
    publications.sort((a, b) => Number(a.copy) - Number(b.copy));
    const mountPath = await this.mount(job, fid, signal), records = [];
    const byId = new Map();
    const scratch = await fs.mkdtemp(path.join(this.dataDir, 'revision-read-'));
    try {
      for (const [number, { entry, id, copy }] of publications.entries()) {
        this.update(job.id, { phase: 'checking', current: `校验修订记录 ${number + 1}/${publications.length}：${entry.file_name}` });
        const file = path.join(scratch, entry.file_name);
        await this.downloadFile(mountPath, RECORDS + '/' + entry.file_name, file, signal);
        if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('修订记录文件过大');
        const record = parseRecordBytes(await fs.readFile(file));
        if (record?.revision_id !== id) throw new Error(`修订编号与文件名不一致：${entry.file_name}`);
        if (copy) {
          if (!isDeepStrictEqual(byId.get(id), record)) throw new Error(`修订副本内容冲突，保留本地文件：${entry.file_name}`);
          this.log('info', 'revision', '修订记录相同副本已核对，按一条记录处理',
            { jobId: job.id, jobName: job.name, details: { file: entry.file_name, revision: id } });
        } else { byId.set(id, record); records.push(record); }
      }
    } finally {
      // Only remove files this invocation downloaded under its private directory.
      for (const name of await fs.readdir(scratch)) await fs.unlink(path.join(scratch, name));
      await fs.rmdir(scratch);
    }
    const heads = revisionHeads(records), checkpoint = path.join(this.dataDir, `revision-heads-${job.id}.json`);
    for (const name of localNames) {
      if (!records.some(r => r.revision_id + '.json' === name)) throw new Error('云端缺少已应用的修订历史');
    }
    let previous = {};
    try { previous = JSON.parse(await fs.readFile(checkpoint, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const [name, hash] of Object.entries(previous))
      if (!records.some(r => r.path === name && r.sha256 === hash)) throw new Error(`云端缺少已应用的修订历史：${name}`);
    for (const record of records) {
      const file = await safeLocal(job.destination, `${RECORDS}/${record.revision_id}.json`, true);
      try {
        const saved = await fs.readFile(file);
        if (JSON.stringify(parseRecordBytes(saved)) !== JSON.stringify(record))
          throw new Error('同编号修订记录已改变，保留本地文件');
        // Older append-only clients can have saved the CDN's gzip envelope as
        // a .json file. Normalize only after matching its decoded publication.
        if (saved[0] === 0x1f && saved[1] === 0x8b) await atomicJson(file, record);
      } catch (e) { if (e.code !== 'ENOENT') throw e; await atomicJson(file, record); }
    }
    let updated = 0;
    for (const [name, record] of heads) {
      this.update(job.id, { phase: 'checking', current: `校验修订：${name}` });
      const result = await installRevision(job.destination, record,
        (rel, target, token) => this.downloadFile(mountPath, rel, target, token), signal);
      if (result.updated) {
        updated++;
        this.log('info', 'revision', '修订文件已校验并替换，旧文件已留档',
          { jobId: job.id, jobName: job.name, details: { path: name, revision: record.revision_id, sha256: record.sha256, backup: result.backup } });
      }
      previous[name] = record.sha256;
      await atomicJson(checkpoint, previous);
    }
    return { paths: new Set(heads.keys()), updated };
  }
  async copy(job, mountPath, filesFile, password, signal) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, RCLONE_CONFIG_ARCHIVE_TYPE: 'webdav',
        RCLONE_CONFIG_ARCHIVE_URL: `http://127.0.0.1:${this.port}/dav${mountPath}/`,
        RCLONE_CONFIG_ARCHIVE_VENDOR: 'other', RCLONE_CONFIG_ARCHIVE_USER: 'admin', RCLONE_CONFIG_ARCHIVE_PASS: password };
      const child = this.spawn('rclone', copyArgs('archive:', job.destination, filesFile), { env });
      this.copyProcess = child; let buffer = ''; let lastError = '', lastProgress = 0;
      const consume = chunk => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const entry = JSON.parse(line);
            if (entry.stats && Date.now() - lastProgress > 30000) {
              lastProgress = Date.now(); this.log('debug', 'download', '下载进度', { jobId: job.id, jobName: job.name,
                details: { bytes: entry.stats.bytes, speed: entry.stats.speed, transferred: entry.stats.transfers } });
            }
            if (entry.level === 'info' && /^Copied \(/.test(entry.msg || '')) this.log('info', 'download', '文件下载完成', { jobId: job.id, jobName: job.name, details: { file: entry.object } });
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

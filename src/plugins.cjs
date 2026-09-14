'use strict';
// The host knows only local commands, durable events and the versioned JSON protocol.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { atomicJson } = require('./model.cjs');

function validatePlugin(value) {
  if (!value || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value.id) ||
      typeof value.version !== 'string' || !value.version || value.version.length > 80 ||
      !Array.isArray(value.command) || !value.command.length || value.command.length > 50 ||
      value.command.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0')) ||
      !path.isAbsolute(value.command[0])) throw new Error('插件需要 ID、版本和已安装程序的绝对路径及参数数组');
  const timeout_seconds = value.timeout_seconds ?? 60;
  if (!Number.isInteger(timeout_seconds) || timeout_seconds < 1 || timeout_seconds > 3600) throw new Error('插件超时范围为 1 至 3600 秒');
  return { id: value.id, version: value.version, command: value.command, timeout_seconds };
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function invoke(config, request, signal, progress = () => {}) {
  return new Promise(resolve => {
    let child, output = '', errors = 0, done = false, timer;
    const decoder = new StringDecoder('utf8');
    let diagnostics = '';
    function diagnosticLines(chunk) {
      diagnostics += chunk;
      let end;
      while ((end = diagnostics.indexOf('\n')) !== -1) {
        const line = diagnostics.slice(0, end); diagnostics = diagnostics.slice(end + 1);
        if (!line.startsWith('PLUGIN_PROGRESS ') || line.length > 16384) continue;
        try {
          const value = JSON.parse(line.slice(16));
          if (value.event_id !== request.event_id ||
              (value.invocation_id != null && value.invocation_id !== request.invocation_id) ||
              typeof value.message !== 'string' || !value.message.trim() || value.message.length > 2000) continue;
          progress({ message: value.message.replace(/[\x00-\x1f\x7f]/g, ' '), updatedAt: Date.now() });
        } catch { /* Diagnostics are optional; malformed lines are not results. */ }
      }
      if (diagnostics.length > 16384) diagnostics = '';
    }
    const failure = message => finish({ protocol_version: 1, event_id: request.event_id, status: 'retry', message });
    function finish(result) {
      if (done) return; done = true; clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      resolve(result);
    }
    const cancel = () => failure('插件执行已取消，等待重试');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'].includes(key.toUpperCase())));
    env.PYTHONIOENCODING = 'utf-8';
    try { child = spawn(config.command[0], config.command.slice(1), { windowsHide: true,
      shell: false, stdio: ['pipe', 'pipe', 'pipe'], env }); }
    catch { failure('插件程序无法启动'); return; }
    timer = setTimeout(() => failure('插件执行超时'), config.timeout_seconds * 1000);
    child.once('error', () => failure('插件程序无法启动'));
    child.stdin.on('error', () => failure('插件输入通道已关闭'));
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8'); if (Buffer.byteLength(output) > 1024 * 1024) failure('插件输出超过 1 MiB');
    });
    child.stderr.on('data', chunk => {
      if (done) return;
      errors += chunk.length;
      if (errors > 1024 * 1024) { failure('插件诊断输出超过 1 MiB'); return; }
      diagnosticLines(decoder.write(chunk));
    });
    child.once('close', code => {
      if (done) return;
      diagnosticLines(decoder.end());
      if (code !== 0) { failure('插件进程执行失败'); return; }
      try {
        const result = JSON.parse(output);
        if (result.protocol_version !== 1 || result.event_id !== request.event_id ||
            !['ok', 'retry', 'unsupported', 'rejected'].includes(result.status)) throw new Error();
        finish(result);
      } catch { failure('插件响应协议错误'); }
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else child.stdin.end(JSON.stringify(request) + '\n');
  });
}

class PluginManager {
  constructor({ dataDir, getJobs, changed = () => {}, log = () => {} }) {
    Object.assign(this, { getJobs, changed, log });
    this.root = path.join(dataDir, 'plugins'); this.events = new Map();
    this.busy = false; this.closed = false; this.controller = new AbortController();
    this.mutations = Promise.resolve();
  }
  mutate(action) {
    const result = this.mutations.then(action);
    this.mutations = result.catch(() => {});
    return result;
  }
  async save(event) { await atomicJson(path.join(this.root, 'outbox', event.key + '.json'), event); this.events.set(event.key, event); }
  async init() {
    await fs.mkdir(path.join(this.root, 'outbox'), { recursive: true });
    for (const file of await fs.readdir(path.join(this.root, 'outbox'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      try {
        const event = JSON.parse(await fs.readFile(path.join(this.root, 'outbox', file), 'utf8'));
        if (event.key + '.json' !== file || !event.request || !event.jobId) throw new Error();
        if (event.status === 'running') event.status = 'retry';
        this.events.set(event.key, event);
      } catch { this.log('error', 'plugin', '插件投递记录无法读取；保留原文件并重新扫描输入'); }
    }
    // Recovery also covers a crash after files landed but before the finally hook committed.
    for (const job of this.getJobs()) {
      try { await this.settled(job, { outcome: 'recovered', run_id: crypto.randomUUID() }); }
      catch { this.log('error', 'plugin', '插件配置或状态目录不可用', { jobId: job.id }); }
    }
    this.failure = null;
  }
  async settled(job, detail) {
    return this.mutate(async () => {
      if (this.closed) return;
      for (const input of job.plugins || []) {
        const config = validatePlugin(input), configHash = digest(config);
        const event_id = `sync:${job.id}:${detail.run_id}`, key = digest([event_id, configHash]);
        if (this.events.has(key)) continue;
        const state_dir = path.join(this.root, 'state', job.id, config.id);
        const event = { key, jobId: job.id, pluginId: config.id, configHash, status: 'queued',
          attempts: 0, nextAttempt: 0, createdAt: Date.now(), request: { protocol_version: 1,
            plugin_id: config.id, plugin_version: config.version, event_id, hook: 'sync.settled',
            state_dir, input: { root: job.destination, job_id: job.id, source_kind: job.source.kind,
              outcome: detail.outcome, run_id: detail.run_id } } };
        // A sync.settled request scans the current directory. Pending requests
        // for that same directory/config can share one scan; an active scan
        // keeps at most one follow-up so files arriving during it are covered.
        const pending = [...this.events.values()].filter(item => item.jobId === job.id &&
          item.configHash === configHash && item.request.input.root === job.destination &&
          ['queued', 'retry'].includes(item.status)).sort((a, b) => a.createdAt - b.createdAt);
        const primary = pending.shift();
        if (primary) {
          await this.save({ ...primary, status: 'queued', nextAttempt: 0,
            request: { ...primary.request, input: event.request.input } });
          for (const duplicate of [...pending, event])
            await this.save({ ...duplicate, status: 'superseded', supersededBy: primary.key });
        } else await this.save(event);
      }
      this.changed();
    });
  }
  status(jobId) {
    const configs = this.getJobs().find(job => job.id === jobId)?.plugins || [];
    return configs.map(input => {
      let config;
      try { config = validatePlugin(input); }
      catch { return { id: String(input?.id || 'unknown'), status: 'unsupported', message: '插件配置不可用，请重新导入', pending: 0 }; }
      if (this.failure) return { id: config.id, status: 'retry', message: this.failure, pending: 0 };
      const job = this.getJobs().find(job => job.id === jobId);
      const events = [...this.events.values()].filter(event => event.jobId === jobId && event.configHash === digest(config)
        && event.request.input.root === job.destination && event.status !== 'superseded');
      const pending = events.filter(event => ['queued', 'retry'].includes(event.status));
      const running = events.find(event => event.status === 'running');
      const last = running || (pending.length ? pending : events).sort((a, b) => b.createdAt - a.createdAt)[0];
      return { id: config.id, version: config.version, status: last?.status || 'queued',
        message: running ? running.progress?.message || '正在执行后处理' : last?.result?.message || '等待后处理',
        pending: pending.length, elapsedSeconds: running ? Math.max(0, Math.floor((Date.now() - (running.startedAt || Date.now())) / 1000)) : 0,
        progressUpdatedAt: running?.progress?.updatedAt,
        snapshot_id: last?.result?.snapshot_id };
    });
  }
  async retry(jobId) {
    const job = this.getJobs().find(job => job.id === jobId);
    if (job) await this.settled(job, { outcome: 'manual', run_id: crypto.randomUUID() });
  }
  async pump() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      if (this.failure) await this.init();
      for (const key of [...this.events.keys()]) {
        if (this.closed) break;
        const claimed = await this.mutate(async () => {
          const original = this.events.get(key);
          if (!original || !['queued', 'retry'].includes(original.status) || original.nextAttempt > Date.now()) return;
          const job = this.getJobs().find(job => job.id === original.jobId);
          const input = job?.plugins?.find(config => config.id === original.pluginId);
          if (!input || original.request.input.root !== job.destination) return;
          let config;
          try { config = validatePlugin(input); } catch { return; }
          if (digest(config) !== original.configHash) return;
          const event = { ...original, status: 'running', attempts: original.attempts + 1,
            startedAt: Date.now(), progress: null, result: null };
          await this.save(event);
          return { job, config, event };
        });
        if (!claimed) continue;
        const { job, config, event } = claimed;
        this.changed();
        this.log('info', 'plugin', `开始后处理 ${config.id}`, { jobId: job.id });
        await fs.mkdir(event.request.state_dir, { recursive: true });
        this.activeJob = job.id; this.activeController = new AbortController();
        let latestProgress;
        const flush = () => this.mutate(async () => {
          if (!latestProgress) return;
          const progress = latestProgress; latestProgress = null;
          await this.save({ ...this.events.get(event.key), progress });
        });
        const heartbeat = setInterval(() => {
          void flush().then(() => this.changed()).catch(() => {});
        }, 1000);
        let result;
        try {
          result = await invoke(config, { ...event.request, invocation_id: crypto.randomUUID(),
            deadline: Date.now() / 1000 + config.timeout_seconds },
            AbortSignal.any([this.controller.signal, this.activeController.signal]), progress => { latestProgress = progress; });
        } finally { clearInterval(heartbeat); await flush(); }
        this.activeJob = null; this.activeController = null;
        await this.mutate(async () => {
          const next = { ...this.events.get(event.key), status: result.status, result,
            nextAttempt: Date.now() + Math.min(3600000, 5000 * 2 ** Math.min(event.attempts - 1, 9)) };
          const pending = [...this.events.values()].filter(item => item.key !== event.key &&
            item.jobId === job.id && item.configHash === event.configHash &&
            item.request.input.root === job.destination && ['queued', 'retry'].includes(item.status));
          if (result.status === 'retry' && pending.length) {
            const latest = pending.sort((a, b) => b.createdAt - a.createdAt)[0];
            next.status = 'queued'; next.nextAttempt = 0;
            next.request = { ...next.request, input: latest.request.input };
          }
          await this.save(next);
          if (result.status === 'retry') for (const duplicate of pending)
            await this.save({ ...duplicate, status: 'superseded', supersededBy: event.key });
        });
        this.log(result.status === 'ok' ? 'info' : 'warn', 'plugin', `后处理 ${config.id}: ${result.status}`,
          { jobId: job.id, details: { message: result.message } });
        this.changed();
      }
    } finally { this.busy = false; }
  }
  async close() {
    this.closed = true; this.controller.abort();
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 20));
  }
  cancel(jobId) { if (this.activeJob === jobId) this.activeController?.abort(); }
}
module.exports = { PluginManager, validatePlugin, invoke };

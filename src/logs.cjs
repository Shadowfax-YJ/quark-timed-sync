'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { atomicJson } = require('./model.cjs');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULTS = { level: 'info', days: 14, maxMB: 25 };
const FILE_PATTERN = /^events-\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}\.jsonl$/;
const SECRET = /cookie|authorization|password|passcode|token|secret|credential|提取码|密码/i;
function sanitize(value, depth = 0) {
  if (depth > 5) return '[省略]';
  if (value instanceof Error) value = { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === 'string') return value
    .replace(/\b(cookie|set-cookie)\s*[=:]\s*[^\r\n]+/gi, '$1: [已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/gi, text => {
      try { const url = new URL(text); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; } catch { return '[链接已隐藏]'; }
    })
    .replace(/((?:cookie|authorization|password|passcode|token|access[_-]?token|refresh[_-]?token|[a-z_]*secret|credentials?|__puus|__pus|提取码|密码)\s*[=:：]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n,;]+)/gi, '$1[已隐藏]')
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9+/=_\-.]+/g, '$1 [已隐藏]')
    .slice(0, 8000);
  if (Array.isArray(value)) return value.slice(0, 30).map(x => sanitize(x, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key.slice(0, 100), SECRET.test(key) ? '[已隐藏]' : sanitize(item, depth + 1)]));
  return ['number', 'boolean'].includes(typeof value) || value === null ? value : undefined;
}
function preferences(input = {}) {
  const level = input.level || DEFAULTS.level, days = Number(input.days ?? DEFAULTS.days), maxMB = Number(input.maxMB ?? DEFAULTS.maxMB);
  if (!Object.hasOwn(LEVELS, level) || !Number.isInteger(days) || days < 1 || days > 90 || !Number.isInteger(maxMB) || maxMB < 1 || maxMB > 100) throw new Error('日志设置无效：保留 1～90 天，总大小 1～100 MB');
  return { level, days, maxMB };
}
function normalizeFilter(input = {}) {
  const level = String(input.level || ''), source = String(input.source || '').slice(0, 60), jobId = String(input.jobId || '').slice(0, 80);
  if (level && !Object.hasOwn(LEVELS, level)) throw new Error('日志级别无效');
  const from = input.from ? Date.parse(input.from) : 0, to = input.to ? Date.parse(input.to) : Infinity;
  if (!Number.isFinite(from) || (!Number.isFinite(to) && to !== Infinity) || from > to) throw new Error('日志时间范围无效');
  const limit = Number(input.limit ?? 100), offset = Number(input.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new Error('日志分页无效');
  return { level, source, jobId, from, to, query: String(input.query || '').slice(0, 200).toLowerCase(), limit, offset };
}
function matches(entry, filter) {
  const time = Date.parse(entry.time);
  return (!filter.level || entry.level === filter.level) && (!filter.source || entry.source === filter.source)
    && (!filter.jobId || entry.jobId === filter.jobId) && time >= filter.from && time <= filter.to
    && (!filter.query || JSON.stringify(entry).toLowerCase().includes(filter.query));
}

class LogStore extends EventEmitter {
  constructor(directory, { clock = () => Date.now(), chunkBytes = 2 * 1024 * 1024 } = {}) {
    super(); this.directory = directory; this.clock = clock; this.chunkBytes = chunkBytes;
    this.settings = { ...DEFAULTS }; this.queue = Promise.resolve(); this.failure = ''; this.active = null; this.activeSize = 0; this.lastPrune = 0; this.totalBytes = 0;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('日志目录不能是符号链接');
    try { this.settings = preferences(JSON.parse(await fs.readFile(path.join(this.directory, 'settings.json'), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') this.failure = '日志设置无法读取，已使用默认设置'; }
    await this.prune();
    return this;
  }
  enqueue(work) {
    const next = this.queue.then(() => { if (this.disabled) throw new Error('日志目录不可用，请检查目录权限后重启应用'); return work(); });
    this.queue = next.catch(error => { this.failure = '日志写入或读取失败：' + sanitize(error.message); this.emit('changed'); });
    return next;
  }
  write(level, source, message, context = {}) {
    if (!Object.hasOwn(LEVELS, level)) throw new Error('未知日志级别');
    if (LEVELS[level] < LEVELS[this.settings.level]) return Promise.resolve();
    const entry = { id: crypto.randomUUID(), time: new Date(this.clock()).toISOString(), level,
      source: String(source).slice(0, 60), message: sanitize(String(message)),
      ...(context.jobId ? { jobId: String(context.jobId).slice(0, 80), jobName: sanitize(String(context.jobName || '')) } : {}),
      ...(context.details ? { details: sanitize(context.details) } : {}) };
    return this.enqueue(async () => {
      let line = JSON.stringify(entry) + '\n';
      if (Buffer.byteLength(line) > 32000) { entry.details = { truncated: '详情过长，已省略' }; line = JSON.stringify(entry) + '\n'; }
      const date = entry.time.slice(0, 10), bytes = Buffer.byteLength(line);
      if (!this.active || !path.basename(this.active).startsWith('events-' + date + '-') || this.activeSize + bytes > Math.min(this.chunkBytes, this.settings.maxMB * 1024 * 1024)) {
        this.active = path.join(this.directory, `events-${date}-${crypto.randomUUID()}.jsonl`); this.activeSize = 0;
        await fs.writeFile(this.active, '', { flag: 'wx', mode: 0o600 });
      }
      await fs.appendFile(this.active, line, { mode: 0o600 }); this.activeSize += bytes; this.totalBytes += bytes;
      if (this.clock() - this.lastPrune > 60000 || this.totalBytes > this.settings.maxMB * 1024 * 1024) await this.prune();
      this.emit('changed');
    }).catch(() => {}); // Logging failures must not interrupt a subscription.
  }
  async files() {
    const files = [];
    for (const item of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!item.isFile() || !FILE_PATTERN.test(item.name)) continue;
      const file = path.join(this.directory, item.name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      files.push({ file, name: item.name, size: stat.size, modified: stat.mtimeMs });
    }
    return files.sort((a, b) => Number(b.file === this.active) - Number(a.file === this.active) || b.modified - a.modified || b.name.localeCompare(a.name));
  }
  async prune() {
    const files = await this.files(), cutoff = this.clock() - this.settings.days * 86400000;
    let bytes = 0;
    for (const item of files) {
      const date = Date.parse(item.name.slice(7, 17) + 'T23:59:59.999Z');
      if (date < cutoff || bytes + item.size > this.settings.maxMB * 1024 * 1024) {
        await fs.unlink(item.file);
        if (this.active === item.file) { this.active = null; this.activeSize = 0; }
      } else bytes += item.size;
    }
    this.lastPrune = this.clock(); this.totalBytes = bytes;
  }
  async scan(filter, visit) {
    let malformed = 0;
    for (const item of (await this.files()).reverse()) {
      const text = await fs.readFile(item.file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); if (!Object.hasOwn(LEVELS, entry.level) || typeof entry.id !== 'string' || !Number.isFinite(Date.parse(entry.time)) || typeof entry.message !== 'string') throw new Error(); }
        catch { malformed++; continue; }
        if (matches(entry, filter)) await visit(sanitize(entry));
      }
    }
    return malformed;
  }
  query(input) {
    const filter = normalizeFilter(input);
    return this.enqueue(async () => {
      await this.prune();
      const rows = [], counts = { debug: 0, info: 0, warn: 0, error: 0 }, jobs = new Map(); let total = 0;
      const malformed = await this.scan(filter, entry => {
        total++; counts[entry.level]++;
        if (entry.jobId) jobs.set(entry.jobId, entry.jobName || entry.jobId);
        rows.push(entry);
        // Keep memory bounded even when retained files contain many small records.
        if (rows.length > (filter.offset + filter.limit) * 2) { rows.sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id)); rows.length = filter.offset + filter.limit; }
      });
      rows.sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
      return { entries: rows.slice(filter.offset, filter.offset + filter.limit), total, counts,
        jobs: [...jobs].map(([id, name]) => ({ id, name })), malformed, warning: this.failure, settings: this.settings,
        bytes: (await this.files()).reduce((sum, x) => sum + x.size, 0) };
    });
  }
  configure(input) {
    const next = preferences(input);
    return this.enqueue(async () => { await atomicJson(path.join(this.directory, 'settings.json'), next); this.settings = next; await this.prune(); this.emit('changed'); return next; });
  }
  clear() {
    return this.enqueue(async () => { for (const item of await this.files()) await fs.unlink(item.file); this.active = null; this.activeSize = 0; this.totalBytes = 0; this.failure = ''; this.emit('changed'); });
  }
  export(file, input, format = 'jsonl') {
    const filter = normalizeFilter(input);
    if (!['jsonl', 'text'].includes(format)) throw new Error('日志导出格式无效');
    return this.enqueue(async () => {
      const output = await fs.open(file, 'w', 0o600); let count = 0;
      try {
        await this.scan(filter, async entry => {
          const line = format === 'jsonl' ? JSON.stringify(entry) : `${entry.time} [${entry.level.toUpperCase()}] [${entry.source}]${entry.jobName ? ' [' + entry.jobName + ']' : ''} ${entry.message}${entry.details ? '\n' + JSON.stringify(entry.details, null, 2) : ''}`;
          await output.write(line + '\n'); count++;
        });
      } finally { await output.close(); }
      return { count };
    });
  }
  async close() { await this.queue; }
}
module.exports = { LogStore, sanitize, normalizeFilter, DEFAULTS };

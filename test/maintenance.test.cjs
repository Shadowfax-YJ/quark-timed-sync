'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { openRevisionStore } = require('../src/maintenance.cjs');
const { RevisionCache } = require('../src/revision-cache.cjs');
const { publishRevision } = require('../src/revision-publisher.cjs');
const { Engine } = require('../src/engine.cjs');
const { RECORDS } = require('../src/revisions.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'quark-maintenance-test-')));
  const sessions = [];
  t.after(async () => {
    await Promise.all(sessions.map(store => store.close()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const profile = path.join(root, 'profile'), scratch = path.join(root, 'scratch');
  await fs.mkdir(profile); await fs.mkdir(scratch);
  const job = { id: 'fixture', source: { kind: 'drive', fid: 'selected-root' }, destination: path.join(root, 'downloads') };
  await fs.writeFile(path.join(profile, 'subscriptions.json'), JSON.stringify({ jobs: [job] }));
  await fs.writeFile(path.join(profile, 'credentials.bin'), 'synthetic encrypted fixture');
  const remote = new Map([['', { fid: 'selected-root', file: false }]]), calls = [], services = [], progress = [];
  let serial = 0;
  const put = (rel, bytes) => {
    if (rel.includes('/') && !remote.has(path.posix.dirname(rel))) throw new Error('Missing fixture parent');
    const item = { fid: 'object-' + ++serial, file_name: path.posix.basename(rel), file: bytes != null,
      size: bytes?.length || 0, updated_at: serial, bytes: bytes == null ? null : Buffer.from(bytes) };
    remote.set(rel, item); return item;
  };
  class Client {
    constructor(credentials) { assert.deepEqual(credentials, {}); }
    async list(fid) {
      calls.push(['list', fid]);
      const parent = [...remote].find(([, item]) => item.fid === fid)?.[0];
      assert.notEqual(parent, undefined, 'never enumerate outside the selected root');
      return [...remote].filter(([rel]) => rel && (path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)) === parent)
        .map(([, item]) => ({ ...item }));
    }
    async mkdir(fid, name) {
      calls.push(['mkdir', fid, name]);
      const parent = [...remote].find(([, item]) => item.fid === fid)?.[0];
      assert.notEqual(parent, undefined);
      const rel = parent ? parent + '/' + name : name;
      assert.equal(remote.has(rel), false, 'concurrent mkdir must not create duplicate folders');
      return put(rel, null).fid;
    }
  }
  class Service {
    constructor() {
      this.password = 'private-password'; this.auth = 'private-token'; this.port = 12345;
      this.server = { stdout: new PassThrough(), stderr: new PassThrough() };
      services.push(this);
    }
    async mount(selected, fid) {
      assert.equal(selected.id, job.id); assert.equal(fid, job.source.fid);
      return '/subscription-fixture';
    }
    async localApi(endpoint, body) {
      calls.push([endpoint, body]);
      if (endpoint.startsWith('/api/admin/user/list')) return { content: [{ username: 'admin', role: 2, permission: 0 }] };
      if (endpoint === '/api/fs/move') {
        assert.equal(body.overwrite, false);
        const from = path.posix.normalize(body.src_dir.slice('/subscription-fixture/'.length) + '/' + body.names[0]);
        const to = path.posix.normalize(body.dst_dir.slice('/subscription-fixture/'.length) + '/' + body.names[0]);
        assert.equal(remote.has(to), false);
        const item = remote.get(from); remote.delete(from);
        remote.set(to, { ...item, updated_at: ++serial });
      }
    }
    async start() { calls.push(['refresh']); }
    async downloadFile(mount, rel, file) {
      assert.equal(mount, '/subscription-fixture'); calls.push(['download', rel]);
      await fs.writeFile(file, remote.get(rel).bytes);
      if (this.failDownload) throw new Error('interrupted download');
    }
    async command() { return 'obscured-password'; }
    spawn(_name, args, options) {
      assert.equal(options.env.RCLONE_CONFIG_ARCHIVE_URL, 'http://127.0.0.1:12345/dav/subscription-fixture/');
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      void (async () => {
        const rel = args[2].slice('archive:'.length); calls.push(['upload', rel]);
        if (!remote.has(rel)) put(rel, await fs.readFile(args[1]));
        child.emit('close', 0);
      })().catch(error => child.emit('error', error));
      return child;
    }
    async close() { calls.push(['close']); }
  }
  const options = { profile, scratch, jobId: job.id, safeStorage: { decryptString: () => '{}' }, progress: value => progress.push(value) };
  const open = async (extra = {}, adapters = {}) => {
    const store = await openRevisionStore({ ...options, ...extra }, { Engine: Service, Quark: Client, ...adapters });
    sessions.push(store); return store;
  };
  return { root, profile, scratch, job, remote, calls, services, progress, put, open, Service, Client };
}

test('maintenance defaults to read-only and exposes only scoped revision operations', async t => {
  const f = await fixture(t), store = await f.open();
  assert.deepEqual(Object.keys(store).sort(), ['close', 'diagnose', 'hash', 'mkdir', 'move', 'records', 'upload', 'writeRecord']);
  assert.deepEqual(store.diagnose(), { local_service_user: 'admin', role: 2, permission: 0 });
  assert.equal(await store.hash('missing.txt'), null);
  for (const mutate of [() => store.mkdir('folder'), () => store.upload('local', 'remote'),
    () => store.move('source', 'target'), () => store.writeRecord('record.json', {})]) await assert.rejects(mutate, /只读/);
  assert.equal(f.calls.some(([name]) => name === '/api/admin/user/update' || name === 'upload' || name === 'mkdir'), false);
  for (const invalid of ['../escape', '/absolute', 'D:/absolute', 'a/../escape', 'a\\escape'])
    await assert.rejects(() => store.hash(invalid));
  await store.close(); await store.close();
  assert.equal(f.calls.filter(([name]) => name === 'close').length, 1);
  await assert.rejects(() => store.hash('file'), /关闭/);
});

test('explicit write supports publication, recycled originals and an idempotent retry', async t => {
  const f = await fixture(t), old = Buffer.from('old'), bytes = Buffer.from('new');
  f.put('document.zip', old);
  const file = path.join(f.root, 'revised.zip'); await fs.writeFile(file, bytes);
  const record = { format: 'quark-file-revision', schema_version: 1, revision_id: 'r1', path: 'document.zip',
    previous_sha256: digest(old), sha256: digest(bytes), size: bytes.length,
    content_path: `.sync-revisions/objects/${digest(bytes)}`, recycle_path: `.sync-recycle/${digest(old)}/document.zip`,
    created_at: '2026-01-01T00:00:00Z', reason: 'fixture correction' };
  const readonly = await f.open();
  assert.equal((await publishRevision(record, file, readonly)).status, 'prepared');
  assert.equal(f.calls.some(([name]) => name === 'upload'), false);
  const store = await f.open({ write: true });
  await Promise.all([store.mkdir('shared/folder'), store.mkdir('shared/folder')]);
  assert.equal(f.calls.filter(([name]) => name === '/api/admin/user/update').length, 1);
  assert.equal((await publishRevision(record, file, store, { publish: true })).status, 'published');
  assert.deepEqual(f.remote.get('document.zip').bytes, bytes);
  assert.deepEqual(f.remote.get(record.recycle_path).bytes, old);
  const uploads = f.calls.filter(([name]) => name === 'upload').length;
  assert.equal((await publishRevision(record, file, store, { publish: true })).status, 'published');
  assert.equal(f.calls.filter(([name]) => name === 'upload').length, uploads);
  assert.deepEqual(await fs.readdir(f.scratch), ['service-data']);
  await assert.rejects(() => store.mkdir('../escape'));
  await assert.rejects(() => store.upload(file, '../escape'));
  await assert.rejects(() => store.writeRecord('../escape', record));
  await assert.rejects(() => store.move('document.zip', 'renamed.zip'), /保持文件名/);
});

test('record receipts are reused read-only and changed file identities invalidate cached hashes', async t => {
  const f = await fixture(t);
  f.put('.sync-revisions', null); f.put(RECORDS, null);
  const record = { format: 'quark-file-revision', schema_version: 1, revision_id: 'r1', path: 'file.txt',
    previous_sha256: 'a'.repeat(64), sha256: 'b'.repeat(64), size: 3,
    content_path: '.sync-revisions/objects/' + 'b'.repeat(64), created_at: '2026-01-01T00:00:00Z', reason: 'fixture' };
  const item = f.put(RECORDS + '/r1.json', Buffer.from(JSON.stringify(record)));
  const cache = await RevisionCache.open(f.profile, f.job, f.job.source.fid); cache.remember(item, record); await cache.save();
  const receipt = await fs.readFile(cache.file);
  const store = await f.open();
  assert.deepEqual(await store.records(), [record]);
  assert.equal(f.calls.some(([name]) => name === 'download'), false);
  assert.equal(f.progress.at(-1).reused, 1);
  assert.deepEqual(await fs.readFile(cache.file), receipt);
  f.remote.set(RECORDS + '/r1.json', { ...item, updated_at: item.updated_at + 100 });
  assert.deepEqual(await store.records(), [record]);
  assert.equal(f.calls.filter(([name]) => name === 'download').length, 1);
  f.put('file.txt', Buffer.from('one'));
  assert.equal(await store.hash('file.txt'), digest('one'));
  const downloads = f.calls.filter(([name]) => name === 'download').length;
  assert.equal(await store.hash('file.txt'), digest('one'));
  assert.equal(f.calls.filter(([name]) => name === 'download').length, downloads);
  f.put('file.txt', Buffer.from('two'));
  assert.equal(await store.hash('file.txt'), digest('two'));
});

test('initialization failures close the service; interrupted reads clean up temporary files', async t => {
  const f = await fixture(t);
  class Broken extends f.Service { async mount() { throw new Error('mount failed'); } }
  await assert.rejects(() => f.open({}, { Engine: Broken }), /mount failed/);
  assert.equal(f.calls.filter(([name]) => name === 'close').length, 1);
  await assert.rejects(() => f.open({ jobId: 'not-a-subscription' }), /本人网盘/);
  const controller = new AbortController(), store = await f.open({ signal: controller.signal });
  f.put('file.txt', Buffer.from('bytes')); f.services.at(-1).failDownload = true;
  await assert.rejects(() => store.hash('file.txt'), /interrupted/);
  assert.deepEqual(await fs.readdir(f.scratch), ['service-data']);
  controller.abort();
  await assert.rejects(() => store.hash('file.txt'), { name: 'AbortError' });
});

const vendor = path.join(__dirname, '..', 'vendor', `${process.platform}-${process.arch}`);
test('closing a maintenance session aborts outstanding provider requests', async t => {
  const f = await fixture(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  class WaitingClient extends f.Client {
    async list(_fid, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        entered();
      });
    }
  }
  const store = await f.open({}, { Quark: WaitingClient });
  const reading = assert.rejects(() => store.hash('file.txt'), { name: 'AbortError' });
  await started; await store.close(); await reading;
});

const haveVendor = require('node:fs').existsSync(path.join(vendor, 'openlist' + (process.platform === 'win32' ? '.exe' : '')));
test('real embedded maintenance service uploads, verifies and moves synthetic files', { skip: !haveVendor, timeout: 60000 }, async t => {
  const f = await fixture(t), source = path.join(f.root, 'cloud');
  await fs.mkdir(source);
  f.job.source.fid = source;
  await fs.writeFile(path.join(f.profile, 'subscriptions.json'), JSON.stringify({ jobs: [f.job] }));
  let engine;
  class LocalService extends Engine {
    constructor(options) { super(options); engine = this; }
    async mount(_job, fid, signal) {
      await this.start(signal);
      await this.localApi('/api/admin/storage/create', { mount_path: '/fixture', driver: 'Local', order: 0, cache_expiration: 0,
        addition: JSON.stringify({ root_folder_path: fid, thumbnail: false, show_hidden: true }) }, signal);
      return '/fixture';
    }
  }
  class LocalListing {
    async list(folder) {
      assert.ok(folder === source || folder.startsWith(source + path.sep));
      return Promise.all((await fs.readdir(folder, { withFileTypes: true })).map(async item => {
        const full = path.join(folder, item.name), stat = await fs.stat(full);
        return { file_name: item.name, file: item.isFile(), fid: item.isDirectory() ? full : String(stat.ino),
          size: stat.size, updated_at: Math.round(stat.mtimeMs) };
      }));
    }
    async mkdir(folder, name) {
      assert.ok(folder === source || folder.startsWith(source + path.sep));
      const full = path.join(folder, name); await fs.mkdir(full); return full;
    }
  }
  const store = await f.open({ write: true }, { Engine: LocalService, Quark: LocalListing });
  const file = path.join(f.root, 'new.txt'); await fs.writeFile(file, 'synthetic maintenance bytes');
  await store.mkdir('incoming'); await store.mkdir('accepted');
  await store.upload(file, 'incoming/new.txt');
  assert.equal(await store.hash('incoming/new.txt'), digest('synthetic maintenance bytes'));
  await store.move('incoming/new.txt', 'accepted/new.txt');
  assert.equal(await store.hash('incoming/new.txt'), null);
  assert.equal(await store.hash('accepted/new.txt'), digest('synthetic maintenance bytes'));
  assert.equal(await fs.readFile(path.join(source, 'accepted', 'new.txt'), 'utf8'), 'synthetic maintenance bytes');
  await store.close(); assert.equal(engine.children.size, 0);
});

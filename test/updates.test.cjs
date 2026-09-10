'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { crc32 } = require('node:zlib');
const { EventEmitter } = require('node:events');
const { electronFetcher } = require('../src/update-network.cjs');
const { target, assetName, REPOSITORY, TARGETS, PRODUCT } = require('../src/platforms.cjs');
const { Updater, newer, releaseAsset, githubFetch, RELEASES } = require('../src/updater.cjs');
const { writeLayout, readLayout, inside, validatePlan } = require('../src/update-layout.cjs');
const { applyUpdate } = require('../src/update-worker.cjs');
const { extractZip } = require('../src/update-zip.cjs');
const { startup, desktopEntry } = require('../src/desktop.cjs');

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quark-update-test-'));
  t.after(async () => { assert(inside(os.tmpdir(), root)); assert(path.basename(root).startsWith('quark-update-test-')); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
// Small stored ZIP fixtures let us exercise malformed paths without running a packager.
function zip(entries, utf8 = true) {
  const locals = [], central = []; let offset = 0;
  for (const { name, content, mode = 0o100644 } of entries) {
    const data = Buffer.from(content), filename = Buffer.from(name), local = Buffer.alloc(30), dir = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(utf8 ? 0x800 : 0, 6);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(0x314, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(utf8 ? 0x800 : 0, 8);
    dir.writeUInt32LE(crc32(data), 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(filename.length, 28);
    dir.writeUInt32LE((mode << 16) >>> 0, 38); dir.writeUInt32LE(offset, 42);
    locals.push(local, filename, data); central.push(dir, filename); offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function release(version, platform, arch, size = 100) {
  const name = assetName(version, platform, arch), tag = 'v' + version;
  return { tag_name: tag, draft: false, prerelease: false, assets: [name, name + '.sha256'].map((name, i) => ({ name, size: i ? 200 : size, browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(name)}` })) };
}
async function payload(root, version, platform = process.platform, arch = process.arch) {
  const spec = target(platform, arch); await fs.mkdir(path.dirname(path.join(root, spec.executable)), { recursive: true });
  await fs.writeFile(path.join(root, spec.executable), version, { mode: 0o755 });
  await writeLayout(root, platform, arch, version); return spec;
}

test('stable versions compare numerically and releases select all five native assets', () => {
  assert.equal(assetName('1.2.0', 'win32', 'x64'), 'QuarkTimedSync-1.2.0-Windows-x64-portable.zip');
  assert(newer('v1.10.0', '1.9.9')); assert(!newer('v1.1.0', '1.1.0')); assert(!newer('1.0.9', '1.1.0'));
  for (const key of Object.keys(TARGETS)) {
    const [platform, arch] = key.split('-'), data = release('1.2.0', platform, arch);
    assert.equal(releaseAsset(data, '1.1.0', platform, arch).name, assetName('1.2.0', platform, arch));
    assert.equal(releaseAsset({ ...data, prerelease: true }, '1.1.0', platform, arch), null);
    assert.equal(releaseAsset(data, '2.0.0', platform, arch), null);
    assert.throws(() => releaseAsset({ ...data, assets: [data.assets[0]] }, '1.1.0', platform, arch), /完整更新包/);
    data.assets[0].browser_download_url = 'https://example.com/update.zip';
    assert.throws(() => releaseAsset(data, '1.1.0', platform, arch), /完整更新包/);
  }
});

test('GitHub download redirects cannot leave the allowed HTTPS hosts', async () => {
  let calls = 0, aborted = false;
  const net = { request(options) {
    calls++; assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    const request = new EventEmitter(); request.setHeader = () => {};
    request.abort = () => { aborted = true; request.emit('close'); };
    request.end = () => queueMicrotask(() => request.emit('redirect', 302, 'GET', 'https://example.com/evil.zip'));
    return request;
  } };
  await assert.rejects(() => githubFetch(electronFetcher(net), RELEASES), /不属于 GitHub/);
  assert.equal(calls, 1); assert(aborted);
});

test('ZIP extraction rejects traversal, duplicate files and escaping symlinks', async t => {
  const root = await temporary(t);
  const bad = [ [{ name: '../escaped', content: 'bad' }], [{ name: 'a', content: '1' }, { name: 'a', content: '2' }], [{ name: 'dir/link', content: '../../outside', mode: 0o120777 }] ];
  for (let i = 0; i < bad.length; i++) {
    const file = path.join(root, i + '.zip'); await fs.writeFile(file, zip(bad[i]));
    await assert.rejects(() => extractZip(file, path.join(root, 'output-' + i)));
  }
  await assert.rejects(() => fs.access(path.join(root, 'escaped')));
});

test('download, checksum verification, extraction and ready state survive restart', async t => {
  const root = await temporary(t), source = path.join(root, 'source'), dataDir = path.join(root, 'profile');
  const platform = process.platform, arch = process.arch, spec = await payload(source, '1.2.0');
  const layout = await readLayout(source, platform, arch, '1.2.0');
  const prefix = spec.folder + (platform === 'darwin' ? '/' + PRODUCT + '.app' : '');
  const entries = await Promise.all(layout.files.map(async name => ({ name: prefix + '/' + name, content: await fs.readFile(path.join(source, name)) })));
  const archive = zip(entries), metadata = release('1.2.0', platform, arch, archive.length);
  let requests = 0;
  const fetcher = async url => {
    requests++;
    if (url === RELEASES) return new Response(JSON.stringify(metadata));
    if (url.endsWith('.sha256')) return new Response(crypto.createHash('sha256').update(archive).digest('hex') + '  ' + assetName('1.2.0', platform, arch));
    return new Response(archive);
  };
  const updater = new Updater({ dataDir, version: '1.1.0', packaged: true, fetcher });
  await updater.init(); assert.equal(requests, 0, 'updates are opt-in');
  await updater.check(); assert.equal(updater.state.phase, 'ready'); assert.equal(requests, 3);
  await updater.check(); assert.equal(requests, 3, 'do not redownload a prepared update');
  const resumed = new Updater({ dataDir, version: '1.1.0', packaged: true, fetcher });
  await resumed.init(); assert.equal(resumed.state.phase, 'ready'); assert.equal(requests, 3);
});

test('a corrupted download never reaches ready state or touches the installed app', async t => {
  const root = await temporary(t), installRoot = path.join(root, 'installed'), dataDir = path.join(root, 'profile');
  const spec = await payload(installRoot, '1.1.0');
  const metadata = release('1.2.0', process.platform, process.arch, 3);
  const updater = new Updater({ dataDir, version: '1.1.0', packaged: true, execPath: path.join(installRoot, spec.executable), fetcher: async url =>
    new Response(url === RELEASES ? JSON.stringify(metadata) : url.endsWith('.sha256') ? '0'.repeat(64) + '  ' + metadata.assets[0].name : 'bad') });
  await updater.init(); await assert.rejects(() => updater.check(), /SHA-256/);
  assert.equal(updater.state.phase, 'error'); assert.equal(updater.ready, null);
  assert.equal(await fs.readFile(path.join(installRoot, spec.executable), 'utf8'), '1.1.0');
});

test('Mac UTF-8 ZIP names remain readable by the updater after packaging', async t => {
  const root = await temporary(t), file = path.join(root, 'mac.zip'), name = '夸克网盘定时同步.app/Contents/MacOS/夸克网盘定时同步';
  await fs.writeFile(file, zip([{ name, content: 'binary', mode: 0o100755 }], false));
  await extractZip(file, path.join(root, 'before'));
  await assert.rejects(() => fs.access(path.join(root, 'before', name)));
  await require('../scripts/zip-utf8.cjs').markUtf8(file);
  await extractZip(file, path.join(root, 'after'));
  assert.equal(await fs.readFile(path.join(root, 'after', name), 'utf8'), 'binary');
});

test('disabling automatic updates aborts the active request', async t => {
  const dataDir = await temporary(t); let aborted = false;
  const updater = new Updater({ dataDir, version: '1.1.0', fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  await updater.init(); updater.enable(true); const pending = updater.pending; updater.enable(false); await pending;
  assert(aborted); assert.equal(updater.state.phase, 'idle'); assert.equal(updater.enabled, false); await updater.stop();
});

async function updatePlan(t) {
  const root = await temporary(t), id = crypto.randomUUID();
  const plan = { id, parentPid: process.pid, platform: process.platform, arch: process.arch, oldVersion: '1.1.0', version: '1.2.0',
    installRoot: path.join(root, 'installed'), incoming: path.join(root, '.quark-update-next-' + id), backup: path.join(root, '.quark-update-previous-' + id), work: path.join(root, 'work') };
  await payload(plan.installRoot, plan.oldVersion); await payload(plan.incoming, plan.version); return plan;
}
test('installation swaps only the application directory and retains a recovery copy', async t => {
  const plan = await updatePlan(t), outside = path.join(path.dirname(plan.installRoot), 'archive.txt');
  await fs.writeFile(outside, 'keep');
  await applyUpdate(plan, async () => ({ pid: 1 }));
  await readLayout(plan.installRoot, plan.platform, plan.arch, plan.version);
  await readLayout(plan.backup, plan.platform, plan.arch, plan.oldVersion);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
});
test('failed launch restores the old app and attempts to reopen it', async t => {
  const plan = await updatePlan(t), launches = [];
  await assert.rejects(() => applyUpdate(plan, async (_plan, updated) => { launches.push(updated); if (updated) throw new Error('launch failed'); }), /launch failed/);
  await readLayout(plan.installRoot, plan.platform, plan.arch, plan.oldVersion);
  assert.deepEqual(launches, [true, false]); await assert.rejects(() => fs.access(plan.backup));
});
test('unmanaged user files, wrong architecture and unsafe plans stop before replacement', async t => {
  const plan = await updatePlan(t);
  await fs.writeFile(path.join(plan.installRoot, 'my-document.txt'), 'preserve');
  await assert.rejects(() => applyUpdate(plan, async () => {}), /额外文件/);
  assert.equal(await fs.readFile(path.join(plan.installRoot, 'my-document.txt'), 'utf8'), 'preserve');
  // Always choose a different CPU; darwin/x64 is valid on an Intel Mac runner.
  const wrongArch = plan.arch === 'x64' ? 'arm64' : 'x64';
  await assert.rejects(() => readLayout(plan.incoming, plan.platform, wrongArch, '1.2.0'));
  assert.throws(() => validatePlan({ ...plan, backup: path.dirname(plan.installRoot) }), /allowed scope/);
});
test('Linux login startup round-trips quoted paths and only removes its own entry', async t => {
  const root = await temporary(t), settings = startup({ platform: 'linux', execPath: '/home/user/My app "$`%/同步', icon: '/home/user/My app/icon.png', configHome: root });
  assert.equal(settings.get(), false); assert.equal(settings.set(true), true);
  const file = path.join(root, 'autostart', 'quark-timed-sync.desktop'), text = await fs.readFile(file, 'utf8');
  assert(text.includes('%%')); assert(text.includes('\\\\$')); assert(text.includes(' --background'));
  const other = path.join(root, 'autostart', 'other.desktop'); await fs.writeFile(other, 'keep');
  assert.equal(settings.set(false), false); assert.equal(await fs.readFile(other, 'utf8'), 'keep');
  assert.throws(() => desktopEntry('/tmp/bad\nExec=other', '/icon'), /不支持/);
});

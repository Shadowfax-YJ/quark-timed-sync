'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PluginManager, validatePlugin, invoke } = require('../src/plugins.cjs');
const { Engine } = require('../src/engine.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sync-plugin-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'plugin.cjs');
  await fs.writeFile(script, `let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
    const r=JSON.parse(input); if (JSON.stringify(r).includes('cookie')) process.exit(2);
    console.log(JSON.stringify({protocol_version:1,event_id:r.event_id,status:'ok',message:r.input.outcome}));});`);
  const config = { id: 'fixture', version: '1', command: [process.execPath, script], timeout_seconds: 2 };
  const job = { id: 'test-job', name: 'Test', destination: path.join(root, 'destination'),
    source: { kind: 'drive', fid: '0', cookie: 'never-pass' }, interval: 5, plugins: [config] };
  await fs.mkdir(job.destination);
  return { root, config, job };
}

test('durable events recover after restart; duplicate delivery and plugin upgrade are independent', async t => {
  const { root, job } = await fixture(t);
  let manager = new PluginManager({ dataDir: root, getJobs: () => [job] });
  await manager.init();
  await manager.settled(job, { outcome: 'success', run_id: 'same-run' });
  const count = manager.events.size;
  await manager.settled(job, { outcome: 'success', run_id: 'same-run' });
  assert.equal(manager.events.size, count);
  const first = [...manager.events.values()][0]; await manager.save({ ...first, status: 'running' });
  await manager.close();
  manager = new PluginManager({ dataDir: root, getJobs: () => [job] });
  await manager.init(); await manager.pump();
  assert.equal(manager.status(job.id)[0].status, 'ok');
  job.plugins[0].version = '2';
  await manager.retry(job.id); await manager.pump();
  assert.equal(manager.status(job.id)[0].version, '2');
  await manager.close();
});

test('zero-new, partial failure and cancellation all settle without changing transfer outcome', async t => {
  const { root, job } = await fixture(t);
  const events = [];
  const engine = new Engine({ dataDir: root, quark: { list: async () => [] },
    update: () => {}, persist: async () => {}, notify: () => {},
    plugins: { settled: async (_, event) => events.push(event) } });
  await engine.run(job); assert.equal(events.at(-1).outcome, 'success');
  assert.equal(job.lastCount, 0);
  engine.quark.list = async () => { throw new Error('offline'); };
  await engine.run(job); assert.equal(events.at(-1).outcome, 'partial_failure');
  engine.quark.list = async () => { engine.stop(); return []; };
  await engine.run(job); assert.equal(events.at(-1).outcome, 'cancelled');
  engine.plugins.settled = async () => { throw new Error('plugin storage offline'); };
  engine.quark.list = async () => [];
  await engine.run(job); assert.equal(job.lastError, '');
});

test('timeout, malformed protocol and unavailable executable return retry; no shell', async t => {
  const { root, config } = await fixture(t);
  const request = { event_id: 'test', input: { outcome: 'success' } };
  const missing = { ...config, command: [path.join(root, 'missing-program.exe')] };
  assert.equal((await invoke(missing, request)).status, 'retry');
  const slow = { ...config, command: [process.execPath, '-e', 'setTimeout(()=>{},30000)'], timeout_seconds: 1 };
  assert.equal((await invoke(slow, request)).status, 'retry');
  const wrong = { ...config, command: [process.execPath, '-e', 'console.log("{}")'] };
  assert.equal((await invoke(wrong, request)).status, 'retry');
  assert.throws(() => validatePlugin({ ...config, command: ['relative.exe'] }));
});

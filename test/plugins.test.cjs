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

test('plugin progress is decoded across UTF-8 chunks and bound to this invocation', async t => {
  const { config } = await fixture(t);
  const script = `let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
    const r=JSON.parse(input);
    process.stderr.write('PLUGIN_PROGRESS '+JSON.stringify({event_id:'other',message:'wrong event'})+'\\n');
    process.stderr.write('PLUGIN_PROGRESS '+JSON.stringify({event_id:r.event_id,invocation_id:'old-attempt',message:'stale'})+'\\n');
    process.stderr.write('PLUGIN_PROGRESS {invalid}\\n');
    const b=Buffer.from('PLUGIN_PROGRESS '+JSON.stringify({event_id:r.event_id,invocation_id:r.invocation_id,message:'快照对象：12/100'})+'\\n');
    const split=b.indexOf(Buffer.from('快'))+1;process.stderr.write(b.subarray(0,split));
    setTimeout(()=>{process.stderr.write(b.subarray(split));console.log(JSON.stringify({protocol_version:1,event_id:r.event_id,status:'ok',message:'done'}));},30);
  });`;
  const received = [];
  const result = await invoke({ ...config, command: [process.execPath, '-e', script] },
    { event_id: 'progress-test', invocation_id: 'attempt-1' }, undefined, value => received.push(value));
  assert.equal(result.status, 'ok');
  assert.deepEqual(received.map(value => value.message), ['快照对象：12/100']);
});

test('running progress wins over a later queued rescan and an earlier retry message', async t => {
  const { root, job } = await fixture(t);
  const manager = new PluginManager({ dataDir: root, getJobs: () => [job] });
  t.after(() => manager.close());
  await manager.init();
  const first = [...manager.events.values()][0];
  await manager.save({ ...first, status: 'running', startedAt: Date.now() - 10000,
    progress: { message: '快照对象：12/100', updatedAt: Date.now() }, result: { message: '插件执行已取消，等待重试' } });
  await manager.settled(job, { outcome: 'success', run_id: 'new-files' });
  const state = manager.status(job.id)[0];
  assert.equal(state.status, 'running');
  assert.equal(state.message, '快照对象：12/100');
  assert.equal(state.pending, 1);
  assert.ok(state.elapsedSeconds >= 10);
});

test('restart folds legacy duplicate pending scans into one and does not add another', async t => {
  const { root, job } = await fixture(t);
  let manager = new PluginManager({ dataDir: root, getJobs: () => [job] });
  await manager.init();
  const first = [...manager.events.values()][0];
  await manager.save({ ...first, status: 'running', attempts: 1 });
  await manager.save({ ...first, key: 'a'.repeat(64), createdAt: first.createdAt + 1, status: 'queued' });
  await manager.close();
  manager = new PluginManager({ dataDir: root, getJobs: () => [job] });
  t.after(() => manager.close());
  await manager.init();
  const pending = [...manager.events.values()].filter(e => ['queued', 'retry', 'running'].includes(e.status));
  assert.equal(pending.length, 1);
  await manager.pump();
  assert.equal(manager.status(job.id)[0].status, 'ok');
  assert.equal(manager.status(job.id)[0].pending, 0);
});

test('multiple arrivals during a run keep one follow-up scan with the latest input', async t => {
  const { root, job } = await fixture(t);
  const manager = new PluginManager({ dataDir: root, getJobs: () => [job] });
  t.after(() => manager.close());
  await manager.init();
  const first = [...manager.events.values()][0];
  await manager.save({ ...first, status: 'running' });
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    manager.settled(job, { outcome: 'success', run_id: 'new-' + i })));
  const pending = [...manager.events.values()].filter(e => ['queued', 'retry'].includes(e.status));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request.input.run_id, 'new-4');
  assert.equal(manager.events.get(first.key).status, 'running');
});

test('real child progress is visible and persisted before completion; cancellation merges follow-up', async t => {
  const { root, config, job } = await fixture(t);
  const script = `let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
    const r=JSON.parse(input);process.stderr.write('PLUGIN_PROGRESS '+JSON.stringify({event_id:r.event_id,message:'校验对象：25/100'})+'\\n');
    setInterval(()=>{},1000);
  });`;
  job.plugins = [{ ...config, command: [process.execPath, '-e', script], timeout_seconds: 10 }];
  const manager = new PluginManager({ dataDir: root, getJobs: () => [job] });
  t.after(() => manager.close());
  await manager.init();
  const pumping = manager.pump();
  const deadline = Date.now() + 5000;
  while (manager.status(job.id)[0].message !== '校验对象：25/100' && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  const state = manager.status(job.id)[0];
  assert.equal(state.status, 'running'); assert.equal(state.pending, 0);
  assert.equal(state.message, '校验对象：25/100');
  const event = [...manager.events.values()].find(e => e.status === 'running');
  const persisted = JSON.parse(await fs.readFile(path.join(root, 'plugins/outbox', event.key + '.json'), 'utf8'));
  assert.equal(persisted.progress.message, state.message);
  assert.equal(persisted.result, null);
  await manager.settled(job, { outcome: 'success', run_id: 'arrived-during-check' });
  manager.cancel(job.id); await pumping;
  const waiting = [...manager.events.values()].filter(e => ['queued', 'retry'].includes(e.status));
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].request.input.run_id, 'arrived-during-check');
});

'use strict';
// Maintenance entry point. Run with Electron; credentials stay in this process.
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const { prepareMaintenanceProfile, openRevisionStore } = require('../src/maintenance.cjs');
const { publishRevision } = require('../src/revision-publisher.cjs');
const { parseApproval, checkBatch, publishApproval } = require('../src/approval-feed.cjs');
const { RECORDS } = require('../src/revisions.cjs');
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
// Scope optional proxy bypass to this maintenance process and the provider's
// API/object hosts; never change the user's system proxy or GUI profile.
if (args.includes('--direct-upload')) {
  const noProxy = [process.env.NO_PROXY || process.env.no_proxy || '',
    'localhost', '127.0.0.1', '.quark.cn', '.uc.cn', '.aliyuncs.com'].filter(Boolean).join(',');
  process.env.NO_PROXY = noProxy; process.env.no_proxy = noProxy;
}
const context = prepareMaintenanceProfile(app);
let store;
app.whenReady().then(async () => {
  const approvalOnly = args.includes('--approval-only');
  if (!args.includes('--job') || (approvalOnly && !args.includes('--approval-feed')) ||
      (!approvalOnly && !args.includes('--batch') && (!args.includes('--record') || !args.includes('--package'))))
    throw new Error('用法：electron scripts/publish-revision.cjs --job 订阅ID (--batch 批次.json | --record 修订.json --package 修订.zip) [--publish]');
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
  const concurrency = args.includes('--workers') ? Number(arg('--workers')) : 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('发布并发需在 1 到 4 之间');
  store = await openRevisionStore({ ...context, safeStorage, jobId: arg('--job'),
    write: args.includes('--publish') && !args.includes('--diagnose'), nativeUpload: args.includes('--native-upload'),
    progress: value => value.phase === 'upload'
      ? console.log(new Date().toISOString(), value.path, value.message) : console.log(JSON.stringify(value)),
    diagnostic: message => console.error(message) });
  if (args.includes('--diagnose')) {
    console.log(JSON.stringify(store.diagnose()));
    await store.close(); app.exit(0); return;
  }
  if (args.includes('--publish') && !approvalOnly) {
    for (const folderName of ['.sync-revisions/objects', '.sync-revisions/staging', RECORDS, '.sync-recycle']) await store.mkdir(folderName);
  }
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
  await store.close(); app.exit(0);
}).catch(async error => { console.error(error.message); await store?.close(); app.exit(1); });

'use strict';
// Apply only published revisions for one configured drive subscription.
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises'), syncFs = require('node:fs');
const path = require('node:path'), os = require('node:os');
const { Quark } = require('../src/quark.cjs');
const { Engine } = require('../src/engine.cjs');
const args = process.argv.slice(2), index = args.indexOf('--job');
const profile = path.join(app.getPath('appData'), 'Archive Subscriptions');
const scratch = syncFs.mkdtempSync(path.join(os.tmpdir(), 'quark-apply-revisions-'));
app.setPath('userData', scratch);
syncFs.copyFileSync(path.join(profile, 'Local State'), path.join(scratch, 'Local State'));
let engine;
app.whenReady().then(async () => {
  const cfg = JSON.parse(await fs.readFile(path.join(profile, 'subscriptions.json'), 'utf8'));
  const job = index >= 0 && cfg.jobs.find(j => j.id === args[index + 1]);
  if (!job || job.source.kind !== 'drive') throw new Error('请用 --job 指定本人网盘目录订阅');
  const quark = new Quark(JSON.parse(safeStorage.decryptString(await fs.readFile(path.join(profile, 'credentials.bin')))));
  engine = new Engine({ dataDir: path.join(scratch, 'service-data'), vendorDir: path.join(__dirname, '..', 'vendor', `${process.platform}-${process.arch}`),
    quark, update(_id, state) { if (state.current) console.log(state.current); }, async persist() {}, notify() {} });
  await fs.mkdir(engine.dataDir, { recursive: true });
  const signal = new AbortController().signal;
  const first = await engine.applyRevisions(job, job.source.fid, quark, signal);
  console.log(JSON.stringify({ pass: 1, updated: first.updated, paths: [...first.paths] }));
  if (args.includes('--verify-repeat')) {
    const second = await engine.applyRevisions(job, job.source.fid, quark, signal);
    if (second.updated !== 0) throw new Error('重复同步仍有修订写入');
    console.log(JSON.stringify({ pass: 2, updated: second.updated }));
  }
  await engine.close(); app.exit(0);
}).catch(async error => { console.error(error.message); await engine?.close(); app.exit(1); });

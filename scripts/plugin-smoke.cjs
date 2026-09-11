'use strict';
// Explicit local command smoke test, without launching Electron or a cloud client.
const fs = require('node:fs/promises');
const path = require('node:path');
const { PluginManager, validatePlugin } = require('../src/plugins.cjs');
const { Engine } = require('../src/engine.cjs');
(async () => {
  const [configPath, destination, dataDir] = process.argv.slice(2);
  const plugin = validatePlugin(JSON.parse(await fs.readFile(configPath, 'utf8')));
  const job = { id: 'local-smoke', name: 'Local smoke', destination: path.resolve(destination),
    source: { kind: 'drive', fid: '0' }, interval: 5, plugins: [plugin] };
  const manager = new PluginManager({ dataDir: path.resolve(dataDir), getJobs: () => [job] });
  await manager.init();
  try {
    const engine = new Engine({ dataDir, quark: { list: async () => [] },
      update: () => {}, persist: async () => {}, notify: () => {}, plugins: manager });
    await engine.run(job); // Zero-new sync must still validate the already-downloaded dataset.
    await manager.pump();
    const result = manager.status(job.id)[0];
    console.log(JSON.stringify(result));
    if (result.status !== 'ok') process.exitCode = 1;
  } finally { await manager.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

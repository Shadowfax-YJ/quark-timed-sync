'use strict';
// Windows-only integration check: copy Electron into disposable old/new apps.
// No product archive is built and no real user profile is opened.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { PRODUCT, target } = require('../src/platforms.cjs');
const { writeLayout, inside } = require('../src/update-layout.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function main() {
  if (process.platform !== 'win32') throw new Error('This integration fixture tests Windows executable locking');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quark-runtime-update-'));
  const dataDir = path.join(root, 'profile'), id = crypto.randomUUID(), work = path.join(dataDir, 'updates', id);
  const spec = target('win32', 'x64'), installRoot = path.join(root, 'installed'), payload = path.join(work, 'extracted', spec.folder);
  const runtime = path.dirname(require('electron'));
  console.log('Testing in disposable directory: ' + root);
  const updaterSource = path.resolve(__dirname, '../src/updater.cjs');
  for (const [directory, version] of [[installRoot, '1.1.0'], [payload, '1.2.0']]) {
    await fs.cp(runtime, directory, { recursive: true });
    await fs.rename(path.join(directory, 'electron.exe'), path.join(directory, PRODUCT + '.exe'));
    const appDir = path.join(directory, 'resources', 'app'); await fs.mkdir(appDir);
    await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'quark-update-fixture', version, main: 'main.cjs' }));
    await fs.writeFile(path.join(appDir, 'main.cjs'), `
const { app } = require('electron');
const fs = require('node:fs/promises');
const { Updater } = require(${JSON.stringify(updaterSource)});
app.setName('Quark Update Fixture'); app.setPath('userData', ${JSON.stringify(dataDir)});
app.whenReady().then(async () => {
  const updater = new Updater({ dataDir: ${JSON.stringify(dataDir)}, version: ${JSON.stringify(version)}, packaged: true });
  await updater.init(process.argv.find(x => x.startsWith('--update-id='))?.slice(12));
  if (${JSON.stringify(version)} === '1.1.0') {
    updater.ready = ${JSON.stringify({ id, version: '1.2.0', work, payload })};
    await updater.prepareInstall([${JSON.stringify(dataDir)}]);
  } else await fs.writeFile(${JSON.stringify(path.join(dataDir, 'new-version-started'))}, 'ok');
  app.quit();
}).catch(async error => { await fs.writeFile(${JSON.stringify(path.join(dataDir, 'fixture-error'))}, error.stack); app.exit(1); });
`);
    await writeLayout(directory, 'win32', 'x64', version);
  }
  const child = spawn(path.join(installRoot, spec.executable), [], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const deadline = Date.now() + 90000; let status;
  while (Date.now() < deadline) {
    const error = await fs.readFile(path.join(dataDir, 'fixture-error'), 'utf8').catch(() => ''); if (error) throw new Error(error);
    status = await fs.readFile(path.join(work, 'status.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (status?.phase === 'complete') break;
    if (status?.phase === 'error' || status?.phase === 'rolled-back') throw new Error(JSON.stringify(status));
    await sleep(250);
  }
  if (status?.phase !== 'complete') throw new Error('Update fixture timed out; inspect ' + root);
  if (await fs.readFile(path.join(dataDir, 'new-version-started'), 'utf8') !== 'ok') throw new Error('New version did not run');
  await require('../src/update-layout.cjs').readLayout(installRoot, 'win32', 'x64', '1.2.0');
  for (let i = 0; i < 40 && alive(status.workerPid); i++) await sleep(250);
  if (alive(status.workerPid)) throw new Error('Worker did not exit; inspect ' + root);
  if (!inside(os.tmpdir(), root) || !path.basename(root).startsWith('quark-runtime-update-')) throw new Error('Unsafe fixture cleanup path');
  // Windows can retain the just-exited fixture's executable mapping briefly,
  // even after the updater helper has finished. Retry only owned temp cleanup.
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log('PASS: real Windows helper replaced the unlocked app, launched the new version, received its boot acknowledgement and removed the recovery copy.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

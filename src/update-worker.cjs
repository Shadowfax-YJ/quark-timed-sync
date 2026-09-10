'use strict';
// Runs with ELECTRON_RUN_AS_NODE from an independent runtime copy, after exit.
const fs = require('./update-fs.cjs').promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { target } = require('./platforms.cjs');
const { validatePlan, readLayout, removeOwned } = require('./update-layout.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function rename(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(from, to); }
    catch (error) { if (attempt >= 39 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; await sleep(125); }
  }
}
async function launch(plan, updated) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(plan.installRoot, target(plan.platform, plan.arch).executable), updated ? ['--update-id=' + plan.id] : [], { cwd: plan.installRoot, detached: true, windowsHide: true, stdio: 'ignore', env });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref(); return child;
}
async function applyUpdate(plan, start = launch) {
  validatePlan(plan);
  let moved = false, replaced = false;
  try {
    await readLayout(plan.installRoot, plan.platform, plan.arch, plan.oldVersion);
    await readLayout(plan.incoming, plan.platform, plan.arch, plan.version);
    if (await exists(plan.backup)) throw new Error('Recovery directory already exists');
    await rename(plan.installRoot, plan.backup); moved = true;
    await rename(plan.incoming, plan.installRoot); replaced = true;
    return await start(plan, true);
  } catch (error) {
    if (replaced) await rename(plan.installRoot, plan.incoming);
    if (moved) await rename(plan.backup, plan.installRoot);
    await start(plan, false).catch(() => {});
    throw error;
  }
}
async function main(plan) {
  validatePlan(plan);
  const status = data => fs.writeFile(path.join(plan.work, 'status.json'), JSON.stringify({ ...data, workerPid: process.pid }));
  try {
    await fs.writeFile(path.join(plan.work, 'worker-ready'), JSON.stringify({ id: plan.id, pid: process.pid }));
    const deadline = Date.now() + 120000;
    while (alive(plan.parentPid)) {
      if (await exists(path.join(plan.work, 'cancel'))) return;
      if (Date.now() > deadline) throw new Error('程序未退出，更新没有执行');
      await sleep(250);
    }
    if (await exists(path.join(plan.work, 'cancel'))) return;
    const child = await applyUpdate(plan);
    for (let i = 0; i < 240; i++) {
      if (await fs.readFile(path.join(plan.work, 'boot-ok'), 'utf8').catch(() => '') === plan.version) {
        await readLayout(plan.backup, plan.platform, plan.arch, plan.oldVersion);
        await removeOwned(path.dirname(plan.backup), plan.backup);
        await status({ phase: 'complete' }); return;
      }
      if (!alive(child.pid)) {
        await readLayout(plan.installRoot, plan.platform, plan.arch, plan.version);
        await rename(plan.installRoot, plan.incoming); await rename(plan.backup, plan.installRoot);
        await launch(plan, false); await status({ phase: 'rolled-back', error: '新版启动失败，已恢复原版本' }); return;
      }
      await sleep(250);
    }
    await status({ phase: 'error', error: '新版未确认启动成功，原程序保留在 ' + plan.backup });
  } catch (error) { await status({ phase: 'error', error: error.message }); }
}
if (require.main === module) fs.readFile(process.argv[2], 'utf8').then(JSON.parse).then(main).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { applyUpdate, main };

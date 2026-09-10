'use strict';
const fs = require('./update-fs.cjs').promises;
const path = require('node:path');
const { APP_ID, target } = require('./platforms.cjs');
function inside(root, file) { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); }
function relativeFile(value) {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f]/.test(value) || value.startsWith('/') || value.split('/').some(x => !x || x === '.' || x === '..' || /[. ]$/.test(x))) throw new Error('更新包包含不安全的文件路径');
  return value;
}
async function inventory(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), rel = path.relative(root, file).split(path.sep).join('/');
      relativeFile(rel);
      if (entry.isSymbolicLink()) {
        const link = await fs.readlink(file);
        if (path.isAbsolute(link) || !inside(root, path.resolve(dir, link))) throw new Error('更新目录包含指向外部的符号链接');
        files.push(rel);
      } else if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.push(rel);
      else throw new Error('更新目录包含不支持的文件类型');
    }
  }
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('请从实际程序目录更新，不支持符号链接目录');
  await walk(root); return files.sort();
}
async function readLayout(root, platform, arch, version) {
  const spec = target(platform, arch);
  const data = JSON.parse(await fs.readFile(path.join(root, spec.manifest), 'utf8'));
  const universal = platform === 'darwin' && data.arch === 'universal' && ['x64', 'arm64', 'universal'].includes(arch)
    && Array.isArray(data.architectures) && data.architectures.length === 2 && data.architectures.includes('x64') && data.architectures.includes('arm64');
  if (data.schema !== 1 || data.appId !== APP_ID || data.platform !== platform || !(universal || (data.arch === arch && arch !== 'universal')) || data.version !== version || data.executable !== spec.executable || !Array.isArray(data.files)) throw new Error('更新包的应用、版本或芯片信息不匹配');
  const listed = new Set(data.files.map(relativeFile));
  if (!listed.has(spec.executable) || !listed.has(spec.manifest)) throw new Error('更新包清单不完整');
  const actual = await inventory(root);
  if (actual.length !== listed.size || actual.some(x => !listed.has(x))) throw new Error('程序目录中有额外文件或缺少组件，请将程序与下载文件分开存放后再更新');
  return data;
}
async function writeLayout(root, platform, arch, version) {
  const spec = target(platform, arch), file = path.join(root, spec.manifest);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{}');
  const data = { schema: 1, appId: APP_ID, platform, arch, ...(arch === 'universal' ? { architectures: ['x64', 'arm64'] } : {}), version, executable: spec.executable, files: await inventory(root) };
  await fs.writeFile(file, JSON.stringify(data, null, 2)); return data;
}
function validatePlan(plan) {
  if (!/^[0-9a-f-]{36}$/.test(plan.id) || !Number.isSafeInteger(plan.parentPid) || plan.parentPid < 1) throw new Error('Invalid update plan');
  const parent = path.dirname(plan.installRoot);
  for (const file of [plan.installRoot, plan.incoming, plan.backup, plan.work]) if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error('Update paths must be absolute');
  if (plan.installRoot === path.parse(plan.installRoot).root || plan.incoming !== path.join(parent, '.quark-update-next-' + plan.id) || plan.backup !== path.join(parent, '.quark-update-previous-' + plan.id) || inside(plan.installRoot, plan.work)) throw new Error('Update directories are outside the allowed scope');
  target(plan.platform, plan.arch);
}
async function removeOwned(root, file) {
  if (!inside(root, file) || path.resolve(file) !== file) throw new Error('Refusing to remove a directory outside update storage');
  // rm does not traverse a symlink at its root, but reject one explicitly.
  const stat = await fs.lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error('Refusing to remove an update symlink');
  await fs.rm(file, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
module.exports = { inside, relativeFile, inventory, readLayout, writeLayout, validatePlan, removeOwned };

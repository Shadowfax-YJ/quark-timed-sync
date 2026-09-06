'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { abortError } = require('./quark.cjs');

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}
function safeName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name)
      || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error(`文件名无法安全保存到 Windows / Mac：${String(name).slice(0, 100)}`);
  }
  return name;
}
async function statOrNull(file) {
  try { return await fs.lstat(file); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
async function validateDestination(destination) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('请选择有效的本地文件夹');
  const root = path.parse(destination).root;
  if (path.resolve(destination) === root) throw new Error('请选择磁盘中的一个文件夹，不能直接使用磁盘根目录');
  let current = root;
  for (const part of path.relative(root, destination).split(path.sep)) {
    current = path.join(current, part);
    const stat = await statOrNull(current);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('目标文件夹不可用，或路径含符号链接；请重新选择实际文件夹');
  }
  await fs.access(destination, require('node:fs').constants.W_OK);
}
async function prepareFiles(client, fid, destination, signal, progress = () => {}) {
  await validateDestination(destination);
  const files = []; let skipped = 0; let totalBytes = 0;
  const seenIds = new Set(); const seenPaths = new Set();
  async function walk(parent, relative, depth) {
    if (signal?.aborted) throw abortError();
    if (depth > 100 || seenIds.has(parent)) throw new Error('云端目录层级异常');
    seenIds.add(parent);
    const items = await client.list(parent, signal);
    for (const item of items) {
      const name = safeName(item.file_name);
      const rel = relative ? relative + '/' + name : name;
      const canonical = rel.normalize('NFC').toLowerCase();
      if (seenPaths.has(canonical)) throw new Error(`存在仅大小写或 Unicode 形式不同的重名文件：${rel}`);
      seenPaths.add(canonical);
      const local = path.join(destination, ...rel.split('/'));
      const stat = await statOrNull(local);
      if (stat?.isSymbolicLink()) throw new Error(`本地路径含符号链接：${rel}`);
      const directory = item.dir === true || item.file === false || item.file_type === 0;
      if (directory) {
        if (stat && !stat.isDirectory()) throw new Error(`本地同名路径不是文件夹：${rel}`);
        await walk(item.fid, rel, depth + 1);
      } else {
        if (stat && !stat.isFile()) throw new Error(`本地同名路径不是普通文件：${rel}`);
        if (stat) skipped++;
        else { files.push(rel); totalBytes += Number(item.size) || 0; }
      }
      progress({ phase: 'checking', discovered: files.length, skipped, totalBytes, current: rel });
    }
  }
  await walk(fid, '', 0);
  return { files, skipped, totalBytes };
}

// Copy missing cloud entries only. Existing directories are revisited so later
// additions inside an old folder are discovered. No update/delete APIs exist here.
async function reconcileShare(client, share, sourceRoot, targetRoot, signal, progress = () => {}) {
  const visited = new Set(); let saved = 0;
  async function walk(source, target, depth) {
    if (depth > 100 || visited.has(source)) throw new Error('分享目录层级异常');
    visited.add(source);
    const from = await client.list(source, signal, share);
    const to = await client.list(target, signal);
    const targetNames = new Map(to.map(x => [x.file_name, x]));
    const names = new Set();
    const missing = [];
    for (const item of from) {
      safeName(item.file_name);
      const key = item.file_name.normalize('NFC').toLowerCase();
      if (names.has(key)) throw new Error('分享目录含无法在本地区分的重名文件');
      names.add(key);
      const existing = targetNames.get(item.file_name);
      const isDir = item.dir === true || item.file === false || item.file_type === 0;
      if (!existing) missing.push(item);
      else {
        const existingDir = existing.dir === true || existing.file === false || existing.file_type === 0;
        if (isDir !== existingDir) throw new Error(`转存目录存在同名的不同类型条目：${item.file_name}`);
        if (isDir) await walk(item.fid, existing.fid, depth + 1);
      }
    }
    for (let i = 0; i < missing.length; i += 50) {
      if (signal?.aborted) throw abortError();
      const batch = missing.slice(i, i + 50);
      await client.saveFiles(share, batch, target, source, signal);
      saved += batch.length;
      progress({ phase: 'saving', saved, current: batch[0].file_name });
    }
  }
  await walk(sourceRoot, targetRoot, 0);
  return saved;
}
function copyArgs(source, destination, filesFile) {
  return ['copy', source, destination, '--config', '', '--files-from-raw', filesFile,
    '--ignore-existing', '--no-update-dir-modtime', '--transfers', '2', '--checkers', '4',
    '--multi-thread-streams', '2', '--multi-thread-chunk-size', '10M', '--tpslimit', '4',
    '--retries', '3', '--retries-sleep', '10s', '--low-level-retries', '3',
    '--contimeout', '20s', '--timeout', '2m', '--stats', '1s', '--stats-log-level', 'NOTICE',
    '--use-json-log', '--log-level', 'INFO'];
}
module.exports = { atomicJson, safeName, statOrNull, validateDestination, prepareFiles, reconcileShare, copyArgs };

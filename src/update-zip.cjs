'use strict';
const yauzl = require('yauzl');
const fs = require('./update-fs.cjs').promises;
const { createWriteStream } = require('./update-fs.cjs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { inside, relativeFile } = require('./update-layout.cjs');
async function extractZip(file, destination, signal) {
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, strictFileNames: true }, (error, result) => error ? reject(error) : resolve(result)));
  const links = [], seen = new Set(); let count = 0, total = 0;
  await fs.mkdir(destination, { recursive: false });
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', entry => { (async () => {
        signal?.throwIfAborted();
        if (++count > 50000 || (total += entry.uncompressedSize) > 4 * 1024 ** 3) throw new Error('更新包解压大小超出限制');
        const directory = entry.fileName.endsWith('/'), name = relativeFile(entry.fileName.replace(/\/$/, ''));
        // Apple's resource-fork metadata is not part of the application payload.
        if (name === '__MACOSX' || name.startsWith('__MACOSX/')) { zip.readEntry(); return; }
        const key = process.platform === 'linux' ? name : name.toLowerCase();
        if (seen.has(key)) throw new Error('更新包包含重复文件'); seen.add(key);
        const output = path.join(destination, name), mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if (directory) { await fs.mkdir(output, { recursive: true }); zip.readEntry(); return; }
        await fs.mkdir(path.dirname(output), { recursive: true });
        const stream = await new Promise((done, fail) => zip.openReadStream(entry, (e, s) => e ? fail(e) : done(s)));
        if ((mode & 0o170000) === 0o120000) {
          if (entry.uncompressedSize > 4096) throw new Error('更新包的符号链接无效');
          const chunks = []; for await (const chunk of stream) chunks.push(chunk);
          const link = Buffer.concat(chunks).toString('utf8');
          if (/[\x00-\x1f\\]/.test(link) || path.isAbsolute(link) || !inside(destination, path.resolve(path.dirname(output), link))) throw new Error('更新包的符号链接越界');
          links.push({ output, link });
        } else {
          if ((mode & 0o170000) && (mode & 0o170000) !== 0o100000) throw new Error('更新包文件类型不受支持');
          await pipeline(stream, createWriteStream(output, { flags: 'wx', mode: (mode & 0o777) || 0o644 }), { signal });
        }
        zip.readEntry();
      })().catch(reject); });
      zip.readEntry();
    });
    // Links are created last so no extracted regular file can traverse one.
    for (const { output, link } of links) { signal?.throwIfAborted(); await fs.symlink(link, output); }
  } finally { zip.close(); }
}
module.exports = { extractZip };

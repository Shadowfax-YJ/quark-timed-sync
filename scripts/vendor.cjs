'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const versions = { openlist: '4.2.6', rclone: '1.75.1' };
async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}
async function findFile(dir, name) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = await findFile(file, name); if (found) return found; }
    else if (entry.name === name) return file;
  }
}
async function main() {
  const platform = process.platform, arch = process.arch;
  if (!['win32', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported build host');
  const osName = platform === 'win32' ? 'windows' : 'darwin', cpu = arch === 'x64' ? 'amd64' : 'arm64';
  const destination = path.join(root, 'vendor', `${platform}-${arch}`);
  await fs.mkdir(destination, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'archive-vendor-'));
  const specifications = [
    { name: 'openlist', file: `openlist-${osName}-${cpu}.${platform === 'win32' ? 'zip' : 'tar.gz'}`,
      base: `https://github.com/OpenListTeam/OpenList/releases/download/v${versions.openlist}/`,
      sha256: { 'win32-x64': '10d24913f86843e347eefac219c61224628bbd5d3c7443b2ee119c168a8cb3b9',
        'darwin-arm64': '36bc448b66a34cfea4cc8a5729775baab51194c4f17a685ab1364fc1735005b7' }[`${platform}-${arch}`] },
    { name: 'rclone', file: `rclone-v${versions.rclone}-${platform === 'darwin' ? 'osx' : osName}-${cpu}.zip`,
      base: `https://downloads.rclone.org/v${versions.rclone}/`, sums: 'SHA256SUMS' }
  ];
  for (const item of specifications) {
    if (platform === 'darwin' && item.name === 'rclone') {
      // The upstream macOS binary was linked with a newer deployment target.
      // Build the unchanged pinned module without cgo for macOS 12 support.
      execFileSync('go', ['install', '-trimpath', '-ldflags', `-s -w -X github.com/rclone/rclone/fs.Version=v${versions.rclone}`,
        `github.com/rclone/rclone@v${versions.rclone}`], {
        stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0', MACOSX_DEPLOYMENT_TARGET: '12.0',
          GOTOOLCHAIN: 'local', GOSUMDB: 'sum.golang.org', GOBIN: destination }
      });
      console.log(`Built rclone ${versions.rclone} from checksum-verified upstream Go module for macOS 12`);
      continue;
    }
    const zip = path.join(scratch, item.file), sumsPath = path.join(scratch, item.name + '-sums.txt');
    await download(item.base + item.file, zip);
    let expected = item.sha256;
    if (item.sums) {
      await download(item.base + item.sums, sumsPath);
      const sums = await fs.readFile(sumsPath, 'utf8');
      expected = sums.split(/\r?\n/).find(line => line.trim().endsWith(item.file))?.match(/[a-fA-F0-9]{64}/)?.[0]?.toLowerCase();
    }
    const actual = crypto.createHash('sha256').update(await fs.readFile(zip)).digest('hex');
    if (!expected || expected !== actual) throw new Error(`SHA256 mismatch: ${item.file}`);
    const extract = path.join(scratch, item.name); await fs.mkdir(extract);
    // bsdtar ships with current Windows and macOS; its ZIP handling preserves files.
    execFileSync('tar', ['-xf', zip, '-C', extract], { stdio: 'inherit', windowsHide: true });
    const binary = item.name + (platform === 'win32' ? '.exe' : '');
    const source = await findFile(extract, binary); if (!source) throw new Error('Missing binary: ' + binary);
    await fs.copyFile(source, path.join(destination, binary));
    if (platform !== 'win32') await fs.chmod(path.join(destination, binary), 0o755);
    console.log(`Verified ${item.name} ${versions[item.name]} ${platform}/${arch}`);
  }
  await fs.writeFile(path.join(destination, 'versions.json'), JSON.stringify(versions, null, 2));
  // All archives are created beneath this unique task-owned temp directory.
  if (path.basename(scratch).startsWith('archive-vendor-')) await fs.rm(scratch, { recursive: true, force: true });
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });

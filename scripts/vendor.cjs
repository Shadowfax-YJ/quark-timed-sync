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
async function prepare(platform, arch) {
  require('../src/platforms.cjs').target(platform, arch);
  const osName = platform === 'win32' ? 'windows' : platform, cpu = arch === 'x64' ? 'amd64' : 'arm64';
  const destination = path.join(root, 'vendor', `${platform}-${arch}`);
  await fs.mkdir(destination, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'archive-vendor-'));
  const specifications = [
    { name: 'openlist', file: `openlist-${osName}-${cpu}.${platform === 'win32' ? 'zip' : 'tar.gz'}`,
      base: `https://github.com/OpenListTeam/OpenList/releases/download/v${versions.openlist}/`,
      sha256: { 'win32-x64': '10d24913f86843e347eefac219c61224628bbd5d3c7443b2ee119c168a8cb3b9',
        'darwin-arm64': '36bc448b66a34cfea4cc8a5729775baab51194c4f17a685ab1364fc1735005b7',
        'darwin-x64': 'a8bf9e5ea927064daf98aa999f9a19435f9fb98ff2049eebe8d70d3f0aefe8c3',
        'linux-x64': '2f2a5008efe45895292018479cb05556c83e828c3eed68a8b8cd3d35e82f03cb',
        'linux-arm64': 'eed743a0c3b9d67eb3b58b3e5455957a15eb2f4e199c06309fabdbfb0b571904' }[`${platform}-${arch}`] },
    { name: 'rclone', file: `rclone-v${versions.rclone}-${platform === 'darwin' ? 'osx' : osName}-${cpu}.zip`,
      base: `https://downloads.rclone.org/v${versions.rclone}/`, sums: 'SHA256SUMS' }
  ];
  for (const item of specifications) {
    if (platform === 'darwin' && item.name === 'rclone') {
      // The upstream macOS binary was linked with a newer deployment target.
      // Build the unchanged pinned module without cgo for macOS 12 support.
      const env = { ...process.env, CGO_ENABLED: '0', MACOSX_DEPLOYMENT_TARGET: '12.0',
        GOTOOLCHAIN: 'local', GOSUMDB: 'sum.golang.org', GOOS: 'darwin', GOARCH: cpu };
      const module = JSON.parse(execFileSync('go', ['mod', 'download', '-json', `github.com/rclone/rclone@v${versions.rclone}`], { encoding: 'utf8', env }));
      if (module.Error || !module.Dir || !module.Sum) throw new Error('Unable to verify rclone source module');
      execFileSync('go', ['build', '-trimpath', '-ldflags', `-s -w -X github.com/rclone/rclone/fs.Version=v${versions.rclone}`,
        '-o', path.join(destination, 'rclone'), '.'], { cwd: module.Dir, stdio: 'inherit', env });
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
    // GNU tar on Linux cannot read rclone's ZIP archive.
    if (platform === 'linux' && item.file.endsWith('.zip')) execFileSync('unzip', ['-q', zip, '-d', extract], { stdio: 'inherit' });
    else execFileSync('tar', ['-xf', zip, '-C', extract], { stdio: 'inherit', windowsHide: true });
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
async function main() {
  const platform = process.platform, arch = process.env.ARCHIVE_BUILD_ARCH || (platform === 'darwin' ? 'universal' : process.arch);
  if (platform !== 'darwin' || arch !== 'universal') return prepare(platform, arch);
  for (const cpu of ['x64', 'arm64']) await prepare(platform, cpu);
  const destination = path.join(root, 'vendor', 'darwin-universal'); await fs.mkdir(destination, { recursive: true });
  for (const name of ['openlist', 'rclone']) {
    const output = path.join(destination, name);
    execFileSync('lipo', ['-create', path.join(root, 'vendor', 'darwin-x64', name), path.join(root, 'vendor', 'darwin-arm64', name), '-output', output], { stdio: 'inherit' });
    await fs.chmod(output, 0o755);
    execFileSync('lipo', [output, '-verify_arch', 'x86_64', 'arm64'], { stdio: 'inherit' });
  }
  await fs.writeFile(path.join(destination, 'versions.json'), JSON.stringify(versions, null, 2));
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });

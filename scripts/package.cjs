'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { packager } = require('@electron/packager');
const root = path.join(__dirname, '..');
async function main() {
  const platform = process.platform, arch = process.arch, version = require('../package.json').version;
  const name = require('../package.json').productName;
  const vendor = path.join(root, 'vendor', `${platform}-${arch}`);
  for (const name of ['openlist', 'rclone']) await fs.access(path.join(vendor, name + (platform === 'win32' ? '.exe' : '')));
  const outputs = await packager({
    dir: root, out: path.join(root, 'out'), name, executableName: name,
    appBundleId: 'local.archive.subscriptions', appVersion: version, buildVersion: version,
    platform, arch, electronVersion: require('../package.json').devDependencies.electron,
    asar: true, overwrite: true, prune: true,
    icon: path.join(root, 'assets', platform === 'darwin' ? 'icon.icns' : 'icon.ico'),
    ignore: [/^\/out(?:\/|$)/, /^\/vendor(?:\/|$)/, /^\/test(?:\/|$)/, /^\/test-output(?:\/|$)/,
      /^\/scripts(?:\/|$)/, /^\/\.runtime(?:\/|$)/, /^\/\.git(?:\/|$)/, /^\/package-lock\.json$/],
    extraResource: [vendor],
    ...(platform === 'darwin' ? { extendInfo: { LSMinimumSystemVersion: '12.0', NSHighResolutionCapable: true,
      NSDownloadsFolderUsageDescription: '将订阅中的新增文件下载到您选择的文件夹。',
      NSDocumentsFolderUsageDescription: '将订阅中的新增文件下载到您选择的文件夹。' } } : {})
  });
  const appDir = outputs[0];
  const resources = platform === 'darwin' ? path.join(appDir, name + '.app', 'Contents', 'Resources') : path.join(appDir, 'resources');
  await fs.rename(path.join(resources, `${platform}-${arch}`), path.join(resources, 'vendor'));
  for (const name of ['README-便携版.txt', 'THIRD_PARTY.md', 'LICENSE']) await fs.copyFile(path.join(root, name), path.join(appDir, name));
  await fs.cp(path.join(root, 'licenses'), path.join(appDir, 'licenses'), { recursive: true });
  if (platform === 'darwin') {
    const bundle = path.join(appDir, name + '.app');
    await require('./macos-compat.cjs').verifyMacOS12(bundle);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  }
  const archive = `QuarkTimedSync-${version}-${platform === 'darwin' ? 'macOS-AppleSilicon' : 'Windows-x64'}-portable.zip`;
  const zip = path.join(root, 'out', archive);
  if (platform === 'darwin') execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appDir, zip], { stdio: 'inherit' });
  else {
    await fs.unlink(zip).catch(error => { if (error.code !== 'ENOENT') throw error; });
    // Windows tar can lose Chinese paths under an English system code page.
    // .NET uses Unicode paths and stores UTF-8 entry names in the ZIP.
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:QUARK_PACKAGE_DIRECTORY, $env:QUARK_PACKAGE_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $true)'],
    { stdio: 'inherit', windowsHide: true, env: { ...process.env, QUARK_PACKAGE_DIRECTORY: appDir, QUARK_PACKAGE_ZIP: zip } });
  }
  const hash = crypto.createHash('sha256').update(await fs.readFile(zip)).digest('hex');
  await fs.writeFile(zip + '.sha256', `${hash}  ${archive}\n`);
  console.log(JSON.stringify({ archive: zip, directory: appDir, sha256: hash }));
}
main().catch(err => { console.error(err); process.exitCode = 1; });

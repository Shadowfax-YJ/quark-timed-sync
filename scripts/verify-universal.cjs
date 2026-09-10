'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractZip } = require('../src/update-zip.cjs');
const { readLayout } = require('../src/update-layout.cjs');
const { target, PRODUCT, assetName } = require('../src/platforms.cjs');
async function main() {
  const version = require('../package.json').version;
  const source = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
  const file = path.join(source, assetName(version, 'darwin', 'universal'));
  await extractZip(file, output);
  const bundle = path.join(output, target('darwin', 'universal').folder, PRODUCT + '.app');
  await readLayout(bundle, 'darwin', process.arch, version);
  await require('./macos-compat.cjs').verifyMacOS12(bundle, 'universal');
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  await fs.writeFile(path.join(path.dirname(output), 'universal-layout.json'), JSON.stringify({ ok: true, version, hostArch: process.arch, packageArch: 'universal' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

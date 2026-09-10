'use strict';
const PRODUCT = '夸克网盘定时同步';
const APP_ID = 'local.archive.subscriptions';
const REPOSITORY = 'Shadowfax-YJ/quark-timed-sync';
const TARGETS = {
  'win32-x64': 'Windows-x64', 'darwin-arm64': 'macOS-AppleSilicon',
  'darwin-x64': 'macOS-Intel', 'linux-x64': 'Linux-x64', 'linux-arm64': 'Linux-ARM64'
};
function target(platform, arch) {
  const label = TARGETS[`${platform}-${arch}`];
  if (!label) throw new Error('此系统或芯片暂不支持便携包更新');
  return { label, folder: `${PRODUCT}-${platform}-${arch}`,
    executable: platform === 'darwin' ? `Contents/MacOS/${PRODUCT}` : PRODUCT + (platform === 'win32' ? '.exe' : ''),
    manifest: platform === 'darwin' ? 'Contents/Resources/update-manifest.json' : 'resources/update-manifest.json' };
}
// Keep the public release filenames stable; the executable name stays Chinese.
function assetName(version, platform, arch) { return `QuarkTimedSync-${version}-${target(platform, arch).label}-portable.zip`; }
module.exports = { PRODUCT, APP_ID, REPOSITORY, TARGETS, target, assetName };

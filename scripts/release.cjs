'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { REPOSITORY, assetName } = require('../src/platforms.cjs');
const { checksumValue, releaseAsset } = require('../src/updater.cjs');
const TARGETS = [['win32', 'x64'], ['darwin', 'universal'], ['linux', 'x64'], ['linux', 'arm64']];

function gh(args, optional = false) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (optional && result.stderr.trim() === 'release not found') return null;
    throw new Error(result.stderr || `gh exited ${result.status}`);
  }
  return result.stdout;
}
function validateBuild(run, workflow, packageVersion, tag, repository = REPOSITORY) {
  if (!/^v\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(tag) || tag !== 'v' + packageVersion) throw new Error('Tag does not match the built package version');
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
      || run.workflow_id !== workflow.id || run.head_branch !== 'main'
      || !['push', 'workflow_dispatch'].includes(run.event)
      || run.status !== 'completed' || run.conclusion !== 'success'
      || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error('Expected a successful Portable builds run from this repository main branch');
}
function verifyRemote(release, expected, sha, tag, complete = false) {
  if (release.tagName !== tag || release.targetCommitish !== sha || release.isPrerelease) throw new Error('Existing release does not match the verified build');
  const byName = new Map(expected.map(file => [file.name, file]));
  const seen = new Set();
  for (const asset of release.assets) {
    const file = byName.get(asset.name);
    if (!file || seen.has(asset.name) || asset.state !== 'uploaded' || asset.size !== file.size || asset.digest !== 'sha256:' + file.sha256) throw new Error(`Unexpected or mismatched release asset: ${asset.name}`);
    seen.add(asset.name);
  }
  if (complete && seen.size !== expected.length) throw new Error('Release attachments are incomplete');
  return expected.filter(file => !seen.has(file.name));
}
async function checksum(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of require('node:fs').createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function main() {
  const runId = process.env.RELEASE_RUN_ID, tag = process.env.RELEASE_TAG;
  if (!/^\d+$/.test(runId || '') || !/^v\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(tag || '')) throw new Error('Invalid build ID or release tag');
  const api = endpoint => JSON.parse(gh(['api', `repos/${REPOSITORY}/${endpoint}`]));
  const run = api(`actions/runs/${runId}`), workflow = api('actions/workflows/portable.yml');
  if (!/^[a-f0-9]{40}$/.test(run.head_sha || '')) throw new Error('Invalid build commit');
  const source = api(`contents/package.json?ref=${run.head_sha}`);
  const version = JSON.parse(Buffer.from(source.content, 'base64').toString('utf8')).version;
  validateBuild(run, workflow, version, tag);
  const notes = path.join(__dirname, '../docs/releases', tag + '.md');
  await fs.access(notes);
  console.log(`Verified ${tag}: build ${runId}, commit ${run.head_sha}`);
  if (process.argv.includes('--check-build')) return;

  const root = path.resolve(process.env.RELEASE_ASSET_DIR || 'release-assets');
  const expected = [];
  for (const [platform, arch] of TARGETS) {
    const name = assetName(version, platform, arch);
    const label = name.slice(('QuarkTimedSync-' + version + '-').length, -'-portable.zip'.length);
    const artifact = path.join(root, 'QuarkTimedSync-' + label);
    const archive = path.join(artifact, 'out', name), sidecar = archive + '.sha256';
    const archiveHash = await checksum(archive);
    if (checksumValue(await fs.readFile(sidecar, 'utf8'), name) !== archiveHash) throw new Error(`Checksum mismatch: ${name}`);
    const smoke = JSON.parse(await fs.readFile(path.join(artifact, 'test-output/smoke-result.json'), 'utf8'));
    if (!smoke.ok || smoke.version !== version || smoke.platform !== platform
        || smoke.arch !== (arch === 'universal' ? 'arm64' : arch)) throw new Error(`Packaged smoke result mismatch: ${name}`);
    for (const file of [archive, sidecar]) expected.push({ path: file, name: path.basename(file), size: (await fs.stat(file)).size, sha256: file === archive ? archiveHash : await checksum(file) });
  }
  const readRelease = () => {
    const raw = gh(['release', 'view', tag, '--repo', REPOSITORY, '--json', 'tagName,targetCommitish,isDraft,isPrerelease,assets,url'], true);
    return raw === null ? null : JSON.parse(raw);
  };
  let release = readRelease();
  if (!release) {
    gh(['release', 'create', tag, '--repo', REPOSITORY, '--target', run.head_sha, '--title', tag, '--notes-file', notes, '--draft']);
    release = readRelease();
  }
  const missing = verifyRemote(release, expected, run.head_sha, tag);
  if (!release.isDraft && missing.length) throw new Error('Refusing to modify an incomplete public release');
  if (missing.length) gh(['release', 'upload', tag, ...missing.map(file => file.path), '--repo', REPOSITORY]);
  release = readRelease();
  verifyRemote(release, expected, run.head_sha, tag, true);
  if (release.isDraft) gh(['release', 'edit', tag, '--repo', REPOSITORY, '--notes-file', notes, '--draft=false', '--latest']);
  const latest = api('releases/latest');
  if (latest.tag_name !== tag || latest.draft || latest.prerelease) throw new Error('Published version is not the latest stable release');
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    if (releaseAsset(latest, '0.0.0', platform, arch)?.version !== version) throw new Error('Updater cannot resolve release assets');
  }
  console.log(`Published and verified 8 assets: ${latest.html_url}`);
}
module.exports = { validateBuild, verifyRemote };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

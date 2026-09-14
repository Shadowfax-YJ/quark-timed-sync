'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateBuild, verifyRemote } = require('../scripts/release.cjs');
const repository = 'Shadowfax-YJ/quark-timed-sync';
const sha = 'a'.repeat(40);
const run = { repository: { full_name: repository }, head_repository: { full_name: repository }, workflow_id: 12, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', head_sha: sha };
test('release requires the successful build and its exact package version', () => {
  validateBuild(run, { id: 12 }, '1.4.1', 'v1.4.1');
  for (const changed of [{ conclusion: 'failure' }, { status: 'in_progress' }, { head_branch: 'other' }, { event: 'pull_request' }, { workflow_id: 13 }, { head_repository: { full_name: 'other/repo' } }]) {
    assert.throws(() => validateBuild({ ...run, ...changed }, { id: 12 }, '1.4.1', 'v1.4.1'));
  }
  assert.throws(() => validateBuild(run, { id: 12 }, '1.4.0', 'v1.4.1'));
});
const files = [{ name: 'one.zip', size: 8, sha256: '1'.repeat(64) }, { name: 'one.zip.sha256', size: 75, sha256: '2'.repeat(64) }];
const uploaded = file => ({ name: file.name, size: file.size, digest: 'sha256:' + file.sha256, state: 'uploaded' });
const draft = { tagName: 'v1.4.1', targetCommitish: sha, isDraft: true, isPrerelease: false, assets: [uploaded(files[0])] };
test('partial draft resumes only missing assets without replacing valid uploads', () => {
  assert.deepEqual(verifyRemote(draft, files, sha, 'v1.4.1'), [files[1]]);
  assert.throws(() => verifyRemote(draft, files, sha, 'v1.4.1', true));
  assert.deepEqual(verifyRemote({ ...draft, assets: files.map(uploaded) }, files, sha, 'v1.4.1', true), []);
});
test('conflicting assets or a different release commit block publication', () => {
  for (const changed of [{ targetCommitish: 'b'.repeat(40) }, { tagName: 'v1.4.0' }, { isPrerelease: true },
    ...[{ digest: 'sha256:wrong' }, { size: 9 }, { state: 'starter' }, { name: 'unexpected.zip' }].map(change => ({ assets: [{ ...uploaded(files[0]), ...change }] })),
    { assets: [uploaded(files[0]), uploaded(files[0])] }]) assert.throws(() => verifyRemote({ ...draft, ...changed }, files, sha, 'v1.4.1'));
});

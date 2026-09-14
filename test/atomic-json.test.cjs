'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { atomicJson } = require('../src/model.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'quark-atomic-json-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'progress.json');
  await fs.writeFile(target, JSON.stringify({ version: 'old' }));
  return { root, target };
}

test('atomic JSON replacement survives a transient Windows reader lock without removing the old file', async t => {
  const { root, target } = await fixture(t), rename = fs.rename;
  let attempts = 0;
  fs.rename = async (from, to) => {
    assert.equal(to, target);
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { version: 'old' });
    if (++attempts <= 2) throw Object.assign(new Error('reader denies delete sharing'), { code: 'EPERM' });
    return rename(from, to);
  };
  try { await atomicJson(target, { version: 'new' }); }
  finally { fs.rename = rename; }
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { version: 'new' });
  assert.deepEqual(await fs.readdir(root), ['progress.json']);
});

test('atomic JSON permanent lock and other IO errors preserve the old value and clean only their temp file', async t => {
  for (const code of ['EPERM', 'EIO']) await t.test(code, async t => {
    const { root, target } = await fixture(t), rename = fs.rename;
    let attempts = 0;
    fs.rename = async () => { attempts++; throw Object.assign(new Error('injected ' + code), { code }); };
    try { await assert.rejects(atomicJson(target, { version: 'new' }), { code }); }
    finally { fs.rename = rename; }
    assert(attempts >= 1 && attempts <= 10);
    if (code === 'EIO') assert.equal(attempts, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { version: 'old' });
    assert.deepEqual(await fs.readdir(root), ['progress.json']);
  });
});

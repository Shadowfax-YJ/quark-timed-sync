'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { uploadQuark } = require('../scripts/upload-quark.cjs');

test('maintenance multipart upload sends exact bytes, binds authorization and commits once', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quark-upload-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'input.zip'), bytes = Buffer.from('fixture bytes'); await fs.writeFile(file, bytes);
  const endpoints = [], parts = [];
  const quark = { raw: async (url, { body }) => {
    const endpoint = new URL(url).pathname; endpoints.push(endpoint);
    if (endpoint.endsWith('/pre')) {
      assert.equal(Number.isInteger(body.l_created_at), true); assert.equal(body.pdir_fid, 'parent'); assert.equal(body.size, bytes.length);
      return { code: 0, data: { task_id: 'task', upload_url: 'http://oss-cn-fixture.aliyuncs.com', bucket: 'bucket', obj_key: 'object', upload_id: 'upload', auth_info: 'private', callback: {} }, metadata: { part_size: 4 } };
    }
    if (endpoint.endsWith('/hash')) { assert.equal(body.md5, crypto.createHash('md5').update(bytes).digest('hex')); return { code: 0, data: { finish: false } }; }
    if (endpoint.endsWith('/auth')) { assert.equal(body.task_id, 'task'); assert.match(body.auth_meta, /\/bucket\/object\?/); return { code: 0, data: { auth_key: 'temporary' } }; }
    assert.equal(endpoint.endsWith('/finish'), true); return { code: 0 };
  } };
  await uploadQuark(quark, file, 'parent', 'archive.zip', undefined, () => {}, async (url, method, headers, data) => {
    assert.equal(url.protocol, 'https:'); assert.equal(headers.Authorization, 'temporary');
    if (method === 'PUT') { parts.push(Buffer.from(data)); return { etag: crypto.createHash('md5').update(data).digest('hex') }; }
    assert.equal(method, 'POST'); assert.match(data.toString(), /CompleteMultipartUpload/);
    assert.equal(headers['Content-MD5'], crypto.createHash('md5').update(data).digest('base64')); return {};
  });
  assert.deepEqual(Buffer.concat(parts), bytes); assert.equal(endpoints.filter(p => p.endsWith('/finish')).length, 1);
});

test('maintenance upload refuses an untrusted object host before sending authorization', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quark-upload-host-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'input.zip'); await fs.writeFile(file, 'input');
  const quark = { raw: async url => ({ code: 0, data: url.includes('/pre?') ? { task_id: 'task', upload_url: 'https://foreign.invalid', bucket: 'bucket' } : { finish: false } }) };
  await assert.rejects(() => uploadQuark(quark, file, 'parent', 'file', undefined, () => {}, () => { throw new Error('Must not transmit'); }), /对象域名/);
});

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

test('an already stored part is resumed only after checking its size and content digest', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quark-upload-existing-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'input.zip'), bytes = Buffer.from('input'); await fs.writeFile(file, bytes);
  for (const valid of [true, false]) await t.test(valid ? 'matching stored bytes' : 'conflicting stored bytes', async () => {
    let commits = 0, reads = 0;
    const quark = { raw: async (url, { body }) => {
      if (url.includes('/pre?')) return { code: 0, data: { task_id: 'task', upload_url: 'http://oss-cn-fixture.aliyuncs.com',
        bucket: 'bucket', obj_key: 'object', upload_id: 'upload', auth_info: 'private', callback: {} }, metadata: { part_size: 8 } };
      if (url.includes('/hash?')) return { code: 0, data: { finish: false } };
      if (url.includes('/auth?')) { assert.equal(body.task_id, 'task'); return { code: 0, data: { auth_key: 'temporary' } }; }
      assert.equal(url.includes('/finish?'), true); return { code: 0 };
    } };
    const action = () => uploadQuark(quark, file, 'parent', 'archive.zip', undefined, () => {}, async (url, method, headers, body) => {
      if (method === 'PUT') throw Object.assign(new Error('PartAlreadyExist'), { statusCode: 409, ossCode: 'PartAlreadyExist' });
      if (method === 'GET') {
        reads++; assert.equal(url.searchParams.get('uploadId'), 'upload');
        assert.equal(url.searchParams.get('part-number-marker'), '0');
        const etag = crypto.createHash('md5').update(valid ? bytes : Buffer.from('other')).digest('hex');
        return { body: Buffer.from(`<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>"${etag}"</ETag><Size>${bytes.length}</Size></Part></ListPartsResult>`) };
      }
      assert.equal(method, 'POST'); commits++; return {};
    });
    if (valid) await action(); else await assert.rejects(action, /已有分片 1.*不一致/);
    assert.equal(reads, 1); assert.equal(commits, valid ? 1 : 0);
  });
});

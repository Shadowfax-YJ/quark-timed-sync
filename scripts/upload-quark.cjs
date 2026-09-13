'use strict';
// Maintenance upload transport based on OpenList's quark_uc multipart protocol.
// Explicit byte lengths and bounded requests avoid a hanging WebDAV PUT.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const https = require('node:https');
const crypto = require('node:crypto');
const { delay } = require('../src/quark.cjs');
const OSS_UA = 'aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit';

async function sendObject(url, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
    const req = https.request(url, { method, signal: bounded, headers: { ...headers, 'Content-Length': body.length } }, res => {
      let length = 0; const chunks = [];
      res.on('data', chunk => { length += chunk.length; if (length > 1024 * 1024) req.destroy(new Error('上传响应过大')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`对象存储上传被拒绝（HTTP ${res.statusCode}）`));
        resolve({ etag: res.headers.etag, body: Buffer.concat(chunks) });
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('对象存储上传超时')));
    req.on('error', () => reject(new Error(signal?.aborted ? '上传已取消' : '对象存储上传连接失败或超时')));
    req.end(body);
  });
}

async function uploadQuark(quark, file, parent, name, signal, progress = () => {}, transport = sendObject) {
  const stat = await fs.stat(file), md5 = crypto.createHash('md5'), sha1 = crypto.createHash('sha1');
  for await (const chunk of createReadStream(file)) { if (signal?.aborted) throw new Error('上传已取消'); md5.update(chunk); sha1.update(chunk); }
  const api = async (endpoint, body) => {
    let response;
    try { response = await quark.raw('https://drive-pc.quark.cn/1/clouddrive' + endpoint + '?pr=ucpro&fr=pc', { body, signal }); }
    catch (error) { throw new Error(`${endpoint}: ${error.message}${error.remoteMessage ? ' / ' + error.remoteMessage : ''}`); }
    if (response.code !== 0 || response.status >= 400) throw new Error(`${endpoint} 被拒绝（${response.code}）`);
    return response;
  };
  const mime = name.endsWith('.json') ? 'application/json' : file.toLowerCase().endsWith('.zip') ? 'application/zip' : 'application/octet-stream';
  progress('申请上传');
  const prepared = await api('/file/upload/pre', { ccp_hash_update: true, dir_name: '', file_name: name,
    format_type: mime, l_created_at: Math.trunc(stat.mtimeMs), l_updated_at: Math.trunc(stat.mtimeMs), pdir_fid: parent, size: stat.size });
  const pre = prepared.data;
  if (!pre?.task_id) throw new Error('上传预检缺少任务编号');
  const hashed = await api('/file/update/hash', { md5: md5.digest('hex'), sha1: sha1.digest('hex'), task_id: pre.task_id });
  if (hashed.data?.finish) { await delay(1000, signal); progress('内容复用完成'); return; }
  const host = new URL(pre.upload_url).hostname;
  if (!['.aliyuncs.com', '.quark.cn', '.uc.cn'].some(suffix => host.endsWith(suffix)) || !/^[a-z0-9-]+$/i.test(pre.bucket))
    throw new Error('上传目标不是受支持的夸克对象域名');
  const target = new URL(`https://${pre.bucket}.${host}/${pre.obj_key}`);
  const partSize = prepared.metadata?.part_size;
  if (!Number.isSafeInteger(partSize) || partSize < 1 || partSize > 64 * 1024 * 1024) throw new Error('上传分片大小异常');
  progress(`开始分片上传（${Math.ceil(stat.size / partSize)} 片）`);
  const etags = [], reader = await fs.open(file, 'r');
  try {
    for (let offset = 0, part = 1; offset < stat.size; offset += partSize, part++) {
      const size = Math.min(partSize, stat.size - offset), bytes = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) { const result = await reader.read(bytes, read, size - read, offset + read); if (!result.bytesRead) throw new Error('上传文件被截断'); read += result.bytesRead; }
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const date = new Date().toUTCString();
          const auth = await api('/file/upload/auth', { auth_info: pre.auth_info, task_id: pre.task_id,
            auth_meta: `PUT\n\n${mime}\n${date}\nx-oss-date:${date}\nx-oss-user-agent:${OSS_UA}\n/${pre.bucket}/${pre.obj_key}?partNumber=${part}&uploadId=${pre.upload_id}` });
          if (part === 1 && attempt === 0 && Number.isFinite(auth.data.speed)) progress(`服务端上传速度参数：${auth.data.speed}`);
          const url = new URL(target); url.search = new URLSearchParams({ partNumber: part, uploadId: pre.upload_id });
          result = await transport(url, 'PUT', { Authorization: auth.data.auth_key, 'Content-Type': mime,
            Referer: 'https://pan.quark.cn/', 'x-oss-date': date, 'x-oss-user-agent': OSS_UA }, bytes, signal);
          if (!/^"?[a-f0-9]{32}"?$/i.test(result.etag || '')) throw new Error('上传分片没有有效 ETag');
          break;
        } catch (error) { if (attempt === 2 || signal?.aborted) throw error; await delay(1000 * (attempt + 1), signal); }
      }
      etags.push(result.etag);
      progress(`已上传 ${part}/${Math.ceil(stat.size / partSize)} 片`);
    }
  } finally { await reader.close(); }
  const body = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n' +
    etags.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag}</ETag></Part>\n`).join('') + '</CompleteMultipartUpload>');
  const contentMd5 = crypto.createHash('md5').update(body).digest('base64');
  const callback = Buffer.from(JSON.stringify(pre.callback)).toString('base64'), date = new Date().toUTCString();
  const auth = await api('/file/upload/auth', { auth_info: pre.auth_info, task_id: pre.task_id,
    auth_meta: `POST\n${contentMd5}\napplication/xml\n${date}\nx-oss-callback:${callback}\nx-oss-date:${date}\nx-oss-user-agent:${OSS_UA}\n/${pre.bucket}/${pre.obj_key}?uploadId=${pre.upload_id}` });
  target.search = new URLSearchParams({ uploadId: pre.upload_id });
  await transport(target, 'POST', { Authorization: auth.data.auth_key, 'Content-Type': 'application/xml', 'Content-MD5': contentMd5,
    Referer: 'https://pan.quark.cn/', 'x-oss-callback': callback, 'x-oss-date': date, 'x-oss-user-agent': OSS_UA }, body, signal);
  await api('/file/upload/finish', { obj_key: pre.obj_key, task_id: pre.task_id });
  await delay(1000, signal); progress('上传完成');
}
module.exports = { uploadQuark };

'use strict';
const https = require('node:https');
const crypto = require('node:crypto');
const { CookieJar } = require('tough-cookie');

const API = 'https://drive-pc.quark.cn/1/clouddrive';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
function abortError() { return new DOMException('已停止', 'AbortError'); }
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
function parseShare(text, passcode = '') {
  if (typeof text !== 'string' || text.length > 10000) throw new Error('请粘贴有效的夸克分享链接');
  const found = text.match(/https:\/\/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)(?:\?[^\s，。]*)?/);
  if (!found) throw new Error('只支持 https://pan.quark.cn/s/ 开头的夸克分享链接');
  const url = new URL(found[0]);
  const code = String(passcode || url.searchParams.get('pwd') || text.match(/提取码[：:\s]*([a-zA-Z0-9]+)/)?.[1] || '').trim();
  if (code.length > 32) throw new Error('提取码格式不正确');
  return { id: found[1], url: `https://pan.quark.cn/s/${found[1]}`, passcode: code };
}

class Quark {
  constructor(serialized, save = async () => {}) {
    this.jar = serialized ? CookieJar.deserializeSync(serialized) : new CookieJar();
    this.save = save;
    this.lastRequest = 0;
    this.queue = Promise.resolve();
  }
  async raw(url, { body, signal, redirects = 0 } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !(target.hostname === 'quark.cn' || target.hostname.endsWith('.quark.cn')))
      throw new Error('登录请求地址不属于夸克');
    if (signal?.aborted) throw abortError();
    const cookie = await this.jar.getCookieString(url);
    const result = await new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(target, { method: payload ? 'POST' : 'GET', signal,
        headers: { 'User-Agent': UA, Referer: 'https://pan.quark.cn/', Accept: 'application/json',
          ...(cookie ? { Cookie: cookie } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) }
      }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) { req.destroy(new Error('夸克响应过大')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.setTimeout(30000, () => req.destroy(new Error('网络请求超时，请检查网络后重试')));
      req.on('error', err => reject(signal?.aborted ? abortError() : new Error(err.code === 'ENOTFOUND' ? '无法连接夸克，请检查网络' : '连接夸克失败，请稍后重试')));
      req.end(payload);
    });
    for (const line of result.headers['set-cookie'] || []) await this.jar.setCookie(line, url).catch(() => {});
    await this.save(this.jar.serializeSync());
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (redirects >= 5 || !result.headers.location) throw new Error('夸克登录重定向失败');
      return this.raw(new URL(result.headers.location, url).href, { signal, redirects: redirects + 1 });
    }
    if (result.status !== 200) {
      const error = new Error(`夸克请求失败（HTTP ${result.status}），请检查登录状态或稍后重试`);
      try { const detail = JSON.parse(result.text); error.remoteCode = detail.code; error.remoteMessage = String(detail.message || detail.msg || '').replace(/https?:\/\/\S+/g, '[URL]').replace(/[a-fA-F0-9]{24,}/g, '[ID]').slice(0, 200); } catch {}
      throw error;
    }
    try { return JSON.parse(result.text); } catch { throw new Error('夸克返回了无法识别的响应'); }
  }
  async request(endpoint, params = {}, body, signal) {
    const allowed = ['/file/sort', '/file', '/task', '/share/sharepage/token', '/share/sharepage/detail', '/share/sharepage/save'];
    if (!allowed.includes(endpoint)) throw new Error('不支持的网盘操作');
    const previous = this.queue;
    let release; this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      await delay(Math.max(0, 400 - (Date.now() - this.lastRequest)), signal);
      this.lastRequest = Date.now();
      const url = new URL(API + endpoint);
      url.search = new URLSearchParams({ pr: 'ucpro', fr: 'pc', ...params }).toString();
      const json = await this.raw(url.href, { body, signal });
      if (json.code !== 0 || json.status >= 400) {
        const code = Number(json.code);
        if ([31001, 31002, 41000].includes(code) || json.status === 401) throw new Error('夸克登录已失效，请重新扫码登录');
        if ([32003, 32004].includes(code)) throw new Error('夸克网盘空间不足，无法转存分享中的新增文件');
        if (endpoint.includes('share')) throw new Error(`分享链接无法访问或转存（${code}），请检查链接、提取码、有效期和网盘空间`);
        throw new Error(`夸克请求被拒绝（${code}），请重新登录或稍后重试`);
      }
      return json;
    } finally { release(); }
  }
  async list(fid = '0', signal, share) {
    const all = []; const seen = new Set();
    for (let page = 1; page <= 10000; page++) {
      const json = await this.request(share ? '/share/sharepage/detail' : '/file/sort', {
        pdir_fid: fid, _page: page, _size: 100, _fetch_total: 1,
        _sort: 'file_type:asc,file_name:asc', fetch_all_file: 1,
        ...(share ? { pwd_id: share.id, stoken: share.token, _fetch_share: 1, force: 0, ver: 2 } : {})
      }, undefined, signal);
      const batch = json.data?.list;
      if (share && json.data?.is_owner !== undefined) share.isOwner = Number(json.data.is_owner) === 1;
      if (!Array.isArray(batch)) throw new Error('夸克目录列表格式异常');
      for (const item of batch) {
        if (!item.fid || typeof item.file_name !== 'string') throw new Error('夸克文件信息不完整');
        if (seen.has(item.fid)) throw new Error('网盘目录正在变化，请稍后重新检查');
        seen.add(item.fid); all.push(item);
      }
      const total = json.metadata?._total;
      if (!batch.length || (total !== undefined ? all.length >= total : batch.length < 100)) return all;
    }
    throw new Error('目录条目过多，请选择更小的子目录');
  }
  async cookieHeader() { return this.jar.getCookieString(API); }
  async shareToken(share, signal) {
    const json = await this.request('/share/sharepage/token', {}, { pwd_id: share.id, passcode: share.passcode || '' }, signal);
    if (!json.data?.stoken) throw new Error('未取得分享访问令牌，请检查链接和提取码');
    return { ...share, token: json.data.stoken };
  }
  async mkdir(parent, name, signal) {
    const json = await this.request('/file', {}, { pdir_fid: parent, file_name: name, dir_path: '', dir_init_lock: false }, signal);
    if (!json.data?.fid) throw new Error('无法创建分享转存目录');
    return json.data.fid;
  }
  async saveFiles(share, items, target, sourceParent, signal) {
    if (!items.length) return;
    if (items.some(item => !item.share_fid_token)) throw new Error('分享文件缺少转存令牌，请重新检查分享');
    const json = await this.request('/share/sharepage/save', {}, {
      pwd_id: share.id, stoken: share.token, fid_list: items.map(x => x.fid),
      fid_token_list: items.map(x => x.share_fid_token), to_pdir_fid: target, pdir_fid: sourceParent, scene: 'link'
    }, signal);
    if (!json.data?.task_id) throw new Error('夸克没有返回转存任务编号');
    const deadline = Date.now() + 15 * 60 * 1000;
    for (let retry = 0; Date.now() < deadline; retry++) {
      await delay(1500, signal);
      const result = await this.request('/task', { task_id: json.data.task_id, retry_index: retry }, undefined, signal);
      if (result.data?.status === 2) return;
      if ([3, 4].includes(result.data?.status)) throw new Error('分享转存任务失败或暂停，请检查网盘空间后重试');
    }
    throw new Error('分享转存超时，下次检查会核对已转存内容');
  }
  async beginLogin(signal) {
    const params = { client_id: '532', v: '1.2', request_id: crypto.randomUUID() };
    const result = await this.raw('https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?' + new URLSearchParams(params), { signal });
    const token = result.data?.members?.token;
    if (result.status !== 2000000 || !token) throw new Error('无法生成登录二维码，请稍后重试');
    const url = 'https://su.quark.cn/4_eMHBJ?' + new URLSearchParams({ token, client_id: '532', ssb: 'weblogin', uc_param_str: '', uc_biz_str: 'S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0' });
    return { token, url, params, expiresAt: Date.now() + 180000 };
  }
  async pollLogin(qr, signal) {
    const result = await this.raw('https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?' + new URLSearchParams({ ...qr.params, token: qr.token, request_id: crypto.randomUUID() }), { signal });
    const ticket = result.data?.members?.service_ticket;
    if (result.status !== 2000000 || !ticket) return false;
    await this.raw('https://pan.quark.cn/account/info?' + new URLSearchParams({ st: ticket, lw: 'scan' }), { signal });
    await this.list('0', signal);
    return true;
  }
}
module.exports = { Quark, parseShare, delay, abortError };

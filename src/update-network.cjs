'use strict';
const { Readable } = require('node:stream');
// Chromium supplies system proxy support. Surface redirects as responses so
// githubFetch can validate each destination before any request follows it.
function electronFetcher(net) {
  return (url, { headers = {}, signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const request = net.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false });
    let incoming;
    const abort = () => { incoming?.destroy(signal.reason); request.abort(); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => signal?.removeEventListener('abort', abort));
    request.on('error', error => { incoming?.destroy(error); reject(error); });
    request.on('redirect', (status, _method, location) => {
      resolve(new Response(null, { status, headers: { location } }));
      request.abort();
    });
    request.on('response', response => {
      incoming = response;
      const resultHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) resultHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      response.on('aborted', () => response.destroy(new Error('更新下载连接中断')));
      resolve(new Response([204, 304].includes(response.statusCode) ? null : Readable.toWeb(response), { status: response.statusCode, headers: resultHeaders }));
    });
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    request.end();
  });
}
module.exports = { electronFetcher };

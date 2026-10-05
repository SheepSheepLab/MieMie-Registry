import {REGISTRY_VERSION} from './version.js';
import {createGitHubAuth} from './github-auth.js';
import {githubError, isGitHubError, rateHeaders, rateDeadline, rateError} from './github-upstream-state.js';

const API = 'https://api.github.com';
const hosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
function officialURL(value) {
  let url; try {url = new URL(value);} catch {throw githubError('unsafe_redirect', 'GitHub 下载地址无效');}
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !hosts.has(url.hostname)) throw githubError('unsafe_redirect', 'GitHub 下载重定向来源不允许');
  return url;
}
const cancelled = () => githubError('client_disconnected', '下载请求已取消', 499);

// One instance per server: shared credentials, quota backoff and bounded in-flight
// lookups. Completed response bytes are never cached here. Package bytes and the
// final authoritative release re-read must not supply a shareKey.
export function createGitHubClient({fetchImpl = fetch, auth = createGitHubAuth(), now = Date.now,
  maxFlights = 32, maxFlightBytes = 32 * 1024 * 1024} = {}) {
  const flights = new Map(), active = new Set(); let reserved = 0, blockedUntil = 0, closed = false, failed = false, rateLimit = null, backoffError = null;
  async function request(url, {limit = 1048576, timeout = 15000, binary = false, accept, signal} = {}) {
    if (closed || signal?.aborted) throw cancelled();
    if (blockedUntil > now()) throw backoffError || rateError(blockedUntil);
    const controller = new AbortController(); active.add(controller); let timer, reader, response;
    const abort = () => controller.abort(cancelled());
    signal?.addEventListener('abort', abort, {once: true});
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => {
      void reader?.cancel().catch(() => {});
      reject(isGitHubError(controller.signal.reason) ? controller.signal.reason : cancelled());
    }, {once: true}));
    timer = setTimeout(() => controller.abort(githubError('upstream_timeout', '作者 GitHub 请求超时', 504)), timeout); timer.unref?.();
    const operation = (async () => {
      let current = officialURL(url);
      for (let redirects = 0; ; redirects++) {
        controller.signal.throwIfAborted();
        // Construct each hop independently. Never reuse an authenticated header set.
        const headers = {Accept: binary ? 'application/octet-stream' : accept || 'application/vnd.github+json',
          'User-Agent': 'MieMie-Registry/' + REGISTRY_VERSION, 'X-GitHub-Api-Version': '2022-11-28'};
        if (current.origin === API) {
          if (blockedUntil > now()) throw backoffError || rateError(blockedUntil);
          const token = await auth.getToken(); controller.signal.throwIfAborted();
          if (token) headers.Authorization = `Bearer ${token}`;
        }
        response = await fetchImpl(current.href, {method: 'GET', headers, credentials: 'omit', redirect: 'manual', signal: controller.signal});
        if (controller.signal.aborted) {void response.body?.cancel().catch(() => {}); controller.signal.throwIfAborted();}
        if (response.redirected || (response.url && officialURL(response.url).href !== current.href)) throw githubError('unsafe_redirect', '下载响应地址与已验证路径不一致');
        const rate = rateHeaders(response.headers, now());
        if (current.origin === API && (rate.limit !== null || rate.remaining !== null)) {
          rateLimit = {limit: rate.limit, remaining: rate.remaining, resetAt: rate.resetAt ? new Date(rate.resetAt).toISOString() : null, resource: rate.resource};
          if (rate.remaining === 0) {blockedUntil = Math.max(blockedUntil, rateDeadline(rate, now())); backoffError = rateError(blockedUntil);}
        }
        if (response.status === 401 && current.origin === API) {auth.invalidate(); throw githubError('github_auth_failed', 'GitHub 服务端认证失败');}
        // Conservatively back off on all 403s, including secondary limits without
        // Retry-After. Do not parse or expose upstream error bodies.
        if (response.status === 429 || response.status === 403) {
          blockedUntil = Math.max(blockedUntil, rateDeadline(rate, now()));
          backoffError = response.status === 403 && rate.remaining !== 0 && !rate.retryAt
            ? githubError('github_forbidden', 'GitHub 拒绝此次读取，请稍后重试或检查服务权限', 502, blockedUntil) : rateError(blockedUntil);
          throw backoffError;
        }
        if (![301,302,303,307,308].includes(response.status)) break;
        if (!binary || redirects >= 5 || !response.headers.get('location')) throw githubError('unsafe_redirect', 'GitHub API 或下载重定向无效');
        const next = officialURL(new URL(response.headers.get('location'), current).href);
        void response.body?.cancel().catch(() => {}); response = null; current = next;
      }
      try {
        if (!response.ok) throw githubError(response.status === 404 ? 'not_found' : 'github_unavailable', '作者 GitHub 资源暂时不可公开读取', response.status === 404 ? 400 : 502);
        if (Number(response.headers.get('content-length')) > limit) throw githubError('response_too_large', '作者 GitHub 文件超过大小限制');
        if (!response.body?.getReader) throw githubError('invalid_response', '作者 GitHub 文件不可读取');
        reader = response.body.getReader(); const chunks = []; let length = 0;
        for (;;) {controller.signal.throwIfAborted(); const {done, value} = await reader.read(); controller.signal.throwIfAborted(); if (done) break;
          length += value.byteLength; if (length > limit) throw githubError('response_too_large', '作者 GitHub 文件超过大小限制'); chunks.push(value);}
        failed = false; return {bytes: Buffer.concat(chunks), response};
      } finally {if (reader) void reader.cancel().catch(() => {}); else void response?.body?.cancel().catch(() => {});}
    })();
    try {return await Promise.race([operation, aborted]);}
    catch (error) {if (error.code !== 'client_disconnected') failed = true; if (isGitHubError(error)) throw error; throw githubError('github_unavailable', '无法连接作者 GitHub 服务');}
    finally {clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); if (!reader) void response?.body?.cancel().catch(() => {}); active.delete(controller);}
  }
  async function read(url, options = {}) {
    const {shareKey, signal, limit = 1048576} = options;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 16777216) throw githubError('invalid_request', 'GitHub 响应上限无效');
    if (closed || signal?.aborted) throw cancelled();
    if (!shareKey) return request(url, options);
    const key = JSON.stringify([url, shareKey, limit, options.timeout || 15000, !!options.binary, options.accept || '']);
    let flight = flights.get(key);
    if (!flight) {
      if (flights.size >= maxFlights || reserved + limit > maxFlightBytes) throw githubError('busy', 'GitHub 查询繁忙，请稍后重试', 503);
      flight = {controller: new AbortController(), waiters: 0}; flights.set(key, flight); reserved += limit;
      flight.remove = () => {if (flights.get(key) === flight) {flights.delete(key); reserved -= limit;}};
      flight.promise = request(url, {...options, signal: flight.controller.signal}).finally(flight.remove);
    }
    flight.waiters++;
    let abort;
    const cancellation = new Promise((_, reject) => {abort = () => reject(cancelled()); signal?.addEventListener('abort', abort, {once: true});});
    try {const result = await Promise.race([flight.promise, cancellation]); return {...result, bytes: Buffer.from(result.bytes)};}
    finally {signal?.removeEventListener('abort', abort); if (--flight.waiters === 0) {flight.remove(); flight.controller.abort();}}
  }
  return Object.freeze({read,
    status() {const state = auth.status(); return {...state, state: state.state === 'healthy' && !failed && blockedUntil <= now() && !closed ? 'healthy' : 'degraded',
      rateLimit: rateLimit ? {...rateLimit} : null, retryAt: blockedUntil > now() ? new Date(blockedUntil).toISOString() : null};},
    close() {closed = true; for (const controller of active) controller.abort(); for (const flight of flights.values()) flight.controller.abort(); flights.clear(); reserved = 0; auth.close();},
  });
}

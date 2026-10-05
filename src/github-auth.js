import {createPrivateKey, sign} from 'node:crypto';
import {readFileSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {REGISTRY_VERSION} from './version.js';
import {githubError, isGitHubError, rateHeaders, rateDeadline, rateError} from './github-upstream-state.js';

export function createGitHubAuth({mode = 'anonymous', appId, installationId, privateKeyPath} = {},
  {fetchImpl = fetch, now = Date.now, timeoutMs = 15000, refreshBeforeMs = 60000, releaseRoot = fileURLToPath(new URL('../', import.meta.url))} = {}) {
  if (mode === 'anonymous') return Object.freeze({getToken: async () => null, invalidate() {}, status: () => ({githubAuthMode: 'anonymous', tokenExpiresAt: null, state: 'degraded'}), close() {}});
  if (mode !== 'app' || !/^[1-9]\d{0,19}$/.test(appId || '') || !/^[1-9]\d{0,19}$/.test(installationId || '')) throw Error('GitHub App configuration requires valid App ID and Installation ID');
  let privateKey;
  try {
    if (!isAbsolute(privateKeyPath || '')) throw Error();
    const path = realpathSync(privateKeyPath), root = realpathSync(releaseRoot), rel = relative(root, path);
    if (!rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) throw Error();
    const info = statSync(path);
    if (!info.isFile() || info.size > 16384 || (info.mode & 0o007) || (info.mode & 0o020)) throw Error();
    privateKey = createPrivateKey(readFileSync(path));
    if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails?.modulusLength < 2048) throw Error();
  } catch {throw Error('GitHub App private key must be a readable RSA key outside the release directory with restricted permissions');}
  let token = null, expiresAt = 0, pending = null, blockedUntil = 0, failure = false, closed = false, active, cooldownError;
  const endpoint = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  async function refresh() {
    cooldownError = null;
    const controller = new AbortController(); active = controller; let timer, cancelReader;
    const operation = (async () => {
      const seconds = Math.floor(now() / 1000), encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
      const unsigned = encode({alg: 'RS256', typ: 'JWT'}) + '.' + encode({iat: seconds - 60, exp: seconds + 540, iss: appId});
      const jwt = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
      const response = await fetchImpl(endpoint, {method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: {Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'MieMie-Registry/' + REGISTRY_VERSION, Authorization: `Bearer ${jwt}`},
        body: JSON.stringify({permissions: {contents: 'read'}})});
      if (controller.signal.aborted) {void response.body?.cancel().catch(() => {}); controller.signal.throwIfAborted();}
      if (response.redirected || (response.url && response.url !== endpoint)) throw githubError('github_auth_failed', 'GitHub 服务端认证失败');
      const rate = rateHeaders(response.headers, now());
      if (response.status === 429 || (response.status === 403 && (rate.remaining === 0 || rate.retryAt))) {
        blockedUntil = rateDeadline(rate, now()); cooldownError = rateError(blockedUntil); void response.body?.cancel().catch(() => {}); throw rateError(blockedUntil);
      }
      if (!response.ok || Number(response.headers.get('content-length')) > 32768 || !response.body?.getReader) {
        void response.body?.cancel().catch(() => {}); throw githubError('github_auth_failed', 'GitHub 服务端认证失败');
      }
      const reader = response.body.getReader(), chunks = []; let length = 0;
      cancelReader = () => {void reader.cancel().catch(() => {});}; controller.signal.addEventListener('abort', cancelReader, {once: true});
      try {for (;;) {controller.signal.throwIfAborted(); const {done, value} = await reader.read(); if (done) break; length += value.byteLength;
        if (length > 32768) throw githubError('github_auth_failed', 'GitHub 服务端认证响应无效'); chunks.push(value);}}
      finally {controller.signal.removeEventListener('abort', cancelReader); cancelReader();}
      controller.signal.throwIfAborted();
      let value; try {value = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw githubError('github_auth_failed', 'GitHub 服务端认证响应无效');}
      const expiry = Date.parse(value.expires_at);
      if (typeof value.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.token) || !Number.isFinite(expiry)
        || expiry <= now() + refreshBeforeMs || expiry > now() + 7200000 || value.permissions?.contents !== 'read'
        || Object.entries(value.permissions).some(([k,v]) => !['contents','metadata'].includes(k) || v !== 'read')) throw githubError('github_auth_failed', 'GitHub 服务端认证响应无效');
      if (closed) throw githubError('github_auth_failed', 'GitHub 认证服务已关闭');
      token = value.token; expiresAt = expiry; failure = false; return token;
    })();
    const deadline = new Promise((_, reject) => {timer = setTimeout(() => {reject(githubError('github_auth_failed', 'GitHub 服务端认证超时'));controller.abort();}, timeoutMs); timer.unref?.();});
    const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(githubError('github_auth_failed', 'GitHub 服务端认证已取消')), {once: true}));
    try {return await Promise.race([operation, deadline, cancelled]);}
    catch (error) {failure = true; token = null; expiresAt = 0; blockedUntil = Math.max(blockedUntil, now() + 60000);
      if (isGitHubError(error)) throw error; throw githubError('github_auth_failed', 'GitHub 服务端认证失败');}
    finally {clearTimeout(timer); controller.abort(); if (active === controller) active = null;}
  }
  return Object.freeze({
    async getToken() {
      if (closed) throw githubError('github_auth_failed', 'GitHub 认证服务已关闭');
      if (blockedUntil > now()) throw cooldownError || githubError('github_auth_failed', 'GitHub 服务端认证暂不可用', 503, blockedUntil);
      if (token && expiresAt - now() > refreshBeforeMs) return token;
      if (!pending) pending = refresh().finally(() => {pending = null;});
      return pending;
    },
    invalidate() {cooldownError = null; token = null; expiresAt = 0; failure = true; blockedUntil = Math.max(blockedUntil, now() + 60000);},
    status() {return {githubAuthMode: mode, tokenExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      state: !failure && token && expiresAt > now() && !closed ? 'healthy' : 'degraded'};},
    close() {closed = true; token = null; expiresAt = 0; active?.abort(); privateKey = null;},
  });
}

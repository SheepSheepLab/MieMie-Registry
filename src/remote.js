import {createGitHubClient} from './github-client.js';
import {REGISTRY_VERSION} from './version.js';
// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import {verifyPackage, cleanManifest, validateExtensionPackageMetadata, validatePackageRelease, validatePackageAsset} from './package-validation.js';
export {cleanManifest} from './package-validation.js';
import { fail, plain, githubRepo, version, compareVersions, text } from './validation.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function boundedFetch(fetchImpl, url, { limit = 65536, timeout = 15000, headers = {}, method = 'GET', body, allowAssetRedirect = false } = {}) {
  const controller = new AbortController();
  let timer;
  const operation = (async () => {
    let currentUrl = url, response;
    for (let redirects=0;;redirects++) {
      response = await fetchImpl(currentUrl, { method, body, headers, signal: controller.signal, redirect: allowAssetRedirect ? 'manual' : 'error', credentials: 'omit' });
      if (!allowAssetRedirect || ![301,302,303,307,308].includes(response.status)) break;
      if (redirects >= 5) fail(502,'unsafe_redirect','下载重定向次数过多');
      const location=response.headers.get('location'); if(!location) fail(502,'unsafe_redirect','下载重定向无效');
      const next=new URL(location,currentUrl);
      if (next.protocol !== 'https:' || next.port || next.username || next.password || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) fail(502,'unsafe_redirect','下载重定向来源无效');
      await response.body?.cancel(); currentUrl=next.href;
    }
    if (allowAssetRedirect && response.url) {
      const final = new URL(response.url);
      if (final.protocol !== 'https:' || final.port || final.username || final.password || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(final.hostname)) fail(502, 'unsafe_redirect', '下载重定向来源无效');
    }
    if (!response.ok) fail(response.status === 404 ? 400 : 502, response.status === 404 ? 'not_found' : 'upstream_error', response.status === 404 ? '仓库或资源不存在／不可公开访问' : '上游服务失败或达到请求限额');
    if (Number(response.headers.get('content-length')) > limit) fail(502, 'response_too_large', '上游响应超过限制');
    const chunks = []; let length = 0;
    if (!response.body?.getReader) fail(502, 'invalid_response', '上游响应不可读取');
    const reader = response.body.getReader();
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > limit) { controller.abort(); fail(502, 'response_too_large', '上游响应超过限制'); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    return { bytes: Buffer.concat(chunks), response };
  })();
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); const error = new Error('上游请求超时'); error.status = 504; error.code = 'upstream_timeout'; reject(error); }, timeout); timer.unref?.(); });
  try { return await Promise.race([operation, deadline]); }
  catch(e) { if (e.status) throw e; fail(502, 'upstream_unavailable', '无法连接上游服务'); }
  finally { clearTimeout(timer); controller.abort(); }
}
function parseJSON(bytes) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(502, 'invalid_response', '上游 JSON 格式无效'); } }
export function createGitHubAdapter({ fetchImpl = fetch, githubClient } = {}) {
  const client = githubClient || createGitHubClient({fetchImpl});
  async function json(url, limit = 1048576) { return parseJSON((await client.read(url, {limit, shareKey: 'lookup'})).bytes); }
  async function inspect(repoUrl) {
    let repo = githubRepo(repoUrl), base = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
    const repository = await json(base);
    // GitHub language describes implementation, not product type or Package capability.
    // Only verified release metadata and actual package bytes grant installability.
    if (!plain(repository) || repository.private !== false || repository.full_name?.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) fail(400, 'invalid_repository', '仓库必须公开且与输入地址一致');
    repo = githubRepo(`https://github.com/${repository.full_name}`);
    base = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
    const result = { owner: repo.owner, repo: repo.repo, compatibility: 'external', manifest: null, release: null, reason: '没有符合规范的可安装 Release；可前往作者 GitHub 获取' };
    const all = [];
    for (let page = 1; page <= 5; page++) {
      const rows = await json(`${base}/releases?per_page=100&page=${page}`, 4 * 1024 * 1024);
      if (!Array.isArray(rows)) fail(502, 'invalid_response', 'Release 数据无效');
      all.push(...rows);
      if (rows.length < 100) break;
      if (page === 5) fail(502, 'release_limit', 'Release 数量超出当前发现范围');
    }
    const release = all.filter(r => plain(r) && !r.draft && typeof r.tag_name === 'string' && r.tag_name.startsWith('v') && version(r.tag_name.slice(1)) && Number.isSafeInteger(r.id) && r.id > 0).sort((a,b) => compareVersions(b.tag_name.replace(/^v/, ''), a.tag_name.replace(/^v/, '')))[0];
    if (release) result.release = { id: release.id, tag: release.tag_name, version: release.tag_name.replace(/^v/, '') };
    const metadata = Array.isArray(release?.assets) ? release.assets.filter(a => a.name === 'MieMie-Extension-update.json') : [];
    if (metadata.length === 1) {
      try {
        validatePackageRelease(release, release.id);
        const asset = validatePackageAsset(release, 'MieMie-Extension-update.json', base, 65536);
        const { bytes } = await client.read(asset.url, {limit: 65536, binary: true, shareKey: JSON.stringify([base, release.id, asset.id, asset.name, asset.size, asset.digest, asset.url, asset.state])});
        if (bytes.length !== asset.size || `sha256:${hash(bytes)}` !== asset.digest) throw new Error('metadata digest');
        const m = validateExtensionPackageMetadata(parseJSON(bytes), repo, release);
        const manifest = cleanManifest(m.manifest, repo, result.release.version, release.tag_name);
        const packageAsset = validatePackageAsset(release, m.asset.name, base, 16777216);
        if (packageAsset.size !== m.asset.size || packageAsset.digest !== `sha256:${m.asset.sha256}`) throw new Error('package metadata');
        const payload=await client.read(packageAsset.url,{limit:16777216,timeout:60000,binary:true});
        if(payload.bytes.length!==m.asset.size||hash(payload.bytes)!==m.asset.sha256)throw Error('package digest');
        verifyPackage(payload.bytes,m);
        result.manifest = manifest; result.compatibility = 'installable'; result.reason = '符合机器安装包规范；不代表安全审核或作者认证';
        return result;
      } catch (error) { if (['github_auth_failed', 'github_rate_limited', 'github_forbidden'].includes(error.code)) throw error; result.reason = 'Release 安装包或元数据无效、或不可读取；可前往作者 GitHub 获取'; }
    }
    // Root manifest supplies optional display fields only. It cannot grant installability.
    try {
      const response = await client.read(`${base}/contents/manifest.json`, {accept: 'application/vnd.github.raw+json', limit: 65536, shareKey: 'root-manifest'});
      result.manifest = cleanManifest(parseJSON(response.bytes), repo, undefined, release?.tag_name || 'HEAD');
    } catch (error) { if (['github_auth_failed', 'github_rate_limited', 'github_forbidden'].includes(error.code)) throw error; /* ordinary external GitHub projects need no manifest */ }
    return result;
  }
  return { inspect };
}
export function createDiscordAdapter(config, { fetchImpl = fetch, now = Date.now } = {}) {
  return {
    authorizationUrl(state) {
      const url = new URL('https://discord.com/oauth2/authorize');
      for (const [k,v] of Object.entries({ response_type: 'code', client_id: config.clientId, scope: 'identify guilds', state, redirect_uri: config.redirectUri })) url.searchParams.set(k,v);
      return url.href;
    },
    async exchange(code) {
      const result = await boundedFetch(fetchImpl, 'https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }).toString() });
      const tokens = parseJSON(result.bytes);
      if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 4096 || tokens.token_type?.toLowerCase() !== 'bearer' || !Number.isSafeInteger(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 31536000 || !['identify','guilds'].every(scope => typeof tokens.scope === 'string' && tokens.scope.split(/\s+/).includes(scope))) fail(502, 'discord_auth_failed', 'Discord 登录失败');
      const userBytes = await boundedFetch(fetchImpl, 'https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const user = parseJSON(userBytes.bytes);
      if (!/^\d{15,22}$/.test(user.id || '')) fail(502, 'discord_profile_invalid', 'Discord 资料无效');
      const profile = { id: user.id, displayName: text(user.global_name || user.username, 'Discord 显示名', 100), username: text(user.username, 'Discord 用户名', 100), avatarBytes: null };
      if (/^(?:a_)?[a-f0-9]{32}$/.test(user.avatar || '')) {
        try {
          const image = await boundedFetch(fetchImpl, `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`, { limit: 262144 });
          if (image.response.headers.get('content-type')?.split(';')[0] === 'image/png' && image.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) profile.avatarBytes = image.bytes;
        } catch { /* profile identity does not depend on the avatar CDN */ }
      }
      // Returned only to server-side app state, never persisted or serialized to Hub.
      return { profile, credentials: { accessToken: tokens.access_token, expiresAt: now() + tokens.expires_in * 1000, scopes: ['identify', 'guilds'] } };
    },
    async listGuilds(accessToken, {detailsFor} = {}) {
      if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 4096) fail(401, 'discord_session_expired', '请重新使用 Discord 登录');
      const ids = new Set(); let after = '', detail = null;
      for (let page = 0; page < 10; page++) {
        const url = `https://discord.com/api/v10/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`;
        const result = await boundedFetch(fetchImpl, url, { limit: 2 * 1024 * 1024, headers: { Authorization: `Bearer ${accessToken}` } });
        const rows = parseJSON(result.bytes);
        if (!Array.isArray(rows) || rows.length > 200) fail(502, 'discord_guilds_invalid', 'Discord 服务器成员信息无效');
        let last = after;
        for (const row of rows) {
          if (!plain(row) || !/^\d{15,22}$/.test(row.id || '') || ids.has(row.id) || (after && BigInt(row.id) <= BigInt(after))) fail(502, 'discord_guilds_invalid', 'Discord 服务器成员信息无效');
          if (row.id === detailsFor) {
            if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 100) fail(502,'discord_guilds_invalid','Discord 服务器名称无效');
            detail = {id:row.id,name:row.name,iconUrl:typeof row.icon==='string' && /^(?:a_)?[a-f0-9]{32}$/.test(row.icon) ? `https://cdn.discordapp.com/icons/${row.id}/${row.icon}.png?size=96` : null};
          }
          ids.add(row.id); if (!last || BigInt(row.id) > BigInt(last)) last = row.id;
        }
        if (rows.length < 200) return detailsFor ? detail : [...ids];
        if (last === after) fail(502, 'discord_guilds_invalid', 'Discord 服务器分页无效');
        after = last;
      }
      fail(502, 'discord_guilds_limit', 'Discord 服务器列表超过当前查询范围');
    }
  };
}

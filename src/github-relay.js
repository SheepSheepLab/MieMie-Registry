// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 SheepSheep
import { createHash } from 'node:crypto';
import { fail, plain, githubRepo, version } from './validation.js';
import { cleanManifest } from './remote.js';

const METADATA = 'MieMie-Extension-update.json';
const PREFIX = '// MieMie-Extension-Build: ';
const HUB_ID = 'e85cd9a3-6352-4b23-938a-6c94d826b4d3';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === 64;
const keys = (value, names) => plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const decode = bytes => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(502, 'invalid_package_json', '作者 GitHub 文件不是有效 JSON'); } };
const failure = () => fail(502, 'invalid_package', '作者 GitHub 安装包身份、结构或校验信息无效');

function officialURL(value) {
  let url; try { url = new URL(value); } catch { fail(502, 'unsafe_redirect', 'GitHub 下载重定向无效'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) fail(502, 'unsafe_redirect', 'GitHub 下载重定向来源不允许');
  return url.href;
}
function asset(release, name, base, max) {
  const matches = release.assets.filter(value => value?.name === name);
  if (matches.length !== 1) failure();
  const value = matches[0];
  if (!positive(value.id) || value.state !== 'uploaded' || !positive(value.size) || value.size > max || !/^sha256:[a-f0-9]{64}$/.test(value.digest || '') || value.digest.length !== 71 || value.url !== `${base}/releases/assets/${value.id}`) failure();
  return value;
}
function validateRelease(value, id) {
  if (!plain(value) || value.id !== id || value.draft !== false || typeof value.tag_name !== 'string' || !value.tag_name.startsWith('v') || !version(value.tag_name.slice(1)) || !Array.isArray(value.assets) || value.assets.length > 1000) failure();
  const ids = value.assets.map(a => a?.id);
  if (new Set(ids).size !== ids.length) failure();
  return value;
}
function validateMetadata(value, repository, release) {
  if (!keys(value, ['schemaVersion', 'format', 'productId', 'version', 'tag', 'scriptId', 'manifest', 'asset', 'contentSha256']) || value.schemaVersion !== 1 || value.format !== 'tavern-helper-script' || value.tag !== release.tag_name || value.version !== release.tag_name.slice(1) || typeof value.scriptId !== 'string' || !value.scriptId.trim() || value.scriptId.length > 200 || value.scriptId === HUB_ID || !hash(value.contentSha256) || !keys(value.asset, ['name', 'size', 'sha256']) || typeof value.asset.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$/.test(value.asset.name) || value.asset.name.endsWith('\n') || value.asset.name === METADATA || !positive(value.asset.size) || value.asset.size > 16777216 || !hash(value.asset.sha256)) failure();
  const manifest = cleanManifest(value.manifest, repository, value.version, value.tag);
  if (manifest.id !== value.productId || (value.manifest.contributes !== undefined && !plain(value.manifest.contributes))) failure();
  return value;
}
function validateHubMetadata(value, release) {
  if (!keys(value, ['schemaVersion', 'format', 'productId', 'version', 'tag', 'scriptId', 'asset', 'contentSha256']) ||
      value.schemaVersion !== 1 || value.format !== 'tavern-helper-script' || value.productId !== 'miemie.hub' ||
      value.scriptId !== HUB_ID || value.tag !== release.tag_name || value.version !== release.tag_name.slice(1) ||
      !hash(value.contentSha256) || !keys(value.asset, ['name', 'size', 'sha256']) ||
      value.asset.name !== `MieMie-Hub-${value.version}.json` || !positive(value.asset.size) ||
      value.asset.size > 16777216 || !hash(value.asset.sha256)) failure();
  return value;
}
function verifyBytes(bytes, reference) {
  if (bytes.length !== reference.size || `sha256:${digest(bytes)}` !== reference.digest) fail(502, 'digest_mismatch', '作者 GitHub 文件大小或 SHA-256 不匹配');
}
function verifyPackage(bytes, metadata, hub = false) {
  const script = decode(bytes);
  if (!keys(script, ['type', 'enabled', 'name', 'id', 'content', 'info', 'button', 'data', 'export_with']) || script.type !== 'script' || typeof script.enabled !== 'boolean' || typeof script.name !== 'string' || script.id !== metadata.scriptId || typeof script.content !== 'string' || typeof script.info !== 'string' || !plain(script.data) || Object.keys(script.data).length || !keys(script.button, ['enabled', 'buttons']) || typeof script.button.enabled !== 'boolean' || !Array.isArray(script.button.buttons) || script.button.buttons.some(b => !keys(b, ['name', 'visible']) || typeof b.name !== 'string' || typeof b.visible !== 'boolean') || !keys(script.export_with, ['data', 'button']) || typeof script.export_with.data !== 'boolean' || typeof script.export_with.button !== 'boolean') failure();
  const prefix = hub ? '// MieMie-Hub-Build: ' : PREFIX;
  const newline = script.content.indexOf('\n');
  if (!script.content.startsWith(prefix) || newline < 0 || newline > 2048 || !script.content.slice(newline + 1).trim()) failure();
  const identity = decode(Buffer.from(script.content.slice(prefix.length, newline)));
  if (hub) {
    if (!keys(identity, ['schemaVersion', 'productId', 'version', 'scriptId']) || identity.schemaVersion !== 1 || identity.productId !== 'miemie.hub' || identity.version !== metadata.version || identity.scriptId !== HUB_ID || digest(Buffer.from(script.content, 'utf8')) !== metadata.contentSha256) failure();
    return;
  }
  if (!keys(identity, ['schemaVersion', 'productId', 'version', 'scriptId', 'repository']) || identity.schemaVersion !== 1 || identity.productId !== metadata.productId || identity.version !== metadata.version || identity.scriptId !== metadata.scriptId || githubRepo(identity.repository).url.toLowerCase() !== githubRepo(metadata.manifest.repository).url.toLowerCase() || digest(Buffer.from(script.content, 'utf8')) !== metadata.contentSha256) failure();
}
const assetLock = value => JSON.stringify([value.id, value.name, value.size, value.digest, value.url, value.state]);

// A bounded byte transport, never an arbitrary-URL proxy. No downloaded code is
// executed or stored. Hub independently repeats every package check on receipt.
function createReleaseRelay({ hub = false, fetchImpl = fetch, queryTimeoutMs = 15000, assetTimeoutMs = 60000, operationTimeoutMs = 90000, now = Date.now, metadataCacheTtlMs = 120000 } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'MieMie-Registry/0.3.2' };
  const repositoryCache = new Map(), metadataCache = new Map(); let rateReset = 0;
  function limited() {return Object.assign(new Error('GitHub 匿名 API 额度暂时用完，请在配额恢复后重试'), {status: 429, code: 'github_rate_limited', retryAt: new Date(rateReset).toISOString()});}
  function cacheGet(cache, key) {const item = cache.get(key); if (item && item.until > now()) return item.value; cache.delete(key); return undefined;}
  function cachePut(cache, key, value) {
    if (metadataCacheTtlMs <= 0) return;
    for (const [key, entry] of cache) if (entry.until <= now()) cache.delete(key);
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    cache.set(key, {value, until: now() + Math.min(metadataCacheTtlMs, 120000)});
  }
  async function read(input, { signal } = {}) {
    if (hub) {
      if (!keys(input, ['releaseId', 'assetId'])) fail(400, 'invalid_relay_request', 'Hub 转发仅接受 releaseId 和 assetId');
      input = {...input, repository: 'https://github.com/SheepSheepLab/MieMie-Hub'};
    }
    const metadataName = hub ? 'MieMie-Hub-update.json' : METADATA;
    if (!keys(input, ['repository', 'releaseId', 'assetId']) || !positive(input.releaseId) || !positive(input.assetId)) fail(400, 'invalid_relay_request', '仅接受 repository、releaseId 和 assetId');
    const repository = githubRepo(input.repository);
    if (repository.url !== input.repository) fail(400, 'invalid_relay_request', '需要规范化的作者 GitHub 仓库地址');
    if (rateReset > now()) throw limited();
    const controller = new AbortController();
    let rejectAbort;
    const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
    const stop = (status, code, message) => { const error = Object.assign(new Error(message), { status, code }); controller.abort(error); rejectAbort(error); };
    const disconnect = () => stop(499, 'client_disconnected', '下载请求已取消');
    signal?.addEventListener('abort', disconnect, { once: true });
    const timer = setTimeout(() => stop(504, 'upstream_timeout', 'GitHub 文件传输总时限已到'), operationTimeoutMs); timer.unref?.();
    async function download(url, { limit = 1048576, timeout = queryTimeoutMs, binary = false } = {}) {
      let requestTimer;
      const requestController = new AbortController(), abort = () => requestController.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
      const operation = (async () => {
        let current = officialURL(url), response;
        for (let redirects = 0; ; redirects++) {
          requestController.signal.throwIfAborted();
          response = await fetchImpl(current, { method: 'GET', headers: { ...headers, ...(binary ? { Accept: 'application/octet-stream' } : {}) }, credentials: 'omit', redirect: 'manual', signal: requestController.signal });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          if (!binary || redirects >= 5 || !response.headers.get('location')) fail(502, 'unsafe_redirect', 'GitHub API 或下载重定向无效');
          const next = officialURL(new URL(response.headers.get('location'), current).href);
          await response.body?.cancel(); current = next;
        }
        if (response.url && officialURL(response.url) !== current) fail(502, 'unsafe_redirect', '下载响应地址与已验证路径不一致');
        if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
          const retry = Number(response.headers.get('retry-after')) * 1000;
          rateReset = Math.min(now() + 86400000, Math.max(now() + 1000, Number.isFinite(reset) && reset > now() ? reset : now() + (retry > 0 ? retry : 60000)));
          await response.body?.cancel(); throw limited();
        }
        if (!response.ok) fail(502, 'github_unavailable', '作者 GitHub 暂时不可读取（HTTP ' + response.status + '）');
        if (Number(response.headers.get('content-length')) > limit) fail(502, 'response_too_large', '作者 GitHub 文件超过大小限制');
        if (!response.body?.getReader) fail(502, 'invalid_response', '作者 GitHub 文件不可读取');
        const reader = response.body.getReader(), chunks = []; let length = 0;
        try {
          for (;;) { requestController.signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > limit) fail(502, 'response_too_large', '作者 GitHub 文件超过大小限制'); chunks.push(value); }
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks);
      })();
      const timeoutPromise = new Promise((_, reject) => { requestTimer = setTimeout(() => { requestController.abort(); reject(Object.assign(new Error('作者 GitHub 请求超时'), { status: 504, code: 'upstream_timeout' })); }, timeout); requestTimer.unref?.(); });
      try { return await Promise.race([operation, timeoutPromise, cancelled]); }
      finally { clearTimeout(requestTimer); requestController.abort(); controller.signal.removeEventListener('abort', abort); }
    }
    try {
      if (signal?.aborted) disconnect();
      const operation = (async () => {
        const base = `https://api.github.com/repos/${repository.owner}/${repository.repo}`;
        const repo = cacheGet(repositoryCache, base) || decode(await download(base));
        if (!plain(repo) || repo.private !== false || repo.full_name !== `${repository.owner}/${repository.repo}`) fail(400, 'invalid_repository', '仓库必须公开且使用 GitHub 返回的规范名称');
        cachePut(repositoryCache, base, {private: false, full_name: repo.full_name});
        const releaseURL = `${base}/releases/${input.releaseId}`;
        const release = validateRelease(decode(await download(releaseURL)), input.releaseId);
        const metadataAsset = asset(release, metadataName, base, 65536);
        const cacheKey = JSON.stringify([base, release.id, assetLock(metadataAsset)]);
        const metadataBytes = cacheGet(metadataCache, cacheKey)?.slice() || await download(metadataAsset.url, { limit: 65536, binary: true });
        verifyBytes(metadataBytes, metadataAsset);
        const metadata = hub ? validateHubMetadata(decode(metadataBytes), release) : validateMetadata(decode(metadataBytes), repository, release);
        const packageAsset = asset(release, metadata.asset.name, base, 16777216);
        if (packageAsset.size !== metadata.asset.size || packageAsset.digest !== `sha256:${metadata.asset.sha256}`) failure();
        if (![metadataAsset.id, packageAsset.id].includes(input.assetId)) fail(400, 'asset_not_allowed', '只能传输已验证 Manifest 指定的安装包或机器元数据');
        let bytes = metadataBytes;
        if (input.assetId === packageAsset.id) {
          bytes = await download(packageAsset.url, { limit: 16777216, binary: true, timeout: assetTimeoutMs });
          verifyBytes(bytes, packageAsset); verifyPackage(bytes, metadata, hub);
        }
        // Re-read authoritative metadata after transfer, catching replaced assets,
        // changed tags, draft transitions and package-name/ID rebinding.
        const fresh = validateRelease(decode(await download(releaseURL)), input.releaseId);
        if (fresh.tag_name !== release.tag_name || assetLock(asset(fresh, metadataName, base, 65536)) !== assetLock(metadataAsset) || assetLock(asset(fresh, metadata.asset.name, base, 16777216)) !== assetLock(packageAsset)) fail(409, 'release_changed', '作者 GitHub Release 在传输期间变化，请重新预览');
        cachePut(metadataCache, cacheKey, Buffer.from(metadataBytes));
        return bytes;
      })();
      return await Promise.race([operation, cancelled]);
    } catch (error) {
      if (error.status) throw error;
      fail(502, 'github_unavailable', '无法读取作者 GitHub 文件；未转发任何未验证内容');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', disconnect); controller.abort(); }
  }
  return { read };
}

// Separate server-selected validators: clients cannot turn an Extension into Hub,
// choose a Hub repository, or supply an arbitrary download URL.
export const createGitHubRelay = options => createReleaseRelay({...options, hub: false});
export const createHubReleaseRelay = options => createReleaseRelay({...options, hub: true});

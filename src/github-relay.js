import {createGitHubClient} from './github-client.js';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 SheepSheep
import { createHash } from 'node:crypto';
import { fail, plain, githubRepo, version } from './validation.js';
import { cleanManifest } from './remote.js';
import {verifyPackage} from './package-validation.js';

const METADATA = 'MieMie-Extension-update.json';
const HUB_ID = 'e85cd9a3-6352-4b23-938a-6c94d826b4d3';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === 64;
const keys = (value, names) => plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const decode = bytes => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(502, 'invalid_package_json', '作者 GitHub 文件不是有效 JSON'); } };
const failure = () => fail(502, 'invalid_package', '作者 GitHub 安装包身份、结构或校验信息无效');

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

const assetLock = value => JSON.stringify([value.id, value.name, value.size, value.digest, value.url, value.state]);

// A bounded byte transport, never an arbitrary-URL proxy. No downloaded code is
// executed or stored. Hub independently repeats every package check on receipt.
function createReleaseRelay({ hub = false, fetchImpl = fetch, githubClient, queryTimeoutMs = 15000, assetTimeoutMs = 60000, operationTimeoutMs = 90000, now = Date.now, metadataCacheTtlMs = 120000 } = {}) {
  const client = githubClient || createGitHubClient({fetchImpl, now});
  const repositoryCache = new Map(), metadataCache = new Map();
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
    const controller = new AbortController();
    let rejectAbort;
    const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
    const stop = (status, code, message) => { const error = Object.assign(new Error(message), { status, code }); controller.abort(error); rejectAbort(error); };
    const disconnect = () => stop(499, 'client_disconnected', '下载请求已取消');
    signal?.addEventListener('abort', disconnect, { once: true });
    const timer = setTimeout(() => stop(504, 'upstream_timeout', 'GitHub 文件传输总时限已到'), operationTimeoutMs); timer.unref?.();
    async function download(url, { limit = 1048576, timeout = queryTimeoutMs, binary = false, shareKey } = {}) {
      return (await client.read(url, {limit, timeout, binary, shareKey, signal: controller.signal})).bytes;
    }
    try {
      if (signal?.aborted) disconnect();
      const operation = (async () => {
        const base = `https://api.github.com/repos/${repository.owner}/${repository.repo}`;
        const repo = cacheGet(repositoryCache, base) || decode(await download(base, {shareKey: 'repository'}));
        if (!plain(repo) || repo.private !== false || repo.full_name !== `${repository.owner}/${repository.repo}`) fail(400, 'invalid_repository', '仓库必须公开且使用 GitHub 返回的规范名称');
        cachePut(repositoryCache, base, {private: false, full_name: repo.full_name});
        const releaseURL = `${base}/releases/${input.releaseId}`;
        const release = validateRelease(decode(await download(releaseURL, {shareKey: 'release'})), input.releaseId);
        const metadataAsset = asset(release, metadataName, base, 65536);
        const cacheKey = JSON.stringify([base, release.id, assetLock(metadataAsset)]);
        const metadataBytes = cacheGet(metadataCache, cacheKey)?.slice() || await download(metadataAsset.url, { limit: 65536, binary: true, shareKey: cacheKey });
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

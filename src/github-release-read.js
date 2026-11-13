// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 SheepSheep
import {fail, githubRepo, plain} from './validation.js';
import {isGitHubError} from './github-upstream-state.js';

const releasePath = /^\/api\/github\/repos\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})(\/releases(?:\/[1-9]\d{0,15}|\/tags\/v(?:0|[1-9]\d{0,15})\.(?:0|[1-9]\d{0,15})\.(?:0|[1-9]\d{0,15}))?)?$/;

export function isGitHubReleaseRead(path) {return releasePath.test(path);}

const notFound = () => fail(404, 'not_found', '公开 GitHub 资源不存在');

// Expose only the public fields used by Hub's existing Release validators.
function releaseRecord(value) {
  if (!plain(value) || value.draft !== false) return {draft:true};
  return {id:value.id, tag_name:value.tag_name, draft:false};
}

export async function readGitHubRelease(client, request, signal) {
  const [,owner,name,suffix=''] = releasePath.exec(request.pathname);
  const repo = githubRepo(`https://github.com/${owner}/${name}`);
  if (repo.repo !== name) fail(400, 'invalid_repository', '需要公开 GitHub 仓库名称');
  const listing = suffix === '/releases';
  const page = request.searchParams.get('page');
  if (listing ? !/^(?:[1-9]|10)$/.test(page || '') || request.searchParams.get('per_page') !== '100' ||
      [...request.searchParams].length !== 2 : !!request.search) fail(400, 'invalid_query', 'GitHub Release 查询参数无效');
  async function read(url) {
    let result;
    try {result = await client.read(url, {limit:1048576, signal, shareKey:'public-release-read'});}
    catch (error) {
      if (isGitHubError(error) && error.code === 'not_found') notFound();
      throw error;
    }
    try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.bytes));}
    catch {fail(502,'invalid_response','GitHub Release 响应无效');}
  }
  const requested = `https://api.github.com/repos/${owner}/${name}`;
  async function publicRepository(url) {
    const repository = await read(url);
    if (!plain(repository) || repository.private !== false || typeof repository.full_name !== 'string' ||
        repository.full_name.toLowerCase() !== `${owner}/${name}`.toLowerCase()) notFound();
    return repository;
  }
  const repository = await publicRepository(requested);
  const canonical = githubRepo(`https://github.com/${repository.full_name}`);
  if (!suffix) return {full_name:repository.full_name, private:false};
  const canonicalURL = `https://api.github.com/repos/${canonical.owner}/${canonical.repo}`;
  const value = await read(canonicalURL + suffix + (listing ? '?per_page=100&page='+page : ''));
  // The upstream credential may have access to non-public data. Confirm the
  // repository is still public after the metadata read before sending it.
  await publicRepository(canonicalURL);
  if (listing) {
    if (!Array.isArray(value) || value.length > 100) fail(502,'invalid_response','GitHub Release 列表无效');
    // Preserve page length without exposing draft identifiers or metadata.
    return value.map(releaseRecord);
  }
  if (value?.draft !== false) notFound();
  if (!Array.isArray(value.assets) || value.assets.length > 1000) fail(502,'invalid_response','GitHub Release 附件列表无效');
  return {...releaseRecord(value), assets:value.assets.map(asset => ({
    id:asset?.id, name:asset?.name, state:asset?.state, size:asset?.size, digest:asset?.digest,
    url:asset?.url, browser_download_url:asset?.browser_download_url,
  }))};
}

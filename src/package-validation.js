// SPDX-License-Identifier: GPL-3.0-or-later
// Shared byte/identity validation for Catalog inspection and installation relay.
// Never execute downloaded application code.
import {createHash} from 'node:crypto';
import {fail,plain,githubRepo,version,text,iconUrl} from './validation.js';
const PREFIX='// MieMie-Extension-Build: ';
const HUB_ID='e85cd9a3-6352-4b23-938a-6c94d826b4d3';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const keys=(value,names)=>plain(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const failure=()=>fail(502,'invalid_package','作者 GitHub 安装包身份、结构或校验信息无效');
const decode=bytes=>{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{failure();}};
export function verifyPackage(bytes, metadata, hub = false) {
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

// Package v1 declarations and release locks are shared by Catalog and Relay.
// Machine validity never grants compatibility with a particular Hub Runtime.
const METADATA = 'MieMie-Extension-update.json';
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === 64;
export function cleanManifest(value, repository, expectedVersion, ref = 'HEAD') {
  if (!plain(value) || value.schemaVersion !== 1 || (!Number.isSafeInteger(value.apiVersion) || ![1, 2].includes(value.apiVersion)) || !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(value.id || '') || value.id === 'miemie.hub' || !version(value.version) || (expectedVersion && value.version !== expectedVersion) || githubRepo(value.repository).url.toLowerCase() !== repository.url.toLowerCase()) fail(400, 'invalid_manifest', 'Manifest 身份、版本、API 或仓库不匹配');
  const manifest = { schemaVersion: 1, apiVersion: value.apiVersion, id: text(value.id, 'Extension ID', 80), name: text(value.name, '名称', 80), version: value.version, author: text(value.author, '作者', 100), description: text(value.description, '简介', 2000), entry: text(value.entry, 'Entry', 200), repository: repository.url, license: text(value.license, 'License', 100) };
  if (value.icon && typeof value.icon === 'string' && value.icon.length <= 2048) {
    try {
      const relative = !/^[a-z][a-z0-9+.-]*:/i.test(value.icon);
      if (relative && (!/^[A-Za-z0-9_./-]+$/.test(value.icon) || value.icon.startsWith('/') || value.icon.split('/').some(p => ['.', '..', ''].includes(p)))) throw new Error('invalid relative icon');
      manifest.iconUrl = iconUrl(relative ? `https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/${encodeURIComponent(ref)}/${value.icon}` : value.icon);
      manifest.icon = value.icon;
    } catch { /* unsupported icon safely falls back to catalog/default */ }
  }
  if (value.homepage) { const url = new URL(value.homepage); if (url.protocol === 'https:' && !url.username && !url.password && value.homepage.length <= 2048) manifest.homepage = url.href; }
  if (value.hubApi !== undefined) {
    if (!plain(value.hubApi) || !Number.isSafeInteger(value.hubApi.min) || !Number.isSafeInteger(value.hubApi.max) || value.hubApi.min < 1 || value.hubApi.min > value.hubApi.max || value.hubApi.min > value.apiVersion || value.hubApi.max < value.apiVersion) fail(400, 'invalid_manifest', 'Hub API 兼容范围必须有效并包含声明的 API');
    manifest.hubApi = {min:value.hubApi.min,max:value.hubApi.max};
  }
  if (value.contributes?.launcher !== undefined) {
    const launcher=value.contributes.launcher;
    if (!plain(launcher) || (launcher.icon !== undefined && (typeof launcher.icon !== 'string' || launcher.icon.length > 16))) fail(400,'invalid_manifest','Launcher 能力无效');
    manifest.contributes={launcher:{title:text(launcher.title,'Launcher',60)}};
    if(launcher.icon !== undefined) manifest.contributes.launcher.icon=launcher.icon;
  }
  return manifest;
}
export function validatePackageAsset(release, name, base, max) {
  const matches = release.assets.filter(value => value?.name === name);
  if (matches.length !== 1) failure();
  const value = matches[0];
  if (!positive(value.id) || value.state !== 'uploaded' || !positive(value.size) || value.size > max || !/^sha256:[a-f0-9]{64}$/.test(value.digest || '') || value.digest.length !== 71 || value.url !== `${base}/releases/assets/${value.id}`) failure();
  return value;
}
export function validatePackageRelease(value, id) {
  if (!plain(value) || !positive(value.id) || value.id !== id || value.draft !== false || typeof value.tag_name !== 'string' || !value.tag_name.startsWith('v') || !version(value.tag_name.slice(1)) || !Array.isArray(value.assets) || value.assets.length > 1000) failure();
  const ids = value.assets.map(a => a?.id);
  if (new Set(ids).size !== ids.length) failure();
  return value;
}
export function validateExtensionPackageMetadata(value, repository, release) {
  if (!keys(value, ['schemaVersion', 'format', 'productId', 'version', 'tag', 'scriptId', 'manifest', 'asset', 'contentSha256']) || value.schemaVersion !== 1 || value.format !== 'tavern-helper-script' || value.tag !== release.tag_name || value.version !== release.tag_name.slice(1) || typeof value.scriptId !== 'string' || !value.scriptId.trim() || value.scriptId.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.scriptId) || value.scriptId === HUB_ID || !hash(value.contentSha256) || !keys(value.asset, ['name', 'size', 'sha256']) || typeof value.asset.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json$(?![\s\S])/.test(value.asset.name) || value.asset.name.endsWith('\n') || value.asset.name === METADATA || !positive(value.asset.size) || value.asset.size > 16777216 || !hash(value.asset.sha256)) failure();
  const manifest = cleanManifest(value.manifest, repository, value.version, value.tag);
  if (manifest.id !== value.productId || (value.manifest.contributes !== undefined && !plain(value.manifest.contributes))) failure();
  return value;
}

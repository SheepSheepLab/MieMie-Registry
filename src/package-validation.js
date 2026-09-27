// SPDX-License-Identifier: GPL-3.0-or-later
// Shared byte/identity validation for Catalog inspection and installation relay.
// Never execute downloaded application code.
import {createHash} from 'node:crypto';
import {fail,plain,githubRepo} from './validation.js';
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

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 SheepSheep
export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function text(value, field, max, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, 'invalid_input', `${field}格式或长度无效`);
  return value.trim();
}
export function exactOrigin(value, allowHttp = true) {
  let url; try { url = new URL(value); } catch { fail(400, 'invalid_origin', 'Origin 无效'); }
  if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) fail(400, 'invalid_origin', 'Origin 必须为 HTTPS 或本机 HTTP');
  return value;
}
export function githubRepo(value) {
  let u; try { u = new URL(value); } catch { fail(400, 'invalid_github', '请输入公开 GitHub Repository URL'); }
  const match = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(u.pathname);
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || u.search || u.hash || !match || ['.', '..'].includes(match[2])) fail(400, 'invalid_github', '仅接受 https://github.com/owner/repo');
  const owner = match[1], repo = match[2].replace(/\.git$/, '');
  if (!repo || ['.', '..'].includes(repo)) fail(400, 'invalid_github', '仓库名称无效');
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}
export function discordPost(value) {
  let u; try { u = new URL(value); } catch { fail(400, 'invalid_discord', '请输入 Discord 原帖 URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'discord.com' || u.port || u.username || u.password || u.search || u.hash || !/^\/channels\/\d{15,22}\/\d{15,22}(?:\/\d{15,22})?$/.test(u.pathname)) fail(400, 'invalid_discord', '仅接受 Discord 服务器频道／帖子链接，不接受附件或邀请链接');
  return u.href;
}
export function discordLocation(value) {
  const url = discordPost(value), [, , guildId, channelId, messageId] = new URL(url).pathname.split('/');
  return { url, guildId, channelId, messageId: messageId || null };
}
export function iconUrl(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 2048) fail(400, 'invalid_icon', 'Icon URL 无效');
  let u; try { u = new URL(value); } catch { fail(400, 'invalid_icon', 'Icon 必须为 HTTPS URL'); }
  // Icons are never fetched server-side. Keep client image sources narrowly scoped.
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['raw.githubusercontent.com', 'avatars.githubusercontent.com', 'github.com'].includes(u.hostname) || /\.svg(?:$|[?#])/i.test(value)) fail(400, 'invalid_icon', 'Icon 仅支持 GitHub 的 HTTPS PNG/JPEG/WebP 图片地址');
  return u.href;
}
// URLs here are navigation only, never fetched by Registry (no arbitrary URL proxy).
export function websiteUrl(value) {
  if (!value) return null;
  text(value,'Website URL',2048);
  let u; try {u=new URL(value);} catch {fail(400,'invalid_website','需要 HTTPS 网站链接');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.')||/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)||u.hostname.endsWith('.local'))fail(400,'invalid_website','需要公开 HTTPS 网站链接');
  return u.href;
}
export const productTypes = {tavern_extension:true,standalone_app:true,web_tool:true};
// Only server-verified Package capability can grant managed installation.
// Catalog admission and GitHub Language do not establish installability.
export function productDistribution(type,source,github=null){
  if(typeof type!=='string'||!Object.hasOwn(productTypes,type))fail(400,'invalid_type','不支持此产品类型');
  if(!['github','discord'].includes(source))fail(400,'invalid_source','来源必须为 GitHub 或 Discord');
  return type==='web_tool'?'open_url':type==='tavern_extension'&&source==='github'&&github?.compatibility==='installable'?'managed_install':'external_release';
}
export function validateDistribution(type,source,distribution,github=null){
  if(distribution!==productDistribution(type,source,github))fail(400,'invalid_distribution','分发方式由来源、产品类型与服务端安装包检测结果确定');
}
export function submissionInput(body) {
  if (!plain(body)) fail(400, 'invalid_input', '需要 JSON 对象');
  const allowed = new Set(['name', 'description', 'author', 'sourceType', 'sourceUrl', 'icon', 'tags', 'visibility', 'visibilitySourceUrl','githubUrl','discordUrl','discordPostUrl','type','distribution','platforms','websiteUrl','classification']);
  if (Object.keys(body).some(key => !allowed.has(key))) fail(400, 'invalid_field', '不能修改身份、所有者或内部字段');
  if (!['github', 'discord'].includes(body.sourceType)) fail(400, 'invalid_source', '来源必须为 GitHub 或 Discord');
  const type=body.type??'tavern_extension';
  if(typeof type!=='string'||!Object.hasOwn(productTypes,type))fail(400,'invalid_type','不支持此产品类型');
  const distribution=productDistribution(type,body.sourceType);
  // Legacy clients may send a distribution hint; it never grants installability.
  if(Object.hasOwn(body,'distribution')&&(!['managed_install','external_release','open_url'].includes(body.distribution)||(body.distribution==='managed_install'&&(type!=='tavern_extension'||body.sourceType!=='github'))))fail(400,'invalid_distribution','此来源或产品类型不支持该分发方式');
  const website=websiteUrl(body.websiteUrl);
  if(type==='web_tool'&&!website)fail(400,'invalid_website','Web Tool 必须填写网站地址');
  const platforms=body.platforms??[];
  if(!Array.isArray(platforms)||platforms.length>6||platforms.some(p=>!['windows','macos','linux','android','ios','web'].includes(p)))fail(400,'invalid_platforms','平台信息无效');
  // Legacy clients may echo this read-only value. The handler rejects changes.
  const classification=Object.hasOwn(body,'classification') ? body.classification : 'community';
  if(!['community','official'].includes(classification))fail(400,'invalid_classification','身份分类无效');
  const tags = body.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 8) fail(400, 'invalid_tags', '最多 8 个标签');
  const requestedVisibility = body.visibility ?? 'public';
  if (!['public', 'discord_guild'].includes(requestedVisibility)) fail(400, 'invalid_visibility', '可见范围必须为 public 或 discord_guild');
  const sourceUrl = body.sourceType === 'github' ? githubRepo(body.sourceUrl).url : discordPost(body.sourceUrl);
  const optionalLink = (value, parse) => value === undefined || value === null || value === '' ? null : parse(text(value,'项目链接',2048));
  // Hub 0.8.0 aliases are accepted at the boundary, never persisted twice.
  const visibility = body.sourceType === 'discord' ? 'discord_guild' : requestedVisibility;
  const discordPostUrl = body.sourceType === 'github'
    ? optionalLink(Object.hasOwn(body,'discordPostUrl') ? body.discordPostUrl : body.discordUrl, discordPost) : null;
  if (body.sourceType === 'discord' && (body.githubUrl || body.discordPostUrl)) fail(400,'invalid_source','Discord 来源只接受主原帖链接，不提供辅助 GitHub 或发布帖');
  if (body.sourceType === 'github' && Object.hasOwn(body,'discordPostUrl') && Object.hasOwn(body,'discordUrl') && optionalLink(body.discordUrl,discordPost) !== discordPostUrl) fail(400,'invalid_source','Discord 发布帖兼容字段不一致');
  if (body.sourceType === 'github' && body.githubUrl && githubRepo(body.githubUrl).url.toLowerCase() !== sourceUrl.toLowerCase()) fail(400,'invalid_source','GitHub 链接必须与安装来源一致');
  if (body.sourceType === 'discord' && body.discordUrl && discordPost(body.discordUrl) !== sourceUrl) fail(400,'invalid_source','Discord 链接必须与原帖来源一致');
  const discord = body.sourceType === 'discord' ? discordLocation(sourceUrl) : null;
  let visibilityLocation = null;
  if (visibility === 'discord_guild') {
    visibilityLocation = body.sourceType === 'discord' ? discord : discordLocation(body.visibilitySourceUrl || discordPostUrl);
    if (body.sourceType === 'discord' && body.visibilitySourceUrl && discordPost(body.visibilitySourceUrl) !== sourceUrl) fail(400, 'invalid_visibility', 'Discord 可见范围必须依据当前原帖');
  }
  return { discordPostUrl, type, distribution, platforms:[...new Set(platforms)], websiteUrl:website, classification, visibility, visibilityGuildId: visibilityLocation?.guildId || null, visibilitySourceUrl: visibilityLocation?.url || null, discord, name: text(body.name, '名称', 100), description: text(body.description, '简介', 2000), author: text(body.author, '作者', 100), sourceType: body.sourceType, sourceUrl, icon: iconUrl(body.icon), tags: [...new Set(tags.map(tag => text(tag, '标签', 30)))] };
}
export function version(value) { return typeof value === 'string' && value.trim() === value && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.length < 40; }
export function compareVersions(a, b) {
  const x = a.split('.').map(BigInt), y = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

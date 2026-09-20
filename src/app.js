// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 SheepSheep
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { fail, plain, text, submissionInput } from './validation.js';
import { createDiscordAdapter, createGitHubAdapter } from './remote.js';
import { createGitHubRelay } from './github-relay.js';
const random = () => randomBytes(32).toString('base64url');
const sha = value => createHash('sha256').update(value).digest('base64url');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const jsonScript = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
function cookies(header = '') { return Object.fromEntries(header.split(';').map(part => part.trim().split('=')).filter(parts => parts.length === 2)); }
async function readJSON(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, 'json_required', '仅接受 application/json');
  if (Number(req.headers['content-length']) > 16384) fail(413, 'body_too_large', '请求超过 16 KiB');
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 16384) fail(413, 'body_too_large', '请求超过 16 KiB'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!plain(value)) throw new Error(); return value; } catch { fail(400, 'invalid_json', 'JSON 无效'); }
}
export function createApp({ config, store, discord = createDiscordAdapter(config), github = createGitHubAdapter(), githubRelay = createGitHubRelay(), now = Date.now, rateLimit = 120 } = {}) {
  const flows = new Map(), bridges = new Map(), rates = new Map(), previewCache = new Map();
  const relayRequests = new Map();
  const tokenHash = value => createHmac('sha256', config.sessionSecret).update(value).digest('hex');
  function prune() {
    for (const map of [flows, bridges]) for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
    for (const [key, value] of rates) if (value.until <= now()) rates.delete(key);
    store.expireSessions(now());
  }
  function limit(key, max = rateLimit, duration = 60000) {
    const value = rates.get(key); if (!value || value.until <= now()) { if (rates.size >= 10000) fail(503, 'busy', '服务繁忙'); rates.set(key, { count: 1, until: now() + duration }); return; }
    if (++value.count > max) fail(429, 'rate_limited', '请求过于频繁，请稍后重试');
  }
  function authenticate(req, admin = false) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    if (!match) fail(401, 'unauthorized', '请使用 Discord 登录');
    const session = store.sessionByHash(tokenHash(match[1]), now());
    if (!session || session.origin !== req.headers.origin) fail(401, 'session_expired', '登录已过期，请重新登录');
    const user = store.getIdentity(session.discord_id);
    if (!user) fail(401, 'unauthorized', '登录无效');
    const isAdmin = config.adminIds.has(user.discord_id);
    if (admin && !isAdmin) fail(403, 'forbidden', '需要管理员权限');
    return { user, session, isAdmin };
  }
  const canSubmit = user => { if (user.banned) fail(403, 'banned', '该 Discord 身份已被禁止投稿'); };
  const entry = id => { const row = store.getEntry(id); if (!row) fail(404, 'not_found', '项目不存在'); return row; };
  const own = (id, user) => { const row = entry(id); if (row.owner_id !== user.discord_id) fail(403, 'forbidden', '只能管理自己的投稿'); return row; };
  async function inspect(url) {
    const cached = previewCache.get(url);
    if (cached && cached.until > now()) return cached.result;
    const result = await github.inspect(url);
    if (previewCache.size > 1000) previewCache.clear();
    previewCache.set(url, { result, until: now() + 60000 }); return result;
  }
  function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  const handler = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      prune(); limit(`ip:${req.socket.remoteAddress || 'unknown'}`);
      const requestUrl = new URL(req.url, config.publicBaseUrl), path = requestUrl.pathname, method = req.method;
      const origin = req.headers.origin;
      if (origin) {
        if (!config.allowedOrigins.has(origin)) fail(403, 'origin_denied', '此页面来源未获 Registry 允许');
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      }
      if (method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Max-Age', '600'); res.writeHead(204); res.end(); return; }
      if (!['GET', 'POST', 'PATCH'].includes(method)) fail(405, 'method_not_allowed', '不支持此请求');
      if (method !== 'GET' && (!origin || !config.allowedOrigins.has(origin))) fail(403, 'origin_required', '写入请求必须来自已配置页面');
      if (path === '/health' && method === 'GET') return send(res, 200, { status: 'ok', version: '0.1.2' });
      if (path === '/' && method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>MieMie Registry</title><h1>MieMie Registry</h1><p>目录和 Discord 投稿服务。请从 MieMie Hub 扩展中心连接。</p><p>投稿默认上架，不代表安全审核或作者认证。</p>'); return; }
      if (path === '/api/auth/start' && method === 'POST') {
        if (!config.clientId || !config.clientSecret) fail(503, 'oauth_not_configured', 'Registry 尚未配置 Discord OAuth');
        limit(`auth:${req.socket.remoteAddress}`, 10, 600000);
        const body = await readJSON(req);
        if (body.returnOrigin !== origin || !/^[A-Za-z0-9_-]{43}$/.test(body.codeChallenge || '')) fail(400, 'invalid_auth_request', 'OAuth 来源或校验码无效');
        if (flows.size >= 1000) fail(503, 'busy', '登录请求过多');
        const requestId = random(); flows.set(requestId, { requestId, origin, challenge: body.codeChallenge, expiresAt: now() + 300000, started: false });
        return send(res, 200, { authorizationUrl: `${config.publicBaseUrl}/api/auth/authorize?requestId=${requestId}`, requestId });
      }
      if (path === '/api/auth/authorize' && method === 'GET') {
        const flow = flows.get(requestUrl.searchParams.get('requestId'));
        if (!flow || flow.started || flow.expiresAt <= now()) fail(400, 'invalid_state', '登录请求无效或已使用');
        flow.started = true; flow.state = random(); flow.cookie = random();
        const cookieName = `miemie_oauth_${flow.requestId}`;
        res.setHeader('Set-Cookie', `${cookieName}=${flow.cookie}; Path=/api/auth/callback; Max-Age=300; HttpOnly; SameSite=Lax${config.production ? '; Secure' : ''}`);
        res.writeHead(302, { Location: discord.authorizationUrl(flow.state) }); res.end(); return;
      }
      if (path === '/api/auth/callback' && method === 'GET') {
        const state = requestUrl.searchParams.get('state');
        const flow = [...flows.values()].find(f => f.started && safeEqual(f.state, state));
        if (!flow || flow.expiresAt <= now() || !safeEqual(cookies(req.headers.cookie)[`miemie_oauth_${flow.requestId}`], flow.cookie)) fail(400, 'invalid_state', 'OAuth state 或浏览器会话无效');
        flows.delete(flow.requestId); // one use, including upstream failures
        res.setHeader('Set-Cookie', `miemie_oauth_${flow.requestId}=; Path=/api/auth/callback; Max-Age=0; HttpOnly; SameSite=Lax${config.production ? '; Secure' : ''}`);
        if (requestUrl.searchParams.has('error')) fail(400, 'oauth_denied', 'Discord 授权未完成');
        const code = text(requestUrl.searchParams.get('code'), '授权码', 2048);
        const profile = await discord.exchange(code);
        if (!/^\d{15,22}$/.test(profile.id || '')) fail(502, 'invalid_profile', 'Discord 身份无效');
        profile.displayName = text(profile.displayName, '显示名', 100); profile.username = text(profile.username, '用户名', 100);
        store.upsertIdentity(profile, now());
        if (bridges.size >= 1000) fail(503, 'busy', '登录确认请求过多');
        const bridge = random(); bridges.set(sha(bridge), { discordId: profile.id, origin: flow.origin, challenge: flow.challenge, requestId: flow.requestId, expiresAt: now() + 60000 });
        const nonce = random();
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>MieMie Discord 登录</title><p>登录完成，请返回 MieMie Hub。若原窗口已关闭，请重新登录。</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${jsonScript({ type: 'miemie-registry-auth', code: bridge, requestId: flow.requestId })},${jsonScript(flow.origin)});}history.replaceState(null,'','/api/auth/callback');</script>`); return;
      }
      if (path === '/api/auth/exchange' && method === 'POST') {
        const body = await readJSON(req);
        if (!/^[A-Za-z0-9_-]{43}$/.test(body.code || '') || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier || '')) fail(400, 'invalid_bridge', '登录确认无效');
        const key = sha(body.code), bridge = bridges.get(key);
        if (!bridge || bridge.expiresAt <= now() || bridge.origin !== origin || bridge.requestId !== body.requestId || !safeEqual(bridge.challenge, sha(body.codeVerifier))) fail(400, 'invalid_bridge', '登录确认无效或已使用');
        bridges.delete(key);
        const user = store.getIdentity(bridge.discordId), token = random(), expiresAt = now() + config.sessionTtlMs;
        store.createSession(tokenHash(token), user.discord_id, origin, expiresAt);
        return send(res, 200, { token, expiresAt: new Date(expiresAt).toISOString(), profile: store.profileDTO(user), isAdmin: config.adminIds.has(user.discord_id), canSubmit: !user.banned });
      }
      if (path === '/api/me' && method === 'GET') { const auth = authenticate(req); return send(res, 200, { profile: store.profileDTO(auth.user), isAdmin: auth.isAdmin, canSubmit: !auth.user.banned }); }
      if (path === '/api/auth/logout' && method === 'POST') { const auth = authenticate(req); store.deleteSession(auth.session.hash); return send(res, 200, { ok: true }); }
      if (path.startsWith('/api/avatars/') && method === 'GET') {
        const key = path.slice('/api/avatars/'.length); if (!/^[a-f0-9-]{36}$/.test(key)) fail(404, 'not_found', '头像不存在');
        const avatar = store.getAvatar(key); if (!avatar) fail(404, 'not_found', '头像不存在');
        res.writeHead(200, { 'Content-Type': avatar.mime, 'Cache-Control': 'public, max-age=300' }); res.end(avatar.bytes); return;
      }
      if (path === '/api/catalog' && method === 'GET') {
        const page = Number(requestUrl.searchParams.get('page') || 1), pageSize = Number(requestUrl.searchParams.get('pageSize') || 20), source = requestUrl.searchParams.get('source'), q = requestUrl.searchParams.get('q') || '';
        if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50 || q.length > 100 || (source && !['github', 'discord'].includes(source))) fail(400, 'invalid_query', '分页或筛选参数无效');
        const { rows, total } = store.listCatalog({ page, pageSize, source, q });
        const items = rows.map(row => store.entryDTO(row));
        return send(res, 200, { items, page, pageSize, total, hasMore: page * pageSize < total });
      }
      if (/^\/api\/catalog\/[^/]+$/.test(path) && method === 'GET') { const row = entry(path.split('/').at(-1)); if (row.owner_status !== 'listed' || row.moderation !== 'visible') fail(404, 'not_found', '项目不可公开获取'); return send(res, 200, store.entryDTO(row)); }
      if (path === '/api/packages/github/asset' && method === 'POST') {
        if (requestUrl.search) fail(400, 'invalid_relay_request', '文件传输接口不接受 URL 查询参数');
        const ip = req.socket.remoteAddress || 'unknown';
        limit(`relay:${ip}`, 12, 60000);
        if (relayRequests.size >= 4 || [...relayRequests.values()].filter(value => value === ip).length >= 2) fail(429, 'relay_busy', '文件传输任务过多，请稍后重试');
        const body = await readJSON(req), controller = new AbortController(), cancel = () => controller.abort();
        // Count again after reading a possibly delayed request body.
        if (relayRequests.size >= 4 || [...relayRequests.values()].filter(value => value === ip).length >= 2) fail(429, 'relay_busy', '文件传输任务过多，请稍后重试');
        relayRequests.set(controller, ip); req.once('aborted', cancel); res.once('close', cancel);
        try {
          const bytes = await githubRelay.read(body, { signal: controller.signal });
          if (controller.signal.aborted || res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }); res.end(bytes);
        } finally { req.off('aborted', cancel); res.off('close', cancel); controller.abort(); relayRequests.delete(controller); }
        return;
      }
      if (path === '/api/github/preview' && method === 'GET') { const { user } = authenticate(req); canSubmit(user); limit(`preview:${user.discord_id}`, 10, 60000); return send(res, 200, await inspect(requestUrl.searchParams.get('url'))); }
      if (path === '/api/submissions' && method === 'GET') { const { user } = authenticate(req); return send(res, 200, { items: store.listOwn(user.discord_id).map(row => store.entryDTO(row, true)) }); }
      if (path === '/api/submissions' && method === 'POST') {
        const { user } = authenticate(req); canSubmit(user); limit(`submit:${user.discord_id}`, 5, 600000);
        if (store.countOwn(user.discord_id) >= 100) fail(429, 'submission_limit', '当前每个投稿者最多 100 条项目');
        const input = submissionInput(await readJSON(req)); if (input.sourceType === 'github') input.sourceUrl = input.sourceUrl.toLowerCase();
        if (store.sourceDuplicate(input.sourceUrl)) fail(409, 'duplicate_submission', '该来源已被收录；如存在归属争议请联系管理员');
        const discovered = input.sourceType === 'github' ? await inspect(input.sourceUrl) : null, id = randomUUID(), time = now();
        canSubmit(authenticate(req).user);
        if (store.sourceDuplicate(input.sourceUrl)) fail(409, 'duplicate_submission', '该来源已被收录');
        store.transaction(() => { store.insertSubmission({id,ownerId:user.discord_id,input,github:discovered,time}); store.audit(user.discord_id,'create',id,'',time); });
        return send(res, 201, store.entryDTO(entry(id), true));
      }
      const ownMatch = /^\/api\/submissions\/([^/]+)(?:\/(status))?$/.exec(path);
      if (ownMatch) {
        const { user } = authenticate(req), row = own(ownMatch[1], user);
        if (!ownMatch[2] && method === 'PATCH') {
          canSubmit(user); limit(`edit:${user.discord_id}`, 30, 60000);
          const body = await readJSON(req);
          const merged = { name: row.name, description: row.description, author: row.author, sourceType: row.source_type, sourceUrl: row.source_url, icon: row.icon, tags: JSON.parse(row.tags_json), ...body };
          const input = submissionInput(merged); if (input.sourceType === 'github') input.sourceUrl = input.sourceUrl.toLowerCase();
          const duplicate = store.sourceDuplicate(input.sourceUrl, row.id); if (duplicate) fail(409, 'duplicate_submission', '该来源已被收录');
          // Always revalidate source. Never carry version/hash information into another repo.
          const discovered = input.sourceType === 'github' ? await inspect(input.sourceUrl) : null, time = now();
          canSubmit(authenticate(req).user); own(row.id, user);
          if (store.sourceDuplicate(input.sourceUrl, row.id)) fail(409, 'duplicate_submission', '该来源已被收录');
          store.transaction(() => { store.updateSubmission({id:row.id,input,github:discovered,time}); store.audit(user.discord_id,'edit',row.id,'',time); });
          return send(res, 200, store.entryDTO(entry(row.id), true));
        }
        if (ownMatch[2] && method === 'POST') {
          const body = await readJSON(req); if (!['listed', 'unlisted'].includes(body.status)) fail(400, 'invalid_status', '状态必须为 listed 或 unlisted');
          if (body.status === 'listed') canSubmit(user);
          store.transaction(() => { store.setOwnerStatus(row.id,body.status,now()); store.audit(user.discord_id,body.status,row.id,'',now()); });
          return send(res, 200, store.entryDTO(entry(row.id), true));
        }
      }
      if (path === '/api/admin/submissions' && method === 'GET') { authenticate(req, true); const page = Number(requestUrl.searchParams.get('page') || 1); if (!Number.isInteger(page) || page < 1 || page > 10000) fail(400,'invalid_query','页码无效'); const {total,rows} = store.listAdmin(page); return send(res, 200, { items: rows.map(row => ({ ...store.entryDTO(row,true), ownerDiscordUserId: row.owner_id, submitterBanned: !!store.getIdentity(row.owner_id).banned })),page,pageSize:50,total,hasMore:page*50<total }); }
      const moderation = /^\/api\/admin\/submissions\/([^/]+)\/moderation$/.exec(path);
      if (moderation && method === 'POST') {
        const { user } = authenticate(req,true), row = entry(moderation[1]), body = await readJSON(req);
        const states = { hide: 'hidden', unlist: 'unlisted', restore: 'visible' };
        if (!states[body.action]) fail(400,'invalid_action','管理操作无效');
        const reason = text(body.reason,'原因',500,true);
        store.transaction(() => { store.setModeration(row.id,states[body.action],reason,now()); store.audit(user.discord_id,`admin_${body.action}`,row.id,reason,now()); });
        return send(res,200,store.entryDTO(entry(row.id),true));
      }
      const ban = /^\/api\/admin\/identities\/(\d{15,22})\/ban$/.exec(path);
      if (ban && method === 'POST') {
        const { user } = authenticate(req,true), target = store.getIdentity(ban[1]), body = await readJSON(req);
        if (!target) fail(404,'not_found','投稿者不存在'); if (typeof body.banned !== 'boolean') fail(400,'invalid_input','banned 必须为布尔值');
        const reason = text(body.reason,'原因',500,true);
        store.transaction(() => { store.setBanned(target.discord_id,body.banned); store.audit(user.discord_id,body.banned ? 'ban' : 'unban',target.discord_id,reason,now()); });
        return send(res,200,{ok:true});
      }
      fail(404, 'not_found', '接口不存在');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error.status || 500;
      if (status === 429) res.setHeader('Retry-After', String(error.retryAt ? Math.max(1, Math.ceil((Date.parse(error.retryAt) - now()) / 1000)) : 60));
      send(res, status, { error: { code: error.code || 'internal_error', message: status === 500 ? '服务暂时不可用' : error.message, ...(error.code === 'github_rate_limited' ? {retryAt: error.retryAt} : {}) } });
    }
  };
  return { handler, close() { for (const controller of relayRequests.keys()) controller.abort(); relayRequests.clear(); flows.clear(); bridges.clear(); rates.clear(); previewCache.clear(); }, store };
}

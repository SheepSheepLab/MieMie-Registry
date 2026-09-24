// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 SheepSheep
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { fail, plain, text, submissionInput } from './validation.js';
import { createDiscordAdapter, createGitHubAdapter } from './remote.js';
import { createGitHubRelay, createHubReleaseRelay } from './github-relay.js';
import {rolesFor,validateProduct,handleGovernance,moderationSnapshot} from './governance.js';
import {adminPage,adminScript} from './admin.js';
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
export function createApp({ config, store, discord = createDiscordAdapter(config), github = createGitHubAdapter(), githubRelay = createGitHubRelay(), hubRelay = createHubReleaseRelay(), now = Date.now, rateLimit = 120, catalogRefreshTtlMs = 900000, catalogRefreshWaitMs = 3000, catalogRefreshBudget = 8 } = {}) {
  store.bootstrapAdmins(config.adminIds || [],now());
  const flows = new Map(), bridges = new Map(), handoffs = new Map(), rates = new Map(), previewCache = new Map();
  const relayRequests = new Map();
  // OAuth access tokens exist only in process memory, bound to a Registry session.
  // Restart, logout or expiry loses access and requires a fresh Discord login.
  const sessionCredentials = new Map();
  const tokenHash = value => createHmac('sha256', config.sessionSecret).update(value).digest('hex');
  function prune() {
    for (const map of [flows, bridges, handoffs]) for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
    for (const [key, value] of rates) if (value.until <= now()) rates.delete(key);
    for (const [key, value] of sessionCredentials) if (value.expiresAt <= now()) sessionCredentials.delete(key);
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
    if (!session || session.origin !== (req.headers.origin || (req.headers['sec-fetch-site']==='same-origin' ? config.publicBaseUrl : '')) || !sessionCredentials.has(session.hash)) fail(401, 'session_expired', '登录已过期，请重新登录');
    const user = store.getIdentity(session.discord_id);
    if (!user) fail(401, 'unauthorized', '登录无效');
    const roleFlags = rolesFor(config,store,user), {isAdmin}=roleFlags;
    if (admin && !isAdmin) fail(403, 'forbidden', '需要管理员权限');
    return { user, session, ...roleFlags };
  }
  const canSubmit = user => { if (user.banned) fail(403, 'banned', '该 Discord 身份已被禁止投稿'); };
  const entry = id => { const row = store.getEntry(id); if (!row) fail(404, 'not_found', '项目不存在'); return row; };
  const own = (id, user) => { const row = entry(id); if (row.owner_id !== user.discord_id) fail(404, 'not_found', '项目不存在'); return row; };
  async function guildIds(auth) {
    if (!auth) return [];
    const credentials = sessionCredentials.get(auth.session.hash);
    if (!credentials || credentials.expiresAt <= now()) fail(401, 'session_expired', '登录已过期，请重新登录');
    limit(`membership:${auth.user.discord_id}`, 60, 60000);
    let ids;
    try { ids = await discord.listGuilds(credentials.accessToken); }
    catch { fail(503, 'membership_unavailable', '暂时无法验证 Discord 服务器成员资格，请稍后重试或重新登录'); }
    if (!Array.isArray(ids) || ids.length > 2000 || ids.some(id => typeof id !== 'string' || !/^\d{15,22}$/.test(id)) || new Set(ids).size !== ids.length) fail(503, 'membership_unavailable', 'Discord 服务器成员信息无效，请重新登录');
    if (!store.sessionByHash(auth.session.hash, now()) || !sessionCredentials.has(auth.session.hash)) fail(401, 'session_expired', '登录已过期，请重新登录');
    return ids;
  }
  const optionalAuth = req => req.headers.authorization ? authenticate(req) : null;
  async function validateVisibility(input, auth) {
    if (input.visibility === 'discord_guild' && !(await guildIds(auth)).includes(input.visibilityGuildId)) fail(403, 'guild_membership_required', '只能选择你当前已加入的 Discord 服务器');
  }
  async function inspect(url, fresh = false) {
    const cached = previewCache.get(url);
    if (!fresh && cached && cached.until > now()) return cached.result;
    const result = await github.inspect(url);
    if (previewCache.size > 1000) previewCache.clear();
    previewCache.set(url, { result, until: now() + 60000 }); return result;
  }
  const catalogRefresh = new Map();
  let refreshWindow = now(), refreshCount = 0;
  async function refreshCatalogRows(rows) {
    let started = 0;
    if (now() - refreshWindow >= 3600000) {refreshWindow = now(); refreshCount = 0;}
    const tasks = rows.filter(row => row.source_type === 'github').map(row => {
      const key = row.source_url;
      let cached = catalogRefresh.get(key);
      if (!cached || cached.until <= now()) {
        if (++started > 4 || refreshCount >= catalogRefreshBudget) return Promise.resolve();
        if (catalogRefresh.size >= 1000) for (const [k, v] of catalogRefresh) if (v.until <= now()) catalogRefresh.delete(k);
        if (catalogRefresh.size >= 1000) return Promise.resolve();
        refreshCount++;
        const promise = inspect(key).catch(() => null);
        cached = {promise, until: now() + catalogRefreshTtlMs}; catalogRefresh.set(key, cached);
      }
      return cached.promise.then(result => {
        const previous = row.github_json ? JSON.parse(row.github_json) : null;
        if (result && (result.compatibility === 'installable' || previous?.compatibility !== 'installable')) store.refreshGithub(row, result);
      }).catch(() => {});
    });
    let timer;
    try {await Promise.race([Promise.all(tasks), new Promise(resolve => {timer = setTimeout(resolve, catalogRefreshWaitMs);})]);}
    finally {clearTimeout(timer);}
  }
  function completeSession(key, bridge) {
    const user = store.getIdentity(bridge.discordId), token = random(), expiresAt = Math.min(now() + config.sessionTtlMs, bridge.credentials.expiresAt);
    if (expiresAt <= now()) fail(401, 'session_expired', 'Discord 授权已过期，请重新登录');
    if (sessionCredentials.size >= 10000) fail(503, 'busy', '登录会话过多');
    store.createSession(tokenHash(token), user.discord_id, bridge.origin, expiresAt);
    sessionCredentials.set(tokenHash(token), { accessToken: bridge.credentials.accessToken, expiresAt });
    // Both delivery paths consume the same one-use result, synchronously.
    bridges.delete(key); handoffs.delete(bridge.requestId);
    return { token, expiresAt: new Date(expiresAt).toISOString(), profile: store.profileDTO(user), ...rolesFor(config,store,user), canSubmit: !user.banned };
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
      if (path === '/health' && method === 'GET') {if(store.db.prepare('PRAGMA user_version').get().user_version!==3)throw Error('schema');store.db.prepare('SELECT id FROM submissions LIMIT 1').get();return send(res, 200, { status: 'ok', version: '0.3.1' });}
      if(path==='/admin'&&method==='GET') {
        res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(adminPage);return;
      }
      if(path==='/admin.js'&&method==='GET') {res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(adminScript);return;}
      if (path === '/' && method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>MieMie Registry</title><h1>MieMie Registry</h1><p>目录和 Discord 投稿服务。请从 MieMie Hub 扩展中心连接。</p><p>投稿默认上架，不代表安全审核或作者认证。</p>'); return; }
      if (path === '/api/auth/start' && method === 'POST') {
        if (!config.clientId || !config.clientSecret) fail(503, 'oauth_not_configured', 'Registry 尚未配置 Discord OAuth');
        limit(`auth:${req.socket.remoteAddress}`, 10, 600000);
        const body = await readJSON(req);
        if (body.returnOrigin !== origin || !/^[A-Za-z0-9_-]{43}$/.test(body.codeChallenge || '')) fail(400, 'invalid_auth_request', 'OAuth 来源或校验码无效');
        if (flows.size >= 1000 || handoffs.size >= 1000) fail(503, 'busy', '登录请求过多');
        const requestId = random(); flows.set(requestId, { requestId, origin, challenge: body.codeChallenge, expiresAt: now() + 300000, started: false });
        handoffs.set(requestId, { origin, challenge: body.codeChallenge, expiresAt: now() + 300000 });
        return send(res, 200, { authorizationUrl: `${config.publicBaseUrl}/api/auth/authorize?requestId=${requestId}`, requestId, handoff: 'poll-v1' });
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
        const { profile, credentials } = await discord.exchange(code);
        if (!plain(profile) || !plain(credentials) || typeof credentials.accessToken !== 'string' || !credentials.accessToken || credentials.accessToken.length > 4096 || !Number.isSafeInteger(credentials.expiresAt) || credentials.expiresAt <= now() || !Array.isArray(credentials.scopes) || !['identify', 'guilds'].every(scope => credentials.scopes.includes(scope))) fail(502, 'discord_auth_failed', 'Discord 授权不完整，请重新登录');
        if (!/^\d{15,22}$/.test(profile.id || '')) fail(502, 'invalid_profile', 'Discord 身份无效');
        profile.displayName = text(profile.displayName, '显示名', 100); profile.username = text(profile.username, '用户名', 100);
        store.upsertIdentity(profile, now());
        if (bridges.size >= 1000) fail(503, 'busy', '登录确认请求过多');
        const bridge = random(); bridges.set(sha(bridge), { discordId: profile.id, credentials, origin: flow.origin, challenge: flow.challenge, requestId: flow.requestId, expiresAt: now() + 60000 });
        const handoff = handoffs.get(flow.requestId);
        if (handoff) { handoff.bridgeKey = sha(bridge); handoff.expiresAt = now() + 60000; }
        const nonce = random();
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>MieMie Discord 登录</title><p>登录完成，请返回 MieMie Hub。若原窗口已关闭，请重新登录。</p><script nonce="${nonce}">try{if(window.opener){window.opener.postMessage(${jsonScript({ type: 'miemie-registry-auth', code: bridge, requestId: flow.requestId })},${jsonScript(flow.origin)});}}catch{}history.replaceState(null,'','/api/auth/callback');</script>`); return;
      }
      if (path === '/api/auth/complete' && method === 'POST') {
        const body = await readJSON(req);
        if (!/^[A-Za-z0-9_-]{43}$/.test(body.requestId || '') || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier || '')) fail(400, 'invalid_handoff', '登录交接无效或已过期，请重新登录');
        const handoff = handoffs.get(body.requestId);
        if (!handoff || handoff.expiresAt <= now() || handoff.origin !== origin || !safeEqual(handoff.challenge, sha(body.codeVerifier))) fail(400, 'invalid_handoff', '登录交接无效或已过期，请重新登录');
        limit(`handoff:${body.requestId}`, 40, 60000);
        if (!handoff.bridgeKey) return send(res, 202, { status: 'pending' });
        const bridge = bridges.get(handoff.bridgeKey);
        if (!bridge || bridge.expiresAt <= now()) fail(400, 'invalid_handoff', '登录交接无效或已过期，请重新登录');
        return send(res, 200, completeSession(handoff.bridgeKey, bridge));
      }
      if (path === '/api/auth/exchange' && method === 'POST') {
        const body = await readJSON(req);
        if (!/^[A-Za-z0-9_-]{43}$/.test(body.code || '') || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.codeVerifier || '')) fail(400, 'invalid_bridge', '登录确认无效');
        const key = sha(body.code), bridge = bridges.get(key);
        if (!bridge || bridge.expiresAt <= now() || bridge.origin !== origin || bridge.requestId !== body.requestId || !safeEqual(bridge.challenge, sha(body.codeVerifier))) fail(400, 'invalid_bridge', '登录确认无效或已使用');
        return send(res, 200, completeSession(key, bridge));
      }
      if (path === '/api/me' && method === 'GET') { const auth = authenticate(req); return send(res, 200, { profile: store.profileDTO(auth.user), isAdmin: auth.isAdmin, isOwner: auth.isOwner, canPublishOfficial: auth.canPublishOfficial, canSubmit: !auth.user.banned }); }
      if (path === '/api/auth/logout' && method === 'POST') { const auth = authenticate(req); store.deleteSession(auth.session.hash); sessionCredentials.delete(auth.session.hash); return send(res, 200, { ok: true }); }
      if (path.startsWith('/api/avatars/') && method === 'GET') {
        const key = path.slice('/api/avatars/'.length); if (!/^[a-f0-9-]{36}$/.test(key)) fail(404, 'not_found', '头像不存在');
        const avatar = store.getAvatar(key); if (!avatar) fail(404, 'not_found', '头像不存在');
        res.writeHead(200, { 'Content-Type': avatar.mime, 'Cache-Control': 'public, max-age=300' }); res.end(avatar.bytes); return;
      }
      if (path === '/api/catalog' && method === 'GET') {
        const page = Number(requestUrl.searchParams.get('page') || 1), pageSize = Number(requestUrl.searchParams.get('pageSize') || 20), source = requestUrl.searchParams.get('source'), q = requestUrl.searchParams.get('q') || '';
        if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50 || q.length > 100 || (source && !['github', 'discord'].includes(source))) fail(400, 'invalid_query', '分页或筛选参数无效');
        const permittedGuilds = await guildIds(optionalAuth(req));
        const query = { page, pageSize, source, q, guildIds: permittedGuilds };
        await refreshCatalogRows(store.listCatalog(query).rows);
        const { rows, total } = store.listCatalog(query);
        const items = rows.map(row => store.entryDTO(row));
        return send(res, 200, { items, page, pageSize, total, hasMore: page * pageSize < total });
      }
      if (/^\/api\/catalog\/[^/]+$/.test(path) && method === 'GET') {
        const permittedGuilds = await guildIds(optionalAuth(req)); let row = store.getEntry(path.split('/').at(-1));
        if (!row || row.owner_status !== 'listed' || row.moderation !== 'visible' || (row.visibility !== 'public' && !permittedGuilds.includes(row.visibility_guild_id))) fail(404, 'not_found', '项目不存在');
        await refreshCatalogRows([row]); row = store.getEntry(row.id);
        if (!row || row.owner_status !== 'listed' || row.moderation !== 'visible' || (row.visibility !== 'public' && !permittedGuilds.includes(row.visibility_guild_id))) fail(404, 'not_found', '项目不存在');
        return send(res, 200, store.entryDTO(row));
      }
      if (['/api/packages/github/asset', '/api/hub/releases/asset'].includes(path) && method === 'POST') {
        if (requestUrl.search) fail(400, 'invalid_relay_request', '文件传输接口不接受 URL 查询参数');
        const ip = req.socket.remoteAddress || 'unknown';
        limit(`relay:${ip}`, 12, 60000);
        if (relayRequests.size >= 4 || [...relayRequests.values()].filter(value => value === ip).length >= 2) fail(429, 'relay_busy', '文件传输任务过多，请稍后重试');
        const body = await readJSON(req), controller = new AbortController(), cancel = () => controller.abort();
        // Count again after reading a possibly delayed request body.
        if (relayRequests.size >= 4 || [...relayRequests.values()].filter(value => value === ip).length >= 2) fail(429, 'relay_busy', '文件传输任务过多，请稍后重试');
        relayRequests.set(controller, ip); req.once('aborted', cancel); res.once('close', cancel);
        try {
          const bytes = await (path === '/api/hub/releases/asset' ? hubRelay : githubRelay).read(body, { signal: controller.signal });
          if (controller.signal.aborted || res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }); res.end(bytes);
        } finally { req.off('aborted', cancel); res.off('close', cancel); controller.abort(); relayRequests.delete(controller); }
        return;
      }
      if (path === '/api/github/preview' && method === 'GET') { const { user } = authenticate(req); canSubmit(user); limit(`preview:${user.discord_id}`, 10, 60000); return send(res, 200, await inspect(requestUrl.searchParams.get('url'))); }
      if (path === '/api/submissions' && method === 'GET') { const { user } = authenticate(req); return send(res, 200, { items: store.listOwn(user.discord_id).map(row => store.entryDTO(row, true)) }); }
      if (path === '/api/submissions' && method === 'POST') {
        const auth = authenticate(req), { user } = auth; canSubmit(user); limit(`submit:${user.discord_id}`, 5, 600000);
        if (store.countOwn(user.discord_id) >= 100) fail(429, 'submission_limit', '当前每个投稿者最多 100 条项目');
        const body=await readJSON(req);const input = submissionInput(body); if (input.sourceType === 'github') input.sourceUrl = input.sourceUrl.toLowerCase();
        if (store.sourceDuplicate(input.sourceUrl, user.discord_id)) fail(409, 'duplicate_submission', '你已提交过该来源，可在我的投稿中编辑');
        const discovered = input.sourceType === 'github' ? await inspect(input.sourceUrl) : null, id = randomUUID(), time = now();
        if(body.distribution===undefined&&input.type==='tavern_extension'&&discovered?.compatibility==='installable')input.distribution='managed_install';
        await validateVisibility(input, auth);
        const refreshed=authenticate(req);canSubmit(refreshed.user);validateProduct(input,discovered,refreshed);
        if (store.sourceDuplicate(input.sourceUrl, user.discord_id)) fail(409, 'duplicate_submission', '你已提交过该来源，可在我的投稿中编辑');
        store.transaction(() => { store.insertSubmission({id,ownerId:user.discord_id,input,github:discovered,time}); store.audit(user.discord_id,'create',id,'',time,null,{submitterId:user.discord_id,ownerId:user.discord_id,classification:input.classification});if(input.classification==='official')store.audit(user.discord_id,'classification',id,'official submission',time,{classification:null},moderationSnapshot(entry(id))); });
        return send(res, 201, store.entryDTO(entry(id), true));
      }
      const ownMatch = /^\/api\/submissions\/([^/]+)(?:\/(status))?$/.exec(path);
      if (ownMatch) {
        const auth = authenticate(req), { user } = auth, row = own(ownMatch[1], user);
        if (!ownMatch[2] && method === 'PATCH') {
          canSubmit(user); limit(`edit:${user.discord_id}`, 30, 60000);
          const body = await readJSON(req);
          const merged = { name: row.name, description: row.description, author: row.author, sourceType: row.source_type, sourceUrl: row.source_url, icon: row.icon, tags: JSON.parse(row.tags_json), visibility: row.visibility, visibilitySourceUrl: row.visibility_source_url, type:row.product_type,distribution:row.distribution,platforms:JSON.parse(row.platforms_json),websiteUrl:row.website_url,classification:row.classification, ...body };
          if (merged.sourceType === 'discord' && Object.hasOwn(body, 'sourceUrl') && !Object.hasOwn(body, 'visibilitySourceUrl')) merged.visibilitySourceUrl = null;
          const input = submissionInput(merged); if (input.sourceType === 'github') input.sourceUrl = input.sourceUrl.toLowerCase();
          const duplicate = store.sourceDuplicate(input.sourceUrl, user.discord_id, row.id); if (duplicate) fail(409, 'duplicate_submission', '你已提交过该来源，可在我的投稿中编辑');
          // Always revalidate source. Never carry version/hash information into another repo.
          const discovered = input.sourceType === 'github' ? await inspect(input.sourceUrl, input.sourceUrl !== row.source_url) : null, time = now();
          await validateVisibility(input, auth);
          const refreshed=authenticate(req);canSubmit(refreshed.user);own(row.id,user);validateProduct(input,discovered,refreshed,row);
          if (store.sourceDuplicate(input.sourceUrl, user.discord_id, row.id)) fail(409, 'duplicate_submission', '你已提交过该来源，可在我的投稿中编辑');
          store.transaction(() => { store.updateSubmission({id:row.id,input,github:discovered,time}); store.audit(user.discord_id,'edit',row.id,'',time);if(row.classification!==input.classification)store.audit(user.discord_id,'classification',row.id,'submitter classification change',time,moderationSnapshot(row),moderationSnapshot(entry(row.id))); });
          return send(res, 200, store.entryDTO(entry(row.id), true));
        }
        if (ownMatch[2] && method === 'POST') {
          const body = await readJSON(req); if (!['listed', 'unlisted'].includes(body.status)) fail(400, 'invalid_status', '状态必须为 listed 或 unlisted');
          canSubmit(user);
          if (body.status === 'listed') await validateVisibility({ visibility: row.visibility, visibilityGuildId: row.visibility_guild_id }, auth);
          canSubmit(authenticate(req).user); own(row.id, user);
          store.transaction(() => { store.setOwnerStatus(row.id,body.status,now()); store.audit(user.discord_id,body.status,row.id,'',now()); });
          return send(res, 200, store.entryDTO(entry(row.id), true));
        }
      }
      if(path.startsWith('/api/admin/')) {
        const auth=authenticate(req,true);
        // Read body first, then re-read roles/ban to prevent revocation races.
        const body=method==='GET'?null:await readJSON(req);
        return send(res,200,handleGovernance({path,method,body,auth:authenticate(req,true),store,config,now,query:requestUrl.searchParams}));
      }
      fail(404, 'not_found', '接口不存在');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error.status || 500;
      if (status === 429) res.setHeader('Retry-After', String(error.retryAt ? Math.max(1, Math.ceil((Date.parse(error.retryAt) - now()) / 1000)) : 60));
      send(res, status, { error: { code: error.code || 'internal_error', message: status === 500 ? '服务暂时不可用' : error.message, ...(error.code === 'github_rate_limited' ? {retryAt: error.retryAt} : {}) } });
    }
  };
  return { handler, close() { for (const controller of relayRequests.keys()) controller.abort(); relayRequests.clear(); sessionCredentials.clear(); flows.clear(); bridges.clear(); handoffs.clear(); rates.clear(); previewCache.clear(); }, store };
}

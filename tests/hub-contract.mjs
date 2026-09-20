// Explicit cross-project artifact contract test. Intentionally not *.test.mjs:
// Registry's normal build/test never imports or requires another project tree.
// No real OAuth credentials, Discord users, community submissions or GitHub calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash, webcrypto} from 'node:crypto';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {loadConfig} from '../src/config.js';
import {openStore} from '../src/store.js';
import {createApp} from '../src/app.js';

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const [name, value] = process.argv.slice(i, i + 2);
  if (!['--hub', '--hub-client', '--sha256', '--report'].includes(name) || !value || flags.has(name)) throw Error('Usage: node tests/hub-contract.mjs (--hub <built JSON> | --hub-client <explicit snapshot>) --sha256 <expected hash> [--report <JSON>]');
  flags.set(name, value);
}
if (Number(flags.has('--hub')) + Number(flags.has('--hub-client')) !== 1 || !/^[a-f0-9]{64}$/.test(flags.get('--sha256') || '')) throw Error('An explicit Hub artifact/snapshot and its locked SHA-256 are required.');
const artifactBytes = await readFile(flags.get('--hub') || flags.get('--hub-client'));
const artifactHash = createHash('sha256').update(artifactBytes).digest('hex');
assert.equal(artifactHash, flags.get('--sha256'), 'Hub artifact changed from the explicit locked version');
let clientSource, hubVersion = null;
if (flags.has('--hub')) {
  const script = JSON.parse(artifactBytes.toString('utf8'));
  assert.equal(script.type, 'script'); assert.equal(script.id, 'e85cd9a3-6352-4b23-938a-6c94d826b4d3');
  const identity = JSON.parse(script.content.split('\n')[0].slice('// MieMie-Hub-Build: '.length));
  assert.equal(identity.productId, 'miemie.hub'); hubVersion = identity.version;
  const start = script.content.indexOf('// Registry sessions are kept only');
  const end = script.content.indexOf('// Downloaded scripts are never evaluated', start);
  assert.ok(start > 0 && end > start, 'Expected Registry client boundary was not found in this Hub artifact');
  clientSource = script.content.slice(start, end);
} else clientSource = artifactBytes.toString('utf8').replace(/^export /gm, '');
assert.ok(!/^import /m.test(clientSource), 'The client snapshot must be self-contained');
const createRegistryClient = vm.runInNewContext('(function(){\n' + clientSource + '\nreturn createRegistryClient;})()', {
  URL, TextEncoder, TextDecoder, Uint8Array, AbortController, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
}, {timeout: 1000, filename: 'locked-hub-registry-client'});

const ORIGIN = 'http://localhost:8000';
const IDS = {A: '711111111111111111', B: '722222222222222222', ADMIN: '733333333333333333'};
const tests = [], clients = [], popups = [], requests = [], oauthErrors = [];
const record = (name, operation) => Promise.resolve().then(operation).then(() => tests.push({name, passed: true}));
const fixtureDirectory = await mkdtemp(join(tmpdir(), 'miemie-registry-hub-contract-'));
const databasePath = join(fixtureDirectory, 'isolated-test.sqlite');
const store = openStore(databasePath);
const config = loadConfig({DISCORD_CLIENT_ID: '000000000000000001', DISCORD_CLIENT_SECRET: 'test-only-discord-contract-secret',
  SESSION_SECRET: 'test-only-hub-contract-session-secret-xxxxxxxx', MIEMIE_ADMIN_DISCORD_IDS: IDS.ADMIN});
let clock = Date.now();
const profiles = Object.fromEntries(Object.entries(IDS).map(([name,id]) => [name, {id, displayName: 'Development Fixture ' + name, username: 'fixture_' + name, avatarBytes: null}]));
const githubCalls = [];
const GUILD = '744444444444444444';
const memberships = {A: [GUILD], B: [], ADMIN: []};
let membershipUnavailable = false;
const app = createApp({config, store, now: () => clock, rateLimit: 10000,
  discord: {authorizationUrl: state => 'https://discord.com/oauth2/authorize?state=' + encodeURIComponent(state), async exchange(code) {
    assert.ok(profiles[code], 'Mock Discord code unknown'); return {profile: {...profiles[code]}, credentials: {accessToken: 'test-only-' + code, expiresAt: clock + 3600000, scopes: ['identify','guilds']}};
  }, async listGuilds(token) { if (membershipUnavailable) throw Error('Development Fixture Discord outage'); const code = token.replace('test-only-', ''); assert.ok(memberships[code]); return [...memberships[code]]; }},
  github: {async inspect(repoURL) {
    githubCalls.push(repoURL); const url = new URL(repoURL); const [,owner,repo] = url.pathname.split('/');
    return {owner, repo, compatibility: 'external', manifest: {schemaVersion: 1, apiVersion: 1, id: 'fixture.contract', name: 'Development Fixture GitHub', author: 'Actual Work Author',
      version: '1.0.0', description: 'Explicit integration test data.', entry: 'fixture.js', repository: repoURL, license: 'MIT'}, release: {id: 101, tag: 'v1.0.0', version: '1.0.0'}, reason: 'Development Fixture: no binary package'};
  }},
});
const server = createServer(app.handler);
await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
const base = 'http://127.0.0.1:' + server.address().port;
// Config is intentionally changed before the first request: the test's ephemeral
// port is not known until listen() completes, but OAuth must return this origin.
config.publicBaseUrl = base; config.redirectUri = base + '/api/auth/callback'; config.allowedOrigins.add(base);
const submit = patch => ({name: 'Development Fixture GitHub', author: 'Actual Work Author', description: 'Contract test fixture, not a community endorsement.',
  sourceType: 'github', sourceUrl: 'https://github.com/DevelopmentFixture/Contract', icon: '', tags: ['test'], ...patch});
const anonymous = async path => {
  const response = await fetch(base + path, {headers: {Origin: ORIGIN}, redirect: 'error'});
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN); return {status: response.status, value: await response.json()};
};
function browserClient(who = 'A') {
  const listeners = new Set(); let account = who;
  const host = {location: {origin: ORIGIN}, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    addEventListener(type, listener) {assert.equal(type, 'message'); listeners.add(listener);},
    removeEventListener(type, listener) {assert.equal(type, 'message'); listeners.delete(listener);},
    open(url) {
      assert.equal(url, 'about:blank');
      const popup = {closed: false, close() {this.closed = true;}}; popups.push(popup);
      async function navigate(href) {
        try {
          assert.equal(new URL(href).origin, base);
          const authorize = await fetch(href, {redirect: 'manual'}); assert.equal(authorize.status, 302);
          const location = new URL(authorize.headers.get('location')); assert.equal(location.origin, 'https://discord.com');
          const cookie = authorize.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
          assert.match(authorize.headers.get('set-cookie'), /HttpOnly/); assert.match(authorize.headers.get('set-cookie'), /SameSite=Lax/);
          const callback = await fetch(base + '/api/auth/callback?state=' + encodeURIComponent(location.searchParams.get('state')) + '&code=' + account,
            {headers: {Cookie: cookie}, redirect: 'manual'});
          assert.equal(callback.status, 200); const html = await callback.text();
          const bridgeMatch = html.match(/postMessage\((\{.*?\}),([^;]+)\);/); assert.ok(bridgeMatch, 'Registry callback omitted its message contract');
          const data = JSON.parse(bridgeMatch[1]), targetOrigin = JSON.parse(bridgeMatch[2]); assert.equal(targetOrigin, ORIGIN);
          assert.equal(data.type, 'miemie-registry-auth'); assert.equal(typeof data.code, 'string');
          assert.ok(!html.includes(IDS[account])); assert.ok(!html.includes(config.clientSecret));
          // Wrong source/origin must not be accepted before the actual callback.
          for (const listener of listeners) listener({origin: 'https://untrusted.invalid', source: popup, data});
          for (const listener of listeners) listener({origin: base, source: {}, data});
          for (const listener of listeners) listener({origin: base, source: popup, data});
        } catch (error) {oauthErrors.push(error); popup.close();}
      }
      popup.location = {set href(value) {void navigate(value);}}; return popup;
    },
  };
  const client = createRegistryClient({host, crypto: webcrypto, timeoutMs: 3000, loginTimeoutMs: 5000,
    fetch: async (url, options) => {
      assert.equal(new URL(url).origin, base, 'Client must send all Registry credentials only to configured Registry');
      assert.equal(options.credentials, 'omit'); assert.equal(options.mode, 'cors'); assert.equal(options.redirect, 'error');
      const headers = {...options.headers, Origin: ORIGIN};
      requests.push({path: new URL(url).pathname, hasAuthorization: Object.hasOwn(headers, 'Authorization'), body: options.body || ''});
      const result = await fetch(url, {...options, headers});
      assert.equal(result.headers.get('access-control-allow-origin'), ORIGIN, 'Real route returned incompatible CORS response');
      return result;
    },
  });
  client.setBase(base); clients.push(client);
  return {client, setAccount: value => {account = value;}, listenerCount: () => listeners.size};
}

try {
  const a = browserClient('A'), b = browserClient('B'), admin = browserClient('ADMIN');
  let github, discord;
  await record('unauthenticated Hub can read Catalog but cannot submit', async () => {
    assert.equal((await a.client.api('/api/catalog')).total, 0);
    await assert.rejects(a.client.api('/api/submissions', {method: 'POST', body: submit({}), authenticated: true}), /Discord/);
  });
  await record('actual Hub login executes OAuth cookie, state, callback source and PKCE exchange over HTTP', async () => {
    const result = await a.client.login(); assert.equal(result.profile.displayName, profiles.A.displayName); assert.equal(result.isAdmin, false);
    assert.equal(a.listenerCount(), 0); assert.ok(popups.at(-1).closed); assert.equal(oauthErrors.length, 0);
    const exchange = requests.find(item => item.path === '/api/auth/exchange'); assert.ok(exchange);
    const body = JSON.parse(exchange.body); assert.match(body.codeVerifier, /^[A-Za-z0-9_-]{43}$/); assert.equal(exchange.hasAuthorization, false);
    await assert.rejects(a.client.api('/api/auth/exchange', {method: 'POST', body}), /无效|使用/);
  });
  await record('GitHub preview and GitHub/Discord create use the same routes and payload shapes as Hub', async () => {
    const preview = await a.client.api('/api/github/preview?url=' + encodeURIComponent(submit({}).sourceUrl), {authenticated: true});
    assert.equal(preview.manifest.author, 'Actual Work Author');
    github = await a.client.api('/api/submissions', {method: 'POST', body: submit({}), authenticated: true});
    const post = 'https://discord.com/channels/744444444444444444/755555555555555555/766666666666666666';
    discord = await a.client.api('/api/submissions', {method: 'POST', body: submit({name: 'Development Fixture Discord', sourceType: 'discord', sourceUrl: post}), authenticated: true});
    assert.equal(github.author, 'Actual Work Author'); assert.equal(github.submitter.displayName, profiles.A.displayName);
    assert.equal(discord.sourceUrl, post); assert.equal(discord.github, null); assert.equal(discord.version, null); assert.ok(githubCalls.length > 0);
  });
  await record('owner list/edit/unlist/relist contract updates public Catalog without deleting records', async () => {
    const mine = await a.client.api('/api/submissions', {authenticated: true}); assert.equal(mine.items.length, 2);
    await a.client.api('/api/submissions/' + github.id, {method: 'PATCH', body: {name: 'Edited Fixture', description: 'Edited through Hub client'}, authenticated: true});
    assert.equal((await a.client.api('/api/catalog/' + github.id)).name, 'Edited Fixture');
    await a.client.api('/api/submissions/' + github.id + '/status', {method: 'POST', body: {status: 'unlisted'}, authenticated: true});
    assert.equal((await a.client.api('/api/catalog')).total, 1);
    assert.equal((await a.client.api('/api/submissions', {authenticated: true})).items.find(item => item.id === github.id).status, 'unlisted');
    await a.client.api('/api/submissions/' + github.id + '/status', {method: 'POST', body: {status: 'listed'}, authenticated: true});
    assert.equal((await a.client.api('/api/catalog')).total, 2);
  });
  await record('a second real Hub session cannot edit or unlist the first identity submissions', async () => {
    await b.client.login(); assert.equal((await b.client.api('/api/submissions', {authenticated: true})).items.length, 0);
    await assert.rejects(b.client.api('/api/submissions/' + github.id, {method: 'PATCH', body: {name: 'stolen'}, authenticated: true}), /自己的|不存在|不可管理/);
    await assert.rejects(b.client.api('/api/submissions/' + github.id + '/status', {method: 'POST', body: {status: 'unlisted'}, authenticated: true}), /自己的|不存在|不可管理/);
    await assert.rejects(b.client.api('/api/admin/submissions', {authenticated: true}), /管理员/);
  });
  await record('profile refresh updates display name/avatar while preserving immutable owner and avatar privacy', async () => {
    await a.client.logout(); assert.equal(a.client.getIdentity(), null);
    profiles.A = {...profiles.A, displayName: 'Changed Fixture Display', username: 'changed_fixture_username', avatarBytes: Buffer.from([137,80,78,71,13,10,26,10])};
    await a.client.login(); const profile = a.client.getIdentity().profile;
    assert.equal(profile.displayName, profiles.A.displayName); assert.match(profile.avatarUrl, /^\/api\/avatars\/[a-f0-9-]+$/);
    const avatar = await fetch(new URL(profile.avatarUrl, base)); assert.equal(avatar.status, 200); assert.equal(avatar.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), profiles.A.avatarBytes);
    const mine = await a.client.api('/api/submissions', {authenticated: true}); assert.ok(mine.items.some(item => item.id === github.id));
    assert.equal(store.db.prepare('SELECT owner_id FROM submissions WHERE id=?').get(github.id).owner_id, IDS.A);
    assert.equal((await a.client.api('/api/catalog/' + github.id)).submitter.displayName, profiles.A.displayName);
  });
  await record('admin route contract can hide/restore and ban/unban without granting public identity access', async () => {
    await admin.client.login(); assert.equal(admin.client.getIdentity().isAdmin, true);
    const rows = await admin.client.api('/api/admin/submissions', {authenticated: true}); assert.ok(rows.items.some(item => item.ownerDiscordUserId === IDS.A));
    const moderate = action => admin.client.api('/api/admin/submissions/' + github.id + '/moderation', {method: 'POST', authenticated: true, body: {action, reason: 'Development Fixture moderation'}});
    await moderate('hide'); assert.equal((await a.client.api('/api/catalog')).total, 1);
    const own = (await a.client.api('/api/submissions', {authenticated: true})).items.find(item => item.id === github.id);
    assert.equal(own.status, 'listed'); assert.equal(own.moderation, 'hidden'); await moderate('restore');
    const ban = banned => admin.client.api('/api/admin/identities/' + IDS.A + '/ban', {method: 'POST', authenticated: true, body: {banned, reason: 'Development Fixture ban'}});
    await ban(true); await assert.rejects(a.client.api('/api/submissions/' + github.id, {method: 'PATCH', body: {name: 'blocked'}, authenticated: true}), /禁止投稿/); await ban(false);
  });
  await record('Guild Catalog ACL filters actual Hub member, anonymous and nonmember list/detail/search/count', async () => {
    const restricted = await a.client.api('/api/submissions', {method:'POST', authenticated:true, body:submit({name:'Secret ACL Fixture', sourceType:'discord', sourceUrl:`https://discord.com/channels/${GUILD}/755555555555555555/777777777777777777`, visibility:'discord_guild'})});
    const member = await a.client.api('/api/catalog?q=Secret&pageSize=1', {authenticated:true});
    assert.equal(member.total,1); assert.equal(member.items[0].id,restricted.id); assert.equal(member.hasMore,false);
    for (const client of [null,b.client]) {
      const page = client ? await client.api('/api/catalog?q=Secret', {authenticated:true}) : (await anonymous('/api/catalog?q=Secret')).value;
      assert.equal(page.total,0); assert.deepEqual(Array.from(page.items),[]); assert.equal(page.hasMore,false);
      if(client) await assert.rejects(client.api('/api/catalog/'+restricted.id,{authenticated:true}),/不存在|不可/);
      else assert.equal((await anonymous('/api/catalog/'+restricted.id)).status,404);
    }
    const anon = (await anonymous('/api/catalog?visibility=public&guildId='+GUILD)).value;
    assert.ok(!JSON.stringify(anon).includes('Secret ACL Fixture'));
    assert.equal('visibilityGuildId' in member.items[0],false);
    await assert.rejects(b.client.api('/api/submissions',{method:'POST',authenticated:true,body:submit({sourceType:'discord',sourceUrl:`https://discord.com/channels/${GUILD}/755555555555555555/788888888888888888`,visibility:'discord_guild'})}),/成员|权限|已加入/);
    memberships.A=[];
    assert.equal((await a.client.api('/api/catalog?q=Secret',{authenticated:true})).total,0);
    await assert.rejects(a.client.api('/api/submissions/'+restricted.id,{method:'PATCH',authenticated:true,body:{description:'Lost membership'}}),/成员|权限|已加入/);
    memberships.A=[GUILD]; membershipUnavailable=true;
    await assert.rejects(a.client.api('/api/catalog?q=Secret',{authenticated:true}),/服务器|Discord|成员|暂时|验证/);
    membershipUnavailable=false;
    await a.client.api('/api/submissions/'+restricted.id+'/status',{method:'POST',authenticated:true,body:{status:'unlisted'}});
    memberships.A=[];
    await assert.rejects(a.client.api('/api/submissions/'+restricted.id+'/status',{method:'POST',authenticated:true,body:{status:'listed'}}),/成员|权限|已加入/);
    memberships.A=[GUILD];
  });
  await record('GitHub uses same Guild ACL; URL edits revalidate membership and cannot reveal another owners hidden duplicate', async () => {
    const sourceUrl='https://github.com/DevelopmentFixture/PrivateCatalog';
    const hidden = await a.client.api('/api/submissions',{method:'POST',authenticated:true,body:submit({sourceUrl,name:'Private Github Fixture',visibility:'discord_guild',visibilitySourceUrl:`https://discord.com/channels/${GUILD}/755555555555555555/799999999999999999`})});
    assert.equal((await a.client.api('/api/catalog?q=Private',{authenticated:true})).total,1);
    assert.equal((await b.client.api('/api/catalog?q=Private',{authenticated:true})).total,0);
    const ownDuplicate = await b.client.api('/api/submissions',{method:'POST',authenticated:true,body:submit({sourceUrl,name:'Separate Submission Fixture'})});
    assert.notEqual(ownDuplicate.id,hidden.id);
    await assert.rejects(a.client.api('/api/submissions/'+hidden.id,{method:'PATCH',authenticated:true,body:{visibilitySourceUrl:'https://discord.com/channels/899999999999999999/755555555555555555/799999999999999999'}}),/成员|权限|已加入/);
    await assert.rejects(a.client.api('/api/submissions/'+hidden.id,{method:'PATCH',authenticated:true,body:{visibilityGuildId:GUILD}}),/字段|无效|允许/);
    await a.client.api('/api/submissions/'+hidden.id+'/status',{method:'POST',authenticated:true,body:{status:'unlisted'}});
    await b.client.api('/api/submissions/'+ownDuplicate.id+'/status',{method:'POST',authenticated:true,body:{status:'unlisted'}});
  });
  await record('public Catalog JSON has no private Discord identity, credentials or moderation internals', async () => {
    const {status, value} = await anonymous('/api/catalog'); assert.equal(status, 200); const text = JSON.stringify(value);
    for (const secret of [...Object.values(IDS), profiles.A.username, config.clientSecret, config.sessionSecret]) assert.ok(!text.includes(secret));
    for (const field of ['discord_id','owner_id','ownerDiscordUserId','username','email','token','session','moderation','banned']) assert.ok(!text.includes('"' + field + '"'));
    assert.equal(value.items.find(item => item.id === discord.id).sourceUrl, discord.sourceUrl);
    assert.equal((await a.client.api('/api/catalog?source=discord&page=1&pageSize=1&q=Fixture')).total, 1);
  });
  await record('expiry clears client identity and successful logout revokes its Registry session', async () => {
    clock += config.sessionTtlMs + 1;
    await assert.rejects(a.client.me(), /过期|登录/); assert.equal(a.client.getIdentity(), null);
    await b.client.login(); await b.client.logout(); assert.equal(b.client.getIdentity(), null); assert.equal(b.listenerCount(), 0);
  });
  await record('file-backed SQLite persists ownership and Catalog after reopen', async () => {
    const reopened = openStore(databasePath);
    try {assert.equal(reopened.db.prepare('SELECT owner_id FROM submissions WHERE id=?').get(github.id).owner_id, IDS.A); assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM submissions').get().n, 5);}
    finally {reopened.close();}
  });
  assert.equal(oauthErrors.length, 0);
  const report = {suite: 'Hub Registry explicit artifact contract', fixture: 'Development Fixture / Test Data', hubVersion, hubArtifactSha256: artifactHash,
    transport: 'Actual localhost HTTP with browser Origin adapter; Discord/GitHub adapters mocked; no production credentials',
    storage: 'Isolated temporary file-backed SQLite', checks: tests.length, passed: tests.length, failed: 0, tests};
  if (flags.has('--report')) await writeFile(flags.get('--report'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const client of clients) client.dispose(); for (const popup of popups) popup.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.close(); store.close();
  await rm(fixtureDirectory, {recursive: true, force: true});
}

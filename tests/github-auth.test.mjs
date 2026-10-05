import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, verify, randomBytes} from 'node:crypto';
import {mkdtempSync, writeFileSync, chmodSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createGitHubAuth} from '../src/github-auth.js';
import {createGitHubClient} from '../src/github-client.js';
import {loadConfig} from '../src/config.js';
import {fixture} from './helpers.mjs';

function keyFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'miemie-auth-test-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength:2048});
  const path = join(dir, 'ephemeral.pem'); writeFileSync(path, privateKey.export({type:'pkcs8',format:'pem'}), {mode:0o600});
  return {config:{mode:'app', appId:'123', installationId:'456', privateKeyPath:path}, publicKey, path, dir};
}
function stubAuth() {
  const token = randomBytes(24).toString('hex'); let invalid = false;
  return {token, getToken:async()=>{if(invalid)throw Error('invalid');return token;}, invalidate(){invalid=true;},
    status:()=>({githubAuthMode:'app',tokenExpiresAt:'2030-01-01T00:00:00.000Z',state:invalid?'degraded':'healthy'}),close(){},invalid:()=>invalid};
}
const base='https://api.github.com/repos/community/project';

test('installation JWT signature, least permissions, token reuse, near-expiry refresh and concurrent single-flight', async t=>{
  const f=keyFixture(t);let clock=Date.now(),calls=0;const credentials=[];
  const auth=createGitHubAuth(f.config,{now:()=>clock,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://api.github.com/app/installations/456/access_tokens');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    assert.deepEqual(JSON.parse(options.body),{permissions:{contents:'read'}});
    const jwt=options.headers.Authorization.slice(7),[header,payload,signature]=jwt.split('.');
    assert(verify('RSA-SHA256',Buffer.from(header+'.'+payload),f.publicKey,Buffer.from(signature,'base64url')));
    const claims=JSON.parse(Buffer.from(payload,'base64url'));assert.equal(claims.iss,'123');assert.equal(claims.iat,Math.floor(clock/1000)-60);assert(claims.exp<=Math.floor(clock/1000)+600);
    await delay(5);const token=randomBytes(24).toString('hex');credentials.push(token,jwt);
    return Response.json({token,expires_at:new Date(clock+3600000).toISOString(),permissions:{contents:'read',metadata:'read'}});
  }});t.after(()=>auth.close());
  const values=await Promise.all(Array.from({length:12},()=>auth.getToken()));assert.equal(new Set(values).size,1);assert.equal(calls,1);
  assert.equal(await auth.getToken(),values[0]);assert.equal(calls,1);clock+=3540001;
  assert.notEqual(await auth.getToken(),values[0]);assert.equal(calls,2);
  const status=JSON.stringify(auth.status());assert.equal(auth.status().state,'healthy');for(const credential of credentials)assert(!status.includes(credential));
});

test('bad/missing/inside-release/world-readable/writable-by-group keys fail closed, safe diagnostics',t=>{
  const f=keyFixture(t);for(const config of [{...f.config,appId:''},{...f.config,installationId:''},{...f.config,privateKeyPath:'/does-not-exist/private.pem'}])assert.throws(()=>createGitHubAuth(config));
  assert.throws(()=>createGitHubAuth(f.config,{releaseRoot:f.dir}));
  for(const mode of [0o644,0o660]) {chmodSync(f.path,mode);assert.throws(()=>createGitHubAuth(f.config));}
  chmodSync(f.path,0o600);writeFileSync(f.path,'not a private key');assert.throws(()=>createGitHubAuth(f.config),e=>!e.message.includes(f.path));
  for(const mode of ['invalid','app'])assert.throws(()=>loadConfig({GITHUB_AUTH_MODE:mode}));
});

test('token failures are sanitized and cooled down; no anonymous downgrade',async t=>{
  const f=keyFixture(t);let calls=0;const sensitive=randomBytes(32).toString('hex');
  const auth=createGitHubAuth(f.config,{fetchImpl:async()=>{calls++;throw Object.assign(new Error(sensitive),{status:401,code:sensitive});}});t.after(()=>auth.close());
  for(let i=0;i<3;i++)await assert.rejects(auth.getToken(),e=>e.code==='github_auth_failed'&&!JSON.stringify(e).includes(sensitive)&&!e.message.includes(sensitive));assert.equal(calls,1);
});

test('overprivileged installation tokens and redirected token responses are rejected',async t=>{
  const f=keyFixture(t);for(const kind of ['permissions','redirect']) {
    const auth=createGitHubAuth(f.config,{fetchImpl:async()=>{const r=Response.json({token:randomBytes(24).toString('hex'),expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{contents:'write'}});if(kind==='redirect')Object.defineProperty(r,'url',{value:'https://evil.invalid'});return r;}});
    await assert.rejects(auth.getToken(),{code:'github_auth_failed'});auth.close();
  }
});

test('bounded token refresh times out even when fetch ignores AbortSignal',async t=>{
  const f=keyFixture(t),keepAlive=delay(30);const auth=createGitHubAuth(f.config,{timeoutMs:5,fetchImpl:async()=>new Promise(()=>{})});
  await assert.rejects(auth.getToken(),{code:'github_auth_failed'});auth.close();await keepAlive;
});

test('repository, release and asset API requests authenticate; every permitted CDN hop strips token',async()=>{
  const auth=stubAuth(),calls=[];const client=createGitHubClient({auth,fetchImpl:async(url,options)=>{
    calls.push({url,options});if(url.includes('/assets/'))return new Response('',{status:302,headers:{location:'https://release-assets.githubusercontent.com/test'}});
    if(url==='https://release-assets.githubusercontent.com/test')return new Response('',{status:302,headers:{location:'https://objects.githubusercontent.com/test'}});
    if(url==='https://objects.githubusercontent.com/test')return new Response('',{status:302,headers:{location:'https://github.com/test'}});
    return new Response('bytes');
  }});
  for(const path of ['', '/releases/12', '/releases/assets/34'])await client.read(base+path,{binary:path.includes('/assets/')});
  for(const {url,options} of calls){assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,new URL(url).origin==='https://api.github.com'?'Bearer '+auth.token:undefined);}
  for(const url of ['https://raw.githubusercontent.com/test','https://api.github.com.evil.invalid','https://api.github.com:444','http://api.github.com','https://u:p@api.github.com'])await assert.rejects(client.read(url),{code:'unsafe_redirect'});
  assert.equal(calls.length,6);assert(!JSON.stringify(client.status()).includes(auth.token));client.close();
});

test('401 invalidates credentials and never exposes upstream body or headers',async()=>{
  const auth=stubAuth(),client=createGitHubClient({auth,fetchImpl:async()=>new Response(auth.token,{status:401})});
  await assert.rejects(client.read(base),e=>e.code==='github_auth_failed'&&!e.message.includes(auth.token));assert(auth.invalid());assert.equal(client.status().state,'degraded');client.close();
});

test('primary rate-limit headers use actual authenticated quota and stop requests until reset',async()=>{
  let clock=Date.now(),calls=0;const client=createGitHubClient({auth:stubAuth(),now:()=>clock,fetchImpl:async()=>{
    calls++;return calls===1?new Response('',{status:403,headers:{'x-ratelimit-limit':'5000','x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.ceil((clock+120000)/1000)),'x-ratelimit-resource':'core'}}):new Response('ok');
  }});
  await assert.rejects(client.read(base),{code:'github_rate_limited'});assert.equal(client.status().rateLimit.limit,5000);
  for(let i=0;i<10;i++)await assert.rejects(client.read(base),{status:429});assert.equal(calls,1);clock+=121000;await client.read(base);assert.equal(calls,2);client.close();
});

test('secondary Retry-After and headerless 403 back off without retry storms',async()=>{
  for(const headers of [{'retry-after':'180'},{}]){let calls=0,clock=Date.now();const client=createGitHubClient({auth:stubAuth(),now:()=>clock,fetchImpl:async()=>{calls++;return new Response('secondary rate limit',{status:403,headers});}});
    await assert.rejects(client.read(base));await assert.rejects(client.read(base));assert.equal(calls,1);clock+=30000;await assert.rejects(client.read(base));assert.equal(calls,1);client.close();}
});

test('single-flight cancellation is per subscriber; all cancelling aborts upstream and removes entry',async()=>{
  let calls=0,release,upstreamSignal;const client=createGitHubClient({fetchImpl:async(url,options)=>{calls++;upstreamSignal=options.signal;await new Promise(r=>release=r);return new Response('safe');}});
  const a=new AbortController(),b=new AbortController();const first=client.read(base,{shareKey:'repo',signal:a.signal}),second=client.read(base,{shareKey:'repo',signal:b.signal});
  await delay(0);a.abort();await assert.rejects(first,{code:'client_disconnected'});assert.equal(upstreamSignal.aborted,false);release();assert.equal((await second).bytes.toString(),'safe');assert.equal(calls,1);
  const c=new AbortController(),third=client.read(base,{shareKey:'repo',signal:c.signal});await delay(0);c.abort();await assert.rejects(third);assert(upstreamSignal.aborted);release();client.close();
});

test('in-flight bytes and entries are bounded; stream limit and full-body deadline remain enforced',async()=>{
  const c=new AbortController();const client=createGitHubClient({maxFlights:1,maxFlightBytes:100,fetchImpl:async()=>new Promise(()=>{})});
  const first=client.read(base,{shareKey:'one',limit:100,signal:c.signal});await assert.rejects(client.read(base+'/releases',{shareKey:'two',limit:1}),{code:'busy'});c.abort();await assert.rejects(first);client.close();
  let cancelled=false;const streamClient=createGitHubClient({fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(4));},cancel(){cancelled=true;}}))});
  await assert.rejects(streamClient.read(base,{limit:3}),{code:'response_too_large'});assert(cancelled);streamClient.close();
  const keepAlive=delay(30),slow=createGitHubClient({fetchImpl:async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{})}))});
  await assert.rejects(slow.read(base,{timeout:5}),{code:'upstream_timeout'});slow.close();await keepAlive;
});

test('public health exposes only coarse upstream state; detailed status requires unbanned admin',async t=>{
  const auth=stubAuth(),githubClient=createGitHubClient({auth});const f=await fixture(t,{app:{githubClient}});
  const health=(await f.req('/health',{origin:null})).data;assert.equal(health.githubUpstream,'healthy');assert.equal(health.tokenExpiresAt,undefined);
  assert.equal((await f.req('/api/admin/github-upstream')).status,401);
  const user=await f.login('A');assert.equal((await f.req('/api/admin/github-upstream',{token:user.token})).status,403);
  const admin=await f.login('ADMIN'),r=await f.req('/api/admin/github-upstream',{token:admin.token});assert.equal(r.status,200);assert.equal(r.data.githubAuthMode,'app');assert(!JSON.stringify(r.data).includes(auth.token));
});

test('startup rejects invalid App secrets before creating or migrating a database',async t=>{
  const {spawnSync}=await import('node:child_process');const {existsSync}=await import('node:fs');const f=keyFixture(t);
  const db=join(f.dir,'must-not-exist.sqlite');
  const env={PATH:process.env.PATH,NODE_ENV:'production',PUBLIC_BASE_URL:'https://registry.miemie-fixture.org',CORS_ORIGINS:'http://localhost:8000',
    DISCORD_CLIENT_ID:'111111111111111111',DISCORD_CLIENT_SECRET:randomBytes(24).toString('hex'),SESSION_SECRET:randomBytes(32).toString('hex'),
    DATABASE_PATH:db,GITHUB_AUTH_MODE:'app',GITHUB_APP_ID:'123',GITHUB_APP_INSTALLATION_ID:'456',GITHUB_APP_PRIVATE_KEY_PATH:join(f.dir,'missing.pem')};
  for(const change of [{},{GITHUB_APP_ID:''},{GITHUB_APP_INSTALLATION_ID:''},{GITHUB_AUTH_MODE:'anonymous'}]){
    const r=spawnSync(process.execPath,['src/server.js'],{env:{...env,...change},encoding:'utf8'});assert.notEqual(r.status,0);assert(!existsSync(db));
    assert(!r.stderr.includes(env.SESSION_SECRET));assert(!r.stderr.includes(env.DISCORD_CLIENT_SECRET));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createGitHubRelay } from '../src/github-relay.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';

const REPO = 'https://github.com/Example/Fixture';
const BASE = 'https://api.github.com/repos/Example/Fixture';
const ORIGIN = 'http://localhost:8000';
const hash = value => createHash('sha256').update(value).digest('hex');
const input = (assetId = 30) => ({ repository: REPO, releaseId: 20, assetId });
function fixture(options = {}) {
  const identity = { schemaVersion: 1, productId: 'development.fixture', version: '1.0.1', scriptId: '11111111-1111-1111-1111-111111111111', repository: REPO, ...options.identity };
  const content = `// MieMie-Extension-Build: ${JSON.stringify(identity)}\n/* Development Fixture only. */`;
  const script = { type: 'script', enabled: true, name: 'Development Fixture', id: identity.scriptId, content, info: '', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false }, ...options.script };
  const packageBytes = options.packageBytes || Buffer.from(JSON.stringify(script));
  const manifest = { schemaVersion: 1, apiVersion: 1, id: 'development.fixture', name: 'Development Fixture', version: '1.0.1', author: 'Test Author', description: 'Test data, not a community entry.', entry: 'fixture.js', repository: REPO, license: 'GPL-3.0-or-later', ...options.manifest };
  const metadata = { schemaVersion: 1, format: 'tavern-helper-script', productId: manifest.id, version: '1.0.1', tag: 'v1.0.1', scriptId: '11111111-1111-1111-1111-111111111111', manifest, asset: { name: 'Fixture-1.0.1.json', size: packageBytes.length, sha256: hash(packageBytes) }, contentSha256: hash(script.content), ...options.metadata };
  const metadataBytes = options.metadataBytes || Buffer.from(JSON.stringify(metadata));
  const release = { id: 20, draft: false, tag_name: 'v1.0.1', assets: [
    { id: 30, name: 'MieMie-Extension-update.json', size: metadataBytes.length, digest: `sha256:${hash(metadataBytes)}`, state: 'uploaded', url: `${BASE}/releases/assets/30`, ...options.metadataAsset },
    { id: 31, name: 'Fixture-1.0.1.json', size: packageBytes.length, digest: `sha256:${hash(packageBytes)}`, state: 'uploaded', url: `${BASE}/releases/assets/31`, ...options.packageAsset },
    { id: 32, name: 'unrelated.json', size: 1, state: 'uploaded', digest: `sha256:${'0'.repeat(64)}`, url: `${BASE}/releases/assets/32` }
  ], ...options.release };
  let releaseReads = 0;
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({url,request});
    if (options.fetchImpl) return options.fetchImpl(url, request);
    if (url === BASE) return Response.json({ private: false, full_name: 'Example/Fixture', ...options.repository });
    if (url === `${BASE}/releases/20`) return Response.json(++releaseReads > 1 && options.freshRelease ? options.freshRelease(release) : release);
    if (url === `${BASE}/releases/assets/30`) return new Response(options.transferMetadata || metadataBytes);
    if (url === `${BASE}/releases/assets/31`) return new Response(options.transferPackage || packageBytes);
    throw new Error('Unexpected upstream URL');
  };
  return { relay: createGitHubRelay({ fetchImpl, ...options.timeouts }), calls, metadataBytes, packageBytes, release, fetchImpl };
}
async function appFixture(t, options = {}) {
  const config = loadConfig({SESSION_SECRET:'development-fixture-session-secret-not-a-real-key'}), store = openStore(':memory:');
  const upstream = fixture(options);
  const app = createApp({config,store,githubRelay: options.githubRelay || upstream.relay,rateLimit:10000});
  const server = createServer(app.handler); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{app.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  const post = (body=input(), origin=ORIGIN, extra={})=>fetch(`${base}/api/packages/github/asset`,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{}),...extra},body:JSON.stringify(body)});
  return {app,base,post,upstream};
}

test('metadata relay only returns verified metadata, without credentials or persistent writes', async()=>{const f=fixture();assert.deepEqual(await f.relay.read(input()),f.metadataBytes);assert.equal(f.calls.filter(c=>c.url===`${BASE}/releases/20`).length,2);assert.equal(f.calls.some(c=>c.url.endsWith('/31')),false);for(const {request}of f.calls){assert.equal(request.credentials,'omit');assert.equal(request.redirect,'manual');assert.equal(request.headers.Authorization,undefined);assert.equal(request.headers.Cookie,undefined);}});
test('package relay verifies bytes, content and build identity before returning exact bytes',async()=>{const f=fixture();assert.deepEqual(await f.relay.read(input(31)),f.packageBytes);});
test('request rejects arbitrary URLs, unknown fields and noncanonical repo before fetching',async()=>{for(const body of [{...input(),url:'https://127.0.0.1/secret'},{...input(),repository:'https://github.com/Example/Fixture?url=private'},{...input(),repository:'https://github.com/Example/Fixture/'},{...input(),repository:'https://user:password@github.com/Example/Fixture'},{...input(),repository:'https://127.0.0.1/a/b'},{...input(),repository:'https://github.com.evil.example/a/b'},{...input(),assetId:-1},{...input(),releaseId:'20'}]){const f=fixture();await assert.rejects(()=>f.relay.read(body));assert.equal(f.calls.length,0);}});
test('private, missing or noncanonical upstream repositories are refused',async()=>{for(const repository of [{private:true},{full_name:'example/fixture'},{full_name:'Elsewhere/Fixture'}])await assert.rejects(()=>fixture({repository}).relay.read(input()),/仓库必须公开/);});
test('draft, invalid version, mismatched Release ID and duplicated asset IDs are refused',async()=>{for(const release of [{draft:true},{tag_name:'v1.0.1-alpha.1'},{id:999},{assets:[{id:30},{id:30}]}])await assert.rejects(()=>fixture({release}).relay.read(input()));});
test('arbitrary asset and mismatched metadata asset ID or URL are refused',async()=>{const f=fixture();await assert.rejects(()=>f.relay.read(input(32)),/只能传输/);assert.equal(f.calls.some(c=>c.url.endsWith('/32')),false);for(const metadataAsset of [{id:0},{url:'https://127.0.0.1/private'},{url:`${BASE}/releases/assets/32`},{state:'new'}])await assert.rejects(()=>fixture({metadataAsset}).relay.read(input()));});
test('Manifest, metadata product, tag, version and hash schema are all enforced',async()=>{for(const options of [{manifest:{repository:'https://github.com/Other/Repo'}},{manifest:{apiVersion:2}},{manifest:{id:'miemie.hub'}},{manifest:{version:'9.0.0'}},{metadata:{tag:'v1.0.2'}},{metadata:{productId:'another.extension'}},{metadata:{version:'1.0.2'}},{metadata:{contentSha256:'not-a-hash'}},{metadata:{unknown:true}},{metadata:{scriptId:'e85cd9a3-6352-4b23-938a-6c94d826b4d3'}}])await assert.rejects(()=>fixture(options).relay.read(input()));});
test('metadata byte hash/size and package API digest are verified',async()=>{for(const options of [{transferMetadata:Buffer.from('{}')},{metadataAsset:{digest:`sha256:${'0'.repeat(64)}`}},{metadataAsset:{size:1}},{packageAsset:{digest:`sha256:${'0'.repeat(64)}`}},{packageAsset:{size:1}}])await assert.rejects(()=>fixture(options).relay.read(input()));});
test('package byte digest mismatch or malformed JSON cannot reach Hub',async()=>{for(const options of [{transferPackage:Buffer.from('changed')},{packageBytes:Buffer.from('{invalid')},{packageBytes:Buffer.from('[]')}])await assert.rejects(()=>fixture(options).relay.read(input(31)));});
test('package content hash, identity, repository, script structure and imported user data are verified',async()=>{for(const options of [{metadata:{contentSha256:'0'.repeat(64)}},{identity:{productId:'other.extension'}},{identity:{version:'1.0.2'}},{identity:{repository:'https://github.com/Other/Repo'}},{identity:{extra:true}},{script:{data:{private:'test-fixture'}}},{script:{enabled:'yes'}},{script:{unknown:true}},{script:{button:{enabled:true,buttons:[{name:'Test',visible:'yes'}]}}}])await assert.rejects(()=>fixture(options).relay.read(input(31)));});
test('Release lock is read again; tag or either asset changed rejects response',async()=>{for(const freshRelease of [r=>({...r,tag_name:'v1.0.2'}),r=>({...r,draft:true}),r=>({...r,assets:r.assets.map(a=>a.id===30?{...a,id:33,url:`${BASE}/releases/assets/33`}:a)}),r=>({...r,assets:r.assets.map(a=>a.id===31?{...a,digest:`sha256:${'0'.repeat(64)}`}:a)})])await assert.rejects(()=>fixture({freshRelease}).relay.read(input(31)));});
test('SSRF redirects rejected before reaching private, userinfo or nonofficial URLs',async()=>{for(const location of ['http://127.0.0.1/private','https://169.254.169.254/latest','https://evil.example/file','https://user:password@github.com/private','https://api.github.com.evil.example/a']){const base=fixture(),calls=[];const relay=createGitHubRelay({fetchImpl:async(url,options)=>{calls.push(url);return url.endsWith('/assets/30')?new Response('',{status:302,headers:{location}}):base.fetchImpl(url,options);}});await assert.rejects(()=>relay.read(input()),/重定向/);assert.equal(calls.includes(location),false);}});
test('GitHub signed asset redirects lacking ACAO are readable server-side and copied unchanged',async()=>{const f=fixture(),cdn='https://release-assets.githubusercontent.com/fixture?signature=development-fixture';const relay=createGitHubRelay({fetchImpl:async(url,options)=>{if(url.endsWith('/assets/30'))return new Response('',{status:302,headers:{location:cdn}});if(url===cdn)return new Response(f.metadataBytes);return f.fetchImpl(url,options);}});assert.deepEqual(await relay.read(input()),f.metadataBytes);});
test('API redirects, endless asset redirects and forged auto-followed response URL are refused',async()=>{const f=fixture();for(const fetchImpl of [async()=>new Response('',{status:302,headers:{location:BASE}}),async(url,options)=>url.includes('/assets/')?new Response('',{status:302,headers:{location:url}}):f.fetchImpl(url,options),async(url,options)=>{const response=await f.fetchImpl(url,options);Object.defineProperty(response,'url',{value:'https://evil.example/file'});return response;}])await assert.rejects(()=>createGitHubRelay({fetchImpl}).read(input()));});
test('upstream HTTP failure is a controlled error without response contents',async()=>{const relay=createGitHubRelay({fetchImpl:async()=>new Response('private diagnostics',{status:403})});await assert.rejects(()=>relay.read(input()),error=>error.status===502&&!error.message.includes('private diagnostics'));});
test('metadata and streamed data size limits cannot be bypassed',async()=>{await assert.rejects(()=>fixture({metadataAsset:{size:65537}}).relay.read(input()));const f=fixture();for(const response of [()=>new Response('x',{headers:{'Content-Length':'65537'}}),()=>new Response('x'.repeat(65537))]){const relay=createGitHubRelay({fetchImpl:async(url,options)=>url.endsWith('/assets/30')?response():f.fetchImpl(url,options)});await assert.rejects(()=>relay.read(input()),/大小限制/);}});
test('query and whole-operation deadlines stop upstream that ignores AbortSignal',async()=>{const hold=setTimeout(()=>{},200);try{for(const timeouts of [{queryTimeoutMs:5,operationTimeoutMs:100},{queryTimeoutMs:100,operationTimeoutMs:5}]){const relay=createGitHubRelay({fetchImpl:()=>new Promise(()=>{}),...timeouts});await assert.rejects(()=>relay.read(input()),error=>error.status===504);}}finally{clearTimeout(hold);}});
test('AbortSignal cancels relay and upstream immediately without waiting for deadline',async()=>{const controller=new AbortController();let started;const ready=new Promise(resolve=>started=resolve);let upstreamSignal;const relay=createGitHubRelay({fetchImpl:async(url,options)=>{upstreamSignal=options.signal;started();return new Promise(()=>{});}});const pending=relay.read(input(),{signal:controller.signal});await ready;controller.abort();await assert.rejects(()=>pending,error=>error.code==='client_disconnected');assert.equal(upstreamSignal.aborted,true);});
test('real HTTP public endpoint returns binary bytes with allowed CORS, no login or OAuth config',async t=>{const f=await appFixture(t);for(const id of [30,31]){const response=await f.post(input(id));assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),ORIGIN);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.deepEqual(Buffer.from(await response.arrayBuffer()),id===30?f.upstream.metadataBytes:f.upstream.packageBytes);}assert.equal(f.upstream.calls.some(c=>c.request.headers.Authorization||c.request.headers.Cookie),false);});
test('HTTP endpoint refuses missing/disallowed Origin and supports allowed preflight only',async t=>{const f=await appFixture(t);for(const origin of [null,'https://evil.example','null'])assert.equal((await f.post(input(),origin)).status,403);const preflight=await fetch(`${f.base}/api/packages/github/asset`,{method:'OPTIONS',headers:{Origin:ORIGIN,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),ORIGIN);assert.equal(f.upstream.calls.length,0);});
test('HTTP relay rejects unknown request fields, arbitrary asset, and oversize body',async t=>{const f=await appFixture(t);assert.equal((await f.post({...input(),url:'https://127.0.0.1/'})).status,400);assert.equal((await f.post(input(32))).status,400);assert.equal((await f.post({...input(),extra:'x'.repeat(17000)})).status,413);});
test('relay has independent per-IP rate limit without requiring authentication',async t=>{const f=await appFixture(t,{githubRelay:{read:async()=>Buffer.from('fixture')}});for(let i=0;i<12;i++)assert.equal((await f.post()).status,200);const response=await f.post();assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');});
test('relay enforces two concurrent transfers per IP and cancels them when app closes',async t=>{const pending=[],signals=[];const f=await appFixture(t,{githubRelay:{read:async(body,{signal})=>new Promise((resolve,reject)=>{pending.push(resolve);signals.push(signal);signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{status:499})),{once:true});})}});const a=f.post(),b=f.post();while(pending.length<2)await new Promise(resolve=>setTimeout(resolve,1));assert.equal((await f.post()).status,429);f.app.close();assert.ok(signals.every(s=>s.aborted));assert.equal((await a).status,499);assert.equal((await b).status,499);});
test('real HTTP client disconnection aborts in-flight upstream relay',async t=>{let signal,started;const ready=new Promise(resolve=>started=resolve);const f=await appFixture(t,{githubRelay:{read:async(body,options)=>{signal=options.signal;started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{status:499})),{once:true}));}}});const req=httpRequest(`${f.base}/api/packages/github/asset`,{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'}},()=>{});req.on('error',()=>{});req.end(JSON.stringify(input()));await ready;req.destroy();for(let i=0;i<100&&!signal.aborted;i++)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(signal.aborted,true);});


test('repeated metadata requests reuse bounded metadata but always revalidate Release locks', async()=>{
  const f=fixture(); await f.relay.read(input()); const first=f.calls.length;
  await f.relay.read(input()); assert.equal(f.calls.length-first,2);
  assert.equal(f.calls.filter(c=>c.url===BASE).length,1);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/assets/30')).length,1);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/releases/20')).length,4);
});

test('metadata cache expiry fetches again and returned bytes cannot poison cached metadata',async()=>{
  let time=0;const f=fixture({timeouts:1});
  const relay=createGitHubRelay({now:()=>time,fetchImpl:async(url,request)=>{
    f.calls.push({url,request});if(url===BASE)return Response.json({private:false,full_name:'Example/Fixture'});
    if(url.endsWith('/releases/20'))return Response.json(f.release);
    if(url.endsWith('/assets/30'))return new Response(f.metadataBytes);
    throw Error('unexpected');
  }});
  const first=await relay.read(input());first[0]^=1;
  assert.deepEqual(await relay.read(input()),f.metadataBytes);
  time=120001;assert.deepEqual(await relay.read(input()),f.metadataBytes);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/assets/30')).length,2);
});

test('upstream quota is a structured 429 with retry time; cooldown prevents hammering and expires',async()=>{
  let time=100000,calls=0;const relay=createGitHubRelay({now:()=>time,fetchImpl:async()=>{calls++;return new Response('sensitive upstream IP body',{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'200'}});}});
  for(let i=0;i<2;i++)await assert.rejects(relay.read(input()),e=>e.status===429&&e.code==='github_rate_limited'&&e.retryAt==='1970-01-01T00:03:20.000Z'&&!e.message.includes('sensitive'));
  assert.equal(calls,1);time=200001;await assert.rejects(relay.read(input()));assert.equal(calls,2);
});

test('HTTP quota response preserves retryAt and Retry-After instead of reporting CORS failure',async t=>{
  const at=new Date(Date.now()+90000).toISOString();const f=await appFixture(t,{githubRelay:{read:async()=>{throw Object.assign(new Error('quota exhausted'),{status:429,code:'github_rate_limited',retryAt:at});}}});
  const r=await f.post();assert.equal(r.status,429);assert.ok(Number(r.headers.get('retry-after'))>60);assert.equal((await r.json()).error.retryAt,at);
});

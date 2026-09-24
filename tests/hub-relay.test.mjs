import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createHubReleaseRelay, createGitHubRelay} from '../src/github-relay.js';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {openStore} from '../src/store.js';
const base='https://api.github.com/repos/SheepSheepLab/MieMie-Hub';
const id='e85cd9a3-6352-4b23-938a-6c94d826b4d3';
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture({identity={},meta={},corrupt=false,change=false,fetchImpl, ...options}={}) {
  const content='// MieMie-Hub-Build: '+JSON.stringify({schemaVersion:1,productId:'miemie.hub',version:'0.5.1',scriptId:id,...identity})+'\n/* Development Fixture */';
  const script={type:'script',enabled:true,name:'Fixture Hub',id,content,info:'',button:{enabled:false,buttons:[]},data:{},export_with:{data:false,button:false}};
  const bytes=Buffer.from(JSON.stringify(script));
  const metadata={schemaVersion:1,format:'tavern-helper-script',productId:'miemie.hub',version:'0.5.1',tag:'v0.5.1',scriptId:id,asset:{name:'MieMie-Hub-0.5.1.json',size:bytes.length,sha256:hash(bytes)},contentSha256:hash(content),...meta};
  const mb=Buffer.from(JSON.stringify(metadata));
  const asset=(assetId,name,b)=>({id:assetId,name,state:'uploaded',size:b.length,digest:'sha256:'+hash(b),url:base+'/releases/assets/'+assetId});
  const release={id:20,tag_name:'v0.5.1',draft:false,assets:[asset(30,'MieMie-Hub-update.json',mb),asset(31,metadata.asset.name,bytes)]};
  const calls=[];let reads=0;
  const request=fetchImpl||async function(url,init){calls.push({url,init});
    if(url===base)return Response.json({private:false,full_name:'SheepSheepLab/MieMie-Hub'});
    if(url===base+'/releases/20'){reads++;return Response.json(change&&reads>1?{...release,draft:true}:release);}
    if(url===base+'/releases/assets/30')return new Response(mb);
    if(url===base+'/releases/assets/31')return new Response(corrupt?Buffer.from('corrupt'):bytes);
    throw Error('Unexpected URL');
  };
  return {bytes,mb,calls,release,request,relay:createHubReleaseRelay({fetchImpl:request,...options})};
}
test('Hub gateway transfers only fixed official repository metadata/package and checks fresh release lock',async()=>{
  const f=fixture();assert.deepEqual(await f.relay.read({releaseId:20,assetId:30}),f.mb);assert.deepEqual(await f.relay.read({releaseId:20,assetId:31}),f.bytes);
  for(const {url,init} of f.calls){assert.ok(url.startsWith(base));assert.equal(init.credentials,'omit');assert.equal(init.headers.Authorization,undefined);}
  assert.equal(f.calls.filter(x=>x.url===base+'/releases/20').length,4);
});
test('Hub gateway rejects arbitrary URL/repository, missing ID, extra fields and unlisted asset',async()=>{
  for(const input of [{releaseId:20,assetId:31,url:'http://127.0.0.1'},{releaseId:20,assetId:31,repository:'https://github.com/Other/Repo'},{releaseId:20},{releaseId:-1,assetId:31}]){
    const f=fixture();await assert.rejects(f.relay.read(input),e=>e.status===400);assert.equal(f.calls.length,0);
  }
  await assert.rejects(fixture().relay.read({releaseId:20,assetId:99}),e=>e.code==='asset_not_allowed');
});
test('Hub gateway refuses invalid identity/version/content hash and metadata destination fields',async()=>{
  for(const options of [{identity:{productId:'other'}},{identity:{version:'0.5.0'}},{meta:{scriptId:'other'}},{meta:{version:'0.5.0'}},{meta:{contentSha256:'a'.repeat(64)}},{meta:{url:'https://evil.invalid'}}]){
    await assert.rejects(fixture(options).relay.read({releaseId:20,assetId:31}),e=>e.code==='invalid_package');
  }
});
test('Hub gateway refuses corrupted asset, changed Release and oversize metadata',async()=>{
  await assert.rejects(fixture({corrupt:true}).relay.read({releaseId:20,assetId:31}),e=>e.code==='digest_mismatch');
  await assert.rejects(fixture({change:true}).relay.read({releaseId:20,assetId:31}));
  const f=fixture();f.release.assets[0].size=65537;await assert.rejects(f.relay.read({releaseId:20,assetId:30}));
});
test('Hub package cannot enter Extension gateway',async()=>{
  const f=fixture();const relay=createGitHubRelay({fetchImpl:f.request});
  await assert.rejects(relay.read({repository:'https://github.com/SheepSheepLab/MieMie-Hub',releaseId:20,assetId:31}));
});
test('Hub gateway timeout, caller cancellation and unsafe redirect fail closed',async()=>{
  const keep=setTimeout(()=>{},500);
  try {
    await assert.rejects(fixture({queryTimeoutMs:5,fetchImpl:()=>new Promise(()=>{})}).relay.read({releaseId:20,assetId:31}),e=>e.code==='upstream_timeout');
    const controller=new AbortController();controller.abort();await assert.rejects(fixture().relay.read({releaseId:20,assetId:31},{signal:controller.signal}),e=>e.code==='client_disconnected');
    await assert.rejects(fixture({fetchImpl:async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/'}})}).relay.read({releaseId:20,assetId:31}),e=>e.code==='unsafe_redirect');
  } finally {clearTimeout(keep);}
});
test('real HTTP Hub endpoint is anonymous, Origin restricted, binary readable; Extension route stays separate',async t=>{
  const origin='http://127.0.0.1:8000',f=fixture();
  const config=loadConfig({NODE_ENV:'test',PUBLIC_BASE_URL:'http://127.0.0.1:8787',CORS_ORIGINS:origin,SESSION_SECRET:'x'.repeat(48),DATABASE_PATH:':memory:'});
  const store=openStore(':memory:');const app=createApp({config,store,hubRelay:f.relay,githubRelay:{read:()=>{throw Error('Wrong gateway');}}});
  const server=createServer(app.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{app.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
  const url=`http://127.0.0.1:${server.address().port}/api/hub/releases/asset`;
  const post=(o=origin,body={releaseId:20,assetId:31})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(o?{Origin:o}:{})},body:JSON.stringify(body)});
  for(const o of [null,'https://evil.invalid'])assert.equal((await post(o)).status,403);
  const pre=await fetch(url,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});assert.equal(pre.status,204);
  const result=await post();assert.equal(result.status,200);assert.equal(result.headers.get('access-control-allow-origin'),origin);assert.deepEqual(Buffer.from(await result.arrayBuffer()),f.bytes);
  assert.equal((await post(origin,{releaseId:20,assetId:31,url:'http://localhost'})).status,400);
});

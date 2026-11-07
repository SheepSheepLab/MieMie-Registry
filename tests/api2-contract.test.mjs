import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createGitHubAdapter,cleanManifest} from '../src/remote.js';
import {createGitHubRelay} from '../src/github-relay.js';
import {validateExtensionPackageMetadata} from '../src/package-validation.js';
import {githubRepo} from '../src/validation.js';

const REPO='https://github.com/Example/ContractFixture',BASE='https://api.github.com/repos/Example/ContractFixture';
const SCRIPT='11111111-1111-1111-1111-111111111111';
const hash=x=>createHash('sha256').update(x).digest('hex');
const encode=x=>Buffer.from(JSON.stringify(x));
const alter=(x,patch)=>typeof patch==='function'?(patch(x)??x):({...x,...patch});
const declaration=(api=2)=>({schemaVersion:1,apiVersion:api,id:'development.contract-fixture',name:'Development Fixture',version:'1.0.1',author:'Fixture Author',description:'Synthetic contract test; never a production submission.',entry:'fixture.js',repository:REPO,license:'MIT'});
function fixture(options={}) {
 const scriptId=options.scriptId??SCRIPT;
 const manifest=alter(declaration(options.api??2),options.manifest);
 const identity=alter({schemaVersion:1,productId:manifest.id,version:'1.0.1',scriptId,repository:REPO},options.identity);
 const content='// MieMie-Extension-Build: '+JSON.stringify(identity)+'\n// Inert Development Fixture.';
 const script=alter({type:'script',enabled:true,name:'Development Fixture',id:scriptId,content,info:'',button:{enabled:false,buttons:[]},data:{},export_with:{data:false,button:false}},options.script);
 const packageBytes=encode(script);
 const metadata=alter({schemaVersion:1,format:'tavern-helper-script',productId:manifest.id,version:'1.0.1',tag:'v1.0.1',scriptId,manifest,asset:{name:'Fixture-1.0.1.json',size:packageBytes.length,sha256:hash(packageBytes)},contentSha256:hash(script.content)},options.metadata);
 const metadataBytes=encode(metadata);
 const release=alter({id:20,draft:false,tag_name:'v1.0.1',assets:[alter({id:30,name:'MieMie-Extension-update.json',size:metadataBytes.length,digest:'sha256:'+hash(metadataBytes),state:'uploaded',url:BASE+'/releases/assets/30'},options.metadataAsset),alter({id:31,name:metadata.asset.name,size:packageBytes.length,digest:'sha256:'+hash(packageBytes),state:'uploaded',url:BASE+'/releases/assets/31'},options.packageAsset)]},options.release);
 const calls=[];let reads=0;
 const fetchImpl=async(url,request)=>{
  calls.push({url,request});
  if(url===BASE)return Response.json(alter({private:false,full_name:'Example/ContractFixture'},options.repository));
  if(url.includes('/releases?'))return Response.json(options.releases?.(release)??[release]);
  if(url===BASE+'/releases/20')return Response.json(++reads>1&&options.freshRelease?options.freshRelease(release):release);
  if(url===BASE+'/releases/assets/30')return new Response(options.transferMetadata??metadataBytes);
  if(url===BASE+'/releases/assets/31')return options.packageResponse?options.packageResponse(request):new Response(options.transferPackage??packageBytes);
  if(url===BASE+'/contents/manifest.json')return Response.json(manifest);
  throw Error('Unexpected fixture URL');
 };
 return {manifest,metadata,metadataBytes,packageBytes,release,calls,fetchImpl,catalog:createGitHubAdapter({fetchImpl}),relay:createGitHubRelay({fetchImpl,metadataCacheTtlMs:0,...options.timeouts}),input:assetId=>({repository:REPO,releaseId:20,assetId})};
}

for(const [label,api,hubApi] of [['API1 no range',1,undefined],['API2 no range',2,undefined],['API1 exact',1,{min:1,max:1}],['API2 exact',2,{min:2,max:2}],['API1 broad',1,{min:1,max:2}],['API2 broad',2,{min:1,max:2}],['API2 safe maximum',2,{min:1,max:Number.MAX_SAFE_INTEGER}]]) {
 test('declaration accepts '+label+' without rewriting the API',()=>{const m={...declaration(api),...(hubApi?{hubApi}:{})};const before=structuredClone(m);const clean=cleanManifest(m,githubRepo(REPO),'1.0.1');assert.equal(clean.apiVersion,api);assert.deepEqual(clean.hubApi,hubApi);assert.deepEqual(m,before);});
}
const badDeclarations=[['missing API',{apiVersion:undefined}],['null API',{apiVersion:null}],['string API',{apiVersion:'2'}],['boolean API',{apiVersion:true}],['zero API',{apiVersion:0}],['negative API',{apiVersion:-1}],['fractional API',{apiVersion:1.5}],['NaN API',{apiVersion:NaN}],['infinite API',{apiVersion:Infinity}],['unsafe API',{apiVersion:Number.MAX_SAFE_INTEGER+1}],['unknown API3',{apiVersion:3}],['unknown safe API',{apiVersion:Number.MAX_SAFE_INTEGER}],['missing schema',{schemaVersion:undefined}],['schema2',{schemaVersion:2}],['string schema',{schemaVersion:'1'}],['null range',{hubApi:null}],['array range',{hubApi:[]}],['string range',{hubApi:'2'}],['missing min',{hubApi:{max:2}}],['missing max',{hubApi:{min:2}}],['reversed',{hubApi:{min:2,max:1}}],['excludes API2',{hubApi:{min:1,max:1}}],['API1 excludes declaration',{apiVersion:1,hubApi:{min:2,max:2}}]];
for(const field of ['min','max'])for(const [label,value] of [['zero',0],['negative',-1],['fraction',1.1],['NaN',NaN],['infinity',Infinity],['unsafe',Number.MAX_SAFE_INTEGER+1],['string','2'],['boolean',true],['null',null]])badDeclarations.push([label+' '+field,{hubApi:{min:1,max:2,[field]:value}}]);
for(const [label,patch] of badDeclarations)test('declaration rejects '+label,()=>assert.throws(()=>cleanManifest({...declaration(),...patch},githubRepo(REPO)),e=>e.code==='invalid_manifest'));

for(const api of [1,2])for(const scriptId of [SCRIPT,'author-fixed-export-id'])test('Catalog and Relay accept API'+api+' Package1 with '+scriptId,async()=>{
 const f=fixture({api,scriptId,manifest:{hubApi:{min:api,max:api}}}),original=Buffer.from(f.metadataBytes);
 const inspected=await f.catalog.inspect(REPO);assert.equal(inspected.compatibility,'installable');assert.equal(inspected.manifest.apiVersion,api);assert.deepEqual(inspected.manifest.hubApi,{min:api,max:api});
 assert.equal(validateExtensionPackageMetadata(f.metadata,githubRepo(REPO),f.release),f.metadata);
 assert.deepEqual(await f.relay.read(f.input(30)),original);assert.deepEqual(await f.relay.read(f.input(31)),f.packageBytes);assert.deepEqual(f.metadataBytes,original);
 for(const {url,request} of f.calls){assert.ok(url.startsWith(BASE));assert.equal(request.credentials,'omit');assert.equal(request.headers.Authorization,undefined);assert.equal(request.headers.Cookie,undefined);}
});
const invalidPackages=[
 ['unknown API',{api:3}],['incompatible range',{manifest:{hubApi:{min:1,max:1}}}],['unsafe range',{manifest:{hubApi:{min:2,max:Number.MAX_SAFE_INTEGER+1}}}],
 ['extra metadata field',{metadata:{unexpectedField:true}}],['extra asset field',{metadata:m=>({...m,asset:{...m.asset,url:'https://evil.example/file'}})}],['missing metadata field',{metadata:m=>{delete m.format;}}],['metadata schema2',{metadata:{schemaVersion:2}}],['invalid format',{metadata:{format:'arbitrary'}}],['wrong product',{metadata:{productId:'another.product'}}],['Hub product identity',{manifest:{id:'miemie.hub'}}],['wrong version',{metadata:{version:'1.0.2'}}],['wrong tag',{metadata:{tag:'v1.0.2'}}],['wrong repository',{manifest:{repository:'https://github.com/Other/Repo'}}],['wrong Script ID',{metadata:{scriptId:'other-fixed-id'}}],['Hub Script ID',{metadata:{scriptId:'e85cd9a3-6352-4b23-938a-6c94d826b4d3'}}],['control Script ID',{metadata:{scriptId:'bad\u0000id'}}],['bad content hash',{metadata:{contentSha256:'0'.repeat(64)}}],['malformed hash',{metadata:{contentSha256:'invalid'}}],['bad package hash',{metadata:m=>({...m,asset:{...m.asset,sha256:'0'.repeat(64)}})}],['unsafe size',{metadata:m=>({...m,asset:{...m.asset,size:Number.MAX_SAFE_INTEGER+1}})}],['zero size',{metadata:m=>({...m,asset:{...m.asset,size:0}})}],['overlong filename',{metadata:m=>({...m,asset:{...m.asset,name:'x'.repeat(161)+'.json'}})}],['newline filename',{metadata:m=>({...m,asset:{...m.asset,name:'Fixture.json\n'}})}],['reserved metadata filename',{metadata:m=>({...m,asset:{...m.asset,name:'MieMie-Extension-update.json'}})}],['invalid SemVer',{manifest:{version:'01.0.1'}}],['metadata Asset digest',{metadataAsset:{digest:'sha256:'+'0'.repeat(64)}}],['package Asset digest',{packageAsset:{digest:'sha256:'+'0'.repeat(64)}}],['tampered metadata bytes',{transferMetadata:Buffer.from('{}')}],['tampered package bytes',{transferPackage:Buffer.from('tampered')}],['wrong metadata Asset URL',{metadataAsset:{url:'https://evil.example/file'}}],['wrong package Asset URL',{packageAsset:{url:BASE+'/releases/assets/99'}}],['zero package Asset ID',{packageAsset:{id:0,url:BASE+'/releases/assets/0'}}],['unsafe package Asset ID',{packageAsset:{id:Number.MAX_SAFE_INTEGER+1}}],['wrong package Asset state',{packageAsset:{state:'new'}}],['duplicate Asset ID',{release:r=>({...r,assets:[...r.assets,{...r.assets[1],name:'duplicate.json'}]})}],['duplicate metadata Asset',{release:r=>({...r,assets:[...r.assets,{...r.assets[0],id:90,url:BASE+'/releases/assets/90'}]})}],['duplicate package Asset name',{release:r=>({...r,assets:[...r.assets,{...r.assets[1],id:90,url:BASE+'/releases/assets/90'}]})}],['draft Release',{release:{draft:true}}],['nonversion Release',{release:{tag_name:'v1.0.1-beta'}}],['empty data boundary',{script:{data:{privateFixture:'must not import'}}}],['wrong build product',{identity:{productId:'different.product'}}],['wrong build version',{identity:{version:'1.0.2'}}],['wrong build repository',{identity:{repository:'https://github.com/Other/Repo'}}],['unknown build field',{identity:{extra:true}}],['unknown script field',{script:{extra:true}}],['private repository',{repository:{private:true}}]
];
for(const [label,options] of invalidPackages)test('Catalog/Relay reject same '+label,async()=>{
 const f=fixture(options);
 if(options.repository?.private)await assert.rejects(f.catalog.inspect(REPO),e=>e.code==='invalid_repository');
 else assert.equal((await f.catalog.inspect(REPO)).compatibility,'external');
 await assert.rejects(f.relay.read(f.input(31)));
});
for(const api of [1,2])test('strict metadata-only rejection is independent of package transfer for API'+api,async()=>{
 const f=fixture({api,metadata:{unexpectedField:true}});assert.equal((await f.catalog.inspect(REPO)).compatibility,'external');await assert.rejects(f.relay.read(f.input(30)),e=>e.code==='invalid_package');assert.equal(f.calls.some(c=>c.url.endsWith('/assets/31')),false);
});
for(const api of [1,2])test('known API'+api+' old release remains addressable without latest-version substitution',async()=>{
 const f=fixture({api,releases:r=>[{...r,id:40,tag_name:'v2.0.0',assets:[]},r]});
 const result=await f.catalog.inspect(REPO);assert.equal(result.compatibility,'external');assert.equal(result.release.id,40);
 assert.deepEqual(await f.relay.read(f.input(31)),f.packageBytes);assert.ok(f.calls.some(c=>c.url===BASE+'/releases/20'));
});
for(const api of [2,3])test('highest API'+api+' malformed or unknown release never falls back to older API1',async()=>{
 const f=fixture({api,releases:r=>[r,{...r,id:19,tag_name:'v1.0.0'}],...(api===2?{metadata:{unexpectedField:true}}:{})});
 const result=await f.catalog.inspect(REPO);assert.equal(result.compatibility,'external');assert.equal(result.release.id,20);
});
for(const [label,freshRelease] of [['tag',r=>({...r,tag_name:'v1.0.2'})],['metadata Asset',r=>({...r,assets:r.assets.map(a=>a.id===30?{...a,id:90,url:BASE+'/releases/assets/90'}:a)})],['package digest',r=>({...r,assets:r.assets.map(a=>a.id===31?{...a,digest:'sha256:'+'0'.repeat(64)}:a)})]])test('API2 Relay rejects authoritative Release change: '+label,async()=>{
 const f=fixture({freshRelease});await assert.rejects(f.relay.read(f.input(31)),e=>e.code==='release_changed');assert.equal(f.calls.filter(c=>c.url===BASE+'/releases/20').length,2);
});
test('API2 wrong authoritative Release ID cannot authorize bytes',async()=>{const f=fixture({release:{id:21}});await assert.rejects(f.relay.read(f.input(31)));assert.equal(f.calls.some(c=>c.url.endsWith('/assets/31')),false);});
test('API2 Relay cancellation discards held bytes and does not reread or return a package',async()=>{
 let entered;const ready=new Promise(r=>entered=r);let upstream;
 const f=fixture({packageResponse:request=>{upstream=request.signal;entered();return new Promise(()=>{});}}),c=new AbortController();
 const pending=assert.rejects(f.relay.read(f.input(31),{signal:c.signal}),e=>e.code==='client_disconnected');await ready;c.abort();await pending;assert.equal(upstream.aborted,true);assert.equal(f.calls.filter(x=>x.url===BASE+'/releases/20').length,1);
});
test('API2 Relay real operation timeout rejects held bytes with original timeout semantics',async()=>{
 const hold=setTimeout(()=>{},200);try{const f=fixture({packageResponse:()=>new Promise(()=>{}),timeouts:{operationTimeoutMs:10}});await assert.rejects(f.relay.read(f.input(31)),e=>e.code==='upstream_timeout');}finally{clearTimeout(hold);}
});

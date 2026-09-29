import test from 'node:test';import assert from 'node:assert/strict';
import {validateProduct} from '../src/governance.js';
import {submissionInput,productDistribution} from '../src/validation.js';
import {fixture,submission} from './helpers.mjs';
const base={type:'tavern_extension',sourceType:'github',distribution:'managed_install',classification:'community'};
const post='https://discord.com/channels/444444444444444444/555555555555555555';
test('governance independently rejects illegal distributions and unverified installs',()=>{
 assert.doesNotThrow(()=>validateProduct(base,{compatibility:'installable'}));
 for(const [input,github] of [[base,{compatibility:'external'}],[{...base,type:'standalone_app'},{compatibility:'installable'}],[{...base,type:'web_tool'},{compatibility:'installable'}],[{...base,sourceType:'discord'},{compatibility:'installable'}],[{...base,type:'web_tool',distribution:'external_release'},{}],[{...base,type:'shortcut_app'},{}]])assert.throws(()=>validateProduct(input,github));
 assert.doesNotThrow(()=>validateProduct({...base,distribution:'external_release'},{compatibility:'external',language:'JavaScript'}));
 assert.doesNotThrow(()=>validateProduct({...base,sourceType:'discord',distribution:'external_release'},null));
});
test('server derives every source/type using verified capability, never submission hints or Language',()=>{
 for(const sourceType of ['github','discord'])for(const type of ['tavern_extension','standalone_app','web_tool'])for(const compatibility of ['installable','external',undefined]){
  const expected=type==='web_tool'?'open_url':type==='tavern_extension'&&sourceType==='github'&&compatibility==='installable'?'managed_install':'external_release';
  assert.equal(productDistribution(type,sourceType,{compatibility,language:'JavaScript'}),expected);
  const body=submission({sourceType,type,sourceUrl:sourceType==='github'?'https://github.com/example/fixture':post,websiteUrl:type==='web_tool'?'https://example.com/tool':null});
  assert.notEqual(submissionInput(body).distribution,'managed_install','parsing is not Package verification');
  if(type!=='tavern_extension'||sourceType!=='github')assert.throws(()=>submissionInput({...body,distribution:'managed_install'}));
 }
});
test('GitHub create/edit freshly inspect after preview; missing/invalid Package allows external Catalog admission',async t=>{
 let valid=true,calls=0;const f=await fixture(t,{github:{async inspect(url){calls++;return {compatibility:valid?'installable':'external',language:'JavaScript',manifest:valid?{id:'test.package',repository:url}:null,reason:valid?'verified':'invalid Package'};}}}),a=await f.login();
 assert.equal((await f.req('/api/github/preview?url='+encodeURIComponent('https://github.com/example/fixture'),{token:a.token})).data.compatibility,'installable');
 valid=false;const created=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({distribution:'managed_install'})});assert.equal(created.status,201);assert.equal(created.data.distribution,'external_release');assert.equal(created.data.sourceType,'github');assert.equal(calls,2);
 const edit=body=>f.req('/api/submissions/'+created.data.id,{method:'PATCH',token:a.token,body});
 valid=true;const installed=await edit({distribution:'external_release'});assert.equal(installed.status,200);assert.equal(installed.data.distribution,'managed_install');
 valid=false;const changed=await edit({distribution:'managed_install'});assert.equal(changed.status,200);assert.equal(changed.data.distribution,'external_release');assert.equal(changed.data.github.manifest,null);
 assert.equal((await f.req('/api/catalog/'+created.data.id)).data.distribution,'external_release');
});
test('ordinary public GitHub repository without Package is accepted; invalid repository is not',async t=>{
 const f=await fixture(t),a=await f.login();const row=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission()});assert.equal(row.status,201);assert.equal(row.data.distribution,'external_release');assert.equal(row.data.github.compatibility,'external');
 assert.equal((await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({sourceUrl:'https://github.com/example/missing'})})).status,400);
});
test('Discord Tavern canonicalizes legacy open_url to external_release and rejects managed_install',async t=>{
 const f=await fixture(t),a=await f.login();
 const created=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({sourceType:'discord',sourceUrl:post,distribution:'open_url'})});assert.equal(created.status,201);assert.equal(created.data.distribution,'external_release');assert.equal(created.data.visibility,'discord_guild');
 assert.equal((await f.req('/api/submissions/'+created.data.id,{method:'PATCH',token:a.token,body:{distribution:'managed_install'}})).status,400);
 assert.equal((await f.req('/api/submissions/'+created.data.id,{method:'PATCH',token:a.token,body:{distribution:'open_url'}})).data.distribution,'external_release');assert.equal(f.inspections.length,0);
});
test('accepted Catalog refresh promotes verified Package and distribution together without changing other fields',async t=>{
 const f=await fixture(t),a=await f.login(),row=(await f.req('/api/submissions',{method:'POST',token:a.token,body:submission()})).data,before=f.store.getEntry(row.id);
 const verified={compatibility:'installable',manifest:{id:'test.package',repository:row.sourceUrl}};assert.equal(f.store.refreshGithub(before,verified).changes,1);
 const after=f.store.getEntry(row.id);assert.equal(after.distribution,'managed_install');for(const key of Object.keys(before).filter(k=>!['github_json','distribution'].includes(k)))assert.deepEqual(after[key],before[key]);
});

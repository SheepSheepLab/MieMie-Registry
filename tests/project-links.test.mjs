import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,submission,IDS} from './helpers.mjs';
import {openStore} from '../src/store.js';
const post='https://discord.com/channels/444444444444444444/555555555555555555/666666666666666666';
const other='https://discord.com/channels/777777777777777777/555555555555555555/666666666666666666';

test('GitHub submissions persist a separate public Discord post and old content edits preserve both links',async t=>{
 const f=await fixture(t),a=await f.login();
 const created=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({discordUrl:post})});assert.equal(created.status,201);
 const row=created.data;assert.equal(row.githubUrl,row.sourceUrl);assert.equal(row.discordUrl,post);
 const edit=await f.req('/api/submissions/'+row.id,{method:'PATCH',token:a.token,body:{description:'Updated description'}});assert.equal(edit.status,200);assert.equal(edit.data.discordUrl,post);
 const catalog=(await f.req('/api/catalog')).data.items[0];assert.equal(catalog.discordUrl,post);assert.equal(catalog.githubUrl,row.sourceUrl);
 const sourceEdit=await f.req('/api/submissions/'+row.id,{method:'PATCH',token:a.token,body:{sourceUrl:'https://github.com/example/changed'}});assert.equal(sourceEdit.status,200);assert.equal(sourceEdit.data.githubUrl,sourceEdit.data.sourceUrl);assert.equal(sourceEdit.data.discordUrl,post);
});
test('GitHub guild visibility derives from separate Discord post and still verifies membership',async t=>{
 const f=await fixture(t),a=await f.login();
 const bad=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({discordUrl:other,visibility:'discord_guild'})});assert.equal(bad.status,403);
 const good=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({discordUrl:post,visibility:'discord_guild'})});assert.equal(good.status,201);assert.equal(good.data.visibilitySourceUrl,post);
 assert.equal((await f.req('/api/catalog')).data.total,0);assert.equal((await f.req('/api/catalog',{token:a.token})).data.items[0].discordUrl,post);
 const edit=await f.req('/api/submissions/'+good.data.id,{method:'PATCH',token:a.token,body:{discordUrl:other}});assert.equal(edit.status,200);assert.equal(f.store.getEntry(good.data.id).visibility_source_url,post);
 const changeScope=await f.req('/api/submissions/'+good.data.id,{method:'PATCH',token:a.token,body:{visibilitySourceUrl:other}});assert.equal(changeScope.status,403);assert.equal(f.store.getEntry(good.data.id).visibility_source_url,post);
 const publicRow=(await f.req('/api/catalog',{token:a.token})).data.items[0];assert.equal(publicRow.discordUrl,other);assert.equal(publicRow.visibilitySourceUrl,undefined);
});
test('secondary repository on Discord submissions cannot transfer official identity',async t=>{
 const f=await fixture(t),a=await f.login(),o=await f.login('OWNER');
 const created=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({sourceType:'discord',sourceUrl:post,githubUrl:'https://github.com/example/a'})});assert.equal(created.status,201);const row=created.data;
 const mark=await f.req('/api/admin/submissions/'+row.id+'/classification',{method:'POST',token:o.token,body:{classification:'official',reason:'Test acceptance',projectIdentityKey:row.projectIdentityKey}});assert.equal(mark.status,200);
 const change=await f.req('/api/submissions/'+row.id,{method:'PATCH',token:a.token,body:{githubUrl:'https://github.com/example/b'}});assert.equal(change.status,409);assert.equal(f.store.getEntry(row.id).github_url,'https://github.com/example/a');assert.equal(f.store.getEntry(row.id).classification,'official');
});
test('link payload rejects malformed URLs and conflicting primary or visibility aliases',async t=>{
 const f=await fixture(t),a=await f.login();
 for(const patch of [{discordUrl:{}},{discordUrl:[]},{discordUrl:'javascript:alert(1)'},{githubUrl:'https://github.com/example/other'},{sourceType:'discord',sourceUrl:post,visibility:'discord_guild',visibilitySourceUrl:other}]){
  const r=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission(patch)});assert.equal(r.status,400,JSON.stringify(r.data));
 }
});
test('v3 migration adds links once without publishing an old private visibility URL',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'miemie-links-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'test.sqlite');
 let store=openStore(path);store.upsertIdentity({id:IDS.A,displayName:'Fixture',username:'fixture'},1);
 store.insertSubmission({id:'old',ownerId:IDS.A,input:{...submission(),visibility:'discord_guild',visibilityGuildId:'444444444444444444',visibilitySourceUrl:post,icon:null},github:null,time:1});
 store.db.exec('ALTER TABLE submissions DROP COLUMN github_url; ALTER TABLE submissions DROP COLUMN discord_url; PRAGMA user_version=3;');const before={...store.getEntry('old')};store.close();
 for(let i=0;i<2;i++){store=openStore(path);const row=store.getEntry('old');for(const[k,v]of Object.entries(before))assert.deepEqual(row[k],v);assert.equal(store.entryDTO(row).githubUrl,row.source_url);assert.equal(store.entryDTO(row).discordUrl,null);assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,4);store.close();}
});
test('successful OAuth callback closes its own detached window, without affecting PKCE handoff',async t=>{
 const f=await fixture(t),flow=await f.begin(),response=await f.callback(flow);assert.equal(response.status,200);
 const script=response.data.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];let close=0;
 runInNewContext(script,{window:{opener:null,close(){close++;}},history:{replaceState(){}},setTimeout(fn,delay){assert.equal(delay,1500);fn();}});assert.equal(close,1);
 const complete=await f.req('/api/auth/complete',{method:'POST',body:{requestId:flow.requestId,codeVerifier:flow.verifier}});assert.equal(complete.status,200);assert.ok(complete.data.token);
 const denied=await f.callback(flow);assert.equal(denied.status,400);assert.doesNotMatch(JSON.stringify(denied.data),/window.close/);
});

test('Discord verification exposes only the requested joined server and never accepts client membership claims',async t=>{
 const f=await fixture(t),a=await f.login(),b=await f.login('B');const route='/api/discord/verify?url='+encodeURIComponent(post);
 assert.equal((await f.req(route)).status,401);
 assert.equal((await f.req(route,{token:b.token})).status,403);
 assert.equal((await f.req('/api/discord/verify?url=https://evil.example',{token:a.token})).status,400);
 const good=await f.req(route,{token:a.token});assert.equal(good.status,200);assert.deepEqual(good.data,{sourceUrl:post,guild:{id:'444444444444444444',name:'Test community',iconUrl:null},member:true});
 assert.doesNotMatch(JSON.stringify(good.data),/accessToken|permissions|guilds|test-only/);
 f.memberships.A=[];assert.equal((await f.req(route,{token:a.token})).status,403);
 const save=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({discordUrl:post,visibility:'discord_guild'})});assert.equal(save.status,403);assert.equal(f.store.listOwn(IDS.A).length,0);
 f.setMembershipFailure(true);assert.equal((await f.req(route,{token:a.token})).status,503);
});
test('Discord verification rechecks logout while upstream membership lookup is pending',async t=>{
 let started,release;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
 const f=await fixture(t,{beforeGuilds:async()=>{started();await gate;}}),a=await f.login();
 const pending=f.req('/api/discord/verify?url='+encodeURIComponent(post),{token:a.token});await ready;await f.req('/api/auth/logout',{method:'POST',token:a.token,body:{}});release();assert.equal((await pending).status,401);
});

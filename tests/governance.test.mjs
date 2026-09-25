import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture,submission,IDS} from './helpers.mjs';
import {openStore} from '../src/store.js';
import {adminScript} from '../src/admin.js';
import vm from 'node:vm';
const create=async(f,a,change={})=>{const r=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission(change)});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;};
const mutate=(f,a,path,body)=>f.req(path,{method:'POST',token:a.token,body:{reason:'Development Fixture governance',...body}});
const grant=(f,a,id,role,enabled=true)=>mutate(f,a,`/api/admin/identities/${id}/roles`,{role,enabled});

test('moderator can only Hide/Recover Community; no bans, roles, audit or author editing',async t=>{
 const f=await fixture(t),a=await f.login(),admin=await f.login('ADMIN'),owner=await f.login('OWNER'),row=await create(f,a);
 assert.equal((await f.req('/api/admin/submissions',{token:a.token})).status,403);
 for(const action of ['hide','restore'])assert.equal((await mutate(f,admin,`/api/admin/submissions/${row.id}/moderation`,{action})).status,200);
 assert.equal((await mutate(f,admin,`/api/admin/identities/${IDS.A}/ban`,{banned:true})).status,403);
 assert.equal((await grant(f,admin,IDS.A,'admin')).status,403);
 assert.equal((await grant(f,admin,IDS.A,'official_publisher')).status,403);
 for(const path of ['/api/admin/audit','/api/admin/identities'])assert.equal((await f.req(path,{token:admin.token})).status,403);
 for(const actor of [admin,owner]){assert.equal((await f.req(`/api/submissions/${row.id}`,{method:'PATCH',token:actor.token,body:{name:'stolen'}})).status,404);assert.equal((await f.req(`/api/admin/submissions/${row.id}`,{method:'PATCH',token:actor.token,body:{name:'stolen'}})).status,404);}
 assert.equal(f.store.getEntry(row.id).name,row.name);
});
test('Author spoof and legacy publisher grants cannot confer Official or Admin',async t=>{
 const f=await fixture(t),a=await f.login(),owner=await f.login('OWNER');
 const normal=await create(f,a,{author:'SheepSheep'});assert.equal(normal.classification,'community');
 assert.equal((await grant(f,owner,IDS.A,'official_publisher')).status,200);
 assert.equal((await f.req('/api/me',{token:a.token})).data.canPublishOfficial,false);
 assert.equal((await f.req('/api/admin/submissions',{token:a.token})).status,403);
 assert.equal((await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({sourceUrl:'https://github.com/example/official',classification:'official'})})).status,403);
 assert.equal((await f.req(`/api/submissions/${normal.id}`,{method:'PATCH',token:a.token,body:{classification:'official'}})).status,403);
 assert.equal((await grant(f,owner,IDS.A,'admin')).status,200);assert.deepEqual(f.store.rolesFor(IDS.A).sort(),['admin','official_publisher']);
 assert.equal((await f.req('/api/me',{token:a.token})).data.canPublishOfficial,false);
 assert.equal((await grant(f,owner,IDS.A,'admin',false)).status,200);assert.equal((await f.req('/api/me',{token:a.token})).data.isAdmin,false);
});
test('Official protection and Security Hold are Owner only; Owner identity is immutable',async t=>{
 const f=await fixture(t),owner=await f.login('OWNER'),admin=await f.login('ADMIN');const row=await create(f,owner);
 await mutate(f,owner,`/api/admin/submissions/${row.id}/classification`,{classification:'official',projectIdentityKey:row.projectIdentityKey});
 for(const action of ['hide','restore'])assert.equal((await mutate(f,admin,`/api/admin/submissions/${row.id}/moderation`,{action})).status,403);
 for(const action of ['protection','security-hold']){assert.equal((await mutate(f,admin,`/api/admin/submissions/${row.id}/${action}`,{enabled:false})).status,403);assert.equal((await mutate(f,owner,`/api/admin/submissions/${row.id}/${action}`,{enabled:true})).status,200);}
 assert.equal((await f.req('/api/admin/submissions',{token:admin.token})).data.total,0);
 assert.equal((await mutate(f,owner,`/api/admin/submissions/${row.id}/moderation`,{action:'hide'})).status,200);
 assert.equal((await mutate(f,owner,`/api/admin/submissions/${row.id}/moderation`,{action:'restore'})).status,200);
 assert.equal((await grant(f,owner,IDS.OWNER,'admin',false)).status,403);
 assert.equal((await mutate(f,owner,`/api/admin/identities/${IDS.OWNER}/ban`,{banned:true})).status,403);
});
test('Owner ban/unban closes all author writes but permits login/read, retaining historical submissions',async t=>{
 const f=await fixture(t),a=await f.login(),o=await f.login('OWNER'),row=await create(f,a);
 assert.equal((await mutate(f,o,`/api/admin/identities/${IDS.A}/ban`,{banned:true})).status,200);
 assert.equal((await f.login()).canSubmit,false);
 assert.equal((await f.req('/api/catalog')).data.total,1); // ban does not silently hide existing work
 for(const [path,body,method]of [['/api/submissions',submission({sourceUrl:'https://github.com/example/two'}),'POST'],[`/api/submissions/${row.id}`,{name:'changed'},'PATCH'],[`/api/submissions/${row.id}/status`,{status:'listed'},'POST'],[`/api/submissions/${row.id}/status`,{status:'unlisted'},'POST']])assert.equal((await f.req(path,{token:a.token,body,method})).status,403);
 await grant(f,o,IDS.A,'admin');assert.equal((await f.req('/api/admin/submissions',{token:a.token})).status,403);
 assert.equal((await mutate(f,o,`/api/admin/identities/${IDS.A}/ban`,{banned:false})).status,200);
 assert.equal((await f.req(`/api/submissions/${row.id}`,{method:'PATCH',token:a.token,body:{name:'allowed'}})).status,200);
 const logs=(await f.req('/api/admin/audit',{token:o.token})).data.items;assert.ok(logs.some(x=>x.action==='ban'&&x.actor_id===IDS.OWNER&&x.before_json&&x.after_json));assert.ok(logs.some(x=>x.action==='unban'));
});
test('immutable submitter/owner come from session, private identifiers never enter public DTO',async t=>{
 const f=await fixture(t),a=await f.login();for(const field of ['submitter_id','owner_id','submitterDiscordUserId','moderation_protected','security_hold']){f.advance(600001);assert.equal((await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({[field]:IDS.B})})).status,400);}
 const row=await create(f,a);assert.equal(f.store.getEntry(row.id).submitter_id,IDS.A);assert.equal(f.store.getEntry(row.id).owner_id,IDS.A);
 for(const path of ['/api/catalog','/api/catalog/'+row.id]){const s=JSON.stringify((await f.req(path)).data);for(const value of [IDS.A,'submitter_id','owner_id','securityHold','purgeAfter','discord_id'])assert.ok(!s.includes(value));}
});
test('Soft Unlist retention is at least 180 days; holds/hidden investigations are never purged',async t=>{
 const f=await fixture(t),a=await f.login(),o=await f.login('OWNER'),row=await create(f,a);await mutate(f,a,`/api/submissions/${row.id}/status`,{status:'unlisted'});
 const saved=f.store.getEntry(row.id);assert.equal(saved.purge_after-saved.unlisted_at,180*86400000);
 assert.deepEqual(f.store.purgeEligible(saved.purge_after-1),[]);assert.equal(f.store.purgeEligible(saved.purge_after).length,1);
 await mutate(f,o,`/api/admin/submissions/${row.id}/security-hold`,{enabled:true});assert.equal(f.store.purge(saved.purge_after+1),0);
 await mutate(f,o,`/api/admin/submissions/${row.id}/security-hold`,{enabled:false});await mutate(f,o,`/api/admin/submissions/${row.id}/moderation`,{action:'hide'});assert.equal(f.store.purge(saved.purge_after+1),0);
 await mutate(f,o,`/api/admin/submissions/${row.id}/moderation`,{action:'restore'});assert.equal(f.store.purge(saved.purge_after+1),1);assert.ok(f.store.listAudit(1).items.some(x=>x.action==='purge'));assert.ok(f.store.getIdentity(IDS.A));
});
test('Relist clears retention; new unlisting receives a fresh 180 day retention',async t=>{
 const f=await fixture(t),a=await f.login(),row=await create(f,a);await mutate(f,a,`/api/submissions/${row.id}/status`,{status:'unlisted'});const old=f.store.getEntry(row.id).purge_after;
 await mutate(f,a,`/api/submissions/${row.id}/status`,{status:'listed'});assert.equal(f.store.getEntry(row.id).purge_after,null);f.advance(1000);await mutate(f,a,`/api/submissions/${row.id}/status`,{status:'unlisted'});assert.equal(f.store.getEntry(row.id).purge_after,old+1000);
});
test('Type/Distribution isolation: native desktop/web listings cannot obtain Tavern managed installation',async t=>{
 const f=await fixture(t),a=await f.login();
 const app=await create(f,a,{type:'standalone_app',distribution:'external_release',platforms:['macos','windows']});assert.equal(app.type,'standalone_app');assert.equal(app.github.compatibility,'external');
 const web=await create(f,a,{sourceUrl:'https://github.com/example/web',type:'web_tool',distribution:'open_url',websiteUrl:'https://author.example/tool',platforms:['web']});assert.equal(web.websiteUrl,'https://author.example/tool');
 for(const changes of [{type:'standalone_app',distribution:'managed_install'},{type:'web_tool',distribution:'managed_install',websiteUrl:'https://author.example'},{type:'tavern_extension',distribution:'managed_install'},{type:'web_tool',websiteUrl:'javascript:alert(1)'},{platforms:['exe']},{classification:'verified'}]){f.advance(600001);assert.equal((await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({sourceUrl:'https://github.com/example/new',...changes})})).status,400);}
});
test('valid Package gets managed_install for old clients; changed repo cannot reuse old discovery',async t=>{
 const f=await fixture(t,{github:{async inspect(url){return {compatibility:url.endsWith('/fixture')?'installable':'external',manifest:{id:'test.fixture'},release:{version:'1.1.3'}};}}}),a=await f.login();const row=await create(f,a);assert.equal(row.distribution,'managed_install');
 assert.equal((await f.req(`/api/submissions/${row.id}`,{method:'PATCH',token:a.token,body:{sourceUrl:'https://github.com/example/other'}})).status,400);assert.equal(f.store.getEntry(row.id).source_url,row.sourceUrl);
});
test('one-time legacy admin import does not resurrect revoked roles on restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'miemie-governance-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=await fixture(t,{path:join(dir,'test.sqlite')}),o=await f.login('OWNER');await f.login('ADMIN');assert.equal((await grant(f,o,IDS.ADMIN,'admin',false)).status,200);
 f.store.bootstrapAdmins([IDS.ADMIN],Date.now());assert.deepEqual(f.store.rolesFor(IDS.ADMIN),[]);const other=openStore(join(dir,'test.sqlite'));try{other.bootstrapAdmins([IDS.ADMIN],Date.now());assert.deepEqual(other.rolesFor(IDS.ADMIN),[]);}finally{other.close();}
});
test('Web Admin shell has no private configuration and protected endpoints need roles',async t=>{
 const f=await fixture(t),a=await f.login();const r=await f.req('/admin');assert.equal(r.status,200);assert.match(r.data,/\/admin.js/);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.doesNotThrow(()=>new vm.Script(adminScript));
 for(const secret of [f.config.ownerId,f.config.clientSecret,f.config.sessionSecret])assert.ok(!r.data.includes(secret)&&!adminScript.includes(secret));
 for(const path of ['/api/admin/identities','/api/admin/audit','/api/admin/submissions']){assert.equal((await f.req(path)).status,401);assert.equal((await f.req(path,{token:a.token})).status,403);}
 assert.ok(!adminScript.includes('localStorage'));assert.ok(adminScript.includes('/api/auth/complete'));
});

test('real v2 migration preserves every old column, Polisher managed install and audit; backup is restorable and rerun idempotent',async t=>{
 const {openStore:oldStore}=await import('./fixtures/schema-v2-store.mjs');const dir=await mkdtemp(join(tmpdir(),'miemie-v3-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'v2.sqlite'),copy=join(dir,'before.sqlite');
 const old=oldStore(path);old.upsertIdentity({id:IDS.A,displayName:'Fixture Sheep',username:'fixture'},10);
 old.insertSubmission({id:'polisher-fixture',ownerId:IDS.A,input:{...submission(),icon:null,visibility:'public'},github:{compatibility:'installable',manifest:{id:'miemie.polisher'},release:{version:'1.1.3'}},time:20});
 old.audit(IDS.A,'create','polisher-fixture','fixture',20);const before={...old.getEntry('polisher-fixture')};await old.backup(copy);old.close();
 const migrated=openStore(path);try{
  const row=migrated.getEntry('polisher-fixture');for(const [k,v]of Object.entries(before))assert.equal(row[k],v,k);
  assert.equal(row.submitter_id,IDS.A);assert.equal(row.classification,'community');assert.equal(row.product_type,'tavern_extension');assert.equal(row.distribution,'managed_install');assert.equal(migrated.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(migrated.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{migrated.close();}
 const again=openStore(path);assert.equal(again.getEntry('polisher-fixture').distribution,'managed_install');again.close();
 const restored=oldStore(copy);assert.deepEqual({...restored.getEntry('polisher-fixture')},before);restored.close();
});
test('migration SQL failure rolls back all v3 changes and retains old schema',async t=>{
 const {openStore:oldStore}=await import('./fixtures/schema-v2-store.mjs');const dir=await mkdtemp(join(tmpdir(),'miemie-v3-fail-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'test.sqlite'),old=oldStore(path);old.db.exec('CREATE TABLE roles(unexpected TEXT)');old.close();
 assert.throws(()=>openStore(path));const db=new DatabaseSync(path);try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);assert.equal(db.prepare('PRAGMA table_info(submissions)').all().some(c=>c.name==='submitter_id'),false);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
});
test('role revocation during source validation cannot publish Official using stale session flags',async t=>{
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const f=await fixture(t,{beforeInspect:async()=>{started();await gate;}}),a=await f.login(),o=await f.login('OWNER');await grant(f,o,IDS.A,'official_publisher');
 const pending=f.req('/api/submissions',{method:'POST',token:a.token,body:submission({classification:'official'})});await ready;await grant(f,o,IDS.A,'official_publisher',false);release();assert.equal((await pending).status,403);assert.equal(f.store.countOwn(IDS.A),0);
});
test('revoked Moderator session loses authority immediately and invalid governance requests never mutate content',async t=>{
 const f=await fixture(t),a=await f.login(),m=await f.login('ADMIN'),o=await f.login('OWNER'),row=await create(f,a);
 await grant(f,o,IDS.ADMIN,'admin',false);assert.equal((await mutate(f,m,`/api/admin/submissions/${row.id}/moderation`,{action:'hide'})).status,403);
 assert.equal((await mutate(f,o,`/api/admin/submissions/${row.id}/moderation`,{action:'edit',name:'bad'})).status,400);
 assert.equal(f.store.getEntry(row.id).name,row.name);
});
test('offline production migration helper verifies backup/candidate and leaves live v2 untouched',async t=>{
 const {spawnSync}=await import('node:child_process'),{openStore:oldStore}=await import('./fixtures/schema-v2-store.mjs');const dir=await mkdtemp(join(tmpdir(),'miemie-preflight-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=join(dir,'live.sqlite'),candidate=join(dir,'candidate.sqlite'),old=oldStore(source);old.upsertIdentity({id:IDS.A,displayName:'Private fixture',username:'private'},1);old.close();
 const result=spawnSync(process.execPath,[new URL('../tools/migrate-verified.mjs',import.meta.url).pathname,source,join(dir,'backups'),candidate],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,new RegExp(IDS.A+'|Private fixture'));
 const live=new DatabaseSync(source,{readOnly:true}),next=new DatabaseSync(candidate,{readOnly:true});try{assert.equal(live.prepare('PRAGMA user_version').get().user_version,2);assert.equal(next.prepare('PRAGMA user_version').get().user_version,3);assert.equal(next.prepare('SELECT count(*) AS n FROM identities').get().n,1);}finally{live.close();next.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {openStore} from '../src/store.js';
import {submissionInput,productDistribution} from '../src/validation.js';
import {projectIdentityKey} from '../src/extension-identity.js';
import {fixture,submission,IDS} from './helpers.mjs';
const post='https://discord.com/channels/444444444444444444/555555555555555555/666666666666666666';
const other='https://discord.com/channels/777777777777777777/888888888888888888';

async function legacy(t,{invalid=false}={}) {
 const dir=await mkdtemp(join(tmpdir(),'miemie-v5-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'v4.sqlite');
 const store=openStore(path);store.upsertIdentity({id:IDS.A,displayName:'Fixture',username:'fixture',avatarBytes:Buffer.from('fixture-avatar')},1);
 store.upsertIdentity({id:IDS.B,displayName:'Original submitter',username:'original'},1);
 store.createSession('fixture-session-hash',IDS.A,'https://fixture.invalid',999999);
 store.bootstrapAdmins([IDS.A],1);
 for(const [id,content] of [['github',{}],['github-post',{sourceUrl:'https://github.com/example/second',discordPostUrl:post,visibility:'discord_guild',visibilitySourceUrl:other}],['github-unverified',{sourceUrl:'https://github.com/example/old-unverified'}],['discord',{sourceType:'discord',sourceUrl:post}]]){
  store.insertSubmission({id,ownerId:IDS.A,input:submissionInput(submission(content)),github:id==='discord'?null:{compatibility:id==='github-unverified'?'external':'installable',manifest:{id:'test.'+id}},time:2});
 }
 // Official product identities are representative release fixtures, never live data.
 for(const [id,name,version] of [['hub','MieMie-Hub','0.8.0'],['polisher','MieMie-Polisher','1.2.0']]){
  const repository='https://github.com/SheepSheepLab/'+name;
  store.insertSubmission({id,ownerId:IDS.A,input:submissionInput(submission({sourceUrl:repository})),github:{compatibility:'installable',repository,manifest:{id:'miemie.'+id,repository,version}},time:2});
  store.setClassification(id,'official',3);store.setProtection(id,true);
  store.db.prepare('UPDATE submissions SET submitter_id=? WHERE id=?').run(IDS.B,id);
 }
 store.setClassification('github-post','official',3);store.setHold('github-post',true);store.setOwnerStatus('github-post','unlisted',4);store.setModeration('github-post','hidden','test moderation',5);
 store.setRole(IDS.A,'admin',true);store.audit(IDS.A,'fixture','github-post','history stays intact',5,{value:1},{value:2});
 // Reproduce the released v4 columns and legacy public Discord state exactly.
 store.db.exec("ALTER TABLE submissions ADD COLUMN github_url TEXT; ALTER TABLE submissions ADD COLUMN discord_url TEXT; UPDATE submissions SET github_url=source_url,discord_url=discord_post_url,distribution='external_release' WHERE source_type='github'; UPDATE submissions SET github_url='https://github.com/example/old-aux',discord_url=source_url,distribution='open_url',visibility='public',visibility_guild_id=NULL,visibility_source_url=NULL WHERE source_type='discord'; ALTER TABLE submissions DROP COLUMN discord_post_url; PRAGMA user_version=4;");
 if(invalid)store.db.prepare('UPDATE submissions SET source_url=? WHERE id=?').run('https://discord.gg/invite','discord');
 const before=store.db.prepare('SELECT * FROM submissions ORDER BY id').all();
 const tables=Object.fromEntries(['identities','avatars','sessions','audit','roles','governance_settings'].map(table=>[table,store.db.prepare(`SELECT * FROM ${table}`).all()]));
 store.close();return {path,dir,before,tables};
}

test('schema 4→5 preserves all non-link data, normalizes Discord ACL, derives aliases and reruns idempotently',async t=>{
 const f=await legacy(t);
 for(let i=0;i<2;i++){
  const store=openStore(f.path);
  try{
   assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,5);
   const columns=store.db.prepare('PRAGMA table_info(submissions)').all().map(r=>r.name);
   assert.ok(columns.includes('discord_post_url'));assert.ok(!columns.includes('github_url'));assert.ok(!columns.includes('discord_url'));
   for(const before of f.before){
    const row=store.getEntry(before.id),discord=before.source_type==='discord';
    for(const [key,value]of Object.entries(before))if(!['github_url','discord_url','distribution',...(discord?['visibility','visibility_guild_id','visibility_source_url']:[])].includes(key))assert.deepEqual(row[key],value,key);
    assert.equal(row.discord_post_url,discord?null:before.discord_url);assert.equal(row.distribution,productDistribution(row.product_type,row.source_type,JSON.parse(row.github_json||'null')));
    if(discord){assert.equal(row.visibility,'discord_guild');assert.equal(row.visibility_guild_id,'444444444444444444');assert.equal(row.visibility_source_url,post);}
    else assert.equal(projectIdentityKey(row),projectIdentityKey(before),'official GitHub project binding stays identical');
    const dto=store.entryDTO(row);if(row.id==='github-unverified')assert.equal(dto.github.compatibility,'external','normalizing distribution must not invent Package verification');assert.equal(dto.githubUrl,discord?null:before.source_url);assert.equal(dto.discordUrl,discord?post:before.discord_url);assert.equal(dto.discordPostUrl,row.discord_post_url);
   }
   for(const [table,rows]of Object.entries(f.tables))assert.deepEqual(store.db.prepare(`SELECT * FROM ${table}`).all(),rows,table);
   assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{store.close();}
 }
});
test('invalid legacy Discord source aborts v5 atomically, retaining schema and every original row',async t=>{
 const f=await legacy(t,{invalid:true});assert.throws(()=>openStore(f.path),/Discord/);
 const db=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.deepEqual(db.prepare('SELECT * FROM submissions ORDER BY id').all(),f.before);assert.ok(!db.prepare('PRAGMA table_info(submissions)').all().some(c=>c.name==='discord_post_url'));}finally{db.close();}
});
test('future schema is rejected without downgrade',async t=>{
 const f=await legacy(t);const db=new DatabaseSync(f.path);db.exec('PRAGMA user_version=6');db.close();assert.throws(()=>openStore(f.path),/数据库版本/);
});
test('offline v4 migration tool verifies exact allowed differences and leaves source untouched',async t=>{
 const f=await legacy(t);const result=spawnSync(process.execPath,[new URL('../tools/migrate-verified.mjs',import.meta.url).pathname,f.path,join(f.dir,'backups'),join(f.dir,'candidate.sqlite')],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).schema,5);
 const db=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.deepEqual(db.prepare('SELECT * FROM submissions ORDER BY id').all(),f.before);}finally{db.close();}
});
test('old Hub public Discord creates canonical guild-only entry, PATCH cannot publish it, ACL applies everywhere',async t=>{
 const f=await fixture(t),a=await f.login(),b=await f.login('B');
 const created=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({sourceType:'discord',sourceUrl:post,discordUrl:post,githubUrl:'',visibility:'public'})});
 assert.equal(created.status,201);const row=created.data;assert.equal(row.visibility,'discord_guild');assert.equal(row.visibilitySourceUrl,post);assert.equal(row.githubUrl,null);assert.equal(row.discordUrl,post);assert.equal(row.discordPostUrl,null);
 const updated=await f.req('/api/submissions/'+row.id,{method:'PATCH',token:a.token,body:{visibility:'public',visibilitySourceUrl:null}});assert.equal(updated.status,200);assert.equal(updated.data.visibility,'discord_guild');
 for(const token of [undefined,b.token]){assert.equal((await f.req('/api/catalog',{token})).data.total,0);assert.equal((await f.req('/api/catalog/'+row.id,{token})).status,404);}
 assert.equal((await f.req('/api/catalog',{token:a.token})).data.total,1);assert.equal((await f.req('/api/catalog/'+row.id,{token:a.token})).status,200);
 f.memberships.A=[];assert.equal((await f.req('/api/submissions/'+row.id,{method:'PATCH',token:a.token,body:{visibility:'public'}})).status,403);
});
test('GitHub auxiliary post requires no membership, supports old/new edits and never changes official identity',async t=>{
 const f=await fixture(t),a=await f.login(),o=await f.login('OWNER');
 const created=await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({discordPostUrl:other})});assert.equal(created.status,201);assert.equal(f.membershipCalls.length,0);const row=created.data;
 assert.equal(row.visibility,'public');assert.equal(row.discordUrl,other);assert.equal(row.discordPostUrl,other);
 assert.equal((await f.req('/api/admin/submissions/'+row.id+'/classification',{method:'POST',token:o.token,body:{classification:'official',reason:'test acceptance',projectIdentityKey:row.projectIdentityKey}})).status,200);
 for(const body of [{discordPostUrl:post},{discordUrl:other},{discordUrl:''},{discordPostUrl:post}]){
  const r=await f.req('/api/submissions/'+row.id,{method:'PATCH',token:a.token,body});assert.equal(r.status,200);assert.equal(r.data.classification,'official');assert.equal(r.data.projectIdentityKey,row.projectIdentityKey);assert.equal(r.data.discordPostUrl,(body.discordPostUrl??body.discordUrl)||null);
 }
 assert.equal((await f.req('/api/catalog')).data.total,1);
});
test('both sources reject link smuggling; primary Discord parser remains strict',()=>{
 for(const patch of [{githubUrl:'https://github.com/example/aux'},{discordPostUrl:other},{visibilitySourceUrl:other}])assert.throws(()=>submissionInput(submission({sourceType:'discord',sourceUrl:post,...patch})));
 for(const discordPostUrl of ['https://discord.gg/test','https://cdn.discordapp.com/attachments/test','https://discord.com/channels/@me/123',{},[]])assert.throws(()=>submissionInput(submission({discordPostUrl})));
 assert.throws(()=>submissionInput(submission({discordPostUrl:post,discordUrl:other})));
 const input=submissionInput(submission({discordPostUrl:other,visibility:'discord_guild',visibilitySourceUrl:post}));assert.equal(input.discordPostUrl,other);assert.equal(input.visibilitySourceUrl,post);
});

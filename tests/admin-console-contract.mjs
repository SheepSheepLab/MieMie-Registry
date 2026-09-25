// Isolated full Console + Registry HTTP contract. Mock Discord, no production identities.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
if(process.argv[2]!=='--jsdom-module'||!process.argv[3]||process.argv.length!==4)throw Error('Pass --jsdom-module <explicit installed jsdom/lib/api.js>');
const {JSDOM}=await import(pathToFileURL(process.argv[3]).href);
import {adminPage,adminScript} from '../src/admin.js';
import {fixture,IDS,submission} from './helpers.mjs';
const cleanups=[],f=await fixture({after:fn=>cleanups.push(fn)});
let who='OWNER';
const a=await f.login('A');const row=(await f.req('/api/submissions',{method:'POST',token:a.token,body:submission()})).data;
const b=await f.login('B');const other=(await f.req('/api/submissions',{method:'POST',token:b.token,body:submission({sourceUrl:'https://github.com/another/fixture'})})).data;
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Console UI did not settle');};
const checks=[];
async function check(label,fn){await fn();checks.push(label);console.log('PASS '+label);}
const dom=new JSDOM(adminPage,{url:f.config.publicBaseUrl+'/admin',runScripts:'outside-only'}),w=dom.window;
Object.defineProperty(w,'crypto',{value:webcrypto});Object.assign(w,{TextEncoder,AbortSignal});const nativeTimeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms)=>nativeTimeout(fn,Math.min(ms,5));
let popupDone;
w.open=()=>({close(){},set location(url){popupDone=(async()=>{const r=await f.req(new URL(url).pathname+new URL(url).search,{origin:null});const state=new URL(r.headers.get('location')).searchParams.get('state');const cb=await f.req('/api/auth/callback?code='+who+'&state='+state,{origin:null,headers:{Cookie:r.headers.get('set-cookie').split(';')[0]}});assert.equal(cb.status,200);})();}});
w.fetch=async(path,options)=>{const method=options.method||'GET';const r=await f.req(path,{method,origin:method==='GET'?null:w.location.origin,headers:{...options.headers,'sec-fetch-site':'same-origin'},body:options.body?JSON.parse(options.body):undefined});return new Response(JSON.stringify(r.data),{status:r.status});};
const card=()=>w.document.querySelector('article[data-submission-id="'+row.id+'"]');
const click=async (label,scope=w.document)=>{const b=[...scope.querySelectorAll('button')].find(x=>x.textContent===label);assert.ok(b,label);b.click();await new Promise(r=>setTimeout(r,40));};
try{
 w.eval(adminScript);
 await check('Owner OAuth poll handoff and same-origin Bearer current-user read',async()=>{await click('使用 Discord 登录');await until(()=>w.document.body.textContent.includes('角色与封禁'));await popupDone;assert.ok(w.document.body.textContent.includes('Development Fixture OWNER'));});
 await check('Identical names/authors/descriptions remain distinguishable by source, submitter and record ID',async()=>{
  assert.equal(row.name,other.name);assert.equal(row.author,other.author);assert.equal(row.description,other.description);
  for(const [entry,who] of [[row,'A'],[other,'B']]){
   const text=w.document.querySelector('article[data-submission-id="'+entry.id+'"]').textContent;
   for(const value of [entry.sourceUrl,f.profiles[who].displayName,IDS[who],entry.id])assert.ok(text.includes(value),value);
  }
 });
 await check('Owner Console hides and recovers without content editor',async()=>{const reason=card().querySelector('input');reason.value='Fixture hide';await click('Hide',card());await until(()=>f.store.getEntry(row.id).moderation==='hidden');card().querySelector('input').value='Fixture recover';await click('Recover',card());await until(()=>f.store.getEntry(row.id).moderation==='visible');assert.equal(f.store.getEntry(row.id).name,row.name);});
 await check('Owner changes extension identity with a reason; downgrade preserves protection',async()=>{
  card().querySelector('input').value='Fixture official adoption';await click('设为🐑官方扩展',card());
  await until(()=>f.store.getEntry(row.id).classification==='official');assert.ok(card().textContent.includes('🐑官方扩展'));assert.equal(f.store.getEntry(other.id).classification,'community');
  card().querySelector('input').value='Fixture return to community';await click('设为🧩社区扩展',card());
  await until(()=>f.store.getEntry(row.id).classification==='community');assert.equal(f.store.getEntry(row.id).moderation_protected,1);
  card().querySelector('input').value='Fixture remove protection';await click('解除保护',card());
  await until(()=>f.store.getEntry(row.id).moderation_protected===0);
 });
 await check('Owner protection and Hold controls work',async()=>{card().querySelector('input').value='Fixture hold';await click('设置Security Hold',card());await until(()=>f.store.getEntry(row.id).security_hold===1);});
 await check('Owner Audit shows governance actions',async()=>{await click('治理审计');assert.ok(w.document.querySelector('pre').textContent.includes('security-hold'));});
 await check('Owner roles list stays in independent Console',async()=>{await click('角色与封禁');assert.ok(w.document.body.textContent.includes('授予 admin'));assert.ok(!w.document.body.textContent.includes('授予 official_publisher'));});
 await check('Logout clears Console data; Moderator UI has only Community actions',async()=>{await click('退出登录');who='ADMIN';await click('使用 Discord 登录');await until(()=>w.document.body.textContent.includes('Development Fixture ADMIN'));assert.ok(!w.document.body.textContent.includes('角色与封禁'));assert.ok(!w.document.body.textContent.includes('Security Hold'));assert.ok(!w.document.body.textContent.includes('设为🐑官方扩展'));assert.ok(w.document.body.textContent.includes('Hide'));});
 await check('Normal user cannot view Console data',async()=>{await click('退出登录');who='A';await click('使用 Discord 登录');await until(()=>w.document.body.textContent.includes('当前账号没有治理权限'));assert.equal(w.document.querySelector('article'),null);});
 console.log('PASS '+checks.length+' Console HTTP/DOM checks (mock Discord).');
}finally{dom.window.close();for(const fn of cleanups.reverse())await fn();}

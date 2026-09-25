// Isolated full Console + Registry HTTP contract. Mock Discord, no production identities.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
if(process.argv[2]!=='--jsdom-module'||!process.argv[3]||process.argv.length!==4)throw Error('Pass --jsdom-module <explicit installed jsdom/lib/api.js>');
const {JSDOM}=await import(pathToFileURL(process.argv[3]).href);
import {adminPage,adminScript,adminStyle} from '../src/admin.js';
import {fixture,IDS,submission} from './helpers.mjs';
const cleanups=[],f=await fixture({after:fn=>cleanups.push(fn)}, {github:{async inspect(url){const [,owner,repo]=new URL(url).pathname.split('/');return {owner,repo,compatibility:'external',manifest:{id:'fixture.extension',repository:url},release:null};}}});
let who='OWNER';
const a=await f.login('A');const row=(await f.req('/api/submissions',{method:'POST',token:a.token,body:submission({websiteUrl:'https://example.com/project'})})).data;
const b=await f.login('B');const other=(await f.req('/api/submissions',{method:'POST',token:b.token,body:submission({sourceUrl:'https://github.com/another/fixture'})})).data;
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Console UI did not settle');};
const checks=[];
async function check(label,fn){await fn();checks.push(label);console.log('PASS '+label);}
const dom=new JSDOM(adminPage,{url:f.config.publicBaseUrl+'/admin',runScripts:'outside-only'}),w=dom.window;
Object.defineProperty(w,'crypto',{value:webcrypto});Object.assign(w,{TextEncoder,AbortSignal});const nativeTimeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms)=>nativeTimeout(fn,Math.min(ms,5));
let popupDone;
w.open=()=>({close(){},set location(url){popupDone=(async()=>{const r=await f.req(new URL(url).pathname+new URL(url).search,{origin:null});const state=new URL(r.headers.get('location')).searchParams.get('state');const cb=await f.req('/api/auth/callback?code='+who+'&state='+state,{origin:null,headers:{Cookie:r.headers.get('set-cookie').split(';')[0]}});assert.equal(cb.status,200);})();}});
const mutations=[];
w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
w.fetch=async(path,options)=>{const method=options.method||'GET';if(method==='POST'&&path.startsWith('/api/admin/'))mutations.push({path,body:JSON.parse(options.body)});const r=await f.req(path,{method,origin:method==='GET'?null:w.location.origin,headers:{...options.headers,'sec-fetch-site':'same-origin'},body:options.body?JSON.parse(options.body):undefined});return new Response(JSON.stringify(r.data),{status:r.status});};
const card=()=>w.document.querySelector('tr[data-submission-id="'+row.id+'"]');
const click=async (label,scope=w.document)=>{const b=[...scope.querySelectorAll('button')].find(x=>x.textContent===label);assert.ok(b,label);b.click();await new Promise(r=>setTimeout(r,40));};
const dialog=()=>w.document.querySelector('dialog[open]');
const confirm=async reason=>{const modal=dialog();assert.ok(modal);modal.querySelector('textarea').value=reason;await click('确认执行',modal);};
const action=async(label,reason)=>{await click(label,card());await confirm(reason);};
try{
 const stylesheet=w.document.createElement('style');stylesheet.textContent=adminStyle;w.document.head.append(stylesheet);assert.ok(stylesheet.sheet.cssRules.length>30);
 w.eval(adminScript);
 await check('Owner OAuth and public assets use same-origin session with explicit account status',async()=>{
  await click('使用 Discord 登录');await until(()=>w.document.body.textContent.includes('角色与封禁'));await popupDone;
  assert.match(w.document.querySelector('.account').textContent,/Development Fixture OWNER.*管理员/s);
  const page=await f.req('/admin'),css=await f.req('/admin.css');
  assert.match(page.data,/href="\/admin.css"/);assert.match(page.headers.get('content-security-policy'),/style-src 'self'/);assert.doesNotMatch(page.headers.get('content-security-policy'),/unsafe-inline/);
  assert.equal(css.status,200);assert.match(css.headers.get('content-type'),/text\/css/);assert.match(css.data,/@media/);
 });
 await check('Project table disambiguates identical content and includes source, account and project identifiers',async()=>{
  assert.equal(row.name,other.name);assert.equal(row.author,other.author);assert.equal(row.description,other.description);
  assert.equal(w.document.querySelectorAll('tbody tr').length,2);assert.equal(w.document.querySelector('tbody input,tbody textarea'),null);
  for(const [entry,who]of [[row,'A'],[other,'B']]){const text=w.document.querySelector('tr[data-submission-id="'+entry.id+'"]').textContent;for(const value of [entry.name,entry.author,entry.sourceUrl,f.profiles[who].displayName,IDS[who],entry.id,'fixture.extension','Protection','Security Hold'])assert.ok(text.includes(value),value);}
  assert.ok(card().textContent.includes('https://example.com/project'));
 });
 await check('Every project operation waits for confirmation; Cancel and Escape send no governance request',async()=>{
  for(const button of [...card().querySelectorAll('button')]){
   const n=mutations.length;await click(button.textContent,card());assert.ok(dialog());
   for(const value of [row.name,row.id,row.sourceUrl,'fixture.extension',f.profiles.A.displayName])assert.ok(dialog().textContent.includes(value));
   assert.equal(mutations.length,n);await click('取消',dialog());assert.equal(dialog(),null);assert.equal(mutations.length,n);assert.equal(w.document.activeElement,button);
  }
  await click('Hide',card());const n=mutations.length;dialog().dispatchEvent(new w.Event('cancel',{cancelable:true}));assert.equal(dialog(),null);assert.equal(mutations.length,n);
 });
 await check('Blank reasons cannot submit; confirmation executes exactly once with the reason',async()=>{
  await click('Hide',card());const n=mutations.length;dialog().querySelector('textarea').value='   ';dialog().querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(mutations.length,n);
  const modal=dialog();modal.querySelector('textarea').value='  Fixture hide  ';const submit=modal.querySelector('form');submit.dispatchEvent(new w.Event('submit',{cancelable:true}));submit.dispatchEvent(new w.Event('submit',{cancelable:true}));
  await until(()=>!dialog());assert.equal(mutations.length,n+1);assert.equal(mutations.at(-1).body.reason,'Fixture hide');assert.equal(f.store.getEntry(row.id).moderation,'hidden');
  await action('Recover','Fixture recover');assert.equal(f.store.getEntry(row.id).moderation,'visible');
 });
 await check('Identity confirmation retains project snapshot and downgrade preserves protection',async()=>{
  await action('设为🐑官方扩展','Fixture adoption');assert.equal(f.store.getEntry(row.id).classification,'official');assert.ok(mutations.at(-1).body.projectIdentityKey);assert.equal(f.store.getEntry(other.id).classification,'community');
  await action('改为🧩社区扩展','Fixture return');assert.equal(f.store.getEntry(row.id).classification,'community');assert.equal(f.store.getEntry(row.id).moderation_protected,1);
  await action('解除保护','Fixture remove protection');assert.equal(f.store.getEntry(row.id).moderation_protected,0);
  await action('设置Security Hold','Fixture hold');assert.equal(f.store.getEntry(row.id).security_hold,1);
  await action('解除Security Hold','Fixture release');assert.equal(f.store.getEntry(row.id).security_hold,0);
 });
 await check('Stale project confirmation is rejected and retains reason without claiming success',async()=>{
  await click('设为🐑官方扩展',card());const r=await f.req('/api/submissions/'+row.id,{method:'PATCH',token:a.token,body:{sourceUrl:'https://github.com/example/changed'}});assert.equal(r.status,200);
  await confirm('Review old card');assert.ok(dialog());assert.match(dialog().querySelector('[role=alert]').textContent,/变化/);assert.equal(dialog().querySelector('textarea').value,'Review old card');assert.equal(f.store.getEntry(row.id).classification,'community');await click('取消',dialog());await click('刷新列表');
 });
 await check('Owner audit retains server actions and expandable details',async()=>{await click('治理审计');assert.match(w.document.querySelector('table').textContent,/security-hold/);assert.ok(w.document.querySelector('details pre'));});
 await check('Late list responses cannot replace the current management section',async()=>{
  await click('投稿管理');const fetchNow=w.fetch;let release,started;
  const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  w.fetch=async(path,options)=>{if(path.startsWith('/api/admin/submissions?')){started();await gate;}return fetchNow(path,options);};
  const pending=click('刷新列表');await ready;await click('角色与封禁');release();await pending;await new Promise(r=>setTimeout(r,40));
  assert.ok(w.document.querySelector('[data-identity-id]'));assert.equal(w.document.querySelector('[data-submission-id]'),null);w.fetch=fetchNow;
 });
 await check('Account table protects Owner and confirms all user mutations including legacy role revocation',async()=>{
  f.store.setRole(IDS.A,'official_publisher',true);await click('角色与封禁');
  const user=()=>w.document.querySelector('[data-identity-id="'+IDS.A+'"]');
  assert.equal(w.document.querySelector('[data-identity-id="'+IDS.OWNER+'"] button'),null);assert.match(w.document.querySelector('[data-identity-id="'+IDS.OWNER+'"]').textContent,/管理员.*Owner/s);
  for(const b of [...user().querySelectorAll('button')]){const n=mutations.length;await click(b.textContent,user());assert.ok(dialog().textContent.includes(IDS.A));assert.equal(mutations.length,n);await click('取消',dialog());assert.equal(mutations.length,n);}
  for(const [label,assertion]of [
   ['Ban · 限制账号',()=>{assert.equal(f.store.getIdentity(IDS.A).banned,1);assert.match(user().textContent,/受限用户/);}],
   ['Unban · 解除限制',()=>assert.equal(f.store.getIdentity(IDS.A).banned,0)],
   ['授予管理员',()=>assert.ok(f.store.rolesFor(IDS.A).includes('admin'))],
   ['撤销管理员',()=>assert.ok(!f.store.rolesFor(IDS.A).includes('admin'))],
   ['撤销历史 Publisher',()=>assert.ok(!f.store.rolesFor(IDS.A).includes('official_publisher'))],
  ]){await click(label,user());await confirm('Fixture '+label);assertion();assert.equal(mutations.at(-1).body.reason,'Fixture '+label);}
 });
 await check('Admin sees only community moderation and cancellation never mutates',async()=>{
  await click('退出登录');who='ADMIN';await click('使用 Discord 登录');await until(()=>w.document.body.textContent.includes('Development Fixture ADMIN'));
  assert.ok(!w.document.body.textContent.includes('角色与封禁'));assert.ok(!w.document.body.textContent.includes('设为🐑官方扩展'));
  assert.deepEqual([...card().querySelectorAll('button')].map(b=>b.textContent),['Hide','Recover']);
  const n=mutations.length;await click('Hide',card());await click('取消',dialog());assert.equal(mutations.length,n);
  await action('Hide','Moderator hide');assert.equal(f.store.getEntry(row.id).moderation,'hidden');await action('Recover','Moderator recover');
  const admin=await f.login('ADMIN');assert.equal((await f.req('/api/admin/submissions/'+row.id+'/classification',{method:'POST',token:admin.token,body:{classification:'official',reason:'Forged',projectIdentityKey:row.projectIdentityKey}})).status,403);
 });
 await check('Normal and restricted accounts cannot access governance data',async()=>{
  await click('退出登录');who='A';await click('使用 Discord 登录');await until(()=>w.document.body.textContent.includes('当前账号没有治理权限'));assert.equal(w.document.querySelector('table'),null);assert.match(w.document.querySelector('.account').textContent,/普通用户/);
  await click('退出登录');f.store.setBanned(IDS.ADMIN,true);who='ADMIN';await click('使用 Discord 登录');await until(()=>w.document.body.textContent.includes('当前账号没有治理权限'));assert.match(w.document.querySelector('.account').textContent,/受限用户/);assert.equal(w.document.querySelector('table'),null);
 });
 console.log('PASS '+checks.length+' Console HTTP/DOM checks (mock Discord).');
}finally{dom.window.close();for(const fn of cleanups.reverse())await fn();}

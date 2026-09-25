import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,IDS} from './helpers.mjs';

test('OAuth exchange, poll and me expose explicit banned while preserving Owner/Admin capabilities',async t=>{
 const f=await fixture(t);
 for(const who of ['A','ADMIN','OWNER']){
  for(const banned of [false,true]){
   f.advance(600001);
   await f.login(who);f.store.setBanned(IDS[who],banned);
   const login=await f.login(who),me=(await f.req('/api/me',{token:login.token})).data;
   const flow=await f.begin();await f.callback(flow,who);
   const poll=await f.req('/api/auth/complete',{method:'POST',body:{requestId:flow.requestId,codeVerifier:flow.verifier}});
   assert.equal(poll.status,200);
   for(const dto of [login,me,poll.data]){
    assert.equal(dto.banned,banned);assert.equal(dto.canSubmit,!banned);
    assert.equal(dto.isAdmin,who!=='A');assert.equal(dto.isOwner,who==='OWNER');
   }
   if(banned&&who!=='A')assert.equal((await f.req('/api/admin/submissions',{token:login.token})).status,403);
  }
  f.store.setBanned(IDS[who],false);
 }
 const owner=await f.login('OWNER');const users=(await f.req('/api/admin/identities',{token:owner.token})).data.items;
 assert.equal(users.find(u=>u.discord_id===IDS.OWNER).isOwner,true);
 assert.equal(users.find(u=>u.discord_id===IDS.OWNER).isAdmin,true);
 assert.equal(users.find(u=>u.discord_id===IDS.A).isAdmin,false);
 assert.equal((await f.req('/api/admin/identities/'+IDS.OWNER+'/ban',{method:'POST',token:owner.token,body:{banned:true,reason:'Attempt'}})).status,403);
});

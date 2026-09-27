import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';

for(const failure of ['denied','exchange'])test(`OAuth ${failure} failure terminates polling without publishing a session`,async t=>{
  const f=await fixture(t),flow=await f.begin();
  const callback=failure==='denied'
    ?await f.req('/api/auth/callback?state='+encodeURIComponent(flow.state)+'&error=access_denied',{origin:null,headers:{Cookie:flow.cookie}})
    :await f.callback(flow,'invalid');
  assert.ok(callback.status>=400);
  const body={requestId:flow.requestId,codeVerifier:flow.verifier};
  const result=await f.req('/api/auth/complete',{method:'POST',body});
  assert.equal(result.status,400);assert.equal(result.data.error.code,'invalid_handoff');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
  const retry=await f.login();assert.ok(retry.token);
});

test('invalid callback cookie cannot cancel a legitimate pending OAuth flow',async t=>{
  const f=await fixture(t),flow=await f.begin();
  assert.equal((await f.callback(flow,'A',{headers:{}})).status,400);
  const body={requestId:flow.requestId,codeVerifier:flow.verifier};
  assert.equal((await f.req('/api/auth/complete',{method:'POST',body})).status,202);
  assert.equal((await f.callback(flow)).status,200);
  assert.equal((await f.req('/api/auth/complete',{method:'POST',body})).status,200);
});

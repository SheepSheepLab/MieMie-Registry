import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createApp } from '../src/app.js';
export const ORIGIN = 'http://localhost:8000';
export const IDS = { A:'111111111111111111', B:'222222222222222222', ADMIN:'333333333333333333', OWNER:'999999999999999999' };
const challenge = v => createHash('sha256').update(v).digest('base64url');
export const submission = (overrides={}) => ({name:'Development Fixture · Example',description:'Test data, not a real community endorsement.',author:'Fixture Author',sourceType:'github',sourceUrl:'https://github.com/example/fixture',tags:['test'],...overrides});
export async function fixture(t, options={}) {
  const config = loadConfig({ DISCORD_CLIENT_ID:'000000000000000001',DISCORD_CLIENT_SECRET:'test-only-discord-secret',SESSION_SECRET:'test-only-session-secret-xxxxxxxxxxxxxxxxxxxxxxxx',MIEMIE_ADMIN_DISCORD_IDS:IDS.ADMIN,MIEMIE_OWNER_DISCORD_ID:IDS.OWNER, ...options.env });
  let clock=Date.now(); const store = openStore(options.path||':memory:');
  const profiles = Object.fromEntries(Object.entries(IDS).map(([key,id])=>[key,{id,displayName:`Development Fixture ${key}`,username:`fixture_${key}`,avatarBytes:null}]));
  const inspections=[], membershipCalls=[];
  const memberships={A:['444444444444444444'], B:[], ADMIN:[], OWNER:[]}; let membershipFailure=false;
  const github = options.github || { async inspect(url) { inspections.push(url); if(options.beforeInspect) await options.beforeInspect(url); const u=new URL(url), [,owner,repo]=u.pathname.split('/'); if(repo==='missing') {const error=new Error('not public'); error.status=400;throw error;} return {owner,repo,compatibility:'external',manifest:null,release:null,reason:'fixture metadata'}; } };
  const app=createApp({config,store,...options.app,now:()=>clock,rateLimit:options.rateLimit||10000,github,discord:{authorizationUrl:state=>`https://discord.com/oauth2/authorize?state=${state}`,async exchange(code){if(!profiles[code])throw new Error('invalid OAuth code');return {profile:profiles[code],credentials:{accessToken:`test-only-discord-access-${code}`,expiresAt:clock+(options.oauthTtlMs||36000000),scopes:['identify','guilds']}};},async listGuilds(token){membershipCalls.push(token);if(options.beforeGuilds)await options.beforeGuilds();if(membershipFailure)throw new Error('private-upstream-details');return [...memberships[token.replace('test-only-discord-access-','')]];}}});
  const server=createServer(app.handler); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.close();store.close();});
  async function req(path, {method='GET',body,token,origin=ORIGIN,headers={}}={}) {
    const response=await fetch(`${base}${path}`,{method,headers:{...(origin?{Origin:origin}:{}),...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`} : {}),...headers},body:body?JSON.stringify(body):undefined,redirect:'manual'});
    const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data=raw;} return {status:response.status,data,headers:response.headers};
  }
  async function begin(verifier='v'.repeat(43)) {const start=await req('/api/auth/start',{method:'POST',body:{codeChallenge:challenge(verifier),returnOrigin:ORIGIN}});assert.equal(start.status,200);const auth=await req(new URL(start.data.authorizationUrl).pathname+new URL(start.data.authorizationUrl).search,{origin:null});assert.equal(auth.status,302);return {requestId:start.data.requestId,verifier,cookie:auth.headers.get('set-cookie').split(';')[0],state:new URL(auth.headers.get('location')).searchParams.get('state')};}
  async function callback(flow, who='A', overrides={}) {return req(`/api/auth/callback?state=${encodeURIComponent(flow.state)}&code=${who}`,{origin:null,headers:{Cookie:flow.cookie},...overrides});}
  async function login(who='A') {const flow=await begin();const cb=await callback(flow,who);assert.equal(cb.status,200);const bridge=JSON.parse(cb.data.match(/postMessage\((\{.*?\}),/)[1]);const exchanged=await req('/api/auth/exchange',{method:'POST',body:{code:bridge.code,requestId:flow.requestId,codeVerifier:flow.verifier}});assert.equal(exchanged.status,200);return {...exchanged.data,flow,bridge};}
  return {config,store,req,begin,callback,login,profiles,inspections,memberships,membershipCalls,setMembershipFailure:value=>membershipFailure=value,app,advance:n=>clock+=n};
}

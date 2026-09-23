// SPDX-License-Identifier: GPL-3.0-or-later
// Development Fixture / Test Data: real browser HTTP, popup, cookies and CORS;
// Discord and GitHub are mocked. Never uses production credentials or databases.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {openStore} from '../src/store.js';

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const [key, value] = process.argv.slice(i, i + 2);
  if (!['--hub', '--sha256', '--auto-consent', '--detach-opener', '--iframe', '--sandbox'].includes(key) || !value || flags.has(key)) throw Error('Usage: node tests/browser-oauth.mjs --hub <built Hub JSON> --sha256 <locked SHA-256>');
  flags.set(key, value);
}
assert.ok(flags.has('--hub') && /^[a-f0-9]{64}$/.test(flags.get('--sha256') || ''), 'Explicit Hub artifact and SHA-256 are required');
if (flags.has('--auto-consent')) assert.equal(flags.get('--auto-consent'), 'true');
const detachOpener = flags.get('--detach-opener') === 'true';
const sandboxMode = flags.get('--sandbox') === 'true';
const iframeMode = flags.get('--iframe') === 'true';
const autoConsent = flags.get('--auto-consent') === 'true';
const bytes = await readFile(flags.get('--hub'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), flags.get('--sha256'), 'Hub artifact differs from the locked SHA-256');
const script = JSON.parse(bytes);
assert.equal(script.type, 'script'); assert.equal(script.id, 'e85cd9a3-6352-4b23-938a-6c94d826b4d3');
const build = JSON.parse(script.content.split('\n')[0].slice('// MieMie-Hub-Build: '.length));
assert.equal(build.productId, 'miemie.hub');
assert.match(build.version, /^\d+\.\d+\.\d+$/);
const start = script.content.indexOf('// Registry sessions are kept only');
const end = script.content.indexOf('// Downloaded scripts are never evaluated', start);
assert.ok(start > 0 && end > start, 'Hub Registry client boundary missing');
const clientSource = script.content.slice(start, end);
assert.ok(!/^import /m.test(clientSource), 'Expected a self-contained built Registry client');

const USER = '711111111111111111', GUILD = '744444444444444444';
const store = openStore(':memory:');
const config = loadConfig({DISCORD_CLIENT_ID: '000000000000000001', DISCORD_CLIENT_SECRET: 'fixture-only-not-a-real-discord-secret', SESSION_SECRET: 'fixture-only-browser-session-secret-xxxxxxxx'});
let registryBase = '', browserBase = '', isMember = true, completed = null;
const profile = {id: USER, displayName: 'Development Fixture Member', username: 'fixture_member', avatarBytes: null};
const app = createApp({config, store, rateLimit: 1000,
  discord: {
    authorizationUrl: state => registryBase + '/__test/consent?state=' + encodeURIComponent(state),
    async exchange(code) {
      assert.equal(code, 'fixture-approved-code');
      return {profile: {...profile}, credentials: {accessToken: 'fixture-only-discord-access-token', expiresAt: Date.now() + 3600000, scopes: ['identify', 'guilds']}};
    },
    async listGuilds(token) {assert.equal(token, 'fixture-only-discord-access-token'); return isMember ? [GUILD] : [];},
  },
  github: {async inspect() {throw Error('This browser fixture must not inspect a real repository');}},
  githubRelay: {async read() {throw Error('This browser fixture must not download a real package');}},
});
const registryServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__test/consent') {
    const state = url.searchParams.get('state');
    if (!/^[A-Za-z0-9_-]{43}$/.test(state || '')) {res.writeHead(400); res.end('Invalid fixture state'); return;}
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...(detachOpener ? {'Cross-Origin-Opener-Policy':'same-origin'} : {})});
    res.end((autoConsent ? '<meta http-equiv="refresh" content="0;url=/api/auth/callback?code=fixture-approved-code&amp;state=' + state + '">' : '') + '<!doctype html><meta charset="utf-8"><title>Development Fixture consent</title><h1>Development Fixture / Mock Discord</h1><p>This is a local browser test, not Discord. No real account or credentials are involved.</p><a href="/api/auth/callback?code=fixture-approved-code&amp;state=' + state + '">Approve fixture login</a>');
    return;
  }
  void app.handler(req, res);
});
const inline = value => JSON.stringify(value).replaceAll('<', '\u003c');
const page = () => `<!doctype html><meta charset="utf-8"><title>MieMie browser OAuth fixture</title>
<style>body{font:17px system-ui;max-width:1000px;margin:40px auto;padding:20px}button{font:inherit;padding:12px}li{margin:12px 0}.pass{color:#176b25}.fail{color:#ae1515}</style>
<h1>Development Fixture / Test Data</h1>
<p>Hub ${build.version}: real browser popup, cookies, CORS and server ACL. Discord is mocked; this does not establish real Discord or SillyTavern verification.</p>
<button id="start">Start browser OAuth fixture</button><p id="status">Ready. A clearly labeled local mock consent popup will open.</p><ol id="results"></ol>
<script src="/locked-hub-client.js"></script><script>
const BASE=${inline(registryBase)}, USER=${inline(USER)}, GUILD=${inline(GUILD)};
const list=document.querySelector('#results'), status=document.querySelector('#status'), button=document.querySelector('#start');
const checks=[], requests=[];
function assert(value,message){if(!value)throw Error(message);}
async function check(name,fn){await fn();checks.push({name,passed:true});const li=document.createElement('li');li.textContent='PASS — '+name;li.className='pass';list.append(li);}
const client=createRegistryClient({host:window.parent,crypto:window.crypto,timeoutMs:10000,loginTimeoutMs:120000,fetch:async(url,options)=>{
  assert(new URL(url).origin===BASE,'Registry credentials escaped the configured origin');
  assert(options.credentials==='omit'&&options.mode==='cors'&&options.redirect==='error','Client transport policy changed');
  requests.push({path:new URL(url).pathname,authorization:Boolean(options.headers.Authorization)});
  return fetch(url,options);
}});
client.setBase(BASE);
const catalog=()=>client.api('/api/catalog',{authenticated:'optional'});
const anonymous=async path=>{const response=await fetch(BASE+path,{credentials:'omit',mode:'cors',redirect:'error'});return {status:response.status,body:await response.json()};};
async function execute(login){
 let item;
 await check('Popup login confirms current user without depending on opener or third-party cookies',async()=>{
  const identity=await login;assert(identity.profile.displayName==='Development Fixture Member','Profile mismatch');
  assert(!JSON.stringify(identity).includes(USER)&&!JSON.stringify(identity).includes('fixture-only-discord-access-token'),'Private identity leaked');
  assert(requests.some(r=>r.path==='/api/auth/complete'&&!r.authorization),'Expected PKCE completion request missing');
 });
 await check('Active submission alone creates the Guild-restricted Catalog entry',async()=>{
  assert((await catalog()).total===0,'Fixture catalog must start empty');
  item=await client.api('/api/submissions',{method:'POST',authenticated:true,body:{name:'Development Fixture Restricted',author:'Separate Fixture Author',description:'Guild ACL browser fixture',sourceType:'discord',sourceUrl:'https://discord.com/channels/'+GUILD+'/755555555555555555/766666666666666666',icon:'',tags:['fixture'],visibility:'discord_guild'}});
  assert(item.author==='Separate Fixture Author'&&item.submitter.displayName==='Development Fixture Member','Author and submitter not separated');
 });
 await check('Authenticated member receives the entry and authorized total',async()=>{
  const result=await catalog();assert(result.total===1&&result.items[0].id===item.id,'Member catalog missing entry');
  assert(!JSON.stringify(result).includes(USER),'Discord User ID leaked');
  assert((await client.api('/api/catalog/'+item.id,{authenticated:'optional'})).id===item.id,'Member detail missing');
 });
 await check('Anonymous list, search, counts and details disclose no restricted entry',async()=>{
  for(const path of ['/api/catalog','/api/catalog?q=Restricted&pageSize=1']){const r=await anonymous(path);assert(r.status===200&&r.body.total===0&&r.body.items.length===0&&!r.body.hasMore,'Anonymous ACL/count leak');}
  assert((await anonymous('/api/catalog/'+item.id)).status===404,'Anonymous detail leak');
 });
 await check('Fresh membership loss denies previously authorized session',async()=>{
  await fetch('/__test/membership',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({member:false})});
  assert((await catalog()).total===0,'Stale membership was trusted');
  let denied=false;try{await client.api('/api/catalog/'+item.id,{authenticated:'optional'});}catch{denied=true;}assert(denied,'Nonmember detail leaked');
  await fetch('/__test/membership',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({member:true})});
 });
 await check('My edit, soft unlist and relist preserve ownership and update discovery',async()=>{
  await client.api('/api/submissions/'+item.id,{method:'PATCH',authenticated:true,body:{description:'Edited browser fixture'}});
  assert((await catalog()).items[0].description==='Edited browser fixture','Edit missing');
  await client.api('/api/submissions/'+item.id+'/status',{method:'POST',authenticated:true,body:{status:'unlisted'}});
  assert((await catalog()).total===0,'Unlisted entry still discoverable');
  assert((await client.api('/api/submissions',{authenticated:true})).items[0].status==='unlisted','Unlisted entry lost from mine');
  await client.api('/api/submissions/'+item.id+'/status',{method:'POST',authenticated:true,body:{status:'listed'}});
  assert((await catalog()).total===1,'Relist failed');
 });
 await check('Public entries remain visible without login',async()=>{
  await client.api('/api/submissions',{method:'POST',authenticated:true,body:{name:'Development Fixture Public',author:'Separate Fixture Author',description:'Public browser fixture',sourceType:'discord',sourceUrl:'https://discord.com/channels/'+GUILD+'/755555555555555555/777777777777777777',icon:'',tags:[],visibility:'public'}});
  assert((await anonymous('/api/catalog')).body.total===1,'Public entry unavailable');
 });
 await check('Logout clears identity and restricted Catalog access immediately',async()=>{
  const pending=client.logout();assert(client.getIdentity()===null,'Logout did not clear local session');await pending;
  const result=await catalog();assert(result.total===1&&result.items[0].name==='Development Fixture Public','Logout retains restricted Catalog');
 });
 client.dispose();
 document.title='PASS '+checks.length+'/'+checks.length+' MieMie browser OAuth fixture';status.textContent=document.title;
 await fetch('/__test/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({passed:true,checks})});
}
button.onclick=()=>{button.disabled=true;status.textContent='Approve the Development Fixture popup. No real Discord login is used.';const login=client.login();void execute(login).catch(async error=>{client.dispose();const li=document.createElement('li');li.className='fail';li.textContent='FAIL — '+error.message;list.append(li);document.title='FAIL MieMie browser OAuth fixture';status.textContent=document.title;await fetch('/__test/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({passed:false,error:error.message,stack:error.stack,requests,checks})});});};
</script>`;
const browserServer = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/' && iframeMode) {res.writeHead(200, {'Content-Type':'text/html'});res.end('<!doctype html><title>Development Fixture · Tavern iframe</title><iframe src="/hub-frame" style="width:100%;height:95vh" '+(sandboxMode ? 'sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"' : '')+'></iframe>');return;}
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'GET' && ['/','/hub-frame'].includes(path)) {res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});res.end(page());return;}
  if (req.method === 'GET' && path === '/locked-hub-client.js') {res.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8'});res.end(clientSource);return;}
  if (req.method === 'GET' && path === '/__test/result') {res.writeHead(200, {'Content-Type':'application/json'});res.end(JSON.stringify(completed ?? {pending:true}));return;}
  if (req.method === 'POST' && ['/__test/membership','/__test/result'].includes(path) && req.headers.origin === browserBase && req.headers['content-type'] === 'application/json') {
    let body='';for await (const chunk of req) {body+=chunk;if(body.length>16384){res.writeHead(413);res.end();return;}}
    try {
      const value=JSON.parse(body);
      if(path==='/__test/membership'){assert.equal(typeof value.member,'boolean');isMember=value.member;}
      else {assert.equal(typeof value.passed,'boolean');completed={fixture:'Development Fixture / Test Data',hubVersion:build.version,hubArtifactSha256:flags.get('--sha256'),detachOpener,iframeMode,sandboxMode,...value};console.log(JSON.stringify(completed));}
      res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');
    }catch{res.writeHead(400);res.end('Invalid fixture command');}
    return;
  }
  res.writeHead(404);res.end();
});
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
await listen(registryServer);registryBase='http://127.0.0.1:'+registryServer.address().port;
await listen(browserServer);browserBase='http://127.0.0.1:'+browserServer.address().port;
config.publicBaseUrl=registryBase;config.redirectUri=registryBase+'/api/auth/callback';config.allowedOrigins.add(browserBase);config.allowedOrigins.add(registryBase);
console.log(JSON.stringify({fixture:'Development Fixture / Test Data',url:browserBase,registryOrigin:registryBase,hubVersion:build.version,hubArtifactSha256:flags.get('--sha256'),instructions: autoConsent ? 'Click Start; local Mock Discord consent is automated for this fixture only.' : 'Click Start browser OAuth fixture, then Approve fixture login in the local mock popup.'}));
let stopping=false;
function stop(){if(stopping)return;stopping=true;browserServer.closeAllConnections();registryServer.closeAllConnections();browserServer.close();registryServer.close();app.close();store.close();}
process.once('SIGINT',stop);process.once('SIGTERM',stop);

// Read-only upstream verification. The only POST exchanges the App JWT for a
// scoped installation token. No database, package execution or byte persistence.
import {createHash} from 'node:crypto';
import {createGitHubAuth} from '../src/github-auth.js';
import {createGitHubClient} from '../src/github-client.js';
import {isGitHubError} from '../src/github-upstream-state.js';
const repository = process.argv[2];
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || repository.split('/')[0].toLowerCase() === 'sheepsheeplab') {
  console.error('Usage: node tools/github-community-poc.mjs <community-owner/repository>'); process.exit(1);
}
let client, step = 'app_configuration'; const checks = [], requests = [];
try {
  if (process.env.GITHUB_AUTH_MODE !== 'app') throw Error('app required');
  const instrumentedFetch = async (url, options) => {
    const api = new URL(url).origin === 'https://api.github.com';
    if ((!api && options.headers.Authorization) || (api && !options.headers.Authorization)) throw Error('authorization boundary');
    const response = await fetch(url, options);
    // No Authorization, JWT, token, body or signed CDN URLs enter this evidence.
    requests.push({host:new URL(url).hostname, method:options.method, status:response.status, authenticated:api});
    return response;
  };
  const auth=createGitHubAuth({mode:'app',appId:process.env.GITHUB_APP_ID,installationId:process.env.GITHUB_APP_INSTALLATION_ID,privateKeyPath:process.env.GITHUB_APP_PRIVATE_KEY_PATH},{fetchImpl:instrumentedFetch});
  client=createGitHubClient({auth,fetchImpl:instrumentedFetch});
  const base=`https://api.github.com/repos/${repository}`;
  const json=async(url)=>JSON.parse((await client.read(url,{limit:4*1024*1024})).bytes);
  step='installation_scope';let complete=false,installedCount=0;
  for(let page=1;page<=10;page++){
    const value=await json(`https://api.github.com/installation/repositories?per_page=100&page=${page}`);
    if(!Array.isArray(value.repositories))throw Error('invalid inventory');
    if(value.repositories.some(r=>r.full_name?.toLowerCase()===repository.toLowerCase()))throw Error('repository belongs to installation');
    installedCount+=value.repositories.length;if(value.repositories.length<100){complete=true;break;}
  }
  if(!complete)throw Error('incomplete inventory');checks.push({step,pass:true,installedRepositoryCount:installedCount,targetOutsideInstallation:true});
  step='repository';const repo=await json(base);if(repo.private!==false||repo.full_name?.toLowerCase()!==repository.toLowerCase())throw Error('not public');checks.push({step,pass:true});
  step='releases';const releases=await json(base+'/releases?per_page=10');
  if(!Array.isArray(releases))throw Error('invalid releases');
  const selection=releases.filter(r=>!r.draft&&Number.isSafeInteger(r.id)).flatMap(r=>(r.assets||[]).filter(a=>a.state==='uploaded'&&Number.isSafeInteger(a.size)&&a.size>0&&a.size<=1048576&&Number.isSafeInteger(a.id)&&a.url===`${base}/releases/assets/${a.id}`).map(a=>({r,a}))).sort((a,b)=>a.a.size-b.a.size)[0];
  if(!selection)throw Error('no bounded public asset');checks.push({step,pass:true});
  step='release_by_id';const release=await json(`${base}/releases/${selection.r.id}`);
  if(release.id!==selection.r.id||release.draft!==false)throw Error('release mismatch');checks.push({step,pass:true,releaseId:release.id});
  step='release_asset';const asset=selection.a,{bytes,response}=await client.read(asset.url,{binary:true,limit:1048576,timeout:60000});
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==asset.size||(asset.digest&&asset.digest!==`sha256:${sha256}`))throw Error('asset bytes mismatch');
  checks.push({step,pass:true,assetId:asset.id,bytes:bytes.length,sha256,httpStatus:response.status});
  console.log(JSON.stringify({result:'PASS',repository,checkedAt:new Date().toISOString(),checks,requests,upstream:client.status()},null,2));
} catch(error) {
  console.log(JSON.stringify({result:'FAIL',repository,checkedAt:new Date().toISOString(),step,code:isGitHubError(error)?error.code:'poc_gate_failed',checks,requests},null,2));process.exitCode=1;
} finally {client?.close();}

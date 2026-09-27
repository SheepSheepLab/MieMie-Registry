import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {REGISTRY_VERSION} from '../src/version.js';
import {createGitHubAdapter} from '../src/remote.js';
import {createGitHubRelay} from '../src/github-relay.js';

test('service version and both GitHub User-Agents use package version', async()=>{
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(REGISTRY_VERSION,pkg.version);
  const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  assert.ok(server.includes('MieMie Registry ${REGISTRY_VERSION} listening'));
  assert.doesNotMatch(server,/MieMie Registry \d+\.\d+\.\d+ listening/);
  assert.match(REGISTRY_VERSION,/^\d+\.\d+\.\d+$/);
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push(options.headers['User-Agent']);return new Response('',{status:503});};
  await assert.rejects(()=>createGitHubAdapter({fetchImpl}).inspect('https://github.com/Example/Fixture'));
  await assert.rejects(()=>createGitHubRelay({fetchImpl}).read({repository:'https://github.com/Example/Fixture',releaseId:20,assetId:30}));
  assert.deepEqual(calls,[`MieMie-Registry/${pkg.version}`,`MieMie-Registry/${pkg.version}`]);
});

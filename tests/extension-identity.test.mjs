import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture, submission, IDS} from './helpers.mjs';
import {openStore} from '../src/store.js';

const create = async (f, actor, changes = {}) => {
  const response = await f.req('/api/submissions', {method:'POST', token:actor.token, body:submission(changes)});
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
};
const classify = (f, actor, id, classification, reason = 'Fixture platform identity decision') =>
  f.req(`/api/admin/submissions/${id}/classification`, {method:'POST', token:actor.token, body:{classification, reason, projectIdentityKey:f.store.entryDTO(f.store.getEntry(id),true).projectIdentityKey}});

test('Author, authenticated Submitter and default identity are independent for every account', async t => {
  const f = await fixture(t);
  // A name collision must not confer platform ownership.
  f.profiles.A.displayName = f.profiles.A.username = 'SheepSheep';
  for (const who of ['A','ADMIN','OWNER']) {
    const actor = await f.login(who);
    const row = await create(f, actor, {author:who === 'A' ? 'SheepSheep' : '星夜'});
    assert.equal(row.classification, 'community');
    assert.equal(row.author, who === 'A' ? 'SheepSheep' : '星夜');
    assert.equal(row.submitter.displayName, f.profiles[who].displayName);
    assert.equal(f.store.getEntry(row.id).submitter_id, IDS[who]);
    assert.equal(f.store.getEntry(row.id).owner_id, IDS[who]);
    assert.equal((await f.req('/api/submissions/'+row.id, {method:'PATCH', token:actor.token, body:{classification:'official'}})).status, 403);
    assert.equal((await f.req('/api/submissions', {method:'POST', token:actor.token,
      body:submission({sourceUrl:'https://github.com/example/official', classification:'official'})})).status, 403);
  }
});

test('forged identities and submitters in payloads or remote manifests never assign official', async t => {
  const f = await fixture(t, {github:{async inspect() {return {compatibility:'external',
    manifest:{id:'miemie.polisher', author:'SheepSheep', official:true, classification:'official', extension_identity:'official'}, release:null};}}});
  const a = await f.login();
  for (const [key,value] of Object.entries({official:true, extension_identity:'official', publisher_type:'official', submitted_by:'SheepSheep', submitter_id:IDS.OWNER})) {
    f.advance(600001);
    const r = await f.req('/api/submissions', {method:'POST', token:a.token, body:submission({[key]:value})});
    assert.equal(r.status, 400);
  }
  f.advance(600001);
  const row = await create(f, a);
  assert.equal(row.classification, 'community');
  assert.equal((await f.req('/api/catalog/'+row.id)).data.classification, 'community');
});

test('only Owner can change either identity direction; DTOs and audit retain separate author/submitter/source', async t => {
  const f = await fixture(t), a = await f.login(), admin = await f.login('ADMIN'), owner = await f.login('OWNER');
  const row = await create(f, a, {author:'星夜', sourceType:'discord', sourceUrl:'https://discord.com/channels/444444444444444444/555555555555555555'});
  // A historical publisher role (alone or combined with Admin) has no authority.
  f.store.setRole(IDS.A, 'official_publisher', true);
  f.store.setRole(IDS.ADMIN, 'official_publisher', true);
  for (const value of ['official','community']) {
    for (const actor of [a,admin]) assert.equal((await classify(f, actor, row.id, value)).status, 403);
    assert.equal((await classify(f, owner, row.id, value)).status, 200);
    for (const path of ['/api/catalog/'+row.id, '/api/catalog', '/api/submissions', '/api/admin/submissions']) {
      const r = await f.req(path, {token:path.startsWith('/api/admin') ? owner.token : a.token});
      assert.equal(r.status, 200);
      const dto = r.data.items ? r.data.items.find(x => x.id === row.id) : r.data;
      assert.equal(dto.classification, value);
      assert.equal(dto.author, '星夜');
      assert.equal(dto.submitter.displayName, f.profiles.A.displayName);
      assert.equal(dto.sourceType, 'discord');
      assert.equal(dto.distribution, 'open_url');
    }
    assert.equal((await f.req(`/api/submissions/${row.id}`, {method:'PATCH', token:a.token, body:{description:'Maintainer edit'}})).status, 200);
    assert.equal(f.store.getEntry(row.id).classification, value);
  }
  assert.equal(f.store.getEntry(row.id).moderation_protected, 1);
  const logs = f.store.listAudit(1).items.filter(x => x.action === 'classification');
  assert.equal(logs.length, 2);
  for (const log of logs) {assert.equal(log.actor_id, IDS.OWNER); assert.ok(log.reason); assert.ok(log.before_json && log.after_json);}
  assert.equal(JSON.parse(logs[0].before_json).classification, 'official');
  assert.equal(JSON.parse(logs[0].after_json).classification, 'community');
});

test('invalid identity, missing reason, ban and audit failure leave governance state untouched', async t => {
  const f = await fixture(t), a = await f.login(), owner = await f.login('OWNER'), row = await create(f, a);
  for (const value of [true, null, {}, 'Official', 'bundled']) assert.equal((await classify(f, owner, row.id, value)).status, 400);
  assert.equal((await classify(f, owner, row.id, 'official', '')).status, 400);
  f.store.setBanned(IDS.OWNER, true);
  assert.equal((await classify(f, owner, row.id, 'official')).status, 403);
  f.store.setBanned(IDS.OWNER, false);
  f.store.db.exec("CREATE TRIGGER fixture_identity_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'rollback'); END");
  assert.equal((await classify(f, owner, row.id, 'official')).status, 500);
  assert.equal(f.store.getEntry(row.id).classification, 'community');
  assert.equal(f.store.getEntry(row.id).moderation_protected, 0);
});

test('in-flight content edit cannot overwrite an Owner promotion or create a false identity audit', async t => {
  let pause = false, release, started;
  const gate = new Promise(r => release = r), ready = new Promise(r => started = r);
  const f = await fixture(t, {beforeInspect:async () => {if (pause) {started(); await gate;}}});
  const a = await f.login(), owner = await f.login('OWNER'), row = await create(f, a);
  pause = true;
  const pending = f.req('/api/submissions/'+row.id, {method:'PATCH', token:a.token,
    body:{sourceUrl:'https://github.com/example/changed', classification:'community'}});
  await ready;
  assert.equal((await classify(f, owner, row.id, 'official')).status, 200);
  release();
  const denied = await pending;
  assert.equal(denied.status, 409);
  assert.equal(denied.data.error.code, 'official_project_identity_mismatch');
  assert.equal(f.store.getEntry(row.id).source_url, row.sourceUrl);
  assert.equal(f.store.getEntry(row.id).classification, 'official');
  assert.equal(f.store.getEntry(row.id).moderation_protected, 1);
  assert.equal(f.store.listAudit(1).items.filter(x => x.action === 'classification').length, 1);
});

test('existing schema-v3 explicit identities survive reopen; absent DTO identity fails closed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'miemie-identity-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const path = join(dir, 'existing.sqlite'), store = openStore(path);
  store.upsertIdentity({id:IDS.A, displayName:'SheepSheep', username:'SheepSheep'}, 1);
  store.insertSubmission({id:'existing', ownerId:IDS.A, input:{...submission(), icon:null}, github:null, time:2});
  assert.equal(store.getEntry('existing').classification, 'community');
  store.setClassification('existing', 'official', 3);
  const before = {...store.getEntry('existing')};
  store.close();
  const reopened = openStore(path);
  try {
    assert.deepEqual({...reopened.getEntry('existing')}, before);
    const legacy = {...before}; delete legacy.classification;
    assert.equal(reopened.entryDTO(legacy).classification, 'community');
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 3);
  } finally {reopened.close();}
});

const patch = (f, actor, id, body) => f.req('/api/submissions/'+id, {method:'PATCH', token:actor.token, body});
const metadata = (changes = {}) => ({owner:'example', repo:'fixture', compatibility:'installable',
  manifest:{id:'example.project-a', repository:'https://github.com/example/fixture', version:'1.0.0', name:'Project A'},
  release:{version:'1.0.0'}, ...changes});

test('official project selectors are locked for submitter, Publisher, Admin and Owner; demote/edit/reaccept works', async t => {
  const f = await fixture(t), owner = await f.login('OWNER');
  for (const who of ['A','ADMIN','OWNER']) {
    const actor = who === 'OWNER' ? owner : await f.login(who);
    f.store.setRole(IDS[who], 'official_publisher', true);
    const row = await create(f, actor);
    assert.equal((await classify(f, owner, row.id, 'official')).status, 200);
    const before = f.store.getEntry(row.id);
    for (const change of [
      {sourceUrl:'https://github.com/example/project-b'},
      {sourceType:'discord', sourceUrl:'https://discord.com/channels/444444444444444444/555555555555555555'},
      {type:'standalone_app'}, {websiteUrl:'https://example.com/other-project'},
    ]) {
      const r = await patch(f, actor, row.id, change);
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.equal(r.data.error.code, 'official_project_identity_mismatch');
      assert.deepEqual(f.store.getEntry(row.id), before);
    }
    for (const key of ['extensionId','repository','manifest']) assert.equal((await patch(f, actor, row.id, {[key]:'forged'})).status, 400);
    assert.equal((await classify(f, owner, row.id, 'community')).status, 200);
    assert.equal((await patch(f, actor, row.id, {sourceUrl:'https://github.com/example/project-b'})).status, 200);
    assert.equal(f.store.getEntry(row.id).classification, 'community');
    assert.equal((await classify(f, owner, row.id, 'official')).status, 200);
    assert.equal(f.store.getEntry(row.id).source_url, 'https://github.com/example/project-b');
    assert.equal(f.store.getEntry(row.id).classification, 'official');
    assert.equal(f.store.getEntry(row.id).submitter_id, IDS[who]);
  }
});

test('promotion requires the project actually shown to Owner, including when an edit commits first', async t => {
  const f = await fixture(t), a = await f.login(), owner = await f.login('OWNER'), row = await create(f, a);
  const shown = (await f.req('/api/admin/submissions', {token:owner.token})).data.items[0];
  assert.ok(shown.projectIdentityKey);
  assert.equal((await patch(f, a, row.id, {sourceUrl:'https://github.com/example/project-b'})).status, 200);
  for (const key of [undefined, shown.projectIdentityKey, 'forged']) {
    const r = await f.req(`/api/admin/submissions/${row.id}/classification`, {method:'POST', token:owner.token,
      body:{classification:'official', projectIdentityKey:key, reason:'Approve displayed project'}});
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'project_changed');
    assert.equal(f.store.getEntry(row.id).classification, 'community');
  }
  assert.equal((await classify(f, owner, row.id, 'official')).status, 200);
  const audit = f.store.listAudit(1).items.find(x => x.action === 'classification');
  assert.equal(JSON.parse(audit.after_json).project.sourceUrl, 'https://github.com/example/project-b');
});

test('PATCH and refresh share checks for manifest ID and canonical repository identity', async t => {
  for (const change of [
    {manifest:{...metadata().manifest, id:'example.project-b'}},
    {manifest:{...metadata().manifest, repository:'https://github.com/example/project-b'}},
    {owner:'another-owner'}, {repo:'project-b'}, {manifest:null},
  ]) await t.test(JSON.stringify(change), async t => {
    let discovered = metadata();
    const f = await fixture(t, {github:{async inspect() {return structuredClone(discovered);}}});
    const a = await f.login(), owner = await f.login('OWNER'), row = await create(f, a);
    assert.equal((await classify(f, owner, row.id, 'official')).status, 200);
    const before = f.store.getEntry(row.id);
    discovered = metadata(change); f.advance(60001);
    assert.equal((await patch(f, a, row.id, {description:'Must not save a different project'})).status, 409);
    assert.deepEqual(f.store.getEntry(row.id), before);
    const refreshed = await f.req('/api/catalog/'+row.id);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.data.extensionId, 'example.project-a');
    assert.equal(refreshed.data.classification, 'official');
    assert.deepEqual(f.store.getEntry(row.id), before);
    const conflicts = f.store.listAudit(1).items.filter(x => x.action === 'project_identity_mismatch');
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].actor_id, 'server-refresh');
    assert.equal(conflicts[0].reason, 'official_project_identity_mismatch');
    assert.ok(conflicts[0].created_at);
    assert.equal(JSON.parse(conflicts[0].before_json).extensionId, 'example.project-a');
    assert.ok(JSON.parse(conflicts[0].after_json).attempted);
    await f.req('/api/catalog/'+row.id);
    assert.equal(f.store.listAudit(1).items.filter(x => x.action === 'project_identity_mismatch').length, 1);
  });
});

test('official refresh accepts version/content updates and equivalent canonical repository spellings', async t => {
  let discovered = metadata();
  const f = await fixture(t, {github:{async inspect() {return structuredClone(discovered);}}});
  const a = await f.login(), owner = await f.login('OWNER'), row = await create(f, a);
  assert.equal((await classify(f, owner, row.id, 'official')).status, 200);
  discovered = metadata({owner:'Example', repo:'Fixture', manifest:{...metadata().manifest,
    repository:'https://github.com/Example/Fixture.git', version:'1.1.0', name:'Updated display name'}, release:{version:'1.1.0'}});
  f.advance(60001);
  const dto = (await f.req('/api/catalog/'+row.id)).data;
  assert.equal(dto.classification, 'official');
  assert.equal(dto.version, '1.1.0');
  assert.equal(dto.github.manifest.name, 'Updated display name');
  assert.equal((await patch(f, a, row.id, {description:'Normal maintenance'})).status, 200);
  assert.equal(f.store.getEntry(row.id).moderation_protected, 1);
  assert.equal(f.store.listAudit(1).items.some(x => x.action === 'project_identity_mismatch'), false);
});

test('refresh rechecks latest promotion and stale cache cannot overwrite a later project edit', async t => {
  let pause = false, release, started;
  const gate = new Promise(r => release = r), ready = new Promise(r => started = r);
  const f = await fixture(t, {github:{async inspect() {
    if (pause) {started(); await gate; return metadata({manifest:{...metadata().manifest, id:'example.project-b'}});}
    return metadata();
  }}});
  const a = await f.login(), owner = await f.login('OWNER'), row = await create(f, a);
  const stale = f.store.getEntry(row.id);
  pause = true; f.advance(60001);
  const pending = f.req('/api/catalog/'+row.id);
  await ready;
  assert.equal((await classify(f, owner, row.id, 'official')).status, 200);
  release();
  const response = await pending;
  assert.equal(response.data.classification, 'official');
  assert.equal(response.data.extensionId, 'example.project-a');
  assert.equal(f.store.getEntry(row.id).github_json, stale.github_json);
  assert.equal((await classify(f, owner, row.id, 'community')).status, 200);
  pause = false;
  assert.equal((await patch(f, a, row.id, {sourceUrl:'https://github.com/example/different'})).status, 200);
  const edited = f.store.getEntry(row.id);
  assert.equal(f.store.refreshGithub(stale, metadata()).changes, 0);
  assert.deepEqual(f.store.getEntry(row.id), edited);
});

test('ordinary in-flight content edit preserves promotion, protection, hold and moderation', async t => {
  let pause = false, release, started;
  const gate = new Promise(r => release = r), ready = new Promise(r => started = r);
  const f = await fixture(t, {beforeInspect:async () => {if (pause) {started(); await gate;}}});
  const a = await f.login(), owner = await f.login('OWNER'), row = await create(f, a);
  pause = true; f.advance(60001);
  const pending = patch(f, a, row.id, {description:'Ordinary content edit'});
  await ready;
  assert.equal((await classify(f, owner, row.id, 'official')).status, 200);
  for (const [kind, body] of [['security-hold',{enabled:true}],['moderation',{action:'hide'}]]) {
    assert.equal((await f.req(`/api/admin/submissions/${row.id}/${kind}`, {method:'POST', token:owner.token, body:{...body, reason:'During edit'}})).status, 200);
  }
  release();
  assert.equal((await pending).status, 200);
  const saved = f.store.getEntry(row.id);
  assert.equal(saved.description, 'Ordinary content edit');
  assert.equal(saved.classification, 'official');
  assert.equal(saved.moderation_protected, 1);
  assert.equal(saved.security_hold, 1);
  assert.equal(saved.moderation, 'hidden');
});

test('invalid persisted classification is community throughout store, Catalog, edits, Admin and governance', async t => {
  const f = await fixture(t), a = await f.login(), admin = await f.login('ADMIN'), owner = await f.login('OWNER');
  const row = await create(f, a);
  for (const invalid of ['official123','banana','','Official']) {
    f.store.db.prepare('UPDATE submissions SET classification=?,moderation_protected=0 WHERE id=?').run(invalid,row.id);
    assert.equal(f.store.getEntry(row.id).classification, 'community');
    for (const [path, token] of [['/api/catalog',null],['/api/submissions',a.token],['/api/admin/submissions',admin.token]]) {
      const response = await f.req(path, {token});
      assert.equal(response.status, 200);
      assert.equal(response.data.items.find(x => x.id === row.id).classification, 'community');
    }
    assert.equal((await f.req('/api/catalog/'+row.id)).data.classification, 'community');
    assert.equal((await patch(f, a, row.id, {description:'Editing legacy record'})).status, 200);
    assert.equal(f.store.getEntry(row.id).classification, 'community');
    // Read normalization does not silently mutate persisted governance history.
    assert.equal(f.store.db.prepare('SELECT classification FROM submissions WHERE id=?').get(row.id).classification, invalid);
    const moderate = action => f.req(`/api/admin/submissions/${row.id}/moderation`, {method:'POST', token:admin.token, body:{action,reason:'Legacy community moderation'}});
    assert.equal((await moderate('hide')).status, 200);
    assert.equal((await moderate('restore')).status, 200);
    assert.equal((await classify(f, owner, row.id, 'community')).status, 200);
    f.store.db.prepare('UPDATE submissions SET classification=? WHERE id=?').run(invalid,row.id);
    assert.equal((await classify(f, owner, row.id, 'official')).status, 200);
    assert.equal(f.store.getEntry(row.id).moderation_protected, 1);
    assert.equal((await classify(f, owner, row.id, 'community')).status, 200);
    assert.equal((await moderate('hide')).status, 403);
  }
});

test('client invalid classification remains rejected on creation, editing and governance', async t => {
  const f = await fixture(t), a = await f.login(), owner = await f.login('OWNER'), row = await create(f, a);
  for (const value of ['official123','banana','null','',null,true,{},[]]) {
    f.advance(600001);
    const post = await f.req('/api/submissions', {method:'POST', token:a.token, body:submission({classification:value})});
    assert.equal(post.status, 400);
    assert.equal(post.data.error.code, 'invalid_classification');
    assert.equal((await patch(f, a, row.id, {classification:value})).status, 400);
    assert.equal((await classify(f, owner, row.id, value)).status, 400);
    assert.equal(f.store.getEntry(row.id).classification, 'community');
  }
});

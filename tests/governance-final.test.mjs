import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, submission, IDS} from './helpers.mjs';

const create = async (f, actor, overrides = {}) => {
  const result = await f.req('/api/submissions', {method:'POST', token:actor.token, body:submission(overrides)});
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
};
const govern = (f, actor, path, body) => f.req('/api/admin/' + path, {
  method:'POST', token:actor.token, body:{reason:'Development Fixture final acceptance', ...body},
});

test('author classification downgrade cannot clear Owner moderation protection', async t => {
  const f = await fixture(t), author = await f.login(), owner = await f.login('OWNER'), admin = await f.login('ADMIN');
  await govern(f, owner, `identities/${IDS.A}/roles`, {role:'official_publisher', enabled:true});
  const row = await create(f, author, {classification:'official'});
  await govern(f, owner, `submissions/${row.id}/protection`, {enabled:true});
  const edited = await f.req(`/api/submissions/${row.id}`, {method:'PATCH', token:author.token, body:{classification:'community'}});
  assert.equal(edited.status, 200);
  assert.equal(f.store.getEntry(row.id).moderation_protected, 1, 'author edit must preserve Owner protection');
  assert.equal((await govern(f, admin, `submissions/${row.id}/moderation`, {action:'hide'})).status, 403);
  assert.equal((await govern(f, owner, `submissions/${row.id}/protection`, {enabled:false})).status, 200);
  assert.equal((await govern(f, admin, `submissions/${row.id}/moderation`, {action:'hide'})).status, 200);
});

test('classification edits preserve the latest Owner protection and hold during source validation', async t => {
  let pause = false, release, started;
  const gate = new Promise(resolve => release = resolve), ready = new Promise(resolve => started = resolve);
  const f = await fixture(t, {beforeInspect:async () => {if (pause) {started(); await gate;}}});
  const author = await f.login(), owner = await f.login('OWNER');
  await govern(f, owner, `identities/${IDS.A}/roles`, {role:'official_publisher', enabled:true});
  const row = await create(f, author, {classification:'official'});
  await govern(f, owner, `submissions/${row.id}/protection`, {enabled:false});
  pause = true;
  const pending = f.req(`/api/submissions/${row.id}`, {method:'PATCH', token:author.token,
    body:{classification:'community', sourceUrl:'https://github.com/example/revalidated'}});
  await ready;
  await govern(f, owner, `submissions/${row.id}/protection`, {enabled:true});
  await govern(f, owner, `submissions/${row.id}/security-hold`, {enabled:true});
  release();
  assert.equal((await pending).status, 200);
  const saved = f.store.getEntry(row.id);
  assert.equal(saved.moderation_protected, 1);
  assert.equal(saved.security_hold, 1);
  assert.equal(saved.owner_id, IDS.A);
  assert.equal(saved.submitter_id, IDS.A);
  const change = f.store.listAudit(1).items.find(record => record.action === 'classification');
  assert.equal(JSON.parse(change.before_json).protected, true);
  assert.equal(JSON.parse(change.before_json).securityHold, true);
  assert.equal(JSON.parse(change.after_json).protected, true);
});

test('Owner root remains exact Snowflake identity after profile and role changes', async t => {
  const f = await fixture(t);
  f.profiles.OWNER.displayName = 'Renamed Owner';
  f.profiles.OWNER.username = 'renamed_owner';
  f.profiles.A.displayName = 'Renamed Owner';
  f.profiles.A.username = 'renamed_owner';
  f.store.setRole(IDS.OWNER, 'admin', false);
  f.store.setRole(IDS.OWNER, 'official_publisher', false);
  const owner = await f.login('OWNER'), impostor = await f.login();
  assert.equal(owner.isOwner, true);
  assert.equal(owner.isAdmin, true);
  assert.equal(owner.canPublishOfficial, true);
  assert.equal(impostor.isOwner, false);
  assert.equal(impostor.isAdmin, false);
  for (const actor of [owner, impostor]) {
    const r = await f.req('/api/me', {token:actor.token});
    for (const id of Object.values(IDS)) assert.ok(!JSON.stringify(r.data).includes(id));
  }
});

test('normal and publisher direct APIs cannot moderate, ban, grant or spoof ownership', async t => {
  const f = await fixture(t), a = await f.login(), b = await f.login('B'), owner = await f.login('OWNER');
  const row = await create(f, b);
  for (const publisher of [false, true]) {
    if (publisher) await govern(f, owner, `identities/${IDS.A}/roles`, {role:'official_publisher', enabled:true});
    for (const [path, body] of [
      [`submissions/${row.id}/moderation`, {action:'hide'}],
      [`identities/${IDS.B}/ban`, {banned:true}],
      [`identities/${IDS.B}/ban`, {banned:false}],
      [`identities/${IDS.B}/roles`, {role:'admin', enabled:true}],
      [`identities/${IDS.B}/roles`, {role:'official_publisher', enabled:false}],
    ]) assert.equal((await govern(f, a, path, body)).status, 403);
    assert.equal((await f.req(`/api/submissions/${row.id}`, {method:'PATCH', token:a.token, body:{name:'stolen'}})).status, 404);
    assert.equal((await f.req(`/api/submissions/${row.id}/status`, {method:'POST', token:a.token, body:{status:'unlisted'}})).status, 404);
  }
  const own = await create(f, a);
  for (const field of ['id','owner_id','submitter_id','ownerDiscordUserId','submitterDiscordUserId']) {
    assert.equal((await f.req(`/api/submissions/${own.id}`, {method:'PATCH', token:a.token, body:{[field]:IDS.B}})).status, 400);
  }
  assert.equal(f.store.getEntry(own.id).owner_id, IDS.A);
});

test('Owner role grant/revoke, ban/unban, protection and hold have complete credential-free audit', async t => {
  const f = await fixture(t), a = await f.login(), owner = await f.login('OWNER'), row = await create(f, a);
  for (const role of ['admin','official_publisher']) for (const enabled of [true,false]) {
    assert.equal((await govern(f, owner, `identities/${IDS.A}/roles`, {role,enabled})).status, 200);
    const me = (await f.req('/api/me', {token:a.token})).data;
    assert.equal(role === 'admin' ? me.isAdmin : me.canPublishOfficial, enabled);
  }
  for (const banned of [true,false]) assert.equal((await govern(f, owner, `identities/${IDS.A}/ban`, {banned})).status, 200);
  for (const action of ['hide','restore']) await govern(f, owner, `submissions/${row.id}/moderation`, {action});
  for (const kind of ['protection','security-hold']) for (const enabled of [true,false]) await govern(f, owner, `submissions/${row.id}/${kind}`, {enabled});
  const response = await f.req('/api/admin/audit', {token:owner.token});
  assert.equal(response.status, 200);
  const actions = ['grant_admin','revoke_admin','grant_official_publisher','revoke_official_publisher','ban','unban','hide','restore','protection','security-hold'];
  for (const action of actions) {
    const records = response.data.items.filter(record => record.action === action && record.actor_id !== 'server-bootstrap');
    assert.ok(records.length, action);
    for (const record of records) {
      assert.equal(record.actor_id, IDS.OWNER);
      assert.ok([row.id, IDS.A].includes(record.target_id));
      assert.ok(record.reason && record.created_at && record.before_json && record.after_json);
    }
  }
  const serialized = JSON.stringify(response.data);
  for (const secret of [f.config.clientSecret,f.config.sessionSecret,a.token,owner.token,'test-only-discord-access']) assert.ok(!serialized.includes(secret));
});

test('ban arriving during asynchronous submission validation prevents the write', async t => {
  let release, started;
  const gate = new Promise(resolve => release = resolve), ready = new Promise(resolve => started = resolve);
  const f = await fixture(t, {beforeInspect:async () => {started(); await gate;}}), a = await f.login(), owner = await f.login('OWNER');
  const pending = f.req('/api/submissions', {method:'POST', token:a.token, body:submission()});
  await ready;
  await govern(f, owner, `identities/${IDS.A}/ban`, {banned:true});
  release();
  assert.equal((await pending).status, 403);
  assert.equal(f.store.countOwn(IDS.A), 0);
  assert.equal((await f.req('/api/catalog')).status, 200);
});

test('audit insert failure rolls back governance state with the same SQLite transaction', async t => {
  const f = await fixture(t), author = await f.login(), owner = await f.login('OWNER'), row = await create(f, author);
  f.store.db.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
  assert.equal((await govern(f, owner, `submissions/${row.id}/moderation`, {action:'hide'})).status, 500);
  assert.equal(f.store.getEntry(row.id).moderation, 'visible');
  assert.equal((await govern(f, owner, `identities/${IDS.A}/ban`, {banned:true})).status, 500);
  assert.equal(f.store.getIdentity(IDS.A).banned, 0);
  assert.equal((await govern(f, owner, `identities/${IDS.A}/roles`, {role:'admin', enabled:true})).status, 500);
  assert.deepEqual(f.store.rolesFor(IDS.A), []);
});

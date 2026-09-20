// SPDX-License-Identifier: GPL-3.0-or-later
// Development Fixture / Test Data: fake application values, no external OAuth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { backupDatabase } from '../tools/sqlite-backup.mjs';
const root = new URL('../', import.meta.url).pathname;
const production = { NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://registry.miemie-fixture.org', CORS_ORIGINS: 'http://127.0.0.1:8000', DISCORD_CLIENT_ID: '000000000000000001', DISCORD_CLIENT_SECRET: 'development-fixture-not-a-real-client-secret', SESSION_SECRET: 'development-fixture-not-a-real-session-secret' };
async function folder(t) { const path = await mkdtemp(join(tmpdir(), 'miemie-deploy-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
async function run(file, env) {
  const child = spawn(process.execPath, [file], { cwd: root, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore','pipe','pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  const [code, signal] = await once(child, 'close'); return { code, signal, stdout, stderr };
}
test('production requires explicit HTTPS, CORS, OAuth configuration and private session secret', () => {
  for (const key of ['PUBLIC_BASE_URL','CORS_ORIGINS','DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET','SESSION_SECRET']) assert.throws(() => loadConfig({ ...production, [key]: '' }), key);
  for (const url of ['http://localhost:8787','https://registry.example.org','https://registry.example.org.','https://registry.test','https://registry.invalid','https://registry.local','https://127.0.0.1','https://[::1]','https://192.168.1.2','https://registry']) assert.throws(() => loadConfig({ ...production, PUBLIC_BASE_URL: url }));
  for (const origin of ['*','null',',,,','https://tavern.miemie-fixture.org/path']) assert.throws(() => loadConfig({ ...production, CORS_ORIGINS: origin }));
  assert.throws(() => loadConfig({ ...production, SESSION_SECRET: ' '.repeat(64) }));
  assert.throws(() => loadConfig({ ...production, DISCORD_REDIRECT_URI: 'https://another.miemie-fixture.org/api/auth/callback' }));
  assert.throws(() => loadConfig({ ...production, DATABASE_PATH: ':memory:' }));
  assert.throws(() => loadConfig({ NODE_ENV: 'prod' }));
});
test('production supports exact local Tavern origins and privately configured admin identity only', async () => {
  const config = loadConfig(production);
  assert.equal(config.production, true); assert.equal(config.redirectUri, `${production.PUBLIC_BASE_URL}/api/auth/callback`);
  assert.deepEqual([...config.adminIds], []); assert.equal(config.allowedOrigins.has('http://127.0.0.1:8000'), true);
  assert.equal(config.allowedOrigins.has('http://localhost:8000'), false);
  assert.equal(loadConfig({ ...production, MIEMIE_ADMIN_DISCORD_IDS: '000000000000000009' }).adminIds.has('000000000000000009'), true);
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /^MIEMIE_ADMIN_DISCORD_IDS=$/m); assert.match(example, /^DISCORD_CLIENT_SECRET=$/m);
});
test('development public catalog can run without invented Discord credentials', () => {
  const config = loadConfig({}); assert.equal(config.production, false); assert.equal(config.clientId, ''); assert.equal(config.clientSecret, '');
  assert.equal(config.publicBaseUrl, 'http://127.0.0.1:8787'); assert.ok(config.sessionSecret.length >= 32);
});
test('production OAuth flow cookie is HttpOnly Secure SameSite=Lax and uses only identify guilds', async t => {
  const config = loadConfig(production), store = openStore(':memory:'), app = createApp({ config, store });
  const server = createServer(app.handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const start = await fetch(`${base}/api/auth/start`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:8000', 'Content-Type': 'application/json' }, body: JSON.stringify({ returnOrigin: 'http://127.0.0.1:8000', codeChallenge: 'x'.repeat(43) }) });
  assert.equal(start.status, 200); const flow = await start.json();
  const authorizeUrl = new URL(flow.authorizationUrl); // Server returns public Origin, local test maps it to listener.
  const response = await fetch(`${base}${authorizeUrl.pathname}${authorizeUrl.search}`, { redirect: 'manual' });
  assert.equal(response.status, 302); assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Secure/);
  const discord = new URL(response.headers.get('location')); assert.equal(discord.origin, 'https://discord.com'); assert.equal(discord.searchParams.get('scope'), 'identify guilds');
  assert.equal(JSON.stringify(flow).includes(config.clientSecret), false); assert.equal(response.headers.get('set-cookie').includes(config.sessionSecret), false);
});
test('backup reads committed WAL data without changing or migrating the source schema', async t => {
  const dir = await folder(t), source = join(dir, 'legacy.sqlite'), db = new DatabaseSync(source);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'committed private fixture\')');
  try {
    const destination = await backupDatabase(source, join(dir, 'backups'));
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try { assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 1); assert.equal(snapshot.prepare('SELECT value FROM fixture').get().value, 'committed private fixture'); } finally { snapshot.close(); }
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'backups'))).mode & 0o777, 0o700);
  } finally { db.close(); }
});
test('backup of absent database fails without creating a new empty source or requiring OAuth', async t => {
  const dir = await folder(t), source = join(dir, 'absent.sqlite');
  await assert.rejects(backupDatabase(source, join(dir, 'backups'))); await assert.rejects(access(source));
  await assert.rejects(backupDatabase(':memory:', join(dir, 'backups')));
  const db = new DatabaseSync(join(dir, 'source.sqlite')); db.exec('CREATE TABLE fixture(value TEXT)'); db.close();
  const result = await run('tools/backup.mjs', { NODE_ENV: 'production', DATABASE_PATH: join(dir, 'source.sqlite'), BACKUP_DIRECTORY: join(dir, 'backups') });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Consistent SQLite backup created/);
});
test('real server boots, migrates persistent data, passes healthcheck, and stops cleanly', async t => {
  const dir = await folder(t), databasePath = join(dir, 'data', 'registry.sqlite');
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0,'127.0.0.1',resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const env = { PATH: process.env.PATH, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, DATABASE_PATH: databasePath };
  async function start() {
    const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore','pipe','pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    const closed = once(child, 'close');
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('Server did not listen')), 8000);
      child.stdout.on('data', chunk => { if (String(chunk).includes('listening at')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); if (code !== null) reject(new Error(`Server exited ${code}`)); });
    });
    return { child, closed };
  }
  const first = await start();
  assert.equal((await run('tools/healthcheck.mjs', { PORT: String(port) })).code, 0);
  const health = await (await fetch(`${env.PUBLIC_BASE_URL}/health`)).json(); const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(health.version, pkg.version); assert.equal(health.status, 'ok');
  const store = openStore(databasePath); store.upsertIdentity({ id: '000000000000000002', displayName: 'Persistent fixture', username: 'fixture' }, 1); store.close();
  first.child.kill('SIGTERM'); assert.deepEqual(await first.closed, [0, null]);
  const second = await start(); const reopened = openStore(databasePath);
  try { assert.equal(reopened.getIdentity('000000000000000002').display_name, 'Persistent fixture'); } finally { reopened.close(); }
  second.child.kill('SIGTERM'); assert.deepEqual(await second.closed, [0, null]);
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
});
test('health probe fails closed on dead listener without revealing configuration', async () => {
  const result = await run('tools/healthcheck.mjs', { PORT: '0', SESSION_SECRET: 'private-fixture-value' });
  assert.equal(result.code, 1); assert.match(result.stderr, /Registry health check failed/); assert.equal(result.stderr.includes('private-fixture-value'), false);
});

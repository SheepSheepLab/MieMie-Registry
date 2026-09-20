// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 SheepSheep
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const schema = db.prepare('PRAGMA user_version').get().user_version;
  if (schema > 2) throw new Error('数据库版本高于当前程序；请使用较新程序');
  if (schema === 0) db.exec(`BEGIN;
    CREATE TABLE identities (discord_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, username TEXT NOT NULL, avatar_key TEXT, profile_updated_at INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE avatars (key TEXT PRIMARY KEY, bytes BLOB NOT NULL, mime TEXT NOT NULL);
    CREATE TABLE sessions (hash TEXT PRIMARY KEY, discord_id TEXT NOT NULL REFERENCES identities(discord_id), origin TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE submissions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES identities(discord_id), name TEXT NOT NULL, description TEXT NOT NULL, author TEXT NOT NULL, source_type TEXT NOT NULL, source_url TEXT NOT NULL, icon TEXT, tags_json TEXT NOT NULL, github_json TEXT, owner_status TEXT NOT NULL DEFAULT 'listed', moderation TEXT NOT NULL DEFAULT 'visible', moderation_reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(source_url));
    CREATE TABLE audit (id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX submissions_owner ON submissions(owner_id);
    CREATE INDEX sessions_expiry ON sessions(expires_at);
    PRAGMA user_version=1;
    COMMIT;`);
  // Transactional v1 -> v2 migration preserves existing records while making source
  // uniqueness owner-scoped: a duplicate error must not reveal a private Catalog row.
  if (schema < 2) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE submissions RENAME TO submissions_v1;
    CREATE TABLE submissions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES identities(discord_id), name TEXT NOT NULL, description TEXT NOT NULL, author TEXT NOT NULL, source_type TEXT NOT NULL, source_url TEXT NOT NULL, icon TEXT, tags_json TEXT NOT NULL, github_json TEXT, owner_status TEXT NOT NULL DEFAULT 'listed', moderation TEXT NOT NULL DEFAULT 'visible', moderation_reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','discord_guild')), visibility_guild_id TEXT, visibility_source_url TEXT, discord_json TEXT, UNIQUE(owner_id,source_url), CHECK((visibility='public' AND visibility_guild_id IS NULL AND visibility_source_url IS NULL) OR (visibility='discord_guild' AND visibility_guild_id IS NOT NULL AND visibility_source_url IS NOT NULL)));
    INSERT INTO submissions(id,owner_id,name,description,author,source_type,source_url,icon,tags_json,github_json,owner_status,moderation,moderation_reason,created_at,updated_at) SELECT id,owner_id,name,description,author,source_type,source_url,icon,tags_json,github_json,owner_status,moderation,moderation_reason,created_at,updated_at FROM submissions_v1;
    DROP TABLE submissions_v1;
    CREATE INDEX submissions_owner ON submissions(owner_id);
    CREATE INDEX submissions_visibility ON submissions(visibility,visibility_guild_id);
    PRAGMA user_version=2;
    COMMIT;`);
  const getIdentity = id => db.prepare('SELECT * FROM identities WHERE discord_id=?').get(id);
  function upsertIdentity(profile, now) {
    const existing = getIdentity(profile.id);
    const avatarKey = profile.avatarBytes ? randomUUID() : null;
    db.exec('BEGIN');
    try {
      if (avatarKey) db.prepare('INSERT INTO avatars VALUES (?, ?, ?)').run(avatarKey, profile.avatarBytes, 'image/png');
      db.prepare(`INSERT INTO identities(discord_id,display_name,username,avatar_key,profile_updated_at) VALUES(?,?,?,?,?) ON CONFLICT(discord_id) DO UPDATE SET display_name=excluded.display_name,username=excluded.username,avatar_key=excluded.avatar_key,profile_updated_at=excluded.profile_updated_at`).run(profile.id, profile.displayName, profile.username, avatarKey, now);
      if (existing?.avatar_key) db.prepare('DELETE FROM avatars WHERE key=?').run(existing.avatar_key);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return getIdentity(profile.id);
  }
  function profileDTO(identity) { return { displayName: identity.display_name, avatarUrl: identity.avatar_key ? `/api/avatars/${identity.avatar_key}` : null }; }
  function entryDTO(row, privateView = false) {
    const github = row.github_json ? JSON.parse(row.github_json) : null;
    const dto = { id: row.id, visibility: row.visibility, extensionId: github?.manifest?.id || null, name: row.name, description: row.description, author: row.author, submitter: profileDTO(getIdentity(row.owner_id)), sourceType: row.source_type, sourceUrl: row.source_url, icon: github?.manifest?.iconUrl || row.icon || null, tags: JSON.parse(row.tags_json), version: github?.release?.version || null, github, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
    if (privateView) Object.assign(dto, { status: row.owner_status, moderation: row.moderation, moderationReason: row.moderation_reason, visibilitySourceUrl: row.visibility_source_url });
    return dto;
  }
  function audit(actor, action, target, reason, now) { db.prepare('INSERT INTO audit(actor_id,action,target_id,reason,created_at) VALUES(?,?,?,?,?)').run(actor, action, target, reason, now); }
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } }
  // Keep SQL behind this repository boundary; handlers use domain operations.
  const sessionByHash = (hash, time) => db.prepare('SELECT * FROM sessions WHERE hash=? AND expires_at>?').get(hash,time);
  const createSession = (hash,id,origin,expiresAt) => db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash,id,origin,expiresAt);
  const deleteSession = hash => db.prepare('DELETE FROM sessions WHERE hash=?').run(hash);
  const expireSessions = time => db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(time);
  const getEntry = id => db.prepare('SELECT * FROM submissions WHERE id=?').get(id);
  const sourceDuplicate = (url, ownerId, except='') => db.prepare('SELECT id FROM submissions WHERE source_url=? AND owner_id=? AND id<>?').get(url,ownerId,except);
  const countOwn = id => db.prepare('SELECT count(*) AS n FROM submissions WHERE owner_id=?').get(id).n;
  const listOwn = id => db.prepare('SELECT * FROM submissions WHERE owner_id=? ORDER BY created_at DESC,id').all(id);
  const getAvatar = key => db.prepare('SELECT bytes,mime FROM avatars WHERE key=?').get(key);
  function listCatalog({page,pageSize,source,q,guildIds=[]}) {
    const params=[]; let where="owner_status='listed' AND moderation='visible'";
    where += " AND (visibility='public'";
    if (guildIds.length) { where += ` OR (visibility='discord_guild' AND visibility_guild_id IN (${guildIds.map(()=>'?').join(',')}))`; params.push(...guildIds); }
    where += ')';
    if(source){where+=' AND source_type=?';params.push(source);}
    if(q){where+=' AND (instr(lower(name),lower(?))>0 OR instr(lower(description),lower(?))>0 OR instr(lower(author),lower(?))>0)';params.push(q,q,q);}
    const total=db.prepare(`SELECT count(*) AS n FROM submissions WHERE ${where}`).get(...params).n;
    const rows=db.prepare(`SELECT * FROM submissions WHERE ${where} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`).all(...params,pageSize,(page-1)*pageSize);
    return {rows,total};
  }
  function insertSubmission({id,ownerId,input,github,time}) {
    db.prepare('INSERT INTO submissions(id,owner_id,name,description,author,source_type,source_url,icon,tags_json,github_json,created_at,updated_at,visibility,visibility_guild_id,visibility_source_url,discord_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,ownerId,input.name,input.description,input.author,input.sourceType,input.sourceUrl,input.icon,JSON.stringify(input.tags),github?JSON.stringify(github):null,time,time,input.visibility||'public',input.visibilityGuildId||null,input.visibilitySourceUrl||null,input.discord?JSON.stringify(input.discord):null);
  }
  function updateSubmission({id,input,github,time}) {
    db.prepare('UPDATE submissions SET name=?,description=?,author=?,source_type=?,source_url=?,icon=?,tags_json=?,github_json=?,updated_at=?,visibility=?,visibility_guild_id=?,visibility_source_url=?,discord_json=? WHERE id=?').run(input.name,input.description,input.author,input.sourceType,input.sourceUrl,input.icon,JSON.stringify(input.tags),github?JSON.stringify(github):null,time,input.visibility,input.visibilityGuildId,input.visibilitySourceUrl,input.discord?JSON.stringify(input.discord):null,id);
  }
  const setOwnerStatus=(id,status,time)=>db.prepare('UPDATE submissions SET owner_status=?,updated_at=? WHERE id=?').run(status,time,id);
  function listAdmin(page) { return {total:db.prepare('SELECT count(*) AS n FROM submissions').get().n,rows:db.prepare('SELECT * FROM submissions ORDER BY created_at DESC,id LIMIT 50 OFFSET ?').all((page-1)*50)}; }
  const setModeration=(id,status,reason,time)=>db.prepare('UPDATE submissions SET moderation=?,moderation_reason=?,updated_at=? WHERE id=?').run(status,reason,time,id);
  const setBanned=(id,banned)=>db.prepare('UPDATE identities SET banned=? WHERE discord_id=?').run(banned?1:0,id);
  return { db, getIdentity, upsertIdentity, profileDTO, entryDTO, audit, transaction,sessionByHash,createSession,deleteSession,expireSessions,getEntry,sourceDuplicate,countOwn,listOwn,getAvatar,listCatalog,insertSubmission,updateSubmission,setOwnerStatus,listAdmin,setModeration,setBanned,close:()=>db.close(),backup:destination=>backup(db,destination) };
}

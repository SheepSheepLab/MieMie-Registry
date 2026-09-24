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
  try {
  const schema = db.prepare('PRAGMA user_version').get().user_version;
  if (schema > 3) throw new Error('数据库版本高于当前程序；请使用较新程序');
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
  // Additive, atomic v3: old business/ACL/source columns are preserved verbatim.
  if (schema < 3) db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE submissions ADD COLUMN submitter_id TEXT;
    UPDATE submissions SET submitter_id=owner_id;
    ALTER TABLE submissions ADD COLUMN classification TEXT NOT NULL DEFAULT 'community';
    ALTER TABLE submissions ADD COLUMN moderation_protected INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE submissions ADD COLUMN security_hold INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE submissions ADD COLUMN product_type TEXT NOT NULL DEFAULT 'tavern_extension';
    ALTER TABLE submissions ADD COLUMN distribution TEXT NOT NULL DEFAULT 'external_release';
    ALTER TABLE submissions ADD COLUMN platforms_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE submissions ADD COLUMN website_url TEXT;
    ALTER TABLE submissions ADD COLUMN unlisted_at INTEGER;
    ALTER TABLE submissions ADD COLUMN purge_after INTEGER;
    UPDATE submissions SET distribution='open_url' WHERE source_type='discord';
    UPDATE submissions SET distribution='managed_install' WHERE source_type='github' AND json_valid(github_json) AND json_extract(github_json,'$.compatibility')='installable';
    UPDATE submissions SET unlisted_at=MAX(updated_at, CAST(strftime('%s','now') AS INTEGER)*1000), purge_after=MAX(updated_at, CAST(strftime('%s','now') AS INTEGER)*1000)+15552000000 WHERE owner_status='unlisted';
    ALTER TABLE audit ADD COLUMN before_json TEXT;
    ALTER TABLE audit ADD COLUMN after_json TEXT;
    CREATE TABLE roles(discord_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','official_publisher')), PRIMARY KEY(discord_id,role));
    CREATE TABLE governance_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE INDEX submissions_retention ON submissions(purge_after,security_hold);
    PRAGMA user_version=3;
    COMMIT;`);
  } catch(error) {try {db.exec('ROLLBACK');} catch {} db.close();throw error;}
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
    const dto = { id: row.id, visibility: row.visibility, extensionId: github?.manifest?.id || null, name: row.name, description: row.description, author: row.author, classification: row.classification, type: row.product_type, distribution: row.distribution, platforms: JSON.parse(row.platforms_json), websiteUrl: row.website_url, submitter: profileDTO(getIdentity(row.submitter_id)), sourceType: row.source_type, sourceUrl: row.source_url, icon: github?.manifest?.iconUrl || row.icon || null, tags: JSON.parse(row.tags_json), version: github?.release?.version || null, github, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
    if (privateView) Object.assign(dto, { status: row.owner_status, moderation: row.moderation, moderationReason: row.moderation_reason, visibilitySourceUrl: row.visibility_source_url, moderationProtected: !!row.moderation_protected, unlistedAt: row.unlisted_at, purgeAfter: row.purge_after });
    return dto;
  }
  function audit(actor, action, target, reason, now, before = null, after = null) { db.prepare('INSERT INTO audit(actor_id,action,target_id,reason,created_at,before_json,after_json) VALUES(?,?,?,?,?,?,?)').run(actor, action, target, reason, now, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)); }
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
    db.prepare('UPDATE submissions SET submitter_id=?,classification=?,moderation_protected=? WHERE id=?').run(ownerId,input.classification||'community',input.classification==='official'?1:0,id);
    setProduct(id,input);
  }
  function updateSubmission({id,input,github,time}) {
    db.prepare('UPDATE submissions SET name=?,description=?,author=?,source_type=?,source_url=?,icon=?,tags_json=?,github_json=?,updated_at=?,visibility=?,visibility_guild_id=?,visibility_source_url=?,discord_json=? WHERE id=?').run(input.name,input.description,input.author,input.sourceType,input.sourceUrl,input.icon,JSON.stringify(input.tags),github?JSON.stringify(github):null,time,input.visibility,input.visibilityGuildId,input.visibilitySourceUrl,input.discord?JSON.stringify(input.discord):null,id);
    setProduct(id,input);
  }
  function setProduct(id,input) {
    db.prepare('UPDATE submissions SET product_type=?,distribution=?,platforms_json=?,website_url=? WHERE id=?').run(input.type||'tavern_extension',input.distribution||(input.sourceType==='discord'?'open_url':'external_release'),JSON.stringify(input.platforms||[]),input.websiteUrl||null,id);
    const current=getEntry(id);
    // Publishing Official enables protection by default. Returning to Community
    // must not revoke a governance decision: only the Owner protection endpoint
    // may remove protection (including protection set while validation awaited).
    if (input.classification && input.classification !== current.classification) db.prepare('UPDATE submissions SET classification=?,moderation_protected=? WHERE id=?').run(input.classification,input.classification==='official'?1:current.moderation_protected,id);
  }
  // Cache refresh must never overwrite edits, ownership, ACL or moderation.
  const refreshGithub = (row, github) => db.prepare("UPDATE submissions SET github_json=? WHERE id=? AND source_type='github' AND source_url=? AND github_json IS ?").run(JSON.stringify(github),row.id,row.source_url,row.github_json);
  const setOwnerStatus=(id,status,time)=>db.prepare("UPDATE submissions SET owner_status=?,updated_at=?,unlisted_at=CASE WHEN ?='listed' THEN NULL ELSE COALESCE(unlisted_at,?) END,purge_after=CASE WHEN ?='listed' THEN NULL ELSE COALESCE(purge_after,?) END WHERE id=?").run(status,time,status,time,status,time+180*86400000,id);
  function listAdmin(page, owner=false) {
    const where=owner?'1=1':"classification='community' AND moderation_protected=0";
    return {total:db.prepare(`SELECT count(*) AS n FROM submissions WHERE ${where}`).get().n, rows:db.prepare(`SELECT * FROM submissions WHERE ${where} ORDER BY created_at DESC,id LIMIT 50 OFFSET ?`).all((page-1)*50)};
  }
  const rolesFor=id=>db.prepare('SELECT role FROM roles WHERE discord_id=?').all(id).map(r=>r.role);
  const setRole=(id,role,enabled)=>enabled?db.prepare('INSERT OR IGNORE INTO roles VALUES(?,?)').run(id,role):db.prepare('DELETE FROM roles WHERE discord_id=? AND role=?').run(id,role);
  function bootstrapAdmins(ids,time) {
    if(db.prepare("SELECT 1 FROM governance_settings WHERE key='legacy_admins_imported'").get())return;
    transaction(()=>{for(const id of ids){setRole(id,'admin',true);audit('server-bootstrap','grant_admin',id,'one-time legacy allowlist import',time,null,{role:'admin'});}db.prepare("INSERT INTO governance_settings VALUES('legacy_admins_imported','1')").run();});
  }
  const listIdentities=page=>({items:db.prepare('SELECT discord_id,display_name,banned FROM identities ORDER BY discord_id LIMIT 50 OFFSET ?').all((page-1)*50).map(u=>({...u,roles:rolesFor(u.discord_id)})),total:db.prepare('SELECT count(*) AS n FROM identities').get().n});
  const listAudit=page=>({items:db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 50 OFFSET ?').all((page-1)*50),total:db.prepare('SELECT count(*) AS n FROM audit').get().n});
  const setProtection=(id,value)=>db.prepare('UPDATE submissions SET moderation_protected=? WHERE id=?').run(value?1:0,id);
  const setHold=(id,value)=>db.prepare('UPDATE submissions SET security_hold=? WHERE id=?').run(value?1:0,id);
  const purgeEligible=time=>db.prepare("SELECT id FROM submissions WHERE owner_status='unlisted' AND moderation='visible' AND security_hold=0 AND purge_after IS NOT NULL AND purge_after<=?").all(time);
  // Explicit operational cleanup only; no automatic deletion on requests or startup.
  function purge(time) {return transaction(()=>{const rows=purgeEligible(time);for(const row of rows){const prior=getEntry(row.id);db.prepare('DELETE FROM submissions WHERE id=?').run(row.id);audit('server-cleanup','purge',row.id,'retention elapsed',time,{status:'unlisted',submitterId:prior.submitter_id,ownerId:prior.owner_id,source:prior.source_url},null);}return rows.length;});}
  const setModeration=(id,status,reason,time)=>db.prepare('UPDATE submissions SET moderation=?,moderation_reason=?,updated_at=? WHERE id=?').run(status,reason,time,id);
  const setBanned=(id,banned)=>db.prepare('UPDATE identities SET banned=? WHERE discord_id=?').run(banned?1:0,id);
  return { db, rolesFor,setRole,bootstrapAdmins,listIdentities,listAudit,setProtection,setHold,purgeEligible,purge, getIdentity, upsertIdentity, profileDTO, entryDTO, audit, transaction,sessionByHash,createSession,deleteSession,expireSessions,getEntry,sourceDuplicate,countOwn,listOwn,getAvatar,listCatalog,insertSubmission,updateSubmission,refreshGithub,setOwnerStatus,listAdmin,setModeration,setBanned,close:()=>db.close(),backup:destination=>backup(db,destination) };
}

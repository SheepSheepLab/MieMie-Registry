// SPDX-License-Identifier: GPL-3.0-or-later
// Offline preparation only. Caller must stop Registry and hold its operational lock.
// Never replaces the live database; prepares a verified candidate and recovery snapshot.
import {DatabaseSync} from 'node:sqlite';
import {copyFile,chmod,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openStore} from '../src/store.js';
import {backupDatabase} from './sqlite-backup.mjs';
process.umask(0o077);
if(process.argv.length!==5)throw Error('Usage: migrate-verified.mjs <existing-db> <private-backup-directory> <new-candidate>');
const [source,directory,candidate]=process.argv.slice(2).map(value=>resolve(value));
if(source===candidate)throw Error('Candidate must differ from live database');
await stat(source);try{await stat(candidate);throw Error('Candidate already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
const snapshot=await backupDatabase(source,directory);
const prior=new DatabaseSync(snapshot,{readOnly:true});
try {
 if(prior.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||prior.prepare('PRAGMA foreign_key_check').all().length)throw Error('Backup integrity failed');
 if(prior.prepare('PRAGMA user_version').get().user_version!==2)throw Error('Expected production schema 2');
 await copyFile(snapshot,candidate);await chmod(candidate,0o600);
 const migrated=openStore(candidate);
 try {
  for(const table of ['identities','avatars','sessions','submissions','audit']){
   const columns=prior.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name).join(',');
   const before=prior.prepare(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all();
   const after=migrated.db.prepare(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all();
   if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Existing records changed: '+table);
  }
  const rows=migrated.db.prepare("SELECT product_type,distribution,github_json FROM submissions WHERE source_type='github'").all();
  for(const row of rows)if(JSON.parse(row.github_json||'null')?.compatibility==='installable'&&(row.product_type!=='tavern_extension'||row.distribution!=='managed_install'))throw Error('Package migration mismatch');
  if(migrated.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||migrated.db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Candidate integrity failed');
  migrated.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
 } finally {migrated.close();}
 console.log(JSON.stringify({status:'prepared',schema:3,snapshot,candidate,existingRows:'unchanged'}));
}finally{prior.close();}

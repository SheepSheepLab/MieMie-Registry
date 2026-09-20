import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/store.js';
const config = loadConfig(), store = openStore(config.databasePath);
await mkdir('backups',{recursive:true,mode:0o700});
const file = resolve('backups',`registry-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
try { await store.backup(file); console.log('Consistent SQLite backup created in backups/. Treat it as private identity data.'); } finally { store.close(); }

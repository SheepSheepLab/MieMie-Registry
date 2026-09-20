// SPDX-License-Identifier: GPL-3.0-or-later
import { backupDatabase } from './sqlite-backup.mjs';
// Backups need neither OAuth credentials nor migrations and must not create or
// upgrade the source database.
await backupDatabase(process.env.DATABASE_PATH || './data/registry.sqlite', process.env.BACKUP_DIRECTORY || './backups');
console.log('Consistent SQLite backup created. Treat backups as private identity data.');

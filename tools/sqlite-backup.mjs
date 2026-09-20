// SPDX-License-Identifier: GPL-3.0-or-later
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function backupDatabase(source, directory) {
  if (!source || source === ':memory:') throw new Error('Backup requires an existing SQLite file');
  const db = new DatabaseSync(source, { readOnly: true });
  let destination;
  try {
    // SQLite online backup includes committed WAL data and never runs migrations.
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite integrity check failed');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    destination = resolve(directory, `registry-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`);
    await (await open(destination, 'wx', 0o600)).close();
    await backup(db, destination);
    return destination;
  } catch (error) {
    if (destination) await rm(destination, { force: true });
    throw error;
  } finally { db.close(); }
}

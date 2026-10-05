import {createGitHubAuth} from './github-auth.js';
import {createGitHubClient} from './github-client.js';
// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import {REGISTRY_VERSION} from './version.js';
import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { createApp } from './app.js';
// Restrict newly created database/WAL files and local operational output.
process.umask(0o077);
const config = loadConfig();
// Validate external key/config before opening or migrating the database.
const githubClient = createGitHubClient({auth: createGitHubAuth(config.githubAuth)});
const store = openStore(config.databasePath), app = createApp({config, store, githubClient});
const server = createServer(app.handler);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(config.port, config.host, () => {
  console.log(`MieMie Registry ${REGISTRY_VERSION} listening at ${config.publicBaseUrl}`);
  if (!config.clientId || !config.clientSecret) console.log('Discord OAuth is not configured; public catalog is available, login fails safely.');
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  app.close();
  const deadline = setTimeout(() => server.closeAllConnections(), 10000);
  deadline.unref();
  server.close(() => { clearTimeout(deadline); store.close(); process.exit(0); });
}
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, stop);

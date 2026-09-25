// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { createApp } from './app.js';
// Restrict newly created database/WAL files and local operational output.
process.umask(0o077);
const config = loadConfig(), store = openStore(config.databasePath), app = createApp({ config, store });
const server = createServer(app.handler);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(config.port, config.host, () => {
  console.log(`MieMie Registry 0.4.0 listening at ${config.publicBaseUrl}`);
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

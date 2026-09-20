// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { createApp } from './app.js';
const config = loadConfig(), store = openStore(config.databasePath), app = createApp({ config, store });
const server = createServer(app.handler);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(config.port, config.host, () => {
  console.log(`MieMie Registry 0.1.1 listening at ${config.publicBaseUrl}`);
  if (!config.clientId || !config.clientSecret) console.log('Discord OAuth is not configured; public catalog is available, login fails safely.');
});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => server.close(() => { app.close(); store.close(); process.exit(0); }));

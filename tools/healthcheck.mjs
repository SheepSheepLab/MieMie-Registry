// SPDX-License-Identifier: GPL-3.0-or-later
try {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid health port');
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Registry unhealthy');
} catch {
  // Never print response bodies, headers, credentials or private environment.
  console.error('Registry health check failed');
  process.exitCode = 1;
}

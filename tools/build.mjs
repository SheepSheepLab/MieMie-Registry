import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const pkg = JSON.parse(await readFile(new URL('../package.json',import.meta.url)));
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version)) throw new Error('Official versions must be x.x.x');
for (const file of await readdir(new URL('../src/',import.meta.url))) {
  if (!file.endsWith('.js')) continue;
  const result = spawnSync(process.execPath,['--check',new URL(`../src/${file}`,import.meta.url).pathname],{stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status);
}
console.log(`MieMie Registry ${pkg.version}: source syntax and version validated (no client secrets bundled).`);

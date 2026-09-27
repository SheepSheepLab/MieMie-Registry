// Service metadata only; protocol and database versions are independent.
import {readFileSync} from 'node:fs';
export const REGISTRY_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

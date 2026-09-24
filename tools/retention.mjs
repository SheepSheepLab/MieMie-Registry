// SPDX-License-Identifier: GPL-3.0-or-later
// Deliberate local operator action; not scheduled automatically and never exposed as HTTP.
import {openStore} from '../src/store.js';
if(!process.env.DATABASE_PATH||!['--dry-run','--purge'].includes(process.argv[2])||process.argv.length!==3)throw Error('Set DATABASE_PATH; pass --dry-run or --purge. Back up before purge.');
const store=openStore(process.env.DATABASE_PATH);
try{console.log(JSON.stringify({mode:process.argv[2],count:process.argv[2]==='--purge'?store.purge(Date.now()):store.purgeEligible(Date.now()).length}));}finally{store.close();}

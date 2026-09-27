import test from 'node:test';import assert from 'node:assert/strict';
import {validateProduct} from '../src/governance.js';
const base={type:'tavern_extension',sourceType:'github',distribution:'managed_install',classification:'community'};
test('governance independently rejects illegal product distributions and unverified installs',()=>{
 assert.doesNotThrow(()=>validateProduct(base,{compatibility:'installable'}));
 for(const [input,github] of [[base,{compatibility:'external'}],[{...base,type:'standalone_app'},{compatibility:'installable'}],[{...base,type:'web_tool'},{compatibility:'installable'}],[{...base,sourceType:'discord'},{compatibility:'installable'}],[{...base,type:'web_tool',distribution:'external_release'},{}],[{...base,type:'shortcut_app'},{}]])assert.throws(()=>validateProduct(input,github));
 assert.doesNotThrow(()=>validateProduct({...base,distribution:'external_release'},{compatibility:'external',language:'JavaScript'}));
});

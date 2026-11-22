import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const suite=process.argv[2],prefix=process.argv[3];
assert.ok(['community','compile'].includes(suite));
const directory=new URL('./',import.meta.url).pathname.replace(/\/$/,'');
await mkdir(directory,{recursive:true});
const source=new URL(suite==='community'?'../qa-source/run-native.mjs':'../qa-source/finalize-native.mjs',import.meta.url);
let code=await readFile(source,'utf8');
const sha256=createHash('sha256').update(code).digest('hex');
const client=new URL('../qa-source/native-client.mjs',import.meta.url).href;
const fixture=new URL('../qa-source/runtime-fixture.mjs',import.meta.url).href;
// Reuse the versioned scenarios and fixtures; only their output destination
// changes. Earlier package evidence and screenshots are never overwritten.
const original="import {cli,evaluate,capture,directory} from './native-client.mjs';";
assert.ok(code.includes(original));
code=code.replace(original,`import {cli,evaluate} from ${JSON.stringify(client)};\nconst directory=${JSON.stringify(directory)};\nconst capture=name=>cli('simulator_screenshot',['--path',directory+'/'+name+'.png','--optimize','false']);`)
  .replace("'./runtime-fixture.mjs'",JSON.stringify(fixture));
process.argv[2]=prefix;
await writeFile(`${directory}/${suite}-replay-source.json`,JSON.stringify({source:source.pathname,sha256,changes:'Output destination and absolute imports only; original scenarios unchanged.'},null,2)+'\n');
await import('data:text/javascript,'+encodeURIComponent(code));

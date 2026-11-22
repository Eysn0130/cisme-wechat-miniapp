import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {cli,evaluate,directory} from './native-client.mjs';
import {setup,beginUpload,state,restore} from './runtime-fixture.mjs';
await cli('automation_navigate',['--action','switchTab','--url','/pages/community/index']);
await evaluate(async function(){const p=getCurrentPages().at(-1);for(let i=0;i<120&&p.data.loading;i++)await new Promise(resolve=>setTimeout(resolve,25));return {ready:!p.data.loading};});
let active=false;
try{
  await setup();active=true;
  await cli('automation_navigate',['--action','navigateTo','--url','/pages/community-compose/index?id=11111111-1111-4111-8111-111111111111']);
  await beginUpload();await evaluate(function(){getCurrentPages().at(-1).onHide();return true;});
  const facts=await state();assert.equal(facts.files[0].state,'failed');assert.deepEqual(facts.unexpected,[]);
  await writeFile(directory+'/412-final-upload-interruption.json',JSON.stringify(facts,null,2)+'\n');
  const previous=JSON.parse(await readFile(directory+'/412-final-failure.json','utf8'));
  const results=[...previous.results,{name:'upload-interruption',passed:true}];assert.equal(results.length,16);
  await writeFile(directory+'/412-final-native-summary.json',JSON.stringify({status:'passed',scope:'Final frozen package, controlled native transports and real images; 15 earlier checks plus resumed interruption. IDE rate-limit failure retained separately; no real member writes.',results},null,2)+'\n');
  console.log(JSON.stringify({passed:results.length,resumed:'upload-interruption'}));
}finally{
  if(active){const cleanup=await restore();assert.equal(cleanup.restored,true);assert.deepEqual(cleanup.unexpected,[]);await writeFile(directory+'/412-final-runtime-restored.json',JSON.stringify(cleanup,null,2)+'\n');}
}

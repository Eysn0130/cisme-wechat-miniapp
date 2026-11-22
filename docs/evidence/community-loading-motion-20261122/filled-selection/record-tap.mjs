import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {cli,evaluate} from '../qa-source/native-client.mjs';
const [width,target]=process.argv.slice(2),directory=new URL('./',import.meta.url).pathname;
const value=await evaluate(function(){const p=getCurrentPages().at(-1),q=getApp().__glassReview;return {route:p.route,active:p.getTabBar().data.active,publisherCalls:q?.publisherCalls,controlled:!!q,width:wx.getWindowInfo().windowWidth};});
assert.equal(String(value.width),width);assert.equal(value.controlled,true);
if(target==='publisher'){assert.equal(value.route,'pages/community/index');assert.equal(value.publisherCalls,1);}
else{const index=['home','shop','community','profile'].indexOf(target);assert.ok(index>=0);assert.equal(value.route,'pages/'+target+'/index');assert.equal(value.active,index);}
const file=directory+'cua-'+width+'.json';let results=[];
try{results=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
results.push({target,method:'Actual native app CUA pointer click, followed by independent runtime read',...value});
await writeFile(file,JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify({target,passed:true,route:value.route,active:value.active}));

await cli('simulator_screenshot',['--path',directory+'cua-'+width+'-'+target+'.png','--optimize','false']);

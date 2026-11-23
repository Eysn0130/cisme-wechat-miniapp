import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cli,evaluate,directory} from './native-client.mjs';
import {restore} from './runtime-fixture.mjs';
const shots=process.env.CISME_SETTINGS_SHOTS;
if(!shots)throw Error('CISME_SETTINGS_SHOTS required');
const packageHash=JSON.parse(await readFile(new URL('../visual/current-source-acceptance.json',import.meta.url),'utf8')).packageSourceSha256;
const cases=[];
async function capture(name,selector){
  await cli('automation_viewport_action',['--action','pageScrollTo','--scroll-top','280']);
  const style=await evaluate(async function(selector){return new Promise(r=>wx.createSelectorQuery().select(selector).fields({size:true,computedStyle:['color']}).exec(r));},selector);
  if(style[0]?.color!=='rgb(154, 61, 85)'||style[0]?.height<44)throw Error(name+': danger action color or target');
  const file=`settings-${packageHash.slice(0,12)}-${name}-375.png`;
  await cli('simulator_screenshot',['--path',shots+'/'+file,'--optimize','false']);
  cases.push({name,file,style:style[0],sha256:createHash('sha256').update(await readFile(shots+'/'+file)).digest('hex')});
}
let cleanup;
try{
  await evaluate(async function(){const p=getCurrentPages().slice(-1)[0];if(!getApp().__settingsReview)throw Error('Isolated fixture required');await new Promise(r=>p.setData({editingProfile:false,editingAddresses:true,addressEditorOpen:false,addressesReady:true,addresses:[{id:'synthetic-settings-address',recipientName:'合成收货人',phone:'13800000000',labelText:'家',summary:'演示路 1 号',isDefault:true}]},r));});
  await capture('address-list','.address-action--delete');
  await evaluate(async function(){const p=getCurrentPages().slice(-1)[0];await new Promise(r=>p.setData({editingAddresses:false,editingProfile:true,phoneBound:true,phoneMasked:'138****0000'},r));});
  await capture('profile-phone','.phone-remove');
  await writeFile(directory+'/settings-controls-native.json',JSON.stringify({schemaVersion:1,packageSourceSha256:packageHash,mode:'isolated synthetic native rendering; no delete or unbind command executed',cases},null,2)+'\n');
}finally{
  cleanup=await restore();await writeFile(directory+'/settings-controls-restored.json',JSON.stringify(cleanup,null,2)+'\n');
  console.log(JSON.stringify({cases:cases.length,cleanup}));
}

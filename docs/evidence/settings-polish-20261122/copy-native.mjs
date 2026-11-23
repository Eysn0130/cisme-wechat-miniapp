import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cli,evaluate,directory} from './native-client.mjs';
import {restore} from './runtime-fixture.mjs';
const shots=process.env.CISME_SETTINGS_SHOTS;
if(!shots)throw Error('CISME_SETTINGS_SHOTS required');
await mkdir(shots,{recursive:true});
const captures=[];
async function capture(name){
  const path=`${shots}/copy-${name}-375.png`;
  await cli('simulator_screenshot',['--path',path,'--optimize','false']);
  const state=await evaluate(async function(){
    const p=getCurrentPages().slice(-1)[0],q=getApp().__settingsReview;
    const r=await new Promise(resolve=>wx.createSelectorQuery().selectAll('.settings-principle').boundingClientRect().select('.member-card__footer').boundingClientRect().select('.member-card__number').boundingClientRect().selectAll('.settings-row,.profile-row').boundingClientRect().exec(resolve));
    return {route:p.route,width:wx.getWindowInfo().windowWidth,loading:p.data.loading,profileError:!!p.data.profileError,error:!!p.data.error,footerCount:r[0].length,cardFooter:r[1],cardNumber:r[2],rows:r[3],blockedWrites:q.blockedWrites,unexpected:q.unexpected};
  });
  if(state.width!==375||state.blockedWrites||state.unexpected.length||state.error||state.profileError)throw Error(name+': unexpected state');
  if(state.footerCount)throw Error('Removed explanatory footer still rendered');
  if(state.rows.some(r=>r.height<44||r.left<0||r.right>375.5))throw Error(name+': invalid row geometry');
  if(state.cardNumber&&Math.abs(state.cardFooter.right-state.cardNumber.right)>1)throw Error('Membership number lost right alignment');
  captures.push({name,file:`copy-${name}-375.png`,sha256:createHash('sha256').update(await readFile(path)).digest('hex'),...state});
  console.log(JSON.stringify({name,route:state.route,pass:true}));
}
async function scroll(top){await cli('automation_viewport_action',['--action','pageScrollTo','--scroll-top',String(top)]);}
let cleanup;
try{
  await evaluate(function(){
    const q=getApp().__settingsReview;if(!q)throw Error('Isolated fixture required');
    const {avatar_data_url,...member}=q.profile;
    Object.assign(q.extra,{
      '/v1/bootstrap/profile':{businessVersion:1,member,points:{projection:{available:250,frozen:0,debt:0,reserved:0,version:1}},care:null},
      '/v1/me/commercial-membership':{eligible:false,membershipState:'none',verifiedOrderCount:0,commission:{netEarnedCents:0}},
      '/v1/me/support/summary':{unreadCount:0},
      '/v1/me/daily-care-records':{items:[],loadedCount:0,hasMore:false,nextCursor:null,serverDay:'2026-11-22',today:null,totalCount:0}
    });
  });
  await scroll(0);await capture('settings');
  await cli('automation_element_action',['--selector','.settings-group .settings-row:nth-child(2)','--action','tap']);
  await scroll(280);await capture('profile-editor');
  await cli('automation_element_action',['--selector','.settings-group .settings-row:nth-child(4)','--action','tap']);
  await scroll(280);
  await cli('automation_element_action',['--selector','.settings-empty .secondary','--action','tap']);
  await capture('address-editor');
  await scroll(100000);await capture('address-actions');
  await evaluate(function(){const p=getCurrentPages().slice(-1)[0];p.setData({addressDirty:false,profileDirty:false});p.syncUnloadGuard();});
  await cli('automation_navigate',['--action','switchTab','--url','/pages/profile/index']);
  await evaluate(async function(){const p=getCurrentPages().slice(-1)[0];for(let i=0;i<100&&(p.data.loading||p.data.authorityState==='loading'||p.data.commercialState==='loading');i++)await new Promise(r=>setTimeout(r,100));});
  await scroll(0);await capture('my-page');
  const card=await cli('automation_element_action',['--selector','.member-card__footer','--action','text']);
  await writeFile(directory+'/copy-native-results.json',JSON.stringify({schemaVersion:1,mode:'isolated synthetic native copy/layout check',captures,cardFooterText:card},null,2)+'\n');
}finally{
  const route=await evaluate(function(){return getCurrentPages().slice(-1)[0]?.route;});
  if(route!=='pages/settings/index')await cli('automation_navigate',['--action','navigateTo','--url','/pages/settings/index']);
  cleanup=await restore();
  await writeFile(directory+'/copy-runtime-restored.json',JSON.stringify(cleanup,null,2)+'\n');
  console.log(JSON.stringify({cleanup}));
}

import {writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {cli,evaluate,directory} from './native-client.mjs';

const shots=process.env.CISME_SETTINGS_SHOTS;
if(!shots)throw Error('Set CISME_SETTINGS_SHOTS to a private local screenshot directory');
await mkdir(shots,{recursive:true});
const label=process.argv[2]||'375';
const checks=[];
function assert(ok,message){if(!ok)throw Error(message);}
async function patch(values){return evaluate(async function(values){
  if(!getApp().__settingsReview)throw Error('Isolated fixture required');
  const p=getCurrentPages().slice(-1)[0];if(p.route!=='pages/settings/index')throw Error('Settings required');
  await new Promise(resolve=>p.setData(values,resolve));return true;
},values);}
async function scroll(top=0){await cli('automation_viewport_action',['--action','pageScrollTo','--scroll-top',String(top)]);}
async function scrollTo(selector){
  const top=await evaluate(async function(selector){return new Promise(resolve=>wx.createSelectorQuery().select(selector).boundingClientRect().selectViewport().scrollOffset().exec(r=>resolve(Math.max(0,(r[0]?.top||0)+(r[1]?.scrollTop||0)-wx.getWindowInfo().statusBarHeight-70))));},selector);
  await scroll(top);
}
async function capture(name){
  const path=`${shots}/${label}-${name}.png`;
  await cli('simulator_screenshot',['--path',path,'--optimize','false']);
  const sha256=createHash('sha256').update(await readFile(path)).digest('hex');
  const state=await evaluate(async function(){
    const p=getCurrentPages().slice(-1)[0],q=getApp().__settingsReview;
    const result=await new Promise(resolve=>wx.createSelectorQuery().selectAll('.settings-row').boundingClientRect().selectAll('.field-input').boundingClientRect().selectAll('.settings-row__copy').boundingClientRect().selectAll('.settings-row__icon').boundingClientRect().selectAll('.settings-row__value,.settings-caret').boundingClientRect().select('.topbar__back').boundingClientRect().select('.topbar__title').boundingClientRect().select('.settings-logout').boundingClientRect().selectViewport().scrollOffset().exec(resolve));
    const w=wx.getWindowInfo();
    return {route:p.route,width:w.windowWidth,height:w.windowHeight,safeBottom:w.screenHeight-w.safeArea.bottom,
      profileOpen:p.data.editingProfile,addressOpen:p.data.editingAddresses,addressEditorOpen:p.data.addressEditorOpen,aboutOpen:p.data.aboutOpen,profileReady:p.data.profileReady,
      sessionStatus:p.data.sessionStatus,loading:p.data.loading,hasError:!!p.data.error,admin:p.data.canManageMembers,
      consentCount:p.data.consents.length,activeConsents:p.data.consents.filter(x=>!x.revoked_at).length,
      rows:result[0],inputs:result[1],copies:result[2],icons:result[3],trailing:result[4],back:result[5],title:result[6],logout:result[7],scroll:result[8],
      blockedWrites:q?.blockedWrites,unexpected:q?.unexpected};
  });
  assert(state.route==='pages/settings/index',name+': wrong route');
  assert(state.rows.every(r=>r.width>=44&&r.height>=44&&r.left>=0&&r.right<=state.width+.5),name+': row clipping / target');
  assert(state.copies.every((r,i)=>r.left-state.icons[i].right>=7.5),name+': icon/text spacing');
  assert(state.inputs.every(r=>r.height>=44&&r.left>=0&&r.right<=state.width+.5),name+': input clipping / target');
  assert(state.back.width>=44&&state.back.height>=44,name+': back target');
  assert(state.blockedWrites===0&&!state.unexpected.length,name+': unexpected transport');
  checks.push({name,screenshot:{file:`${label}-${name}.png`,sha256,synthetic:true},...state});
  console.log(JSON.stringify({case:name,width:state.width,rows:state.rows.length,inputs:state.inputs.length,pass:true}));
}

await patch({editingProfile:false,editingAddresses:false,aboutOpen:false,profileDirty:false,addressDirty:false,canManageMembers:false});
await scroll();await capture('overview');
await cli('automation_element_action',['--selector','.settings-group .settings-row:nth-child(2)','--action','tap']);
await scrollTo('.settings-detail');await capture('profile-expanded');
assert(checks.at(-1).profileOpen&&checks.at(-1).profileReady,'Profile did not open');
await patch({editingProfile:false,editingAddresses:true});
await scrollTo('.settings-detail');await capture('address-empty');
await cli('automation_element_action',['--selector','.settings-empty .secondary','--action','tap']);
await scrollTo('.settings-detail');await capture('address-editor');
assert(checks.at(-1).addressEditorOpen,'Shared address editor did not open');
await patch({addressEditorOpen:false,addressDirty:false});
await patch({editingAddresses:false,aboutOpen:true});
await scrollTo('.about-detail');await capture('about-and-logout');
const bottom=checks.at(-1);assert(bottom.aboutOpen&&bottom.logout.bottom<=bottom.height-bottom.safeBottom+1,'Logout inaccessible at lower safe area');
await evaluate(async function(){getApp().__settingsReview.admin=true;await getCurrentPages().slice(-1)[0].loadManagementAccess();});
await patch({aboutOpen:false,consents:[
  {id:'synthetic-active',purposeLabel:'保存投稿资料',revoked_at:null},
  {id:'synthetic-revoked',purposeLabel:'精选展示',revoked_at:'2026-11-22'}
]});
await scrollTo('.consent-list');await capture('consents-and-management');
await evaluate(async function(){const p=getCurrentPages().slice(-1)[0];getApp().__settingsReview.admin=false;getApp().__settingsReview.failConsents=true;await p.loadManagementAccess();await p.load();});
await scrollTo('.settings-row--status');await capture('consent-error');
assert(checks.at(-1).sessionStatus==='unknown'&&checks.at(-1).hasError,'Failed read became a confirmed state');
await evaluate(async function(){getApp().__settingsReview.failConsents=false;await getCurrentPages().slice(-1)[0].load();});
await scrollTo('.settings-row--status');await capture('consent-recovered');
assert(checks.at(-1).sessionStatus==='valid'&&!checks.at(-1).hasError&&checks.at(-1).consentCount===0,'Confirmed empty did not recover');
await patch({sessionStatus:'valid',error:'',displayName:'合成昵称长文本'.repeat(5)});
const chrome=await evaluate(function(){return getCurrentPages().slice(-1)[0].data.chromeStyle;});
await patch({chromeStyle:chrome+';--cisme-text-small:15.6px;--cisme-text-body:18.2px;--cisme-text-action:20.8px'});
await scroll();await capture('font-130-long-name');
await patch({editingAddresses:true,addressEditorOpen:true});
await scrollTo('.settings-detail');await capture('font-130-address-editor');
await patch({editingAddresses:false,addressEditorOpen:false,addressDirty:false});
await patch({chromeStyle:chrome,displayName:'合成会员'});
await scroll();
await writeFile(`${directory}/${label}-native-checks.json`,JSON.stringify({schemaVersion:1,mode:'isolated-synthetic-native-render',systemFontSettingVerified:false,checks},null,2)+'\n');

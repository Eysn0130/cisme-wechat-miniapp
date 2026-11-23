import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {cli,evaluate} from '../settings-polish-20261122/native-client.mjs';
import {restore} from '../settings-polish-20261122/runtime-fixture.mjs';
import {execFileSync} from 'node:child_process';
const survey=JSON.parse(execFileSync('./node_modules/.bin/tsx',['-e',"import {careQuestions,careQuestionnaireVersion,careConsentVersion,careConsentText} from './services/api/src/careOnboarding';console.log(JSON.stringify({questionnaireVersion:careQuestionnaireVersion,questions:careQuestions,sensitiveConsent:{version:careConsentVersion,text:careConsentText},birthdayMonthDay:null,profile:null}));"],{encoding:'utf8'}));

// Run prepare-native.mjs first. All member data, writes and storage are isolated.
// Public legal text is read without credentials; member GETs use explicit fixtures.
const phase=process.argv[2]||'baseline';
const shots=process.env.CISME_SECONDARY_SHOTS;
if(!shots)throw Error('CISME_SECONDARY_SHOTS required');
await mkdir(shots,{recursive:true});
const hash=JSON.parse(await readFile(new URL('../visual/current-source-acceptance.json',import.meta.url),'utf8')).packageSourceSha256;
const captures=[];
const width=await evaluate(function(){return wx.getWindowInfo().windowWidth;});
const wait=()=>evaluate(async function(){await new Promise(r=>setTimeout(r,350));return {route:getCurrentPages().slice(-1)[0]?.route};});
const scroll=(top)=>cli('automation_viewport_action',['--action','pageScrollTo','--scroll-top',String(top)]);
const tap=(selector)=>cli('automation_element_action',['--selector',selector,'--action','tap']);
async function capture(name){
 if(process.env.CISME_QUICK && !['legal-privacy','legal-terms','rights-empty','rights-close','rights-withdraw-error','rights-reply'].includes(name))return;
 const path=`${shots}/${phase}-${hash.slice(0,12)}-${name}-${width}.png`;
 await cli('simulator_screenshot',['--path',path,'--optimize','false']);
 const geometry=await evaluate(function(){return new Promise(resolve=>{const selectors=['.topbar','.topbar__back','.settings-row','.field-input','.primary','.secondary','.rights-picker','.rights-input','.text-button','.inline-action'],query=wx.createSelectorQuery();for(const selector of selectors)query.selectAll(selector).fields({rect:true,size:true,computedStyle:['fontSize','color']});query.exec(rows=>resolve({route:getCurrentPages().slice(-1)[0]?.route,width:wx.getWindowInfo().windowWidth,controls:rows.flatMap((list,index)=>(list||[]).map(rect=>({selector:selectors[index],...rect})))}));});});
 captures.push({name,path,geometry});console.log(JSON.stringify({capture:name,path}));
}
let cleanup,legal;
try{
 legal=await evaluate(async function(){
  const app=getApp(),q=app.__settingsReview;if(!q)throw Error('isolated fixture required');
  const response=await new Promise(resolve=>q.original.request({url:app.globalData.apiBaseUrl.replace(/\/$/,'')+'/v1/legal',method:'GET',success:r=>resolve(r.statusCode===200?r.data:null),fail:()=>resolve(null)}));
  q.extra['/v1/legal']=response||{ready:true,documents:[{document_type:'privacy',title:'测试隐私保护指引',version:'fixture-v1',operator_name:'测试主体',contact:'测试联系渠道',body:'# 测试隐私保护指引\n\n此为隔离展示测试正文，不代表正式协议。'},{document_type:'terms',title:'测试用户协议',version:'fixture-v1',operator_name:'测试主体',contact:'测试联系渠道',body:'# 测试用户协议\n\n此为隔离展示测试正文，不代表正式协议。'}]};
  return {publicReadSucceeded:!!response,documents:q.extra['/v1/legal'].documents.map(d=>({type:d.document_type,version:d.version}))};
 });
 await evaluate(async function(survey){const q=getApp().__settingsReview;q.profile.id='11111111-1111-4111-8111-111111111111';q.extra['/v1/me/points/receipts']={memberId:q.profile.id,pending:false,receipts:[]};q.extra['/v1/me/care-profile']=survey;const p=getCurrentPages().slice(-1)[0];p.clearMemberSnapshot();p.profileSessionToken='';await p.loadSettingsBootstrap();},
  survey);
 if(!process.env.CISME_SKIP_PRIMARY){await scroll(0);await capture('settings');
 await tap('.settings-group .settings-row:nth-child(2)');await scroll(280);await capture('profile');
 await evaluate(function(){const p=getCurrentPages().slice(-1)[0];p.setData({editingProfile:false,profileDirty:false});p.openCareProfile();});
 await wait();await capture('care-profile');
 await evaluate(function(){getCurrentPages().slice(-1)[0].closeCareProfile();});
 await tap('.settings-group .settings-row:nth-child(4)');await wait();await scroll(260);await capture('addresses-empty');
 await tap('.settings-empty .secondary');await scroll(360);await capture('address-editor');
 await scroll(100000);await capture('address-editor-actions');}
 await evaluate(function(){const p=getCurrentPages().slice(-1)[0];p.setData({addressDirty:false,profileDirty:false});p.syncUnloadGuard();p.openLegal();});
 await wait();await scroll(0);await capture('legal-privacy');
 const switcher=await evaluate(function(){return typeof getCurrentPages().slice(-1)[0].changeDocument==='function';});
 if(switcher===true){await evaluate(async function(){const p=getCurrentPages().slice(-1)[0];await p.changeDocument({detail:{value:'terms'}});});await wait();await scroll(0);await capture('legal-terms');}
 await cli('automation_navigate',['--action','navigateBack']);
 await evaluate(function(){const q=getApp().__settingsReview;q.extra['/v1/me/privacy-requests']={items:[],nextCursor:null};getCurrentPages().slice(-1)[0].openPrivacyRights();});
 await wait();await scroll(0);await capture('rights-empty');
 if(phase!=='baseline'){
  await evaluate(function(){return getCurrentPages().slice(-1)[0].submit();});await capture('rights-required-error');
  await evaluate(function(){const p=getCurrentPages().slice(-1)[0];p.choose({detail:{value:'1'}});});await capture('rights-correct');
  await evaluate(function(){const p=getCurrentPages().slice(-1)[0];p.choose({detail:{value:'2'}});});await capture('rights-delete');
  await evaluate(function(){const p=getCurrentPages().slice(-1)[0];p.chooseDeleteScope({detail:{value:'1'}});});await capture('rights-delete-other');
 }
 await evaluate(function(){const p=getCurrentPages().slice(-1)[0];p.choose({detail:{value:'3'}});});await capture('rights-close');
 await evaluate(function(){const p=getCurrentPages().slice(-1)[0];p.choose({detail:{value:'4'}});});await wait();await capture('rights-withdraw-empty');
 await evaluate(function(){const q=getApp().__settingsReview;q.failConsents=true;return getCurrentPages().slice(-1)[0].loadConsents();});await capture('rights-withdraw-error');
 if(phase!=='baseline'){
  await evaluate(function(){const q=getApp().__settingsReview;q.failConsents=false;q.consents=[{id:'synthetic-consent-active',submission_id:'synthetic-submission',purpose:'feed_readonly',active:true,revoked_at:null}];return getCurrentPages().slice(-1)[0].loadConsents();});await capture('rights-withdraw-active');
  await evaluate(function(){const q=getApp().__settingsReview;q.extra['/v1/me/privacy-requests']={items:[{id:'synthetic-request-reply',kind:'correct',message:'请更正我的会员资料。此条与以下回复均为隔离展示数据，不代表真实会员申请。',status:'responded',waitingOn:'member',response:'请补充希望更正的具体内容。',replyHistory:[{version:1,actor:'operator',body:'请补充希望更正的具体内容。'}],execution:null},{id:'synthetic-request-copy',kind:'access',message:'查阅我的资料',status:'completed',replyHistory:[],execution:{scope:'member_profile_only',status:'succeeded',deliveryState:'available',downloadAvailable:true}}],nextCursor:null};const p=getCurrentPages().slice(-1)[0];p.choose({detail:{value:'0'}});return p.load();});await scroll(600);await capture('rights-records');
  await evaluate(function(){const p=getCurrentPages().slice(-1)[0];p.startReply({currentTarget:{dataset:{id:'synthetic-request-reply'}}});});await scroll(600);await capture('rights-reply');
 }

 await cli('automation_navigate',['--action','navigateBack']);
 await evaluate(function(){const p=getCurrentPages().slice(-1)[0];p.setData({aboutOpen:true,editingAddresses:false,addressEditorOpen:false});});await scroll(100000);await capture('about');
 await writeFile(new URL(`./${phase}-native.json`,import.meta.url),JSON.stringify({packageSourceSha256:hash,mode:'isolated synthetic member native rendering; no member writes',legal,captures},null,2)+'\n');
}finally{
 const route=await evaluate(function(){return getCurrentPages().slice(-1)[0]?.route;});
 if(route!=='pages/settings/index')await cli('automation_navigate',['--action','navigateTo','--url','/pages/settings/index']);
 cleanup=await restore();
 await writeFile(new URL(`./${phase}-native.json`,import.meta.url),JSON.stringify({packageSourceSha256:hash,mode:'isolated synthetic member native rendering; no member writes',legal,captures},null,2)+'\n');
 await writeFile(new URL(`./${phase}-cleanup.json`,import.meta.url),JSON.stringify(cleanup,null,2)+'\n');
 console.log(JSON.stringify({cleanup}));
}

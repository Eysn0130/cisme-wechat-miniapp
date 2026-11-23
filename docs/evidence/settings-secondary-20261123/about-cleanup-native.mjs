import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cli,evaluate} from '../settings-polish-20261122/native-client.mjs';
import {restore} from '../settings-polish-20261122/runtime-fixture.mjs';
const folder=process.env.CISME_SECONDARY_SHOTS;if(!folder)throw Error('CISME_SECONDARY_SHOTS required');
await mkdir(folder,{recursive:true});
const hash=JSON.parse(await readFile(new URL('../visual/current-source-acceptance.json',import.meta.url),'utf8')).packageSourceSha256;
const captures=[],checks=[];
const scroll=top=>cli('automation_viewport_action',['--action','pageScrollTo','--scroll-top',String(top)]);
async function capture(name){const path=`${folder}/about-cleanup-${hash.slice(0,12)}-${name}-375.png`;await cli('simulator_screenshot',['--path',path,'--optimize','false']);captures.push({name,localPath:path,storage:'local-only; repository PNG ignore policy',sha256:createHash('sha256').update(await readFile(path)).digest('hex')});console.log(JSON.stringify({capture:name,path}));}
let cleanup;
try{
 await evaluate(async function(){
  const q=getApp().__settingsReview;if(!q)throw Error('Isolated fixture required');
  const {avatar_data_url,...member}=q.profile;
  Object.assign(q.extra,{
   '/v1/bootstrap/profile':{businessVersion:1,member,points:{projection:{available:250,frozen:0,debt:0,reserved:0,version:1}},care:null},
   '/v1/me/commercial-membership':{eligible:false,membershipState:'none',verifiedOrderCount:0,commission:{netEarnedCents:0}},
   '/v1/me/support/summary':{unreadCount:0},
   '/v1/me/daily-care-records':{items:[],loadedCount:0,hasMore:false,nextCursor:null,serverDay:'2026-11-23',today:null,totalCount:0}
  });
  q.consents=[{id:'synthetic-about-review-consent',purpose:'feed_readonly',active:true,revoked_at:null}];
  await getCurrentPages().slice(-1)[0].load();
 });
 await scroll(0);await capture('settings-top');
 const text=JSON.stringify(await cli('automation_element_action',['--selector','.settings-page','--action','text']));
 if(/关于 CISME|会员编号|运行环境|开发版/.test(text))throw Error('Removed About details still visible');
 checks.push({name:'settings-no-duplicate-number-or-runtime-and-no-empty-about-entry',passed:true});
 await scroll(100000);await capture('settings-bottom');
 checks.push(await evaluate(function(){return new Promise(resolve=>wx.createSelectorQuery().select('.settings-logout').boundingClientRect().exec(rows=>{const w=wx.getWindowInfo(),rect=rows[0];resolve({name:'logout-retains-safe-bottom-position',passed:!!rect&&rect.height>=44&&Math.abs(rect.bottom-(w.windowHeight-(w.screenHeight-w.safeArea.bottom)-12))<2,rect,viewport:{width:w.windowWidth,height:w.windowHeight}});}));}));
 await cli('automation_navigate',['--action','switchTab','--url','/pages/profile/index']);
 await evaluate(async function(){for(let i=0;i<200;i++){const p=getCurrentPages().slice(-1)[0];if(p.route==='pages/profile/index'&&!p.data.loading&&p.data.authorityState!=='loading'&&p.data.commercialState!=='loading')return true;await new Promise(r=>setTimeout(r,100));}throw Error('My page did not settle');});
 await scroll(0);await capture('my-member-card');
 const card=JSON.stringify(await cli('automation_element_action',['--selector','.member-card__footer','--action','text']));
 if(!card.includes('No. 00042'))throw Error('Membership number missing from My card');
 checks.push({name:'my-member-card-keeps-own-membership-number',passed:true});
}finally{
 if(await evaluate(function(){return getCurrentPages().slice(-1)[0]?.route;})!=='pages/settings/index')await cli('automation_navigate',['--action','navigateTo','--url','/pages/settings/index']);
 cleanup=await restore();
 const result={schemaVersion:1,packageSourceSha256:hash,mode:'isolated synthetic native presentation; no real account writes',captures,checks,cleanup,scope:'Settings de-duplication and My number retention at 375 only; earlier 33 frames belong to package a004bf1c and are not reclassified as current acceptance.'};
 await writeFile(new URL('./about-cleanup.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({checks,cleanup}));
 if(checks.some(c=>!c.passed)||!cleanup.restored||cleanup.blockedWrites||cleanup.unexpected.length)throw Error('Focused native verification incomplete');
}

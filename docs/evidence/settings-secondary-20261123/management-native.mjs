import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {cli,evaluate} from '../settings-polish-20261122/native-client.mjs';
import {restore} from '../settings-polish-20261122/runtime-fixture.mjs';
const shots=process.env.CISME_SECONDARY_SHOTS;if(!shots)throw Error('CISME_SECONDARY_SHOTS required');
await mkdir(shots,{recursive:true});
const hash=JSON.parse(await readFile(new URL('../visual/current-source-acceptance.json',import.meta.url),'utf8')).packageSourceSha256;
const captures=[],checks=[];
const wait=()=>evaluate(async function(){await new Promise(r=>setTimeout(r,350));return true;});
const tap=selector=>cli('automation_element_action',['--selector',selector,'--action','tap']);
async function capture(name){const path=`${shots}/final-${hash.slice(0,12)}-${name}-375.png`;await cli('simulator_screenshot',['--path',path,'--optimize','false']);captures.push({name,path});console.log(JSON.stringify({capture:name,path}));}
try{
 await evaluate(async function(){
  const q=getApp().__settingsReview;if(!q)throw Error('isolated fixture required');q.admin=true;
  const scope={profile:true,contact:false,care:true,orders:true,points:true,rewards:true,issueRewards:false,administrators:false,sharing:false,commission:false,finance:false,support:false,privacy:false,moderate:false,manage:false,export:false};
  const member={id:'22222222-2222-4222-8222-222222222222',displayName:'合成测试会员',userCode:'SAMPLEUSER01',cardNumber:'00043',avatar:null,accountStatus:'active',onboarding:'complete',createdAt:'2026-11-23T00:00:00Z',phoneMasked:null,points:{available:100},commerce:{netCents:0,paidOrderCount:0},activity:{careDays:3,streak:1},rewards:{availableCoupons:0,unclaimedRewards:0},sharing:{state:'none'}};
  q.extra['/v1/management/users']={scope,items:[member],total:1,nextCursor:null};
  q.extra['/v1/management/users/'+member.id]={member,scope};
  q.extra['/v1/management/users/'+member.id+'/sections/profile']={data:{birthday:null,wechatHandle:null,questionnaire:{questions:[]},agreements:[]}};
  q.extra['/v1/management/members']={items:[{id:member.id,displayName:member.displayName,accountStatus:'active',membershipState:'none',commercialEligible:false,expiresAt:null,referralCode:null}],summary:{all:1,members:0,ordinary:1},matchingTotal:1,loadedCount:1,nextCursor:null};
  const previous=wx.request;
  wx.request=function(options){const path=options.url.replace(/^https?:\/\/[^/]+/,'').split('?')[0];if(q.managementDenied&&path.startsWith('/v1/management/users')){q.requests.push({method:options.method||'GET',path});setTimeout(()=>{options.success?.({statusCode:403,data:{title:'当前无权查看用户资料',status:403},header:{}});options.complete?.({});},80);return {abort(){}};}return previous(options);};
  const p=getCurrentPages().slice(-1)[0];await p.loadManagementAccess();p.openMemberManagement();
 });
 await wait();await capture('management-list');
 await tap('.users-search .action-text');await capture('management-filter');
 await tap('.users-sheet .action-text');
 await tap('.users-toolbar .action-text');await capture('management-fields');
 await tap('.users-sheet .users-primary');
 await tap('.users-detail-cell.action-text');await wait();await capture('management-inspector');
 checks.push(await evaluate(function(){const c=getCurrentPages().slice(-1)[0].selectComponent('#memberInspector');if(!c)throw Error('Inspector unavailable');c.tabChange({detail:{value:'profile'}});return {name:'inspector-tab',available:true};}));
 await wait();await capture('management-profile');
 checks.push(await evaluate(async function(){const q=getApp().__settingsReview,p=getCurrentPages().slice(-1)[0];p.closeInspector();q.managementDenied=true;await p.load(false,false);const count=q.requests.length;p.changeView({detail:{value:'commerce'}});await new Promise(r=>setTimeout(r,200));return {name:'revoked-read-clears-member-data-and-stops-tabs',passed:p.data.items.length===0&&p.data.scope===null&&!p.data.inspectorVisible&&q.requests.length===count};}));
 await capture('management-no-permission');
 await evaluate(async function(){const q=getApp().__settingsReview,p=getCurrentPages().slice(-1)[0];q.managementDenied=false;await p.load(false,false);p.commercial();});
 await wait();await capture('management-commercial');
}finally{
 const route=await evaluate(function(){return getCurrentPages().slice(-1)[0]?.route;});
 if(route!=='pages/settings/index')await cli('automation_navigate',['--action','navigateTo','--url','/pages/settings/index']);
 const cleanup=await restore();
 await writeFile(new URL('./management-native.json',import.meta.url),JSON.stringify({packageSourceSha256:hash,mode:'isolated read-only management capability/transport fixtures; no real permissions or writes',captures,checks,cleanup},null,2)+'\n');
 console.log(JSON.stringify({checks,cleanup}));
}

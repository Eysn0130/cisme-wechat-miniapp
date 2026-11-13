import{cli,evaluate,setup,restore,root}from'./native-fixture.mts';
import{mkdir,readFile,writeFile}from'node:fs/promises';
import{inspectMiniProgramPackage}from'/Users/mini/CISME/scripts/miniprogram-package-lib.ts';
import{careQuestions,careQuestionnaireVersion,careConsentVersion,careConsentText}from'/Users/mini/CISME/services/api/src/careOnboarding.ts';
const pack=await inspectMiniProgramPackage(root+'/apps/miniprogram'),hash=pack.actual.sourceSha256;
const accepted=JSON.parse(await readFile(root+'/docs/evidence/visual/current-source-acceptance.json','utf8'));if(accepted.packageSourceSha256!==hash)throw Error('SOURCE_MISMATCH');
const dir=root+'/docs/evidence/member08-onboarding-feedback-20261113/native-'+hash.slice(0,12);await mkdir(dir,{recursive:true});
const out:any={packageSourceSha256:hash,scope:'Native WeChat simulator; all HTTP and storage isolated. WeChat login and phone authorization callbacks injected with synthetic codes, not a real WeChat popup, real profile or actual phone binding. New member profile is optional and remains neutral by Owner decision.',captures:[]};
async function shot(name:string,selector?:string){const r=await cli('simulator_screenshot',['--path',dir+'/'+name+'.png','--optimize','false',...(selector?['--wait-for-selector',selector]:[])]);out.captures.push({name,...r});}
out.setup=await setup();
try{
 await evaluate(function(survey){
  const q=getApp().__cismeTravelQA,base=wx.request,date=new Date().toISOString();q.owner='11111111-1111-4111-8111-'+Date.now().toString(16).padStart(12,'0');getApp().globalData.sessionToken='synthetic-member-feedback-'+Date.now();q.nativeSurvey={...survey,profile:null,birthdayMonthDay:null,birthdayChangeAfter:null};q.newOnboarding=true;q.ledgerAt=Infinity;q.createdAvatars=[];q.usage=null;q.usageAt=Infinity;q.creditTimeline=[];q.original.localFiles=wx.getFileSystemManager().readdirSync(wx.env.USER_DATA_PATH);
  q.original.login=wx.login;wx.login=()=>Promise.resolve({code:'synthetic-native-identity-code'});q.identityToken='synthetic-authorized-'+Date.now();getApp().globalData.sessionToken='';q.phoneBound=false;
  q.nativeMember={id:q.owner,display_name:'CISME 会员',card_number:'00008',profile_revision:0,completed_at:null,avatar_data_url:null,avatar_revision:null,public_status:'private'};
  q.points=()=>{const granted=Date.now()>=q.ledgerAt;return{projection:{available:granted?100+(Date.now()>=q.usageAt?15:0):0,frozen:0,reserved:0,debt:0,version:granted?2:1},rulesEnabled:true,entries:granted?[{id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',entry_type:'grant_available',source_type:'questionnaire',component:'base',available_delta:100,frozen_delta:0,debt_delta:0,business_key:'synthetic-questionnaire-grant',occurred_at:date}]:[],nextCursor:null,totalCount:granted?1:0,lifetimeEarned:granted?100:0,used:0,expired:0,expiring:{points:0,earliestAt:null,withinDays:30},clubPolicy:null};};
  wx.request=o=>{
   const path=o.url.replace('https://synthetic-travel.invalid',''),method=o.method||'GET';
   const handled=['/v1/identity/capabilities','/v1/identity/wechat','/v1/me/phone','/v1/me','/v1/legal','/v1/me/profile','/v1/me/care-profile','/v1/me/care-profile/complete','/v1/bootstrap/home','/v1/bootstrap/profile','/v1/me/points/club','/v1/me/rewards'].includes(path)||path.startsWith('/v1/me/points?')||path==='/v1/me/points/checkin'||path.startsWith('/v1/me/care-usage-records?');
   if(!handled)return base(o);q.requests.push({path,method,handled:true});let aborted=false;
   const timer=setTimeout(()=>{if(aborted)return;const b=o.data||{};let data;
    if(path==='/v1/legal')data={ready:true,documents:[{document_type:'privacy',version:'v1'},{document_type:'terms',version:'v1'}]};
    else if(path==='/v1/identity/capabilities')data={phoneBindingEnabled:true,avatarSelection:'chooseAvatar'};
    else if(path==='/v1/identity/wechat')data={sessionToken:q.identityToken,onboardingRequired:true,phoneBindingEnabled:true};
    else if(path==='/v1/me/phone'){q.phoneBound=true;data={bound:true,masked:'***0001'};}
    else if(path==='/v1/me')data=q.nativeMember;
    else if(path==='/v1/me/profile')data=q.nativeMember;
    else if(path.startsWith('/v1/me/care-profile')){
     if(method!=='GET'){
      const complete=path.endsWith('/complete'),previous=q.nativeSurvey.profile;
      q.nativeSurvey.profile={version:(previous?.version||0)+1,questionnaireVersion:survey.questionnaireVersion,required:!complete,currentQuestion:b.currentQuestion,latestOperationId:o.header['Idempotency-Key'],answers:b.answers,birthdayMonthDay:b.birthdayMonthDay??null,healthChoice:b.consentChoice??previous?.healthChoice??'unasked',healthTextVersion:survey.sensitiveConsent.version,healthDecidedAt:date,completedAt:complete?date:null,updatedAt:date};
      if(complete){q.newOnboarding=false;q.ledgerAt=Date.now()+200;}
      data={profile:q.nativeSurvey.profile,operationId:o.header['Idempotency-Key'],current:true,replayed:false,appliedVersion:q.nativeSurvey.profile.version};
     }else data=q.nativeSurvey;
    }else if(path==='/v1/bootstrap/home'||path==='/v1/bootstrap/profile')data={member:q.nativeMember,care:null,businessVersion:q.nativeMember.profile_revision,onboardingRequired:q.newOnboarding,points:path.endsWith('/profile')?q.points():null};
    else if(path==='/v1/me/points/checkin'){
     const id='12121212-1212-4212-8212-121212121212';q.usage={id,operationId:o.header['Idempotency-Key'],products:b.products,note:b.note,version:(q.usage?.version||0)+1};if(q.usageAt===Infinity)q.usageAt=Date.now()+180;data={recordId:id,operationId:q.usage.operationId,replayed:false,careDay:b.serverDay};
    }else if(path==='/v1/me/points/club'||path.startsWith('/v1/me/care-usage-records?')){
     const receipt=q.usage?{careDay:'2026-11-13',pointsGranted:Date.now()>=q.usageAt?15:0,pointsReversed:0,debtOffset:0,pending:Date.now()<q.usageAt,components:Date.now()>=q.usageAt?[{code:'daily',points:10,reversed:0,ruleVersion:'fixture',grantId:'13131313-1313-4313-8313-131313131313'},{code:'note',points:5,reversed:0,ruleVersion:'fixture',grantId:'14141414-1414-4414-8414-141414141414'}]:[]}:null;
     data=path==='/v1/me/points/club'?{memberId:q.owner,enabled:true,serverDay:'2026-11-13',today:q.usage,streak:q.usage?1:0,todayRewards:receipt}:{items:q.usage?[{...q.usage,careDay:'2026-11-13',completedAt:date,updatedAt:date,rewards:receipt}]:[],totalCount:q.usage?1:0,nextBefore:null,serverDay:'2026-11-13',streak:q.usage?1:0};
    }
    else if(path==='/v1/me/rewards')data={memberId:q.owner,vouchers:[],claims:[],moreClaims:false,claimsNextCursor:null,coupons:[]};
    else data=q.points();
    o.success({statusCode:200,data:JSON.parse(JSON.stringify(data)),header:{},cookies:[],errMsg:'request:ok'});
   },35);return{abort(){aborted=true;clearTimeout(timer);o.fail?.({errMsg:'request:fail abort'});}};
  };return{fixtureOwner:q.owner,allHttpIntercepted:true};
 },{questionnaireVersion:careQuestionnaireVersion,questions:careQuestions,sensitiveConsent:{version:careConsentVersion,text:careConsentText}});
 await cli('automation_navigate',['--action','reLaunch','--url','/pages/account/index?intent=login']);await shot('01-official-login','.account-login');
 out.login=await evaluate(async function(){const p=getCurrentPages().slice(-1)[0],q=getApp().__cismeTravelQA;if(p.route!=='pages/account/index')throw Error('NOT_LOGIN');p.toggleAgreement({detail:{value:['accepted']}});await p.loginWithPhone({detail:{code:'synthetic-native-phone-code'}});return{phoneBound:q.phoneBound,identityRequests:q.requests.filter(r=>r.path==='/v1/identity/wechat').length,phoneRequests:q.requests.filter(r=>r.path==='/v1/me/phone').length,sequence:q.requests.filter(r=>r.path==='/v1/identity/wechat'||r.path==='/v1/me/phone').map(r=>r.path)};});
 if(!out.login.phoneBound||out.login.identityRequests!==1||out.login.phoneRequests!==1)throw Error('LOGIN_PHONE_FLOW_INVALID');
 out.setupState=await evaluate(async function(){for(let i=0;i<40;i++){const p=getCurrentPages().slice(-1)[0],c=p.selectComponent('#care-onboarding');if(c?.data.ready||c?.data.error)return{route:p.route,ready:c.data.ready,index:c.data.index,error:c.data.error,extraProfileStep:!!c.data.setupOpen};await new Promise(r=>setTimeout(r,50));}return{timeout:true};});if(!out.setupState.ready||out.setupState.index!==0||out.setupState.extraProfileStep)throw Error('QUESTIONNAIRE_NOT_DIRECT');await shot('02-direct-questionnaire');
 out.completion=await evaluate(async function(){
 const q=getApp().__cismeTravelQA,credit=getCurrentPages().slice(-1)[0].selectComponent('#onboarding-credit'),set=credit.setData.bind(credit);credit.setData=function(p,cb){q.creditTimeline.push({at:Date.now(),...p});const result=set(p,cb);if(p.showing&&p.phase==='spinning')for(const wait of[100,350])setTimeout(()=>{credit.createSelectorQuery().select('.credit-moment__opal').fields({computedStyle:['transform','animation-name']}).exec(rows=>{q.spinSamples=q.spinSamples||[];q.spinSamples.push({at:Date.now(),rows});});},wait);return result;};
 const c=getCurrentPages().slice(-1)[0].selectComponent('#care-onboarding');for(let i=0;i<12;i++){
  if(c.data.consentMode){await c.decideSensitive('declined');continue;}
  const question=c.data.question;if(!question)throw Error('QUESTION_MISSING');c.choose({currentTarget:{dataset:{value:question.options[0].value}}});const complete=c.data.index===9;await c.next();if(complete)return{completed:true,syntheticCareVersion:getApp().__cismeTravelQA.nativeSurvey.profile.version};
 }throw Error('QUESTIONNAIRE_DID_NOT_COMPLETE');});
 out.reward=await evaluate(async function(){const q=getApp().__cismeTravelQA;for(let i=0;i<130;i++){if(q.creditTimeline.some(x=>x.showing===true)&&q.creditTimeline.slice(q.creditTimeline.findIndex(x=>x.showing===true)+1).some(x=>x.showing===false))break;await new Promise(r=>setTimeout(r,25));}const start=q.creditTimeline.findIndex(x=>x.showing===true),timeline=q.creditTimeline.slice(start),at=timeline[0]?.at;return{timeline:timeline.map(x=>({...x,elapsed:x.at-at,at:undefined})),amount:timeline[0]?.amount,showing:getCurrentPages().slice(-1)[0].selectComponent('#onboarding-credit').data.showing,spinSamples:q.spinSamples,grantReads:q.requests.filter(r=>r.path.startsWith('/v1/me/points?')).length};});
 if(out.reward.amount!==100||out.reward.showing||!out.reward.timeline.some(x=>x.phase==='checked')||!out.reward.timeline.some(x=>x.displayAmount===100))throw Error('REWARD_SEQUENCE_INVALID');
 await evaluate(function(){getCurrentPages().slice(-1)[0].selectComponent('#onboarding-credit').setData({showing:true,phase:'settled',amount:100,displayAmount:100,digits:3});});await shot('04-confirmed-points-controlled-visual');await evaluate(function(){getCurrentPages().slice(-1)[0].selectComponent('#onboarding-credit').setData({showing:false});});
 await cli('automation_navigate',['--action','switchTab','--url','/pages/profile/index']);await shot('05-default-profile-with-edit-entry','.profile-identity__title');out.profile=await evaluate(function(){const p=getCurrentPages().slice(-1)[0];return{nickname:p.data.member.display_name,available:p.data.points.projection.available,avatarIsLocal:p.data.memberAvatar.indexOf('cisme-avatar-')>=0,owner:p.data.member.id,repeatedCelebration:p.selectComponent('#onboarding-credit').data.showing};});
 if(out.profile.nickname!=='CISME 会员'||out.profile.avatarIsLocal||out.profile.available!==100||out.profile.repeatedCelebration)throw Error('CANONICAL_PROFILE_NOT_VISIBLE');
 await cli('automation_navigate',['--action','switchTab','--url','/pages/home/index']);
 out.daily=await evaluate(async function(){const p=getCurrentPages().slice(-1)[0],q=getApp().__cismeTravelQA;await p.primaryAction();p.toggleCareProduct({currentTarget:{dataset:{id:'net_run'}}});p.careNoteInput({detail:{value:'洗后头皮清爽，发根也轻盈了一些。'}});q.creditTimeline=[];await p.continueCareUsage();await new Promise(r=>setTimeout(r,3200));const timeline=q.creditTimeline,first=timeline.findIndex(x=>x.showing===true),at=timeline[first]?.at;return{amount:timeline[first]?.amount,timeline:timeline.slice(first).map(x=>({...x,elapsed:x.at-at,at:undefined})),showing:p.selectComponent('#onboarding-credit').data.showing,saved:!!q.usage,error:p.data.error};});
 if(out.daily.amount!==15||out.daily.showing||!out.daily.saved)throw Error('DAILY_SEQUENCE_INVALID:'+JSON.stringify(out.daily));
 await evaluate(function(){getCurrentPages().slice(-1)[0].selectComponent('#onboarding-credit').setData({showing:true,phase:'settled',amount:15,displayAmount:15,digits:2});});await shot('06-daily-credit-controlled-visual');await evaluate(function(){getCurrentPages().slice(-1)[0].selectComponent('#onboarding-credit').setData({showing:false});});
 out.edit=await evaluate(async function(){const p=getCurrentPages().slice(-1)[0],q=getApp().__cismeTravelQA;q.creditTimeline=[];await p.primaryAction();p.careNoteInput({detail:{value:'调整护理感受，洗后头皮清爽。'}});await p.continueCareUsage();await new Promise(r=>setTimeout(r,1200));return{celebrations:q.creditTimeline.filter(x=>x.showing===true).length,version:q.usage?.version,error:p.data.error};});if(out.edit.celebrations||out.edit.version!==2)throw Error('CARE_EDIT_REPEATED_CREDIT');
 await cli('automation_navigate',['--action','navigateTo','--url','/pages/rewards/index']);await shot('06-no-unearned-voucher');
 out.vouchers=await evaluate(function(){const p=getCurrentPages().slice(-1)[0];return{vouchers:p.data.wallet?.vouchers.length,coupons:p.data.wallet?.coupons.length};});if(out.vouchers.vouchers||out.vouchers.coupons)throw Error('UNAUTHORIZED_VOUCHER');
 out.result='passed';
}catch(e){out.error=String(e);throw e;}
finally{
 out.localFixtureCleanup=await evaluate(function(){const q=getApp().__cismeTravelQA,fs=wx.getFileSystemManager(),removed=[];for(const p of q?.createdAvatars??[]){const name=p.split('/').pop();if(p.startsWith(wx.env.USER_DATA_PATH+'/')&&/^cisme-avatar-[a-z0-9]+-\d+-8{64}\.jpg$/.test(name)&&!q.original.localFiles.includes(name)){try{fs.unlinkSync(p);removed.push(name);}catch{}}}return{exactFixtureAvatarFilesRemoved:removed.length};});
 await evaluate(function(){const q=getApp().__cismeTravelQA;if(q?.original.login)wx.login=q.original.login;});out.restore=await restore();out.sourceUnchanged=(await inspectMiniProgramPackage(root+'/apps/miniprogram')).actual.sourceSha256===hash;await writeFile(dir+'/verification.json',JSON.stringify(out,null,2)+'\n');
}
console.log(JSON.stringify({result:out.result,captures:out.captures.length,restore:out.restore,sourceUnchanged:out.sourceUnchanged}));

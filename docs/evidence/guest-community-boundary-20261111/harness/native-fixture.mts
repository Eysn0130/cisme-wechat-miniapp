import{cli,evaluate}from'./native-cli.mts';import{writeFile,mkdir}from'node:fs/promises';
export const dir='/Users/mini/CISME/docs/evidence/guest-community-boundary-20261111',id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export async function setup(){return evaluate(function(){
 const app=getApp();if(!app||Object.keys(app).some(k=>/QA$/.test(k)))throw Error('NOT_READY_OR_QA_ACTIVE');const p=getCurrentPages().slice(-1)[0];
 const original={globalData:{...app.globalData},request:wx.request,login:wx.login,getStorageSync:wx.getStorageSync,getStorageInfoSync:wx.getStorageInfoSync,setStorageSync:wx.setStorageSync,removeStorageSync:wx.removeStorageSync,requirePrivacyAuthorize:wx.requirePrivacyAuthorize,getPrivacySetting:wx.getPrivacySetting,route:p?.route,options:p?.options};
 const q={original,storage:{},requests:[],phone:true,firstMember:false,loginCalls:0,privateGuestReads:0};app.__cismeGuestQA=q;
 wx.getStorageSync=k=>q.storage[k]??'';wx.getStorageInfoSync=()=>({keys:Object.keys(q.storage),currentSize:0,limitSize:10240});wx.setStorageSync=(k,v)=>{q.storage[k]=v;};wx.removeStorageSync=k=>{delete q.storage[k];};
 wx.login=async()=>{q.loginCalls++;return{code:'synthetic-guest-login-code',errMsg:'login:ok'};};
 wx.requirePrivacyAuthorize=o=>o?.success?.({errMsg:'requirePrivacyAuthorize:ok'});wx.getPrivacySetting=o=>o?.success?.({needAuthorization:false,privacyContractName:'合成验收条款',errMsg:'getPrivacySetting:ok'});
 app.globalData={...app.globalData,sessionToken:'',privacyRightsToken:'',apiBaseUrl:'https://synthetic-guest.invalid',cloudFunction:null};
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',authorId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',stamp='2026-11-11T03:00:00Z';
 const article={id,version:1,authorId,author:'示例会员',avatar:'',avatarRevision:null,title:'把日常护理，记成自己的节奏',excerpt:'今天，也照顾好自己。',body:'每一次真实的使用感受，都值得留下。\n按实际使用选择产品，慢慢找到适合自己的日常节奏。',publishedAt:stamp,isMine:false,following:false,liked:false,saved:false,likeCount:0,saveCount:0,aiUsage:'none',media:[],commentsTotal:1,commentCount:1,commentsEnabled:true,commentsPolicyVersion:0,canModerate:false,interactionsEnabled:true,sourceUrl:null,coverUrl:null,provenanceLabel:''};
 const comment={id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',version:1,postId:id,authorId,author:'示例会员',avatar:'',avatarRevision:null,body:'洗后清爽，想了解精华的日常使用方法。',state:'published',isMine:false,liked:false,likeCount:0,parentId:null,replyToId:null,createdAt:stamp};
 wx.request=function(o){let aborted=false;const path=o.url.replace('https://synthetic-guest.invalid',''),clean=path.split('?')[0],method=o.method||'GET',signed=!!app.globalData.sessionToken;const record={path,method,signed,handled:true};q.requests.push(record);const timer=setTimeout(()=>{if(aborted)return;let data,statusCode=200;
  if(clean==='/v1/legal')data={ready:true,documents:[{document_type:'privacy',version:'synthetic-privacy-20261111'},{document_type:'terms',version:'synthetic-terms-20261111'}]};
  else if(clean==='/v1/identity/capabilities')data={phoneBindingEnabled:q.phone};
  else if(clean==='/v1/capabilities')data={communityPreviewEnabled:false};
  else if(clean==='/v1/ugc/status')data={publicEnabled:true,draftsEnabled:false};
  else if(clean==='/v1/feed/page')data={items:[],authors:{},nextCursor:null};
  else if(clean==='/v1/editorial/articles')data={items:[article],nextCursor:null};
  else if(clean==='/v1/ugc/posts')data={items:[],nextCursor:null};
  else if(clean==='/v1/editorial/articles/'+id||clean==='/v1/ugc/posts/'+id)data=article;
  else if(clean==='/v1/editorial/articles/'+id+'/comments'||clean==='/v1/ugc/posts/'+id+'/comments'){
   if(!signed){q.privateGuestReads++;statusCode=401;data={code:'SYNTHETIC_GUEST_COMMENTS_FORBIDDEN',title:'请先登录'};}
   else if(clean.startsWith('/v1/ugc/'))data={items:[comment],nextCursor:null,matchingTotal:1};
   else data={comments:[{...comment,status:'published',replyRootId:comment.id,authorName:comment.author,replyToName:null}],authors:{[authorId]:{name:comment.author,avatar:'',avatarRevision:null}},commentCount:1,commentsEnabled:true,commentsPolicyVersion:0,canModerate:false,loadedCount:1,hasMore:false,nextCursor:null,truncated:false,preview:false,asOf:stamp};
  }else if(clean==='/v1/me/support/summary')data={unreadCount:0};
  else if(clean==='/v1/me/community-access')data={canReview:false};
  else if(clean==='/v1/me/follows')data=[];
  else if(clean==='/v1/me/profile')data={id:authorId,display_name:'合成验收会员',profile_revision:1,avatar_data_url:null,avatar_revision:null};
  else if(clean==='/v1/me')data={id:authorId};
  else if(clean==='/v1/identity/wechat'&&method==='POST')data={sessionToken:'synthetic-guest-member',onboardingRequired:q.firstMember};
  else{record.handled=false;statusCode=404;data={code:'SYNTHETIC_UNDEFINED_ROUTE',title:'合成接口尚未定义'};}
  o.success({statusCode,data:JSON.parse(JSON.stringify(data)),header:{},cookies:[],errMsg:'request:ok'});
 },30);return{abort(){aborted=true;clearTimeout(timer);o.fail?.({errMsg:'request:fail abort'});}};};
 return{installed:true,allHttpIntercepted:true,virtualStorage:true,originalRoute:original.route,originalHasSession:!!original.globalData.sessionToken,width:wx.getWindowInfo().windowWidth};
 });}
export async function restore(){return evaluate(function(){const app=getApp(),q=app.__cismeGuestQA;if(!q)return{absent:true};const p=getCurrentPages().slice(-1)[0];p.onHide?.();p.onUnload?.();const o=q.original;for(const key of ['request','login','getStorageSync','getStorageInfoSync','setStorageSync','removeStorageSync','requirePrivacyAuthorize','getPrivacySetting']){if(o[key]===undefined)delete wx[key];else wx[key]=o[key];}app.globalData=o.globalData;delete app.__cismeGuestQA;wx.reLaunch({url:'/'+(o.route||'pages/account/index')});return{restored:true,privateGuestReads:q.privateGuestReads,syntheticIdentityWrites:q.requests.filter(r=>r.path==='/v1/identity/wechat'&&r.method==='POST').length,actualMemberWrites:0,undefinedRoutes:q.requests.filter(r=>!r.handled),requests:q.requests};});}
export async function waitReady(){return evaluate(async function(){let p=getCurrentPages().slice(-1)[0];for(let i=0;i<30&&(p?.data.loading||p?.data.legalLoading);i++){await new Promise(r=>setTimeout(r,50));p=getCurrentPages().slice(-1)[0];}return{route:p?.route,loading:p?.data.loading,error:p?.data.error};});}
export async function shot(phase:string,name:string){await mkdir(dir+'/'+phase,{recursive:true});const f=await evaluate(function(){const p=getCurrentPages().slice(-1)[0],q=getApp().__cismeGuestQA;return{route:p.route,width:wx.getWindowInfo().windowWidth,loading:p.data.loading,error:p.data.error,notice:p.data.notice,authenticated:!!getApp().globalData.sessionToken,guest:q.storage['cisme.guestBrowsing']===true,returnUrl:p.authenticationReturnUrl,commentAuthenticated:p.data.commentAuthenticated,threads:p.data.threads?.length,privateGuestReads:q.privateGuestReads,requests:q.requests};});await cli('simulator_screenshot',['--path',dir+'/'+phase+'/'+name+'.png']);await writeFile(dir+'/'+phase+'/'+name+'.json',JSON.stringify(f,null,2)+'\n');console.log(name,JSON.stringify({route:f.route,width:f.width,error:f.error,guest:f.guest,commentAuthenticated:f.commentAuthenticated}));return f;}
if(process.argv[2]==='setup')console.log(await setup());
if(process.argv[2]==='restore'){const r=await restore();await writeFile(dir+'/native-restoration.json',JSON.stringify(r,null,2)+'\n');console.log({restored:r.restored,privateGuestReads:r.privateGuestReads,actualMemberWrites:r.actualMemberWrites,undefinedRoutes:r.undefinedRoutes});}

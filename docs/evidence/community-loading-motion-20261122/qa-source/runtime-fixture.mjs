import {evaluate} from './native-client.mjs';
export async function setup(){return evaluate(function(){
  const app=getApp(),page=getCurrentPages().slice(-1)[0];
  if(app.__motionReview)throw Error('A fixture is already active');
  if(app.globalData.sessionToken)throw Error('Guest baseline required; do not replace a real member session');
  const source=page.data.feedColumns?.flat().find(card=>card.image)?.image;
  if(!source)throw Error('A real public image is required');
  const origin=app.globalData.apiBaseUrl.replace(/\/$/,''),cover=source.startsWith(origin)?source.slice(origin.length):source;
  const q={original:{globalData:{...app.globalData},request:wx.request,uploadFile:wx.uploadFile,getStorageSync:wx.getStorageSync,setStorageSync:wx.setStorageSync,removeStorageSync:wx.removeStorageSync,getDeviceInfo:wx.getDeviceInfo},
    cover,origin,storage:{},requests:[],unexpected:[],pending:[],uploads:[],confirmed:[],completeMode:'hold',holdFeatured:true,holdRecommend:false,empty:false,fail:false,failRecommend:true,nextMedia:1,transport:'POST'};
  app.__motionReview=q;
  const card=(id,title)=>({id,title,kind:'editorial',author:'CISME头皮实验室',authorId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',coverUrl:cover,avatar:'',likeCount:0,saveCount:0,publishedAt:'2026-11-22T12:00:00Z'});
  q.cards=[card('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','头皮护理，从了解自己开始'),card('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','记录每一次真实感受')];
  wx.getStorageSync=key=>q.storage[key]??'';wx.setStorageSync=(key,value)=>{q.storage[key]=value;};wx.removeStorageSync=key=>{delete q.storage[key];};
  wx.request=function(options){
    let aborted=false;const path=options.url.startsWith(origin)?options.url.slice(origin.length):options.url,method=options.method||'GET';
    q.requests.push({path,method});
    const deliver=()=>{
      if(aborted)return;let data,statusCode=200;
      if(path==='/v1/capabilities')data={communityPreviewEnabled:false};
      else if(path==='/v1/ugc/status')data={publicEnabled:true,draftsEnabled:true,directPublication:true};
      else if(path==='/v1/me/community-access')data={canReview:false};
      else if(path==='/v1/shares'&&method==='POST')data={shareId:'77777777-7777-4777-8777-777777777777',path:'/pages/community/index'};
      else if(path.startsWith('/v1/community/featured?')){if(q.fail){statusCode=503;data={code:'SYNTHETIC_READ_FAILURE',title:'受控读取失败'};}else data={items:q.empty?[]:q.cards,nextCursor:null};}
      else if(path.startsWith('/v1/feed/page?')){if(q.denyLegacy){statusCode=403;data={code:'SYNTHETIC_READ_DENIED'};}else if(q.fail||q.failRecommend){statusCode=503;data={code:'SYNTHETIC_READ_FAILURE'};}else data={items:[],nextCursor:null};}
      else if(path.startsWith('/v1/ugc/posts?')){if(q.fail||q.failRecommend||q.failFormal){statusCode=503;data={code:'SYNTHETIC_READ_FAILURE'};}else data={items:q.empty?[]:[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',title:'推荐中的真实读取状态',authorId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',author:'合成会员',likeCount:0,coverId:null}],nextCursor:null};}
      else if(path.startsWith('/v1/me/community/following?'))data={items:[],nextCursor:null};
      else if(path==='/v1/me/ugc/posts/11111111-1111-4111-8111-111111111111')data={id:'11111111-1111-4111-8111-111111111111',ownerId:'22222222-2222-4222-8222-222222222222',state:'draft',version:1,revision:1,title:'今天的护理记录',body:'本次素材仅用于隔离验收。',media:[],publicVersionActive:false};
      else if(path.endsWith('/media/authorize')&&method==='POST')data={mediaId:`33333333-3333-4333-8333-${String(q.nextMedia++).padStart(12,'0')}`,url:origin+'/synthetic-review-upload',method:q.transport,fields:{}};
      else if(path.endsWith('/complete')&&method==='POST'){
        const id=path.split('/').at(-2);if(!q.confirmed.includes(id))q.confirmed.push(id);
        if(q.completeMode==='lost'){options.fail({errMsg:'request:fail timeout'});return;}
        data={id,state:'uploaded'};
      }
      else if(path.endsWith('/preview-url')){
        const id=path.split('/').at(-2);
        if(q.confirmed.includes(id))data={url:'/assets/cisme/cisme-scalp-lab-avatar-v1.jpg'};
        else{statusCode=404;data={code:'UGC_MEDIA_NOT_FOUND',title:'尚不能确认这张图片'};}
      }
      else if(path==='/synthetic-review-upload'&&method==='PUT')data={};
      else{q.unexpected.push({path,method});options.fail({errMsg:'SYNTHETIC_REQUEST_BLOCKED'});return;}
      options.success({statusCode,data});options.complete?.({statusCode,data});
    };
    const held=q.holdFeatured&&path.startsWith('/v1/community/featured?')||q.holdRecommend&&(path.startsWith('/v1/feed/page?')||path.startsWith('/v1/ugc/posts?'))||q.holdFormal&&path.startsWith('/v1/ugc/posts?')||q.completeMode==='hold'&&path.endsWith('/complete')||path==='/synthetic-review-upload'&&method==='PUT';
    if(held)q.pending.push({path,deliver});else setTimeout(deliver,15);
    return {abort(){if(aborted)return;aborted=true;options.fail({errMsg:'request:fail abort'});}};
  };
  wx.uploadFile=function(options){const task={options,listeners:[]};q.uploads.push(task);return {
    onProgressUpdate(fn){task.listeners.push(fn);},offProgressUpdate(fn){task.listeners=task.listeners.filter(item=>item!==fn);},abort(){options.fail({errMsg:'uploadFile:fail abort'});}
  };};
  app.globalData={...app.globalData,sessionToken:'synthetic-motion-review',cloudFunction:null};
  return {controlled:true,realWrites:0,coverFromRealAnonymousRead:true};
});}
export async function configure(patch){return evaluate(function(patch){Object.assign(getApp().__motionReview,patch);return true;},patch);}
export async function release(prefix){return evaluate(function(prefix){const q=getApp().__motionReview,selected=q.pending.filter(item=>item.path.startsWith(prefix));q.pending=q.pending.filter(item=>!selected.includes(item));for(const item of selected)item.deliver();return selected.length;},prefix);}
export async function state(){return evaluate(function(){const p=getCurrentPages().slice(-1)[0],q=getApp().__motionReview;return {route:p.route,width:wx.getWindowInfo().windowWidth,loading:p.data.loading,feedReady:p.data.feedReady,count:p.data.displayFeedCount,mode:p.data.mode,error:p.data.error,reducedMotion:p.data.reducedMotion,
  files:p.data.files?.map(file=>({id:file.id,state:file.state,phase:file.uploadPhase,progress:file.progress,known:file.progressKnown,confirmationPending:file.confirmationPending,retryReady:file.confirmationRetryReady,error:file.error})),unexpected:q?.unexpected,requests:q?.requests.length};});}
export async function beginUpload(){return evaluate(async function(){const app=getApp(),p=getCurrentPages().slice(-1)[0],q=app.__motionReview;
  if(p.route!=='pages/community-compose/index'||!p.data.postId)throw Error('Composer required');
  const path='/assets/cisme/cisme-scalp-lab-avatar-v1.jpg',size=await new Promise((resolve,reject)=>wx.getFileSystemManager().getFileInfo({filePath:path,success:value=>resolve(value.size),fail:reject}));
  q.transferSize=size;const id='local-synthetic-'+Date.now();p.setData({dirty:true,uploadBusy:true,files:[{id,localPath:path,previewUrl:'',size,state:'uploading',progress:0,error:''}]});
  q.operation=p.uploadImage(id,path,size,p.data.epoch,app.globalData.sessionToken,++p.mediaEpoch).finally(()=>{if(p.mediaVisible)p.setData({uploadBusy:false});});return {size};
});}
export async function progress(percent){return evaluate(function(percent){const q=getApp().__motionReview,task=q.uploads.at(-1);for(const listener of task.listeners)listener({progress:percent,totalBytesSent:Math.round(q.transferSize*percent/100),totalBytesExpectedToSend:q.transferSize});return true;},percent);}
export async function finishUpload(){return evaluate(function(){getApp().__motionReview.uploads.at(-1).options.success({statusCode:201});return true;});}
export async function restore(){return evaluate(function(){const app=getApp(),q=app.__motionReview;if(!q)return {restored:false};
  const page=getCurrentPages().slice(-1)[0];page.setData({dirty:false});page.onHide?.();
  page.syncUnloadWarning?.();Object.assign(wx,{request:q.original.request,uploadFile:q.original.uploadFile,getStorageSync:q.original.getStorageSync,setStorageSync:q.original.setStorageSync,removeStorageSync:q.original.removeStorageSync,getDeviceInfo:q.original.getDeviceInfo});
  app.globalData=q.original.globalData;const unexpected=q.unexpected;delete app.__motionReview;
  return {restored:true,realWrites:0,unexpected,syntheticStorageDiscarded:true,signedIn:!!app.globalData.sessionToken};
});}
if(process.argv[2]==='setup')console.log(JSON.stringify(await setup()));
if(process.argv[2]==='state')console.log(JSON.stringify(await state()));
if(process.argv[2]==='restore')console.log(JSON.stringify(await restore()));

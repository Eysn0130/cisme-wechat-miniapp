import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {cli,evaluate} from '../qa-source/native-client.mjs';
import {setup,configure,release,restore,beginUpload,finishUpload} from '../qa-source/runtime-fixture.mjs';
const width=process.argv[2],directory=new URL('./',import.meta.url).pathname.replace(/\/$/,'');
const results=[];
const save=(name,facts)=>{results.push({name,passed:true,facts});console.log(name+' passed');};
const state=()=>evaluate(function(){const p=getCurrentPages().at(-1);return {mode:p.data.mode,count:p.data.displayFeedCount,loading:p.data.loading,more:p.data.formalLoadingMore,cursor:p.data.formalNextCursor,error:p.data.error,capabilityError:p.data.capabilityError,ugc:p.data.ugcFeedEnabled,drafts:p.data.ugcDraftsEnabled};});
const ready=()=>evaluate(async function(){const p=getCurrentPages().at(-1);for(let i=0;i<200&&(p.data.loading||p.pendingFeedRead);i++)await new Promise(r=>setTimeout(r,25));return true;});
let active=false;
try{
  await cli('automation_navigate',['--action','switchTab','--url','/pages/community/index']);await ready();
  await setup();active=true;await configure({holdFeatured:false,failRecommend:false});
  await evaluate(function(){const q=getApp().__motionReview,interceptor=wx.request;q.extra={};
    wx.request=function(options){const path=options.url.startsWith(q.origin)?options.url.slice(q.origin.length):options.url;
      if(q.extra.holdCapability===path){let aborted=false;q.pending.push({path,deliver:()=>{if(!aborted)wx.request(options);}});return {abort(){aborted=true;options.fail({errMsg:'request:fail abort'});}};}
      const success=options.success;return interceptor({...options,success(response){
        if(q.extra.failCapability===path)response={statusCode:503,data:{code:'SYNTHETIC_STATUS_UNAVAILABLE'}};
        if(q.extra.denyCapability===path)response={statusCode:403,data:{code:'SYNTHETIC_STATUS_DENIED'}};
        if(q.extra.revokePath&&path.startsWith(q.extra.revokePath))response={statusCode:401,data:{code:'AUTH_REVOKED'}};
        if(response.statusCode===200&&path.startsWith('/v1/me/community/following?'))response={...response,data:{items:[{...q.cards[0],kind:'editorial'}],nextCursor:'native-next'}};
        success(response);
      }});
    };return true;
  });
  await evaluate(async function(){const p=getCurrentPages().at(-1);p.setData({mode:'recommend'});await p.load();return true;});
  for(const path of ['/v1/capabilities','/v1/ugc/status']){
    await evaluate(async function(path){const p=getCurrentPages().at(-1),q=getApp().__motionReview;q.extra={failCapability:path};await p.load();return true;},path);
    const value=await state();assert.equal(value.mode,'recommend');assert.equal(value.count,1);assert.ok(value.capabilityError);assert.equal(value.drafts,path!=='/v1/ugc/status');save('capability-failure-'+path.split('/').at(-1),value);
  }
  await evaluate(async function(){const p=getCurrentPages().at(-1),q=getApp().__motionReview;q.extra={};await p.load();q.extra={denyCapability:'/v1/ugc/status',holdCapability:'/v1/capabilities'};void p.load();await new Promise(r=>setTimeout(r,250));return true;});
  const denied=await state();assert.equal(denied.count,0);assert.equal(denied.loading,false);assert.equal(denied.cursor,null);assert.equal(denied.drafts,false);save('capability-denial-before-other-result',denied);
  await evaluate(function(){getApp().__motionReview.extra.holdCapability='';return true;});await release('/v1/capabilities');await ready();
  for(const stage of ['after-read','before-read']){
    await evaluate(async function(stage){const a=getApp(),p=getCurrentPages().at(-1),q=a.__motionReview;q.extra={};a.globalData.sessionToken='synthetic-extra-'+stage;p.setData({mode:'following'});await p.loadFollowing();
      if(stage==='before-read'){q.holdFeatured=true;p.setData({mode:'featured'});void p.load();}
      q.extra.revokePath='/v1/shares';await p.prepareCommunityShare();for(let i=0;i<80&&p.data.loading;i++)await new Promise(r=>setTimeout(r,25));return true;
    },stage);
    const value=await state();assert.equal(value.count,0);assert.equal(value.loading,false);assert.equal(value.more,false);assert.ok(value.error.includes('登录状态已失效'));save('revoked-share-'+stage,value);
  }
  await evaluate(function(){const a=getApp(),q=a.__motionReview;q.extra={};q.holdFeatured=false;a.globalData.sessionToken='synthetic-extra-upload';return true;});
  await cli('automation_navigate',['--action','navigateTo','--url','/pages/community-compose/index?id=11111111-1111-4111-8111-111111111111']);
  await ready();await beginUpload();await finishUpload();
  const persisted=await evaluate(function(){const p=getCurrentPages().at(-1),q=getApp().__motionReview,file=p.data.files[0];
    const saved=Object.values(q.storage).some(value=>value?.mediaItems?.some(item=>item.id===file.id&&item.confirmationPending===true));
    p.previewFailed({currentTarget:{dataset:{id:file.id,epoch:p.data.epoch,preview:file.localPath}}});
    return {saved,confirmationPending:file.confirmationPending,error:p.data.files[0].error,phase:p.data.files[0].uploadPhase};
  });assert.equal(persisted.saved,true);assert.equal(persisted.confirmationPending,true);assert.ok(persisted.error.includes('核对'));save('pending-confirmation-durable-before-response-and-preview-expiry',persisted);
  await configure({completeMode:'success'});await release('/v1/me/ugc/posts/11111111-1111-4111-8111-111111111111/media/');
  await evaluate(async function(){await getApp().__motionReview.operation;return true;});
}finally{
  if(active){const cleanup=await restore();assert.equal(cleanup.restored,true);assert.deepEqual(cleanup.unexpected,[]);await writeFile(`${directory}/${width}-extra-cleanup.json`,JSON.stringify(cleanup,null,2)+'\n');}
  await writeFile(`${directory}/${width}-extra-results.json`,JSON.stringify({scope:'Native DevTools, actual application API/session handling with intercepted JSON and upload callbacks; no real member writes.',results},null,2)+'\n');
}

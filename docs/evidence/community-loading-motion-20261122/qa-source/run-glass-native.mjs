import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {cli,evaluate,capture,directory} from './native-client.mjs';
const width=process.argv[2],facts={scope:'Controlled member data and backdrop specimens in the official native simulator; no real member writes.'};
let active=false;
try{
  facts.setup=await evaluate(async function(){
    const app=getApp();if(app.globalData.sessionToken||app.__motionReview||app.__glassReview)throw Error('Anonymous baseline required');
    const original={globalData:app.globalData,request:wx.request,uploadFile:wx.uploadFile,getStorageSync:wx.getStorageSync,setStorageSync:wx.setStorageSync,removeStorageSync:wx.removeStorageSync,getDeviceInfo:wx.getDeviceInfo,switchTab:wx.switchTab,pageScrollTo:wx.pageScrollTo};
    const origin='https://cisme-tabbar-qa.invalid',member={id:'b95d9d5a-3423-4943-ad70-04f26af8224e',display_name:'模拟会员',profile_revision:1,avatar_data_url:'/assets/icons/user-active.svg',avatar_revision:null,completed_at:'2026-11-20T12:00:00Z'};
    const q=app.__glassReview={original,storage:{},network:[]};
    wx.getStorageSync=key=>q.storage[key]??'';wx.setStorageSync=(key,value)=>{q.storage[key]=value;};wx.removeStorageSync=key=>{delete q.storage[key];};
    wx.uploadFile=options=>{options.fail({errMsg:'CONTROLLED_UPLOAD_BLOCKED'});return {abort(){}};};
    wx.request=options=>{
      const path=options.url.startsWith(origin)?options.url.slice(origin.length).split('?')[0]:'blocked-origin',method=options.method||'GET';q.network.push({path,method});
      let reply;if(method==='GET'){
        if(path==='/v1/me')reply=member;
        else if(path==='/v1/capabilities')reply={communityPreviewEnabled:false};
        else if(path==='/v1/ugc/status')reply={publicEnabled:false,draftsEnabled:false};
        else if(path==='/v1/catalog'||path==='/v1/community/featured'||path==='/v1/feed/page'||path==='/v1/ugc/posts')reply={items:[],nextCursor:null};
        else if(path==='/v1/bootstrap/profile')reply={member,points:{projection:{available:0,version:1}},care:null,businessVersion:1};
        else if(path==='/v1/bootstrap/home')reply={member,care:null,businessVersion:1,onboardingRequired:false};
      }
      let cancelled=false;setTimeout(()=>{if(!cancelled)options.success?.({statusCode:reply?200:403,data:reply??{code:'CONTROLLED_REQUEST_BLOCKED'},header:{}});},12);
      return {abort(){cancelled=true;}};
    };
    app.globalData={...app.globalData,apiBaseUrl:origin,cloudFunction:null,sessionToken:'synthetic-glass-review',privacyRightsToken:'',sessionStorageKey:'cisme.tabbar.review'};
    app.onShow({});await new Promise(r=>setTimeout(r,150));
    for(const name of ['home','shop','profile','community']){await new Promise((resolve,reject)=>wx.switchTab({url:'/pages/'+name+'/index',success:resolve,fail:reject}));await new Promise(r=>setTimeout(r,170));}
    return {controlled:true,allRequestsIntercepted:true,realWrites:0,width:wx.getWindowInfo().windowWidth};
  });active=true;assert.equal(String(facts.setup.width),width);
  facts.transitions=[];
  for(const index of [0,1,0,2,1,2,3,0,3,1,3,2])facts.transitions.push(await evaluate(async function(index){
    const p=()=>getCurrentPages().at(-1),tab=()=>p()?.getTabBar?.(),source=p().route,frames=[];
    // A query started on the outgoing page can lose its callback when hidden.
    // Sample without awaiting each query and bound each native tool invocation.
    const timer=setInterval(()=>{const page=p(),t=tab();if(!t)return;
      const state={route:page.route,active:t.data.active,lensOffset:t.data.lensOffset};
      t.createSelectorQuery().select('.bar__lens-track').fields({rect:true,size:true,computedStyle:['transform','animationName']},value=>{if(value)frames.push({...state,...value});}).exec();
    },16);
    setTimeout(()=>tab()?.switchTab({currentTarget:{dataset:{index}}}),35);
    await new Promise(r=>setTimeout(r,850));clearInterval(timer);await new Promise(r=>setTimeout(r,40));
    return {source,index,target:p().route,frames};
  },index));
  for(const run of facts.transitions){
    assert.equal(run.target,['pages/home/index','pages/shop/index','pages/community/index','pages/profile/index'][run.index]);
    const frames=run.frames.filter(f=>f.active===run.index),scales=frames.map(f=>Number(f.transform?.match(/^matrix\(([^,]+)/)?.[1]));
    assert.ok(Math.max(...scales)>1.03);assert.ok(Math.min(...scales)<.99);assert.ok(Math.abs(scales.at(-1)-1)<.001);
  }
  facts.geometry=await evaluate(function(){const p=getCurrentPages().at(-1),t=p.getTabBar(),w=wx.getWindowInfo();return new Promise(resolve=>{
    const query=t.createSelectorQuery();query.select('.bar').fields({rect:true,size:true,computedStyle:['backdropFilter','backgroundImage','backgroundColor']});query.selectAll('.bar__item').fields({rect:true,size:true,computedStyle:['color','fontSize','fontWeight']});query.exec(([bar,items])=>resolve({width:w.windowWidth,height:w.windowHeight,safeBottom:w.screenHeight-w.safeArea.bottom,bar,items}));
  });});
  assert.equal(facts.geometry.items.length,4);assert.ok(facts.geometry.items.every(r=>r.width>=44&&r.height>=44));assert.ok(facts.geometry.bar.backdropFilter.includes('20px'));
  // Tap the lower body of the middle item, below the separate publish FAB.
  const item=facts.geometry.items[1];
  try{
    await cli('automation_element_action',['--action','tap','--x',String(item.left+item.width/2),'--y',String(item.top+item.height*.8)]);
    facts.nativeTap=await evaluate(async function(){await new Promise(r=>setTimeout(r,330));const p=getCurrentPages().at(-1);return {status:'passed',route:p.route,active:p.getTabBar().data.active};});assert.equal(facts.nativeTap.route,'pages/shop/index');
  }catch(error){
    const message=error.stdout?JSON.parse(error.stdout).message:String(error);
    if(!message.includes('App.CDPEnable unimplemented'))throw error;
    facts.nativeTap={status:'not_validated',toolError:message,...await evaluate(function(){return {route:getCurrentPages().at(-1).route};})};
  }
  await evaluate(async function(){getCurrentPages().at(-1).getTabBar().switchTab({currentTarget:{dataset:{index:2}}});await new Promise(r=>setTimeout(r,400));return true;});
  facts.edges=await evaluate(async function(){
    const app=getApp(),q=app.__glassReview,p=getCurrentPages().at(-1),t=p.getTabBar(),from=t.data.active,scroll=[];
    wx.pageScrollTo=options=>{scroll.push({scrollTop:options.scrollTop,duration:options.duration});};t.switchTab({currentTarget:{dataset:{index:from}}});wx.pageScrollTo=q.original.pageScrollTo;
    t.setPresentation('glass-review',true);t.switchTab({currentTarget:{dataset:{index:1}}});const hiddenBlocked=getCurrentPages().at(-1)===p;t.setPresentation('glass-review',false);
    let failed=0;wx.switchTab=options=>{failed++;setTimeout(()=>options.fail({errMsg:'CONTROLLED_SWITCH_FAILURE'}),30);};t.switchTab({currentTarget:{dataset:{index:1}}});t.switchTab({currentTarget:{dataset:{index:3}}});await new Promise(r=>setTimeout(r,90));wx.switchTab=q.original.switchTab;
    const failureRecovered=!t.data.switching&&t.data.active===from&&failed===1;
    const originalPublisher=p.openPublisher;let publisherCalls=0;p.openPublisher=()=>{publisherCalls++;};t.setCommunityPublisherAvailable(true);t.activateCommunityFab();p.openPublisher=originalPublisher;t.setCommunityPublisherAvailable(false);
    wx.getDeviceInfo=()=>({...q.original.getDeviceInfo(),benchmarkLevel:5});t.syncActive(from);
    const reduced=await new Promise(resolve=>{const query=t.createSelectorQuery();query.select('.bar').fields({computedStyle:['backdropFilter','backgroundColor']});query.select('.bar__lens-track').fields({computedStyle:['animationName','transform']});query.exec(([bar,lens])=>resolve({enabled:t.data.reducedMotion,bar,lens}));});
    wx.getDeviceInfo=q.original.getDeviceInfo;t.syncActive(from);
    return {repeatTap:scroll,hiddenBlocked,failureRecovered,publisherCalls,reduced};
  });
  assert.deepEqual(facts.edges.repeatTap,[{scrollTop:0,duration:0}]);assert.equal(facts.edges.hiddenBlocked,true);assert.equal(facts.edges.failureRecovered,true);assert.equal(facts.edges.publisherCalls,1);assert.equal(facts.edges.reduced.enabled,true);assert.equal(facts.edges.reduced.bar.backdropFilter,'none');assert.equal(facts.edges.reduced.lens.animationName,'none');
  facts.backdrops=[];
  for(const [name,background] of [['light','linear-gradient(120deg,#eef2f7,#ffffff)'],['warm','linear-gradient(120deg,#e8c8a5,#f5ebe0)'],['dark','linear-gradient(120deg,#0d1728,#2a203a)'],['busy','repeating-linear-gradient(45deg,#171320 0px,#171320 3px,#ffffff 3px,#ffffff 6px)']]){
    const state=await evaluate(async function(background){const t=getCurrentPages().at(-1).getTabBar();t.setData({chromeStyle:getApp().globalData.chromeStyle+';background:'+background+';'});await new Promise(r=>setTimeout(r,150));return {active:t.data.active,reduced:t.data.reducedMotion,background};},background);
    await capture('glass-'+width+'-'+name);facts.backdrops.push({name,...state,screenshot:'glass-'+width+'-'+name+'.png'});
  }
}finally{
  if(active)facts.cleanup=await evaluate(async function(){
    const app=getApp(),q=app.__glassReview;if(!q)return {restored:false};
    if(getCurrentPages().at(-1).route!=='pages/community/index')await new Promise((resolve,reject)=>q.original.switchTab({url:'/pages/community/index',success:resolve,fail:reject}));
    const p=getCurrentPages().at(-1);p.onHide();Object.assign(wx,{request:q.original.request,uploadFile:q.original.uploadFile,getStorageSync:q.original.getStorageSync,setStorageSync:q.original.setStorageSync,removeStorageSync:q.original.removeStorageSync,getDeviceInfo:q.original.getDeviceInfo,switchTab:q.original.switchTab,pageScrollTo:q.original.pageScrollTo});
    app.globalData=q.original.globalData;const blockedWriteRequests=q.network.filter(row=>row.method!=='GET').length;delete app.__glassReview;
    p.readVisible=true;p.setData({signedIn:false,motionActive:true});p.getTabBar().setData({chromeStyle:app.globalData.chromeStyle});void p.load();
    return {restored:true,realWrites:0,allNetworkIntercepted:true,blockedWriteRequests,syntheticStorageDiscarded:true};
  });
  await writeFile(directory+'/glass-'+width+'-native.json',JSON.stringify(facts,null,2)+'\n');
}
assert.equal(facts.cleanup.restored,true);console.log(JSON.stringify({width,transitions:facts.transitions.length,scenes:facts.backdrops.length,nativeTap:facts.nativeTap,edges:'passed',restored:true}));

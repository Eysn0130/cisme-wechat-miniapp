import {evaluate} from './native-client.mjs';

// Source hot reload can restore the IDE's persisted login. Preserve it only
// in runtime memory; the controlled suite still starts from an anonymous read.
export async function isolate(){return evaluate(async function(){
  const app=getApp(),page=getCurrentPages().at(-1);
  if(app.__motionReview||app.__motionSessionBaseline)throw Error('Another review is active');
  const original=app.globalData;
  page.onHide?.();
  app.__motionSessionBaseline={original};
  app.globalData={...original,sessionToken:'',privacyRightsToken:''};
  if(page.route==='pages/community/index'){
    page.readVisible=true;page.setData({signedIn:false,mode:'featured',motionActive:true});void page.load();
  }else await new Promise((resolve,reject)=>wx.switchTab({url:'/pages/community/index',success:resolve,fail:reject}));
  return {isolated:true,originalSessionPreservedInMemory:true,persistentStorageChanged:false};
});}
export async function restore(){return evaluate(function(){
  const app=getApp(),baseline=app.__motionSessionBaseline,page=getCurrentPages().at(-1);
  if(app.__motionReview)throw Error('Restore the controlled transport first');
  if(!baseline)throw Error('No preserved session baseline');
  page.onHide?.();app.globalData=baseline.original;delete app.__motionSessionBaseline;
  if(page.route==='pages/community/index'){
    page.readVisible=true;page.setData({signedIn:Boolean(app.globalData.sessionToken),motionActive:true});void page.load();
  }
  return {restored:true,originalGlobalDataRestored:app.globalData===baseline.original,persistentStorageChanged:false,controlledFixturePresent:false};
});}

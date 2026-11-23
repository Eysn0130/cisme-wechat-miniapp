import {evaluate} from './native-client.mjs';

// Runtime-only synthetic presentation fixture. This file is outside the native
// package. All transport and storage are isolated before the fake session exists.
export async function install(){return evaluate(async function(){
  const app=getApp(),page=getCurrentPages().slice(-1)[0];
  if(!['pages/settings/index','pages/account/index'].includes(page.route)||page.data.loading||page.data.addressesLoading)throw Error('Settled settings or guest account baseline required');
  if(app.__settingsReview)throw Error('Fixture already installed');
  const methods=['request','uploadFile','getStorageSync','setStorageSync','removeStorageSync'];
  const q={globalData:app.globalData,original:Object.fromEntries(methods.map(key=>[key,wx[key]])),storage:{},extra:{},requests:[],blockedWrites:0,unexpected:[],admin:false,failConsents:false,failAddresses:false};
  app.__settingsReview=q;
  q.profile={id:'synthetic-settings-member',user_code:'TESTCODE0001',card_number:'00042',display_name:'合成会员',wechat_handle:'',profile_revision:1,completed_at:'2026-11-22T00:00:00Z',registration_completed_at:'2026-11-22T00:00:00Z',avatar_data_url:null,avatar_revision:null,public_status:'private',birthday_month_day:null};
  q.consents=[];
  wx.getStorageSync=key=>q.storage[key]??'';
  wx.setStorageSync=(key,value)=>{q.storage[key]=value;};
  wx.removeStorageSync=key=>{delete q.storage[key];};
  wx.uploadFile=function(options){q.blockedWrites++;setTimeout(()=>options.fail?.({errMsg:'Synthetic review: upload blocked'}),0);return {abort(){}};};
  wx.request=function(options){
    const path=options.url.replace(/^https?:\/\/[^/]+/,'').split('?')[0],method=(options.method||'GET').toUpperCase();
    q.requests.push({method,path});
    let data,error=false;
    if(method!=='GET'){q.blockedWrites++;error=true;}
    else if(Object.prototype.hasOwnProperty.call(q.extra,path))data=q.extra[path];
    else if(path==='/v1/bootstrap/settings')data={settings:{profile:q.profile,phone:{enabled:true,bound:false},consents:q.consents}};
    else if(path==='/v1/me/profile')data=q.profile;
    else if(path==='/v1/me')data={...q.profile,avatar_data_url:'synthetic-retained-entry-shape-only'};
    else if(path==='/v1/legal')data={ready:true,documents:[{document_type:'privacy',version:'synthetic-privacy'},{document_type:'terms',version:'synthetic-terms'}]};
    else if(path==='/v1/me/addresses'){data={enabled:true,maxAddresses:10,addresses:[]};error=q.failAddresses;}
    else if(path==='/v1/me/authority')data={version:1,managementAvailable:q.admin,capabilities:q.admin?['member.profile.read']:[]};
    else if(path==='/v1/me/consents'){data=q.consents;error=q.failConsents;}
    else{q.unexpected.push({method,path});error=true;}
    let aborted=false;
    setTimeout(()=>{
      if(aborted)return;
      if(error)options.fail?.({errMsg:'request:fail synthetic offline'});
      else options.success?.({statusCode:200,data,header:{}});
      options.complete?.({});
    },80);
    return {abort(){aborted=true;},onHeadersReceived(){},offHeadersReceived(){}};
  };
  app.globalData={...app.globalData,sessionToken:'synthetic-settings-review',privacyRightsToken:'',cloudFunction:null};
  if(page.route==='pages/settings/index'){
    page.profileSessionToken='';page.clearMemberSnapshot();page.profileVisible=true;
    await Promise.all([page.loadSettingsBootstrap(),page.loadAddresses(),page.loadManagementAccess()]);
  }else{
    // Exercise the existing readonly retained-session gate with synthetic data.
    // No login, legal acceptance or real identity is created or changed.
    page.authenticationReturnUrl='/pages/settings/index';page.setData({leaving:false});
    await page.restoreRetainedSession();
  }
  return {installed:true,route:getCurrentPages().slice(-1)[0].route,persistedWrites:0};
});}

export async function restore(){return evaluate(function(){
  const app=getApp(),q=app.__settingsReview;if(!q)return {restored:false};
  const page=getCurrentPages().slice(-1)[0];
  page.data.profileDirty=false;page.data.addressDirty=false;
  if(page.route==='pages/settings/index'){page.clearMemberSnapshot();page.profileSessionToken='';}
  Object.assign(wx,q.original);app.globalData=q.globalData;
  const result={restored:true,originalSessionRestored:app.globalData===q.globalData,signedInAfterRestore:!!app.globalData.sessionToken,storageRestored:wx.getStorageSync===q.original.getStorageSync&&wx.setStorageSync===q.original.setStorageSync&&wx.removeStorageSync===q.original.removeStorageSync,transportRestored:wx.request===q.original.request&&wx.uploadFile===q.original.uploadFile,blockedWrites:q.blockedWrites,unexpected:q.unexpected,syntheticReadCount:q.requests.length};
  delete app.__settingsReview;if(page.route==='pages/settings/index'&&app.globalData.sessionToken)page.onShow();else wx.navigateBack();return result;
});}

if(process.argv[2]==='install')console.log(JSON.stringify(await install()));
if(process.argv[2]==='restore')console.log(JSON.stringify(await restore()));

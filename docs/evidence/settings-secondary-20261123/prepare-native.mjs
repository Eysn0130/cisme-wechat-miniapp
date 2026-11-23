import {cli,evaluate} from '../settings-polish-20261122/native-client.mjs';
import {install} from '../settings-polish-20261122/runtime-fixture.mjs';
if(process.argv[2]){
 const result=await cli('simulator_set_device',['--device',process.argv[2]]);
 if(result.success===false)throw Error('Device change rejected');
}
const state=await evaluate(async function(){
 for(let i=0;i<200;i++){
  const app=getApp(),page=getCurrentPages().slice(-1)[0];
  if(app&&page)return {fixture:!!app.__settingsReview,route:page.route,signedIn:!!app.globalData.sessionToken};
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 throw Error('App runtime did not become ready');
});
if(!state.fixture){
 if(!['pages/settings/index','pages/account/index'].includes(state.route))await cli('automation_navigate',['--action','navigateTo','--url','/pages/settings/index']);
 const baseline=await evaluate(async function(){
  for(let i=0;i<200;i++){
   const p=getCurrentPages().slice(-1)[0];
   if(p&&['pages/settings/index','pages/account/index'].includes(p.route)&&!p.data.loading&&!p.data.addressesLoading)
    return {route:p.route,settled:true,signedIn:!!getApp().globalData.sessionToken};
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Readonly baseline did not settle');
 });
 console.log(JSON.stringify({baseline}));console.log(JSON.stringify(await install()));
}
console.log(JSON.stringify(await evaluate(function(){return {route:getCurrentPages().slice(-1)[0]?.route,fixture:!!getApp().__settingsReview,width:wx.getWindowInfo().windowWidth};})));

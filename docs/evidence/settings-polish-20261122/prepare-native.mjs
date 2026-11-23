import {cli,evaluate} from './native-client.mjs';
import {install} from './runtime-fixture.mjs';

const device=process.argv[2];
if(device){
  const result=await cli('simulator_set_device',['--device',device]);
  if(result.success===false)throw Error('Device switch rejected');
}
let state=await evaluate(function(){return {route:getCurrentPages().slice(-1)[0]?.route,fixture:!!getApp().__settingsReview};});
if(!state.fixture){
  if(!['pages/settings/index','pages/account/index'].includes(state.route))
    await cli('automation_navigate',['--action','navigateTo','--url','/pages/settings/index']);
  state=await evaluate(async function(){
    for(let i=0;i<200;i++){
      const p=getCurrentPages().slice(-1)[0];
      if(p&&['pages/settings/index','pages/account/index'].includes(p.route)&&!p.data.loading&&!p.data.addressesLoading)
        return {route:p.route,settled:true,signedIn:!!getApp().globalData.sessionToken};
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return {settled:false};
  });
  if(!state.settled)throw Error('Readonly baseline did not settle within 20 seconds');
  console.log(JSON.stringify({baseline:state}));
  console.log(JSON.stringify(await install()));
}
console.log(JSON.stringify(await evaluate(async function(){
  for(let i=0;i<100;i++){
    const p=getCurrentPages().slice(-1)[0];
    if(p?.route==='pages/settings/index'&&!p.data.loading&&!p.data.addressesLoading)
      return {route:p.route,fixture:!!getApp().__settingsReview,width:wx.getWindowInfo().windowWidth,profileReady:p.data.profileReady};
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Synthetic native settings did not settle');
})));

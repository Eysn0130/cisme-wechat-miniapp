import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {cli,evaluate,capture,directory} from './native-client.mjs';
const compiles=[];
for(const [tool,path] of [['compile_wxml','pages/community/index.wxml'],['compile_wxss','pages/community/index.wxss'],['compile_wxml','templates/community-feed.wxml'],['compile_wxml','pages/community-compose/index.wxml'],['compile_wxss','pages/community-compose/index.wxss'],['compile_wxml','custom-tab-bar/index.wxml'],['compile_wxss','custom-tab-bar/index.wxss']]){
  const result=await cli(tool,['--file-path',path]);assert.equal(result.success,true);compiles.push({tool,path,...result});
}
await writeFile(directory+'/native-compilation.json',JSON.stringify({compiles,scope:'Seven local WXML/WXSS compilation checks, not all routes or physical-device acceptance.'},null,2)+'\n');
await cli('automation_navigate',['--action','switchTab','--url','/pages/community/index']);
const restored=await evaluate(async function(){const app=getApp(),p=getCurrentPages().at(-1);for(let i=0;i<120&&p.data.loading;i++)await new Promise(resolve=>setTimeout(resolve,25));
  const w=wx.getWindowInfo(),base=wx.getAppBaseInfo();return {route:p.route,width:w.windowWidth,height:w.windowHeight,safeBottom:w.screenHeight-(w.safeArea?.bottom??w.screenHeight),sdkVersion:base.SDKVersion,guest:!app.globalData.sessionToken,
    controlledFixturePresent:!!app.__motionReview,loading:p.data.loading,count:p.data.displayFeedCount,error:p.data.error};
});
assert.equal(restored.guest,true);assert.equal(restored.controlledFixturePresent,false);assert.equal(restored.loading,false);assert.ok(restored.count>0);
await writeFile(directory+'/final-live-anonymous-runtime.json',JSON.stringify(restored,null,2)+'\n');await capture('final-live-anonymous-community');
console.log(JSON.stringify({compiles:compiles.length,restored}));

import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cli,evaluate} from '../qa-source/native-client.mjs';
import {isolate,restore as restoreSession} from '../qa-source/session-baseline.mjs';
const directory=new URL('./',import.meta.url).pathname.replace(/\/$/,'');
await mkdir(directory,{recursive:true});
const legacy=await readFile(new URL('../qa-source/run-glass-native.mjs',import.meta.url),'utf8');
// Reuse the already reviewed, versioned in-memory fixture without modifying
// its archived source or redirecting any real member transport.
function fixture(marker,endMarker){const start=legacy.indexOf(marker)+marker.length,end=legacy.indexOf(endMarker,start);assert.ok(start>=marker.length&&end>start);return (0,eval)('('+legacy.slice(start,end)+')');}
const setup=fixture('facts.setup=await evaluate(',');active=true;');
const cleanup=fixture('facts.cleanup=await evaluate(',');\n  await writeFile');
const edges=fixture('facts.edges=await evaluate(',');\n  assert.deepEqual(facts.edges');
const screenshot=name=>cli('simulator_screenshot',['--path',directory+'/'+name+'.png','--optimize','false']);
const finish=async width=>{
  const pointers=await evaluate(function(){const p=getCurrentPages().at(-1),q=getApp().__glassReview;
    const result={route:p.route,active:p.getTabBar().data.active,publisherCalls:q?.publisherCalls};
    if(q?.originalPublisher)p.openPublisher=q.originalPublisher;p.getTabBar().setCommunityPublisherAvailable(false);return result;});
  const controlled=await evaluate(cleanup);
  const anonymous=await evaluate(async function(){const p=getCurrentPages().at(-1);for(let i=0;i<300&&p.data.loading;i++)await new Promise(r=>setTimeout(r,50));return {route:p.route,width:wx.getWindowInfo().windowWidth,guest:!getApp().globalData.sessionToken,count:p.data.displayFeedCount,fixture:!!getApp().__glassReview};});
  await screenshot('native-'+width);const session=await restoreSession();
  assert.equal(controlled.restored,true);assert.equal(anonymous.guest,true);assert.equal(anonymous.fixture,false);assert.ok(anonymous.count>0);assert.equal(session.originalGlobalDataRestored,true);
  const result={pointers,controlled,anonymous,session};await writeFile(directory+'/cleanup-'+width+'.json',JSON.stringify(result,null,2)+'\n');return result;
};
if(process.argv[2]==='finish'){console.log(JSON.stringify(await finish(process.argv[3])));process.exit(0);}
const width=process.argv[2],facts={scope:'Solid white selected SVG/text on a readable grape-purple lens after the latest user annotation. Controlled member data; no real member writes.',fixtureSha256:createHash('sha256').update(legacy).digest('hex')};
let active=false,passed=false;
try{
  const baseline=await evaluate(function(){return {width:wx.getWindowInfo().windowWidth,preserved:!!getApp().__motionSessionBaseline};});assert.equal(String(baseline.width),width);
  if(!baseline.preserved)await isolate();
  facts.setup=await evaluate(setup);active=true;facts.transitions=[];
  for(const index of [0,1,0,2,1,2,3,0,3,1,3,2]){
    const result=await evaluate(async function(index){
      const current=()=>getCurrentPages().at(-1),tab=()=>current()?.getTabBar?.(),source=current().route,frames=[];
      const timer=setInterval(()=>{const t=tab();if(!t)return;const state={route:current().route,active:t.data.active};const q=t.createSelectorQuery();q.select('.bar__lens-track').fields({computedStyle:['transform','animationName']});q.select('.bar__lens').boundingClientRect();q.select('.bar').boundingClientRect();q.select('.bar__item.is-active .bar__icon-selected').fields({computedStyle:['opacity']});q.select('.bar__item.is-active .bar__label').fields({computedStyle:['color']});q.select('.bar__item.is-active').boundingClientRect();q.select('.bar__item.is-active .bar__icon').fields({computedStyle:['opacity']});q.exec(([track,lens,bar,icon,label,selected,outline])=>{if(track&&lens&&bar&&icon&&label&&selected)frames.push({...state,track,lens:{left:lens.left,right:lens.right},bar:{left:bar.left,right:bar.right},icon,label,selected:{left:selected.left,right:selected.right},outline});});},16);
      setTimeout(()=>tab()?.switchTab({currentTarget:{dataset:{index}}}),35);await new Promise(r=>setTimeout(r,850));clearInterval(timer);await new Promise(r=>setTimeout(r,40));return {source,index,target:current().route,frames};
    },index);
    assert.equal(result.target,['pages/home/index','pages/shop/index','pages/community/index','pages/profile/index'][index]);
    const frames=result.frames.filter(f=>f.active===index),scales=frames.map(f=>Number(f.track.transform.match(/^matrix\(([^,]+)/)?.[1]));
    assert.ok(Math.max(...scales)>1.03);assert.ok(Math.min(...scales)<.99);assert.ok(Math.abs(scales.at(-1)-1)<.001);assert.equal(frames.at(-1).label.color,'rgb(255, 255, 255)');assert.equal(Number(frames.at(-1).icon.opacity),1);assert.equal(Number(frames.at(-1).outline.opacity),0);assert.ok(frames.some(f=>Number(f.outline.opacity)>.05));assert.ok(frames.some(f=>Number(f.icon.opacity)<.99));assert.ok(frames.filter(f=>Number(f.icon.opacity)>.05).every(f=>{const center=(f.selected.left+f.selected.right)/2;return f.lens.left<=center-12&&f.lens.right>=center+12;}));
    assert.ok(frames.every(f=>f.lens.left>=f.bar.left-.5&&f.lens.right<=f.bar.right+.5));facts.transitions.push(result);
  }
  facts.geometry=await evaluate(function(){const t=getCurrentPages().at(-1).getTabBar(),w=wx.getWindowInfo();return new Promise(resolve=>{
    const q=t.createSelectorQuery();q.select('.bar').fields({rect:true,size:true,computedStyle:['backdropFilter']});q.select('.bar__lens').fields({rect:true,size:true,computedStyle:['backgroundColor','borderTopColor','borderBottomColor','borderLeftColor','borderRightColor','borderTopWidth','backgroundImage','boxShadow']});q.selectAll('.bar__item').fields({rect:true,size:true,computedStyle:['color','fontSize','fontWeight']});q.exec(([bar,lens,items])=>resolve({width:w.windowWidth,height:w.windowHeight,safeBottom:w.screenHeight-w.safeArea.bottom,bar,lens,items}));
  });});
  assert.equal(facts.geometry.lens.borderTopWidth,'1px');assert.equal(facts.geometry.lens.backgroundColor,'rgb(109, 71, 130)');assert.equal(facts.geometry.lens.borderLeftColor,'rgb(117, 81, 134)');assert.ok(facts.geometry.lens.backgroundImage.includes('98, 64, 118'));assert.equal(facts.geometry.items[2].fontWeight,'600');assert.equal(facts.geometry.items[2].color,'rgb(255, 255, 255)');assert.ok(facts.geometry.items.every(r=>r.width>=44&&r.height>=44));
  facts.edges=await evaluate(edges);assert.deepEqual(facts.edges.repeatTap,[{scrollTop:0,duration:0}]);assert.equal(facts.edges.hiddenBlocked,true);assert.equal(facts.edges.failureRecovered,true);assert.equal(facts.edges.publisherCalls,1);assert.equal(facts.edges.reduced.enabled,true);assert.equal(facts.edges.reduced.bar.backdropFilter,'none');assert.equal(facts.edges.reduced.lens.animationName,'none');
  facts.disabledSelected=await evaluate(async function(){const p=getCurrentPages().at(-1),t=p.getTabBar();p.setData({working:true});t.syncActive(2);await new Promise(r=>setTimeout(r,30));const result=await new Promise(resolve=>{const q=t.createSelectorQuery();q.select('.bar__item.is-active').fields({computedStyle:['color','opacity']});q.select('.bar__item.is-active .bar__label').fields({computedStyle:['color']});q.select('.bar__item.is-active .bar__icon-selected').fields({computedStyle:['opacity']});q.exec(([item,label,icon])=>resolve({busy:t.data.externalBusy,item,label,icon}));});p.setData({working:false});t.syncActive(2);return result;});assert.equal(facts.disabledSelected.busy,true);assert.equal(facts.disabledSelected.item.color,'rgb(255, 255, 255)');assert.equal(Number(facts.disabledSelected.item.opacity),1);assert.equal(facts.disabledSelected.label.color,'rgb(255, 255, 255)');assert.equal(Number(facts.disabledSelected.icon.opacity),1);
  facts.backdrops=[];
  for(const [name,background] of [['light','linear-gradient(120deg,#eef2f7,#ffffff)'],['warm','linear-gradient(120deg,#e8c8a5,#f5ebe0)'],['dark','linear-gradient(120deg,#0d1728,#2a203a)'],['busy','repeating-linear-gradient(45deg,#171320 0px,#171320 3px,#ffffff 3px,#ffffff 6px)']]){
    await evaluate(async function(background){const t=getCurrentPages().at(-1).getTabBar();t.setData({chromeStyle:getApp().globalData.chromeStyle+';background:'+background+';'});await new Promise(r=>setTimeout(r,100));return true;},background);
    await screenshot(width+'-'+name);facts.backdrops.push({name,background,active:2,screenshot:width+'-'+name+'.png'});
  }
  facts.reduced=await evaluate(function(){const q=getApp().__glassReview,t=getCurrentPages().at(-1).getTabBar();wx.getDeviceInfo=()=>({...q.original.getDeviceInfo(),benchmarkLevel:5});t.syncActive(2);return new Promise(resolve=>{const s=t.createSelectorQuery();s.select('.bar').fields({computedStyle:['backdropFilter','backgroundColor']});s.select('.bar__lens-track').fields({computedStyle:['animationName','transform']});s.select('.bar__lens').fields({computedStyle:['borderLeftColor','borderTopWidth']});s.select('.bar__item.is-active .bar__icon').fields({computedStyle:['opacity']});s.exec(([bar,track,lens,outline])=>resolve({bar,track,lens,outline,active:t.data.active}));});});
  assert.equal(facts.reduced.bar.backdropFilter,'none');assert.equal(facts.reduced.track.animationName,'none');assert.equal(facts.reduced.active,2);assert.equal(Number(facts.reduced.outline.opacity),0);
  await evaluate(function(){const q=getApp().__glassReview,p=getCurrentPages().at(-1),t=p.getTabBar();wx.getDeviceInfo=q.original.getDeviceInfo;t.syncActive(2);t.setData({chromeStyle:getApp().globalData.chromeStyle});q.publisherCalls=0;q.originalPublisher=p.openPublisher;p.openPublisher=()=>{q.publisherCalls++;};t.setCommunityPublisherAvailable(true);return true;});
  await screenshot(width+'-pointer-baseline');passed=true;facts.status='passed';
}catch(error){facts.status='failed';facts.error=String(error);throw error;}
finally{
  await writeFile(directory+'/review-'+width+'.json',JSON.stringify(facts,null,2)+'\n');
  if(active&&(!passed||!process.argv.includes('--hold')))await finish(width);
}
console.log(JSON.stringify({width,status:facts.status,transitions:facts.transitions.length,backgrounds:facts.backdrops.length,heldForPointerReview:process.argv.includes('--hold')}));

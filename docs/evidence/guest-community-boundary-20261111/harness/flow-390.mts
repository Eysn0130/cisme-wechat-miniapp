import{cli,evaluate}from'./native-cli.mts';import{waitReady,shot,id}from'./native-fixture.mts';import{writeFile}from'node:fs/promises';
const phase='native-390',results=[];
// The coordinate tool reported App.CDPEnable unimplemented. Invoke the actual native component handler; do not label this a gesture test.
for(const [name,index]of[['home',0],['shop',1],['profile',3]]as const){
 await evaluate(function(index){const bar=getCurrentPages().slice(-1)[0].getTabBar?.();if(!bar)throw Error('TAB_BAR_UNAVAILABLE');bar.switchTab({currentTarget:{dataset:{index}}});},index);await waitReady();
 const f=await shot(phase,'04-'+name+'-login');if(f.route!=='pages/account/index'||!f.guest)throw Error('GUEST_TAB_BYPASS:'+name);results.push({tab:name,route:f.route,target:f.returnUrl,interaction:'native component handler'});
 await cli('automation_element_action',['--selector','.account-topbar__back','--action','tap']);const b=await waitReady();if(b.route!=='pages/community/index')throw Error('BACK_LOOP:'+name);
}
await evaluate(function(){getApp().__cismeGuestQA.phone=false;});
await cli('automation_navigate',['--action','navigateTo','--url','/pages/post/index?id='+id+'&source=editorial']);await waitReady();await shot(phase,'05-editorial-guest-wall');
await cli('automation_element_action',['--selector','.comment-login-button','--action','tap']);await waitReady();const account=await shot(phase,'06-comments-login');if(account.route!=='pages/account/index'||account.returnUrl!=='/pages/post/index?id='+id+'&source=editorial')throw Error('COMMENT_RETURN_LOST');
await cli('automation_element_action',['--selector','.account-agreement__label','--action','tap']);await cli('automation_element_action',['--selector','.account-login','--action','tap']);await waitReady();
const logged=await shot(phase,'07-member-comments');if(logged.route!=='pages/post/index'||!logged.authenticated||logged.guest||!logged.commentAuthenticated||logged.threads!==1)throw Error('LOGIN_COMMENTS_FAILED');
results.push({commentLogin:account.returnUrl,loggedRoute:logged.route,threads:logged.threads,guestMarkerCleared:!logged.guest});
await evaluate(function(){const a=getApp();a.globalData.sessionToken='';a.__cismeGuestQA.storage['cisme.guestBrowsing']=true;});
await cli('automation_navigate',['--action','redirectTo','--url','/pages/post/index?id='+id+'&source=formal']);await waitReady();const formal=await shot(phase,'08-formal-guest-wall');if(formal.commentAuthenticated||formal.threads||formal.privateGuestReads)throw Error('FORMAL_COMMENTS_LEAK');
for(const route of ['home','shop','product','community-author']){
 await cli('automation_navigate',['--action',['home','shop'].includes(route)?'reLaunch':'redirectTo','--url','/pages/'+route+'/index'+(route==='product'?'?id=serum':route==='community-author'?'?id='+id:'')]);await waitReady();
 const f=await shot(phase,'09-direct-'+route);if(f.route!=='pages/account/index')throw Error('DIRECT_GUEST_BYPASS:'+route);results.push({direct:route,redirect:f.route});
 await cli('automation_element_action',['--selector','.account-topbar__back','--action','tap']);await waitReady();
}
const facts=await evaluate(function(){const q=getApp().__cismeGuestQA;return{privateGuestReads:q.privateGuestReads,loginCalls:q.loginCalls,undefinedRoutes:q.requests.filter(r=>!r.handled),requests:q.requests};});if(facts.privateGuestReads||facts.undefinedRoutes.length)throw Error('FIXTURE_ROUTE_OR_PRIVATE_READ');
await writeFile('/Users/mini/CISME/docs/evidence/guest-community-boundary-20261111/native-flow.json',JSON.stringify({results,...facts,realMemberWrites:0},null,2)+'\n');console.log({passed:true,tabGuards:3,directGuards:4,privateGuestReads:facts.privateGuestReads,syntheticLoginCalls:facts.loginCalls});

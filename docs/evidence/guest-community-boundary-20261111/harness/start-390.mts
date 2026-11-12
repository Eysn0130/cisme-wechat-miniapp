import{cli,evaluate}from'./native-cli.mts';import{waitReady,shot}from'./native-fixture.mts';
await cli('automation_navigate',['--action','reLaunch','--url','/pages/account/index?intent=login']);console.log(await waitReady());await shot('native-390','01-login-clean');
await evaluate(function(){const p=getCurrentPages().slice(-1)[0];p.setData({pendingDestination:'/pages/shop/index',loginStage:'avatar'});p.revealExpiredLogin();});await shot('native-390','02-expired-clean');
await cli('automation_element_action',['--selector','.account-browse','--action','tap']);console.log(await waitReady());await shot('native-390','03-guest-community');

from pathlib import Path
import runpy,sys,json,subprocess

out=Path(__file__).resolve().parent
record=runpy.run_path(str(out/'native-recorder.py'))
call,shot=record['call'],record['shot']
size=sys.argv[1]
devices={'361':'HUAWEI nova 13','430':'iPhone 14/15 Pro Max'}
response=subprocess.run(['/usr/local/bin/wechatide','-c','Codex','simulator_set_device','--project',record['project'],'--device',devices[size]],capture_output=True,text=True,timeout=45)
(out/f'native-device-{size}.json').write_text(response.stdout)
assert json.loads(response.stdout).get('ok')
call('native-text-input-'+size,'await new Promise((resolve,reject)=>wx.reLaunch({url:"/pages/community-compose/index?new=1&entry=text",success:resolve,fail:reject}));const p=getCurrentPages().slice(-1)[0];await wait(()=>p.data.textCardVisible&&!p.data.loading);const c=p.selectComponent("#communityTextCard"),f=getApp().globalData.motionFixture;c.editText({detail:{value:"慢慢来"}});const geometry=await new Promise(resolve=>c.createSelectorQuery().select(".text-card-next").boundingClientRect().select(".text-card-back").boundingClientRect().select(".text-card-writing-copy").boundingClientRect().select(".text-card-writing-card").boundingClientRect().exec(resolve));return {width:wx.getWindowInfo().windowWidth,stage:c.data.stage,text:c.data.text,postId:p.data.postId,posts:Object.keys(f.posts).length,writes:f.calls.filter(x=>x.method!=="GET"),menu:wx.getMenuButtonBoundingClientRect(),geometry};')
shot('native-text-input-'+size)
call('native-text-templates-'+size,'const p=getCurrentPages().slice(-1)[0],c=p.selectComponent("#communityTextCard"),f=getApp().globalData.motionFixture;await c.confirm();await wait(()=>c.data.stage==="templates"&&!c.data.busy);c.selectTemplate({currentTarget:{dataset:{template:"border"}}});const geometry=await new Promise(resolve=>c.createSelectorQuery().select(".text-card-preview-image").boundingClientRect().select(".text-card-confirm").boundingClientRect().select(".text-card-template-scroll").boundingClientRect().exec(resolve));return {stage:c.data.stage,template:c.data.template,pngCount:c.data.templates.filter(x=>x.previewPath).length,canExport:c.data.canExport,posts:Object.keys(f.posts).length,writes:f.calls.filter(x=>x.method!=="GET"),geometry};')
shot('native-text-templates-'+size)
call('native-text-publisher-'+size,'const p=getCurrentPages().slice(-1)[0],c=p.selectComponent("#communityTextCard"),f=getApp().globalData.motionFixture;await c.confirm();await wait(()=>!p.data.textCardVisible&&p.data.files.length===1&&!p.data.uploadBusy&&!p.data.busy);f.publicEnabled=true;await p.refreshPublicGate();return {scope:"offline API and controlled public gate only",width:wx.getWindowInfo().windowWidth,title:p.data.title,body:p.data.body,textCardText:p.data.textCardText,template:p.data.textCardTemplate,files:p.data.files.map(x=>({state:x.state,preview:x.previewUrl})),posts:Object.keys(f.posts).length,writes:f.calls.filter(x=>x.method!=="GET"),publicEnabled:p.data.publicGateEnabled,error:p.data.error};')
shot('native-text-publisher-public-'+size)

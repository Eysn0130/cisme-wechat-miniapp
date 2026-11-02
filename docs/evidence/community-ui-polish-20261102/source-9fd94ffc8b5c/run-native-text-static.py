from pathlib import Path
import runpy,sys,json,subprocess

out=Path(__file__).resolve().parent
record=runpy.run_path(str(out/'native-recorder.py'))
call,shot=record['call'],record['shot']
size=sys.argv[1]
devices={'361':'HUAWEI nova 13','390':'iPhone 12/13 (Pro)','430':'iPhone 14/15 Pro Max'}
response=subprocess.run(['/usr/local/bin/wechatide','-c','Codex','simulator_set_device','--project',record['project'],'--device',devices[size]],capture_output=True,text=True,timeout=45)
(out/f'native-device-{size}.json').write_text(response.stdout)
assert json.loads(response.stdout).get('ok')
if json.loads(response.stdout)['result'].get('changed'):
 refresh=subprocess.run(['/usr/local/bin/wechatide','-c','Codex','simulator_refresh','--project',record['project']],capture_output=True,text=True,timeout=45)
 (out/f'native-refresh-{size}.json').write_text(refresh.stdout)
 ready=subprocess.run(['/usr/local/bin/wechatide','-c','Codex','automation_runtime_info','--project',record['project'],'--action','pageStack'],capture_output=True,text=True,timeout=45)
 (out/f'native-ready-{size}.json').write_text(ready.stdout)
call('native-text-input-'+size,'await new Promise((resolve,reject)=>wx.reLaunch({url:"/pages/community-compose/index?new=1&entry=text",success:resolve,fail:reject}));const p=getCurrentPages().slice(-1)[0];await wait(()=>p.data.textCardVisible&&!p.data.loading);const c=p.selectComponent("#communityTextCard"),f=getApp().globalData.motionFixture;c.editText({detail:{value:"护理慢慢来，\\n感受每天的小变化。"}});const geometry=await new Promise(resolve=>c.createSelectorQuery().select(".text-card-next").boundingClientRect().select(".text-card-back").boundingClientRect().select(".text-card-writing-copy").boundingClientRect().select(".text-card-writing-card").boundingClientRect().exec(resolve));return {width:wx.getWindowInfo().windowWidth,stage:c.data.stage,text:c.data.text,postId:p.data.postId,posts:Object.keys(f.posts).length,writes:f.calls.filter(x=>x.method!=="GET"),menu:wx.getMenuButtonBoundingClientRect(),geometry};')
shot('native-text-input-'+size)
call('native-text-templates-'+size,'const p=getCurrentPages().slice(-1)[0],c=p.selectComponent("#communityTextCard"),f=getApp().globalData.motionFixture;await c.confirm();await wait(()=>c.data.stage==="templates"&&!c.data.busy);c.selectTemplate({currentTarget:{dataset:{template:"border"}}});const geometry=await new Promise(resolve=>c.createSelectorQuery().select(".text-card-preview-image").boundingClientRect().select(".text-card-confirm").boundingClientRect().select(".text-card-template-scroll").boundingClientRect().exec(resolve));return {stage:c.data.stage,template:c.data.template,pngCount:c.data.templates.filter(x=>x.previewPath).length,canExport:c.data.canExport,posts:Object.keys(f.posts).length,writes:f.calls.filter(x=>x.method!=="GET"),geometry};')
shot('native-text-templates-'+size)
if size=='390':
 call('native-six-actual-png-390','const c=getCurrentPages().slice(-1)[0].selectComponent("#communityTextCard"),files=await Promise.all(c.data.templates.map(async item=>{const data=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:item.previewPath,success:x=>resolve(x.data),fail:reject})),b=new Uint8Array(data);return {template:item.value,path:item.previewPath,size:b.length,signature:Array.from(b.slice(0,8)),width:b[16]*16777216+b[17]*65536+b[18]*256+b[19],height:b[20]*16777216+b[21]*65536+b[22]*256+b[23],content:Array.from(b).join(",")};}));const uniqueContents=new Set(files.map(x=>x.content)).size;files.forEach(x=>delete x.content);return {text:c.data.text,files,uniqueContents,selected:c.data.template,canExport:c.data.canExport};')
call('native-text-publisher-'+size,'const p=getCurrentPages().slice(-1)[0],c=p.selectComponent("#communityTextCard"),f=getApp().globalData.motionFixture;await c.confirm();await wait(()=>!p.data.textCardVisible&&p.data.files.length===1&&!p.data.uploadBusy&&!p.data.busy);f.publicEnabled=true;await p.refreshPublicGate();return {scope:"offline API and controlled public gate only",width:wx.getWindowInfo().windowWidth,title:p.data.title,body:p.data.body,textCardText:p.data.textCardText,template:p.data.textCardTemplate,files:p.data.files.map(x=>({state:x.state,preview:x.previewUrl})),posts:Object.keys(f.posts).length,writes:f.calls.filter(x=>x.method!=="GET"),publicEnabled:p.data.publicGateEnabled,error:p.data.error};')
shot('native-text-publisher-public-'+size)

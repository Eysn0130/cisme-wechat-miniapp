from pathlib import Path
import subprocess,json
out=Path(__file__).resolve().parent
project='/tmp/cisme-compose-native-20261101'
wait='const wait=async f=>{for(let i=0;i<100;i++){if(f())return;await new Promise(r=>setTimeout(r,30));}throw new Error("Native state timeout")};'
def call(name,code):
 r=subprocess.run(['/usr/local/bin/wechatide','-c','Codex','automation_evaluate','--project',project,'--fn-source','async function(){'+wait+code+'}'],capture_output=True,text=True,timeout=45)
 (out/(name+'.json')).write_text(r.stdout)
 j=json.loads(r.stdout);assert j.get('ok') and j['result'].get('success'),j
 result=j['result']['result']['result'];print(name, json.dumps(result,ensure_ascii=False)[:1400],flush=True);return result
def shot(name):
 r=subprocess.run(['/usr/local/bin/wechatide','-c','Codex','simulator_screenshot','--project',project,'--path',str(out/(name+'.png')),'--optimize','false'],capture_output=True,text=True,timeout=45)
 (out/(name+'-receipt.json')).write_text(r.stdout);assert json.loads(r.stdout).get('ok');print(name,flush=True)
def tap(name,rect):
 assert rect and rect['width']>=1 and rect['height']>=1
 args=['/usr/local/bin/wechatide','-c','Codex','automation_element_action','--project',project,'--action','tap','--x',str(rect['left']+rect['width']/2),'--y',str(rect['top']+rect['height']/2)]
 r=subprocess.run(args,capture_output=True,text=True,timeout=45);(out/(name+'.json')).write_text(r.stdout);j=json.loads(r.stdout);assert j.get('ok') and j['result'].get('success'),j
 print(name,flush=True)
rect=call('native-binding-01-fab-geometry', 'await new Promise((resolve,reject)=>wx.reLaunch({url:"/pages/community/index",success:resolve,fail:reject}));const p=getCurrentPages().slice(-1)[0];await p.load();const t=p.getTabBar();await wait(()=>t.data.communityFabVisible&&t.data.communityPublisherAvailable);return await new Promise(resolve=>wx.createSelectorQuery().in(t).select(".community-fab").boundingClientRect(resolve).exec());')
tap('native-binding-02-fab-tap',rect)
rect=call('native-binding-03-text-choice', 'const p=getCurrentPages().slice(-1)[0];await wait(()=>p.data.publishEntryOpen);const options=await new Promise(resolve=>wx.createSelectorQuery().selectAll(".community-publisher-option").boundingClientRect(resolve).exec());return options[2];')
tap('native-binding-04-text-choice-tap',rect)
rect=call('native-binding-05-text-next-geometry', 'await wait(()=>getCurrentPages().slice(-1)[0].route==="pages/community-compose/index");const p=getCurrentPages().slice(-1)[0];await wait(()=>p.data.postId&&p.data.textCardVisible&&p.selectComponent("#communityTextCard").data.visible);const c=p.selectComponent("#communityTextCard");c.editText({detail:{value:"每一次护理，都认真记录。"}});await wait(()=>c.data.canExport);return await new Promise(resolve=>wx.createSelectorQuery().in(c).select(".text-card-confirm").boundingClientRect(resolve).exec());')
tap('native-binding-06-text-next-tap',rect)
call('native-binding-07-text-next-result', 'const p=getCurrentPages().slice(-1)[0];await wait(()=>!p.data.textCardVisible&&!p.data.uploadBusy&&p.data.files.length===1);return {textNextBinding:true,files:p.data.files.length,error:p.data.error};')
rect=call('native-binding-08-direct-body-geometry', 'const p=getCurrentPages().slice(-1)[0];p.openTextCard("editor");await wait(()=>p.data.textCardVisible&&p.selectComponent("#communityTextCard").data.visible);const c=p.selectComponent("#communityTextCard");c.editText({detail:{value:"正文入口也会保留当前文字。"}});return await new Promise(resolve=>wx.createSelectorQuery().in(c).select(".text-card-write-body").boundingClientRect(resolve).exec());')
tap('native-binding-09-direct-body-tap',rect)
call('native-binding-10-direct-body-result', 'const p=getCurrentPages().slice(-1)[0];await wait(()=>!p.data.textCardVisible);wx.hideKeyboard();return {directBodyBinding:true,body:p.data.body,files:p.data.files.length,error:p.data.error};')
rect=call('native-binding-11-image-disabled-geometry', 'const p=getCurrentPages().slice(-1)[0];await p.openPhotoEditorForImage({currentTarget:{dataset:{id:p.data.files[0].id}}});await wait(()=>p.data.photoEditorVisible&&p.selectComponent("#communityImageEditor").data.visible);const e=p.selectComponent("#communityImageEditor");e.toggleTool({currentTarget:{dataset:{tool:"text"}}});e.changeOverlayText({detail:{value:"认真护理"}});await new Promise(resolve=>wx.nextTick(resolve));return await new Promise(resolve=>wx.createSelectorQuery().in(e).select(".image-editor-next").boundingClientRect(resolve).exec());')
tap('native-binding-12-disabled-next-tap',rect)
rect=call('native-binding-13-image-apply-geometry', 'const p=getCurrentPages().slice(-1)[0],e=p.selectComponent("#communityImageEditor");if(!p.data.photoEditorVisible||!e.data.effectDirty)throw new Error("Disabled next unexpectedly navigated");return await new Promise(resolve=>wx.createSelectorQuery().in(e).select(".image-editor-apply").boundingClientRect(resolve).exec());')
tap('native-binding-14-image-apply-tap',rect)
rect=call('native-binding-15-image-next-geometry', 'const p=getCurrentPages().slice(-1)[0],e=p.selectComponent("#communityImageEditor");await wait(()=>!e.data.busy&&!e.data.effectDirty);return await new Promise(resolve=>wx.createSelectorQuery().in(e).select(".image-editor-next").boundingClientRect(resolve).exec());')
tap('native-binding-16-image-next-tap',rect)
rect=call('native-binding-17-save-geometry', 'const p=getCurrentPages().slice(-1)[0];await wait(()=>!p.data.photoEditorVisible&&!p.data.uploadBusy);getApp().globalData.motionFixture.publicEnabled=false;await p.refreshPublicGate();wx.hideKeyboard();return await new Promise(resolve=>wx.createSelectorQuery().select(".composer-actions__save").boundingClientRect(resolve).exec());')
tap('native-binding-18-save-tap',rect)
rect=call('native-binding-19-settings-geometry', 'const p=getCurrentPages().slice(-1)[0];await wait(()=>!p.data.busy&&!p.data.dirty);return await new Promise(resolve=>wx.createSelectorQuery().select(".composer-settings-entry").boundingClientRect(resolve).exec());')
tap('native-binding-20-settings-tap',rect)
rect=call('native-binding-21-settings-done-geometry', 'const p=getCurrentPages().slice(-1)[0];await wait(()=>p.data.settingsExpanded);return await new Promise(resolve=>wx.createSelectorQuery().select(".composer-settings-head .text-button").boundingClientRect(resolve).exec());')
tap('native-binding-22-settings-done-tap',rect)
call('native-binding-23-final', 'const p=getCurrentPages().slice(-1)[0];await wait(()=>!p.data.settingsExpanded);return {scope:"official coordinate taps on current native geometry; text stimulus controlled; API offline",settingsClosed:true,state:p.data.state,dirty:p.data.dirty,files:p.data.files.length,error:p.data.error};')

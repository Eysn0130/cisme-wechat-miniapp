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
import sys
size=sys.argv[1]
call('native-size-card-'+size, 'if(getApp().globalData.motionFixture)getApp().globalData.motionFixture.publicEnabled=false;await new Promise((resolve,reject)=>wx.reLaunch({url:"/pages/community-compose/index?new=1&entry=text",success:resolve,fail:reject}));const p=getCurrentPages().slice(-1)[0];await wait(()=>p.data.postId&&p.data.textCardVisible&&p.selectComponent("#communityTextCard").data.visible);const c=p.selectComponent("#communityTextCard");c.editText({detail:{value:"认真护理，慢慢记录。"+String.fromCharCode(10)+"今天的感受也值得留下 💜"}});c.selectTemplate({currentTarget:{dataset:{template:"memo"}}});await wait(()=>c.data.canExport);const w=wx.getWindowInfo();return {width:w.windowWidth,height:w.windowHeight,previewReady:!!c.data.previewPath,canExport:c.data.canExport,error:c.data.error};')
shot('native-text-card-'+size)
call('native-size-photo-dirty-'+size, 'const p=getCurrentPages().slice(-1)[0];p.selectComponent("#communityTextCard").writeBody();const path="/assets/cisme/cisme-scalp-lab-avatar-v1.jpg",size=await new Promise((resolve,reject)=>wx.getFileSystemManager().getFileInfo({filePath:path,success:r=>resolve(r.size),fail:reject}));p.pendingInitialMedia={source:"camera",files:[{path,size}]};p.pendingMediaOrigin="editor";await p.importInitialMedia();await wait(()=>p.selectComponent("#communityImageEditor").data.visible&&p.selectComponent("#communityImageEditor").data.files.length);const e=p.selectComponent("#communityImageEditor");e.toggleTool({currentTarget:{dataset:{tool:"text"}}});e.changeOverlayText({detail:{value:"CISME 护理记录"}});e.changeOverlayPosition({currentTarget:{dataset:{value:"bottom"}}});await e.confirm();await new Promise(resolve=>wx.nextTick(resolve));const geometry=await new Promise(resolve=>wx.createSelectorQuery().in(e).select(".image-editor-fixed-actions").boundingClientRect().select(".image-editor-footer").boundingClientRect().select(".image-editor-next").fields({rect:true,properties:["disabled"]}).exec(resolve));return {scope:"local fixture image, not hardware camera",width:wx.getWindowInfo().windowWidth,dirty:e.data.effectDirty,refusedDirtyNext:p.data.photoEditorVisible,geometry,error:e.data.error};')
shot('native-photo-dirty-'+size)
call('native-size-photo-apply-'+size, 'const p=getCurrentPages().slice(-1)[0],e=p.selectComponent("#communityImageEditor"),before=e.data.files[0].path;e.discardEffects();const discarded=!e.data.effectDirty&&e.data.files[0].path===before;e.changeOverlayText({detail:{value:"CISME 护理记录"}});e.changeOverlayPosition({currentTarget:{dataset:{value:"bottom"}}});await e.applyEffects();const file=e.data.files[0];return {discardedWithoutChangingSource:discarded,appliedNewFile:file.path!==before,dirty:e.data.effectDirty,busy:e.data.busy,error:e.data.error,signature:await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:file.path,position:0,length:3,success:r=>resolve(Array.from(new Uint8Array(r.data))),fail:reject}))};')
shot('native-photo-applied-'+size)
call('native-size-private-'+size, 'const p=getCurrentPages().slice(-1)[0];await p.selectComponent("#communityImageEditor").confirm();await wait(()=>!p.data.uploadBusy&&p.data.files.length===1);wx.hideKeyboard();const saved=await p.saveDraft();return {nextClosedEditor:!p.data.photoEditorVisible,saved:!!saved,publicEnabled:p.data.publicGateEnabled,state:p.data.state,files:p.data.files.length,error:p.data.error};')
shot('native-private-composer-'+size)
call('native-size-public-'+size, 'const p=getCurrentPages().slice(-1)[0];getApp().globalData.motionFixture.publicEnabled=true;await p.refreshPublicGate();p.changeRights({detail:{value:true}});p.changeConsent({detail:{value:true}});return {scope:"controlled gate, not public backend",publicEnabled:p.data.publicGateEnabled};')
shot('native-public-composer-'+size)

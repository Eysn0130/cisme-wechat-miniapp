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
call('native-static-'+size,'await new Promise((resolve,reject)=>wx.reLaunch({url:"/pages/community-compose/index?new=1",success:resolve,fail:reject}));const p=getCurrentPages().slice(-1)[0];await wait(()=>p.data.postId&&!p.data.loading);const f=getApp().globalData.motionFixture,files=Array.from({length:3},(_,i)=>({id:"ffffffff-ffff-4fff-8fff-"+String(i+1).padStart(12,"0"),localPath:"/assets/cisme/cisme-scalp-lab-avatar-v1.jpg",previewUrl:"/assets/cisme/cisme-scalp-lab-avatar-v1.jpg",size:92465,state:"uploaded",progress:100,error:""}));p.setData({files,title:"把护理感受记录下来",body:"认真护理，慢慢记录。",dirty:true});await p.saveDraft();const geometry=await new Promise(resolve=>wx.createSelectorQuery().select(".composer-media-scroll").boundingClientRect().selectAll(".composer-media__frame").boundingClientRect().selectAll(".composer-media__actions").boundingClientRect().selectAll(".composer-media__remove-icon").boundingClientRect().select(".composer-sort").boundingClientRect().select(".composer-settings-entry").boundingClientRect().exec(resolve));return {width:wx.getWindowInfo().windowWidth,geometry,publicEnabled:p.data.publicGateEnabled,files:p.data.files.length,error:p.data.error};')
shot('native-delete-private-'+size)
call('native-static-public-'+size,'const p=getCurrentPages().slice(-1)[0];getApp().globalData.motionFixture.publicEnabled=true;await p.refreshPublicGate();return {scope:"controlled public gate, no real publication",publicEnabled:p.data.publicGateEnabled,error:p.data.error};')
shot('native-delete-public-'+size)

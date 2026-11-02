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
call('native-final-empty-baseline','await new Promise((resolve,reject)=>wx.reLaunch({url:"/pages/community/index",success:resolve,fail:reject}));const p=getCurrentPages().slice(-1)[0];await p.load();const f=getApp().globalData.motionFixture;return {scope:"fresh official simulator runtime after cleanup refresh; offline adapters only",route:p.route,width:wx.getWindowInfo().windowWidth,posts:Object.keys(f.posts).length,writeCalls:f.calls.filter(x=>x.method!=="GET").length,publicEnabled:f.publicEnabled,publishEntryOpen:p.data.publishEntryOpen,componentBackupsResetByFreshRuntime:true,realAccountDataAccessed:false,persistentStorage:false};')

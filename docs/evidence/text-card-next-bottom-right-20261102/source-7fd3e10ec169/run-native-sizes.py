from pathlib import Path
import json,runpy,subprocess

out=Path(__file__).resolve().parent
r=runpy.run_path(str(out/'native-recorder.py'))
for size,device in [('361','HUAWEI nova 13'),('430','iPhone 14/15 Pro Max')]:
 for name,args in [('device',['simulator_set_device','--device',device]),('refresh',['simulator_refresh'])]:
  response=subprocess.run(['/usr/local/bin/wechatide','-c','Codex',args[0],'--project',r['project'],*args[1:]],capture_output=True,text=True,timeout=45)
  (out/f'native-{name}-{size}.json').write_text(response.stdout)
  assert json.loads(response.stdout).get('ok')
 r['call']('native-input-geometry-'+size,'await wait(()=>typeof wx!=="undefined"&&typeof getCurrentPages==="function");await new Promise((resolve,reject)=>wx.reLaunch({url:"/pages/community-compose/index?new=1&entry=text",success:resolve,fail:reject}));await wait(()=>getCurrentPages().some(x=>x.route==="pages/community-compose/index"));const p=getCurrentPages().slice(-1)[0];await wait(()=>p.data.textCardVisible&&!p.data.loading);const c=p.selectComponent("#communityTextCard");c.editText({detail:{value:"护理慢慢来，\\n感受每天的小变化。"}});await new Promise(resolve=>wx.nextTick(resolve));return {width:wx.getWindowInfo().windowWidth,height:wx.getWindowInfo().windowHeight,canProceed:c.data.canProceed,geometry:await new Promise(resolve=>c.createSelectorQuery().select(".text-card-confirm").boundingClientRect().select(".text-card-writing-card").boundingClientRect().select(".text-card-write-body").boundingClientRect().select(".text-card-input-body").boundingClientRect().select(".text-card-next").boundingClientRect().exec(resolve)),postId:p.data.postId,writes:getApp().globalData.motionFixture.calls.filter(x=>x.method!=="GET")};')
 r['shot']('native-input-bottom-next-'+size)

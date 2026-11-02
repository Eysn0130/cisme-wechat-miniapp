from pathlib import Path
import json, subprocess

out = Path('/Users/mini/CISME/docs/evidence/community-compose-followup-20261101')
project = '/tmp/cisme-compose-native-20261101'
def call(tool, *args, name):
    result = subprocess.run(['wechatide','-c','Codex',tool,'--project',project,*args], capture_output=True, text=True, timeout=40)
    (out / (name+'.json')).write_text(result.stdout)
    response = json.loads(result.stdout[result.stdout.index('{'):])
    if not response.get('ok'): raise RuntimeError(result.stdout)
    return response
def evaluate(code,name): return call('automation_evaluate','--fn-source',code,name=name)
def capture(name): return call('simulator_screenshot','--path',str(out/(name+'.png')),'--optimize','false',name=name+'-receipt')
def open_editor(prefix):
    call('automation_runtime_info','--action','currentPage',name=prefix+'-runtime')
    evaluate('function(){return new Promise((resolve,reject)=>wx.switchTab({url:"/pages/community/index",success:()=>resolve(true),fail:reject}));}',prefix+'-community')
    evaluate('function(){getCurrentPages().slice(-1)[0].getTabBar().activateCommunityFab();return true;}',prefix+'-open')

call('simulator_set_device','--device','HUAWEI nova 13',name='responsive-small-device')
open_editor('responsive-small')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0],f=getApp().globalData.motionFixture,post=f.posts[p.data.postId];f.publicEnabled=true;await p.refreshPublicGate();post.media=Array.from({length:9},(_,i)=>({id:"cccccccc-cccc-4ccc-8ccc-"+String(i+1).padStart(12,"0"),state:"uploaded"}));p.applyDraft(post,false);return {width:wx.getWindowInfo().windowWidth,files:p.data.files.length};}', 'responsive-small-nine')
capture('native-small-361-public-nine')
evaluate('function(){const p=getCurrentPages().slice(-1)[0];p.toggleSorting();return {sorting:p.data.sorting};}', 'responsive-small-sort')
capture('native-small-361-sorting')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0],f=getApp().globalData.motionFixture;p.toggleSorting();p.editBody({detail:{value:"保存回执待确认时内容被下架，仍保留这段本机输入和图片。"}});f.terminalOnSave="hidden";f.unknownSave=true;await p.saveDraft();if(p.data.state!=="hidden"||!p.data.dirty||p.data.writeRecovery)throw new Error("Terminal recovery did not preserve input");wx.pageScrollTo({scrollTop:0,duration:0});return {state:p.data.state,dirty:p.data.dirty,files:p.data.files.length,writeRecovery:p.data.writeRecovery};}', 'responsive-small-hidden-recovery')
capture('native-small-361-hidden-dirty')
call('simulator_set_device','--device','iPhone 14/15 Pro Max',name='responsive-large-device')
open_editor('responsive-large')
capture('native-large-430-empty')
call('simulator_set_device','--device','iPhone 12/13 (Pro)',name='responsive-restored-device')
open_editor('responsive-restored')
print(json.dumps({'captured':4,'scope':'Native layouts at actual simulator widths361 and430; no physical touch, keyboard or real-account verification'}))

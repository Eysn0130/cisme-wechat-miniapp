from pathlib import Path
import subprocess,json
out=Path('/Users/mini/CISME/docs/evidence/community-publish-loop-20261101')
project='/tmp/cisme-compose-native-20261101'
def call(tool,*args,name=None):
    r=subprocess.run(['wechatide','-c','Codex',tool,'--project',project,*args],capture_output=True,text=True,timeout=35)
    if name:(out/("final-"+name)).write_text(r.stdout)
    obj=json.loads(r.stdout)
    if not obj.get('ok'):raise RuntimeError(r.stdout)
    return obj

def evaluate(code,name):
    return call('automation_evaluate','--fn-source',code,name=name+'.json')

def capture(name):
    call('simulator_screenshot','--path',str(out/('final-'+name+'.png')),'--optimize','false',name=name+'-receipt.json')

evaluate('function(){getCurrentPages().slice(-1)[0].getTabBar().activateCommunityFab();return true;}','00-open-composer')
capture('01-private-empty')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0];p.editTitle({detail:{value:"今天的护理感受"}});p.editBody({detail:{value:"这是一段离线校验内容。保存为仅自己可见的草稿，不会进入真实社区。"}});await p.saveDraft();return {postId:p.data.postId,state:p.data.state,version:p.data.version,dirty:p.data.dirty,notice:p.data.notice};}','02-save-private')
capture('02-private-saved')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0],f=getApp().globalData.motionFixture,post=f.posts[p.data.postId];post.media=Array.from({length:9},(_,i)=>({id:"cccccccc-cccc-4ccc-8ccc-"+String(i+1).padStart(12,"0"),state:"uploaded"}));p.applyDraft(post);return {images:p.data.files.length};}','03-nine-images')
capture('03-nine-images')
evaluate('function(){const p=getCurrentPages().slice(-1)[0];const first=p.data.files[0].id,second=p.data.files[1].id;p.toggleSorting();p.moveImage({currentTarget:{dataset:{id:first,direction:1}}});return {sorting:p.data.sorting,first:p.data.files[0].id,expected:second};}','04-reorder')
capture('04-sorting')
evaluate('function(){wx.pageScrollTo({scrollTop:10000,duration:0});return true;}','05-scroll-declarations')
capture('05-declarations')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0];getApp().globalData.motionFixture.publicEnabled=true;await p.refreshPublicGate();p.changeAi({detail:{value:"1"}});p.changeRights({detail:{value:true}});p.changeConsent({detail:{value:true}});await p.submit();wx.pageScrollTo({scrollTop:0,duration:0});return {state:p.data.state,dirty:p.data.dirty,publicGateEnabled:p.data.publicGateEnabled};}','06-submit-synthetic')
capture('06-pending-review')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0],f=getApp().globalData.motionFixture,post=f.posts[p.data.postId];post.state="awaiting_publication";post.revisionState="approved";post.version++;await p.loadDraft(post.id);return {state:p.data.state};}','07-awaiting-publication')
capture('07-awaiting-publication')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0];await p.showMyPosts();return {listMode:p.data.listMode};}','08-my-posts')
capture('08-my-posts')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0];getApp().globalData.motionFixture.publicEnabled=false;await p.refreshPublicGate();p.startNew();return true;}','09-new-private')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0],f=getApp().globalData.motionFixture;p.editBody({detail:{value:"离线校验：保存已发送，回执和读取暂时不可用。"}});f.unknownSave=true;f.failReads=true;await p.saveDraft();return {writeRecovery:p.data.writeRecovery,recoveryBusy:p.data.recoveryBusy,dirty:p.data.dirty};}','09-unknown-result')
capture('09-unknown-result')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0];getApp().globalData.motionFixture.failReads=false;await p.verifyWriteResult();return {writeRecovery:p.data.writeRecovery,dirty:p.data.dirty,notice:p.data.notice};}','10-verify-result')
capture('10-result-reconciled')
print(json.dumps({'captured':10,'project':project,'scope':'actual native composer sources with isolated in-memory service adapters; no real account or publication'},ensure_ascii=False))

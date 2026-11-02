from pathlib import Path
import json, subprocess

out = Path('/Users/mini/CISME/docs/evidence/community-compose-followup-20261101')
project = '/tmp/cisme-compose-native-20261101'

def call(tool, *args, name=None):
    result = subprocess.run(['wechatide', '-c', 'Codex', tool, '--project', project, *args], capture_output=True, text=True, timeout=40)
    if name:
        (out / (name + '.json')).write_text(result.stdout)
    response = json.loads(result.stdout[result.stdout.index('{'):])
    if not response.get('ok'):
        raise RuntimeError(result.stdout)
    return response

def evaluate(code, name):
    return call('automation_evaluate', '--fn-source', code, name=name)

def capture(name):
    return call('simulator_screenshot', '--path', str(out / (name + '.png')), '--optimize', 'false', name=name+'-receipt')

evaluate('function(){wx.switchTab({url:"/pages/community/index"});return true;}', '00-community')
evaluate('function(){getCurrentPages().slice(-1)[0].getTabBar().activateCommunityFab();return true;}', '01-open')
capture('native-01-empty')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0];p.editTitle({detail:{value:"今天的护理感受"}});p.editBody({detail:{value:"离线样式验证：照片、文字与发布声明均沿用真实小程序页面，不会发布到真实社区。"}});await p.saveDraft();return {state:p.data.state,postId:p.data.postId};}', '02-save')
evaluate('function(){const p=getCurrentPages().slice(-1)[0],f=getApp().globalData.motionFixture,post=f.posts[p.data.postId];post.media=Array.from({length:9},(_,i)=>({id:"cccccccc-cccc-4ccc-8ccc-"+String(i+1).padStart(12,"0"),state:"uploaded"}));p.applyDraft(post,false);return {files:p.data.files.length};}', '03-nine')
capture('native-02-nine-strip')
evaluate('function(){const p=getCurrentPages().slice(-1)[0];p.toggleSorting();return {sorting:p.data.sorting};}', '04-sorting')
capture('native-03-sorting')
evaluate('function(){const p=getCurrentPages().slice(-1)[0];p.toggleSorting();wx.pageScrollTo({scrollTop:10000,duration:0});return true;}', '05-declarations')
capture('native-04-declarations')
evaluate('function(){const p=getCurrentPages().slice(-1)[0],f=getApp().globalData.motionFixture,post=f.posts[p.data.postId];post.state="pending_review";post.version++;post.media=post.media.slice(0,1);f.holdPreviews=true;p.applyDraft(post,false);p.updateMedia(post.media[0].id,{localPath:"/assets/cisme/cisme-scalp-lab-avatar-v1.jpg"});wx.pageScrollTo({scrollTop:0,duration:0});return {state:p.data.state,files:p.data.files};}', '06-readonly-local')
capture('native-05-readonly-local-fallback')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0],f=getApp().globalData.motionFixture;p.nativeMedia="preview";p.onHide();(f.previewWaiters||[]).forEach(resolve=>resolve({url:"/assets/cisme/cisme-scalp-lab-avatar-v1.jpg"}));f.previewWaiters=[];await Promise.resolve();await Promise.resolve();f.holdPreviews=false;p.onShow();return {scope:"Manual native lifecycle stimulus; actual chooser cancellation covered by focused tests"};}', '07-readonly-return')
evaluate('function(){const p=getCurrentPages().slice(-1)[0];return {state:p.data.state,files:p.data.files};}', '08-readonly-confirm')
capture('native-06-readonly-preview-restored')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0],f=getApp().globalData.motionFixture,post=f.posts[p.data.postId];Object.assign(post,{state:"published",publicVersionActive:true,version:post.version+1});f.publicEnabled=true;await p.loadDraft(post.id,false);await p.refreshPublicGate();p.editTitle({detail:{value:"本机尚未保存的标题"}});p.editBody({detail:{value:"这段修改尚未保存。公开详情中的删除不应让本页的文字和图片消失。"}});p.openPublishedPost();return {stimulus:"Offline stub detail route, no real public post"};}', '09-detail-navigation')
evaluate('function(){const p=getCurrentPages().slice(-1)[0];if(typeof p.removeFixtureAndBack!=="function")throw new Error("Expected offline detail stimulus page");p.removeFixtureAndBack();return true;}', '10-detail-delete-return')
evaluate('function(){const p=getCurrentPages().slice(-1)[0];if(p.data.state!=="deleted"||!p.data.dirty||!p.data.files.length)throw new Error("Deleted return state did not retain inputs");return {state:p.data.state,dirty:p.data.dirty,version:p.data.version,files:p.data.files.length,body:p.data.body,publicVersionActive:p.data.publicVersionActive};}', '11-delete-confirm')
capture('native-07-deleted-dirty')
evaluate('function(){void getCurrentPages().slice(-1)[0].showMyPosts();return true;}', '12-exit-warning')
capture('native-08-deleted-exit-warning')
print(json.dumps({'captured':8,'scope':'Actual native composer with in-memory services and explicit detail/lifecycle stimuli; no real account, upload or publication'}, ensure_ascii=False))

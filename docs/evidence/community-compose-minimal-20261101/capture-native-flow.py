from pathlib import Path
import json, subprocess

out=Path('/Users/mini/CISME/docs/evidence/community-compose-minimal-20261101')
project='/tmp/cisme-compose-native-20261101'
def call(tool,*args,name):
    result=subprocess.run(['wechatide','-c','Codex',tool,'--project',project,*args],capture_output=True,text=True,timeout=40)
    (out/(name+'.json')).write_text(result.stdout)
    response=json.loads(result.stdout[result.stdout.index('{'):])
    if not response.get('ok'):raise RuntimeError(result.stdout)
    return response
def evaluate(code,name):return call('automation_evaluate','--fn-source',code,name=name)
def capture(name):return call('simulator_screenshot','--path',str(out/(name+'.png')),'--optimize','false',name=name+'-receipt')

evaluate('function(){return new Promise((resolve,reject)=>wx.switchTab({url:"/pages/community/index",success:()=>resolve(true),fail:reject}));}','01-community')
evaluate('function(){getCurrentPages().slice(-1)[0].getTabBar().activateCommunityFab();return true;}','02-open')
evaluate('async function(){getApp().globalData.motionFixture.publicEnabled=true;await getCurrentPages().slice(-1)[0].refreshPublicGate();return {scope:"Isolated positive capability fixture only; formal gate unchanged"};}','03-open-capability')
capture('native-01-editor-empty')
evaluate('function(){const p=getCurrentPages().slice(-1)[0],post=getApp().globalData.motionFixture.posts[p.data.postId];post.media=[{id:"cccccccc-cccc-4ccc-8ccc-000000000001",state:"uploaded"}];p.applyDraft(post,false);return true;}','04-one-photo')
capture('native-02-editor-one-photo')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0];p.editTitle({detail:{value:"今天的护理感受"}});p.editBody({detail:{value:"这是一段离线验收内容，使用真实小程序页面方法，不会进入正式社区。"}});await p.submit();if(!p.data.settingsExpanded)throw new Error("Missing consent did not open settings");return {settingsExpanded:p.data.settingsExpanded,error:p.data.error};}','05-submit-missing-confirmation')
capture('native-03-settings-required')
evaluate('function(){const p=getCurrentPages().slice(-1)[0];p.changeRights({detail:{value:true}});p.changeConsent({detail:{value:true}});return {rights:p.data.rightsConfirmed,consent:p.data.publicConsentConfirmed,error:p.data.error};}','06-confirm-settings')
capture('native-04-settings-confirmed')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0];p.togglePublishSettings();await p.submit();if(p.data.state!=="pending_review"||p.data.settingsExpanded)throw new Error("Submission did not reach readonly review");return {state:p.data.state,dirty:p.data.dirty,settingsExpanded:p.data.settingsExpanded};}','07-submit')
capture('native-05-review-pending')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0];await p.showMyPosts();return {listMode:p.data.listMode};}','08-my-posts')
capture('native-06-my-posts')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0],post=Object.values(getApp().globalData.motionFixture.posts)[0];Object.assign(post,{state:"awaiting_publication",revisionState:"approved",version:post.version+1});await p.loadDraft(post.id,false);return {state:p.data.state};}','09-awaiting-publication')
capture('native-07-awaiting-publication')
evaluate('async function(){const p=getCurrentPages().slice(-1)[0],post=getApp().globalData.motionFixture.posts[p.data.postId];Object.assign(post,{state:"published",publicVersionActive:true,version:post.version+1});await p.loadDraft(post.id,false);return {state:p.data.state,publicVersionActive:p.data.publicVersionActive};}','10-published-readback')
capture('native-08-published-readback')
evaluate('function(){const p=getCurrentPages().slice(-1)[0];p.editBody({detail:{value:"这段本机修改尚未保存。删除后返回仍应保留文字和图片。"}});p.openPublishedPost();return true;}','11-detail-navigation')
evaluate('function(){const p=getCurrentPages().slice(-1)[0];if(typeof p.removeFixtureAndBack!=="function")throw new Error("Expected isolated detail stimulus");p.removeFixtureAndBack();return true;}','12-detail-delete-return')
evaluate('function(){const p=getCurrentPages().slice(-1)[0];if(p.data.state!=="deleted"||!p.data.dirty||!p.data.files.length)throw new Error("Deleted return lost input");return {state:p.data.state,dirty:p.data.dirty,files:p.data.files.length};}','13-deletion-confirmed')
capture('native-09-deleted-retained')
evaluate('function(){void getCurrentPages().slice(-1)[0].showMyPosts();return true;}','14-exit-warning')
capture('native-10-deleted-exit-warning')
print(json.dumps({'captured':10,'scope':'Actual native composer with offline service fixtures. Review/publication/detail changes are explicit stimuli, not real moderation or public release.'}))

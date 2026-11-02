from pathlib import Path
import json, runpy, shutil

root = Path('/Users/mini/CISME')
runpy.run_path(str(root / 'docs/evidence/community-publish-loop-20261101/harness/prepare-native-fixture.py'))
fixture = Path('/tmp/cisme-compose-native-20261101')
shutil.copy2(root / 'apps/miniprogram/assets/icons/close-plum.svg', fixture / 'assets/icons/close-plum.svg')
api = fixture / 'services/api.ts'
text = api.read_text()
text = text.replace('delete fixture.posts[post.id];return {ok:true}', 'Object.assign(post,{state:"deleted",publicVersionActive:false,version:post.version+1});return {ok:true}')
text = text.replace('if(tail.endsWith("/preview-url"))return', 'if(tail.endsWith("/preview-url")&&fixture.holdPreviews)return await new Promise(resolve=>{(fixture.previewWaiters||(fixture.previewWaiters=[])).push(resolve);});\n  if(tail.endsWith("/preview-url"))return')
text = text.replace('if(fixture.unknownSave){fixture.unknownSave=false;', 'if(fixture.unknownSave){if(fixture.terminalOnSave)Object.assign(post,{state:fixture.terminalOnSave,publicVersionActive:false,version:post.version+1});fixture.unknownSave=false;')
api.write_text(text)
app_path = fixture / 'app.json'
app = json.loads(app_path.read_text())
app['pages'].append('pages/community-post/index')
app_path.write_text(json.dumps(app, ensure_ascii=False, indent=2))
stub = fixture / 'pages/community-post'
stub.mkdir(exist_ok=True)
(stub / 'index.json').write_text('{}')
(stub / 'index.ts').write_text('Page({data:{id:""},onLoad(q:any){this.setData({id:q.id});},removeFixtureAndBack(){const p=getApp<any>().globalData.motionFixture.posts[this.data.id];Object.assign(p,{state:"deleted",publicVersionActive:false,version:p.version+1});wx.navigateBack();}});')
(stub / 'index.wxml').write_text('<view class="page"><text>离线往返刺激页：不代表真实公开详情界面验收</text></view>')
(stub / 'index.wxss').write_text('.page{padding-top:110px;}')
print(json.dumps({'scope':'Actual composer sources unchanged; in-memory service and detail-return stimulus only','network':False,'persistentStorage':False}))

from pathlib import Path
import runpy,shutil,json,hashlib
root=Path('/Users/mini/CISME')
runpy.run_path(str(root/'docs/evidence/community-compose-followup-20261101/prepare-native-followup.py'))
source=root/'apps/miniprogram';fixture=Path('/tmp/cisme-compose-native-20261101')
files=[f'pages/community/index.{ext}' for ext in ['ts','wxml','wxss','json']]+[
 f'components/{component}/index.{ext}'
 for component in ['community-text-card','community-image-editor']
 for ext in ['ts','wxml','wxss','json']
]+[
 'services/community-compose-intent.ts','services/ugc-image-edit.ts','services/ugc-photo-effects.ts',
 'services/ugc-text-card-layout.ts','services/feed-projection.ts','services/editorial-publisher.ts']
for name in files:
 target=fixture/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source/name,target)
 if hashlib.sha256((source/name).read_bytes()).digest()!=hashlib.sha256(target.read_bytes()).digest():
  raise RuntimeError(f'Fixture source mismatch: {name}')
# Runtime imports are all local. The official Developer Tools TypeScript
# compiler supplies wx/WechatMiniprogram declarations; no npm runtime is copied.
# layout/layout-metrics and the in-memory commerce context adapter are prepared
# by the base fixture; photo-effects uses the unchanged text-card layout helper.
for dependency in ['services/layout.ts','services/layout-metrics.ts','services/commerce-command-store.ts']:
 if not (fixture/dependency).is_file():raise RuntimeError(f'Missing fixture dependency: {dependency}')
for name in ['images-plum.svg','camera-plum.svg','note-pencil-plum.svg','shield-check-plum.svg','magnifying-glass-plum.svg']:
 if (source/'assets/icons'/name).exists():shutil.copy2(source/'assets/icons'/name,fixture/'assets/icons'/name)
(fixture/'services/performance-metrics.ts').write_text('export const measurementClock=()=>Date.now();export function recordClientMetric(_value:any){}')
(fixture/'services/member-avatar.ts').write_text('export const defaultMemberAvatar="/assets/cisme/cisme-scalp-lab-avatar-v1.jpg";export async function localMemberAvatar(){return defaultMemberAvatar;}export async function prepareFeedAuthors(){return {};}export async function prepareFeedPage(value:any){return value.items||[];}')
(fixture/'services/member-identity.ts').write_text('export function memberIdentity(){return {id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};}')
(fixture/'services/task-entry.ts').write_text('export function consumerTaskEntries(){return [];}')
(fixture/'services/editorial.ts').write_text('''export type PublishedEditorialCard=any;
const cover="/assets/cisme/cisme-scalp-lab-avatar-v1.jpg";
const rows=[{id:"offline-editorial",title:"每一次真实分享",excerpt:"离线原生入口验收，不读取真实会员数据",author:"CISME头皮实验室",coverUrl:cover,likeCount:0,publishedAt:"2026-11-01T00:00:00Z"}];
export function editorialStoriesForRuntime(){return rows.map(row=>({...row,image:cover,kind:"editorial",engagementLabel:"离线样本"}));}
export function editorialMediaSrc(value:string){return value;}
export async function publishedEditorialArticles(){return {items:rows,nextCursor:null};}
export function expiredEditorialRead(){return false;}
''')
api=fixture/'services/api.ts';text=api.read_text()
text=text.replace('export async function uploadAuthorized(){throw new Error("Use isolated unit/integration upload tests");}', '''export async function uploadAuthorized(path:string,_authorization:any,options:any){
 await new Promise<void>((resolve,reject)=>wx.getFileSystemManager().getFileInfo({filePath:path,success:()=>resolve(),fail:reject}));(fixture.mediaLocalPaths||(fixture.mediaLocalPaths={} ))[_authorization.mediaId]=path;options?.onProgress?.(100);
}''')
text=text.replace('fixture.calls.push({method,path});','fixture.calls.push({method,path,dataKeys:Object.keys(options.data||{})});')
text=text.replace('if(path==="/v1/ugc/status")return', '''if(path==="/v1/capabilities")return {communityPreviewEnabled:false} as T;
 if(path.startsWith("/v1/feed/page")||path.startsWith("/v1/ugc/posts?"))return {items:[],nextCursor:null} as T;
 if(path==="/v1/me/community-access")return {canReview:false} as T;
 if(path==="/v1/me/tasks")return [] as T;
 if(path==="/v1/ugc/status")return''')
text=text.replace('const tail=match[2];','''const tail=match[2];
  if(tail==="/media/authorize"&&method==="POST"){const id="dddddddd-dddd-4ddd-8ddd-"+String(++fixture.sequence).padStart(12,"0");return {mediaId:id,url:"offline-only-no-network",method:"PUT",fields:{}} as T;}
  if(tail.endsWith("/complete")&&method==="POST")return {state:"uploaded"} as T;''')
text=text.replace('Object.values(fixture.posts).filter((p:any)=>filter==="all"||p.state===filter)','Object.values(fixture.posts).filter((p:any)=>p.state!=="deleted"&&(filter==="all"||p.state===filter))')
text=text.replace('if(tail.endsWith("/preview-url"))return {url:"/assets/cisme/cisme-scalp-lab-avatar-v1.jpg"} as T;', r'if(tail.endsWith("/preview-url")){const id=(tail.match(/media\/([^/]+)\/preview-url/)||[])[1];return {url:fixture.mediaLocalPaths?.[id]||"/assets/cisme/cisme-scalp-lab-avatar-v1.jpg"} as T;}')
api.write_text(text)
app=json.loads((fixture/'app.json').read_text());app['window']['backgroundColor']='#f7f1f8';(fixture/'app.json').write_text(json.dumps(app,ensure_ascii=False,indent=2))
print(json.dumps({'sourceIdenticalCommunity':True,'sourceIdenticalComposer':True,'sourceIdenticalCardAndMediaHelpers':True,'sourceIdenticalImageEditorAndEffects':True,'network':False,'persistentStorage':False,'scope':'Only service adapters/auth and fixture detail-return stimulus replaced'}))

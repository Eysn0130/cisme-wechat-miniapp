from pathlib import Path
import json,shutil
source=Path('/Users/mini/CISME/apps/miniprogram')
preview=Path('/tmp/cisme-compose-native-20261101')
preview.mkdir(exist_ok=True)
for name in ['custom-tab-bar/index.ts','custom-tab-bar/index.wxss','custom-tab-bar/index.wxml','custom-tab-bar/index.json','services/layout.ts','services/layout-metrics.ts','services/route-access.ts','app.wxss','pages/community-compose/index.ts','pages/community-compose/index.wxml','pages/community-compose/index.wxss','pages/community-compose/index.json']:
    target=preview/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source/name,target)
(preview/'services/commerce-command-store.ts').write_text('export function commerceContextRevision(){return 0;}\n')
(preview/'services/page-requests.ts').write_text('import {request} from "./api"; export function pageRead<T>(_page:unknown,options:any):Promise<T>{return request<T>(options);} export function cancelPageReads(_page:unknown){}\n')
(preview/'services/ugc-local-backup.ts').write_text('export type UgcLocalBackup=any;const backups=new Map<string,any>();const key=(o:string,p:string,v:number)=>`${o}:${p}:${v}`;export function writeUgcBackup(b:any){backups.set(key(b.ownerId,b.postId,b.baseVersion),JSON.parse(JSON.stringify(b)));}export function readUgcBackup(o:string,p:string,v:number){return backups.get(key(o,p,v))||null;}export function clearUgcBackup(o:string,p:string,v:number){backups.delete(key(o,p,v));}\n')
(preview/'services/api.ts').write_text('''const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const clone=(x:any)=>JSON.parse(JSON.stringify(x));
const fixture:any={publicEnabled:false,draftsEnabled:true,posts:{},keys:{},sequence:0,failReads:false,unknownSave:false,calls:[]};
export function requireMemberAccess(){return true;}
export function resumeAuthentication(){throw new Error("Offline fixture has no real authentication");}
export async function uploadAuthorized(){throw new Error("Use isolated unit/integration upload tests");}
export async function request<T>(options:any):Promise<T>{
 const app=getApp<any>();app.globalData.motionFixture=fixture;
 const method=options.method||"GET",path=options.path;fixture.calls.push({method,path});
 if(path==="/v1/ugc/status")return {publicEnabled:fixture.publicEnabled,draftsEnabled:fixture.draftsEnabled} as T;
 if(method==="GET"&&fixture.failReads)throw {status:0,title:"离线场景：读取暂未确认"};
 if(path.startsWith("/v1/me/ugc/posts?")){
   const filter=decodeURIComponent((path.match(/[?&]state=([^&]+)/)||[])[1]||"all");
   const items=Object.values(fixture.posts).filter((p:any)=>filter==="all"||p.state===filter).map((p:any)=>({...clone(p),imageCount:p.media.length}));
   return {items,matchingTotal:items.length,nextCursor:null} as T;
 }
 if(path==="/v1/me/ugc/posts"&&method==="POST"){
   if(fixture.keys[options.idempotencyKey])return clone(fixture.posts[fixture.keys[options.idempotencyKey]]);
   const id="bbbbbbbb-bbbb-4bbb-8bbb-"+String(++fixture.sequence).padStart(12,"0");
   const draft={id,ownerId:owner,state:"draft",revision:1,version:1,publishedRevision:null,revisionState:"unreviewed",publicVersionActive:false,title:"",body:"",aiUsage:"unknown",rightsConfirmed:false,publicConsentConfirmed:false,media:[],reviewNote:null,reviewedAt:null,hiddenReason:null,hiddenAt:null,hiddenPublished:null,appeal:null};
   fixture.posts[id]=draft;fixture.keys[options.idempotencyKey]=id;return clone(draft);
 }
 const match=path.match(/^\\/v1\\/me\\/ugc\\/posts\\/([^/?]+)(.*)$/);
 if(match){const post=fixture.posts[match[1]];if(!post)throw {status:404,title:"内容不存在"};
  const tail=match[2];
  if(tail===""&&method==="GET")return clone(post);
  if(tail===""&&method==="DELETE"){delete fixture.posts[post.id];return {ok:true} as T;}
  if(tail.endsWith("/preview-url"))return {url:"/assets/cisme/cisme-scalp-lab-avatar-v1.jpg"} as T;
  if(tail==="/draft"&&method==="PUT"){
   if(post.version!==options.data.expectedVersion)throw {status:409,code:"UGC_VERSION_CONFLICT",title:"草稿版本已有更新"};
   const data=options.data;Object.assign(post,{...data,version:post.version+1,revision:post.revision+1,media:data.mediaIds.map((id:string)=>({id,state:"uploaded"}))});delete post.mediaIds;delete post.expectedVersion;
   if(fixture.unknownSave){fixture.unknownSave=false;throw {status:0,title:"离线场景：保存回执暂未确认"};}
   return clone(post);
  }
  if(tail==="/submit"&&method==="POST"){
   if(!fixture.publicEnabled)throw {status:503,title:"公开投稿暂未开放"};
   Object.assign(post,{state:"pending_review",revisionState:"pending",version:post.version+1});return clone(post);
  }
 }
 throw {status:422,title:"离线夹具未声明该操作"};
}
''')
(preview/'app.ts').write_text('App({globalData:{sessionToken:"offline-fixture-only",apiBaseUrl:"",motionFixture:null}});\n')
actual=json.loads((source/'app.json').read_text())
app={'pages':[f'pages/{n}/index' for n in ['home','records','community','profile']],'subPackages':[{'root':'pages/community-compose','pages':['index']}],'window':actual['window'],'tabBar':actual['tabBar'],'lazyCodeLoading':actual['lazyCodeLoading']}
(preview/'app.json').write_text(json.dumps(app,ensure_ascii=False,indent=2))
config=json.loads((source/'project.config.json').read_text());config['projectname']='cisme-publish-loop-offline';config['packOptions']={'ignore':[],'include':[]}
(preview/'project.config.json').write_text(json.dumps(config,ensure_ascii=False,indent=2))
for i,name in enumerate(['home','records','community','profile']):
    page=preview/f'pages/{name}';page.mkdir(parents=True,exist_ok=True)
    (page/'index.json').write_text('{}')
    (page/'index.ts').write_text('Page({onShow(){const tab=this.getTabBar?.();tab?.syncActive?.('+str(i)+');tab?.setCommunityPublisherAvailable?.('+str(i==2).lower()+',"写仅自己可见的草稿");},onHide(){this.getTabBar?.()?.setCommunityPublisherAvailable?.(false);},openPublisher(){wx.navigateTo({url:"/pages/community-compose/index?new=1"});}});\n')
    (page/'index.wxml').write_text('<view class="page"><view class="title">CISME 原生发布校验</view><view class="subtitle">离线场景 · 不读取或写入真实会员数据</view></view>\n')
    (page/'index.wxss').write_text('.page{padding-top:103px;}\n')
icons=['drop-muted.svg','drop-active.svg','clipboard-text-muted.svg','clipboard-text-active.svg','users-muted.svg','users-active.svg','user-muted.svg','user-active.svg','plus-white.svg','stepper-plus-plum.svg','arrow-left-ink.svg']
(preview/'assets/icons').mkdir(parents=True,exist_ok=True)
for name in icons:shutil.copy2(source/'assets/icons'/name,preview/'assets/icons'/name)
(preview/'assets/cisme').mkdir(parents=True,exist_ok=True)
shutil.copy2(source/'assets/cisme/cisme-scalp-lab-avatar-v1.jpg',preview/'assets/cisme/cisme-scalp-lab-avatar-v1.jpg')
print(json.dumps({'preview':str(preview),'network':False,'persistentStorage':False,'copiedPage':'actual TS/WXML/WXSS/JSON unchanged'},ensure_ascii=False))

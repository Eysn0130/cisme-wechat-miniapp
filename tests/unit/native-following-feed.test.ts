import {nativePageTemplate} from "../helpers/native-page-template";
// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({token:'actor-a',revision:0,origin:'https://synthetic.invalid',request:vi.fn(),login:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,resumeAuthentication:m.login}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>m.revision}));
vi.mock('../../apps/miniprogram/services/member-identity',()=>({memberIdentity:()=>null}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({defaultMemberAvatar:'/avatar',localMemberAvatar:async()=>'/avatar',prepareFeedPage:async(p:any)=>p.items,prepareFeedAuthors:async(p:any)=>p}));
const simulate=createRequire(import.meta.url)('miniprogram-simulate');
const uuid=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const card=(id:string,kind='formal')=>({id:uuid(id),kind,authorId:uuid('f'),author:'合成作者',avatar:'',avatarRevision:null,title:`动态${id}`,excerpt:'合成公开内容',coverUrl:null,publishedAt:'2026-11-03T00:00:00Z',likeCount:0});
const deferred=()=>{let resolve!:(v:any)=>void,reject!:(v:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();await new Promise(r=>setTimeout(r,0));};
let page:any,rendered:any,wx:any,following:any,queue:Array<ReturnType<typeof deferred>>,requests:string[];
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();m.token='actor-a';m.revision=0;m.origin='https://synthetic.invalid';queue=[];requests=[];following={items:[],nextCursor:null};
 m.request.mockImplementation(async({path}:any)=>{requests.push(path);if(path.startsWith('/v1/me/community/following?'))return queue.shift()?.promise??following;
  if(path==='/v1/capabilities')return{communityPreviewEnabled:false};if(path==='/v1/ugc/status')return{publicEnabled:false,draftsEnabled:false};
  if(path==='/v1/me/community-access')return{canReview:false};if(path==='/v1/me/tasks')return[];
  if(path==='/v1/editorial/articles?limit=20')return{items:[{...card('e','editorial'),saveCount:0}],nextCursor:null};
  if(path==='/v1/ugc/posts?limit=30'||path==='/v1/feed/page?limit=30')return{items:[],nextCursor:null};throw Error('Unexpected read '+path);
 });
 wx={navigateTo:vi.fn(),stopPullDownRefresh:vi.fn()};Object.assign(globalThis,{wx,getApp:()=>({globalData:{sessionToken:m.token,apiBaseUrl:m.origin,cloudFunction:null}}),getCurrentPages:()=>[]});
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(patch:any,cb?:()=>void){
  for(const [path,value]of Object.entries(patch)){const keys=path.replace(/\[(\d+)\]/g,'.$1').split('.');let target=this.data;for(const key of keys.slice(0,-1))target=target[key];target[keys.at(-1)!]=value;}
  rendered?.setData(structuredClone(this.data));cb?.();}};};
 await import('../../apps/miniprogram/pages/community/index');
 const id=simulate.load({template:nativePageTemplate('apps/miniprogram/pages/community/index.wxml'),data:structuredClone(page.data)});rendered=simulate.render(id);rendered.attach(document.body);
 await page.load();await flush();
});
afterEach(()=>{page.onUnload();rendered.detach();rendered=null;});
const select=(mode:string)=>page.selectMode({currentTarget:{dataset:{mode}}});
const ids=()=>page.data.feedColumns.flat().map((x:any)=>x.id);

it('always places Following next to Featured even while public UGC and development previews are closed',()=>{
 expect(rendered.querySelectorAll('.community-mode__tab').slice(0,2).map((x:any)=>x.dom.textContent)).toEqual(['精选','关注']);
 expect(page.data.mode).toBe('featured');expect(requests.some(p=>p.startsWith('/v1/me/community/following'))).toBe(false);
});
it('keeps the requested channel across explicit login and never requests a guest following list',async()=>{
 m.token='';page.onShow();await flush();await select('following');expect(m.login).toHaveBeenCalledExactlyOnceWith('/pages/community/index');
 expect(page.data.mode).toBe('featured');expect(requests.some(p=>p.startsWith('/v1/me/community/following'))).toBe(false);
 following={items:[card('a')],nextCursor:null};m.token='new-account';page.onShow();await flush();
 expect(page.data.mode).toBe('following');expect(ids()).toEqual([uuid('a')]);
});
it('uses the authenticated timeline rather than appending un-followed curated content',async()=>{
 following={items:[card('a','editorial'),card('b','formal'),card('c','ugc')],nextCursor:null};await select('following');
 expect(ids().sort()).toEqual([uuid('a'),uuid('b'),uuid('c')]);expect(ids()).not.toContain(uuid('e'));
 expect(Object.fromEntries(page.data.feedColumns.flat().map((x:any)=>[x.id,x.kind]))).toEqual({[uuid('a')]:'editorial',[uuid('b')]:'formal',[uuid('c')]:'ugc'});
 expect(rendered.dom.textContent).toContain('关注动态');expect(rendered.dom.textContent).not.toContain('邀请活动');
});
it.each([['editorial','/pages/post/index?id=','&source=editorial'],['formal','/pages/post/index?id=','&source=formal'],['ugc','/pages/post/index?id=','']])('opens a %s card with its original source and detail route',async(kind,prefix,suffix)=>{
 following={items:[card('a',kind)],nextCursor:null};await select('following');page.openPost({currentTarget:{dataset:{id:uuid('a')}}});
 expect(wx.navigateTo.mock.calls[0][0].url).toBe(prefix+uuid('a')+suffix);
});
it('appends the next globally ordered page and de-duplicates without moving existing cards',async()=>{
 following={items:[card('a'),card('b')],nextCursor:'next-cursor'};await select('following');const first=rendered.querySelector('.feed-card').dom;
 following={items:[card('b'),card('c'),card('c')],nextCursor:null};await page.onReachBottom();
 expect(ids().sort()).toEqual([uuid('a'),uuid('b'),uuid('c')]);expect(rendered.querySelector('.feed-card').dom).toBe(first);
 expect(requests).toContain('/v1/me/community/following?limit=30&cursor=next-cursor');
});
it('preserves existing cards during a same-owner return read and applies freshly published posts afterwards',async()=>{
 following={items:[card('a')],nextCursor:null};await select('following');const first=rendered.querySelector('.feed-card').dom;
 const read=deferred();queue.push(read);page.onHide();page.onShow();await flush();
 expect(page.data).toMatchObject({mode:'following',loading:true,feedReady:true});expect(rendered.querySelector('.feed-card').dom).toBe(first);expect(rendered.querySelector('.page-read-loading')).toBeFalsy();
 read.resolve({items:[card('b'),card('a')],nextCursor:null});await flush();expect(ids().sort()).toEqual([uuid('a'),uuid('b')]);expect(page.data.loading).toBe(false);
});
it('preserves a confirmed empty state during refresh and offers a return to Featured',async()=>{
 await select('following');const empty=rendered.querySelector('.community-following-empty').dom;expect(empty.textContent).toContain('去精选发现作者');
 const read=deferred();queue.push(read);const refresh=page.onPullDownRefresh();await flush();expect(rendered.querySelector('.community-following-empty').dom).toBe(empty);
 read.resolve({items:[],nextCursor:null});await refresh;expect(wx.stopPullDownRefresh).toHaveBeenCalledOnce();
});
it.each(['account','environment'])('drops an old %s completion without clearing the new read',async(change)=>{
 const old=deferred();queue.push(old);const pending=select('following');await flush();page.onHide();
 if(change==='account')m.token='actor-b';else{m.origin='https://other.invalid';m.revision++;}
 following={items:[card('b')],nextCursor:null};page.onShow();await flush();expect(ids()).toEqual([uuid('b')]);
 old.reject({status:401});await pending;expect(ids()).toEqual([uuid('b')]);expect(page.data.error).toBe('');
});
it('lets a user leave a slow Following read and ignores the older A→B→A response',async()=>{
 const old=deferred();queue.push(old);const first=select('following');await flush();await select('featured');
 const fresh=deferred();queue.push(fresh);const second=select('following');await flush();old.resolve({items:[card('a')],nextCursor:null});await first;
 expect(page.data.loading).toBe(true);expect(ids()).not.toContain(uuid('a'));fresh.resolve({items:[card('b')],nextCursor:null});await second;expect(ids()).toEqual([uuid('b')]);
});
it('shows a failed first read as an error, not an empty list, and retains cards after a page failure',async()=>{
 const first=deferred();queue.push(first);const loading=select('following');first.reject({status:503});await loading;
 expect(rendered.querySelector('.community-following-empty')).toBeFalsy();expect(page.data.error).toContain('暂时无法更新');
 following={items:[card('a')],nextCursor:'next'};await page.loadFollowing();const next=deferred();queue.push(next);const more=page.onReachBottom();next.reject({status:503});await more;
 expect(ids()).toEqual([uuid('a')]);expect(page.data.moreError).toContain('已显示的故事保留');expect(page.data.followingNextCursor).toBe('next');
});
it('keeps publisher and review operations intact when a pull gesture arrives',async()=>{
 const before=requests.length;page.data.publishEntryOpen=true;await page.onPullDownRefresh();expect(requests).toHaveLength(before);
 page.data.publishEntryOpen=false;page.data.reviewBusy=true;await page.onPullDownRefresh();expect(requests).toHaveLength(before);expect(wx.stopPullDownRefresh).toHaveBeenCalledTimes(2);
});

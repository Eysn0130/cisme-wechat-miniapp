import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({request:vi.fn(),token:'member-a'}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,resumeAuthentication:vi.fn(),beginLegalRenewal:vi.fn(),clearAuthenticationRedirectSuppression:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',motionDuration:()=>0}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({defaultMemberAvatar:'/default.svg',localMemberAvatar:async(value:string)=>value||'/default.svg',prepareFeedAuthors:async(value:unknown)=>value}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>1}));
const postId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',authorId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',mediaId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let page:any,wxMock:any;
const article=(patch={})=>({id:postId,authorId,author:'HEHEHE',avatar:'',avatarRevision:null,title:'个人护理记录',body:'真实作者自己的内容',version:3,publishedAt:'2026-11-04T10:00:00Z',
 isMine:true,following:false,liked:false,saved:false,likeCount:0,saveCount:0,aiUsage:'unknown',media:[{id:mediaId,position:0}],commentsTotal:0,...patch});
beforeEach(async()=>{
 vi.resetModules();m.request.mockReset();m.token='member-a';
 wxMock={hideShareMenu:vi.fn(),showShareMenu:vi.fn(),navigateTo:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn(),showToast:vi.fn(),showModal:vi.fn(),getStorageSync:vi.fn(),hideKeyboard:vi.fn()};
 Object.assign(globalThis,{wx:wxMock,getApp:()=>({globalData:{sessionToken:m.token,privacyRightsToken:'',apiBaseUrl:'https://synthetic.invalid'}}),
  Page:(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(patch:any,callback?:()=>void){Object.assign(this.data,patch);callback?.();}};}});
 await import('../../apps/miniprogram/pages/post/index');
});

describe('legacy ordinary-post links',()=>{
 it('redirects once to the shared detail without making any API request',async()=>{
  wxMock.redirectTo=vi.fn();await import('../../apps/miniprogram/pages/community-post/index');
  page.onLoad({id:postId});page.open();
  expect(wxMock.redirectTo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url:`/pages/post/index?id=${postId}&source=formal`}));
  expect(m.request).not.toHaveBeenCalled();
 });
 it('keeps a failed redirect retryable and discards errors after unload',async()=>{
  wxMock.redirectTo=vi.fn();await import('../../apps/miniprogram/pages/community-post/index');
  page.onLoad({id:postId});const first=wxMock.redirectTo.mock.calls[0][0];first.fail();first.complete();
  expect(page.data.error).toContain('重试');page.open();expect(wxMock.redirectTo).toHaveBeenCalledTimes(2);
  page.onUnload();wxMock.redirectTo.mock.calls[1][0].fail();expect(page.data.error).toBe('');
  expect(m.request).not.toHaveBeenCalled();
 });
 it('rejects malformed links without navigation or reads',async()=>{
  wxMock.redirectTo=vi.fn();await import('../../apps/miniprogram/pages/community-post/index');page.onLoad({id:'../private'});
  expect(page.data.error).toContain('无效');expect(wxMock.redirectTo).not.toHaveBeenCalled();expect(m.request).not.toHaveBeenCalled();
 });
});
function answer(patch={}){m.request.mockImplementation(async({path}:any)=>path.includes('/comments?')?{items:[],nextCursor:null,matchingTotal:0}:article(patch));}
describe('one shared detail for public normal posts',()=>{
 it('uses the real author and public UGC images with the featured renderer',async()=>{
  answer();page.onLoad({id:postId,source:'formal'});await page.load();
  expect(page.data).toMatchObject({formalSource:true,editorialSource:true,item:{id:postId,kind:'formal',author:'HEHEHE',avatar:'/default.svg',isMine:true,readingSegments:expect.any(Array)},media:[`https://synthetic.invalid/v1/ugc/media/${mediaId}`]});
  expect(m.request.mock.calls.every(([r])=>!r.path.includes('/editorial/'))).toBe(true);
  expect(page.onShareAppMessage().path).toBe(`/pages/post/index?id=${postId}&source=formal`);
 });
 it('keeps brand-like personal nicknames separate from the official publisher avatar',async()=>{
  answer({author:'CISME头皮实验室'});page.onLoad({id:postId,source:'formal'});await page.load();
  expect(page.data.item.avatar).toBe('/default.svg');expect(page.data.item.authorId).toBe(authorId);
 });
 it('opens the actual own composer and denies visitor or changed-session edits',async()=>{
  answer();page.onLoad({id:postId,source:'formal'});await page.load();page.editOwn();
  expect(wxMock.navigateTo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url:`/pages/community-compose/index?id=${postId}`}));
  wxMock.navigateTo.mockClear();page.data.leaving=false;page.data.item.isMine=false;page.editOwn();expect(wxMock.navigateTo).not.toHaveBeenCalled();
  page.data.item.isMine=true;m.token='member-b';page.editOwn();expect(wxMock.navigateTo).not.toHaveBeenCalled();
 });
 it('never promotes an editorial manager into a normal post owner',async()=>{
  answer({isMine:false,canManage:true});page.onLoad({id:postId,source:'formal'});await page.load();
  expect(page.canManageOwnPost()).toBe(false);expect(page.data.item.canManage).toBe(false);await page.deleteOwn();expect(wxMock.showModal).not.toHaveBeenCalled();
 });
 it('preserves the formal namespace in the author link',async()=>{
  answer();page.onLoad({id:postId,source:'formal'});await page.load();page.openAuthor();
  expect(wxMock.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:`/pages/community-author/index?id=${authorId}&source=formal`}));
 });
});

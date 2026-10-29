import {beforeEach,describe,expect,it,vi} from 'vitest';
// Exercise the actual API/coordinator/HTTP and Account together. Only native
// transport callbacks and unrelated avatar/layout/share adapters are synthetic.
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',motionDuration:()=>0,shouldReduceMotion:()=>false}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({defaultMemberAvatar:'local-avatar',clearMemberAvatarCache:vi.fn(),localMemberAvatar:async()=> 'local-avatar',prepareAvatarUpload:vi.fn()}));
vi.mock('../../apps/miniprogram/services/share',()=>({attributePendingShare:vi.fn()}));
vi.mock('../../apps/miniprogram/release-config',()=>({legalDocumentVersions:()=>({terms:'current-terms',privacy:'current-privacy',localFixture:false}),shouldUseDevelopmentIdentity:()=>false}));
let storage:Map<string,unknown>,runtime:any,page:any,definition:any,pages:any[],wxMock:any,requests:any[],holdIdentity:boolean,heldIdentity:any,expireMe:boolean,meFailure:""|"network"|"unavailable",holdMe:boolean,heldMe:(()=>void)|null;
const home='/pages/home/index',old='/pages/management-fulfillment/index';
const article='/pages/post/index?id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&source=editorial';
function flowQuery(url:string){return Object.fromEntries(new URL('https://synthetic.invalid'+url).searchParams);}
function response(options:any){const path=new URL(options.url).pathname;
 if(path==='/v1/me'&&holdMe){heldMe=()=>options.success({statusCode:200,data:{id:'synthetic-member'}});return;}
 if(path==='/v1/me'&&meFailure==='network'){options.fail({errMsg:'request:fail network unavailable'});return;}
 if(path==='/v1/me'&&meFailure==='unavailable'){options.success({statusCode:503,data:{code:'SERVICE_UNAVAILABLE'}});return;}
 if(path==='/v1/me'&&expireMe){options.success({statusCode:401,data:{code:'AUTH_EXPIRED'}});return;}
 const data=path==='/v1/me'?{id:'synthetic-member'}:path==='/v1/identity/wechat'?{sessionToken:'synthetic-new-session'}:path==='/v1/me/legal-acceptances'?{accepted:true,documents:options.data.consents}:path==='/v1/identity/capabilities'?{phoneBindingEnabled:false}:{};
 if(path==='/v1/identity/wechat'&&holdIdentity){heldIdentity=()=>options.success({statusCode:200,data});return;}
 options.success({statusCode:200,data});
}
async function mount(query:Record<string,string>={intent:'login'}){await import('../../apps/miniprogram/pages/account/index');page={...definition,data:structuredClone(definition.data),setData(values:any,callback?:()=>void){Object.assign(this.data,values);callback?.();}};page.onLoad(query);Object.assign(page.data,{legalLoading:false,legalTextsReady:true,agreementAccepted:true});return page;}
async function start(source:string,intent:'login'|'renew'='login') {const api=await import('../../apps/miniprogram/services/api');if(intent==='renew')api.beginLegalRenewal(source);else api.beginAuthentication(source);return {api,query:flowQuery(wxMock.navigateTo.mock.calls.at(-1)[0].url)};}
function paths(){return requests.map(x=>new URL(x.url).pathname);}
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();storage=new Map();runtime={globalData:{sessionToken:'',privacyRightsToken:'',sessionStorageKey:'synthetic.session',apiBaseUrl:'https://synthetic.invalid'}};pages=[{route:'pages/account/index',options:{intent:'login'}}];requests=[];holdIdentity=false;heldIdentity=null;expireMe=false;meFailure="";holdMe=false;heldMe=null;
 (globalThis as any).getApp=()=>runtime;(globalThis as any).getCurrentPages=()=>pages;
 (globalThis as any).Page=(value:any)=>{definition=value;};
 wxMock={getAccountInfoSync:()=>({miniProgram:{envVersion:'trial'}}),getDeviceInfo:()=>({platform:'ios'}),getStorageSync:(key:string)=>storage.get(key)||'',getStorageInfoSync:()=>({keys:[...storage.keys()]}),setStorageSync:vi.fn((key:string,value:unknown)=>storage.set(key,value)),removeStorageSync:vi.fn((key:string)=>storage.delete(key)),login:vi.fn(async()=>({code:'synthetic-login-code'})),navigateTo:vi.fn(),reLaunch:vi.fn(),switchTab:vi.fn((o:any)=>o.success?.()),navigateBack:vi.fn((o:any)=>o.success?.()),redirectTo:vi.fn((o:any)=>o.success?.()),showModal:vi.fn(async()=>({confirm:true})),showToast:vi.fn(),pageScrollTo:vi.fn(),enableAlertBeforeUnload:vi.fn(),disableAlertBeforeUnload:vi.fn(),request:vi.fn((o:any)=>{requests.push(o);queueMicrotask(()=>response(o));return {abort:vi.fn()};})};(globalThis as any).wx=wxMock;
});
describe('Account return destinations belong to one live authentication flow',()=>{
 it.each([{intent:'login'},{}])('ignores a persisted old management target at direct/cold entry %j',async(query)=>{storage.set('cisme.authReturnUrl',old);await mount(query);await page.login();expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:home}));expect(wxMock.redirectTo).not.toHaveBeenCalled();expect(storage.has('cisme.authReturnUrl')).toBe(false);expect(paths().filter(x=>x==='/v1/identity/wechat')).toHaveLength(1);});
 it('discards a cold-restarted flow query without a matching in-memory flow',async()=>{storage.set('cisme.authReturnUrl',old);await mount({intent:'login',authFlow:'previous-process-flow'});await page.login();expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:home}));expect(wxMock.redirectTo).not.toHaveBeenCalled();expect(storage.has('cisme.authReturnUrl')).toBe(false);});
 it('clears an abandoned native-back flow before a new direct login',async()=>{const {query}=await start(old);await mount(query);page.onUnload();await mount();await page.login();expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:home}));expect(storage.has('cisme.authReturnUrl')).toBe(false);});
 it.each([article,'/pages/settings/index?section=addresses'])('keeps an original source page and its unsaved local state: %s',async(source)=>{const {query}=await start(source);const original={route:source.split('?')[0]!.slice(1),draft:{text:'synthetic unsaved text'}};pages=[original,{route:'pages/account/index',options:query}];await mount(query);await page.login();expect(page.data.pendingDestination).toBe(source);expect(wxMock.navigateBack).toHaveBeenCalledWith(expect.objectContaining({delta:1}));expect(pages[0]).toBe(original);expect(original.draft.text).toBe('synthetic unsaved text');expect(wxMock.redirectTo).not.toHaveBeenCalled();});
 it('preserves the full source query when a stack fallback is necessary',async()=>{const {query}=await start(article);await mount(query);await page.login();expect(wxMock.redirectTo).toHaveBeenCalledWith(expect.objectContaining({url:article}));});
 it('keeps page-owned return context across a legal-page hide/show',async()=>{const {query}=await start(article);await mount(query);page.onHide();page.onShow();await Promise.resolve();await page.login();expect(page.data.pendingDestination).toBe(article);expect(wxMock.redirectTo).toHaveBeenCalledWith(expect.objectContaining({url:article}));});
 it('does not let another automatic redirect overwrite an already-open flow',async()=>{const {api,query}=await start(article);api.beginAuthentication(old);expect(wxMock.navigateTo).toHaveBeenCalledOnce();await mount(query);await page.login();expect(wxMock.redirectTo).toHaveBeenCalledWith(expect.objectContaining({url:article}));});
 it('does not cancel a newer flow when an older Account unloads',async()=>{const {api,query}=await start(article);await mount(query);const oldPage=page;api.cancelAuthentication(query.authFlow);const next=await start('/pages/settings/index?section=addresses');oldPage.onUnload();await mount(next.query);await page.login();expect(wxMock.redirectTo).toHaveBeenCalledWith(expect.objectContaining({url:'/pages/settings/index?section=addresses'}));});
 it('clears cancelled guest context and never exchanges identity while browsing',async()=>{const {query}=await start(old);await mount(query);await page.browseCommunity();expect(storage.has('cisme.authReturnUrl')).toBe(false);expect(storage.get('cisme.guestBrowsing')).toBe(true);expect(wxMock.login).not.toHaveBeenCalled();expect(paths()).not.toContain('/v1/identity/wechat');await mount();await page.login();expect(wxMock.switchTab).toHaveBeenLastCalledWith(expect.objectContaining({url:home}));});
 it('returns back to a protected source once without an automatic login loop',async()=>{const {api,query}=await start('/pages/settings/index');await mount(query);await page.back();expect(api.requireMemberAccess('/pages/settings/index')).toBe(false);expect(wxMock.navigateTo).toHaveBeenCalledOnce();expect(wxMock.login).not.toHaveBeenCalled();expect(storage.has('cisme.authReturnUrl')).toBe(false);api.resumeAuthentication(article);expect(wxMock.navigateTo).toHaveBeenCalledTimes(2);});
 it('ignores an identity response after cancellation and does not consume a new target',async()=>{const {query}=await start(article);await mount(query);holdIdentity=true;const login=page.login();await vi.waitFor(()=>expect(heldIdentity).toBeTypeOf('function'));await page.browseCommunity();heldIdentity();await login;expect(runtime.globalData.sessionToken).toBe('');expect(wxMock.redirectTo).not.toHaveBeenCalled();expect(wxMock.switchTab).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url:'/pages/community/index'}));});
 it('claims only a matching environment/session/intent flow',async()=>{const {api,query}=await start(article);runtime.globalData.apiBaseUrl='https://other.synthetic.invalid';expect(api.consumeAuthReturnUrl(query.authFlow,'login')).toBe(home);expect(api.consumeAuthReturnUrl(query.authFlow,'login')).toBe(home);runtime.globalData.sessionToken='synthetic-existing-session';const renewed=await start(article,'renew');expect(api.consumeAuthReturnUrl(renewed.query.authFlow,'login')).toBe(home);});
 it('keeps the first current 401 source when another protected guard fires before Account loads',async()=>{runtime.globalData.sessionToken='synthetic-expired-session';pages=[{route:'pages/post/index',options:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',source:'editorial'}}];expireMe=true;const api=await import('../../apps/miniprogram/services/api');await expect(api.request({path:'/v1/me'})).rejects.toMatchObject({status:401});expect(runtime.globalData.sessionToken).toBe('');const query=flowQuery(wxMock.navigateTo.mock.calls.at(-1)[0].url);api.requireMemberAccess(old);expect(wxMock.navigateTo).toHaveBeenCalledOnce();expireMe=false;await mount(query);await page.login();expect(page.data.pendingDestination).toBe(article);expect(wxMock.redirectTo).toHaveBeenCalledWith(expect.objectContaining({url:article}));});
 it('discards the old member return when the renewal account changes',async()=>{runtime.globalData.sessionToken='synthetic-first-session';const {query}=await start(article,'renew');await mount(query);runtime.globalData.sessionToken='synthetic-second-session';await page.login();expect(page.data.agreementAccepted).toBe(false);expect(paths()).not.toContain('/v1/me/legal-acceptances');page.data.agreementAccepted=true;await page.login();expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:'/pages/community/index'}));expect(wxMock.redirectTo).not.toHaveBeenCalled();});
 it('keeps explicit renewal on the same session and returns to the exact article without replaying interaction',async()=>{runtime.globalData.sessionToken='synthetic-existing-session';const {query}=await start(article,'renew');await mount(query);expect(page.data.agreementAccepted).toBe(true);page.data.agreementAccepted=false;await page.login();expect(paths()).not.toContain('/v1/me/legal-acceptances');page.data.agreementAccepted=true;await page.login();expect(runtime.globalData.sessionToken).toBe('synthetic-existing-session');expect(wxMock.login).not.toHaveBeenCalled();expect(paths()).toEqual(['/v1/me/legal-acceptances']);expect(wxMock.redirectTo).toHaveBeenCalledWith(expect.objectContaining({url:article}));expect(requests[0].data.consents).toEqual([{documentType:'terms',version:'current-terms'},{documentType:'privacy',version:'current-privacy'}]);});
});


describe('cold business-session recovery and explicit logout',()=>{
 it('keeps cold guests on welcome login until they explicitly browse',async()=>{
  storage.set('cisme.guestBrowsing',true);await mount({});expect(wxMock.switchTab).not.toHaveBeenCalled();
  expect(paths()).toEqual([]);await page.browseCommunity();
  expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:'/pages/community/index'}));
  expect(wxMock.login).not.toHaveBeenCalled();expect(paths()).not.toContain('/v1/identity/wechat');
 });
 it('restores a server-verified session through a readonly me request',async()=>{
  runtime.globalData.sessionToken='synthetic-existing-session';await mount({});
  await vi.waitFor(()=>expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:home})));
  expect(paths()).toEqual(['/v1/me']);expect(wxMock.login).not.toHaveBeenCalled();
 });
 it('reveals login when the retained business session actually returns401',async()=>{
  runtime.globalData.sessionToken='synthetic-expired-session';expireMe=true;await mount({});
  await vi.waitFor(()=>expect(page.data.loading).toBe(false));
  expect(runtime.globalData.sessionToken).toBe('');expect(page.data.pendingDestination).toBe('');
  expect(page.data.notice).toContain('登录状态已失效');expect(wxMock.switchTab).not.toHaveBeenCalled();
  expect(wxMock.navigateTo).not.toHaveBeenCalled();expect(wxMock.login).not.toHaveBeenCalled();
 });
 it.each(['network','unavailable'] as const)('preserves the retained identity on%s and retries without an identity POST',async(failure)=>{
  runtime.globalData.sessionToken='synthetic-existing-session';meFailure=failure;await mount({});
  await vi.waitFor(()=>expect(page.data.sessionRestoreFailed).toBe(true));
  expect(runtime.globalData.sessionToken).toBe('synthetic-existing-session');expect(wxMock.switchTab).not.toHaveBeenCalled();
  meFailure='';await page.login();expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:home}));
  expect(paths().every(path=>path==='/v1/me')).toBe(true);expect(wxMock.login).not.toHaveBeenCalled();
 });
 it('only clears an unverified retained session after the user explicitly chooses another login',async()=>{
  runtime.globalData.sessionToken='synthetic-existing-session';meFailure='network';await mount({});
  await vi.waitFor(()=>expect(page.data.sessionRestoreFailed).toBe(true));page.restartLogin();
  expect(runtime.globalData.sessionToken).toBe('');expect(page.data).toMatchObject({pendingDestination:'',sessionRestoreFailed:false,agreementAccepted:false});
  expect(wxMock.login).not.toHaveBeenCalled();expect(paths()).not.toContain('/v1/identity/wechat');
 });
 it.each(['browse','hide','unload','actor'])("drops a retained-session response after%s",async(change)=>{
  runtime.globalData.sessionToken='synthetic-existing-session';holdMe=true;await mount({});
  await vi.waitFor(()=>expect(heldMe).not.toBeNull());
  if(change==='browse')await page.browseCommunity();else if(change==='hide')page.onHide();else if(change==='unload')page.onUnload();else runtime.globalData.sessionToken='synthetic-other-session';
  heldMe!();await Promise.resolve();await Promise.resolve();
  expect(wxMock.switchTab.mock.calls.some(([options]:any[])=>options.url===home)).toBe(false);
  expect(wxMock.login).not.toHaveBeenCalled();
 });
 it('clears the prior guest preference on login and explicitly lands logout on Account',async()=>{
  storage.set('cisme.guestBrowsing',true);await mount({intent:'login'});await page.login();
  expect(storage.has('cisme.guestBrowsing')).toBe(false);
  storage.set('cisme.guestBrowsing',true);
  await import('../../apps/miniprogram/pages/settings/index');
  const settings={...definition,data:structuredClone(definition.data),setData(values:any,done?:()=>void){Object.assign(this.data,values);done?.();}};
  await settings.logout();expect(runtime.globalData.sessionToken).toBe('');expect(storage.has('cisme.guestBrowsing')).toBe(false);
  expect(wxMock.reLaunch).toHaveBeenCalledWith(expect.objectContaining({url:'/pages/account/index?intent=login'}));
 });
 it('does not let an earlier logout confirmation clear a different restored session',async()=>{
  runtime.globalData.sessionToken='synthetic-first-session';await import('../../apps/miniprogram/pages/settings/index');
  const settings={...definition,data:structuredClone(definition.data),setData(values:any,done?:()=>void){Object.assign(this.data,values);done?.();}};
  let finish!:(value:{confirm:boolean})=>void;wxMock.showModal.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  const loggingOut=settings.logout();runtime.globalData.sessionToken='synthetic-second-session';finish({confirm:true});await loggingOut;
  expect(runtime.globalData.sessionToken).toBe('synthetic-second-session');expect(wxMock.reLaunch).not.toHaveBeenCalled();
 });
});

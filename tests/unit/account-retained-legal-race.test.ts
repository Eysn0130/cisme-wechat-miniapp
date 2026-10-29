import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
// Real Account/API/coordinator/HTTP: only the native wx transport and unrelated
// display adapters are synthetic. A real 401 callback clears the real session.
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',motionDuration:()=>0,shouldReduceMotion:()=>false}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({defaultMemberAvatar:'local-avatar',clearMemberAvatarCache:vi.fn(),localMemberAvatar:async()=> 'local-avatar',prepareAvatarUpload:vi.fn()}));
vi.mock('../../apps/miniprogram/services/member-identity',()=>({clearMemberIdentity:vi.fn(),publishMemberIdentity:vi.fn()}));
vi.mock('../../apps/miniprogram/services/share',()=>({attributePendingShare:vi.fn()}));
vi.mock('../../apps/miniprogram/release-config',()=>({legalDocumentVersions:()=>null,shouldUseDevelopmentIdentity:()=>false}));
let page:any,runtime:any,storage:Map<string,unknown>,wxMock:any,requests:any[];
const documents=(version='current-v1')=>({ready:true,documents:[{document_type:'terms',version},{document_type:'privacy',version}]});
const pathOf=(request:any)=>new URL(request.url).pathname;
const reads=(path:string)=>requests.filter(request=>pathOf(request)===path);
async function settle(){for(let n=0;n<12;n++)await Promise.resolve();}
async function cold(){await import('../../apps/miniprogram/pages/account/index');page.onLoad({});page.onShow();await settle();}
function respond(request:any,status:number,data:unknown){request.success({statusCode:status,data});}
async function expire(){respond(reads('/v1/me')[0],401,{code:'AUTH_EXPIRED'});await settle();await vi.advanceTimersByTimeAsync(110);await settle();}
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();vi.useFakeTimers();storage=new Map();requests=[];
 runtime={globalData:{sessionToken:'synthetic-expired-session',privacyRightsToken:'',apiBaseUrl:'https://api.synthetic.invalid',sessionStorageKey:'cisme.synthetic.session',cloudFunction:null}};
 wxMock={getStorageSync:vi.fn((key:string)=>storage.get(key)),setStorageSync:vi.fn((key:string,value:unknown)=>storage.set(key,value)),removeStorageSync:vi.fn((key:string)=>storage.delete(key)),getStorageInfoSync:()=>({keys:[...storage.keys()]}),
  getAccountInfoSync:()=>({miniProgram:{envVersion:'trial'}}),getDeviceInfo:()=>({platform:'ios'}),
  request:vi.fn((request:any)=>{requests.push(request);if(pathOf(request)==='/v1/identity/capabilities')queueMicrotask(()=>respond(request,200,{phoneBindingEnabled:false}));return{abort:vi.fn()};}),
  login:vi.fn(),switchTab:vi.fn(),navigateTo:vi.fn(),navigateBack:vi.fn(),redirectTo:vi.fn(),reLaunch:vi.fn(),pageScrollTo:vi.fn(),showToast:vi.fn(),disableAlertBeforeUnload:vi.fn(),enableAlertBeforeUnload:vi.fn()};
 vi.stubGlobal('wx',wxMock);vi.stubGlobal('getApp',()=>runtime);vi.stubGlobal('getCurrentPages',()=>[{route:'pages/account/index',options:{}}]);
 vi.stubGlobal('Page',(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(values:any,done?:()=>void){Object.assign(this.data,values);done?.();}};});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('cold retained-session verdict before public Account bootstrap',()=>{
 it('loads current legal documents automatically after the real expired-session401 without a context-aborted error',async()=>{
  await cold();await expire();
  const currentLegal=reads('/v1/legal').at(-1);expect(currentLegal).toBeDefined();respond(currentLegal,200,documents());await settle();
  expect(runtime.globalData.sessionToken).toBe('');expect(page.data.notice).toContain('登录状态已失效');
  expect(page.data).toMatchObject({restoringSession:false,loading:false,legalLoading:false,legalTextsReady:true,legalLoadError:'',legalFailureCode:'',agreementAccepted:false});
  expect(page.data.serverLegalDocuments).toMatchObject({terms:'current-v1',privacy:'current-v1'});
  expect(requests.every(request=>(request.method??'GET')==='GET')).toBe(true);expect(wxMock.login).not.toHaveBeenCalled();expect(wxMock.navigateTo).not.toHaveBeenCalled();
 });
 it('does not dispatch a legal read under the unverified token or fetch it after verified Home navigation',async()=>{
  await cold();expect(reads('/v1/legal')).toHaveLength(0);expect(reads('/v1/identity/capabilities')).toHaveLength(0);
  respond(reads('/v1/me')[0],200,{id:'synthetic-existing-member'});await settle();
  expect(wxMock.switchTab).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url:'/pages/home/index'}));
  expect(reads('/v1/legal')).toHaveLength(0);expect(wxMock.login).not.toHaveBeenCalled();
 });
 it('keeps a genuine legal service failure fail-closed after expiry and never starts identity or consent',async()=>{
  await cold();await expire();respond(reads('/v1/legal').at(-1),200,{ready:false,documents:[]});await settle();
  expect(page.data.legalTextsReady).toBe(false);expect(page.data.agreementAccepted).toBe(false);
  await page.login();expect(wxMock.login).not.toHaveBeenCalled();expect(requests.some(request=>request.method==='POST')).toBe(false);
 });
 it('retains the business session on500 while independently making current legal documents available',async()=>{
  await cold();respond(reads('/v1/me')[0],500,{code:'UNAVAILABLE'});await settle();
  respond(reads('/v1/legal').at(-1),200,documents());await settle();
  expect(runtime.globalData.sessionToken).toBe('synthetic-expired-session');
  expect(page.data).toMatchObject({restoringSession:false,sessionRestoreFailed:true,legalTextsReady:true,agreementAccepted:false});
  expect(wxMock.switchTab).not.toHaveBeenCalled();expect(wxMock.login).not.toHaveBeenCalled();
 });
 it('does not let an older context-aborted legal read overwrite the fresh current versions',async()=>{
  await cold();const oldRead=page.syncLegalDocuments();const oldLegal=reads('/v1/legal')[0];
  await expire();const fresh=reads('/v1/legal').at(-1);expect(fresh).not.toBe(oldLegal);
  respond(fresh,200,documents('current-v2'));await settle();respond(oldLegal,200,documents('old-v1'));await oldRead;await settle();
  expect(page.data.serverLegalDocuments).toMatchObject({terms:'current-v2',privacy:'current-v2'});
  expect(page.data.legalTextsReady).toBe(true);expect(page.data.legalFailureCode).toBe('');expect(page.data.agreementAccepted).toBe(false);
 });
 it.each(['hide','unload','actor','browse'] as const)('does not bootstrap login from a late retained verdict after%s',async(change)=>{
  await cold();
  if(change==='hide')page.onHide();else if(change==='unload')page.onUnload();else if(change==='browse')await page.browseCommunity();else{
   const {setSessionToken}=await import('../../apps/miniprogram/services/api');setSessionToken('synthetic-new-actor');
  }
  const legalBefore=reads('/v1/legal').length;respond(reads('/v1/me')[0],401,{code:'AUTH_EXPIRED'});await settle();await vi.advanceTimersByTimeAsync(110);await settle();
  expect(reads('/v1/legal')).toHaveLength(legalBefore);expect(wxMock.login).not.toHaveBeenCalled();
  if(change==='actor')expect(runtime.globalData.sessionToken).toBe('synthetic-new-actor');
  expect(wxMock.switchTab.mock.calls.some(([options]:any[])=>options.url==='/pages/home/index')).toBe(false);
 });
});

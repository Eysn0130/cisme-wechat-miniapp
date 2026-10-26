import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({token:'',request:vi.fn(),navigate:vi.fn(),prepare:vi.fn(),setSession:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:mocks.request,navigateAfterAuthentication:mocks.navigate,
 setSessionToken:(token:string)=>{mocks.token=token;mocks.setSession(token);},consumeAuthReturnUrl:()=>'/pages/home/index',cancelAuthentication:vi.fn(),
 setPrivacyRightsToken:vi.fn(),suppressAuthenticationRedirectOnce:vi.fn(),acceptCurrentLegalDocuments:vi.fn()}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({defaultMemberAvatar:'neutral-avatar',localMemberAvatar:vi.fn(),prepareAvatarUpload:mocks.prepare}));
vi.mock('../../apps/miniprogram/services/member-identity',()=>({publishMemberIdentity:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',motionDuration:()=>0,shouldReduceMotion:()=>false}));
vi.mock('../../apps/miniprogram/services/share',()=>({attributePendingShare:vi.fn()}));
vi.mock('../../apps/miniprogram/release-config',()=>({legalDocumentVersions:()=>({privacy:'v3',terms:'v3',localFixture:false}),shouldUseDevelopmentIdentity:()=>false}));
const destination='/pages/post/index?id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&source=editorial';
let page:any,wxMock:any;
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();mocks.token='';mocks.navigate.mockResolvedValue('target');
 mocks.request.mockImplementation(async({path}:any)=>{if(path==='/v1/identity/wechat')return {sessionToken:'new-synthetic-session'};throw new Error('unexpected request');});
 (globalThis as any).getApp=()=>({globalData:{get sessionToken(){return mocks.token;},cloudFunction:{name:'synthetic-api'}}});
 (globalThis as any).getCurrentPages=()=>[{route:'pages/account/index'}];
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(values:any,callback?:()=>void){Object.assign(this.data,values);callback?.();}};};
 wxMock={getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}}),getDeviceInfo:()=>({platform:'devtools'}),getStorageSync:()=>false,
  login:vi.fn(async()=>({code:'synthetic-login-code'})),enableAlertBeforeUnload:vi.fn(),disableAlertBeforeUnload:vi.fn(),pageScrollTo:vi.fn(),showToast:vi.fn()};
 (globalThis as any).wx=wxMock;
 await import('../../apps/miniprogram/pages/account/index');
 page.authenticationReturnUrl=destination;page.syncLegalDocuments=vi.fn(async()=>{});page.loadCapabilities=vi.fn(async()=>{});
 page.setData({pendingDestination:destination,legalLoading:false,legalTextsReady:true,agreementAccepted:true,crossBorderAccepted:true});
});
describe('expired retained destination on the actual Account page',()=>{
 it('reveals ordinary login on show without replacing its owned return path or creating consent',()=>{
  page.setData({loginStage:'avatar',avatarBusy:true,avatarUrl:'previous-avatar'});page.onShow();
  expect(page.data).toMatchObject({pendingDestination:'',loginStage:'login',avatarBusy:false,agreementAccepted:false,crossBorderAccepted:false,avatarUrl:'neutral-avatar'});
  expect(page.authenticationReturnUrl).toBe(destination);expect(page.data.notice).toContain('重新登录');
  expect(wxMock.login).not.toHaveBeenCalled();expect(mocks.request).not.toHaveBeenCalled();expect(mocks.setSession).not.toHaveBeenCalled();
 });
 it('reveals the checkbox on a late expiry tap and waits for a fresh deliberate login',async()=>{
  await page.login();
  expect(page.data.pendingDestination).toBe('');expect(page.data.agreementAccepted).toBe(false);
  expect(wxMock.login).not.toHaveBeenCalled();expect(mocks.navigate).not.toHaveBeenCalled();
  await page.login();expect(wxMock.login).not.toHaveBeenCalled();
  page.toggleAgreement({detail:{value:['accepted']}});await page.login();
  expect(wxMock.login).toHaveBeenCalledOnce();
  expect(mocks.request.mock.calls.filter(([input])=>input.path==='/v1/identity/wechat')).toEqual([[expect.objectContaining({path:'/v1/identity/wechat',
   data:expect.objectContaining({consents:[{documentType:'privacy',version:'v3'},{documentType:'terms',version:'v3'}]})})]]);
  expect(mocks.navigate).toHaveBeenCalledWith(destination);
 });
 it('does not let native phone ownership hide the expiry recovery gesture',()=>{
  page.data.phoneBindingEnabled=true;page.loginTap();
  expect(page.data.pendingDestination).toBe('');expect(page.data.agreementAccepted).toBe(false);expect(wxMock.login).not.toHaveBeenCalled();
 });
 it.each(['continueLogin','chooseLoginAvatar'])('returns an expired avatar step to login from %s',async method=>{
  page.data.loginStage='avatar';await page[method]({detail:{avatarUrl:'synthetic-avatar'}});
  expect(page.data).toMatchObject({pendingDestination:'',loginStage:'login',agreementAccepted:false});
  expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.navigate).not.toHaveBeenCalled();expect(mocks.request).not.toHaveBeenCalled();
 });
 it('preserves an existing valid-session continuation without requesting another identity',async()=>{
  mocks.token='existing-synthetic-session';page.onShow();await page.login();
  expect(page.data.pendingDestination).toBe(destination);expect(mocks.navigate).toHaveBeenCalledWith(destination);
  expect(wxMock.login).not.toHaveBeenCalled();expect(mocks.setSession).not.toHaveBeenCalled();expect(mocks.request).not.toHaveBeenCalled();
 });
});

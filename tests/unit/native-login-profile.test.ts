import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({request:vi.fn(),navigate:vi.fn(async()=> 'target'),prepare:vi.fn(),local:vi.fn(),publish:vi.fn(),token:''}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:mocks.request,navigateAfterAuthentication:mocks.navigate,setSessionToken:(token:string)=>{mocks.token=token;},consumeAuthReturnUrl:()=>'/pages/home/index',cancelAuthentication:vi.fn(),clearAuthenticationRedirectSuppression:vi.fn(),suppressAuthenticationRedirectOnce:vi.fn()}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({defaultMemberAvatar:'neutral',localMemberAvatar:mocks.local,prepareAvatarUpload:mocks.prepare}));
vi.mock('../../apps/miniprogram/services/member-identity',()=>({publishMemberIdentity:mocks.publish}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',motionDuration:()=>0,shouldReduceMotion:()=>false}));
vi.mock('../../apps/miniprogram/services/share',()=>({attributePendingShare:vi.fn()}));
vi.mock('../../apps/miniprogram/release-config',()=>({legalDocumentVersions:()=>({privacy:'v3',terms:'v3',localFixture:false}),shouldUseDevelopmentIdentity:()=>false}));
let page:any, wxMock:any;
const member={id:'member-1',display_name:'原有昵称',profile_revision:2,avatar_data_url:null,avatar_revision:null};
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();mocks.token='';
 wxMock={getAccountInfoSync:vi.fn(()=>({miniProgram:{envVersion:'develop'}})),getDeviceInfo:vi.fn(()=>({platform:'devtools'})),getStorageSync:vi.fn(()=>false),switchTab:vi.fn(),login:vi.fn(async()=>({code:'identity-code'})),enableAlertBeforeUnload:vi.fn(),disableAlertBeforeUnload:vi.fn(),pageScrollTo:vi.fn(),showToast:vi.fn()};
 (globalThis as any).wx=wxMock;
 (globalThis as any).getApp=()=>({globalData:{get sessionToken(){return mocks.token;},cloudFunction:{name:'cismeApi'}}});
 (globalThis as any).getCurrentPages=()=>[{route:'pages/account/index'}];
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:{...definition.data},setData(patch:any,callback?:()=>void){Object.assign(this.data,patch);callback?.();}};};
 mocks.local.mockResolvedValue('neutral');mocks.prepare.mockResolvedValue('data:image/jpeg;base64,dGVzdA==');
 mocks.request.mockImplementation(async(options:any)=>{
  if(options.path==='/v1/identity/wechat')return {sessionToken:'member-session',phoneBindingEnabled:true};
  if(options.path==='/v1/me')return member;
  if(options.path==='/v1/me/phone')return {bound:true,masked:'***1234'};
  if(options.path==='/v1/me/profile' && options.method!=='PUT')return member;
  if(options.path==='/v1/me/profile')return {...member,avatar_data_url:'canonical',avatar_revision:'revision',profile_revision:3};
  if(options.path==='/v1/identity/capabilities')return {phoneBindingEnabled:true};
  throw new Error(options.path);
 });
 await vi.importActual<any>('../../apps/miniprogram/pages/account/index');
 Object.assign(page.data,{agreementAccepted:true,legalTextsReady:true});
});
it('keeps a fresh cold launch on Account without starting identity or phone authorization',()=>{
 page.onLoad({});
 expect(page.data.leaving).toBe(false);expect(wxMock.switchTab).not.toHaveBeenCalled();
 expect(wxMock.login).not.toHaveBeenCalled();expect(mocks.request).not.toHaveBeenCalled();
});
it('restores an existing session to Home without starting a second login',()=>{
 mocks.token='retained-member-session';page.onLoad({});
 expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:'/pages/home/index'}));
 expect(page.data.leaving).toBe(true);expect(wxMock.login).not.toHaveBeenCalled();
});
it('honours an explicit retained guest choice without forcing a login loop',()=>{
 wxMock.getStorageSync.mockReturnValue(true);page.onLoad({});
 expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:'/pages/community/index'}));
 expect(wxMock.login).not.toHaveBeenCalled();expect(mocks.request).not.toHaveBeenCalled();
});
it('keeps an explicit Account visit open even when a member session exists',()=>{
 mocks.token='retained-member-session';page.onLoad({intent:'login'});
 expect(page.data.leaving).toBe(false);expect(wxMock.switchTab).not.toHaveBeenCalled();
});
it('recovers the Account consent screen when restoring the destination fails',async()=>{
 mocks.token='retained-member-session';wxMock.switchTab.mockImplementation(({fail}:any)=>fail());
 page.onLoad({});await Promise.resolve();
 expect(page.data.leaving).toBe(false);expect(page.data.legalTextsReady).toBe(true);
 expect(wxMock.login).not.toHaveBeenCalled();
});
it('lets the native phone callback own login and exchanges separate phone and identity codes',async()=>{
 page.data.phoneBindingEnabled=true;page.loginTap();expect(wxMock.login).not.toHaveBeenCalled();
 await page.loginWithPhone({detail:{code:'selected-phone-code'}});
 expect(wxMock.login).toHaveBeenCalledTimes(1);
 const calls=mocks.request.mock.calls.map(([request])=>request);
 expect(calls[0]).toMatchObject({path:'/v1/identity/wechat',data:{code:'identity-code'}});
 expect(calls[1]).toEqual({path:'/v1/me/phone',method:'POST',data:{code:'selected-phone-code'}});
 expect(page.data.loginStage).toBe('login');expect(mocks.navigate).toHaveBeenCalledWith('/pages/home/index');
 expect(JSON.stringify(page.data)).not.toContain('selected-phone-code');
});
it('continues login after phone denial without inventing a phone binding',async()=>{
 await page.loginWithPhone({detail:{errMsg:'getPhoneNumber:fail user deny'}});
 expect(mocks.token).toBe('member-session');expect(page.data.loginStage).toBe('login');expect(mocks.navigate).toHaveBeenCalledWith('/pages/home/index');
 expect(mocks.request.mock.calls.some(([options])=>options.path==='/v1/me/phone')).toBe(false);
 expect(page.data.notice).toContain('未提供手机号');
});
it('does not promise a future phone binding when the native phone service is unavailable',async()=>{
 await page.loginWithPhone({detail:{errMsg:'getPhoneNumber:fail privacy not configured'}});
 expect(mocks.token).toBe('member-session');expect(page.data.notice).toBe('微信手机号授权暂不可用，仍可使用微信账号登录。');
 expect(mocks.request.mock.calls.some(([options])=>options.path==='/v1/me/phone')).toBe(false);
});
it('does not consume authorization when the agreement is unchecked',async()=>{
 page.data.agreementAccepted=false;
 await page.loginWithPhone({detail:{code:'phone-code'}});
 expect(wxMock.login).not.toHaveBeenCalled();expect(mocks.request).not.toHaveBeenCalled();
});
it('reuses an already saved avatar without asking again',async()=>{
 mocks.request.mockImplementation(async(options:any)=>options.path==='/v1/identity/wechat'?{sessionToken:'member-session'}:{...member,avatar_data_url:'saved-avatar'});
 await page.login();
 expect(mocks.navigate).toHaveBeenCalledWith('/pages/home/index');expect(page.data.loginStage).toBe('login');
 expect(mocks.prepare).not.toHaveBeenCalled();
});
it('saves selected avatar using the latest name/version without opting into public display',async()=>{
 mocks.token='member-session';page.data.loginStage='avatar';page.data.pendingDestination='/pages/profile/index';mocks.local.mockResolvedValue('wxfile://saved.jpg');
 await page.chooseLoginAvatar({detail:{avatarUrl:'wxfile://chosen.jpg'}});
 const write=mocks.request.mock.calls.map(([options])=>options).find(options=>options.method==='PUT');
 expect(write).toEqual({path:'/v1/me/profile',method:'PUT',data:{displayName:'原有昵称',expectedVersion:2,avatarDataUrl:'data:image/jpeg;base64,dGVzdA=='}});
 expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({avatarUrl:'wxfile://saved.jpg',profile_revision:3}));
 expect(mocks.navigate).toHaveBeenCalledWith('/pages/profile/index');
});
it('permits skipping avatar selection without creating a fake image',async()=>{
 mocks.token='member-session';page.data.loginStage='avatar';page.data.pendingDestination='/pages/profile/index';
 await page.chooseLoginAvatar({detail:{}});await page.browseCommunity();
 expect(mocks.request).not.toHaveBeenCalled();expect(mocks.navigate).toHaveBeenCalledWith('/pages/profile/index');
});
it('prevents late avatar conversion from writing to a different session',async()=>{
 mocks.token='member-session';page.data.loginStage='avatar';let done:(value:string)=>void=()=>{};
 mocks.prepare.mockReturnValue(new Promise<string>(resolve=>{done=resolve;}));
 const pending=page.chooseLoginAvatar({detail:{avatarUrl:'wxfile://chosen.jpg'}});
 mocks.token='other-session';done('data:image/jpeg;base64,dGVzdA==');await pending;
 expect(mocks.request).not.toHaveBeenCalled();expect(mocks.navigate).not.toHaveBeenCalled();
});
it('keeps login successful when phone binding fails and gives a separate retry notice',async()=>{
 const original=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async options=>{if(options.path==='/v1/me/phone')throw {title:'手机号服务尚未开通'};return original(options);});
 await page.loginWithPhone({detail:{code:'phone-code'}});
 expect(mocks.token).toBe('member-session');expect(page.data.notice).toBe('手机号服务尚未开通');expect(page.data.error).toBe('');
});
it('keeps an avatar save conflict visible and does not navigate as if saved',async()=>{
 mocks.token='member-session';page.data.loginStage='avatar';const original=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(async options=>{if(options.method==='PUT')throw {title:'资料已更新，请重试'};return original(options);});
 await page.chooseLoginAvatar({detail:{avatarUrl:'wxfile://chosen.jpg'}});
 expect(page.data.error).toBe('资料已更新，请重试');expect(mocks.navigate).not.toHaveBeenCalled();expect(mocks.publish).not.toHaveBeenCalled();
});
it('continues a retained valid session without making profile or identity a prerequisite',async()=>{
 mocks.token='valid-session';page.data.pendingDestination='/pages/profile/index';
 mocks.request.mockRejectedValue({status:503});await page.login();
 expect(page.data.loading).toBe(false);expect(page.data.loginStage).toBe('login');expect(page.data.error).toBe('');
 expect(mocks.navigate).toHaveBeenCalledWith('/pages/profile/index');expect(mocks.request).not.toHaveBeenCalled();expect(wxMock.login).not.toHaveBeenCalled();
});
it('goes straight to the requested destination after identity succeeds with no avatar',async()=>{
 await page.login();
 expect(mocks.token).toBe('member-session');expect(page.data.loginStage).toBe('login');
 expect(mocks.navigate).toHaveBeenCalledWith('/pages/home/index');expect(mocks.prepare).not.toHaveBeenCalled();
 expect(mocks.request.mock.calls.filter(([options])=>options.path==='/v1/identity/wechat')).toHaveLength(1);
});
it('does not wait for an optional profile response before navigating after identity',async()=>{
 const original=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(options=>options.path==='/v1/me'?new Promise(()=>{}):original(options));
 await page.login();
 expect(mocks.token).toBe('member-session');expect(page.data.loading).toBe(false);
 expect(mocks.navigate).toHaveBeenCalledWith('/pages/home/index');expect(page.data.loginStage).toBe('login');
});
it('keeps successful identity navigable when profile refresh fails and retries navigation without another identity',async()=>{
 const original=mocks.request.getMockImplementation()!;
 mocks.request.mockImplementation(options=>options.path==='/v1/me'?Promise.reject({status:503}):original(options));
 mocks.navigate.mockResolvedValueOnce('fallback');await page.login();
 expect(mocks.token).toBe('member-session');expect(page.data.loginStage).toBe('login');
 expect(mocks.navigate).toHaveBeenCalledWith('/pages/home/index');expect(page.data.error).toContain('原目标页面');
 await page.login();
 expect(mocks.navigate).toHaveBeenCalledTimes(2);expect(page.data.error).toBe('');
 expect(mocks.request.mock.calls.filter(([options])=>options.path==='/v1/identity/wechat')).toHaveLength(1);expect(wxMock.login).toHaveBeenCalledTimes(1);
});

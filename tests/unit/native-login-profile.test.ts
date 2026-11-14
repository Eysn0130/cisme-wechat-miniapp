import {beforeEach,expect,it,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
const m=vi.hoisted(()=>({request:vi.fn(),navigate:vi.fn(),prepare:vi.fn(),local:vi.fn(),publish:vi.fn(),token:''}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,navigateAfterAuthentication:m.navigate,setSessionToken:(v:string)=>{m.token=v;},consumeAuthReturnUrl:()=>'/pages/home/index',cancelAuthentication:vi.fn(),clearAuthenticationRedirectSuppression:vi.fn(),suppressAuthenticationRedirectOnce:vi.fn(),isGuestCommunityBrowsing:()=>false}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({defaultMemberAvatar:'neutral',localMemberAvatar:m.local,prepareAvatarUpload:m.prepare}));
vi.mock('../../apps/miniprogram/services/member-identity',()=>({publishMemberIdentity:m.publish}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',motionDuration:()=>0,shouldReduceMotion:()=>false}));
vi.mock('../../apps/miniprogram/services/share',()=>({attributePendingShare:vi.fn()}));
vi.mock('../../apps/miniprogram/release-config',()=>({legalDocumentVersions:()=>({privacy:'v3',terms:'v3',localFixture:false}),shouldUseDevelopmentIdentity:()=>false}));
let page:any,wxMock:any,profile:any,phone:any;
const owner='11111111-1111-4111-8111-111111111111';
const writes=()=>m.request.mock.calls.map(([v])=>v).filter(v=>v.method==='PUT');
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();m.token='';m.navigate.mockResolvedValue('target');m.local.mockImplementation(async(src)=>src?'wxfile://canonical.jpg':'neutral');m.prepare.mockResolvedValue('data:image/jpeg;base64,fixture');
 profile={id:owner,display_name:'CISME 会员',profile_revision:0,avatar_data_url:null,avatar_revision:null,completed_at:null,public_status:'private'};phone={bound:false,enabled:true,masked:null};
 wxMock={getAccountInfoSync:()=>({miniProgram:{envVersion:'trial'}}),getDeviceInfo:()=>({platform:'ios'}),getStorageSync:()=>'',setStorageSync:vi.fn(),switchTab:vi.fn(),login:vi.fn(async()=>({code:'identity-code'})),enableAlertBeforeUnload:vi.fn(),disableAlertBeforeUnload:vi.fn(),pageScrollTo:vi.fn(),showToast:vi.fn()};
 Object.assign(globalThis,{wx:wxMock,getApp:()=>({globalData:{get sessionToken(){return m.token;}}}),getCurrentPages:()=>[{route:'pages/account/index'}],Page:(d:any)=>{page={...d,data:{...d.data},setData(p:any,cb?:()=>void){Object.assign(this.data,p);cb?.();}};}});
 m.request.mockImplementation(async(o:any)=>{
  if(o.path==='/v1/identity/wechat')return{sessionToken:'current-session',onboardingRequired:true,phoneBindingEnabled:true};
  if(o.path==='/v1/me/profile'&&o.method==='PUT'){expect(m.token).toBe('current-session');expect(o.data.expectedVersion).toBe(profile.profile_revision);profile={...profile,display_name:o.data.displayName,profile_revision:profile.profile_revision+1,completed_at:'2026-11-13T00:00:00Z',...(o.data.avatarDataUrl?{avatar_data_url:'canonical',avatar_revision:'a'.repeat(64)}:{})};return{...profile};}
  if(o.path==='/v1/me/profile')return{...profile};
  if(o.path==='/v1/me/phone'){if(o.method==='POST'){expect(m.token).toBe('current-session');phone={bound:true,enabled:true,masked:'***0001'};}return{...phone};}
  if(o.path==='/v1/me')return{...profile};
  if(o.path==='/v1/identity/capabilities')return{phoneBindingEnabled:true};throw Error(o.path);
 });
 await import('../../apps/miniprogram/pages/account/index');Object.assign(page.data,{agreementAccepted:true,legalTextsReady:true});
});
it('does not create an identity before an explicit login or accepted terms',async()=>{
 page.onLoad({});expect(m.request).not.toHaveBeenCalled();page.data.agreementAccepted=false;await page.loginTap();expect(wxMock.login).not.toHaveBeenCalled();
});
it('checks existing facts before asking, and only the missing phone first',async()=>{
 await page.loginTap();expect(wxMock.login).toHaveBeenCalledTimes(1);expect(page.data.loginStage).toBe('phone');expect(m.navigate).not.toHaveBeenCalled();expect(writes()).toEqual([]);
 await page.loginTap();expect(wxMock.login).toHaveBeenCalledTimes(1);
 await page.loginWithPhone({detail:{code:'native-phone-code'}});expect(phone.bound).toBe(true);expect(page.data.loginStage).toBe('avatar');expect(m.request.mock.calls.find(([v])=>v.method==='POST'&&v.path==='/v1/me/phone')?.[0].data).toEqual({code:'native-phone-code'});
});
it('holds an explicitly chosen avatar privately then saves it with the confirmed native nickname to the same owner',async()=>{
 phone.bound=true;await page.loginTap();await page.chooseLoginAvatar({detail:{avatarUrl:'wxfile://selected.jpg'}});
 expect(page.data).toMatchObject({loginStage:'nickname',avatarUrl:'wxfile://selected.jpg'});expect(writes()).toEqual([]);expect(JSON.stringify(page.data)).not.toContain('base64');
 page.editLoginName({detail:{value:'旧的输入事件值'}});await page.saveLoginNickname({detail:{value:{nickname:'小雨'}}});expect(writes()).toEqual([{path:'/v1/me/profile',method:'PUT',data:{displayName:'小雨',expectedVersion:0,avatarDataUrl:'data:image/jpeg;base64,fixture'}}]);
 expect(profile.id).toBe(owner);expect(m.publish).toHaveBeenCalledWith(expect.objectContaining({id:owner,display_name:'小雨',phone_masked:null}));expect(m.navigate).toHaveBeenCalledWith('/pages/home/index');
});
it('loads a complete returning member without repeating any phone, avatar or nickname question',async()=>{
 profile={...profile,display_name:'已有昵称',avatar_data_url:'saved',profile_revision:3,completed_at:'2026-11-12T00:00:00Z'};phone.bound=true;
 await page.loginTap();expect(page.data.loginStage).toBe('login');expect(m.navigate).toHaveBeenCalledTimes(1);expect(writes()).toEqual([]);expect(m.prepare).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([v])=>v.path==='/v1/me/phone'&&v.method==='POST')).toBe(false);
});
it('fills only a missing avatar while retaining the stored nickname and version',async()=>{
 profile={...profile,display_name:'已有昵称',profile_revision:2};phone.bound=true;await page.loginTap();await page.chooseLoginAvatar({detail:{avatarUrl:'wxfile://selected.jpg'}});
 expect(writes()[0].data).toMatchObject({displayName:'已有昵称',expectedVersion:2});expect(m.navigate).toHaveBeenCalledTimes(1);expect(page.data.loginStage).toBe('login');
});
it('fills only a missing nickname without asking for an existing avatar again',async()=>{
 profile.avatar_data_url='saved';phone.bound=true;await page.loginTap();expect(page.data.loginStage).toBe('nickname');
 await page.saveLoginNickname({detail:{value:'微信快捷昵称'}});expect(writes()[0].data).toEqual({displayName:'微信快捷昵称',expectedVersion:0});expect(m.prepare).not.toHaveBeenCalled();expect(m.navigate).toHaveBeenCalledTimes(1);
});
it('does not overwrite another already-completed nickname when the same account changed in another page',async()=>{
 profile.avatar_data_url='saved';phone.bound=true;await page.loginTap();profile.display_name='其他页面已保存';page.editLoginName({detail:{value:'旧输入'}});await page.saveLoginNickname();expect(writes()).toEqual([]);expect(m.publish).toHaveBeenCalledWith(expect.objectContaining({display_name:'其他页面已保存'}));
});
it('keeps denial of optional phone truthful and continues the same login flow',async()=>{
 await page.loginTap();await page.loginWithPhone({detail:{errMsg:'getPhoneNumber:fail user deny'}});expect(phone.bound).toBe(false);expect(page.data).toMatchObject({loginStage:'avatar',phoneSkipped:true});expect(m.request.mock.calls.some(([v])=>v.path==='/v1/me/phone'&&v.method==='POST')).toBe(false);
});
it('never treats an unavailable phone service as a binding',async()=>{
 phone.enabled=false;await page.loginTap();expect(page.data.loginStage).toBe('avatar');expect(phone.bound).toBe(false);
});
it('reconciles an unknown profile write by reading rather than sending it again',async()=>{
 phone.bound=true;profile.avatar_data_url='saved';await page.loginTap();page.editLoginName({detail:{value:'小雨'}});const original=m.request.getMockImplementation()!;
 m.request.mockImplementation(async(o)=>{const result=await original(o);if(o.method==='PUT')throw Error('response lost after commit');return result;});await page.saveLoginNickname();expect(page.data.loginProfileUncertain).toBe(true);expect(m.navigate).not.toHaveBeenCalled();
 await page.loginTap();expect(writes()).toHaveLength(1);expect(m.navigate).toHaveBeenCalledTimes(1);
});
it('does not write a late selected avatar into another session',async()=>{
 phone.bound=true;await page.loginTap();let finish!:(v:string)=>void;m.prepare.mockReturnValueOnce(new Promise(r=>{finish=r;}));const save=page.chooseLoginAvatar({detail:{avatarUrl:'wxfile://selected.jpg'}});m.token='another-session';finish('private');await save;expect(writes()).toEqual([]);expect(m.navigate).not.toHaveBeenCalled();
});
it('requires a valid explicit nickname and does not hide a failed native nickname review',async()=>{
 phone.bound=true;profile.avatar_data_url='saved';await page.loginTap();await page.saveLoginNickname();expect(writes()).toEqual([]);page.editLoginName({detail:{value:'被拒昵称'}});page.reviewLoginName({detail:{pass:false}});await page.saveLoginNickname();expect(writes()).toEqual([]);
});
it('keeps all native actions on Account and removes the skip-avatar path',async()=>{
 const wxml=await readFile('apps/miniprogram/pages/account/index.wxml','utf8');expect(wxml).toContain('type="nickname"');expect(wxml).toContain("loginStage === 'phone' ? 'getPhoneNumber'");expect(wxml).toContain("loginStage === 'avatar' ? 'chooseAvatar'");expect(wxml).not.toContain('稍后设置');expect(wxml).not.toContain('member-setup-form');
});

it('resumes missing profile confirmation after Account is reconstructed with a verified retained session',async()=>{
 m.token='current-session';phone.bound=true;await page.restoreRetainedSession();expect(page.data.loginStage).toBe('avatar');expect(page.loginOwnerId).toBe(owner);expect(wxMock.login).not.toHaveBeenCalled();expect(m.navigate).not.toHaveBeenCalled();expect(m.request.mock.calls.some(([v])=>v.path==='/v1/me/phone'&&v.method==='POST')).toBe(false);
});

it('accepts a user-confirmed nickname matching a generic label without asking again after it was saved',async()=>{
 phone.bound=true;profile.avatar_data_url='saved';await page.loginTap();page.editLoginName({detail:{value:'微信用户'}});await page.saveLoginNickname();expect(profile.completed_at).toBeTruthy();expect(profile.display_name).toBe('微信用户');expect(m.navigate).toHaveBeenCalledTimes(1);m.navigate.mockClear();page.loginFlowToken=m.token;await page.advanceLogin();expect(m.navigate).toHaveBeenCalledTimes(1);expect(page.data.loginStage).toBe('login');
});

it('recovers a questionnaire-complete member with a bound phone and no saved profile on a nested Account entry',async()=>{
 m.token='current-session';phone.bound=true;Object.assign(profile,{care_onboarding_required:false,card_number:'No. 00010'});
 (globalThis as any).getCurrentPages=()=>[{route:'pages/profile/index'},{route:'pages/account/index'}];page.onLoad({intent:'login'});page.onShow();for(let i=0;i<20;i++)await Promise.resolve();
 expect(page.data.loginStage).toBe('avatar');expect(page.loginOwnerId).toBe(owner);expect(m.navigate).not.toHaveBeenCalled();expect(wxMock.login).not.toHaveBeenCalled();
 await page.chooseLoginAvatar({detail:{avatarUrl:'wxfile://selected.jpg'}});expect(page.data.loginStage).toBe('nickname');
 await page.saveLoginNickname({detail:{value:{nickname:'微信快捷昵称'}}});
 expect(writes()).toHaveLength(1);expect(profile.id).toBe(owner);expect(profile.card_number).toBe('No. 00010');expect(profile.care_onboarding_required).toBe(false);expect(m.navigate).toHaveBeenCalledTimes(1);
 expect(m.request.mock.calls.some(([v])=>v.path==='/v1/identity/wechat'||v.path==='/v1/me/phone'&&v.method==='POST'||v.path.includes('care-profile'))).toBe(false);
});
it.each(['continueLogin','login'])('does not let the retained-session %s shortcut skip missing identity fields',async method=>{
 m.token='current-session';phone.bound=true;page.data.pendingDestination='/pages/home/index';await page[method]();
 expect(page.data.loginStage).toBe('avatar');expect(m.navigate).not.toHaveBeenCalled();expect(wxMock.login).not.toHaveBeenCalled();
});
it('leaves an unfinished login as public browsing while retaining the canonical server member',async()=>{
 phone.bound=true;await page.loginTap();expect(page.data.loginStage).toBe('avatar');await page.browseCommunity();
 expect(m.token).toBe('');expect(page.loginFlowToken).toBe('');expect(writes()).toEqual([]);expect(wxMock.setStorageSync).toHaveBeenCalledWith('cisme.guestBrowsing',true);expect(wxMock.switchTab).toHaveBeenCalledWith(expect.objectContaining({url:'/pages/community/index'}));
});
it('takes the final native form value even if quick-fill has not emitted an input event',async()=>{
 phone.bound=true;profile.avatar_data_url='saved';await page.loginTap();expect(page.data.loginName).toBe('');
 await page.saveLoginNickname({detail:{value:{nickname:'键盘快捷微信昵称'}}});expect(writes()[0].data.displayName).toBe('键盘快捷微信昵称');expect(m.navigate).toHaveBeenCalledTimes(1);
 const wxml=await readFile('apps/miniprogram/pages/account/index.wxml','utf8');expect(wxml).toContain('bindsubmit="saveLoginNickname"');expect(wxml).toContain('name="nickname"');expect(wxml).toContain("loginStage === 'nickname' ? 'submit'");
});
it('leaves as a guest when the retained profile read is still pending and ignores its late response',async()=>{
 m.token='current-session';const original=m.request.getMockImplementation()!;let finish!:(v:any)=>void;
 m.request.mockImplementation((o:any)=>o.path==='/v1/me'?new Promise(r=>{finish=r;}):original(o));
 const restoring=page.restoreRetainedSession();await Promise.resolve();await page.browseCommunity();expect(m.token).toBe('');
 finish({...profile});await restoring;expect(m.navigate).not.toHaveBeenCalled();expect(writes()).toEqual([]);
});

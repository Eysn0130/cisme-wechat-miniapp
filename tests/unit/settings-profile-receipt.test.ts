import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({request:vi.fn(),local:vi.fn(),publish:vi.fn(),identity:vi.fn(),token:'member-session'}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:mocks.request,requireMemberAccess:()=>true,retainMemberSnapshot:()=>true,clearAuthenticationRedirectSuppression:vi.fn(),resumeAuthentication:vi.fn(),setSessionToken:vi.fn()}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({defaultMemberAvatar:'neutral',localMemberAvatar:mocks.local,prepareAvatarUpload:vi.fn()}));
vi.mock('../../apps/miniprogram/services/member-identity',()=>({memberIdentity:mocks.identity,publishMemberIdentity:mocks.publish}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',motionDuration:()=>0}));
vi.mock('../../apps/miniprogram/services/authority',()=>({authorityProjection:vi.fn(),hasCapability:()=>false}));
let page:any,wxMock:any;
const saved={id:'synthetic-member',display_name:'已保存昵称',profile_revision:3,wechat_handle:null,avatar_data_url:'canonical-avatar',avatar_revision:'new-avatar',completed_at:'2026-10-29T00:00:00Z',community_visible:false,public_status:'private'};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((ok,no)=>{resolve=ok;reject=no;});return{promise,resolve,reject};}
async function settle(){for(let i=0;i<8;i++)await Promise.resolve();}
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();mocks.token='member-session';mocks.identity.mockReturnValue(null);
 wxMock={getAccountInfoSync:()=>({miniProgram:{envVersion:'trial'}}),getStorageSync:()=>undefined,showToast:vi.fn(),enableAlertBeforeUnload:vi.fn(),disableAlertBeforeUnload:vi.fn(),pageScrollTo:vi.fn()};
 (globalThis as any).wx=wxMock;(globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token}});
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(values:any,done?:()=>void){Object.assign(this.data,values);done?.();}};};
 mocks.request.mockResolvedValue(saved);mocks.local.mockResolvedValue('local-avatar');
 await import('../../apps/miniprogram/pages/settings/index');
 page.profileSessionToken=mocks.token;Object.assign(page.data,{memberId:saved.id,profileVersion:2,profileReady:true,profileDirty:true,displayName:'输入昵称',avatarUrl:'old-avatar'});
});
it('uses the final native form value and publishes the canonical name/revision before avatar work without a second GET',async()=>{
 const avatar=deferred<string>();mocks.local.mockReturnValue(avatar.promise);
 const pending=page.saveProfile({detail:{value:{nickname:'表单最终昵称'}}});await settle();
 expect(mocks.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({method:'PUT',path:'/v1/me/profile',data:expect.objectContaining({displayName:'表单最终昵称',expectedVersion:2})}));
 expect(page.data).toMatchObject({displayName:saved.display_name,profileVersion:3,profileDirty:false,profileReady:true,profileBusy:false});
 expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({id:saved.id,display_name:saved.display_name,profile_revision:3,avatarUrl:'old-avatar'}));
 expect(wxMock.showToast).toHaveBeenCalledExactlyOnceWith({title:'会员资料已保存',icon:'success'});
 avatar.resolve('new-local-avatar');await pending;expect(page.data.avatarUrl).toBe('new-local-avatar');
});
it('keeps the saved nickname/revision usable when local avatar work fails',async()=>{
 mocks.local.mockRejectedValue(new Error('synthetic-avatar-failure'));await page.saveProfile();
 expect(page.data).toMatchObject({displayName:saved.display_name,profileVersion:3,profileDirty:false,profileBusy:false});
 expect(page.data.avatarUrl).toBe('old-avatar');
 expect(page.data.profileError).toContain('资料已保存');expect(mocks.request).toHaveBeenCalledTimes(1);
 page.editDisplayName({detail:{value:'第二次昵称'}});mocks.request.mockResolvedValue({...saved,display_name:'第二次昵称',profile_revision:4});await page.saveProfile();
 expect(mocks.request.mock.calls[1]![0].data.expectedVersion).toBe(3);
});
it('preserves the successful local avatar choice when filesystem loading returns its default failure value',async()=>{
 page.data.avatarChanged=true;page.data.avatarUrl='wxfile://chosen-local-avatar';page.data.avatarPayload='synthetic-upload';mocks.local.mockResolvedValue('neutral');
 await page.saveProfile();expect(page.data.avatarUrl).toBe('wxfile://chosen-local-avatar');
 expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({avatarUrl:'wxfile://chosen-local-avatar',profile_revision:3}));
 expect(page.data.profileError).toContain('资料已保存');
});
it('uses the default only when the acknowledged profile has no avatar, including explicit removal',async()=>{
 page.data.avatarChanged=true;page.data.avatarUrl='neutral';page.data.avatarPayload=null;
 mocks.request.mockResolvedValue({...saved,avatar_data_url:null,avatar_revision:null});mocks.local.mockResolvedValue('neutral');
 await page.saveProfile();expect(page.data.avatarUrl).toBe('neutral');expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({avatarUrl:'neutral'}));
 expect(page.data.profileError).toBe('');
});
it('does not overwrite a newer cached nickname or use an old PUT revision for another edit',async()=>{
 mocks.identity.mockReturnValue({id:saved.id,display_name:'其他页面更新后的昵称',profile_revision:4,avatarUrl:'latest-known-avatar'});
 await page.saveProfile();expect(page.data).toMatchObject({displayName:'其他页面更新后的昵称',profileVersion:4,avatarUrl:'latest-known-avatar',profileDirty:false,profileBusy:false,profileReady:false});
 expect(mocks.publish).not.toHaveBeenCalled();expect(mocks.local).not.toHaveBeenCalled();await page.saveProfile();expect(mocks.request).toHaveBeenCalledTimes(1);
});
it.each(['hide','unload','actor','leave'] as const)('discards an acknowledgement after %s',async(change)=>{
 const write=deferred<any>();mocks.request.mockReturnValue(write.promise);const pending=page.saveProfile();
 if(change==='hide')page.onHide();else if(change==='unload')page.onUnload();else if(change==='actor')mocks.token='another-session';else page.data.leaving=true;
 write.resolve(saved);await pending;expect(mocks.publish).not.toHaveBeenCalled();expect(wxMock.showToast).not.toHaveBeenCalled();expect(page.data.profileVersion).toBe(2);
 if(change==='hide')expect(page.data.profileBusy).toBe(false);
});
it('does not let a prior bootstrap avatar completion restore the name from before the save',async()=>{
 const oldAvatar=deferred<string>();mocks.local.mockReturnValueOnce(oldAvatar.promise).mockResolvedValue('new-avatar');
 mocks.request.mockImplementation(async(options:any)=>options.method==='PUT'?saved:{settings:{profile:{...saved,display_name:'旧昵称',profile_revision:2},phone:{enabled:false,bound:false},consents:[]}});
 page.data.profileDirty=false;const bootstrap=page.loadSettingsBootstrap();await settle();const oldPublications=mocks.publish.mock.calls.filter(([value]:any[])=>value.display_name==='旧昵称').length;page.editDisplayName({detail:{value:'新昵称'}});await page.saveProfile();
 oldAvatar.resolve('old-local-avatar');await bootstrap;
 expect(page.data.displayName).toBe(saved.display_name);expect(page.data.profileVersion).toBe(3);expect(mocks.publish.mock.calls.filter(([value]:any[])=>value.display_name==='旧昵称')).toHaveLength(oldPublications);expect(mocks.publish.mock.calls.at(-1)?.[0].display_name).toBe(saved.display_name);
});
it('accepts manual reload name/revision before local avatar work and keeps them on avatar failure',async()=>{
 page.data.profileDirty=false;const avatar=deferred<string>();mocks.local.mockReturnValue(avatar.promise);
 const pending=page.loadProfile();await settle();
 expect(page.data).toMatchObject({displayName:saved.display_name,profileVersion:3,profileReady:true,avatarUrl:'old-avatar'});
 expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({display_name:saved.display_name,profile_revision:3}));
 avatar.reject(new Error('synthetic-avatar-failure'));await pending;
 expect(page.data).toMatchObject({displayName:saved.display_name,profileVersion:3,profileReady:true,avatarUrl:'old-avatar'});expect(page.data.profileError).toContain('会员资料已加载');
});
it('keeps bootstrap profile and independent phone/consent data ready when only avatar IO fails',async()=>{
 page.data.profileDirty=false;page.data.profileReady=false;mocks.local.mockRejectedValue(new Error('synthetic-avatar-failure'));
 mocks.request.mockResolvedValue({settings:{profile:saved,phone:{enabled:true,bound:true,masked:'***0000'},consents:[{id:'synthetic-consent',purpose:'feed_readonly'}]}});
 await page.loadSettingsBootstrap();
 expect(page.data).toMatchObject({displayName:saved.display_name,profileVersion:3,profileReady:true,phoneBound:true,phoneMasked:'***0000',loading:false,phoneLoading:false,avatarUrl:'old-avatar'});
 expect(page.data.consents).toHaveLength(1);expect(page.data.profileError).toContain('会员资料已加载');expect(page.data.phoneError).toBe('');
});
it('does not let a prior manual read avatar completion overwrite a newer save',async()=>{
 page.data.profileDirty=false;const avatar=deferred<string>();mocks.local.mockReturnValueOnce(avatar.promise).mockResolvedValue('latest-avatar');
 const pending=page.loadProfile();await settle();page.editDisplayName({detail:{value:'最新设置昵称'}});
 mocks.request.mockResolvedValue({...saved,display_name:'最新设置昵称',profile_revision:4});await page.saveProfile();avatar.resolve('late-old-avatar');await pending;
 expect(page.data).toMatchObject({displayName:'最新设置昵称',profileVersion:4,avatarUrl:'latest-avatar'});expect(mocks.publish.mock.calls.at(-1)?.[0].profile_revision).toBe(4);
});
it('never adopts an older GET over the newest session identity',async()=>{
 page.data.profileDirty=false;mocks.identity.mockReturnValue({id:saved.id,display_name:'最近保存昵称',profile_revision:4,avatarUrl:'known-avatar'});
 await page.loadProfile();expect(page.data).toMatchObject({displayName:'最近保存昵称',profileVersion:4,avatarUrl:'known-avatar',profileReady:false});
 expect(mocks.publish).not.toHaveBeenCalled();expect(mocks.local).not.toHaveBeenCalled();
});
it.each(['hide','unload','actor'] as const)('does not adopt a late manual GET after %s',async(change)=>{
 page.data.profileDirty=false;const read=deferred<any>();mocks.request.mockReturnValue(read.promise);const pending=page.loadProfile();
 if(change==='hide')page.onHide();else if(change==='unload')page.onUnload();else mocks.token='another-session';read.resolve(saved);await pending;
 expect(page.data.profileVersion).toBe(2);expect(mocks.publish).not.toHaveBeenCalled();expect(mocks.local).not.toHaveBeenCalled();
});
it('preserves dirty input and the expected revision on a real CAS refusal',async()=>{
 mocks.request.mockRejectedValue({status:409,title:'资料已在其他页面更新'});await page.saveProfile();
 expect(page.data).toMatchObject({displayName:'输入昵称',profileVersion:2,profileDirty:true,profileBusy:false,profileError:'资料已在其他页面更新'});
 expect(mocks.publish).not.toHaveBeenCalled();expect(wxMock.showToast).not.toHaveBeenCalled();
});
it('does not let an old avatar completion overwrite a newer save or a new draft',async()=>{
 const avatar=deferred<string>();mocks.local.mockReturnValueOnce(avatar.promise).mockResolvedValue('latest-avatar');const first=page.saveProfile();await settle();
 page.editDisplayName({detail:{value:'更新后的昵称'}});mocks.request.mockResolvedValue({...saved,display_name:'更新后的昵称',profile_revision:4});await page.saveProfile();
 avatar.resolve('stale-avatar');await first;expect(page.data).toMatchObject({displayName:'更新后的昵称',profileVersion:4,avatarUrl:'latest-avatar'});
});
it('keeps native nickname-review refusal fail-closed and does not send a write',async()=>{
 page.reviewNickname({detail:{pass:false}});await page.saveProfile({detail:{value:{nickname:'未审核名字'}}});
 expect(page.data.nicknameInvalid).toBe(true);expect(mocks.request).not.toHaveBeenCalled();
});

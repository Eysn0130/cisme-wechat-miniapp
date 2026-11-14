import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),request:vi.fn(),avatar:vi.fn(),token:'operator-a',revision:0}));
vi.mock('../../apps/miniprogram/services/api',()=>({requireMemberAccess:()=>true,request:m.request,registerPrivateExport:()=>vi.fn()}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:m.read,cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({localMemberAvatar:m.avatar}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>m.revision}));
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const scope={profile:true,contact:true,care:true,orders:true,points:true,rewards:true,issueRewards:true,administrators:false,sharing:true,commission:true,finance:true,support:true,privacy:true,manage:true,export:true};
const row={id,displayName:'会员甲',cardNumber:'No. 00028',avatar:null,accountStatus:'active',onboarding:'complete',createdAt:'2026-11-14T00:00:00Z',phoneMasked:'138****0000',points:{available:850,frozen:20,reserved:10,debt:0},commerce:{paidOrderCount:2,netCents:39600},activity:{careDays:7,publicPosts:1,streak:7},rewards:{availableCoupons:1,unclaimedRewards:1},sharing:{state:'active'}};
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
let page:any,component:any;
function deferred(){let resolve!:(v:any)=>void;return {promise:new Promise<any>(r=>resolve=r),resolve:(v:any)=>resolve(v)};}
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();m.token='operator-a';m.revision=0;m.avatar.mockImplementation(async(data:string|null,revision:string|null)=>data&&revision?'/synthetic/local-avatar.jpg':'/assets/icons/user-circle-plum.svg');vi.stubGlobal('getApp',()=>({globalData:{sessionToken:m.token,apiBaseUrl:'https://staging-api.cisme.cn'}}));vi.stubGlobal('wx',{stopPullDownRefresh:vi.fn(),navigateTo:vi.fn(),showToast:vi.fn(),showActionSheet:vi.fn(),showModal:vi.fn(),setClipboardData:vi.fn().mockResolvedValue({}),env:{USER_DATA_PATH:'/synthetic'},getFileSystemManager:()=>({unlinkSync:vi.fn()})});vi.stubGlobal('Page',(d:any)=>page={...d,data:structuredClone(d.data),setData(p:any){Object.assign(this.data,p);}});vi.stubGlobal('Component',(d:any)=>component={...d.methods,data:structuredClone(d.data),properties:{visible:true,active:true,memberId:id,full:false,initialTab:'overview',initialSection:'orders',initialDay:''},setData(p:any){Object.assign(this.data,p);},triggerEvent:vi.fn()});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
async function list(){m.read.mockResolvedValue({scope,items:[row],total:1,nextCursor:null});await import('../../apps/miniprogram/pages/management-members/index');page.onShow();await flush();}
async function inspector(contact?:any){m.read.mockResolvedValue({member:row,scope,...(contact?{contact}:{})});await import('../../apps/miniprogram/pages/management-members/components/member-inspector/index');component.activate();await flush();}
it('uses actual card identity and independent account/onboarding columns',async()=>{await list();expect(page.data.items[0]).toMatchObject({displayName:'会员甲',cardNumber:'No. 00028'});expect(page.data.fields.map((f:any)=>f.id)).toEqual(['points','orders','onboarding']);page.openFields();expect(page.data.fieldOptions.some((f:any)=>f.id==='account')).toBe(true);});
it('clears selection on a filter change and sends the complete applied query',async()=>{await list();page.toggleSelect();page.select({currentTarget:{dataset:{id}}});expect(page.data.selected).toEqual([id]);page.openFilter();page.setData({accountIndex:2,onboardingIndex:1});page.applyFilter();await flush();expect(page.data.selected).toEqual([]);expect(m.read.mock.calls.at(-1)![1].path).toContain('account=blocked');expect(m.read.mock.calls.at(-1)![1].path).toContain('onboarding=complete');});
it('drops a delayed previous search and a different operator’s result',async()=>{await list();const slow=deferred();m.read.mockReturnValueOnce(slow.promise);page.apply({...page.data.query,q:'old'});m.read.mockResolvedValue({scope,items:[{...row,id:other,displayName:'新结果'}],total:1,nextCursor:null});page.apply({...page.data.query,q:'new'});await flush();slow.resolve({scope,items:[row],total:1,nextCursor:null});await flush();expect(page.data.items[0].displayName).toBe('新结果');const lost=deferred();m.read.mockReturnValue(lost.promise);page.load();m.token='operator-b';lost.resolve({scope,items:[row],total:1,nextCursor:null});await flush();expect(page.data.items).toEqual([]);});
it('does not open a forged list identifier or a record outside the loaded subject',async()=>{await list();page.inspect({currentTarget:{dataset:{id:other}}});expect(page.data.inspectorVisible).toBe(false);page.inspect({currentTarget:{dataset:{id}}});expect(page.data.selectedMember).toBe(id);await inspector();component.openRecord({currentTarget:{dataset:{id:other}}});expect(wx.navigateTo).not.toHaveBeenCalled();});
it('restores target context without retaining hidden contact values',async()=>{
 await inspector({phone:'synthetic private phone'});expect(component.data.phoneText).toBe('synthetic private phone');component.deactivate();expect(component.data.phoneText).toBe('');expect(component.data.member).toBeNull();component.activate();await flush();expect(component.data.member.id).toBe(id);
});

it('shows authorized phone inline and copies with automatic server audit without a confirmation',async()=>{
 await inspector({phone:'+8613800000000'});expect(component.data.phoneText).toBe('+8613800000000');expect(wx.showModal).not.toHaveBeenCalled();m.request.mockResolvedValue({phone:'+8613800000000'});await component.copyContact('phone');expect(m.request).toHaveBeenCalledWith(expect.objectContaining({method:'POST',data:{kind:'phone'}}));expect(wx.setClipboardData).toHaveBeenCalledWith({data:'+8613800000000'});
});

it('opens the exact owned business source and clears previous subject details during a target switch',async()=>{await inspector();component.setData({records:[{id:'entry',source:{kind:'order',id:other}}]});component.openRecord({currentTarget:{dataset:{id:'entry'}}});expect(wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:'/pages/management-order-detail/index?id='+other}));const pending=deferred();m.read.mockReturnValue(pending.promise);component.properties.memberId=other;component.activate();expect(component.data.records).toEqual([]);expect(component.data.member).toBeNull();pending.resolve({member:{...row,id:other},scope});await flush();expect(component.data.member.id).toBe(other);});

it('keeps exact phone input out of the query URL and uses the cancellable private read',async()=>{await list();m.request.mockResolvedValue({scope,items:[row],total:1,nextCursor:null});page.apply({...page.data.query,q:'13800000000'});await flush();expect(m.request).toHaveBeenCalledWith(expect.objectContaining({path:'/v1/management/users/search',method:'POST',data:expect.objectContaining({q:'13800000000'}),registerAbort:expect.any(Function)}));expect(m.read.mock.calls.every(([,o])=>!o.path.includes('13800000000'))).toBe(true);});

it('expands the same tab and business filter into the standalone detail route',async()=>{await inspector();component.setData({tab:'business',section:'care',day:'2026-11-14'});component.expand();expect(wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:'/pages/management-members/detail/index?id='+id+'&tab=business&section=care&day=2026-11-14'}));});

it('recovers an invalidated page cursor by reloading the same filter without replaying the bad cursor',async()=>{await list();page.setData({nextCursor:'old-cursor'});m.read.mockRejectedValueOnce({code:'PAGE_CURSOR_INVALID'}).mockResolvedValue({scope,items:[row],total:1,nextCursor:null});await page.load(true);expect(page.data.error).toBe('');expect(page.data.loadingMore).toBe(false);expect(page.data.items).toHaveLength(1);expect(m.read.mock.calls.at(-1)![1].path).not.toContain('cursor=');});

it('renders a failed overview as a retryable error and clears sensitive fields on revoked authority',async()=>{await inspector();m.read.mockRejectedValueOnce({title:'合成服务暂不可用'});await component.load();expect(component.data.error).toBe('合成服务暂不可用');m.read.mockRejectedValueOnce({status:403,title:'权限已撤销'});await component.load();expect(component.data.member).toBeNull();expect(component.data.phoneText).toBe('');expect(component.data.error).toBe('权限已撤销');});

it('prepares the actual saved avatar through the native cache without Base64 in visible page data',async()=>{m.read.mockResolvedValue({scope,items:[{...row,avatar:'data:image/jpeg;base64,synthetic',avatarRevision:'a'.repeat(64)}],total:1,nextCursor:null});await import('../../apps/miniprogram/pages/management-members/index');page.onShow();await flush();expect(m.avatar).toHaveBeenCalledWith('data:image/jpeg;base64,synthetic','a'.repeat(64));expect(page.data.items[0].avatar).toBe('/synthetic/local-avatar.jpg');expect(JSON.stringify(page.data)).not.toContain('data:image/');});

it('does not copy a delayed address after closing the member detail',async()=>{
 await inspector();const pending=deferred();m.request.mockReturnValueOnce(pending.promise);const read=component.copyContact('address',other);component.deactivate();pending.resolve({address:{recipientName:'旧收件人',phone:'old-phone',detail:'旧地址'}});await read;expect(wx.setClipboardData).not.toHaveBeenCalled();expect(component.data.phoneText).toBe('');
});

it('keeps a new copy busy when the previous detail session response finishes',async()=>{
 await inspector();const first=deferred();m.request.mockReturnValueOnce(first.promise);const oldRead=component.copyContact('phone');component.deactivate();component.activate();await flush();const second=deferred();m.request.mockReturnValueOnce(second.promise);const newRead=component.copyContact('phone');first.resolve({phone:'old-phone'});await oldRead;expect(wx.setClipboardData).not.toHaveBeenCalled();expect(component.data.copyBusy).toBe(true);second.resolve({phone:'new-phone'});await newRead;expect(wx.setClipboardData).toHaveBeenCalledWith({data:'new-phone'});expect(component.data.copyBusy).toBe(false);
});

it('clears all derived private fields when the service permission is revoked',async()=>{
 await inspector();component.setData({sharingRows:[{label:'实付净额',value:'synthetic-private-value'}],profileRows:[{label:'档案',value:'synthetic-private-value'}],sectionData:{private:true}});
 m.read.mockRejectedValueOnce({status:403,title:'权限已撤销'});await component.load();
 expect(component.data.sharingRows).toEqual([]);expect(component.data.profileRows).toEqual([]);expect(component.data.sectionData).toBeNull();expect(component.data.metrics).toEqual([]);
});

it('offers activity issuance only when the server explicitly grants that operation',async()=>{
 await inspector();component.setData({scope:{...scope,issueRewards:false}});await component.management();
 expect(wx.showActionSheet).toHaveBeenLastCalledWith({itemList:['商业会员资格','分享官资格']});
 component.setData({scope:{...scope,issueRewards:true}});await component.management();
 expect(wx.showActionSheet).toHaveBeenLastCalledWith({itemList:['商业会员资格','分享官资格','活动发券']});
});

it('names a coupon occupied by an unpaid order without exposing a raw state code',async()=>{
 const {recordView}=await import('../../apps/miniprogram/pages/management-members/service');
 expect(recordView({kind:'purchase_coupon',title:'体验专属正装券',state:'locked',amount:2000,threshold:19800}).stateLabel).toBe('订单占用');
});

it('switches authorized table lenses locally without repeating an identical database read',async()=>{
 await list();const count=m.read.mock.calls.length;for(const view of ['commerce','activity','assets','sharing','profile'])page.changeView({detail:{value:view}});
 expect(m.read.mock.calls).toHaveLength(count);expect(page.data.query.view).toBe('profile');expect(page.data.items).toHaveLength(1);
});
it('retains displayed rows during refresh and removes them on an explicit filter change',async()=>{
 await list();const pending=deferred();m.read.mockReturnValueOnce(pending.promise);const read=page.load(false,true);expect(page.data.items).toHaveLength(1);expect(page.data.resultReady).toBe(true);pending.resolve({scope,items:[{...row,points:{...row.points,available:851}}],total:1,nextCursor:null});await read;expect(page.data.items[0].points.available).toBe(851);const next=deferred();m.read.mockReturnValueOnce(next.promise);page.apply({...page.data.query,q:'different'});expect(page.data.items).toEqual([]);next.resolve({scope,items:[],total:0,nextCursor:null});await flush();
});

const roleData={version:'a'.repeat(64),rootOwner:false,requiredCapabilities:[],capabilities:[],groups:[{label:'用户',items:[{capability:'member.profile.read',label:'用户资料'},{capability:'member.contact.read',label:'联系资料'}]}]};
it('opens administrator settings only for a server-approved root and keeps root ownership protected',async()=>{
 await inspector();const count=m.read.mock.calls.length;await component.openAdministrator();expect(m.read).toHaveBeenCalledTimes(count);expect(component.data.roleSheet).toBe(false);
 component.setData({scope:{...scope,administrators:true}});m.read.mockResolvedValueOnce({...roleData,rootOwner:true,requiredCapabilities:['member.profile.read'],capabilities:['member.profile.read'],groups:[{label:'用户',items:[{capability:'member.profile.read',label:'用户资料',fixed:true}]}]});await component.openAdministrator();component.toggleAdministratorCapability({currentTarget:{dataset:{capability:'member.profile.read'}}});component.clearAdministratorCapabilities();expect(component.data.roleSelected).toEqual(['member.profile.read']);
});
it('drops a closed administrator sheet response after reopening the same member',async()=>{
 await inspector();component.setData({scope:{...scope,administrators:true}});const first=deferred();m.read.mockReturnValueOnce(first.promise);const old=component.openAdministrator();component.closeAdministrator();m.read.mockResolvedValueOnce({...roleData,version:'b'.repeat(64)});await component.openAdministrator();first.resolve(roleData);await old;expect(component.data.roleVersion).toBe('b'.repeat(64));
});
it('retries an ambiguous administrator save with the exact same operation and cannot edit its pending payload',async()=>{
 await inspector();component.setData({scope:{...scope,administrators:true}});m.read.mockResolvedValueOnce(roleData);await component.openAdministrator();m.request.mockRejectedValueOnce({code:'NETWORK_TIMEOUT',title:'暂未确认'});await component.saveAdministrator();
 expect(component.data.roleLocked).toBe(true);component.toggleAdministratorCapability({currentTarget:{dataset:{capability:'member.contact.read'}}});expect(component.data.roleSelected).toEqual(['member.profile.read']);
 m.request.mockResolvedValueOnce({capabilities:['member.profile.read'],version:'b'.repeat(64)});await component.saveAdministrator();const calls=m.request.mock.calls;expect(calls[0]![0].idempotencyKey).toBe(calls[1]![0].idempotencyKey);expect(calls[0]![0].data).toEqual(calls[1]![0].data);expect(component.data.roleSheet).toBe(false);
});

it('keeps selected duties usable and removes dependent duties when their prerequisite is unchecked',async()=>{
 const {administratorSelection}=await import('../../apps/miniprogram/pages/management-members/service');const groups=[{items:[{capability:'support.read',requires:[]},{capability:'support.reply',requires:['support.read']}]}];
 expect(administratorSelection(groups,['support.reply'])).toEqual(['support.read','support.reply']);expect(administratorSelection(groups,['support.reply'],'support.read')).toEqual([]);
});

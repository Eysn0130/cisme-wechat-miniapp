import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),command:vi.fn(),authority:vi.fn(),catalog:vi.fn(),token:'owner-session',context:0,pending:null as any,reducedMotion:false}));
vi.mock('../../apps/miniprogram/services/api',()=>({requireMemberAccess:()=>true,request:m.read,registerPrivateExport:()=>vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',shouldReduceMotion:()=>m.reducedMotion}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/authority',()=>({authorityProjection:m.authority}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',async()=>({
 ...await vi.importActual<typeof import('../../apps/miniprogram/services/commerce-command-store')>('../../apps/miniprogram/services/commerce-command-store'),
 commerceContextRevision:()=>m.context
}));
vi.mock('../../apps/miniprogram/services/commerce',()=>({catalogList:m.catalog}));
vi.mock('../../apps/miniprogram/services/catalog',()=>({nativeCatalogImage:(v:string)=>v}));
vi.mock('../../apps/miniprogram/services/sharing-officer',async()=>{
 const actual=await vi.importActual<any>('../../apps/miniprogram/services/sharing-officer');return {...actual,officerRead:m.read,officerCommand:m.command,officerPending:()=>m.pending};
});
let page:any;const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function deferred(){let resolve!:(v:any)=>void;const promise=new Promise<any>(yes=>resolve=yes);return {promise,resolve};}
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const wallet={memberId:owner,canApply:true,canShare:false,officer:null,policy:{enabled:true,basisPoints:1000,releaseDays:7},metrics:{orderCount:0,pendingCents:0,availableCents:0,settledNetCents:0},relation:{code:'SOAAAAAAAAAA',version:1}};
const pendingReview={...wallet,canApply:false,officer:{state:'pending',version:1}};
const approvedReview={...pendingReview,canShare:true,officer:{state:'active',version:2}};
const agreement={title:'产品分享官合作协议',version:'V2.0',digest:'a'.repeat(64),effectiveOn:'2026-11-24',sections:[{heading:'第一条',paragraphs:[{kind:'paragraph',text:'合成协议内容'}]}]};
const applyButton={currentTarget:{dataset:{sheet:'apply'}}},applyAction={currentTarget:{dataset:{action:'apply'}}};
function scrollToEnd(p:any,attempt=p.data.agreementAttempt){p.agreementEnd({currentTarget:{dataset:{attempt}}});}
async function mount(kind:'consumer'|'admin',query:Record<string,string>={}){
 (globalThis as any).Page=(d:any)=>{page={...d,data:structuredClone(d.data),setData(v:any){Object.assign(this.data,v);}};};
 if(kind==='consumer')await import('../../apps/miniprogram/pages/sharing-officer/index');else await import('../../apps/miniprogram/pages/management-sharing/index');
 page.onLoad(query);return page;
}
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();m.token='owner-session';m.context=0;m.pending=null;m.reducedMotion=false;
 m.catalog.mockResolvedValue({items:[],nextCursor:null});
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token,apiBaseUrl:'https://staging-api.cisme.cn'}});
 (globalThis as any).wx={hideShareMenu:vi.fn(),stopPullDownRefresh:vi.fn(),getStorageSync:()=>'',showToast:vi.fn(),showModal:vi.fn(),nextTick:vi.fn(),env:{USER_DATA_PATH:'/synthetic'},getFileSystemManager:()=>({unlinkSync:vi.fn()}),navigateBack:vi.fn(),navigateTo:vi.fn()};
 m.authority.mockResolvedValue({capabilities:['member.manage','commission.rate.manage','commission.read','commission.settlement.approve']});
});
afterEach(()=>{page?.stopAgreementTimers?.();page?.stopReviewPolling?.();page?.stopReviewApproval?.();vi.useRealTimers();});

it('shows the agreement before qualification and uses the same main action for the scoped purchase',async()=>{
 vi.useFakeTimers();
 const pending={...wallet,canApply:false,qualification:{met:false},applicationAgreement:agreement};
 m.read.mockResolvedValue(pending);
 const p=await mount('consumer');
 p.onShow();await flush();
 expect(p.data.qualificationPurchaseNeeded).toBe(true);
 p.openAgreement();scrollToEnd(p);await vi.advanceTimersByTimeAsync(12_000);p.agree();
 expect(p.data).toMatchObject({agreementOpen:true,agreementChecked:false,agreementReady:false});
 p.closeAgreement();await vi.advanceTimersByTimeAsync(160);
 p.open(applyButton);p.open(applyButton);
 expect(wx.navigateTo).toHaveBeenCalledTimes(1);
 expect(wx.navigateTo).toHaveBeenCalledWith(expect.objectContaining({url:expect.stringMatching(/^\/pages\/product\/index\?id=aigerong-scalp-repair-essence-100&sharingQualification=/)}));
 expect(m.command).not.toHaveBeenCalled();
 const {bindQualificationOrder,markQualificationCompleted,qualificationOrderOwner,qualificationReturnDistance}=await import('../../apps/miniprogram/services/sharing-qualification-purchase');
 const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',detail={};
 (globalThis as any).getCurrentPages=()=>[p,{},detail];
 expect(bindQualificationOrder(p.qualificationKey,'unrelated-sku',id)).toBe('');
 expect(qualificationOrderOwner(p.qualificationKey,id)).toBeNull();
 expect(bindQualificationOrder(p.qualificationKey,'aigerong-scalp-repair-essence-100',id)).toContain('sharingQualification=');
 expect(qualificationReturnDistance(p.qualificationKey,id,detail)).toBe(2);
 expect(qualificationReturnDistance(p.qualificationKey,id,{})).toBe(0);
 markQualificationCompleted(p.qualificationKey,id);
 expect(qualificationOrderOwner(p.qualificationKey,id)).toBeNull();
 p.onHide();
 m.read.mockResolvedValue({...wallet,qualification:{met:true},applicationAgreement:agreement});
 p.onShow();await flush();
 expect(p.data.qualificationMotion).toBe('entry');
 expect(p.data.agreementChecked).toBe(false);
});

it('uses the server-granted highest administrator promotion and shows immediate opening after confirmation',async()=>{
 vi.useFakeTimers();
 const promoted={...wallet,rootException:true,canShare:true,qualification:{met:false},officer:{state:'promotion_only',version:1},applicationAgreement:agreement};
 m.read.mockResolvedValue(promoted);
 m.catalog.mockResolvedValue({items:[{code:'eligible-fixture-product',name:'合成精华',price:29800,imagePath:'/synthetic/essence.png'}],nextCursor:null});
 const p=await mount('consumer');
 p.onShow();await flush();
 expect(p.data).toMatchObject({hasDashboard:true,qualificationPurchaseNeeded:false,stateLabel:'已开通推广'});
 expect(p.data.products).toEqual([expect.objectContaining({code:'eligible-fixture-product',price:'298.00'})]);
 p.openAgreement();scrollToEnd(p);await vi.advanceTimersByTimeAsync(10000);p.agree();await vi.advanceTimersByTimeAsync(160);
 p.open(applyButton);
 expect(p.data.sheet).toBe('apply');
 m.command.mockResolvedValue({state:'active',rootException:true});m.read.mockResolvedValue(approvedReview);
 await p.operate(applyAction);
 expect(m.command).toHaveBeenCalledWith(owner,'apply',{note:'',agreement:{accepted:true,version:agreement.version,digest:agreement.digest,effectiveOn:agreement.effectiveOn}});
 expect(wx.navigateTo).not.toHaveBeenCalled();
 expect(wx.showToast).toHaveBeenCalledWith({title:'已开通',icon:'success'});
});

it('replays the qualification shine on entry and reserves the spin for a verified qualification change',async()=>{
 const pending={...wallet,canApply:false,qualification:{met:false}};
 const qualified={...wallet,qualification:{met:true},applicationAgreement:agreement};
 m.read.mockResolvedValue(pending);
 const p=await mount('consumer');
 p.onShow();await flush();
 expect(p.data.qualificationMotion).toBe('');
 m.read.mockResolvedValue(qualified);
 await p.load();
 expect(p.data.qualificationMotion).toBe('achieved');
 await p.load();
 expect(p.data.qualificationMotion).toBe('achieved');
 p.onHide();
 expect(p.data.qualificationMotion).toBe('');
 p.onShow();await flush();
 expect(p.data.qualificationMotion).toBe('entry');
 p.onHide();
 m.reducedMotion=true;
 p.onShow();await flush();
 expect(p.data.wallet.qualification.met).toBe(true);
 expect(p.data.qualificationMotion).toBe('');
});

it('requires both ten seconds and the document end before checking and then submitting an application',async()=>{
 vi.useFakeTimers();m.read.mockResolvedValue({...wallet,applicationAgreement:agreement});
 const p=await mount('consumer');p.onShow();await flush();
 p.open(applyButton);expect(p.data.sheet).toBe('');
 expect(wx.showToast).toHaveBeenCalledWith({title:'请阅读并勾选分享官合作协议',icon:'none'});
 p.toggleAgreement();expect(p.data).toMatchObject({agreementOpen:true,agreementChecked:false,agreementSeconds:10,agreementReady:false});
 scrollToEnd(p);await vi.advanceTimersByTimeAsync(9_999);p.agree();
 expect(p.data).toMatchObject({agreementAtEnd:true,agreementChecked:false,agreementReady:false});
 await vi.advanceTimersByTimeAsync(1);expect(p.data.agreementReady).toBe(true);
 p.agree();await vi.advanceTimersByTimeAsync(160);
 expect(p.data).toMatchObject({agreementChecked:true,agreementOpen:false});
 expect(m.command).not.toHaveBeenCalled();
 p.open(applyButton);expect(p.data.sheet).toBe('apply');m.command.mockResolvedValue({state:'pending'});
 await p.operate(applyAction);
 expect(m.command).toHaveBeenCalledWith(owner,'apply',{note:'',agreement:{version:agreement.version,digest:agreement.digest,effectiveOn:agreement.effectiveOn,accepted:true}});
});

it('keeps the button locked when the countdown finishes before scrolling, then resets on close or account change',async()=>{
 vi.useFakeTimers();m.read.mockResolvedValue({...wallet,applicationAgreement:agreement});
 const p=await mount('consumer');p.onShow();await flush();
 p.openAgreement();const first=p.data.agreementAttempt;
 await vi.advanceTimersByTimeAsync(10_000);p.agree();
 expect(p.data).toMatchObject({agreementSeconds:0,agreementAtEnd:false,agreementReady:false,agreementChecked:false});
 p.closeAgreement();await vi.advanceTimersByTimeAsync(160);p.openAgreement();
 scrollToEnd(p,first);expect(p.data.agreementAtEnd).toBe(false);
 scrollToEnd(p);await vi.advanceTimersByTimeAsync(10_000);p.agree();
 expect(p.data.agreementChecked).toBe(true);
 p.onHide();m.token='another-owner';p.onShow();await flush();
 expect(p.data).toMatchObject({agreementOpen:false,agreementChecked:false});
 p.open(applyButton);expect(p.data.sheet).toBe('');expect(m.command).not.toHaveBeenCalled();
});

it('lets applicants read a draft but cannot accept it or open the application with it',async()=>{
 vi.useFakeTimers();m.read.mockResolvedValue({...wallet,applicationAgreement:{...agreement,effectiveOn:null}});
 const p=await mount('consumer');p.onShow();await flush();
 p.openAgreement();scrollToEnd(p);await vi.advanceTimersByTimeAsync(10_000);p.agree();
 expect(p.data).toMatchObject({agreementReady:false,agreementChecked:false});
 p.closeAgreement();await vi.advanceTimersByTimeAsync(160);p.open(applyButton);
 expect(wx.showToast).toHaveBeenCalledWith({title:'合作协议尚未启用',icon:'none'});
 expect(p.data.sheet).toBe('');expect(m.command).not.toHaveBeenCalled();
});
it('sends a deliberate referrer change with the displayed relation version',async()=>{
 m.read.mockResolvedValue(wallet);const p=await mount('consumer');p.onShow();await flush();p.setData({sheet:'referrer',preview:{code:'SOBBBBBBBBBB',eligible:true}});m.command.mockResolvedValue({});
 await p.operate({currentTarget:{dataset:{action:'change_referrer'}}});expect(m.command).toHaveBeenCalledWith(owner,'change_referrer',{code:'SOBBBBBBBBBB',confirmed:true,expectedVersion:1});
});
it('opens a shared-link hint for review and makes the choice only after the buyer confirms',async()=>{
 const candidate={code:'SOBBBBBBBBBB',label:'合成分享官'};
 const initial={...wallet,relation:null,linkReferrer:candidate};
 m.read.mockImplementation(async(_page,path)=>path.includes('referrer-preview')?{...candidate,eligible:true,onFirstValidOrder:true}:initial);
 const p=await mount('consumer',{mode:'referrer'});
 p.onShow();await flush();
 await p.openLinkedReferrer();
 expect(p.data).toMatchObject({sheet:'referrer',code:candidate.code,preview:{...candidate,eligible:true}});
 expect(m.command).not.toHaveBeenCalled();
 m.command.mockResolvedValue({pendingReferrer:candidate});
 await p.operate({currentTarget:{dataset:{action:'change_referrer'}}});
 expect(m.command).toHaveBeenCalledExactlyOnceWith(owner,'change_referrer',{code:candidate.code,confirmed:true,expectedVersion:0});
});
it('does not let a late wallet read repopulate another session or a hidden page',async()=>{
 const q=deferred();m.read.mockReturnValue(q.promise);const p=await mount('consumer');p.onShow();p.onHide();m.token='different-owner';q.resolve(wallet);await flush();expect(p.data.wallet).toBeNull();expect(p.data.memberId).toBe('');
});
it('keeps a rejected former officer’s existing money history accessible',async()=>{
 m.read.mockResolvedValue({...wallet,officer:{state:'rejected',version:4},metrics:{...wallet.metrics,orderCount:1}});const p=await mount('consumer');p.onShow();await flush();expect(p.data.hasDashboard).toBe(true);
});
it('silently reads a pending application and plays the opening moment once after approval',async()=>{
 vi.useFakeTimers();
 m.read.mockResolvedValueOnce(pendingReview).mockResolvedValueOnce(pendingReview).mockResolvedValue(approvedReview);
 const p=await mount('consumer');p.onShow();await flush();
 expect(p.data).toMatchObject({reviewMotion:true,reviewApproved:false,loading:false,stateLabel:'待审核'});
 p.onPullDownRefresh();
 expect(m.read).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(8_000);
 expect(m.read).toHaveBeenCalledTimes(2);
 expect(p.data).toMatchObject({reviewApproved:false,loading:false,error:''});
 await vi.advanceTimersByTimeAsync(8_000);
 expect(m.read).toHaveBeenLastCalledWith(p,'/v1/me/sharing-officer');
 expect(p.data).toMatchObject({reviewApproved:true,stateLabel:'已开通',hasDashboard:true,loading:false});
 await vi.advanceTimersByTimeAsync(760);
 expect(p.data.reviewApproved).toBe(false);
 await vi.advanceTimersByTimeAsync(16_000);
 expect(m.read).toHaveBeenCalledTimes(3);
 p.onHide();p.onShow();await flush();
 expect(p.data.reviewApproved).toBe(false);
});
it('backs off a failed quiet read and preserves the last confirmed waiting state',async()=>{
 vi.useFakeTimers();
 m.read.mockResolvedValueOnce(pendingReview).mockRejectedValueOnce(new Error('network interrupted')).mockResolvedValue(pendingReview);
 const p=await mount('consumer');p.onShow();await flush();
 await vi.advanceTimersByTimeAsync(23_999);
 expect(m.read).toHaveBeenCalledTimes(2);
 expect(p.data).toMatchObject({wallet:pendingReview,stateLabel:'待审核',error:'',loading:false});
 await vi.advanceTimersByTimeAsync(1);
 expect(m.read).toHaveBeenCalledTimes(3);
 await vi.advanceTimersByTimeAsync(8_000);
 expect(m.read).toHaveBeenCalledTimes(4);
});
it('stops reads and motion on hide and resynchronizes without applying the late response',async()=>{
 vi.useFakeTimers();
 const late=deferred();
 m.read.mockResolvedValueOnce(pendingReview).mockReturnValueOnce(late.promise).mockResolvedValue(pendingReview);
 const p=await mount('consumer');p.onShow();await flush();
 await vi.advanceTimersByTimeAsync(24_000);
 expect(m.read).toHaveBeenCalledTimes(2);
 p.onHide();
 expect(p.data.reviewMotion).toBe(false);
 await vi.advanceTimersByTimeAsync(16_000);
 expect(m.read).toHaveBeenCalledTimes(2);
 p.onShow();await flush();
 expect(m.read).toHaveBeenCalledTimes(3);
 late.resolve(approvedReview);await flush();
 expect(p.data).toMatchObject({wallet:pendingReview,reviewMotion:true,reviewApproved:false});
});
it.each([['active','已开通'],['rejected','未通过']])('shows a resolved %s state with motion reduced',async(state,label)=>{
 vi.useFakeTimers();m.reducedMotion=true;
 const terminal=state==='active'?approvedReview:{...pendingReview,officer:{state,version:2}};
 m.read.mockResolvedValueOnce(pendingReview).mockResolvedValue(terminal);
 const p=await mount('consumer');p.onShow();await flush();
 expect(p.data.reviewMotion).toBe(false);
 await vi.advanceTimersByTimeAsync(8_000);
 expect(p.data).toMatchObject({stateLabel:label,reviewApproved:false,loading:false});
 await vi.advanceTimersByTimeAsync(16_000);
 expect(m.read).toHaveBeenCalledTimes(2);
});
it.each([['', 'V2.0'], ['条件已达成', 'V2.0.1']])('approves from the shared management page with note %j for agreement %s',async(reason,agreementVersion)=>{
 const applicant='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const row={memberId:applicant,displayName:'合成申请人',state:'pending',version:1,agreementVersion};
 const projection={memberId:owner,scope:{manage:true},policy:wallet.policy,items:[row]};
 m.read.mockImplementation((_page,path)=>Promise.resolve(path.includes('section=officer-detail')?
  {memberId:owner,detail:{officer:row,accountState:'active',qualification:{met:true}}}:projection));
 const p=await mount('admin',reason?{memberId:applicant}:{filter:'pending'});
 p.onShow();await flush();
 if(reason)expect(m.read.mock.calls.some((call:any)=>call[1].includes('memberId='+applicant))).toBe(true);
 else{
  expect(p.data.filter).toBe('pending');
  expect(m.read.mock.calls[0]?.[1]).toContain('&filter=pending');
  p.selectOfficer({currentTarget:{dataset:{id:applicant}}});
  await flush();
 }
 const approve={currentTarget:{dataset:{state:'active',label:'同意申请'}}};
 p.setData({scope:{manage:false}});
 p.chooseDecision(approve);
 expect(p.data.sheet).toBe('officer');
 p.setData({scope:{manage:true}});
 p.chooseDecision(approve);
 expect(p.data).toMatchObject({sheet:'decision',approving:true,reason:''});
 if(reason)p.edit({currentTarget:{dataset:{field:'reason'}},detail:{value:` ${reason} `}});
 m.command.mockResolvedValue({state:'active',version:2});
 m.read.mockResolvedValue({...projection,items:[]});
 await p.operate({currentTarget:{dataset:{action:'officer_state'}}});
 expect(m.command).toHaveBeenCalledExactlyOnceWith(owner,'officer_state',{
  memberId:applicant,state:'active',expectedVersion:1,...(reason?{reason}:{})
 },true);
 expect(p.data.items).toEqual([]);
 expect(wx.showToast).toHaveBeenCalledWith({title:'分享官已开通',icon:'none'});
});
it('filters by review event and requires a second confirmation to remove or restore a customer',async()=>{
 const applicant='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',buyer='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 const row={memberId:applicant,displayName:'合成申请人',state:'suspended',version:3,reviewedAt:'2026-11-23T17:00:00Z',applicationAt:'2026-11-20T09:00:00Z',availablePoints:0};
 const scope={manage:true,customers:true},projection={memberId:owner,scope,items:[row]};
 let removed=false;
 const customer={id:buyer,displayName:'合成会员',cardNumber:'No. 00042',displayIdentity:'sharing-officer',availablePoints:0,version:1,restorable:true};
 m.read.mockImplementation((_page,path)=>{
  if(path.includes('section=officer-detail'))return Promise.resolve({memberId:owner,detail:{officer:row,accountState:'active'}});
  if(path.includes('section=customers')){
   const showingRemoved=path.includes('customerFilter=removed');
   return Promise.resolve({...projection,officerState:'suspended',officerVersion:3,
    items:showingRemoved===removed?[{...customer,controlVersion:removed?2:1,removedAt:removed?'2026-11-24':null}]:[]});
  }
  return Promise.resolve(projection);
 });
 m.command.mockImplementation(async(_owner,_action,input)=>{removed=input.remove;return {removed};});
 const p=await mount('admin');
 p.onShow();await flush();
 p.filterChange({detail:{value:'2'}});await flush();
 expect(m.read.mock.calls.at(-1)?.[1]).toContain('&filter=reviewed');
 expect(p.data.officerGroups[0]).toMatchObject({key:'2026-11-24',items:[{points:'0'}]});
 const rowTap=(id:string)=>({currentTarget:{dataset:{id}}});
 p.selectOfficer(rowTap(applicant));await flush();
 p.openCustomers();await flush();
 expect(p.data.customers[0]).toMatchObject({cardNumber:'No. 00042',points:'0',badge:'sharing-officer',avatar:'/assets/icons/user-circle-plum.svg'});
 p.chooseCustomer(rowTap(buyer));
 p.setData({reason:'确认测试'});
 vi.mocked(wx.showModal).mockResolvedValueOnce({confirm:false,cancel:true});
 await p.confirmCustomer();
 expect(m.command).not.toHaveBeenCalled();
 expect(p.data.sheet).toBe('customer-decision');
 vi.mocked(wx.showModal).mockResolvedValue({confirm:true,cancel:false});
 await p.confirmCustomer();await flush();
 expect(m.command).toHaveBeenLastCalledWith(owner,'customer_relation',expect.objectContaining({
  memberId:applicant,buyerId:buyer,remove:true,expectedVersion:1,expectedControlVersion:1,expectedOfficerVersion:3,confirmed:true
 }),true);
 expect(p.data.customers).toEqual([]);
 p.changeCustomerFilter({detail:{value:'1'}});await flush();
 p.chooseCustomer(rowTap(buyer));
 p.setData({reason:'恢复测试'});
 await p.confirmCustomer();
 expect(m.command).toHaveBeenLastCalledWith(owner,'customer_relation',expect.objectContaining({remove:false,expectedControlVersion:2}),true);
 expect(wx.showModal).toHaveBeenLastCalledWith(expect.objectContaining({content:expect.stringContaining('资格恢复后的新订单才计佣')}));
});
it('clears private finance and payee data when the management page hides',async()=>{
 m.read.mockResolvedValue({memberId:owner,scope:{finance:true,manage:true},policy:wallet.policy,items:[{memberId:owner,displayName:'合成分享官',state:'active'}],hasMore:false,nextCursor:null});
 const p=await mount('admin');p.onShow();await flush();p.setData({payee:{legalName:'合成姓名',account:'SYNTHETIC-ACCOUNT'},reference:'SYNTHETIC-REF',sourceOrders:[{id:owner}],history:[{amount:100}]});p.onHide();
 expect(p.data.payee).toBeNull();expect(p.data.items).toEqual([]);expect(p.data.history).toEqual([]);expect(p.data.scope).toBeNull();expect(p.data.reference).toBe('');
});
it('stops a delayed permission response from restoring a hidden management page',async()=>{
 const q=deferred();m.authority.mockReturnValue(q.promise);const p=await mount('admin');p.onShow();p.onHide();q.resolve({capabilities:['commission.settlement.approve']});await flush();expect(m.read).not.toHaveBeenCalled();expect(p.data.scope).toBeNull();
});

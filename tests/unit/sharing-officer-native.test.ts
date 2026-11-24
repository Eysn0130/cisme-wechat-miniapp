import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),command:vi.fn(),authority:vi.fn(),token:'owner-session',context:0,pending:null as any}));
vi.mock('../../apps/miniprogram/services/api',()=>({requireMemberAccess:()=>true,request:m.read,registerPrivateExport:()=>vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',shouldReduceMotion:()=>false}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/authority',()=>({authorityProjection:m.authority}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>m.context}));
vi.mock('../../apps/miniprogram/services/commerce',()=>({catalogList:async()=>({items:[],nextCursor:null})}));
vi.mock('../../apps/miniprogram/services/catalog',()=>({nativeCatalogImage:(v:string)=>v}));
vi.mock('../../apps/miniprogram/services/sharing-officer',async()=>{
 const actual=await vi.importActual<any>('../../apps/miniprogram/services/sharing-officer');return {...actual,officerRead:m.read,officerCommand:m.command,officerPending:()=>m.pending};
});
let page:any;const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function deferred(){let resolve!:(v:any)=>void;const promise=new Promise<any>(yes=>resolve=yes);return {promise,resolve};}
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const wallet={memberId:owner,canApply:true,canShare:false,officer:null,policy:{enabled:true,basisPoints:1000,releaseDays:7},metrics:{orderCount:0,pendingCents:0,availableCents:0,settledNetCents:0},relation:{code:'SOAAAAAAAAAA',version:1}};
const agreement={title:'产品分享官合作协议',version:'V2.0',digest:'a'.repeat(64),effectiveOn:'2026-11-24',sections:[{heading:'第一条',paragraphs:[{kind:'paragraph',text:'合成协议内容'}]}]};
const applyButton={currentTarget:{dataset:{sheet:'apply'}}},applyAction={currentTarget:{dataset:{action:'apply'}}};
function scrollToEnd(p:any,attempt=p.data.agreementAttempt){p.agreementEnd({currentTarget:{dataset:{attempt}}});}
async function mount(kind:'consumer'|'admin'){
 (globalThis as any).Page=(d:any)=>{page={...d,data:structuredClone(d.data),setData(v:any){Object.assign(this.data,v);}};};
 if(kind==='consumer')await import('../../apps/miniprogram/pages/sharing-officer/index');else await import('../../apps/miniprogram/pages/management-sharing/index');
 page.onLoad({});return page;
}
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();m.token='owner-session';m.context=0;m.pending=null;
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token,apiBaseUrl:'https://staging-api.cisme.cn'}});
 (globalThis as any).wx={hideShareMenu:vi.fn(),stopPullDownRefresh:vi.fn(),getStorageSync:()=>'',showToast:vi.fn(),nextTick:vi.fn(),env:{USER_DATA_PATH:'/synthetic'},getFileSystemManager:()=>({unlinkSync:vi.fn()}),navigateBack:vi.fn()};
 m.authority.mockResolvedValue({capabilities:['member.manage','commission.rate.manage','commission.read','commission.settlement.approve']});
});
afterEach(()=>{page?.stopAgreementTimers?.();vi.useRealTimers();});

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
it('does not let a late wallet read repopulate another session or a hidden page',async()=>{
 const q=deferred();m.read.mockReturnValue(q.promise);const p=await mount('consumer');p.onShow();p.onHide();m.token='different-owner';q.resolve(wallet);await flush();expect(p.data.wallet).toBeNull();expect(p.data.memberId).toBe('');
});
it('keeps a rejected former officer’s existing money history accessible',async()=>{
 m.read.mockResolvedValue({...wallet,officer:{state:'rejected',version:4},metrics:{...wallet.metrics,orderCount:1}});const p=await mount('consumer');p.onShow();await flush();expect(p.data.hasDashboard).toBe(true);
});
it('clears private finance and payee data when the management page hides',async()=>{
 m.read.mockResolvedValue({memberId:owner,scope:{finance:true,manage:true},policy:wallet.policy,items:[{memberId:owner,displayName:'合成分享官',state:'active'}],hasMore:false,nextCursor:null});
 const p=await mount('admin');p.onShow();await flush();p.setData({payee:{legalName:'合成姓名',account:'SYNTHETIC-ACCOUNT'},reference:'SYNTHETIC-REF',sourceOrders:[{id:owner}],history:[{amount:100}]});p.onHide();
 expect(p.data.payee).toBeNull();expect(p.data.items).toEqual([]);expect(p.data.history).toEqual([]);expect(p.data.scope).toBeNull();expect(p.data.reference).toBe('');
});
it('stops a delayed permission response from restoring a hidden management page',async()=>{
 const q=deferred();m.authority.mockReturnValue(q.promise);const p=await mount('admin');p.onShow();p.onHide();q.resolve({capabilities:['commission.settlement.approve']});await flush();expect(m.read).not.toHaveBeenCalled();expect(p.data.scope).toBeNull();
});

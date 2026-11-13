import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const api=vi.hoisted(()=>({requireMemberAccess:vi.fn(()=>true),resumeAuthentication:vi.fn()}));
const services=vi.hoisted(()=>({rewardWallet:vi.fn(),rewardSelection:vi.fn(),rewardClaim:vi.fn(),rewardReceipt:vi.fn(),abandonReward:vi.fn(),rewardQuote:vi.fn(),confirmReward:vi.fn(),operateReward:vi.fn(),rewardCopy:vi.fn(()=> '请重试'),rewardDate:vi.fn(()=> '2026.11.13'),rewardExpiry:vi.fn(()=> '2026.12.13 08:00'),rewardState:{placed:'待发货',unused:'待领取'},purchaseCouponState:{used:'已使用'}}));
const reads=vi.hoisted(()=>({cancelPageReads:vi.fn(),pageRead:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>api);
vi.mock('../../apps/miniprogram/services/rewards',()=>services);
vi.mock('../../apps/miniprogram/services/page-requests',()=>reads);
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',shouldReduceMotion:()=>false}));
const owner='11111111-1111-4111-8111-111111111111',voucher='22222222-2222-4222-8222-222222222222',quoteId='33333333-3333-4333-8333-333333333333',claimId='44444444-4444-4444-8444-444444444444';
let page:any,app:any,storage:Map<string,unknown>,wx:any;
const deferred=<T>()=>{let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const selection=()=>({memberId:owner,voucher:{id:voucher,state:'unused',expiresAt:'2026-12-13T00:00:00Z'},bundles:[{code:'moisture',availableQuantity:1,stockConfirmed:true},{code:'dandruff',availableQuantity:1,stockConfirmed:true}],survey:{completed:true,version:1,recommendation:'moisture'}});
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();storage=new Map();app={globalData:{sessionToken:'member-A',apiBaseUrl:'https://staging-api.cisme.cn',cloudFunction:null}};
 wx={getStorageSync:(k:string)=>structuredClone(storage.get(k)??''),setStorageSync:(k:string,v:unknown)=>storage.set(k,structuredClone(v)),navigateTo:vi.fn(),redirectTo:vi.fn(),switchTab:vi.fn(),navigateBack:vi.fn(),showToast:vi.fn(),stopPullDownRefresh:vi.fn()};
 vi.stubGlobal('getApp',()=>app);vi.stubGlobal('wx',wx);vi.stubGlobal('Page',(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(patch:Record<string,unknown>){Object.assign(this.data,patch);}};});
 services.rewardSelection.mockResolvedValue(selection());reads.pageRead.mockResolvedValue({addresses:[{id:owner,version:1,isDefault:true,recipientName:'测试收件人'}]});
 services.rewardWallet.mockResolvedValue({memberId:owner,vouchers:[],claims:[],coupons:[],moreClaims:false});services.rewardReceipt.mockResolvedValue({status:'not_found'});
 services.rewardQuote.mockResolvedValue({id:quoteId});services.confirmReward.mockResolvedValue({id:claimId,state:'placed',version:1});
 await import('../../apps/miniprogram/pages/rewards/index');page.onLoad({voucher});page.visible=true;page.token='member-A';
});
afterEach(()=>vi.unstubAllGlobals());
async function loaded(){await page.load();page.setData({selectedBundle:'moisture'});}
describe('native reward interruption and result ownership',()=>{
 it('never preselects the recommended bundle on initial load',async()=>{await page.load();expect(page.data.selection.survey.recommendation).toBe('moisture');expect(page.data.selectedBundle).toBe('');});
 it('ignores a selection response after navigation away and cancels read ownership',async()=>{
  const read=deferred<any>();services.rewardSelection.mockReturnValueOnce(read.promise);const loading=page.load();page.onHide();read.resolve(selection());await loading;
  expect(page.data.selection).toBeNull();expect(reads.cancelPageReads).toHaveBeenCalledWith(page);
 });
 it('clears member data on account change and never applies the old account response',async()=>{
  const read=deferred<any>();services.rewardSelection.mockReturnValueOnce(read.promise);const loading=page.load();app.globalData.sessionToken='member-B';read.resolve(selection());await loading;
  expect(page.data.selection).toBeNull();expect(page.current()).toBe(false);
 });
 it('does not dispatch a claim when backgrounded while only the quote was pending',async()=>{
  await loaded();const read=deferred<any>();services.rewardQuote.mockReturnValueOnce(read.promise);const confirming=page.confirm();page.onHide();read.resolve({id:quoteId});await confirming;
  expect(services.confirmReward).not.toHaveBeenCalled();expect(storage.size).toBe(0);
 });
 it('persists the original operation before dispatch and retries exactly that operation after a network error',async()=>{
  await loaded();services.confirmReward.mockRejectedValueOnce({status:503});await page.confirm();expect(page.data.unknown).toBe(true);
  const first=services.confirmReward.mock.calls[0]!;expect(JSON.stringify([...storage])).toContain(first[1]);
  await page.confirm();expect(services.confirmReward).toHaveBeenCalledTimes(1);
  await page.retryPending();expect(services.confirmReward.mock.calls[1]).toEqual(first);expect(wx.redirectTo).toHaveBeenCalledWith(expect.objectContaining({url:`/pages/rewards/index?claim=${claimId}`}));
 });
 it('does not erase the durable hint or navigate from a hidden-page mutation response',async()=>{
  await loaded();const response=deferred<any>();services.confirmReward.mockReturnValueOnce(response.promise);const confirming=page.confirm();
  await vi.waitFor(()=>expect(services.confirmReward).toHaveBeenCalledOnce());page.onHide();response.resolve({id:claimId});await confirming;
  expect(wx.redirectTo).not.toHaveBeenCalled();expect(JSON.stringify([...storage])).toContain(quoteId);
  page.setData({mode:'wallet'});services.rewardReceipt.mockResolvedValueOnce({status:'found',action:'reward.claim',record:{id:claimId}});page.onShow();
  await vi.waitFor(()=>expect(wx.redirectTo).toHaveBeenCalledOnce());expect(JSON.stringify([...storage])).not.toContain(quoteId);
 });
});

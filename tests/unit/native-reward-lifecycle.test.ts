import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const api=vi.hoisted(()=>({requireMemberAccess:vi.fn(()=>true),resumeAuthentication:vi.fn(),navigateAfterAuthentication:vi.fn()}));
const services=vi.hoisted(()=>({exportRewards:vi.fn(),rewardManagement:vi.fn(),rewardWallet:vi.fn(),rewardSelection:vi.fn(),rewardClaim:vi.fn(),rewardReceipt:vi.fn(),abandonReward:vi.fn(),rewardQuote:vi.fn(),confirmReward:vi.fn(),operateReward:vi.fn(),acceptRewardInvitation:vi.fn(),rewardInvitation:vi.fn(),rewardCopy:vi.fn(()=> '请重试'),rewardDate:vi.fn(()=> '2026.11.13'),rewardExpiry:vi.fn(()=> '2026.12.13 08:00'),rewardState:{placed:'待发货',unused:'待领取'},purchaseCouponState:{used:'已使用'}}));
const reads=vi.hoisted(()=>({cancelPageReads:vi.fn(),pageRead:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>api);
vi.mock('../../apps/miniprogram/services/rewards',()=>services);
vi.mock('../../apps/miniprogram/services/page-requests',()=>reads);
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',shouldReduceMotion:()=>false}));
const owner='11111111-1111-4111-8111-111111111111',voucher='22222222-2222-4222-8222-222222222222',quoteId='33333333-3333-4333-8333-333333333333',claimId='44444444-4444-4444-8444-444444444444';
let page:any,app:any,storage:Map<string,unknown>,wx:any,component:any,definition:any;
const deferred=<T>()=>{let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const selection=()=>({memberId:owner,voucher:{id:voucher,state:'unused',expiresAt:'2026-12-13T00:00:00Z'},bundles:[{code:'moisture',availableQuantity:1,stockConfirmed:true},{code:'dandruff',availableQuantity:1,stockConfirmed:true}],survey:{completed:true,version:1,recommendation:'moisture'}});
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();storage=new Map();app={globalData:{sessionToken:'member-A',apiBaseUrl:'https://staging-api.cisme.cn',cloudFunction:null}};
 wx={getStorageSync:(k:string)=>structuredClone(storage.get(k)??''),setStorageSync:(k:string,v:unknown)=>storage.set(k,structuredClone(v)),removeStorageSync:(k:string)=>storage.delete(k),env:{USER_DATA_PATH:'wxfile://usr'},getFileSystemManager:()=>({access:({success}:any)=>success()}),previewImage:vi.fn(),navigateTo:vi.fn(),redirectTo:vi.fn(),switchTab:vi.fn(),navigateBack:vi.fn(),showToast:vi.fn(),showShareMenu:vi.fn(),stopPullDownRefresh:vi.fn()};
 vi.stubGlobal('getApp',()=>app);vi.stubGlobal('wx',wx);vi.stubGlobal('Page',(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(patch:Record<string,unknown>){Object.assign(this.data,patch);}};});
 services.rewardSelection.mockResolvedValue(selection());reads.pageRead.mockResolvedValue({addresses:[{id:owner,version:1,isDefault:true,recipientName:'测试收件人'}]});
 services.rewardWallet.mockResolvedValue({memberId:owner,vouchers:[],claims:[],coupons:[],moreClaims:false});services.rewardReceipt.mockResolvedValue({status:'not_found'});
 services.rewardQuote.mockResolvedValue({id:quoteId,item:{image:'/pages/rewards/assets/moisture-100-100-v1.jpg',name:'净润洗护礼遇',code:'moisture'}});services.confirmReward.mockResolvedValue({id:claimId,state:'placed',version:1});
 vi.stubGlobal('Component',(d:any)=>{definition=d;});await import('../../apps/miniprogram/pages/checkout/components/reward-checkout/index');
 component={...definition.methods,properties:{voucher,active:false},data:structuredClone(definition.data),triggerEvent:vi.fn(),selectComponent:()=>({present:async()=>{}}),setData(patch:any){Object.assign(this.data,patch);}};
 definition.lifetimes.attached.call(component);component.properties.active=true;component.onHide=()=>definition.pageLifetimes.hide.call(component);component.onShow=()=>definition.pageLifetimes.show.call(component);page=component;
});
afterEach(()=>{if(component)definition.lifetimes.detached.call(component);vi.unstubAllGlobals();});
async function loaded(){await page.load();page.setData({selectedBundle:'moisture'});}
describe('native reward interruption and result ownership',()=>{
 it('never preselects the recommended bundle on initial load',async()=>{await page.load();expect(page.data.selection.survey.recommendation).toBe('moisture');expect(page.data.selectedBundle).toBe('');});
 it('ignores a selection response after navigation away and cancels read ownership',async()=>{
  const read=deferred<any>();services.rewardSelection.mockReturnValueOnce(read.promise);const loading=page.load();page.onHide();read.resolve(selection());await loading;
  expect(page.data.selection).toBeNull();expect(reads.cancelPageReads).toHaveBeenCalledWith(page);
 });
 it('clears member data on account change and never applies the old account response',async()=>{
  const read=deferred<any>();services.rewardSelection.mockReturnValueOnce(read.promise);const loading=page.load();app.globalData.sessionToken='member-B';read.resolve(selection());await loading;
  expect(page.data.selection).toBeNull();expect(page.data.memberId).toBe('');expect(services.confirmReward).not.toHaveBeenCalled();
 });
 it('does not dispatch a claim when backgrounded while only the quote was pending',async()=>{
  await loaded();const read=deferred<any>();services.rewardQuote.mockReturnValueOnce(read.promise);const confirming=page.confirm();page.onHide();read.resolve({id:quoteId});await confirming;
  expect(services.confirmReward).not.toHaveBeenCalled();expect(storage.size).toBe(0);
 });
 it('persists the original operation before dispatch and retries exactly that operation after a network error',async()=>{
  await loaded();services.confirmReward.mockRejectedValueOnce({status:503});await page.confirm();expect(page.data.unknown).toBe(true);
  const first=services.confirmReward.mock.calls[0]!;expect(JSON.stringify([...storage])).toContain(first[1]);
  await page.confirm();expect(services.confirmReward).toHaveBeenCalledTimes(1);
  await page.retryPending();expect(services.confirmReward.mock.calls[1]).toEqual(first);expect(page.triggerEvent).toHaveBeenCalledWith('complete',{owner,id:claimId});
 });
 it('does not erase the durable hint or navigate from a hidden-page mutation response',async()=>{
  await loaded();const response=deferred<any>();services.confirmReward.mockReturnValueOnce(response.promise);const confirming=page.confirm();
  await vi.waitFor(()=>expect(services.confirmReward).toHaveBeenCalledOnce());page.onHide();response.resolve({id:claimId});await confirming;
  expect(wx.redirectTo).not.toHaveBeenCalled();expect(JSON.stringify([...storage])).toContain(quoteId);
  page.setData({mode:'wallet'});services.rewardReceipt.mockResolvedValueOnce({status:'found',action:'reward.claim',record:{id:claimId}});page.onShow();
  await vi.waitFor(()=>expect(page.triggerEvent).toHaveBeenCalledWith('complete',{owner,id:claimId}));expect(JSON.stringify([...storage])).not.toContain(quoteId);
 });
});


it('removes private management facts immediately when a refreshed permission check is denied',async()=>{
 await import('../../apps/miniprogram/pages/management-rewards/index');page.onLoad();page.visible=true;page.token='member-A';page.setData({manager:{vouchers:[{member_id:'private-member'}]},detail:{trackingNumber:'private-waybill'},products:[{id:'private-product'}],sheet:'detail',issueInput:'private-list'});services.rewardManagement.mockRejectedValueOnce({status:403,code:'CAPABILITY_REQUIRED'});await page.load();expect(page.data).toMatchObject({manager:null,detail:null,products:[],sheet:'',issueInput:'',loading:false});
});

describe('shared invitation native flow',()=>{
 const token='a'.repeat(64);
 const wallet=()=>({memberId:owner,vouchers:[{id:voucher,state:'unused',expiresAt:'2026-12-13T00:00:00Z'}],claims:[],coupons:[],moreClaims:false});
 it('redirects legacy invitation links to care without showing an arrival popup in the wallet',async()=>{
  await import('../../apps/miniprogram/pages/rewards/index');page.onLoad({invite:token});page.onShow();await Promise.resolve();expect(api.navigateAfterAuthentication).toHaveBeenCalledWith('/pages/home/index');expect(services.acceptRewardInvitation).not.toHaveBeenCalled();expect(page.data.wallet).toBeNull();
 });
 it('closes the picker without discarding the voucher or selected address',async()=>{
  await page.load();const address=page.data.selectedAddressId;page.closeBundleSheet();expect(page.data.bundleSheetOpen).toBe(false);expect(page.data.selection.voucher.id).toBe(voucher);expect(page.data.selectedAddressId).toBe(address);
 });
 it('shows redemption celebration only after a confirmed claim and opens the exact receipt when it finishes',async()=>{
  await loaded();await page.confirm();expect(page.data.redemptionId).toBe(claimId);expect(page.data.bundleSheetOpen).toBe(false);expect(wx.redirectTo).not.toHaveBeenCalled();
  page.finishRedemption({detail:{owner,reference:claimId}});expect(page.triggerEvent).toHaveBeenCalledWith('complete',{owner,id:claimId});
 });
 it('refreshes sold-out choices after fencing the rejected operation and leaves the other set available',async()=>{
  await loaded();services.confirmReward.mockRejectedValueOnce({code:'REWARD_SOLD_OUT'});services.abandonReward.mockResolvedValueOnce({status:'abandoned'});
  services.rewardSelection.mockResolvedValueOnce({...selection(),bundles:[{code:'moisture',stockConfirmed:true,availableQuantity:0},{code:'dandruff',stockConfirmed:true,availableQuantity:2}]});
  await page.confirm();expect(page.data.redemptionId).toBe('');expect(page.data.unknown).toBe(false);expect(page.data.selectedBundle).toBe('');
  page.chooseBundle({currentTarget:{dataset:{code:'moisture'}}});expect(page.data.selectedBundle).toBe('');page.chooseBundle({currentTarget:{dataset:{code:'dandruff'}}});page.confirmBundle();expect(page.data.selectedBundle).toBe('dandruff');
 });
});

it('rejects a sold-out bundle even when a stale or forged selection event names it',async()=>{
 services.rewardSelection.mockResolvedValueOnce({...selection(),bundles:[{code:'moisture',stockConfirmed:true,availableQuantity:0},{code:'dandruff',stockConfirmed:true,availableQuantity:1}]});await page.load();
 page.chooseBundle({currentTarget:{dataset:{code:'moisture'}}});page.confirmBundle();expect(page.data.selectedBundle).toBe('');expect(page.data.draftBundle).toBe('');
 page.chooseBundle({currentTarget:{dataset:{code:'dandruff'}}});page.confirmBundle();expect(page.data.selectedBundle).toBe('dandruff');
});
it('keeps uncertain outcomes out of the picker so recovery controls remain reachable',async()=>{
 await loaded();services.confirmReward.mockRejectedValueOnce({status:503});await page.confirm();await page.load();expect(page.data.unknown).toBe(true);expect(page.data.bundleSheetOpen).toBe(false);expect(page.data.addressReadOnly).toBe(true);
});
it('offers the confirmed receipt again after navigation fails without dispatching another claim',async()=>{
 await loaded();await page.confirm();page.finishRedemption({detail:{owner,reference:claimId}});page.navigationFailed();expect(page.data).toMatchObject({completedId:claimId,navigating:false,addressReadOnly:true});
 await page.confirm();expect(services.confirmReward).toHaveBeenCalledTimes(1);page.viewCompleted();expect(page.triggerEvent).toHaveBeenLastCalledWith('complete',{owner,id:claimId});
});

it('opens original bundle details without selecting or changing an address, including a sold-out set',async()=>{
 await page.load();page.data.selection.bundles[0].availableQuantity=0;const address=page.data.selectedAddressId;
 await page.previewBundle({currentTarget:{dataset:{code:'moisture'}}});expect(wx.previewImage).toHaveBeenCalledExactlyOnceWith({current:'wxfile://usr/cisme-travel-detail-moisture-v1.jpg',urls:['wxfile://usr/cisme-travel-detail-moisture-v1.jpg','wxfile://usr/cisme-travel-detail-dandruff-v1.jpg']});
 expect(page.data.selectedBundle).toBe('');expect(page.data.draftBundle).toBe('');expect(page.data.selectedAddressId).toBe(address);
 page.chooseBundle({currentTarget:{dataset:{code:'moisture'}}});expect(page.data.draftBundle).toBe('');expect(services.rewardQuote).not.toHaveBeenCalled();
 page.onHide();page.previewBundle({currentTarget:{dataset:{code:'dandruff'}}});expect(wx.previewImage).toHaveBeenCalledTimes(1);
});
it('retains the draft choice and open picker after returning from native details',async()=>{
 await page.load();page.chooseBundle({currentTarget:{dataset:{code:'dandruff'}}});const address=page.data.selectedAddressId;
 page.onHide();page.onShow();await vi.waitFor(()=>expect(page.data.loading).toBe(false));
 expect(page.data.draftBundle).toBe('dandruff');expect(page.data.bundleSheetOpen).toBe(true);expect(page.data.selectedAddressId).toBe(address);expect(page.data.selectedBundle).toBe('');
});
it('does not open a prepared detail after the page has hidden',async()=>{
 await page.load();const callbacks:Array<()=>void>=[];wx.getFileSystemManager=()=>({access:({success}:any)=>callbacks.push(success)});
 const opened=page.previewBundle({currentTarget:{dataset:{code:'moisture'}}});expect(page.data.detailLoading).toBe(true);page.onHide();callbacks.forEach(f=>f());await opened;expect(wx.previewImage).not.toHaveBeenCalled();expect(page.data.detailLoading).toBe(false);
});


it('does not let a cancelled claim read replace the current shipment detail',async()=>{
 await import('../../apps/miniprogram/pages/management-rewards/index');
 Object.assign(page,{alive:true,visible:true,token:app.globalData.sessionToken});
 page.data.manager={permissions:{fulfill:true}};
 const stale=deferred<any>(),current=deferred<any>();
 services.rewardClaim.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
 const old=page.openDetail({currentTarget:{dataset:{id:claimId}}});
 page.closeSheet();
 const fresh=page.openDetail({currentTarget:{dataset:{id:quoteId}}});
 current.resolve({id:quoteId,state:'placed'});await fresh;
 stale.resolve({id:claimId,state:'placed'});await old;
 expect(page.data.detail.id).toBe(quoteId);
});
it('exports subsequent fulfillment batches only after an explicit next action and clears progress with filters',async()=>{
 await import('../../apps/miniprogram/pages/management-rewards/index');page.onLoad({tab:'fulfill'});page.visible=true;page.token='member-A';page.setData({activityId:voucher,manager:{permissions:{fulfill:true}},loading:false});
 wx.base64ToArrayBuffer=()=>new ArrayBuffer(1);wx.getFileSystemManager=()=>({writeFile:({success}:any)=>success(),unlink:vi.fn()});wx.openDocument=({success}:any)=>success();services.rewardManagement.mockResolvedValue({memberId:owner,activities:[{id:voucher}],vouchers:[],claims:[],claimNext:null,voucherNext:null,permissions:{fulfill:true}});
 services.exportRewards.mockResolvedValue({fileBase64:'AA==',count:500,nextCursor:quoteId});
 const first={currentTarget:{dataset:{kind:'pending_dispatch'}}};await page.export(first);expect(services.exportRewards.mock.calls[0]![2]).toBeUndefined();expect(page.data).toMatchObject({exportAfter:quoteId,exportCount:500,exportDone:false});
 await page.export(first);expect(services.exportRewards.mock.calls[1]![2]).toBeUndefined();expect(page.data.exportCount).toBe(500);
 services.exportRewards.mockResolvedValue({fileBase64:'AA==',count:1,nextCursor:null});await page.exportNext();expect(services.exportRewards.mock.calls[2]![2]).toBe(quoteId);expect(page.data).toMatchObject({exportAfter:'',exportCount:501,exportDone:true});
 page.selectDate({currentTarget:{dataset:{field:'from'}},detail:{value:'2026-11-17'}});expect(page.data).toMatchObject({exportKind:'',exportAfter:'',exportCount:0,exportDone:false});
});

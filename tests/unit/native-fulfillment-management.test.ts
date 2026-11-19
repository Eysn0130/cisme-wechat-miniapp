import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({request:vi.fn(),authority:vi.fn(),download:vi.fn(),release:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,downloadPrivateMedia:m.download}));
vi.mock('../../apps/miniprogram/services/authority',()=>({authorityProjection:m.authority,hasCapability:(a:any,c:string)=>a?.capabilities.includes(c)}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',shouldReduceMotion:()=>false}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
let def:any,token:string;
const empty={items:[],totalCount:0,nextCursor:null};
const parcel={carrierCode:'SF',carrierName:'顺丰',trackingNumber:'SF123456',shippedAt:'2026-09-22T10:00:00.000Z'};
const entry=(i:number,state='ready')=>({
  line:i+2,orderId:`id-${i}`,orderNumber:`CMTEST-${i}`,memberNickname:`会员 ${i}`,memberCardNumber:'No. 00004',
  state,expectedOrderVersion:7,parcel
});
const writes=()=>m.request.mock.calls.map(([options])=>options).filter(options=>options.path==='/v1/management/shipments/batch');
const accepted=(options:any)=>({results:options.data.entries.map(({orderId}:any)=>({orderId,status:'accepted',shipment:{wechatSyncState:'prepared'}}))});
beforeEach(()=>{
  vi.resetModules();vi.useFakeTimers();token='synthetic';m.request.mockReset().mockResolvedValue(empty);
  m.authority.mockReset().mockResolvedValue({version:1,managementAvailable:true,capabilities:['commerce.fulfillment.manage']});
  m.release.mockReset();m.download.mockReset().mockReturnValue({promise:Promise.resolve('/tmp/synthetic.xlsx'),abort:m.release});
  (globalThis as any).getApp=()=>({globalData:{sessionToken:token}});(globalThis as any).Page=(p:any)=>def=p;
  (globalThis as any).wx={
    showModal:vi.fn((o:any)=>o.success({confirm:true})),openDocument:vi.fn((o:any)=>o.success()),
    navigateBack:vi.fn(),redirectTo:vi.fn(),pageScrollTo:vi.fn(),
    chooseMessageFile:vi.fn((o:any)=>o.success({tempFiles:[{name:'发货清单.xlsx',path:'/tmp/mock.xlsx',size:130}]})),
    getFileSystemManager:()=>({readFile:(o:any)=>o.success({data:'SYNTHETIC_BASE64'})})
  };
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
async function page(){
  await import('../../apps/miniprogram/pages/management-fulfillment/index');
  return {...def,data:structuredClone(def.data),setData(p:any){Object.assign(this.data,p);}};
}

it('renders canonical nickname and full order number with fulfillment-only authority and appends the next page',async()=>{
  const p=await page();
  const order={id:'1',memberNickname:'合成会员',memberCardNumber:'No. 00004',orderNumber:'CMTESTFULL20261118',
    paidAt:'2026-11-17T23:10:00.000Z',items:'净润小紫瓶 × 1',logisticsState:'awaiting_dispatch'};
  m.request.mockResolvedValueOnce({items:[order],totalCount:29,nextCursor:'cursor'});
  await p.onShow();
  expect(p.data.coreReady).toBe(true);expect(p.data.canOrders).toBe(false);
  expect(p.data.items[0]).toMatchObject({memberLabel:'合成会员',orderNumber:'CMTESTFULL20261118',dateLabel:'2026/11/18 07:10'});
  m.request.mockResolvedValueOnce({items:[{...order,id:'2'}],totalCount:28,nextCursor:null});
  await p.load(true);
  expect(p.data.items.map((card:any)=>card.id)).toEqual(['1','2']);expect(p.data.totalCount).toBe(29);
});

it('clears paste text and suppresses a late order response when hidden',async()=>{
  const p=await page();let done!:(x:any)=>void;
  m.request.mockImplementationOnce(()=>new Promise(r=>done=r));
  const load=p.onShow();await Promise.resolve();
  p.data.pasteRows='private draft';p.onHide();done({items:[{id:'old'}],nextCursor:null});await load;
  expect(p.data.items).toEqual([]);expect(p.data.pasteRows).toBe('');expect(p.data.coreReady).toBe(false);
});

it('previews file without writes and confirms only eligible rows with the verified version',async()=>{
  const p=await page();await p.onShow();
  const invalid={...entry(1,'issue'),code:'SHIPMENT_TIME_INVALID'};
  m.request.mockResolvedValueOnce({entries:[entry(0),invalid,entry(2,'registered')],skippedRows:1});
  await p.chooseXlsx();
  expect(p.data).toMatchObject({view:'review',fileName:'发货清单.xlsx',readyCount:1,registeredCount:1,issueCount:1,skippedRows:1});
  expect(m.request).toHaveBeenCalledWith(expect.objectContaining({data:{filename:'发货清单.xlsx',contentBase64:'SYNTHETIC_BASE64',review:true}}));
  expect(writes()).toEqual([]);
  (globalThis as any).wx.showModal.mockImplementationOnce((o:any)=>o.success({confirm:false}));
  await p.submit();expect(writes()).toEqual([]);
  m.request.mockImplementationOnce(async o=>accepted(o));
  await p.submit();expect(writes()).toHaveLength(1);
  expect(writes()[0].data.entries).toEqual([{orderId:'id-0',...parcel,expectedOrderVersion:7,evidenceReference:expect.stringContaining('batch:shipment-')}]);
  expect(p.data).toMatchObject({view:'results',registeredCount:2,issueCount:1,pendingCount:0,retryBatch:false});
  expect(p.data.entries[0].syncLabel).toBe('等待微信同步');
});

it('uses the original payload and key for the uncertain chunk and blocks double submission',async()=>{
  const p=await page();await p.onShow();
  p.showReview({entries:[entry(0)],skippedRows:0},'清单.xlsx');
  let reject!:(e:any)=>void;
  m.request.mockImplementationOnce(()=>new Promise((_,fail)=>reject=fail));
  const first=p.submit();await p.submit();reject({status:504});await first;
  expect(p.data).toMatchObject({view:'results',retryBatch:true,pendingCount:1});
  const [original]=writes();
  p.newBatch();expect(p.data.view).toBe('results');
  m.request.mockImplementationOnce(async o=>accepted(o));await p.sendBatch();
  expect(writes()[1]).toEqual(original);expect(p.data.retryBatch).toBe(false);
});

it('pauses between actual chunks in background and preserves results when the same account returns',async()=>{
  const p=await page();await p.onShow();
  p.showReview({entries:Array.from({length:21},(_,i)=>entry(i)),skippedRows:0},'清单.xlsx');
  let confirm!:(o:any)=>void,options:any;
  m.request.mockImplementationOnce(o=>{options=o;return new Promise(r=>confirm=r);});
  const sending=p.submit();await Promise.resolve();p.onHide();confirm(accepted(options));await sending;
  expect(writes()).toHaveLength(1);expect(p.data.entries).toEqual([]);
  await p.onShow();
  expect(p.data).toMatchObject({view:'results',registeredCount:10,pendingCount:11,retryBatch:true});
  expect(p.data.entries.at(-1).label).toBe('未提交');
  m.request.mockImplementation(async o=>accepted(o));await p.sendBatch();
  expect(writes().map(o=>o.data.entries.length)).toEqual([10,10,1]);
  expect(new Set(writes().map(o=>o.idempotencyKey)).size).toBe(3);
  expect(p.data).toMatchObject({registeredCount:21,pendingCount:0,retryBatch:false,sentCount:21});
});

it('recovers a lost reply from server shipment facts, including both WeChat states, without another dispatch',async()=>{
  const p=await page();await p.onShow();p.showReview({entries:[entry(0),entry(1)],skippedRows:0},'清单.xlsx');
  m.request.mockRejectedValueOnce({status:504});await p.submit();
  m.request.mockResolvedValueOnce({entries:[0,1].map(i=>({...entry(i,'registered'),wechatSyncState:'synced',logisticsMessageState:'registered'})),skippedRows:0});
  await p.reconcileBatch();
  expect(writes()).toHaveLength(1);expect(p.data.retryBatch).toBe(false);
  expect(p.data.entries[0]).toMatchObject({line:2,label:'已登记',syncLabel:'微信已同步',messageLabel:'物流消息已登记'});
});

it('handles partial results and uses a corrected file to review rejected rows again',async()=>{
  const p=await page();await p.onShow();p.showReview({entries:[entry(0),entry(1)],skippedRows:0},'清单.xlsx');
  m.request.mockResolvedValueOnce({results:[{orderId:'id-0',status:'accepted'},{orderId:'id-1',status:'rejected',code:'VERSION_CONFLICT'}]});
  await p.submit();
  expect(p.data).toMatchObject({registeredCount:1,issueCount:1,retryBatch:false});
  expect(p.data.entries[1].note).toContain('订单已变更');
  p.newBatch();expect(p.data.view).toBe('list');expect(p.data.entries).toEqual([]);
});

it('blocks opening an exported recipient file if authorization was revoked and releases the private download',async()=>{
  const p=await page();m.request.mockResolvedValueOnce({...empty,totalCount:2});await p.onShow();
  m.authority.mockResolvedValueOnce({version:1,managementAvailable:false,capabilities:[]});await p.exportExcel();
  expect((globalThis as any).wx.openDocument).not.toHaveBeenCalled();expect(m.release).toHaveBeenCalled();
  expect(p.data.coreReady).toBe(false);
});

it('clears all staged content and keys when the operator identity changes',async()=>{
  const p=await page();await p.onShow();p.showReview({entries:[entry(0)],skippedRows:0},'清单.xlsx');
  m.request.mockRejectedValueOnce({status:504});await p.submit();
  token='changed';await p.recheck();
  expect(p.batch).toBeNull();expect(p.entries).toEqual([]);
  expect(p.data).toMatchObject({coreReady:false,entries:[],fileName:''});
});

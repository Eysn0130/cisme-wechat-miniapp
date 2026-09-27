import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const m=vi.hoisted(()=>({read:vi.fn(),write:vi.fn(),token:'member-a'}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:m.read,cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.write,requireMemberAccess:()=>true,
 historicalCommerceToken:()=>m.token,historicalCommerceClosed:()=>false,requireHistoricalCommerceAccess:()=>Boolean(m.token)}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
let definition:any;
const orderId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const lineId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const record={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',orderId,state:'requested',kind:'return_refund',reason:'',claimBasis:'no_reason',requestedAt:'2026-09-23T10:00:00Z',supportConversationId:null,returnDestination:null,refund:null,resolved:false};
const messages={messages:[],latestCursor:0,conversation:null};
const availability={lines:[{lineId,remainingQuantity:2}]};
const reply=(input:{path:string},items:any[]=[record])=>input.path.includes('/aftersales/availability')?availability:
  input.path.includes('/aftersales?')?{items}:messages;
function deferred(){let resolve!:(value:any)=>void;const promise=new Promise<any>(yes=>resolve=yes);return{resolve,promise};}
async function page(){
 await import('../../apps/miniprogram/pages/order-detail/index');
 const p={...definition,data:structuredClone(definition.data),setData(values:any){Object.assign(this.data,values);}};
 p.lastSessionToken=m.token;p.lastSessionRevision=0;
 Object.assign(p.data,{id:orderId,visible:true,pageAlive:true,coreReady:true,supportSheetOpen:true,
   order:{id:orderId,lines:[{id:lineId,productName:'合成商品',skuLabel:'合成规格'}]}});
 return p;
}
beforeEach(()=>{
 vi.resetModules();vi.useFakeTimers();m.token='member-a';m.read.mockReset();m.write.mockReset();
 m.read.mockImplementation((_page:any,input:any)=>Promise.resolve(reply(input)));
 (globalThis as any).Page=(value:any)=>definition=value;
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token}});
 (globalThis as any).wx={setClipboardData:vi.fn(),navigateTo:vi.fn(),showModal:vi.fn(),getStorageSync:vi.fn()};
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('order support sheet owns reads and reflects current cases',()=>{
 it('updates the case while polling instead of deriving progress from chat text',async()=>{
  const p=await page();await p.loadSupportSheet();
  expect(p.data.sheetCaseShortId).toBe(record.id.slice(-6));
  m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(reply(input,[{...record,state:'awaiting_instruction'}])));
  await p.pollSupportSheet();expect(p.data.sheetCase.state).toBe('awaiting_instruction');expect(p.data.sheetCaseLabel).toBe('客服正在准备退货信息');
 });
 it.each(['cancelled','rejected'])('does not let an old %s case block a new request',async state=>{
  const p=await page();m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(reply(input,[{...record,state}])));
  await p.loadSupportSheet();expect(p.data.sheetCase).toBeNull();expect(p.data.sheetPreviousCase.state).toBe(state);expect(p.data.sheetCasesReady).toBe(true);
 });
 it('ignores a read from the previous open after close and reopen on the same page',async()=>{
  const p=await page(),old=deferred();m.read.mockImplementationOnce(()=>old.promise);
  const first=p.loadSupportSheet();p.closeSupportSheet();p.data.supportSheetOpen=true;
  m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(reply(input,[{...record,state:'refund_pending'}])));
  await p.loadSupportSheet();old.resolve({items:[record]});await first;
  expect(p.data.sheetCase.state).toBe('refund_pending');expect(p.data.sheetCaseLabel).toBe('退款处理中');
 });
 it('ignores a slow poll after a newer explicit refresh',async()=>{
  const p=await page();await p.loadSupportSheet();const old=deferred();
  m.read.mockImplementationOnce(()=>old.promise);const poll=p.pollSupportSheet();
  m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(reply(input,[{...record,resolved:true,state:'refund_pending'}])));
  await p.loadSupportSheet();old.resolve({...messages,latestCursor:100});await poll;
  expect(p.data.sheetCase).toBeNull();expect(p.data.sheetPreviousCase.resolved).toBe(true);expect(p.sheetCursor).toBe(0);
 });
 it('does not submit until the current order cases have been read',async()=>{
  const p=await page();p.data.sheetBasisIndex=1;p.data.sheetReason='';
  m.read.mockImplementation((_p:any,input:any)=>input.path.includes('/aftersales?')?Promise.reject(new Error('offline')):Promise.resolve(reply(input)));
  await p.loadSupportSheet();await p.submitSheetAftersale();expect(m.write).not.toHaveBeenCalled();expect(p.data.sheetCasesReady).toBe(false);
 });
 it('keeps a local validation error through polling, then reads back exactly one submitted case',async()=>{
  let created=false;
  m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(reply(input,created?[record]:[])));
  m.write.mockImplementation(async()=>{created=true;return record;});
  const p=await page();await p.loadSupportSheet();
  await p.submitSheetAftersale();
  expect(p.data.sheetError).toBe('请选择售后问题类型。');
  expect(m.write).not.toHaveBeenCalled();
  await p.pollSupportSheet();
  expect(p.data.sheetError).toBe('请选择售后问题类型。');
  p.chooseSheetBasis({detail:{value:'1'}});
  expect(p.data.sheetError).toBe('');
  await p.submitSheetAftersale();
  expect(m.write).toHaveBeenCalledTimes(1);
  expect(p.data.sheetCase.id).toBe(record.id);
  expect(p.data.sheetError).toBe('');
  await p.pollSupportSheet();
  expect(p.data.sheetCase.id).toBe(record.id);
  await p.submitSheetAftersale();
  expect(m.write).toHaveBeenCalledTimes(1);
 });
 it('still accepts an application when only chat is offline',async()=>{
  const p=await page();m.read.mockImplementation((_p:any,input:any)=>input.path.includes('/aftersales/availability')?Promise.resolve(availability):
    input.path.includes('/aftersales?')?Promise.resolve({items:[]}):Promise.reject(new Error('offline')));
  await p.loadSupportSheet();expect(p.data.sheetCasesReady).toBe(true);expect(p.data.sheetCase).toBeNull();
  p.data.sheetBasisIndex=1;m.write.mockResolvedValue(record);await p.submitSheetAftersale();expect(m.write).toHaveBeenCalledTimes(1);
  expect(m.write.mock.calls[0]![0].data.lines).toEqual([{lineId,quantity:2}]);
 });
 it('lets the buyer choose one remaining unit and blocks a fully refunded order',async()=>{
  const p=await page();m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(reply(input,[])));
  await p.loadSupportSheet();p.chooseSheetQuantity({currentTarget:{dataset:{id:lineId,delta:-1}}});
  expect(p.data.sheetAvailable[0].selectedQuantity).toBe(1);
  p.data.sheetBasisIndex=1;m.write.mockResolvedValue(record);await p.submitSheetAftersale();
  expect(m.write.mock.calls[0]![0].data.lines).toEqual([{lineId,quantity:1}]);
  m.write.mockClear();p.data.sheetCase=null;p.data.sheetAttempt=null;
  m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(input.path.includes('/aftersales/availability')?
    {lines:[{lineId,remainingQuantity:0}]}:reply(input,[])));
  await p.loadSupportSheet();expect(p.data.sheetHasRemaining).toBe(false);
  await p.submitSheetAftersale();expect(m.write).not.toHaveBeenCalled();
 });
 it('can close without cancelling a pending write or losing its idempotency key',async()=>{
  const p=await page();p.data.sheetSubmitting=true;p.data.sheetSending=true;
  p.data.sheetAttempt={key:'original-request',payload:{kind:'return_refund'}};p.data.sheetSendAttempt={key:'original-message',body:'hello'};
  p.closeSupportSheet();expect(p.data.supportSheetOpen).toBe(false);expect(p.data.sheetAttempt.key).toBe('original-request');expect(p.data.sheetSendAttempt.key).toBe('original-message');
 });
 it('unlocks a clearly rejected shipped refund draft for edit and a new request',async()=>{
  const p=await page(),pending=deferred();m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(reply(input,[])));
  await p.loadSupportSheet();p.data.sheetKindIndex=0;p.data.sheetBasisIndex=2;p.data.sheetReason='商品破损';
  m.write.mockImplementationOnce(()=>pending.promise).mockResolvedValueOnce(record);
  const first=p.submitSheetAftersale();
  await p.submitSheetAftersale();expect(m.write).toHaveBeenCalledTimes(1);
  pending.resolve(Promise.reject({status:409,code:'AFTERSALE_RETURN_REQUIRED'}));await first;
  expect(p.data.sheetAttempt).toBeNull();expect(p.data.sheetReason).toBe('商品破损');
  expect(p.data.sheetError).toContain('退货退款');
  await vi.advanceTimersByTimeAsync(5000);
  expect(p.data.sheetError).toContain('退货退款');
  p.closeSupportSheet();p.data.supportSheetOpen=true;await p.loadSupportSheet();
  p.chooseSheetKind({detail:{value:'1'}});p.editSheetReason({detail:{value:'商品外包装破损'}});
  expect(p.data.sheetKindIndex).toBe(1);expect(p.data.sheetReason).toBe('商品外包装破损');
  await p.submitSheetAftersale();expect(m.write).toHaveBeenCalledTimes(2);
  expect(m.write.mock.calls[0]![0].idempotencyKey).not.toBe(m.write.mock.calls[1]![0].idempotencyKey);
  expect(m.write.mock.calls[1]![0].data.kind).toBe('return_refund');
 });
 it('keeps the original request key and payload when the write outcome is unknown',async()=>{
  const p=await page();m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(reply(input,[])));
  await p.loadSupportSheet();p.data.sheetBasisIndex=2;p.data.sheetReason='商品破损';
  m.write.mockRejectedValueOnce({status:503,code:'TRANSACTION_OUTCOME_UNKNOWN'}).mockResolvedValueOnce(record);
  await p.submitSheetAftersale();const original=m.write.mock.calls[0]![0];
  expect(p.data.sheetAttempt.key).toBe(original.idempotencyKey);
  p.chooseSheetKind({detail:{value:'1'}});p.editSheetReason({detail:{value:'不同内容'}});
  expect(p.data.sheetKindIndex).toBe(1);expect(p.data.sheetReason).toBe('商品破损');
  await p.submitSheetAftersale();
  expect(m.write.mock.calls[1]![0].idempotencyKey).toBe(original.idempotencyKey);
  expect(m.write.mock.calls[1]![0].data).toEqual(original.data);
 });
 it('clears inherited busy flags and private drafts on account change',async()=>{
  const p=await page();p.data.sheetSubmitting=true;p.data.sheetSending=true;p.data.sheetReason='private';m.token='member-b';p.syncSession();
  expect(p.data.sheetSubmitting).toBe(false);expect(p.data.sheetSending).toBe(false);expect(p.data.sheetReason).toBe('');expect(p.data.sheetCase).toBeNull();
 });
 it('copies the selected case snapshot, never a different order chat card',async()=>{
  const p=await page();p.data.sheetCasesReady=true;p.data.sheetCase={...record,state:'awaiting_return',returnDestination:{recipientName:'合成收件人',phone:'13800000000',region:'上海市',address:'本单合成地址',version:2}};
  p.data.sheetMessages=[{returnInstruction:{caseId:'other-case',address:'其他订单地址'}}];p.copySheetReturnInstruction();
  expect((globalThis as any).wx.setClipboardData).toHaveBeenCalledWith({data:expect.stringContaining('本单合成地址')});
  expect((globalThis as any).wx.setClipboardData.mock.calls[0][0].data).not.toContain('其他订单地址');
 });
 it('does not copy a return address while cases are unverified',async()=>{
  const p=await page();p.data.sheetCase={...record,state:'awaiting_return',returnDestination:{address:'private'}};
  p.copySheetReturnInstruction();expect((globalThis as any).wx.setClipboardData).not.toHaveBeenCalled();
 });
 it('resumes polling when navigation fails',async()=>{
  const p=await page();(globalThis as any).wx.navigateTo=vi.fn((input:any)=>input.fail());p.openFullAftersale();
  expect(p.data.navigating).toBe(false);expect(p.sheetTimer).not.toBeNull();
 });
 it('opens the existing full conversation for a verified closed-account order',async()=>{
  const p=await page();p.data.closedRights=true;p.data.sheetInput='请核对本单';
  const navigate=vi.fn();(globalThis as any).wx.navigateTo=navigate;
  p.expandSupport();
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({url:`/pages/support/index?orderId=${orderId}`}));
 });
 it('ignores keyboard events after the popup is closed',async()=>{
  const p=await page();p.closeSupportSheet();p.onSheetKeyboardHeightChange({detail:{height:300}});expect(p.data.sheetKeyboardHeight).toBe(0);
 });
 it('keeps the last receipt observation and permits retry after an interrupted query fails',async()=>{
  const p=await page(),old=deferred();
  const shipmentId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  p.data.order={...p.data.order,status:'paid',transactionSourceKind:'verified_commerce'};
  p.data.shipment={id:shipmentId,wechatReceipt:{status:'shipped',observedAt:'2026-09-27T01:00:00Z',label:'微信显示已发货'}};
  p.loadShipment=vi.fn();
  m.write.mockImplementationOnce(()=>old.promise).mockRejectedValueOnce(new Error('offline'));
  const first=p.queryWechatReceipt(false);
  expect(p.data.receiptQueryLoading).toBe(true);
  p.onHide();p.data.visible=true;
  await p.queryWechatReceipt(false);
  expect(p.data.receiptQueryLoading).toBe(false);
  expect(p.data.receiptQueryError).toContain('重试');
  expect(p.data.shipment.wechatReceipt.observedAt).toBe('2026-09-27T01:00:00Z');
  old.resolve({orderId,shipmentId,status:'confirmed',label:'微信已记录确认收货'});
  await first;
  expect(p.data.receiptQueryError).toContain('重试');
  expect(p.data.shipment.wechatReceipt.status).toBe('shipped');
 });
 it('releases a pending receipt query on order reload and ignores its late answer',async()=>{
  const p=await page(),old=deferred(),shipmentId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  p.data.order={...p.data.order,version:1,status:'paid',transactionSourceKind:'verified_commerce'};
  p.data.shipment={id:shipmentId,wechatReceipt:{status:'shipped',label:'微信显示已发货'}};
  p.loadRuntime=vi.fn();p.loadShipment=vi.fn();p.loadRefunds=vi.fn();p.loadRecovery=vi.fn();
  p.refreshRecordedCommands=vi.fn();p.applyRuntime=vi.fn();p.normalize=(row:any)=>row;
  m.read.mockResolvedValue(p.data.order);
  m.write.mockImplementationOnce(()=>old.promise).mockResolvedValueOnce({orderId,shipmentId,
    status:'confirmed',label:'微信已记录确认收货',canOpenComponent:false});
  const first=p.queryWechatReceipt(false);
  expect(p.data.receiptQueryLoading).toBe(true);
  await p.load();
  expect(p.data.receiptQueryLoading).toBe(false);
  expect(p.data.coreReady).toBe(true);
  old.resolve({orderId,shipmentId,status:'refunded',label:'微信显示已退款'});
  await first;
  expect(p.data.shipment.wechatReceipt.status).toBe('shipped');
  await p.queryWechatReceipt(false);
  expect(m.write).toHaveBeenCalledTimes(2);
  expect(p.data.actionStatus).toBe('微信已记录确认收货');
 });
 it('never opens the real WeChat component for a synthetic order',async()=>{
  const p=await page(),shipmentId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  p.data.order={...p.data.order,status:'paid',transactionSourceKind:'verified_commerce'};
  p.data.shipment={id:shipmentId};
  p.data.runtimeMode='test';p.loadShipment=vi.fn();
  m.write.mockResolvedValue({orderId,shipmentId,status:'shipped',label:'微信显示已发货',
    canOpenComponent:true,component:{transactionId:'synthetic-transaction'}});
  (globalThis as any).wx.openBusinessView=vi.fn();
  await p.queryWechatReceipt(true);
  expect(m.write).toHaveBeenCalledTimes(1);
  expect((globalThis as any).wx.openBusinessView).not.toHaveBeenCalled();
  expect(p.data.actionStatus).toContain('不会打开真实微信');
 });
 it('checks a successful component return again without reopening it, and stops after confirmation',async()=>{
  const p=await page(),shipmentId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  p.data.order={...p.data.order,status:'paid',transactionSourceKind:'verified_commerce'};
  p.data.shipment={id:shipmentId};p.loadShipment=vi.fn();
  m.write.mockResolvedValueOnce({orderId,shipmentId,status:'shipped',label:'微信显示已发货',canOpenComponent:true})
    .mockResolvedValueOnce({orderId,shipmentId,status:'confirmed',label:'微信已记录确认收货',canOpenComponent:false});
  (globalThis as any).wx.openBusinessView=vi.fn();
  await p.queryWechatReceipt(false,'success');
  expect(p.data.actionStatus).toContain('正在更新收货状态');
  await vi.advanceTimersByTimeAsync(2000);
  expect(m.write).toHaveBeenCalledTimes(2);
  expect(p.data.actionStatus).toBe('微信已记录确认收货');
  expect((globalThis as any).wx.openBusinessView).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10000);expect(m.write).toHaveBeenCalledTimes(2);
 });
 it('abandons delayed receipt reads after leaving the order',async()=>{
  const p=await page(),shipmentId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  p.data.order={...p.data.order,status:'paid',transactionSourceKind:'verified_commerce'};
  p.data.shipment={id:shipmentId};p.loadShipment=vi.fn();
  m.write.mockResolvedValue({orderId,shipmentId,status:'shipped',label:'微信显示已发货',canOpenComponent:true});
  await p.queryWechatReceipt(false,'success');p.onHide();
  await vi.advanceTimersByTimeAsync(10000);
  expect(m.write).toHaveBeenCalledTimes(1);
 });
 it('uses native enter/leave, keyboard-aware height, one composer, and current-case addresses in WXML',()=>{
  const wxml=readFileSync('apps/miniprogram/pages/order-detail/index.wxml','utf8');
  expect(wxml).toContain('<page-container');expect(wxml).toContain('show="{{supportSheetOpen}}"');
  expect(wxml).toContain('bindbeforeleave="onSupportSheetLeave"');expect(wxml).toContain('overlay-style="background:rgba(30,20,36,.48)"');expect(wxml).toContain('custom-style="height:{{sheetHeight}};');
  expect(wxml).toContain('bottom:{{sheetKeyboardHeight}}px');expect(wxml).toContain('height:calc(100% - {{sheetKeyboardHeight}}px);transform:translateY({{sheetKeyboardHeight}}px)');
  expect(wxml).toContain('!sheetCase && !sheetConsulting');expect(wxml).toContain('sheetCase || sheetConsulting');
  expect(wxml).toContain('sheetCase.returnDestination.address');expect(wxml).not.toContain('{{item.returnInstruction.address}}');
 });
});

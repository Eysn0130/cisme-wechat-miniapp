import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const m=vi.hoisted(()=>({read:vi.fn(),write:vi.fn(),token:'member-a'}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:m.read,cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.write,requireMemberAccess:()=>true}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
let definition:any;
const orderId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const record={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',orderId,state:'requested',kind:'return_refund',reason:'',claimBasis:'no_reason',requestedAt:'2026-09-23T10:00:00Z',supportConversationId:null,returnDestination:null,refund:null,resolved:false};
const messages={messages:[],latestCursor:0,conversation:null};
function deferred(){let resolve!:(value:any)=>void;const promise=new Promise<any>(yes=>resolve=yes);return{resolve,promise};}
async function page(){
 await import('../../apps/miniprogram/pages/order-detail/index');
 const p={...definition,data:structuredClone(definition.data),setData(values:any){Object.assign(this.data,values);}};
 p.lastSessionToken=m.token;p.lastSessionRevision=0;
 Object.assign(p.data,{id:orderId,visible:true,pageAlive:true,coreReady:true,supportSheetOpen:true,order:{id:orderId}});
 return p;
}
beforeEach(()=>{
 vi.resetModules();vi.useFakeTimers();m.token='member-a';m.read.mockReset();m.write.mockReset();
 m.read.mockImplementation((_page:any,input:any)=>Promise.resolve(input.path.includes('/aftersales?')?{items:[record]}:messages));
 (globalThis as any).Page=(value:any)=>definition=value;
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token}});
 (globalThis as any).wx={setClipboardData:vi.fn(),navigateTo:vi.fn(),showModal:vi.fn(),getStorageSync:vi.fn()};
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('order support sheet owns reads and reflects current cases',()=>{
 it('updates the case while polling instead of deriving progress from chat text',async()=>{
  const p=await page();await p.loadSupportSheet();
  m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(input.path.includes('/aftersales?')?{items:[{...record,state:'awaiting_instruction'}]}:messages));
  await p.pollSupportSheet();expect(p.data.sheetCase.state).toBe('awaiting_instruction');expect(p.data.sheetCaseLabel).toBe('客服正在准备退货信息');
 });
 it.each(['cancelled','rejected'])('does not let an old %s case block a new request',async state=>{
  const p=await page();m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(input.path.includes('/aftersales?')?{items:[{...record,state}]}:messages));
  await p.loadSupportSheet();expect(p.data.sheetCase).toBeNull();expect(p.data.sheetPreviousCase.state).toBe(state);expect(p.data.sheetCasesReady).toBe(true);
 });
 it('ignores a read from the previous open after close and reopen on the same page',async()=>{
  const p=await page(),old=deferred();m.read.mockImplementationOnce(()=>old.promise);
  const first=p.loadSupportSheet();p.closeSupportSheet();p.data.supportSheetOpen=true;
  m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(input.path.includes('/aftersales?')?{items:[{...record,state:'refund_pending'}]}:messages));
  await p.loadSupportSheet();old.resolve({items:[record]});await first;
  expect(p.data.sheetCase.state).toBe('refund_pending');expect(p.data.sheetCaseLabel).toBe('退款处理中');
 });
 it('ignores a slow poll after a newer explicit refresh',async()=>{
  const p=await page();await p.loadSupportSheet();const old=deferred();
  m.read.mockImplementationOnce(()=>old.promise);const poll=p.pollSupportSheet();
  m.read.mockImplementation((_p:any,input:any)=>Promise.resolve(input.path.includes('/aftersales?')?{items:[{...record,resolved:true,state:'refund_pending'}]}:messages));
  await p.loadSupportSheet();old.resolve({...messages,latestCursor:100});await poll;
  expect(p.data.sheetCaseLabel).toBe('已退款');expect(p.sheetCursor).toBe(0);
 });
 it('does not submit until the current order cases have been read',async()=>{
  const p=await page();p.data.sheetBasisIndex=1;p.data.sheetReason='';
  m.read.mockImplementation((_p:any,input:any)=>input.path.includes('/aftersales?')?Promise.reject(new Error('offline')):Promise.resolve(messages));
  await p.loadSupportSheet();await p.submitSheetAftersale();expect(m.write).not.toHaveBeenCalled();expect(p.data.sheetCasesReady).toBe(false);
 });
 it('still accepts an application when only chat is offline',async()=>{
  const p=await page();m.read.mockImplementation((_p:any,input:any)=>input.path.includes('/aftersales?')?Promise.resolve({items:[]}):Promise.reject(new Error('offline')));
  await p.loadSupportSheet();expect(p.data.sheetCasesReady).toBe(true);expect(p.data.sheetCase).toBeNull();
  p.data.sheetBasisIndex=1;m.write.mockResolvedValue(record);await p.submitSheetAftersale();expect(m.write).toHaveBeenCalledTimes(1);
 });
 it('can close without cancelling a pending write or losing its idempotency key',async()=>{
  const p=await page();p.data.sheetSubmitting=true;p.data.sheetSending=true;
  p.data.sheetAttempt={key:'original-request',payload:{kind:'return_refund'}};p.data.sheetSendAttempt={key:'original-message',body:'hello'};
  p.closeSupportSheet();expect(p.data.supportSheetOpen).toBe(false);expect(p.data.sheetAttempt.key).toBe('original-request');expect(p.data.sheetSendAttempt.key).toBe('original-message');
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
 it('ignores keyboard events after the popup is closed',async()=>{
  const p=await page();p.closeSupportSheet();p.onSheetKeyboardHeightChange({detail:{height:300}});expect(p.data.sheetKeyboardHeight).toBe(0);
 });
 it('uses native enter/leave, keyboard-aware height, one composer, and current-case addresses in WXML',()=>{
  const wxml=readFileSync('apps/miniprogram/pages/order-detail/index.wxml','utf8');
  expect(wxml).toContain('<page-container');expect(wxml).toContain('show="{{supportSheetOpen}}"');
  expect(wxml).toContain('bindbeforeleave="onSupportSheetLeave"');expect(wxml).toContain('max-height:calc(100vh - {{sheetKeyboardHeight}}px - 100rpx)');
  expect(wxml).toContain('!sheetCase && !sheetConsulting');expect(wxml).toContain('sheetCase || sheetConsulting');
  expect(wxml).toContain('sheetCase.returnDestination.address');expect(wxml).not.toContain('{{item.returnInstruction.address}}');
 });
});

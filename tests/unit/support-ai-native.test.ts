import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({token:'synthetic-member',request:vi.fn(),read:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,requireMemberAccess:()=>true,retainMemberSnapshot:()=>true,
 historicalCommerceToken:()=>m.token,historicalCommerceClosed:()=>false,requireHistoricalCommerceAccess:()=>true,
 downloadPrivateMedia:vi.fn(),uploadAuthorized:vi.fn()}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:m.read,cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
let definition:any,p:any;
const conversation={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'ai_active',version:3,memberReadSequence:0,teamReadSequence:0};
const message=(senderType:string,sequence:number)=>({id:`synthetic-${senderType}-${sequence}`,sequence,senderType,body:senderType==='user'?'护理如何保存？':'完成四步后填写感受并保存。',contentType:'text',createdAt:'2026-10-30T00:00:00Z',attachments:[],orderCard:null,deliveryState:'server_accepted'});
function deferred(){let resolve!:(v:any)=>void;const promise=new Promise<any>(yes=>{resolve=yes;});return {promise,resolve};}
beforeEach(async()=>{
 vi.resetModules();vi.useFakeTimers();m.token='synthetic-member';m.request.mockReset();m.read.mockReset();
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token}});
 (globalThis as any).Page=(value:any)=>{definition=value;};
 (globalThis as any).wx={showModal:vi.fn().mockResolvedValue({confirm:true}),nextTick:(fn:()=>void)=>fn(),showToast:vi.fn(),navigateTo:vi.fn(),getStorageSync:vi.fn()};
 await import('../../apps/miniprogram/pages/support/index');
 p={...definition,data:structuredClone(definition.data),setData(update:any){Object.assign(this.data,structuredClone(update));}};
 Object.assign(p.data,{pageAlive:true,visible:true,loading:false,input:'护理如何保存？',composerSendEnabled:true,conversation});
 m.request.mockResolvedValue({});m.read.mockResolvedValue({conversation,messages:[],latestCursor:0,supportAiAvailable:true});
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('native AI support receipts and explicit switching',()=>{
 it('adds the persisted AI answer immediately while preserving the synchronization cursor for server polling',async()=>{
  m.request.mockImplementation(async(input:any)=>input.path==='/v1/me/support/messages'?{conversation,message:message('user',1),aiMessages:[message('ai',2)],aiStatus:'replied'}:{});
  await p.send();expect(p.data.messages.map((row:any)=>row.senderType)).toEqual(['user','ai']);expect(p.data.syncCursor).toBe(0);
  expect(p.data.input).toBe('');expect(p.data.sendAttempt).toBeNull();expect(p.data.pendingMessage).toBeNull();
 });
 it('acknowledges a saved member message despite pending AI and keeps a real handoff recovery',async()=>{
  m.request.mockImplementation(async(input:any)=>input.path==='/v1/me/support/messages'?{conversation,message:message('user',1),aiStatus:'pending',aiMessages:[]}:input.path==='/v1/me/support/handoff'?{...conversation,status:'waiting_human',version:4}:{});
  await p.send();expect(p.data.messages).toHaveLength(1);expect(p.data.pendingMessage).toBeNull();expect(p.data.error).toContain('消息已收到');expect(p.data.errorAction).toBe('handoff');
  await p.retryHandoff();await Promise.resolve();expect(m.request).toHaveBeenCalledWith(expect.objectContaining({path:'/v1/me/support/handoff',method:'POST'}));
 });
 it('switches a waiting conversation only after explicit confirmation with its current version',async()=>{
  p.data.conversation={...conversation,status:'waiting_human',version:7};p.data.supportAiAvailable=true;
  m.request.mockImplementation(async(input:any)=>input.path==='/v1/me/support/resume-ai'?conversation:{});
  await p.resumeAi();expect(wx.showModal).toHaveBeenCalledOnce();expect(m.request).toHaveBeenCalledWith(expect.objectContaining({path:'/v1/me/support/resume-ai',method:'POST',data:{expectedVersion:7}}));
 });
 it('cannot switch a conversation that is already handled by a person',async()=>{
  p.data.conversation={...conversation,status:'human_active'};p.data.supportAiAvailable=true;await p.resumeAi();
  expect(wx.showModal).not.toHaveBeenCalled();expect(m.request).not.toHaveBeenCalled();
 });
 it.each(['account','hidden','version'])('does not switch after %s changes while confirmation is open',async(change)=>{
  p.data.conversation={...conversation,status:'waiting_human'};p.data.supportAiAvailable=true;
  const modal=deferred();(wx.showModal as any).mockReturnValueOnce(modal.promise);const pending=p.resumeAi();
  if(change==='account')m.token='synthetic-other';else if(change==='hidden'){p.data.visible=false;p.lifecycleEpoch++;}else p.data.conversation.version++;
  modal.resolve({confirm:true});await pending;expect(m.request).not.toHaveBeenCalled();
 });
});

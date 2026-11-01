import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({token:'synthetic-member',request:vi.fn(),read:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,requireMemberAccess:()=>true,retainMemberSnapshot:()=>true,
 historicalCommerceToken:()=>m.token,historicalCommerceClosed:()=>false,requireHistoricalCommerceAccess:()=>true,downloadPrivateMedia:vi.fn(),uploadAuthorized:vi.fn()}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:m.read,cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
let p:any;
const conversation={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'ai_active',version:3,memberReadSequence:0,teamReadSequence:0};
const msg=(sequence:number,senderType='user')=>({id:`synthetic-${sequence}`,sequence,senderType,body:'synthetic conversation',contentType:'text',createdAt:'2026-10-31T00:00:00Z',attachments:[],orderCard:null,deliveryState:'server_accepted'});
const page=(extra:any={})=>({conversation:{...conversation,version:4},contextStartSequence:2,contextVersion:4,newTopicAvailable:true,supportAiAvailable:true,messages:[],latestCursor:2,olderCursor:null,...extra});
function deferred(){let resolve!:(v:any)=>void,reject!:(v:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
beforeEach(async()=>{
 vi.resetModules();vi.useFakeTimers();m.token='synthetic-member';m.request.mockReset();m.read.mockReset();
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token}});
 let definition:any;(globalThis as any).Page=(value:any)=>{definition=value;};
 (globalThis as any).wx={showModal:vi.fn().mockResolvedValue({confirm:true}),nextTick:(fn:()=>void)=>fn(),showToast:vi.fn(),navigateTo:vi.fn(),getStorageSync:vi.fn()};
 await import('../../apps/miniprogram/pages/support/index');
 p={...definition,data:structuredClone(definition.data),setData(update:any){Object.assign(this.data,structuredClone(update));}};
 Object.assign(p.data,{pageAlive:true,visible:true,loading:false,historyLoaded:true,conversation,supportAiAvailable:true,newTopicAvailable:true,messages:[msg(1),msg(2,'ai')],syncCursor:2,maxSeenSequence:2});
 m.request.mockResolvedValue(page());m.read.mockResolvedValue(page());
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('native support new AI topic',()=>{
 it('confirms clearing prior records and opens an empty conversation without an old history cursor',async()=>{
  await p.startNewTopic();expect(p.data.messages).toEqual([]);expect(p.data.contextStartSequence).toBe(2);expect(p.data.contextVersion).toBe(4);expect(p.data.olderCursor).toBeNull();
  expect(p.data.conversation.version).toBe(4);expect(p.data.newTopicAttempt).toBeNull();expect(p.data.newTopicBusy).toBe(false);
  expect(wx.showModal).toHaveBeenCalledWith(expect.objectContaining({content:expect.stringContaining('之前的聊天和未发送内容会清空')}));
  const modal=(wx.showModal as any).mock.calls[0][0];
  expect(Array.from(modal.confirmText).length).toBeLessThanOrEqual(4);
  const calls=m.request.mock.calls.filter(([x])=>x.path==='/v1/me/support/new-topic');expect(calls).toHaveLength(1);
  expect(calls[0]![0].data).toMatchObject({conversationId:conversation.id,expectedVersion:3,requestId:expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)});
  await p.loadOlder();expect(m.read).not.toHaveBeenCalled();
 });
 it('paginates only messages belonging to the new conversation generation',async()=>{
  await p.startNewTopic();p.data.olderCursor=5;
  m.read.mockResolvedValueOnce(page({messages:[msg(1),msg(3),msg(4,'ai')],olderCursor:null}));await p.loadOlder();
  expect(m.read).toHaveBeenCalledWith(p,expect.objectContaining({path:'/v1/me/support/messages?before=5&limit=50'}));expect(p.data.messages.map((x:any)=>x.sequence)).toEqual([3,4]);
 });
 it('starts a distinct generation even when the current conversation has no records left',async()=>{
  await p.startNewTopic();p.data.presence.operatorTyping=true;p.data.anchor='retired';p.data.newMessagesBelowCount=2;
  m.request.mockResolvedValueOnce(page({conversation:{...conversation,version:5},contextVersion:5}));await p.startNewTopic();
  expect(m.request.mock.calls.filter(([x])=>x.path==='/v1/me/support/new-topic')).toHaveLength(2);expect(p.data.contextVersion).toBe(5);
  expect(p.data.messages).toEqual([]);expect(p.data.anchor).toBe('');expect(p.data.presence.operatorTyping).toBe(false);expect(p.data.newMessagesBelowCount).toBe(0);
 });
 it('confirms an existing empty view before deleting records hidden by the former topic boundary',async()=>{
  p.data.messages=[];p.data.syncCursor=2;p.data.contextStartSequence=2;
  await p.startNewTopic();expect(wx.showModal).toHaveBeenCalledOnce();
  expect(m.request.mock.calls.filter(([input])=>input.path==='/v1/me/support/new-topic')).toHaveLength(1);
 });
 it('does not create a server conversation when the view is already empty',async()=>{
  p.data.conversation=null;p.data.messages=[];p.data.input='unsent';await p.startNewTopic();
  expect(wx.showModal).toHaveBeenCalledOnce();expect(m.request).not.toHaveBeenCalled();expect(p.data.input).toBe('');
 });
 it('keeps unsent content and history if the draft confirmation is cancelled',async()=>{
  p.data.input='retain this';p.data.selectedOrder={id:'synthetic-order'};(wx.showModal as any).mockResolvedValueOnce({confirm:false});await p.startNewTopic();
  expect(p.data.input).toBe('retain this');expect(p.data.selectedOrder.id).toBe('synthetic-order');expect(p.data.messages).toHaveLength(2);expect(m.request).not.toHaveBeenCalled();expect(p.data.newTopicBusy).toBe(false);
 });
 it('does not discard a draft changed while the confirmation was open',async()=>{
  const modal=deferred();p.data.input='original';(wx.showModal as any).mockReturnValueOnce(modal.promise);const starting=p.startNewTopic();
  p.data.selectedOrder={id:'late-order'};modal.resolve({confirm:true});await starting;
  expect(p.data.selectedOrder.id).toBe('late-order');expect(m.request).not.toHaveBeenCalled();
 });
 it.each(['waiting_human','human_active'])('does not leave %s to start a fresh topic',async(status)=>{
  p.data.conversation={...conversation,status};await p.startNewTopic();expect(m.request).not.toHaveBeenCalled();
 });
 it.each(['sending','uploadBusy','handoffBusy','closedRights','sendAttempt'])('does not start during %s',async(key)=>{
  p.data[key]=key==='sendAttempt'?{id:'unconfirmed-original'}:true;await p.startNewTopic();expect(m.request).not.toHaveBeenCalled();
 });
 it('keeps the same command and draft after an unknown result, blocking accidental sends until retry',async()=>{
  p.data.input='draft';m.request.mockRejectedValueOnce(new Error('synthetic network loss'));await p.startNewTopic();
  const attempt=structuredClone(p.data.newTopicAttempt);expect(attempt.requestId).toBeTruthy();expect(p.data.input).toBe('draft');
  await p.send();await p.requestHuman();p.prepareAttachmentSheet('image');expect(m.request).toHaveBeenCalledOnce();expect(p.data.attachmentSheetOpen).toBe(false);
  m.request.mockResolvedValueOnce(page());await p.startNewTopic();
  expect(m.request.mock.calls[1]![0].data).toEqual(attempt);expect(wx.showModal).toHaveBeenCalledOnce();expect(p.data.input).toBe('');expect(p.data.newTopicAttempt).toBeNull();
 });
 it('discards an old in-flight poll after an explicit topic change',async()=>{
  const old=deferred();m.read.mockReturnValueOnce(old.promise);const polling=p.poll();await p.startNewTopic();
  old.resolve(page({conversation,contextStartSequence:0,messages:[msg(1),msg(2,'ai')]}));await polling;
  expect(p.data.contextStartSequence).toBe(2);expect(p.data.messages).toEqual([]);expect(p.data.conversation.version).toBe(4);
 });
 it('accepts a newer boundary from another device and discards old history requests',async()=>{
  p.data.olderCursor=1;const history=deferred();m.read.mockReturnValueOnce(history.promise);const older=p.loadOlder();
  m.read.mockResolvedValueOnce(page({messages:[msg(3)],latestCursor:3}));await p.poll();
  history.resolve(page({conversation,contextStartSequence:0,messages:[msg(1)]}));await older;
  expect(p.data.contextStartSequence).toBe(2);expect(p.data.messages.map((x:any)=>x.sequence)).toEqual([3]);
 });
 it('clears a remotely replaced empty generation even when its sequence boundary has not changed',async()=>{
  Object.assign(p.data,{contextStartSequence:2,contextVersion:4,messages:[msg(3)],input:'old draft',selectedImage:{localPath:'old-image'},pendingMessage:msg(4),anchor:'old',newMessagesBelowCount:3});
  m.read.mockResolvedValueOnce(page({conversation:{...conversation,version:5},contextVersion:5}));await p.poll();
  expect(p.data.contextVersion).toBe(5);expect(p.data.messages).toEqual([]);expect(p.data.input).toBe('');expect(p.data.selectedImage).toBeNull();
  expect(p.data.pendingMessage).toBeNull();expect(p.data.anchor).toBe('');expect(p.data.newMessagesBelowCount).toBe(0);
 });
 it('ignores a late lower-generation load even if its conversation version is higher',async()=>{
  const stale=deferred();m.read.mockReturnValueOnce(stale.promise);const loading=p.load();
  Object.assign(p.data,{contextVersion:5,contextStartSequence:2,messages:[],conversation:{...conversation,version:6}});
  stale.resolve(page({conversation:{...conversation,version:7},contextVersion:4,messages:[msg(3)]}));await loading;
  expect(p.data.contextVersion).toBe(5);expect(p.data.messages).toEqual([]);expect(p.data.conversation.version).toBe(6);
 });
 it('does not apply a read receipt from a retired generation',async()=>{
  p.data.messages=[msg(1,'ai')];const receipt=deferred();m.request.mockReturnValueOnce(receipt.promise);const reading=p.markRead();
  p.data.contextVersion=4;p.data.readCursor=0;receipt.resolve({});await reading;expect(p.data.readCursor).toBe(0);
 });
 it('pins generation metadata to an uncertain send and retries that exact original command',async()=>{
  Object.assign(p.data,{contextVersion:4,contextStartSequence:2,input:'current message',composerSendEnabled:true});
  m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?Promise.reject(new Error('network lost')):Promise.resolve({}));
  await p.send();const first=m.request.mock.calls.find(([x])=>x.path==='/v1/me/support/messages')![0].data;
  p.data.contextVersion=5;await p.retrySend();const sends=m.request.mock.calls.filter(([x])=>x.path==='/v1/me/support/messages');
  expect(first).toMatchObject({expectedConversationId:conversation.id,contextVersion:4});expect(sends[1]![0].data).toEqual(first);
 });
 it('does not let an old send completion unlock a newer generation send',async()=>{
  p.data.input='old send';p.data.composerSendEnabled=true;const old=deferred(),current=deferred();let writes=0;
  m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?(++writes===1?old.promise:current.promise):Promise.resolve({}));
  const first=p.send();await p.load();p.updateInput({detail:{value:'new send'}});const second=p.send();const newAttempt=p.data.sendAttempt;
  old.resolve({conversation,message:msg(1),aiMessages:[],contextVersion:0,contextStartSequence:0});await first;
  expect(p.data.sending).toBe(true);expect(p.data.sendAttempt).toEqual(newAttempt);
  current.resolve({...page(),message:msg(3),aiMessages:[]});await second;expect(p.data.sending).toBe(false);expect(p.data.messages.map((item:any)=>item.sequence)).toEqual([3]);
 });
 it('refreshes a definitively retired send without replaying its text into the new conversation',async()=>{
  p.data.input='old draft';p.data.composerSendEnabled=true;
  m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?Promise.reject({status:409,code:'SUPPORT_CONTEXT_CHANGED'}):Promise.resolve({}));
  await p.send();expect(p.data.contextVersion).toBe(4);expect(p.data.messages).toEqual([]);expect(p.data.input).toBe('');
  expect(p.data.sendAttempt).toBeNull();expect(p.data.pendingMessage).toBeNull();expect(p.data.error).toContain('原消息未发送');
 });
 it('pins the explicit human request to its current generation and refreshes a retired request without resubmitting',async()=>{
  Object.assign(p.data,{contextVersion:4,contextStartSequence:2});
  m.request.mockImplementation(input=>input.path==='/v1/me/support/handoff'?Promise.reject({status:409,code:'SUPPORT_CONTEXT_CHANGED'}):Promise.resolve({}));
  m.read.mockResolvedValueOnce(page({contextVersion:5,conversation:{...conversation,version:5}}));await p.requestHuman();
  const requests=m.request.mock.calls.filter(([input])=>input.path==='/v1/me/support/handoff');expect(requests).toHaveLength(1);
  expect(requests[0]![0].data).toEqual({expectedConversationId:conversation.id,contextVersion:4});
  expect(p.data.contextVersion).toBe(5);expect(p.data.handoffBusy).toBe(false);expect(p.data.handoffFailed).toBe(false);expect(p.data.error).toContain('再申请人工客服');
 });
 it('acknowledges an old send without putting its bubbles back into a newer topic',async()=>{
  p.data.input='synthetic conversation';p.data.composerSendEnabled=true;
  m.request.mockImplementation(async input=>input.path==='/v1/me/support/messages'?{...page(),message:msg(1),aiMessages:[msg(2,'ai')],aiStatus:'pending'}:{});await p.send();
  expect(p.data.messages).toEqual([]);expect(p.data.contextStartSequence).toBe(2);expect(p.data.input).toBe('');expect(p.data.error).toBe('');expect(p.data.sendAttempt).toBeNull();
 });
 it('does not clear drafts or resurrect a view when the new-topic response arrives after hiding',async()=>{
  const result=deferred();p.data.input='retain after hiding';m.request.mockReturnValueOnce(result.promise);const starting=p.startNewTopic();await Promise.resolve();
  p.onHide();result.resolve(page());await starting;
  expect(p.data.input).toBe('retain after hiding');expect(p.data.visible).toBe(false);expect(p.data.newTopicBusy).toBe(false);expect(p.data.newTopicAttempt).not.toBeNull();
 });
 it('stops the busy visual when the request fails after the token changes without navigation',async()=>{
  const result=deferred();m.request.mockReturnValueOnce(result.promise);const starting=p.startNewTopic();await Promise.resolve();expect(m.request).toHaveBeenCalledOnce();m.token='';result.reject(new Error('synthetic identity revoked'));await starting;
  expect(p.data.newTopicBusy).toBe(false);expect(p.data.messages).toHaveLength(2);
 });
 it('preserves an authoritative human state returned by idempotent retry',async()=>{
  p.data.newTopicAttempt={conversationId:conversation.id,expectedVersion:2,requestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
  p.data.conversation={...conversation,status:'human_active',version:7};m.request.mockResolvedValueOnce(page({conversation:{...conversation,status:'human_active',version:7}}));
  await p.startNewTopic();expect(p.data.conversation.status).toBe('human_active');expect(p.data.newTopicAttempt).toBeNull();
 });
 it('starts the boundary at zero for a replacement conversation after lawful retention',async()=>{
  p.data.contextStartSequence=20;
  const replacement={...conversation,id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1};
  m.read.mockResolvedValue(page({conversation:replacement,contextStartSequence:0,messages:[msg(1)],latestCursor:1,olderCursor:null}));
  await p.poll();expect(p.data.contextStartSequence).toBe(0);expect(p.data.conversation.id).toBe(replacement.id);expect(p.data.messages.map((x:any)=>x.sequence)).toEqual([1]);
 });
 it('does not display an acknowledgement from a retired conversation under the replacement id',async()=>{
  p.data.contextStartSequence=20;p.data.input='synthetic conversation';p.data.composerSendEnabled=true;
  const replacement={...conversation,id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1};
  m.read.mockResolvedValue(page({conversation:replacement,contextStartSequence:0,messages:[],latestCursor:0,olderCursor:null}));
  m.request.mockImplementation(async input=>input.path==='/v1/me/support/messages'?{...page(),conversation:replacement,contextStartSequence:0,acknowledgedConversationId:conversation.id,message:msg(1),aiMessages:[],aiStatus:'pending'}:{});
  await p.send();expect(p.data.conversation.id).toBe(replacement.id);expect(p.data.contextStartSequence).toBe(0);expect(p.data.messages).toEqual([]);expect(p.data.input).toBe('');expect(p.data.error).toBe('');
 });
 it('reloads the replacement conversation without carrying an old incremental cursor into it',async()=>{
  p.data.syncCursor=50;p.data.contextStartSequence=40;
  const replacement={...conversation,id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1};
  m.read.mockResolvedValueOnce(page({conversation:replacement,contextStartSequence:0,messages:[],latestCursor:2,olderCursor:null}));
  m.read.mockResolvedValueOnce(page({conversation:replacement,contextStartSequence:0,messages:[msg(1),msg(2,'ai')],latestCursor:2,olderCursor:null}));
  await p.poll();expect(m.read.mock.calls[1]![1].path).toBe('/v1/me/support/messages');expect(p.data.messages.map((x:any)=>x.sequence)).toEqual([1,2]);expect(p.data.contextStartSequence).toBe(0);
 });
 it('resynchronizes a committed acknowledgement when its current topic metadata was temporarily unavailable',async()=>{
  p.data.input='synthetic conversation';p.data.composerSendEnabled=true;
  m.request.mockImplementation(async input=>input.path==='/v1/me/support/messages'?{conversation,message:msg(1),aiMessages:[],aiStatus:'pending',contextSyncRequired:true}:{});
  m.read.mockResolvedValueOnce(page({messages:[msg(3)],latestCursor:3}));await p.send();
  expect(p.data.sendAttempt).toBeNull();expect(p.data.input).toBe('');expect(p.data.messages.map((x:any)=>x.sequence)).toEqual([3]);expect(p.data.contextStartSequence).toBe(2);
 });
});

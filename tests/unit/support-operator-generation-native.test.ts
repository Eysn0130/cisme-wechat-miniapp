import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({token:'synthetic-operator',request:vi.fn(),read:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,retainMemberSnapshot:()=>true,downloadPrivateMedia:vi.fn()}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:m.read,cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
vi.mock('../../apps/miniprogram/services/authority',()=>({authorityProjection:vi.fn(),hasCapability:()=>true}));
let p:any;
const conversation={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'resolved',version:3};
const message=(sequence:number)=>({id:`synthetic-${sequence}`,sequence,senderType:'user',body:'synthetic chat',contentType:'text',createdAt:'2026-10-31T00:00:00Z',attachments:[],orderCard:null});
const page=(extra:any={})=>({conversation:{...conversation,status:'ai_active',version:4},contextVersion:4,contextStartSequence:2,messages:[],latestCursor:2,olderCursor:null,assignedToMe:false,...extra});
function deferred(){let resolve!:(value:any)=>void,reject!:(value:any)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return{resolve,reject,promise};}
beforeEach(async()=>{
 vi.resetModules();vi.useFakeTimers();m.token='synthetic-operator';m.request.mockReset().mockResolvedValue({});m.read.mockReset().mockResolvedValue(page());
 let definition:any;vi.stubGlobal('Page',(value:any)=>definition=value);vi.stubGlobal('getApp',()=>({globalData:{sessionToken:m.token}}));
 vi.stubGlobal('wx',{nextTick:(fn:()=>void)=>fn(),showToast:vi.fn()});
 await import('../../apps/miniprogram/pages/management-support-chat/index');
 p={...definition,data:structuredClone(definition.data),setData(patch:any){Object.assign(this.data,structuredClone(patch));}};
 Object.assign(p.data,{id:conversation.id,pageAlive:true,visible:true,loading:false,conversation,messages:[message(1),message(2)],syncCursor:2,maxSeenSequence:2,input:'retired draft',olderCursor:1,replyTarget:{id:'synthetic-1',sequence:1,summary:'synthetic chat',generation:0,contextVersion:0}});
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
describe('operator support generation isolation',()=>{
 it('rebuilds the same conversation ID and clears old bubbles, draft, cursor and typing',async()=>{
  p.data.presence.memberTyping=true;p.data.pendingMessage=message(3);p.data.anchor='retired';p.data.newMessagesBelowCount=2;
  await p.poll();expect(p.data.contextVersion).toBe(4);expect(p.data.messages).toEqual([]);expect(p.data.input).toBe('');
  expect(p.data.pendingMessage).toBeNull();expect(p.data.olderCursor).toBeNull();expect(p.data.anchor).toBe('');expect(p.data.newMessagesBelowCount).toBe(0);expect(p.data.presence.memberTyping).toBe(false);
 });
 it('treats an empty reset with unchanged sequence boundary as a new generation',async()=>{
  Object.assign(p.data,{contextVersion:4,contextStartSequence:2});m.read.mockResolvedValueOnce(page({contextVersion:5,conversation:{...conversation,version:5}}));
  await p.poll();expect(p.data.contextVersion).toBe(5);expect(p.data.messages).toEqual([]);expect(p.data.input).toBe('');
 });
 it('ignores a lower-generation full response after a newer generation was adopted',async()=>{
  const old=deferred();m.read.mockReturnValueOnce(old.promise);const loading=p.load();
  Object.assign(p.data,{contextVersion:5,contextStartSequence:2,messages:[]});old.resolve(page({contextVersion:4,messages:[message(3)]}));await loading;
  expect(p.data.contextVersion).toBe(5);expect(p.data.messages).toEqual([]);
 });
 it('discards old pagination returned after a newer same-ID poll',async()=>{
  const old=deferred();m.read.mockReturnValueOnce(old.promise);const history=p.loadOlder();
  await p.poll();old.resolve(page({contextVersion:0,contextStartSequence:0,messages:[message(1)]}));await history;
  expect(p.data.messages).toEqual([]);expect(p.data.contextVersion).toBe(4);
 });
 it('filters pagination to the current generation',async()=>{
  Object.assign(p.data,{contextVersion:4,contextStartSequence:2,messages:[],olderCursor:5});
  m.read.mockResolvedValueOnce(page({messages:[message(1),message(3),message(4)]}));await p.loadOlder();
  expect(p.data.messages.map((item:any)=>item.sequence)).toEqual([3,4]);
 });
 it('does not apply a read acknowledgement from a retired generation',async()=>{
  const read=deferred();m.request.mockReturnValueOnce(read.promise);const reading=p.markRead();p.data.contextVersion=4;
  read.resolve({});await reading;expect(p.data.readCursor).toBe(0);
 });
 it('does not append a late operator reply after the same-ID generation changed',async()=>{
  Object.assign(p.data,{assignedToMe:true,canReply:true,conversation:{...conversation,status:'human_active'}});
  const reply=deferred();m.request.mockImplementation(input=>input.path.endsWith('/messages')?reply.promise:Promise.resolve({}));
  const sending=p.send();p.data.contextVersion=4;p.data.messages=[];p.clearRetiredTopic();
  reply.resolve({conversation,message:{...message(3),senderType:'admin'},contextVersion:0,contextStartSequence:0});await sending;
  expect(p.data.messages).toEqual([]);expect(p.data.pendingMessage).toBeNull();
 });
 it('does not recreate a retired pending bubble when an old operator reply fails late',async()=>{
  Object.assign(p.data,{assignedToMe:true,canReply:true,conversation:{...conversation,status:'human_active'}});
  const reply=deferred();m.request.mockImplementation(input=>input.path.endsWith('/messages')?reply.promise:Promise.resolve({}));
  const sending=p.send();p.data.contextVersion=4;p.data.messages=[];p.clearRetiredTopic();
  reply.reject(new Error('late network failure'));await sending;expect(p.data.messages).toEqual([]);expect(p.data.pendingMessage).toBeNull();
 });
 it('acknowledges a committed reply whose current context metadata needs refresh',async()=>{
  Object.assign(p.data,{assignedToMe:true,canReply:true,conversation:{...conversation,status:'human_active'},contextVersion:4,contextStartSequence:2,messages:[],replyTarget:{id:'synthetic-3',sequence:3,summary:'synthetic chat',generation:0,contextVersion:4}});
  m.request.mockImplementation(async input=>input.path.endsWith('/messages')?{message:{...message(3),senderType:'admin'},contextSyncRequired:true}:{});
  await p.send();expect(p.data.sendAttempt).toBeNull();expect(p.data.pendingMessage).toBeNull();expect(p.data.input).toBe('');expect(p.data.messages).toEqual([]);
 });
});

const activeConversation={...conversation,status:'human_active',version:5};
const humanRequest={generation:1,status:'human_active',anchorKnown:true,anchorMessageId:'synthetic-1',anchorSequence:1};
const humanPage=(extra:any={})=>page({conversation:activeConversation,contextVersion:0,contextStartSequence:0,assignedToMe:true,humanRequest,messages:[message(1),{...message(3),body:'another basic question'}],latestCursor:3,...extra});
async function loadHuman(extra:any={}){
 Object.assign(p.data,{replyTarget:null,input:'',canReply:true,assignedToMe:true});
 m.read.mockResolvedValueOnce(humanPage(extra));await p.load();
}
const select=(id:string)=>p.selectReplyTarget({currentTarget:{dataset:{id}}});
describe('operator reads crossing a confirmed newer assignment',()=>{
 it('merges older pagination without applying its former null human-request metadata',async()=>{
  await loadHuman();p.data.olderCursor=2;const old=deferred();m.read.mockReturnValueOnce(old.promise);const reading=p.loadOlder();
  p.setData({conversation:{...activeConversation,version:7},input:'新草稿',replyTargetNeedsRefresh:false,readCursor:8,syncCursor:9});
  const target=structuredClone(p.data.replyTarget);
  old.resolve(humanPage({conversation:{...conversation,status:'ai_active',version:4},humanRequest:null,assignedToMe:false,messages:[message(2)],latestCursor:2}));await reading;
  expect(p.data).toMatchObject({conversation:{status:'human_active',version:7},humanRequest,assignedToMe:true,replyTarget:target,input:'新草稿',replyTargetNeedsRefresh:false,readCursor:8,syncCursor:9});
  expect(p.data.messages.map((item:any)=>item.sequence)).toEqual([1,2,3]);
 });
 it.each(['load','poll'])('keeps newer human metadata when an older AI/null snapshot finishes its %s',async(method)=>{
  const old=deferred();Object.assign(p.data,{conversation:{...conversation,status:'ai_active',version:5},humanRequest:null,replyTarget:null,input:'',assignedToMe:false});
  m.read.mockReturnValueOnce(old.promise);const reading=p[method]();
  const target={id:'synthetic-1',sequence:1,summary:'synthetic chat',generation:1,contextVersion:0};
  const attempt={id:'newer-reply',body:'新的人工回复草稿',replyToMessageId:target.id,expectedHumanRequestGeneration:1,contextVersion:0};
  p.setData({conversation:{...activeConversation,version:7},humanRequest,assignedToMe:true,replyTarget:target,replyTargetNeedsRefresh:false,
    input:attempt.body,sendAttempt:attempt,pendingMessage:{id:'local-newer-reply'},composerSendEnabled:true,
    messages:[message(1)],syncCursor:9,maxSeenSequence:9,readCursor:8,olderCursor:42,atBottom:false,anchor:'newer-anchor',newMessagesBelow:true,newMessagesBelowCount:2});
  old.resolve(humanPage({conversation:{...conversation,status:'ai_active',version:5},humanRequest:null,assignedToMe:false,messages:[message(2)],latestCursor:2,olderCursor:null}));await reading;
  expect(p.data).toMatchObject({conversation:{status:'human_active',version:7},humanRequest,assignedToMe:true,replyTarget:target,replyTargetNeedsRefresh:false,
    input:attempt.body,sendAttempt:attempt,pendingMessage:{id:'local-newer-reply'},composerSendEnabled:true,syncCursor:9,maxSeenSequence:9,readCursor:8,olderCursor:42,anchor:'newer-anchor',newMessagesBelowCount:3});
  expect(p.data.messages.map((item:any)=>item.sequence)).toEqual([1,2]);expect(m.request).not.toHaveBeenCalled();
 });
 it.each(['load','poll'])('keeps a claimed assignment and draft when a same-generation older waiting snapshot finishes its %s',async(method)=>{
  const waiting={...activeConversation,status:'waiting_human',version:6};const old=deferred();
  Object.assign(p.data,{conversation:waiting,humanRequest:{...humanRequest,status:'waiting_human'},replyTarget:null,input:'',assignedToMe:false});
  m.read.mockReturnValueOnce(old.promise);const reading=p[method]();
  const target={id:'synthetic-1',sequence:1,summary:'synthetic chat',generation:1,contextVersion:0};
  p.setData({conversation:{...activeConversation,version:7},humanRequest,assignedToMe:true,replyTarget:target,replyTargetNeedsRefresh:false,
    input:'已认领后的新草稿',composerSendEnabled:true,messages:[message(1)],syncCursor:4,maxSeenSequence:4,readCursor:4});
  old.resolve(humanPage({conversation:waiting,humanRequest:{...humanRequest,status:'waiting_human'},assignedToMe:false,messages:[],latestCursor:1}));await reading;
  expect(p.data).toMatchObject({conversation:{status:'human_active',version:7},humanRequest,assignedToMe:true,replyTarget:target,replyTargetNeedsRefresh:false,
    input:'已认领后的新草稿',composerSendEnabled:true,syncCursor:4,maxSeenSequence:4,readCursor:4});
  expect(m.request.mock.calls.some(([input])=>input.path.endsWith('/presence')&&input.data.online===false)).toBe(false);
 });
});
describe('operator replies bind an explicit question',()=>{
 it('shows the authorized original summary before claim even when the source is outside the loaded page',async()=>{
  const summary='请核对原订单的退款金额';
  await loadHuman({conversation:{...activeConversation,status:'waiting_human'},assignedToMe:false,
    humanRequest:{...humanRequest,status:'waiting_human',anchorSummary:summary},messages:[message(30)]});
  expect(p.data.assignedToMe).toBe(false);expect(p.data.humanIssueSummary).toBe(summary);expect(p.data.replyTarget).toMatchObject({id:'synthetic-1',summary});
  expect(m.read).toHaveBeenCalledOnce();
 });
 it('keeps a legacy unspecified original question unknown instead of taking the latest loaded user text',async()=>{
  await loadHuman({humanRequest:{...humanRequest,generation:0,anchorKnown:false,anchorMessageId:null,anchorSequence:null,anchorSummary:'不得展示的旧摘要'},messages:[{...message(30),body:'最新的问题不能代替原问题'}]});
  expect(p.data.humanIssueSummary).toBe('');expect(p.data.replyTarget).toBeNull();
 });
 it('defaults to the server human-request anchor rather than the latest user question',async()=>{
  await loadHuman();expect(p.data.replyTarget).toMatchObject({id:'synthetic-1',summary:'synthetic chat',generation:1,contextVersion:0});
  p.updateInput({detail:{value:'answer to original issue'}});
  m.request.mockImplementation(async input=>input.path.endsWith('/messages')?{conversation:activeConversation,message:{...message(4),senderType:'admin'},contextVersion:0,contextStartSequence:0}:{});
  await p.send();expect(m.request).toHaveBeenCalledWith(expect.objectContaining({path:expect.stringContaining('/messages'),data:expect.objectContaining({replyToMessageId:'synthetic-1',expectedHumanRequestGeneration:1,contextVersion:0,body:'answer to original issue'})}));
 });
 it('does not guess the latest question when the original human-request anchor is unknown',async()=>{
  await loadHuman({humanRequest:{...humanRequest,anchorKnown:false,anchorMessageId:null,anchorSequence:null}});
  expect(p.data.replyTarget).toBeNull();p.data.input='unbound draft';await p.send();
  expect(m.request.mock.calls.some(([input])=>input.path.endsWith('/messages'))).toBe(false);expect(p.data.error).toContain('点选');
 });
 it('lets the operator select a loaded user question but never an AI or retired message',async()=>{
  await loadHuman();await select('synthetic-3');expect(p.data.replyTarget).toMatchObject({id:'synthetic-3',summary:'another basic question'});
  p.data.messages.push({...message(4),senderType:'ai'});await select('synthetic-4');expect(p.data.replyTarget.id).toBe('synthetic-3');
  p.data.contextStartSequence=3;await select('synthetic-1');expect(p.data.replyTarget.id).toBe('synthetic-3');
 });
 it('requires clearing a bound draft before changing the target question',async()=>{
  await loadHuman();p.updateInput({detail:{value:'original answer'}});(wx as any).showModal=vi.fn().mockResolvedValue({confirm:false});
  await select('synthetic-3');expect(p.data.replyTarget.id).toBe('synthetic-1');expect(p.data.input).toBe('original answer');
  (wx.showModal as any).mockResolvedValueOnce({confirm:true});await select('synthetic-3');expect(p.data.replyTarget.id).toBe('synthetic-3');expect(p.data.input).toBe('');
 });
 it('pins an uncertain send to the original target and command when later user questions arrive',async()=>{
  await loadHuman();p.updateInput({detail:{value:'original answer'}});
  m.request.mockImplementation(async input=>input.path.endsWith('/messages')?Promise.reject({code:'NETWORK_TIMEOUT'}):{});
  await p.send();const attempt=structuredClone(p.data.sendAttempt);expect(p.data.pendingMessage.deliveryLabel).toBe('结果待核对');
  p.updateInput({detail:{value:'replacement'}});await select('synthetic-3');expect(p.data.input).toBe('original answer');expect(p.data.replyTarget.id).toBe('synthetic-1');
  m.read.mockResolvedValueOnce(humanPage({messages:[message(5)],latestCursor:5}));await p.poll();expect(p.data.sendAttempt).toEqual(attempt);
  m.request.mockImplementation(async input=>input.path.endsWith('/messages')?{conversation:activeConversation,message:{...message(4),senderType:'admin'},contextVersion:0,contextStartSequence:0}:{});
  await p.retrySend();const sends=m.request.mock.calls.filter(([input])=>input.path.endsWith('/messages'));
  expect(sends).toHaveLength(2);expect(sends[1]![0].data).toEqual(sends[0]![0].data);expect(p.data.sendAttempt).toBeNull();
 });
 it('clears a draft and target on a new human request and requires refresh before rebinding',async()=>{
  await loadHuman();p.updateInput({detail:{value:'old issue answer'}});
  const newer=humanPage({humanRequest:{...humanRequest,generation:2,anchorMessageId:'synthetic-3',anchorSequence:3}});m.read.mockResolvedValueOnce(newer);await p.poll();
  expect(p.data.replyTarget).toBeNull();expect(p.data.input).toBe('');expect(p.data.replyTargetNeedsRefresh).toBe(true);expect(p.data.error).toContain('刷新');
  await select('synthetic-3');expect(p.data.replyTarget).toBeNull();
  p.onShow=vi.fn(async()=>p.load());m.read.mockResolvedValueOnce(newer);await p.retry();expect(p.data.replyTarget.id).toBe('synthetic-3');expect(p.data.replyTarget.generation).toBe(2);
 });
 it('keeps the newer request anchor when an older request snapshot arrives late',async()=>{
  await loadHuman();m.read.mockResolvedValueOnce(humanPage({humanRequest:{...humanRequest,generation:0,anchorMessageId:'synthetic-3'}}));await p.poll();
  expect(p.data.humanRequest.generation).toBe(1);expect(p.data.replyTarget.id).toBe('synthetic-1');
 });
 it('requires fresh context after a definitive server conflict without replaying the old target',async()=>{
  await loadHuman();p.updateInput({detail:{value:'outdated answer'}});
  m.request.mockImplementation(async input=>input.path.endsWith('/messages')?Promise.reject({status:409,code:'SUPPORT_HUMAN_REQUEST_CHANGED'}):{});
  await p.send();expect(p.data.replyTarget).toBeNull();expect(p.data.sendAttempt).toBeNull();expect(p.data.pendingMessage).toBeNull();expect(p.data.replyTargetNeedsRefresh).toBe(true);expect(p.data.error).toContain('原回复未发送');
 });
 it('keeps an interrupted send recoverable with its original target after the page is hidden',async()=>{
  await loadHuman();p.updateInput({detail:{value:'original answer'}});const response=deferred();
  m.request.mockImplementation(input=>input.path.endsWith('/messages')?response.promise:Promise.resolve({}));const sending=p.send();const attempt=structuredClone(p.data.sendAttempt);
  p.onHide();expect(p.data.pendingMessage.deliveryLabel).toBe('结果待核对');expect(p.data.sendAttempt).toEqual(attempt);expect(p.data.busy).toBe(false);
  response.resolve({conversation:activeConversation,message:{...message(4),senderType:'admin'},contextVersion:0,contextStartSequence:0});await sending;
  expect(p.data.sendAttempt).toEqual(attempt);expect(p.data.pendingMessage.deliveryLabel).toBe('结果待核对');
 });
 it('does not adopt an older human request from a late pagination response',async()=>{
  await loadHuman();p.data.olderCursor=2;const response=deferred();m.read.mockReturnValueOnce(response.promise);const reading=p.loadOlder();
  p.data.humanRequest={...humanRequest,generation:2};p.data.replyTarget={...p.data.replyTarget,generation:2};
  response.resolve(humanPage({humanRequest,messages:[message(1)]}));await reading;expect(p.data.humanRequest.generation).toBe(2);expect(p.data.replyTarget.generation).toBe(2);
 });
 it('does not rebind a draft if its human request changes during the target confirmation',async()=>{
  await loadHuman();p.updateInput({detail:{value:'old answer'}});const modal=deferred();(wx as any).showModal=vi.fn().mockReturnValueOnce(modal.promise);
  const selecting=select('synthetic-3');p.data.humanRequest={...humanRequest,generation:2};modal.resolve({confirm:true});await selecting;
  expect(p.data.replyTarget.id).toBe('synthetic-1');expect(p.data.input).toBe('old answer');
 });
 it('binds an AI reply draft to the selected question and both generations',async()=>{
  await loadHuman();p.data.aiProviderAvailable=true;await select('synthetic-3');
  m.request.mockImplementation(async input=>input.path.endsWith('/suggested-reply')?{text:'draft for selected question'}:{});
  await p.suggest();expect(m.request).toHaveBeenCalledWith(expect.objectContaining({path:expect.stringContaining('/suggested-reply'),data:{replyToMessageId:'synthetic-3',expectedHumanRequestGeneration:1,contextVersion:0}}));
  expect(p.data.input).toBe('draft for selected question');expect(p.data.replyTarget.id).toBe('synthetic-3');
 });
});

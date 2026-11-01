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
 Object.assign(p.data,{id:conversation.id,pageAlive:true,visible:true,loading:false,conversation,messages:[message(1),message(2)],syncCursor:2,maxSeenSequence:2,input:'retired draft',olderCursor:1});
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
  Object.assign(p.data,{assignedToMe:true,canReply:true,conversation:{...conversation,status:'human_active'},contextVersion:4,contextStartSequence:2,messages:[]});
  m.request.mockImplementation(async input=>input.path.endsWith('/messages')?{message:{...message(3),senderType:'admin'},contextSyncRequired:true}:{});
  await p.send();expect(p.data.sendAttempt).toBeNull();expect(p.data.pendingMessage).toBeNull();expect(p.data.input).toBe('');expect(p.data.messages).toEqual([]);
 });
});

import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const m=vi.hoisted(()=>({token:'synthetic-member',retain:true,closed:false,request:vi.fn(),read:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,requireMemberAccess:()=>true,retainMemberSnapshot:()=>m.retain,
 historicalCommerceToken:()=>m.token,historicalCommerceClosed:()=>m.closed,requireHistoricalCommerceAccess:()=>true,
 downloadPrivateMedia:vi.fn(),uploadAuthorized:vi.fn()}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:m.read,cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
let definition:any,p:any;
const conversation={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'ai_active',version:3,memberReadSequence:0,teamReadSequence:0};
const message=(senderType:string,sequence:number)=>({id:`synthetic-${senderType}-${sequence}`,sequence,senderType,body:senderType==='user'?'护理如何保存？':'完成四步后填写感受并保存。',contentType:'text',createdAt:'2026-10-30T00:00:00Z',attachments:[],orderCard:null,deliveryState:'server_accepted'});
function deferred(){let resolve!:(v:any)=>void,reject!:(v:any)=>void;const promise=new Promise<any>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function captureComposerMeasurements(){
 const ticks:Array<()=>void>=[];(globalThis as any).wx.nextTick=(callback:()=>void)=>ticks.push(callback);p.measureComposer=vi.fn();return ticks;
}
const welcomeView=readFileSync(new URL('../../apps/miniprogram/pages/support/index.wxml',import.meta.url),'utf8');
const welcomeConditions=[...welcomeView.matchAll(/<view wx:if="\{\{([^}]+)\}\}"[^>]*\bsupport-welcome-message\b/g)].map(match=>match[1]!);
function welcomeCount(){
 expect(welcomeConditions).toHaveLength(1);
 return welcomeConditions.reduce((count,condition)=>{
  const tokens=condition.match(/[A-Za-z_][A-Za-z0-9_]*|&&|\|\||!|\(|\)/g)??[];
  expect(tokens.join('')).toBe(condition.replace(/\s/g,''));
  const names=['historyLoaded','historyStartLoaded','closedRights','loading'];
  for(const token of tokens)if(/^[A-Za-z_]/.test(token))expect(names).toContain(token);
  const values=Object.fromEntries(names.map(name=>[name,p.data[name]===true]));
  return count+Number(Boolean(runInNewContext(`(${condition})`,values,{timeout:100,contextCodeGeneration:{strings:false,wasm:false}})));
 },0);
}
const historyPage=(extra:any={})=>({conversation:{...conversation},messages:[],latestCursor:0,olderCursor:null,
 contextVersion:0,contextStartSequence:0,newTopicAvailable:true,supportAiAvailable:true,supportAiCanRespond:true,...extra});
async function settlePage(){for(let index=0;index<8;index++)await Promise.resolve();}
beforeEach(async()=>{
 vi.resetModules();vi.useFakeTimers();m.token='synthetic-member';m.retain=true;m.closed=false;m.request.mockReset();m.read.mockReset();
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token}});
 (globalThis as any).Page=(value:any)=>{definition=value;};
 (globalThis as any).wx={showModal:vi.fn().mockResolvedValue({confirm:true}),nextTick:(fn:()=>void)=>fn(),showToast:vi.fn(),navigateTo:vi.fn(),getStorageSync:vi.fn()};
 await import('../../apps/miniprogram/pages/support/index');
 p={...definition,data:structuredClone(definition.data),setData(update:any){Object.assign(this.data,structuredClone(update));}};
 Object.assign(p.data,{pageAlive:true,visible:true,loading:false,input:'护理如何保存？',composerSendEnabled:true,conversation,supportAiAvailable:true});
 m.request.mockResolvedValue({});m.read.mockResolvedValue({conversation,messages:[],latestCursor:0,supportAiAvailable:true});
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('native AI and human support collaboration receipts',()=>{
 it('measures an asynchronously attached route order after its owned card renders',async()=>{
  p.linkedOrderId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';const ticks=captureComposerMeasurements(),response=deferred();m.read.mockReturnValueOnce(response.promise);
  const loading=p.loadLinkedOrder();expect(ticks).toHaveLength(0);
  response.resolve({id:p.linkedOrderId,orderNumber:'SYNTHETIC-0001',status:'pending_payment',currency:'CNY',totalCents:100,lines:[]});await loading;
  expect(p.data.selectedOrder?.id).toBe(p.linkedOrderId);expect(ticks).toHaveLength(1);expect(p.measureComposer).not.toHaveBeenCalled();
  ticks.shift()!();expect(p.measureComposer).toHaveBeenCalledOnce();
 });
 it.each(['hidden','account'])('does not attach or measure a route order returned after %s ownership changes',async(change)=>{
  p.linkedOrderId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';const ticks=captureComposerMeasurements(),response=deferred();m.read.mockReturnValueOnce(response.promise);
  const loading=p.loadLinkedOrder();if(change==='hidden'){p.data.visible=false;p.lifecycleEpoch++;}else m.token='synthetic-other';
  response.resolve({id:p.linkedOrderId,orderNumber:'SYNTHETIC-0001',status:'pending_payment',currency:'CNY',totalCents:100,lines:[]});await loading;
  expect(p.data.selectedOrder).toBeNull();expect(ticks).toHaveLength(0);expect(p.measureComposer).not.toHaveBeenCalled();
 });
 it('measures a newly loaded composer action after render and skips unchanged polls',async()=>{
  Object.assign(p.data,{loading:true,conversation:null,supportAiAvailable:false});const ticks=captureComposerMeasurements(),response=deferred();m.read.mockReturnValueOnce(response.promise);
  const loading=p.load();expect(ticks).toHaveLength(0);
  response.resolve({conversation,messages:[],latestCursor:0,supportAiAvailable:true});await loading;
  expect(ticks).toHaveLength(1);expect(p.measureComposer).not.toHaveBeenCalled();ticks.shift()!();expect(p.measureComposer).toHaveBeenCalledOnce();
  await p.poll();expect(ticks).toHaveLength(0);
 });
 it('keeps queue actions stable when AI availability or queue version changes',async()=>{
  const waiting={...conversation,status:'waiting_human',version:4};p.data.conversation=waiting;const ticks=captureComposerMeasurements();
  m.read.mockResolvedValueOnce({conversation:waiting,messages:[],latestCursor:0,supportAiAvailable:false});await p.poll();
  expect(ticks).toHaveLength(0);
  m.read.mockResolvedValueOnce({conversation:{...waiting,version:5},messages:[],latestCursor:0,supportAiAvailable:false});await p.poll();expect(ticks).toHaveLength(0);
  m.read.mockResolvedValueOnce({conversation:{...waiting,version:6},messages:[],latestCursor:0,supportAiAvailable:true});await p.poll();expect(ticks).toHaveLength(0);
 });
 it('measures the restored contact action after an initial load error',async()=>{
  Object.assign(p.data,{loading:true,conversation:null,supportAiAvailable:false});const ticks=captureComposerMeasurements();m.read.mockRejectedValueOnce(new Error('synthetic read failure'));
  await p.load();expect(p.data.errorAction).toBe('sync');expect(ticks).toHaveLength(1);expect(p.measureComposer).not.toHaveBeenCalled();ticks.shift()!();expect(p.measureComposer).toHaveBeenCalledOnce();
 });
 it('remeasures the composer when a pending AI receipt hides its contact action',async()=>{
  const schedule=vi.spyOn(p,'scheduleComposerMeasure');
  m.request.mockImplementation(async input=>input.path==='/v1/me/support/messages'?{conversation,message:message('user',1),aiStatus:'pending',aiMessages:[]}:{});
  await p.send();expect(p.data.errorAction).toBe('handoff');expect(schedule).toHaveBeenCalledOnce();
 });
 it.each(['hidden','account'])('defers resize measurement and discards its callback after %s ownership changes',async(change)=>{
  const ticks=captureComposerMeasurements();p.onResize();expect(ticks).toHaveLength(1);expect(p.measureComposer).not.toHaveBeenCalled();
  if(change==='hidden'){p.data.visible=false;p.lifecycleEpoch++;}else m.token='synthetic-other';
  ticks.shift()!();expect(p.measureComposer).not.toHaveBeenCalled();
 });
 it('reads an empty thread repeatedly without posting a greeting or creating a local message',async()=>{
  p.data.conversation=null;m.read.mockResolvedValue({conversation:null,messages:[],latestCursor:0,supportAiAvailable:true});
  expect(p.data.historyLoaded).toBe(false);await p.load();await p.load();
  expect(p.data.historyLoaded).toBe(true);expect(p.data.messages).toEqual([]);expect(p.data.conversation).toBeNull();
  expect(p.data).toMatchObject({statusLabel:'CISME AI 客服',statusTone:'ai'});
  expect(m.read).toHaveBeenCalledTimes(2);expect(m.request).not.toHaveBeenCalled();
 });
 it('does not treat a failed first history read as a successful empty conversation',async()=>{
  p.data.conversation=null;m.read.mockRejectedValueOnce(new Error('synthetic network failure'));
  await p.load();expect(p.data.historyLoaded).toBe(false);expect(p.data.errorAction).toBe('sync');expect(p.data.messages).toEqual([]);
 });
 it('shows AI waiting only during an active eligible text POST and stops when its persisted answer arrives',async()=>{
  const response=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?response.promise:Promise.resolve({}));
  const sending=p.send();expect(p.data.aiReplyWaiting).toBe(true);expect(p.data.pendingMessage.deliveryLabel).toBe('正在发送');
  response.resolve({conversation,message:message('user',1),aiMessages:[message('ai',2)],aiStatus:'replied'});await sending;
  expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.messages.map((row:any)=>row.senderType)).toEqual(['user','ai']);
 });
 it.each(['disabled','legacy-human','attachment','unknown','capability-disabled'])('does not claim AI waiting for a %s send',async(mode)=>{
  if(mode==='disabled')p.data.supportAiAvailable=false;
  if(mode==='legacy-human')p.data.conversation={...conversation,status:'human_active'};
  if(mode==='attachment')p.data.selectedImage={mediaId:'synthetic-image',status:'ready',mimeType:'image/jpeg',size:10,localPath:'/tmp/synthetic'};
  if(mode==='unknown')p.data.sendAttempt={id:'synthetic-retry-key',body:p.data.input,mediaIds:[],linkedOrderId:null,signature:'retained-signature'};
  if(mode==='capability-disabled')p.data.supportAiCanRespond=false;
  const response=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?response.promise:Promise.resolve({}));
  const sending=p.send();expect(p.data.aiReplyWaiting).toBe(false);
  response.resolve({conversation:p.data.conversation,message:message('user',1)});await sending;
  if(mode==='unknown')expect(m.request).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({clientMessageId:'synthetic-retry-key'})}));
 });
 it('stops waiting on a network timeout and retains the exact unknown attempt for verification',async()=>{
  const response=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?response.promise:Promise.resolve({}));
  const sending=p.send(),attempt=p.data.sendAttempt;expect(p.data.aiReplyWaiting).toBe(true);
  response.reject({code:'NETWORK_TIMEOUT'});await sending;
  expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.sendAttempt).toEqual(attempt);expect(p.data.pendingMessage.deliveryLabel).toBe('结果待核对');
 });
 it('stops AI waiting as soon as the message POST finishes, even if its read receipt is still pending',async()=>{
  const readReceipt=deferred();
  m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?Promise.resolve({conversation,message:message('user',1),aiMessages:[message('ai',2)]}):input.path==='/v1/me/support/read'?readReceipt.promise:Promise.resolve({}));
  const sending=p.send();await Promise.resolve();await Promise.resolve();
  expect(p.data.messages.map((row:any)=>row.senderType)).toEqual(['user','ai']);expect(p.data.aiReplyWaiting).toBe(false);
  readReceipt.resolve({});await sending;
 });
 it('keeps disabled AI neutral while retaining an explicit user handoff',async()=>{
  p.data.supportAiAvailable=false;
  expect(p.headerPatch(null,p.data.presence)).toMatchObject({statusTone:'neutral',statusLabel:'欢迎留言'});
  expect(p.headerPatch(conversation,p.data.presence)).toMatchObject({statusTone:'neutral',statusLabel:'AI 客服暂不可用'});
  m.request.mockImplementation(async input=>input.path==='/v1/me/support/handoff'?{...conversation,status:'waiting_human',version:4}:{});
  await p.requestHuman();expect(p.data.conversation.status).toBe('waiting_human');expect(p.data.aiReplyWaiting).toBe(false);
 });
 it.each(['hidden','account'])('drops late AI state after the page becomes %s',async(change)=>{
  const response=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?response.promise:Promise.resolve({}));
  const sending=p.send();expect(p.data.aiReplyWaiting).toBe(true);p.onHide();
  if(change==='account'){m.token='synthetic-other';m.retain=false;p.load=vi.fn();p.onShow();p.updateInput({detail:{value:'新账号草稿'}});}
  response.resolve({conversation,message:message('user',1),aiMessages:[message('ai',2)],aiStatus:'replied'});await sending;
  expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.messages).toEqual([]);
  if(change==='account')expect(p.data.input).toBe('新账号草稿');
 });
 it('ends an old wait when the token changes before the next lifecycle notification',async()=>{
  const response=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?response.promise:Promise.resolve({}));
  const sending=p.send();m.token='synthetic-other';
  response.resolve({conversation,message:message('user',1),aiMessages:[message('ai',2)]});await sending;
  expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.messages).toEqual([]);
 });
 it('allows handoff during the first send and retains the newer queue state when the older acknowledgement arrives',async()=>{
  p.data.conversation=null;const response=deferred(),handoff=deferred();
  m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?response.promise:input.path==='/v1/me/support/handoff'?handoff.promise:Promise.resolve({}));
  const sending=p.send();expect(p.data.aiReplyWaiting).toBe(true);
  const requesting=p.requestHuman();expect(p.data.aiReplyWaiting).toBe(true);
  const waiting={...conversation,status:'waiting_human',version:4};handoff.resolve(waiting);await requesting;
  response.resolve({conversation,message:message('user',1),aiStatus:'pending',aiMessages:[]});await sending;
  expect(p.data.conversation).toEqual(waiting);expect(p.data.statusLabel).toBe('等待人工客服');expect(p.data.messages.map((row:any)=>row.id)).toEqual(['synthetic-user-1']);
  expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.errorAction).toBe('sync');expect(p.data.sendAttempt).toBeNull();
 });
 it('keeps thinking for a new question while handoff is pending without regressing its later queue receipt',async()=>{
  const handoff=deferred(),response=deferred();
  m.request.mockImplementation(input=>input.path==='/v1/me/support/handoff'?handoff.promise:input.path==='/v1/me/support/messages'?response.promise:Promise.resolve({}));
  const requesting=p.requestHuman();expect(p.data.handoffBusy).toBe(true);
  const sending=p.send();expect(p.data.aiReplyWaiting).toBe(true);expect(p.data.sending).toBe(true);
  expect(m.request).toHaveBeenCalledWith(expect.objectContaining({path:'/v1/me/support/messages',method:'POST',data:expect.objectContaining({body:'护理如何保存？'})}));
  const waiting={...conversation,status:'waiting_human',version:4};handoff.resolve(waiting);await requesting;
  response.resolve({conversation,message:message('user',1),aiStatus:'pending',aiMessages:[]});await sending;
  expect(p.data.conversation).toEqual(waiting);expect(p.data.messages.map((row:any)=>row.id)).toEqual(['synthetic-user-1']);
  expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.pendingMessage).toBeNull();expect(p.data.sendAttempt).toBeNull();
 });
 it('keeps a confirmed human assignment when an older handoff or poll returns',async()=>{
  const handoff=deferred(),poll=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/handoff'?handoff.promise:Promise.resolve({}));m.read.mockReturnValue(poll.promise);
  const reading=p.poll(),requesting=p.requestHuman();p.data.conversation={...conversation,status:'human_active',version:6};
  handoff.resolve({...conversation,status:'waiting_human',version:4});await requesting;
  poll.resolve({conversation,messages:[message('admin',2)],latestCursor:2,supportAiAvailable:true});await reading;
  expect(p.data.conversation.status).toBe('human_active');expect(p.data.conversation.version).toBe(6);expect(p.data.messages.map((row:any)=>row.id)).toEqual(['synthetic-admin-2']);
 });
 it('does not clear an acknowledged first message when an older empty initial read arrives',async()=>{
  p.data.conversation=null;const history=deferred();m.read.mockReturnValueOnce(history.promise);
  const reading=p.load();m.request.mockImplementation(async(input:any)=>input.path==='/v1/me/support/messages'?{conversation,message:message('user',1),aiMessages:[message('ai',2)]}:{});
  await p.send();history.resolve({conversation:null,messages:[],latestCursor:0,supportAiAvailable:true});await reading;
  expect(p.data.conversation).toEqual(conversation);expect(p.data.messages.map((row:any)=>row.senderType)).toEqual(['user','ai']);
 });
 it('keeps a real send thinking through a failed handoff without silently resubmitting the human request',async()=>{
  const response=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?response.promise:input.path==='/v1/me/support/handoff'?Promise.reject(new Error('synthetic failure')):Promise.resolve({}));
  const sending=p.send();await p.requestHuman();expect(p.data.aiReplyWaiting).toBe(true);expect(p.data.handoffFailed).toBe(true);
  response.resolve({conversation,message:message('user',1),aiMessages:[{...message('system',2),body:'这个问题需要人工核对，可点击申请人工客服。'}],aiStatus:'handoff_suggested',handoffSuggested:true});await sending;
  expect(p.data.conversation.status).toBe('ai_active');expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.messages.map((row:any)=>row.senderType)).toEqual(['user','system']);
  expect(m.request.mock.calls.filter(([input])=>input.path==='/v1/me/support/handoff')).toHaveLength(1);
 });
 it('adds the persisted AI answer immediately while preserving the synchronization cursor for server polling',async()=>{
  m.request.mockImplementation(async(input:any)=>input.path==='/v1/me/support/messages'?{conversation,message:message('user',1),aiMessages:[message('ai',2)],aiStatus:'replied'}:{});
  await p.send();expect(p.data.messages.map((row:any)=>row.senderType)).toEqual(['user','ai']);expect(p.data.syncCursor).toBe(0);
  expect(p.data.input).toBe('');expect(p.data.sendAttempt).toBeNull();expect(p.data.pendingMessage).toBeNull();
 });
 it('acknowledges a saved member message despite pending AI and keeps a real handoff recovery',async()=>{
  m.request.mockImplementation(async(input:any)=>input.path==='/v1/me/support/messages'?{conversation,message:message('user',1),aiStatus:'pending',aiMessages:[]}:input.path==='/v1/me/support/handoff'?{...conversation,status:'waiting_human',version:4}:{});
  await p.send();expect(p.data.messages).toHaveLength(1);expect(p.data.pendingMessage).toBeNull();expect(p.data.error).toContain('消息已收到');expect(p.data.errorAction).toBe('handoff');
  expect(p.data.aiReplyWaiting).toBe(false);
  await p.retryHandoff();await Promise.resolve();expect(m.request).toHaveBeenCalledWith(expect.objectContaining({path:'/v1/me/support/handoff',method:'POST'}));
 });
 it.each(['waiting_human','human_active'])('answers a basic question during %s without switching modes or ending the human request',async(status)=>{
  const active={...conversation,status,version:7};p.data.conversation=active;p.data.supportAiCanRespond=true;
  const response=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?response.promise:Promise.resolve({}));
  const sending=p.send();expect(p.data.aiReplyWaiting).toBe(true);
  response.resolve({conversation:active,message:message('user',1),aiMessages:[message('ai',2)],aiStatus:'replied',supportAiCanRespond:true});await sending;
  expect(p.data.conversation).toEqual(active);expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.messages.map((row:any)=>row.senderType)).toEqual(['user','ai']);
  expect(m.request.mock.calls.some(([input])=>input.path.includes('resume-ai'))).toBe(false);expect(wx.showModal).not.toHaveBeenCalled();
 });
 it.each(['waiting_human','human_active'])('does not submit another human request when the conversation is %s',async(status)=>{
  p.data.conversation={...conversation,status};await p.requestHuman();await p.retryHandoff();expect(m.request).not.toHaveBeenCalled();
 });
 it.each([false,true])('pins the confirmed handoff source through a pending send and retry (known source: %s)',async(known)=>{
  p.data.messages=known?[message('user',1)]:[];
  p.data.pendingMessage={...message('user',2),id:'local-unknown-send'};
  p.data.sendAttempt={id:'unknown-send',body:'not yet confirmed',mediaIds:[],linkedOrderId:null};
  let requests=0;m.request.mockImplementation(input=>input.path==='/v1/me/support/handoff'
    ?++requests===1?Promise.reject({code:'NETWORK_TIMEOUT'}):Promise.resolve({...conversation,status:'waiting_human',version:4}):Promise.resolve({}));
  await p.requestHuman();expect(p.data.handoffFailed).toBe(true);
  const first=m.request.mock.calls.find(([input])=>input.path==='/v1/me/support/handoff')![0].data;
  expect(first.questionMessageId).toBe(known?'synthetic-user-1':null);
  p.data.messages.push(message('user',3));await p.requestHuman();
  const handoffs=m.request.mock.calls.filter(([input])=>input.path==='/v1/me/support/handoff');expect(handoffs).toHaveLength(2);expect(handoffs[1]![0].data).toEqual(first);expect(p.data.handoffAttempt).toBeNull();
 });
 it('uses the server collaboration capability after an uncertain handoff without asking the user to switch',async()=>{
  const waiting={...conversation,status:'waiting_human',version:4};
  m.request.mockImplementation(input=>input.path==='/v1/me/support/handoff'?Promise.reject({code:'NETWORK_TIMEOUT'}):Promise.resolve({}));
  await p.requestHuman();expect(p.data.handoffFailed).toBe(true);
  m.read.mockResolvedValueOnce({conversation:waiting,messages:[],latestCursor:0,supportAiAvailable:true,supportAiCanRespond:true});await p.poll();
  const response=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?response.promise:Promise.resolve({}));
  const sending=p.send();expect(p.data.aiReplyWaiting).toBe(true);
  response.resolve({conversation:waiting,message:message('user',1),aiMessages:[message('ai',2)],aiStatus:'replied'});await sending;
  expect(p.data.conversation.status).toBe('waiting_human');expect(p.data.messages.map((row:any)=>row.senderType)).toEqual(['user','ai']);
 });
 it('uses a refresh recovery for an unconfirmed AI reply during human service instead of another handoff',async()=>{
  const active={...conversation,status:'human_active',version:7};Object.assign(p.data,{conversation:active,supportAiCanRespond:true});
  m.request.mockImplementation(async input=>input.path==='/v1/me/support/messages'?{conversation:active,message:message('user',1),aiMessages:[],aiStatus:'pending'}:{});
  await p.send();expect(p.data.errorAction).toBe('sync');expect(p.data.error).not.toContain('申请人工');expect(p.data.pendingMessage).toBeNull();expect(p.data.sendAttempt).toBeNull();
 });
 it('does not expose a manual AI mode switching method',()=>{expect(p.resumeAi).toBeUndefined();});
});

describe('native current-topic welcome remains a presentation prefix',()=>{
 it('keeps one welcome through pending, unknown result, successful retry, human states and re-entry without inventing messages',async()=>{
  p.data.conversation=null;m.read.mockResolvedValue(historyPage({conversation:null}));await p.load();
  expect(welcomeCount()).toBe(1);expect(p.data.messages).toEqual([]);expect(p.data.readCursor).toBe(0);expect(m.request).not.toHaveBeenCalled();
  const first=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?first.promise:Promise.resolve({}));
  const sending=p.send();expect(p.data.pendingMessage).not.toBeNull();expect(welcomeCount()).toBe(1);
  first.reject({code:'NETWORK_TIMEOUT'});await sending;
  const originalAttempt=p.data.sendAttempt.id;expect(p.data.pendingMessage.deliveryLabel).toBe('结果待核对');expect(welcomeCount()).toBe(1);
  const retry=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?retry.promise:Promise.resolve({}));
  const retrying=p.send();expect(welcomeCount()).toBe(1);
  retry.resolve(historyPage({message:message('user',1),aiMessages:[message('ai',2)],aiStatus:'replied'}));await retrying;
  expect(welcomeCount()).toBe(1);expect(p.data.messages.map((item:any)=>item.id)).toEqual(['synthetic-user-1','synthetic-ai-2']);
  expect(p.data).toMatchObject({readCursor:2,maxSeenSequence:2,pendingMessage:null,sendAttempt:null});
  const posts=m.request.mock.calls.filter(([input])=>input.path==='/v1/me/support/messages');expect(posts).toHaveLength(2);
  expect(posts.every(([input])=>input.data.clientMessageId===originalAttempt&&input.data.body==='护理如何保存？')).toBe(true);
  expect(JSON.stringify(m.request.mock.calls)).not.toContain('你好呀');
  for(const [index,status] of ['waiting_human','human_active','resolved'].entries()){
   m.read.mockResolvedValue(historyPage({conversation:{...conversation,status,version:4+index},latestCursor:2}));await p.poll();
   expect(p.data.conversation.status).toBe(status);expect(welcomeCount()).toBe(1);expect(p.data.messages).toHaveLength(2);
  }
  p.onHide();p.onShow();await settlePage();expect(welcomeCount()).toBe(1);expect(p.data.messages).toHaveLength(2);expect(p.data.conversation.status).toBe('resolved');
  expect(m.request.mock.calls.filter(([input])=>input.path==='/v1/me/support/messages')).toHaveLength(2);
 });
 it('keeps a successfully loaded prefix while a retry read is pending or fails, but never fabricates one on an initial failure or in closed-rights support',async()=>{
  p.data.conversation=null;m.read.mockRejectedValueOnce(new Error('initial read failure'));await p.load();expect(welcomeCount()).toBe(0);
  m.read.mockResolvedValueOnce(historyPage({conversation:null}));await p.load();expect(welcomeCount()).toBe(1);
  const retry=deferred();m.read.mockReturnValueOnce(retry.promise);const loading=p.load();expect(p.data.loading).toBe(true);expect(welcomeCount()).toBe(1);
  retry.reject(new Error('retry read failure'));await loading;expect(welcomeCount()).toBe(1);expect(p.data.errorAction).toBe('sync');
  p.data.closedRights=true;expect(welcomeCount()).toBe(0);expect(p.data.messages).toEqual([]);expect(m.request).not.toHaveBeenCalled();
 });
 it('does not place the welcome before a recent fifty-message window and reveals it only after loading the topic head without changing the reading anchor',async()=>{
  const latest=Array.from({length:50},(_,index)=>message('user',51+index));
  m.read.mockResolvedValueOnce(historyPage({messages:latest,latestCursor:100,olderCursor:51}));await p.load();
  expect(welcomeCount()).toBe(0);expect(p.data.historyStartLoaded).toBe(false);
  m.read.mockResolvedValueOnce(historyPage({messages:Array.from({length:40},(_,index)=>message('user',11+index)),olderCursor:11,latestCursor:50}));await p.loadOlder();
  expect(welcomeCount()).toBe(0);expect(p.data.anchor).toBe('support-51');
  m.read.mockResolvedValueOnce(historyPage({messages:Array.from({length:10},(_,index)=>message('user',1+index)),olderCursor:null,latestCursor:10}));await p.loadOlder();
  expect(welcomeCount()).toBe(1);expect(p.data.anchor).toBe('support-11');expect(p.data.messages).toHaveLength(100);
  expect(p.data.messages[0].sequence).toBe(1);expect(p.data.readCursor).toBe(0);expect(p.data.syncCursor).toBe(100);
  expect(m.request.mock.calls.some(([input])=>input.path==='/v1/me/support/messages')).toBe(false);
 });
 it('does not mistake a high-sequence first ACK or a late empty full read for the topic head',async()=>{
  p.data.conversation=null;m.read.mockResolvedValueOnce(historyPage({conversation:null}));await p.load();expect(welcomeCount()).toBe(1);
  const oldEmpty=deferred();m.read.mockReturnValueOnce(oldEmpty.promise);const loading=p.load();
  m.request.mockImplementation(async input=>input.path==='/v1/me/support/messages'
   ?historyPage({conversation:{...conversation,version:101},message:message('user',99),aiMessages:[message('ai',100)]}):{});
  await p.send();expect(p.data.messages.map((item:any)=>item.sequence)).toEqual([99,100]);expect(welcomeCount()).toBe(0);
  oldEmpty.resolve(historyPage({conversation:{...conversation,version:90},messages:[],olderCursor:null}));await loading;
  expect(p.data.conversation.version).toBe(101);expect(p.data.messages.map((item:any)=>item.sequence)).toEqual([99,100]);expect(welcomeCount()).toBe(0);
  m.read.mockResolvedValueOnce(historyPage({conversation:{...conversation,version:101},messages:Array.from({length:50},(_,index)=>message('user',index+1)),latestCursor:50}));await p.poll();
  expect(p.data.messages[0].sequence).toBe(1);expect(welcomeCount()).toBe(1);
 });
 it('revokes an empty same-conversation topic-head proof when its first ACK skips unseen current-topic messages',async()=>{
  const emptyTopic=historyPage({conversation:{...conversation,version:8},contextVersion:8,contextStartSequence:4,latestCursor:4});
  m.read.mockResolvedValueOnce(emptyTopic);await p.load();expect(welcomeCount()).toBe(1);expect(p.data.messages).toEqual([]);
  p.updateInput({detail:{value:'护理如何保存？'}});
  const oldEmpty=deferred();m.read.mockReturnValueOnce(oldEmpty.promise);const loading=p.load();
  // Another device already sent sequences5..98 in the same current topic.
  m.request.mockImplementation(async input=>input.path==='/v1/me/support/messages'
   ?historyPage({conversation:{...conversation,version:105},contextVersion:8,contextStartSequence:4,
     message:message('user',99),aiMessages:[message('ai',100)]}):{});
  await p.send();expect(p.data.conversation.id).toBe(conversation.id);expect(p.data.contextVersion).toBe(8);
  expect(p.data.messages.map((item:any)=>item.sequence)).toEqual([99,100]);expect(welcomeCount()).toBe(0);
  oldEmpty.resolve(emptyTopic);await loading;
  expect(p.data.conversation.version).toBe(105);expect(p.data.historyStartLoaded).toBe(false);expect(welcomeCount()).toBe(0);
  m.read.mockResolvedValueOnce(historyPage({conversation:{...conversation,version:105},contextVersion:8,contextStartSequence:4,
   messages:Array.from({length:50},(_,index)=>message('user',index+5)),latestCursor:54}));await p.poll();
  expect(m.read).toHaveBeenLastCalledWith(p,expect.objectContaining({path:'/v1/me/support/messages?after=4&limit=50'}));
  expect(p.data.messages[0].sequence).toBe(5);expect(p.data.historyStartLoaded).toBe(true);expect(welcomeCount()).toBe(1);
 });
 it.each(['history','poll'])('keeps a new-topic prefix and empty history when a retired %s response arrives late',async(kind)=>{
  m.read.mockResolvedValueOnce(historyPage({messages:[message('user',51)],latestCursor:51,olderCursor:51}));await p.load();expect(welcomeCount()).toBe(0);
  const old=deferred();m.read.mockReturnValueOnce(old.promise);const reading=kind==='history'?p.loadOlder():p.poll();
  m.request.mockImplementation(async input=>input.path==='/v1/me/support/new-topic'
   ?historyPage({conversation:{...conversation,version:4},contextVersion:4,contextStartSequence:51,latestCursor:51}):{});
  await p.startNewTopic();expect(welcomeCount()).toBe(1);expect(p.data.messages).toEqual([]);
  old.resolve(historyPage({messages:[message('user',1)],latestCursor:51,olderCursor:null}));await reading;
  expect(p.data).toMatchObject({contextVersion:4,contextStartSequence:51,historyStartLoaded:true});expect(p.data.messages).toEqual([]);expect(welcomeCount()).toBe(1);
 });
 it('does not restore an old message or old head state when an ACK arrives after a newer topic was loaded',async()=>{
  m.read.mockResolvedValueOnce(historyPage({messages:[message('user',1)],latestCursor:1}));await p.load();expect(welcomeCount()).toBe(1);
  const old=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?old.promise:Promise.resolve({}));const sending=p.send();
  m.read.mockResolvedValueOnce(historyPage({conversation:{...conversation,version:5},contextVersion:5,contextStartSequence:2,latestCursor:2}));await p.load();
  expect(p.data.messages).toEqual([]);expect(welcomeCount()).toBe(1);
  old.resolve(historyPage({message:message('user',2),aiMessages:[message('ai',3)]}));await sending;
  expect(p.data.contextVersion).toBe(5);expect(p.data.messages).toEqual([]);expect(welcomeCount()).toBe(1);
 });
 it('clears the previous identity head proof immediately and rejects its late history before loading the new identity',async()=>{
  m.read.mockResolvedValueOnce(historyPage({messages:[message('user',1)],latestCursor:1}));await p.load();expect(welcomeCount()).toBe(1);
  const old=deferred(),fresh=deferred();m.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);const reading=p.load();
  m.token='synthetic-other-member';m.retain=false;p.onShow();expect(p.data.historyStartLoaded).toBe(false);expect(welcomeCount()).toBe(0);
  old.resolve(historyPage({messages:[message('user',1)],latestCursor:1}));await reading;expect(welcomeCount()).toBe(0);expect(p.data.messages).toEqual([]);
  fresh.resolve(historyPage({conversation:null}));await settlePage();expect(welcomeCount()).toBe(1);expect(p.data.conversation).toBeNull();expect(p.data.messages).toEqual([]);
 });
 it('rechecks the topic head after an empty-page handoff assigns a previously unknown conversation ID',async()=>{
  p.data.conversation=null;m.read.mockResolvedValueOnce(historyPage({conversation:null}));await p.load();expect(welcomeCount()).toBe(1);
  m.request.mockResolvedValueOnce({...conversation,status:'waiting_human',version:1});await p.requestHuman();
  expect(p.data.conversation.status).toBe('waiting_human');expect(p.data.messages).toEqual([]);expect(welcomeCount()).toBe(0);
  m.read.mockResolvedValueOnce(historyPage({conversation:{...conversation,status:'waiting_human',version:1}}));await p.poll();
  expect(welcomeCount()).toBe(1);expect(p.data.messages).toEqual([]);
  expect(m.request.mock.calls.filter(([input])=>input.path==='/v1/me/support/handoff')).toHaveLength(1);
  expect(m.request.mock.calls.some(([input])=>input.path==='/v1/me/support/messages')).toBe(false);
 });
});

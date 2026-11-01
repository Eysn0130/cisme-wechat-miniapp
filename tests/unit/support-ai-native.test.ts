import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
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
describe('native AI support receipts and explicit switching',()=>{
 it('measures a newly loaded composer action after render and skips unchanged polls',async()=>{
  Object.assign(p.data,{loading:true,conversation:null,supportAiAvailable:false});const ticks=captureComposerMeasurements(),response=deferred();m.read.mockReturnValueOnce(response.promise);
  const loading=p.load();expect(ticks).toHaveLength(0);
  response.resolve({conversation,messages:[],latestCursor:0,supportAiAvailable:true});await loading;
  expect(ticks).toHaveLength(1);expect(p.measureComposer).not.toHaveBeenCalled();ticks.shift()!();expect(p.measureComposer).toHaveBeenCalledOnce();
  await p.poll();expect(ticks).toHaveLength(0);
 });
 it('remeasures queue action visibility after AI availability changes, not on every queue version',async()=>{
  const waiting={...conversation,status:'waiting_human',version:4};p.data.conversation=waiting;const ticks=captureComposerMeasurements();
  m.read.mockResolvedValueOnce({conversation:waiting,messages:[],latestCursor:0,supportAiAvailable:false});await p.poll();
  expect(ticks).toHaveLength(1);ticks.shift()!();
  m.read.mockResolvedValueOnce({conversation:{...waiting,version:5},messages:[],latestCursor:0,supportAiAvailable:false});await p.poll();expect(ticks).toHaveLength(0);
  m.read.mockResolvedValueOnce({conversation:{...waiting,version:6},messages:[],latestCursor:0,supportAiAvailable:true});await p.poll();expect(ticks).toHaveLength(1);
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
 it.each(['disabled','human','attachment','unknown','unconfirmed-handoff'])('does not claim AI waiting for a %s send',async(mode)=>{
  if(mode==='disabled')p.data.supportAiAvailable=false;
  if(mode==='human')p.data.conversation={...conversation,status:'human_active'};
  if(mode==='attachment')p.data.selectedImage={mediaId:'synthetic-image',status:'ready',mimeType:'image/jpeg',size:10,localPath:'/tmp/synthetic'};
  if(mode==='unknown')p.data.sendAttempt={id:'synthetic-retry-key',body:p.data.input,mediaIds:[],linkedOrderId:null,signature:'retained-signature'};
  if(mode==='unconfirmed-handoff')p.data.handoffFailed=true;
  const response=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?response.promise:Promise.resolve({}));
  const sending=p.send();expect(p.data.aiReplyWaiting).toBe(false);
  response.resolve({conversation:p.data.conversation,message:message('user',1)});await sending;
  if(mode==='unknown')expect(m.request).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({clientMessageId:'synthetic-retry-key'})}));
  if(mode==='unconfirmed-handoff')expect(p.data.handoffFailed).toBe(true);
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
  const requesting=p.requestHuman();expect(p.data.aiReplyWaiting).toBe(false);
  const waiting={...conversation,status:'waiting_human',version:4};handoff.resolve(waiting);await requesting;
  response.resolve({conversation,message:message('user',1),aiStatus:'pending',aiMessages:[]});await sending;
  expect(p.data.conversation).toEqual(waiting);expect(p.data.statusLabel).toBe('等待人工客服');expect(p.data.messages.map((row:any)=>row.id)).toEqual(['synthetic-user-1']);
  expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.error).toBe('');expect(p.data.sendAttempt).toBeNull();
 });
 it('accepts a new message while handoff is pending without restarting AI waiting or regressing its later queue receipt',async()=>{
  const handoff=deferred(),response=deferred();
  m.request.mockImplementation(input=>input.path==='/v1/me/support/handoff'?handoff.promise:input.path==='/v1/me/support/messages'?response.promise:Promise.resolve({}));
  const requesting=p.requestHuman();expect(p.data.handoffBusy).toBe(true);
  const sending=p.send();expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.sending).toBe(true);
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
 it('does not restart thinking after a failed explicit handoff or silently queue a handoff suggestion',async()=>{
  const response=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/messages'?response.promise:input.path==='/v1/me/support/handoff'?Promise.reject(new Error('synthetic failure')):Promise.resolve({}));
  const sending=p.send();await p.requestHuman();expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.handoffFailed).toBe(true);
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
 it('switches a waiting conversation only after explicit confirmation with its current version',async()=>{
  p.data.conversation={...conversation,status:'waiting_human',version:7};p.data.supportAiAvailable=true;
  m.request.mockImplementation(async(input:any)=>input.path==='/v1/me/support/resume-ai'?conversation:{});
  await p.resumeAi();expect(wx.showModal).toHaveBeenCalledOnce();expect(m.request).toHaveBeenCalledWith(expect.objectContaining({path:'/v1/me/support/resume-ai',method:'POST',data:{expectedVersion:7}}));
 });
 it('restores AI waiting after a timed-out handoff is observed in the queue and explicitly resumed',async()=>{
  const waiting={...conversation,status:'waiting_human',version:4},resumed={...conversation,version:5},response=deferred();
  m.request.mockImplementation(input=>input.path==='/v1/me/support/handoff'?Promise.reject({code:'NETWORK_TIMEOUT'}):input.path==='/v1/me/support/resume-ai'?Promise.resolve(resumed):input.path==='/v1/me/support/messages'?response.promise:Promise.resolve({}));
  await p.requestHuman();expect(p.data.handoffFailed).toBe(true);
  m.read.mockResolvedValueOnce({conversation:waiting,messages:[],latestCursor:0,supportAiAvailable:true});await p.poll();
  expect(p.data.conversation.status).toBe('waiting_human');expect(p.data.handoffFailed).toBe(true);
  m.read.mockResolvedValueOnce({conversation:resumed,messages:[],latestCursor:0,supportAiAvailable:true});await p.resumeAi();
  expect(p.data.conversation).toEqual(resumed);expect(p.data.handoffFailed).toBe(false);
  const sending=p.send();expect(p.data.aiReplyWaiting).toBe(true);
  response.resolve({conversation:resumed,message:message('user',1),aiMessages:[message('ai',2)],aiStatus:'replied'});await sending;
  expect(p.data.aiReplyWaiting).toBe(false);expect(p.data.messages.map((row:any)=>row.senderType)).toEqual(['user','ai']);
 });
 it.each(['cancelled','failed','newer-human'])('retains an unconfirmed handoff when explicit AI switching is %s',async(mode)=>{
  p.data.conversation={...conversation,status:'waiting_human',version:7};p.data.handoffFailed=true;
  if(mode==='cancelled')(wx.showModal as any).mockResolvedValueOnce({confirm:false});
  if(mode==='failed')m.request.mockImplementation(input=>input.path==='/v1/me/support/resume-ai'?Promise.reject(new Error('synthetic failure')):Promise.resolve({}));
  if(mode==='newer-human'){
    const response=deferred();m.request.mockImplementation(input=>input.path==='/v1/me/support/resume-ai'?response.promise:Promise.resolve({}));
    const resuming=p.resumeAi();await Promise.resolve();p.data.conversation={...conversation,status:'human_active',version:9};
    response.resolve({...conversation,version:8});await resuming;
  }else await p.resumeAi();
  expect(p.data.handoffFailed).toBe(true);expect(p.data.aiReplyWaiting).toBe(false);
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

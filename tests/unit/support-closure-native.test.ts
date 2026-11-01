import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const m=vi.hoisted(()=>({token:'synthetic-session',request:vi.fn(),read:vi.fn(),modal:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,requireMemberAccess:()=>true,retainMemberSnapshot:()=>true,
 historicalCommerceToken:()=>m.token,historicalCommerceClosed:()=>false,requireHistoricalCommerceAccess:()=>true,
 downloadPrivateMedia:vi.fn(),uploadAuthorized:vi.fn()}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:m.read,cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>0}));
vi.mock('../../apps/miniprogram/services/authority',()=>({authorityProjection:vi.fn(),hasCapability:()=>true}));

const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const question={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',sequence:1,senderType:'user',body:'请核对我的退款事项',attachments:[],orderCard:null,createdAt:'2026-11-01T00:00:00Z'};
const conversation={id,status:'human_active',version:7};
const humanRequest={generation:1,status:'human_active',anchorKnown:true,anchorMessageId:question.id,anchorSequence:1,anchorSummary:question.body};
let operatorDefinition:any,consumerDefinition:any,server:any;
function mount(definition:any,overrides:any={}){
 return {...definition,data:{...structuredClone(definition.data),...overrides},setData(patch:any){Object.assign(this.data,structuredClone(patch));}};
}
function operator(extra:any={}){return mount(operatorDefinition,{id,pageAlive:true,visible:true,loading:false,canReply:true,canManageAftersale:true,assignedToMe:true,
 conversation:{...conversation},humanRequest:{...humanRequest},humanIssueSummary:question.body,messages:[{...question}],input:'当前回复草稿',
 replyTarget:{id:question.id,sequence:1,summary:question.body,generation:1,contextVersion:0},...extra});}
function consumer(extra:any={}){return mount(consumerDefinition,{pageAlive:true,visible:true,loading:false,historyLoaded:true,
 conversation:{...conversation},messages:[{...question}],newTopicAvailable:true,supportAiAvailable:false,supportAiCanRespond:false,...extra});}
function receipt(){return {conversation:{...server},messages:[{...question}],latestCursor:1,olderCursor:null,contextVersion:0,contextStartSequence:0,
 humanRequest:server.status==='human_active'?{...humanRequest}:null,newTopicAvailable:true,supportAiAvailable:false,supportAiCanRespond:false,assignedToMe:true};}
function deferred(){let resolve!:(value:any)=>void;const promise=new Promise<any>(yes=>{resolve=yes;});return {resolve,promise};}

beforeEach(async()=>{
 vi.resetModules();vi.useFakeTimers();m.request.mockReset();m.read.mockReset();m.modal.mockReset();server={...conversation};
 vi.stubGlobal('getApp',()=>({globalData:{sessionToken:m.token}}));
 let captured:any;vi.stubGlobal('Page',(definition:any)=>{captured=definition;});
 vi.stubGlobal('wx',{nextTick:(callback:()=>void)=>callback(),showModal:m.modal,showToast:vi.fn(),getStorageSync:vi.fn()});
 await import('../../apps/miniprogram/pages/management-support-chat/index');operatorDefinition=captured;
 await import('../../apps/miniprogram/pages/support/index');consumerDefinition=captured;
 // Enforce the native API's four-character limit instead of accepting invalid
 // parameters as the former unconditional resolved modal fixture did.
 m.modal.mockImplementation(async(options:any)=>{
  for(const field of ['confirmText','cancelText'])if(options[field]!==undefined&&Array.from(options[field]).length>4)
   throw new Error(`showModal:fail ${field} length should not exceed 4 chars`);
  return {confirm:true,cancel:false};
 });
 m.read.mockImplementation(async(_page:any,input:any)=>input.path.endsWith('/aftersales')?{items:[]}:receipt());
 m.request.mockImplementation(async(input:any)=>{
  if(input.path.endsWith('/resolve')){
   if(input.data.expectedVersion!==server.version)throw {status:409,code:'VERSION_CONFLICT'};
   server={...server,status:'resolved',version:server.version+1};return {...server};
  }
  if(input.path==='/v1/me/support/new-topic'){
   expect(server.status).toBe('resolved');expect(input.data.expectedVersion).toBe(server.version);
   server={...server,status:'ai_active',version:server.version+1};
   return {...receipt(),messages:[],contextStartSequence:1,contextVersion:server.version};
  }
  return {};
 });
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

const modalKinds=['resolve','select-target','approve-return','return-instruction','new-topic','human-new-topic'] as const;
function invoke(kind:typeof modalKinds[number]){
 const p=kind==='new-topic'?consumer({conversation:{...conversation,status:'resolved'}}):kind==='human-new-topic'?consumer():operator();
 if(kind==='resolve')return {p,run:()=>p.resolve()};
 if(kind==='select-target'){
  p.data.messages.push({...question,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',sequence:2,body:'另一个问题'});
  return {p,run:()=>p.selectReplyTarget({currentTarget:{dataset:{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}}})};
 }
 if(kind==='approve-return'){
  p.data.aftersaleCases=[{id:'synthetic-case',state:'requested',kind:'return_refund',version:1}];
  return {p,run:()=>p.approveReturn({currentTarget:{dataset:{id:'synthetic-case'}}})};
 }
 if(kind==='return-instruction'){
  p.data.aftersaleCases=[{id:'synthetic-case',state:'awaiting_instruction',kind:'return_refund',version:1}];p.data.returnFormCaseId='synthetic-case';
  p.data.returnForm={recipientName:'合成收件人',phone:'13800000000',region:'合成地区',address:'合成地址',freightPayer:'merchant',instructions:''};
  return {p,run:()=>p.sendReturnInstruction()};
 }
 return {p,run:()=>p.startNewTopic()};
}

describe('native support resolution and modal recovery',()=>{
 it.each(modalKinds)('keeps every %s modal within WeChat button-label limits',async(kind)=>{
  m.modal.mockImplementationOnce(async(options:any)=>{
   expect(Array.from(options.confirmText??'确定').length).toBeLessThanOrEqual(4);
   expect(Array.from(options.cancelText??'取消').length).toBeLessThanOrEqual(4);
   return {confirm:false,cancel:true};
  });
  await invoke(kind).run();expect(m.modal).toHaveBeenCalledOnce();expect(m.request).not.toHaveBeenCalled();
 });
 it.each(modalKinds)('preserves current facts and drafts when the %s modal cannot open',async(kind)=>{
  const {p,run}=invoke(kind),before=structuredClone({input:p.data.input,messages:p.data.messages,replyTarget:p.data.replyTarget,returnForm:p.data.returnForm,conversation:p.data.conversation});
  m.modal.mockRejectedValueOnce(new Error('showModal:fail native window unavailable'));await expect(run()).resolves.toBeUndefined();
  expect(m.request).not.toHaveBeenCalled();expect(p.data.input).toBe(before.input);expect(p.data.messages).toEqual(before.messages);
  expect(p.data.conversation).toEqual(before.conversation);expect(p.data.replyTarget).toEqual(before.replyTarget);expect(p.data.returnForm).toEqual(before.returnForm);
  expect(p.data.error||p.data.aftersaleError).toContain('暂时无法打开');expect(p.data.newTopicAttempt??null).toBeNull();
  expect(p.data.error||'').not.toContain('结果待确认');expect(p.data.newTopicBusy??false).toBe(false);
 });
 it('recovers an unopened resolve confirmation and completes admin resolution followed by a consumer new conversation with AI offline',async()=>{
  const admin=operator(),member=consumer();
  m.modal.mockRejectedValueOnce(new Error('showModal:fail native window unavailable'));await admin.resolve();
  expect(server.status).toBe('human_active');expect(m.request).not.toHaveBeenCalled();expect(admin.data.input).toBe('当前回复草稿');
  await admin.resolve();expect(server.status).toBe('resolved');expect(admin.data).toMatchObject({assignedToMe:false,humanRequest:null,replyTarget:null,input:'',busy:false});
  await member.poll();expect(member.data.conversation.status).toBe('resolved');expect(member.data.supportAiAvailable).toBe(false);expect(member.composerControlKey()).toContain(':topic');
  await member.startNewTopic();expect(member.data.messages).toEqual([]);expect(member.data.contextStartSequence).toBe(1);expect(member.data.conversation.status).toBe('ai_active');
  expect(m.request.mock.calls.filter(([input])=>input.path.endsWith('/resolve'))).toHaveLength(1);
  expect(m.request.mock.calls.filter(([input])=>input.path==='/v1/me/support/new-topic')).toHaveLength(1);
 });
 it('does not resolve a newer version that appeared while the confirmation was open',async()=>{
  const admin=operator(),modal=deferred();m.modal.mockReturnValueOnce(modal.promise);const resolving=admin.resolve();
  admin.data.conversation={...conversation,version:8};modal.resolve({confirm:true});await resolving;
  expect(m.request).not.toHaveBeenCalled();expect(admin.data.conversation.version).toBe(8);expect(admin.data.input).toBe('当前回复草稿');expect(admin.data.error).toContain('会话已变化');
 });
 it('keeps an unknown reply command intact and requires verification before resolving',async()=>{
  const attempt={id:'unknown-reply',body:'待核对的原回复',replyToMessageId:question.id,expectedHumanRequestGeneration:1,contextVersion:0};
  const admin=operator({sendAttempt:attempt,pendingMessage:{body:attempt.body,deliveryLabel:'结果待核对'}});
  await admin.resolve();expect(m.modal).not.toHaveBeenCalled();expect(m.request).not.toHaveBeenCalled();
  expect(admin.data.sendAttempt).toEqual(attempt);expect(admin.data.pendingMessage.deliveryLabel).toBe('结果待核对');expect(admin.data.error).toContain('请先核对上条回复');
 });
 it.each(['human-generation','topic-context'])('resynchronizes a late resolve acknowledgement without clearing the newer %s draft',async(change)=>{
  const admin=operator(),reply=deferred();m.request.mockImplementation(input=>input.path.endsWith('/resolve')?reply.promise:Promise.resolve({}));
  const resolving=admin.resolve();await Promise.resolve();await Promise.resolve();
  expect(m.request).toHaveBeenCalledWith(expect.objectContaining({path:expect.stringContaining('/resolve'),data:{expectedVersion:7}}));
  const contextVersion=change==='topic-context'?9:0,generation=change==='human-generation'?2:1;
  const newQuestion={...question,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',sequence:2,body:'新的人工事项'};
  const newHuman={...humanRequest,generation,anchorMessageId:newQuestion.id,anchorSequence:2,anchorSummary:newQuestion.body};
  const target={id:newQuestion.id,sequence:2,summary:newQuestion.body,generation,contextVersion};
  admin.setData({conversation:{...conversation,version:10},humanRequest:newHuman,humanIssueSummary:newQuestion.body,contextVersion,
    contextStartSequence:contextVersion?1:0,replyTarget:target,input:'新事项的人工回复草稿',messages:[newQuestion],busy:false});
  m.read.mockResolvedValueOnce({conversation:{...conversation,version:10},humanRequest:newHuman,assignedToMe:true,contextVersion,contextStartSequence:contextVersion?1:0,
    messages:[newQuestion],latestCursor:2,olderCursor:null});
  reply.resolve({...conversation,status:'resolved',version:8});await resolving;
  expect(m.read).toHaveBeenCalledOnce();expect(admin.data).toMatchObject({conversation:{status:'human_active',version:10},humanRequest:newHuman,
    replyTarget:target,input:'新事项的人工回复草稿',assignedToMe:true,contextVersion,busy:false});
 });
});

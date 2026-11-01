import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,resetDatabase,testPool} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {AuthorityService} from '../../services/api/src/authority';
import {PlatformService} from '../../services/api/src/platformService';
import {SupportService} from '../../services/api/src/supportService';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {ApprovedKnowledgeRegistry,SupportAiBoundary,type SupportAiSuggestion} from '../../services/api/src/supportAiBoundary';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'synthetic-ai-chat-session',UPLOAD_TOKEN_SECRET:'synthetic-ai-chat-upload',OBJECT_STORAGE_DRIVER:'api_gateway',API_RATE_LOGIN_MAX:'200'});
const storage=createApiGatewayStorage(config);
const source={id:'synthetic.support-guide',version:'1',title:'Synthetic support guide',content:'按00到03步骤护理，再保存感受。',approved:true as const,sha256:createHash('sha256').update('按00到03步骤护理，再保存感受。').digest('hex')};
const reply:SupportAiSuggestion={text:'请按 00 到 03 顺序完成，再保存护理感受。',confidence:0.95,citations:[{sourceId:source.id,version:'1'}],handoffReason:null,route:'general'};
const suggest=vi.fn();
const boundary=new SupportAiBoundary({id:'synthetic-ai',available:true,suggest},new ApprovedKnowledgeRegistry([source]),4000,true);
const support=new SupportService(pool,new AuthorityService(pool,'test'),new PlatformService(pool,config,storage),storage,undefined,boundary);
let app:FastifyInstance,user:any,operator:any,serial=0;
const storedObjectKeys:string[]=[];
const auth=(token:string)=>({authorization:`Bearer ${token}`});
const identity=async(name:string)=>(await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:name,displayName:name,consents:[{documentType:'privacy',version:'v1'},{documentType:'terms',version:'v1'}]}})).json();
const send=(body='如何记录护理？',key='synthetic-message-01')=>support.sendMember(user.memberId,user.principalId,{body,clientMessageId:key},'synthetic-ai-trace');
const handoffEvents=async(id:string)=>(await pool.query("SELECT count(*)::int n FROM outbox_event WHERE aggregate_id=$1 AND event_type='support.conversation.handoff_requested.v1'",[id])).rows[0].n;
async function ownedOrder(){
 const address=(await pool.query(`INSERT INTO member_delivery_address(id,member_id,encrypted_payload,payload_hmac,key_version,label,client_request_key)
  VALUES(gen_random_uuid(),$1,'synthetic-private',$2,'synthetic','home',$3) RETURNING id`,[user.memberId,'a'.repeat(64),`ai-order-address-${serial}`])).rows[0];
 const quote=(await pool.query(`INSERT INTO commerce_checkout_quote(member_id,product_id,sku_id,address_id,address_version,quantity,currency,
  unit_price_cents,subtotal_cents,member_discount_cents,shipping_cents,total_cents,pricing_rule_version,product_version,sku_version,price_version,status,
  idempotency_key,request_hash,expires_at,consumed_at)
  VALUES($1,'c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001',$2,1,1,'CNY',10000,10000,0,0,10000,
   'synthetic-r1',1,1,1,'consumed',$3,$4,now()+interval '1 day',now()) RETURNING id`,
  [user.memberId,address.id,`ai-order-quote-${serial}`,'b'.repeat(64)])).rows[0];
 const order=(await pool.query(`INSERT INTO commerce_order(order_number,member_id,source_quote_id,currency,subtotal_cents,member_discount_cents,
  shipping_cents,total_cents,pricing_rule_version,expires_at) VALUES($1,$2,$3,'CNY',10000,0,0,10000,'synthetic-r1',now()+interval '1 day') RETURNING id`,
  [`CM20261030${String(serial).padStart(12,'0')}`,user.memberId,quote.id])).rows[0];
 await pool.query(`INSERT INTO commerce_order_line(order_id,line_number,product_id,sku_id,product_code,product_name,sku_code,sku_label,
  quantity,unit_price_cents,line_subtotal_cents,line_discount_cents,line_total_cents)
  VALUES($1,1,'c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','synthetic-ai-order','合成客服订单',
   'SYNTHETIC_AI_ORDER','合成规格',1,10000,10000,0,10000)`,[order.id]);
 return order.id as string;
}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
beforeAll(async()=>{
 await resetDatabase(pool);await storage.ensureReady();app=await createApp({config,pool,storage});operator=await identity('synthetic-support-operator');
 for(const capability of ['support.read','support.assign','support.reply'])await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
 VALUES($1,$2,'synthetic','AI handoff integration','test','integration_fixture')`,[operator.memberId,capability]);
});
beforeEach(async()=>{user=await identity(`synthetic-ai-user-${++serial}`);suggest.mockReset();suggest.mockResolvedValue(reply);});
afterAll(async()=>{for(const key of storedObjectKeys)await storage.delete(key);await app.close();await pool.end();});

describe('persistent AI support and manual handoff',()=>{
 it('keeps opening an empty support thread read-only without a greeting message or queue entry',async()=>{
  const page=await app.inject({method:'GET',url:'/v1/me/support/messages',headers:auth(user.sessionToken)});
  expect(page.statusCode).toBe(200);expect(page.json()).toMatchObject({conversation:null,messages:[]});
  expect((await pool.query('SELECT id FROM support_conversation WHERE member_id=$1',[user.memberId])).rowCount).toBe(0);
  expect(suggest).not.toHaveBeenCalled();
 });
 it('persists one grounded AI answer and replays the same member acknowledgement without duplicate AI calls',async()=>{
  const first=await send();expect(first).toMatchObject({replayed:false,conversation:{status:'ai_active'},aiStatus:'replied',aiMessages:[{senderType:'ai',body:reply.text,sequence:2}]});
  const again=await send();expect(again).toMatchObject({replayed:true,message:{id:first.message.id},conversation:{status:'ai_active'}});expect(suggest).toHaveBeenCalledTimes(1);
  const page=(await app.inject({method:'GET',url:'/v1/me/support/messages',headers:auth(user.sessionToken)})).json();
  expect(page.messages.map((m:any)=>m.senderType)).toEqual(['user','ai']);expect(page.messages.map((m:any)=>m.sequence)).toEqual([1,2]);
  const audit=(await pool.query("SELECT after_state FROM audit_log WHERE action='support.ai.reply' AND object_id=$1",[first.conversation.id])).rows[0].after_state;
  expect(audit).toMatchObject({inReplyTo:first.message.id,citations:reply.citations,confidence:0.95});expect(JSON.stringify(audit)).not.toContain('如何记录');
  expect(await handoffEvents(first.conversation.id)).toBe(0);
 });
 it('keeps explicit handoff in the same admin queue, discards late AI, and delivers the claimed administrator reply to the member',async()=>{
  const late=deferred<SupportAiSuggestion>();suggest.mockReturnValueOnce(late.promise);const pending=send();await vi.waitFor(()=>expect(suggest).toHaveBeenCalledOnce());
  const handoff=await support.requestHuman(user.memberId,user.principalId);expect(handoff.status).toBe('waiting_human');
  expect(await handoffEvents(handoff.id)).toBe(1);
  const queue=(await app.inject({method:'GET',url:'/v1/management/support/conversations',headers:auth(operator.sessionToken)})).json();expect(queue.items.some((row:any)=>row.id===handoff.id&&row.status==='waiting_human')).toBe(true);
  const claimed=await app.inject({method:'POST',url:`/v1/management/support/conversations/${handoff.id}/claim`,headers:auth(operator.sessionToken),payload:{expectedVersion:handoff.version}});expect(claimed.statusCode).toBe(200);
  suggest.mockResolvedValueOnce({...reply,route:'human_followup'});
  late.resolve(reply);await pending;
  expect((await pool.query("SELECT id FROM support_message WHERE conversation_id=$1 AND sender_type='ai'",[handoff.id])).rowCount).toBe(0);
  const manual=await app.inject({method:'POST',url:`/v1/management/support/conversations/${handoff.id}/messages`,headers:auth(operator.sessionToken),payload:{body:'您好，已收到您的问题，由我继续处理。',clientMessageId:'synthetic-human-reply-01',expectedHumanRequestGeneration:1,contextVersion:0}});expect(manual.statusCode).toBe(200);
  const page=(await app.inject({method:'GET',url:'/v1/me/support/messages?after=1',headers:auth(user.sessionToken)})).json();expect(page.conversation.status).toBe('human_active');expect(page.messages.map((m:any)=>m.senderType)).toEqual(['system','system','admin']);expect(page.messages.at(-1).body).toContain('由我继续处理');
  await expect(support.resumeAi(user.memberId,user.principalId,{expectedVersion:page.conversation.version},'synthetic')).rejects.toMatchObject({code:'SUPPORT_ALREADY_ASSIGNED'});
 });
 it.each(['failure','low-confidence','handoff','invalid-output'])('persists a safe invitation without entering the human queue on %s',async(mode)=>{
  if(mode==='failure')suggest.mockRejectedValueOnce(Object.assign(new Error('private upstream detail'),{code:'SUPPORT_AI_TIMEOUT'}));
  else suggest.mockResolvedValueOnce({...reply,text:'untrusted model reasoning',...(mode==='handoff'?{handoffReason:'Need a person'}:mode==='invalid-output'?{citations:[]}:{confidence:0.2})});
  const result=await send();expect(result).toMatchObject({conversation:{status:'ai_active'},aiStatus:'handoff_suggested',handoffSuggested:true,aiMessages:[{senderType:'system'}]});
  expect((result as any).aiMessages[0].body).toContain('申请人工');expect(JSON.stringify(result)).not.toMatch(/private upstream|untrusted model reasoning|Need a person|已转人工/);
  const stored=(await pool.query('SELECT sender_type FROM support_message WHERE conversation_id=$1 ORDER BY sequence',[result.conversation.id])).rows;expect(stored.map(row=>row.sender_type)).toEqual(['user','system']);
  expect(await handoffEvents(result.conversation.id)).toBe(0);
  const replay=await send();expect(replay).toMatchObject({replayed:true,message:{id:result.message.id},conversation:{status:'ai_active'}});
  expect((await pool.query('SELECT id FROM support_message WHERE conversation_id=$1',[result.conversation.id])).rowCount).toBe(2);
  const requested=await app.inject({method:'POST',url:'/v1/me/support/handoff',headers:auth(user.sessionToken)});
  expect(requested.statusCode).toBe(200);expect(requested.json().status).toBe('waiting_human');expect(await handoffEvents(result.conversation.id)).toBe(1);
  await app.inject({method:'POST',url:'/v1/me/support/handoff',headers:auth(user.sessionToken)});
  expect(await handoffEvents(result.conversation.id)).toBe(1);
 });
 it('keeps a first text question in AI routing even when the configured provider is unavailable',async()=>{
  const response=await app.inject({method:'POST',url:'/v1/me/support/messages',headers:auth(user.sessionToken),payload:{body:'咨询护理流程',clientMessageId:'synthetic-disabled-first'}});
  expect(response.statusCode).toBe(200);const result=response.json();
  expect(result).toMatchObject({conversation:{status:'ai_active'},aiStatus:'handoff_suggested',handoffSuggested:true,aiMessages:[{senderType:'system'}]});
  expect(result.aiMessages[0].body).toContain('申请人工');expect(await handoffEvents(result.conversation.id)).toBe(0);
 });
 it('creates exactly one handoff event when the member explicitly requests human support before sending a message',async()=>{
  const first=await support.requestHuman(user.memberId,user.principalId);
  expect(first.status).toBe('waiting_human');expect(await handoffEvents(first.id)).toBe(1);
  const repeat=await support.requestHuman(user.memberId,user.principalId);
  expect(repeat).toMatchObject({id:first.id,version:first.version});expect(await handoffEvents(first.id)).toBe(1);
 });
 it('keeps a first image authorization and sent image out of the human queue until the member requests it',async()=>{
  const authorization=await app.inject({method:'POST',url:'/v1/me/support/media/authorize',headers:auth(user.sessionToken),payload:{mimeType:'image/jpeg',maxBytes:4}});
  expect(authorization.statusCode).toBe(200);const media=authorization.json();
  const draft=(await pool.query('SELECT id,status FROM support_conversation WHERE member_id=$1',[user.memberId])).rows[0];
  expect(draft.status).toBe('ai_active');expect(await handoffEvents(draft.id)).toBe(0);
  storedObjectKeys.push((await pool.query('SELECT object_key FROM media_object WHERE id=$1',[media.mediaId])).rows[0].object_key);
  const bytes=Buffer.from([0xff,0xd8,0xff,0x00]);
  expect((await app.inject({method:'POST',url:`/v1/uploads/${media.mediaId}/chunks`,payload:{token:media.fields.token,index:0,totalBytes:bytes.length,base64:bytes.toString('base64')}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:`/v1/uploads/${media.mediaId}/assemble`,payload:{token:media.fields.token}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:`/v1/me/support/media/${media.mediaId}/complete`,headers:auth(user.sessionToken)})).statusCode).toBe(200);
  const result=await support.sendMember(user.memberId,user.principalId,{body:'',mediaIds:[media.mediaId],clientMessageId:'synthetic-first-image'},'synthetic');
  expect(result).toMatchObject({conversation:{status:'ai_active'},aiStatus:'handoff_suggested',message:{contentType:'image'},aiMessages:[{senderType:'system'}]});
  expect(suggest).not.toHaveBeenCalled();expect(await handoffEvents(draft.id)).toBe(0);
 });
 it.each([false,true])('keeps owned-order context private and preserves historical-order human routing (historical=%s)',async(historical)=>{
  const orderId=await ownedOrder();
  const result=await support.sendMember(user.memberId,user.principalId,{body:'请核对这个订单',linkedOrderId:orderId,clientMessageId:'synthetic-first-order'},'synthetic',historical);
  expect(result).toMatchObject({conversation:{status:historical?'waiting_human':'ai_active'},message:{contentType:'mixed',orderCard:{orderId}}});
  if(!historical)expect(result).toMatchObject({aiStatus:'handoff_suggested',handoffSuggested:true,aiMessages:[{senderType:'system'}]});
  expect(suggest).not.toHaveBeenCalled();expect(await handoffEvents(result.conversation.id)).toBe(0);
 });
 it('keeps waiting human routing intact while answering and preserves the legacy explicit cancellation version guard',async()=>{
  const waiting=await support.requestHuman(user.memberId,user.principalId);
  const message=await send();expect(message.conversation.status).toBe('waiting_human');expect(suggest).toHaveBeenCalledOnce();
  await expect(support.resumeAi(user.memberId,user.principalId,{expectedVersion:waiting.version},'synthetic')).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  const resumed=await support.resumeAi(user.memberId,user.principalId,{expectedVersion:message.conversation.version},'synthetic');expect(resumed.status).toBe('ai_active');
  const answered=await send('如何保存感受？','synthetic-resumed-message');expect(answered).toMatchObject({aiStatus:'replied'});
  const page=(await pool.query('SELECT body,sender_type FROM support_message WHERE conversation_id=$1 ORDER BY sequence',[waiting.id])).rows;expect(page.some(row=>row.sender_type==='system'&&row.body.includes('已切换 AI'))).toBe(true);
  await support.requestHuman(user.memberId,user.principalId);
  await expect(pool.query("UPDATE support_conversation SET status='ai_active',version=version+1,updated_at=clock_timestamp() WHERE id=$1",[waiting.id])).rejects.toThrow(/SUPPORT_CONVERSATION_ILLEGAL_TRANSITION/);
 });
 it('returns the committed member receipt on a subsequent database failure, and the identical retry recovers exactly one AI reply',async()=>{
  const original=pool.connect.bind(pool);let failed=false,memberCommitted=false;
  const observed=new Set<object>(),restores:Array<()=>void>=[];
  const spy=vi.spyOn(pool,'connect').mockImplementation((async()=>{
   const client=await original();
   if(!observed.has(client)){
    observed.add(client);const query=client.query.bind(client);let wroteMemberMessage=false;
    const fault=vi.spyOn(client,'query').mockImplementation(((...args:any[])=>{
     const sql=String(args[0]);
     if(/^BEGIN /i.test(sql))wroteMemberMessage=false;
     if(sql.includes('INSERT INTO support_message'))wroteMemberMessage=true;
     if(/^COMMIT/i.test(sql)&&wroteMemberMessage)memberCommitted=true;
     if(memberCommitted&&!failed&&sql.includes('SELECT * FROM support_conversation WHERE member_id=$1')){
      failed=true;return Promise.reject(new Error('synthetic read outage'));
     }
     if(/^(COMMIT|ROLLBACK)/i.test(sql))wroteMemberMessage=false;
     return (query as any)(...args);
    }) as any);
    restores.push(()=>fault.mockRestore());
   }
   return client;
  }) as any);
  let first:any;try{first=await send();}finally{spy.mockRestore();for(const restore of restores)restore();}
  expect(first).toMatchObject({replayed:false,aiStatus:'pending',aiMessages:[]});expect(first.message.body).toBe('如何记录护理？');expect(suggest).not.toHaveBeenCalled();
  const retry=await send();expect(retry).toMatchObject({replayed:true,message:{id:first.message.id},aiStatus:'replied'});expect(suggest).toHaveBeenCalledOnce();
  const counts=(await pool.query("SELECT sender_type,count(*)::int n FROM support_message WHERE conversation_id=$1 GROUP BY sender_type",[first.conversation.id])).rows;expect(counts).toEqual(expect.arrayContaining([{sender_type:'user',n:1},{sender_type:'ai',n:1}]));
 });
 it('keeps separately targeted answers when two user questions complete out of order',async()=>{
  const earlier=deferred<SupportAiSuggestion>(),later=deferred<SupportAiSuggestion>();suggest.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
  const one=send('第一条问题','synthetic-concurrent-one');await vi.waitFor(()=>expect(suggest).toHaveBeenCalledTimes(1));
  const two=send('第二条问题','synthetic-concurrent-two');await vi.waitFor(()=>expect(suggest).toHaveBeenCalledTimes(2));later.resolve(reply);const second=await two;earlier.resolve({...reply,text:'第一题的答案'});const first=await one;
  const row=(await pool.query('SELECT id FROM support_conversation WHERE member_id=$1',[user.memberId])).rows[0];const answers=(await pool.query("SELECT body,reply_to_message_id FROM support_message WHERE conversation_id=$1 AND sender_type='ai'",[row.id])).rows;
  expect(answers).toEqual(expect.arrayContaining([{body:reply.text,reply_to_message_id:second.message.id},{body:'第一题的答案',reply_to_message_id:first.message.id}]));expect(answers).toHaveLength(2);
 });

 it.each([false,true])('answers a separate basic question while human service stays intact (claimed=%s)',async(claimed)=>{
  const original=await send('请人工核实原退款事项','synthetic-original-refund');
  const waiting=await support.requestHuman(user.memberId,user.principalId);
  if(claimed)await support.claim(operator.memberId,operator.principalId,waiting.id,{expectedVersion:waiting.version},'synthetic');
  const before=(await pool.query('SELECT status,current_handler_principal_id,human_request_generation FROM support_conversation WHERE id=$1',[waiting.id])).rows[0];
  const response=await send('护理结束后怎样保存感受？','synthetic-independent-care');
  expect(response).toMatchObject({supportAiCanRespond:true,aiStatus:'replied',aiMessages:[{senderType:'ai',body:reply.text,replyToMessageId:response.message.id}]});
  expect((await pool.query('SELECT status,current_handler_principal_id,human_request_generation FROM support_conversation WHERE id=$1',[waiting.id])).rows[0]).toEqual(before);
  expect(suggest.mock.calls.at(-1)?.[0].conversation).toMatchObject({question:{body:'护理结束后怎样保存感受？'},humanRequest:{generation:1,anchorKnown:true,anchorQuestion:'请人工核实原退款事项'}});
  const page=await support.messagesForMember(user.memberId,{});expect(page).toMatchObject({supportAiCanRespond:true,humanRequest:{generation:1,anchorMessageId:original.message.id,anchorSequence:1,anchorKnown:true}});
  expect(await handoffEvents(waiting.id)).toBe(1);
 });
 it.each([false,true])('uses the latest actual manual status for related followups, never model promises (claimed=%s)',async(claimed)=>{
  await send('原人工售后问题','synthetic-followup-origin');const waiting=await support.requestHuman(user.memberId,user.principalId);
  const late=deferred<SupportAiSuggestion>();suggest.mockReturnValueOnce(late.promise);
  const pending=send('刚才那个问题有进展了吗？','synthetic-human-followup');await vi.waitFor(()=>expect(suggest).toHaveBeenCalledTimes(2));
  if(claimed){const row=(await pool.query('SELECT version FROM support_conversation WHERE id=$1',[waiting.id])).rows[0];await support.claim(operator.memberId,operator.principalId,waiting.id,{expectedVersion:row.version},'synthetic');}
  late.resolve({...reply,route:'human_followup',text:'模型虚构已退款，不得发布'});
  const result=await pending;expect(result.aiMessages?.[0]).toMatchObject({senderType:'system',replyToMessageId:result.message.id});
  expect(result.aiMessages?.[0]?.body).toContain(claimed?'正由人工客服跟进':'正在等待处理');
  expect(JSON.stringify(result)).not.toContain('模型虚构');expect(await handoffEvents(waiting.id)).toBe(1);
 });
 it('asks one clarification and keeps unknown legacy human anchors unknown',async()=>{
  const row=(await pool.query("INSERT INTO support_conversation(member_id,status,current_handler_principal_id) VALUES($1,'human_active',$2) RETURNING id",[user.memberId,operator.principalId])).rows[0];
  suggest.mockResolvedValueOnce({...reply,route:'clarify',confidence:0.3,text:'你是在补充之前的问题，还是咨询护理步骤？'});
  const result=await send('这个怎么办？','synthetic-legacy-clarification');
  expect(result).toMatchObject({conversation:{id:row.id,status:'human_active'},aiMessages:[{senderType:'ai',body:'你是在补充之前的问题，还是咨询护理步骤？'}]});
  expect(suggest.mock.calls.at(-1)?.[0].conversation.humanRequest).toMatchObject({generation:0,anchorKnown:false,anchorQuestion:null});
  expect((await pool.query('SELECT human_request_anchor_sequence FROM support_conversation WHERE id=$1',[row.id])).rows[0].human_request_anchor_sequence).toBeNull();
 });
 it('answers the basic portion of mixed questions without repeatedly appending the same manual-status notice',async()=>{
  await send('原退款问题','synthetic-mixed-origin');const waiting=await support.requestHuman(user.memberId,user.principalId);
  suggest.mockResolvedValue({...reply,route:'mixed'});
  const first=await send('退款什么时候处理？另外护理怎么保存？','synthetic-mixed-first');
  const second=await send('退款还在等吗？护理再说明一下？','synthetic-mixed-second');
  expect(first.aiMessages?.[0]?.body).toContain(reply.text);expect(first.aiMessages?.[0]?.body).toContain('正在等待处理');
  expect(second.aiMessages?.[0]?.body).toBe(reply.text);expect(await handoffEvents(waiting.id)).toBe(1);
 });
 it.each(['failure','missing-route'])('retains the existing human request without asking to apply again on %s',async(mode)=>{
  await send('原人工问题','synthetic-manual-failure-origin');const waiting=await support.requestHuman(user.memberId,user.principalId);
  if(mode==='failure')suggest.mockRejectedValueOnce(Object.assign(new Error('private upstream'),{code:'SUPPORT_AI_TIMEOUT'}));
  else if(mode==='uncertain')suggest.mockResolvedValueOnce({...reply,confidence:0.6});
  else{const {route:_,...missing}=reply;suggest.mockResolvedValueOnce(missing);}
  const result=await send('另一个基础咨询','synthetic-manual-failure-next');
  expect(result).toMatchObject({conversation:{status:'waiting_human'},handoffSuggested:false,aiMessages:[{senderType:'system'}]});
  expect(result.aiMessages?.[0]?.body).toContain('已有人工申请会继续保留');expect(result.aiMessages?.[0]?.body).not.toContain('申请人工');
  expect(await handoffEvents(waiting.id)).toBe(1);
 });
 it.each([false,true])('does not let an administrator reply swallow an unrelated AI answer (sameQuestion=%s)',async(sameQuestion)=>{
  const origin=await send('原人工退款事项','synthetic-race-origin');const waiting=await support.requestHuman(user.memberId,user.principalId);
  await support.claim(operator.memberId,operator.principalId,waiting.id,{expectedVersion:waiting.version},'synthetic');
  const late=deferred<SupportAiSuggestion>();suggest.mockReturnValueOnce(late.promise);
  const pending=send('护理怎么保存？','synthetic-race-care');await vi.waitFor(()=>expect(suggest).toHaveBeenCalledTimes(2));
  const target=(await pool.query("SELECT id FROM support_message WHERE conversation_id=$1 AND client_message_id='synthetic-race-care'",[waiting.id])).rows[0].id;
  await support.reply(operator.memberId,operator.principalId,waiting.id,{body:'人工对此问题的回复',clientMessageId:'synthetic-targeted-agent',replyToMessageId:sameQuestion?target:origin.message.id,expectedHumanRequestGeneration:1,contextVersion:0},'synthetic');
  late.resolve(reply);const result=await pending;
  expect(result.aiStatus).toBe(sameQuestion?'answered_by_human':'replied');expect(result.aiMessages??[]).toHaveLength(sameQuestion?0:1);
  expect((await pool.query("SELECT id FROM support_message WHERE conversation_id=$1 AND sender_type='ai' AND reply_to_message_id=$2",[waiting.id,target])).rowCount).toBe(sameQuestion?0:1);
 });
 it('reclassifies a question when a new human request arrives during AI generation',async()=>{
  const late=deferred<SupportAiSuggestion>();suggest.mockReturnValueOnce(late.promise).mockResolvedValueOnce({...reply,route:'human_followup'});
  const pending=send('需要核实这个问题','synthetic-reroute-question');await vi.waitFor(()=>expect(suggest).toHaveBeenCalledOnce());
  const waiting=await support.requestHuman(user.memberId,user.principalId);late.resolve(reply);const result=await pending;
  expect(suggest).toHaveBeenCalledTimes(2);expect(result.aiMessages?.[0]).toMatchObject({senderType:'system'});expect(result.aiMessages?.[0]?.body).toContain('正在等待处理');
  expect((await pool.query("SELECT id FROM support_message WHERE conversation_id=$1 AND client_message_id=$2",[waiting.id,`ai-reply:${result.message.id}`])).rowCount).toBe(1);
 });
 it('enforces targeted reply ownership, human generation and current topic before a new admin command',async()=>{
  const origin=await send('原人工问题','synthetic-target-origin');const waiting=await support.requestHuman(user.memberId,user.principalId);
  await support.claim(operator.memberId,operator.principalId,waiting.id,{expectedVersion:waiting.version},'synthetic');
  const input={body:'目标回复',clientMessageId:'synthetic-target-validation',replyToMessageId:origin.message.id,expectedHumanRequestGeneration:1,contextVersion:0};
  await expect(support.reply(operator.memberId,operator.principalId,waiting.id,{...input,expectedHumanRequestGeneration:0},'synthetic')).rejects.toMatchObject({code:'SUPPORT_HUMAN_REQUEST_CHANGED'});
  await expect(support.reply(operator.memberId,operator.principalId,waiting.id,{...input,contextVersion:1},'synthetic')).rejects.toMatchObject({code:'SUPPORT_CONTEXT_CHANGED'});
  const foreign=await identity(`synthetic-target-other-${serial}`);
  const foreignMessage=await support.sendMember(foreign.memberId,foreign.principalId,{body:'别人的问题',clientMessageId:'synthetic-foreign-target'},'synthetic');
  await expect(support.reply(operator.memberId,operator.principalId,waiting.id,{...input,replyToMessageId:foreignMessage.message.id},'synthetic')).rejects.toMatchObject({code:'SUPPORT_REPLY_TARGET_INVALID'});
  const written=await support.reply(operator.memberId,operator.principalId,waiting.id,input,'synthetic');
  expect(written.message.replyToMessageId).toBe(origin.message.id);
  await expect(support.reply(operator.memberId,operator.principalId,waiting.id,{...input,replyToMessageId:foreignMessage.message.id},'synthetic')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 });
 it('requires the scoped SQL marker for AI in manual service and rejects cross-conversation reply links',async()=>{
  const origin=await send('原人工问题','synthetic-sql-origin');const waiting=await support.requestHuman(user.memberId,user.principalId);
  const row=(await pool.query('SELECT next_sequence FROM support_conversation WHERE id=$1',[waiting.id])).rows[0];
  await expect(pool.query(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id,reply_to_message_id)
   VALUES($1,$2,'ai','ai:support','不得直接写入','synthetic-unscoped-ai',$3)`,[waiting.id,row.next_sequence,origin.message.id])).rejects.toThrow(/SUPPORT_AI_COLLABORATION_CONTEXT_REQUIRED/);
  const client=await pool.connect();try{
   await client.query('BEGIN');await client.query("SELECT set_config('cisme.support_ai_reply',$1,true)",[`${waiting.id}:${origin.message.id}:0:0`]);
   await expect(client.query(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id,reply_to_message_id)
    VALUES($1,$2,'ai','ai:support','错误代次','synthetic-wrong-generation',$3)`,[waiting.id,row.next_sequence,origin.message.id])).rejects.toThrow(/SUPPORT_AI_COLLABORATION_CONTEXT_REQUIRED/);
  }finally{await client.query('ROLLBACK');client.release();}
  await expect(pool.query('UPDATE support_conversation SET human_request_generation=human_request_generation+1,version=version+1 WHERE id=$1',[waiting.id])).rejects.toThrow(/SUPPORT_HUMAN_REQUEST_METADATA_REQUIRED/);
 });
 it('binds the explicit handoff question despite another device adding a later question',async()=>{
  const original=await send('本设备需要人工处理的问题','synthetic-explicit-origin');
  await send('另一设备后来问的基础问题','synthetic-other-device-question');
  const waiting=await support.requestHuman(user.memberId,user.principalId,{expectedConversationId:original.conversation.id,contextVersion:0,questionMessageId:original.message.id});
  expect((await support.messagesForMember(user.memberId,{})).humanRequest).toMatchObject({anchorMessageId:original.message.id,anchorSequence:1});
  expect(await handoffEvents(waiting.id)).toBe(1);
 });
 it('keeps an explicitly unknown handoff question unguessed and rejects invalid question owners/types',async()=>{
  const first=await send('已确认的问题','synthetic-invalid-handoff-origin');
  const foreign=await identity(`synthetic-handoff-other-${serial}`);
  const other=await support.sendMember(foreign.memberId,foreign.principalId,{body:'其他会员问题',clientMessageId:'synthetic-foreign-handoff-question'},'synthetic');
  for(const questionMessageId of [other.message.id,first.aiMessages![0]!.id])
   await expect(support.requestHuman(user.memberId,user.principalId,{expectedConversationId:first.conversation.id,contextVersion:0,questionMessageId})).rejects.toMatchObject({code:'SUPPORT_HANDOFF_QUESTION_INVALID'});
  await support.requestHuman(user.memberId,user.principalId,{expectedConversationId:first.conversation.id,contextVersion:0,questionMessageId:null});
  expect((await support.messagesForMember(user.memberId,{})).humanRequest).toMatchObject({anchorKnown:false,anchorMessageId:null});
 });
 it('clarifies low-confidence association instead of treating it as an unrelated basic question',async()=>{
  await send('原人工问题','synthetic-uncertain-origin');await support.requestHuman(user.memberId,user.principalId);
  suggest.mockResolvedValueOnce({...reply,route:'general',confidence:0.6,text:'不得直接作为无关问题答复'});
  const result=await send('这个怎么弄？','synthetic-uncertain-question');
  expect(result.aiMessages?.[0]?.body).toBe('你是在补充之前申请人工的问题，还是有新的使用问题？');
  expect(result.conversation.status).toBe('waiting_human');expect(result.aiMessages?.[0]?.body.match(/[？?]/g)).toHaveLength(1);
 });
 it('keeps an in-flight basic answer after an administrator resolves the separate human request',async()=>{
  const origin=await send('人工原退款事项','synthetic-resolve-origin');const waiting=await support.requestHuman(user.memberId,user.principalId);
  await support.claim(operator.memberId,operator.principalId,waiting.id,{expectedVersion:waiting.version},'synthetic');
  const late=deferred<SupportAiSuggestion>();suggest.mockReturnValueOnce(late.promise);
  const pending=send('另一基础护理问题','synthetic-resolve-general');await vi.waitFor(()=>expect(suggest).toHaveBeenCalledTimes(2));
  const before=(await pool.query('SELECT version FROM support_conversation WHERE id=$1',[waiting.id])).rows[0];
  await support.resolve(operator.memberId,operator.principalId,waiting.id,{expectedVersion:before.version},'synthetic');
  const resolved=(await pool.query('SELECT status,current_handler_principal_id,resolved_at FROM support_conversation WHERE id=$1',[waiting.id])).rows[0];
  late.resolve(reply);const answer=await pending;
  expect(answer.aiMessages?.[0]).toMatchObject({senderType:'ai',replyToMessageId:answer.message.id,body:reply.text});
  expect((await pool.query('SELECT status,current_handler_principal_id,resolved_at FROM support_conversation WHERE id=$1',[waiting.id])).rows[0]).toEqual(resolved);
  expect(resolved.status).toBe('resolved');expect(resolved.current_handler_principal_id).toBeNull();expect(origin.message.id).not.toBe(answer.message.id);
 });
 it('keeps an explicitly selected draft question separate and blocks inactive-account AI processing',async()=>{
  const original=await send('原人工问题','synthetic-draft-original');const waiting=await support.requestHuman(user.memberId,user.principalId);
  await support.claim(operator.memberId,operator.principalId,waiting.id,{expectedVersion:waiting.version},'synthetic');
  await send('另外的基础问题','synthetic-draft-later-question');
  const projection=await support.modelProjectionForAssignedOperator(operator.memberId,operator.principalId,waiting.id,
    {replyToMessageId:original.message.id,expectedHumanRequestGeneration:1,contextVersion:0});
  expect(projection.question).toMatchObject({body:'原人工问题'});expect(JSON.stringify(projection)).not.toContain('另外的基础问题');
  const count=(await pool.query('SELECT count(*)::int n FROM support_message WHERE conversation_id=$1',[waiting.id])).rows[0].n;
  const calls=suggest.mock.calls.length;await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[user.memberId]);
  await expect(support.modelProjectionForAssignedOperator(operator.memberId,operator.principalId,waiting.id,
    {replyToMessageId:original.message.id,expectedHumanRequestGeneration:1,contextVersion:0})).rejects.toMatchObject({code:'MEMBER_NOT_ACTIVE'});
  const forbidden=await app.inject({method:'POST',url:'/v1/me/support/messages',headers:auth(user.sessionToken),payload:{body:'失效后的问题',clientMessageId:'synthetic-blocked-collaboration'}});
  expect(forbidden.statusCode).toBe(401);expect(forbidden.json()).toMatchObject({code:'AUTH_REVOKED'});expect(suggest.mock.calls).toHaveLength(calls);
  expect((await pool.query('SELECT count(*)::int n FROM support_message WHERE conversation_id=$1',[waiting.id])).rows[0].n).toBe(count);
 });
});

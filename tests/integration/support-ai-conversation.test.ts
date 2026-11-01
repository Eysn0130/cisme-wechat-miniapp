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
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'synthetic-ai-chat-session',UPLOAD_TOKEN_SECRET:'synthetic-ai-chat-upload',OBJECT_STORAGE_DRIVER:'api_gateway'});
const storage=createApiGatewayStorage(config);
const source={id:'synthetic.support-guide',version:'1',title:'Synthetic support guide',content:'按00到03步骤护理，再保存感受。',approved:true as const,sha256:createHash('sha256').update('按00到03步骤护理，再保存感受。').digest('hex')};
const reply:SupportAiSuggestion={text:'请按 00 到 03 顺序完成，再保存护理感受。',confidence:0.95,citations:[{sourceId:source.id,version:'1'}],handoffReason:null};
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
  late.resolve(reply);await pending;
  expect((await pool.query("SELECT id FROM support_message WHERE conversation_id=$1 AND sender_type='ai'",[handoff.id])).rowCount).toBe(0);
  const manual=await app.inject({method:'POST',url:`/v1/management/support/conversations/${handoff.id}/messages`,headers:auth(operator.sessionToken),payload:{body:'您好，已收到您的问题，由我继续处理。',clientMessageId:'synthetic-human-reply-01'}});expect(manual.statusCode).toBe(200);
  const page=(await app.inject({method:'GET',url:'/v1/me/support/messages?after=1',headers:auth(user.sessionToken)})).json();expect(page.conversation.status).toBe('human_active');expect(page.messages.map((m:any)=>m.senderType)).toEqual(['system','admin']);expect(page.messages.at(-1).body).toContain('由我继续处理');
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
 it('does not return waiting users to AI until their own explicit versioned command, and rejects stale switching',async()=>{
  const waiting=await support.requestHuman(user.memberId,user.principalId);
  const message=await send();expect(message.conversation.status).toBe('waiting_human');expect(suggest).not.toHaveBeenCalled();
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
 it('allows only the newest member turn to publish when two generation requests finish out of order',async()=>{
  const earlier=deferred<SupportAiSuggestion>(),later=deferred<SupportAiSuggestion>();suggest.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
  const one=send('第一条问题','synthetic-concurrent-one');await vi.waitFor(()=>expect(suggest).toHaveBeenCalledTimes(1));
  const two=send('第二条问题','synthetic-concurrent-two');await vi.waitFor(()=>expect(suggest).toHaveBeenCalledTimes(2));later.resolve(reply);await two;earlier.resolve({...reply,text:'旧问题回复'});await one;
  const row=(await pool.query('SELECT id FROM support_conversation WHERE member_id=$1',[user.memberId])).rows[0];const answers=(await pool.query("SELECT body FROM support_message WHERE conversation_id=$1 AND sender_type='ai'",[row.id])).rows;
  expect(answers).toEqual([{body:reply.text}]);
 });
});

import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,resetDatabase,testPool} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {AuthorityService} from '../../services/api/src/authority';
import {PlatformService} from '../../services/api/src/platformService';
import {SupportService} from '../../services/api/src/supportService';
import {AccountClosure} from '../../services/api/src/accountClosure';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {ApprovedKnowledgeRegistry,SupportAiBoundary,type SupportAiSuggestion} from '../../services/api/src/supportAiBoundary';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,
 APP_SESSION_SECRET:'synthetic-topic-session',UPLOAD_TOKEN_SECRET:'synthetic-topic-upload',OBJECT_STORAGE_DRIVER:'api_gateway',API_RATE_LOGIN_MAX:'200'});
const storage=createApiGatewayStorage(config);
const source={id:'synthetic.new-topic-guide',version:'1',title:'Synthetic topic guide',content:'新问题只参考本话题。',approved:true as const,
 sha256:createHash('sha256').update('新问题只参考本话题。').digest('hex')};
const answer:SupportAiSuggestion={text:'这是当前问题的合成回答。',confidence:0.95,
 citations:[{sourceId:source.id,version:source.version}],handoffReason:null};
const suggest=vi.fn();
const boundary=new SupportAiBoundary({id:'synthetic-new-topic',available:true,suggest},new ApprovedKnowledgeRegistry([source]),4000,true);
let support:SupportService,directory:string;
const operation='support.conversation.new_topic';
let app:FastifyInstance,user:any,operator:any,serial=0;
const auth=(token:string)=>({authorization:`Bearer ${token}`});
const identity=async(name:string)=>{
 const response=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:name,displayName:name,
  consents:[{documentType:'privacy',version:'v1'},{documentType:'terms',version:'v1'}]}});
 expect(response.statusCode).toBe(200);return response.json();
};
const current=async(id:string)=>(await pool.query('SELECT * FROM support_conversation WHERE id=$1',[id])).rows[0]!;
const inputFor=(row:any,requestId:string=randomUUID())=>({conversationId:row.id,expectedVersion:row.version,requestId});
const reset=(input:ReturnType<typeof inputFor>,actor=user.principalId)=>support.startNewTopic(user.memberId,actor,input,'synthetic-topic-trace');
const send=async(body:string,key=`synthetic-topic-message-${randomUUID()}`)=>{
 const state=await support.messagesForMember(user.memberId,{});
 return support.sendMember(user.memberId,user.principalId,{body,clientMessageId:key,
  expectedConversationId:state.conversation?.id,contextVersion:state.contextVersion},'synthetic-topic-trace');
};
const requestHuman=async()=>{
 const state=await support.messagesForMember(user.memberId,{});
 return support.requestHuman(user.memberId,user.principalId,{expectedConversationId:state.conversation?.id,contextVersion:state.contextVersion});
};
const receiptRows=async(owner=user.memberId)=>(await pool.query(`SELECT * FROM idempotency_operation
 WHERE principal_id=$1 AND operation=$2 ORDER BY created_at,idempotency_key`,[`member:${owner}`,operation])).rows;

/** Insert synthetic history through the real sequence/immutability guards;
 * no provider, external account, order or message delivery is involved. */
async function seedHistory(count=3,status='ai_active',firstPurpose='ordinary'){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const row=(await client.query(`INSERT INTO support_conversation(member_id,status,current_handler_principal_id,resolved_at)
   VALUES($1,$2,$3,CASE WHEN $2='resolved' THEN clock_timestamp() ELSE NULL END) RETURNING *`,
   [user.memberId,status,status==='human_active'?operator.principalId:null])).rows[0]!;
  for(let sequence=1;sequence<=count;sequence++){
   await client.query(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id,retention_purpose)
    VALUES($1,$2,'user',$3,$4,$5,$6)`,[row.id,sequence,user.principalId,`旧话题合成历史 ${sequence}`,
    `synthetic-history-${row.id}-${sequence}`,sequence===1?firstPurpose:'ordinary']);
   await client.query(`UPDATE support_conversation SET next_sequence=next_sequence+1,version=version+1,
    updated_at=clock_timestamp() WHERE id=$1`,[row.id]);
  }
  await client.query('COMMIT');
  return current(row.id);
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

async function seedMixedImageHistory(){
 const ids={ordinary:randomUUID(),shared:randomUUID(),transaction:randomUUID(),draft:randomUUID()};
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const row=(await client.query(`INSERT INTO support_conversation(member_id,status) VALUES($1,'ai_active') RETURNING *`,[user.memberId])).rows[0]!;
  const messages:string[]=[];
  for(const [index,purpose,media] of [[0,'ordinary',[ids.ordinary,ids.shared]],[1,'transaction',[ids.shared,ids.transaction]]] as const){
   const message=(await client.query(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,
    body,content_type,attachment_refs,client_message_id,retention_purpose)
    VALUES($1,$2,'user',$3,'','image',$4::jsonb,$5,$6) RETURNING id`,
    [row.id,index+1,user.principalId,JSON.stringify(media),`synthetic-topic-media-${randomUUID()}`,purpose])).rows[0]!;
   messages.push(message.id);
   await client.query(`UPDATE support_conversation SET next_sequence=next_sequence+1,version=version+1,
    updated_at=clock_timestamp() WHERE id=$1`,[row.id]);
  }
  for(const [name,id] of Object.entries(ids))await client.query(`INSERT INTO media_object(id,kind,object_key,mime_type,size_bytes,
   upload_state,uploaded_at,support_conversation_id,support_member_id,bound_support_message_id,support_expires_at)
   VALUES($1,'chat_image',$2,'image/jpeg',3,'uploaded',clock_timestamp(),$3,$4,$5,clock_timestamp()+interval '1 day')`,
   [id,`synthetic-new-conversation/${id}`,row.id,user.memberId,name==='draft'?null:name==='transaction'?messages[1]:messages[0]]);
  await client.query('COMMIT');
  return {row:await current(row.id),ids};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

async function facts(id:string){
 const [conversation,messages,outbox,presence]=await Promise.all([
  pool.query(`SELECT id,member_id,status,current_handler_principal_id,priority,next_sequence,member_unread_count,team_unread_count,
   member_last_read_sequence,team_last_read_sequence,resolved_at FROM support_conversation WHERE id=$1`,[id]),
  pool.query('SELECT * FROM support_message WHERE conversation_id=$1 ORDER BY sequence',[id]),
  pool.query('SELECT * FROM outbox_event WHERE aggregate_id=$1 ORDER BY id',[id]),
  pool.query('SELECT * FROM support_presence WHERE conversation_id=$1 ORDER BY actor_type,actor_principal_id',[id])
 ]);
 return {conversation:conversation.rows[0],messages:messages.rows,outbox:outbox.rows,presence:presence.rows};
}

function deferred<T>(){
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(yes=>{resolve=yes;});
 return {promise,resolve};
}

beforeAll(async()=>{
 await resetDatabase(pool);await storage.ensureReady();
 directory=await mkdtemp(join(tmpdir(),'cisme-new-conversation-'));
 config.privacy.suppressionDirectory=directory;
 support=new SupportService(pool,new AuthorityService(pool,'test'),new PlatformService(pool,config,storage),storage,new AccountClosure(directory),boundary);
 app=await createApp({config,pool,storage});
 operator=await identity('synthetic-new-topic-operator');
 for(const capability of ['support.read','support.assign','support.reply'])await pool.query(`INSERT INTO authority_grant
  (member_id,capability,granted_by,grant_reason,environment,grant_source)
  VALUES($1,$2,'synthetic','New-topic integration fixture','test','integration_fixture')`,[operator.memberId,capability]);
});
beforeEach(async()=>{user=await identity(`synthetic-new-topic-user-${++serial}`);suggest.mockReset();suggest.mockResolvedValue(answer);});
afterAll(async()=>{await app.close();await pool.end();await rm(directory,{recursive:true,force:true});});

describe('fresh support conversation with ordinary-message erasure',()=>{
 it('erases ordinary history, resets active read state and records one small owner-scoped receipt without inventing messages',async()=>{
  const row=await seedHistory();
  await pool.query(`UPDATE support_conversation SET member_unread_count=2,team_unread_count=3,
   member_last_read_sequence=1,team_last_read_sequence=2 WHERE id=$1`,[row.id]);
  await pool.query(`INSERT INTO support_presence(conversation_id,actor_type,actor_principal_id,online_expires_at,typing_expires_at)
   VALUES($1,'member',$2,clock_timestamp()+interval '2 minutes',clock_timestamp()+interval '30 seconds')`,[row.id,user.principalId]);
  const before=await facts(row.id),input=inputFor(row);
  const result=await reset({...input,conversationId:input.conversationId.toUpperCase(),requestId:input.requestId.toUpperCase()});
  expect(result).toMatchObject({replayed:false,contextStartSequence:3,contextVersion:row.version+1,newTopicAvailable:true,messages:[],olderCursor:null,
   conversation:{id:row.id,status:'ai_active',version:row.version+1}});
  const after=await facts(row.id);
  expect(after.messages).toEqual([]);expect(after.outbox).toEqual(before.outbox);
  expect(after.conversation).toMatchObject({...before.conversation,member_unread_count:0,team_unread_count:0,
   member_last_read_sequence:'3',team_last_read_sequence:'3'});
  expect(after.presence.every(item=>new Date(item.typing_expires_at).getTime()<=Date.now())).toBe(true);
  const receipts=await receiptRows();expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({principal_id:`member:${user.memberId}`,operation,idempotency_key:input.requestId,
   business_key:`support-topic:${row.id}:v${row.version}`,response_status:200,
   request_hash:createHash('sha256').update(JSON.stringify({conversationId:row.id,expectedVersion:row.version})).digest('hex'),
   response_body:{conversationId:row.id,contextStartSequence:3,resultVersion:row.version+1}});
  expect(Object.keys(receipts[0].response_body).sort()).toEqual(['contextStartSequence','conversationId','resultVersion']);
  const audit=(await pool.query(`SELECT principal_id,after_state FROM audit_log WHERE action=$1 AND object_id=$2`,[operation,row.id])).rows;
  expect(audit).toHaveLength(1);expect(audit[0].principal_id).toBe(user.principalId);
  expect(JSON.stringify(audit)).not.toContain('旧话题合成历史');expect(suggest).not.toHaveBeenCalled();
 });

 it('removes a large ordinary history and refuses to reveal the previous conversation through before or after',async()=>{
  const row=await seedHistory(65);await reset(inputFor(row));
  const empty=await support.messagesForMember(user.memberId,{});
  expect(empty).toMatchObject({contextStartSequence:65,newTopicAvailable:true,messages:[],latestCursor:65,olderCursor:null});
  const older=await support.messagesForMember(user.memberId,{before:66,limit:20});
  expect(older.messages).toEqual([]);expect(older.olderCursor).toBeNull();
  expect((await pool.query('SELECT id FROM support_message WHERE conversation_id=$1',[row.id])).rowCount).toBe(0);
  expect(await support.messagesForMember(user.memberId,{after:0,limit:100})).toMatchObject({messages:[],olderCursor:null});
  const sent=await send('本话题的新问题');
  const page=await support.messagesForMember(user.memberId,{after:1,limit:100});
  expect(page.contextStartSequence).toBe(65);
  expect(page.messages.map(message=>message.sequence)).toEqual([66,67]);
  expect(page.olderCursor).toBeNull();
  expect((await support.messagesForMember(user.memberId,{after:65,limit:100})).olderCursor).toBeNull();
  expect(page.messages[0]?.id).toBe(sent.message.id);
  expect(suggest.mock.calls[0]?.[0].conversation.messages).toEqual([{sequence:66,senderType:'user',body:'本话题的新问题'}]);
 });

 it('uses the newest global receipt boundary rather than a marker in the latest fifty messages',async()=>{
  const row=await seedHistory(60),first=await reset(inputFor(row));
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   for(let sequence=61;sequence<=115;sequence++){
    await client.query(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id,retention_purpose)
     VALUES($1,$2,'user',$3,$4,$5,'ordinary')`,[row.id,sequence,user.principalId,`上一段合成上下文 ${sequence}`,`synthetic-later-history-${sequence}`]);
    await client.query(`UPDATE support_conversation SET next_sequence=next_sequence+1,version=version+1,updated_at=clock_timestamp() WHERE id=$1`,[row.id]);
   }
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  expect(first.contextStartSequence).toBe(60);
  const next=await reset(inputFor(await current(row.id)));expect(next.contextStartSequence).toBe(115);
  await send('第三个话题的问题');
  expect(suggest.mock.calls[0]?.[0].conversation.messages).toEqual([{sequence:116,senderType:'user',body:'第三个话题的问题'}]);
  expect((await support.messagesForMember(user.memberId,{})).contextStartSequence).toBe(115);
 });

 it('replays the same request across actor sessions without resetting again and returns the current human state',async()=>{
  const row=await seedHistory(2),input=inputFor(row);await reset(input);
  const waiting=await requestHuman();
  const claimed=await support.claim(operator.memberId,operator.principalId,row.id,{expectedVersion:waiting.version},'synthetic-topic-claim');
  const before=await facts(row.id),versionBefore=(await current(row.id)).version;
  const replay=await reset(input,'synthetic:rotated-member-session');
  expect(replay).toMatchObject({replayed:true,contextStartSequence:2,
   conversation:{id:row.id,status:'human_active',version:claimed.version}});
  expect(replay.messages.some(message=>message.senderType==='system')).toBe(true);
  expect(await facts(row.id)).toEqual(before);expect((await current(row.id)).version).toBe(versionBefore);
  expect(await receiptRows()).toHaveLength(1);
  expect((await pool.query('SELECT id FROM audit_log WHERE action=$1 AND object_id=$2',[operation,row.id])).rowCount).toBe(1);
  await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[user.memberId]);
  await expect(reset(input)).rejects.toMatchObject({code:'MEMBER_NOT_ACTIVE',status:403});
 });

 it('rejects changed input for a reused request and treats a different request as a new versioned intent',async()=>{
  const row=await seedHistory(),input=inputFor(row);await reset(input);
  await expect(reset({...input,expectedVersion:row.version+1})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT',status:409});
  await expect(reset({...input,requestId:randomUUID()})).rejects.toMatchObject({code:'VERSION_CONFLICT',status:409});
  const newer=await reset(inputFor(await current(row.id)));
  expect(newer.replayed).toBe(false);expect(newer.contextStartSequence).toBe(3);expect(await receiptRows()).toHaveLength(2);
 });

 it('serializes identical concurrent requests into one version increase and receipt',async()=>{
  const row=await seedHistory(),input=inputFor(row);
  const results=await Promise.all([reset(input),reset(input)]);
  expect(results.map(result=>result.replayed).sort()).toEqual([false,true]);
  expect((await current(row.id)).version).toBe(row.version+1);expect(await receiptRows()).toHaveLength(1);
 });

 it('uses a distinct generation for consecutive empty resets even when the sequence boundary is unchanged',async()=>{
  const row=await seedHistory(0);
  const first=await reset(inputFor(row));
  const second=await reset(inputFor(await current(row.id)));
  expect(first).toMatchObject({contextStartSequence:0,contextVersion:row.version+1,messages:[],olderCursor:null});
  expect(second).toMatchObject({contextStartSequence:0,contextVersion:row.version+2,messages:[],olderCursor:null});
  const before=await facts(row.id);
  for(const fields of [{},{expectedConversationId:row.id},{expectedConversationId:row.id,contextVersion:first.contextVersion},
   {expectedConversationId:randomUUID(),contextVersion:second.contextVersion}]){
   await expect(support.sendMember(user.memberId,user.principalId,{body:'上一会话的迟到草稿',
    clientMessageId:`synthetic-stale-empty-${randomUUID()}`,...fields},'synthetic-stale-empty'))
    .rejects.toMatchObject({code:'SUPPORT_CONTEXT_CHANGED',status:409});
  }
  for(const fields of [{},{expectedConversationId:row.id,contextVersion:first.contextVersion}]){
   await expect(support.requestHuman(user.memberId,user.principalId,fields))
    .rejects.toMatchObject({code:'SUPPORT_CONTEXT_CHANGED',status:409});
  }
  expect(await facts(row.id)).toEqual(before);expect(suggest).not.toHaveBeenCalled();
  const sent=await send('这一会话的新问题');
  expect(sent.message.sequence).toBe(1);expect(sent).toMatchObject({contextVersion:second.contextVersion});
 });

 it('keeps ambiguous legacy evidence isolated while deleting ordinary text in the same record',async()=>{
  const row=await seedHistory(3,'ai_active','legacy_unknown');
  await reset(inputFor(row));
  expect((await pool.query('SELECT sequence,retention_purpose FROM support_message WHERE conversation_id=$1 ORDER BY sequence',[row.id])).rows)
   .toEqual([{sequence:'1',retention_purpose:'legacy_unknown'}]);
  for(const query of [{},{before:4},{after:0}]){
   expect((await support.messagesForMember(user.memberId,query)).messages).toEqual([]);
   expect((await support.operatorMessages(operator.memberId,operator.principalId,row.id,query)).messages).toEqual([]);
  }
  expect((await support.messagesForMember(user.memberId,{},false)).messages.map(message=>message.sequence)).toEqual([1]);
 });

 it('retains held ordinary evidence but isolates it from the new member and operator conversation',async()=>{
  const row=await seedHistory(2);
  const message=(await pool.query('SELECT id FROM support_message WHERE conversation_id=$1 ORDER BY sequence LIMIT 1',[row.id])).rows[0]!;
  const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
   VALUES('SYNTHETIC_SUPPORT_HOLD','Isolated test evidence retention','synthetic',clock_timestamp()+interval '1 day',
    clock_timestamp()+interval '2 days') RETURNING id`)).rows[0]!;
  await pool.query(`INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'support_message',$2)`,[hold.id,message.id]);
  const fresh=await reset(inputFor(row));
  expect(fresh).toMatchObject({messages:[],olderCursor:null,contextStartSequence:2});
  expect((await pool.query('SELECT id FROM support_message WHERE id=$1',[message.id])).rowCount).toBe(1);
  expect((await support.messagesForMember(user.memberId,{before:3})).messages).toEqual([]);
  expect((await support.operatorMessages(operator.memberId,operator.principalId,row.id,{before:3})).messages).toEqual([]);
  await send('与被保全内容无关的新问题');
  expect(suggest.mock.calls[0]?.[0].conversation.messages).toEqual([{sequence:3,senderType:'user',body:'与被保全内容无关的新问题'}]);
 });

 it('returns the latest topic boundary when an earlier successful command is retried',async()=>{
  const row=await seedHistory(2),original=inputFor(row);await reset(original);
  await send('第二段话题的问题');await reset(inputFor(await current(row.id)));
  const before=await facts(row.id),versionBefore=(await current(row.id)).version;
  const replay=await reset(original);
  expect(replay).toMatchObject({replayed:true,contextStartSequence:4,messages:[],olderCursor:null});
  expect((await current(row.id)).version).toBe(versionBefore);expect(await facts(row.id)).toEqual(before);
  expect((await receiptRows()).map(receipt=>receipt.response_body.contextStartSequence).sort()).toEqual([2,4]);
 });

 it('rejects an old member retry with a missing generation instead of recreating deleted text',async()=>{
  const row=await seedHistory(3);await reset(inputFor(row));const before=await facts(row.id);
  await expect(support.sendMember(user.memberId,user.principalId,{body:'旧话题合成历史 3',
   clientMessageId:`synthetic-history-${row.id}-3`},'synthetic-stale-send'))
   .rejects.toMatchObject({code:'SUPPORT_CONTEXT_CHANGED',status:409});
  expect(suggest).not.toHaveBeenCalled();expect(await facts(row.id)).toEqual(before);
  expect((await support.messagesForMember(user.memberId,{})).messages).toEqual([]);
 });

 it('enforces the conversation owner, exact id, active account and current version before any new receipt',async()=>{
  const other=await identity(`synthetic-topic-other-${serial}`),row=await seedHistory();
  await expect(support.startNewTopic(other.memberId,other.principalId,inputFor(row),'synthetic-cross-owner')).rejects.toMatchObject({status:404});
  await expect(reset({...inputFor(row),conversationId:randomUUID()})).rejects.toMatchObject({status:404});
  await expect(reset({...inputFor(row),expectedVersion:row.version+1})).rejects.toMatchObject({code:'VERSION_CONFLICT',status:409});
  await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[user.memberId]);
  await expect(reset(inputFor(row))).rejects.toMatchObject({code:'MEMBER_NOT_ACTIVE',status:403});
  expect(await receiptRows()).toHaveLength(0);
 });

 it('returns 404 without creating a conversation for a member who has not sent a message',async()=>{
  await expect(reset({conversationId:randomUUID(),expectedVersion:1,requestId:randomUUID()})).rejects.toMatchObject({status:404});
  expect((await pool.query('SELECT id FROM support_conversation WHERE member_id=$1',[user.memberId])).rowCount).toBe(0);
  expect(await receiptRows()).toHaveLength(0);
 });

 it.each(['waiting_human','human_active'])('rejects a new reset in %s without changing the queue or conversation',async status=>{
  const row=await seedHistory(2,status),before=await facts(row.id);
  await expect(reset(inputFor(row))).rejects.toMatchObject({status:409});
  expect(await facts(row.id)).toEqual(before);expect(await receiptRows()).toHaveLength(0);
 });

 it('reopens a resolved conversation as a fresh AI session without adding a greeting or entering the human queue',async()=>{
  const row=await seedHistory(2,'resolved'),before=await facts(row.id),result=await reset(inputFor(row));
  expect(result).toMatchObject({replayed:false,contextStartSequence:2,messages:[],conversation:{id:row.id,status:'ai_active',version:row.version+1}});
  const after=await facts(row.id);
  expect(after.messages).toEqual([]);expect(after.outbox).toEqual(before.outbox);
  expect(after.conversation).toMatchObject({...before.conversation,status:'ai_active',resolved_at:null,
   member_last_read_sequence:'2',team_last_read_sequence:'2'});
  expect(suggest).not.toHaveBeenCalled();
 });

 it('discards an AI answer started before the reset and generates the next answer from only the new question',async()=>{
  const late=deferred<SupportAiSuggestion>();suggest.mockReturnValueOnce(late.promise);
  const pending=send('重置前尚未回答的问题');await vi.waitFor(()=>expect(suggest).toHaveBeenCalledOnce());
  const row=(await pool.query('SELECT * FROM support_conversation WHERE member_id=$1',[user.memberId])).rows[0]!;
  const resetResult=await reset(inputFor(row));expect(resetResult.contextStartSequence).toBe(1);
  late.resolve({...answer,text:'这条旧回答不能进入新话题'});
  expect(await pending).toMatchObject({acknowledgedConversationId:row.id,contextStartSequence:1,aiMessages:[],conversation:{id:row.id,version:resetResult.conversation!.version}});
  expect((await pool.query("SELECT id FROM support_message WHERE conversation_id=$1 AND sender_type='ai'",[row.id])).rowCount).toBe(0);
  expect((await support.messagesForMember(user.memberId,{})).messages).toEqual([]);
  await send('重置后的问题');
  expect(suggest.mock.calls[1]?.[0].conversation.messages).toEqual([{sequence:2,senderType:'user',body:'重置后的问题'}]);
  expect((await pool.query("SELECT body FROM support_message WHERE conversation_id=$1 AND sender_type='ai'",[row.id])).rows).toEqual([{body:answer.text}]);
 });

 it('keeps the old send acknowledgement scoped to its original conversation after precise removal and recreation',async()=>{
  const late=deferred<SupportAiSuggestion>();suggest.mockReturnValueOnce(late.promise);
  const pending=send('旧会话的尚未完成问题');await vi.waitFor(()=>expect(suggest).toHaveBeenCalledOnce());
  const old=(await pool.query('SELECT * FROM support_conversation WHERE member_id=$1',[user.memberId])).rows[0]!;
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   await client.query("SELECT set_config('cisme.support_purge_conversation_id',$1,true)",[old.id]);
   await client.query('DELETE FROM support_message WHERE conversation_id=$1',[old.id]);
   await client.query('DELETE FROM support_conversation WHERE id=$1',[old.id]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const recreated=await seedHistory(1);
  late.resolve({...answer,text:'旧会话的回答不能进入新会话'});
  const acknowledged=await pending;
  expect(acknowledged).toMatchObject({acknowledgedConversationId:old.id,contextStartSequence:0,aiMessages:[],
   message:{sequence:1,body:'旧会话的尚未完成问题'},conversation:{id:recreated.id}});
  expect((await support.messagesForMember(user.memberId,{})).messages.map(message=>message.body)).toEqual(['旧话题合成历史 1']);
 });

 it('does not advertise an older cursor when all messages before the receipt boundary have been purged',async()=>{
  const row=await seedHistory(3);await reset(inputFor(row));
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   await client.query("SELECT set_config('cisme.support_purge_conversation_id',$1,true)",[row.id]);
   await client.query('DELETE FROM support_message WHERE conversation_id=$1',[row.id]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  expect(await support.messagesForMember(user.memberId,{after:0})).toMatchObject({contextStartSequence:3,messages:[],olderCursor:null});
  expect(await support.messagesForMember(user.memberId,{})).toMatchObject({contextStartSequence:3,messages:[],olderCursor:null});
 });

 it('keeps the previous conversation out of operator activity and suggested-reply context',async()=>{
  const row=await seedHistory(3);await reset(inputFor(row));await send('新话题需要帮助');
  const waiting=await requestHuman();
  await support.claim(operator.memberId,operator.principalId,row.id,{expectedVersion:waiting.version},'synthetic-topic-claim');
  const history=await support.operatorMessages(operator.memberId,operator.principalId,row.id,{limit:100});
  expect(history.messages.map(message=>message.sequence)).toEqual([4,5,6]);
  expect(JSON.stringify(history)).not.toContain('旧话题合成历史');
  expect((await support.operatorMessages(operator.memberId,operator.principalId,row.id,{before:4,limit:100})).messages).toEqual([]);
  const projection=await support.modelProjectionForAssignedOperator(operator.memberId,operator.principalId,row.id);
  expect(projection.messages.map(message=>message.sequence)).toEqual([4,5,6]);
  expect(JSON.stringify(projection)).not.toContain('旧话题合成历史');
 });

 it('erases ordinary messages while retaining transaction evidence outside ordinary and operator chat history',async()=>{
  const row=await seedHistory(3,'ai_active','transaction');await reset(inputFor(row));
  expect((await pool.query('SELECT sequence,retention_purpose FROM support_message WHERE conversation_id=$1',[row.id])).rows)
   .toEqual([{sequence:'1',retention_purpose:'transaction'}]);
  const page=await support.messagesForMember(user.memberId,{});
  expect(page).toMatchObject({contextStartSequence:3,messages:[],olderCursor:null});
  expect((await support.messagesForMember(user.memberId,{before:4})).messages).toEqual([]);
  expect((await support.operatorMessages(operator.memberId,operator.principalId,row.id,{before:4})).messages).toEqual([]);
  expect((await support.messagesForMember(user.memberId,{before:4},false)).messages.map(message=>message.sequence)).toEqual([1]);
  expect((await support.queue(operator.memberId,{limit:100})).items.find(item=>item.id===row.id)?.lastMessage).toBe('暂无消息');
  await send('删除旧普通记录后的新问题');
  expect(suggest.mock.calls[0]?.[0].conversation.messages).toEqual([{sequence:4,senderType:'user',body:'删除旧普通记录后的新问题'}]);
  expect((await receiptRows())[0].response_body.contextStartSequence).toBe(3);
 });

 it('queues only orphan ordinary and draft images and blocks retained old media from active chat routes',async()=>{
  const {row,ids}=await seedMixedImageHistory();
  await reset(inputFor(row));
  const queued=(await pool.query('SELECT media_id FROM media_cleanup_queue WHERE media_id=ANY($1::uuid[]) ORDER BY media_id',
   [Object.values(ids)])).rows.map(item=>item.media_id).sort();
  const mediaState=(await pool.query('SELECT id,upload_state,authorized_at,bound_support_message_id FROM media_object WHERE id=ANY($1::uuid[])',[Object.values(ids)])).rows;
  const markers=await new AccountClosure(directory).supportConversationResetMarkers(user.memberId);
  expect(queued,JSON.stringify({ids,mediaState,markers})).toEqual([ids.ordinary,ids.draft].sort());
  expect((await pool.query('SELECT sequence,retention_purpose,attachment_refs FROM support_message WHERE conversation_id=$1',[row.id])).rows)
   .toEqual([{sequence:'2',retention_purpose:'transaction',attachment_refs:[ids.shared,ids.transaction]}]);
  await expect(support.deleteSupportMedia(user.memberId,user.principalId,ids.shared,'synthetic-protected-image-delete'))
   .rejects.toMatchObject({code:'SUPPORT_MEDIA_BOUND',status:409});
  expect((await pool.query('SELECT upload_state FROM media_object WHERE id=$1',[ids.shared])).rows[0]).toEqual({upload_state:'uploaded'});
  for(const mediaId of [ids.ordinary,ids.shared,ids.transaction]){
   await expect(support.memberSupportMedia(user.memberId,mediaId)).rejects.toMatchObject({code:'SUPPORT_MEDIA_NOT_FOUND',status:404});
   await expect(support.operatorSupportMedia(operator.memberId,row.id,mediaId)).rejects.toMatchObject({code:'SUPPORT_MEDIA_NOT_FOUND',status:404});
  }
 });

 it('ignores other-owner, other-operation and other-conversation receipt boundaries',async()=>{
  const row=await seedHistory(4);await reset(inputFor(row));await send('仍然属于当前话题的问题');
  const add=async(principal:string,op:string,response:unknown)=>pool.query(`INSERT INTO idempotency_operation
   (principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
   VALUES($1,$2,$3,$4,$5,200,$6)`,[principal,op,randomUUID(),`synthetic-invalid-boundary:${randomUUID()}`,'f'.repeat(64),response]);
  const valid={conversationId:row.id,contextStartSequence:6,resultVersion:(await current(row.id)).version};
  await add(`member:${operator.memberId}`,operation,valid);
  await add(`member:${user.memberId}`,'support.conversation.other',valid);
  await add(`member:${user.memberId}`,operation,{...valid,conversationId:randomUUID()});
  const page=await support.messagesForMember(user.memberId,{});
  expect(page.contextStartSequence).toBe(4);expect(page.messages.map(message=>message.sequence)).toEqual([5,6]);
 });

 it.each([-1,1.5,'3',null,'invalid',Number.MAX_SAFE_INTEGER+1,4])(
  'fails closed on an exact-owner malformed receipt boundary %s instead of restoring old context',async invalid=>{
   const row=await seedHistory(3);await reset(inputFor(row));
   await pool.query(`INSERT INTO idempotency_operation
    (principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
    VALUES($1,$2,$3,$4,$5,200,$6)`,[`member:${user.memberId}`,operation,randomUUID(),
    `synthetic-corrupt-boundary:${randomUUID()}`,'f'.repeat(64),
    {conversationId:row.id,contextStartSequence:invalid,resultVersion:row.version+1}]);
   await expect(support.messagesForMember(user.memberId,{})).rejects.toMatchObject({code:'SUPPORT_TOPIC_RECEIPT_INVALID',status:503});
   expect(suggest).not.toHaveBeenCalled();
  });

 it.each([undefined,0,1.5,'5',Number.MAX_SAFE_INTEGER])('fails closed on an invalid receipt result version %s',async resultVersion=>{
  const row=await seedHistory(3);await reset(inputFor(row));
  await pool.query(`INSERT INTO idempotency_operation
   (principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
   VALUES($1,$2,$3,$4,$5,200,$6)`,[`member:${user.memberId}`,operation,randomUUID(),
   `synthetic-corrupt-version:${randomUUID()}`,'f'.repeat(64),{conversationId:row.id,contextStartSequence:3,resultVersion}]);
  await expect(support.messagesForMember(user.memberId,{})).rejects.toMatchObject({code:'SUPPORT_TOPIC_RECEIPT_INVALID',status:503});
 });

 it('exposes the authenticated HTTP command and current-topic metadata even when automatic AI is disabled',async()=>{
  const row=await seedHistory(2),input=inputFor(row);
  expect((await app.inject({method:'POST',url:'/v1/me/support/new-topic',payload:input})).statusCode).toBe(401);
  for(const change of [{requestId:'not-a-uuid'},{conversationId:'not-a-uuid'},{expectedVersion:0},{expectedVersion:1.5},{expectedVersion:'1'}]){
   expect((await app.inject({method:'POST',url:'/v1/me/support/new-topic',headers:auth(user.sessionToken),payload:{...input,...change}})).statusCode).toBe(422);
  }
  const result=await app.inject({method:'POST',url:'/v1/me/support/new-topic',headers:auth(user.sessionToken),payload:input});
  expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({replayed:false,contextStartSequence:2,newTopicAvailable:true,messages:[]});
  const page=await app.inject({method:'GET',url:'/v1/me/support/messages',headers:auth(user.sessionToken)});
  expect(page.statusCode).toBe(200);expect(page.json()).toMatchObject({contextStartSequence:2,newTopicAvailable:true,messages:[],supportAiAvailable:false});
  const stale=await app.inject({method:'POST',url:'/v1/me/support/messages',headers:auth(user.sessionToken),
   payload:{body:'旧界面的迟到内容',clientMessageId:`synthetic-http-stale-${randomUUID()}`}});
  expect(stale.statusCode).toBe(409);expect(stale.json().code).toBe('SUPPORT_CONTEXT_CHANGED');
  const sent=await app.inject({method:'POST',url:'/v1/me/support/messages',headers:auth(user.sessionToken),
   payload:{body:'本会话的新内容',clientMessageId:`synthetic-http-current-${randomUUID()}`,
    expectedConversationId:row.id,contextVersion:page.json().contextVersion}});
  expect(sent.statusCode,sent.body).toBe(200);expect(sent.json().message.body).toBe('本会话的新内容');
  expect(sent.json().contextVersion).toBe(page.json().contextVersion);
  expect(suggest).not.toHaveBeenCalled();
 });
});

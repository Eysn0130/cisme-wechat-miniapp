import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readdir,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,resetDatabase,testPool} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {AuthorityService} from '../../services/api/src/authority';
import {PlatformService} from '../../services/api/src/platformService';
import {SupportService} from '../../services/api/src/supportService';
import {AccountClosure,type Marker,type SuppressionRemote} from '../../services/api/src/accountClosure';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {ApprovedKnowledgeRegistry,SupportAiBoundary,type SupportAiSuggestion} from '../../services/api/src/supportAiBoundary';
import type {SupportConversationResetMarker} from '../../services/api/src/supportConversationReset';

const pool=testPool(),config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,
  APP_SESSION_SECRET:'synthetic-reset-recovery',UPLOAD_TOKEN_SECRET:'synthetic-reset-recovery-upload',
  OBJECT_STORAGE_DRIVER:'api_gateway',API_RATE_LOGIN_MAX:'200'});
const storage=createApiGatewayStorage(config),source={id:'synthetic.recovery-guide',version:'1',title:'Synthetic guide',
  content:'仅参考新会话。',approved:true as const,sha256:createHash('sha256').update('仅参考新会话。').digest('hex')};
const answer:SupportAiSuggestion={text:'新的合成回答。',confidence:0.95,citations:[{sourceId:source.id,version:source.version}],handoffReason:null};
const suggest=vi.fn();
let directory:string,app:FastifyInstance,closure:AccountClosure,support:SupportService,user:any,serial=0,failRemote=false,remoteResetWrites=0;
const remoteRows=new Map<string,Marker>();
const remote:SuppressionRemote={async put(row){if(row.version===7){remoteResetWrites++;if(failRemote)throw new Error('SYNTHETIC_REMOTE_UNAVAILABLE');}
  remoteRows.set(JSON.stringify(row),structuredClone(row));},async list(){return [...remoteRows.values()].map(row=>structuredClone(row));}};
const current=async(id:string)=>(await pool.query('SELECT * FROM support_conversation WHERE id=$1',[id])).rows[0]!;
const inputFor=(row:any)=>({conversationId:row.id,expectedVersion:row.version,requestId:randomUUID()});
const reset=(input:any)=>support.startNewTopic(user.memberId,user.principalId,input,'synthetic-reset-recovery');
async function seed(count=3){
  const client=await pool.connect();
  try{await client.query('BEGIN');
    const row=(await client.query("INSERT INTO support_conversation(member_id,status) VALUES($1,'ai_active') RETURNING *",[user.memberId])).rows[0]!;
    for(let sequence=1;sequence<=count;sequence++){
      await client.query(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id,retention_purpose)
        VALUES($1,$2,'user',$3,$4,$5,$6)`,[row.id,sequence,user.principalId,`待清空合成问题${sequence}`,`synthetic-recovery-${sequence}`,sequence===1?'transaction':'ordinary']);
      await client.query('UPDATE support_conversation SET next_sequence=next_sequence+1,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[row.id]);
    }
    await client.query('COMMIT');return current(row.id);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
beforeAll(async()=>{
  await resetDatabase(pool);await storage.ensureReady();directory=await mkdtemp(join(tmpdir(),'cisme-support-new-recovery-'));
  config.privacy.suppressionDirectory=directory;closure=new AccountClosure(directory,remote);
  app=await createApp({config,pool,storage,suppressionRemote:remote});
  support=new SupportService(pool,new AuthorityService(pool,'test'),new PlatformService(pool,config,storage),storage,closure,
    new SupportAiBoundary({id:'synthetic-recovery-provider',available:true,suggest},new ApprovedKnowledgeRegistry([source]),4000,true));
});
beforeEach(async()=>{
  failRemote=false;remoteResetWrites=0;suggest.mockReset();suggest.mockResolvedValue(answer);
  const result=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:`synthetic-reset-recovery-${++serial}`,
    displayName:'Synthetic recovery',consents:[{documentType:'privacy',version:'v1'},{documentType:'terms',version:'v1'}]}});
  expect(result.statusCode).toBe(200);user=result.json();
});
afterAll(async()=>{await app.close();await pool.end();await rm(directory,{recursive:true,force:true});});

describe('independent user-requested support conversation reset recovery',()=>{
  it('blocks old reads and sends while the independent copy is unconfirmed, then reconciles the same intent exactly once',async()=>{
    const row=await seed(),input=inputFor(row);failRemote=true;
    await expect(reset(input)).rejects.toMatchObject({code:'SUPPORT_NEW_CONVERSATION_PENDING',status:503});
    expect((await pool.query('SELECT id FROM support_message WHERE conversation_id=$1',[row.id])).rowCount).toBe(3);
    expect((await pool.query("SELECT idempotency_key FROM idempotency_operation WHERE operation='support.conversation.new_topic' AND principal_id=$1",[`member:${user.memberId}`])).rowCount).toBe(0);
    // Startup also confirms the independent copy before creating a receipt.
    await expect(new AccountClosure(directory,remote).replay(pool)).rejects.toThrow('SYNTHETIC_REMOTE_UNAVAILABLE');
    expect((await pool.query("SELECT idempotency_key FROM idempotency_operation WHERE operation='support.conversation.new_topic' AND principal_id=$1",[`member:${user.memberId}`])).rowCount).toBe(0);
    await expect(support.messagesForMember(user.memberId,{})).rejects.toMatchObject({status:503});
    await expect(support.sendMember(user.memberId,user.principalId,{body:'不应写入',clientMessageId:'synthetic-blocked-send'},'synthetic')).rejects.toMatchObject({status:503});
    failRemote=false;
    const page=await support.messagesForMember(user.memberId,{});
    expect(page).toMatchObject({contextStartSequence:3,contextVersion:row.version+1,messages:[],olderCursor:null});
    expect((await pool.query('SELECT sequence,retention_purpose FROM support_message WHERE conversation_id=$1',[row.id])).rows)
      .toEqual([{sequence:'1',retention_purpose:'transaction'}]);
    expect(await reset(input)).toMatchObject({replayed:true,contextVersion:row.version+1});
    expect((await current(row.id)).version).toBe(row.version+1);
    expect((await pool.query("SELECT id FROM audit_log WHERE action='support.conversation.new_topic' AND object_id=$1",[row.id])).rowCount).toBe(1);
    const marker=(await closure.supportConversationResetMarkers(user.memberId))[0]!;
    expect(marker.scope).toBe('support_new_conversation_v1');expect(JSON.stringify(marker)).not.toContain('合成问题');
    expect(Object.keys(marker).sort()).toEqual(['version','scope','memberId','conversationId','requestId','expectedVersion','contextStartSequence','resultVersion','memberCreatedAt','createdAt'].sort());
  });

  it('rebuilds the generation and receipt from a remote marker after restoring an older message/sequence snapshot',async()=>{
    const row=await seed(3),input=inputFor(row);await reset(input);
    const marker=(await closure.supportConversationResetMarkers(user.memberId))[0] as SupportConversationResetMarker;
    const client=await pool.connect();
    try{await client.query('BEGIN');
      await client.query("SELECT set_config('cisme.support_purge_conversation_id',$1,true)",[row.id]);
      await client.query('DELETE FROM support_message WHERE conversation_id=$1',[row.id]);
      await client.query('DELETE FROM support_conversation WHERE id=$1',[row.id]);
      await client.query("DELETE FROM idempotency_operation WHERE principal_id=$1 AND operation='support.conversation.new_topic'",[`member:${user.memberId}`]);
      await client.query("INSERT INTO support_conversation(id,member_id,status) VALUES($1,$2,'ai_active')",[row.id,user.memberId]);
      for(let sequence=1;sequence<=2;sequence++){
        await client.query(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id,retention_purpose)
          VALUES($1,$2,'user',$3,$4,$5,$6)`,[row.id,sequence,user.principalId,`恢复的旧问题${sequence}`,`synthetic-restored-${sequence}`,sequence===1?'transaction':'ordinary']);
        await client.query('UPDATE support_conversation SET next_sequence=next_sequence+1,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[row.id]);
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    // Simulate losing the local suppression directory independently of DB.
    const filename=(await readdir(directory)).find(name=>name===`${user.memberId}.support-reset.${row.id}.${input.requestId}.json`)!;
    expect(filename).toBeTruthy();await unlink(join(directory,filename));
    await new AccountClosure(directory,remote).replay(pool);
    const restored=await support.messagesForMember(user.memberId,{});
    expect(restored).toMatchObject({contextStartSequence:3,contextVersion:marker.resultVersion,messages:[],olderCursor:null});
    const facts=await current(row.id);expect(facts.next_sequence).toBe('4');expect(facts.version).toBeGreaterThanOrEqual(marker.resultVersion);
    expect((await pool.query('SELECT sequence,retention_purpose FROM support_message WHERE conversation_id=$1',[row.id])).rows)
      .toEqual([{sequence:'1',retention_purpose:'transaction'}]);
    await expect(support.sendMember(user.memberId,user.principalId,{body:'旧设备重试',clientMessageId:'synthetic-recovery-stale',contextVersion:0,expectedConversationId:row.id},'synthetic'))
      .rejects.toMatchObject({code:'SUPPORT_CONTEXT_CHANGED',status:409});
    expect((await support.messagesForMember(user.memberId,{},false)).messages.map(message=>message.sequence)).toEqual([1]);
  });

  it('reconciles a published but rolled-back reset before a previously started AI answer can persist',async()=>{
    let resolve!:(value:SupportAiSuggestion)=>void;
    suggest.mockReturnValueOnce(new Promise<SupportAiSuggestion>(yes=>{resolve=yes;}));
    const pending=support.sendMember(user.memberId,user.principalId,{body:'将被清空的问题',clientMessageId:'synthetic-recovery-delayed-ai'},'synthetic');
    await vi.waitFor(()=>expect(suggest).toHaveBeenCalledOnce());
    const row=(await pool.query('SELECT * FROM support_conversation WHERE member_id=$1',[user.memberId])).rows[0]!;
    failRemote=true;await expect(reset(inputFor(row))).rejects.toMatchObject({status:503});
    failRemote=false;resolve({...answer,text:'旧AI回答不得落库'});
    expect(await pending).toMatchObject({contextVersion:row.version+1,contextStartSequence:1,aiMessages:[]});
    expect((await pool.query('SELECT id FROM support_message WHERE conversation_id=$1',[row.id])).rowCount).toBe(0);
    expect((await support.messagesForMember(user.memberId,{})).messages).toEqual([]);
  });

  it('does not reset a later human service or lower a newer empty generation when markers replay out of order',async()=>{
    const row=await seed(1),first=inputFor(row);await reset(first);const second=inputFor(await current(row.id));await reset(second);
    const context=await support.messagesForMember(user.memberId,{});
    await support.requestHuman(user.memberId,user.principalId,{expectedConversationId:row.id,contextVersion:context.contextVersion});
    const before=await current(row.id),markers=await closure.supportConversationResetMarkers(user.memberId);
    for(const marker of markers.reverse()){
      const {transaction}=await import('../../services/api/src/db');
      const {applySupportConversationReset}=await import('../../services/api/src/supportConversationReset');
      await transaction(pool,client=>applySupportConversationReset(client,marker));
    }
    expect(await current(row.id)).toEqual(before);
    expect(await support.messagesForMember(user.memberId,{})).toMatchObject({contextVersion:second.expectedVersion+1,conversation:{status:'waiting_human'}});
  });

  it('keeps a newly authorized draft when the application clock is behind the database reset cutoff',async()=>{
    const row=await seed(1);await reset(inputFor(row));
    const media=await support.authorizeSupportMedia(user.memberId,user.principalId,
      {mimeType:'image/png',maxBytes:1024,baseUrl:'http://127.0.0.1'},'synthetic-skewed-new-draft',new Date(Date.now()-60_000));
    await support.messagesForMember(user.memberId,{});
    expect((await pool.query('SELECT upload_state FROM media_object WHERE id=$1',[media.mediaId])).rows[0]).toEqual({upload_state:'authorized'});
    expect((await pool.query('SELECT id FROM media_cleanup_queue WHERE media_id=$1',[media.mediaId])).rowCount).toBe(0);
  });

  it('reconciles an uncommitted reset before accepting a stale operator claim',async()=>{
    const row=await seed(2),input=inputFor(row);failRemote=true;
    await expect(reset(input)).rejects.toMatchObject({status:503});failRemote=false;
    await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
      VALUES($1,'support.assign','synthetic','Reset recovery claim fixture','test','integration_fixture')`,[user.memberId]);
    await expect(support.claim(user.memberId,user.principalId,row.id,{expectedVersion:row.version},'synthetic-stale-claim'))
      .rejects.toMatchObject({code:'VERSION_CONFLICT',status:409});
    expect((await current(row.id)).status).toBe('ai_active');
    expect((await pool.query("SELECT id FROM support_message WHERE conversation_id=$1 AND sender_type='system'",[row.id])).rowCount).toBe(0);
  });

  it('uses matching committed receipts without rewriting historical markers during polling, sends, AI guards and worker replay',async()=>{
    const row=await seed(2);await reset(inputFor(row));await reset(inputFor(await current(row.id)));
    expect(remoteResetWrites).toBe(2);
    for(let index=0;index<5;index++)await support.messagesForMember(user.memberId,{});
    const page=await support.messagesForMember(user.memberId,{});
    const sent=await support.sendMember(user.memberId,user.principalId,{body:'新代的问题',clientMessageId:'synthetic-recovery-no-cos-rewrite',
      expectedConversationId:row.id,contextVersion:page.contextVersion},'synthetic');
    expect(sent).toMatchObject({contextVersion:page.contextVersion,aiStatus:'replied'});expect(suggest).toHaveBeenCalledOnce();
    await closure.replayPendingErasure(pool);await support.messagesForMember(user.memberId,{});
    expect(remoteResetWrites).toBe(2);
  });

  it('does not treat a mismatching receipt as a remote acknowledgement or expose the retired content',async()=>{
    const row=await seed(2),input=inputFor(row);await reset(input);
    const prior=(await pool.query("SELECT request_hash FROM idempotency_operation WHERE principal_id=$1 AND operation='support.conversation.new_topic' AND idempotency_key=$2",
      [`member:${user.memberId}`,input.requestId])).rows[0]!.request_hash;
    const writes=remoteResetWrites;
    try{
      await pool.query("UPDATE idempotency_operation SET request_hash=$3 WHERE principal_id=$1 AND operation='support.conversation.new_topic' AND idempotency_key=$2",
        [`member:${user.memberId}`,input.requestId,'0'.repeat(64)]);
      await expect(support.messagesForMember(user.memberId,{})).rejects.toThrow('SUPPORT_NEW_CONVERSATION_RECEIPT_MISMATCH');
      expect(remoteResetWrites).toBe(writes);
    }finally{
      await pool.query("UPDATE idempotency_operation SET request_hash=$3 WHERE principal_id=$1 AND operation='support.conversation.new_topic' AND idempotency_key=$2",
        [`member:${user.memberId}`,input.requestId,prior]);
    }
  });
});

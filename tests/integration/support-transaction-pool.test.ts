import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,resetDatabase} from '@cisme/testkit';
import {createPool} from '../../services/api/src/db';
import {createApp} from '../../services/api/src/server';
import {AuthorityService} from '../../services/api/src/authority';
import {PlatformService} from '../../services/api/src/platformService';
import {SupportService} from '../../services/api/src/supportService';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {ApprovedKnowledgeRegistry,SupportAiBoundary} from '../../services/api/src/supportAiBoundary';
import {AccountClosure} from '../../services/api/src/accountClosure';

// A real one-connection pool makes a nested pool read inside a held transaction
// observable. Preserve the production-default acquisition/transaction deadlines.
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,
  APP_SESSION_SECRET:'synthetic-support-pool',UPLOAD_TOKEN_SECRET:'synthetic-support-pool-upload',
  OBJECT_STORAGE_DRIVER:'api_gateway',DATABASE_POOL_MAX:'1',API_RATE_LOGIN_MAX:'200'});
const pool=createPool(TEST_DATABASE_URL,config.database),storage=createApiGatewayStorage(config);
let app:FastifyInstance,directory:string;
const identity=async(name:string)=>{
  const response=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:name,displayName:name,
    consents:[{documentType:'privacy',version:'v1'},{documentType:'terms',version:'v1'}]}});
  expect(response.statusCode).toBe(200);return response.json();
};
beforeAll(async()=>{await resetDatabase(pool);await storage.ensureReady();directory=await mkdtemp(join(tmpdir(),'cisme-support-bounded-pool-'));
  config.privacy.suppressionDirectory=directory;app=await createApp({config,pool,storage});});
afterAll(async()=>{await app.close();await pool.end();await rm(directory,{recursive:true,force:true});});

it('commits linked automatic fallbacks for concurrent members using a single available database connection',async()=>{
  const members=await Promise.all(Array.from({length:4},(_,index)=>identity(`synthetic-bounded-support-${index}`)));
  const replies=await Promise.all(members.map((member,index)=>app.inject({method:'POST',url:'/v1/me/support/messages',
    headers:{authorization:`Bearer ${member.sessionToken}`},payload:{body:'合成基础问题',clientMessageId:`synthetic-bounded-message-${index}`}})));
  expect(replies.map(response=>response.statusCode)).toEqual([200,200,200,200]);
  for(const response of replies){
    const result=response.json();
    expect(JSON.stringify(result)).not.toMatch(/"(?:snapshot|member_id|sender_principal_id|human_request_anchor_sequence)"/);
    expect(result).toMatchObject({aiStatus:'handoff_suggested',aiMessages:[{senderType:'system',replyToMessageId:result.message.id}]});
    const rows=(await pool.query('SELECT sender_type,reply_to_message_id FROM support_message WHERE conversation_id=$1 ORDER BY sequence',[result.conversation.id])).rows;
    expect(rows).toEqual([{sender_type:'user',reply_to_message_id:null},{sender_type:'system',reply_to_message_id:result.message.id}]);
  }
  const first=replies[0]!.json(),member=members[0];
  const replay=await app.inject({method:'POST',url:'/v1/me/support/messages',headers:{authorization:`Bearer ${member.sessionToken}`},
    payload:{body:'合成基础问题',clientMessageId:'synthetic-bounded-message-0'}});
  expect(replay.statusCode).toBe(200);expect(replay.json()).toMatchObject({replayed:true,message:{id:first.message.id},aiMessages:[{id:first.aiMessages[0].id}]});
});

it.each(['blocked','reset','handoff'])('rechecks committed source boundaries before the unavailable-provider reply when %s changes',async(change)=>{
  const owner=await identity(`synthetic-bounded-context-${change}`),closure=new AccountClosure(directory);
  const support=new SupportService(pool,new AuthorityService(pool,'test'),new PlatformService(pool,config,storage),storage,closure);
  let entered!:()=>void,proceed!:()=>void;
  const committed=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{proceed=resolve;});
  const original=(support as any).automaticReply.bind(support);
  const pause=vi.spyOn(support as any,'automaticReply').mockImplementation(async(...args:unknown[])=>{entered();await resume;return original(...args);});
  const sending=support.sendMember(owner.memberId,owner.principalId,{body:'已提交但尚未答复的合成问题',clientMessageId:`synthetic-bounded-fence-${change}`},'synthetic');
  await committed;
  const source=(await pool.query("SELECT c.id,c.version,m.id message_id FROM support_conversation c JOIN support_message m ON m.conversation_id=c.id WHERE c.member_id=$1 AND m.sender_type='user'",[owner.memberId])).rows[0];
  expect(source).toBeTruthy();
  try{
    if(change==='blocked')await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[owner.memberId]);
    else if(change==='reset')await support.startNewTopic(owner.memberId,owner.principalId,{conversationId:source.id,expectedVersion:source.version,requestId:randomUUID()},'synthetic');
    else await support.requestHuman(owner.memberId,owner.principalId,{expectedConversationId:source.id,contextVersion:0,questionMessageId:source.message_id});
  }finally{proceed();}
  let result:any;try{result=await sending;}finally{pause.mockRestore();}
  expect(JSON.stringify(result)).not.toMatch(/"(?:snapshot|member_id|sender_principal_id|human_request_anchor_sequence)"/);
  const rows=(await pool.query('SELECT sender_type,reply_to_message_id,body FROM support_message WHERE conversation_id=$1 ORDER BY sequence',[source.id])).rows;
  if(change==='reset'){
    expect(rows).toEqual([]);expect(result.aiMessages??[]).toEqual([]);expect(result.contextStartSequence).toBe(1);expect(result.contextVersion).toBeGreaterThan(0);
  }else if(change==='blocked'){
    expect(rows.map(row=>row.sender_type)).toEqual(['user']);expect(result.aiMessages??[]).toEqual([]);
  }else{
    expect(rows.map(row=>row.sender_type)).toEqual(['user','system']);expect(rows[1]).toMatchObject({reply_to_message_id:source.message_id});
    expect(rows[1].body).toContain('已有人工申请会继续保留');expect(rows[1].body).not.toContain('申请人工');
    expect(result).toMatchObject({conversation:{status:'waiting_human'},humanRequest:{generation:1,anchorMessageId:source.message_id},handoffSuggested:false});
  }
});

it('persists AI and targeted administrator acknowledgements and their exact replays with no second connection',async()=>{
  const owner=await identity('synthetic-bounded-ai-owner'),operator=await identity('synthetic-bounded-ai-operator');
  for(const capability of ['support.read','support.assign','support.reply'])await pool.query(`INSERT INTO authority_grant
    (member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,$2,'synthetic','single-pool integration','test','integration_fixture')`,[operator.memberId,capability]);
  const content='合成护理指导',knowledge={id:'synthetic.pool-guide',version:'1',title:'Synthetic guide',content,approved:true as const,
    sha256:createHash('sha256').update(content).digest('hex')};
  let calls=0;
  const boundary=new SupportAiBoundary({id:'synthetic-pool-ai',available:true,async suggest(){calls++;return {text:'这是简短的合成指导。',
    citations:[{sourceId:knowledge.id,version:knowledge.version}],confidence:0.95,handoffReason:null,route:'general' as const};}},new ApprovedKnowledgeRegistry([knowledge]),4000,true);
  const support=new SupportService(pool,new AuthorityService(pool,'test'),new PlatformService(pool,config,storage),storage,undefined,boundary);
  const input={body:'如何完成护理？',clientMessageId:'synthetic-bounded-ai-question'};
  const first=await support.sendMember(owner.memberId,owner.principalId,input,'synthetic');
  expect(first).toMatchObject({aiStatus:'replied',aiMessages:[{senderType:'ai',replyToMessageId:first.message.id}]});
  const replay=await support.sendMember(owner.memberId,owner.principalId,input,'synthetic');
  expect(replay).toMatchObject({replayed:true,aiMessages:[{id:first.aiMessages![0]!.id}]});expect(calls).toBe(1);
  const waiting=await support.requestHuman(owner.memberId,owner.principalId,{questionMessageId:first.message.id});
  await support.claim(operator.memberId,operator.principalId,waiting.id,{expectedVersion:waiting.version},'synthetic');
  const answer={body:'人工对该问题的合成回复',clientMessageId:'synthetic-bounded-human-answer',replyToMessageId:first.message.id,expectedHumanRequestGeneration:1,contextVersion:0};
  const manual=await support.reply(operator.memberId,operator.principalId,waiting.id,answer,'synthetic');
  const repeated=await support.reply(operator.memberId,operator.principalId,waiting.id,answer,'synthetic');
  expect(manual.message).toMatchObject({senderType:'admin',replyToMessageId:first.message.id});
  expect(repeated).toMatchObject({replayed:true,message:{id:manual.message.id,replyToMessageId:first.message.id}});
  expect((await pool.query("SELECT count(*)::int n FROM support_message WHERE conversation_id=$1 AND sender_type='admin'",[waiting.id])).rows[0].n).toBe(1);
});

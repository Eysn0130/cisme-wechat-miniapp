import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const pool = testPool();
const config = loadConfig({ APP_ENV:"test",DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"support-test-session",ADMIN_API_TOKEN:"legacy-admin",UPLOAD_TOKEN_SECRET:"support-upload",OBJECT_STORAGE_DRIVER:"api_gateway" });
let app: FastifyInstance;
let user: any; let memberOnly: any; let operatorA: any; let operatorB: any; let reader: any; let privacyOperator: any;
let winningOperator: any;
const auth = (token: string) => ({ authorization:`Bearer ${token}` });
const identity = async (name: string) => (await app.inject({ method:"POST",url:"/v1/identity/dev",payload:{externalUserId:name,displayName:name,consents:[{documentType:"privacy",version:"v1"},{documentType:"terms",version:"v1"}]}})).json();
const grant = async (who: any, capabilities: string[]) => {
  for (const capability of capabilities) await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,$2,'test-authority','R1 R2 integration test','test','integration_fixture')`, [who.memberId, capability]);
};

beforeAll(async()=>{
  await resetDatabase(pool); app=await createApp({config,pool,storage:createApiGatewayStorage(config)});
  [user,memberOnly,operatorA,operatorB,reader,privacyOperator]=await Promise.all(["support-user","member-only","operator-a","operator-b","reader-only","privacy-operator"].map(identity));
  await grant(operatorA,["support.read","support.reply","support.assign","member.support_view"]);
  await grant(operatorB,["support.read","support.reply","support.assign"]);
  await grant(reader,["support.read"]);
  await grant(privacyOperator,["privacy.request.manage"]);
  // Legacy/team membership must not silently become broad R1 authority.
  await pool.query("INSERT INTO member_team_access(member_id,role,granted_by) VALUES($1,'administrator','test-authority')",[memberOnly.memberId]);
});
afterAll(async()=>{await app.close();await pool.end();});

describe("R1 role-aware authority",()=>{
  it("projects only active server grants and never treats member/team/client flags as authorization",async()=>{
    await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
      VALUES($1,'support.read','test-authority','Separate staging authority fixture','staging','integration_fixture')`,[operatorA.memberId]);
    expect((await pool.query("SELECT count(*)::int count FROM authority_grant WHERE member_id=$1 AND capability='support.read' AND revoked_at IS NULL",[operatorA.memberId])).rows[0].count).toBe(2);
    await expect(pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
      VALUES($1,'support.read','test-authority','Duplicate test authority fixture','test','integration_fixture')`,[operatorA.memberId])).rejects.toMatchObject({code:'23505'});
    const stagedAudit=(await pool.query(`SELECT after_state FROM audit_log WHERE action='authority.grant' AND object_type='authority_grant'
      AND after_state->>'memberId'=$1 AND after_state->>'environment'='staging'`,[operatorA.memberId])).rows[0];
    expect(stagedAudit?.after_state).toMatchObject({capability:'support.read',environment:'staging',grantSource:'integration_fixture'});
    expect((await app.inject({method:"GET",url:"/v1/me/authority",headers:auth(user.sessionToken)})).json()).toEqual({version:1,capabilities:[],managementAvailable:false});
    expect((await app.inject({method:"GET",url:"/v1/me/authority",headers:auth(memberOnly.sessionToken)})).json()).toEqual({version:1,capabilities:[],managementAvailable:false});
    const projection=(await app.inject({method:"GET",url:"/v1/me/authority",headers:auth(operatorA.sessionToken)})).json();
    expect(projection.managementAvailable).toBe(true);expect(projection.capabilities).toEqual(["member.support_view","support.assign","support.read","support.reply"]);
    await expect(pool.query("DELETE FROM authority_grant WHERE member_id=$1 AND capability='support.reply'",[operatorA.memberId])).rejects.toThrow(/AUTHORITY_GRANT_EVIDENCE_IMMUTABLE/);
    expect((await app.inject({method:"GET",url:"/v1/management/support/conversations"})).statusCode).toBe(401);
    expect((await app.inject({method:"GET",url:"/v1/management/support/conversations",headers:{...auth(user.sessionToken),"x-admin":"true","x-principal-id":operatorA.principalId}})).statusCode).toBe(403);
  });
});

describe("R2 support authority",()=>{
  it("persists retries once, orders concurrent member messages and exposes the same conversation",async()=>{
    const send=(body:string,key:string)=>app.inject({method:"POST",url:"/v1/me/support/messages",headers:auth(user.sessionToken),payload:{body,clientMessageId:key}});
    expect((await app.inject({method:"POST",url:"/v1/me/support/messages",headers:auth(user.sessionToken)})).statusCode).toBe(422);
    const duplicate=await Promise.all([send("你好，我需要人工帮助","member-retry-0001"),send("你好，我需要人工帮助","member-retry-0001")]);
    expect(duplicate.map(item=>item.statusCode)).toEqual([200,200]);
    expect(new Set(duplicate.map(item=>item.json().message.id)).size).toBe(1);
    const concurrent=await Promise.all(Array.from({length:8},(_,index)=>send(`连续消息 ${index}`,`member-sequence-${index}`)));
    expect(concurrent.map(item=>item.statusCode)).toEqual(Array(8).fill(200));
    const page=(await app.inject({method:"GET",url:"/v1/me/support/messages",headers:auth(user.sessionToken)})).json();
    expect(page.messages).toHaveLength(9);expect(page.messages.map((item:any)=>item.sequence)).toEqual([1,2,3,4,5,6,7,8,9]);
    expect(new Set(page.messages.map((item:any)=>item.body))).toEqual(new Set(["你好，我需要人工帮助",...Array.from({length:8},(_,index)=>`连续消息 ${index}`)]));
    const summary=(await app.inject({method:"GET",url:"/v1/me/support/summary",headers:auth(user.sessionToken)})).json();
    expect(summary.conversation.id).toBe(page.conversation.id);expect(summary.conversation.status).toBe("waiting_human");
    expect((await pool.query("SELECT count(*)::int AS count FROM support_message")).rows[0].count).toBe(9);
  });

  it("requires discrete capabilities and serializes competing operator claims",async()=>{
    const queue=(await app.inject({method:"GET",url:"/v1/management/support/conversations",headers:auth(operatorA.sessionToken)})).json();
    const conversation=queue.items[0];expect(conversation.memberDisplayName).toBe("support-user");
    expect((await app.inject({method:"POST",url:`/v1/management/support/conversations/${conversation.id}/claim`,headers:auth(operatorA.sessionToken)})).statusCode).toBe(422);
    expect((await app.inject({method:"POST",url:`/v1/management/support/conversations/${conversation.id}/messages`,headers:auth(reader.sessionToken),payload:{body:"forbidden",clientMessageId:"reader-reply-1"}})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:`/v1/management/support/conversations/${conversation.id}/messages`,headers:auth(operatorA.sessionToken),payload:{body:"unclaimed",clientMessageId:"unclaimed-reply"}})).statusCode).toBe(409);
    const claims=await Promise.all([operatorA,operatorB].map(operator=>app.inject({method:"POST",url:`/v1/management/support/conversations/${conversation.id}/claim`,headers:auth(operator.sessionToken),payload:{expectedVersion:conversation.version}})));
    expect(claims.map(item=>item.statusCode).sort()).toEqual([200,409]);
    const winner=claims[0]!.statusCode===200?operatorA:operatorB;const loser=winner===operatorA?operatorB:operatorA;
    const claimed=claims.find(item=>item.statusCode===200)!.json();expect(claimed.status).toBe("human_active");
    expect((await app.inject({method:"POST",url:`/v1/management/support/conversations/${conversation.id}/messages`,headers:auth(loser.sessionToken),payload:{body:"wrong agent",clientMessageId:"wrong-agent-1"}})).statusCode).toBe(409);
    const reply=await app.inject({method:"POST",url:`/v1/management/support/conversations/${conversation.id}/messages`,headers:auth(winner.sessionToken),payload:{body:"您好，我是人工客服。",clientMessageId:"operator-reply-1"}});
    expect(reply.statusCode).toBe(200);expect(reply.json().message.senderType).toBe("admin");
    const reply2=await app.inject({method:"POST",url:`/v1/management/support/conversations/${conversation.id}/messages`,headers:auth(winner.sessionToken),payload:{body:"我再补充一条处理说明。",clientMessageId:"operator-reply-2"}});
    expect(reply2.statusCode).toBe(200);
    const userSummary=(await app.inject({method:"GET",url:"/v1/me/support/summary",headers:auth(user.sessionToken)})).json();expect(userSummary.unreadCount).toBe(3);
    await app.inject({method:"POST",url:"/v1/me/support/read",headers:auth(user.sessionToken),payload:{lastSeenSequence:reply.json().message.sequence}});
    expect((await app.inject({method:"GET",url:"/v1/me/support/summary",headers:auth(user.sessionToken)})).json().unreadCount).toBe(1);
    await app.inject({method:"POST",url:"/v1/me/support/read",headers:auth(user.sessionToken),payload:{lastSeenSequence:reply2.json().message.sequence}});
    expect((await app.inject({method:"GET",url:"/v1/me/support/summary",headers:auth(user.sessionToken)})).json().unreadCount).toBe(0);
    const context=await app.inject({method:"POST",url:`/v1/management/support/conversations/${conversation.id}/member-context`,headers:auth(operatorA.sessionToken)});
    expect(context.statusCode).toBe(operatorA===winner?200:200);expect(context.json()).toMatchObject({displayName:"support-user",memberStatus:"active",maskedPhone:null});
    expect(Object.keys(context.json()).sort()).toEqual(["displayName","maskedPhone","memberSince","memberStatus"].sort());
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE action LIKE 'support.%'")).rows[0].count).toBeGreaterThanOrEqual(3);
    winningOperator=winner;
  });

  it("resolves with version control, reopens on member text, and revokes access immediately",async()=>{
    const winner=winningOperator;const current=(await app.inject({method:"GET",url:"/v1/management/support/conversations",headers:auth(winner.sessionToken)})).json().items[0];
    const resolved=await app.inject({method:"POST",url:`/v1/management/support/conversations/${current.id}/resolve`,headers:auth(winner.sessionToken),payload:{expectedVersion:current.version}});
    expect(resolved.statusCode).toBe(200);expect(resolved.json().status).toBe("resolved");
    expect((await pool.query("SELECT current_handler_principal_id FROM support_conversation WHERE id=$1",[current.id])).rows[0].current_handler_principal_id).toBeNull();
    const reopened=await app.inject({method:"POST",url:"/v1/me/support/messages",headers:auth(user.sessionToken),payload:{body:"还有一个问题",clientMessageId:"member-reopen-01"}});
    expect(reopened.json().conversation).toMatchObject({status:"waiting_human"});expect(reopened.json().conversation).not.toHaveProperty("currentHandlerPrincipalId");
    await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='test-authority',revoke_reason='test immediate revocation' WHERE member_id=$1 AND capability='support.read'",[reader.memberId]);
    expect((await app.inject({method:"GET",url:"/v1/management/support/conversations",headers:auth(reader.sessionToken)})).statusCode).toBe(403);
  });

  it("keeps message facts immutable and outbox payloads free of message text",async()=>{
    const message=(await pool.query("SELECT id FROM support_message LIMIT 1")).rows[0];
    await expect(pool.query("UPDATE support_message SET body='changed' WHERE id=$1",[message.id])).rejects.toThrow(/SUPPORT_MESSAGE_IMMUTABLE/);
    const events=await pool.query("SELECT payload FROM outbox_event WHERE event_type='support.message.created.v1'");
    expect(events.rowCount).toBeGreaterThan(0);for(const row of events.rows)expect(JSON.stringify(row.payload)).not.toMatch(/人工|处理说明|连续|问题|帮助/);
    const conversation=(await pool.query("SELECT id,next_sequence,status FROM support_conversation LIMIT 1")).rows[0];
    expect(conversation.status).toBe("waiting_human");
    await expect(pool.query(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id)
      VALUES($1,$2,'ai','ai:r3-stale','stale answer','stale-ai-answer')`,[conversation.id,conversation.next_sequence])).rejects.toThrow(/SUPPORT_AI_REPLY_FORBIDDEN_AFTER_HANDOFF/);
    await expect(pool.query("UPDATE support_conversation SET status='ai_active',version=version+1,updated_at=now() WHERE id=$1",[conversation.id])).rejects.toThrow(/SUPPORT_CONVERSATION_ILLEGAL_TRANSITION/);
  });

  it("paginates the changing mobile queue with opaque cursors instead of offsets",async()=>{
    for(const [who,key] of [[memberOnly,"queue-member-only"],[reader,"queue-reader-only"]] as const)expect((await app.inject({method:"POST",url:"/v1/me/support/messages",headers:auth(who.sessionToken),payload:{body:"分页会话",clientMessageId:key}})).statusCode).toBe(200);
    const ids:string[]=[];let next:string|null=null;
    for(let index=0;index<3;index+=1){const page:{items:Array<{id:string}>;nextCursor:string|null}=(await app.inject({method:"GET",url:`/v1/management/support/conversations?limit=1${next?`&cursor=${encodeURIComponent(next)}`:""}`,headers:auth(operatorA.sessionToken)})).json();ids.push(page.items[0]!.id);next=page.nextCursor;}
    expect(new Set(ids).size).toBe(3);expect(next).toBeNull();
    expect((await app.inject({method:"GET",url:"/v1/management/support/conversations?cursor=not-a-cursor",headers:auth(operatorA.sessionToken)})).statusCode).toBe(422);
  });

  it("pages older chat history without gaps or an ambiguous extra cursor",async()=>{
    for(let index=0;index<45;index+=1)expect((await app.inject({method:"POST",url:"/v1/me/support/messages",headers:auth(user.sessionToken),payload:{body:`历史消息 ${index}`,clientMessageId:`member-history-${index}`}})).statusCode).toBe(200);
    const latest=(await app.inject({method:"GET",url:"/v1/me/support/messages?limit=50",headers:auth(user.sessionToken)})).json();
    expect(latest.messages).toHaveLength(50);expect(typeof latest.olderCursor).toBe("number");
    const older=(await app.inject({method:"GET",url:`/v1/me/support/messages?limit=50&before=${latest.olderCursor}`,headers:auth(user.sessionToken)})).json();
    expect(older.messages.length).toBeGreaterThan(0);expect(older.olderCursor).toBeNull();
    expect(new Set([...older.messages,...latest.messages].map((item:any)=>item.sequence)).size).toBe(older.messages.length+latest.messages.length);
    expect(older.messages.at(-1).sequence+1).toBe(latest.messages[0].sequence);
  });

  it("purges only an eligible resolved conversation, honors legal hold, and replays idempotently",async()=>{
    const userConversation=(await pool.query("SELECT * FROM support_conversation WHERE member_id=$1",[user.memberId])).rows[0];
    const otherConversation=(await pool.query("SELECT * FROM support_conversation WHERE member_id=$1",[memberOnly.memberId])).rows[0];
    expect((await app.inject({method:"POST",url:`/v1/management/support/conversations/${userConversation.id}/purge`,headers:{...auth(operatorA.sessionToken),"idempotency-key":"support-retention-no-cap"},payload:{expectedVersion:userConversation.version}})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:`/v1/management/support/conversations/${userConversation.id}/purge`,headers:{...auth(privacyOperator.sessionToken),"idempotency-key":"support-retention-pending"},payload:{expectedVersion:userConversation.version}})).json().code).toBe("SUPPORT_RETENTION_POLICY_PENDING");
    await pool.query(`UPDATE data_retention_policy SET duration_days=1,enforcement_state='enforced',active=true,version=version+1,updated_at=now()
      WHERE code='support_conversation_policy_pending'`);
    const resolved=(await pool.query(`UPDATE support_conversation SET status='resolved',current_handler_principal_id=NULL,resolved_at=now()-interval '2 days',
      version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[userConversation.id])).rows[0];
    expect((await app.inject({method:"GET",url:`/v1/management/support/conversations/${resolved.id}/retention`,headers:auth(privacyOperator.sessionToken)})).json()).toMatchObject({eligible:true,reason:"eligible",durationDays:1,activeLegalHolds:0});
    const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
      VALUES('SYNTHETIC_SUPPORT_HOLD','Synthetic support retention hold verification only','privacy-operator',now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0];
    await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'support_conversation',$2)",[hold.id,resolved.id]);
    const held=await app.inject({method:"POST",url:`/v1/management/support/conversations/${resolved.id}/purge`,headers:{...auth(privacyOperator.sessionToken),"idempotency-key":"support-retention-held"},payload:{expectedVersion:resolved.version}});
    expect(held.statusCode).toBe(423);expect(held.json().code).toBe("SUPPORT_RETENTION_LEGAL_HOLD");
    await pool.query("UPDATE legal_hold SET status='released',released_by='privacy-operator',released_at=now() WHERE id=$1",[hold.id]);
    await expect(pool.query("DELETE FROM support_conversation WHERE id=$1",[otherConversation.id])).rejects.toThrow(/SUPPORT_CONVERSATION_PURGE_PATH_REQUIRED/);
    const headers={...auth(privacyOperator.sessionToken),"idempotency-key":"support-retention-purge-01"};
    const first=await app.inject({method:"POST",url:`/v1/management/support/conversations/${resolved.id}/purge`,headers,payload:{expectedVersion:resolved.version}});
    expect(first.statusCode).toBe(200);expect(first.json()).toMatchObject({conversationId:resolved.id,purged:true,policyCode:"support_conversation_policy_pending"});expect(first.json().messagesPurged).toBeGreaterThan(0);
    const replay=await app.inject({method:"POST",url:`/v1/management/support/conversations/${resolved.id}/purge`,headers,payload:{expectedVersion:resolved.version}});
    expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual(first.json());
    expect((await pool.query("SELECT 1 FROM support_conversation WHERE id=$1",[resolved.id])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM support_message WHERE conversation_id=$1",[resolved.id])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM support_conversation WHERE id=$1",[otherConversation.id])).rowCount).toBe(1);
    const tombstone=(await pool.query("SELECT before_state,after_state FROM audit_log WHERE action='support.retention.purge' AND object_id=$1",[resolved.id])).rows[0];
    expect(tombstone).toBeTruthy();expect(JSON.stringify(tombstone)).not.toContain(user.memberId);expect(JSON.stringify(tombstone)).not.toContain("历史消息");
    const event=(await pool.query("SELECT payload FROM outbox_event WHERE event_type='support.conversation.purged.v1' AND aggregate_id=$1",[resolved.id])).rows[0];
    expect(event).toBeTruthy();expect(JSON.stringify(event)).not.toContain(user.memberId);expect(JSON.stringify(event)).not.toContain("历史消息");
  });
});

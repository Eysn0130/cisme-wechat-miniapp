import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Capability, SupportConversationStatus, SupportMessageView } from "@cisme/contracts";
import { DomainError } from "@cisme/domain";
import { AuthorityService } from "./authority.js";
import { transaction, type DbClient } from "./db.js";
import { enqueue } from "./outbox.js";

type ConversationRow = {
  id: string; member_id: string; status: SupportConversationStatus; priority: "normal" | "high" | "urgent";
  current_handler_principal_id: string | null; next_sequence: string; member_unread_count: number;
  team_unread_count: number; member_last_read_sequence:string; team_last_read_sequence:string; version: number; updated_at: Date;
  resolved_at?: Date | null;
};
type MessageRow = { id: string; sequence: string; sender_type: "user" | "ai" | "admin" | "system"; body: string; attachment_refs: string[]; delivery_state: "persisted" | "read"; created_at: Date };

function required(value: string | undefined, code: string): string {
  if (!value) throw new DomainError(code, "Authenticated principal required", 401);
  return value;
}
function textBody(input: unknown): string {
  if (typeof input !== "string") throw new DomainError("SUPPORT_MESSAGE_INVALID", "Message text is required", 422);
  const value = input.trim();
  if (!value || Array.from(value).length > 4000) throw new DomainError("SUPPORT_MESSAGE_INVALID", "Message must contain 1 to 4000 characters", 422);
  return value;
}
function clientMessageId(input: unknown): string {
  if (typeof input !== "string" || input.length < 8 || input.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(input)) {
    throw new DomainError("CLIENT_MESSAGE_ID_INVALID", "clientMessageId must be 8 to 200 safe characters", 422);
  }
  return input;
}
function version(input: unknown): number {
  if (!Number.isInteger(input) || Number(input) < 1) throw new DomainError("VERSION_INVALID", "A positive expectedVersion is required", 422);
  return Number(input);
}
function limit(input: unknown): number {
  const value = input === undefined ? 50 : Number(input);
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new DomainError("PAGE_LIMIT_INVALID", "limit must be between 1 and 100", 422);
  return value;
}
function cursor(input: unknown): number | null {
  if (input === undefined) return null;
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError("CURSOR_INVALID", "Message cursor is invalid", 422);
  return value;
}
function queueCursor(input: unknown): {rank:number;unreadRank:number;at:string;id:string}|null {
  if(input===undefined)return null;
  try{const value=JSON.parse(Buffer.from(String(input),"base64url").toString("utf8")) as Record<string,unknown>;
    if(!Number.isInteger(value.rank)||!Number.isInteger(value.unreadRank)||typeof value.at!=="string"||!Number.isFinite(Date.parse(value.at))||typeof value.id!=="string"||!/^[0-9a-f-]{36}$/i.test(value.id))throw new Error();
    return {rank:Number(value.rank),unreadRank:Number(value.unreadRank),at:value.at,id:value.id};
  }catch{throw new DomainError("CURSOR_INVALID","Support queue cursor is invalid",422);}
}
function encodeQueueCursor(row:{rank:number;unread_rank:number;updated_at:Date;id:string}):string{return Buffer.from(JSON.stringify({rank:row.rank,unreadRank:row.unread_rank,at:row.updated_at.toISOString(),id:row.id})).toString("base64url");}
function view(row: MessageRow): SupportMessageView {
  return { id: row.id, sequence: Number(row.sequence), senderType: row.sender_type, body: row.body, attachmentRefs: row.attachment_refs, deliveryState: row.delivery_state, createdAt: row.created_at.toISOString() };
}
function conversation(row: ConversationRow) {
  return { id: row.id, status: row.status, priority: row.priority,
    memberUnreadCount: row.member_unread_count, teamUnreadCount: row.team_unread_count, version: row.version, updatedAt: row.updated_at.toISOString() };
}
function requestHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function modelSafeSupportProjection(input: { conversation: ConversationRow; messages: MessageRow[] }) {
  return { conversationId: input.conversation.id, status: input.conversation.status,
    messages: input.messages.map((row) => ({ sequence: Number(row.sequence), senderType: row.sender_type, body: row.body })) };
}

export class SupportService {
  constructor(private readonly pool: pg.Pool, private readonly authority: AuthorityService) {}

  private async findForMember(client: DbClient | pg.Pool, memberId: string, lock = false): Promise<ConversationRow | null> {
    const result = await client.query<ConversationRow>(`SELECT * FROM support_conversation WHERE member_id=$1${lock ? " FOR UPDATE" : ""}`, [memberId]);
    return result.rows[0] ?? null;
  }
  private async findById(client: DbClient | pg.Pool, id: string, lock = false): Promise<ConversationRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError("SUPPORT_CONVERSATION_INVALID", "Conversation id is invalid", 422);
    const result = await client.query<ConversationRow>(`SELECT * FROM support_conversation WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
    if (!result.rows[0]) throw new DomainError("SUPPORT_CONVERSATION_NOT_FOUND", "Support conversation was not found", 404);
    return result.rows[0];
  }

  async modelProjectionForAssignedOperator(memberId:string|undefined,principalId:string|undefined,id:string) {
    await this.authority.require(memberId,"support.reply");
    const principal=required(principalId,"AUTH_REQUIRED");
    const row=await this.findById(this.pool,id);
    if(row.status!=="human_active"||row.current_handler_principal_id!==principal)throw new DomainError("SUPPORT_OWNERSHIP_CONFLICT","Claim the conversation before requesting a suggested reply",409);
    const messages=await this.pool.query<MessageRow>(`SELECT id,sequence,sender_type,body,attachment_refs,delivery_state,created_at FROM support_message WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT 50`,[id]);
    return modelSafeSupportProjection({conversation:row,messages:messages.rows.reverse()});
  }
  private async audit(client: DbClient, principalId: string, action: string, objectId: string, before: unknown, after: unknown, traceId: string) {
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
      VALUES($1,$2,'support_conversation',$3,'SUPPORT_CASE_HANDLING',$4,$5,$6)`, [principalId, action, objectId, before, after, traceId]);
  }

  private async retentionState(client: DbClient | pg.Pool, row: ConversationRow) {
    const policy = await client.query<{code:string;duration_days:number|null;enforcement_state:"declared"|"enforced";active:boolean;version:number}>(`SELECT code,duration_days,enforcement_state,active,version
      FROM data_retention_policy WHERE code='support_conversation_policy_pending'`);
    if (!policy.rows[0]) throw new DomainError("SUPPORT_RETENTION_POLICY_MISSING", "Support retention policy is not configured", 503);
    const current = policy.rows[0];
    const hold = await client.query<{count:number}>(`SELECT count(*)::int AS count FROM legal_hold_binding binding
      JOIN legal_hold hold ON hold.id=binding.hold_id
      WHERE hold.status='active' AND hold.expires_at>clock_timestamp() AND (
        (binding.object_type='support_conversation' AND binding.object_id=$1)
        OR (binding.object_type='member' AND binding.object_id=$2)
      )`, [row.id, row.member_id]);
    const due = current.duration_days !== null && row.resolved_at
      ? await client.query<{eligible:boolean;eligible_at:Date}>(`SELECT clock_timestamp() >= $1::timestamptz + make_interval(days=>$2) AS eligible,
          $1::timestamptz + make_interval(days=>$2) AS eligible_at`, [row.resolved_at, current.duration_days])
      : null;
    const policyReady = current.active && current.enforcement_state === "enforced" && current.duration_days !== null;
    const reason = !policyReady ? "policy_pending" : row.status !== "resolved" || !row.resolved_at ? "not_resolved"
      : hold.rows[0]!.count > 0 ? "legal_hold" : !due?.rows[0]?.eligible ? "not_due" : "eligible";
    return { eligible: reason === "eligible", reason, policyCode: current.code, policyVersion: current.version,
      durationDays: current.duration_days, eligibleAt: due?.rows[0]?.eligible_at.toISOString() ?? null, activeLegalHolds: hold.rows[0]!.count };
  }

  async summary(memberId: string | undefined) {
    const owner = required(memberId, "AUTH_REQUIRED");
    const row = await this.findForMember(this.pool, owner);
    return row ? { conversation: conversation(row), unreadCount: row.member_unread_count } : { conversation: null, unreadCount: 0 };
  }

  async messagesForMember(memberId: string | undefined, query: { after?: unknown; before?: unknown; limit?: unknown }) {
    const owner = required(memberId, "AUTH_REQUIRED");
    const row = await this.findForMember(this.pool, owner);
    if (!row) return { conversation: null, messages: [], latestCursor: 0, olderCursor: null };
    return this.messagePage(row, query);
  }

  private async messagePage(row: ConversationRow, query: { after?: unknown; before?: unknown; limit?: unknown }) {
    const pageLimit = limit(query.limit);
    const after = cursor(query.after);
    const before = cursor(query.before);
    if (after !== null && before !== null) throw new DomainError("CURSOR_INVALID", "Use either after or before, not both", 422);
    let result: pg.QueryResult<MessageRow>;
    if (after !== null) result = await this.pool.query<MessageRow>(`SELECT id,sequence,sender_type,body,attachment_refs,delivery_state,created_at FROM support_message
      WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence ASC LIMIT $3`, [row.id, after, pageLimit]);
    else if (before !== null) result = await this.pool.query<MessageRow>(`SELECT * FROM (SELECT id,sequence,sender_type,body,attachment_refs,delivery_state,created_at FROM support_message
      WHERE conversation_id=$1 AND sequence<$2 ORDER BY sequence DESC LIMIT $3) recent ORDER BY sequence ASC`, [row.id, before, pageLimit + 1]);
    else result = await this.pool.query<MessageRow>(`SELECT * FROM (SELECT id,sequence,sender_type,body,attachment_refs,delivery_state,created_at FROM support_message
      WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT $2) recent ORDER BY sequence ASC`, [row.id, pageLimit + 1]);
    const hasOlder = after === null && result.rows.length > pageLimit;
    const pageRows = hasOlder ? result.rows.slice(result.rows.length - pageLimit) : result.rows;
    const messages = pageRows.map(view);
    return { conversation: conversation(row), messages, latestCursor: messages.at(-1)?.sequence ?? Number(row.next_sequence) - 1,
      olderCursor: hasOlder ? messages[0]!.sequence : null };
  }

  async sendMember(memberId: string | undefined, principalId: string | undefined, input: { body?: unknown; clientMessageId?: unknown }, traceId: string) {
    const owner = required(memberId, "AUTH_REQUIRED");
    const principal = required(principalId, "AUTH_REQUIRED");
    const body = textBody(input.body); const messageKey = clientMessageId(input.clientMessageId);
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`support-member:${owner}`]);
      let row = await this.findForMember(client, owner, true);
      if (!row) {
        const created = await client.query<ConversationRow>(`INSERT INTO support_conversation(member_id,status)
          VALUES($1,'waiting_human') RETURNING *`, [owner]); row = created.rows[0]!;
      }
      const duplicate = await client.query<MessageRow>(`SELECT id,sequence,sender_type,body,attachment_refs,delivery_state,created_at FROM support_message
        WHERE conversation_id=$1 AND sender_type='user' AND sender_principal_id=$2 AND client_message_id=$3`, [row.id, principal, messageKey]);
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].body !== body) throw new DomainError("IDEMPOTENCY_CONFLICT", "clientMessageId was reused with different text", 409);
        return { conversation: conversation(row), message: view(duplicate.rows[0]), replayed: true };
      }
      const sequence = Number(row.next_sequence); const messageId = randomUUID();
      const reopened = row.status === "resolved";
      const nextStatus: SupportConversationStatus = reopened ? "waiting_human" : row.status;
      const inserted = await client.query<MessageRow>(`INSERT INTO support_message(id,conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id)
        VALUES($1,$2,$3,'user',$4,$5,$6) RETURNING id,sequence,sender_type,body,attachment_refs,delivery_state,created_at`, [messageId, row.id, sequence, principal, body, messageKey]);
      const updated = await client.query<ConversationRow>(`UPDATE support_conversation SET next_sequence=next_sequence+1,team_unread_count=team_unread_count+1,
        status=$2,current_handler_principal_id=CASE WHEN $3 THEN NULL ELSE current_handler_principal_id END,resolved_at=NULL,version=version+1,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [row.id, nextStatus, reopened]);
      row = updated.rows[0]!;
      await enqueue(client, { eventType: "support.message.created.v1", aggregateType: "support_conversation", aggregateId: row.id,
        aggregateVersion: row.version, businessKey: `support-message:${messageId}`, payload: { conversationId: row.id, messageId, senderType: "user", sequence }, occurredAt: inserted.rows[0]!.created_at });
      return { conversation: conversation(row), message: view(inserted.rows[0]!), replayed: false };
    });
  }

  async requestHuman(memberId: string | undefined, principalId: string | undefined) {
    const owner = required(memberId, "AUTH_REQUIRED"); required(principalId, "AUTH_REQUIRED");
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`support-member:${owner}`]);
      let row = await this.findForMember(client, owner, true);
      if (!row) row = (await client.query<ConversationRow>("INSERT INTO support_conversation(member_id,status) VALUES($1,'waiting_human') RETURNING *", [owner])).rows[0]!;
      if (row.status === "human_active" || row.status === "waiting_human") return conversation(row);
      const updated = (await client.query<ConversationRow>(`UPDATE support_conversation SET status='waiting_human',current_handler_principal_id=NULL,resolved_at=NULL,
        version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [row.id])).rows[0]!;
      await enqueue(client, { eventType: "support.conversation.handoff_requested.v1", aggregateType: "support_conversation", aggregateId: row.id,
        aggregateVersion: updated.version, businessKey: `support-handoff:${row.id}:v${updated.version}`, payload: { conversationId: row.id }, occurredAt: updated.updated_at });
      return conversation(updated);
    });
  }

  async markMemberRead(memberId: string | undefined, input: { lastSeenSequence?: unknown }) {
    const owner = required(memberId, "AUTH_REQUIRED"); const seen = cursor(input.lastSeenSequence);
    if (seen === null) throw new DomainError("CURSOR_INVALID", "lastSeenSequence is required", 422);
    return transaction(this.pool, async (client) => {
      const row = await this.findForMember(client, owner, true);
      if (!row) return null;
      const effectiveSeen = Math.max(Number(row.member_last_read_sequence), Math.min(seen, Number(row.next_sequence) - 1));
      const unread = await client.query<{count:number}>(`SELECT count(*)::int AS count FROM support_message
        WHERE conversation_id=$1 AND sequence>$2 AND sender_type IN ('ai','admin','system')`, [row.id, effectiveSeen]);
      const updated = await client.query<ConversationRow>(`UPDATE support_conversation
        SET member_last_read_sequence=$2,member_unread_count=$3 WHERE id=$1 RETURNING *`, [row.id, effectiveSeen, unread.rows[0]!.count]);
      return conversation(updated.rows[0]!);
    });
  }

  private async operator(memberId: string | undefined, capability: Capability): Promise<string> {
    return this.authority.require(memberId, capability);
  }
  async queue(memberId: string | undefined, query: { cursor?: unknown; limit?: unknown }) {
    await this.operator(memberId, "support.read"); const pageLimit = limit(query.limit); const after=queueCursor(query.cursor);
    const result = await this.pool.query(`WITH ranked AS (SELECT c.id,c.status,c.priority,c.current_handler_principal_id,c.member_unread_count,c.team_unread_count,c.version,c.updated_at,
      m.display_name AS member_display_name,latest.body AS last_message,latest.sender_type AS last_sender_type,
      CASE c.status WHEN 'waiting_human' THEN 0 WHEN 'human_active' THEN 1 WHEN 'ai_active' THEN 2 ELSE 3 END AS rank,
      CASE WHEN c.team_unread_count>0 THEN 0 ELSE 1 END AS unread_rank
      FROM support_conversation c JOIN member m ON m.id=c.member_id
      LEFT JOIN LATERAL(SELECT body,sender_type FROM support_message WHERE conversation_id=c.id ORDER BY sequence DESC LIMIT 1) latest ON true)
      SELECT * FROM ranked WHERE $1::int IS NULL OR rank>$1 OR (rank=$1 AND unread_rank>$2) OR
        (rank=$1 AND unread_rank=$2 AND updated_at<$3::timestamptz) OR
        (rank=$1 AND unread_rank=$2 AND updated_at=$3::timestamptz AND id::text<$4)
      ORDER BY rank,unread_rank,updated_at DESC,id DESC LIMIT $5`, [after?.rank??null,after?.unreadRank??null,after?.at??null,after?.id??null,pageLimit+1]);
    return { items: result.rows.slice(0, pageLimit).map((item: any) => ({ id:item.id,status:item.status,priority:item.priority,
      memberUnreadCount:item.member_unread_count,teamUnreadCount:item.team_unread_count,version:item.version,updatedAt:item.updated_at.toISOString(),memberDisplayName:item.member_display_name,
      lastMessage:item.last_message ?? "暂无消息",lastSenderType:item.last_sender_type ?? null })), nextCursor: result.rows.length > pageLimit ? encodeQueueCursor(result.rows[pageLimit-1]) : null };
  }
  async operatorMessages(memberId: string | undefined, principalId: string | undefined, id: string, query: { after?: unknown; before?: unknown; limit?: unknown }) {
    await this.operator(memberId, "support.read"); const principal=required(principalId,"AUTH_REQUIRED");const row=await this.findById(this.pool,id);
    const page=await this.messagePage(row,query);const member=await this.pool.query<{display_name:string}>("SELECT display_name FROM member WHERE id=$1",[row.member_id]);
    return {...page,memberDisplayName:member.rows[0]?.display_name??"CISME 会员",assignedToMe:row.current_handler_principal_id===principal};
  }
  async claim(memberId: string | undefined, principalId: string | undefined, id: string, input: { expectedVersion?: unknown }, traceId: string) {
    await this.operator(memberId, "support.assign"); const principal = required(principalId, "AUTH_REQUIRED"); const expected = version(input.expectedVersion);
    return transaction(this.pool, async (client) => {
      const row = await this.findById(client, id, true);
      if (row.status === "human_active" && row.current_handler_principal_id === principal) return conversation(row);
      if (row.version !== expected) throw new DomainError("VERSION_CONFLICT", "Conversation changed; reload before claiming", 409);
      if (row.status === "resolved") throw new DomainError("SUPPORT_CONVERSATION_RESOLVED", "Resolved conversation must be reopened by the member", 409);
      if (row.status === "human_active") throw new DomainError("SUPPORT_ALREADY_ASSIGNED", "Conversation is already assigned", 409);
      const updated = (await client.query<ConversationRow>(`UPDATE support_conversation SET status='human_active',current_handler_principal_id=$2,
        resolved_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id, principal])).rows[0]!;
      await this.audit(client, principal, "support.conversation.claim", id, conversation(row), conversation(updated), traceId);
      await enqueue(client, { eventType: "support.conversation.claimed.v1", aggregateType: "support_conversation", aggregateId: id,
        aggregateVersion: updated.version, businessKey: `support-claim:${id}:v${updated.version}`, payload: { conversationId:id,claimedBy:principal }, occurredAt:updated.updated_at });
      return conversation(updated);
    });
  }
  async reply(memberId: string | undefined, principalId: string | undefined, id: string, input: { body?: unknown; clientMessageId?: unknown }, traceId: string) {
    await this.operator(memberId, "support.reply"); const principal = required(principalId, "AUTH_REQUIRED");
    const body=textBody(input.body); const messageKey=clientMessageId(input.clientMessageId);
    return transaction(this.pool, async (client) => {
      let row=await this.findById(client,id,true);
      const duplicate=await client.query<MessageRow>(`SELECT id,sequence,sender_type,body,attachment_refs,delivery_state,created_at FROM support_message
        WHERE conversation_id=$1 AND sender_type='admin' AND sender_principal_id=$2 AND client_message_id=$3`,[id,principal,messageKey]);
      if(duplicate.rows[0]){if(duplicate.rows[0].body!==body)throw new DomainError("IDEMPOTENCY_CONFLICT","clientMessageId was reused with different text",409);return {conversation:conversation(row),message:view(duplicate.rows[0]),replayed:true};}
      if(row.status!=="human_active"||row.current_handler_principal_id!==principal)throw new DomainError("SUPPORT_ASSIGNMENT_REQUIRED","Claim this conversation before replying",409);
      const sequence=Number(row.next_sequence);const messageId=randomUUID();
      const inserted=(await client.query<MessageRow>(`INSERT INTO support_message(id,conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id)
        VALUES($1,$2,$3,'admin',$4,$5,$6) RETURNING id,sequence,sender_type,body,attachment_refs,delivery_state,created_at`,[messageId,id,sequence,principal,body,messageKey])).rows[0]!;
      row=(await client.query<ConversationRow>(`UPDATE support_conversation SET next_sequence=next_sequence+1,member_unread_count=member_unread_count+1,
        version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id])).rows[0]!;
      await this.audit(client,principal,"support.message.reply",id,null,{messageId,sequence},traceId);
      await enqueue(client,{eventType:"support.message.created.v1",aggregateType:"support_conversation",aggregateId:id,aggregateVersion:row.version,
        businessKey:`support-message:${messageId}`,payload:{conversationId:id,messageId,senderType:"admin",sequence},occurredAt:inserted.created_at});
      return {conversation:conversation(row),message:view(inserted),replayed:false};
    });
  }
  async markTeamRead(memberId:string|undefined,id:string,input:{lastSeenSequence?:unknown}){
    await this.operator(memberId,"support.read");const seen=cursor(input.lastSeenSequence);if(seen===null)throw new DomainError("CURSOR_INVALID","lastSeenSequence is required",422);
    return transaction(this.pool,async client=>{const row=await this.findById(client,id,true);
      const effectiveSeen=Math.max(Number(row.team_last_read_sequence),Math.min(seen,Number(row.next_sequence)-1));
      const unread=await client.query<{count:number}>("SELECT count(*)::int AS count FROM support_message WHERE conversation_id=$1 AND sequence>$2 AND sender_type='user'",[row.id,effectiveSeen]);
      const updated=await client.query<ConversationRow>("UPDATE support_conversation SET team_last_read_sequence=$2,team_unread_count=$3 WHERE id=$1 RETURNING *",[row.id,effectiveSeen,unread.rows[0]!.count]);
      return conversation(updated.rows[0]!);});
  }
  async resolve(memberId:string|undefined,principalId:string|undefined,id:string,input:{expectedVersion?:unknown},traceId:string){
    await this.operator(memberId,"support.reply");const principal=required(principalId,"AUTH_REQUIRED");const expected=version(input.expectedVersion);
    return transaction(this.pool,async client=>{const row=await this.findById(client,id,true);if(row.status==="resolved")return conversation(row);
      if(row.version!==expected)throw new DomainError("VERSION_CONFLICT","Conversation changed; reload before resolving",409);
      if(row.status!=="human_active"||row.current_handler_principal_id!==principal)throw new DomainError("SUPPORT_ASSIGNMENT_REQUIRED","Only the assigned operator can resolve",409);
      const updated=(await client.query<ConversationRow>(`UPDATE support_conversation SET status='resolved',current_handler_principal_id=NULL,resolved_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id])).rows[0]!;
      await this.audit(client,principal,"support.conversation.resolve",id,conversation(row),conversation(updated),traceId);
      await enqueue(client,{eventType:"support.conversation.resolved.v1",aggregateType:"support_conversation",aggregateId:id,aggregateVersion:updated.version,
        businessKey:`support-resolve:${id}:v${updated.version}`,payload:{conversationId:id,resolvedBy:principal},occurredAt:updated.updated_at});return conversation(updated);});
  }
  async memberContext(memberId:string|undefined,principalId:string|undefined,id:string,traceId:string){
    await this.operator(memberId,"member.support_view");const principal=required(principalId,"AUTH_REQUIRED");
    return transaction(this.pool,async client=>{const row=await this.findById(client,id);const result=await client.query(`SELECT m.display_name,m.status,m.created_at,c.phone_masked
      FROM member m LEFT JOIN member_contact c ON c.member_id=m.id WHERE m.id=$1`,[row.member_id]);
      const projection={displayName:result.rows[0].display_name,memberStatus:result.rows[0].status,memberSince:result.rows[0].created_at.toISOString(),maskedPhone:result.rows[0].phone_masked??null};
      await this.audit(client,principal,"support.member_context.view",id,null,{fields:Object.keys(projection)},traceId);return projection;});
  }

  async retentionEligibility(memberId:string|undefined,id:string){
    await this.operator(memberId,"privacy.request.manage");
    const row=await this.findById(this.pool,id);
    return this.retentionState(this.pool,row);
  }

  async purge(memberId:string|undefined,principalId:string|undefined,id:string,idempotencyKey:string,input:{expectedVersion?:unknown},traceId:string){
    await this.operator(memberId,"privacy.request.manage");
    const principal=required(principalId,"AUTH_REQUIRED");
    const expected=version(input.expectedVersion);
    const operation="support.retention.purge";
    const hash=requestHash({conversationId:id,expectedVersion:expected});
    return transaction(this.pool,async client=>{
      const replay=await client.query<{request_hash:string;response_body:Record<string,unknown>}>(`SELECT request_hash,response_body FROM idempotency_operation
        WHERE principal_id=$1 AND operation=$2 AND idempotency_key=$3`,[principal,operation,idempotencyKey]);
      if(replay.rows[0]){
        if(replay.rows[0].request_hash!==hash)throw new DomainError("IDEMPOTENCY_CONFLICT","Idempotency key was used for another purge",409);
        return replay.rows[0].response_body;
      }
      const row=await this.findById(client,id,true);
      if(row.version!==expected)throw new DomainError("VERSION_CONFLICT","Conversation changed; reload before purging",409);
      const state=await this.retentionState(client,row);
      if(state.reason==="policy_pending")throw new DomainError("SUPPORT_RETENTION_POLICY_PENDING","Support retention remains POLICY PENDING and cannot delete data",409);
      if(state.reason==="not_resolved")throw new DomainError("SUPPORT_RETENTION_NOT_RESOLVED","Only resolved conversations can become purge eligible",409);
      if(state.reason==="legal_hold")throw new DomainError("SUPPORT_RETENTION_LEGAL_HOLD","An active legal hold blocks this purge",423);
      if(state.reason!=="eligible")throw new DomainError("SUPPORT_RETENTION_NOT_DUE","The approved retention period has not elapsed",409);
      const messageCount=(await client.query<{count:number}>("SELECT count(*)::int AS count FROM support_message WHERE conversation_id=$1",[id])).rows[0]!.count;
      await client.query("SELECT set_config('cisme.support_purge_conversation_id',$1,true)",[id]);
      await client.query("DELETE FROM support_message WHERE conversation_id=$1",[id]);
      await client.query("DELETE FROM support_conversation WHERE id=$1",[id]);
      const auditId=(await client.query<{id:string}>(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'support.retention.purge','support_conversation',$2,'SUPPORT_RETENTION_POLICY',
          jsonb_build_object('policyCode',$3::text,'policyVersion',$4::integer,'messageCount',$5::integer,'resolvedAt',$6::timestamptz),
          jsonb_build_object('purged',true),$7) RETURNING id`,[principal,id,state.policyCode,state.policyVersion,messageCount,row.resolved_at,traceId])).rows[0]!.id;
      const response={conversationId:id,purged:true,messagesPurged:messageCount,policyCode:state.policyCode,policyVersion:state.policyVersion,auditTombstoneId:auditId};
      await enqueue(client,{eventType:"support.conversation.purged.v1",aggregateType:"support_conversation",aggregateId:id,aggregateVersion:row.version+1,
        businessKey:`support-purge:${id}`,payload:{conversationId:id,policyCode:state.policyCode,policyVersion:state.policyVersion,messageCount},occurredAt:new Date()});
      await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
        VALUES($1,$2,$3,$4,$5,200,$6)`,[principal,operation,idempotencyKey,`support-purge:${id}`,hash,response]);
      return response;
    });
  }
}

import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Capability, CommerceOrderStatus, SupportConversationStatus, SupportMessageContentType, SupportMessageView, SupportPresenceView, UploadAuthorization } from "@cisme/contracts";
import { DomainError } from "@cisme/domain";
import { AuthorityService } from "./authority.js";
import { transaction, type DbClient } from "./db.js";
import { enqueue } from "./outbox.js";
import type { PlatformService } from "./platformService.js";
import type { ObjectStorage } from "./storage.js";

type ConversationRow = {
  id: string; member_id: string; status: SupportConversationStatus; priority: "normal" | "high" | "urgent";
  current_handler_principal_id: string | null; next_sequence: string; member_unread_count: number;
  team_unread_count: number; member_last_read_sequence:string; team_last_read_sequence:string; version: number; updated_at: Date;
  resolved_at?: Date | null;
};
type OrderCard = { orderId: string; orderNumberTail: string; status: CommerceOrderStatus; currency: "CNY"; totalCents: number; productName: string; productImage: string | null; itemSummary: string };
type MessageRow = { id: string; sequence: string; sender_type: "user" | "ai" | "admin" | "system"; body: string; attachment_refs: string[];
  content_type: SupportMessageContentType; linked_order_id: string | null; order_snapshot: OrderCard | null;
  linked_case_id:string|null;return_instruction_snapshot:Omit<NonNullable<SupportMessageView['returnInstruction']>,'caseId'>|null;created_at: Date };
type MediaRow = { id: string; mime_type: "image/jpeg" | "image/png" | "image/webp"; size_bytes: string | number };

function required(value: string | undefined, code: string): string {
  if (!value) throw new DomainError(code, "Authenticated principal required", 401);
  return value;
}
function textBody(input: unknown, optional = false): string {
  if (input === undefined && optional) return "";
  if (typeof input !== "string") throw new DomainError("SUPPORT_MESSAGE_INVALID", "Message text is required", 422);
  const value = input.trim();
  if ((!optional && !value) || Array.from(value).length > 4000) throw new DomainError("SUPPORT_MESSAGE_INVALID", "Message must contain no more than 4000 characters", 422);
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
function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new DomainError(code, "Identifier is invalid", 422);
  return value;
}
function mediaIds(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 3) throw new DomainError("SUPPORT_MEDIA_INVALID", "Up to three support images are allowed", 422);
  const ids = input.map((item) => uuid(item, "SUPPORT_MEDIA_INVALID"));
  if (new Set(ids).size !== ids.length) throw new DomainError("SUPPORT_MEDIA_INVALID", "Support image references must be unique", 422);
  return ids;
}
function contentType(body: string, images: readonly string[], orderId: string | null): SupportMessageContentType {
  if (!body && !images.length && !orderId) throw new DomainError("SUPPORT_MESSAGE_INVALID", "Text, an image, or an order is required", 422);
  if (images.length && !body && !orderId) return "image";
  if (orderId && !body && !images.length) return "order";
  if (images.length || orderId) return "mixed";
  return "text";
}
function messageColumns(): string {
  return "id,sequence,sender_type,body,attachment_refs,content_type,linked_order_id,order_snapshot,linked_case_id,return_instruction_snapshot,created_at";
}
function view(row: MessageRow, input: { counterpartyReadSequence: number; previewPrefix: string; media: ReadonlyMap<string, MediaRow> }): SupportMessageView {
  const attachments = (Array.isArray(row.attachment_refs) ? row.attachment_refs : []).flatMap((id) => {
    const media = input.media.get(id);
    return media ? [{ id, mimeType: media.mime_type, sizeBytes: Number(media.size_bytes), previewPath: `${input.previewPrefix}/${id}` }] : [];
  });
  return { id: row.id, sequence: Number(row.sequence), senderType: row.sender_type, body: row.body, contentType: row.content_type,
    attachments, orderCard: row.order_snapshot ?? null,
    returnInstruction:row.linked_case_id&&row.return_instruction_snapshot?{caseId:row.linked_case_id,...row.return_instruction_snapshot}:null,
    deliveryState: Number(row.sequence) <= input.counterpartyReadSequence ? "read" : "server_accepted", createdAt: row.created_at.toISOString() };
}
function conversation(row: ConversationRow) {
  return { id: row.id, status: row.status, priority: row.priority,
    memberUnreadCount: row.member_unread_count, teamUnreadCount: row.team_unread_count,
    memberReadSequence: Number(row.member_last_read_sequence), teamReadSequence: Number(row.team_last_read_sequence),
    version: row.version, updatedAt: row.updated_at.toISOString() };
}
function requestHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function modelSafeSupportProjection(input: { conversation: ConversationRow; messages: Array<{sequence:string;sender_type:"user"|"ai"|"admin"|"system";body:string;[key:string]:unknown}> }) {
  return { conversationId: input.conversation.id, status: input.conversation.status,
    messages: input.messages.map((row) => ({ sequence: Number(row.sequence), senderType: row.sender_type, body: row.body })) };
}

export class SupportService {
  constructor(private readonly pool: pg.Pool, private readonly authority: AuthorityService, private readonly platform: PlatformService, private readonly storage: ObjectStorage) {}

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

  private async mediaMap(client: DbClient | pg.Pool, messages: readonly MessageRow[]): Promise<Map<string, MediaRow>> {
    const ids = [...new Set(messages.flatMap((row) => Array.isArray(row.attachment_refs) ? row.attachment_refs : []))];
    if (!ids.length) return new Map();
    const messageIds = messages.map((row) => row.id);
    const result = await client.query<MediaRow>(`SELECT id,mime_type,size_bytes FROM media_object
      WHERE id=ANY($1::uuid[]) AND bound_support_message_id=ANY($2::uuid[])
        AND upload_state='uploaded' AND support_conversation_id IS NOT NULL`, [ids, messageIds]);
    return new Map(result.rows.map((row) => [row.id, row]));
  }

  private async orderCard(client: DbClient, memberId: string, orderId: string | null): Promise<OrderCard | null> {
    if (!orderId) return null;
    const result = await client.query<{id:string;order_number:string;status:CommerceOrderStatus;currency:"CNY";total_cents:string;product_name:string;image_path:string|null;item_summary:string}>(`
      SELECT o.id,o.order_number,o.status,o.currency,o.total_cents,
        (array_agg(line.product_name ORDER BY line.line_number))[1] AS product_name,
        (array_agg(line.image_path ORDER BY line.line_number))[1] AS image_path,
        string_agg(line.product_name || ' · ' || line.sku_label || ' × ' || line.quantity, '；' ORDER BY line.line_number) AS item_summary
      FROM commerce_order o JOIN commerce_order_line line ON line.order_id=o.id
      WHERE o.id=$1 AND o.member_id=$2
      GROUP BY o.id`, [orderId, memberId]);
    const row = result.rows[0];
    if (!row) throw new DomainError("SUPPORT_ORDER_NOT_FOUND", "Order was not found for this member", 404);
    return { orderId: row.id, orderNumberTail: row.order_number.slice(-4), status: row.status, currency: row.currency,
      totalCents: Number(row.total_cents), productName: row.product_name, productImage: row.image_path, itemSummary: row.item_summary };
  }

  private async presence(row: ConversationRow, now = new Date()): Promise<SupportPresenceView> {
    const result = await this.pool.query<{agent_display_name:string;operator_online:boolean;operator_typing:boolean;member_online:boolean;member_typing:boolean}>(`
      SELECT COALESCE(profile.display_name,'CISME 客服') AS agent_display_name,
        COALESCE(operator.online_expires_at>$2,false) AS operator_online,
        COALESCE(operator.typing_expires_at>$2,false) AS operator_typing,
        COALESCE(member_presence.online_expires_at>$2,false) AS member_online,
        COALESCE(member_presence.typing_expires_at>$2,false) AS member_typing
      FROM support_conversation conversation
      LEFT JOIN support_operator_profile profile ON profile.principal_id=conversation.current_handler_principal_id
      LEFT JOIN support_presence operator ON operator.conversation_id=conversation.id AND operator.actor_type='operator'
        AND operator.actor_principal_id=conversation.current_handler_principal_id
      LEFT JOIN support_presence member_presence ON member_presence.conversation_id=conversation.id AND member_presence.actor_type='member'
      WHERE conversation.id=$1`, [row.id, now]);
    const state = result.rows[0];
    return { serverTime: now.toISOString(), agentDisplayName: state?.agent_display_name ?? "CISME 客服",
      operatorOnline: state?.operator_online === true, operatorTyping: state?.operator_typing === true,
      memberOnline: state?.member_online === true, memberTyping: state?.member_typing === true };
  }

  private async messageView(row: MessageRow, conversationRow: ConversationRow, perspective: "member" | "operator", media?: ReadonlyMap<string, MediaRow>) {
    const mediaRows = media ?? await this.mediaMap(this.pool, [row]);
    return view(row, {
      counterpartyReadSequence: Number(perspective === "member" ? conversationRow.team_last_read_sequence : conversationRow.member_last_read_sequence),
      previewPrefix: perspective === "member" ? "/v1/me/support/media" : `/v1/management/support/conversations/${conversationRow.id}/media`,
      media: mediaRows
    });
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
    // The original conversation can contain both ordinary consultation and
    // order/aftersale evidence. Never let the ordinary policy purge both.
    const linked=await client.query<{linked:boolean}>(`SELECT (
      EXISTS(SELECT 1 FROM support_message WHERE conversation_id=$1
        AND (linked_order_id IS NOT NULL OR linked_case_id IS NOT NULL))
      OR EXISTS(SELECT 1 FROM commerce_aftersale_case WHERE support_conversation_id=$1
        OR support_conversation_id IS NULL AND member_id=$2 AND created_at<=$3::timestamptz)
    ) AS linked`,[row.id,row.member_id,row.resolved_at]);
    const hold = await client.query<{count:number}>(`SELECT count(*)::int AS count FROM legal_hold_binding binding
      JOIN legal_hold hold ON hold.id=binding.hold_id
      WHERE hold.status='active' AND hold.expires_at>clock_timestamp() AND (
        (binding.object_type='support_conversation' AND binding.object_id=$1)
        OR (binding.object_type='member' AND binding.object_id=$2)
      )`, [row.id, row.member_id]);
    const openRights=(await client.query<{open:boolean}>(`SELECT EXISTS(SELECT 1 FROM privacy_request
      WHERE member_id=$1 AND status NOT IN ('completed','partially_completed','rejected','canceled')) AS open`,
      [row.member_id])).rows[0]?.open;
    if(linked.rows[0]?.linked){
      const policy=(await client.query<{code:string;version:number;duration_months:number|null}>(
        "SELECT code,version,duration_months FROM data_retention_policy WHERE code='support_transaction_three_years'")).rows[0];
      if(!policy)throw new DomainError('SUPPORT_RETENTION_POLICY_MISSING','交易客服保留规则尚未装配',503);
      return {eligible:false,reason:'transaction_scope_requires_separate_execution',policyCode:policy.code,
        policyVersion:policy.version,durationDays:null,durationMonths:policy.duration_months,eligibleAt:null,
        activeLegalHolds:hold.rows[0]!.count};
    }
    const policy = await client.query<{code:string;duration_days:number|null;duration_months:number|null;enforcement_state:"declared"|"enforced";active:boolean;version:number}>(`SELECT code,duration_days,duration_months,enforcement_state,active,version
      FROM data_retention_policy WHERE code='support_conversation_policy_pending'`);
    if (!policy.rows[0]) throw new DomainError("SUPPORT_RETENTION_POLICY_MISSING", "Support retention policy is not configured", 503);
    const current = policy.rows[0];
    const hasDuration=current.duration_days!==null||current.duration_months!==null;
    const due = hasDuration && row.resolved_at
      ? await client.query<{eligible:boolean;eligible_at:Date}>(`SELECT clock_timestamp() >= $1::timestamptz + make_interval(days=>$2,months=>$3) AS eligible,
          $1::timestamptz + make_interval(days=>$2,months=>$3) AS eligible_at`,
          [row.resolved_at,current.duration_days??0,current.duration_months??0])
      : null;
    const policyReady = current.active && current.enforcement_state === "enforced" && hasDuration;
    const reason = !policyReady ? "policy_pending" : row.status !== "resolved" || !row.resolved_at ? "not_resolved"
      : hold.rows[0]!.count > 0 ? "legal_hold" : openRights ? 'privacy_request_active'
      : !due?.rows[0]?.eligible ? "not_due" : "eligible";
    return { eligible: reason === "eligible", reason, policyCode: current.code, policyVersion: current.version,
      durationDays: current.duration_days,durationMonths:current.duration_months,
      eligibleAt: due?.rows[0]?.eligible_at.toISOString() ?? null, activeLegalHolds: hold.rows[0]!.count };
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
    return this.messagePage(row, query, "member");
  }

  private async messagePage(row: ConversationRow, query: { after?: unknown; before?: unknown; limit?: unknown }, perspective: "member" | "operator") {
    const pageLimit = limit(query.limit);
    const after = cursor(query.after);
    const before = cursor(query.before);
    if (after !== null && before !== null) throw new DomainError("CURSOR_INVALID", "Use either after or before, not both", 422);
    let result: pg.QueryResult<MessageRow>;
    if (after !== null) result = await this.pool.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message
      WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence ASC LIMIT $3`, [row.id, after, pageLimit]);
    else if (before !== null) result = await this.pool.query<MessageRow>(`SELECT * FROM (SELECT ${messageColumns()} FROM support_message
      WHERE conversation_id=$1 AND sequence<$2 ORDER BY sequence DESC LIMIT $3) recent ORDER BY sequence ASC`, [row.id, before, pageLimit + 1]);
    else result = await this.pool.query<MessageRow>(`SELECT * FROM (SELECT ${messageColumns()} FROM support_message
      WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT $2) recent ORDER BY sequence ASC`, [row.id, pageLimit + 1]);
    const hasOlder = after === null && result.rows.length > pageLimit;
    const pageRows = hasOlder ? result.rows.slice(result.rows.length - pageLimit) : result.rows;
    const media = await this.mediaMap(this.pool, pageRows);
    const messages = pageRows.map((messageRow) => view(messageRow, {
      counterpartyReadSequence: Number(perspective === "member" ? row.team_last_read_sequence : row.member_last_read_sequence),
      previewPrefix: perspective === "member" ? "/v1/me/support/media" : `/v1/management/support/conversations/${row.id}/media`,
      media
    }));
    return { conversation: conversation(row), presence: await this.presence(row), messages,
      latestCursor: messages.at(-1)?.sequence ?? Number(row.next_sequence) - 1, olderCursor: hasOlder ? messages[0]!.sequence : null };
  }

  async sendMember(memberId: string | undefined, principalId: string | undefined, input: { body?: unknown; clientMessageId?: unknown; mediaIds?: unknown; linkedOrderId?: unknown }, traceId: string) {
    const owner = required(memberId, "AUTH_REQUIRED");
    const principal = required(principalId, "AUTH_REQUIRED");
    const body = textBody(input.body, true); const messageKey = clientMessageId(input.clientMessageId);
    const images = mediaIds(input.mediaIds);
    const linkedOrderId = input.linkedOrderId === undefined || input.linkedOrderId === null || input.linkedOrderId === "" ? null : uuid(input.linkedOrderId, "SUPPORT_ORDER_INVALID");
    const messageContentType = contentType(body, images, linkedOrderId);
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`support-member:${owner}`]);
      let row = await this.findForMember(client, owner, true);
      if (!row) {
        const created = await client.query<ConversationRow>(`INSERT INTO support_conversation(member_id,status)
          VALUES($1,'waiting_human') RETURNING *`, [owner]); row = created.rows[0]!;
      }
      const duplicate = await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message
        WHERE conversation_id=$1 AND sender_type='user' AND sender_principal_id=$2 AND client_message_id=$3`, [row.id, principal, messageKey]);
      if (duplicate.rows[0]) {
        const prior = duplicate.rows[0];
        if (prior.body !== body || JSON.stringify(prior.attachment_refs ?? []) !== JSON.stringify(images) || prior.linked_order_id !== linkedOrderId) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "clientMessageId was reused with different support content", 409);
        }
        return { conversation: conversation(row), message: await this.messageView(prior, row, "member", await this.mediaMap(client, [prior])), replayed: true };
      }
      const order = await this.orderCard(client, owner, linkedOrderId);
      if (images.length) {
        const media = await client.query<{id:string}>(`SELECT id FROM media_object WHERE id=ANY($1::uuid[])
          AND support_conversation_id=$2 AND support_member_id=$3 AND upload_state='uploaded'
          AND bound_support_message_id IS NULL AND support_expires_at>clock_timestamp() FOR UPDATE`, [images, row.id, owner]);
        if (media.rowCount !== images.length) throw new DomainError("SUPPORT_MEDIA_NOT_FOUND", "A support image is unavailable or belongs to another conversation", 404);
      }
      const sequence = Number(row.next_sequence); const messageId = randomUUID();
      const reopened = row.status === "resolved";
      const nextStatus: SupportConversationStatus = reopened ? "waiting_human" : row.status;
      const inserted = await client.query<MessageRow>(`INSERT INTO support_message
        (id,conversation_id,sequence,sender_type,sender_principal_id,body,attachment_refs,content_type,linked_order_id,order_snapshot,client_message_id)
        VALUES($1,$2,$3,'user',$4,$5,$6,$7,$8,$9,$10) RETURNING ${messageColumns()}`,
      [messageId, row.id, sequence, principal, body, JSON.stringify(images), messageContentType, linkedOrderId, order, messageKey]);
      if (images.length) await client.query("UPDATE media_object SET bound_support_message_id=$1,support_expires_at='infinity' WHERE id=ANY($2::uuid[])", [messageId, images]);
      const updated = await client.query<ConversationRow>(`UPDATE support_conversation SET next_sequence=next_sequence+1,team_unread_count=team_unread_count+1,
        status=$2,current_handler_principal_id=CASE WHEN $3 THEN NULL ELSE current_handler_principal_id END,resolved_at=NULL,version=version+1,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [row.id, nextStatus, reopened]);
      row = updated.rows[0]!;
      await client.query("UPDATE support_presence SET typing_expires_at=clock_timestamp(),updated_at=clock_timestamp() WHERE conversation_id=$1 AND actor_type='member'", [row.id]);
      await enqueue(client, { eventType: "support.message.created.v1", aggregateType: "support_conversation", aggregateId: row.id,
        aggregateVersion: row.version, businessKey: `support-message:${messageId}`, payload: { conversationId: row.id, messageId, senderType: "user", sequence }, occurredAt: inserted.rows[0]!.created_at });
      return { conversation: conversation(row), message: await this.messageView(inserted.rows[0]!, row, "member", await this.mediaMap(client, inserted.rows)), replayed: false };
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

  private presenceInput(input: { online?: unknown; typing?: unknown }): { online: boolean; typing: boolean } {
    if (typeof input.online !== "boolean" || typeof input.typing !== "boolean") throw new DomainError("SUPPORT_PRESENCE_INVALID", "online and typing flags are required", 422);
    return { online: input.online, typing: input.online && input.typing };
  }

  async touchMemberPresence(memberId: string | undefined, input: { online?: unknown; typing?: unknown }, now = new Date()) {
    const owner = required(memberId, "AUTH_REQUIRED");
    const state = this.presenceInput(input);
    const row = await this.findForMember(this.pool, owner);
    if (!row) return { accepted: false, serverTime: now.toISOString() };
    const onlineUntil = state.online ? new Date(now.getTime() + 10_000) : now;
    const typingUntil = state.typing ? new Date(now.getTime() + 9_000) : now;
    await this.pool.query(`INSERT INTO support_presence(conversation_id,actor_type,actor_principal_id,online_expires_at,typing_expires_at,updated_at)
      VALUES($1,'member',$2,$3,$4,$5)
      ON CONFLICT(conversation_id,actor_type) DO UPDATE SET actor_principal_id=EXCLUDED.actor_principal_id,
        online_expires_at=EXCLUDED.online_expires_at,typing_expires_at=EXCLUDED.typing_expires_at,updated_at=EXCLUDED.updated_at`,
    [row.id, owner, onlineUntil, typingUntil, now]);
    return { accepted: true, onlineExpiresAt: onlineUntil.toISOString(), typingExpiresAt: typingUntil.toISOString(), serverTime: now.toISOString() };
  }

  async touchOperatorPresence(memberId: string | undefined, principalId: string | undefined, id: string, input: { online?: unknown; typing?: unknown }, now = new Date()) {
    await this.operator(memberId, "support.read");
    const principal = required(principalId, "AUTH_REQUIRED");
    const state = this.presenceInput(input);
    const row = await this.findById(this.pool, id);
    if (!state.online) {
      const stopped = await this.pool.query(`UPDATE support_presence SET online_expires_at=$3,typing_expires_at=$3,updated_at=$3
        WHERE conversation_id=$1 AND actor_type='operator' AND actor_principal_id=$2`, [row.id, principal, now]);
      return { accepted: Boolean(stopped.rowCount), onlineExpiresAt: now.toISOString(), typingExpiresAt: now.toISOString(), serverTime: now.toISOString() };
    }
    if (row.status !== "human_active" || row.current_handler_principal_id !== principal) {
      throw new DomainError("SUPPORT_ASSIGNMENT_REQUIRED", "Only the assigned operator can publish presence", 409);
    }
    const onlineUntil = new Date(now.getTime() + 10_000);
    const typingUntil = state.typing ? new Date(now.getTime() + 9_000) : now;
    await this.pool.query(`INSERT INTO support_presence(conversation_id,actor_type,actor_principal_id,online_expires_at,typing_expires_at,updated_at)
      VALUES($1,'operator',$2,$3,$4,$5)
      ON CONFLICT(conversation_id,actor_type) DO UPDATE SET actor_principal_id=EXCLUDED.actor_principal_id,
        online_expires_at=EXCLUDED.online_expires_at,typing_expires_at=EXCLUDED.typing_expires_at,updated_at=EXCLUDED.updated_at`,
    [row.id, principal, onlineUntil, typingUntil, now]);
    return { accepted: true, onlineExpiresAt: onlineUntil.toISOString(), typingExpiresAt: typingUntil.toISOString(), serverTime: now.toISOString() };
  }

  async authorizeSupportMedia(memberId: string | undefined, principalId: string | undefined, input: { mimeType?: unknown; maxBytes?: unknown; baseUrl: string }, traceId: string, now = new Date()): Promise<UploadAuthorization> {
    const owner = required(memberId, "AUTH_REQUIRED");
    const actor = required(principalId, "AUTH_REQUIRED");
    const mimeType = input.mimeType;
    const maxBytes = Number(input.maxBytes);
    if (!(["image/jpeg", "image/png", "image/webp"] as unknown[]).includes(mimeType) || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024) {
      throw new DomainError("SUPPORT_MEDIA_INVALID", "Support images must be JPG, PNG or WEBP and no larger than 5 MiB", 422);
    }
    return transaction(this.pool, async (client) => {
      await this.platform.assertSwitch(client, "uploads");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`support-member:${owner}`]);
      let row = await this.findForMember(client, owner, true);
      if (!row) row = (await client.query<ConversationRow>("INSERT INTO support_conversation(member_id,status) VALUES($1,'waiting_human') RETURNING *", [owner])).rows[0]!;
      const id = randomUUID();
      const objectKey = `support/${row.id}/images/${id}`;
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      await client.query(`INSERT INTO media_object
        (id,submission_id,kind,object_key,mime_type,is_current,authorized_max_bytes,support_conversation_id,support_member_id,support_expires_at,authorized_at)
        VALUES($1,NULL,'chat_image',$2,$3,true,$4,$5,$6,$7,$8)`, [id, objectKey, mimeType, maxBytes, row.id, owner, expiresAt, now]);
      const authorization = await this.storage.authorize({ mediaId:id,objectKey,mimeType: mimeType as string,maxBytes,baseUrl:input.baseUrl,now });
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'support.media.authorize','media_object',$2,$3,$4)`,
        [actor,id,{conversationId:row.id,mimeType,maxBytes},traceId]);
      return authorization;
    });
  }

  async completeSupportMedia(memberId: string | undefined, principalId: string | undefined, mediaId: string, traceId: string, now = new Date()) {
    const owner = required(memberId, "AUTH_REQUIRED");
    const actor = required(principalId, "AUTH_REQUIRED");
    const targetMediaId = uuid(mediaId, "SUPPORT_MEDIA_INVALID");
    const outcome = await transaction(this.pool, async (client) => {
      await this.platform.assertSwitch(client, "uploads");
      const result = await client.query<{id:string;object_key:string;mime_type:string;upload_state:string;authorized_max_bytes:number;support_expires_at:Date}>(`
        SELECT media.id,media.object_key,media.mime_type,media.upload_state,media.authorized_max_bytes,media.support_expires_at
        FROM media_object media JOIN support_conversation conversation ON conversation.id=media.support_conversation_id
        WHERE media.id=$1 AND media.support_member_id=$2 AND conversation.member_id=$2 FOR UPDATE OF media,conversation`, [targetMediaId, owner]);
      const row = result.rows[0];
      if (!row) throw new DomainError("SUPPORT_MEDIA_NOT_FOUND", "Support image was not found", 404);
      if (row.upload_state === "uploaded") return { media: row };
      if (row.upload_state !== "authorized" || row.support_expires_at <= now) throw new DomainError("SUPPORT_MEDIA_NOT_FOUND", "Support image authorization has expired", 404);
      const stored = await this.storage.verify(row.object_key);
      const fail = async (error: DomainError) => {
        await this.storage.delete(row.object_key);
        await client.query("UPDATE media_object SET upload_state='failed' WHERE id=$1", [targetMediaId]);
        return { error };
      };
      if (stored.bytes < 1 || stored.bytes > row.authorized_max_bytes) return fail(new DomainError("UPLOAD_SIZE_INVALID", "Uploaded support image exceeds its authorization", 422));
      if (stored.detectedMime !== row.mime_type) return fail(new DomainError("UPLOAD_CONTENT_MISMATCH", "Uploaded support image content does not match its MIME type", 422));
      const media = (await client.query(`UPDATE media_object SET upload_state='uploaded',content_hash=$1,size_bytes=$2,uploaded_at=$3
        WHERE id=$4 RETURNING id,mime_type,size_bytes,upload_state`, [stored.checksumBase64, stored.bytes, now, targetMediaId])).rows[0];
      await client.query("DELETE FROM upload_chunk WHERE media_id=$1", [targetMediaId]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'support.media.complete','media_object',$2,$3,$4)`,
        [actor,targetMediaId,{uploadState:"uploaded",sizeBytes:stored.bytes},traceId]);
      return { media };
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.media;
  }

  async deleteSupportMedia(memberId: string | undefined, principalId: string | undefined, mediaId: string, traceId: string, now = new Date()) {
    const owner = required(memberId, "AUTH_REQUIRED");
    const actor = required(principalId, "AUTH_REQUIRED");
    const targetMediaId = uuid(mediaId, "SUPPORT_MEDIA_INVALID");
    return transaction(this.pool, async (client) => {
      const media = await client.query<{object_key:string;upload_state:string;bound_support_message_id:string|null}>(`SELECT object_key,upload_state,bound_support_message_id
        FROM media_object WHERE id=$1 AND support_member_id=$2 FOR UPDATE`, [targetMediaId, owner]);
      const row = media.rows[0];
      if (!row || row.upload_state === "deleted") throw new DomainError("SUPPORT_MEDIA_NOT_FOUND", "Support image was not found", 404);
      if (row.bound_support_message_id) throw new DomainError("SUPPORT_MEDIA_BOUND", "A sent support image is immutable", 409);
      await client.query("UPDATE media_object SET upload_state='deleted',deleted_at=$2,is_current=false WHERE id=$1", [targetMediaId, now]);
      await client.query(`INSERT INTO media_cleanup_queue(media_id,object_key,reason,next_attempt_at)
        VALUES($1,$2,'support_deleted',$3) ON CONFLICT DO NOTHING`, [targetMediaId, row.object_key, now]);
      await client.query("DELETE FROM upload_chunk WHERE media_id=$1", [targetMediaId]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,before_state,after_state,trace_id)
        VALUES($1,'support.media.delete','media_object',$2,$3,$4,$5)`,
        [actor,targetMediaId,{uploadState:row.upload_state},{uploadState:"deleted"},traceId]);
      return { deleted:true,cleanupQueued:true };
    });
  }

  async memberSupportMedia(memberId: string | undefined, mediaId: string) {
    const owner = required(memberId, "AUTH_REQUIRED");
    const targetMediaId = uuid(mediaId, "SUPPORT_MEDIA_INVALID");
    const result = await this.pool.query<{object_key:string}>(`SELECT media.object_key FROM media_object media
      JOIN support_conversation conversation ON conversation.id=media.support_conversation_id
      WHERE media.id=$1 AND conversation.member_id=$2 AND media.support_member_id=$2
        AND media.upload_state='uploaded' AND media.bound_support_message_id IS NOT NULL`, [targetMediaId, owner]);
    if (!result.rows[0]) throw new DomainError("SUPPORT_MEDIA_NOT_FOUND", "Support image was not found", 404);
    return this.storage.read(result.rows[0].object_key);
  }

  async operatorSupportMedia(memberId: string | undefined, id: string, mediaId: string) {
    await this.operator(memberId, "support.read");
    const conversationId = uuid(id, "SUPPORT_CONVERSATION_INVALID");
    const targetMediaId = uuid(mediaId, "SUPPORT_MEDIA_INVALID");
    const result = await this.pool.query<{object_key:string}>(`SELECT object_key FROM media_object
      WHERE id=$1 AND support_conversation_id=$2 AND upload_state='uploaded' AND bound_support_message_id IS NOT NULL`, [targetMediaId, conversationId]);
    if (!result.rows[0]) throw new DomainError("SUPPORT_MEDIA_NOT_FOUND", "Support image was not found", 404);
    return this.storage.read(result.rows[0].object_key);
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
    const page=await this.messagePage(row,query,"operator");const member=await this.pool.query<{display_name:string}>("SELECT display_name FROM member WHERE id=$1",[row.member_id]);
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
      const systemMessageId = randomUUID();
      const systemSequence = Number(row.next_sequence);
      const systemMessage = (await client.query<MessageRow>(`INSERT INTO support_message
        (id,conversation_id,sequence,sender_type,sender_principal_id,body,content_type,client_message_id)
        VALUES($1,$2,$3,'system','system:support','已为你接入人工客服','system',$4) RETURNING ${messageColumns()}`,
      [systemMessageId,id,systemSequence,`support-claim-${id}-v${row.version+1}`])).rows[0]!;
      const updated = (await client.query<ConversationRow>(`UPDATE support_conversation SET status='human_active',current_handler_principal_id=$2,
        next_sequence=next_sequence+1,member_unread_count=member_unread_count+1,resolved_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id, principal])).rows[0]!;
      await this.audit(client, principal, "support.conversation.claim", id, conversation(row), conversation(updated), traceId);
      await enqueue(client, { eventType: "support.message.created.v1", aggregateType: "support_conversation", aggregateId: id,
        aggregateVersion: updated.version, businessKey: `support-message:${systemMessageId}`, payload: { conversationId:id,messageId:systemMessageId,senderType:"system",sequence:systemSequence }, occurredAt:systemMessage.created_at });
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
      const duplicate=await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message
        WHERE conversation_id=$1 AND sender_type='admin' AND sender_principal_id=$2 AND client_message_id=$3`,[id,principal,messageKey]);
      if(duplicate.rows[0]){if(duplicate.rows[0].body!==body)throw new DomainError("IDEMPOTENCY_CONFLICT","clientMessageId was reused with different text",409);return {conversation:conversation(row),message:await this.messageView(duplicate.rows[0],row,"operator"),replayed:true};}
      if(row.status!=="human_active"||row.current_handler_principal_id!==principal)throw new DomainError("SUPPORT_ASSIGNMENT_REQUIRED","Claim this conversation before replying",409);
      const sequence=Number(row.next_sequence);const messageId=randomUUID();
      const inserted=(await client.query<MessageRow>(`INSERT INTO support_message(id,conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id)
        VALUES($1,$2,$3,'admin',$4,$5,$6) RETURNING ${messageColumns()}`,[messageId,id,sequence,principal,body,messageKey])).rows[0]!;
      row=(await client.query<ConversationRow>(`UPDATE support_conversation SET next_sequence=next_sequence+1,member_unread_count=member_unread_count+1,
        version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id])).rows[0]!;
      await client.query("UPDATE support_presence SET typing_expires_at=clock_timestamp(),online_expires_at=GREATEST(online_expires_at,clock_timestamp()+interval '10 seconds'),updated_at=clock_timestamp() WHERE conversation_id=$1 AND actor_type='operator' AND actor_principal_id=$2", [id, principal]);
      await this.audit(client,principal,"support.message.reply",id,null,{messageId,sequence},traceId);
      await enqueue(client,{eventType:"support.message.created.v1",aggregateType:"support_conversation",aggregateId:id,aggregateVersion:row.version,
        businessKey:`support-message:${messageId}`,payload:{conversationId:id,messageId,senderType:"admin",sequence},occurredAt:inserted.created_at});
      return {conversation:conversation(row),message:await this.messageView(inserted,row,"operator"),replayed:false};
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
      const pendingAftersale=(await client.query(`SELECT c.id FROM commerce_aftersale_case c
        LEFT JOIN commission_refund_intent i ON i.request_id=c.refund_request_id
        WHERE (c.support_conversation_id=$1 OR (c.support_conversation_id IS NULL AND c.member_id=$2)) AND (c.state IN
          ('requested','need_info','awaiting_instruction','return_received','quality_checked','refund_exception_approved')
          OR (c.state='refund_pending' AND COALESCE(i.state,'')<>'succeeded')) LIMIT 1`,[id,row.member_id])).rows[0];
      if(pendingAftersale)throw new DomainError('AFTERSALE_CASE_ACTIVE','本会话有待处理售后，请先处理案件后再结束会话',409);
      const updated=(await client.query<ConversationRow>(`UPDATE support_conversation SET status='resolved',current_handler_principal_id=NULL,resolved_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id])).rows[0]!;
      await client.query("UPDATE support_presence SET typing_expires_at=clock_timestamp(),online_expires_at=clock_timestamp(),updated_at=clock_timestamp() WHERE conversation_id=$1 AND actor_type='operator'", [id]);
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
      // Match the worker's policy → conversation → hold lock order. The
      // policy cannot be disabled between eligibility and deletion.
      await client.query("SELECT code FROM data_retention_policy WHERE code='support_conversation_policy_pending' FOR SHARE");
      const row=await this.findById(client,id,true);
      if(row.version!==expected)throw new DomainError("VERSION_CONFLICT","Conversation changed; reload before purging",409);
      // The eligibility read and deletion must not race a newly inserted hold.
      await client.query('LOCK TABLE legal_hold IN SHARE MODE');
      await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
      await client.query('LOCK TABLE privacy_request IN SHARE MODE');
      const state=await this.retentionState(client,row);
      if(state.reason==="policy_pending")throw new DomainError("SUPPORT_RETENTION_POLICY_PENDING","Support retention remains POLICY PENDING and cannot delete data",409);
      if(state.reason==='transaction_scope_requires_separate_execution')throw new DomainError(
        'SUPPORT_TRANSACTION_RETENTION_SCOPE','关联订单或售后的客服事实必须按交易范围单独处理，不能整段清除',409);
      if(state.reason==="not_resolved")throw new DomainError("SUPPORT_RETENTION_NOT_RESOLVED","Only resolved conversations can become purge eligible",409);
      if(state.reason==="legal_hold")throw new DomainError("SUPPORT_RETENTION_LEGAL_HOLD","An active legal hold blocks this purge",423);
      if(state.reason==='privacy_request_active')throw new DomainError('SUPPORT_RETENTION_PRIVACY_REQUEST_ACTIVE',
        'The member has an open privacy request; finish it before purging support history',409);
      if(state.reason!=="eligible")throw new DomainError("SUPPORT_RETENTION_NOT_DUE","The approved retention period has not elapsed",409);
      const messageCount=(await client.query<{count:number}>("SELECT count(*)::int AS count FROM support_message WHERE conversation_id=$1",[id])).rows[0]!.count;
      await client.query(`INSERT INTO media_cleanup_queue(media_id,object_key,reason,next_attempt_at)
        SELECT id,object_key,'support_purged',clock_timestamp() FROM media_object
        WHERE support_conversation_id=$1 AND upload_state IN ('authorized','uploaded')
        ON CONFLICT DO NOTHING`, [id]);
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

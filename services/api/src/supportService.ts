import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Capability, CommerceOrderStatus, SupportConversationStatus, SupportMessageContentType, SupportMessageView, SupportPresenceView, UploadAuthorization } from "@cisme/contracts";
import { DomainError } from "@cisme/domain";
import { AuthorityService } from "./authority.js";
import { readSnapshot, transaction, type DbClient } from "./db.js";
import { enqueue } from "./outbox.js";
import type { PlatformService } from "./platformService.js";
import type { ObjectStorage } from "./storage.js";
import type {AccountClosure} from './accountClosure.js';
import {recordWholeSuppression} from './supportRetention.js';
import type {SupportAiBoundary,SupportAiSuggestion} from './supportAiBoundary.js';
import {applySupportConversationReset,supportNewTopicOperation} from './supportConversationReset.js';

type ConversationRow = {
  id: string; member_id: string; status: SupportConversationStatus; priority: "normal" | "high" | "urgent";
  current_handler_principal_id: string | null; next_sequence: string; member_unread_count: number;
  team_unread_count: number; member_last_read_sequence:string; team_last_read_sequence:string; version: number; updated_at: Date;
  resolved_at?: Date | null;
  human_request_generation?:number;human_request_anchor_sequence?:string|null;human_request_context_version?:number;
};
type OrderCard = { orderId: string; orderNumberTail: string; status: CommerceOrderStatus; currency: "CNY"; totalCents: number; productName: string; productImage: string | null; itemSummary: string };
type MessageRow = { id: string; conversation_id:string; sequence: string; sender_type: "user" | "ai" | "admin" | "system"; body: string; attachment_refs: string[];
  content_type: SupportMessageContentType; linked_order_id: string | null; order_snapshot: OrderCard | null;
  linked_case_id:string|null;return_instruction_snapshot:Omit<NonNullable<SupportMessageView['returnInstruction']>,'caseId'>|null;created_at: Date;reply_to_message_id?:string|null };
type MediaRow = { id: string; mime_type: "image/jpeg" | "image/png" | "image/webp"; size_bytes: string | number };
type ReplyTargetInput={replyToMessageId?:unknown;expectedHumanRequestGeneration?:unknown;contextVersion?:unknown};
type HumanContext={generation:number;status:'waiting_human'|'human_active';anchorQuestion:string|null;anchorKnown:boolean;anchorMessageId:string|null;anchorSequence:number|null};
type CommittedQuestion={snapshot:ConversationRow;source:MessageRow;topic:{contextStartSequence:number;contextVersion:number}};

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
  return "id,conversation_id,sequence,sender_type,body,attachment_refs,content_type,linked_order_id,order_snapshot,linked_case_id,return_instruction_snapshot,created_at,reply_to_message_id";
}
function view(row: MessageRow, input: { counterpartyReadSequence: number; previewPrefix: string; media: ReadonlyMap<string, MediaRow> }): SupportMessageView {
  const attachments = (Array.isArray(row.attachment_refs) ? row.attachment_refs : []).flatMap((id) => {
    const media = input.media.get(id);
    return media ? [{ id, mimeType: media.mime_type, sizeBytes: Number(media.size_bytes), previewPath: `${input.previewPrefix}/${id}` }] : [];
  });
  return { id: row.id, sequence: Number(row.sequence), senderType: row.sender_type, body: row.body, contentType: row.content_type,
    attachments, orderCard: row.order_snapshot ?? null,
    returnInstruction:row.linked_case_id&&row.return_instruction_snapshot?{caseId:row.linked_case_id,...row.return_instruction_snapshot}:null,
    replyToMessageId:row.reply_to_message_id??null,
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
const newTopicOperation = supportNewTopicOperation;

export function modelSafeSupportProjection(input: { conversation: ConversationRow; messages: Array<{sequence:string;sender_type:"user"|"ai"|"admin"|"system";body:string;[key:string]:unknown}> }) {
  return { conversationId: input.conversation.id, status: input.conversation.status,
    messages: input.messages.map((row) => ({ sequence: Number(row.sequence), senderType: row.sender_type, body: row.body })) };
}

export class SupportService {
  constructor(private readonly pool: pg.Pool, private readonly authority: AuthorityService, private readonly platform: PlatformService, private readonly storage: ObjectStorage,
    private readonly suppression?:AccountClosure,private readonly ai?:Pick<SupportAiBoundary,'status'|'suggestedReply'>) {}

  private automaticAiAvailable():boolean {
    const status=this.ai?.status();return status?.providerAvailable===true&&status.autoSendEnabled===true;
  }

  private async reconcile(owner?:string){
    if(this.suppression?.suppressionEnabled())await this.suppression.replaySupportConversations(this.pool,owner);
  }
  private async reconcileLocked(client:DbClient,owner:string){
    if(this.suppression?.suppressionEnabled())for(const marker of await this.suppression.supportConversationResetMarkers(owner,client))
      await applySupportConversationReset(client,marker);
  }
  private async requireCurrentContext(client:DbClient,row:ConversationRow,input:{expectedConversationId?:unknown;contextVersion?:unknown}){
    const context=await this.contextState(client,row);
    if((context.contextVersion>0&&(input.expectedConversationId===undefined||input.contextVersion===undefined))||
      input.expectedConversationId!==undefined&&input.expectedConversationId!==row.id||
      input.contextVersion!==undefined&&(!Number.isSafeInteger(input.contextVersion)||input.contextVersion!==context.contextVersion))
      throw new DomainError('SUPPORT_CONTEXT_CHANGED','会话已更新，请刷新后再发送',409);
    return context;
  }

  private async contextState(client:DbClient|pg.Pool,row:ConversationRow):Promise<{contextStartSequence:number;contextVersion:number}> {
    // Command receipts survive ordinary-message retention. A display message
    // must never be the sole boundary, because that message may be purged.
    const next=Number(row.next_sequence);
    if(!Number.isSafeInteger(next)||next<1)throw new DomainError('SUPPORT_TOPIC_RECEIPT_INVALID','会话状态暂时无法核对，请稍后重试',503);
    const receipts=await client.query<{response_body:unknown}>(`SELECT response_body FROM idempotency_operation
      WHERE principal_id=$1 AND operation=$2 AND response_body->>'conversationId'=$3`,
      [`member:${row.member_id}`,newTopicOperation,row.id]);
    let boundary=0,contextVersion=0;
    for(const receipt of receipts.rows){
      const value=receipt.response_body as {conversationId?:unknown;contextStartSequence?:unknown;resultVersion?:unknown}|null;
      if(!value||value.conversationId!==row.id||!Number.isSafeInteger(value.contextStartSequence)||
        Number(value.contextStartSequence)<0||Number(value.contextStartSequence)>=next||
        !Number.isSafeInteger(value.resultVersion)||Number(value.resultVersion)<1||Number(value.resultVersion)>row.version){
        throw new DomainError('SUPPORT_TOPIC_RECEIPT_INVALID','会话状态暂时无法核对，请稍后重试',503);
      }
      boundary=Math.max(boundary,Number(value.contextStartSequence));
      contextVersion=Math.max(contextVersion,Number(value.resultVersion));
    }
    return {contextStartSequence:boundary,contextVersion};
  }

  private async contextBoundary(client:DbClient|pg.Pool,row:ConversationRow){
    return (await this.contextState(client,row)).contextStartSequence;
  }

  private async modelMessages(client:DbClient|pg.Pool,row:ConversationRow):Promise<MessageRow[]> {
    const boundary=await this.contextBoundary(client,row);
    return (await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message
      WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence DESC LIMIT 50`,[row.id,boundary])).rows.reverse();
  }

  private async currentTopicState(owner:string) {
    await this.reconcile(owner);
    return readSnapshot(this.pool,async client=>{
      const row=await this.findForMember(client,owner);
      if(!row)throw new DomainError('SUPPORT_CONVERSATION_NOT_FOUND','会话状态暂时无法核对，请刷新后重试',503);
      const topic=await this.contextState(client,row);
      return {conversation:conversation(row),...topic,newTopicAvailable:this.suppression?.suppressionEnabled()===true,
        supportAiCanRespond:this.automaticAiAvailable(),humanRequest:this.humanView(await this.humanContext(client,row,topic))};
    });
  }

  private async humanContext(client:DbClient|pg.Pool,row:ConversationRow,context?:{contextStartSequence:number;contextVersion:number}):Promise<HumanContext|null>{
    if(row.status!=='waiting_human'&&row.status!=='human_active')return null;
    const topic=context??await this.contextState(client,row),generation=row.human_request_generation??0;
    const sequence=Number(row.human_request_anchor_sequence??0);
    const anchor=generation>0&&row.human_request_context_version===topic.contextVersion&&sequence>topic.contextStartSequence
      ?(await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message WHERE conversation_id=$1 AND sequence=$2 AND sender_type='user'`,[row.id,sequence])).rows[0]:undefined;
    const known=Boolean(anchor?.body.trim());
    return {generation,status:row.status,anchorQuestion:known?anchor!.body:null,anchorKnown:known,anchorMessageId:anchor?.id??null,anchorSequence:anchor?Number(anchor.sequence):null};
  }

  private humanView(human:HumanContext|null){
    if(!human)return null;
    const {anchorQuestion:_,...visible}=human;return visible;
  }
  private humanStatus(human:HumanContext){return human.status==='waiting_human'
    ?'之前申请人工的问题正在等待处理，有补充可以直接告诉我 😊'
    :'之前申请人工的问题正由人工客服跟进，有补充可以直接告诉我 😊';}
  private humanKey(human:HumanContext|null){return human?`${human.generation}:${human.anchorMessageId??'unknown'}`:'none';}

  /** Each AI receipt belongs to one user question and topic, independently of
   * unrelated human messages. Only the commit transaction allocates sequence. */
  private async automaticReply(owner:string,id:string,messageId:string,traceId:string,committedQuestion:CommittedQuestion|null=null) {
    for(let attempt=0;attempt<2;attempt++){
      await this.reconcile(owner);
      // With no external model work, the just-committed source is sufficient
      // preparation. The locked write below still rechecks every live fence.
      // A changed human request retries through the normal fresh read path.
      const context=attempt===0&&!this.automaticAiAvailable()&&committedQuestion
        ?{...committedQuestion,prior:null,human:null,messages:[] as MessageRow[],answeredByHuman:false}
        :await transaction(this.pool,async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`support-member:${owner}`]);
        await this.reconcileLocked(client,owner);
        const snapshot=await this.findForMember(client,owner);
        if(!snapshot||snapshot.id!==id)return null;
        if(!(await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR SHARE",[owner])).rowCount)return null;
        const topic=await this.contextState(client,snapshot);
        const source=(await client.query<MessageRow&{prior_reply_id:string|null;answered_by_human:boolean}>(`SELECT ${messageColumns().split(',').map(column=>`source.${column}`).join(',')},
          (SELECT prior.id FROM support_message prior WHERE prior.conversation_id=source.conversation_id AND prior.client_message_id=$4
            AND prior.sender_type IN ('ai','system') LIMIT 1) AS prior_reply_id,
          EXISTS(SELECT 1 FROM support_message answer WHERE answer.conversation_id=source.conversation_id
            AND answer.sender_type='admin' AND answer.reply_to_message_id=source.id) AS answered_by_human
          FROM support_message source WHERE source.id=$1 AND source.conversation_id=$2 AND source.sender_type='user' AND source.sequence>$3`,
          [messageId,id,topic.contextStartSequence,`ai-reply:${messageId}`])).rows[0];
        if(!source)return null;
        const prior=source.prior_reply_id?(await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message WHERE id=$1`,[source.prior_reply_id])).rows[0]:null;
        if(prior)return {snapshot,topic,source,prior,human:null,messages:[] as MessageRow[],answeredByHuman:false};
        const answeredByHuman=source.answered_by_human;
        const messages=this.automaticAiAvailable()&&source.content_type==='text'&&!answeredByHuman
          ?(await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message WHERE conversation_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence DESC LIMIT 50`,[id,topic.contextStartSequence,source.sequence])).rows.reverse():[];
        return {snapshot,topic,source,prior:null,human:await this.humanContext(client,snapshot,topic),messages,answeredByHuman};
      });
      if(!context)return {};
      if(context.prior)return {conversation:conversation(context.snapshot),aiMessages:[await this.messageView(this.pool,context.prior,context.snapshot,'member')],aiStatus:context.prior.sender_type==='ai'?'replied':'handoff_suggested'};
      if(context.answeredByHuman)return {conversation:conversation(context.snapshot),aiStatus:'answered_by_human',aiMessages:[]};
      const {snapshot,source,messages,human}=context;
      let suggestion:SupportAiSuggestion|null=null,failure='SUPPORT_AI_UNAVAILABLE';
      if(source.content_type!=='text')failure='SUPPORT_AI_HUMAN_CONTEXT_REQUIRED';
      else if(this.automaticAiAvailable()){
        try{
          suggestion=await this.ai!.suggestedReply({...modelSafeSupportProjection({conversation:snapshot,messages}),
            question:{sequence:Number(source.sequence),body:source.body},...(human?{humanRequest:human}:{})});
          const route=suggestion.route??'general';
          if(human&&route!=='clarify'&&(suggestion.confidence<0.75||(['general','mixed'].includes(route)&&suggestion.handoffReason)))
            suggestion={...suggestion,route:'clarify',text:'你是在补充之前申请人工的问题，还是有新的使用问题？',handoffReason:null};
          else if(!human&&(suggestion.handoffReason||suggestion.confidence<0.5)){failure='SUPPORT_AI_HANDOFF_REQUIRED';suggestion=null;}
          if(suggestion?.route==='clarify'&&(suggestion.text.match(/[？?]/g)?.length??0)>1)
            suggestion={...suggestion,text:'你是在补充之前申请人工的问题，还是有新的使用问题？'};
        }catch(error){
          const code=(error as {code?:unknown})?.code;failure=typeof code==='string'&&/^SUPPORT_AI_[A-Z_]+$/.test(code)?code:'SUPPORT_AI_UNAVAILABLE';
        }
      }
      const committed=await transaction(this.pool,async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`support-member:${owner}`]);
        await this.reconcileLocked(client,owner);
        if(!(await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR SHARE",[owner])).rowCount)return {done:{}};
        const row=await this.findForMember(client,owner,true);
        if(!row||row.id!==id)return {done:{}};
        const topic=await this.contextState(client,row);
        if(topic.contextVersion!==context.topic.contextVersion||topic.contextStartSequence!==context.topic.contextStartSequence)return {done:{}};
        const retained=(await client.query('SELECT id FROM support_message WHERE id=$1 AND conversation_id=$2 AND sequence>$3',[messageId,id,topic.contextStartSequence])).rowCount;
        if(!retained)return {done:{}};
        const existing=(await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message WHERE conversation_id=$1 AND client_message_id=$2 AND sender_type IN ('ai','system')`,[id,`ai-reply:${messageId}`])).rows[0];
        if(existing)return {done:{conversation:conversation(row),aiMessages:[await this.messageView(client,existing,row,'member')],aiStatus:existing.sender_type==='ai'?'replied':'handoff_suggested'}};
        const currentHuman=await this.humanContext(client,row,topic);
        if((row.human_request_generation??0)!==(snapshot.human_request_generation??0)||this.humanKey(currentHuman)!==this.humanKey(human))return {retry:true};
        const answered=(await client.query(`SELECT id FROM support_message WHERE conversation_id=$1 AND sender_type='admin' AND reply_to_message_id=$2 LIMIT 1`,[id,messageId])).rowCount;
        if(answered)return {done:{conversation:conversation(row),aiStatus:'answered_by_human',aiMessages:[]}};
        const route=suggestion?.route??'general';
        const issueAnswered=currentHuman?.anchorMessageId&&(await client.query(`SELECT id FROM support_message WHERE conversation_id=$1 AND sender_type='admin' AND reply_to_message_id=$2 AND sequence>$3 LIMIT 1`,[id,currentHuman.anchorMessageId,source.sequence])).rowCount;
        if(route==='human_followup'&&issueAnswered)return {done:{conversation:conversation(row),aiStatus:'answered_by_human',aiMessages:[]}};
        let body:string,isAi=false,humanStatusShown=false;
        if(suggestion&&route==='human_followup'&&currentHuman){body=this.humanStatus(currentHuman);humanStatusShown=true;}
        else if(suggestion){
          const statusAlreadyShown=route==='mixed'&&currentHuman&&(await client.query(`SELECT id FROM audit_log WHERE object_id=$1 AND action IN ('support.ai.reply','support.ai.handoff_suggested')
            AND after_state->>'humanRequestGeneration'=$2 AND after_state->>'humanRequestStatus'=$3
            AND after_state->>'humanStatusShown'='true' LIMIT 1`,[id,String(currentHuman.generation),currentHuman.status])).rowCount;
          humanStatusShown=Boolean(route==='mixed'&&currentHuman&&!issueAnswered&&!statusAlreadyShown);
          isAi=true;body=suggestion.text+(humanStatusShown?'\n'+this.humanStatus(currentHuman!):'');
        }
        else body=currentHuman
          ?(failure==='SUPPORT_AI_HUMAN_CONTEXT_REQUIRED'?'信息已收到，需要人工核实；已有人工申请会继续保留。':'这次暂时没能准确回答，已有人工申请会继续保留，你也可以补充问题。')
          :(['SUPPORT_AI_HUMAN_CONTEXT_REQUIRED','SUPPORT_AI_HANDOFF_REQUIRED'].includes(failure)
            ?'这个问题需要人工核实 😊 点「申请人工」，客服会接着帮你。':'这次没能及时回复你，抱歉呀 🌿 你可以稍后再问，或点「申请人工」。');
        const sequence=Number(row.next_sequence),replyId=randomUUID();
        if(isAi&&row.status!=='ai_active')await client.query("SELECT set_config('cisme.support_ai_reply',$1,true)",[`${id}:${messageId}:${topic.contextVersion}:${row.human_request_generation??0}`]);
        const inserted=(await client.query<MessageRow>(`INSERT INTO support_message
          (id,conversation_id,sequence,sender_type,sender_principal_id,body,content_type,client_message_id,retention_purpose,reply_to_message_id)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,retention_purpose,id FROM support_message WHERE id=$9 RETURNING ${messageColumns()}`,
          [replyId,id,sequence,isAi?'ai':'system',isAi?'ai:support':'system:support',body,isAi?'text':'system',`ai-reply:${messageId}`,messageId])).rows[0]!;
        const updated=(await client.query<ConversationRow>(`UPDATE support_conversation SET next_sequence=next_sequence+1,member_unread_count=member_unread_count+1,
          version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id])).rows[0]!;
        await this.audit(client,isAi?'ai:support':'system:support',isAi?'support.ai.reply':'support.ai.handoff_suggested',id,null,
          {messageId:replyId,inReplyTo:messageId,route:suggestion?.route??null,humanRequestGeneration:currentHuman?.generation??null,humanRequestStatus:currentHuman?.status??null,humanStatusShown,
            providerId:this.ai?.status().providerId??'disabled',...(suggestion?{citations:suggestion.citations,confidence:suggestion.confidence}:{reason:failure})},traceId);
        await enqueue(client,{eventType:'support.message.created.v1',aggregateType:'support_conversation',aggregateId:id,aggregateVersion:updated.version,
          businessKey:`support-message:${replyId}`,payload:{conversationId:id,messageId:replyId,senderType:isAi?'ai':'system',sequence},occurredAt:inserted.created_at});
        return {done:{conversation:conversation(updated),aiMessages:[await this.messageView(client,inserted,updated,'member',undefined,messageId)],
          aiStatus:suggestion?'replied':'handoff_suggested',handoffSuggested:!suggestion&&!currentHuman}};
      });
      if('done' in committed)return committed.done;
    }
    return {aiStatus:'pending',aiMessages:[]};
  }

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
    const conversationIds=[...new Set(messages.map(row=>row.conversation_id))];
    const result = await client.query<MediaRow>(`SELECT id,mime_type,size_bytes FROM media_object
      WHERE id=ANY($1::uuid[]) AND support_conversation_id=ANY($2::uuid[])
        AND upload_state='uploaded' AND EXISTS(SELECT 1 FROM support_message message
          WHERE message.id=ANY($3::uuid[]) AND message.conversation_id=media_object.support_conversation_id
            AND message.attachment_refs ? media_object.id::text)`, [ids, conversationIds,messageIds]);
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

  private async presence(row: ConversationRow, now = new Date(),client:DbClient|pg.Pool=this.pool): Promise<SupportPresenceView> {
    const result = await client.query<{agent_display_name:string;operator_online:boolean;operator_typing:boolean;member_online:boolean;member_typing:boolean}>(`
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

  private async messageView(client:DbClient|pg.Pool,row: MessageRow, conversationRow: ConversationRow, perspective: "member" | "operator", media?: ReadonlyMap<string, MediaRow>,verifiedReplyTarget?:string) {
    const mediaRows = media ?? await this.mediaMap(client, [row]);
    // Fresh inserts are validated by the sender trigger while this transaction
    // still holds the conversation lock. Historical receipts must recheck links.
    const validTarget=row.reply_to_message_id&&(row.reply_to_message_id===verifiedReplyTarget||(await client.query('SELECT id FROM support_message WHERE id=$1 AND conversation_id=$2',[row.reply_to_message_id,row.conversation_id])).rowCount);
    return view({...row,reply_to_message_id:validTarget?row.reply_to_message_id??null:null}, {
      counterpartyReadSequence: Number(perspective === "member" ? conversationRow.team_last_read_sequence : conversationRow.member_last_read_sequence),
      previewPrefix: perspective === "member" ? "/v1/me/support/media" : `/v1/management/support/conversations/${conversationRow.id}/media`,
      media: mediaRows
    });
  }

  private async replyTarget(client:DbClient,row:ConversationRow,input:ReplyTargetInput,requiredTarget=false){
    const topic=await this.contextState(client,row),generation=row.human_request_generation??0;
    if((topic.contextVersion>0&&input.contextVersion===undefined)||input.contextVersion!==undefined&&input.contextVersion!==topic.contextVersion)
      throw new DomainError('SUPPORT_CONTEXT_CHANGED','聊天已更新，请刷新后再回复',409);
    if((generation>0&&input.expectedHumanRequestGeneration===undefined)||input.expectedHumanRequestGeneration!==undefined&&input.expectedHumanRequestGeneration!==generation)
      throw new DomainError('SUPPORT_HUMAN_REQUEST_CHANGED','人工事项已更新，请刷新后再回复',409);
    const human=await this.humanContext(client,row,topic);
    const targetId=input.replyToMessageId===undefined?human?.anchorMessageId:input.replyToMessageId===null?null:uuid(input.replyToMessageId,'SUPPORT_REPLY_TARGET_INVALID');
    const target=targetId?(await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message WHERE id=$1 AND conversation_id=$2 AND sender_type='user' AND sequence>$3`,[targetId,row.id,topic.contextStartSequence])).rows[0]:null;
    if(targetId&&!target)throw new DomainError('SUPPORT_REPLY_TARGET_INVALID','请选择当前聊天中的用户问题',409);
    if(requiredTarget&&!target)throw new DomainError('SUPPORT_REPLY_TARGET_REQUIRED','请先选择需要回复的用户问题',422);
    return {topic,target};
  }
  async modelProjectionForAssignedOperator(memberId:string|undefined,principalId:string|undefined,id:string,input:ReplyTargetInput={}) {
    await this.authority.require(memberId,"support.reply");
    const principal=required(principalId,"AUTH_REQUIRED");
    await this.reconcile((await this.findById(this.pool,id)).member_id);
    return readSnapshot(this.pool,async client=>{
      const row=await this.findById(client,id);
      if(row.status!=="human_active"||row.current_handler_principal_id!==principal)throw new DomainError("SUPPORT_OWNERSHIP_CONFLICT","Claim the conversation before requesting a suggested reply",409);
      if(!(await client.query("SELECT id FROM member WHERE id=$1 AND status='active'",[row.member_id])).rowCount)
        throw new DomainError('MEMBER_NOT_ACTIVE','该账号的历史事项仅由人工处理',403);
      const {topic,target}=await this.replyTarget(client,row,input,true);
      const messages=(await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message WHERE conversation_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence DESC LIMIT 50`,[id,topic.contextStartSequence,target!.sequence])).rows.reverse();
      return {...modelSafeSupportProjection({conversation:row,messages}),question:{sequence:Number(target!.sequence),body:target!.body}};
    });
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
        OR (binding.object_type='support_message' AND EXISTS(SELECT 1 FROM support_message m
          WHERE m.conversation_id=$1::uuid AND m.id::text=binding.object_id))
        OR (binding.object_type='media_object' AND EXISTS(SELECT 1 FROM media_object media
          WHERE media.support_conversation_id=$1::uuid AND media.id::text=binding.object_id))
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
    await this.reconcile(owner);
    const row = await this.findForMember(this.pool, owner);
    return row ? { conversation: conversation(row), unreadCount: row.member_unread_count,supportAiCanRespond:this.automaticAiAvailable() } : { conversation: null, unreadCount: 0,supportAiCanRespond:this.automaticAiAvailable() };
  }

  async messagesForMember(memberId: string | undefined, query: { after?: unknown; before?: unknown; limit?: unknown },ordinary=true) {
    const owner = required(memberId, "AUTH_REQUIRED");
    await this.reconcile(owner);
    return readSnapshot(this.pool,async client=>{
      const row = await this.findForMember(client, owner);
      const metadata={supportAiAvailable:this.automaticAiAvailable(),supportAiCanRespond:ordinary&&this.automaticAiAvailable(),newTopicAvailable:ordinary&&this.suppression?.suppressionEnabled()===true};
      if (!row) return { conversation: null, messages: [], latestCursor: 0, olderCursor: null,contextStartSequence:0,contextVersion:0,humanRequest:null,...metadata };
      const context=ordinary?await this.contextState(client,row):{contextStartSequence:0,contextVersion:0};
      return {...await this.messagePage(row, query, "member",client,context.contextStartSequence),...context,...metadata,
        humanRequest:this.humanView(await this.humanContext(client,row,context))};
    });
  }

  private async messagePage(row: ConversationRow, query: { after?: unknown; before?: unknown; limit?: unknown }, perspective: "member" | "operator",client:DbClient|pg.Pool=this.pool,boundary=0) {
    const pageLimit = limit(query.limit);
    const after = cursor(query.after);
    const before = cursor(query.before);
    if (after !== null && before !== null) throw new DomainError("CURSOR_INVALID", "Use either after or before, not both", 422);
    let result: pg.QueryResult<MessageRow>;
    if (after !== null) result = await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message
      WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence ASC LIMIT $3`, [row.id, Math.max(after,boundary), pageLimit]);
    else if (before !== null) result = await client.query<MessageRow>(`SELECT * FROM (SELECT ${messageColumns()} FROM support_message
      WHERE conversation_id=$1 AND sequence<$2 AND sequence>$4 ORDER BY sequence DESC LIMIT $3) recent ORDER BY sequence ASC`, [row.id, before, pageLimit + 1,boundary]);
    else result = await client.query<MessageRow>(`SELECT * FROM (SELECT ${messageColumns()} FROM support_message
      WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence DESC LIMIT $3) recent ORDER BY sequence ASC`, [row.id,boundary,pageLimit + 1]);
    const hasOlder = after === null && result.rows.length > pageLimit;
    const pageRows = hasOlder ? result.rows.slice(result.rows.length - pageLimit) : result.rows;
    const media = await this.mediaMap(client, pageRows);
    const replyIds=pageRows.flatMap(message=>message.reply_to_message_id?[message.reply_to_message_id]:[]);
    const validTargets=new Set((replyIds.length?(await client.query<{id:string}>(`SELECT id FROM support_message WHERE id=ANY($1::uuid[]) AND conversation_id=$2 AND sequence>$3`,[replyIds,row.id,boundary])).rows:[]).map(target=>target.id));
    const messages = pageRows.map((messageRow) => view({...messageRow,reply_to_message_id:messageRow.reply_to_message_id&&validTargets.has(messageRow.reply_to_message_id)?messageRow.reply_to_message_id:null}, {
      counterpartyReadSequence: Number(perspective === "member" ? row.team_last_read_sequence : row.member_last_read_sequence),
      previewPrefix: perspective === "member" ? "/v1/me/support/media" : `/v1/management/support/conversations/${row.id}/media`,
      media
    }));
    const olderCursor:number|null=hasOlder?messages[0]!.sequence:null;
    return { conversation: conversation(row), presence: await this.presence(row,new Date(),client), messages,
      latestCursor: messages.at(-1)?.sequence ?? Number(row.next_sequence) - 1, olderCursor };
  }

  async startNewTopic(memberId:string|undefined,principalId:string|undefined,input:{conversationId?:unknown;expectedVersion?:unknown;requestId?:unknown},traceId:string) {
    const owner=required(memberId,'AUTH_REQUIRED'),actor=required(principalId,'AUTH_REQUIRED');
    const id=uuid(input.conversationId,'SUPPORT_CONVERSATION_INVALID').toLowerCase();
    const expected=version(input.expectedVersion),key=uuid(input.requestId,'SUPPORT_TOPIC_REQUEST_INVALID').toLowerCase();
    const principal=`member:${owner}`,hash=requestHash({conversationId:id,expectedVersion:expected});
    await this.reconcile(owner);
    const replayed=await transaction(this.pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`support-member:${owner}`]);
      await this.reconcileLocked(client,owner);
      const active=await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR SHARE",[owner]);
      if(!active.rowCount)throw new DomainError('MEMBER_NOT_ACTIVE','账号暂不可执行此操作',403);
      const row=await this.findForMember(client,owner,true);
      if(!row||row.id!==id)throw new DomainError('SUPPORT_CONVERSATION_NOT_FOUND','当前会话不存在，请刷新后重试',404);
      const prior=(await client.query<{request_hash:string}>(`SELECT request_hash FROM idempotency_operation
        WHERE principal_id=$1 AND operation=$2 AND idempotency_key=$3`,[principal,newTopicOperation,key])).rows[0];
      if(prior){
        if(prior.request_hash!==hash)throw new DomainError('IDEMPOTENCY_CONFLICT','请求编号已用于另一项操作',409);
        return true;
      }
      if(row.version!==expected)throw new DomainError('VERSION_CONFLICT','会话已变化，请刷新后重试',409);
      if(row.status==='waiting_human'||row.status==='human_active')throw new DomainError('SUPPORT_HUMAN_CONVERSATION_ACTIVE','正在等待或接待人工客服，请在当前会话继续沟通',409);
      await this.contextState(client,row);
      const boundary=Number(row.next_sequence)-1;
      if(!this.suppression?.suppressionEnabled())throw new DomainError('SUPPORT_NEW_CONVERSATION_UNAVAILABLE','新对话暂不可用，请稍后重试',503);
      const member=(await client.query<{created_at:Date;reset_at:string}>(`SELECT created_at,
        to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reset_at FROM member WHERE id=$1`,[owner])).rows[0]!;
      const marker=await this.suppression.recordSupportConversationReset({memberId:owner,conversationId:row.id,
        requestId:key,expectedVersion:expected,contextStartSequence:boundary,resultVersion:expected+1,memberCreatedAt:member.created_at.toISOString(),createdAt:member.reset_at});
      await applySupportConversationReset(client,marker,false);
      const response={conversationId:row.id,contextStartSequence:boundary,resultVersion:expected+1};
      await this.audit(client,actor,'support.conversation.new_topic',row.id,{version:row.version,status:row.status},response,traceId);
      return false;
    });
    // The command receipt is immutable, but the HTTP view must be current: a
    // later handoff/new topic must never be overwritten by an old replay.
    return {...await this.messagesForMember(owner,{}),replayed};
  }

  async sendMember(memberId: string | undefined, principalId: string | undefined, input: { body?: unknown; clientMessageId?: unknown; mediaIds?: unknown; linkedOrderId?: unknown;expectedConversationId?:unknown;contextVersion?:unknown }, traceId: string, historicalOrder=false) {
    const owner = required(memberId, "AUTH_REQUIRED");
    const principal = required(principalId, "AUTH_REQUIRED");
    const body = textBody(input.body, true); const messageKey = clientMessageId(input.clientMessageId);
    const images = mediaIds(input.mediaIds);
    const linkedOrderId = input.linkedOrderId === undefined || input.linkedOrderId === null || input.linkedOrderId === "" ? null : uuid(input.linkedOrderId, "SUPPORT_ORDER_INVALID");
    const messageContentType = contentType(body, images, linkedOrderId);
    await this.reconcile(owner);
    let committedQuestion:CommittedQuestion|null=null;
    const result=await transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`support-member:${owner}`]);
      await this.reconcileLocked(client,owner);
      let row = await this.findForMember(client, owner, true);
      if (!row) {
        if(!historicalOrder&&(input.expectedConversationId!==undefined||input.contextVersion!==undefined&&input.contextVersion!==0))
          throw new DomainError('SUPPORT_CONTEXT_CHANGED','会话已更新，请刷新后再发送',409);
        const created = await client.query<ConversationRow>(`INSERT INTO support_conversation(member_id,status)
          VALUES($1,$2) RETURNING *`, [owner,historicalOrder?'waiting_human':'ai_active']); row = created.rows[0]!;
      }
      const topic=!historicalOrder?await this.requireCurrentContext(client,row,input):null;
      const duplicate = await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message
        WHERE conversation_id=$1 AND sender_type='user' AND sender_principal_id=$2 AND client_message_id=$3`, [row.id, principal, messageKey]);
      if (duplicate.rows[0]) {
        const prior = duplicate.rows[0];
        if (prior.body !== body || JSON.stringify(prior.attachment_refs ?? []) !== JSON.stringify(images) || prior.linked_order_id !== linkedOrderId) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "clientMessageId was reused with different support content", 409);
        }
        return { conversation: conversation(row), message: await this.messageView(client,prior, row, "member", await this.mediaMap(client, [prior])), replayed: true };
      }
      const order = await this.orderCard(client, owner, linkedOrderId);
      if (images.length) {
        const media = await client.query<{id:string}>(`SELECT id FROM media_object WHERE id=ANY($1::uuid[])
          AND support_conversation_id=$2 AND support_member_id=$3 AND upload_state='uploaded'
          AND bound_support_message_id IS NULL AND support_expires_at>clock_timestamp() FOR UPDATE`, [images, row.id, owner]);
        if (media.rowCount !== images.length) throw new DomainError("SUPPORT_MEDIA_NOT_FOUND", "A support image is unavailable or belongs to another conversation", 404);
      }
      const sequence = Number(row.next_sequence); const messageId = randomUUID();
      const bindHuman=Boolean(!historicalOrder&&topic&&(row.human_request_generation??0)>0&&row.human_request_anchor_sequence===null
        &&row.human_request_context_version===topic.contextVersion&&(row.status==='waiting_human'||row.status==='human_active'));
      if(bindHuman)await client.query("SELECT set_config('cisme.support_human_anchor_bind',$1,true)",
        [`${row.id}:${owner}:${row.human_request_generation}:${sequence}:${topic!.contextVersion}`]);
      const reopened = row.status === "resolved";
      const resetHandler = reopened || historicalOrder && row.status === "ai_active";
      const nextStatus: SupportConversationStatus = historicalOrder && resetHandler
        ? "waiting_human" : reopened ? "ai_active" : row.status;
      const inserted = await client.query<MessageRow>(`INSERT INTO support_message
        (id,conversation_id,sequence,sender_type,sender_principal_id,body,attachment_refs,content_type,linked_order_id,order_snapshot,client_message_id,retention_purpose)
        VALUES($1,$2,$3,'user',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${messageColumns()}`,
      [messageId, row.id, sequence, principal, body, JSON.stringify(images), messageContentType, linkedOrderId, order, messageKey,
        linkedOrderId?'transaction':'ordinary']);
      if (images.length) await client.query("UPDATE media_object SET bound_support_message_id=$1,support_expires_at='infinity' WHERE id=ANY($2::uuid[])", [messageId, images]);
      const updated = await client.query<ConversationRow>(`UPDATE support_conversation SET next_sequence=next_sequence+1,team_unread_count=team_unread_count+1,
        status=$2,current_handler_principal_id=CASE WHEN $3 THEN NULL ELSE current_handler_principal_id END,
        human_request_anchor_sequence=CASE WHEN $4 THEN $5 ELSE human_request_anchor_sequence END,
        resolved_at=NULL,version=version+1,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [row.id, nextStatus, resetHandler,bindHuman,sequence]);
      row = updated.rows[0]!;
      await client.query("UPDATE support_presence SET typing_expires_at=clock_timestamp(),updated_at=clock_timestamp() WHERE conversation_id=$1 AND actor_type='member'", [row.id]);
      await enqueue(client, { eventType: "support.message.created.v1", aggregateType: "support_conversation", aggregateId: row.id,
        aggregateVersion: row.version, businessKey: `support-message:${messageId}`, payload: { conversationId: row.id, messageId, senderType: "user", sequence }, occurredAt: inserted.rows[0]!.created_at });
      if(!historicalOrder&&!this.automaticAiAvailable()&&topic)committedQuestion={snapshot:row,source:inserted.rows[0]!,topic};
      return { conversation: conversation(row), message: await this.messageView(client,inserted.rows[0]!, row, "member", await this.mediaMap(client, inserted.rows)), replayed: false };
    });
    let acknowledged:typeof result&{aiMessages?:SupportMessageView[];aiStatus?:string;handoffSuggested?:boolean}=result;
    if(!historicalOrder&&(result.conversation.status==='ai_active'||this.automaticAiAvailable())){
      try{
        // Replaying a committed member receipt also recovers a reply interrupted
        // between commits, but never regenerates an earlier topic's answer.
        acknowledged={...result,...await this.automaticReply(owner,result.conversation.id,result.message.id,traceId,result.replayed?null:committedQuestion)};
      }catch{
        acknowledged={...result,aiStatus:'pending',aiMessages:[]};
      }
    }
    if(historicalOrder)return {...acknowledged,supportAiCanRespond:false};
    try{
      const current=await this.currentTopicState(owner);
      return {...acknowledged,acknowledgedConversationId:result.conversation.id,...current,supportAiCanRespond:this.automaticAiAvailable(),
        aiMessages:current.conversation.id===result.conversation.id
          ?(acknowledged.aiMessages??[]).filter(message=>message.sequence>current.contextStartSequence):[]};
    }catch{
      // Committed user text remains acknowledged even if refreshing the topic
      // fails. Do not invent a zero boundary or expose an old generated reply.
      return {...acknowledged,acknowledgedConversationId:result.conversation.id,supportAiCanRespond:this.automaticAiAvailable(),aiStatus:'pending',aiMessages:[],contextSyncRequired:true};
    }
  }

  async requestHuman(memberId: string | undefined, principalId: string | undefined,input:{expectedConversationId?:unknown;contextVersion?:unknown;questionMessageId?:unknown}={}) {
    const owner = required(memberId, "AUTH_REQUIRED"); required(principalId, "AUTH_REQUIRED");
    await this.reconcile(owner);
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`support-member:${owner}`]);
      await this.reconcileLocked(client,owner);
      let row = await this.findForMember(client, owner, true);
      if(row)await this.requireCurrentContext(client,row,input);
      else if(input.expectedConversationId!==undefined||input.contextVersion!==undefined&&input.contextVersion!==0)
        throw new DomainError('SUPPORT_CONTEXT_CHANGED','会话已更新，请刷新后重试',409);
      if (!row) {
        if(input.questionMessageId!==undefined&&input.questionMessageId!==null)throw new DomainError('SUPPORT_HANDOFF_QUESTION_INVALID','请选择当前聊天中已确认的用户问题',409);
        row = (await client.query<ConversationRow>("INSERT INTO support_conversation(member_id,status,human_request_generation) VALUES($1,'waiting_human',1) RETURNING *", [owner])).rows[0]!;
      }
      else if (row.status === "human_active" || row.status === "waiting_human") return conversation(row);
      else {
        const topic=await this.contextState(client,row),generation=(row.human_request_generation??0)+1;
        const explicitId=input.questionMessageId===undefined||input.questionMessageId===null?null:uuid(input.questionMessageId,'SUPPORT_HANDOFF_QUESTION_INVALID');
        const anchor=input.questionMessageId===null?null:(await client.query<{sequence:string}>(`SELECT sequence FROM support_message
          WHERE conversation_id=$1 AND sender_type='user' AND sequence>$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY sequence DESC LIMIT 1`,[row.id,topic.contextStartSequence,explicitId])).rows[0]?.sequence??null;
        if(explicitId&&!anchor)throw new DomainError('SUPPORT_HANDOFF_QUESTION_INVALID','请选择当前聊天中已确认的用户问题',409);
        await client.query("SELECT set_config('cisme.support_human_request_transition',$1,true)",
          [`${row.id}:${owner}:${row.human_request_generation??0}:${generation}:${topic.contextVersion}:${anchor??0}`]);
        row = (await client.query<ConversationRow>(`UPDATE support_conversation SET status='waiting_human',current_handler_principal_id=NULL,resolved_at=NULL,
          human_request_generation=$2,human_request_anchor_sequence=$3,human_request_context_version=$4,
          version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [row.id,generation,anchor,topic.contextVersion])).rows[0]!;
      }
      await enqueue(client, { eventType: "support.conversation.handoff_requested.v1", aggregateType: "support_conversation", aggregateId: row.id,
        aggregateVersion: row.version, businessKey: `support-handoff:${row.id}:v${row.version}`, payload: { conversationId: row.id }, occurredAt: row.updated_at });
      return conversation(row);
    });
  }

  async resumeAi(memberId:string|undefined,principalId:string|undefined,input:{expectedVersion?:unknown},traceId:string) {
    const owner=required(memberId,'AUTH_REQUIRED'),principal=required(principalId,'AUTH_REQUIRED'),expected=version(input.expectedVersion);
    if(!this.automaticAiAvailable())throw new DomainError('SUPPORT_AI_UNAVAILABLE','AI 客服暂时无法接待，请继续等待人工处理',503);
    await this.reconcile(owner);
    return transaction(this.pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`support-member:${owner}`]);
      await this.reconcileLocked(client,owner);
      const active=await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR SHARE",[owner]);
      if(!active.rowCount)throw new DomainError('MEMBER_NOT_ACTIVE','账号暂不可执行此操作',403);
      const row=await this.findForMember(client,owner,true);
      if(!row)throw new DomainError('SUPPORT_CONVERSATION_NOT_FOUND','请先发送问题后再切换客服',404);
      if(row.status==='ai_active')return conversation(row);
      if(row.version!==expected)throw new DomainError('VERSION_CONFLICT','会话已变化，请刷新后再切换',409);
      if(row.status==='human_active')throw new DomainError('SUPPORT_ALREADY_ASSIGNED','人工客服已接管，请在当前会话继续沟通',409);
      await client.query("SELECT set_config('cisme.support_resume_ai_conversation_id',$1,true)",[row.id]);
      const id=randomUUID(),sequence=Number(row.next_sequence);
      const inserted=(await client.query<MessageRow>(`INSERT INTO support_message
        (id,conversation_id,sequence,sender_type,sender_principal_id,body,content_type,client_message_id,retention_purpose)
        VALUES($1,$2,$3,'system','system:support','已切换 AI 咨询，请发送你的问题。','system',$4,'ordinary') RETURNING ${messageColumns()}`,
        [id,row.id,sequence,`resume-ai:${row.id}:v${row.version}`])).rows[0]!;
      const updated=(await client.query<ConversationRow>(`UPDATE support_conversation SET status='ai_active',resolved_at=NULL,
        next_sequence=next_sequence+1,member_unread_count=member_unread_count+1,version=version+1,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`,[row.id])).rows[0]!;
      await this.audit(client,principal,'support.conversation.resume_ai',row.id,conversation(row),conversation(updated),traceId);
      await enqueue(client,{eventType:'support.message.created.v1',aggregateType:'support_conversation',aggregateId:row.id,
        aggregateVersion:updated.version,businessKey:`support-message:${id}`,payload:{conversationId:row.id,messageId:id,senderType:'system',sequence},occurredAt:inserted.created_at});
      return conversation(updated);
    });
  }

  async markMemberRead(memberId: string | undefined, input: { lastSeenSequence?: unknown }) {
    const owner = required(memberId, "AUTH_REQUIRED"); const seen = cursor(input.lastSeenSequence);
    if (seen === null) throw new DomainError("CURSOR_INVALID", "lastSeenSequence is required", 422);
    await this.reconcile(owner);
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`support-member:${owner}`]);
      await this.reconcileLocked(client,owner);
      const row = await this.findForMember(client, owner, true);
      if (!row) return null;
      const effectiveSeen = Math.max(await this.contextBoundary(client,row),Number(row.member_last_read_sequence), Math.min(seen, Number(row.next_sequence) - 1));
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
      await this.reconcileLocked(client,owner);
      let row = await this.findForMember(client, owner, true);
      if (!row) row = (await client.query<ConversationRow>("INSERT INTO support_conversation(member_id,status) VALUES($1,'ai_active') RETURNING *", [owner])).rows[0]!;
      const id = randomUUID();
      const objectKey = `support/${row.id}/images/${id}`;
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      await client.query(`INSERT INTO media_object
        (id,submission_id,kind,object_key,mime_type,is_current,authorized_max_bytes,support_conversation_id,support_member_id,support_expires_at,authorized_at)
        VALUES($1,NULL,'chat_image',$2,$3,true,$4,$5,$6,$7,clock_timestamp())`, [id, objectKey, mimeType, maxBytes, row.id, owner, expiresAt]);
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
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`support-member:${owner}`]);
      await this.reconcileLocked(client,owner);
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
      const media = await client.query<{object_key:string;upload_state:string;bound_support_message_id:string|null;referenced:boolean}>(`SELECT object_key,upload_state,bound_support_message_id,
        EXISTS(SELECT 1 FROM support_message message WHERE message.attachment_refs ? media_object.id::text) AS referenced
        FROM media_object WHERE id=$1 AND support_member_id=$2 FOR UPDATE`, [targetMediaId, owner]);
      const row = media.rows[0];
      if (!row || row.upload_state === "deleted") throw new DomainError("SUPPORT_MEDIA_NOT_FOUND", "Support image was not found", 404);
      if (row.bound_support_message_id||row.referenced) throw new DomainError("SUPPORT_MEDIA_BOUND", "A sent support image is immutable", 409);
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

  async memberSupportMedia(memberId: string | undefined, mediaId: string,ordinary=true) {
    const owner = required(memberId, "AUTH_REQUIRED");
    const targetMediaId = uuid(mediaId, "SUPPORT_MEDIA_INVALID");
    await this.reconcile(owner);
    const conversationRow=await this.findForMember(this.pool,owner);
    const boundary=ordinary&&conversationRow?await this.contextBoundary(this.pool,conversationRow):0;
    const result = await this.pool.query<{object_key:string}>(`SELECT media.object_key FROM media_object media
      JOIN support_conversation conversation ON conversation.id=media.support_conversation_id
      WHERE media.id=$1 AND conversation.member_id=$2 AND media.support_member_id=$2
        AND media.upload_state='uploaded' AND EXISTS(SELECT 1 FROM support_message message
          WHERE message.conversation_id=conversation.id AND message.sequence>$3 AND message.attachment_refs ? media.id::text)`, [targetMediaId, owner,boundary]);
    if (!result.rows[0]) throw new DomainError("SUPPORT_MEDIA_NOT_FOUND", "Support image was not found", 404);
    return this.storage.read(result.rows[0].object_key);
  }

  async operatorSupportMedia(memberId: string | undefined, id: string, mediaId: string) {
    await this.operator(memberId, "support.read");
    const conversationId = uuid(id, "SUPPORT_CONVERSATION_INVALID");
    const targetMediaId = uuid(mediaId, "SUPPORT_MEDIA_INVALID");
    await this.reconcile((await this.findById(this.pool,conversationId)).member_id);
    const boundary=await this.contextBoundary(this.pool,await this.findById(this.pool,conversationId));
    const result = await this.pool.query<{object_key:string}>(`SELECT media.object_key FROM media_object media
      WHERE media.id=$1 AND media.support_conversation_id=$2 AND media.upload_state='uploaded'
        AND EXISTS(SELECT 1 FROM support_message message WHERE message.conversation_id=$2
          AND message.sequence>$3 AND message.attachment_refs ? media.id::text)`, [targetMediaId, conversationId,boundary]);
    if (!result.rows[0]) throw new DomainError("SUPPORT_MEDIA_NOT_FOUND", "Support image was not found", 404);
    return this.storage.read(result.rows[0].object_key);
  }

  private async operator(memberId: string | undefined, capability: Capability): Promise<string> {
    return this.authority.require(memberId, capability);
  }
  async queue(memberId: string | undefined, query: { cursor?: unknown; limit?: unknown }) {
    await this.operator(memberId, "support.read"); const pageLimit = limit(query.limit); const after=queueCursor(query.cursor);
    await this.reconcile();
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
    // The durable aggregate may retain protected transaction evidence. Its
    // preview is derived only from the current generation, like active chat.
    for(const item of result.rows.slice(0,pageLimit)){
      const row=await this.findById(this.pool,item.id),boundary=await this.contextBoundary(this.pool,row);
      const latest=(await this.pool.query<{body:string;sender_type:string}>(`SELECT body,sender_type FROM support_message
        WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence DESC LIMIT 1`,[item.id,boundary])).rows[0];
      item.last_message=latest?.body??null;item.last_sender_type=latest?.sender_type??null;
    }
    return { items: result.rows.slice(0, pageLimit).map((item: any) => ({ id:item.id,status:item.status,priority:item.priority,
      memberUnreadCount:item.member_unread_count,teamUnreadCount:item.team_unread_count,version:item.version,updatedAt:item.updated_at.toISOString(),memberDisplayName:item.member_display_name,
      lastMessage:item.last_message ?? "暂无消息",lastSenderType:item.last_sender_type ?? null })), nextCursor: result.rows.length > pageLimit ? encodeQueueCursor(result.rows[pageLimit-1]) : null };
  }
  async operatorMessages(memberId: string | undefined, principalId: string | undefined, id: string, query: { after?: unknown; before?: unknown; limit?: unknown }) {
    await this.operator(memberId, "support.read"); const principal=required(principalId,"AUTH_REQUIRED");
    await this.reconcile((await this.findById(this.pool,id)).member_id);
    return readSnapshot(this.pool,async client=>{
      const row=await this.findById(client,id),context=await this.contextState(client,row);
      const page=await this.messagePage(row,query,"operator",client,context.contextStartSequence);
      const member=await client.query<{display_name:string}>("SELECT display_name FROM member WHERE id=$1",[row.member_id]);
      return {...page,...context,humanRequest:this.humanView(await this.humanContext(client,row,context)),memberDisplayName:member.rows[0]?.display_name??"CISME 会员",assignedToMe:row.current_handler_principal_id===principal};
    });
  }
  async claim(memberId: string | undefined, principalId: string | undefined, id: string, input: { expectedVersion?: unknown }, traceId: string) {
    await this.operator(memberId, "support.assign"); const principal = required(principalId, "AUTH_REQUIRED"); const expected = version(input.expectedVersion);
    const owner=(await this.findById(this.pool,id)).member_id;
    await this.reconcile(owner);
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`support-member:${owner}`]);
      await this.reconcileLocked(client,owner);
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
  async reply(memberId: string | undefined, principalId: string | undefined, id: string, input: { body?: unknown; clientMessageId?: unknown }&ReplyTargetInput, traceId: string) {
    await this.operator(memberId, "support.reply"); const principal = required(principalId, "AUTH_REQUIRED");
    const body=textBody(input.body); const messageKey=clientMessageId(input.clientMessageId);
    const targetOwner=(await this.findById(this.pool,id)).member_id;
    await this.reconcile(targetOwner);
    const result=await transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`support-member:${targetOwner}`]);
      await this.reconcileLocked(client,targetOwner);
      let row=await this.findById(client,id,true);
      const duplicate=await client.query<MessageRow>(`SELECT ${messageColumns()} FROM support_message
        WHERE conversation_id=$1 AND sender_type='admin' AND sender_principal_id=$2 AND client_message_id=$3`,[id,principal,messageKey]);
      if(duplicate.rows[0]){
        const prior=duplicate.rows[0],topic=await this.contextState(client,row);
        if(prior.body!==body||input.replyToMessageId!==undefined&&(input.replyToMessageId??null)!==(prior.reply_to_message_id??null))throw new DomainError("IDEMPOTENCY_CONFLICT","clientMessageId was reused with different support content",409);
        if(Number(prior.sequence)<=topic.contextStartSequence)throw new DomainError('SUPPORT_CONTEXT_CHANGED','原回复属于之前的聊天，请刷新核对',409);
        return {memberId:row.member_id,conversation:conversation(row),message:await this.messageView(client,prior,row,"operator"),replayed:true};
      }
      if(row.status!=="human_active"||row.current_handler_principal_id!==principal)throw new DomainError("SUPPORT_ASSIGNMENT_REQUIRED","Claim this conversation before replying",409);
      const {target}=await this.replyTarget(client,row,input);
      const sequence=Number(row.next_sequence);const messageId=randomUUID();
      const context=(await client.query<{retention_purpose:string}>(`SELECT retention_purpose FROM support_message
        WHERE conversation_id=$1 AND sender_type='user' ORDER BY sequence DESC LIMIT 1`,[id])).rows[0];
      const targetPurpose=target?(await client.query<{retention_purpose:string}>('SELECT retention_purpose FROM support_message WHERE id=$1',[target.id])).rows[0]?.retention_purpose:context?.retention_purpose;
      const purpose=targetPurpose==='ordinary'?'ordinary':
        targetPurpose==='transaction'?'transaction':'legacy_unknown';
      const inserted=(await client.query<MessageRow>(`INSERT INTO support_message(id,conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id,retention_purpose,reply_to_message_id)
        VALUES($1,$2,$3,'admin',$4,$5,$6,$7,$8) RETURNING ${messageColumns()}`,[messageId,id,sequence,principal,body,messageKey,purpose,target?.id??null])).rows[0]!;
      row=(await client.query<ConversationRow>(`UPDATE support_conversation SET next_sequence=next_sequence+1,member_unread_count=member_unread_count+1,
        version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id])).rows[0]!;
      await client.query("UPDATE support_presence SET typing_expires_at=clock_timestamp(),online_expires_at=GREATEST(online_expires_at,clock_timestamp()+interval '10 seconds'),updated_at=clock_timestamp() WHERE conversation_id=$1 AND actor_type='operator' AND actor_principal_id=$2", [id, principal]);
      await this.audit(client,principal,"support.message.reply",id,null,{messageId,sequence},traceId);
      await enqueue(client,{eventType:"support.message.created.v1",aggregateType:"support_conversation",aggregateId:id,aggregateVersion:row.version,
        businessKey:`support-message:${messageId}`,payload:{conversationId:id,messageId,senderType:"admin",sequence},occurredAt:inserted.created_at});
      return {memberId:row.member_id,conversation:conversation(row),message:await this.messageView(client,inserted,row,"operator",undefined,target?.id),replayed:false};
    });
    const {memberId:owner,...acknowledged}=result;
    try{return {...acknowledged,...await this.currentTopicState(owner)};}
    catch{return {...acknowledged,contextSyncRequired:true};}
  }
  async markTeamRead(memberId:string|undefined,id:string,input:{lastSeenSequence?:unknown}){
    await this.operator(memberId,"support.read");const seen=cursor(input.lastSeenSequence);if(seen===null)throw new DomainError("CURSOR_INVALID","lastSeenSequence is required",422);
    const owner=(await this.findById(this.pool,id)).member_id;await this.reconcile(owner);
    return transaction(this.pool,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`support-member:${owner}`]);
      await this.reconcileLocked(client,owner);
      const row=await this.findById(client,id,true);
      const effectiveSeen=Math.max(await this.contextBoundary(client,row),Number(row.team_last_read_sequence),Math.min(seen,Number(row.next_sequence)-1));
      const unread=await client.query<{count:number}>("SELECT count(*)::int AS count FROM support_message WHERE conversation_id=$1 AND sequence>$2 AND sender_type='user'",[row.id,effectiveSeen]);
      const updated=await client.query<ConversationRow>("UPDATE support_conversation SET team_last_read_sequence=$2,team_unread_count=$3 WHERE id=$1 RETURNING *",[row.id,effectiveSeen,unread.rows[0]!.count]);
      return conversation(updated.rows[0]!);});
  }
  async resolve(memberId:string|undefined,principalId:string|undefined,id:string,input:{expectedVersion?:unknown},traceId:string){
    await this.operator(memberId,"support.reply");const principal=required(principalId,"AUTH_REQUIRED");const expected=version(input.expectedVersion);
    const owner=(await this.findById(this.pool,id)).member_id;await this.reconcile(owner);
    return transaction(this.pool,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`support-member:${owner}`]);
      await this.reconcileLocked(client,owner);
      const row=await this.findById(client,id,true);if(row.status==="resolved")return conversation(row);
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
      if(this.suppression?.suppressionEnabled())await recordWholeSuppression(client,this.suppression,
        {...row,resolved_at:row.resolved_at!},state.policyCode,true,new Date());
      await client.query(`INSERT INTO media_cleanup_queue(media_id,object_key,reason,next_attempt_at)
        SELECT id,object_key,'support_purged',clock_timestamp() FROM media_object
        WHERE support_conversation_id=$1 AND upload_state IN ('authorized','uploaded')
          AND NOT EXISTS(SELECT 1 FROM support_message external_message
            WHERE external_message.conversation_id<>$1 AND external_message.attachment_refs ? media_object.id::text)
        ON CONFLICT DO NOTHING`, [id]);
      await client.query("SELECT set_config('cisme.support_purge_conversation_id',$1,true)",[id]);
      await client.query("DELETE FROM support_message WHERE conversation_id=$1",[id]);
      const removed=Boolean((await client.query(`DELETE FROM support_conversation c WHERE c.id=$1
        AND NOT EXISTS(SELECT 1 FROM media_object media WHERE media.support_conversation_id=c.id
          AND media.upload_state IN ('authorized','uploaded')
          AND NOT EXISTS(SELECT 1 FROM media_cleanup_queue queued WHERE queued.media_id=media.id))`,
        [id])).rowCount);
      if(!removed)await client.query(`UPDATE support_conversation SET member_unread_count=0,
        team_unread_count=0,version=version+1,updated_at=clock_timestamp() WHERE id=$1`,[id]);
      const auditId=(await client.query<{id:string}>(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'support.retention.purge','support_conversation',$2,'SUPPORT_RETENTION_POLICY',
          jsonb_build_object('policyCode',$3::text,'policyVersion',$4::integer,'messageCount',$5::integer,'resolvedAt',$6::timestamptz),
          jsonb_build_object('messagesPurged',true,'conversationRemoved',$7::boolean),$8) RETURNING id`,
        [principal,id,state.policyCode,state.policyVersion,messageCount,row.resolved_at,removed,traceId])).rows[0]!.id;
      const response={conversationId:id,purged:true,messagesPurged:messageCount,conversationRemoved:removed,
        policyCode:state.policyCode,policyVersion:state.policyVersion,auditTombstoneId:auditId};
      if(removed)await enqueue(client,{eventType:"support.conversation.purged.v1",aggregateType:"support_conversation",aggregateId:id,aggregateVersion:row.version+1,
        businessKey:`support-purge:${id}`,payload:{conversationId:id,policyCode:state.policyCode,policyVersion:state.policyVersion,messageCount},occurredAt:new Date()});
      await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
        VALUES($1,$2,$3,$4,$5,200,$6)`,[principal,operation,idempotencyKey,`support-purge:${id}`,hash,response]);
      return response;
    },'READ COMMITTED',1,60_000);
  }
}

import {createHash} from 'node:crypto';
import type {DbClient} from './db.js';

/** User-requested new conversations are distinct from time-based retention.
 * This body-free marker lives outside database backups and preserves both
 * the erasure intent and the generation fence after a database restore. */
export type SupportConversationResetMarker={version:7;scope:'support_new_conversation_v1';memberId:string;
  conversationId:string;requestId:string;expectedVersion:number;contextStartSequence:number;
  resultVersion:number;memberCreatedAt:string;createdAt:string};
export const supportNewTopicOperation='support.conversation.new_topic';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validateSupportConversationReset(row:SupportConversationResetMarker,memberId=row.memberId,
  conversationId=row.conversationId,requestId=row.requestId){
  const keys=['version','scope','memberId','conversationId','requestId','expectedVersion','contextStartSequence',
    'resultVersion','memberCreatedAt','createdAt'];
  if(row.version!==7||row.scope!=='support_new_conversation_v1'||row.memberId!==memberId||
    row.conversationId!==conversationId||row.requestId!==requestId||![memberId,conversationId,requestId].every(v=>uuid.test(v))||
    Object.keys(row).length!==keys.length||!keys.every(key=>Object.hasOwn(row,key))||
    !Number.isSafeInteger(row.expectedVersion)||row.expectedVersion<1||
    !Number.isSafeInteger(row.resultVersion)||row.resultVersion!==row.expectedVersion+1||
    !Number.isSafeInteger(row.contextStartSequence)||row.contextStartSequence<0||
    !Number.isFinite(Date.parse(row.memberCreatedAt))||!Number.isFinite(Date.parse(row.createdAt)))
    throw new Error('SUPPORT_NEW_CONVERSATION_MARKER_INVALID');
  return row;
}
export function supportResetRequestHash(row:Pick<SupportConversationResetMarker,'conversationId'|'expectedVersion'>){
  return createHash('sha256').update(JSON.stringify({conversationId:row.conversationId,expectedVersion:row.expectedVersion})).digest('hex');
}
export type SupportResetReceipt={principal_id:string;idempotency_key:string;business_key:string;
  request_hash:string;response_status:number;response_body:unknown};
export function assertSupportResetReceipt(marker:SupportConversationResetMarker,receipt:SupportResetReceipt){
  const value=receipt.response_body as {conversationId?:unknown;contextStartSequence?:unknown;resultVersion?:unknown}|null;
  if(receipt.principal_id!==`member:${marker.memberId}`||receipt.idempotency_key!==marker.requestId||
    receipt.business_key!==`support-topic:${marker.conversationId}:v${marker.expectedVersion}`||
    receipt.request_hash!==supportResetRequestHash(marker)||receipt.response_status!==200||
    !value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||
    value.conversationId!==marker.conversationId||value.contextStartSequence!==marker.contextStartSequence||value.resultVersion!==marker.resultVersion)
    throw new Error('SUPPORT_NEW_CONVERSATION_RECEIPT_MISMATCH');
}

/** Idempotently restores the generation before removing ordinary content.
 * Held/transaction/ambiguous records remain available to their separate
 * rights/retention workflows, never to the active chat or model window. */
export async function applySupportConversationReset(client:DbClient,marker:SupportConversationResetMarker,recovering=true){
  validateSupportConversationReset(marker);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`support-member:${marker.memberId}`]);
  const member=(await client.query<{created_at:Date}>('SELECT created_at FROM member WHERE id=$1 FOR SHARE',[marker.memberId])).rows[0];
  if(!member)return false;
  if(member.created_at.toISOString()!==marker.memberCreatedAt)throw new Error('SUPPORT_NEW_CONVERSATION_SUBJECT_MISMATCH');
  const row=(await client.query<{member_id:string;status:string;version:number;next_sequence:string}>(
    'SELECT member_id,status,version,next_sequence FROM support_conversation WHERE id=$1 FOR UPDATE',[marker.conversationId])).rows[0];
  // A later exact retention purge may legitimately have removed this old
  // aggregate. Never recreate it or attach the marker to a new aggregate.
  if(!row)return false;
  if(row.member_id!==marker.memberId)throw new Error('SUPPORT_NEW_CONVERSATION_SUBJECT_MISMATCH');
  const response={conversationId:marker.conversationId,contextStartSequence:marker.contextStartSequence,resultVersion:marker.resultVersion};
  const hash=supportResetRequestHash(marker),principal=`member:${marker.memberId}`;
  const prior=(await client.query<SupportResetReceipt>(`SELECT principal_id,idempotency_key,business_key,request_hash,response_status,response_body FROM idempotency_operation
    WHERE principal_id=$1 AND operation=$2 AND idempotency_key=$3`,[principal,supportNewTopicOperation,marker.requestId])).rows[0];
  if(prior)assertSupportResetReceipt(marker,prior);
  if(prior){
    const pending=(await client.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM support_message
      WHERE conversation_id=$1 AND sequence<=$2 AND retention_purpose='ordinary') OR
      EXISTS(SELECT 1 FROM media_object media WHERE support_conversation_id=$1 AND bound_support_message_id IS NULL
        AND upload_state IN ('authorized','uploaded') AND authorized_at<=$3::timestamptz
        AND NOT EXISTS(SELECT 1 FROM support_message remaining WHERE remaining.attachment_refs ? media.id::text)) AS pending`,
      [marker.conversationId,marker.contextStartSequence,marker.createdAt])).rows[0]?.pending;
    if(!pending)return false;
  }
  if(!prior){
    // A restore may predate messages that established the original boundary.
    // Honour the existing monotonic trigger one step at a time, in one DB
    // round trip. No fake messages or relaxed database guards are introduced.
    if(Number(row.next_sequence)<=marker.contextStartSequence||row.version<marker.resultVersion-1){
      await client.query("SELECT set_config('cisme.support_reset_replay',$1,true)",[JSON.stringify(marker)]);
      await client.query(`DO $support_reset$ DECLARE value jsonb:=current_setting('cisme.support_reset_replay')::jsonb;
        target uuid:=(value->>'conversationId')::uuid; boundary bigint:=(value->>'contextStartSequence')::bigint;
        required_version integer:=(value->>'resultVersion')::integer; current_row support_conversation%ROWTYPE;
        BEGIN SELECT * INTO current_row FROM support_conversation WHERE id=target FOR UPDATE;
          WHILE current_row.next_sequence<=boundary OR current_row.version<required_version-1 LOOP
            UPDATE support_conversation SET next_sequence=CASE WHEN next_sequence<=boundary THEN next_sequence+1 ELSE next_sequence END,
              version=version+1,updated_at=clock_timestamp() WHERE id=target RETURNING * INTO current_row;
          END LOOP;
        END $support_reset$`);
    }
    // Preserve an already established human service when replaying an intent;
    // ordinary fresh reset requests are rejected before recording a marker.
    await client.query(`UPDATE support_conversation SET status=CASE WHEN status='resolved' THEN 'ai_active' ELSE status END,
      resolved_at=CASE WHEN status='resolved' THEN NULL ELSE resolved_at END,
      version=version+1,updated_at=clock_timestamp() WHERE id=$1`,[marker.conversationId]);
    await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
      VALUES($1,$2,$3,$4,$5,200,$6)`,[principal,supportNewTopicOperation,marker.requestId,
      `support-topic:${marker.conversationId}:v${marker.expectedVersion}`,hash,response]);
    if(recovering)await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
      VALUES($1,'support.conversation.new_topic','support_conversation',$2,'SUPPORT_USER_NEW_CONVERSATION',$3,gen_random_uuid()::text)`,
      [principal,marker.conversationId,{...response,recoveredFromIndependentMarker:true}]);
  }
  await client.query('LOCK TABLE legal_hold IN SHARE MODE');
  await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
  await client.query('LOCK TABLE privacy_request IN SHARE MODE');
  // Capture image IDs before the immutable message delete nulls media bindings.
  const removable=(await client.query<{id:string;attachment_refs:string[]}>(`SELECT message.id,message.attachment_refs FROM support_message message
    WHERE message.conversation_id=$1 AND message.sequence<=$2 AND message.retention_purpose='ordinary'
      AND NOT EXISTS(SELECT 1 FROM privacy_request request WHERE request.member_id=$3
        AND request.status NOT IN ('completed','partially_completed','rejected','canceled'))
      AND NOT EXISTS(SELECT 1 FROM legal_hold_binding binding JOIN legal_hold hold ON hold.id=binding.hold_id
        WHERE hold.status='active' AND hold.expires_at>clock_timestamp() AND (
          binding.object_type='member' AND binding.object_id=$3::text OR
          binding.object_type='support_conversation' AND binding.object_id=$1::text OR
          binding.object_type='support_message' AND binding.object_id=message.id::text OR
          binding.object_type='media_object' AND message.attachment_refs ? binding.object_id))
    FOR UPDATE`,[marker.conversationId,marker.contextStartSequence,marker.memberId])).rows;
  if(removable.length){
    await client.query("SELECT set_config('cisme.support_purge_conversation_id',$1,true)",[marker.conversationId]);
    await client.query(`DELETE FROM support_message WHERE conversation_id=$1 AND id=ANY($2::uuid[])
      AND retention_purpose='ordinary' AND sequence<=$3`,[marker.conversationId,removable.map(item=>item.id),marker.contextStartSequence]);
  }
  const images=[...new Set(removable.flatMap(item=>item.attachment_refs))];
  // Unsent draft images from the old generation are cleared as well. Never
  // remove an attachment still referenced by preserved evidence.
  const removedMedia=(await client.query<{id:string}>(`WITH selected AS (SELECT media.id,media.object_key FROM media_object media
    WHERE media.support_conversation_id=$1 AND media.support_member_id=$2 AND media.upload_state IN ('authorized','uploaded')
      AND (media.id=ANY($3::uuid[]) OR media.bound_support_message_id IS NULL AND media.authorized_at<=$4::timestamptz)
      AND NOT EXISTS(SELECT 1 FROM support_message remaining WHERE remaining.attachment_refs ? media.id::text)
      AND NOT EXISTS(SELECT 1 FROM legal_hold_binding binding JOIN legal_hold hold ON hold.id=binding.hold_id
        WHERE hold.status='active' AND hold.expires_at>clock_timestamp() AND (
          binding.object_type='member' AND binding.object_id=$2::text OR
          binding.object_type='support_conversation' AND binding.object_id=$1::text OR
          binding.object_type='media_object' AND binding.object_id=media.id::text))
      AND NOT EXISTS(SELECT 1 FROM privacy_request request WHERE request.member_id=$2
        AND request.status NOT IN ('completed','partially_completed','rejected','canceled'))
      FOR UPDATE OF media), queued AS (
      INSERT INTO media_cleanup_queue(media_id,object_key,reason,next_attempt_at)
      SELECT id,object_key,'support_deleted',clock_timestamp() FROM selected ON CONFLICT DO NOTHING RETURNING media_id)
    UPDATE media_object SET upload_state='deleted',deleted_at=clock_timestamp(),is_current=false
    WHERE id IN (SELECT id FROM selected) RETURNING id`,[marker.conversationId,marker.memberId,images,marker.createdAt])).rows;
  if(removedMedia.length)await client.query('DELETE FROM upload_chunk WHERE media_id=ANY($1::uuid[])',[removedMedia.map(item=>item.id)]);
  // The highest receipt wins regardless of marker replay order. A delayed old
  // intent must never reset a newer generation's unread/read state or typing.
  const newest=(await client.query<{boundary:string;result_version:string}>(`SELECT response_body->>'contextStartSequence' AS boundary,
    response_body->>'resultVersion' AS result_version FROM idempotency_operation
    WHERE principal_id=$1 AND operation=$2 AND response_body->>'conversationId'=$3
    ORDER BY (response_body->>'resultVersion')::bigint DESC LIMIT 1`,[principal,supportNewTopicOperation,marker.conversationId])).rows[0]!;
  const boundary=Number(newest.boundary);
  await client.query(`UPDATE support_conversation c SET
    member_last_read_sequence=GREATEST(member_last_read_sequence,$2),team_last_read_sequence=GREATEST(team_last_read_sequence,$2),
    member_unread_count=(SELECT count(*)::int FROM support_message m WHERE m.conversation_id=c.id AND m.sequence>GREATEST(c.member_last_read_sequence,$2) AND m.sender_type IN ('ai','admin','system')),
    team_unread_count=(SELECT count(*)::int FROM support_message m WHERE m.conversation_id=c.id AND m.sequence>GREATEST(c.team_last_read_sequence,$2) AND m.sender_type='user') WHERE id=$1`,[marker.conversationId,boundary]);
  if(!prior&&Number(newest.result_version)===marker.resultVersion)
    await client.query('DELETE FROM support_presence WHERE conversation_id=$1',[marker.conversationId]);
  return !prior||removable.length>0||removedMedia.length>0;
}

import type {DbClient} from './db.js';
import type {SupportMessageMarker} from './accountClosure.js';
import {enqueue} from './outbox.js';

/** Replays an independently durable, already reviewed ordinary-message
 * deletion after database restore. The marker contains IDs, never bodies.
 * A newer hold or active conversation delays replay without losing it. */
export async function applySupportMessageSuppression(client:DbClient,marker:SupportMessageMarker,now=new Date()){
  const row=(await client.query<{member_id:string;status:string;created_at:Date;version:number}>(`SELECT c.member_id,c.status,m.created_at,c.version
    FROM support_conversation c JOIN member m ON m.id=c.member_id
    WHERE c.id=$1 FOR UPDATE OF c`,[marker.conversationId])).rows[0];
  if(!row)return {deleted:0,queued:0,removed:false};
  if(row.member_id!==marker.memberId||row.created_at.toISOString()!==marker.memberCreatedAt)
    throw new Error('SUPPORT_SUPPRESSION_SUBJECT_MISMATCH');
  if(row.status!=='resolved')return {deleted:0,queued:0,removed:false};
  await client.query('LOCK TABLE legal_hold IN SHARE MODE');
  await client.query('LOCK TABLE legal_hold_binding IN SHARE MODE');
  const held=(await client.query<{held:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM legal_hold_binding b JOIN legal_hold h ON h.id=b.hold_id
    WHERE h.status='active' AND h.expires_at>$4 AND (
      b.object_type='member' AND b.object_id=$1 OR
      b.object_type='support_conversation' AND b.object_id=$2 OR
      b.object_type='support_message' AND b.object_id=ANY($3::text[]) OR
      b.object_type='media_object' AND b.object_id=ANY($5::text[]))) AS held`,
    [marker.memberId,marker.conversationId,marker.messageIds,now,marker.mediaIds])).rows[0]?.held;
  if(held)return {deleted:0,queued:0,removed:false};
  const openRights=(await client.query<{open:boolean}>(`SELECT EXISTS(SELECT 1 FROM privacy_request
    WHERE member_id=$1 AND status NOT IN ('completed','partially_completed','rejected','canceled')) AS open`,
    [marker.memberId])).rows[0]?.open;
  if(openRights)return {deleted:0,queued:0,removed:false};
  await client.query("SELECT set_config('cisme.support_purge_conversation_id',$1,true)",[marker.conversationId]);
  const deleted=(await client.query(`DELETE FROM support_message WHERE conversation_id=$1
    AND id=ANY($2::uuid[])`,[marker.conversationId,marker.messageIds])).rowCount??0;
  const queued=(await client.query(`INSERT INTO media_cleanup_queue(media_id,object_key,reason,next_attempt_at)
    SELECT media.id,media.object_key,'support_purged',$3 FROM media_object media
    WHERE media.id=ANY($1::uuid[]) AND media.support_conversation_id=$2
      AND media.upload_state IN ('authorized','uploaded')
      AND media.bound_support_message_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM support_message remaining
        WHERE remaining.attachment_refs ? media.id::text)
    ON CONFLICT DO NOTHING`,[marker.mediaIds,marker.conversationId,now])).rowCount??0;
  let version=row.version;
  if(deleted){
    const updated=(await client.query<{version:number}>(`UPDATE support_conversation c SET
      member_unread_count=(SELECT count(*)::int FROM support_message m WHERE m.conversation_id=c.id
        AND m.sequence>c.member_last_read_sequence AND m.sender_type IN ('ai','admin','system')),
      team_unread_count=(SELECT count(*)::int FROM support_message m WHERE m.conversation_id=c.id
        AND m.sequence>c.team_last_read_sequence AND m.sender_type='user'),
      version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING version`,[marker.conversationId])).rows[0];
    version=updated!.version;
  }
  const removed=marker.removeConversation&&Boolean((await client.query(`DELETE FROM support_conversation c
    WHERE c.id=$1 AND NOT EXISTS(SELECT 1 FROM support_message m WHERE m.conversation_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM commerce_aftersale_case a WHERE a.support_conversation_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM media_object media WHERE media.support_conversation_id=c.id
        AND media.upload_state IN ('authorized','uploaded')
        AND NOT EXISTS(SELECT 1 FROM media_cleanup_queue queued WHERE queued.media_id=media.id))`,
    [marker.conversationId])).rowCount);
  if(deleted||removed){
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
      after_state,trace_id) VALUES('worker:support-retention','support.message.retention.purge',
      'support_conversation',$1,'SUPPORT_MESSAGE_RETENTION',$2,gen_random_uuid()::text)`,
      [marker.conversationId,{batchId:marker.batchId,policyCode:marker.policyCode,
        messageCount:deleted,mediaQueued:queued,conversationRemoved:removed}]);
    if(removed)await enqueue(client,{eventType:'support.conversation.purged.v1',
      aggregateType:'support_conversation',aggregateId:marker.conversationId,
      aggregateVersion:version,businessKey:`support-purge:${marker.conversationId}`,
      payload:{conversationId:marker.conversationId,policyCode:marker.policyCode,messageCount:deleted},
      occurredAt:now});
  }
  return {deleted,queued,removed};
}

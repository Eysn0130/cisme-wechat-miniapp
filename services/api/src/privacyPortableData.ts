import { createDecipheriv } from 'node:crypto';
import type { AppConfig } from '@cisme/config';
import { DomainError } from '@cisme/domain';
import type { DbClient } from './db.js';
import { DeliveryAddressService } from './deliveryAddress.js';
import type { ObjectStorage } from './storage.js';
import { assertOperationActive } from './operationBudget.js';

const maxCopyBytes=64*1024*1024;
type MediaRow={id:string;object_key:string;mime_type:string;size_bytes:string|null;kind:string};

function openContact(config:AppConfig,memberId:string,row:{phone_encrypted:string;key_version:string}|undefined){
  if(!row)return null;
  if(!config.contacts.encryptionKey||row.key_version!==config.contacts.keyVersion)
    throw new DomainError('PRIVACY_EXPORT_CONTACT_KEY_UNAVAILABLE','手机号暂时无法安全读取',503);
  try{
    const bytes=Buffer.from(row.phone_encrypted,'base64');
    const decipher=createDecipheriv('aes-256-gcm',Buffer.from(config.contacts.encryptionKey,'hex'),bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(memberId));
    decipher.setAuthTag(bytes.subarray(12,28));
    return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
  }catch{throw new DomainError('PRIVACY_EXPORT_CONTACT_UNREADABLE','手机号暂时无法安全读取',503);}
}

/** Fixed owner-scoped projections prevent future database columns or other
 * members' records from silently entering a private export. Internal keys,
 * security logs and other people's identities are intentionally excluded. */
export async function collectMemberPortableData(client:DbClient,config:AppConfig,
  addresses:DeliveryAddressService,memberId:string){
  const member=(await client.query<{id:string;display_name:string;status:string;created_at:Date}>(
    'SELECT id,display_name,status,created_at FROM member WHERE id=$1',[memberId])).rows[0];
  if(!member||!['active','deleted'].includes(member.status))
    throw new DomainError('PRIVACY_EXPORT_MEMBER_MISSING','申请账号不可用',409);
  const contact=(await client.query<{phone_encrypted:string;key_version:string}>(
    'SELECT phone_encrypted,key_version FROM member_contact WHERE member_id=$1',[memberId])).rows[0];
  const addressRows=await addresses.exportOwned(client,memberId);
  const sections:Record<string,unknown>={
    account:{id:member.id,displayName:member.display_name,createdAt:member.created_at,
      identity:(await client.query(`SELECT provider,app_id,openid,unionid,created_at FROM wechat_identity
        WHERE member_id=$1`,[memberId])).rows,
      profile:(await client.query(`SELECT wechat_handle,avatar_data_url,public_status,completed_at,updated_at
        FROM member_profile WHERE member_id=$1`,[memberId])).rows[0]??null,
      phone:openContact(config,memberId,contact),addresses:addressRows},
    care:{cycles:(await client.query(`SELECT id,phase,started_on,timezone,protocol_version,created_at,updated_at
        FROM care_cycle WHERE member_id=$1 ORDER BY created_at,id`,[memberId])).rows,
      records:(await client.query(`SELECT r.id,r.cycle_id,r.milestone,r.due_on,r.completed_at,r.protocol_version,r.self_assessment
        FROM care_record r JOIN care_cycle c ON c.id=r.cycle_id WHERE c.member_id=$1
        ORDER BY r.completed_at,r.id`,[memberId])).rows,
      steps:(await client.query(`SELECT s.record_id,s.step_code,s.sequence,s.completed_at,s.protocol_version
        FROM care_record_step s JOIN care_record r ON r.id=s.record_id
        JOIN care_cycle c ON c.id=r.cycle_id WHERE c.member_id=$1
        ORDER BY s.record_id,s.sequence`,[memberId])).rows},
    commerce:{orders:(await client.query(`SELECT id,order_number,status,subtotal_cents,member_discount_cents,
        shipping_cents,total_cents,credit_tender_cents,created_at,updated_at
        FROM commerce_order WHERE member_id=$1 ORDER BY created_at,id`,[memberId])).rows,
      lines:(await client.query(`SELECT l.order_id,l.line_number,l.product_name,l.sku_label,l.quantity,
        l.unit_price_cents,l.line_discount_cents,l.line_total_cents,l.credit_tender_cents
        FROM commerce_order_line l JOIN commerce_order o ON o.id=l.order_id
        WHERE o.member_id=$1 ORDER BY l.order_id,l.line_number`,[memberId])).rows,
      aftersales:(await client.query(`SELECT id,order_id,kind,state,claim_basis,reason,lines,amount_cents,
        return_carrier,return_tracking,quality_result,created_at,updated_at
        FROM commerce_aftersale_case WHERE member_id=$1 ORDER BY created_at,id`,[memberId])).rows,
      refunds:(await client.query(`SELECT r.id,r.order_id,r.amount_cents,r.reason,r.state,r.created_at,r.decided_at
        FROM commerce_refund_request r JOIN commerce_order o ON o.id=r.order_id
        WHERE o.member_id=$1 ORDER BY r.created_at,r.id`,[memberId])).rows},
    support:{messages:(await client.query(`SELECT m.id,m.sequence,m.sender_type,m.body,m.content_type,
        m.linked_order_id,m.linked_case_id,m.created_at
        FROM support_message m JOIN support_conversation c ON c.id=m.conversation_id
        WHERE c.member_id=$1 ORDER BY m.sequence,m.id`,[memberId])).rows},
    community:{posts:(await client.query(`SELECT id,state,visibility,published_at,created_at,updated_at
        FROM ugc_post WHERE author_member_id=$1 ORDER BY created_at,id`,[memberId])).rows,
      revisions:(await client.query(`SELECT r.post_id,r.revision,r.title,r.body,r.content_warning,r.created_at
        FROM ugc_post_revision r JOIN ugc_post p ON p.id=r.post_id
        WHERE p.author_member_id=$1 ORDER BY r.post_id,r.revision`,[memberId])).rows,
      comments:(await client.query(`SELECT id,post_id,parent_id,reply_to_id,body,state,created_at,updated_at
        FROM ugc_comment WHERE author_member_id=$1 ORDER BY created_at,id`,[memberId])).rows},
    membership:{state:(await client.query(`SELECT state,effective_at,expires_at,updated_at
        FROM commercial_membership WHERE member_id=$1`,[memberId])).rows[0]??null,
      commission:(await client.query(`SELECT id,kind,amount_cents,occurred_at
        FROM commission_ledger_entry WHERE referrer_member_id=$1 ORDER BY occurred_at,id`,[memberId])).rows,
      shoppingCredit:(await client.query(`SELECT e.id,e.kind,e.amount_cents,e.purchase_order_id,e.occurred_at
        FROM commission_credit_entry e JOIN commission_credit_source s ON s.id=e.source_id
        JOIN commission_credit_conversion c ON c.id=s.conversion_id
        WHERE c.member_id=$1 ORDER BY e.occurred_at,e.id`,[memberId])).rows},
    rights:{requests:(await client.query(`SELECT id,kind,message,scope_code,status,response,
        resolution_code,created_at,completed_at FROM privacy_request WHERE member_id=$1
        ORDER BY created_at,id`,[memberId])).rows,
      consents:(await client.query(`SELECT purpose_code,document_type,document_version,scope,
        status,granted_at,withdrawn_at FROM consent_receipt WHERE member_id=$1
        ORDER BY granted_at,id`,[memberId])).rows}
  };
  const orderAddresses=(await client.query<{order_id:string;encrypted_payload:string;payload_hmac:string;key_version:string}>(
    `SELECT a.order_id,a.encrypted_payload,a.payload_hmac,a.key_version FROM commerce_order_address a
      JOIN commerce_order o ON o.id=a.order_id WHERE o.member_id=$1 ORDER BY a.order_id`,[memberId])).rows;
  (sections.commerce as Record<string,unknown>).deliveryAddresses=orderAddresses.map(row=>({orderId:row.order_id,
    address:addresses.openOrderSnapshot(memberId,row.order_id,row.encrypted_payload,row.payload_hmac,row.key_version)}));
  const uploaded=(await client.query<MediaRow>(`SELECT m.id,m.object_key,m.mime_type,m.size_bytes,'member_upload' AS kind
    FROM media_object m WHERE m.upload_state='uploaded' AND m.deleted_at IS NULL AND (
      EXISTS(SELECT 1 FROM submission s WHERE s.id=m.submission_id AND s.member_id=$1)
      OR EXISTS(SELECT 1 FROM support_conversation c WHERE c.id=m.support_conversation_id AND c.member_id=$1))
    UNION ALL SELECT id,object_key,mime_type,size_bytes,'community_upload' AS kind
      FROM ugc_media_asset WHERE owner_member_id=$1 AND state IN ('uploaded','scanning','approved','rejected')
    ORDER BY id`,[memberId])).rows;
  return {sections,uploaded};
}

/** Object storage calls happen after the short database snapshot has closed.
 * An unavailable owned asset is reported explicitly and never makes the rest
 * of the subject's readable information disappear. */
export async function materializeMemberPortableData(snapshot:Awaited<ReturnType<typeof collectMemberPortableData>>,
  storage:ObjectStorage){
  const {sections,uploaded}=snapshot;
  const media:Array<{id:string;kind:string;mimeType:string;base64:string}>=[];
  const unavailableMedia:Array<{id:string;kind:string;reason:string}>=[];
  let mediaBytes=0;
  for(const row of uploaded){
    assertOperationActive();
    if(row.mime_type==='video/mp4'){
      unavailableMedia.push({id:row.id,kind:row.kind,reason:'video_requires_separate_copy'});
      continue;
    }
    const remaining=maxCopyBytes/2-mediaBytes;
    if(remaining<=0||(row.size_bytes!==null&&Number(row.size_bytes)>remaining)){
      unavailableMedia.push({id:row.id,kind:row.kind,reason:'inline_copy_size_limit'});continue;
    }
    try{
      const source=await storage.read(row.object_key);
      if(source.bytes.byteLength>remaining){
        unavailableMedia.push({id:row.id,kind:row.kind,reason:'inline_copy_size_limit'});continue;
      }
      mediaBytes+=source.bytes.byteLength;
      media.push({id:row.id,kind:row.kind,mimeType:source.mimeType,base64:Buffer.from(source.bytes).toString('base64')});
    }catch{
      unavailableMedia.push({id:row.id,kind:row.kind,reason:'stored_copy_unavailable'});
    }
  }
  sections.media=media;
  const bytes=Buffer.from(JSON.stringify({schema:'cisme.member.portable.v1',generatedAt:new Date().toISOString(),sections,
    unavailableMedia}),'utf8');
  if(bytes.length>maxCopyBytes)throw new DomainError('PRIVACY_EXPORT_TOO_LARGE','数据副本超出单次下载上限',409);
  return {bytes,complete:unavailableMedia.length===0,sectionNames:Object.keys(sections),unavailableMedia};
}

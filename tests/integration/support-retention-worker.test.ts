import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {chmod,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { purgeDueOrdinarySupport, purgeDueLinkedSupport, purgeDueMixedOrdinarySupport } from '../../services/api/src/supportRetention.js';
import {AccountClosure} from '../../services/api/src/accountClosure.js';
import {SupportService} from '../../services/api/src/supportService.js';

const pool=testPool();
const suppressionDirectory=await mkdtemp(join(tmpdir(),'cisme-support-suppression-'));
await chmod(suppressionDirectory,0o700);
const suppression=new AccountClosure(suppressionDirectory);
const now=new Date('2026-09-23T12:00:00.000Z');
async function conversation(label:string,resolvedAt:string){
  const member=(await pool.query<{id:string}>('INSERT INTO member(display_name) VALUES($1) RETURNING id',[label])).rows[0]!;
  const row=(await pool.query<{id:string}>(`INSERT INTO support_conversation(member_id,status,resolved_at)
    VALUES($1,'resolved',$2) RETURNING id`,[member.id,resolvedAt])).rows[0]!;
  await pool.query(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,body,client_message_id)
    VALUES($1,1,'user',$2,$3,$4)`,[row.id,`member:${member.id}`,label,`retention-${label}`]);
  return {id:row.id,memberId:member.id};
}

async function linkedCanceledConversation(suffix:string,finishedAt:string,resolvedAt:string,sharedMediaId?:string){
  const member=(await pool.query<{id:string}>('INSERT INTO member(display_name) VALUES($1) RETURNING id',[`linked-${suffix}`])).rows[0]!;
  const product=(await pool.query<{id:string}>(`INSERT INTO catalog_product(code,name,source_kind,qualification_status,
    publication_status,created_by,updated_by,published_at)
    VALUES($1,'Retention fixture','admin','eligible','published','fixture','fixture',now()) RETURNING id`,
    [`retention-${suffix}`])).rows[0]!;
  const sku=(await pool.query<{id:string}>(`INSERT INTO catalog_sku(product_id,code,label,created_by,updated_by)
    VALUES($1,$2,'One','fixture','fixture') RETURNING id`,[product.id,`RETENTION_${suffix}`])).rows[0]!;
  const addressId=randomUUID();
  await pool.query(`INSERT INTO member_delivery_address(id,member_id,encrypted_payload,payload_hmac,key_version,label,client_request_key)
    VALUES($1,$2,'fixture',$3,'fixture','home',$4)`,[addressId,member.id,'a'.repeat(64),`retention-address-${suffix}`]);
  const quote=(await pool.query<{id:string}>(`INSERT INTO commerce_checkout_quote(member_id,product_id,sku_id,address_id,
    address_version,quantity,currency,unit_price_cents,subtotal_cents,member_discount_cents,shipping_cents,
    total_cents,pricing_rule_version,product_version,sku_version,price_version,status,idempotency_key,request_hash,
    expires_at,consumed_at,created_at)
    VALUES($1,$2,$3,$4,1,1,'CNY',10000,10000,0,0,10000,'fixture-r1',1,1,1,'consumed',$5,$6,
    $7::timestamptz+interval '1 day',$7,$7) RETURNING id`,
    [member.id,product.id,sku.id,addressId,`retention-quote-${suffix}`,'b'.repeat(64),finishedAt])).rows[0]!;
  const order=(await pool.query<{id:string}>(`INSERT INTO commerce_order(order_number,member_id,source_quote_id,status,
    currency,subtotal_cents,member_discount_cents,shipping_cents,total_cents,pricing_rule_version,expires_at,
    cancelled_at,terminal_reason,transaction_source_kind,created_at,updated_at)
    VALUES($1,$2,$3,'cancelled','CNY',10000,0,0,10000,'fixture-r1',$4::timestamptz+interval '1 day',
    $4,'Cancelled fixture','verified_commerce',$4,$4) RETURNING id`,
    [`CM20260923${suffix.padStart(12,'0')}`,member.id,quote.id,finishedAt])).rows[0]!;
  const row=(await pool.query<{id:string}>(`INSERT INTO support_conversation(member_id,status,resolved_at,created_at,updated_at)
    VALUES($1,'resolved',$2,$2,$2) RETURNING id`,[member.id,resolvedAt])).rows[0]!;
  await pool.query(`INSERT INTO support_message(conversation_id,sequence,sender_type,sender_principal_id,
    body,content_type,linked_order_id,order_snapshot,attachment_refs,client_message_id,created_at)
    VALUES($1,1,'user',$2,'Order consultation',$6,$3,'{}'::jsonb,$7::jsonb,$4,$5)`,
    [row.id,`member:${member.id}`,order.id,`retention-linked-${suffix}`,resolvedAt,
      sharedMediaId?'mixed':'order',JSON.stringify(sharedMediaId?[sharedMediaId]:[])]);
  return {conversationId:row.id,memberId:member.id,orderId:order.id};
}

beforeAll(async()=>{await resetDatabase(pool);});
afterAll(async()=>{await pool.end();await rm(suppressionDirectory,{recursive:true,force:true});});

describe('ordinary support retention worker',()=>{
  it('requires an enabled finite policy and applies calendar months',async()=>{
    const configured=(await pool.query(`SELECT duration_months,active,enforcement_state,
      automatic_purge_enabled FROM data_retention_policy
      WHERE code='support_conversation_policy_pending'`)).rows[0];
    expect(configured).toMatchObject({duration_months:3,active:true,
      enforcement_state:'enforced',automatic_purge_enabled:false});
    const old=await conversation('old ordinary inquiry','2026-07-01T12:00:00Z');
    const recent=await conversation('recent ordinary inquiry','2026-09-01T12:00:00Z');
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(0);
    await pool.query(`UPDATE data_retention_policy SET duration_months=1,enforcement_state='enforced',active=true,
      version=version+1,updated_at=now() WHERE code='support_conversation_policy_pending'`);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(0);
    await pool.query(`UPDATE data_retention_policy SET automatic_purge_enabled=true,
      version=version+1,updated_at=now() WHERE code='support_conversation_policy_pending'`);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(1);
    expect((await pool.query('SELECT id FROM support_conversation WHERE id=$1',[old.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM support_conversation WHERE id=$1',[recent.id])).rowCount).toBe(1);
    const audit=(await pool.query(`SELECT before_state,after_state FROM audit_log
      WHERE action='support.retention.purge' AND object_id=$1`,[old.id])).rows[0];
    expect(audit?.before_state).toMatchObject({policyCode:'support_conversation_policy_pending',messageCount:1});
    expect(JSON.stringify(audit)).not.toContain('old ordinary inquiry');
    expect((await pool.query(`SELECT after_state->>'automaticPurge' AS enabled FROM audit_log
      WHERE action='privacy.retention_policy.change' AND after_state->>'code'='support_conversation_policy_pending'
      ORDER BY created_at DESC,id DESC LIMIT 1`)).rows[0].enabled).toBe('true');
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(0);
  });

  it('preserves a held conversation and deletes it only after release',async()=>{
    const held=await conversation('held ordinary inquiry','2026-07-01T12:00:00Z');
    const hold=(await pool.query<{id:string}>(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
      VALUES('SUPPORT_RETENTION_TEST','Isolated retention hold','test-reviewer',$1,$2) RETURNING id`,
      [new Date('2026-10-01T12:00:00Z'),new Date('2026-11-01T12:00:00Z')])).rows[0]!;
    await pool.query(`INSERT INTO legal_hold_binding(hold_id,object_type,object_id)
      VALUES($1,'support_conversation',$2)`,[hold.id,held.id]);
    const next=await conversation('later eligible inquiry','2026-08-01T12:00:00Z');
    expect(await purgeDueOrdinarySupport(pool,now,1)).toBe(1);
    expect((await pool.query('SELECT id FROM support_conversation WHERE id=$1',[next.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM support_conversation WHERE id=$1',[held.id])).rowCount).toBe(1);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(0);
    await pool.query(`UPDATE legal_hold SET status='released',released_by='test-reviewer',released_at=$2
      WHERE id=$1`,[hold.id,now]);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(1);
    expect((await pool.query('SELECT id FROM support_conversation WHERE id=$1',[held.id])).rowCount).toBe(0);
  });

  it('preserves an ordinary message or attachment held on its own',async()=>{
    const messageHeld=await conversation('held single message','2026-07-01T12:00:00Z');
    const mediaHeld=await conversation('held single attachment','2026-07-02T12:00:00Z');
    const message=(await pool.query<{id:string}>(
      'SELECT id FROM support_message WHERE conversation_id=$1',[messageHeld.id])).rows[0]!;
    const media=(await pool.query<{id:string}>(`INSERT INTO media_object(kind,object_key,mime_type,size_bytes,
      upload_state,uploaded_at,support_conversation_id,support_member_id,support_expires_at)
      VALUES('chat_image',$1,'image/jpeg',3,'uploaded',$2,$3,$4,$5) RETURNING id`,
      [`held-support-${randomUUID()}`,now,mediaHeld.id,mediaHeld.memberId,
        new Date('2026-11-01T12:00:00Z')])).rows[0]!;
    const hold=(await pool.query<{id:string}>(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
      VALUES('SUPPORT_MESSAGE_MEDIA_HOLD','Isolated message and attachment hold','test-reviewer',$1,$2) RETURNING id`,
      [new Date('2026-10-01T12:00:00Z'),new Date('2026-11-01T12:00:00Z')])).rows[0]!;
    await pool.query(`INSERT INTO legal_hold_binding(hold_id,object_type,object_id)
      VALUES($1,'support_message',$2),($1,'media_object',$3)`, [hold.id,message.id,media.id]);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(0);
    expect((await pool.query('SELECT 1 FROM support_message WHERE id=$1',[message.id])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM media_object WHERE id=$1',[media.id])).rowCount).toBe(1);
    await pool.query(`DELETE FROM legal_hold_binding WHERE hold_id=$1 AND object_type='support_message'`,[hold.id]);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(1);
    expect((await pool.query('SELECT 1 FROM support_conversation WHERE id=$1',[messageHeld.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM support_conversation WHERE id=$1',[mediaHeld.id])).rowCount).toBe(1);
    await pool.query("UPDATE legal_hold SET status='released',released_by='test-reviewer',released_at=$2 WHERE id=$1",[hold.id,now]);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(1);
    expect((await pool.query('SELECT 1 FROM support_conversation WHERE id=$1',[mediaHeld.id])).rowCount).toBe(0);
  });

  it('keeps consultation history while the member has an open privacy request',async()=>{
    const subject=await conversation('rights inquiry evidence','2026-07-01T12:00:00Z');
    const request=(await pool.query<{id:string}>(`INSERT INTO privacy_request(member_id,kind,message,due_at)
      VALUES($1,'access','Need my information',clock_timestamp()+interval '30 days') RETURNING id`,
      [subject.memberId])).rows[0]!;
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(0);
    expect((await pool.query('SELECT id FROM support_conversation WHERE id=$1',[subject.id])).rowCount).toBe(1);
    await pool.query("UPDATE privacy_request SET status='canceled' WHERE id=$1",[request.id]);
    expect(await purgeDueOrdinarySupport(pool,now)).toBe(1);
  });
  it('persists suppression before whole-conversation cleanup and reapplies it after restore',async()=>{
    await pool.query(`UPDATE data_retention_policy SET active=true,enforcement_state='enforced',
      automatic_purge_enabled=true,version=version+1 WHERE code='support_conversation_policy_pending'`);
    const old=await conversation('suppressed old support inquiry','2026-04-01T12:00:00Z');
    const message=(await pool.query<{id:string}>(`SELECT id FROM support_message WHERE conversation_id=$1`,
      [old.id])).rows[0]!;
    expect(await purgeDueOrdinarySupport(pool,now,20,suppression)).toBe(1);
    expect((await pool.query('SELECT 1 FROM support_conversation WHERE id=$1',[old.id])).rowCount).toBe(0);
    await pool.query(`INSERT INTO support_conversation(id,member_id,status,resolved_at)
      VALUES($1,$2,'resolved',$3)`,[old.id,old.memberId,'2026-04-01T12:00:00Z']);
    await pool.query(`INSERT INTO support_message(id,conversation_id,sequence,sender_type,
      sender_principal_id,body,client_message_id,retention_purpose)
      VALUES($1,$2,1,'user',$3,'旧备份中的咨询',$4,'ordinary')`,
      [message.id,old.id,`member:${old.memberId}`,`restored-whole-${randomUUID()}`]);
    await suppression.replayPendingErasure(pool);
    expect((await pool.query('SELECT 1 FROM support_message WHERE id=$1',[message.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM support_conversation WHERE id=$1',[old.id])).rowCount).toBe(0);
  });
  it('records every attachment in bounded marker pages before removing a large old conversation',async()=>{
    const old=await conversation('many old support attachments','2026-04-01T12:00:00Z');
    await pool.query(`INSERT INTO media_object(kind,object_key,mime_type,size_bytes,upload_state,
      uploaded_at,support_conversation_id,support_member_id,support_expires_at)
      SELECT 'chat_image','retention-many-'||$3::text||'-'||n,'image/jpeg',3,'uploaded',$4,
        $1,$2,'infinity' FROM generate_series(1,1001) n`,[old.id,old.memberId,randomUUID(),now]);
    expect(await purgeDueOrdinarySupport(pool,now,20,suppression)).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS count FROM media_cleanup_queue
      WHERE reason='support_purged' AND object_key LIKE 'retention-many-%'`)).rows[0].count).toBe(1001);
    expect((await pool.query('SELECT 1 FROM support_conversation WHERE id=$1',[old.id])).rowCount).toBe(0);
  });
});

describe('linked transaction support retention worker',()=>{
  it('honors the separate 36-month policy and the later conversation close',async()=>{
    const due=await linkedCanceledConversation('0001','2023-08-01T12:00:00Z','2023-08-02T12:00:00Z');
    const message=(await pool.query<{id:string}>(`SELECT id FROM support_message WHERE conversation_id=$1`,
      [due.conversationId])).rows[0]!;
    expect(await purgeDueLinkedSupport(pool,now)).toBe(0);
    await pool.query(`UPDATE data_retention_policy SET active=true,enforcement_state='enforced',
      automatic_purge_enabled=true,version=version+1,updated_at=now()
      WHERE code='support_transaction_three_years'`);
    expect(await purgeDueLinkedSupport(pool,now,20,suppression)).toBe(1);
    expect((await pool.query('SELECT 1 FROM support_message WHERE conversation_id=$1',[due.conversationId])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM support_conversation WHERE id=$1',[due.conversationId])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM commerce_order WHERE id=$1',[due.orderId])).rowCount).toBe(1);
    expect((await pool.query(`SELECT before_state FROM audit_log WHERE action='support.transaction.retention.purge'
      AND object_id=$1`,[due.conversationId])).rows[0]?.before_state).toMatchObject({
        policyCode:'support_transaction_three_years',messageCount:1,orderCount:1});
    await pool.query(`INSERT INTO support_conversation(id,member_id,status,resolved_at)
      VALUES($1,$2,'resolved',$3)`,[due.conversationId,due.memberId,'2023-08-02T12:00:00Z']);
    await pool.query(`INSERT INTO support_message(id,conversation_id,sequence,sender_type,
      sender_principal_id,body,content_type,linked_order_id,order_snapshot,client_message_id)
      VALUES($1,$2,1,'user',$3,'恢复的订单咨询','order',$4,'{}'::jsonb,$5)`,
      [message.id,due.conversationId,`member:${due.memberId}`,due.orderId,`restored-linked-${randomUUID()}`]);
    await suppression.replayPendingErasure(pool);
    expect((await pool.query('SELECT 1 FROM support_message WHERE id=$1',[message.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM support_conversation WHERE id=$1',[due.conversationId])).rowCount).toBe(0);
  });

  it('holds a linked conversation until the latest transaction and any legal hold end',async()=>{
    const recent=await linkedCanceledConversation('0002','2024-01-01T12:00:00Z','2023-01-01T12:00:00Z');
    expect(await purgeDueLinkedSupport(pool,now)).toBe(0);
    expect((await pool.query('SELECT 1 FROM support_message WHERE conversation_id=$1',[recent.conversationId])).rowCount).toBe(1);
    const held=await linkedCanceledConversation('0003','2023-07-01T12:00:00Z','2023-07-02T12:00:00Z');
    const hold=(await pool.query<{id:string}>(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
      VALUES('LINKED_SUPPORT_TEST','Isolated order hold','test-reviewer',$1,$2) RETURNING id`,
      [new Date('2026-10-01T12:00:00Z'),new Date('2026-11-01T12:00:00Z')])).rows[0]!;
    await pool.query(`INSERT INTO legal_hold_binding(hold_id,object_type,object_id)
      VALUES($1,'commerce_order',$2)`,[hold.id,held.orderId]);
    expect(await purgeDueLinkedSupport(pool,now)).toBe(0);
    await pool.query(`UPDATE legal_hold SET status='released',released_by='test-reviewer',released_at=$2 WHERE id=$1`,
      [hold.id,now]);
    expect(await purgeDueLinkedSupport(pool,now)).toBe(1);
    expect((await pool.query('SELECT 1 FROM support_message WHERE conversation_id=$1',[held.conversationId])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM support_message WHERE conversation_id=$1',[recent.conversationId])).rowCount).toBe(1);
  });

  it('removes due messages but keeps the case-referenced conversation shell',async()=>{
    const linked=await linkedCanceledConversation('0004','2023-06-01T12:00:00Z','2023-06-02T12:00:00Z');
    const entry=(await pool.query<{id:string}>(`INSERT INTO commerce_aftersale_case(order_id,member_id,kind,state,
      reason,lines,amount_cents,idempotency_key,request_hash,support_conversation_id,created_at,updated_at)
      VALUES($1,$2,'refund_only','rejected','Fixture rejected claim','[{"lineId":"fixture","quantity":1}]',
      10000,$3,$4,$5,$6,$6) RETURNING id`,[linked.orderId,linked.memberId,'retention-case-0004',
      'c'.repeat(64),linked.conversationId,'2023-06-03T12:00:00Z'])).rows[0]!;
    expect(await purgeDueLinkedSupport(pool,now)).toBe(1);
    expect((await pool.query('SELECT 1 FROM support_message WHERE conversation_id=$1',[linked.conversationId])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM support_conversation WHERE id=$1',[linked.conversationId])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM commerce_aftersale_case WHERE id=$1',[entry.id])).rowCount).toBe(1);
    expect((await pool.query(`SELECT after_state->>'conversationRetained' AS retained FROM audit_log
      WHERE action='support.transaction.retention.purge' AND object_id=$1`,[linked.conversationId])).rows[0]?.retained).toBe('true');
    expect(await purgeDueLinkedSupport(pool,now)).toBe(0);
  });

  it('does not extend an old linked conversation for a later unrelated order',async()=>{
    const old=await linkedCanceledConversation('0005','2023-06-01T12:00:00Z','2023-06-02T12:00:00Z');
    const source=(await pool.query(`SELECT q.product_id,q.sku_id,q.address_id FROM commerce_order o
      JOIN commerce_checkout_quote q ON q.id=o.source_quote_id WHERE o.id=$1`,[old.orderId])).rows[0];
    const quote=(await pool.query<{id:string}>(`INSERT INTO commerce_checkout_quote(member_id,product_id,sku_id,address_id,
      address_version,quantity,currency,unit_price_cents,subtotal_cents,member_discount_cents,
      shipping_cents,total_cents,pricing_rule_version,product_version,sku_version,price_version,
      status,idempotency_key,request_hash,expires_at)
      VALUES($1,$2,$3,$4,1,1,'CNY',10000,10000,0,0,10000,'fixture-r1',1,1,1,
      'active','retention-new-order-0005',$5,now()+interval '1 day') RETURNING id`,
      [old.memberId,source.product_id,source.sku_id,source.address_id,'d'.repeat(64)])).rows[0]!;
    await pool.query(`UPDATE commerce_checkout_quote SET status='consumed',consumed_at=now() WHERE id=$1`,[quote.id]);
    const laterOrder=(await pool.query<{id:string}>(`INSERT INTO commerce_order(order_number,member_id,source_quote_id,status,currency,
      subtotal_cents,member_discount_cents,shipping_cents,total_cents,pricing_rule_version,expires_at)
      VALUES('CM20260923000000000006',$1,$2,'pending_payment','CNY',10000,0,0,10000,
      'fixture-r1',now()+interval '1 day') RETURNING id`,[old.memberId,quote.id])).rows[0]!;
    await pool.query(`INSERT INTO commerce_aftersale_case(order_id,member_id,kind,state,
      reason,lines,amount_cents,idempotency_key,request_hash,created_at,updated_at)
      VALUES($1,$2,'refund_only','requested','Later unrelated request',
        '[{"lineId":"fixture","quantity":1}]',10000,$3,$4,$5,$5)`,
      [laterOrder.id,old.memberId,`retention-later-case-${randomUUID()}`,'d'.repeat(64),
        '2026-09-23T12:00:00Z']);
    expect(await purgeDueLinkedSupport(pool,now)).toBe(1);
    expect((await pool.query('SELECT 1 FROM support_message WHERE conversation_id=$1',[old.conversationId])).rowCount).toBe(0);
  });

  it('passes an unfinished older conversation to clear a later due conversation',async()=>{
    // PostgreSQL microseconds must survive keyset pagination; JS Date alone
    // would truncate the cursor and repeatedly select this blocked row.
    const unfinished=await linkedCanceledConversation('0007','2024-01-01T12:00:00Z','2022-01-01T12:00:00.000123Z');
    const due=await linkedCanceledConversation('0008','2022-06-01T12:00:00Z','2022-06-02T12:00:00Z');
    expect(await purgeDueLinkedSupport(pool,now,1)).toBe(1);
    expect((await pool.query('SELECT 1 FROM support_message WHERE conversation_id=$1',[unfinished.conversationId])).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM support_message WHERE conversation_id=$1',[due.conversationId])).rowCount).toBe(0);
  });
  it('purges only due ordinary messages in a mixed thread and suppresses backup restoration',async()=>{
    await pool.query(`UPDATE data_retention_policy SET active=true,enforcement_state='enforced',
      automatic_purge_enabled=true,version=version+1 WHERE code='support_conversation_policy_pending'`);
    const sharedId=randomUUID(),orphanId=randomUUID();
    const linked=await linkedCanceledConversation('0010','2023-06-01T12:00:00Z','2023-06-02T12:00:00Z',sharedId);
    await pool.query('UPDATE support_conversation SET next_sequence=2,version=version+1 WHERE id=$1',[linked.conversationId]);
    const ordinary=(await pool.query<{id:string}>(`INSERT INTO support_message(conversation_id,sequence,
      sender_type,sender_principal_id,body,content_type,attachment_refs,client_message_id,retention_purpose,created_at)
      VALUES($1,2,'user',$2,'其他咨询','image',$5::jsonb,$3,'ordinary',$4) RETURNING id`,
      [linked.conversationId,`member:${linked.memberId}`,`mixed-ordinary-${randomUUID()}`,
        '2023-06-02T12:00:00Z',JSON.stringify([sharedId,orphanId])])).rows[0]!;
    await pool.query<{id:string}>(`INSERT INTO media_object(id,kind,object_key,mime_type,size_bytes,
      upload_state,uploaded_at,support_conversation_id,support_member_id,bound_support_message_id,support_expires_at)
      VALUES($1,'chat_image',$2,'image/jpeg',3,'uploaded',$3,$4,$5,$6,'infinity')`,
      [sharedId,`shared-support-${randomUUID()}`,now,linked.conversationId,linked.memberId,ordinary.id]);
    await pool.query<{id:string}>(`INSERT INTO media_object(id,kind,object_key,mime_type,size_bytes,
      upload_state,uploaded_at,support_conversation_id,support_member_id,bound_support_message_id,support_expires_at)
      VALUES($1,'chat_image',$2,'image/jpeg',3,'uploaded',$3,$4,$5,$6,'infinity')`,
      [orphanId,`orphan-support-${randomUUID()}`,now,linked.conversationId,linked.memberId,ordinary.id]);
    await pool.query(`UPDATE support_conversation SET next_sequence=3,team_unread_count=2,version=version+1
      WHERE id=$1`,[linked.conversationId]);
    expect(await purgeDueMixedOrdinarySupport(pool,suppression,now)).toBe(1);
    expect((await pool.query('SELECT 1 FROM support_message WHERE id=$1',[ordinary.id])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM support_message WHERE conversation_id=$1
      AND linked_order_id IS NOT NULL`,[linked.conversationId])).rowCount).toBe(1);
    expect((await pool.query('SELECT team_unread_count,next_sequence FROM support_conversation WHERE id=$1',
      [linked.conversationId])).rows[0]).toMatchObject({team_unread_count:1,next_sequence:'3'});
    expect((await pool.query('SELECT 1 FROM media_cleanup_queue WHERE media_id=$1',[sharedId])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM media_cleanup_queue WHERE media_id=$1',[orphanId])).rowCount).toBe(1);
    const support=new SupportService(pool,null as never,null as never,
      {read:async()=>({bytes:Uint8Array.of(0xff,0xd8,0xff),mimeType:'image/jpeg'})} as never);
    const page=await support.messagesForMember(linked.memberId,{limit:20});
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.attachments[0]?.id).toBe(sharedId);
    expect((await support.memberSupportMedia(linked.memberId,sharedId)).bytes).toEqual(Uint8Array.of(0xff,0xd8,0xff));
    expect((await support.messagesForMember(linked.memberId,{after:1,limit:20})).messages).toHaveLength(0);
    // A restored old database contains the same message again. The marker
    // outside that backup removes it, without touching the transaction row.
    await pool.query(`INSERT INTO support_message(id,conversation_id,sequence,sender_type,sender_principal_id,
      body,content_type,attachment_refs,client_message_id,retention_purpose)
      VALUES($1,$2,3,'user',$3,'恢复的旧咨询','image',$4::jsonb,$5,'ordinary')`,
      [ordinary.id,linked.conversationId,`member:${linked.memberId}`,JSON.stringify([sharedId,orphanId]),
        `restored-${randomUUID()}`]);
    await suppression.replayPendingErasure(pool);
    expect((await pool.query('SELECT 1 FROM support_message WHERE id=$1',[ordinary.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM media_cleanup_queue WHERE media_id=$1',[sharedId])).rowCount).toBe(0);
    const ambiguous=(await pool.query<{retention_purpose:string}>(`INSERT INTO support_message(conversation_id,
      sequence,sender_type,sender_principal_id,body,client_message_id)
      VALUES($1,3,'user',$3,'历史未判明用途',$2) RETURNING retention_purpose`,
      [linked.conversationId,`legacy-mixed-${randomUUID()}`,`member:${linked.memberId}`])).rows[0]!;
    expect(ambiguous.retention_purpose).toBe('legacy_unknown');
    expect(await purgeDueMixedOrdinarySupport(pool,suppression,now)).toBe(0);
  });
});

/** Fixed owner projections shared with the bounded v2 portable export. Keep these
 * query fields aligned with privacyPortableData.ts until v1 is retired. */
export const portableQuerySpecs = [
  {section:'account',collection:'identity',single:false,sql:`SELECT provider,app_id,openid,unionid,created_at FROM wechat_identity
        WHERE member_id=$1`},
  {section:'account',collection:'profile',single:true,sql:`SELECT wechat_handle,avatar_data_url,public_status,completed_at,updated_at
        FROM member_profile WHERE member_id=$1`},
  {section:'care',collection:'cycles',single:false,sql:`SELECT id,phase,started_on,timezone,protocol_version,created_at,updated_at
        FROM care_cycle WHERE member_id=$1 ORDER BY created_at,id`},
  {section:'care',collection:'qualifications',single:false,sql:`SELECT id,source,external_ref,occurred_at,created_at
        FROM qualification_fact WHERE member_id=$1 ORDER BY occurred_at,id`},
  {section:'care',collection:'pauses',single:false,sql:`SELECT p.cycle_id,p.reason_code,p.paused_at,p.paused_on,
        p.ended_at,p.ended_on,p.end_action,p.duration_days FROM care_cycle_pause p
        JOIN care_cycle c ON c.id=p.cycle_id WHERE c.member_id=$1
        ORDER BY p.paused_at,p.id`},
  {section:'care',collection:'records',single:false,sql:`SELECT r.id,r.cycle_id,r.milestone,r.due_on,r.completed_at,r.protocol_version,r.self_assessment
        FROM care_record r JOIN care_cycle c ON c.id=r.cycle_id WHERE c.member_id=$1
        ORDER BY r.completed_at,r.id`},
  {section:'care',collection:'steps',single:false,sql:`SELECT s.record_id,s.step_code,s.sequence,s.completed_at,s.protocol_version
        FROM care_record_step s JOIN care_record r ON r.id=s.record_id
        JOIN care_cycle c ON c.id=r.cycle_id WHERE c.member_id=$1
        ORDER BY s.record_id,s.sequence`},
  {section:'participation',collection:'submissions',single:false,sql:`SELECT id,status,post_url,platform_account,disclosure,
        license_payload,submitted_at,created_at,updated_at FROM submission
        WHERE member_id=$1 ORDER BY created_at,id`},
  {section:'participation',collection:'decisions',single:false,sql:`SELECT d.id,d.cycle_id,d.eligible,d.reason_code,d.decided_at
        FROM eligibility_decision d JOIN care_cycle c ON c.id=d.cycle_id
        WHERE c.member_id=$1 ORDER BY d.decided_at,d.id`},
  {section:'participation',collection:'tasks',single:false,sql:`SELECT id,state,expires_at FROM eligibility_task
        WHERE member_id=$1 ORDER BY expires_at,id`},
  {section:'participation',collection:'claims',single:false,sql:`SELECT id,task_id,submission_id,claimed_at FROM task_claim
        WHERE member_id=$1 ORDER BY claimed_at,id`},
  {section:'participation',collection:'appeals',single:false,sql:`SELECT id,review_case_id,reason,status,created_at FROM appeal
        WHERE member_id=$1 ORDER BY created_at,id`},
  {section:'participation',collection:'rewards',single:false,sql:`SELECT id,submission_id,amount,state,created_at FROM reward_claim
        WHERE member_id=$1 ORDER BY created_at,id`},
  {section:'participation',collection:'points',single:false,sql:`SELECT id,grant_id,lot_id,entry_type,frozen_delta,
        available_delta,debt_delta,occurred_at FROM points_entry
        WHERE member_id=$1 ORDER BY occurred_at,id`},
  {section:'participation',collection:'pointBalance',single:true,sql:`SELECT frozen,available,debt,updated_at FROM points_projection
        WHERE member_id=$1`},
  {section:'participation',collection:'consentGrants',single:false,sql:`SELECT submission_id,purpose,granted_at FROM consent_grant
        WHERE member_id=$1 ORDER BY granted_at,id`},
  {section:'participation',collection:'revocations',single:false,sql:`SELECT r.consent_grant_id,r.reason,r.requested_at,r.processed_at
        FROM revocation_request r JOIN consent_grant g ON g.id=r.consent_grant_id
        WHERE g.member_id=$1 ORDER BY r.requested_at,r.id`},
  {section:'commerce',collection:'orders',single:false,sql:`SELECT id,order_number,status,subtotal_cents,member_discount_cents,
        shipping_cents,total_cents,credit_tender_cents,created_at,updated_at
        FROM commerce_order WHERE member_id=$1 ORDER BY created_at,id`},
  {section:'commerce',collection:'lines',single:false,sql:`SELECT l.order_id,l.line_number,l.product_name,l.sku_label,l.quantity,
        l.unit_price_cents,l.line_discount_cents,l.line_total_cents,l.credit_tender_cents
        FROM commerce_order_line l JOIN commerce_order o ON o.id=l.order_id
        WHERE o.member_id=$1 ORDER BY l.order_id,l.line_number`},
  {section:'commerce',collection:'aftersales',single:false,sql:`SELECT id,order_id,kind,state,claim_basis,reason,lines,amount_cents,
        return_carrier,return_tracking,quality_result,created_at,updated_at
        FROM commerce_aftersale_case WHERE member_id=$1 ORDER BY created_at,id`},
  {section:'commerce',collection:'refunds',single:false,sql:`SELECT r.id,r.order_id,r.amount_cents,r.reason,r.state,r.created_at,r.decided_at
        FROM commerce_refund_request r JOIN commerce_order o ON o.id=r.order_id
        WHERE o.member_id=$1 ORDER BY r.created_at,r.id`},
  {section:'commerce',collection:'paymentAttempts',single:false,sql:`SELECT id,order_id,out_trade_no,amount_cents,currency,state,
        created_at,updated_at FROM commerce_payment_attempt WHERE member_id=$1
        ORDER BY created_at,id`},
  {section:'commerce',collection:'shipments',single:false,sql:`SELECT s.id,s.order_id,s.carrier_name,s.logistics_state,
        s.shipped_at,s.delivered_at,s.receipt_confirmed_at FROM commerce_shipment s
        JOIN commerce_order o ON o.id=s.order_id WHERE o.member_id=$1
        ORDER BY s.shipped_at,s.id`},
  {section:'commerce',collection:'shipmentEvents',single:false,sql:`SELECT e.shipment_id,e.event_type,e.occurred_at
        FROM commerce_shipment_event e JOIN commerce_shipment s ON s.id=e.shipment_id
        JOIN commerce_order o ON o.id=s.order_id WHERE o.member_id=$1
        ORDER BY e.occurred_at,e.id`},
  {section:'commerce',collection:'aftersaleEvents',single:false,sql:`SELECT e.case_id,e.action,e.note,e.from_state,e.to_state,
        e.created_at FROM commerce_aftersale_event e
        JOIN commerce_aftersale_case c ON c.id=e.case_id WHERE c.member_id=$1
        ORDER BY e.created_at,e.id`},
  {section:'commerce',collection:'returnInstructions',single:false,sql:`SELECT i.case_id,i.version,i.recipient_name,i.phone,
        i.region,i.address,i.freight_payer,i.instructions,i.issued_at
        FROM commerce_aftersale_return_instruction i
        JOIN commerce_aftersale_case c ON c.id=i.case_id WHERE c.member_id=$1
        ORDER BY i.case_id,i.version`},
  {section:'support',collection:'messages',single:false,sql:`SELECT m.id,m.sequence,m.sender_type,m.body,m.content_type,
        m.attachment_refs,m.linked_order_id,m.order_snapshot,m.linked_case_id,
        m.return_instruction_snapshot,m.created_at
        FROM support_message m JOIN support_conversation c ON c.id=m.conversation_id
        WHERE c.member_id=$1 ORDER BY m.sequence,m.id`},
  {section:'community',collection:'posts',single:false,sql:`SELECT id,state,visibility,published_at,created_at,updated_at
        FROM ugc_post WHERE author_member_id=$1 ORDER BY created_at,id`},
  {section:'community',collection:'revisions',single:false,sql:`SELECT r.post_id,r.revision,r.title,r.body,r.content_warning,r.created_at
        FROM ugc_post_revision r JOIN ugc_post p ON p.id=r.post_id
        WHERE p.author_member_id=$1 ORDER BY r.post_id,r.revision`},
  {section:'community',collection:'comments',single:false,sql:`SELECT id,post_id,parent_id,reply_to_id,body,state,created_at,updated_at
        FROM ugc_comment WHERE author_member_id=$1 ORDER BY created_at,id`},
  {section:'community',collection:'reactions',single:false,sql:`SELECT post_id,kind,created_at FROM ugc_post_reaction
        WHERE member_id=$1 ORDER BY created_at,post_id,kind`},
  {section:'community',collection:'follows',single:false,sql:`SELECT created_at FROM ugc_author_follow
        WHERE follower_member_id=$1 ORDER BY created_at,followed_member_id`},
  {section:'community',collection:'blocks',single:false,sql:`SELECT created_at FROM ugc_block_relation
        WHERE blocker_member_id=$1 ORDER BY created_at,blocked_member_id`},
  {section:'community',collection:'reports',single:false,sql:`SELECT id,target_type,target_id,category,description,state,
        created_at,updated_at FROM ugc_report WHERE reporter_member_id=$1
        ORDER BY created_at,id`},
  {section:'membership',collection:'state',single:true,sql:`SELECT state,effective_at,expires_at,updated_at
        FROM commercial_membership WHERE member_id=$1`},
  {section:'membership',collection:'referralCode',single:true,sql:`SELECT code,state,created_at,disabled_at
        FROM commercial_referral_code WHERE member_id=$1`},
  {section:'membership',collection:'referralReceived',single:true,sql:`SELECT confirmed_at FROM commercial_referral_relation
        WHERE referred_member_id=$1`},
  {section:'membership',collection:'referralSent',single:false,sql:`SELECT confirmed_at FROM commercial_referral_relation
        WHERE referrer_member_id=$1 ORDER BY confirmed_at`},
  {section:'membership',collection:'shares',single:false,sql:`SELECT id,share_id,target_type,target_ref,state,created_at,expires_at
        FROM share_link WHERE member_id=$1 ORDER BY created_at,id`},
  {section:'membership',collection:'commission',single:false,sql:`SELECT id,kind,amount_cents,occurred_at
        FROM commission_ledger_entry WHERE referrer_member_id=$1 ORDER BY occurred_at,id`},
  {section:'membership',collection:'settlementRequests',single:false,sql:`SELECT id,amount_cents,state,created_at,decided_at,finalized_at
        FROM commission_settlement_request WHERE member_id=$1 ORDER BY created_at,id`},
  {section:'membership',collection:'creditConversions',single:false,sql:`SELECT id,gross_cents,withholding_cents,credit_cents,
        state,created_at,cancelled_at FROM commission_credit_conversion WHERE member_id=$1
        ORDER BY created_at,id`},
  {section:'membership',collection:'shoppingCredit',single:false,sql:`SELECT e.id,e.kind,e.amount_cents,e.purchase_order_id,e.occurred_at
        FROM commission_credit_entry e JOIN commission_credit_source s ON s.id=e.source_id
        JOIN commission_credit_conversion c ON c.id=s.conversion_id
        WHERE c.member_id=$1 ORDER BY e.occurred_at,e.id`},
  {section:'rights',collection:'requests',single:false,sql:`SELECT id,kind,message,scope_code,target_ref,status,response,
        resolution_code,created_at,completed_at FROM privacy_request WHERE member_id=$1
        ORDER BY created_at,id`},
  {section:'rights',collection:'consents',single:false,sql:`SELECT purpose_code,document_type,document_version,scope,
        status,granted_at,withdrawn_at FROM consent_receipt WHERE member_id=$1
        ORDER BY granted_at,id`},
  {section:'rights',collection:'memberReplies',single:false,sql:`SELECT r.privacy_request_id,r.body,r.created_at
        FROM privacy_request_member_reply r JOIN privacy_request p ON p.id=r.privacy_request_id
        WHERE p.member_id=$1 ORDER BY r.created_at,r.id`},
  {section:'rights',collection:'operatorReplies',single:false,sql:`SELECT r.privacy_request_id,r.body,r.created_at
        FROM privacy_request_operator_reply r JOIN privacy_request p ON p.id=r.privacy_request_id
        WHERE p.member_id=$1 ORDER BY r.created_at,r.id`},
] as const;

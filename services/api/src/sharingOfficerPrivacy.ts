import type {AppConfig} from '@cisme/config';
import type {DbClient} from './db.js';
import {openSharingPayload} from './sharingOfficerCrypto.js';
export const sharingPortableSpecs=[
 {section:'sharingOfficer',collection:'qualification',single:true,sql:`SELECT referral_code,state,application_note,review_reason,created_at,updated_at FROM sharing_officer WHERE member_id=$1`},
 {section:'sharingOfficer',collection:'qualificationHistory',single:false,sql:`SELECT version,from_state,to_state,reason,occurred_at FROM sharing_officer_event WHERE member_id=$1 ORDER BY version`},
 {section:'sharingOfficer',collection:'customerRelation',single:true,sql:`SELECT o.referral_code,r.source,r.effective_at,r.expires_at,r.version FROM sharing_customer_relation r JOIN sharing_officer o ON o.member_id=r.officer_id WHERE r.buyer_id=$1`},
 {section:'sharingOfficer',collection:'relationHistory',single:false,sql:`SELECT e.version,a.referral_code AS from_code,b.referral_code AS to_code,e.source,e.occurred_at FROM sharing_relation_event e LEFT JOIN sharing_officer a ON a.member_id=e.from_officer_id JOIN sharing_officer b ON b.member_id=e.to_officer_id WHERE e.buyer_id=$1 ORDER BY e.version`},
 {section:'sharingOfficer',collection:'links',single:false,sql:`SELECT share_id,product_code,created_at FROM sharing_link WHERE officer_id=$1 ORDER BY created_at,share_id`},
 {section:'sharingOfficer',collection:'visits',single:false,sql:`SELECT id,share_id,visited_at,bound_at FROM sharing_visit WHERE visitor_id=$1 ORDER BY visited_at,id`},
 {section:'sharingOfficer',collection:'orders',single:false,sql:`SELECT s.order_id,s.basis_points,s.cash_merchandise_cents,p.version AS policy_version,s.created_at FROM commission_order_snapshot s JOIN sharing_policy p ON p.id=s.sharing_policy_id WHERE s.referrer_member_id=$1 AND s.program='sharing_officer' ORDER BY s.created_at,s.order_id`},
 {section:'sharingOfficer',collection:'refunds',single:false,sql:`SELECT i.id,i.order_id,i.state,i.eligible_merchandise_refund_cents,i.finalized_at FROM commission_refund_intent i JOIN commission_order_snapshot s ON s.order_id=i.order_id WHERE s.referrer_member_id=$1 AND s.program='sharing_officer' ORDER BY i.created_at,i.id`},
 {section:'sharingOfficer',collection:'settlements',single:false,sql:`SELECT l.id,b.period,l.state,l.gross_cents,l.tax_cents,l.net_cents,l.tax_note,l.reviewed_at,l.paid_at,l.payment_reference,l.created_at FROM sharing_settlement_line l JOIN sharing_settlement_batch b ON b.id=l.batch_id WHERE l.member_id=$1 ORDER BY l.created_at,l.id`},
 {section:'sharingOfficer',collection:'allocations',single:false,sql:`SELECT a.line_id,a.order_id,a.amount_cents FROM sharing_settlement_allocation a JOIN sharing_settlement_line l ON l.id=a.line_id WHERE l.member_id=$1 ORDER BY a.line_id,a.order_id`},
 {section:'sharingOfficer',collection:'recoveries',single:false,sql:`SELECT r.id,r.order_id,r.amount_cents,r.received_cents,r.tax_adjustment_cents,r.note,r.reference,r.recorded_at FROM sharing_recovery r JOIN commission_order_snapshot s ON s.order_id=r.order_id WHERE s.referrer_member_id=$1 ORDER BY r.recorded_at,r.id`},
 {section:'sharingOfficer',collection:'payee',single:true,sql:`SELECT member_id,encrypted_payload,version,updated_at FROM sharing_payee WHERE member_id=$1`},
 {section:'sharingOfficer',collection:'reviewedPayee',single:false,sql:`SELECT member_id,payee_snapshot AS encrypted_payload,payee_version AS version,reviewed_at,id AS settlement_id FROM sharing_settlement_line WHERE member_id=$1 AND payee_snapshot IS NOT NULL ORDER BY created_at,id`},
] as const;
export function sharingPortableRow(config:AppConfig,collection:string,row:Record<string,unknown>){
 if(collection!=='payee'&&collection!=='reviewedPayee')return row;
 const {member_id,encrypted_payload,...safe}=row;
 return {...safe,...openSharingPayload(config,String(encrypted_payload),`sharing-payee:${member_id}`)};
}
export async function collectSharingPortableData(client:DbClient,config:AppConfig,memberId:string){
 const result:Record<string,unknown>={};for(const spec of sharingPortableSpecs){const rows=(await client.query(spec.sql,[memberId])).rows.map(r=>sharingPortableRow(config,spec.collection,r));result[spec.collection]=spec.single?rows[0]??null:rows;}return result;
}
/** Live payee details are optional; immutable reviewed payment evidence remains.
 * Pending/recoverable money and legal holds keep the minimum settlement data. */
export async function eraseOptionalSharingPayee(client:DbClient,memberId:string,cutoff:string){
 return client.query(`DELETE FROM sharing_payee p WHERE p.member_id=$1 AND p.updated_at<=$2::timestamptz
  AND NOT EXISTS(SELECT 1 FROM sharing_settlement_line l WHERE l.member_id=$1 AND l.state IN ('prepared','reviewed'))
  AND NOT EXISTS(SELECT 1 FROM commission_order_snapshot s LEFT JOIN LATERAL(
   SELECT COALESCE(sum(amount_cents) FILTER(WHERE kind IN ('accrual','refund_reversal')),0) AS net,
    COALESCE(sum(amount_cents) FILTER(WHERE kind='settlement'),0) AS paid FROM commission_ledger_entry e WHERE e.order_id=s.order_id
  ) e ON true WHERE s.referrer_member_id=$1 AND s.program='sharing_officer' AND (e.net>e.paid OR e.paid-e.net>
    COALESCE((SELECT sum(r.amount_cents) FROM sharing_recovery r WHERE r.order_id=s.order_id),0)))`,[memberId,cutoff]);
}

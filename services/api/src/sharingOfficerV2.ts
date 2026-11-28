import type pg from 'pg';
import {transaction,type DbClient} from './db.js';

export const sharingV2BasisPoints=3000;
const shanghaiOffset=8*3600_000;

export function sharingV2Period(at:Date){
 const local=new Date(at.getTime()+shanghaiOffset);
 if(local.getUTCDate()===31)local.setUTCMonth(local.getUTCMonth()+1,1);
 return local.toISOString().slice(0,7);
}

export function sharingV2Cutoff(period:string){
 const [year,month]=period.split('-').map(Number);
 const end=new Date(Date.UTC(year!,month!,0));
 return new Date(Date.UTC(year!,month!-1,Math.min(end.getUTCDate()+1,31))-shanghaiOffset);
}

export function sharingV2PaymentWindow(period:string){
 const [year,month]=period.split('-').map(Number);
 const next=new Date(Date.UTC(year!,month!,1)).toISOString().slice(0,7);
 return {start:next+'-10',end:next+'-15'};
}

export async function setSharingV2Intent(client:DbClient,buyer:string,officer:string){
 const pending=(await client.query(`SELECT id,officer_id,source FROM sharing_v2_referral_intent
  WHERE buyer_id=$1 AND state='pending' FOR UPDATE`,[buyer])).rows[0];
 if(pending?.officer_id===officer&&pending.source==='member_choice')return;
 // A historical link intent and a new confirmation have distinct evidence and order snapshots.
 if(pending)await client.query("UPDATE sharing_v2_referral_intent SET state='superseded' WHERE id=$1",[pending.id]);
 await client.query("INSERT INTO sharing_v2_referral_intent(buyer_id,officer_id,source) VALUES($1,$2,'member_choice')",[buyer,officer]);
}

export async function clearSharingV2Referrals(client:DbClient,officer:string){
 // The current projection is cleared. Immutable relation and order snapshots retain history.
 const removed=await client.query("DELETE FROM sharing_customer_relation WHERE officer_id=$1",[officer]);
 await client.query("UPDATE sharing_v2_referral_intent SET state='released' WHERE officer_id=$1 AND state='pending'",[officer]);
 return removed.rowCount??0;
}

export async function bindSharingV2ReleasedOrder(client:DbClient,orderId:string){
 const snapshot=(await client.query(`SELECT s.buyer_member_id,s.referrer_member_id,s.sharing_v2_intent_id,s.sharing_policy_id,s.sharing_v2_application_version
  FROM commission_order_snapshot s WHERE s.order_id=$1 AND s.sharing_v2_intent_id IS NOT NULL`,[orderId])).rows[0];
 if(!snapshot)return;
 const buyer=snapshot.buyer_member_id;
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sharing-relation:${buyer}`]);
 const intent=(await client.query(`SELECT i.*,o.state AS officer_state,o.v2_application_version,m.status,m2.status AS buyer_status,p.attribution_days
  FROM sharing_v2_referral_intent i JOIN sharing_officer o ON o.member_id=i.officer_id
  JOIN member m ON m.id=o.member_id JOIN member m2 ON m2.id=i.buyer_id
  JOIN sharing_policy p ON p.id=$2
  WHERE i.id=$1 FOR UPDATE OF i FOR SHARE OF o,m,m2`,[snapshot.sharing_v2_intent_id,snapshot.sharing_policy_id])).rows[0];
 // Previously created orders still release their locked commission. A link-only intent cannot establish a customer.
 if(intent?.state!=='pending'||intent.source!=='member_choice'
  ||intent.officer_state!=='active'||intent.status!=='active'||intent.buyer_status!=='active'||
  intent.v2_application_version!==snapshot.sharing_v2_application_version)return;
 const prior=(await client.query("SELECT officer_id FROM sharing_customer_relation WHERE buyer_id=$1 FOR UPDATE",[buyer])).rows[0];
 const version=(await client.query(`SELECT COALESCE(max(version),0)+1 AS version FROM sharing_relation_event WHERE buyer_id=$1`,[buyer])).rows[0].version;
 await client.query(`INSERT INTO sharing_relation_event(buyer_id,version,from_officer_id,to_officer_id,visit_id,source)
  VALUES($1,$2,$3,$4,$5,$6)`,[buyer,version,prior?.officer_id??null,intent.officer_id,intent.visit_id,intent.source]);
 await client.query(`INSERT INTO sharing_customer_relation(buyer_id,officer_id,visit_id,source,effective_at,expires_at,policy_id,version)
  VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+make_interval(days=>$7),$5,$6)
  ON CONFLICT(buyer_id) DO UPDATE SET officer_id=$2,visit_id=$3,source=$4,effective_at=excluded.effective_at,expires_at=excluded.expires_at,policy_id=$5,version=$6,removed_at=NULL`,
 [buyer,intent.officer_id,intent.visit_id,intent.source,snapshot.sharing_policy_id,version,intent.v2_application_version?null:intent.attribution_days]);
 await client.query("UPDATE sharing_v2_referral_intent SET state='bound' WHERE id=$1",[intent.id]);
}

export async function assessSharingV2Performance(pool:pg.Pool,limit=25,asOf?:Date){
 return transaction(pool,async client=>{
  const now=asOf??(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at;
  const [year,month]=sharingV2Period(now).split('-').map(Number);
  const periods=[3,2,1].map(offset=>new Date(Date.UTC(year!,month!-1-offset,1)).toISOString().slice(0,7));
  const through=periods[2]!;
  const selected=(await client.query(`SELECT o.member_id,o.version,o.v2_application_version
   FROM sharing_officer o
   WHERE o.state='active' AND sharing_v2_approval_at(o.member_id,o.v2_application_version) < $2
     AND NOT EXISTS(SELECT 1 FROM sharing_v2_assessment r WHERE r.member_id=o.member_id AND r.application_version=o.v2_application_version AND r.through_period=$1)
   ORDER BY o.member_id LIMIT $3 FOR UPDATE OF o SKIP LOCKED`,[through,sharingV2Cutoff(periods[0]!),limit])).rows;
  let terminated=0;
  for(const officer of selected){
   const firstMonth=periods[0]!;
   const [firstYear,firstMonthNumber]=firstMonth.split('-').map(Number);
   const previousMonth=new Date(Date.UTC(firstYear!,firstMonthNumber!-2,1)).toISOString().slice(0,7);
   const releases=(await client.query<{occurred_at:Date}>(`SELECT l.occurred_at FROM commission_ledger_entry l
     JOIN commission_order_snapshot s ON s.order_id=l.order_id
     JOIN commerce_order o ON o.id=s.order_id
     WHERE l.kind='release' AND s.referrer_member_id=$1 AND s.sharing_v2_application_version=$2
       AND l.occurred_at >= $3 AND l.occurred_at < $4 AND o.status='paid'
       AND NOT EXISTS(SELECT 1 FROM commission_refund_intent r WHERE r.order_id=s.order_id AND r.state='succeeded')
       AND COALESCE((SELECT sum(amount_cents) FROM commission_ledger_entry n WHERE n.order_id=s.order_id AND n.kind IN ('accrual','refund_reversal')),0)>0`,
    [officer.member_id,officer.v2_application_version,sharingV2Cutoff(previousMonth),sharingV2Cutoff(through)])).rows;
   const counts=periods.map(period=>releases.filter(row=>sharingV2Period(row.occurred_at)===period).length);
   const zero=counts.every(count=>count===0);
   await client.query(`INSERT INTO sharing_v2_assessment(member_id,application_version,through_period,valid_order_counts,terminated)
    VALUES($1,$2,$3,$4,$5)`,[officer.member_id,officer.v2_application_version,through,counts,zero]);
   if(!zero)continue;
   const reason='连续三个月有效推荐业绩为零';
   const row=(await client.query(`UPDATE sharing_officer SET state='terminated',review_reason=$2,version=version+1,
    updated_at=clock_timestamp() WHERE member_id=$1 RETURNING version`,[officer.member_id,reason])).rows[0];
   const cleared=await clearSharingV2Referrals(client,officer.member_id);
   await client.query(`INSERT INTO sharing_officer_event(member_id,version,from_state,to_state,actor_id,reason,system_assessment)
    VALUES($1,$2,'active','terminated',NULL,$3,true)`,[officer.member_id,row.version,reason]);
   await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
    VALUES('worker:sharing-v2-performance','sharing.monthly_eligibility','sharing_officer',$1,$2,$3)`,
   [officer.member_id,{applicationVersion:officer.v2_application_version,periods,counts,cleared},`sharing-v2:${through}:${officer.member_id}`]);
   terminated++;
  }
  return terminated;
 },'SERIALIZABLE');
}

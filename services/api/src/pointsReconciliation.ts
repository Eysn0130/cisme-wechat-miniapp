import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {transaction} from './db.js';
import {lockPointWallet} from './pointsLedger.js';
/** Observe discrepancies; never overwrite assets or manufacture balancing entries. */
export async function reconcilePointWallets(pool:pg.Pool,now=new Date(),limit=30){
 const members=(await pool.query<{member_id:string}>(`SELECT p.member_id FROM points_projection p LEFT JOIN member_points_wallet_check c ON c.member_id=p.member_id
  WHERE c.member_id IS NULL OR c.projection_version<>p.version OR c.checked_at<=$1::timestamptz-interval '24 hours' ORDER BY c.checked_at NULLS FIRST,p.member_id LIMIT $2`,[now,limit])).rows;
 let mismatches=0;
 for(const {member_id:owner} of members)await transaction(pool,async c=>{
  const projection=await lockPointWallet(c,owner);
  const entries=(await c.query(`SELECT COALESCE(sum(available_delta),0)::text available,COALESCE(sum(frozen_delta),0)::text frozen,COALESCE(sum(debt_delta),0)::text debt,COALESCE(sum(reserved_delta),0)::text reserved FROM points_entry WHERE member_id=$1`,[owner])).rows[0];
  const lots=(await c.query(`SELECT COALESCE(sum(l.available_amount),0)::text available,COALESCE(sum(l.frozen_amount),0)::text frozen,COALESCE(sum(l.reserved_amount),0)::text reserved FROM points_lot l JOIN points_grant g ON g.id=l.grant_id WHERE g.member_id=$1`,[owner])).rows[0];
  const orders=Number((await c.query(`SELECT count(*)::text n FROM commerce_order o WHERE o.member_id=$1 AND o.points_spent>0 AND (
   o.points_spent<>(SELECT COALESCE(sum(a.amount),0) FROM member_points_allocation a WHERE a.order_id=o.id) OR EXISTS(SELECT 1 FROM member_points_allocation a WHERE a.order_id=o.id AND a.state<>CASE WHEN o.status='paid' THEN 'spent' WHEN o.status='pending_payment' THEN 'reserved' ELSE 'released' END))`,[owner])).rows[0].n);
  const gifts=Number((await c.query(`SELECT count(*)::text n FROM member_points_redemption r WHERE r.member_id=$1 AND (
   r.points_cost<>(SELECT COALESCE(sum(a.amount),0) FROM member_points_gift_allocation a WHERE a.redemption_id=r.id) OR EXISTS(SELECT 1 FROM member_points_gift_allocation a WHERE a.redemption_id=r.id AND a.returned<>(r.state IN ('cancelled','returned'))))`,[owner])).rows[0].n);
  const balanced=['available','frozen','reserved','debt'].every(k=>Number(entries[k])===projection[k as keyof typeof projection])&&['available','frozen','reserved'].every(k=>Number(lots[k])===projection[k as keyof typeof projection])&&!(projection.debt>0&&projection.available>0)&&orders===0&&gifts===0;
  const detail={projection,entries,lots,orderDiscrepancies:orders,redemptionDiscrepancies:gifts},status=balanced?'balanced':'mismatch';
  const previous=(await c.query('SELECT status,projection_version FROM member_points_wallet_check WHERE member_id=$1',[owner])).rows[0];
  await c.query(`INSERT INTO member_points_wallet_check(member_id,projection_version,status,detail,checked_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(member_id) DO UPDATE SET projection_version=$2,status=$3,detail=$4,checked_at=$5`,[owner,projection.version,status,detail,now]);
  if(!balanced){mismatches++;if(previous?.status!=='mismatch'||previous?.projection_version!==projection.version)await c.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id) VALUES('worker:member-points','points.wallet.reconciliation_failed','member',$1,'POINTS_LEDGER_DRIFT','{}',$2,$3)`,[owner,detail,randomUUID()]);}
 });
 return {checked:members.length,mismatches};
}

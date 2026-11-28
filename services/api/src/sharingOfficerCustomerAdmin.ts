import {randomUUID} from 'node:crypto';
import type {DbClient} from './db.js';
import {finishPage,readPageCursor,pageScope} from './keysetPage.js';
import {sharingFail as fail,sharingId as id,sharingInt as int,sharingText as text} from './sharingOfficerPolicy.js';

export async function sharingAdminCustomers(client:DbClient,actor:string,officer:string,filter:string,limit:number,cursorInput:unknown){
 if(!['retained','removed','pending'].includes(filter))fail('SHARING_FILTER_INVALID','分类无效',422);
 const key=pageScope(['sharing-admin-customers',actor,officer,filter]),cursor=readPageCursor(cursorInput,key);
 const account=(await client.query(`SELECT o.state,o.version FROM sharing_officer o JOIN member m ON m.id=o.member_id
  WHERE o.member_id=$1 AND m.status='active' AND o.state IN ('active','suspended')`,[officer])).rows[0];
 if(!account)fail('SHARING_CUSTOMER_OFFICER_UNAVAILABLE','当前资格不可管理推荐归属',409);
 const source=filter==='pending' ? `SELECT i.buyer_id AS id,m.display_name AS "displayName",n.user_code AS "userCode",
   i.created_at AS at,i.created_at::text AS cursor_at,true AS pending
  FROM sharing_v2_referral_intent i JOIN member m ON m.id=i.buyer_id LEFT JOIN member_card_number n ON n.member_id=m.id
  WHERE i.officer_id=$1 AND i.state='pending' AND i.source='member_choice'
    AND m.status='active' AND m.registration_completed_at IS NOT NULL`
  : `SELECT r.buyer_id AS id,m.display_name AS "displayName",n.user_code AS "userCode",
   r.version,r.control_version AS "controlVersion",r.effective_at AS "effectiveAt",r.expires_at AS "expiresAt",r.removed_at AS "removedAt",
   r.effective_at AS at,r.effective_at::text AS cursor_at,
   COALESCE(r.expires_at<=clock_timestamp(),false) AS "expired",
   NOT EXISTS(SELECT 1 FROM sharing_v2_referral_intent i WHERE i.buyer_id=r.buyer_id AND i.state='pending'
     AND i.source='member_choice' AND i.officer_id<>r.officer_id) AS "restorable"
  FROM sharing_customer_relation r JOIN member m ON m.id=r.buyer_id LEFT JOIN member_card_number n ON n.member_id=m.id
  WHERE r.officer_id=$1 AND m.status='active' AND m.registration_completed_at IS NOT NULL
    AND ${filter==='removed' ? 'r.removed_at IS NOT NULL'
      : 'r.removed_at IS NULL AND r.effective_at<=clock_timestamp() AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp())'}`;
 const rows=(await client.query(`SELECT * FROM (${source}) customers
  WHERE ($2::timestamptz IS NULL OR (at,id)<($2,$3::uuid))
  ORDER BY at DESC,id DESC LIMIT $4`,[officer,cursor?.at??null,cursor?.id??null,limit+1])).rows;
 const page=finishPage(rows.map(r=>({...r,id:String(r.id),cursorAt:String(r.cursor_at)})),limit,key);
 return {...page,officerState:account.state,officerVersion:account.version,items:page.items.map(({at:_,cursor_at:__,cursorAt:___,...r})=>r)};
}

export async function changeSharingCustomer(client:DbClient,actor:string,input:Record<string,unknown>){
 const officer=id(input.memberId).toLowerCase(),buyer=id(input.buyerId).toLowerCase(),reason=text(input.reason,'调整依据',2);
 const version=int(input.expectedVersion,'推荐关系版本',1,2_000_000_000);
 const controlVersion=int(input.expectedControlVersion,'管理版本',1,2_000_000_000);
 const officerVersion=int(input.expectedOfficerVersion,'分享官版本',1,2_000_000_000);
 if(input.confirmed!==true||typeof input.remove!=='boolean')fail('SHARING_CUSTOMER_CONFIRM_REQUIRED','请再次确认推荐归属调整',422);
 if(actor===buyer||actor===officer)fail('SHARING_SELF_REVIEW_FORBIDDEN','不能在管理中心调整本人的推荐归属',403);
 const remove=input.remove;
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sharing-relation:${buyer}`]);
 const account=(await client.query(`SELECT o.state,o.version FROM sharing_officer o JOIN member m ON m.id=o.member_id
  WHERE o.member_id=$1 AND m.status='active' FOR SHARE OF o,m`,[officer])).rows[0];
 if(!account||account.version!==officerVersion||!['active','suspended'].includes(account.state))fail('VERSION_CONFLICT','分享官资格已变化，请重新加载');
 const prior=(await client.query(`SELECT r.version,r.control_version,r.removed_at,r.expires_at,
  (r.expires_at IS NULL OR r.expires_at>clock_timestamp()) AS eligible FROM sharing_customer_relation r
  JOIN member m ON m.id=r.buyer_id WHERE r.buyer_id=$1 AND r.officer_id=$2 AND m.status='active'
    AND m.registration_completed_at IS NOT NULL FOR UPDATE OF r FOR SHARE OF m`,[buyer,officer])).rows[0];
 if(!prior||prior.version!==version||prior.control_version!==controlVersion||Boolean(prior.removed_at)===remove)
  fail('VERSION_CONFLICT','推荐归属已变化，请重新加载');
 if(!prior.eligible)fail('SHARING_CUSTOMER_EXPIRED','这条推荐归属已经到期');
 if(!remove&&(await client.query(`SELECT 1 FROM sharing_v2_referral_intent
   WHERE buyer_id=$1 AND officer_id<>$2 AND state='pending' AND source='member_choice'`,[buyer,officer])).rowCount)
  fail('SHARING_CUSTOMER_REPLACEMENT_PENDING','会员已选择新的推荐人，当前归属不能恢复');
 const updated=(await client.query(`UPDATE sharing_customer_relation SET removed_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
   control_version=control_version+1 WHERE buyer_id=$1 RETURNING control_version,removed_at`,[buyer,remove])).rows[0];
 if(remove)await client.query(`UPDATE sharing_v2_referral_intent SET state='released'
  WHERE buyer_id=$1 AND state='pending' AND (officer_id=$2 OR source='first_touch')`,[buyer,officer]);
 await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
  VALUES($1,$2,'member',$3,'SHARING_CUSTOMER_CONTROL',$4,$5,$6)`,
  [`member:${actor}`,remove?'sharing.customer.remove':'sharing.customer.restore',buyer,
   {officerId:officer,version,controlVersion,removedAt:prior.removed_at},
   {officerId:officer,version,controlVersion:updated.control_version,removedAt:updated.removed_at,reason},randomUUID()]);
 return {removed:remove,controlVersion:updated.control_version};
}

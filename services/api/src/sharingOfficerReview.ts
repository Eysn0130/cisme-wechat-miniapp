import {randomUUID} from 'node:crypto';
import type {AppEnvironment} from '@cisme/config';
import type {DbClient} from './db.js';
import {memberAdminCardNumber,memberAdminCommerce,memberAdminPoints} from './memberAdministration.js';
import {userProjectionSql} from './memberAdministrationSql.js';
import {userNumber} from './memberAdministrationPolicy.js';
import {memberDisplayIdentities} from './displayIdentity.js';
import {officerView,sharingQualification} from './sharingOfficer.js';
import {sharingFail as fail} from './sharingOfficerPolicy.js';
import {finishPage,type PageCursor} from './keysetPage.js';

type ReviewScope={profile:boolean;points:boolean;orders:boolean;commission:boolean};
type Row=Record<string,any>;

const reviewRows=`SELECT o.*,o.member_id AS id,m.display_name,m.status AS member_status,
  COALESCE(agreement.accepted_at,submission.occurred_at,CASE WHEN o.version=1 THEN o.created_at END) AS application_at,
  decision.occurred_at AS reviewed_at,decision.to_state AS reviewed_state,decision.reason AS decision_reason,
  reviewer.display_name AS reviewer_name,agreement.accepted_at,agreement.verified_at,
  CASE WHEN agreement.verification_reference IS NOT NULL THEN '•••'||right(agreement.verification_reference,3) END AS verification_mask,
  EXISTS(SELECT 1 FROM sharing_payee p WHERE p.member_id=o.member_id) AS payee_ready
 FROM sharing_officer o JOIN member m ON m.id=o.member_id
 LEFT JOIN sharing_v2_application agreement ON agreement.member_id=o.member_id AND agreement.application_version=o.v2_application_version
 LEFT JOIN LATERAL(SELECT e.version,e.occurred_at FROM sharing_officer_event e
  WHERE e.member_id=o.member_id AND e.to_state='pending' ORDER BY e.version DESC LIMIT 1) submission ON true
 LEFT JOIN LATERAL(SELECT e.to_state,e.occurred_at,e.actor_id,e.reason FROM sharing_officer_event e
  WHERE e.member_id=o.member_id AND e.from_state='pending' AND e.to_state IN ('active','rejected')
   AND e.version>GREATEST(COALESCE(submission.version,0),COALESCE(o.v2_application_version,0))
  ORDER BY e.version DESC LIMIT 1) decision ON true
 LEFT JOIN member reviewer ON reviewer.id=decision.actor_id`;

async function projections(client:DbClient,ids:string[],scope:ReviewScope,environment:AppEnvironment){
 if(!scope.profile||!ids.length)return new Map<string,Row>();
 const base=userProjectionSql({points:scope.points,orders:scope.orders,care:false,rewards:false,sharing:false,support:false},
  !['test','development'].includes(environment),environment);
 const {rows}=await client.query(`WITH u AS (${base}) SELECT * FROM u WHERE id=ANY($2::uuid[])`,[new Date(),ids]);
 return new Map(rows.map(r=>[String(r.id),r]));
}

export async function sharingMemberCards(client:DbClient,ids:string[],scope:Pick<ReviewScope,'profile'|'points'>,environment:AppEnvironment){
 const members=await projections(client,ids,{...scope,orders:false,commission:false},environment);
 const identities=await memberDisplayIdentities(client,environment,[...members.keys()]);
 return new Map([...members].map(([id,member])=>[id,{
  cardNumber:memberAdminCardNumber(member.card_number),
  avatar:member.avatar_data_url??null,avatarRevision:member.avatar_revision??null,displayIdentity:identities.get(id)?.privateIdentity??null,
  ...(scope.points?{availablePoints:memberAdminPoints(member).available}:{})
 }]));
}

function reviewView(row:Row){
 return {...officerView(row),id:row.id,memberId:row.member_id,displayName:row.display_name,payeeReady:row.payee_ready,
  applicationAt:row.application_at??null,reviewedAt:row.reviewed_at??null};
}

export async function sharingReviewQueue(client:DbClient,filter:string,target:string|null,cursor:PageCursor|null,limit:number,key:string,scope:ReviewScope,environment:AppEnvironment){
 if(!['all','pending','reviewed','active','rejected','suspended','terminated'].includes(filter))fail('SHARING_FILTER_INVALID','分类无效',422);
 // The sentinel is private to the cursor. Legacy rows without a corresponding
 // event stay visible in the undated group rather than acquiring a fake date.
 const {rows}=await client.query(`WITH review_rows AS (${reviewRows}
  WHERE ($1='all' OR o.state=$1 OR ($1='reviewed' AND o.state IN ('active','rejected','suspended','terminated')))
   AND ($5::uuid IS NULL OR o.member_id=$5)), ordered AS (
   SELECT r.*,COALESCE(CASE WHEN state='pending' THEN application_at ELSE reviewed_at END,'0001-01-01 00:00:00+00'::timestamptz) AS list_at FROM review_rows r
  ) SELECT *,list_at::text AS cursor_at FROM ordered WHERE ($2::timestamptz IS NULL OR (list_at,id)<($2,$3::uuid))
  ORDER BY list_at DESC,id DESC LIMIT $4`,[filter,cursor?.at??null,cursor?.id??null,limit+1,target]);
 const page=finishPage(rows.map(r=>({...r,id:String(r.id),cursorAt:String(r.cursor_at)})),limit,key);
 const cards=await sharingMemberCards(client,page.items.map(row=>row.id),scope,environment);
 return {...page,items:page.items.map(row=>({...reviewView(row),...cards.get(row.id)}))};
}

export async function sharingReviewDetail(client:DbClient,actor:string,target:string,expectedVersion:number,scope:ReviewScope,environment:AppEnvironment){
 const row=(await client.query(`${reviewRows} WHERE o.member_id=$1`,[target])).rows[0];
 if(!row)fail('SHARING_OFFICER_NOT_FOUND','分享官申请不存在',404);
 if(row.version!==expectedVersion)fail('VERSION_CONFLICT','申请已更新，请重新加载',409);
 const member=(await projections(client,[target],scope,environment)).get(target);
 const qualification=row.state==='pending'?await sharingQualification(client,target):null;
 const review=row.reviewed_at?{occurredAt:row.reviewed_at,result:row.reviewed_state,reviewer:row.reviewer_name??null,reason:row.decision_reason}:null;
 const agreement=row.accepted_at?{acceptedAt:row.accepted_at,version:'V2.0',verifiedAt:row.verified_at??null,reference:row.verification_mask??null}:null;
 const history=(await client.query(`SELECT e.version,e.occurred_at AS "occurredAt",e.to_state AS result,m.display_name AS reviewer,e.reason
  FROM sharing_officer_event e LEFT JOIN member m ON m.id=e.actor_id
  WHERE e.member_id=$1 AND e.from_state='pending' AND e.to_state IN ('active','rejected')
    AND ($2::timestamptz IS NULL OR e.occurred_at<$2) ORDER BY e.version DESC LIMIT 5`,[target,row.reviewed_at??null])).rows;
 const commerce=member&&scope.orders?memberAdminCommerce(member):null;
 const orders=commerce?(await client.query(`SELECT o.id,p.paid_at AS "paidAt",p.paid_cents AS "paidCents",
   COALESCE(r.refunded,0) AS "refundedCents",l.title
  FROM commerce_order o JOIN LATERAL(SELECT max(i.verified_paid_at) AS paid_at,sum(i.amount_cents) AS paid_cents
   FROM commission_payment_inbox i WHERE i.order_id=o.id AND i.state='applied')p ON p.paid_at IS NOT NULL
  LEFT JOIN LATERAL(SELECT sum(i.refund_cents) AS refunded FROM commission_refund_intent i WHERE i.order_id=o.id AND i.state='succeeded')r ON true
  LEFT JOIN LATERAL(SELECT string_agg(orline.product_name,' · ' ORDER BY orline.line_number) AS title FROM commerce_order_line orline WHERE orline.order_id=o.id)l ON true
  WHERE o.member_id=$1 AND o.transaction_source_kind='verified_commerce' ORDER BY p.paid_at DESC,o.id DESC LIMIT 5`,[target])).rows.map(order=>({...order,paidCents:userNumber(order.paidCents),refundedCents:userNumber(order.refundedCents)})):[];
 const posts=member?(await client.query(`SELECT p.id,p.published_at AS "publishedAt",r.title FROM ugc_post p
  JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.published_revision WHERE p.author_member_id=$1 AND p.state='published' AND p.visibility='public'
  ORDER BY p.published_at DESC,p.id DESC LIMIT 5`,[target])).rows:[];
 const referrals=member?(await client.query(`SELECT
  (SELECT count(*)::int FROM member_points_referral r JOIN member m ON m.id=r.member_id
    WHERE r.referrer_member_id=$1 AND m.registration_completed_at IS NOT NULL AND m.status<>'deleted') AS "invitedRegistrations",
  (SELECT count(*)::int FROM sharing_customer_relation r JOIN member m ON m.id=r.buyer_id
    WHERE r.officer_id=$1 AND m.status='active' AND m.registration_completed_at IS NOT NULL AND r.removed_at IS NULL
      AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp())) AS "attributedMembers",
  CASE WHEN $2 THEN (SELECT count(*)::int FROM commission_order_snapshot s WHERE s.referrer_member_id=$1 AND s.program='sharing_officer'
    AND EXISTS(SELECT 1 FROM commission_payment_inbox p WHERE p.order_id=s.order_id AND p.state='applied')) END AS "verifiedPaidOrders"`,[target,scope.commission])).rows[0]:null;
 await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
  VALUES($1,'sharing.admin.review.read','member',$2,'SHARING_APPLICATION_REVIEW',$3,$4)`,[`member:${actor}`,target,{version:row.version,...scope},randomUUID()]);
 return {officer:reviewView(row),accountState:row.member_status,qualification,review,agreement,history,
  member:member?{registeredAt:member.created_at,publicPosts:Number(member.post_count),posts,commerce:commerce?{...commerce,orders}:null,referrals}:null};
}

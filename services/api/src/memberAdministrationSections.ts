import type {Capability} from '@cisme/contracts';
import type {DbClient} from './db.js';
import type {MemberAdministration} from './memberAdministration.js';
import {userSections,userFail,userNumber,type UserScope} from './memberAdministrationPolicy.js';
import {pageLimit,pageScope,readPageCursor,finishPage} from './keysetPage.js';
import {openPointsNote} from './memberPointsClub.js';
import {careDayRewards} from './careUsageRewards.js';
import {sharingOrderProjection,sharingOrderView,officerView,officerPolicyView,currentSharingPolicySql} from './sharingOfficer.js';
import {commissionOrderBuckets} from './commissionPolicy.js';
type Row=Record<string,any>;
const names:Record<string,string>={net_run:'净润洗发水',net_xie:'净屑洗发水',essence:'护理精华'};
function required(value:boolean){if(!value)userFail('CAPABILITY_REQUIRED','当前账号没有此分类的查看权限',403);}
export async function memberAdministrationSection(service:MemberAdministration,c:DbClient,actor:string,target:string,section:string,input:Row,scope:UserScope,caps:Capability[]){
 if(!userSections.includes(section as any))userFail('USER_SECTION_INVALID','资料分类无效');
 if(section==='profile')return {section,data:await service.profile(c,target,scope)};
 const permission:Record<string,boolean>={addresses:scope.contact,care:scope.care,points:scope.points,vouchers:scope.rewards||scope.points,orders:scope.orders,aftersales:scope.orders,sharing:scope.sharing,'sharing-orders':scope.commission,settlements:scope.commission,posts:true,comments:true,support:scope.support,privacy:scope.privacy,logs:true};required(permission[section]===true);
 if(section==='addresses'){
  const rows=(await c.query('SELECT id,label,is_default,created_at,updated_at FROM member_delivery_address WHERE member_id=$1 AND deleted_at IS NULL ORDER BY is_default DESC,updated_at DESC,id',[target])).rows;
  return {section,items:rows.map(r=>({id:r.id,kind:'address',title:({home:'家庭地址',company:'公司地址',other:'其他地址'} as Row)[r.label],isDefault:r.is_default,occurredAt:r.updated_at,source:{kind:'address',id:r.id}})),nextCursor:null};
 }
 if(section==='sharing'){
  const officer=(await c.query('SELECT * FROM sharing_officer WHERE member_id=$1',[target])).rows[0],policy=(await c.query(currentSharingPolicySql)).rows[0];
  const relation=(await c.query(`SELECT r.source,r.version,r.effective_at,r.expires_at,o.referral_code,o.state FROM sharing_customer_relation r
   JOIN sharing_officer o ON o.member_id=r.officer_id WHERE r.buyer_id=$1 AND (r.expires_at IS NULL OR r.expires_at>now())`,[target])).rows[0];
  const orders=scope.commission?(await c.query(`${sharingOrderProjection} WHERE s.program='sharing_officer' AND s.referrer_member_id=$1`,[target])).rows:[];
  const buckets=commissionOrderBuckets(orders.map(r=>({accruedCents:userNumber(r.accrued),reversedCents:userNumber(r.reversed),releasedCents:userNumber(r.released),paidCents:userNumber(r.paid),heldCents:userNumber(r.held)})));
  const paid=scope.commission?(await c.query("SELECT COALESCE(sum(tax_cents),0)::text AS tax,COALESCE(sum(net_cents),0)::text AS net FROM sharing_settlement_line WHERE member_id=$1 AND state='paid'",[target])).rows[0]:{tax:0,net:0};
  const outstanding=orders.map(sharingOrderView).reduce((n,r)=>userNumber(n+r.outstandingRecoveryCents),0);
  return {section,data:{officer:officerView(officer),policy:officerPolicyView(policy),relation:relation??null,orderCount:scope.commission?orders.length:null,commission:scope.commission?{...buckets,outstandingRecoveryCents:outstanding,taxCents:userNumber(paid.tax),netCents:userNumber(paid.net)}:null,canManage:scope.manage,canFinance:scope.finance}};
 }
 const limit=pageLimit(input.limit),key=pageScope(['member-admin-section',actor,target,section,scope,input.day??null]),cursor=readPageCursor(input.cursor,key);
 const args:unknown[]=[target,cursor?.at??null,cursor?.id??null,limit+1];let sql='',map:(r:Row)=>Row=(r)=>r;
 const bound="($2::timestamptz IS NULL OR (x.at,x.id)<($2,$3::uuid))";
 if(section==='sharing-orders'){
  sql=`SELECT x.*,x.created_at::text AS cursor_at FROM(${sharingOrderProjection} WHERE s.program='sharing_officer' AND s.referrer_member_id=$1)x WHERE ($2::timestamptz IS NULL OR (x.created_at,x.order_id)<($2,$3::uuid)) ORDER BY x.created_at DESC,x.order_id DESC LIMIT $4`;
  const rows=(await c.query(sql,args)).rows.map(r=>({...r,id:r.order_id,cursorAt:r.cursor_at}));const page=finishPage(rows,limit,key);
  return {section,items:page.items.map(r=>({kind:'sharing_order',...sharingOrderView(r),title:r.product_name,number:r.order_number,occurredAt:r.created_at,source:scope.orders?{kind:'order',id:r.order_id}:null})),nextCursor:page.nextCursor,hasMore:page.hasMore};
 }
 if(section==='care'){
  const day=input.day==null?null:String(input.day);if(day!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day))userFail('CARE_USAGE_PAGE_INVALID','护理日期无效');args.push(day);
  sql=`SELECT x.* FROM(SELECT k.*,k.created_at AS at,k.created_at::text AS cursor_at,k.care_day::text AS day FROM member_points_checkin k WHERE k.member_id=$1 AND ($5::date IS NULL OR k.care_day=$5))x WHERE ${bound} ORDER BY x.at DESC,x.id DESC LIMIT $4`;
  map=r=>({id:r.id,kind:'care',occurredAt:r.created_at,day:r.day,title:r.products.map((p:string)=>names[p]??p).join(' · '),products:r.products,note:openPointsNote(service.config,{id:r.id,member_id:r.member_id,note_encrypted:r.note_encrypted,key_version:r.key_version}),version:r.version,updatedAt:r.updated_at});
 }else if(section==='points'){
  sql=`SELECT x.* FROM(SELECT e.id,e.occurred_at AS at,e.occurred_at::text AS cursor_at,e.entry_type,e.available_delta,e.frozen_delta,e.reserved_delta,e.debt_delta,e.used_delta,e.expired_delta,
   t.reason,t.rule_version,g.source_type,g.source_id,g.component,g.expires_at,
   (SELECT o.id FROM commerce_order o WHERE o.member_id=$1 AND o.id::text=COALESCE(e.metadata->>'orderId',CASE WHEN g.source_type IN ('shopping','first_order') THEN g.source_id END)) AS order_id
   FROM points_entry e LEFT JOIN points_transaction t ON t.id=e.transaction_id LEFT JOIN points_grant g ON g.id=e.grant_id WHERE e.member_id=$1)x
   WHERE ${bound} ORDER BY x.at DESC,x.id DESC LIMIT $4`;
  map=r=>({id:r.id,kind:'points',title:r.reason||r.entry_type,state:r.entry_type,occurredAt:r.at,ruleVersion:r.rule_version,component:r.component,expiresAt:r.expires_at,
   changes:{available:userNumber(r.available_delta),frozen:userNumber(r.frozen_delta),reserved:userNumber(r.reserved_delta),debt:userNumber(r.debt_delta),used:userNumber(r.used_delta),expired:userNumber(r.expired_delta)},
   source:r.order_id&&scope.orders?{kind:'order',id:r.order_id}:r.source_type==='questionnaire'?{kind:'profile'}:['care_day','care_streak'].includes(r.source_type)&&/^\d{4}-\d{2}-\d{2}$/.test(r.source_id)&&scope.care?{kind:'care',day:r.source_id}:null});
 }else if(section==='vouchers'){
  sql=`SELECT x.* FROM(
   SELECT v.id,'travel_voucher'::text AS kind,a.title,v.issued_at AS at,v.issued_at::text AS cursor_at,CASE WHEN v.state='unused' AND v.expires_at<=now() THEN 'expired' ELSE v.state END AS state,v.expires_at,0::bigint AS amount,0::bigint AS threshold,v.claim_id AS linked_id,NULL::text AS number,NULL::jsonb AS detail
   FROM reward_voucher v JOIN reward_activity a ON a.id=v.activity_id WHERE ${scope.rewards?'true':'false'} AND v.member_id=$1
   UNION ALL SELECT p.id,'purchase_coupon','满198减20正装券',p.issued_at,p.issued_at::text,CASE WHEN p.state='available' AND p.expires_at<=now() THEN 'expired' ELSE p.state END,p.expires_at,p.discount_cents,p.threshold_cents,p.order_id,NULL,NULL
   FROM member_purchase_coupon p WHERE ${scope.rewards?'true':'false'} AND p.member_id=$1
   UNION ALL SELECT r.id,'points_gift',COALESCE(r.item_snapshot->>'name',r.item_snapshot->>'productName','积分兑换'),r.created_at,r.created_at::text,r.state,NULL,r.points_cost,0,r.id,NULL,jsonb_build_object('quantity',r.quantity)
   FROM member_points_redemption r WHERE ${scope.points?'true':'false'} AND r.member_id=$1
   UNION ALL SELECT a.id,'travel_claim',COALESCE(a.item_snapshot->>'name','旅行洗护套'),a.created_at,a.created_at::text,a.state,NULL,0,0,a.id,a.claim_number,jsonb_build_object('bundle',a.bundle_code)
   FROM activity_reward_claim a WHERE ${scope.rewards?'true':'false'} AND a.member_id=$1)x WHERE ${bound} ORDER BY x.at DESC,x.id DESC LIMIT $4`;
  map=r=>({id:r.id,kind:r.kind,title:r.title,state:r.state,occurredAt:r.at,expiresAt:r.expires_at,amount:userNumber(r.amount),threshold:userNumber(r.threshold),number:r.number,detail:r.detail,
   source:r.kind==='purchase_coupon'&&r.linked_id&&scope.orders?{kind:'order',id:r.linked_id}:r.kind==='travel_claim'&&caps.includes('commerce.fulfillment.manage')?{kind:'reward_claim',id:r.id}:r.kind==='travel_voucher'&&scope.manage&&caps.includes('commerce.product.manage')?{kind:'reward_voucher',id:r.id}:r.kind==='points_gift'&&caps.includes('commerce.fulfillment.manage')?{kind:'points_gift',id:r.id}:null});
 }else if(section==='orders'){
  sql=`SELECT x.* FROM(SELECT o.id,o.created_at AS at,o.created_at::text AS cursor_at,o.order_number,o.status,o.total_cents,o.points_spent,CASE WHEN o.points_spent>0 THEN GREATEST(0,o.member_discount_cents-o.coupon_discount_cents) ELSE 0 END AS points_discount_cents,o.coupon_discount_cents,
   (SELECT sum(pay.amount_cents) FROM commission_payment_inbox pay WHERE pay.order_id=o.id AND pay.state='applied') AS paid,
   (SELECT sum(ri.refund_cents) FROM commission_refund_intent ri WHERE ri.order_id=o.id AND ri.state='succeeded') AS refunded,
   (SELECT string_agg(l.product_name,' · ' ORDER BY l.line_number) FROM commerce_order_line l WHERE l.order_id=o.id) AS title,
   ship.shipped_at,ship.receipt_confirmed_at FROM commerce_order o LEFT JOIN commerce_shipment ship ON ship.order_id=o.id
   WHERE o.member_id=$1 AND o.transaction_source_kind='verified_commerce')x WHERE ${bound} ORDER BY x.at DESC,x.id DESC LIMIT $4`;
  map=r=>({id:r.id,kind:'order',title:r.title||'商品订单',number:r.order_number,occurredAt:r.at,state:r.refunded&&userNumber(r.refunded)>=userNumber(r.total_cents)?'refunded':r.status==='paid'?r.receipt_confirmed_at?'received':r.shipped_at?'shipped':'awaiting_dispatch':r.status,
   amountCents:userNumber(r.total_cents),paidCents:userNumber(r.paid),refundedCents:userNumber(r.refunded),pointsSpent:userNumber(r.points_spent),pointsDiscountCents:userNumber(r.points_discount_cents),couponDiscountCents:userNumber(r.coupon_discount_cents),source:{kind:'order',id:r.id}});
 }else if(section==='aftersales'){
  sql=`SELECT x.* FROM(SELECT a.id,a.created_at AS at,a.created_at::text AS cursor_at,a.order_id,a.kind,a.state,a.amount_cents,a.reason,o.order_number FROM commerce_aftersale_case a JOIN commerce_order o ON o.id=a.order_id WHERE a.member_id=$1)x WHERE ${bound} ORDER BY x.at DESC,x.id DESC LIMIT $4`;
  map=r=>({id:r.id,kind:'aftersale',title:r.kind==='return_refund'?'退货退款':'退款',number:r.order_number,state:r.state,occurredAt:r.at,amountCents:userNumber(r.amount_cents),body:r.reason,source:{kind:'order',id:r.order_id}});
 }else if(section==='settlements'){
  sql=`SELECT x.* FROM(SELECT l.id,l.created_at AS at,l.created_at::text AS cursor_at,l.batch_id,b.period,l.state,l.gross_cents,l.tax_cents,l.net_cents,l.paid_at,l.payment_reference FROM sharing_settlement_line l JOIN sharing_settlement_batch b ON b.id=l.batch_id WHERE l.member_id=$1)x WHERE ${bound} ORDER BY x.at DESC,x.id DESC LIMIT $4`;
  map=r=>({id:r.id,kind:'settlement',title:r.period+' 月结',state:r.state,occurredAt:r.at,grossCents:userNumber(r.gross_cents),taxCents:r.tax_cents===null?null:userNumber(r.tax_cents),netCents:r.net_cents===null?null:userNumber(r.net_cents),paidAt:r.paid_at,paymentReference:scope.finance?r.payment_reference:undefined,source:scope.finance?{kind:'sharing_settlement',id:r.id,batchId:r.batch_id}:null});
 }else if(section==='posts'){
  sql=`SELECT x.* FROM(SELECT p.id,p.published_at AS at,p.published_at::text AS cursor_at,r.title,r.body,p.state FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.published_revision WHERE p.author_member_id=$1 AND p.state='published' AND p.visibility='public')x WHERE ${bound} ORDER BY x.at DESC,x.id DESC LIMIT $4`;
  map=r=>({id:r.id,kind:'post',title:r.title||'护理分享',body:r.body?.slice(0,160)??'',state:r.state,occurredAt:r.at,source:{kind:'post',id:r.id}});
 }else if(section==='comments'){
  sql=`SELECT x.* FROM(SELECT e.id,'editorial_comment'::text AS kind,e.created_at AS at,e.created_at::text AS cursor_at,e.body,e.state,e.article_id AS parent_id FROM editorial_comment e WHERE e.author_member_id=$1 AND e.state='published'
   UNION ALL SELECT u.id,'ugc_comment',u.created_at,u.created_at::text,u.body,u.state,u.post_id FROM ugc_comment u JOIN ugc_post p ON p.id=u.post_id WHERE u.author_member_id=$1 AND u.state='published' AND p.state='published' AND p.visibility='public')x WHERE ${bound} ORDER BY x.at DESC,x.id DESC LIMIT $4`;
  map=r=>({id:r.id,kind:r.kind,title:'公开评论',body:r.body,state:r.state,occurredAt:r.at,source:{kind:r.kind==='editorial_comment'?'editorial':'post',id:r.parent_id}});
 }else if(section==='support'){
  sql=`SELECT x.* FROM(SELECT sc.id,sc.created_at AS at,sc.created_at::text AS cursor_at,sc.status,sc.priority,sc.team_unread_count,sc.current_handler_principal_id,
   (SELECT sm.body FROM support_message sm WHERE sm.conversation_id=sc.id AND sm.sender_type='user' ORDER BY sm.sequence DESC LIMIT 1) AS preview FROM support_conversation sc WHERE sc.member_id=$1)x WHERE ${bound} ORDER BY x.at DESC,x.id DESC LIMIT $4`;
  map=r=>({id:r.id,kind:'support',title:'客服会话',state:r.status,priority:r.priority,unread:userNumber(r.team_unread_count),body:r.preview?.slice(0,160)??'',occurredAt:r.at,source:{kind:'support',id:r.id}});
 }else if(section==='privacy'){
  sql=`SELECT x.* FROM(SELECT p.id,p.created_at AS at,p.created_at::text AS cursor_at,p.kind,p.scope_code,p.status,p.message,p.response,p.version FROM privacy_request p WHERE p.member_id=$1)x WHERE ${bound} ORDER BY x.at DESC,x.id DESC LIMIT $4`;
  map=r=>({id:r.id,kind:'privacy',title:({access:'查阅资料',export:'资料副本',correct:'更正资料',delete:'删除或注销',withdraw:'撤回授权'} as Row)[r.kind]||r.kind,state:r.status,body:r.message,reply:r.response,scopeCode:r.scope_code,occurredAt:r.at,source:{kind:'privacy',id:r.id}});
 }else if(section==='logs'){
  // Object ownership, never the subject acting as an administrator on somebody else.
  sql=`SELECT x.* FROM(SELECT a.id,a.created_at AS at,a.created_at::text AS cursor_at,a.action,a.reason_code,
   COALESCE((SELECT m.display_name FROM member m WHERE 'member:'||m.id::text=a.principal_id),'系统或运营人员') AS actor
   FROM audit_log a WHERE (a.object_type='member' AND a.object_id=$1
    OR ${scope.orders?'true':'false'} AND a.object_type IN ('commerce_order','order') AND EXISTS(SELECT 1 FROM commerce_order o WHERE o.id=a.object_id AND o.member_id=$1)
    OR ${scope.support?'true':'false'} AND a.object_type='support_conversation' AND EXISTS(SELECT 1 FROM support_conversation sc WHERE sc.id=a.object_id AND sc.member_id=$1))
   AND (${scope.contact?'true':'false'} OR a.action<>'member.admin.contact.view')
   AND (${scope.care?'true':'false'} OR a.after_state->>'section' IS DISTINCT FROM 'care'))x WHERE ${bound} ORDER BY x.at DESC,x.id DESC LIMIT $4`;
  map=r=>({id:r.id,kind:'audit',title:r.action,actor:r.actor,occurredAt:r.at,reasonCode:/^[A-Z_]+$/.test(r.reason_code??'')?r.reason_code:null});
 }
 const rows=(await c.query(sql,args)).rows,items=rows.slice(0,limit).map(map);
 if(section==='care'&&scope.points){const rewards=await careDayRewards(c,target,items.map(r=>r.day));for(const item of items)item.rewards=rewards.get(item.day);}
 const page=finishPage(rows.map(r=>({id:r.id,cursorAt:r.cursor_at})),limit,key);
 return {section,items,nextCursor:page.nextCursor,hasMore:page.hasMore};
}

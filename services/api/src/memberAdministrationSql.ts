import type {UserScope} from './memberAdministrationPolicy.js';
/** Every lateral source is preaggregated before joining: no order×post×grant fanout. $1 is the snapshot clock. */
export function userProjectionSql(s:UserScope,canonicalOnly:boolean){
 const yes=(v:boolean)=>v?'true':'false';
 return `SELECT m.id,m.display_name,m.status AS account_status,m.created_at,m.created_at::text AS registered_sort,
 mc.number::text AS card_number,p.avatar_data_url,p.avatar_revision,p.profile_revision,c.phone_masked,
 cp.completed_at AS onboarding_completed_at,cp.erased_at AS care_erased_at,
 COALESCE(w.available,0)::bigint AS points_available,COALESCE(w.frozen,0)::bigint AS points_frozen,COALESCE(w.reserved,0)::bigint AS points_reserved,COALESCE(w.debt,0)::bigint AS points_debt,w.updated_at AS wallet_updated_at,
 COALESCE(due.expired_available,0)::bigint AS expired_available,COALESCE(due.expired_frozen,0)::bigint AS expired_frozen,COALESCE(due.unlock_frozen,0)::bigint AS unlock_frozen,
 COALESCE(ord.order_count,0)::int AS order_count,COALESCE(ord.paid_count,0)::int AS paid_count,COALESCE(ord.paid_cents,0)::text AS paid_cents,COALESCE(ref.refunded_cents,0)::text AS refunded_cents,
 COALESCE(afs.open_count,0)::int AS aftersale_count,COALESCE(care.care_days,0)::int AS care_days,care.last_at AS care_last_at,
 COALESCE(att.streak,0)::int AS streak,COALESCE(ugc.post_count,0)::int AS post_count,
 COALESCE(vch.usable_coupons,0)::int AS usable_coupons,COALESCE(vch.unclaimed_rewards,0)::int AS unclaimed_rewards,
 so.state AS officer_state,so.referral_code AS officer_code,so.version AS officer_version,
 relation.officer_id AS referrer_id,referrer.referral_code AS referrer_code,relation.source AS referrer_source,relation.version AS relation_version,
 COALESCE(direct.direct_count,0)::int AS direct_count,
 GREATEST(care.last_at,ord.last_at,ugc.last_at,sup.last_at) AS recent_at
 FROM member m LEFT JOIN member_card_number mc ON mc.member_id=m.id
 LEFT JOIN member_profile p ON p.member_id=m.id LEFT JOIN member_contact c ON c.member_id=m.id
 LEFT JOIN member_care_profile cp ON cp.member_id=m.id
 LEFT JOIN points_projection w ON w.member_id=m.id AND ${yes(s.points)}
 LEFT JOIN LATERAL(SELECT sum(CASE WHEN l.expires_at<=$1 THEN l.available_amount ELSE 0 END) AS expired_available,
 sum(CASE WHEN l.expires_at<=$1 THEN l.frozen_amount ELSE 0 END) AS expired_frozen,
 sum(CASE WHEN (l.expires_at IS NULL OR l.expires_at>$1) AND NOT g.blocked_for_use AND g.available_after<=$1 THEN l.frozen_amount ELSE 0 END) AS unlock_frozen
 FROM points_lot l JOIN points_grant g ON g.id=l.grant_id WHERE ${yes(s.points)} AND g.member_id=m.id)due ON true
 LEFT JOIN LATERAL(SELECT count(*) AS order_count,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM commission_payment_inbox pay WHERE pay.order_id=o.id AND pay.state='applied')) AS paid_count,
 COALESCE(sum((SELECT sum(pay.amount_cents) FROM commission_payment_inbox pay WHERE pay.order_id=o.id AND pay.state='applied')),0) AS paid_cents,max(o.created_at) AS last_at
 FROM commerce_order o WHERE ${yes(s.orders)} AND o.member_id=m.id AND o.transaction_source_kind='verified_commerce')ord ON true
 LEFT JOIN LATERAL(SELECT sum(i.refund_cents) AS refunded_cents FROM commission_refund_intent i JOIN commerce_order o ON o.id=i.order_id
 WHERE ${yes(s.orders)} AND o.member_id=m.id AND o.transaction_source_kind='verified_commerce' AND i.state='succeeded')ref ON true
 LEFT JOIN LATERAL(SELECT count(*) AS open_count FROM commerce_aftersale_case ac LEFT JOIN commission_refund_intent ri ON ri.request_id=ac.refund_request_id
 WHERE ${yes(s.orders)} AND ac.member_id=m.id AND ac.state NOT IN ('cancelled','rejected') AND NOT(ac.state='refund_pending' AND COALESCE(ri.state='succeeded',false)))afs ON true
 LEFT JOIN LATERAL(SELECT count(*) AS care_days,max(k.updated_at) AS last_at FROM member_points_checkin k WHERE ${yes(s.care)} AND k.member_id=m.id)care ON true
 LEFT JOIN LATERAL(SELECT count(*) AS streak FROM(SELECT a.care_day,row_number()OVER(ORDER BY a.care_day DESC) AS n,max(a.care_day)OVER() AS latest
 FROM member_points_attendance a WHERE ${yes(s.care)} AND a.member_id=m.id AND a.care_day<=($1 AT TIME ZONE 'Asia/Shanghai')::date)d
 WHERE d.latest>=($1 AT TIME ZONE 'Asia/Shanghai')::date-1 AND d.care_day=d.latest-(d.n::int-1))att ON true
 LEFT JOIN LATERAL(SELECT count(*) AS post_count,max(u.published_at) AS last_at FROM ugc_post u WHERE u.author_member_id=m.id AND u.state='published' AND u.visibility='public')ugc ON true
 LEFT JOIN LATERAL(SELECT (SELECT count(*) FROM member_purchase_coupon pc WHERE ${yes(s.rewards)} AND pc.member_id=m.id AND pc.state='available' AND pc.expires_at>$1) AS usable_coupons,
 (SELECT count(*) FROM reward_voucher rv WHERE ${yes(s.rewards)} AND rv.member_id=m.id AND rv.state='unused' AND rv.expires_at>$1) AS unclaimed_rewards)vch ON true
 LEFT JOIN sharing_officer so ON so.member_id=m.id AND ${yes(s.sharing)}
 LEFT JOIN sharing_customer_relation relation ON relation.buyer_id=m.id AND ${yes(s.sharing)} AND (relation.expires_at IS NULL OR relation.expires_at>$1)
 LEFT JOIN sharing_officer referrer ON referrer.member_id=relation.officer_id
 LEFT JOIN LATERAL(SELECT count(*) AS direct_count FROM sharing_customer_relation r WHERE ${yes(s.sharing)} AND r.officer_id=m.id AND (r.expires_at IS NULL OR r.expires_at>$1))direct ON true
 LEFT JOIN LATERAL(SELECT max(sm.created_at) AS last_at FROM support_message sm JOIN support_conversation sc ON sc.id=sm.conversation_id
 WHERE ${yes(s.support)} AND sc.member_id=m.id AND sm.sender_type='user')sup ON true
 WHERE m.status<>'deleted' ${canonicalOnly?"AND EXISTS(SELECT 1 FROM wechat_identity wi WHERE wi.member_id=m.id AND wi.provider='wechat_miniprogram' AND wi.app_id='wx4eac2d4fb11d299b')":''}`;
}

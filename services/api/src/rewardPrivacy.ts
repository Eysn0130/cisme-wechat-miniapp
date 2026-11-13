import type {AppConfig} from '@cisme/config';
import type {DbClient} from './db.js';
import type {DeliveryAddressService} from './deliveryAddress.js';
import {openRewardShipment} from './activityRewards.js';
export const rewardPortableSpecs=[
 {section:'activityRewards',collection:'awards',single:false,sql:`SELECT id,activity_id,source_record_id,batch_id,created_at FROM reward_award WHERE member_id=$1 ORDER BY created_at,id`},
 {section:'activityRewards',collection:'vouchers',single:false,sql:`SELECT id,activity_id,state,terms_snapshot,activity_version,expires_at,issued_at,version,claim_id FROM reward_voucher WHERE member_id=$1 ORDER BY issued_at,id`},
 {section:'activityRewards',collection:'quotes',single:false,sql:`SELECT id,voucher_id,bundle_code,item_snapshot,survey_version,questionnaire_version,recommendation,shipping_cents,expires_at,consumed_at,created_at FROM reward_quote WHERE member_id=$1 ORDER BY created_at,id`},
 {section:'activityRewards',collection:'claims',single:false,sql:`SELECT id,member_id,claim_number,voucher_id,quote_id,state,version,bundle_code,item_snapshot,terms_snapshot,survey_version,questionnaire_version,recommendation,shipping_cents,encrypted_address,address_hmac,key_version,shipment_encrypted,carrier_name,shipped_at,received_at,aftersale_reason,previous_state,created_at,updated_at FROM activity_reward_claim WHERE member_id=$1 ORDER BY created_at,id`},
 {section:'activityRewards',collection:'coupons',single:false,sql:`SELECT id,template_code,source_claim_id,state,threshold_cents,discount_cents,eligible_product_ids,issued_at,expires_at,order_id,version FROM member_purchase_coupon WHERE member_id=$1 ORDER BY issued_at,id`}
];
export function rewardPortableRow(config:AppConfig,addresses:DeliveryAddressService,collection:string,row:Record<string,any>){
 if(collection!=='claims')return row;
 const {member_id,encrypted_address,address_hmac,key_version,shipment_encrypted,...safe}=row;
 return {...safe,address:addresses.openOrderSnapshot(member_id,row.id,encrypted_address,address_hmac,key_version),trackingNumber:openRewardShipment(config,row)};
}
export async function collectRewardPortableData(c:DbClient,config:AppConfig,addresses:DeliveryAddressService,memberId:string){
 const result:Record<string,unknown>={};for(const spec of rewardPortableSpecs)result[spec.collection]=(await c.query(spec.sql,[memberId])).rows.map(row=>rewardPortableRow(config,addresses,spec.collection,row));return result;
}

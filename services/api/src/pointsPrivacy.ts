import type {AppConfig} from '@cisme/config';
import {openPointsNote} from './memberPointsClub.js';
import type {DeliveryAddressService} from './deliveryAddress.js';
export const pointsPortableSpecs=[
 {section:'pointsClub',collection:'checkins',single:false,sql:`SELECT id,member_id,care_day,products,note_encrypted,key_version,version,created_at,updated_at FROM member_points_checkin WHERE member_id=$1 ORDER BY care_day,id`},
 {section:'pointsClub',collection:'birthday',single:true,sql:`SELECT birthday_month_day,birthday_set_at,birthday_change_after,updated_at FROM member_points_profile WHERE member_id=$1`},
 {section:'pointsClub',collection:'badges',single:false,sql:`SELECT code,earned_at FROM member_points_badge WHERE member_id=$1 ORDER BY earned_at,code`},
 {section:'pointsClub',collection:'attendance',single:false,sql:`SELECT care_day,qualified_at FROM member_points_attendance WHERE member_id=$1 ORDER BY care_day`},
 {section:'pointsClub',collection:'redemptions',single:false,sql:`SELECT id,member_id,sku_id,quantity,points_cost,item_snapshot,state,version,carrier_name,tracking_number,policy_version,encrypted_address,address_hmac,key_version,created_at,updated_at FROM member_points_redemption WHERE member_id=$1 ORDER BY created_at,id`},
 {section:'pointsClub',collection:'redemptionEvents',single:false,sql:`SELECT e.redemption_id,e.action,e.reason,e.occurred_at FROM member_points_redemption_event e JOIN member_points_redemption r ON r.id=e.redemption_id WHERE r.member_id=$1 ORDER BY e.occurred_at,e.id`},
 {section:'pointsClub',collection:'grants',single:false,sql:`SELECT id,amount,source_type,component,rule_version,rule_snapshot,reversed_total,available_after,expires_at,created_at FROM points_grant WHERE member_id=$1 ORDER BY created_at,id`}
];
export function pointsPortableRow(config:AppConfig,addresses:DeliveryAddressService,collection:string,row:Record<string,any>){
 if(collection==='checkins'){const {member_id,note_encrypted,key_version,...safe}=row;return {...safe,note:openPointsNote(config,row as Parameters<typeof openPointsNote>[1])};}
 if(collection==='redemptions'){const {member_id,encrypted_address,address_hmac,key_version,...safe}=row;
  return {...safe,address:addresses.openOrderSnapshot(member_id,row.id,encrypted_address,address_hmac,key_version)};}
 return row;
}

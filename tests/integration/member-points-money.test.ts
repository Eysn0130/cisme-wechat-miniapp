// Isolated signed-provider fixtures; no real payment, refund or shipment.
import { createCipheriv, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resetDatabase, testPool } from "@cisme/testkit";
import { VerifiedPaymentInbox } from "../../services/api/src/verifiedPaymentInbox";
import { VerifiedRefundInbox } from "../../services/api/src/verifiedRefundInbox";
import { expirePendingOrders } from "../../services/api/src/commerceOrders";
import { claimDueMoneyInbox, recordMoneyInboxFailure, redriveQuarantinedMoneyInbox } from "../../services/api/src/moneyInboxRetry";
import { SettlementCycleService } from "../../services/api/src/settlementCycle";
import { SettlementCommandService } from "../../services/api/src/settlementCommand";
import { ShoppingCreditService } from "../../services/api/src/shoppingCredit";
import type { WechatPayV3Client } from "../../services/api/src/wechatPayV3";
import { AuthorityService } from "../../services/api/src/authority";

const pool=testPool();
const platform=generateKeyPairSync("rsa",{modulusLength:2048});
const publicPem=platform.publicKey.export({type:"spki",format:"pem"}).toString();
const appId="wx4eac2d4fb11d299b",merchantId="1234567890",apiV3Key="0123456789abcdef0123456789abcdef";
const processor=new VerifiedPaymentInbox(pool,{appId,merchantId,apiV3Key,
  platformKeys:new Map([["PUB_KEY_ID_3000000001",publicPem]])});
const refunds=new VerifiedRefundInbox(pool,{merchantId,apiV3Key,
  platformKeys:new Map([["PUB_KEY_ID_3000000001",publicPem]])});
let payerOpenid='verified-buyer-openid';
let databaseClockOffset=0;
let buyer:string,referrer:string,sku:string,product:string,codeId:string,ruleId:string,addressId:string;

async function seedOrder(suffix:string,commissionBasis:number|null=10000,createdAt=new Date()){
  const quoteId=randomUUID(),orderId=randomUUID(),number=`CM20260912${suffix.padStart(12,"0")}`;
  const now=createdAt,expires=new Date(now.getTime()+60*60_000);
  await pool.query(`INSERT INTO commerce_checkout_quote(id,member_id,product_id,sku_id,address_id,address_version,
    quantity,currency,unit_price_cents,subtotal_cents,member_discount_cents,shipping_cents,total_cents,
    pricing_rule_version,product_version,sku_version,price_version,status,idempotency_key,request_hash,
    expires_at,consumed_at,created_at) VALUES($1,$2,$3,$4,$5,1,1,'CNY',10000,10000,0,0,10000,
    'fixture-r1',1,1,1,'consumed',$6,$7,$8,$9,$10)`,
    [quoteId,buyer,product,sku,addressId,`payment-quote-${suffix}`,"a".repeat(64),expires,now,now]);
  await pool.query(`INSERT INTO commerce_order(id,order_number,member_id,source_quote_id,status,currency,
    subtotal_cents,member_discount_cents,shipping_cents,total_cents,points_spent,points_policy_version,points_birthday_month,shopping_points_multiplier,pricing_rule_version,expires_at,
    created_at,updated_at,transaction_source_kind) VALUES($1,$2,$3,$4,'pending_payment','CNY',10000,500,0,9500,500,'club-owner-20261110-v1',extract(month from clock_timestamp() AT TIME ZONE 'Asia/Shanghai'),3,
    'fixture-r1',$5,$6,$6,'verified_commerce')`,[orderId,number,buyer,quoteId,expires,now]);
  await pool.query(`INSERT INTO commerce_payment_attempt(order_id,out_trade_no,member_id,payer_openid,
    app_id,merchant_id,amount_cents,currency,quote_id,pricing_rule_version,quote_price_version,expires_at)
    VALUES($1,$2,$3,$8,$4,$5,9500,'CNY',$6,'fixture-r1',1,$7)`,
    [orderId,number,buyer,appId,merchantId,quoteId,expires,payerOpenid]);
  await pool.query(`INSERT INTO commerce_order_line(order_id,line_number,product_id,sku_id,product_code,
    product_name,sku_code,sku_label,quantity,unit_price_cents,line_subtotal_cents,line_discount_cents,
    line_total_cents) VALUES($1,1,$2,$3,'verified-product','Verified fixture','VERIFIED_SKU','One',1,10000,10000,500,9500)`,
    [orderId,product,sku]);
  await pool.query(`INSERT INTO commerce_inventory_reservation(order_id,sku_id,quantity,expires_at)
    VALUES($1,$2,1,$3)`,[orderId,sku,expires]);
  await pool.query(`UPDATE catalog_inventory_level SET reserved_quantity=reserved_quantity+1 WHERE sku_id=$1`,[sku]);
  if(commissionBasis!==null)await pool.query(`INSERT INTO commission_order_snapshot(order_id,buyer_member_id,referrer_member_id,
    referral_code_id,rate_rule_id,basis_points,cash_merchandise_cents,source_kind,created_at)
    VALUES($1,$2,$3,$4,$5,2000,$6,'verified_commerce',$7)`,[orderId,buyer,referrer,codeId,ruleId,commissionBasis,now]);
  return {id:orderId,number,createdAt:now,expiresAt:expires};
}
function notification(orderNumber:string,transactionId:string,eventId:string,successTime:string,
  payerTotal=10000,total=10000){
  const transaction={appid:appId,mchid:merchantId,out_trade_no:orderNumber,
    transaction_id:transactionId,trade_type:"JSAPI",trade_state:"SUCCESS",success_time:successTime,
    amount:{total,payer_total:payerTotal,currency:"CNY",payer_currency:"CNY"},
    payer:{openid:payerOpenid}};
  const nonce="0123456789ab",associated="transaction";
  const cipher=createCipheriv("aes-256-gcm",Buffer.from(apiV3Key),Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(transaction)),cipher.final(),cipher.getAuthTag()]).toString("base64");
  const rawBody=Buffer.from(JSON.stringify({id:eventId,event_type:"TRANSACTION.SUCCESS",resource_type:"encrypt-resource",
    resource:{algorithm:"AEAD_AES_256_GCM",ciphertext,associated_data:associated,nonce,original_type:"transaction"}}));
  const timestamp=Math.floor(Date.now()/1000).toString(),requestNonce=randomBytes(16).toString("hex");
  const signature=sign("RSA-SHA256",Buffer.concat([Buffer.from(`${timestamp}\n${requestNonce}\n`),rawBody,Buffer.from("\n")]),
    platform.privateKey).toString("base64");
  return {rawBody,headers:{"Wechatpay-Serial":"PUB_KEY_ID_3000000001","Wechatpay-Timestamp":timestamp,
    "Wechatpay-Nonce":requestNonce,"Wechatpay-Signature":signature}};
}
function refundNotification(input:{orderNumber:string;transactionId:string;refundNumber:string;providerRefundId:string;
  eventId:string;refundCents:number;total?:number;status:"SUCCESS"|"ABNORMAL"|"CLOSED";successTime?:string}){
  const payload={mchid:merchantId,out_trade_no:input.orderNumber,transaction_id:input.transactionId,
    out_refund_no:input.refundNumber,refund_id:input.providerRefundId,refund_status:input.status,
    ...(input.status==="SUCCESS"?{success_time:input.successTime}:{}),
    amount:{total:input.total??10000,refund:input.refundCents,payer_total:input.total??10000,payer_refund:input.refundCents}};
  const nonce="0123456789ab",associated="refund";
  const cipher=createCipheriv("aes-256-gcm",Buffer.from(apiV3Key),Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]).toString("base64");
  const rawBody=Buffer.from(JSON.stringify({id:input.eventId,event_type:`REFUND.${input.status}`,
    resource_type:"encrypt-resource",resource:{algorithm:"AEAD_AES_256_GCM",ciphertext,
      associated_data:associated,nonce,original_type:"refund"}}));
  const timestamp=Math.floor(Date.now()/1000).toString(),requestNonce=randomBytes(16).toString("hex");
  const signature=sign("RSA-SHA256",Buffer.concat([Buffer.from(`${timestamp}\n${requestNonce}\n`),rawBody,Buffer.from("\n")]),
    platform.privateKey).toString("base64");
  return {rawBody,headers:{"Wechatpay-Serial":"PUB_KEY_ID_3000000001","Wechatpay-Timestamp":timestamp,
    "Wechatpay-Nonce":requestNonce,"Wechatpay-Signature":signature}};
}
async function refundIntent(input:{orderId:string;paymentId:string;refundNumber:string;refundCents:number;
  eligibleCents?:number;shippingCents?:number}){
  const lineId=(await pool.query("SELECT id FROM commerce_order_line WHERE order_id=$1",[input.orderId])).rows[0].id;
  const eligible=input.eligibleCents??input.refundCents,shipping=input.shippingCents??0;
  const other=input.refundCents-eligible-shipping;
  return (await pool.query(`INSERT INTO commission_refund_intent(order_id,payment_inbox_id,out_refund_no,
    refund_cents,payer_refund_cents,eligible_merchandise_refund_cents,other_merchandise_refund_cents,
    shipping_cash_refund_cents,line_allocation,allocation_policy_version,created_by)
    VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,'fixture-allocation-v1','isolated-test') RETURNING id`,
    [input.orderId,input.paymentId,input.refundNumber,input.refundCents,eligible,other,shipping,
      JSON.stringify(eligible+other?[{lineId,eligibleCashRefundCents:eligible,otherCashRefundCents:other}]:[])])).rows[0].id;
}
beforeAll(async()=>{
  await resetDatabase(pool);
  referrer=(await pool.query("INSERT INTO member(display_name) VALUES('Verified referrer') RETURNING id")).rows[0].id;
  const {loadConfig}=await import('@cisme/config'),{TEST_DATABASE_URL}=await import('@cisme/testkit');
  const {PlatformService}=await import('../../services/api/src/platformService'),{createApiGatewayStorage}=await import('../../services/api/src/storage');
  const inviteConfig=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'signed-invite-fixture',UPLOAD_TOKEN_SECRET:'signed-invite-upload'});
  const service=new PlatformService(pool,inviteConfig,createApiGatewayStorage(inviteConfig));
  const at=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  databaseClockOffset=Math.max(0,+at-Date.now())+10;
  const share=await service.createShare(referrer,'signed-invite-share-0001',{targetType:'invite',targetRef:'home'},at);
  await service.recordShareVisit(share.shareId,'signed-invite-visitor-0001',at);
  const registered=await service.identity({provider:'dev_test',appId:'dev',openid:'signed-new-buyer',displayName:'Verified buyer',adapter:'dev',consents:[{documentType:'privacy',version:'fixture'},{documentType:'terms',version:'fixture'}]},new Date(+at+1));buyer=registered.memberId;
  await service.attributeShareIdentity(buyer,share.shareId,'signed-invite-visitor-0001',new Date(+at+2));
  expect((await pool.query('SELECT referrer_member_id FROM member_points_referral WHERE member_id=$1',[buyer])).rows).toEqual([{referrer_member_id:referrer}]);
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram',$2,'verified-buyer-openid','wechat')`,[buyer,appId]);
  product=(await pool.query(`INSERT INTO catalog_product(code,name,source_kind,qualification_status,
    publication_status,created_by,updated_by,published_at) VALUES('verified-product','Verified fixture',
    'admin','eligible','published','fixture','fixture',now()) RETURNING id`)).rows[0].id;
  sku=(await pool.query(`INSERT INTO catalog_sku(product_id,code,label,created_by,updated_by)
    VALUES($1,'VERIFIED_SKU','One','fixture','fixture') RETURNING id`,[product])).rows[0].id;
  await pool.query(`INSERT INTO catalog_inventory_level(sku_id,stock_on_hand,updated_by)
    VALUES($1,10,'fixture')`,[sku]);
  addressId=randomUUID();
  await pool.query(`INSERT INTO member_delivery_address(id,member_id,encrypted_payload,payload_hmac,
    key_version,label,client_request_key) VALUES($1,$2,'fixture-encrypted',$3,'fixture','home','payment-address-fixture')`,
    [addressId,buyer,"a".repeat(64)]);
  await pool.query(`INSERT INTO commercial_membership(member_id,state,effective_at,expires_at,changed_by,change_reason)
    VALUES($1,'active',now()-interval '1 day',now()+interval '1 year','fixture','Verified payment fixture')`,[referrer]);
  codeId=(await pool.query(`INSERT INTO commercial_referral_code(member_id,code)
    VALUES($1,'CMABCDEFGHJK') RETURNING id`,[referrer])).rows[0].id;
  ruleId=(await pool.query(`SELECT id FROM commission_rate_rule WHERE member_id IS NULL AND state='active' LIMIT 1`)).rows[0].id;
});
afterAll(async()=>pool.end());

it('spends points only on verified payment, earns after owner receipt, and allocates cumulative signed refunds exactly',async()=>{
 const {loadConfig}=await import('@cisme/config');const {TEST_DATABASE_URL}=await import('@cisme/testkit');
 const {transaction}=await import('../../services/api/src/db');
 const {grantMemberPoints,reserveMemberPoints}=await import('../../services/api/src/pointsLedger');
 const {processMemberPointSources}=await import('../../services/api/src/memberPointsClub');
 const {ShippingSyncService}=await import('../../services/api/src/shippingSync');
 const {OrderFulfillmentService}=await import('../../services/api/src/orderFulfillment');
 const {DeliveryAddressService}=await import('../../services/api/src/deliveryAddress');
 const policy=(await pool.query("SELECT * FROM member_points_policy WHERE version='club-owner-20261110-v1'")).rows[0];
 const now=()=>new Date(Date.now()+databaseClockOffset);
 await transaction(pool,c=>grantMemberPoints(c,{owner:buyer,sourceType:'fixture',sourceId:randomUUID(),component:'base',amount:1000,policy,now:now()}));
 const order=await seedOrder('CLUBPOINTS1',null,now());
 await transaction(pool,c=>reserveMemberPoints(c,buyer,order.id,500,now()));
 expect((await pool.query('SELECT available,reserved FROM points_projection WHERE member_id=$1',[buyer])).rows[0]).toEqual({available:500,reserved:500});
 const transactionId='4200000000CLUBPOINTS1',signed=notification(order.number,transactionId,'EV-CLUB-POINTS1',now().toISOString(),9500,9500);
 const paid=await processor.receive(signed.rawBody,signed.headers);expect(await processor.processOne(paid.inboxId)).toBe('applied');
 expect((await pool.query('SELECT reserved FROM points_projection WHERE member_id=$1',[buyer])).rows[0].reserved).toBe(0);
 expect((await pool.query("SELECT sum(used_delta)::int n FROM points_entry WHERE member_id=$1",[buyer])).rows[0].n).toBe(500);
 expect((await pool.query("SELECT * FROM points_grant WHERE source_type='order' AND member_id=$1",[buyer])).rowCount).toBe(0);
 const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'club-shipping-test',UPLOAD_TOKEN_SECRET:'club-shipping-upload',CONTACT_ENCRYPTION_KEY:'31'.repeat(32),CONTACT_HASH_KEY:'32'.repeat(32)});
 const addresses=new DeliveryAddressService(pool,config),authority=new AuthorityService(pool,'test');
 await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,'commerce.fulfillment.manage','fixture','Synthetic points shipment','test','integration_fixture')`,[referrer]);
 const sync=new ShippingSyncService(pool,authority,{enabled:true,appId,merchantId,encryptionKey:'41'.repeat(32),hashKey:'42'.repeat(32),keyVersion:'club-shipping-v1'},{query:async()=>{throw Error('offline')},uploadOnce:async()=>({acknowledged:true as const})});
 const fulfillment=new OrderFulfillmentService(pool,authority,addresses,sync,true);
 const sealed=addresses.sealOrderSnapshot(buyer,order.id,{recipientName:'合成收件人',phone:'13800000000',province:'上海市',city:'上海市',district:'浦东新区',detail:'合成路1号',postalCode:'200000',nationalCode:'310115',provinceCode:'310000',cityCode:'310100',districtCode:'310115'});
 await pool.query('INSERT INTO commerce_order_address(order_id,encrypted_payload,payload_hmac,key_version,source_address_id,source_address_version) VALUES($1,$2,$3,$4,$5,1)',[order.id,sealed.encryptedPayload,sealed.payloadHmac,sealed.keyVersion,addressId]);
 await pool.query('UPDATE catalog_product SET shopping_points_multiplier=1,version=version+1 WHERE id=$1',[product]);
 await expect(pool.query('UPDATE commerce_order SET shopping_points_multiplier=1 WHERE id=$1',[order.id])).rejects.toThrow('COMMERCE_POINTS_SNAPSHOT_IMMUTABLE');
 const shipped=await fulfillment.dispatch(referrer,order.id,'club-shipment-0001',{carrierCode:'SF',carrierName:'顺丰速运',trackingNumber:'SF123456789002',shippedAt:now().toISOString(),evidenceReference:'synthetic-club-dispatch-01',expectedOrderVersion:2});
 await fulfillment.confirmReceipt(buyer,order.id,'club-receipt-0001',1);
 await processMemberPointSources(pool,new Date(Date.now()+1000));
 expect((await pool.query("SELECT state,last_error FROM member_points_source_event WHERE kind='receipt' AND source_id=$1",[order.id])).rows).toEqual([{state:'applied',last_error:null}]);
 expect((await pool.query("SELECT component,amount FROM points_grant WHERE source_type='order' AND source_id=$1 ORDER BY component",[order.id])).rows).toEqual([{component:'birthday',amount:285},{component:'first_order',amount:300},{component:'invite_friend',amount:200},{component:'invite_sponsor',amount:300},{component:'shopping',amount:285}]);
 expect((await pool.query('SELECT available FROM points_projection WHERE member_id=$1',[buyer])).rows[0].available).toBe(1570);
 expect((await pool.query('SELECT available FROM points_projection WHERE member_id=$1',[referrer])).rows[0].available).toBe(300);
 let cumulative=0;
 for(const [i,amount] of [3333,6167].entries()){
  const number=`RFCLUBPOINTS000${i+1}`;await refundIntent({orderId:order.id,paymentId:paid.inboxId,refundNumber:number,refundCents:amount,eligibleCents:0});
  const r=refundNotification({orderNumber:order.number,transactionId,refundNumber:number,providerRefundId:`50000000000CLUBPOINTS${i}`,eventId:`EV-CLUB-REFUND-${i}`,refundCents:amount,total:9500,status:'SUCCESS',successTime:now().toISOString()});
  const received=await refunds.receive(r.rawBody,r.headers);await refunds.processOne(received.inboxId);expect((await pool.query('SELECT state,exception_code FROM commission_refund_inbox WHERE id=$1',[received.inboxId])).rows).toEqual([{state:'applied',exception_code:null}]);
  await processMemberPointSources(pool,new Date(Date.now()+1000));await processMemberPointSources(pool,new Date(Date.now()+1000));cumulative+=amount;
  const returned=Number(BigInt(500)*BigInt(cumulative)/9500n),remaining=9500-cumulative;
  expect((await pool.query('SELECT sum(returned)::int n FROM member_points_allocation WHERE order_id=$1',[order.id])).rows[0].n).toBe(returned);
  expect((await pool.query('SELECT available,debt FROM points_projection WHERE member_id=$1',[buyer])).rows[0]).toEqual({available:500+returned+(remaining>0?500:0)+6*Math.floor(remaining/100),debt:0});
  expect((await pool.query('SELECT available,debt FROM points_projection WHERE member_id=$1',[referrer])).rows[0]).toEqual({available:remaining>0?300:0,debt:0});
 }
 expect((await pool.query('SELECT sum(available_delta)::int n FROM points_entry WHERE member_id=$1',[buyer])).rows[0].n).toBe(1000);
 expect(shipped.id).toBeTruthy();
});

it('books invalid reserved points as debt only on signed payment and reverses the obligation on signed refund',async()=>{
 const {transaction}=await import('../../services/api/src/db');const {grantMemberPoints,reserveMemberPoints,reverseMemberGrant}=await import('../../services/api/src/pointsLedger');const {processMemberPointSources}=await import('../../services/api/src/memberPointsClub');
 buyer=(await pool.query("INSERT INTO member(display_name) VALUES('Synthetic conditional-debt buyer') RETURNING id")).rows[0].id;payerOpenid='synthetic-conditional-'+buyer;
 await pool.query("INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter) VALUES($1,'wechat_miniprogram',$2,$3,'wechat')",[buyer,appId,payerOpenid]);
 const policy=(await pool.query("SELECT * FROM member_points_policy WHERE version='club-owner-20261110-v1'")).rows[0];
 const fund=async(amount:number)=>transaction(pool,c=>grantMemberPoints(c,{owner:buyer,sourceType:'fixture',sourceId:randomUUID(),component:'base',amount,policy,now:new Date()}));
 const grant=await fund(1000),order=await seedOrder('CLUBDEBT2',null,new Date());await transaction(pool,c=>reserveMemberPoints(c,buyer,order.id,500,new Date()));
 await transaction(pool,c=>reverseMemberGrant(c,grant!,1000,'conditional-debt-source',new Date(),'Synthetic reward source withdrawn'));
 expect((await pool.query('SELECT available,reserved,debt FROM points_projection WHERE member_id=$1',[buyer])).rows[0]).toEqual({available:0,reserved:500,debt:0});
 const transactionId='420000000CLUBCONDITION2',event=notification(order.number,transactionId,'EV-CLUB-CONDITION-2',new Date().toISOString(),9500,9500);
 const paid=await processor.receive(event.rawBody,event.headers);expect(await processor.processOne(paid.inboxId)).toBe('applied');expect(await processor.processOne(paid.inboxId)).toBe('applied');
 expect((await pool.query('SELECT available,reserved,debt FROM points_projection WHERE member_id=$1',[buyer])).rows[0]).toEqual({available:0,reserved:0,debt:500});
 await fund(200);const number='RFCLUBCONDITION2';await refundIntent({orderId:order.id,paymentId:paid.inboxId,refundNumber:number,refundCents:9500,eligibleCents:0});
 const refund=refundNotification({orderNumber:order.number,transactionId,refundNumber:number,providerRefundId:'500000CLUBCONDITION2',eventId:'EV-CLUB-CONDITION-REFUND2',refundCents:9500,total:9500,status:'SUCCESS',successTime:new Date().toISOString()});
 const received=await refunds.receive(refund.rawBody,refund.headers);expect(await refunds.processOne(received.inboxId)).toBe('applied');await processMemberPointSources(pool,new Date(Date.now()+1000));
 expect((await pool.query('SELECT available,reserved,debt FROM points_projection WHERE member_id=$1',[buyer])).rows[0]).toEqual({available:200,reserved:0,debt:0});
 expect((await pool.query("SELECT count(*)::int n FROM points_grant WHERE member_id=$1 AND source_type='refund_recovery'",[buyer])).rows[0].n).toBe(1);
 expect((await pool.query("SELECT COALESCE(sum(available_delta+frozen_delta),0)::int n FROM points_entry WHERE member_id=$1 AND entry_type IN ('grant_available','grant_frozen')",[buyer])).rows[0].n).toBe(1200);
});

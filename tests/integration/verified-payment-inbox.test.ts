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
    subtotal_cents,member_discount_cents,shipping_cents,total_cents,pricing_rule_version,expires_at,
    created_at,updated_at,transaction_source_kind) VALUES($1,$2,$3,$4,'pending_payment','CNY',10000,0,0,10000,
    'fixture-r1',$5,$6,$6,'verified_commerce')`,[orderId,number,buyer,quoteId,expires,now]);
  await pool.query(`INSERT INTO commerce_payment_attempt(order_id,out_trade_no,member_id,payer_openid,
    app_id,merchant_id,amount_cents,currency,quote_id,pricing_rule_version,quote_price_version,expires_at)
    VALUES($1,$2,$3,'verified-buyer-openid',$4,$5,10000,'CNY',$6,'fixture-r1',1,$7)`,
    [orderId,number,buyer,appId,merchantId,quoteId,expires]);
  await pool.query(`INSERT INTO commerce_order_line(order_id,line_number,product_id,sku_id,product_code,
    product_name,sku_code,sku_label,quantity,unit_price_cents,line_subtotal_cents,line_discount_cents,
    line_total_cents) VALUES($1,1,$2,$3,'verified-product','Verified fixture','VERIFIED_SKU','One',1,10000,10000,0,10000)`,
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
  payerTotal=10000){
  const transaction={appid:appId,mchid:merchantId,out_trade_no:orderNumber,
    transaction_id:transactionId,trade_type:"JSAPI",trade_state:"SUCCESS",success_time:successTime,
    amount:{total:10000,payer_total:payerTotal,currency:"CNY",payer_currency:"CNY"},
    payer:{openid:"verified-buyer-openid"}};
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
  eventId:string;refundCents:number;status:"SUCCESS"|"ABNORMAL"|"CLOSED";successTime?:string}){
  const payload={mchid:merchantId,out_trade_no:input.orderNumber,transaction_id:input.transactionId,
    out_refund_no:input.refundNumber,refund_id:input.providerRefundId,refund_status:input.status,
    ...(input.status==="SUCCESS"?{success_time:input.successTime}:{}),
    amount:{total:10000,refund:input.refundCents,payer_total:10000,payer_refund:input.refundCents}};
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
  buyer=(await pool.query("INSERT INTO member(display_name) VALUES('Verified buyer') RETURNING id")).rows[0].id;
  referrer=(await pool.query("INSERT INTO member(display_name) VALUES('Verified referrer') RETURNING id")).rows[0].id;
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

it("persists a signed payment, consumes stock and accrues once despite replay",async()=>{
  const order=await seedOrder("1");
  const event=notification(order.number,"420000000000000000000101","EV-20260912-0101",
    new Date(order.createdAt.getTime()+1000).toISOString());
  const first=await processor.receive(event.rawBody,event.headers);
  expect(first).toMatchObject({persisted:true,state:"pending"});
  expect(await processor.processPending()).toContainEqual({id:first.inboxId,state:"applied"});
  const replay=await processor.receive(event.rawBody,event.headers);
  expect(replay).toMatchObject({inboxId:first.inboxId,state:"applied"});
  expect((await pool.query(`SELECT status,version,transaction_source_kind FROM commerce_order WHERE id=$1`,[order.id])).rows[0])
    .toMatchObject({status:"paid",version:2,transaction_source_kind:"verified_commerce"});
  expect((await pool.query(`SELECT kind,amount_cents FROM commission_ledger_entry WHERE order_id=$1`,[order.id])).rows)
    .toMatchObject([{kind:"accrual",amount_cents:"2000"}]);
  expect((await pool.query(`SELECT status FROM commerce_inventory_reservation WHERE order_id=$1`,[order.id])).rows[0].status)
    .toBe("consumed");
  expect((await pool.query(`SELECT stock_on_hand,reserved_quantity FROM catalog_inventory_level WHERE sku_id=$1`,[sku])).rows[0])
    .toMatchObject({stock_on_hand:9,reserved_quantity:0});
  expect((await pool.query(`SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id=$1 AND event_type='commerce.order.paid.v1'`,[order.id])).rows[0].n)
    .toBe(1);
  await expect(pool.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,event_key,kind,
    amount_cents,source_fact_id,actor_principal_id) VALUES($1,$2,'forged-accrual-0001','accrual',10,$3,'fixture')`,
    [order.id,referrer,randomUUID()])).rejects.toThrow();
});

it("keeps a signed late payment as an exception after cancellation, with no commission",async()=>{
  const order=await seedOrder("2");
  await pool.query(`UPDATE commerce_order SET status='cancelled',cancelled_at=now(),terminal_reason='TEST_CANCELLED',version=2 WHERE id=$1`,[order.id]);
  const event=notification(order.number,"420000000000000000000102","EV-20260912-0102",
    new Date(order.createdAt.getTime()+1000).toISOString());
  expect(await processor.receive(event.rawBody,event.headers)).toMatchObject({persisted:true,state:"pending"});
  expect(await processor.processPending()).toContainEqual(expect.objectContaining({state:"exception"}));
  expect((await pool.query(`SELECT exception_code FROM commission_payment_inbox WHERE order_id=$1`,[order.id])).rows[0].exception_code)
    .toBe("ORDER_ALREADY_TERMINAL");
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1`,[order.id])).rows[0].n).toBe(0);
  const tampered=Buffer.from(event.rawBody.toString().replace("TRANSACTION.SUCCESS","TRANSACTION.FAIL"));
  await expect(processor.receive(tampered,event.headers)).rejects.toThrow();
});

it("does not expire verified-commerce orders before payment reconciliation and rejects inflated commission basis",async()=>{
  const order=await seedOrder("3",20_000);
  expect(await expirePendingOrders(pool,new Date(order.expiresAt.getTime()+1000))).toBe(0);
  const event=notification(order.number,"420000000000000000000103","EV-20260912-0103",
    new Date(order.createdAt.getTime()+1000).toISOString());
  const received=await processor.receive(event.rawBody,event.headers);
  expect(await processor.processOne(received.inboxId)).toBe("exception");
  expect((await pool.query("SELECT exception_code FROM commission_payment_inbox WHERE id=$1",[received.inboxId])).rows[0].exception_code)
    .toBe("COMMISSION_SNAPSHOT_MISMATCH");
  expect((await pool.query("SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1",[order.id])).rows[0].n).toBe(0);
});

it("reverses signed partial refunds cumulatively and exactly once, without altering paid history",async()=>{
  const order=await seedOrder("4"),transactionId="420000000000000000000104";
  const paid=notification(order.number,transactionId,"EV-20260912-0104",
    new Date(order.createdAt.getTime()+1000).toISOString());
  const payment=await processor.receive(paid.rawBody,paid.headers);
  expect(await processor.processOne(payment.inboxId)).toBe("applied");
  const firstNumber="RF2026091200000001";
  await refundIntent({orderId:order.id,paymentId:payment.inboxId,refundNumber:firstNumber,refundCents:3333});
  const first=refundNotification({orderNumber:order.number,transactionId,refundNumber:firstNumber,
    providerRefundId:"500000000000000000000101",eventId:"EV-20260912-R101",refundCents:3333,status:"SUCCESS",
    successTime:new Date(order.createdAt.getTime()+2000).toISOString()});
  const received=await refunds.receive(first.rawBody,first.headers);
  expect(await refunds.processOne(received.inboxId)).toBe("applied");
  expect(await refunds.receive(first.rawBody,first.headers)).toMatchObject({inboxId:received.inboxId,state:"applied"});
  expect((await pool.query(`SELECT kind,amount_cents FROM commission_ledger_entry WHERE order_id=$1
    ORDER BY occurred_at,id`,[order.id])).rows.map(row=>[row.kind,row.amount_cents]))
    .toEqual([["accrual","2000"],["refund_reversal","-667"]]);

  const duplicateProviderNumber="RF2026091200000009";
  await refundIntent({orderId:order.id,paymentId:payment.inboxId,
    refundNumber:duplicateProviderNumber,refundCents:1});
  const duplicateProvider=refundNotification({orderNumber:order.number,transactionId,
    refundNumber:duplicateProviderNumber,providerRefundId:"500000000000000000000101",
    eventId:"EV-20260912-R109",refundCents:1,status:"SUCCESS",
    successTime:new Date(order.createdAt.getTime()+2500).toISOString()});
  const duplicateReceipt=await refunds.receive(duplicateProvider.rawBody,duplicateProvider.headers);
  expect(await refunds.processOne(duplicateReceipt.inboxId)).toBe("exception");
  expect((await pool.query(`SELECT exception_code FROM commission_refund_inbox WHERE id=$1`,[duplicateReceipt.inboxId])).rows[0].exception_code)
    .toBe("REFUND_PROVIDER_ID_CONFLICT");

  const secondNumber="RF2026091200000002";
  await refundIntent({orderId:order.id,paymentId:payment.inboxId,refundNumber:secondNumber,refundCents:6667});
  const second=refundNotification({orderNumber:order.number,transactionId,refundNumber:secondNumber,
    providerRefundId:"500000000000000000000102",eventId:"EV-20260912-R102",refundCents:6667,status:"SUCCESS",
    successTime:new Date(order.createdAt.getTime()+3000).toISOString()});
  const secondReceipt=await refunds.receive(second.rawBody,second.headers);
  expect(await refunds.processOne(secondReceipt.inboxId)).toBe("applied");
  expect((await pool.query(`SELECT COALESCE(sum(amount_cents),0)::text AS total FROM commission_ledger_entry
    WHERE order_id=$1`,[order.id])).rows[0].total).toBe("0");
  expect((await pool.query(`SELECT status FROM commerce_order WHERE id=$1`,[order.id])).rows[0].status).toBe("paid");

  const extraNumber="RF2026091200000003";
  await refundIntent({orderId:order.id,paymentId:payment.inboxId,refundNumber:extraNumber,refundCents:1});
  const extra=refundNotification({orderNumber:order.number,transactionId,refundNumber:extraNumber,
    providerRefundId:"500000000000000000000103",eventId:"EV-20260912-R103",refundCents:1,status:"SUCCESS",
    successTime:new Date(order.createdAt.getTime()+4000).toISOString()});
  const extraReceipt=await refunds.receive(extra.rawBody,extra.headers);
  expect(await refunds.processOne(extraReceipt.inboxId)).toBe("exception");
  expect((await pool.query(`SELECT exception_code FROM commission_refund_inbox WHERE id=$1`,[extraReceipt.inboxId])).rows[0].exception_code)
    .toBe("REFUND_CUMULATIVE_OVERDRAW");
  await expect(pool.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,event_key,kind,
    amount_cents,reverse_of,source_fact_id,actor_principal_id)
    SELECT $1,$2,'forged-refund-reversal-0001','refund_reversal',-1,id,$3,'isolated-test'
    FROM commission_ledger_entry WHERE order_id=$1 AND kind='accrual'`,
    [order.id,referrer,randomUUID()])).rejects.toThrow();
});

it("holds an abnormal refund without reversal and accepts only a later signed success",async()=>{
  const order=await seedOrder("5"),transactionId="420000000000000000000105";
  const paid=notification(order.number,transactionId,"EV-20260912-0105",
    new Date(order.createdAt.getTime()+1000).toISOString());
  const payment=await processor.receive(paid.rawBody,paid.headers);
  expect(await processor.processOne(payment.inboxId)).toBe("applied");
  const refundNumber="RF2026091200000005";
  await refundIntent({orderId:order.id,paymentId:payment.inboxId,refundNumber,refundCents:5000});
  const abnormal=refundNotification({orderNumber:order.number,transactionId,refundNumber,
    providerRefundId:"500000000000000000000105",eventId:"EV-20260912-R105A",refundCents:5000,status:"ABNORMAL"});
  const initial=await refunds.receive(abnormal.rawBody,abnormal.headers);
  expect(await refunds.processOne(initial.inboxId)).toBe("applied");
  expect((await pool.query(`SELECT state FROM commission_refund_intent WHERE out_refund_no=$1`,[refundNumber])).rows[0].state)
    .toBe("abnormal");
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1 AND kind='refund_reversal'`,[order.id])).rows[0].n)
    .toBe(0);
  const success=refundNotification({orderNumber:order.number,transactionId,refundNumber,
    providerRefundId:"500000000000000000000105",eventId:"EV-20260912-R105S",refundCents:5000,status:"SUCCESS",
    successTime:new Date(order.createdAt.getTime()+3000).toISOString()});
  const later=await refunds.receive(success.rawBody,success.headers);
  expect(await refunds.processOne(later.inboxId)).toBe("applied");
  expect((await pool.query(`SELECT amount_cents FROM commission_ledger_entry WHERE order_id=$1 AND kind='refund_reversal'`,[order.id])).rows[0].amount_cents)
    .toBe("-1000");
  const tampered=Buffer.from(success.rawBody.toString().replace("REFUND.SUCCESS","REFUND.CLOSED"));
  await expect(refunds.receive(tampered,success.headers)).rejects.toThrow();
});

it("records an ordinary order refund without a commission ledger and rejects excess freight allocation",async()=>{
  const order=await seedOrder("6",null),transactionId="420000000000000000000106";
  const paid=notification(order.number,transactionId,"EV-20260912-0106",
    new Date(order.createdAt.getTime()+1000).toISOString());
  const payment=await processor.receive(paid.rawBody,paid.headers);
  expect(await processor.processOne(payment.inboxId)).toBe("applied");
  const ordinaryNumber="RF2026091200000006";
  await refundIntent({orderId:order.id,paymentId:payment.inboxId,refundNumber:ordinaryNumber,
    refundCents:5000,eligibleCents:0});
  const ordinary=refundNotification({orderNumber:order.number,transactionId,refundNumber:ordinaryNumber,
    providerRefundId:"500000000000000000000106",eventId:"EV-20260912-R106",refundCents:5000,status:"SUCCESS",
    successTime:new Date(order.createdAt.getTime()+2000).toISOString()});
  const ordinaryReceipt=await refunds.receive(ordinary.rawBody,ordinary.headers);
  expect(await refunds.processOne(ordinaryReceipt.inboxId)).toBe("applied");
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1`,[order.id])).rows[0].n).toBe(0);
  const freightNumber="RF2026091200000007";
  await refundIntent({orderId:order.id,paymentId:payment.inboxId,refundNumber:freightNumber,
    refundCents:1,eligibleCents:0,shippingCents:1});
  const freight=refundNotification({orderNumber:order.number,transactionId,refundNumber:freightNumber,
    providerRefundId:"500000000000000000000107",eventId:"EV-20260912-R107",refundCents:1,status:"SUCCESS",
    successTime:new Date(order.createdAt.getTime()+3000).toISOString()});
  const freightReceipt=await refunds.receive(freight.rawBody,freight.headers);
  expect(await refunds.processOne(freightReceipt.inboxId)).toBe("exception");
  expect((await pool.query(`SELECT exception_code FROM commission_refund_inbox WHERE id=$1`,[freightReceipt.inboxId])).rows[0].exception_code)
    .toBe("REFUND_CUMULATIVE_OVERDRAW");
});

it("delays twenty failed payment facts so a later fact is processed, then isolates and safely redrives one",async()=>{
  const order=await seedOrder("7"),ids:string[]=[];
  for(let n=1;n<=21;n++){
    const event=notification(order.number,`42000000000000000007${String(n).padStart(4,"0")}`,
      `EV-PAGED-PAY-${String(n).padStart(4,"0")}`,new Date(order.createdAt.getTime()+1000).toISOString());
    ids.push((await processor.receive(event.rawBody,event.headers)).inboxId);
  }
  for(const id of ids.slice(0,20))expect(await recordMoneyInboxFailure(pool,"payment",id,new Error("synthetic transient"))).toBe("pending");
  const restarted=new VerifiedPaymentInbox(pool,{appId,merchantId,apiV3Key,
    platformKeys:new Map([["PUB_KEY_ID_3000000001",publicPem]])});
  expect(await restarted.processPending(20)).toEqual([{id:ids[20],state:"applied"}]);
  expect(await processor.processPending(20)).toEqual([]);
  expect((await pool.query("SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1 AND kind='accrual'",[order.id])).rows[0].n).toBe(1);
  await pool.query("UPDATE commission_payment_inbox SET next_attempt_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])",[ids.slice(0,20)]);
  const concurrent=await Promise.all([processor.processPending(20),restarted.processPending(20)]);
  expect(new Set(concurrent.flat().map(row=>row.id)).size).toBe(20);
  expect((await pool.query("SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1 AND kind='accrual'",[order.id])).rows[0].n).toBe(1);

  const redriveOrder=await seedOrder("8");
  const signed=notification(redriveOrder.number,"420000000000000000000108","EV-RETRY-PAY-0108",
    new Date(redriveOrder.createdAt.getTime()+1000).toISOString());
  const received=await processor.receive(signed.rawBody,signed.headers);
  for(let n=0;n<8;n++)await recordMoneyInboxFailure(pool,"payment",received.inboxId,new Error("synthetic transient"));
  expect((await pool.query("SELECT state,attempt_count,exception_code FROM commission_payment_inbox WHERE id=$1",[received.inboxId])).rows[0])
    .toMatchObject({state:"exception",attempt_count:8,exception_code:"RETRY_EXHAUSTED"});
  expect(await redriveQuarantinedMoneyInbox(pool,"payment",received.inboxId,`member:${referrer}`,"核对通道恢复后重驱")).toMatchObject({state:"pending"});
  expect(await restarted.processPending(20)).toContainEqual({id:received.inboxId,state:"applied"});
  await expect(redriveQuarantinedMoneyInbox(pool,"payment",received.inboxId,`member:${referrer}`,"不能再次重驱已应用事实")).rejects.toThrow();
  expect((await pool.query("SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1 AND kind='accrual'",[redriveOrder.id])).rows[0].n).toBe(1);
});

it("also skips twenty delayed refund facts and applies a later signed refund once",async()=>{
  const order=await seedOrder("9"),transactionId="420000000000000000000109";
  const paid=notification(order.number,transactionId,"EV-RETRY-PAY-0109",
    new Date(order.createdAt.getTime()+1000).toISOString());
  const payment=await processor.receive(paid.rawBody,paid.headers);
  expect(await processor.processOne(payment.inboxId)).toBe("applied");
  const ids:string[]=[];
  for(let n=1;n<=21;n++){
    const refundNumber=`RF-PAGED-${String(n).padStart(4,"0")}`;
    await refundIntent({orderId:order.id,paymentId:payment.inboxId,refundNumber,refundCents:1});
    const event=refundNotification({orderNumber:order.number,transactionId,refundNumber,
      providerRefundId:`50000000000000000009${String(n).padStart(4,"0")}`,
      eventId:`EV-PAGED-REFUND-${String(n).padStart(4,"0")}`,refundCents:1,status:"SUCCESS",
      successTime:new Date(order.createdAt.getTime()+2000).toISOString()});
    ids.push((await refunds.receive(event.rawBody,event.headers)).inboxId);
  }
  for(const id of ids.slice(0,20))expect(await recordMoneyInboxFailure(pool,"refund",id,new Error("synthetic transient"))).toBe("pending");
  const restarted=new VerifiedRefundInbox(pool,{merchantId,apiV3Key,
    platformKeys:new Map([["PUB_KEY_ID_3000000001",publicPem]])});
  expect(await restarted.processPending(20)).toEqual([{id:ids[20],state:"applied"}]);
  expect(await refunds.processPending(20)).toEqual([]);
  expect((await pool.query("SELECT count(*)::int AS n FROM commission_refund_inbox WHERE refund_intent_id=(SELECT id FROM commission_refund_intent WHERE out_refund_no='RF-PAGED-0021') AND state='applied'")).rows[0].n).toBe(1);
});

it("fences stale payment and refund workers after a timed-out claim is replaced",async()=>{
  const order=await seedOrder("12"),transactionId="420000000000000000000112";
  const signed=notification(order.number,transactionId,"EV-CLAIM-FENCE-PAY-0112",
    new Date(order.createdAt.getTime()+1000).toISOString());
  const payment=await processor.receive(signed.rawBody,signed.headers);
  const oldPayment=(await claimDueMoneyInbox(pool,"payment",100)).find(row=>row.id===payment.inboxId)!;
  expect(oldPayment).toBeTruthy();
  await pool.query("UPDATE commission_payment_inbox SET lease_until=now()-interval '1 second' WHERE id=$1",
    [payment.inboxId]);
  const newPayment=(await claimDueMoneyInbox(pool,"payment",100)).find(row=>row.id===payment.inboxId)!;
  expect(newPayment.leaseToken).not.toBe(oldPayment.leaseToken);
  await expect(processor.processOne(payment.inboxId,oldPayment.leaseToken))
    .rejects.toMatchObject({code:"PAYMENT_INBOX_LEASE_LOST"});
  expect(await recordMoneyInboxFailure(pool,"payment",payment.inboxId,new Error("stale payment"),
    oldPayment.leaseToken)).toBe("pending");
  expect((await pool.query("SELECT attempt_count,lease_token FROM commission_payment_inbox WHERE id=$1",
    [payment.inboxId])).rows[0]).toMatchObject({attempt_count:0,lease_token:newPayment.leaseToken});
  expect(await processor.processOne(payment.inboxId,newPayment.leaseToken)).toBe("applied");

  const refundNumber="RF-CLAIM-FENCE-0112";
  await refundIntent({orderId:order.id,paymentId:payment.inboxId,refundNumber,refundCents:100});
  const refundSigned=refundNotification({orderNumber:order.number,transactionId,refundNumber,
    providerRefundId:"500000000000000000000112",eventId:"EV-CLAIM-FENCE-REF-0112",
    refundCents:100,status:"SUCCESS",successTime:new Date(order.createdAt.getTime()+2000).toISOString()});
  const refund=await refunds.receive(refundSigned.rawBody,refundSigned.headers);
  const oldRefund=(await claimDueMoneyInbox(pool,"refund",100)).find(row=>row.id===refund.inboxId)!;
  expect(oldRefund).toBeTruthy();
  await pool.query("UPDATE commission_refund_inbox SET lease_until=now()-interval '1 second' WHERE id=$1",
    [refund.inboxId]);
  const newRefund=(await claimDueMoneyInbox(pool,"refund",100)).find(row=>row.id===refund.inboxId)!;
  expect(newRefund.leaseToken).not.toBe(oldRefund.leaseToken);
  await expect(refunds.processOne(refund.inboxId,oldRefund.leaseToken))
    .rejects.toMatchObject({code:"REFUND_INBOX_LEASE_LOST"});
  expect(await recordMoneyInboxFailure(pool,"refund",refund.inboxId,new Error("stale refund"),
    oldRefund.leaseToken)).toBe("pending");
  expect((await pool.query("SELECT attempt_count,lease_token FROM commission_refund_inbox WHERE id=$1",
    [refund.inboxId])).rows[0]).toMatchObject({attempt_count:0,lease_token:newRefund.leaseToken});
  expect(await refunds.processOne(refund.inboxId,newRefund.leaseToken)).toBe("applied");
});

it("carries sub-threshold released sources into a later non-payable monthly candidate",async()=>{
  const dates=(await pool.query<{earlier:string;later:string;created:Date;early_release:Date;late_release:Date}>(`SELECT
    (date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')-interval '2 months 1 day')::date::text AS earlier,
    (date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')-interval '1 month 1 day')::date::text AS later,
    (date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')-interval '4 months') AT TIME ZONE 'Asia/Shanghai' AS created,
    (date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')-interval '3 months'+interval '15 days') AT TIME ZONE 'Asia/Shanghai' AS early_release,
    (date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')-interval '2 months'+interval '15 days') AT TIME ZONE 'Asia/Shanghai' AS late_release`)).rows[0]!;
  const operator=(await pool.query("INSERT INTO member(display_name) VALUES('Cycle reviewer fixture') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'commission.settlement.approve','fixture','Cycle snapshot fixture','test','integration_fixture')`,[operator]);
  await pool.query(`UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+10 WHERE sku_id=$1`,[sku]);
  const cycles=new SettlementCycleService(pool,new AuthorityService(pool,"test"),"test");
  for(let index=0;index<5;index++){
    const order=await seedOrder(String(100+index),10000,dates.created);
    const event=notification(order.number,`cycle-transaction-${index}-00001`,
      `cycle-notification-${index}-00001`,new Date(order.createdAt.getTime()+1000).toISOString());
    const received=await processor.receive(event.rawBody,event.headers);
    expect(await processor.processOne(received.inboxId)).toBe("applied");
    const releasedAt=index===4?dates.late_release:dates.early_release;
    const attestation=(await pool.query<{id:string}>(`INSERT INTO commerce_fulfillment_attestation
      (order_id,source_kind,source_reference,evidence_sha256,request_key,request_hash,delivered_at,
        release_policy_version,proposed_by_member_id,reviewed_by_member_id,decision_key,decision_hash,
        decision_reason,state,version,decided_at)
      VALUES($1,'isolated_manual_fixture',$2,$3,$4,$5,$6,'isolated-delivery-v1',
        $7,$8,$9,$10,'合成履约复核','verified',2,$11) RETURNING id`,
      [order.id,`cycle-delivery-${index}-001`,"a".repeat(64),`cycle-release-${index}-001`,
        "b".repeat(64),new Date(releasedAt.getTime()-8*86_400_000),operator,buyer,
        `cycle-decision-${index}-001`,"c".repeat(64),releasedAt])).rows[0]!.id;
    await pool.query(`INSERT INTO commission_ledger_entry
      (order_id,referrer_member_id,event_key,kind,amount_cents,source_fact_id,actor_principal_id,occurred_at)
      VALUES($1,$2,$3,'release',2000,$4,'fixture:verified-release',$5)`,
      [order.id,referrer,`cycle-release-ledger-${index}-001`,attestation,releasedAt]);
  }
  const earlier=await cycles.prepare(operator,dates.earlier);
  expect(earlier.members).toEqual([]);
  const later=await cycles.prepare(operator,dates.later);
  expect(later).toMatchObject({payable:false,state:"blocked_tax_and_payout_policy",
    members:[{memberId:referrer,grossCents:10000,orderCount:5,withholdingCents:null,netCents:null}]});
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_settlement_cycle_candidate
    WHERE cycle_id=$1`,[later.id])).rows[0].n).toBe(5);
  await expect(pool.query(`UPDATE commission_settlement_cycle_candidate SET gross_cents=1 WHERE cycle_id=$1`,
    [later.id])).rejects.toMatchObject({code:"55000"});
  const checker=(await pool.query("INSERT INTO member(display_name) VALUES('Cycle independent checker') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'commission.settlement.approve','fixture','Cycle independent decision','test','integration_fixture')`,[checker]);
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram',$2,'cycle-payee-openid','wechat')`,[referrer,appId]);
  const commands=new SettlementCommandService(pool,new AuthorityService(pool,"test"),
    {} as WechatPayV3Client,"test",{appId,merchantId,sceneId:"ISOLATED_CYCLE",
      notifyUrl:"https://fixture.invalid/v1/payments/wechat/transfer-callback"});
  const intent=await commands.request(referrer,"cycle-intent-0001",
    {amountCents:10000,reason:"合成会员申请仅作意向"});
  await expect(commands.decide(checker,intent.id,"cycle-direct-approval-0001",
    {decision:"approve",expectedVersion:1,reason:"直接申请不得绕过周期批次"}))
    .rejects.toMatchObject({code:"SETTLEMENT_CYCLE_REQUIRED"});
  await expect(commands.approveCycleMember(operator,later.id,"cycle-self-check-0001",
    {memberId:referrer,taxPolicyVersion:"isolated-synthetic-zero-withholding-v1",reason:"同人不得复核周期"}))
    .rejects.toMatchObject({code:"SETTLEMENT_CYCLE_SELF_APPROVAL_FORBIDDEN"});
  await expect(commands.approveCycleMember(checker,later.id,"cycle-bad-tax-0001",
    {memberId:referrer,taxPolicyVersion:"real-zero-tax",reason:"未经批准税务口径"}))
    .rejects.toMatchObject({code:"SETTLEMENT_TAX_POLICY_NOT_APPROVED"});
  const payload={memberId:referrer,taxPolicyVersion:"isolated-synthetic-zero-withholding-v1",
    reason:"独立复核五笔历史来源与合成税务"};
  const approved=await commands.approveCycleMember(checker,later.id,"cycle-approved-0001",payload);
  expect(approved).toMatchObject({cycleId:later.id,amountCents:10000,grossCents:10000,
    withholdingCents:0,taxPolicyVersion:payload.taxPolicyVersion,state:"reserved",replay:false});
  expect(await commands.approveCycleMember(checker,later.id,"cycle-approved-0001",payload))
    .toMatchObject({id:approved.id,replay:true});
  expect(await cycles.prepare(operator,dates.later)).toMatchObject({replay:true,
    members:[{memberId:referrer,requestId:approved.id,requestState:"reserved",
      grossCents:10000,withholdingCents:0,netCents:10000}]});
  expect((await pool.query(`SELECT count(*)::int AS n,sum(amount_cents)::text AS gross
    FROM commission_settlement_allocation WHERE request_id=$1`,[approved.id])).rows[0])
    .toMatchObject({n:5,gross:"10000"});
  await expect(pool.query(`UPDATE commission_settlement_request SET gross_cents=10001 WHERE id=$1`,
    [approved.id])).rejects.toMatchObject({code:"55000"});
  // This independent fixture owns its reservation and closes it before the
  // following test's source-allocation race; it never sends a channel request.
  await pool.query(`UPDATE commission_settlement_request SET state='cancelled',
    finalized_at=clock_timestamp() WHERE id=$1`,[approved.id]);
  const historical=new SettlementCommandService(pool,new AuthorityService(pool,"test"),
    {} as WechatPayV3Client,"test",{appId,merchantId,sceneId:"ISOLATED_CYCLE",
      notifyUrl:"https://fixture.invalid/v1/payments/wechat/transfer-callback",
      legacyDirectFixture:true});
  const oldIntent=await historical.request(referrer,"cycle-old-fixture-intent-001",
    {amountCents:100,reason:"旧版转账协议仅供回归测试"});
  const oldReserved=await historical.decide(checker,oldIntent.id,"cycle-old-fixture-approve-001",
    {decision:"approve",expectedVersion:1,reason:"测试旧版意向不会在默认 worker 发款"});
  expect(oldReserved.state).toBe("reserved");
  expect(await commands.processDue()).toEqual([]);
  expect((await pool.query("SELECT state,cycle_id FROM commission_settlement_request WHERE id=$1",
    [oldReserved.id])).rows[0]).toMatchObject({state:"reserved",cycle_id:null});
  await pool.query(`UPDATE commission_settlement_request SET state='cancelled',
    finalized_at=clock_timestamp() WHERE id=$1`,[oldReserved.id]);
});

it("preserves discounted signed channel payment without posting unsupported cash commission",async()=>{
  const order=await seedOrder("105"),transactionId="420000000000000000000150";
  const paidAt=new Date(order.createdAt.getTime()+1000).toISOString();
  const discounted=notification(order.number,transactionId,"EV-20260912-COUPON-0150",paidAt,9000);
  const received=await processor.receive(discounted.rawBody,discounted.headers);
  expect(received).toMatchObject({persisted:true,state:"pending"});
  expect(await processor.processOne(received.inboxId)).toBe("exception");
  expect((await pool.query(`SELECT amount_cents,payer_total_cents,composition_status,exception_code
    FROM commission_payment_inbox WHERE id=$1`,[received.inboxId])).rows[0]).toMatchObject({
    amount_cents:"10000",payer_total_cents:"9000",composition_status:"unknown_or_discounted",
    exception_code:"PAYMENT_COMPOSITION_UNSUPPORTED"});
  expect((await pool.query(`SELECT status FROM commerce_order WHERE id=$1`,[order.id])).rows[0].status)
    .toBe("pending_payment");
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1`,
    [order.id])).rows[0].n).toBe(0);
  // A later differently-composed signed observation remains immutable and
  // explicitly requires finance reconciliation; it cannot auto-clear the hold.
  const followUp=notification(order.number,transactionId,"EV-20260912-QUERY-0150",paidAt);
  expect(await processor.receive(followUp.rawBody,followUp.headers))
    .toMatchObject({persisted:true,inboxId:received.inboxId,state:"exception"});
  expect((await pool.query(`SELECT composition_status,payer_total_cents FROM
    commission_payment_composition_observation WHERE order_id=$1`,[order.id])).rows[0])
    .toMatchObject({composition_status:"full_cash",payer_total_cents:"10000"});
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1`,
    [order.id])).rows[0].n).toBe(0);
});

it("converts only released source lots 1:1, arbitrates cash reservation, and restores unused credit without rewriting history",async()=>{
  const credit=new ShoppingCreditService(pool,"test");
  const fixture={amountCents:8000,confirmed:true,taxPolicyVersion:"isolated-synthetic-zero-withholding-v1"};
  await expect(new ShoppingCreditService(pool,"staging").convert(referrer,"stage-denied",fixture))
    .rejects.toMatchObject({code:"SHOPPING_CREDIT_LIVE_DISABLED"});
  await expect(credit.convert(referrer,"consent-missing",{...fixture,confirmed:false}))
    .rejects.toMatchObject({code:"CREDIT_CONSENT_AND_TAX_FIXTURE_REQUIRED"});
  const first=await credit.convert(referrer,"credit-source-0001",fixture);
  expect(first).toMatchObject({amountCents:8000,grossCents:8000,withholdingCents:0,
    state:"available",taxPolicyVersion:fixture.taxPolicyVersion});
  expect(await credit.convert(referrer,"credit-source-0001",fixture)).toMatchObject({id:first.id});
  await expect(credit.convert(referrer,"credit-source-0001",{...fixture,amountCents:7000}))
    .rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  const sources=(await pool.query<{amount_cents:string;order_id:string}>(`SELECT order_id,amount_cents
    FROM commission_credit_source WHERE conversion_id=$1 ORDER BY order_id`,[first.id])).rows;
  expect(sources).toHaveLength(4);
  expect(sources.reduce((sum,row)=>sum+Number(row.amount_cents),0)).toBe(8000);
  const movements=(await pool.query<{kind:string;amount_cents:string}>(`SELECT kind,amount_cents
    FROM commission_ledger_entry WHERE source_fact_id=$1 ORDER BY kind`,[first.id])).rows;
  expect(movements).toHaveLength(4);
  expect(movements.every(row=>row.kind==="credit_conversion"&&Number(row.amount_cents)===2000)).toBe(true);
  await expect(credit.cancel(buyer,first.id,"other-owner-cancel"))
    .rejects.toMatchObject({code:"CREDIT_CONVERSION_NOT_FOUND"});
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram',$2,'verified-referrer-credit-openid','wechat')`,[referrer,appId]);
  const operator=(await pool.query("INSERT INTO member(display_name) VALUES('Credit checkout reviewer') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'commission.settlement.approve','fixture','Credit race fixture','test','integration_fixture')`,[operator]);
  // Use the real authority service, but no channel request is made by request/decide.
  const reviewerSettlement=new SettlementCommandService(pool,new AuthorityService(pool,"test"),
    {} as WechatPayV3Client,"test",{appId,merchantId,sceneId:"ISOLATED_CREDIT_TEST",
      notifyUrl:"https://fixture.invalid/v1/payments/wechat/transfer-callback",legacyDirectFixture:true});
  const request=await reviewerSettlement.request(referrer,"credit-race-settle",{amountCents:2000,reason:"测试并发现金预占"});
  const outcomes=await Promise.allSettled([
    reviewerSettlement.decide(operator,request.id,"credit-race-approve",{decision:"approve",expectedVersion:1,
      reason:"并发锁校验来源"}),
    credit.convert(referrer,"credit-race-convert",{...fixture,amountCents:2000})
  ]);
  expect(outcomes.filter(outcome=>outcome.status==="fulfilled")).toHaveLength(1);
  expect(outcomes.filter(outcome=>outcome.status==="rejected")).toHaveLength(1);
  await expect(credit.convert(referrer,"credit-overdraw-1",{...fixture,amountCents:1}))
    .rejects.toMatchObject({code:"CREDIT_SOURCE_INSUFFICIENT"});
  const reversed=await credit.cancel(referrer,first.id,"credit-cancel-0001");
  expect(reversed.state).toBe("cancelled");
  expect((await credit.cancel(referrer,first.id,"credit-cancel-0001")).state).toBe("cancelled");
  await expect(credit.cancel(referrer,first.id,"credit-cancel-0002"))
    .rejects.toMatchObject({code:"CREDIT_CONVERSION_ALREADY_CANCELLED"});
  expect((await pool.query(`SELECT COALESCE(sum(amount_cents),0)::text AS total
    FROM commission_ledger_entry WHERE source_fact_id=$1`,[first.id])).rows[0].total).toBe("0");
  expect((await pool.query(`SELECT COALESCE(sum(e.amount_cents),0)::text AS total
    FROM commission_credit_entry e JOIN commission_credit_source s ON s.id=e.source_id
    WHERE s.conversion_id=$1`,[first.id])).rows[0].total).toBe("0");
  const later=await credit.convert(referrer,"credit-later-0001",{...fixture,amountCents:1});
  const page=await credit.listMine(referrer,{limit:"1"});
  expect(page).toMatchObject({totalCount:expect.any(Number),spendable:true,availableCents:1,
    redemptionStatus:"ISOLATED_TEST_ONLY",items:[{id:later.id,availableCents:1}]});
  expect(page.nextCursor).toBeTruthy();
  const continued=await credit.listMine(referrer,{limit:"1",cursor:page.nextCursor!});
  expect(continued.items[0]?.id).not.toBe(later.id);
  expect((await credit.listMine(buyer)).totalCount).toBe(0);
  const affected=(await pool.query<{order_id:string;order_number:string;provider_transaction_id:string;created_at:Date}>(`
    SELECT s.order_id,o.order_number,p.provider_transaction_id,o.created_at
    FROM commission_credit_source s JOIN commerce_order o ON o.id=s.order_id
    JOIN commission_payment_inbox p ON p.order_id=o.id AND p.state='applied'
    WHERE s.conversion_id=$1`,[later.id])).rows[0]!;
  const paidId=(await pool.query<{id:string}>(`SELECT id FROM commission_payment_inbox
    WHERE order_id=$1 AND state='applied'`,[affected.order_id])).rows[0]!.id;
  const refundNumber="RF20260912CREDIT0001";
  await refundIntent({orderId:affected.order_id,paymentId:paidId,refundNumber,refundCents:10000});
  const signed=refundNotification({orderNumber:affected.order_number,
    transactionId:affected.provider_transaction_id,refundNumber,
    providerRefundId:"500000000000000000000151",eventId:"EV-20260912-CREDIT-R151",
    refundCents:10000,status:"SUCCESS",successTime:new Date(Date.now()+1000).toISOString()});
  const refunded=await refunds.receive(signed.rawBody,signed.headers);
  expect(await refunds.processOne(refunded.inboxId)).toBe("applied");
  expect(await refunds.processOne(refunded.inboxId)).toBe("applied");
  const sourceBalance=(await pool.query<{balance:string;frozen:string}>(`SELECT
    sum(e.amount_cents)::text AS balance,
    COALESCE(-sum(e.amount_cents) FILTER(WHERE e.kind='freeze'),0)::text AS frozen
    FROM commission_credit_entry e JOIN commission_credit_source s ON s.id=e.source_id
    WHERE s.conversion_id=$1`,[later.id])).rows[0]!;
  expect(sourceBalance.balance).toBe("0");
  expect(sourceBalance.frozen).toBe("1");
  expect((await credit.listMine(referrer)).items.find(item=>item.id===later.id)?.availableCents).toBe(0);
  await expect(credit.cancel(referrer,later.id,"credit-frozen-cancel-0001"))
    .rejects.toMatchObject({code:"CREDIT_ALREADY_USED_OR_FROZEN"});
});

it('durably fences shipping dispatch, reconciles uncertain uploads and preserves independent order facts',async()=>{
  const {ShippingSyncService}=await import('../../services/api/src/shippingSync.js');
  const actor=(await pool.query("INSERT INTO member(display_name) VALUES('Synthetic shipping operator') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'commerce.fulfillment.manage','fixture','Synthetic shipping sync','test','integration_fixture')`,[actor]);
  const options={enabled:true,appId,merchantId,encryptionKey:'71'.repeat(32),hashKey:'82'.repeat(32),keyVersion:'shipping-test-v1'};
  const parcel={trackingNumber:'SYNTHETIC-SHIP-0001',carrierCode:'SF',description:'合成商品 × 1',receiverContactMasked:'****1234'};
  let uploaded=0,queries=0,seen=false;
  const channel={query:async()=>{queries++;return {decision:seen?'matched' as const:'not_uploaded' as const,platformOrderState:seen?2:1,inComplaint:false};},
    uploadOnce:async()=>{uploaded++;seen=true;throw new Error('Synthetic response lost after platform commit');}};
  const service=new ShippingSyncService(pool,new AuthorityService(pool,'test'),options,channel);
  await pool.query('UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+20 WHERE sku_id=$1',[sku]);
  const order=await seedOrder('SHIP01',null);
  await expect(service.prepare(actor,order.id,'shipping-before-paid-01',parcel,'carrier-proof-fixture'))
    .rejects.toMatchObject({code:'SHIPPING_SETTLED_ORDER_REQUIRED'});
  const paid=notification(order.number,'42000000000000000000SHIP01','EV-SHIPPING-000001',new Date().toISOString());
  const inbox=await processor.receive(paid.rawBody,paid.headers);expect(await processor.processOne(inbox.inboxId)).toBe('applied');
  await expect(service.prepare(buyer,order.id,'shipping-no-role-0001',parcel,'carrier-proof-fixture')).rejects.toThrow();
  const proposal=await service.prepare(actor,order.id,'shipping-idempotent-01',parcel,'carrier-proof-fixture');
  expect(await service.prepare(actor,order.id,'shipping-idempotent-01',parcel,'carrier-proof-fixture')).toEqual(proposal);
  await expect(service.prepare(actor,order.id,'shipping-idempotent-01',{...parcel,trackingNumber:'OTHER'},'carrier-proof-fixture'))
    .rejects.toMatchObject({code:'SHIPPING_PROPOSAL_CONFLICT'});
  const stored=(await pool.query('SELECT encrypted_parcel FROM commerce_shipping_sync WHERE id=$1',[proposal.id])).rows[0];
  expect(stored.encrypted_parcel).not.toContain(parcel.trackingNumber);expect(stored.encrypted_parcel).not.toContain('1234');
  const concurrent=await Promise.all([service.processOne(proposal.id),service.processOne(proposal.id)]);
  expect(concurrent).toContain('verifying');expect(uploaded).toBe(1);
  await pool.query("UPDATE commerce_shipping_sync SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[proposal.id]);
  expect(await service.processOne(proposal.id)).toBe('synced');expect(uploaded).toBe(1);expect(queries).toBe(2);
  expect(await service.processOne(proposal.id)).toBe('idle');
  await expect(pool.query("UPDATE commerce_shipping_sync SET state='prepared',dispatched_at=NULL WHERE id=$1",[proposal.id])).rejects.toThrow();
  expect((await pool.query('SELECT status FROM commerce_order WHERE id=$1',[order.id])).rows[0].status).toBe('paid');
  expect((await pool.query('SELECT count(*)::int n FROM commerce_fulfillment_attestation WHERE order_id=$1',[order.id])).rows[0].n).toBe(0);

  const crashed=await seedOrder('SHIP03',null);
  const crashEvent=notification(crashed.number,'42000000000000000000SHIP03','EV-SHIPPING-000003',new Date().toISOString());
  const crashPaid=await processor.receive(crashEvent.rawBody,crashEvent.headers);expect(await processor.processOne(crashPaid.inboxId)).toBe('applied');
  const crashJob=await service.prepare(actor,crashed.id,'shipping-crash-recovery-01',parcel,'carrier-proof-fixture');
  await pool.query(`UPDATE commerce_shipping_sync SET state='dispatching',dispatched_at=now(),
    claim_token=gen_random_uuid(),lease_until=now()-interval '1 minute' WHERE id=$1`,[crashJob.id]);
  seen=false; // Even a lagging provider read must never authorize a second upload.
  for(let attempt=1;attempt<=5;attempt++){
    await pool.query("UPDATE commerce_shipping_sync SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[crashJob.id]);
    expect(await service.processOne(crashJob.id)).toBe(attempt<5?'verifying':'manual_review');
  }
  expect(uploaded).toBe(1);

  const next=await seedOrder('SHIP02',null);
  const event=notification(next.number,'42000000000000000000SHIP02','EV-SHIPPING-000002',new Date().toISOString());
  const received=await processor.receive(event.rawBody,event.headers);expect(await processor.processOne(received.inboxId)).toBe('applied');
  const pending=await service.prepare(actor,next.id,'shipping-revoke-role-01',parcel,'carrier-proof-fixture');
  await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='fixture',revoke_reason='Synthetic revocation' WHERE member_id=$1 AND capability='commerce.fulfillment.manage'",[actor]);
  expect(await service.processOne(pending.id)).toBe('manual_review');expect(uploaded).toBe(1);
});

it('commits local shipment and WeChat intent together without network I/O; receipt stays independent',async()=>{
  const {loadConfig}=await import('@cisme/config');
  const {ShippingSyncService}=await import('../../services/api/src/shippingSync.js');
  const {OrderFulfillmentService}=await import('../../services/api/src/orderFulfillment.js');
  const {DeliveryAddressService}=await import('../../services/api/src/deliveryAddress.js');
  const {TEST_DATABASE_URL}=await import('@cisme/testkit');
  const actor=(await pool.query("INSERT INTO member(display_name) VALUES('Synthetic warehouse operator') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'commerce.fulfillment.manage','fixture','Synthetic local shipment','test','integration_fixture')`,[actor]);
  const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'local-shipping-fixture',
    UPLOAD_TOKEN_SECRET:'local-shipping-upload',CONTACT_ENCRYPTION_KEY:'31'.repeat(32),CONTACT_HASH_KEY:'32'.repeat(32)});
  const addresses=new DeliveryAddressService(pool,config),authority=new AuthorityService(pool,'test');
  let networkCalls=0;
  const sync=new ShippingSyncService(pool,authority,{enabled:true,appId,merchantId,encryptionKey:'41'.repeat(32),hashKey:'42'.repeat(32),keyVersion:'local-shipping-v1'},
    {query:async()=>{networkCalls++;throw Error('Synthetic offline');},uploadOnce:async()=>{networkCalls++;return {acknowledged:true as const};}});
  const service=new OrderFulfillmentService(pool,authority,addresses,sync,true);
  const dbNow=async()=>new Date((await pool.query('SELECT clock_timestamp() AS time')).rows[0].time);
  const order=await seedOrder('LOCALSHIP01',null,await dbNow());
  const input={carrierCode:'SF',carrierName:'顺丰速运',trackingNumber:'SF123456789001',shippedAt:new Date().toISOString(),evidenceReference:'synthetic-handover-001',expectedOrderVersion:1};
  await expect(service.dispatch(actor,order.id,'local-shipment-0001',input)).rejects.toMatchObject({code:'SHIPMENT_PAID_ORDER_REQUIRED'});
  const paid=notification(order.number,'420000000000000LOCALSHIP01','EV-LOCAL-SHIPPING-01',(await dbNow()).toISOString());
  const received=await processor.receive(paid.rawBody,paid.headers);expect(await processor.processOne(received.inboxId)).toBe('applied');
  input.expectedOrderVersion=(await pool.query('SELECT version FROM commerce_order WHERE id=$1',[order.id])).rows[0].version;
  input.shippedAt=(await dbNow()).toISOString();
  const sealed=addresses.sealOrderSnapshot(buyer,order.id,{recipientName:'合成收件人',phone:'13800000000',province:'上海市',city:'上海市',district:'浦东新区',detail:'测试地址1号',postalCode:'200000',nationalCode:'310115',provinceCode:'310000',cityCode:'310100',districtCode:'310115'});
  await pool.query(`INSERT INTO commerce_order_address(order_id,encrypted_payload,payload_hmac,key_version,source_address_id,source_address_version)
    VALUES($1,$2,$3,$4,$5,1)`,[order.id,sealed.encryptedPayload,sealed.payloadHmac,sealed.keyVersion,addressId]);
  await expect(service.dispatch(buyer,order.id,'local-shipment-0001',input)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
  await expect(service.dispatch(actor,order.id,'local-shipment-invalid',{...input,trackingNumber:'=CMD()'})).rejects.toMatchObject({code:'SHIPMENT_INPUT_INVALID'});
  const [one,two]=await Promise.all([service.dispatch(actor,order.id,'local-shipment-0001',input),service.dispatch(actor,order.id,'local-shipment-0001',input)]);
  expect(one).toEqual(two);expect(networkCalls).toBe(0);
  expect((await pool.query('SELECT count(*)::int n FROM commerce_shipment WHERE order_id=$1',[order.id])).rows[0].n).toBe(1);
  expect((await pool.query('SELECT quantity FROM commerce_shipment_line WHERE shipment_id=$1',[one.id])).rows).toEqual([{quantity:1}]);
  await expect(service.dispatch(actor,order.id,'local-shipment-0001',{...input,trackingNumber:'SF123456789002'})).rejects.toMatchObject({code:'SHIPMENT_IDEMPOTENCY_CONFLICT'});
  await expect(service.detailMine(referrer,order.id)).rejects.toMatchObject({code:'ORDER_NOT_FOUND'});
  expect(await service.detailMine(buyer,order.id)).toMatchObject({trackingNumber:input.trackingNumber,logisticsState:'shipped',wechatSyncState:'prepared',receiptConfirmedAt:null});
  const job=(await pool.query('SELECT shipping_sync_id FROM commerce_shipment WHERE id=$1',[one.id])).rows[0].shipping_sync_id;
  expect(await sync.processOne(job)).toBe('prepared');
  expect(await service.detailMine(buyer,order.id)).toMatchObject({logisticsState:'shipped',wechatSyncState:'prepared'});
  await expect(service.dispatchBatch(actor,'batch-invalid-01',[{orderId:order.id,...input},{orderId:order.id,...input}])).rejects.toMatchObject({code:'SHIPMENT_BATCH_DUPLICATE_ORDER'});
  await expect(service.importRows(actor,'import-invalid-01',`${order.number}\tSF\t顺丰速运\tSF123456789001\t${input.shippedAt}\nWRONGORDER001\tSF\t顺丰速运\tSF123456789002\t${input.shippedAt}`)).rejects.toMatchObject({code:'SHIPMENT_IMPORT_ORDER_NOT_FOUND'});
  const batch=await service.dispatchBatch(actor,'batch-mixed-001',[{orderId:order.id,...input},{orderId:randomUUID(),...input}]);
  expect(batch.results.map(r=>r.status)).toEqual(['rejected','rejected']);
  expect(await service.managementList(actor,{state:'shipped',orderNumber:order.number})).toMatchObject({items:[{id:order.id,logisticsState:'shipped'}]});
  await expect(service.managementList(buyer,{state:'all'},true)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
  const exported=await service.managementList(actor,{state:'shipped',orderNumber:order.number},true);
  expect(exported.workbook?.subarray(0,2).toString()).toBe('PK');
  const audit=(await pool.query("SELECT principal_id,after_state,created_at FROM audit_log WHERE action='commerce.shipment.export' AND principal_id=$1",[`member:${actor}`])).rows;
  expect(audit).toHaveLength(1);expect(audit[0].after_state.count).toBe(1);expect(JSON.stringify(audit)).not.toContain('13800000000');
  await expect(pool.query("UPDATE commerce_order SET fulfillment_policy='{}' WHERE id=$1",[order.id])).rejects.toThrow('FULFILLMENT_PROMISE_IMMUTABLE');
  await expect(pool.query("UPDATE commerce_checkout_quote SET fulfillment_policy='{}' WHERE id=(SELECT source_quote_id FROM commerce_order WHERE id=$1)",[order.id])).rejects.toThrow('FULFILLMENT_PROMISE_IMMUTABLE');
  const ledgerBefore=(await pool.query('SELECT count(*)::int n FROM commission_ledger_entry')).rows[0].n;
  await expect(service.confirmReceipt(referrer,order.id,'local-receipt-0001',1)).rejects.toMatchObject({code:'ORDER_NOT_FOUND'});
  const receipt=await service.confirmReceipt(buyer,order.id,'local-receipt-0001',1);
  expect(await service.confirmReceipt(buyer,order.id,'local-receipt-0001',1)).toEqual(receipt);
  expect(await service.detailMine(buyer,order.id)).toMatchObject({version:2,logisticsState:'shipped',deliveredAt:null,receiptConfirmedAt:receipt.receiptConfirmedAt});
  expect((await pool.query('SELECT status FROM commerce_order WHERE id=$1',[order.id])).rows[0].status).toBe('paid');
  expect((await pool.query('SELECT count(*)::int n FROM commission_ledger_entry')).rows[0].n).toBe(ledgerBefore);
  await expect(pool.query('DELETE FROM commerce_shipment_line WHERE shipment_id=$1',[one.id])).rejects.toThrow();
  await expect(pool.query('UPDATE commerce_shipment SET receipt_confirmed_at=NULL,version=version+1 WHERE id=$1',[one.id])).rejects.toThrow();
  const revoke=await pool.connect();await revoke.query('BEGIN');
  await revoke.query("UPDATE authority_grant SET revoked_at=clock_timestamp(),revoked_by='fixture' WHERE member_id=$1 AND capability='commerce.fulfillment.manage'",[actor]);
  const racing=service.managementList(actor,{state:'all'},true);
  const denied=expect(racing).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
  await revoke.query('COMMIT');revoke.release();await denied;
  expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='commerce.shipment.export' AND principal_id=$1",[`member:${actor}`])).rows[0].n).toBe(1);

});

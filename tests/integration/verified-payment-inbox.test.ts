import { createCipheriv, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resetDatabase, testPool } from "@cisme/testkit";
import { VerifiedPaymentInbox } from "../../services/api/src/verifiedPaymentInbox";
import { expirePendingOrders } from "../../services/api/src/commerceOrders";

const pool=testPool();
const platform=generateKeyPairSync("rsa",{modulusLength:2048});
const publicPem=platform.publicKey.export({type:"spki",format:"pem"}).toString();
const appId="wx4eac2d4fb11d299b",merchantId="1234567890",apiV3Key="0123456789abcdef0123456789abcdef";
const processor=new VerifiedPaymentInbox(pool,{appId,merchantId,apiV3Key,
  platformKeys:new Map([["PUB_KEY_ID_3000000001",publicPem]])});
let buyer:string,referrer:string,sku:string,product:string,codeId:string,ruleId:string,addressId:string;

async function seedOrder(suffix:string,commissionBasis=10000){
  const quoteId=randomUUID(),orderId=randomUUID(),number=`CM20260912${suffix.padStart(12,"0")}`;
  const now=new Date(),expires=new Date(now.getTime()+60*60_000);
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
  await pool.query(`INSERT INTO commerce_order_line(order_id,line_number,product_id,sku_id,product_code,
    product_name,sku_code,sku_label,quantity,unit_price_cents,line_subtotal_cents,line_discount_cents,
    line_total_cents) VALUES($1,1,$2,$3,'verified-product','Verified fixture','VERIFIED_SKU','One',1,10000,10000,0,10000)`,
    [orderId,product,sku]);
  await pool.query(`INSERT INTO commerce_inventory_reservation(order_id,sku_id,quantity,expires_at)
    VALUES($1,$2,1,$3)`,[orderId,sku,expires]);
  await pool.query(`UPDATE catalog_inventory_level SET reserved_quantity=reserved_quantity+1 WHERE sku_id=$1`,[sku]);
  await pool.query(`INSERT INTO commission_order_snapshot(order_id,buyer_member_id,referrer_member_id,
    referral_code_id,rate_rule_id,basis_points,cash_merchandise_cents,source_kind)
    VALUES($1,$2,$3,$4,$5,2000,$6,'verified_commerce')`,[orderId,buyer,referrer,codeId,ruleId,commissionBasis]);
  return {id:orderId,number,createdAt:now,expiresAt:expires};
}
function notification(orderNumber:string,transactionId:string,eventId:string,successTime:string){
  const transaction={appid:appId,mchid:merchantId,out_trade_no:orderNumber,
    transaction_id:transactionId,trade_type:"JSAPI",trade_state:"SUCCESS",success_time:successTime,
    amount:{total:10000,currency:"CNY"},payer:{openid:"verified-buyer-openid"}};
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
    VALUES($1,3,'fixture')`,[sku]);
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
    .toMatchObject({stock_on_hand:2,reserved_quantity:0});
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

/** Synthetic, owned-run fixture only. Uses the real signed payment inbox to
 * establish a paid order; never changes an existing order's source/status. */
import {createCipheriv,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import type pg from 'pg';
import type {AppConfig} from '@cisme/config';
import {DeliveryAddressService} from '../services/api/src/deliveryAddress.js';
import {VerifiedPaymentInbox} from '../services/api/src/verifiedPaymentInbox.js';

export async function nativeFulfillmentFixture(pool:pg.Pool,config:AppConfig,templateId:string){
 const run=process.env.CISME_TEST_RUN_ID;
 const target=(await pool.query('SELECT current_database() name')).rows[0].name;
 if(config.env!=='test'||!run||target!==`cisme_test_${run}`)throw Error('OWNED_SYNTHETIC_FIXTURE_REQUIRED');
 const ownership=(await pool.query('SELECT run_id,token,purpose,reset_authorized FROM cisme_test_control.ownership')).rows;
 if(ownership.length!==1||ownership[0].run_id!==run||ownership[0].token!==process.env.CISME_TEST_RESET_TOKEN||ownership[0].purpose!=='disposable-synthetic'||!ownership[0].reset_authorized)throw Error('OWNED_SYNTHETIC_FIXTURE_REQUIRED');
 const id=randomUUID(),quote=randomUUID(),number='CM20260922'+randomBytes(6).toString('hex').toUpperCase();
 const template=(await pool.query('SELECT * FROM commerce_order WHERE id=$1',[templateId])).rows[0];
 if(!template||template.transaction_source_kind!=='synthetic_nonproduction'||Number(template.credit_tender_cents)!==0)throw Error('SYNTHETIC_TEMPLATE_REQUIRED');
 await pool.query(`INSERT INTO commerce_checkout_quote(id,member_id,product_id,sku_id,address_id,address_version,quantity,currency,
 unit_price_cents,subtotal_cents,member_discount_cents,shipping_cents,total_cents,pricing_rule_version,product_version,sku_version,
 price_version,status,idempotency_key,request_hash,expires_at,consumed_at,fulfillment_policy)
 SELECT $1,member_id,product_id,sku_id,address_id,address_version,quantity,currency,unit_price_cents,subtotal_cents,member_discount_cents,
 shipping_cents,total_cents,pricing_rule_version,product_version,sku_version,price_version,'consumed',$2,request_hash,
 clock_timestamp()+interval '2 hours',clock_timestamp(),fulfillment_policy FROM commerce_checkout_quote WHERE id=$3`,[quote,`native-fulfillment-${id}`,template.source_quote_id]);
 await pool.query(`INSERT INTO commerce_order(id,order_number,member_id,source_quote_id,status,currency,subtotal_cents,member_discount_cents,
 shipping_cents,total_cents,pricing_rule_version,expires_at,transaction_source_kind,fulfillment_policy)
 SELECT $1,$2,member_id,$3,'pending_payment',currency,subtotal_cents,member_discount_cents,shipping_cents,total_cents,
 pricing_rule_version,clock_timestamp()+interval '2 hours','verified_commerce',fulfillment_policy FROM commerce_order WHERE id=$4`,[id,number,quote,templateId]);
 await pool.query(`INSERT INTO commerce_order_line(order_id,line_number,product_id,sku_id,product_code,product_name,sku_code,sku_label,
 quantity,unit_price_cents,line_subtotal_cents,line_discount_cents,line_total_cents)
 SELECT $1,line_number,product_id,sku_id,product_code,product_name,sku_code,sku_label,quantity,unit_price_cents,line_subtotal_cents,
 line_discount_cents,line_total_cents FROM commerce_order_line WHERE order_id=$2`,[id,templateId]);
 await pool.query(`INSERT INTO commerce_inventory_reservation(order_id,sku_id,quantity,expires_at)
 SELECT $1,sku_id,quantity,clock_timestamp()+interval '2 hours' FROM commerce_inventory_reservation WHERE order_id=$2`,[id,templateId]);
 await pool.query(`UPDATE catalog_inventory_level i SET reserved_quantity=i.reserved_quantity+r.quantity
 FROM commerce_inventory_reservation r WHERE r.order_id=$1 AND r.sku_id=i.sku_id`,[id]);
 const addresses=new DeliveryAddressService(pool,config),source=(await pool.query('SELECT * FROM commerce_order_address WHERE order_id=$1',[templateId])).rows[0];
 const parcel=addresses.openOrderSnapshot(template.member_id,templateId,source.encrypted_payload,source.payload_hmac,source.key_version);
 const sealed=addresses.sealOrderSnapshot(template.member_id,id,parcel);
 await pool.query(`INSERT INTO commerce_order_address(order_id,encrypted_payload,payload_hmac,key_version,source_address_id,source_address_version)
 VALUES($1,$2,$3,$4,$5,$6)`,[id,sealed.encryptedPayload,sealed.payloadHmac,sealed.keyVersion,source.source_address_id,source.source_address_version]);
 const appId=config.commerce.fulfillment!.appId,merchantId=config.commerce.fulfillment!.merchantId,payer='synthetic-native-payer';
 await pool.query(`INSERT INTO commerce_payment_attempt(order_id,out_trade_no,member_id,payer_openid,app_id,merchant_id,amount_cents,currency,
 quote_id,pricing_rule_version,quote_price_version,expires_at) SELECT $1,$2,member_id,$3,$4,$5,total_cents,'CNY',id,pricing_rule_version,price_version,expires_at
 FROM commerce_checkout_quote WHERE id=$6`,[id,number,payer,appId,merchantId,quote]);
 const keys=generateKeyPairSync('rsa',{modulusLength:2048}),key=Buffer.from(randomBytes(16).toString('hex')),nonce=randomBytes(6).toString('hex'),aad='synthetic-native-fixture';
 const paidAt=(await pool.query('SELECT clock_timestamp() now')).rows[0].now.toISOString();
 const body={appid:appId,mchid:merchantId,out_trade_no:number,transaction_id:'420000'+randomBytes(12).toString('hex'),trade_type:'JSAPI',trade_state:'SUCCESS',
 success_time:paidAt,amount:{total:Number(template.total_cents),payer_total:Number(template.total_cents),currency:'CNY',payer_currency:'CNY'},payer:{openid:payer}};
 const cipher=createCipheriv('aes-256-gcm',key,Buffer.from(nonce));cipher.setAAD(Buffer.from(aad));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(body)),cipher.final(),cipher.getAuthTag()]).toString('base64');
 const raw=Buffer.from(JSON.stringify({id:`NATIVE-${id}`,event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',ciphertext,associated_data:aad,nonce,original_type:'transaction'}}));
 const stamp=String(Math.floor(Date.now()/1000)),requestNonce=randomBytes(16).toString('hex'),serial='PUB_KEY_ID_3000000001';
 const signature=sign('RSA-SHA256',Buffer.concat([Buffer.from(`${stamp}\n${requestNonce}\n`),raw,Buffer.from('\n')]),keys.privateKey).toString('base64');
 const inbox=new VerifiedPaymentInbox(pool,{appId,merchantId,apiV3Key:key.toString('utf8'),platformKeys:new Map([[serial,keys.publicKey.export({type:'spki',format:'pem'}).toString()]])});
 const received=await inbox.receive(raw,{'Wechatpay-Serial':serial,'Wechatpay-Timestamp':stamp,'Wechatpay-Nonce':requestNonce,'Wechatpay-Signature':signature});
 if(await inbox.processOne(received.inboxId)!=='applied')throw Error('SYNTHETIC_PAYMENT_NOT_APPLIED');
 return {id,number,paymentEvidence:'synthetic signed/encrypted notification applied through real inbox; no real provider or money'};
}

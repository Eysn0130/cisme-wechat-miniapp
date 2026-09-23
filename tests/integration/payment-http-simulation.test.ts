import { AftersaleService } from '../../services/api/src/aftersale.js';
import {DomainError} from "@cisme/domain";
import { createCipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";
import { VerifiedPaymentInbox } from "../../services/api/src/verifiedPaymentInbox";
import { VerifiedRefundInbox } from "../../services/api/src/verifiedRefundInbox";
import { WechatPayV3Client } from "../../services/api/src/wechatPayV3";
import { runMoneyWorkerCycle } from "../../services/worker/src/moneyJobs";
import { RefundCommandService } from "../../services/api/src/refundCommand";
import { AuthorityService } from "../../services/api/src/authority";
import { ManagementAttentionService } from "../../services/api/src/managementAttention";
import { SettlementCommandService } from "../../services/api/src/settlementCommand";
import { TransferCallbackInbox } from "../../services/api/src/transferCallbackInbox";
import { formalPaymentProtocol } from "../../services/api/src/formalPaymentProtocol";
import { ShoppingCreditService } from "../../services/api/src/shoppingCredit";

const pool=testPool();
const merchant=generateKeyPairSync("rsa",{modulusLength:2048});
const platform=generateKeyPairSync("rsa",{modulusLength:2048});
const merchantPrivate=merchant.privateKey.export({type:"pkcs8",format:"pem"}).toString();
const merchantPublic=merchant.publicKey.export({type:"spki",format:"pem"}).toString();
const platformPublic=platform.publicKey.export({type:"spki",format:"pem"}).toString();
const appId="wx4eac2d4fb11d299b",merchantId="1234567890",apiV3Key="0123456789abcdef0123456789abcdef";
const serial="PUB_KEY_ID_3000000001";
const channelOrders=new Map<string,{appid:string;mchid:string;openid:string;amount:number;
  state:"NOTPAY"|"SUCCESS"|"CLOSED";prepayId:string;transactionId:string;paidAt:string}>();
const channelRefunds=new Map<string,{outTradeNo:string;transactionId:string;amount:number;total:number;
  status:"PROCESSING"|"SUCCESS"|"CLOSED"|"ABNORMAL";refundId:string;succeededAt:string;acceptedAt:string}>();
const channelTransfers=new Map<string,{openid:string;amount:number;state:"WAIT_USER_CONFIRM"|"SUCCESS"|"FAIL";
  transferBillNo:string;remark:string}>();
const tradeBillFixtures=new Map<string,Buffer>();
let missingQueryBarrier:{orderNumber:string;entered:()=>void;wait:Promise<void>}|undefined;
let channelRequestCount=0;
let recheckAdmissionObservation:{target:string;visible:boolean[]}|undefined;
let corruptBillHash=false;
let loseNextRefundResponse=false;
let loseNextTransferResponse=false;
let server:ReturnType<typeof createServer>,app:FastifyInstance,baseUrl:string;
type TestActor={memberId:string;principalId:string;sessionToken:string};
let buyer:TestActor,skuId:string;
let operator:TestActor,referrer:TestActor,reviewer:TestActor;
let refundCommands:RefundCommandService,refundInbox:VerifiedRefundInbox,paymentInbox:VerifiedPaymentInbox;
let settlementCommands:SettlementCommandService;
let transferInbox:TransferCallbackInbox;
const auth=(token:string)=>({authorization:`Bearer ${token}`});

function signedHeaders(raw:Buffer){
  const timestamp=Math.floor(Date.now()/1000).toString(),nonce=randomBytes(16).toString("hex");
  const signature=sign("RSA-SHA256",Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`),raw,Buffer.from("\n")]),
    platform.privateKey).toString("base64");
  return {"Wechatpay-Serial":serial,"Wechatpay-Timestamp":timestamp,
    "Wechatpay-Nonce":nonce,"Wechatpay-Signature":signature};
}
function sendSigned(response:ServerResponse,status:number,payload:object){
  const raw=Buffer.from(JSON.stringify(payload));
  response.writeHead(status,{"Content-Type":"application/json",...signedHeaders(raw)});response.end(raw);
}
async function body(request:IncomingMessage){
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function channelHandler(request:IncomingMessage,response:ServerResponse){
  channelRequestCount++;
  if(recheckAdmissionObservation)recheckAdmissionObservation.visible.push(Boolean((await pool.query(
    "SELECT 1 FROM audit_log WHERE action='commerce.money.recheck_admitted' AND object_id=$1",
    [recheckAdmissionObservation.target])).rowCount));
  const raw=await body(request),path=request.url??"",method=request.method??"";
  const authorization=String(request.headers.authorization??"");
  const timestamp=authorization.match(/timestamp="(\d+)"/)?.[1],nonce=authorization.match(/nonce_str="([^"]+)"/)?.[1],
    signature=authorization.match(/signature="([^"]+)"/)?.[1];
  const valid=Boolean(timestamp&&nonce&&signature&&verify("RSA-SHA256",
    Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${raw.toString("utf8")}\n`),merchantPublic,
    Buffer.from(signature!,"base64")));
  if(!valid){sendSigned(response,401,{code:"SIGN_ERROR"});return;}
  const billApplication=path.match(/^\/v3\/bill\/tradebill\?bill_date=(\d{4}-\d{2}-\d{2})&bill_type=(SUCCESS|REFUND)$/);
  if(method==="GET"&&billApplication){
    const key=`${billApplication[1]}:${billApplication[2]}`,bytes=tradeBillFixtures.get(key);
    if(!bytes){sendSigned(response,404,{code:"BILL_NOT_FOUND"});return;}
    sendSigned(response,200,{hash_type:"SHA1",hash_value:corruptBillHash?"0".repeat(40):
      createHash("sha1").update(bytes).digest("hex"),download_url:`${baseUrl}/v3/billdownload/file?token=${encodeURIComponent(key)}`});return;
  }
  const billDownload=path.match(/^\/v3\/billdownload\/file\?token=(.+)$/);
  if(method==="GET"&&billDownload){
    const bytes=tradeBillFixtures.get(decodeURIComponent(billDownload[1]!));
    if(!bytes){response.writeHead(404);response.end();return;}
    response.writeHead(200,{"Content-Type":"application/octet-stream","Content-Length":String(bytes.length)});
    response.end(bytes);return;
  }
  if(method==="POST"&&path==="/v3/pay/transactions/jsapi"){
    const requestBody=JSON.parse(raw.toString("utf8")) as {appid:string;mchid:string;out_trade_no:string;
      payer:{openid:string};amount:{total:number}};
    if(requestBody.appid!==appId||requestBody.mchid!==merchantId){sendSigned(response,400,{code:"PARAM_ERROR"});return;}
    let order=channelOrders.get(requestBody.out_trade_no);
    if(!order){order={appid:requestBody.appid,mchid:requestBody.mchid,openid:requestBody.payer.openid,
      amount:requestBody.amount.total,state:"NOTPAY",prepayId:`wxfixture${randomBytes(16).toString("hex")}`,
      transactionId:`4200${randomBytes(12).toString("hex")}`,paidAt:""};channelOrders.set(requestBody.out_trade_no,order);}
    if(order.amount!==requestBody.amount.total||order.openid!==requestBody.payer.openid){sendSigned(response,409,{code:"OUT_TRADE_NO_USED"});return;}
    sendSigned(response,200,{prepay_id:order.prepayId});return;
  }
  const query=path.match(/^\/v3\/pay\/transactions\/out-trade-no\/([^/?]+)\?mchid=([^&]+)$/);
  if(method==="GET"&&query){
    const order=channelOrders.get(decodeURIComponent(query[1]!));
    if(!order){if(missingQueryBarrier?.orderNumber===decodeURIComponent(query[1]!)){missingQueryBarrier.entered();await missingQueryBarrier.wait;}sendSigned(response,404,{code:"ORDER_NOT_EXIST"});return;}
    sendSigned(response,200,{appid:order.appid,mchid:order.mchid,out_trade_no:decodeURIComponent(query[1]!),
      trade_type:"JSAPI",trade_state:order.state,payer:{openid:order.openid},
      amount:{total:order.amount,payer_total:order.amount,currency:"CNY",payer_currency:"CNY"},
      ...(order.state==="SUCCESS"?{transaction_id:order.transactionId,success_time:order.paidAt}:{})});return;
  }
  const close=path.match(/^\/v3\/pay\/transactions\/out-trade-no\/([^/?]+)\/close$/);
  if(method==="POST"&&close){
    const order=channelOrders.get(decodeURIComponent(close[1]!));
    if(!order||order.state!=="NOTPAY"){sendSigned(response,409,{code:"ORDER_STATE_ERROR"});return;}
    order.state="CLOSED";response.writeHead(204,signedHeaders(Buffer.alloc(0)));response.end();return;
  }
  if(method==="POST"&&path==="/v3/refund/domestic/refunds"){
    const input=JSON.parse(raw.toString("utf8")) as {transaction_id:string;out_refund_no:string;
      amount:{refund:number;total:number}};
    const payment=[...channelOrders.entries()].find(([,order])=>order.transactionId===input.transaction_id&&order.state==="SUCCESS");
    if(!payment||payment[1].amount!==input.amount.total){sendSigned(response,404,{code:"RESOURCE_NOT_EXISTS"});return;}
    let refund=channelRefunds.get(input.out_refund_no);
    if(!refund){refund={outTradeNo:payment[0],transactionId:input.transaction_id,amount:input.amount.refund,
      total:input.amount.total,status:"PROCESSING",refundId:`ref-${randomBytes(12).toString("hex")}`,
      succeededAt:"",acceptedAt:new Date().toISOString()};channelRefunds.set(input.out_refund_no,refund);}
    if(refund.amount!==input.amount.refund||refund.transactionId!==input.transaction_id){
      sendSigned(response,409,{code:"REFUND_NO_USED"});return;
    }
    if(loseNextRefundResponse){loseNextRefundResponse=false;sendSigned(response,503,{code:"SYSTEM_ERROR"});return;}
    sendSigned(response,200,refundResponse(input.out_refund_no,refund));return;
  }
  const refundQuery=path.match(/^\/v3\/refund\/domestic\/refunds\/([^/?]+)$/);
  if(method==="GET"&&refundQuery){
    const refundNumber=decodeURIComponent(refundQuery[1]!),refund=channelRefunds.get(refundNumber);
    if(!refund){sendSigned(response,404,{code:"RESOURCE_NOT_EXISTS"});return;}
    sendSigned(response,200,refundResponse(refundNumber,refund));return;
  }
  if(method==="POST"&&path==="/v3/fund-app/mch-transfer/transfer-bills"){
    const input=JSON.parse(raw.toString("utf8")) as {appid:string;out_bill_no:string;openid:string;
      transfer_amount:number;transfer_remark:string;transfer_scene_id:string};
    if(input.appid!==appId||input.transfer_scene_id!=="ISOLATED_COMMISSION"){
      sendSigned(response,400,{code:"PARAM_ERROR"});return;
    }
    let transfer=channelTransfers.get(input.out_bill_no);
    if(!transfer){transfer={openid:input.openid,amount:input.transfer_amount,state:"WAIT_USER_CONFIRM",
      transferBillNo:`transfer-${randomBytes(12).toString("hex")}`,remark:input.transfer_remark};
      channelTransfers.set(input.out_bill_no,transfer);}
    if(transfer.openid!==input.openid||transfer.amount!==input.transfer_amount){
      sendSigned(response,409,{code:"OUT_BILL_NO_USED"});return;
    }
    if(loseNextTransferResponse){loseNextTransferResponse=false;sendSigned(response,503,{code:"SYSTEM_ERROR"});return;}
    sendSigned(response,200,{out_bill_no:input.out_bill_no,transfer_bill_no:transfer.transferBillNo,
      create_time:new Date().toISOString(),state:transfer.state,package_info:"fixture-user-confirm"});return;
  }
  const transferQuery=path.match(/^\/v3\/fund-app\/mch-transfer\/transfer-bills\/out-bill-no\/([^/?]+)$/);
  if(method==="GET"&&transferQuery){
    const billNo=decodeURIComponent(transferQuery[1]!),transfer=channelTransfers.get(billNo);
    if(!transfer){sendSigned(response,404,{code:"NOT_FOUND"});return;}
    sendSigned(response,200,{mch_id:merchantId,appid:appId,out_bill_no:billNo,
      transfer_bill_no:transfer.transferBillNo,state:transfer.state,transfer_amount:transfer.amount,
      transfer_remark:transfer.remark,openid:transfer.openid,
      create_time:new Date().toISOString(),update_time:new Date().toISOString(),
      ...(transfer.state==="WAIT_USER_CONFIRM"?{package_info:"fixture-user-confirm"}:{})});return;
  }
  sendSigned(response,404,{code:"NOT_FOUND"});
}
function refundResponse(refundNumber:string,refund:NonNullable<ReturnType<typeof channelRefunds.get>>){
  return {out_trade_no:refund.outTradeNo,transaction_id:refund.transactionId,out_refund_no:refundNumber,
    refund_id:refund.refundId,status:refund.status,create_time:refund.acceptedAt,
    ...(refund.status==="SUCCESS"?{success_time:refund.succeededAt}:{}),
    amount:{total:refund.total,refund:refund.amount,payer_total:refund.total,
      payer_refund:refund.amount,currency:"CNY"}};
}
function paidCallback(outTradeNo:string,payerOverride?:string,paidAtOverride?:string,payerTotalOverride?:number){
  const order=channelOrders.get(outTradeNo)!;
  order.state="SUCCESS";order.paidAt=paidAtOverride??new Date().toISOString();
  const transaction={appid:order.appid,mchid:order.mchid,out_trade_no:outTradeNo,
    trade_type:"JSAPI",trade_state:"SUCCESS",transaction_id:order.transactionId,
    success_time:order.paidAt,payer:{openid:payerOverride??order.openid},
    amount:{total:order.amount,payer_total:payerTotalOverride??order.amount,currency:"CNY",payer_currency:"CNY"}};
  const nonce=randomBytes(6).toString("hex"),associated="transaction";
  const cipher=createCipheriv("aes-256-gcm",Buffer.from(apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from(associated));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(transaction)),cipher.final(),cipher.getAuthTag()]).toString("base64");
  const raw=Buffer.from(JSON.stringify({id:`evt-${randomBytes(12).toString("hex")}`,event_type:"TRANSACTION.SUCCESS",
    resource_type:"encrypt-resource",resource:{algorithm:"AEAD_AES_256_GCM",ciphertext,
      associated_data:associated,nonce,original_type:"transaction"}}));
  return {raw,headers:signedHeaders(raw)};
}
function refundCallback(refundNumber:string){
  const refund=channelRefunds.get(refundNumber)!;
  refund.status="SUCCESS";refund.succeededAt=new Date().toISOString();
  const payload={...refundResponse(refundNumber,refund),mchid:merchantId,refund_status:"SUCCESS"};
  const nonce=randomBytes(6).toString("hex"),associated="refund";
  const cipher=createCipheriv("aes-256-gcm",Buffer.from(apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from(associated));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]).toString("base64");
  const raw=Buffer.from(JSON.stringify({id:`refund-evt-${randomBytes(12).toString("hex")}`,
    event_type:"REFUND.SUCCESS",resource_type:"encrypt-resource",
    resource:{algorithm:"AEAD_AES_256_GCM",ciphertext,associated_data:associated,nonce,original_type:"refund"}}));
  return {raw,headers:signedHeaders(raw)};
}
function transferCallback(outBillNo:string,openidOverride?:string){
  const transfer=channelTransfers.get(outBillNo)!;
  const payload={out_bill_no:outBillNo,transfer_bill_no:transfer.transferBillNo,state:transfer.state,
    mch_id:merchantId,transfer_amount:transfer.amount,openid:openidOverride??transfer.openid,
    create_time:new Date().toISOString(),update_time:new Date().toISOString()};
  const nonce=randomBytes(6).toString("hex"),associated="mch_payment";
  const cipher=createCipheriv("aes-256-gcm",Buffer.from(apiV3Key),Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]).toString("base64");
  const raw=Buffer.from(JSON.stringify({id:`transfer-evt-${randomBytes(12).toString("hex")}`,
    event_type:"MCHTRANSFER.BILL.FINISHED",resource_type:"encrypt-resource",
    resource:{algorithm:"AEAD_AES_256_GCM",ciphertext,associated_data:associated,nonce,
      original_type:"mch_payment"}}));
  return {raw,headers:signedHeaders(raw)};
}

beforeAll(async()=>{
  await resetDatabase(pool);
  server=createServer((request,response)=>void channelHandler(request,response).catch(()=>{response.writeHead(500);response.end();}));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("fixture channel address missing");
  baseUrl=`http://127.0.0.1:${address.port}`;
  const config=loadConfig({APP_ENV:"test",DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"payment-http-session",
    ADMIN_API_TOKEN:"payment-http-admin",UPLOAD_TOKEN_SECRET:"payment-http-upload",OBJECT_STORAGE_DRIVER:"api_gateway",
    CONTACT_ENCRYPTION_KEY:"11".repeat(32),CONTACT_HASH_KEY:"22".repeat(32),CONTACT_KEY_VERSION:"payment-test-v1",
    COMMERCE_ORDER_FLOW_ENABLED:"true",COMMERCE_SIMULATED_PAYMENT_ENABLED:"true",
    COMMERCE_SIMULATED_CHANNEL_URL:baseUrl,COMMERCE_SIMULATED_MERCHANT_ID:merchantId,WECHAT_APP_ID:appId,
    COMMERCE_SIMULATED_TRANSFER_ENABLED:"true",COMMERCE_SIMULATED_TRANSFER_SCENE_ID:"ISOLATED_COMMISSION"});
  const channel=new WechatPayV3Client(merchantId,"MERCHANT_CERT_FIXTURE",merchantPrivate,
    new Map([[serial,platformPublic]]),fetch,baseUrl);
  const inbox=new VerifiedPaymentInbox(pool,{appId,merchantId,apiV3Key,platformKeys:new Map([[serial,platformPublic]])});
  refundInbox=new VerifiedRefundInbox(pool,{merchantId,apiV3Key,platformKeys:new Map([[serial,platformPublic]])});
  transferInbox=new TransferCallbackInbox(pool,{merchantId,apiV3Key,
    platformKeys:new Map([[serial,platformPublic]])});
  app=await createApp({config,pool,storage:createApiGatewayStorage(config),paymentProtocol:{channel,inbox,refundInbox,
    paymentNotifyUrl:"https://payment-fixture.invalid/v1/payments/wechat/callback",
    refundNotifyUrl:"https://payment-fixture.invalid/v1/payments/wechat/refund-callback",
    transferNotifyUrl:"https://payment-fixture.invalid/v1/payments/wechat/transfer-callback",transferInbox},
    legacyDirectSettlementFixture:true});
  const identity=await app.inject({method:"POST",url:"/v1/identity/dev",payload:{externalUserId:"payment-http-buyer",
    displayName:"Payment HTTP buyer",consents:[{documentType:"privacy",version:"test"},{documentType:"terms",version:"test"}]}});
  expect(identity.statusCode).toBe(200);buyer=identity.json();
  const staff=await app.inject({method:"POST",url:"/v1/identity/dev",payload:{externalUserId:"payment-http-operator",
    displayName:"Payment HTTP operator",consents:[{documentType:"privacy",version:"test"},{documentType:"terms",version:"test"}]}});
  expect(staff.statusCode).toBe(200);operator=staff.json();
  const secondReviewer=await app.inject({method:"POST",url:"/v1/identity/dev",payload:{externalUserId:"payment-http-reviewer",
    displayName:"Payment HTTP reviewer",consents:[{documentType:"privacy",version:"test"},{documentType:"terms",version:"test"}]}});
  expect(secondReviewer.statusCode).toBe(200);reviewer=secondReviewer.json();
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'commerce.refund.approve','fixture','Isolated refund HTTP integration','test','integration_fixture')`,[operator.memberId]);
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'commerce.money.reconcile','fixture','Isolated exception inspection','test','integration_fixture')`,[operator.memberId]);
  const sponsor=await app.inject({method:"POST",url:"/v1/identity/dev",payload:{externalUserId:"payment-http-referrer",
    displayName:"Payment HTTP referrer",consents:[{documentType:"privacy",version:"test"},{documentType:"terms",version:"test"}]}});
  expect(sponsor.statusCode).toBe(200);referrer=sponsor.json();
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram',$2,'verified-http-referrer-openid','wechat')`,[referrer.memberId,appId]);
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram',$2,'verified-http-buyer-openid','wechat')`,[buyer.memberId,appId]);
  const product=(await pool.query(`INSERT INTO catalog_product(code,name,source_kind,qualification_status,
    publication_status,created_by,updated_by,published_at) VALUES('payment-http-fixture','HTTP fixture',
    'synthetic_test','eligible','published','fixture','fixture',now()) RETURNING id`)).rows[0].id;
  skuId=(await pool.query(`INSERT INTO catalog_sku(product_id,code,label,created_by,updated_by)
    VALUES($1,'PAYMENT_HTTP_SKU','One','fixture','fixture') RETURNING id`,[product])).rows[0].id;
  await pool.query(`INSERT INTO catalog_price(sku_id,currency,amount_cents,created_by,updated_by)
    VALUES($1,'CNY',10000,'fixture','fixture')`,[skuId]);
  await pool.query(`INSERT INTO catalog_inventory_level(sku_id,stock_on_hand,updated_by)
    VALUES($1,5,'fixture')`,[skuId]);
  paymentInbox=inbox;
  refundCommands=new RefundCommandService(pool,new AuthorityService(pool,"test"),channel,refundInbox,
    {merchantId,notifyUrl:"https://payment-fixture.invalid/v1/payments/wechat/refund-callback"});
  settlementCommands=new SettlementCommandService(pool,new AuthorityService(pool,"test"),channel,"test",
    {appId,merchantId,sceneId:"ISOLATED_COMMISSION",
      notifyUrl:"https://payment-fixture.invalid/v1/payments/wechat/transfer-callback",
      legacyDirectFixture:true});
});

async function creditSpendCase(){
  await pool.query("UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+5 WHERE sku_id=$1",[skuId]);
  const source=await createOrder("credit-spend-source");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${source.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const channelPaid=paidCallback(source.orderNumber);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...channelPaid.headers,"Content-Type":"application/json"},payload:channelPaid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox);
  const proposed=await app.inject({method:"POST",url:`/v1/management/commerce/orders/${source.id}/fulfillment`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"credit-spend-delivered-001"},
    payload:{sourceReference:"fixture-credit-spend-001",evidenceSha256:"a".repeat(64),
      deliveredAt:new Date().toISOString()}});
  expect(proposed.statusCode,proposed.body).toBe(200);
  const released=await app.inject({method:"POST",url:`/v1/management/fulfillment/${proposed.json().id}/decision`,
    headers:{...auth(reviewer.sessionToken),"idempotency-key":"credit-spend-release-001"},
    payload:{decision:"verify",expectedVersion:1,reason:"独立复核信用来源"}});
  expect(released.statusCode,released.body).toBe(200);
  const credit=new ShoppingCreditService(pool,"test");
  const converted=await credit.convert(referrer.memberId,"credit-spend-convert-001",
    {amountCents:2000,confirmed:true,taxPolicyVersion:"isolated-synthetic-zero-withholding-v1"});
  const address=await app.inject({method:"POST",url:"/v1/me/addresses",
    headers:{...auth(referrer.sessionToken),"idempotency-key":"credit-spend-address-001"},
    payload:{recipientName:"合成权益买家",phone:"13800008888",province:"上海市",city:"上海市",
      district:"浦东新区",detail:"隔离测试路 2 号",postalCode:"200000",nationalCode:"310115",
      provinceCode:"310000",cityCode:"310100",districtCode:"310115",label:"home",isDefault:true}});
  expect(address.statusCode,address.body).toBe(200);
  async function creditOrder(suffix:string,creditCents:number){
    const quote=await app.inject({method:"POST",url:"/v1/me/commerce/quotes",
      headers:{...auth(referrer.sessionToken),"idempotency-key":`credit-quote-${suffix}-01`},
      payload:{skuId,quantity:1,addressId:address.json().id,
        addressVersion:address.json().version,creditCents}});
    expect(quote.statusCode,quote.body).toBe(200);
    expect(quote.json()).toMatchObject({totalCents:10000,creditTenderCents:creditCents,
      cashPayableCents:10000-creditCents,memberDiscountCents:0});
    const created=await app.inject({method:"POST",url:"/v1/me/orders",
      headers:{...auth(referrer.sessionToken),"idempotency-key":`credit-order-${suffix}-01`},
      payload:{quoteId:quote.json().id}});
    expect(created.statusCode,created.body).toBe(200);
    return created.json() as {id:string;orderNumber:string;version:number};
  }
  const purchase=await creditOrder("paid",1000);
  const binding=(await pool.query<{amount_cents:string}>(`SELECT amount_cents
    FROM commerce_payment_attempt WHERE order_id=$1`,[purchase.id])).rows[0]!;
  expect(binding.amount_cents).toBe("9000");
  expect((await pool.query(`SELECT cash_merchandise_cents FROM commission_order_snapshot
    WHERE order_id=$1`,[purchase.id])).rowCount).toBe(0);
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${purchase.id}/payment-intent`,
    headers:auth(referrer.sessionToken),payload:{}})).statusCode).toBe(200);
  expect(channelOrders.get(purchase.orderNumber)?.amount).toBe(9000);
  const payment=paidCallback(purchase.orderNumber);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...payment.headers,"Content-Type":"application/json"},payload:payment.raw})).statusCode).toBe(204);
  expect((await runMoneyWorkerCycle(paymentInbox)).payments).toContainEqual(expect.objectContaining({state:"applied"}));
  expect((await pool.query("SELECT status FROM commerce_order WHERE id=$1",[purchase.id])).rows[0].status).toBe("paid");
  const credited=(await pool.query<{kind:string;amount_cents:string}>(`SELECT e.kind,e.amount_cents FROM commission_credit_entry e
    JOIN commission_credit_source s ON s.id=e.source_id WHERE s.conversion_id=$1
    ORDER BY e.occurred_at,e.id`,[converted.id])).rows;
  expect(credited.filter(row=>row.kind==="spend")
    .reduce((sum,row)=>sum+Number(row.amount_cents),0)).toBe(-1000);
  expect(await credit.convert(referrer.memberId,"credit-spend-convert-001",
    {amountCents:2000,confirmed:true,taxPolicyVersion:"isolated-synthetic-zero-withholding-v1"}))
    .toMatchObject({id:converted.id,availableCents:1000,cancellable:false});
  for(const [index,gross,cash,returned] of [[1,3000,2700,300],[2,7000,6300,700]]){
    const requested=await app.inject({method:"POST",url:`/v1/me/orders/${purchase.id}/refund-requests`,
      headers:{...auth(referrer.sessionToken),"idempotency-key":`credit-refund-request-${index}-01`},
      payload:{amountCents:gross,reason:`隔离混合支付分次退款 ${index}`}});
    expect(requested.statusCode,requested.body).toBe(200);
    const approved=await app.inject({method:"POST",url:`/v1/management/refund-requests/${requested.json().id}/decision`,
      headers:{...auth(operator.sessionToken),"idempotency-key":`credit-refund-approve-${index}-01`},
      payload:{decision:"approve",expectedVersion:1,reason:"独立核对原付款组成"}});
    expect(approved.statusCode,approved.body).toBe(200);
    const intent=approved.json().intent;
    expect((await pool.query(`SELECT refund_cents,payer_refund_cents FROM commission_refund_intent
      WHERE id=$1`,[intent.id])).rows[0]).toMatchObject({refund_cents:String(cash),payer_refund_cents:String(cash)});
    expect((await pool.query(`SELECT sum(amount_cents)::text AS amount FROM commission_credit_refund_allocation
      WHERE refund_intent_id=$1`,[intent.id])).rows[0].amount).toBe(String(returned));
    const creditSource=(await pool.query<{source_id:string}>(`SELECT source_id FROM commission_credit_refund_allocation
      WHERE refund_intent_id=$1 LIMIT 1`,[intent.id])).rows[0]!;
    await expect(pool.query(`INSERT INTO commission_credit_entry
      (source_id,event_key,kind,amount_cents,purchase_order_id,actor_principal_id)
      VALUES($1,$2,'refund_return',$3,$4,'fixture:unverified-refund')`,
      [creditSource.source_id,`unverified-credit-return-${index}-01`,returned,purchase.id]))
      .rejects.toMatchObject({code:"23514"});
    expect(await refundCommands.processDue()).toContainEqual({id:intent.id,state:"accepted_processing"});
    expect(channelRefunds.get(intent.outRefundNo)?.total).toBe(9000);
    const callback=refundCallback(intent.outRefundNo);
    expect((await app.inject({method:"POST",url:"/v1/payments/wechat/refund-callback",
      headers:{...callback.headers,"Content-Type":"application/json"},payload:callback.raw})).statusCode).toBe(204);
    expect((await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands)).refunds)
      .toContainEqual(expect.objectContaining({state:"applied"}));
  }
  // One paid order can have a credit-only remaining unit even though its
  // original payment contained cash. The first unit uses the one cash cent;
  // the second must return only its original lot without calling WeChat.
  const lowPriceSku=(await pool.query<{id:string}>(`INSERT INTO catalog_sku(product_id,code,label,created_by,updated_by)
    SELECT product_id,'PAYMENT_HTTP_CREDIT_UNIT','Credit unit','fixture','fixture'
    FROM catalog_sku WHERE id=$1 RETURNING id`,[skuId])).rows[0]!.id;
  await pool.query(`INSERT INTO catalog_price(sku_id,currency,amount_cents,created_by,updated_by)
    VALUES($1,'CNY',1000,'fixture','fixture')`,[lowPriceSku]);
  await pool.query(`INSERT INTO catalog_inventory_level(sku_id,stock_on_hand,updated_by)
    VALUES($1,2,'fixture')`,[lowPriceSku]);
  const tinyQuote=await app.inject({method:'POST',url:'/v1/me/commerce/quotes',
    headers:{...auth(referrer.sessionToken),'idempotency-key':'credit-local-quote-001'},
    payload:{skuId:lowPriceSku,quantity:2,addressId:address.json().id,
      addressVersion:address.json().version,creditCents:1999}});
  expect(tinyQuote.statusCode,tinyQuote.body).toBe(200);
  expect(tinyQuote.json()).toMatchObject({totalCents:2000,creditTenderCents:1999,cashPayableCents:1});
  const tinyOrderResponse=await app.inject({method:'POST',url:'/v1/me/orders',
    headers:{...auth(referrer.sessionToken),'idempotency-key':'credit-local-order-001'},
    payload:{quoteId:tinyQuote.json().id}});
  expect(tinyOrderResponse.statusCode,tinyOrderResponse.body).toBe(200);
  const tinyOrder=tinyOrderResponse.json() as {id:string;orderNumber:string};
  expect((await app.inject({method:'POST',url:`/v1/me/orders/${tinyOrder.id}/payment-intent`,
    headers:auth(referrer.sessionToken),payload:{}})).statusCode).toBe(200);
  const tinyPaid=paidCallback(tinyOrder.orderNumber);
  expect((await app.inject({method:'POST',url:'/v1/payments/wechat/callback',
    headers:{...tinyPaid.headers,'Content-Type':'application/json'},payload:tinyPaid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox);
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'commerce.aftersale.review','fixture','Credit-only line refund','test','integration_fixture')
    ON CONFLICT DO NOTHING`,[operator.memberId]);
  const tinyLine=(await pool.query<{id:string}>(`SELECT id FROM commerce_order_line WHERE order_id=$1`,[tinyOrder.id])).rows[0]!.id;
  const tinyAftersales=new AftersaleService(pool,new AuthorityService(pool,'test'));
  for(const [index,expectedCash,expectedCredit] of [[1,1,999],[2,0,1000]]){
    const claim=await tinyAftersales.request(referrer.memberId,tinyOrder.id,`credit-local-claim-${index}`,
      {kind:'refund_only',reason:'隔离权益单件退款',lines:[{lineId:tinyLine,quantity:1}]});
    expect(claim.amountCents).toBe(1000);
    const pending=await tinyAftersales.act(operator.memberId,claim.id,`credit-local-claim-action-${index}`,
      {action:'request_refund',expectedVersion:1,note:'隔离原支付组成复核'},true,refundCommands);
    const approved=await refundCommands.decide(operator.memberId,pending.refundRequestId!,
      `credit-local-approval-${index}`,{decision:'approve',expectedVersion:1,reason:'隔离退款组成审批'});
    expect(approved.intent).toMatchObject({cashRefundCents:expectedCash,creditReturnCents:expectedCredit,
      executionKind:expectedCash?'wechat':'local_credit'});
    if(expectedCash){
      await refundCommands.processDue();
      const callback=refundCallback(approved.intent!.outRefundNo);
      expect((await app.inject({method:'POST',url:'/v1/payments/wechat/refund-callback',
        headers:{...callback.headers,'Content-Type':'application/json'},payload:callback.raw})).statusCode).toBe(204);
      await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
    }else{
      const sentBefore=channelRefunds.size;
      expect((await pool.query('SELECT state FROM commission_refund_intent WHERE id=$1',[approved.intent!.id])).rows[0].state).toBe('succeeded');
      const sourceId=(await pool.query<{source_id:string}>(`SELECT source_id FROM commission_credit_refund_allocation
        WHERE refund_intent_id=$1 LIMIT 1`,[approved.intent!.id])).rows[0]!.source_id;
      await expect(pool.query(`INSERT INTO commission_credit_entry
        (source_id,event_key,kind,amount_cents,purchase_order_id,actor_principal_id)
        VALUES($1,'credit-local-overreturn-001','refund_return',1,$2,'fixture')`,
        [sourceId,tinyOrder.id])).rejects.toMatchObject({code:'23514'});
      const forbiddenChannel={queryRefundByMerchantRefundNumberWithEvidence:()=>{
        throw new Error('local credit must not query WeChat');
      }} as unknown as WechatPayV3Client;
      await expect(refundInbox.receiveQueried(forbiddenChannel,approved.intent!.id)).rejects.toMatchObject({code:'REFUND_INTENT_UNMATCHED'});
      const falseChannelQuery=await app.inject({method:'POST',url:`/v1/management/money/recheck/refund/${approved.intent!.id}`,
        headers:auth(operator.sessionToken),payload:{}});
      expect(falseChannelQuery.statusCode).toBe(404);
      expect(await refundCommands.processDue()).toEqual([]);
      expect(channelRefunds.size).toBe(sentBefore);
      expect((await tinyAftersales.availability(referrer.memberId,tinyOrder.id)).lines[0]?.remainingQuantity).toBe(0);
    }
  }
  const pending=await creditOrder("cancel",500);
  const cancelled=await app.inject({method:"POST",url:`/v1/me/orders/${pending.id}/cancel-verified`,
    headers:{...auth(referrer.sessionToken),"idempotency-key":"credit-order-cancel-001"},
    payload:{expectedVersion:pending.version,reason:"隔离信用预占释放"}});
  expect(cancelled.statusCode,cancelled.body).toBe(200);
  const balance=(await pool.query<{balance:string}>(`SELECT sum(e.amount_cents)::text AS balance
    FROM commission_credit_entry e JOIN commission_credit_source s ON s.id=e.source_id
    WHERE s.conversion_id=$1`,[converted.id])).rows[0]!;
  expect(balance.balance).toBe("2000");
  expect((await credit.listMine(referrer.memberId)).items.find(item=>item.id===converted.id))
    .toMatchObject({availableCents:2000,cancellable:false});
  const disputed=await app.inject({method:"POST",url:`/v1/me/orders/${source.id}/refund-requests`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"credit-source-pending-refund-001"},
    payload:{amountCents:100,reason:"隔离信用来源退款争议"}});
  expect(disputed.statusCode,disputed.body).toBe(200);
  expect((await pool.query(`SELECT count(*)::int AS n FROM commerce_refund_request
    WHERE order_id=$1 AND state='requested'`,[source.id])).rows[0].n).toBe(1);
  const cleanBalance=Number((await pool.query<{balance:string}>(`SELECT COALESCE(sum(e.amount_cents),0)::text AS balance
    FROM commission_credit_source s JOIN commission_credit_entry e ON e.source_id=s.id
    WHERE s.conversion_id=$1 AND s.order_id<>$2`,[converted.id,source.id])).rows[0]!.balance);
  expect(cleanBalance).toBeGreaterThan(0);
  expect(await credit.listMine(referrer.memberId)).toMatchObject({availableCents:2000,
    checkoutAvailableCents:cleanBalance,spendable:true});
  const cleanPurchase=await creditOrder("clean",Math.min(cleanBalance,500));
  const usedOrigins=(await pool.query<{order_id:string}>(`SELECT DISTINCT s.order_id FROM commission_credit_checkout_allocation a
    JOIN commission_credit_source s ON s.id=a.source_id WHERE a.order_id=$1`,[cleanPurchase.id])).rows;
  expect(usedOrigins.length).toBeGreaterThan(0);
  expect(usedOrigins.every(row=>row.order_id!==source.id)).toBe(true);
  expect(await credit.listMine(referrer.memberId)).toMatchObject({checkoutAvailableCents:0,spendable:false});
  const disputedQuote=await app.inject({method:"POST",url:"/v1/me/commerce/quotes",
    headers:{...auth(referrer.sessionToken),"idempotency-key":"credit-disputed-quote-001"},
    payload:{skuId,quantity:1,addressId:address.json().id,addressVersion:address.json().version,
      creditCents:500}});
  expect(disputedQuote.statusCode,disputedQuote.body).toBe(200);
  const blocked=await app.inject({method:"POST",url:"/v1/me/orders",
    headers:{...auth(referrer.sessionToken),"idempotency-key":"credit-disputed-order-001"},
    payload:{quoteId:disputedQuote.json().id}});
  expect(blocked.statusCode,blocked.body).toBe(409);
  expect(blocked.json().code).toBe("CREDIT_CHECKOUT_ORIGIN_DISPUTED");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${cleanPurchase.id}/cancel-verified`,
    headers:{...auth(referrer.sessionToken),"idempotency-key":"credit-clean-cancel-001"},
    payload:{expectedVersion:cleanPurchase.version,reason:"仅干净来源可预占并正常释放"}})).statusCode).toBe(200);
  expect(await credit.listMine(referrer.memberId)).toMatchObject({checkoutAvailableCents:cleanBalance,spendable:true});
  const rejected=await app.inject({method:"POST",url:`/v1/management/refund-requests/${disputed.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"credit-source-dispute-reject-001"},
    payload:{decision:"reject",expectedVersion:1,reason:"隔离争议核实后不退款"}});
  expect(rejected.statusCode,rejected.body).toBe(200);
  const pendingAtRisk=await creditOrder("origin-risk",cleanBalance+1);
  const reservedOrigins=(await pool.query<{order_id:string}>(`SELECT DISTINCT s.order_id
    FROM commission_credit_checkout_allocation a JOIN commission_credit_source s ON s.id=a.source_id
    WHERE a.order_id=$1`,[pendingAtRisk.id])).rows;
  expect(reservedOrigins.some(row=>row.order_id===source.id)).toBe(true);
  const newDispute=await app.inject({method:"POST",url:`/v1/me/orders/${source.id}/refund-requests`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"credit-source-later-dispute-001"},
    payload:{amountCents:10000,reason:"预占后出现隔离来源争议"}});
  expect(newDispute.statusCode,newDispute.body).toBe(200);
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${pendingAtRisk.id}/payment-intent`,
    headers:auth(referrer.sessionToken),payload:{}})).statusCode).toBe(200);
  const paidAtRisk=paidCallback(pendingAtRisk.orderNumber);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...paidAtRisk.headers,"Content-Type":"application/json"},payload:paidAtRisk.raw})).statusCode).toBe(204);
  expect((await runMoneyWorkerCycle(paymentInbox)).payments)
    .toContainEqual(expect.objectContaining({state:"applied"}));
  expect((await pool.query("SELECT status FROM commerce_order WHERE id=$1",[pendingAtRisk.id])).rows[0].status)
    .toBe("paid");
  expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE object_id=$1
    AND action='commission.credit_reserved_origin_disputed'`,[pendingAtRisk.id])).rows[0].n)
    .toBeGreaterThan(0);
  expect((await credit.listMine(referrer.memberId)).checkoutAvailableCents).toBeLessThanOrEqual(cleanBalance);
  const approvedRisk=await app.inject({method:"POST",url:`/v1/management/refund-requests/${newDispute.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"credit-source-later-approve-001"},
    payload:{decision:"approve",expectedVersion:1,reason:"隔离来源全额退款核对"}});
  expect(approvedRisk.statusCode,approvedRisk.body).toBe(200);
  expect(await refundCommands.processDue()).toContainEqual({id:approvedRisk.json().intent.id,
    state:"accepted_processing"});
  const signedRiskRefund=refundCallback(approvedRisk.json().intent.outRefundNo);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/refund-callback",
    headers:{...signedRiskRefund.headers,"Content-Type":"application/json"},
    payload:signedRiskRefund.raw})).statusCode).toBe(204);
  expect((await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands)).refunds)
    .toContainEqual(expect.objectContaining({state:"applied"}));
  const exposure=(await pool.query<{after_state:{uncoveredCents:number}}>(`SELECT after_state
    FROM audit_log WHERE object_id=$1 AND action='commission.credit_recovery_exposure'
    ORDER BY created_at DESC,id DESC LIMIT 1`,[source.id])).rows[0];
  expect(exposure?.after_state.uncoveredCents).toBeGreaterThan(0);
  expect((await pool.query("SELECT status FROM commerce_order WHERE id=$1",[pendingAtRisk.id])).rows[0].status)
    .toBe("paid");
}
afterAll(async()=>{await app?.close();await new Promise<void>(resolve=>server?.close(()=>resolve()));await pool.end();});

async function createOrder(key:string,target:FastifyInstance=app,
  historicalComponents?:{discountCents:number;shippingCents:number},owner:TestActor=buyer,quantity=1){
  const address=await target.inject({method:"POST",url:"/v1/me/addresses",headers:{...auth(owner.sessionToken),
    "idempotency-key":`address-${key}-0001`},payload:{recipientName:"合成收件人",phone:"13800001234",province:"上海市",
      city:"上海市",district:"浦东新区",detail:"隔离测试路 1 号",postalCode:"200000",nationalCode:"310115",
      provinceCode:"310000",cityCode:"310100",districtCode:"310115",label:"home",isDefault:true}});
  expect(address.statusCode,JSON.stringify(address.json())).toBe(200);
  const quote=await target.inject({method:"POST",url:"/v1/me/commerce/quotes",headers:{...auth(owner.sessionToken),
    "idempotency-key":`quote-${key}-0001`},payload:{skuId,quantity,addressId:address.json().id,
      addressVersion:address.json().version}});
  expect(quote.statusCode,JSON.stringify(quote.json())).toBe(200);
  if(historicalComponents){
    // Reconstruct an old paid quote using captured monetary facts. The live
    // checkout intentionally does not offer this price shape today.
    await pool.query(`UPDATE commerce_checkout_quote SET member_discount_cents=$2,
      shipping_cents=$3,total_cents=subtotal_cents-$2::bigint+$3::bigint
      WHERE id=$1 AND status='active'`,[quote.json().id,historicalComponents.discountCents,historicalComponents.shippingCents]);
  }
  const created=await target.inject({method:"POST",url:"/v1/me/orders",headers:{...auth(owner.sessionToken),
    "idempotency-key":`order-${key}-0001`},payload:{quoteId:quote.json().id}});
  expect(created.statusCode,JSON.stringify(created.json())).toBe(200);
  return created.json() as {id:string;orderNumber:string;version:number};
}

it("runs quote, order, signed HTTP prepay, raw callback, and durable worker application",async()=>{
  const order=await createOrder("paid");
  const source=(await pool.query(`SELECT o.transaction_source_kind,a.payer_openid,a.quote_id,
    a.amount_cents FROM commerce_order o JOIN commerce_payment_attempt a ON a.order_id=o.id WHERE o.id=$1`,[order.id])).rows[0];
  expect(source).toMatchObject({transaction_source_kind:"verified_commerce",payer_openid:"verified-http-buyer-openid",amount_cents:"10000"});
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram',$2,'later-rotated-buyer-openid','wechat')`,[buyer.memberId,appId]);
  const channelCountBeforeCross=channelOrders.size;
  const crossPrepay=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,
    headers:auth(referrer.sessionToken),payload:{memberId:buyer.memberId,role:"review_lead"}});
  expect(crossPrepay.statusCode).toBe(404);
  expect(crossPrepay.json().code).toBe("PAYMENT_ATTEMPT_NOT_FOUND");
  const crossRefresh=await app.inject({method:"GET",url:`/v1/me/orders/${order.id}/payment-intent?memberId=${buyer.memberId}&role=review_lead`,
    headers:auth(referrer.sessionToken)});
  expect(crossRefresh.statusCode).toBe(404);
  expect(crossRefresh.json().code).toBe("PAYMENT_ATTEMPT_NOT_FOUND");
  expect(channelOrders.size).toBe(channelCountBeforeCross);
  const prepay=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,headers:auth(buyer.sessionToken),
    payload:{memberId:referrer.memberId,principalId:"forged",role:"review_lead",state:"paid"}});
  expect(prepay.statusCode,JSON.stringify(prepay.json())).toBe(200);
  expect(prepay.json()).toMatchObject({state:"prepay_ready",simulation:true,requestPayment:{signType:"RSA"}});
  const again=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,headers:auth(buyer.sessionToken),payload:{}});
  expect(again.statusCode).toBe(200);expect(channelOrders.size).toBe(1);
  const intentAudit=(await pool.query(`SELECT action,principal_id,before_state,after_state,trace_id FROM audit_log
    WHERE object_type='commerce_payment_attempt' AND object_id=$1 ORDER BY action`,[order.id])).rows;
  expect(intentAudit).toMatchObject([
    {action:"commerce.payment_intent.claim",principal_id:buyer.principalId,before_state:{state:"prepared"},after_state:{state:"unknown"}},
    {action:"commerce.payment_intent.prepay_ready",principal_id:buyer.principalId,before_state:{state:"unknown"},after_state:{state:"prepay_ready"}}
  ]);
  expect(intentAudit).toHaveLength(2);
  expect(intentAudit.every((row)=>typeof row.trace_id==="string"&&row.trace_id.length>0)).toBe(true);
  expect(JSON.stringify(intentAudit)).not.toContain(prepay.json().requestPayment.paySign);
  const directCancel=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/cancel`,headers:{...auth(buyer.sessionToken),
    "idempotency-key":"payment-direct-cancel-0001"},payload:{expectedVersion:1,reason:"测试直接取消"}});
  expect(directCancel.statusCode).toBe(409);expect(directCancel.json().code).toBe("PAYMENT_CLOSE_REQUIRED");
  const wrongPayer=paidCallback(order.orderNumber,"later-rotated-buyer-openid");
  const rejected=await app.inject({method:"POST",url:"/v1/payments/wechat/callback",headers:{...wrongPayer.headers,
    "Content-Type":"application/json"},payload:wrongPayer.raw});
  expect(rejected.statusCode).toBe(422);expect(rejected.json().code).toBe("WECHAT_PAY_FACT_INVALID");
  const callback=paidCallback(order.orderNumber);
  const received=await app.inject({method:"POST",url:"/v1/payments/wechat/callback",headers:{...callback.headers,
    "Content-Type":"application/json"},payload:callback.raw});
  expect(received.statusCode,received.body).toBe(204);
  const before=(await pool.query("SELECT status FROM commerce_order WHERE id=$1",[order.id])).rows[0].status;
  expect(before).toBe("pending_payment");
  const inbox=new VerifiedPaymentInbox(pool,{appId,merchantId,apiV3Key,platformKeys:new Map([[serial,platformPublic]])});
  expect((await runMoneyWorkerCycle(inbox)).payments).toContainEqual(expect.objectContaining({state:"applied"}));
  expect((await pool.query("SELECT status FROM commerce_order WHERE id=$1",[order.id])).rows[0].status).toBe("paid");
  expect((await pool.query("SELECT state FROM commerce_payment_attempt WHERE order_id=$1",[order.id])).rows[0].state).toBe("paid");
  expect((await pool.query("SELECT count(*)::int AS n FROM commission_payment_inbox WHERE order_id=$1",[order.id])).rows[0].n).toBe(1);
  const replay=await app.inject({method:"POST",url:"/v1/payments/wechat/callback",headers:{...callback.headers,
    "Content-Type":"application/json"},payload:callback.raw});
  expect(replay.statusCode).toBe(204);
  expect((await pool.query("SELECT count(*)::int AS n FROM commission_payment_inbox WHERE order_id=$1",[order.id])).rows[0].n).toBe(1);
});

it("queries the original number after a lost callback and closes before inventory release",async()=>{
  const order=await createOrder("reconcile");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  paidCallback(order.orderNumber);
  const refreshed=await app.inject({method:"GET",url:`/v1/me/orders/${order.id}/payment-intent`,headers:auth(buyer.sessionToken)});
  expect(refreshed.statusCode,JSON.stringify(refreshed.json())).toBe(200);
  expect(refreshed.json().state).toBe("verified_pending");
  const refreshAudit=(await pool.query(`SELECT principal_id,before_state,after_state FROM audit_log
    WHERE action='commerce.payment_intent.refresh_verified' AND object_id=$1`,[order.id])).rows;
  expect(refreshAudit).toMatchObject([{principal_id:buyer.principalId,
    before_state:{state:"prepay_ready"},after_state:{state:"verified_pending",inboxId:refreshed.json().inboxId}}]);
  const inbox=new VerifiedPaymentInbox(pool,{appId,merchantId,apiV3Key,platformKeys:new Map([[serial,platformPublic]])});
  await runMoneyWorkerCycle(inbox);
  expect((await pool.query("SELECT status FROM commerce_order WHERE id=$1",[order.id])).rows[0].status).toBe("paid");
  const unpaid=await createOrder("cancel");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${unpaid.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const crossCancel=await app.inject({method:"POST",url:`/v1/me/orders/${unpaid.id}/cancel-verified`,
    headers:{...auth(referrer.sessionToken),"idempotency-key":"cross0008"},
    payload:{expectedVersion:unpaid.version,reason:"合成跨人取消",memberId:buyer.memberId,status:"closed"}});
  expect(crossCancel.statusCode).toBe(404);
  expect(crossCancel.json().code).toBe("PAYMENT_ATTEMPT_NOT_FOUND");
  expect(channelOrders.get(unpaid.orderNumber)?.state).toBe("NOTPAY");
  const stale=await app.inject({method:"POST",url:`/v1/me/orders/${unpaid.id}/cancel-verified`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"payment-verified-cancel-stale-0001"},
    payload:{expectedVersion:unpaid.version+1,reason:"隔离版本过期取消"}});
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe("ORDER_VERSION_CONFLICT");
  expect((await pool.query(`SELECT state FROM commerce_payment_attempt WHERE order_id=$1`,[unpaid.id])).rows[0].state)
    .not.toBe("closed");
  const cancelled=await app.inject({method:"POST",url:`/v1/me/orders/${unpaid.id}/cancel-verified`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"payment-verified-cancel-0001"},
    payload:{expectedVersion:unpaid.version,reason:"隔离模拟取消",memberId:referrer.memberId,principalId:"forged",role:"review_lead",status:"paid"}});
  expect(cancelled.statusCode,JSON.stringify(cancelled.json())).toBe(200);
  expect(cancelled.json().status).toBe("cancelled");
  expect((await pool.query("SELECT principal_id FROM audit_log WHERE action='commerce.order.cancel' AND object_id=$1",
    [unpaid.id])).rows[0].principal_id).toBe(buyer.principalId);
  expect(channelOrders.get(unpaid.orderNumber)?.state).toBe("CLOSED");
  expect((await pool.query("SELECT status FROM commerce_inventory_reservation WHERE order_id=$1",[unpaid.id])).rows[0].status).toBe("released");
  const late=paidCallback(unpaid.orderNumber);
  const lateReceipt=await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...late.headers,"Content-Type":"application/json"},payload:late.raw});
  expect(lateReceipt.statusCode).toBe(204);
  const isolated=await runMoneyWorkerCycle(inbox);
  expect(isolated.payments).toContainEqual(expect.objectContaining({state:"exception"}));
  const forbidden=await app.inject({method:"GET",url:"/v1/management/money/issues",headers:auth(buyer.sessionToken)});
  expect(forbidden.statusCode).toBe(403);
  const issues=await app.inject({method:"GET",url:"/v1/management/money/issues?limit=1",headers:auth(operator.sessionToken)});
  expect(issues.statusCode,issues.body).toBe(200);
  expect(issues.json()).toMatchObject({totalCount:1,items:[{kind:"payment_inbox",relatedId:unpaid.id,
    code:"PAYMENT_CLOSED_CHANNEL_CONFLICT",canRedrive:false}]});
  const attempted=await app.inject({method:"POST",url:`/v1/management/money/inboxes/payment/${issues.json().items[0].id}/redrive`,
    headers:auth(operator.sessionToken),payload:{reason:"终态冲突人工复核之后重驱"}});
  expect(attempted.statusCode).toBe(409);
  expect(attempted.json().code).toBe("INBOX_REDRIVE_NOT_ALLOWED");
});

it("reserves partial refunds before signed HTTP submission and reverses commission by cumulative cents",async()=>{
  await pool.query(`INSERT INTO commercial_membership(member_id,state,effective_at,expires_at,changed_by,change_reason)
    VALUES($1,'active',now()-interval '1 day',now()+interval '1 year','fixture','Isolated refund commission test')`,
    [referrer.memberId]);
  const code=(await pool.query(`INSERT INTO commercial_referral_code(member_id,code)
    VALUES($1,'CMABCDEFGHJK') RETURNING id`,[referrer.memberId])).rows[0].id;
  await pool.query(`INSERT INTO commercial_referral_relation(referred_member_id,referrer_member_id,
    referral_code_id,confirmation_key,confirmed_by) VALUES($1,$2,$3,'payment-http-referral-0001','fixture')`,
    [buyer.memberId,referrer.memberId,code]);
  const order=await createOrder("refund");
  const snapshot=(await pool.query("SELECT basis_points,cash_merchandise_cents FROM commission_order_snapshot WHERE order_id=$1",
    [order.id])).rows[0];
  expect(snapshot).toMatchObject({basis_points:2000,cash_merchandise_cents:"10000"});
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const payment=paidCallback(order.orderNumber);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...payment.headers,"Content-Type":"application/json"},payload:payment.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  expect((await pool.query(`SELECT amount_cents FROM commission_ledger_entry WHERE order_id=$1 AND kind='accrual'`,
    [order.id])).rows[0].amount_cents).toBe("2000");

  for(const [method,url] of [
    ["POST",`/v1/me/orders/${order.id}/refund-requests`],
    ["GET",`/v1/me/refund-requests?orderId=${order.id}`],
    ["GET","/v1/management/refund-requests/pending"],
    ["POST",`/v1/management/refund-requests/${order.id}/decision`],
    ["POST",`/v1/management/refund-submissions/${order.id}/redrive`]
  ] as const) expect((await app.inject({method,url})).statusCode,`${method} ${url}`).toBe(401);

  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'commerce.refund.approve','fixture','Self-approval negative','test','integration_fixture')`,[buyer.memberId]);
  for(const [index,amount] of [3000,4000,3000].entries()){
    const request=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/refund-requests`,
      headers:{...auth(buyer.sessionToken),"idempotency-key":`refund-request-${index}-0001`},
      payload:{amountCents:amount,reason:`合成分次退款 ${index+1}`,memberId:referrer.memberId,
        status:"approved",role:"review_lead"}});
    expect(request.statusCode,JSON.stringify(request.json())).toBe(200);
    expect(request.json().state).toBe("requested");
    const requestId=request.json().id;
    expect((await pool.query("SELECT requested_by_member_id FROM commerce_refund_request WHERE id=$1",
      [requestId])).rows[0].requested_by_member_id).toBe(buyer.memberId);
    expect((await pool.query("SELECT principal_id,after_state FROM audit_log WHERE action='commerce.refund.request' AND object_id=$1",
      [requestId])).rows[0]).toMatchObject({principal_id:`member:${buyer.memberId}`,
        after_state:{state:"requested",amountCents:amount}});
    if(index===0){
      const otherRequest=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/refund-requests`,
        headers:{...auth(referrer.sessionToken),"idempotency-key":"cross0006"},
        payload:{amountCents:100,reason:"合成跨人退款申请",memberId:buyer.memberId}});
      expect(otherRequest.statusCode).toBe(404);
      expect(otherRequest.json().code).toBe("ORDER_NOT_FOUND");
      expect((await app.inject({method:"GET",url:"/v1/management/refund-requests/pending",
        headers:auth(referrer.sessionToken)})).statusCode).toBe(403);
      const pending=await app.inject({method:"GET",url:"/v1/management/refund-requests/pending",
        headers:auth(operator.sessionToken)});
      expect(pending.statusCode).toBe(200);
      expect(pending.json().items).toContainEqual(expect.objectContaining({id:requestId,
        requestedByMemberId:buyer.memberId}));
      expect((await app.inject({method:"POST",url:`/v1/management/refund-requests/${requestId}/decision`,
        headers:{...auth(referrer.sessionToken),"idempotency-key":"cross0007"},
        payload:{decision:"approve",expectedVersion:1,reason:"无权审批合成退款"}})).statusCode).toBe(403);
    }
    const duplicate=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/refund-requests`,
      headers:{...auth(buyer.sessionToken),"idempotency-key":`refund-request-${index}-0001`},
      payload:{amountCents:amount,reason:`合成分次退款 ${index+1}`}});
    expect(duplicate.json().id).toBe(requestId);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='commerce.refund.request' AND object_id=$1",
      [requestId])).rows[0].n).toBe(1);
    const self=await app.inject({method:"POST",url:`/v1/management/refund-requests/${requestId}/decision`,
      headers:{...auth(buyer.sessionToken),"idempotency-key":`refund-self-${index}-0001`},
      payload:{decision:"approve",expectedVersion:1,reason:"不允许自己审批"}});
    expect(self.statusCode).toBe(403);
    const approved=await app.inject({method:"POST",url:`/v1/management/refund-requests/${requestId}/decision`,
      headers:{...auth(operator.sessionToken),"idempotency-key":`refund-approve-${index}-0001`},
      payload:{decision:"approve",expectedVersion:1,reason:`独立核对隔离退款 ${index+1}`,
        memberId:buyer.memberId,principalId:"forged",role:"review_lead"}});
    expect(approved.statusCode,JSON.stringify(approved.json())).toBe(200);
    expect((await pool.query("SELECT principal_id FROM audit_log WHERE action='commerce.refund.decision' AND object_id=$1",
      [requestId])).rows[0].principal_id).toBe(`member:${operator.memberId}`);
    const refundNumber=approved.json().intent.outRefundNo as string;
    expect(refundNumber).toMatch(/^CR[0-9A-F]{32}$/);
    expect((await pool.query(`SELECT count(*)::int AS n FROM commission_refund_intent WHERE request_id=$1`,
      [requestId])).rows[0].n).toBe(1);
    const submitted=await refundCommands.processDue();
    expect(submitted).toContainEqual({id:approved.json().intent.id,state:"accepted_processing"});
    expect(channelRefunds.get(refundNumber)?.status).toBe("PROCESSING");
    const before=(await pool.query(`SELECT COALESCE(sum(amount_cents),0)::text AS total FROM commission_ledger_entry
      WHERE order_id=$1`,[order.id])).rows[0].total;
    expect(before).toBe(String(2000-[0,600,1400][index]!));
    const callback=refundCallback(refundNumber);
    const received=await app.inject({method:"POST",url:"/v1/payments/wechat/refund-callback",
      headers:{...callback.headers,"Content-Type":"application/json"},payload:callback.raw});
    expect(received.statusCode,received.body).toBe(204);
    await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
    const replay=await app.inject({method:"POST",url:"/v1/payments/wechat/refund-callback",
      headers:{...callback.headers,"Content-Type":"application/json"},payload:callback.raw});
    expect(replay.statusCode).toBe(204);
    const net=(await pool.query(`SELECT COALESCE(sum(amount_cents),0)::text AS total FROM commission_ledger_entry
      WHERE order_id=$1`,[order.id])).rows[0].total;
    expect(net).toBe(String([1400,600,0][index]!));
  }
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1
    AND kind='refund_reversal'`,[order.id])).rows[0].n).toBe(3);
  const ownerPage=await app.inject({method:"GET",url:`/v1/me/refund-requests?orderId=${order.id}&limit=2`,
    headers:auth(buyer.sessionToken)});
  expect(ownerPage.statusCode,ownerPage.body).toBe(200);
  expect(ownerPage.json().totalCount).toBe(3);
  expect(ownerPage.json().items).toHaveLength(2);
  const otherPage=await app.inject({method:"GET",url:`/v1/me/refund-requests?orderId=${order.id}&limit=2`,
    headers:auth(referrer.sessionToken)});
  expect(otherPage.statusCode).toBe(200);
  expect(otherPage.json()).toMatchObject({totalCount:0,items:[]});
  const borrowedCursor=await app.inject({method:"GET",url:`/v1/me/refund-requests?orderId=${order.id}&limit=2&cursor=${encodeURIComponent(ownerPage.json().nextCursor)}`,
    headers:auth(referrer.sessionToken)});
  expect(borrowedCursor.statusCode).toBe(422);
  expect(borrowedCursor.json().code).toBe("PAGE_CURSOR_INVALID");
  const ownerNext=await app.inject({method:"GET",url:`/v1/me/refund-requests?orderId=${order.id}&limit=2&cursor=${encodeURIComponent(ownerPage.json().nextCursor)}`,
    headers:auth(buyer.sessionToken)});
  expect(ownerNext.statusCode,ownerNext.body).toBe(200);
  expect(ownerNext.json().items).toHaveLength(1);
  expect(ownerNext.json().totalCount).toBe(3);
  expect((await pool.query(`SELECT status,paid_at FROM commerce_order WHERE id=$1`,[order.id])).rows[0])
    .toMatchObject({status:"paid",paid_at:expect.any(Date)});
  const excess=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/refund-requests`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"refund-overdraw-0001"},
    payload:{amountCents:1,reason:"超过原支付金额"}});
  expect(excess.statusCode).toBe(409);
});

it("keeps the original refund number through an unknown response and reconciles a lost callback",async()=>{
  const order=await createOrder("refund-retry");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const payment=paidCallback(order.orderNumber);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...payment.headers,"Content-Type":"application/json"},payload:payment.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  const request=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/refund-requests`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"refund-retry-request-0001"},
    payload:{amountCents:1234,reason:"模拟退款响应丢失"}});
  expect(request.statusCode,JSON.stringify(request.json())).toBe(200);
  const approved=await app.inject({method:"POST",url:`/v1/management/refund-requests/${request.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"refund-retry-approve-0001"},
    payload:{decision:"approve",expectedVersion:1,reason:"独立审批响应丢失测试"}});
  expect(approved.statusCode,JSON.stringify(approved.json())).toBe(200);
  const intent=approved.json().intent,initialCount=channelRefunds.size;
  loseNextRefundResponse=true;
  expect(await refundCommands.processDue()).toContainEqual({id:intent.id,state:"retry_scheduled"});
  expect(channelRefunds.size).toBe(initialCount+1);
  expect((await pool.query("SELECT submission_state FROM commission_refund_intent WHERE id=$1",[intent.id])).rows[0].submission_state)
    .toBe("unknown");
  await pool.query(`UPDATE commission_refund_intent SET submission_attempt_count=8,
    submission_quarantined_at=clock_timestamp(),submission_last_error_code='CHANNEL_UNAVAILABLE'
    WHERE id=$1`,[intent.id]);
  const queue=await app.inject({method:"GET",url:"/v1/management/money/issues?limit=20",
    headers:auth(operator.sessionToken)});
  expect(queue.statusCode,queue.body).toBe(200);
  expect(queue.json().items).toContainEqual(expect.objectContaining({id:intent.id,
    kind:"refund_submission",canRedrive:true,attempts:8}));
  const denied=await app.inject({method:"POST",url:`/v1/management/refund-submissions/${intent.id}/redrive`,
    headers:auth(buyer.sessionToken),payload:{expectedAttempts:8,reason:"原单状态已核验申请重驱"}});
  expect(denied.statusCode).toBe(403);
  const redrive=await app.inject({method:"POST",url:`/v1/management/refund-submissions/${intent.id}/redrive`,
    headers:auth(operator.sessionToken),payload:{expectedAttempts:8,reason:"原单状态已核验申请重驱",
      memberId:buyer.memberId,principalId:"forged",state:"succeeded"}});
  expect(redrive.statusCode,redrive.body).toBe(200);
  expect(redrive.json()).toMatchObject({id:intent.id,state:"requery_due"});
  expect((await pool.query("SELECT principal_id FROM audit_log WHERE action='commerce.refund_submission_redrive' AND object_id=$1",
    [intent.id])).rows[0].principal_id).toBe(`member:${operator.memberId}`);
  const staleRedrive=await app.inject({method:"POST",url:`/v1/management/refund-submissions/${intent.id}/redrive`,
    headers:auth(operator.sessionToken),payload:{expectedAttempts:8,reason:"不能重复重驱相同次数"}});
  expect(staleRedrive.statusCode).toBe(409);
  expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action='commerce.refund_submission_redrive' AND object_id=$1",
    [intent.id])).rows[0].n).toBe(1);
  expect(await refundCommands.processDue()).toContainEqual({id:intent.id,state:"accepted_processing"});
  expect(channelRefunds.size).toBe(initialCount+1);
  refundCallback(intent.outRefundNo); // signed channel state changed; callback delivery is intentionally lost
  await pool.query(`UPDATE commission_refund_intent SET submission_next_attempt_at=clock_timestamp()
    WHERE id=$1`,[intent.id]);
  expect(await refundCommands.reconcileAccepted()).toContainEqual({id:intent.id,state:"verified_fact_pending"});
  expect((await pool.query(`SELECT state FROM commission_refund_intent WHERE id=$1`,[intent.id])).rows[0].state).toBe("prepared");
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  expect((await pool.query(`SELECT state FROM commission_refund_intent WHERE id=$1`,[intent.id])).rows[0].state).toBe("succeeded");
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_refund_inbox WHERE refund_intent_id=$1`,[intent.id])).rows[0].n).toBe(1);
});

it("requires a second test reviewer and resolved refunds before releasing earned commission",async()=>{
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'commerce.fulfillment.manage','fixture','Isolated fulfillment test','test','integration_fixture'),
      ($2,'commerce.fulfillment.manage','fixture','Isolated fulfillment test','test','integration_fixture'),
      ($3,'commerce.fulfillment.manage','fixture','Isolated fulfillment test','test','integration_fixture')`,
    [operator.memberId,referrer.memberId,reviewer.memberId]);
  const order=await createOrder("fulfillment");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const payment=paidCallback(order.orderNumber);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...payment.headers,"Content-Type":"application/json"},payload:payment.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  const proposal=await app.inject({method:"POST",url:`/v1/management/commerce/orders/${order.id}/fulfillment`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"fulfillment-submit-0001"},
    payload:{sourceReference:"fixture-carrier-0001",evidenceSha256:"a".repeat(64),
      deliveredAt:new Date().toISOString()}});
  expect(proposal.statusCode,JSON.stringify(proposal.json())).toBe(200);
  const pending=await app.inject({method:"GET",url:"/v1/management/fulfillment/pending?limit=1",
    headers:auth(reviewer.sessionToken)});
  expect(pending.statusCode).toBe(200);
  expect(pending.json().totalCount).toBe(1);
  const self=await app.inject({method:"POST",url:`/v1/management/fulfillment/${proposal.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"fulfillment-self-0001"},
    payload:{decision:"verify",expectedVersion:1,reason:"隔离自审拒绝"}});
  expect(self.statusCode).toBe(403);
  const beneficiary=await app.inject({method:"POST",url:`/v1/management/fulfillment/${proposal.json().id}/decision`,
    headers:{...auth(referrer.sessionToken),"idempotency-key":"fulfillment-beneficiary-0001"},
    payload:{decision:"verify",expectedVersion:1,reason:"受益人不应核验"}});
  expect(beneficiary.statusCode).toBe(403);
  expect(beneficiary.json().code).toBe("FULFILLMENT_BENEFICIARY_REVIEW_FORBIDDEN");
  const refund=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/refund-requests`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"fulfillment-refund-0001"},
    payload:{amountCents:1000,reason:"合成未决售后申请"}});
  expect(refund.statusCode).toBe(200);
  const blocked=await app.inject({method:"POST",url:`/v1/management/fulfillment/${proposal.json().id}/decision`,
    headers:{...auth(reviewer.sessionToken),"idempotency-key":"fulfillment-verify-0001"},
    payload:{decision:"verify",expectedVersion:1,reason:"独立核验合成签收"}});
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().code).toBe("FULFILLMENT_REFUND_UNRESOLVED");
  const rejected=await app.inject({method:"POST",url:`/v1/management/refund-requests/${refund.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"fulfillment-refund-reject-0001"},
    payload:{decision:"reject",expectedVersion:1,reason:"合成申请核实后不退款"}});
  expect(rejected.statusCode,JSON.stringify(rejected.json())).toBe(200);
  const verified=await app.inject({method:"POST",url:`/v1/management/fulfillment/${proposal.json().id}/decision`,
    headers:{...auth(reviewer.sessionToken),"idempotency-key":"fulfillment-verify-0001"},
    payload:{decision:"verify",expectedVersion:1,reason:"独立核验合成签收"}});
  expect(verified.statusCode,JSON.stringify(verified.json())).toBe(200);
  expect(verified.json()).toMatchObject({state:"verified",releasedCents:2000});
  expect((await pool.query(`SELECT kind,amount_cents FROM commission_ledger_entry WHERE order_id=$1
    ORDER BY occurred_at,id`,[order.id])).rows.map(row=>[row.kind,row.amount_cents]))
    .toEqual([["accrual","2000"],["release","2000"]]);
  const replay=await app.inject({method:"POST",url:`/v1/management/fulfillment/${proposal.json().id}/decision`,
    headers:{...auth(reviewer.sessionToken),"idempotency-key":"fulfillment-verify-0001"},
    payload:{decision:"verify",expectedVersion:1,reason:"独立核验合成签收"}});
  expect(replay.statusCode).toBe(200);
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1
    AND kind='release'`,[order.id])).rows[0].n).toBe(1);
});

it("reserves commission once and records settlement only after signed SUCCESS query",async()=>{
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'commission.settlement.approve','fixture','Isolated transfer approval','test','integration_fixture'),
      ($2,'commission.settlement.approve','fixture','Self-approval negative','test','integration_fixture')`,
    [operator.memberId,referrer.memberId]);
  const orderId=(await pool.query(`SELECT order_id FROM commission_ledger_entry WHERE kind='release'`)).rows[0].order_id;
  const request=await app.inject({method:"POST",url:"/v1/me/commission/settlement-requests",
    headers:{...auth(referrer.sessionToken),"idempotency-key":"settlement-request-0001"},
    payload:{amountCents:2000,reason:"隔离已释放佣金结算"}});
  expect(request.statusCode,JSON.stringify(request.json())).toBe(200);
  const second=await app.inject({method:"POST",url:"/v1/me/commission/settlement-requests",
    headers:{...auth(referrer.sessionToken),"idempotency-key":"settlement-request-0002"},
    payload:{amountCents:2000,reason:"隔离重复可用额申请"}});
  expect(second.statusCode).toBe(200);
  const self=await app.inject({method:"POST",
    url:`/v1/management/commission/settlement-requests/${request.json().id}/decision`,
    headers:{...auth(referrer.sessionToken),"idempotency-key":"settlement-self-0001"},
    payload:{decision:"approve",expectedVersion:1,reason:"不能自行核准结算"}});
  expect(self.statusCode).toBe(403);
  const approved=await app.inject({method:"POST",
    url:`/v1/management/commission/settlement-requests/${request.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"settlement-approve-0001"},
    payload:{decision:"approve",expectedVersion:1,reason:"独立核验隔离结算"}});
  expect(approved.statusCode,JSON.stringify(approved.json())).toBe(200);
  expect(approved.json().state).toBe("reserved");
  const overdraw=await app.inject({method:"POST",
    url:`/v1/management/commission/settlement-requests/${second.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"settlement-approve-0002"},
    payload:{decision:"approve",expectedVersion:1,reason:"验证预占不会超额"}});
  expect(overdraw.statusCode).toBe(409);
  expect(overdraw.json().code).toBe("SETTLEMENT_AVAILABLE_INSUFFICIENT");
  const held=await app.inject({method:"GET",url:"/v1/me/commercial-membership",
    headers:auth(referrer.sessionToken)});
  expect(held.statusCode,JSON.stringify(held.json())).toBe(200);
  expect(held.json().commission).toMatchObject({paymentHeldCents:2000,availableCents:0,settledCents:0});
  const outBillNo=approved.json().outBillNo as string;
  loseNextTransferResponse=true;
  const created=await settlementCommands.processDue();
  expect(created).toContainEqual({id:request.json().id,state:"retry_scheduled"});
  expect(channelTransfers.get(outBillNo)?.state).toBe("WAIT_USER_CONFIRM");
  expect(channelTransfers.size).toBe(1);
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_ledger_entry
    WHERE order_id=$1 AND kind='settlement'`,[orderId])).rows[0].n).toBe(0);
  await pool.query(`UPDATE commission_settlement_request SET next_attempt_at=clock_timestamp()
    WHERE id=$1`,[request.json().id]);
  expect(await settlementCommands.processDue()).toContainEqual({id:request.json().id,state:"processing"});
  expect(channelTransfers.size).toBe(1);
  expect((await pool.query(`SELECT channel_state FROM commission_settlement_request WHERE id=$1`,
    [request.json().id])).rows[0].channel_state).toBe("WAIT_USER_CONFIRM");
  const path=`/v1/me/commission/settlement-requests/${request.json().id}/confirmation`;
  expect((await app.inject({method:"GET",url:path,headers:auth(buyer.sessionToken)})).statusCode).toBe(404);
  const confirmation=await app.inject({method:"GET",url:path,headers:auth(referrer.sessionToken)});
  expect(confirmation.statusCode,JSON.stringify(confirmation.json())).toBe(200);
  expect(confirmation.json()).toMatchObject({requestId:request.json().id,state:"WAIT_USER_CONFIRM",
    package:"fixture-user-confirm",simulation:true});
  expect(confirmation.json()).toMatchObject({appId,mchId:merchantId});
  channelTransfers.get(outBillNo)!.state="SUCCESS";
  const wrong=transferCallback(outBillNo,"wrong-payee-openid");
  const rejected=await app.inject({method:"POST",url:"/v1/payments/wechat/transfer-callback",
    headers:{...wrong.headers,"Content-Type":"application/json"},payload:wrong.raw});
  expect(rejected.statusCode).toBe(422);
  const callback=transferCallback(outBillNo);
  const received=await app.inject({method:"POST",url:"/v1/payments/wechat/transfer-callback",
    headers:{...callback.headers,"Content-Type":"application/json"},payload:callback.raw});
  expect(received.statusCode,received.body).toBe(204);
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1
    AND kind='settlement'`,[orderId])).rows[0].n).toBe(0);
  const replay=await app.inject({method:"POST",url:"/v1/payments/wechat/transfer-callback",
    headers:{...callback.headers,"Content-Type":"application/json"},payload:callback.raw});
  expect(replay.statusCode).toBe(204);
  expect(await transferInbox.processPending(settlementCommands)).toContainEqual(
    expect.objectContaining({state:"applied"}));
  expect((await pool.query(`SELECT amount_cents FROM commission_ledger_entry WHERE order_id=$1
    AND kind='settlement'`,[orderId])).rows[0].amount_cents).toBe("2000");
  expect((await app.inject({method:"GET",url:path,headers:auth(referrer.sessionToken)})).statusCode).toBe(409);
  const paid=await app.inject({method:"GET",url:"/v1/me/commercial-membership",
    headers:auth(referrer.sessionToken)});
  expect(paid.json().commission).toMatchObject({paymentHeldCents:0,availableCents:0,settledCents:2000});
});

it("cancels an unsubmitted transfer even if an approved refund has no intent yet",async()=>{
  await pool.query(`UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1,
    version=version+1,updated_by='fixture' WHERE sku_id=$1`,[skuId]);
  const order=await createOrder("settlement-late-refund");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const paid=paidCallback(order.orderNumber);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...paid.headers,"Content-Type":"application/json"},payload:paid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  const proof=await app.inject({method:"POST",url:`/v1/management/commerce/orders/${order.id}/fulfillment`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"late-refund-proof-0001"},
    payload:{sourceReference:"fixture-carrier-late-0001",evidenceSha256:"b".repeat(64),
      deliveredAt:new Date().toISOString()}});
  expect(proof.statusCode,JSON.stringify(proof.json())).toBe(200);
  const released=await app.inject({method:"POST",url:`/v1/management/fulfillment/${proof.json().id}/decision`,
    headers:{...auth(reviewer.sessionToken),"idempotency-key":"late-refund-proof-review-0001"},
    payload:{decision:"verify",expectedVersion:1,reason:"独立核验隔离签收"}});
  expect(released.statusCode,JSON.stringify(released.json())).toBe(200);
  const request=await app.inject({method:"POST",url:"/v1/me/commission/settlement-requests",
    headers:{...auth(referrer.sessionToken),"idempotency-key":"late-refund-settlement-0001"},
    payload:{amountCents:2000,reason:"隔离后续退款竞争测试"}});
  expect(request.statusCode).toBe(200);
  const reserved=await app.inject({method:"POST",
    url:`/v1/management/commission/settlement-requests/${request.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"late-refund-settlement-approve-0001"},
    payload:{decision:"approve",expectedVersion:1,reason:"隔离预占后检查退款"}});
  expect(reserved.statusCode,JSON.stringify(reserved.json())).toBe(200);
  const refund=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/refund-requests`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"late-refund-request-0001"},
    payload:{amountCents:1000,reason:"隔离预占后的售后申请"}});
  expect(refund.statusCode,JSON.stringify(refund.json())).toBe(200);
  // Model an interrupted/historical decision before its channel intent was
  // persisted. The LEFT JOIN must treat a missing intent as unresolved.
  await pool.query(`UPDATE commerce_refund_request SET state='approved',version=version+1,
    decided_by_member_id=$2,decision_key='late-refund-gap-decision',
    decision_hash=$3,decision_reason='历史批准但意图缺失',decided_at=clock_timestamp()
    WHERE id=$1`,[refund.json().id,operator.memberId,"e".repeat(64)]);
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_refund_intent
    WHERE request_id=$1`,[refund.json().id])).rows[0].n).toBe(0);
  expect(await settlementCommands.processDue()).toContainEqual({id:request.json().id,state:"cancelled_invalid_allocation"});
  expect(channelTransfers.has(reserved.json().outBillNo)).toBe(false);
  expect((await pool.query(`SELECT state FROM commission_settlement_request WHERE id=$1`,
    [request.json().id])).rows[0].state).toBe("cancelled");
  const overdraw=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/refund-requests`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"late-refund-gap-overdraw-01"},
    payload:{amountCents:10000,reason:"已有未写入意图的批准退款"}});
  expect(overdraw.statusCode).toBe(409);
  expect(overdraw.json().code).toBe("REFUND_AMOUNT_EXCEEDS_REMAINING");
  const another=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/refund-requests`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"late-refund-gap-another-01"},
    payload:{amountCents:9000,reason:"剩余额度仍需避免审批竞态"}});
  expect(another.statusCode,another.body).toBe(200);
  const blockedDecision=await app.inject({method:"POST",
    url:`/v1/management/refund-requests/${another.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"gap-approval-0001"},
    payload:{decision:"approve",expectedVersion:1,reason:"隔离孤儿批准先核对"}});
  expect(blockedDecision.statusCode).toBe(409);
  expect(blockedDecision.json().code).toBe("REFUND_APPROVED_INTENT_MISSING");
});

it("keeps other-order pending income apart from a paid order refunded in full",async()=>{
  const before=(await app.inject({method:"GET",url:"/v1/me/commercial-membership",
    headers:auth(referrer.sessionToken)})).json().commission;
  const prior=(await pool.query(`SELECT a.order_id FROM commission_settlement_allocation a
    JOIN commission_settlement_request r ON r.id=a.request_id WHERE r.state='succeeded'
    ORDER BY r.created_at LIMIT 1`)).rows[0].order_id as string;
  const full=await app.inject({method:"POST",url:`/v1/me/orders/${prior}/refund-requests`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"n01-full-refund-0001"},
    payload:{amountCents:10000,reason:"隔离跨订单追偿与待结算"}});
  expect(full.statusCode,JSON.stringify(full.json())).toBe(200);
  const approved=await app.inject({method:"POST",url:`/v1/management/refund-requests/${full.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"n01-full-approve-0001"},
    payload:{decision:"approve",expectedVersion:1,reason:"隔离跨订单全额退款"}});
  expect(approved.statusCode,JSON.stringify(approved.json())).toBe(200);
  await refundCommands.processDue();
  const callback=refundCallback(approved.json().intent.outRefundNo);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/refund-callback",
    headers:{...callback.headers,"Content-Type":"application/json"},payload:callback.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  await pool.query(`UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1,
    version=version+1,updated_by='fixture' WHERE sku_id=$1`,[skuId]);
  const next=await createOrder("n01-pending");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${next.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const paid=paidCallback(next.orderNumber);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...paid.headers,"Content-Type":"application/json"},payload:paid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  const status=await app.inject({method:"GET",url:"/v1/me/commercial-membership",
    headers:auth(referrer.sessionToken)});
  expect(status.statusCode,JSON.stringify(status.json())).toBe(200);
  expect(status.json().commission).toMatchObject({pendingCents:before.pendingCents+2000,
    recoveryCents:before.recoveryCents+2000,settledCents:before.settledCents});
});

it("fences other in-flight allocations after a verified refund",async()=>{
  await pool.query(`UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1,
    version=version+1,updated_by='fixture' WHERE sku_id=$1`,[skuId]);
  const order=await createOrder("n02-overlap");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const paid=paidCallback(order.orderNumber);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...paid.headers,"Content-Type":"application/json"},payload:paid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  const proof=await app.inject({method:"POST",url:`/v1/management/commerce/orders/${order.id}/fulfillment`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"n02-proof-0001"},
    payload:{sourceReference:"fixture-carrier-n02-0001",evidenceSha256:"c".repeat(64),
      deliveredAt:new Date().toISOString()}});
  expect(proof.statusCode,JSON.stringify(proof.json())).toBe(200);
  const release=await app.inject({method:"POST",url:`/v1/management/fulfillment/${proof.json().id}/decision`,
    headers:{...auth(reviewer.sessionToken),"idempotency-key":"n02-release-0001"},
    payload:{decision:"verify",expectedVersion:1,reason:"隔离来源已核验"}});
  expect(release.statusCode,JSON.stringify(release.json())).toBe(200);
  const requests=[];
  for(let index=1;index<=2;index++){
    const requested=await app.inject({method:"POST",url:"/v1/me/commission/settlement-requests",
      headers:{...auth(referrer.sessionToken),"idempotency-key":`n02-request-${index}-0001`},
      payload:{amountCents:800,reason:"隔离同订单多笔预占"}});
    expect(requested.statusCode,JSON.stringify(requested.json())).toBe(200);
    const reserved=await app.inject({method:"POST",
      url:`/v1/management/commission/settlement-requests/${requested.json().id}/decision`,
      headers:{...auth(operator.sessionToken),"idempotency-key":`n02-approve-${index}-0001`},
      payload:{decision:"approve",expectedVersion:1,reason:"隔离重核多笔来源"}});
    expect(reserved.statusCode,JSON.stringify(reserved.json())).toBe(200);
    requests.push(reserved.json() as {id:string;outBillNo:string});
  }
  const refund=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/refund-requests`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"n02-refund-0001"},
    payload:{amountCents:5000,reason:"隔离预占后的部分退款"}});
  expect(refund.statusCode,JSON.stringify(refund.json())).toBe(200);
  const approved=await app.inject({method:"POST",url:`/v1/management/refund-requests/${refund.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"n02-refund-approve-0001"},
    payload:{decision:"approve",expectedVersion:1,reason:"隔离已成功部分退款"}});
  expect(approved.statusCode,JSON.stringify(approved.json())).toBe(200);
  await refundCommands.processDue();
  const callback=refundCallback(approved.json().intent.outRefundNo);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/refund-callback",
    headers:{...callback.headers,"Content-Type":"application/json"},payload:callback.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  const results=await settlementCommands.processDue();
  expect(results).toContainEqual({id:requests[0]!.id,state:"submitted_query_due"});
  expect(results).toContainEqual({id:requests[1]!.id,state:"cancelled_invalid_allocation"});
  expect(channelTransfers.has(requests[0]!.outBillNo)).toBe(true);
  expect(channelTransfers.has(requests[1]!.outBillNo)).toBe(false);
});

it("retains a committed may-have-sent fact across restart, lease takeover and redrive",async()=>{
  const active=(await pool.query(`SELECT id,out_bill_no FROM commission_settlement_request
    WHERE state='processing' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  expect(active).toBeDefined();
  const oldToken=(await pool.query(`UPDATE commission_settlement_request SET lease_token=gen_random_uuid()
    WHERE id=$1 RETURNING lease_token`,[active.id])).rows[0].lease_token;
  // The durable boundary remains even after a fresh worker takes the lease.
  await expect(settlementCommands.processOne(active.id,randomUUID())).rejects.toMatchObject({code:"SETTLEMENT_LEASE_LOST"});
  expect((await pool.query(`SELECT first_dispatch_started_at FROM commission_settlement_request
    WHERE id=$1`,[active.id])).rows[0].first_dispatch_started_at).toBeTruthy();
  expect(oldToken).toBeTruthy();
  const source=(await pool.query(`SELECT order_id FROM commission_settlement_allocation
    WHERE request_id=$1`,[active.id])).rows[0].order_id;
  const requested=await app.inject({method:"POST",url:"/v1/me/commission/settlement-requests",
    headers:{...auth(referrer.sessionToken),"idempotency-key":"n03-request-0001"},
    payload:{amountCents:100,reason:"隔离持久发送历史崩溃测试"}});
  expect(requested.statusCode,JSON.stringify(requested.json())).toBe(200);
  const approved=await app.inject({method:"POST",
    url:`/v1/management/commission/settlement-requests/${requested.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"n03-approve-0001"},
    payload:{decision:"approve",expectedVersion:1,reason:"隔离发送前持久边界"}});
  expect(approved.statusCode,JSON.stringify(approved.json())).toBe(200);
  const reserved={id:requested.json().id,out_bill_no:approved.json().outBillNo};
  expect((await pool.query(`SELECT order_id FROM commission_settlement_allocation WHERE request_id=$1`,
    [reserved.id])).rows[0].order_id).toBe(source);
  await pool.query(`UPDATE commission_settlement_request SET state='unknown' WHERE id=$1`,[reserved.id]);
  await pool.query(`UPDATE commission_settlement_request SET state='processing',
    first_dispatch_started_at=clock_timestamp(),attempt_count=8,quarantined_at=clock_timestamp(),
    next_attempt_at=clock_timestamp() WHERE id=$1`,[reserved.id]);
  const redriven=await settlementCommands.redrive(operator.memberId,reserved.id,
    {expectedAttempts:8,reason:"隔离模拟发送边界后恢复查询"});
  expect(redriven.state).toBe("requery_due");
  const fresh=new SettlementCommandService(pool,new AuthorityService(pool,"test"),
    new WechatPayV3Client(merchantId,"MERCHANT_CERT_FIXTURE",merchantPrivate,
      new Map([[serial,platformPublic]]),fetch,baseUrl),"test",
    {appId,merchantId,sceneId:"ISOLATED_COMMISSION",
      notifyUrl:"https://payment-fixture.invalid/v1/payments/wechat/transfer-callback",
      legacyDirectFixture:true});
  expect(await fresh.processDue()).toContainEqual({id:reserved.id,state:"retry_scheduled"});
  const history=(await pool.query(`SELECT attempt_count,first_dispatch_started_at,state
    FROM commission_settlement_request WHERE id=$1`,[reserved.id])).rows[0];
  expect(history.first_dispatch_started_at).toBeTruthy();
  expect(history.state).toBe("processing");
  expect(channelTransfers.has(reserved.out_bill_no)).toBe(false);
});

it("does not reissue payment or refund after a committed dispatch boundary and temporary NOT_FOUND",async()=>{
  await pool.query(`UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+2,
    version=version+1,updated_by='fixture' WHERE sku_id=$1`,[skuId]);
  const payment=await createOrder("n03-payment-crash");
  await pool.query(`UPDATE commerce_payment_attempt SET state='unknown',
    first_dispatch_started_at=clock_timestamp() WHERE order_id=$1`,[payment.id]);
  const retried=await app.inject({method:"POST",url:`/v1/me/orders/${payment.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}});
  expect(retried.statusCode).toBe(409);
  expect(retried.json().code).toBe("PAYMENT_ORIGINAL_QUERY_REQUIRED");
  expect(channelOrders.has(payment.orderNumber)).toBe(false);
  expect((await pool.query(`SELECT principal_id,before_state,after_state FROM audit_log
    WHERE action='commerce.payment_intent.claim' AND object_id=$1`,[payment.id])).rows)
    .toMatchObject([{principal_id:buyer.principalId,before_state:{state:"unknown"},after_state:{state:"unknown"}}]);

  const paidOrder=await createOrder("n03-refund-crash");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${paidOrder.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const paid=paidCallback(paidOrder.orderNumber);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...paid.headers,"Content-Type":"application/json"},payload:paid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  const requested=await app.inject({method:"POST",url:`/v1/me/orders/${paidOrder.id}/refund-requests`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"n03-refund-request-0001"},
    payload:{amountCents:1000,reason:"隔离退款发送后崩溃"}});
  expect(requested.statusCode,JSON.stringify(requested.json())).toBe(200);
  const approved=await app.inject({method:"POST",url:`/v1/management/refund-requests/${requested.json().id}/decision`,
    headers:{...auth(operator.sessionToken),"idempotency-key":"n03-refund-approve-0001"},
    payload:{decision:"approve",expectedVersion:1,reason:"隔离退款原单可靠性"}});
  expect(approved.statusCode,JSON.stringify(approved.json())).toBe(200);
  const intent=approved.json().intent as {id:string;outRefundNo:string};
  await pool.query(`UPDATE commission_refund_intent SET submission_state='unknown',
    first_dispatch_started_at=clock_timestamp(),submission_attempt_count=8,
    submission_quarantined_at=clock_timestamp() WHERE id=$1`,[intent.id]);
  await refundCommands.redrive(operator.memberId,intent.id,
    {expectedAttempts:8,reason:"隔离退款原单人工核对后重驱"});
  const freshRefund=new RefundCommandService(pool,new AuthorityService(pool,"test"),
    new WechatPayV3Client(merchantId,"MERCHANT_CERT_FIXTURE",merchantPrivate,
      new Map([[serial,platformPublic]]),fetch,baseUrl),refundInbox,
    {merchantId,notifyUrl:"https://payment-fixture.invalid/v1/payments/wechat/refund-callback"});
  expect(await freshRefund.processDue()).toContainEqual({id:intent.id,state:"retry_scheduled"});
  expect(channelRefunds.has(intent.outRefundNo)).toBe(false);
  const history=(await pool.query(`SELECT first_dispatch_started_at,submission_attempt_count
    FROM commission_refund_intent WHERE id=$1`,[intent.id])).rows[0];
  expect(history.first_dispatch_started_at).toBeTruthy();
  expect(history.submission_attempt_count).toBe(1);
});

it("downloads a hash-checked trade bill, imports once, and exposes amount conflicts without posting money",async()=>{
  const billOne=new Date(Date.now()+8*60*60*1000-3*24*60*60*1000).toISOString().slice(0,10);
  const billTwo=new Date(Date.now()+8*60*60*1000-2*24*60*60*1000).toISOString().slice(0,10);
  const fact=(await pool.query(`SELECT a.out_trade_no,a.payer_openid,a.amount_cents,
    p.provider_transaction_id FROM commerce_payment_attempt a
    JOIN commerce_order o ON o.id=a.order_id AND o.status='paid'
    JOIN commission_payment_inbox p ON p.order_id=o.id AND p.state='applied'
    ORDER BY a.created_at LIMIT 1`)).rows[0];
  expect(fact).toBeDefined();
  const line=(amount:string)=>`${billOne} 12:00:00,${appId},${merchantId},${fact.provider_transaction_id},${fact.out_trade_no},${fact.payer_openid},CNY,${amount},0.00`;
  const csv=(amount:string)=>Buffer.from(`交易时间,公众账号ID,商户号,微信订单号,商户订单号,用户标识,货币种类,订单金额,代金券金额\n${line(amount)}\n总交易单数,1\n`);
  const prior=(await pool.query("SELECT count(*)::int AS n FROM commission_ledger_entry")).rows[0].n;
  tradeBillFixtures.set(`${billOne}:SUCCESS`,csv("100.00"));
  const path="/v1/management/money/trade-bills/import";
  const noAuthority=await app.inject({method:"POST",url:path,headers:auth(buyer.sessionToken),
    payload:{billDate:billOne,billType:"SUCCESS"}});
  expect(noAuthority.statusCode).toBe(403);
  corruptBillHash=true;
  const tampered=await app.inject({method:"POST",url:path,headers:auth(operator.sessionToken),
    payload:{billDate:billOne,billType:"SUCCESS"}});
  expect(tampered.statusCode).toBe(422);
  corruptBillHash=false;
  const simultaneous=await Promise.all([0,1].map(()=>app.inject({method:"POST",url:path,
    headers:auth(operator.sessionToken),payload:{billDate:billOne,billType:"SUCCESS"}})));
  expect(simultaneous.map(response=>response.statusCode)).toEqual([200,200]);
  expect(simultaneous.map(response=>response.json().replayed).sort()).toEqual([false,true]);
  expect(simultaneous[0]!.json().id).toBe(simultaneous[1]!.json().id);
  const imported=simultaneous.find(response=>!response.json().replayed)!;
  expect(imported.statusCode,JSON.stringify(imported.json())).toBe(200);
  expect(imported.json()).toMatchObject({rowCount:1,matchedCount:1,exceptionCount:0,replayed:false});
  const replay=await app.inject({method:"POST",url:path,headers:auth(operator.sessionToken),
    payload:{billDate:billOne,billType:"SUCCESS"}});
  expect(replay.statusCode).toBe(200);expect(replay.json()).toMatchObject({id:imported.json().id,replayed:true});
  const history=await app.inject({method:"GET",url:"/v1/management/money/trade-bills?limit=1",
    headers:auth(operator.sessionToken)});
  expect(history.statusCode).toBe(200);
  expect(history.json()).toMatchObject({totalCount:1,items:[{id:imported.json().id,rowCount:1}]});
  tradeBillFixtures.set(`${billOne}:SUCCESS`,csv("101.00"));
  const changed=await app.inject({method:"POST",url:path,headers:auth(operator.sessionToken),
    payload:{billDate:billOne,billType:"SUCCESS"}});
  expect(changed.statusCode).toBe(409);expect(changed.json().code).toBe("TRADE_BILL_CHANGED");
  tradeBillFixtures.set(`${billTwo}:SUCCESS`,csv("101.00"));
  const conflict=await app.inject({method:"POST",url:path,headers:auth(operator.sessionToken),
    payload:{billDate:billTwo,billType:"SUCCESS"}});
  expect(conflict.statusCode,JSON.stringify(conflict.json())).toBe(200);
  expect(conflict.json()).toMatchObject({rowCount:1,matchedCount:0,exceptionCount:1});
  const issues=await app.inject({method:"GET",url:"/v1/management/money/issues?limit=50",
    headers:auth(operator.sessionToken)});
  expect(issues.statusCode).toBe(200);
  expect(issues.json().items).toContainEqual(expect.objectContaining({kind:"trade_bill",
    code:"PAYMENT_FACT_MISMATCH",canRedrive:false}));
  const refundFact=(await pool.query(`SELECT i.out_refund_no,i.refund_cents,i.payer_refund_cents,
    o.order_number,p.provider_refund_id,
    to_char(ob.accepted_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS acceptance_time
    FROM commission_refund_intent i
    JOIN commerce_order o ON o.id=i.order_id
    JOIN commission_refund_inbox p ON p.refund_intent_id=i.id AND p.state='applied'
    JOIN LATERAL (SELECT accepted_at FROM commission_refund_channel_observation
      WHERE refund_intent_id=i.id ORDER BY observed_at,id LIMIT 1) ob ON true
    ORDER BY i.created_at LIMIT 1`)).rows[0];
  expect(refundFact).toBeDefined();
  const money=(value:number)=>(value/100).toFixed(2);
  tradeBillFixtures.set(`${billOne}:REFUND`,Buffer.from(
    `交易时间,退款申请时间,商户号,商户订单号,商户退款单号,微信退款单号,货币种类,申请退款金额,退款金额\n`+
    `${refundFact.acceptance_time},${refundFact.acceptance_time},${merchantId},${refundFact.order_number},${refundFact.out_refund_no},`+
    `${refundFact.provider_refund_id},CNY,${money(Number(refundFact.refund_cents))},`+
    `${money(Number(refundFact.payer_refund_cents))}\n总退款单数,1\n`));
  const refundBill=await app.inject({method:"POST",url:path,headers:auth(operator.sessionToken),
    payload:{billDate:billOne,billType:"REFUND"}});
  expect(refundBill.statusCode,JSON.stringify(refundBill.json())).toBe(200);
  expect(refundBill.json()).toMatchObject({rowCount:1,matchedCount:0,exceptionCount:1});
  expect((await pool.query(`SELECT exception_code FROM commerce_trade_bill_row WHERE batch_id=$1`,
    [refundBill.json().id])).rows[0].exception_code).toBe("REFUND_ACCEPTANCE_TIME_MISMATCH");
  expect((await pool.query("SELECT count(*)::int AS n FROM commission_ledger_entry")).rows[0].n).toBe(prior);
});

it("flags an internal paid order missing from a complete signed daily trade bill",async()=>{
  const yesterday=new Date(Date.now()+8*60*60*1000-24*60*60*1000).toISOString().slice(0,10);
  await pool.query(`UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1,
    version=version+1,updated_by='fixture' WHERE sku_id=$1`,[skuId]);
  const order=await createOrder("bill-internal-only");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  // Isolated historical-bill fixture: keep the signed success timestamp inside
  // the order's persisted payment window without changing any inbox evidence.
  await pool.query(`UPDATE commerce_order SET created_at=$2::timestamptz,
    expires_at=$3::timestamptz WHERE id=$1`,[order.id,
      `${yesterday}T11:00:00+08:00`,`${yesterday}T13:00:00+08:00`]);
  const paid=paidCallback(order.orderNumber,undefined,`${yesterday}T12:00:00+08:00`);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...paid.headers,"Content-Type":"application/json"},payload:paid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  tradeBillFixtures.set(`${yesterday}:SUCCESS`,Buffer.from(
    "交易时间,公众账号ID,商户号,微信订单号,商户订单号,用户标识,货币种类,订单金额,代金券金额\n总交易单数,0\n"));
  const imported=await app.inject({method:"POST",url:"/v1/management/money/trade-bills/import",
    headers:auth(operator.sessionToken),payload:{billDate:yesterday,billType:"SUCCESS"}});
  expect(imported.statusCode,JSON.stringify(imported.json())).toBe(200);
  expect(imported.json()).toMatchObject({matchedCount:0,exceptionCount:1});
  const row=(await pool.query(`SELECT exception_code,related_id FROM commerce_trade_bill_row
    WHERE batch_id=$1`,[imported.json().id])).rows[0];
  expect(row).toEqual({exception_code:"PAYMENT_MISSING_PROVIDER_BILL",related_id:order.id});
});

it("never clears a complete bill that omits a signed but quarantined discounted payment",async()=>{
  const day=new Date(Date.now()+8*60*60*1000-4*24*60*60*1000).toISOString().slice(0,10);
  await pool.query(`UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1,
    version=version+1,updated_by='fixture' WHERE sku_id=$1`,[skuId]);
  const order=await createOrder("bill-discounted-exception");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  await pool.query(`UPDATE commerce_order SET created_at=$2::timestamptz,
    expires_at=$3::timestamptz WHERE id=$1`,[order.id,
      `${day}T11:00:00+08:00`,`${day}T13:00:00+08:00`]);
  const paid=paidCallback(order.orderNumber,undefined,`${day}T12:00:00+08:00`,9900);
  expect((await app.inject({method:"POST",url:"/v1/payments/wechat/callback",
    headers:{...paid.headers,"Content-Type":"application/json"},payload:paid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  const fact=(await pool.query(`SELECT state,composition_status FROM commission_payment_inbox
    WHERE order_id=$1`,[order.id])).rows[0];
  expect(fact).toMatchObject({state:"exception",composition_status:"unknown_or_discounted"});
  tradeBillFixtures.set(`${day}:SUCCESS`,Buffer.from(
    "交易时间,公众账号ID,商户号,微信订单号,商户订单号,用户标识,货币种类,订单金额,代金券金额\n总交易单数,0\n"));
  const imported=await app.inject({method:"POST",url:"/v1/management/money/trade-bills/import",
    headers:auth(operator.sessionToken),payload:{billDate:day,billType:"SUCCESS"}});
  expect(imported.statusCode,JSON.stringify(imported.json())).toBe(200);
  expect(imported.json()).toMatchObject({matchedCount:0,exceptionCount:1});
  expect((await pool.query(`SELECT exception_code,related_id FROM commerce_trade_bill_row
    WHERE batch_id=$1`,[imported.json().id])).rows[0])
    .toEqual({exception_code:"PAYMENT_MISSING_PROVIDER_BILL",related_id:order.id});
});

it("flags a channel-observed refund missing from an otherwise complete REFUND bill",async()=>{
  const yesterday=new Date(Date.now()+8*60*60*1000-24*60*60*1000).toISOString().slice(0,10);
  const paid=(await pool.query<{id:string;order_id:string;order_number:string}>(`SELECT p.id,p.order_id,o.order_number
    FROM commission_payment_inbox p JOIN commerce_order o ON o.id=p.order_id
    WHERE p.state='applied' AND o.status='paid' LIMIT 1`)).rows[0]!;
  // Synthetic signed-query observation: this isolates the reverse selector.
  // The normal path inserts the same record only after verified HTTP bytes.
  const refunds:string[]=[];
  for(const index of [1,2]){
    const refund=(await pool.query<{id:string}>(`INSERT INTO commission_refund_intent
      (order_id,payment_inbox_id,out_refund_no,refund_cents,payer_refund_cents,
        eligible_merchandise_refund_cents,other_merchandise_refund_cents,shipping_cash_refund_cents,
        line_allocation,allocation_policy_version,created_by)
      VALUES($1,$2,$3,1,1,1,0,0,'[]','isolated-test-v1','fixture') RETURNING id`,
      [paid.order_id,paid.id,`RF-MISSING-PROVIDER-00${index}`])).rows[0]!;
    refunds.push(refund.id);
    await pool.query(`INSERT INTO commission_refund_channel_observation
      (refund_intent_id,source_kind,raw_sha256,provider_refund_id,accepted_at)
      VALUES($1,'signed_query',$2,$3,$4)`,
      [refund.id,createHash("sha256").update(`refund-observed:${refund.id}`).digest("hex"),
        `REFUND-PROVIDER-MISSING-00${index}`,`${yesterday}T12:00:00+08:00`]);
  }
  tradeBillFixtures.set(`${yesterday}:REFUND`,Buffer.from(
    `交易时间,退款申请时间,商户号,商户订单号,商户退款单号,微信退款单号,货币种类,申请退款金额,退款金额\n`+
    `${yesterday} 12:00:00,${yesterday} 12:00:00,${merchantId},${paid.order_number},`+
    `RF-MISSING-PROVIDER-001,REFUND-PROVIDER-MISSING-001,CNY,0.01,0.01\n总退款单数,1\n`));
  const imported=await app.inject({method:"POST",url:"/v1/management/money/trade-bills/import",
    headers:auth(operator.sessionToken),payload:{billDate:yesterday,billType:"REFUND"}});
  expect(imported.statusCode,JSON.stringify(imported.json())).toBe(200);
  expect(imported.json()).toMatchObject({rowCount:2,matchedCount:1,exceptionCount:1});
  expect((await pool.query(`SELECT exception_code,related_id FROM commerce_trade_bill_row WHERE batch_id=$1`,
    [imported.json().id])).rows).toEqual(expect.arrayContaining([
      {exception_code:null,related_id:refunds[0]},
      {exception_code:"REFUND_MISSING_PROVIDER_BILL",related_id:refunds[1]}
    ]));
});

it("assembles pinned formal trust through isolated payment, callback, refund and worker routes without non-loopback egress",async()=>{
  const fixtureDir=await mkdtemp(join(tmpdir(),"cisme-formal-protocol-"));
  let formalApp:FastifyInstance|undefined;
  try{
    const merchantPath=join(fixtureDir,"merchant.pem"),platformPath=join(fixtureDir,"platform.pem"),
      apiKeyPath=join(fixtureDir,"api-v3.key"),manifestPath=join(fixtureDir,"trust.json");
    await writeFile(merchantPath,merchantPrivate,{mode:0o600});
    await writeFile(platformPath,platformPublic,{mode:0o600});
    await writeFile(apiKeyPath,apiV3Key,{mode:0o600});
    await writeFile(manifestPath,JSON.stringify({schemaVersion:1,
      keys:[{id:serial,publicKeyFile:platformPath}]}),{mode:0o600});
    const config=loadConfig({APP_ENV:"test",DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"payment-http-session",
      ADMIN_API_TOKEN:"payment-http-admin",UPLOAD_TOKEN_SECRET:"payment-http-upload",OBJECT_STORAGE_DRIVER:"api_gateway",
      CONTACT_ENCRYPTION_KEY:"11".repeat(32),CONTACT_HASH_KEY:"22".repeat(32),CONTACT_KEY_VERSION:"payment-test-v1",
      COMMERCE_ORDER_FLOW_ENABLED:"true",COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED:"true",
      WECHAT_APP_ID:appId,COMMERCE_FORMAL_MERCHANT_ID:merchantId,COMMERCE_FORMAL_MERCHANT_SERIAL:"MERCHANT_CERT_FIXTURE",
      COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE:merchantPath,COMMERCE_FORMAL_API_V3_KEY_FILE:apiKeyPath,
      COMMERCE_FORMAL_PLATFORM_TRUST_FILE:manifestPath,
      COMMERCE_FORMAL_PAYMENT_NOTIFY_URL:"https://formal-fixture.invalid/v1/payments/wechat/callback",
      COMMERCE_FORMAL_REFUND_NOTIFY_URL:"https://formal-fixture.invalid/v1/payments/wechat/refund-callback"});
    let syntheticCalls=0;
    const loopbackOnly:typeof fetch=(input,init)=>{
      const original=new URL(String(input));
      if(original.origin!=="https://api.mch.weixin.qq.com")throw new Error("NON_LOOPBACK_EGRESS_FORBIDDEN");
      syntheticCalls+=1;
      return fetch(`${baseUrl}${original.pathname}${original.search}`,init);
    };
    const protocol=formalPaymentProtocol(config,pool,loopbackOnly)!;
    expect(protocol.networkAuthorized).toBe(false);
    const inert=await createApp({config,pool,storage:createApiGatewayStorage(config),
      paymentProtocol:formalPaymentProtocol(config,pool)!});
    try{
      expect((await inert.inject({method:"POST",url:"/v1/payments/wechat/callback",payload:{}})).statusCode).toBe(503);
      expect((await inert.inject({method:"POST",url:`/v1/me/orders/${randomUUID()}/payment-intent`,
        headers:auth(buyer.sessionToken),payload:{}})).json().code).toBe("FORMAL_PAYMENT_NEW_COMMAND_DISABLED");
    }finally{await inert.close();}
    await expect(createApp({config:{...config,env:"staging"},pool,
      storage:createApiGatewayStorage(config),paymentProtocol:protocol}))
      .rejects.toThrow("FAIL_CLOSED:PAYMENT_PROTOCOL_NO_ISOLATED_PROFILE");
    formalApp=await createApp({config,pool,storage:createApiGatewayStorage(config),paymentProtocol:protocol});
    expect((await formalApp.inject({method:"GET",url:"/v1/commerce/orders/status"})).json().scope)
      .toBe("formal_protocol_synthetic_test");
    await pool.query(`UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1,
      version=version+1,updated_by='fixture' WHERE sku_id=$1`,[skuId]);
    const order=await createOrder("formal-local",formalApp);
    const prepay=await formalApp.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,
      headers:auth(buyer.sessionToken),payload:{}});
    expect(prepay.statusCode,JSON.stringify(prepay.json())).toBe(200);
    expect(prepay.json()).toMatchObject({simulation:true,state:"prepay_ready"});
    const paid=paidCallback(order.orderNumber);
    expect((await formalApp.inject({method:"POST",url:"/v1/payments/wechat/callback",
      headers:{...paid.headers,"Content-Type":"application/json"},payload:paid.raw})).statusCode).toBe(204);
    const grantPath=join(fixtureDir,"recovery-authorization.json");
    await writeFile(grantPath,JSON.stringify({schemaVersion:1,mode:"ordinary-merchant-recovery-only",environment:"staging",
      appId,merchantId,approvalReference:"synthetic-recovery-test",expiresAt:new Date(Date.now()+60000).toISOString(),
      capabilities:["payment.callback"]}),{mode:0o600});
    const recoveryConfig={...config,env:"staging" as const,commerce:{...config.commerce,orderFlowEnabled:false,
      formalProtocol:{...config.commerce.formalProtocol!,recoveryAuthorizationFile:grantPath}}};
    const recoveryProtocol=formalPaymentProtocol(recoveryConfig,pool)!;
    const recoveryApp=await createApp({config:recoveryConfig,pool,storage:createApiGatewayStorage(config),paymentProtocol:recoveryProtocol});
    try{
      // New orders/money remain closed while an independently authorized historical callback persists.
      expect((await recoveryApp.inject({method:"POST",url:"/v1/payments/wechat/callback",
        headers:{...paid.headers,"Content-Type":"application/json"},payload:paid.raw})).statusCode).toBe(204);
      expect((await recoveryApp.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,
        headers:auth(buyer.sessionToken),payload:{}})).json().code).toBe("FORMAL_PAYMENT_NEW_COMMAND_DISABLED");
      expect((await recoveryApp.inject({method:"GET",url:`/v1/me/orders/${order.id}/payment-intent`,
        headers:auth(buyer.sessionToken)})).statusCode).toBe(503);
      await rm(grantPath);
      expect((await recoveryApp.inject({method:"POST",url:"/v1/payments/wechat/callback",
        headers:{...paid.headers,"Content-Type":"application/json"},payload:paid.raw})).statusCode).toBeGreaterThanOrEqual(500);
    }finally{await recoveryApp.close();}
    await runMoneyWorkerCycle(protocol.inbox,protocol.refundInbox);
    expect((await pool.query(`SELECT status FROM commerce_order WHERE id=$1`,[order.id])).rows[0].status).toBe("paid");
    const request=await formalApp.inject({method:"POST",url:`/v1/me/orders/${order.id}/refund-requests`,
      headers:{...auth(buyer.sessionToken),"idempotency-key":"formal-refund-req"},
      payload:{amountCents:1000,reason:"合成正式协议退款"}});
    expect(request.statusCode,JSON.stringify(request.json())).toBe(200);
    const approved=await formalApp.inject({method:"POST",url:`/v1/management/refund-requests/${request.json().id}/decision`,
      headers:{...auth(operator.sessionToken),"idempotency-key":"formal-refund-approve"},
      payload:{decision:"approve",expectedVersion:1,reason:"正式装配隔离复核"}});
    expect(approved.statusCode,JSON.stringify(approved.json())).toBe(200);
    const formalRefund=new RefundCommandService(pool,new AuthorityService(pool,"test"),protocol.channel,
      protocol.refundInbox,{merchantId,notifyUrl:protocol.refundNotifyUrl});
    expect(await formalRefund.processDue()).toContainEqual({id:approved.json().intent.id,state:"accepted_processing"});
    const refunded=refundCallback(approved.json().intent.outRefundNo);
    expect((await formalApp.inject({method:"POST",url:"/v1/payments/wechat/refund-callback",
      headers:{...refunded.headers,"Content-Type":"application/json"},payload:refunded.raw})).statusCode).toBe(204);
    await runMoneyWorkerCycle(protocol.inbox,protocol.refundInbox,formalRefund);
    expect((await pool.query(`SELECT state FROM commission_refund_inbox WHERE refund_intent_id=$1`,
      [approved.json().intent.id])).rows[0].state).toBe("applied");
    // Exercise the v2 command composition on the SAME owned isolated DB and
    // signed loopback provider. These injected approvals are never runtime files.
    let commandsEnabled=true;
    const commandCaps:string[]=[];
    const commandApp=await createApp({config,pool,storage:createApiGatewayStorage(config),paymentProtocol:{...protocol,
      isolatedSyntheticTransport:false,formalRecovery:true,
      authorizeRecovery:()=>"synthetic-recovery-only",
      authorizeCommerce:(capability)=>{commandCaps.push(capability);if(!commandsEnabled)throw new DomainError('FORMAL_COMMERCE_NOT_AUTHORIZED','Synthetic command revoked',503);return "synthetic-command-only";}}});
    try{
      expect((await commandApp.inject({method:'GET',url:'/v1/commerce/orders/status'})).json())
        .toMatchObject({version:2,scope:'formal_commerce',paymentAvailable:true,formalMoneyOperationsAvailable:true,isolatedMoneyOperationsAvailable:false,isolatedTransferAvailable:false});
      await pool.query("UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1 WHERE sku_id=$1",[skuId]);
      const addressId=(await pool.query('SELECT address_id FROM commerce_checkout_quote WHERE id=(SELECT source_quote_id FROM commerce_order WHERE id=$1)',[order.id])).rows[0].address_id;
      const rejected=await commandApp.inject({method:'POST',url:'/v1/me/commerce/quotes',headers:{...auth(buyer.sessionToken),'idempotency-key':'formal-reject-synthetic'},payload:{skuId,quantity:1,addressId,addressVersion:1}});
      expect(rejected.json().code).toBe('COMMERCE_FORMAL_PRODUCT_REQUIRED');
      // Fixture-only source change in this run's disposable DB; no live product is published.
      await pool.query("UPDATE catalog_product SET source_kind='admin' WHERE id=(SELECT product_id FROM catalog_sku WHERE id=$1)",[skuId]);
      const productCode=(await pool.query('SELECT code FROM catalog_product WHERE id=(SELECT product_id FROM catalog_sku WHERE id=$1)',[skuId])).rows[0].code;
      expect((await commandApp.inject({method:'GET',url:`/v1/catalog/${productCode}`})).json().purchaseEnabled).toBe(true);
      const liveShape=await createOrder('formal-command-local',commandApp);
      expect((await pool.query('SELECT transaction_source_kind FROM commerce_order WHERE id=$1',[liveShape.id])).rows[0].transaction_source_kind).toBe('verified_commerce');
      const liveIntent=await commandApp.inject({method:'POST',url:`/v1/me/orders/${liveShape.id}/payment-intent`,headers:auth(buyer.sessionToken),payload:{}});
      expect(liveIntent.statusCode,JSON.stringify(liveIntent.json())).toBe(200);
      expect(liveIntent.json()).toMatchObject({simulation:false,state:'prepay_ready',requestPayment:{signType:'RSA'}});
      expect(commandCaps).toContain('payment.prepare');
      commandsEnabled=false;
      expect((await commandApp.inject({method:'GET',url:`/v1/catalog/${productCode}`})).json().purchaseEnabled).toBe(false);
      expect((await commandApp.inject({method:'GET',url:'/v1/commerce/orders/status'})).json())
        .toMatchObject({paymentAvailable:false,orderFlowEnabled:false,formalRecoveryAvailable:true});
      expect((await commandApp.inject({method:'POST',url:`/v1/me/orders/${liveShape.id}/payment-intent`,headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(503);
      expect((await commandApp.inject({method:'GET',url:`/v1/me/orders/${liveShape.id}`,headers:auth(buyer.sessionToken)})).statusCode).toBe(200);
      const completed=paidCallback(liveShape.orderNumber);
      expect((await commandApp.inject({method:'POST',url:'/v1/payments/wechat/callback',headers:{...completed.headers,'Content-Type':'application/json'},payload:completed.raw})).statusCode).toBe(204);
      await runMoneyWorkerCycle(protocol.inbox,protocol.refundInbox);
      expect((await pool.query('SELECT status FROM commerce_order WHERE id=$1',[liveShape.id])).rows[0].status).toBe('paid');
      const directRefund=await commandApp.inject({method:'POST',url:`/v1/me/orders/${liveShape.id}/refund-requests`,
        headers:{...auth(buyer.sessionToken),'idempotency-key':'formal-direct-refund-denied'},
        payload:{amountCents:1000,reason:'正式订单不得绕过售后案件'}});
      expect(directRefund.statusCode).toBe(409);
      expect(directRefund.json().code).toBe('AFTERSALE_CASE_REQUIRED');
      expect((await pool.query('SELECT count(*)::int AS count FROM commerce_refund_request WHERE order_id=$1',[liveShape.id])).rows[0].count).toBe(0);
    }finally{await commandApp.close();await pool.query("UPDATE catalog_product SET source_kind='synthetic_test' WHERE id=(SELECT product_id FROM catalog_sku WHERE id=$1)",[skuId]);}
    expect(syntheticCalls).toBeGreaterThanOrEqual(2);
  }finally{
    await formalApp?.close();
    await rm(fixtureDir,{recursive:true,force:true});
  }
});

it("spends source-attributed test credit beside signed cash, and releases an unpaid reservation",creditSpendCase);


for(const mismatch of ['appid','mchid','openid','amount'] as const)it(`does not release inventory for a signed CLOSED query with mismatched ${mismatch}`,async()=>{
  await pool.query("UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1 WHERE sku_id=$1",[skuId]);
  const order=await createOrder(`closed-query-binding-${mismatch}`);
  expect((await app.inject({method:'POST',url:`/v1/me/orders/${order.id}/payment-intent`,headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const channelOrder=channelOrders.get(order.orderNumber)!;
  channelOrder.state='CLOSED';
  if(mismatch==='amount')channelOrder.amount+=1;
  else channelOrder[mismatch]='different-synthetic-binding';
  const before=(await pool.query('SELECT status FROM commerce_inventory_reservation WHERE order_id=$1',[order.id])).rows[0].status;
  const response=await app.inject({method:'POST',url:`/v1/me/orders/${order.id}/cancel-verified`,
    headers:{...auth(buyer.sessionToken),'idempotency-key':`closed-query-cancel-${mismatch}`},payload:{expectedVersion:order.version,reason:'Synthetic signed mismatch'}});
  expect(response.statusCode).toBe(422);expect(response.json().code).toBe('WECHAT_PAY_FACT_INVALID');
  expect((await pool.query('SELECT status FROM commerce_order WHERE id=$1',[order.id])).rows[0].status).toBe('pending_payment');
  expect((await pool.query('SELECT status FROM commerce_inventory_reservation WHERE order_id=$1',[order.id])).rows[0].status).toBe(before);
  expect((await pool.query("SELECT 1 FROM audit_log WHERE object_id=$1 AND action='commerce.order.cancel'",[order.id])).rowCount).toBe(0);
});

it('does not release stock when an ORDER_NOT_EXIST response races a dispatched prepay',async()=>{
 await pool.query("UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1 WHERE sku_id=$1",[skuId]);
 const order=await createOrder('missing-query-prepay-race');
 let release!:()=>void,entered!:()=>void;
 const arrived=new Promise<void>(resolve=>{entered=resolve;});
 missingQueryBarrier={orderNumber:order.orderNumber,entered,wait:new Promise<void>(resolve=>{release=resolve;})};
 const cancellation=app.inject({method:'POST',url:`/v1/me/orders/${order.id}/cancel-verified`,
  headers:{...auth(buyer.sessionToken),'idempotency-key':'missing-query-prepay-cancel'},payload:{expectedVersion:order.version,reason:'Synthetic channel race'}});
 try{
  await arrived;
  const payment=await app.inject({method:'POST',url:`/v1/me/orders/${order.id}/payment-intent`,headers:auth(buyer.sessionToken),payload:{}});
  expect(payment.statusCode).toBe(200);
  release();const result=await cancellation;
  expect(result.statusCode).toBe(409);expect(result.json().code).toBe('PAYMENT_CLOSE_REQUIRED');
  expect((await pool.query('SELECT status FROM commerce_order WHERE id=$1',[order.id])).rows[0].status).toBe('pending_payment');
  expect((await pool.query('SELECT status FROM commerce_inventory_reservation WHERE order_id=$1',[order.id])).rows[0].status).toBe('active');
  expect(channelOrders.get(order.orderNumber)?.state).toBe('NOTPAY');
 }finally{release();await cancellation;missingQueryBarrier=undefined;}
});

it('rechecks subject authority at the committed dispatch marker across independent transactions',async()=>{
 await pool.query("UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1 WHERE sku_id=$1",[skuId]);
 const order=await createOrder('prepay-member-revocation');
 const blocker=await pool.connect();let pending:Promise<{statusCode:number;json():{code?:string}}>|undefined;
 try{
  await blocker.query('BEGIN');
  await blocker.query("UPDATE member SET status='blocked' WHERE id=$1",[buyer.memberId]);
  pending=app.inject({method:'POST',url:`/v1/me/orders/${order.id}/payment-intent`,headers:auth(buyer.sessionToken),payload:{}});
  let waiting=false;
  for(let i=0;i<100;i++){
   const observed=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT 1 FROM member%' AND query LIKE '%FOR SHARE%'");
   if(observed.rowCount){waiting=true;break;}
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(waiting).toBe(true);expect(channelOrders.has(order.orderNumber)).toBe(false);
  await blocker.query('COMMIT');
  const result=await pending;
  expect(result.statusCode).toBe(403);expect(result.json().code).toBe('MEMBER_NOT_ACTIVE');
  expect(channelOrders.has(order.orderNumber)).toBe(false);
  expect((await pool.query('SELECT first_dispatch_started_at FROM commerce_payment_attempt WHERE order_id=$1',[order.id])).rows[0].first_dispatch_started_at).toBeNull();
  expect((await pool.query('SELECT status FROM commerce_inventory_reservation WHERE order_id=$1',[order.id])).rows[0].status).toBe('active');
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;await pool.query("UPDATE member SET status='active' WHERE id=$1",[buyer.memberId]);}
});

for(const replay of [false,true])it(`rejects a ${replay?'replayed':'new'} refund request after a concurrent member block without side effects`,async()=>{
 await pool.query('UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1 WHERE sku_id=$1',[skuId]);
 const order=await createOrder(`refund-block-${replay}`);
 expect((await app.inject({method:'POST',url:`/v1/me/orders/${order.id}/payment-intent`,headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
 const payment=paidCallback(order.orderNumber);
 expect((await app.inject({method:'POST',url:'/v1/payments/wechat/callback',headers:{...payment.headers,'Content-Type':'application/json'},payload:payment.raw})).statusCode).toBe(204);
 await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
 const options={method:'POST' as const,url:`/v1/me/orders/${order.id}/refund-requests`,headers:{...auth(buyer.sessionToken),'idempotency-key':`refund-block-key-${replay}`},payload:{amountCents:1000,reason:'合成封禁并发退款请求'}};
 if(replay)expect((await app.inject(options)).statusCode).toBe(200);
 const beforeRefunds=channelRefunds.size,beforeAudit=(await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='commerce.refund.request'")).rows[0].n;
 const blocker=await pool.connect();let pending:Promise<{statusCode:number}>|undefined;
 try{
  await blocker.query('BEGIN');await blocker.query("UPDATE member SET status='blocked' WHERE id=$1",[buyer.memberId]);
  let settled=false;pending=app.inject(options).finally(()=>{settled=true;});
  for(let n=0;n<50&&!settled;n++){
   if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount)break;
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  await blocker.query('COMMIT');expect((await pending).statusCode).toBe(403);
  expect((await pool.query('SELECT count(*)::int n FROM commerce_refund_request WHERE order_id=$1',[order.id])).rows[0].n).toBe(replay?1:0);
  expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='commerce.refund.request'")).rows[0].n).toBe(beforeAudit);
  expect((await pool.query('SELECT count(*)::int n FROM commission_refund_intent WHERE order_id=$1',[order.id])).rows[0].n).toBe(0);
  expect(channelRefunds.size).toBe(beforeRefunds);
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;await pool.query("UPDATE member SET status='active' WHERE id=$1",[buyer.memberId]);}
});

for(const surface of ['refund','fulfillment','money','bill'] as const)it(`rechecks current capability before returning the ${surface} management queue`,async()=>{
 const actor=(await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:`queue-revoked-${surface}`,displayName:'synthetic queue reader',
  consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}})).json();
 await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
  VALUES($1,$2,'fixture','synthetic queue withdrawal','test','integration_fixture')`,[actor.memberId,surface==='refund'?'commerce.refund.approve':surface==='fulfillment'?'commerce.fulfillment.manage':'commerce.money.reconcile']);
 const options={url:surface==='refund'?'/v1/management/refund-requests/pending':surface==='fulfillment'?'/v1/management/fulfillment/pending':surface==='money'?'/v1/management/money/issues':'/v1/management/money/trade-bills',headers:auth(actor.sessionToken)};
 expect((await app.inject(options)).statusCode).toBe(200);
 const blocker=await pool.connect();let pending:Promise<{statusCode:number}>|undefined;
 try{
  await blocker.query('BEGIN');await blocker.query("UPDATE authority_grant SET revoked_at=clock_timestamp(),revoked_by='fixture',revoke_reason='synthetic revoke' WHERE member_id=$1",[actor.memberId]);
  let settled=false;pending=app.inject(options).finally(()=>{settled=true;});
  for(let n=0;n<50&&!settled;n++){
   if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount)break;
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  await blocker.query('COMMIT');expect((await pending).statusCode).toBe(403);
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});

for(const surface of ['refund','settlement'] as const)it(`denies own ${surface} history after a concurrent account block`,async()=>{
 const options={url:surface==='refund'?'/v1/me/refund-requests':'/v1/me/commission/settlement-requests',headers:auth(buyer.sessionToken)};
 expect((await app.inject(options)).statusCode).toBe(200);
 const blocker=await pool.connect();let pending:Promise<{statusCode:number}>|undefined;
 try{
  await blocker.query('BEGIN');await blocker.query("UPDATE member SET status='blocked' WHERE id=$1",[buyer.memberId]);
  let settled=false;pending=app.inject(options).finally(()=>{settled=true;});
  for(let n=0;n<50&&!settled;n++){
   if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount)break;
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  await blocker.query('COMMIT');expect((await pending).statusCode).toBe(403);
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;await pool.query("UPDATE member SET status='active' WHERE id=$1",[buyer.memberId]);}
});


for(const kind of ['payment','refund','transfer'] as const)for(const withdrawal of ['grant','member'] as const)
it(`denies ${kind} management recheck after concurrent ${withdrawal} withdrawal without querying the channel`,async()=>{
 const actor=(await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:`recheck-${kind}-${withdrawal}`,
  displayName:'synthetic recheck operator',consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}})).json();
 await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
  VALUES($1,'commerce.money.reconcile','fixture','synthetic recheck withdrawal','test','integration_fixture')`,[actor.memberId]);
 const target=kind==='payment'?(await pool.query('SELECT order_id AS id FROM commerce_payment_attempt LIMIT 1')).rows[0].id:
  kind==='refund'?(await pool.query('SELECT id FROM commission_refund_intent LIMIT 1')).rows[0].id:
  (await pool.query('SELECT id FROM commission_settlement_request LIMIT 1')).rows[0].id;
 const beforeChannel=channelRequestCount;
 const beforeFacts=(await pool.query(`SELECT (SELECT count(*) FROM commission_payment_inbox) AS payments,
  (SELECT count(*) FROM commission_refund_inbox) AS refunds,(SELECT count(*) FROM commission_transfer_fact) AS transfers,
  (SELECT count(*) FROM audit_log WHERE action='commerce.money.recheck_admitted') AS admissions`)).rows[0];
 const holder=await pool.connect();let pending:Promise<{statusCode:number;json:()=>{code?:string}}>|undefined;
 try{
  await holder.query('BEGIN');
  if(withdrawal==='grant')await holder.query(`UPDATE authority_grant SET revoked_at=clock_timestamp(),revoked_by='fixture',
   revoke_reason='synthetic withdrawal' WHERE member_id=$1`,[actor.memberId]);
  else await holder.query("UPDATE member SET status='blocked' WHERE id=$1",[actor.memberId]);
  let settled=false;pending=app.inject({method:'POST',url:`/v1/management/money/recheck/${kind}/${target}`,
   headers:auth(actor.sessionToken),payload:{}}).finally(()=>{settled=true;});
  for(let n=0;n<50&&!settled;n++){
   if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount)break;
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  await holder.query('COMMIT');const response=await pending;
  expect(response.statusCode).toBe(403);expect(response.json().code).toBe('CAPABILITY_REQUIRED');
  expect(channelRequestCount).toBe(beforeChannel);
  expect((await pool.query(`SELECT (SELECT count(*) FROM commission_payment_inbox) AS payments,
   (SELECT count(*) FROM commission_refund_inbox) AS refunds,(SELECT count(*) FROM commission_transfer_fact) AS transfers,
   (SELECT count(*) FROM audit_log WHERE action='commerce.money.recheck_admitted') AS admissions`)).rows[0]).toEqual(beforeFacts);
 }finally{await holder.query('ROLLBACK');holder.release();await pending;}
});


for(const kind of ['payment','refund','transfer'] as const)it(`commits ${kind} recheck admission before signed channel I/O`,async()=>{
 const target=kind==='payment'?(await pool.query(`SELECT o.id FROM commerce_order o JOIN commerce_payment_attempt a ON a.order_id=o.id
   WHERE o.order_number=ANY($1::text[]) AND o.status='paid' ORDER BY o.created_at LIMIT 1`,
   [[...channelOrders].filter(([,v])=>v.state==='SUCCESS').map(([k])=>k)])).rows[0].id:
  kind==='refund'?(await pool.query('SELECT id FROM commission_refund_intent WHERE out_refund_no=ANY($1::text[]) LIMIT 1',
   [[...channelRefunds].filter(([,v])=>v.status==='SUCCESS').map(([k])=>k)])).rows[0].id:
  (await pool.query('SELECT id FROM commission_settlement_request WHERE out_bill_no=ANY($1::text[]) LIMIT 1',[[...channelTransfers.keys()]])).rows[0].id;
 const beforeChannel=channelRequestCount;
 recheckAdmissionObservation={target,visible:[]};
 try{
  const response=await app.inject({method:'POST',url:`/v1/management/money/recheck/${kind}/${target}`,
   headers:auth(operator.sessionToken),payload:{}});
  expect(response.statusCode,JSON.stringify(response.json())).toBe(200);
  expect(channelRequestCount).toBe(beforeChannel+1);expect(recheckAdmissionObservation.visible).toEqual([true]);
  const audit=(await pool.query("SELECT principal_id,reason_code,after_state FROM audit_log WHERE action='commerce.money.recheck_admitted' AND object_id=$1",[target])).rows;
  expect(audit).toEqual([{principal_id:`member:${operator.memberId}`,reason_code:'SIGNED_ORIGINAL_QUERY',after_state:{kind}}]);
 }finally{recheckAdmissionObservation=undefined;}
});
it('does not admit an invalid kind or missing original money intent',async()=>{
 const beforeChannel=channelRequestCount,target=randomUUID();
 for(const kind of ['invalid','payment','refund','transfer']){
  const response=await app.inject({method:'POST',url:`/v1/management/money/recheck/${kind}/${target}`,
   headers:auth(operator.sessionToken),payload:{}});
  expect(response.statusCode).toBe(kind==='invalid'?422:404);
 }
 expect(channelRequestCount).toBe(beforeChannel);
 expect((await pool.query("SELECT 1 FROM audit_log WHERE action='commerce.money.recheck_admitted' AND object_id=$1",[target])).rowCount).toBe(0);
});

// PRD §8.2 / AFS-01..03. Every payment/refund fact below is signed by this
// file's disposable loopback channel; it is not a production transaction.
async function aftersalePaidOrder(suffix:string,owner:TestActor=buyer){
  await pool.query('UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+2 WHERE sku_id=$1',[skuId]);
  const order=await createOrder(`aftersale-${suffix}`,app,undefined,owner);
  const prepared=await app.inject({method:'POST',url:`/v1/me/orders/${order.id}/payment-intent`,headers:auth(owner.sessionToken),payload:{}});
  expect(prepared.statusCode,prepared.body).toBe(200);
  const paid=paidCallback(order.orderNumber);
  expect((await app.inject({method:'POST',url:'/v1/payments/wechat/callback',headers:{...paid.headers,'Content-Type':'application/json'},payload:paid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox);return order;
}
async function aftersaleGrant(actor:TestActor,capability:string){
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,$2,'fixture','Synthetic after-sale test','test','integration_fixture') ON CONFLICT DO NOTHING`,[actor.memberId,capability]);
}
const aftersalePost=async(actor:TestActor,url:string,payload:object,key:string)=>app.inject({method:'POST',url,headers:{...auth(actor.sessionToken),'idempotency-key':key},payload});
it('records bounded owned cases, serializes duplicate claims and supports non-destructive withdrawal',async()=>{
  const order=await aftersalePaidOrder('intake');
  const url=`/v1/me/orders/${order.id}/aftersales`,payload={kind:'return_refund',reason:'合成退货受理测试'};
  expect((await aftersalePost(referrer,url,payload,'aftersale-cross-001')).statusCode).toBe(404);
  const duplicate=await Promise.all([1,2].map(()=>aftersalePost(buyer,url,payload,'aftersale-intake-001')));
  for(const response of duplicate)expect(response.statusCode,response.body).toBe(200);
  const row=duplicate[0]!.json();expect(duplicate[1]!.json().id).toBe(row.id);
  expect(row).toMatchObject({state:'requested',version:1,amountCents:10000,resolved:false,returnDestination:null});
  expect((await aftersalePost(buyer,url,{...payload,reason:'改变申请内容'},'aftersale-intake-001')).statusCode).toBe(409);
  expect((await aftersalePost(buyer,url,payload,'aftersale-intake-002')).json().code).toBe('AFTERSALE_ACTIVE_CASE');
  expect((await aftersalePost(buyer,`/v1/me/orders/${order.id}/refund-requests`,{amountCents:100,reason:'不能旁路案件'},'aftersale-direct-refund')).json().code).toBe('AFTERSALE_ACTIVE_CASE');
  const detail=await app.inject({url:`/v1/me/aftersales/${row.id}`,headers:auth(referrer.sessionToken)});expect(detail.statusCode).toBe(404);
  expect((await app.inject({url:`/v1/management/aftersales/${row.id}`,headers:auth(buyer.sessionToken)})).statusCode).toBe(403);
  expect((await aftersalePost(buyer,`/v1/me/aftersales/${row.id}/actions`,{action:'cancel',expectedVersion:2,note:'未发生任何退货'},'aftersale-wrong-version')).statusCode).toBe(409);
  const cancelled=await aftersalePost(buyer,`/v1/me/aftersales/${row.id}/actions`,{action:'cancel',expectedVersion:1,note:'未发生任何退货'},'aftersale-cancel-001');
  expect(cancelled.statusCode,cancelled.body).toBe(200);expect(cancelled.json().state).toBe('cancelled');
  const again=await aftersalePost(buyer,url,payload,'aftersale-intake-003');expect(again.statusCode,again.body).toBe(200);
  // Two synthetic historical cases in one millisecond expose cursor timestamp truncation.
  const syntheticCase=async(key:string,at:string)=>(await pool.query(`INSERT INTO commerce_aftersale_case
    (order_id,member_id,kind,state,reason,lines,amount_cents,idempotency_key,request_hash,created_at)
    SELECT order_id,member_id,kind,'cancelled',reason,lines,amount_cents,$2,request_hash,$3::timestamptz
    FROM commerce_aftersale_case WHERE id=$1 RETURNING id`,[row.id,key,at])).rows[0].id as string;
  const firstId=await syntheticCase('synthetic-page-newer','2099-01-01T00:00:00.001900Z');
  const secondId=await syntheticCase('synthetic-page-older','2099-01-01T00:00:00.001800Z');
  const page=await app.inject({url:`/v1/me/aftersales?orderId=${order.id}&limit=1`,headers:auth(buyer.sessionToken)});
  expect(page.json()).toMatchObject({hasMore:true,loadedCount:1});
  expect(page.json().items.map((item:{id:string})=>item.id)).toEqual([firstId]);
  const nextPage=await app.inject({url:`/v1/me/aftersales?orderId=${order.id}&limit=1&cursor=${encodeURIComponent(page.json().nextCursor)}`,headers:auth(buyer.sessionToken)});
  expect(nextPage.json().items.map((item:{id:string})=>item.id)).toEqual([secondId]);
  expect((await app.inject({url:`/v1/me/aftersales?cursor=${page.json().nextCursor}`,headers:auth(referrer.sessionToken)})).statusCode).toBe(422);
  await expect(pool.query('DELETE FROM commerce_aftersale_event WHERE case_id=$1',[row.id])).rejects.toMatchObject({code:'55000'});
  expect((await pool.query('SELECT count(*)::int AS n FROM commerce_refund_request WHERE order_id=$1',[order.id])).rows[0].n).toBe(0);
});
it('adopts an existing unlinked case in the original support conversation without replacing its application time',async()=>{
  const order=await aftersalePaidOrder('legacy-chat');
  await aftersaleGrant(operator,'commerce.aftersale.review');
  await aftersaleGrant(operator,'support.read');
  await aftersaleGrant(operator,'support.reply');
  const lines=(await pool.query('SELECT id,product_name,sku_label,quantity,line_total_cents FROM commerce_order_line WHERE order_id=$1 ORDER BY id',[order.id])).rows;
  const originalAt='2026-09-20T12:00:00.000Z';
  const legacy=(await pool.query<{id:string}>(`INSERT INTO commerce_aftersale_case
    (order_id,member_id,kind,reason,lines,amount_cents,idempotency_key,request_hash,created_at)
    VALUES($1,$2,'return_refund','历史退货申请',$3,$4,$5,$6,$7) RETURNING id`,
    [order.id,buyer.memberId,JSON.stringify(lines.map(line=>({lineId:line.id,productName:line.product_name,
      skuLabel:line.sku_label,quantity:line.quantity,amountCents:Number(line.line_total_cents)}))),10000,
      'legacy-chat-intake',createHash('sha256').update('legacy-chat').digest('hex'),originalAt])).rows[0]!;
  let conversation=(await pool.query<{id:string}>('SELECT id FROM support_conversation WHERE member_id=$1',[buyer.memberId])).rows[0];
  if(!conversation)conversation=(await pool.query<{id:string}>("INSERT INTO support_conversation(member_id,status) VALUES($1,'waiting_human') RETURNING id",[buyer.memberId])).rows[0]!;
  const assigned=(await pool.query<{version:number}>(`UPDATE support_conversation SET status='human_active',
    current_handler_principal_id=$2,version=version+1 WHERE id=$1 RETURNING version`,
    [conversation.id,operator.principalId])).rows[0]!;
  const unresolved=await aftersalePost(operator,`/v1/management/support/conversations/${conversation.id}/resolve`,
    {expectedVersion:assigned.version},'legacy-chat-premature-resolve');
  expect(unresolved.statusCode).toBe(409);
  expect(unresolved.json().code).toBe('AFTERSALE_CASE_ACTIVE');
  const service=new AftersaleService(pool,new AuthorityService(pool,'test'));
  expect((await service.forConversation(operator.memberId,conversation.id)).items.some(item=>item.id===legacy.id)).toBe(true);
  const accepted=await service.act(operator.memberId,legacy.id,'legacy-chat-approve',
    {action:'approve_return',expectedVersion:1,note:'核对历史退货申请并准备指引'},true);
  expect(accepted).toMatchObject({state:'awaiting_instruction',supportConversationId:null});
  const sent=await service.act(operator.memberId,legacy.id,'legacy-chat-instruction',{
    action:'send_return_instruction',expectedVersion:2,note:'历史申请退货地址已逐单确认',
    recipientName:'隔离测试收件人',phone:'13800000000',region:'合成地区',address:'合成测试地址禁止寄送',
    freightPayer:'merchant',instructions:''},true);
  expect(sent).toMatchObject({state:'awaiting_return',supportConversationId:conversation.id,
    returnDestination:{version:1}});
  expect(new Date(sent.requestedAt).toISOString()).toBe(originalAt);
  expect((await pool.query('SELECT count(*)::int AS n FROM commerce_aftersale_return_instruction WHERE case_id=$1',[legacy.id])).rows[0].n).toBe(1);
});
it('requires the live assigned operator for actions from the existing support chat',async()=>{
  const order=await aftersalePaidOrder('chat-assignment');
  await aftersaleGrant(operator,'commerce.aftersale.review');
  await aftersaleGrant(operator,'support.read');
  await aftersaleGrant(operator,'support.reply');
  const service=new AftersaleService(pool,new AuthorityService(pool,'test'));
  const claim=await service.request(buyer.memberId,order.id,'chat-assignment-claim',
    {kind:'return_refund',reason:'隔离客服分配校验'});
  await pool.query(`UPDATE support_conversation SET status='waiting_human',current_handler_principal_id=NULL,
    version=version+1,updated_at=clock_timestamp() WHERE id=$1`,[claim.supportConversationId]);
  const path=`/v1/management/support/conversations/${claim.supportConversationId}/aftersales/${claim.id}/actions`;
  const command={action:'approve_return',expectedVersion:1,note:'已确认本案需要真实退货指引'};
  expect((await aftersalePost(operator,path,command,'chat-assignment-before')).statusCode).toBe(403);
  await pool.query(`UPDATE support_conversation SET status='human_active',current_handler_principal_id=$2,
    version=version+1,updated_at=clock_timestamp() WHERE id=$1`,[claim.supportConversationId,operator.principalId]);
  const chatVersion=(await pool.query<{version:number}>('SELECT version FROM support_conversation WHERE id=$1',
    [claim.supportConversationId])).rows[0]!.version;
  const prematureResolve=await aftersalePost(operator,
    `/v1/management/support/conversations/${claim.supportConversationId}/resolve`,
    {expectedVersion:chatVersion},'chat-early-resolve');
  expect(prematureResolve.statusCode).toBe(409);
  expect(prematureResolve.json().code).toBe('AFTERSALE_CASE_ACTIVE');
  const accepted=await aftersalePost(operator,path,command,'chat-assignment-accepted');
  expect(accepted.statusCode,accepted.body).toBe(200);
  expect(accepted.json().state).toBe('awaiting_instruction');
  let another=(await pool.query<{id:string}>('SELECT id FROM support_conversation WHERE member_id=$1',[referrer.memberId])).rows[0];
  if(!another)another=(await pool.query<{id:string}>("INSERT INTO support_conversation(member_id,status) VALUES($1,'waiting_human') RETURNING id",[referrer.memberId])).rows[0]!;
  const wrong=await aftersalePost(operator,`/v1/management/support/conversations/${another.id}/aftersales/${claim.id}/actions`,
    {action:'send_return_instruction',expectedVersion:2,note:'错误会话不能发送收件信息',
      recipientName:'合成收件人',phone:'13800000000',region:'合成地区',address:'合成测试地址禁止寄送',freightPayer:'merchant'},'chat-wrong-conversation');
  expect(wrong.statusCode).toBe(403);
  const sent=await aftersalePost(operator,path,{action:'send_return_instruction',expectedVersion:2,note:'已核对并发送本案退货指引',
    recipientName:'合成收件人',phone:'13800000000',region:'合成地区',address:'合成测试地址禁止寄送',freightPayer:'merchant'},'chat-instruction-authorized');
  expect(sent.statusCode,sent.body).toBe(200);
  expect(sent.json()).toMatchObject({state:'awaiting_return',returnDestination:{version:1}});
  expect((await pool.query("SELECT count(*)::int AS n FROM support_message WHERE linked_case_id=$1 AND content_type='return_instruction'",[claim.id])).rows[0].n).toBe(1);
});
it('keeps a lost-delivery claim without forcing a return, then routes a reviewed exception into the real refund budget',async()=>{
  const order=await aftersalePaidOrder('lost-delivery');
  await aftersaleGrant(operator,'commerce.aftersale.review');
  await pool.query(`INSERT INTO commerce_shipping_sync
    (order_id,created_by_member_id,request_key,request_hmac,encrypted_parcel,key_version,evidence_reference)
    VALUES($1,$2,$3,$4,'synthetic-ciphertext','synthetic','synthetic-dispatch-evidence')`,
    [order.id,operator.memberId,'synthetic-lost-delivery',createHash('sha256').update('lost').digest('hex')]);
  const service=new AftersaleService(pool,new AuthorityService(pool,'test'));
  await expect(service.request(buyer.memberId,order.id,'lost-generic-refund',
    {kind:'refund_only',claimBasis:'other',reason:'包裹未收到'})).rejects.toMatchObject({code:'AFTERSALE_RETURN_REQUIRED'});
  const claim=await service.request(buyer.memberId,order.id,'lost-delivery-claim',
    {kind:'refund_only',claimBasis:'delivery_issue',reason:'承运商核实包裹丢失'});
  expect(claim).toMatchObject({state:'requested',claimBasis:'delivery_issue',returnDestination:null,refundRequestId:null});
  await expect(service.act(operator.memberId,claim.id,'lost-invalid-evidence',{
    action:'approve_refund_without_return',expectedVersion:1,note:'承运商已核实丢件',
    exceptionKind:'lost_in_transit',evidenceReference:'bad'},true)).rejects.toMatchObject({code:'AFTERSALE_EXCEPTION_EVIDENCE_REQUIRED'});
  const decision={action:'approve_refund_without_return',expectedVersion:1,note:'承运商已核实丢件',
    exceptionKind:'lost_in_transit',evidenceReference:'synthetic-trace-001'};
  const approved=await service.act(operator.memberId,claim.id,'lost-exception-approve',decision,true);
  expect(approved).toMatchObject({state:'refund_exception_approved',version:2,
    exceptionResolution:{kind:'lost_in_transit',evidenceReference:'synthetic-trace-001'},refundRequestId:null});
  expect((await service.act(operator.memberId,claim.id,'lost-exception-approve',decision,true)).version).toBe(2);
  const requested=await service.act(operator.memberId,claim.id,'lost-exception-refund',
    {action:'request_refund',expectedVersion:2,note:'按已核实丢件例外申请原路退款'},true,refundCommands);
  expect(requested).toMatchObject({state:'refund_pending',version:3,amountCents:10000});
  expect((await pool.query('SELECT count(*)::int AS n FROM commerce_refund_request WHERE order_id=$1',[order.id])).rows[0].n).toBe(1);
  expect((await pool.query('SELECT count(*)::int AS n FROM commerce_aftersale_return_instruction WHERE case_id=$1',[claim.id])).rows[0].n).toBe(0);
  await expect(refundCommands.decide(operator.memberId,requested.refundRequestId!,'lost-exception-same-reviewer',
    {decision:'reject',expectedVersion:1,reason:'隔离验证同一操作员不得复核自己的免寄回决定'}))
    .rejects.toMatchObject({code:'REFUND_EXCEPTION_DUAL_REVIEW_REQUIRED'});
  await aftersaleGrant(reviewer,'commerce.refund.approve');
  await refundCommands.decide(reviewer.memberId,requested.refundRequestId!,'lost-exception-finance',
    {decision:'reject',expectedVersion:1,reason:'隔离验证财务拒绝后保持原例外事实'});
  const reopened=await service.act(operator.memberId,claim.id,'lost-exception-reopen',
    {action:'reopen_refund',expectedVersion:3,note:'原退款已拒绝，保留丢件依据'},true);
  expect(reopened).toMatchObject({state:'refund_exception_approved',exceptionResolution:{kind:'lost_in_transit'}});
});
it('reverses an old paid discount and shipping snapshot in full with explicit component allocation',async()=>{
  await pool.query('UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1 WHERE sku_id=$1',[skuId]);
  const order=await createOrder('historical-components',app,{discountCents:1000,shippingCents:500});
  expect((await app.inject({method:'POST',url:`/v1/me/orders/${order.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const paid=paidCallback(order.orderNumber);
  expect((await app.inject({method:'POST',url:'/v1/payments/wechat/callback',
    headers:{...paid.headers,'Content-Type':'application/json'},payload:paid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  expect((await pool.query('SELECT status,total_cents FROM commerce_order WHERE id=$1',[order.id])).rows[0])
    .toMatchObject({status:'paid',total_cents:'9500'});
  await expect(refundCommands.request(buyer.memberId,order.id,'historical-components-partial',
    {amountCents:1000,reason:'部分运费优惠分摊仍需单独政策'}))
    .rejects.toMatchObject({code:'REFUND_POLICY_UNSUPPORTED'});
  await aftersaleGrant(operator,'commerce.aftersale.review');
  const service=new AftersaleService(pool,new AuthorityService(pool,'test'));
  const claim=await service.request(buyer.memberId,order.id,'historical-components-claim',
    {kind:'refund_only',reason:'原订单全额退款'});
  expect(claim.amountCents).toBe(9500);
  const requested=await service.act(operator.memberId,claim.id,'historical-components-refund',
    {action:'request_refund',expectedVersion:1,note:'按订单支付时的完整商品与运费快照申请退款'},true,refundCommands);
  const reviewed=await refundCommands.decide(operator.memberId,requested.refundRequestId!,
    'historical-components-approval',{decision:'approve',expectedVersion:1,reason:'隔离核对全额原支付构成'});
  expect(reviewed.intent).toMatchObject({cashRefundCents:9500});
  const intent=(await pool.query(`SELECT eligible_merchandise_refund_cents,other_merchandise_refund_cents,
    shipping_cash_refund_cents,line_allocation,allocation_policy_version FROM commission_refund_intent
    WHERE request_id=$1`,[requested.refundRequestId])).rows[0];
  expect(Number(intent.shipping_cash_refund_cents)).toBe(500);
  expect(Number(intent.eligible_merchandise_refund_cents)+Number(intent.other_merchandise_refund_cents)).toBe(9000);
  expect(intent.allocation_policy_version).toBe('quantity-net-components-v1');
  expect(intent.line_allocation).toHaveLength(1);
  await refundCommands.processDue();
  const callback=refundCallback(reviewed.intent!.outRefundNo);
  expect((await app.inject({method:'POST',url:'/v1/payments/wechat/refund-callback',
    headers:{...callback.headers,'Content-Type':'application/json'},payload:callback.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  expect((await service.detail(buyer.memberId,claim.id)).resolved).toBe(true);
});
it('refunds one paid unit at a time with original discount and freight shares, holding the pending budget',async()=>{
  const identity=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'partial-isolated-buyer',
    displayName:'Partial isolated buyer',consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
  expect(identity.statusCode).toBe(200);
  const owner=identity.json() as TestActor;
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram',$2,'partial-isolated-openid','wechat')`,[owner.memberId,appId]);
  const code=(await pool.query<{id:string}>('SELECT id FROM commercial_referral_code WHERE member_id=$1',[referrer.memberId])).rows[0]!;
  await pool.query(`INSERT INTO commercial_referral_relation(referred_member_id,referrer_member_id,
    referral_code_id,confirmation_key,confirmed_by) VALUES($1,$2,$3,'partial-isolated-referral-0001','fixture')`,
    [owner.memberId,referrer.memberId,code.id]);
  await pool.query('UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+2 WHERE sku_id=$1',[skuId]);
  const order=await createOrder('historical-two-units',app,{discountCents:1000,shippingCents:500},owner,2);
  expect((await app.inject({method:'POST',url:`/v1/me/orders/${order.id}/payment-intent`,
    headers:auth(owner.sessionToken),payload:{}})).statusCode).toBe(200);
  const paid=paidCallback(order.orderNumber);
  expect((await app.inject({method:'POST',url:'/v1/payments/wechat/callback',
    headers:{...paid.headers,'Content-Type':'application/json'},payload:paid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  const source=(await pool.query<{id:string}>('SELECT id FROM commerce_order_line WHERE order_id=$1',[order.id])).rows[0]!;
  const service=new AftersaleService(pool,new AuthorityService(pool,'test'));
  await aftersaleGrant(operator,'commerce.aftersale.review');
  const availability=await service.availability(owner.memberId,order.id);
  expect(availability.lines).toEqual([{lineId:source.id,remainingQuantity:2}]);
  expect((await app.inject({method:'GET',url:`/v1/me/orders/${order.id}/aftersales/availability`,
    headers:auth(referrer.sessionToken)})).statusCode).toBe(404);
  const first=await service.request(owner.memberId,order.id,'partial-unit-first',
    {kind:'refund_only',reason:'第一件商品需要退款',lines:[{lineId:source.id,quantity:1}]});
  expect(first.amountCents).toBe(9750);
  expect((await service.request(owner.memberId,order.id,'partial-unit-first',
    {kind:'refund_only',reason:'第一件商品需要退款',lines:[{lineId:source.id,quantity:1}]})).id).toBe(first.id);
  await expect(service.request(owner.memberId,order.id,'partial-unit-first',
    {kind:'refund_only',reason:'第一件商品需要退款',lines:[{lineId:source.id,quantity:2}]}))
    .rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const pending=await service.act(operator.memberId,first.id,'partial-first-refund',
    {action:'request_refund',expectedVersion:1,note:'核实首件退款组成'},true,refundCommands);
  const reviewed=await refundCommands.decide(operator.memberId,pending.refundRequestId!,'partial-first-approval',
    {decision:'approve',expectedVersion:1,reason:'首件商品与运费各半'});
  expect(reviewed.intent).toMatchObject({cashRefundCents:9750});
  await expect(service.request(owner.memberId,order.id,'partial-too-early',
    {kind:'refund_only',reason:'第二件商品需要退款',lines:[{lineId:source.id,quantity:1}]}))
    .rejects.toMatchObject({code:'AFTERSALE_ACTIVE_CASE'});
  await refundCommands.processDue();
  const callback=refundCallback(reviewed.intent!.outRefundNo);
  expect((await app.inject({method:'POST',url:'/v1/payments/wechat/refund-callback',
    headers:{...callback.headers,'Content-Type':'application/json'},payload:callback.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  expect((await service.detail(owner.memberId,first.id)).resolved).toBe(true);
  expect((await service.availability(owner.memberId,order.id)).lines).toEqual([{lineId:source.id,remainingQuantity:1}]);
  await expect(service.request(owner.memberId,order.id,'partial-overdraw',
    {kind:'refund_only',reason:'超出剩余数量',lines:[{lineId:source.id,quantity:2}]}))
    .rejects.toMatchObject({code:'AFTERSALE_QUANTITY_EXCEEDS_REMAINING'});
  const races=await Promise.allSettled(['partial-unit-second','partial-unit-race'].map(key=>
    service.request(owner.memberId,order.id,key,
      {kind:'refund_only',reason:'第二件商品需要退款',lines:[{lineId:source.id,quantity:1}]})));
  expect(races.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(races.filter(result=>result.status==='rejected').map(result=>(result as PromiseRejectedResult).reason.code))
    .toEqual(['AFTERSALE_ACTIVE_CASE']);
  const second=(races.find(result=>result.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof service.request>>>).value;
  expect(second.amountCents).toBe(9750);
  const secondPending=await service.act(operator.memberId,second.id,'partial-second-refund',
    {action:'request_refund',expectedVersion:1,note:'核实剩余商品退款组成'},true,refundCommands);
  const secondReviewed=await refundCommands.decide(operator.memberId,secondPending.refundRequestId!,'partial-second-approval',
    {decision:'approve',expectedVersion:1,reason:'剩余商品与运费分摊'});
  expect(secondReviewed.intent).toMatchObject({cashRefundCents:9750});
  const allocations=(await pool.query(`SELECT r.amount_cents,i.shipping_cash_refund_cents,i.eligible_merchandise_refund_cents
    FROM commerce_refund_request r JOIN commission_refund_intent i ON i.request_id=r.id
    WHERE r.order_id=$1 ORDER BY r.created_at,r.id`,[order.id])).rows;
  expect(allocations.reduce((sum,row)=>sum+Number(row.amount_cents),0)).toBe(19500);
  expect(allocations.reduce((sum,row)=>sum+Number(row.shipping_cash_refund_cents),0)).toBe(500);
  expect(allocations.reduce((sum,row)=>sum+Number(row.eligible_merchandise_refund_cents),0)).toBe(19000);
  await refundCommands.processDue();
  const secondCallback=refundCallback(secondReviewed.intent!.outRefundNo);
  expect((await app.inject({method:'POST',url:'/v1/payments/wechat/refund-callback',
    headers:{...secondCallback.headers,'Content-Type':'application/json'},payload:secondCallback.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
  expect((await service.availability(owner.memberId,order.id)).lines).toEqual([{lineId:source.id,remainingQuantity:0}]);
  const reversed=(await pool.query(`SELECT COALESCE(sum(amount_cents),0)::text AS amount_cents FROM commission_ledger_entry
    WHERE order_id=$1 AND kind='refund_reversal'`,[order.id])).rows[0];
  expect(Number(reversed.amount_cents)).toBe(-3800);
});
it('keeps the original application time, sends versioned case instructions in chat and separates later physical and payment facts',async()=>{
  const order=await aftersalePaidOrder('return');
  await aftersaleGrant(operator,'commerce.aftersale.review');await aftersaleGrant(reviewer,'commerce.return.receive');
  const authority=new AuthorityService(pool,'test'),service=new AftersaleService(pool,authority);
  const row=await service.request(buyer.memberId,order.id,'aftersale-return-001',{kind:'return_refund',claimBasis:'no_reason',reason:''});
  expect(row).toMatchObject({state:'requested',reason:'',claimBasis:'no_reason',returnDestination:null});
  expect((await pool.query(`SELECT count(*)::int AS n FROM support_message WHERE conversation_id=$1 AND client_message_id=$2`,[row.supportConversationId,`aftersale-request:${row.id}`])).rows[0].n).toBe(1);
  const step=(action:string,expectedVersion:number,extra={})=>({action,expectedVersion,note:'合成独立操作依据',...extra});
    await expect(service.act(reviewer.memberId,row.id,'aftersale-cross-cap',step('approve_return',1),true)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
    expect(await service.act(operator.memberId,row.id,'aftersale-info-001',step('request_info',1),true)).toMatchObject({state:'need_info',version:2});
    expect(await service.act(buyer.memberId,row.id,'aftersale-info-002',step('provide_info',2))).toMatchObject({state:'requested',version:3});
    const accepted=await service.act(operator.memberId,row.id,'aftersale-accept-001',step('approve_return',3),true);
    expect(accepted).toMatchObject({state:'awaiting_instruction',version:4,returnDestination:null,requestedAt:row.requestedAt});
    await expect(service.act(buyer.memberId,row.id,'aftersale-premature-ship',step('ship_return',4,{carrier:'合成物流',tracking:'SYNTHETIC123456'}))).rejects.toMatchObject({code:'AFTERSALE_STATE_CONFLICT'});
    const instruction={recipientName:'合成收件人',phone:'13800000000',region:'上海市浦东新区',address:'合成隔离测试地址，禁止真实寄件',freightPayer:'merchant',instructions:'仅用于隔离测试'};
    const sent=await service.act(operator.memberId,row.id,'aftersale-instruction-001',step('send_return_instruction',4,instruction),true);
    expect(sent).toMatchObject({state:'awaiting_return',version:5,returnDestination:{version:1,...instruction}});
    const changed=await service.act(operator.memberId,row.id,'aftersale-instruction-002',step('send_return_instruction',5,{...instruction,address:'合成隔离测试新地址，禁止真实寄件'}),true);
    expect(changed).toMatchObject({state:'awaiting_return',version:6,returnDestination:{version:2}});
    expect((await pool.query(`SELECT count(*)::int AS n FROM commerce_aftersale_return_instruction WHERE case_id=$1`,[row.id])).rows[0].n).toBe(2);
    expect((await pool.query(`SELECT count(*)::int AS n FROM support_message WHERE linked_case_id=$1 AND content_type='return_instruction'`,[row.id])).rows[0].n).toBe(2);
    expect((await service.detail(buyer.memberId,row.id)).returnInstructionHistory.map(item=>item.version)).toEqual([2,1]);
    await expect(service.act(buyer.memberId,row.id,'aftersale-bad-tracking',step('ship_return',6,{carrier:'合成物流',tracking:'bad!'}))).rejects.toMatchObject({code:'RETURN_TRACKING_INVALID'});
    await expect(service.act(buyer.memberId,row.id,'aftersale-wrong-instruction',step('ship_return',6,
      {carrier:'合成物流',tracking:'SYNTHETIC123456',instructionVersion:3}))).rejects.toMatchObject({code:'RETURN_INSTRUCTION_VERSION_INVALID'});
    const shipped=await service.act(buyer.memberId,row.id,'aftersale-ship-001',step('ship_return',6,
      {carrier:'合成物流',tracking:'SYNTHETIC123456',instructionVersion:1}));
    expect(shipped).toMatchObject({state:'return_in_transit',shippedInstructionVersion:1,returnRouteReviewRequired:true});
    expect((await pool.query(`SELECT count(*)::int AS n FROM support_message WHERE conversation_id=$1
      AND client_message_id=$2`,[row.supportConversationId,`aftersale-old-route:${row.id}`])).rows[0].n).toBe(1);
    expect((await new ManagementAttentionService(pool,'test').summary(operator.memberId)).counts.oldRouteShipments?.count).toBeGreaterThanOrEqual(1);
    expect((await service.act(buyer.memberId,row.id,'aftersale-ship-001',step('ship_return',6,
      {carrier:'合成物流',tracking:'SYNTHETIC123456',instructionVersion:1}))).shippedInstructionVersion).toBe(1);
    await expect(pool.query('UPDATE commerce_aftersale_case SET shipped_instruction_version=2,version=version+1 WHERE id=$1',
      [row.id])).rejects.toThrow();
    await expect(service.act(operator.memberId,row.id,'aftersale-too-late-address',step('send_return_instruction',7,instruction),true)).rejects.toMatchObject({code:'AFTERSALE_STATE_CONFLICT'});
    await expect(service.act(buyer.memberId,row.id,'aftersale-late-cancel',step('cancel',7))).rejects.toMatchObject({code:'AFTERSALE_STATE_CONFLICT'});
    await expect(service.act(operator.memberId,row.id,'aftersale-cross-receive',step('receive_return',7),true)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
    await service.act(reviewer.memberId,row.id,'aftersale-receive-001',step('receive_return',7),true);
    await expect(service.act(reviewer.memberId,row.id,'aftersale-cross-inspect',step('inspect_return',8,{qualityResult:'unsellable'}),true)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
    await aftersaleGrant(reviewer,'commerce.return.inspect');
    await service.act(reviewer.memberId,row.id,'aftersale-quality-001',step('inspect_return',8,{qualityResult:'unsellable'}),true);
    // Unusable stock does not automatically deny a consumer refund.
    const request=await service.act(operator.memberId,row.id,'aftersale-refund-001',step('request_refund',9),true,refundCommands);
    expect(request).toMatchObject({state:'refund_pending',version:10,resolved:false,refund:{reviewState:'requested',channelState:null}});
    expect((await service.act(operator.memberId,row.id,'aftersale-refund-001',step('request_refund',9),true,refundCommands)).refundRequestId).toBe(request.refundRequestId);
    expect((await pool.query('SELECT count(*)::int AS n FROM commerce_refund_request WHERE order_id=$1',[order.id])).rows[0].n).toBe(1);
    const approved=await refundCommands.decide(operator.memberId,request.refundRequestId!,'aftersale-finance-001',{decision:'approve',expectedVersion:1,reason:'隔离独立退款金额复核'});
    const intent=(approved as any).intent;
    await refundCommands.processDue();
    expect((await service.detail(buyer.memberId,row.id)).resolved).toBe(false);
    const callback=refundCallback(intent.outRefundNo);
    expect((await app.inject({method:'POST',url:'/v1/payments/wechat/refund-callback',headers:{...callback.headers,'Content-Type':'application/json'},payload:callback.raw})).statusCode).toBe(204);
    await runMoneyWorkerCycle(paymentInbox,refundInbox,refundCommands);
    const final=await service.detail(buyer.memberId,row.id);
    expect(final).toMatchObject({resolved:true,qualityResult:'unsellable',inventoryStatus:'separate_ledger_required',refund:{channelState:'succeeded'}});
    expect(final.events).toHaveLength(10);
    await expect(service.act(operator.memberId,row.id,'aftersale-false-reopen',step('reopen_refund',10),true)).rejects.toMatchObject({code:'AFTERSALE_STATE_CONFLICT'});
});
it('records a prior-address shipment before a waybill exists and keeps the original route through later registration',async()=>{
  const identity=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'old-route-isolated-buyer',
    displayName:'Old route isolated buyer',consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
  expect(identity.statusCode).toBe(200);
  const owner=identity.json() as TestActor;
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram',$2,'old-route-isolated-openid','wechat')`,[owner.memberId,appId]);
  const order=await aftersalePaidOrder('old-route-no-waybill',owner);
  await aftersaleGrant(operator,'commerce.aftersale.review');
  const service=new AftersaleService(pool,new AuthorityService(pool,'test'));
  const claim=await service.request(owner.memberId,order.id,'old-route-claim-001',
    {kind:'return_refund',claimBasis:'no_reason',reason:''});
  const instruction={recipientName:'合成收件人',phone:'13800000000',region:'上海市浦东新区',
    address:'合成旧地址，仅供隔离测试',freightPayer:'merchant',instructions:''};
  await service.act(operator.memberId,claim.id,'old-route-approve-001',
    {action:'approve_return',expectedVersion:1,note:'确认退货需逐单指引'},true);
  await service.act(operator.memberId,claim.id,'old-route-send-001',
    {action:'send_return_instruction',expectedVersion:2,note:'已确认首版收件信息',...instruction},true);
  await service.act(operator.memberId,claim.id,'old-route-send-002',
    {action:'send_return_instruction',expectedVersion:3,note:'已确认更新版收件信息',...instruction,
      address:'合成新地址，仅供隔离测试'},true);
  const reported=await service.act(owner.memberId,claim.id,'old-route-report-001',
    {action:'report_old_route',expectedVersion:4,note:'已按首版地址交寄',instructionVersion:1});
  expect(reported).toMatchObject({state:'awaiting_return',version:5,returnTracking:null,
    shippedInstructionVersion:1,returnRouteReviewRequired:true});
  expect((await new ManagementAttentionService(pool,'test').summary(operator.memberId)).counts.oldRouteShipments?.count).toBeGreaterThanOrEqual(1);
  await expect(service.act(owner.memberId,claim.id,'old-route-cancel-001',
    {action:'cancel',expectedVersion:5,note:'不能撤回已经交寄的案件'})).rejects.toMatchObject({code:'AFTERSALE_STATE_CONFLICT'});
  await expect(service.act(operator.memberId,claim.id,'old-route-change-003',
    {action:'send_return_instruction',expectedVersion:5,note:'不得再次更改用户已使用的指引',...instruction},true))
    .rejects.toMatchObject({code:'AFTERSALE_STATE_CONFLICT'});
  const shipped=await service.act(owner.memberId,claim.id,'old-route-waybill-001',
    {action:'ship_return',expectedVersion:5,note:'补充原交寄运单',instructionVersion:1,
      carrier:'合成物流',tracking:'SYNTHETIC654321'});
  expect(shipped).toMatchObject({state:'return_in_transit',shippedInstructionVersion:1,returnRouteReviewRequired:true});
  expect((await pool.query(`SELECT count(*)::int AS n FROM support_message WHERE conversation_id=$1
    AND client_message_id=$2`,[claim.supportConversationId,`aftersale-old-route:${claim.id}`])).rows[0].n).toBe(1);
  const filtered=await service.list(operator.memberId,{attention:'old_route'},true);
  expect(filtered.items.some(item=>item.id===claim.id)).toBe(true);
  await expect(service.list(owner.memberId,{attention:'old_route'})).rejects.toMatchObject({code:'AFTERSALE_FILTER_INVALID'});
  const before=(await new ManagementAttentionService(pool,'test').summary(operator.memberId)).counts.oldRouteShipments!.count;
  const contacted=await service.act(operator.memberId,claim.id,'old-route-contacted-001',
    {action:'resolve_old_route',expectedVersion:6,note:'已联系承运商核对旧地址包裹',routeOutcome:'carrier_contacted'},true);
  expect(contacted).toMatchObject({state:'return_in_transit',routeReviewOutcome:'carrier_contacted',returnRouteReviewRequired:false});
  expect((await new ManagementAttentionService(pool,'test').summary(operator.memberId)).counts.oldRouteShipments!.count).toBe(before-1);
  expect((await service.list(operator.memberId,{attention:'old_route'},true)).items.some(item=>item.id===claim.id)).toBe(false);
  const resolved=await service.act(operator.memberId,claim.id,'old-route-rerouted-001',
    {action:'resolve_old_route',expectedVersion:7,note:'承运商确认转寄到当前地址',routeOutcome:'rerouted'},true);
  expect(resolved).toMatchObject({routeReviewOutcome:'rerouted',version:8});
  await expect(service.act(operator.memberId,claim.id,'old-route-change-result',
    {action:'resolve_old_route',expectedVersion:8,note:'不可覆盖已完成的协调结果',routeOutcome:'received'},true))
    .rejects.toMatchObject({code:'AFTERSALE_STATE_CONFLICT'});
});
it('rechecks revoked case permissions and rolls back a failed refund link atomically',async()=>{
  const order=await aftersalePaidOrder('atomic');const service=new AftersaleService(pool,new AuthorityService(pool,'test'));
  const row=await service.request(buyer.memberId,order.id,'aftersale-atomic-001',{kind:'refund_only',reason:'合成未发货全额申请'});
  const command={action:'request_refund',expectedVersion:1,note:'隔离事务原子性测试'};
  await pool.query(`CREATE FUNCTION synthetic_aftersale_event_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='request_refund' THEN RAISE EXCEPTION 'synthetic event failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_aftersale_event_fail BEFORE INSERT ON commerce_aftersale_event FOR EACH ROW EXECUTE FUNCTION synthetic_aftersale_event_fail()`);
  try{await expect(service.act(operator.memberId,row.id,'aftersale-atomic-command',command,true,refundCommands)).rejects.toThrow();}
  finally{await pool.query('DROP TRIGGER synthetic_aftersale_event_fail ON commerce_aftersale_event; DROP FUNCTION synthetic_aftersale_event_fail()');}
  expect((await pool.query('SELECT count(*)::int AS n FROM commerce_refund_request WHERE order_id=$1',[order.id])).rows[0].n).toBe(0);
  expect((await service.detail(buyer.memberId,row.id)).state).toBe('requested');
  const linked=await service.act(operator.memberId,row.id,'aftersale-atomic-command',command,true,refundCommands);
  await refundCommands.decide(operator.memberId,linked.refundRequestId!,'aftersale-reject-finance',{decision:'reject',expectedVersion:1,reason:'隔离验证拒绝后的案件恢复'});
  const reopened=await service.act(operator.memberId,row.id,'aftersale-reopen-001',{action:'reopen_refund',expectedVersion:2,note:'原退款已明确拒绝'},true);
  expect(reopened).toMatchObject({state:'requested',refundRequestId:null,version:3});
  await pool.query("UPDATE authority_grant SET revoked_at=clock_timestamp(),revoked_by='fixture',revoke_reason='Synthetic revocation' WHERE member_id=$1 AND capability='commerce.aftersale.review' AND revoked_at IS NULL",[operator.memberId]);
  await expect(service.act(operator.memberId,row.id,'aftersale-revoked-001',{action:'reject',expectedVersion:3,note:'已撤权不能写入'},true)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
  await expect(service.detail(operator.memberId,row.id,true)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
});

it('shows only current capability-scoped management attention and clears it after revocation',async()=>{
  const identity=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'attention-isolated-actor',
    displayName:'Attention isolated actor',consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
  expect(identity.statusCode).toBe(200);
  const actor=identity.json() as TestActor;
  const path='/v1/management/attention';
  expect((await app.inject({url:path})).statusCode).toBe(401);
  expect((await app.inject({url:path,headers:auth(actor.sessionToken)})).statusCode).toBe(403);
  await aftersaleGrant(actor,'support.read');
  const supportOnly=await app.inject({url:path,headers:auth(actor.sessionToken)});
  expect(supportOnly.statusCode,supportOnly.body).toBe(200);
  expect(Object.keys(supportOnly.json().counts)).toEqual(['support']);
  await aftersaleGrant(actor,'commerce.aftersale.review');
  const customer=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'attention-isolated-customer',
    displayName:'Attention isolated customer',consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
  expect(customer.statusCode).toBe(200);
  const owner=customer.json() as TestActor;
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram',$2,'attention-isolated-openid','wechat')`,[owner.memberId,appId]);
  await pool.query('UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+1 WHERE sku_id=$1',[skuId]);
  const order=await createOrder('attention',app,undefined,owner);
  const prepared=await app.inject({method:'POST',url:`/v1/me/orders/${order.id}/payment-intent`,headers:auth(owner.sessionToken),payload:{}});
  expect(prepared.statusCode,prepared.body).toBe(200);
  const paid=paidCallback(order.orderNumber);
  expect((await app.inject({method:'POST',url:'/v1/payments/wechat/callback',
    headers:{...paid.headers,'Content-Type':'application/json'},payload:paid.raw})).statusCode).toBe(204);
  await runMoneyWorkerCycle(paymentInbox);
  const attentionAftersales=new AftersaleService(pool,new AuthorityService(pool,'test'));
  const attentionCase=await attentionAftersales.request(owner.memberId,order.id,
    'attention-new-case-001',{kind:'refund_only',reason:'隔离待办计数申请'});
  const withCase=await app.inject({url:path,headers:auth(actor.sessionToken)});
  expect(withCase.statusCode,withCase.body).toBe(200);
  expect(withCase.json().counts.newAftersales.count).toBeGreaterThanOrEqual(1);
  expect(withCase.json().counts).not.toHaveProperty('privacyRequests');
  await aftersaleGrant(actor,'commerce.refund.approve');
  const refundPending=await attentionAftersales.act(actor.memberId,attentionCase.id,'attention-refund-001',
    {action:'request_refund',expectedVersion:1,note:'隔离退款待办准确跳转'},true,refundCommands);
  const withRefund=await app.inject({url:path,headers:auth(actor.sessionToken)});
  expect(withRefund.statusCode,withRefund.body).toBe(200);
  expect(withRefund.json().counts.pendingRefunds.count).toBeGreaterThanOrEqual(1);
  await refundCommands.decide(actor.memberId,refundPending.refundRequestId!,'attention-refund-approve-001',
    {decision:'approve',expectedVersion:1,reason:'隔离确认审批后待办消失'});
  const afterApproval=await app.inject({url:path,headers:auth(actor.sessionToken)});
  expect(afterApproval.json().counts.pendingRefunds.count).toBe(withRefund.json().counts.pendingRefunds.count-1);
  await pool.query(`UPDATE authority_grant SET revoked_at=clock_timestamp(),revoked_by='fixture',revoke_reason='attention test'
    WHERE member_id=$1 AND capability IN ('commerce.aftersale.review','commerce.refund.approve') AND revoked_at IS NULL`,[actor.memberId]);
  const revoked=await app.inject({url:path,headers:auth(actor.sessionToken)});
  expect(revoked.statusCode,revoked.body).toBe(200);
  expect(Object.keys(revoked.json().counts)).toEqual(['support']);
  await aftersaleGrant(actor,'privacy.request.manage');
  const before=await app.inject({url:path,headers:auth(actor.sessionToken)});
  expect(before.statusCode,before.body).toBe(200);
  const privacy=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:auth(owner.sessionToken),
    payload:{kind:'access',message:'Access request for the isolated attention test'}});
  expect(privacy.statusCode,privacy.body).toBe(200);
  await pool.query("UPDATE privacy_request SET created_at=clock_timestamp()-interval '31 days', due_at=clock_timestamp()-interval '1 day' WHERE id=$1",[privacy.json().id]);
  const overdue=await app.inject({url:path,headers:auth(actor.sessionToken)});
  expect(overdue.statusCode,overdue.body).toBe(200);
  expect(overdue.json().counts.privacyOverdue.count).toBe(before.json().counts.privacyOverdue.count+1);
  expect(overdue.json().counts).not.toHaveProperty('newAftersales');
});

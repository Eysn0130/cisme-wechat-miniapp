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
let corruptBillHash=false;
let loseNextRefundResponse=false;
let loseNextTransferResponse=false;
let server:ReturnType<typeof createServer>,app:FastifyInstance,baseUrl:string;
let buyer:{memberId:string;sessionToken:string},skuId:string;
let operator:{memberId:string;sessionToken:string},referrer:{memberId:string;sessionToken:string},reviewer:{memberId:string;sessionToken:string};
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
    if(!order){sendSigned(response,404,{code:"ORDER_NOT_EXIST"});return;}
    sendSigned(response,200,{appid:order.appid,mchid:order.mchid,out_trade_no:decodeURIComponent(query[1]!),
      trade_type:"JSAPI",trade_state:order.state,payer:{openid:order.openid},
      amount:{total:order.amount,payer_total:order.amount,currency:"CNY",payer_currency:"CNY"},
      ...(order.state==="SUCCESS"?{transaction_id:order.transactionId,success_time:order.paidAt}:{})});return;
  }
  const close=path.match(/^\/v3\/pay\/transactions\/out-trade-no\/([^/?]+)\/close$/);
  if(method==="POST"&&close){
    const order=channelOrders.get(decodeURIComponent(close[1]!));
    if(!order||order.state!=="NOTPAY"){sendSigned(response,409,{code:"ORDER_STATE_ERROR"});return;}
    order.state="CLOSED";response.writeHead(204);response.end();return;
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

async function createOrder(key:string,target:FastifyInstance=app){
  const address=await target.inject({method:"POST",url:"/v1/me/addresses",headers:{...auth(buyer.sessionToken),
    "idempotency-key":`address-${key}-0001`},payload:{recipientName:"合成收件人",phone:"13800001234",province:"上海市",
      city:"上海市",district:"浦东新区",detail:"隔离测试路 1 号",postalCode:"200000",nationalCode:"310115",
      provinceCode:"310000",cityCode:"310100",districtCode:"310115",label:"home",isDefault:true}});
  expect(address.statusCode,JSON.stringify(address.json())).toBe(200);
  const quote=await target.inject({method:"POST",url:"/v1/me/commerce/quotes",headers:{...auth(buyer.sessionToken),
    "idempotency-key":`quote-${key}-0001`},payload:{skuId,quantity:1,addressId:address.json().id,
      addressVersion:address.json().version}});
  expect(quote.statusCode,JSON.stringify(quote.json())).toBe(200);
  const created=await target.inject({method:"POST",url:"/v1/me/orders",headers:{...auth(buyer.sessionToken),
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
  const prepay=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,headers:auth(buyer.sessionToken),payload:{}});
  expect(prepay.statusCode,JSON.stringify(prepay.json())).toBe(200);
  expect(prepay.json()).toMatchObject({state:"prepay_ready",simulation:true,requestPayment:{signType:"RSA"}});
  const again=await app.inject({method:"POST",url:`/v1/me/orders/${order.id}/payment-intent`,headers:auth(buyer.sessionToken),payload:{}});
  expect(again.statusCode).toBe(200);expect(channelOrders.size).toBe(1);
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
  const inbox=new VerifiedPaymentInbox(pool,{appId,merchantId,apiV3Key,platformKeys:new Map([[serial,platformPublic]])});
  await runMoneyWorkerCycle(inbox);
  expect((await pool.query("SELECT status FROM commerce_order WHERE id=$1",[order.id])).rows[0].status).toBe("paid");
  const unpaid=await createOrder("cancel");
  expect((await app.inject({method:"POST",url:`/v1/me/orders/${unpaid.id}/payment-intent`,
    headers:auth(buyer.sessionToken),payload:{}})).statusCode).toBe(200);
  const stale=await app.inject({method:"POST",url:`/v1/me/orders/${unpaid.id}/cancel-verified`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"payment-verified-cancel-stale-0001"},
    payload:{expectedVersion:unpaid.version+1,reason:"隔离版本过期取消"}});
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe("ORDER_VERSION_CONFLICT");
  expect((await pool.query(`SELECT state FROM commerce_payment_attempt WHERE order_id=$1`,[unpaid.id])).rows[0].state)
    .not.toBe("closed");
  const cancelled=await app.inject({method:"POST",url:`/v1/me/orders/${unpaid.id}/cancel-verified`,
    headers:{...auth(buyer.sessionToken),"idempotency-key":"payment-verified-cancel-0001"},
    payload:{expectedVersion:unpaid.version,reason:"隔离模拟取消"}});
  expect(cancelled.statusCode,JSON.stringify(cancelled.json())).toBe(200);
  expect(cancelled.json().status).toBe("cancelled");
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
  const imported=await app.inject({method:"POST",url:path,headers:auth(operator.sessionToken),
    payload:{billDate:billOne,billType:"SUCCESS"}});
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
    await expect(createApp({config,pool,storage:createApiGatewayStorage(config),
      paymentProtocol:formalPaymentProtocol(config,pool)!}))
      .rejects.toThrow("FAIL_CLOSED:PAYMENT_PROTOCOL_NO_ISOLATED_PROFILE");
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
    expect(syntheticCalls).toBeGreaterThanOrEqual(2);
  }finally{
    await formalApp?.close();
    await rm(fixtureDir,{recursive:true,force:true});
  }
});

it("spends source-attributed test credit beside signed cash, and releases an unpaid reservation",creditSpendCase);

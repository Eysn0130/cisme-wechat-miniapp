import {createCipheriv,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {loadConfig} from '@cisme/config';
import {testPool,resetDatabase,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {AuthorityService} from '../../services/api/src/authority';
import {SharingOfficerService,snapshotSharingOfficer,releaseSharingCommissions} from '../../services/api/src/sharingOfficer';
import {SharingOfficerFinance} from '../../services/api/src/sharingOfficerFinance';
import {assessSharingV2Performance,sharingV2Cutoff,sharingV2PaymentWindow,sharingV2Period} from '../../services/api/src/sharingOfficerV2';
import {VerifiedPaymentInbox} from '../../services/api/src/verifiedPaymentInbox';
import {VerifiedRefundInbox} from '../../services/api/src/verifiedRefundInbox';
import {SharingOfficerAssets} from '../../services/api/src/sharingOfficerAssets';
import {collectSharingPortableData} from '../../services/api/src/sharingOfficerPrivacy';
import {MemberAdministration} from '../../services/api/src/memberAdministration';
import type {FastifyInstance} from 'fastify';
const pool=testPool(),appId='wx-sharing-synthetic',merchantId='sharing-synthetic-merchant',apiV3Key=randomBytes(16).toString('hex');
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'sharing-test-session',ADMIN_API_TOKEN:'sharing-test-admin',UPLOAD_TOKEN_SECRET:'sharing-test-upload',OBJECT_STORAGE_DRIVER:'api_gateway',CONTACT_ENCRYPTION_KEY:randomBytes(32).toString('hex')});
const authority=new AuthorityService(pool,'test'),service=new SharingOfficerService(pool,authority,config),finance=new SharingOfficerFinance(service);
const platform=generateKeyPairSync('rsa',{modulusLength:2048}),binding={appId,merchantId,apiV3Key,platformKeys:new Map([['PUB_KEY_ID_3000000001',platform.publicKey.export({type:'spki',format:'pem'}).toString()]])};
const payments=new VerifiedPaymentInbox(pool,binding),refunds=new VerifiedRefundInbox(pool,binding);
let app:FastifyInstance,manager:any,a:any,b:any,buyer:any,other:any,product:string,sku:string,address:string,shareA:string,shareB:string,codeA:string,codeB:string,policyVersion:number;
let first:any,second:any,monthBatch:string,line:any;let n=0;
let historical:any,period:string,qualProduct:string,qualSku:string;
const auth=(p:any)=>({authorization:'Bearer '+p.sessionToken});
const command=async(p:any,action:string,input:Record<string,unknown>,management=false,key=`sharing-test-${++n}`)=>{
 const r=await app.inject({method:'POST',url:`/v1/${management?'management':'me'}/sharing-officer/commands`,headers:{...auth(p),'idempotency-key':key},payload:{action,input}});return r;
};
const expectOk=async(p:Promise<any>)=>{const r=await p;expect(r.statusCode,r.body).toBe(200);return r.json();};
function signedFact(payload:any,eventType:string,eventId:string,originalType:string){
 const nonce=randomBytes(6).toString('hex'),aad=originalType,cipher=createCipheriv('aes-256-gcm',Buffer.from(apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from(aad));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]).toString('base64');
 const rawBody=Buffer.from(JSON.stringify({id:eventId,event_type:eventType,resource_type:'encrypt-resource',resource:{algorithm:'AEAD_AES_256_GCM',ciphertext,associated_data:aad,nonce,original_type:originalType}}));
 const timestamp=Math.floor(Date.now()/1000).toString(),requestNonce=randomBytes(16).toString('hex');
 const signature=sign('RSA-SHA256',Buffer.concat([Buffer.from(`${timestamp}\n${requestNonce}\n`),rawBody,Buffer.from('\n')]),platform.privateKey).toString('base64');
 return {rawBody,headers:{'Wechatpay-Serial':'PUB_KEY_ID_3000000001','Wechatpay-Timestamp':timestamp,'Wechatpay-Nonce':requestNonce,'Wechatpay-Signature':signature}};
}
async function seedOrder(owner:any,historical=false,qualified=false){
 const orderProduct=qualified?qualProduct:product,orderSku=qualified?qualSku:sku,unit=qualified?29800:10000,discount=qualified?0:1200,shipping=qualified?0:500,net=unit-discount,total=net+shipping;
 const orderId=randomUUID(),quote=randomUUID(),number='CM20261113'+randomBytes(6).toString('hex').toUpperCase();
 const now=new Date(),at=historical?new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,5,2)):new Date(now.getTime()-5000),expires=new Date(at.getTime()+3600_000);
 await pool.query(`INSERT INTO commerce_checkout_quote(id,member_id,product_id,sku_id,address_id,address_version,quantity,currency,unit_price_cents,subtotal_cents,member_discount_cents,shipping_cents,total_cents,pricing_rule_version,product_version,sku_version,price_version,status,idempotency_key,request_hash,expires_at,consumed_at,created_at)
  VALUES($1,$2,$3,$4,$5,1,1,'CNY',${unit},${unit},${discount},${shipping},${total},'sharing-synthetic-v1',1,1,1,'consumed',$6,$7,$8,$9,$9)`,[quote,owner.memberId,orderProduct,orderSku,address,'sharing-quote-'+quote,'a'.repeat(64),expires,at]);
 await pool.query(`INSERT INTO commerce_order(id,order_number,member_id,source_quote_id,status,currency,subtotal_cents,member_discount_cents,shipping_cents,total_cents,pricing_rule_version,expires_at,created_at,updated_at,transaction_source_kind)
  VALUES($1,$2,$3,$4,'pending_payment','CNY',${unit},${discount},${shipping},${total},'sharing-synthetic-v1',$5,$6,$6,'verified_commerce')`,[orderId,number,owner.memberId,quote,expires,at]);
 await pool.query(`INSERT INTO commerce_order_line(order_id,line_number,product_id,sku_id,product_code,product_name,sku_code,sku_label,quantity,unit_price_cents,line_subtotal_cents,line_discount_cents,line_total_cents)
  VALUES($1,1,$2,$3,'${qualified?'aigerong-scalp-repair-essence-100':'sharing-test-product'}','合成分享商品','SHARING_SKU','One',1,${unit},${unit},${discount},${net})`,[orderId,orderProduct,orderSku]);
 await pool.query(`INSERT INTO commerce_payment_attempt(order_id,out_trade_no,member_id,payer_openid,app_id,merchant_id,amount_cents,currency,quote_id,pricing_rule_version,quote_price_version,expires_at)
  VALUES($1,$2,$3,$4,$5,$6,${total},'CNY',$7,'sharing-synthetic-v1',1,$8)`,[orderId,number,owner.memberId,'payer-'+owner.memberId,appId,merchantId,quote,expires]);
 await pool.query('INSERT INTO commerce_inventory_reservation(order_id,sku_id,quantity,expires_at) VALUES($1,$2,1,$3)',[orderId,orderSku,expires]);
 await pool.query('UPDATE catalog_inventory_level SET reserved_quantity=reserved_quantity+1 WHERE sku_id=$1',[orderSku]);
 const client=await pool.connect();try{
  if(historical){
   // Historical synthetic source fixtures exercise month cutoff/carryover. No production clock or immutable fact is modified.
   await client.query(`INSERT INTO commission_order_snapshot(order_id,buyer_member_id,referrer_member_id,basis_points,cash_merchandise_cents,source_kind,program,sharing_policy_id,sharing_visit_id,sharing_relation_event_id,created_at)
    SELECT $1,r.buyer_id,r.officer_id,p.basis_points,8800,'verified_commerce','sharing_officer',p.id,r.visit_id,e.id,$3
    FROM sharing_customer_relation r JOIN sharing_relation_event e ON e.buyer_id=r.buyer_id AND e.version=r.version CROSS JOIN LATERAL(SELECT id,basis_points FROM sharing_policy ORDER BY version DESC LIMIT 1)p WHERE r.buyer_id=$2`,[orderId,owner.memberId,at]);
  }else await snapshotSharingOfficer(client,orderId,owner.memberId,'verified_commerce',net);
 }finally{client.release();}
 return {id:orderId,number,owner,at,total,transactionId:'TX'+randomBytes(12).toString('hex')};
}
async function pay(order:any){
 const fact=signedFact({appid:appId,mchid:merchantId,out_trade_no:order.number,transaction_id:order.transactionId,trade_type:'JSAPI',trade_state:'SUCCESS',success_time:new Date(order.at.getTime()+1000).toISOString(),amount:{total:order.total,payer_total:order.total,currency:'CNY',payer_currency:'CNY'},payer:{openid:'payer-'+order.owner.memberId}},'TRANSACTION.SUCCESS','pay-'+order.id,'transaction');
 const received=await payments.receive(fact.rawBody,fact.headers);expect(await payments.processOne(received.inboxId)).toBe('applied');expect(await payments.processOne(received.inboxId)).toBe('applied');return received.inboxId;
}
async function refund(order:any,amount:number,paymentId:string){
 const ref='RF'+randomBytes(12).toString('hex'),lineId=(await pool.query('SELECT id FROM commerce_order_line WHERE order_id=$1',[order.id])).rows[0].id;
 await pool.query(`INSERT INTO commission_refund_intent(order_id,payment_inbox_id,out_refund_no,refund_cents,payer_refund_cents,eligible_merchandise_refund_cents,other_merchandise_refund_cents,shipping_cash_refund_cents,line_allocation,allocation_policy_version,created_by)
  VALUES($1,$2,$3,$4,$4,$4,0,0,$5,'sharing-synthetic-v1','isolated-test')`,[order.id,paymentId,ref,amount,JSON.stringify([{lineId,eligibleCashRefundCents:amount,otherCashRefundCents:0}])]);
 const fact=signedFact({mchid:merchantId,out_trade_no:order.number,transaction_id:order.transactionId,out_refund_no:ref,refund_id:'PR'+randomBytes(10).toString('hex'),refund_status:'SUCCESS',success_time:new Date().toISOString(),amount:{total:9300,refund:amount,payer_total:9300,payer_refund:amount}},'REFUND.SUCCESS','refund-'+ref,'refund');
 const received=await refunds.receive(fact.rawBody,fact.headers);expect(await refunds.processOne(received.inboxId)).toBe('applied');expect((await refunds.receive(fact.rawBody,fact.headers)).inboxId).toBe(received.inboxId);return received;
}
async function ship(order:any,sameDay=false){
 const sync=(await pool.query(`INSERT INTO commerce_shipping_sync(order_id,created_by_member_id,request_key,request_hmac,encrypted_parcel,key_version,evidence_reference)
  VALUES($1,$2,$3,$4,'synthetic-only','v1','synthetic-fixture') RETURNING id`,[order.id,manager.memberId,'shipping-'+order.id,'a'.repeat(64)])).rows[0].id;
 const shipmentDelay=sameDay?2000:86400_000,receipt=new Date(order.at.getTime()+2*shipmentDelay);
 await pool.query(`INSERT INTO commerce_shipment(order_id,shipping_sync_id,carrier_name,shipped_at,receipt_confirmed_at,created_by_member_id)
  VALUES($1,$2,'合成承运商',$3,$4,$5)`,[order.id,sync,new Date(order.at.getTime()+shipmentDelay),receipt,manager.memberId]);
}
beforeAll(async()=>{
 await resetDatabase(pool);app=await createApp({config,pool,storage:createApiGatewayStorage(config)});
 const identity=async(name:string)=>expectOk(app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:name,displayName:name,consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}}));
 [manager,a,b,buyer,other]=await Promise.all(['sharing-manager','sharing-a','sharing-b','sharing-buyer','sharing-other'].map(identity));
 for(const cap of ['member.manage','commission.rate.manage','commission.read','commission.settlement.approve'])await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,$2,'fixture','sharing synthetic test','test','integration_fixture')`,[manager.memberId,cap]);
 product=(await pool.query(`INSERT INTO catalog_product(code,name,source_kind,qualification_status,publication_status,created_by,updated_by,published_at) VALUES('sharing-test-product','合成分享商品','admin','eligible','published','fixture','fixture',now()) RETURNING id`)).rows[0].id;
 sku=(await pool.query(`INSERT INTO catalog_sku(product_id,code,label,created_by,updated_by) VALUES($1,'SHARING_SKU','One','fixture','fixture') RETURNING id`,[product])).rows[0].id;
 await pool.query("INSERT INTO catalog_inventory_level(sku_id,stock_on_hand,updated_by) VALUES($1,100,'fixture')",[sku]);
 qualProduct=(await pool.query(`INSERT INTO catalog_product(code,name,source_kind,qualification_status,publication_status,created_by,updated_by,published_at) VALUES('aigerong-scalp-repair-essence-100','合成精华套组','synthetic_test','eligible','published','fixture','fixture',now()) RETURNING id`)).rows[0].id;
 qualSku=(await pool.query(`INSERT INTO catalog_sku(product_id,code,label,created_by,updated_by) VALUES($1,'QUALIFYING_ESSENCE','100mL','fixture','fixture') RETURNING id`,[qualProduct])).rows[0].id;
 await pool.query("INSERT INTO catalog_inventory_level(sku_id,stock_on_hand,updated_by) VALUES($1,100,'fixture')",[qualSku]);
 address=randomUUID();await pool.query(`INSERT INTO member_delivery_address(id,member_id,encrypted_payload,payload_hmac,key_version,label,client_request_key) VALUES($1,$2,'synthetic-only',$3,'fixture','home','sharing-fixture-address')`,[address,buyer.memberId,'a'.repeat(64)]);
});
afterAll(async()=>{await app?.close();await pool.end();});

it('requires a paid essence set before applications, isolates review authority and preserves idempotent decisions',async()=>{
 expect((await app.inject({method:'GET',url:'/v1/me/sharing-officer'})).statusCode).toBe(401);
 const status=await service.mine(a.memberId);expect(status).toMatchObject({canApply:false,qualification:{met:false},applicationAgreement:{version:'V2.0.1',effectiveOn:null},policy:{attributionDays:null,priority:'first',selfPurchase:false,basisPoints:1000,releaseDays:7}});policyVersion=status.policy!.version;
 expect((await command(a,'apply',{})).json().code).toBe('SHARING_PURCHASE_REQUIRED');
 for(const member of [a,b])await pay(await seedOrder(member,false,true));
 expect((await service.mine(a.memberId)).canApply).toBe(true);
 const applyKey='sharing-application-replay';const applied=await expectOk(command(a,'apply',{note:'合成申请'},false,applyKey));expect(applied).toMatchObject({state:'pending',version:1});codeA=applied.referralCode;
 expect((await expectOk(command(a,'apply',{note:'合成申请'},false,applyKey))).referralCode).toBe(codeA);
 expect((await command(a,'apply',{note:'不同内容'},false,applyKey)).statusCode).toBe(409);
 expect((await command(a,'officer_state',{memberId:a.memberId,state:'active',expectedVersion:1,reason:'无权自审'},true)).statusCode).toBe(403);
 const detail=await expectOk(app.inject({method:'GET',headers:auth(manager),url:`/v1/management/sharing-officer?section=officer-detail&memberId=${a.memberId}&version=1`}));
 expect(detail.detail).toMatchObject({accountState:'active',qualification:{met:true},member:null});
 expect((await app.inject({method:'GET',headers:auth(manager),url:`/v1/management/sharing-officer?section=customers&memberId=${a.memberId}`})).statusCode).toBe(403);
 for(const target of [a,b]){const application=target===a?applied:await expectOk(command(target,'apply',{}));if(target===b)codeB=application.referralCode;
  await expectOk(command(manager,'officer_state',{memberId:target.memberId,state:'active',expectedVersion:1,reason:'合成审核通过'},true));}
 expect((await service.mine(a.memberId)).canShare).toBe(true);expect((await pool.query('SELECT user_code FROM member_card_number WHERE member_id=$1',[a.memberId])).rows[0].user_code).toBe(codeA);const owned=await finance.management(manager.memberId,{memberId:a.memberId});expect('items'in owned&&owned.items.map((r:any)=>r.memberId)).toEqual([a.memberId]);expect((await pool.query('SELECT count(*)::int AS n FROM commercial_membership')).rows[0].n).toBe(0);
});
it('issues one non-product referral for community content and care while the qualifying product is offline',async()=>{
 await pool.query("UPDATE catalog_product SET publication_status='unpublished' WHERE id=$1",[qualProduct]);
 try{
  const issue=(user:any,targetType:string,targetRef:string,sequence:string)=>expectOk(app.inject({
   method:'POST',url:'/v1/shares',headers:{...auth(user),'idempotency-key':'sharing-entry-'+sequence},payload:{targetType,targetRef}
  }));
  const invite=await issue(a,'invite','home','officer');
  const post=await issue(a,'post',randomUUID(),'article');
  expect(invite.officerShareId).toMatch(/^[0-9a-f]{32}$/);
  expect(post.officerShareId).toBe(invite.officerShareId);
  expect((await issue(other,'invite','home','ordinary')).officerShareId).toBeNull();
  expect(await service.visit(invite.officerShareId,'synthetic-public-entry-0001')).toMatchObject({productCode:null,visitToken:expect.any(String)});
 }finally{await pool.query("UPDATE catalog_product SET publication_status='published' WHERE id=$1",[qualProduct]);}
});
it('creates native product attribution and keeps first permanent ownership until the buyer changes it',async()=>{
 shareA=(await expectOk(command(a,'share',{productCode:'sharing-test-product'}))).shareId;shareB=(await expectOk(command(b,'share',{productCode:'sharing-test-product'}))).shareId;
 const generic=await expectOk(app.inject({method:'POST',url:'/v1/shares',headers:{...auth(a),'idempotency-key':'sharing-generic-product'},payload:{targetType:'product',targetRef:'sharing-test-product'}}));expect(generic.officerShareId).toBe(shareA);
 const firstVisit=await expectOk(app.inject({method:'POST',url:`/v1/officer-shares/${shareA}/visits`,payload:{visitKey:'synthetic-first-visit-0001'}}));
 const lastVisit=await service.visit(shareB,'synthetic-second-visit-0002');
 // Both visits happened within one JavaScript millisecond. Bind the later
 // visit first and verify that database precision still identifies the first.
 await pool.query(`WITH visit_time AS (SELECT date_trunc('milliseconds',min(visited_at))-interval '1 millisecond' AS at
  FROM sharing_visit WHERE visit_key IN ('synthetic-first-visit-0001','synthetic-second-visit-0002'))
  UPDATE sharing_visit SET visited_at=visit_time.at+CASE WHEN visit_key='synthetic-first-visit-0001' THEN interval '1 microsecond' ELSE interval '2 microseconds' END
  FROM visit_time WHERE visit_key IN ('synthetic-first-visit-0001','synthetic-second-visit-0002')`);
 const returning=buyer,oldVisit=await service.visit(shareA,'synthetic-existing-member-0001');await expectOk(command(returning,'bind_visit',{visitToken:oldVisit.visitToken}));expect((await service.mine(returning.memberId)).relation).toBeNull();
 buyer=await expectOk(app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'sharing-new-after-link',displayName:'合成受邀新会员',consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}}));
 address=randomUUID();await pool.query(`INSERT INTO member_delivery_address(id,member_id,encrypted_payload,payload_hmac,key_version,label,client_request_key) VALUES($1,$2,'synthetic-only',$3,'fixture','home','sharing-new-buyer-address')`,[address,buyer.memberId,'a'.repeat(64)]);

 await expectOk(command(buyer,'bind_visit',{visitToken:lastVisit.visitToken}));await expectOk(command(buyer,'bind_visit',{visitToken:firstVisit.visitToken}));
 expect((await service.mine(buyer.memberId)).relation).toMatchObject({code:codeA,expiresAt:null,source:'first_touch'});
 first=await seedOrder(buyer);expect((await pool.query('SELECT referrer_member_id,basis_points FROM commission_order_snapshot WHERE order_id=$1',[first.id])).rows[0]).toEqual({referrer_member_id:a.memberId,basis_points:1000});
 const preview=await service.previewReferrer(buyer.memberId,codeB);await expectOk(command(buyer,'change_referrer',{code:codeB,confirmed:true,expectedVersion:preview.current!.version}));
 await expectOk(command(buyer,'bind_visit',{visitToken:firstVisit.visitToken}));expect((await service.mine(buyer.memberId)).relation!.code).toBe(codeB);
 expect((await command(buyer,'change_referrer',{code:codeA,confirmed:false,expectedVersion:3})).statusCode).toBe(422);
 const own=await service.visit(shareA,'synthetic-self-visit-0003');await expectOk(command(a,'bind_visit',{visitToken:own.visitToken}));expect((await service.mine(a.memberId)).relation).toBeNull();
 expect((await app.inject({method:'GET',url:'/v1/me/sharing-officer/referrer-preview?code='+codeA,headers:auth(a)})).statusCode).toBe(422);
});
it('locks future rates separately and uses only verified merchandise cash for actual accrual',async()=>{
 await expectOk(command(manager,'policy',{enabled:true,attributionDays:null,priority:'first',selfPurchase:false,basisPoints:2000,releaseDays:7,reason:'合成调整新订单佣金',expectedVersion:policyVersion},true));
 second=await seedOrder(buyer,true);first.paymentId=await pay(first);second.paymentId=await pay(second);
 const rows=(await pool.query('SELECT order_id,referrer_member_id,basis_points FROM commission_order_snapshot ORDER BY order_id')).rows;
 expect(rows).toEqual(expect.arrayContaining([{order_id:first.id,referrer_member_id:a.memberId,basis_points:1000},{order_id:second.id,referrer_member_id:b.memberId,basis_points:2000}]));
 expect((await service.orders(a.memberId,{id:first.id})).items[0]).toMatchObject({cashMerchandiseCents:8800,pendingCents:880,paidAt:expect.any(Date)});
 expect((await service.orders(b.memberId,{id:second.id})).items[0]).toMatchObject({pendingCents:1760});
 expect((await service.orders(other.memberId,{id:first.id})).items).toHaveLength(0);
 const privatePayload=JSON.stringify(await service.orders(a.memberId));for(const value of ['buyer_member_id','payer_openid','recipientName','phone','address'])expect(privatePayload).not.toContain(value);
});
it('preserves partial-refund history and prevents immature/manual-forged release',async()=>{
 await refund(first,4400,first.paymentId);const before=(await service.orders(a.memberId,{id:first.id})).items[0];expect(before).toMatchObject({pendingCents:440,refundedMerchandiseCents:4400});
 await expect(pool.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,event_key,kind,amount_cents,source_fact_id,actor_principal_id)
  SELECT order_id,referrer_member_id,'sharing-forged-release','release',440,sharing_policy_id,'fixture' FROM commission_order_snapshot WHERE order_id=$1`,[first.id])).rejects.toThrow('SHARING_RELEASE_NOT_ELIGIBLE');
 await ship(second);expect(await releaseSharingCommissions(pool)).toBe(1);expect(await releaseSharingCommissions(pool)).toBe(0);
 const selfOrder=await seedOrder(a);expect((await pool.query('SELECT 1 FROM commission_order_snapshot WHERE order_id=$1',[selfOrder.id])).rowCount).toBe(0);
});
it('prevents legacy automatic payout/credit allocation of manual-only sources',async()=>{
 const snapshot=(await pool.query('SELECT * FROM commission_order_snapshot WHERE order_id=$1',[second.id])).rows[0];
 await expect(pool.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,event_key,kind,amount_cents,source_fact_id,actor_principal_id)
  VALUES($1,$2,'sharing-forged-payment','settlement',100,$3,'fixture')`,[second.id,snapshot.referrer_member_id,randomUUID()])).rejects.toThrow('SHARING_RECORDED_PAYMENT_REQUIRED');
 expect((await new (await import('../../services/api/src/commercialMembership')).CommercialMembershipService(pool,authority,'test').myStatus(b.memberId)).commission.availableCents).toBe(0);
});
it('records encrypted payee data and rejects ordinary users reading company finance data',async()=>{
 await expectOk(command(b,'payee',{legalName:'合成收款人',channel:'合成银行',account:'SYNTHETIC-ACCOUNT-ONLY',expectedVersion:0}));
 const db=(await pool.query('SELECT encrypted_payload FROM sharing_payee WHERE member_id=$1',[b.memberId])).rows[0];expect(db.encrypted_payload).not.toContain('SYNTHETIC');
 expect((await app.inject({method:'POST',url:'/v1/management/sharing-officer/payee/'+b.memberId,headers:auth(other)})).statusCode).toBe(403);
 expect(await service.readPayee(manager.memberId,b.memberId)).toMatchObject({legalName:'合成收款人',account:'SYNTHETIC-ACCOUNT-ONLY'});
 expect((await pool.query("SELECT response::text FROM sharing_command WHERE actor_id=$1",[b.memberId])).rows.every(r=>!r.response.includes('SYNTHETIC-ACCOUNT'))).toBe(true);
});
it('recovers ambiguous commands without permitting a delayed abandoned request to execute',async()=>{
 const key='sharing-abandoned-command-0001';expect(await service.commandStatus(a.memberId,key,true)).toEqual({state:'abandoned'});
 expect((await command(a,'payee',{legalName:'合成',channel:'合成',account:'0000',expectedVersion:0},false,key)).statusCode).toBe(409);
 expect(await service.commandStatus(a.memberId,key)).toMatchObject({state:'abandoned'});
});
it('generates monthly held sources, rechecks changed payee/refunds and records reviewed tax and manual payment exactly once',async()=>{
 const preview=await service.previewReferrer(other.memberId,codeB);await expectOk(command(other,'change_referrer',{code:codeB,confirmed:true,expectedVersion:preview.current?.version??0}));
 historical=await seedOrder(other,true);historical.paymentId=await pay(historical);await ship(historical);
 await pool.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,event_key,kind,amount_cents,source_fact_id,actor_principal_id,occurred_at)
  SELECT order_id,referrer_member_id,$2,'release',1760,sharing_policy_id,'synthetic-history-fixture',$3 FROM commission_order_snapshot WHERE order_id=$1`,
  [historical.id,'sharing-history-release-'+historical.id,new Date(historical.at.getTime()+15*86400_000)]);
 period=historical.at.toISOString().slice(0,7);const prepared=await expectOk(command(manager,'prepare_month',{period},true));monthBatch=prepared.batchId;expect(prepared.created).toBe(1);
 let lines=await finance.management(manager.memberId,{section:'lines',batchId:monthBatch});expect('items'in lines&&lines.items).toHaveLength(1);line=('items'in lines?lines.items:[])[0];expect(line.grossCents).toBe(1760);const wrong=await finance.management(manager.memberId,{section:'lines',batchId:monthBatch,memberId:a.memberId,lineId:line.id});expect('items'in wrong&&wrong.items).toHaveLength(0);const exact=await finance.management(manager.memberId,{section:'lines',batchId:monthBatch,memberId:b.memberId,lineId:line.id});expect('items'in exact&&exact.items).toHaveLength(1);
 expect((await command(manager,'review_line',{lineId:line.id,expectedVersion:line.version,taxCents:1761,taxNote:'合成超额扣税'},true)).statusCode).toBe(422);
 const reviewed=await expectOk(command(manager,'review_line',{lineId:line.id,expectedVersion:line.version,taxCents:176,taxNote:'合成财务审核；不代表真实税率'},true));
 await expectOk(command(b,'payee',{legalName:'合成收款人更新',channel:'合成银行',account:'SYNTHETIC-ACCOUNT-UPDATED',expectedVersion:1}));
 const sourceClock=async()=>(await pool.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
 const payInput={lineId:line.id,expectedVersion:reviewed.version,paidConfirmed:true,paymentReference:'SYNTHETIC-PAYEE-CHANGED',paymentNote:'合成记录',paidAt:await sourceClock()};
 const changed=await command(manager,'record_payment',payInput,true);expect(changed.statusCode).toBe(409);expect(changed.json().code).toBe('SHARING_PAYEE_CHANGED');
 await refund(historical,880,historical.paymentId);
 const disputed=await command(manager,'review_line',{lineId:line.id,expectedVersion:reviewed.version,taxCents:176,taxNote:'合成退款重审'},true);expect(disputed.statusCode).toBe(409);expect(disputed.json().code).toBe('SHARING_SETTLEMENT_SOURCE_CHANGED');
 await expectOk(command(manager,'void_line',{lineId:line.id,expectedVersion:reviewed.version,reason:'合成退款后重新生成'},true));
 const again=await expectOk(command(manager,'prepare_month',{period},true));expect(again.created).toBe(1);
 lines=await finance.management(manager.memberId,{section:'lines',batchId:monthBatch});line=('items'in lines?lines.items:[]).find((r:any)=>r.state==='prepared');expect(line.grossCents).toBe(1584);
 const checked=await expectOk(command(manager,'review_line',{lineId:line.id,expectedVersion:line.version,taxCents:84,taxNote:'合成财务核定金额；不代表真实税率'},true));
 await new Promise(resolve=>setTimeout(resolve,5));const input={lineId:line.id,expectedVersion:checked.version,paidConfirmed:true,paymentReference:'SYNTHETIC-PAID-'+line.id,paymentNote:'隔离测试人工付款结果，不发生任何真实转账',paidAt:await sourceClock()},key='sharing-payment-exact-replay';
 const paid=await expectOk(command(manager,'record_payment',input,true,key));expect(paid).toMatchObject({state:'paid',grossCents:1584,taxCents:84,netCents:1500});
 expect(await expectOk(command(manager,'record_payment',input,true,key))).toEqual(paid);
 expect((await command(manager,'record_payment',input,true)).statusCode).toBe(409);
 expect((await pool.query("SELECT count(*)::int AS n FROM commission_ledger_entry WHERE order_id=$1 AND kind='settlement'",[historical.id])).rows[0].n).toBe(1);
 expect((await finance.settlements(b.memberId)).items.some(r=>r.id===line.id&&r.netCents===1500&&r.taxCents===84)).toBe(true);
 const exported=await finance.exportBatch(manager.memberId,monthBatch);expect(exported.csv).toContain('15.00');expect(exported.csv).not.toContain('SYNTHETIC-ACCOUNT');
 expect((await app.inject({method:'GET',url:`/v1/management/sharing-officer/batches/${monthBatch}/export`,headers:auth(other)})).statusCode).toBe(403);
});
it('keeps paid history immutable after a later full merchandise refund and records reconciled recovery separately',async()=>{
 await refund(historical,7920,historical.paymentId);
 const order=(await service.orders(b.memberId,{id:historical.id})).items[0]!;expect(order).toMatchObject({settledCents:1584,recoveryCents:1584,outstandingRecoveryCents:1584,pendingCents:0,availableCents:0});
 const settled=(await finance.settlements(b.memberId,{id:line.id})).items[0];expect(settled).toMatchObject({grossCents:1584,taxCents:84,netCents:1500,state:'paid'});
 await expect(pool.query("UPDATE sharing_settlement_line SET tax_cents=0,version=version+1 WHERE id=$1",[line.id])).rejects.toThrow('SHARING_SETTLEMENT_IMMUTABLE');
 expect((await command(manager,'record_recovery',{orderId:historical.id,amountCents:1584,receivedCents:1500,taxAdjustmentCents:0,reference:'SYNTHETIC-RECOVERY-BAD',note:'合成财务核对',receivedConfirmed:true},true)).statusCode).toBe(422);
 await expectOk(command(manager,'record_recovery',{orderId:historical.id,amountCents:1584,receivedCents:1500,taxAdjustmentCents:84,reference:'SYNTHETIC-RECOVERY-'+historical.id,note:'合成财务审核税务调整及实际回收；不代表真实税率',receivedConfirmed:true},true));
 expect((await service.orders(b.memberId,{id:historical.id})).items[0]!.outstandingRecoveryCents).toBe(0);
 const detail=await finance.orderDetail(b.memberId,historical.id);expect(detail.items.some((p:any)=>p.kind==='payment_record'&&p.reference==='SYNTHETIC-PAID-'+line.id)).toBe(true);expect(detail.items.filter((p:any)=>p.kind==='refund_record')).toHaveLength(2);expect(detail.items.find((p:any)=>p.kind==='recovery_record')).toMatchObject({amountCents:1584,receivedCents:1500,taxAdjustmentCents:84});
 expect((await app.inject({method:'GET',url:'/v1/me/sharing-officer/orders/'+historical.id,headers:auth(a)})).statusCode).toBe(404);
});
it('generates official API assets, refreshes an expired token once, caches assets and rechecks paused qualifications',async()=>{
 const requests:Array<{url:string;body:any}>=[];let qrCalls=0;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=','base64');
 const fetcher=(async(url:any,options:any)=>{requests.push({url:String(url),body:JSON.parse(options.body)});
  if(String(url).includes('stable_token'))return Response.json({access_token:'synthetic-provider-token-'+requests.length,expires_in:7200});
  if(String(url).includes('getwxacodeunlimit'))return ++qrCalls===1?Response.json({errcode:40001}):new Response(png,{headers:{'content-type':'image/png'}});
  return Response.json({errcode:0,url_link:'https://wxaurl.cn/SyntheticSharingOnly'});
 }) as typeof fetch;
 const assets=new SharingOfficerAssets(service,{appId,appSecret:'isolated-synthetic-only',environment:'trial'},fetcher);
 const result=await assets.assets(a.memberId,shareA);expect(result).toMatchObject({urlAvailable:true,qrPngBase64:png.toString('base64')});
 expect(requests.filter(r=>r.url.includes('stable_token'))).toHaveLength(2);expect(qrCalls).toBe(2);
 expect(requests.find(r=>r.url.includes('getwxacodeunlimit'))!.body).toMatchObject({scene:shareA,page:'pages/product/index',check_path:false,env_version:'trial'});
 expect(await assets.assets(a.memberId,shareA)).toMatchObject({qrPngBase64:result.qrPngBase64});expect(requests).toHaveLength(5);
 await expectOk(command(manager,'officer_state',{memberId:a.memberId,state:'suspended',expectedVersion:2,reason:'合成暂停资格验证'},true));
 await expect(assets.assets(a.memberId,shareA)).rejects.toThrow('当前不可使用');
 await expectOk(command(manager,'officer_state',{memberId:a.memberId,state:'active',expectedVersion:3,reason:'合成恢复资格验证'},true));
});
it('exports only owner sharing/settlement records with decrypted owner payee details and no referred customer identity',async()=>{
 const client=await pool.connect();try{const exported=await collectSharingPortableData(client,config,b.memberId);
  expect(exported.payee).toMatchObject({legalName:'合成收款人更新',account:'SYNTHETIC-ACCOUNT-UPDATED'});
  const safe=JSON.stringify(exported);expect(safe).not.toContain(buyer.memberId);expect(safe).not.toContain(other.memberId);expect(safe).not.toContain('encrypted_payload');expect(safe).not.toContain('token_hash');
 }finally{client.release();}
});
it('redacts a former finance operator’s command receipt and refuses replay after permission is revoked',async()=>{
 await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='fixture',revoke_reason='合成撤权测试' WHERE member_id=$1 AND capability='commission.settlement.approve'",[manager.memberId]);
 expect(await service.commandStatus(manager.memberId,'sharing-payment-exact-replay')).toEqual({state:'completed',redacted:true});
 const denied=await command(manager,'record_payment',{},true,'sharing-payment-exact-replay');expect(denied.statusCode).toBe(403);
});

it('shows the same verified payment, refund, coupon-free order and paid sharing history in member administration',async()=>{
 for(const cap of ['member.profile.read','commerce.order.read','commerce.money.reconcile'])await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,$2,'fixture','member source reconciliation','test','integration_fixture')",[manager.memberId,cap]);
 const admin=new MemberAdministration(pool,config),member=await admin.overview(manager.memberId,other.memberId);
 expect(member.member.commerce).toMatchObject({orderCount:1,paidOrderCount:1,paidCents:9300,refundedCents:8800,netCents:500});
 const orders:any=await admin.section(manager.memberId,other.memberId,'orders');
 expect(orders.items).toHaveLength(1);expect(orders.items[0]).toMatchObject({id:historical.id,paidCents:9300,refundedCents:8800,source:{kind:'order',id:historical.id}});
 const sharing:any=await admin.section(manager.memberId,b.memberId,'sharing');
 expect(sharing.data.commission).toMatchObject({settledCents:1584,taxCents:84,netCents:1500,outstandingRecoveryCents:0});
 const promoted:any=await admin.section(manager.memberId,b.memberId,'sharing-orders');
 expect(promoted.items.find((r:any)=>r.id===historical.id)).toMatchObject({settledCents:1584,outstandingRecoveryCents:0,source:{kind:'order',id:historical.id}});
 const settlements:any=await admin.section(manager.memberId,b.memberId,'settlements');
 expect(settlements.items.find((r:any)=>r.id===line.id)).toMatchObject({grossCents:1584,taxCents:84,netCents:1500,state:'paid',source:null});
 expect(JSON.stringify(settlements)).not.toContain('SYNTHETIC-PAID-');
});

it('records simple approval, binds only after valid orders, and clears expired V2 relations',async()=>{
 const identity=(name:string)=>expectOk(app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:name,displayName:name,
  consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}}));
 const [officer,next,customer]=await Promise.all(['sharing-v2-officer','sharing-v2-next','sharing-v2-customer'].map(identity));
 for(const applicant of [officer,next])await pay(await seedOrder(applicant,false,true));
 expect((await service.mine(officer.memberId)).applicationAgreement).toMatchObject({version:'V2.0.1',effectiveOn:null});
 expect((await command(officer,'apply',{agreement:{accepted:true}})).json().code).toBe('SHARING_AGREEMENT_NOT_EFFECTIVE');
 config.sharingAgreementV2EffectiveOn='2026-01-01';
 try{
  const codes:string[]=[];
  for(const applicant of [officer,next]){
   const document=(await service.mine(applicant.memberId)).applicationAgreement!;
   const agreement={accepted:true,version:document.version,effectiveOn:document.effectiveOn,digest:document.digest};
   expect((await command(applicant,'apply',{})).json().code).toBe('SHARING_AGREEMENT_REQUIRED');
   expect((await command(applicant,'apply',{agreement:{...agreement,digest:'0'.repeat(64)}})).json().code).toBe('SHARING_AGREEMENT_CHANGED');
   const key='sharing-v2-consent-'+applicant.memberId;
   const application=await expectOk(command(applicant,'apply',{agreement},false,key));
   expect(application).toMatchObject({state:'pending',version:1,agreement:{version:'V2.0.1',effectiveOn:'2026-11-28',digest:document.digest,acceptedAt:expect.any(String)}});
   expect(await expectOk(command(applicant,'apply',{agreement},false,key))).toEqual(application);
   const queueUrl='/v1/management/sharing-officer?section=officers&filter=pending&memberId='+applicant.memberId;
   expect((await app.inject({method:'GET',url:queueUrl,headers:auth(applicant)})).statusCode).toBe(403);
   const readQueue=()=>expectOk(app.inject({method:'GET',url:queueUrl,headers:auth(manager)}));
   expect((await readQueue()).items).toEqual([expect.objectContaining({memberId:applicant.memberId,state:'pending',version:1,agreementVersion:'V2.0.1',
    applicationAt:application.agreement.acceptedAt,availablePoints:expect.any(Number)})]);
   const readDetail=(version:number)=>app.inject({method:'GET',headers:auth(manager),
    url:`/v1/management/sharing-officer?section=officer-detail&memberId=${applicant.memberId}&version=${version}`});
   const pendingDetail=await expectOk(readDetail(1));
   expect(pendingDetail.detail).toMatchObject({qualification:{met:true},agreement:{acceptedAt:application.agreement.acceptedAt,version:'V2.0.1'},
    member:{registeredAt:expect.any(String),publicPosts:0,commerce:{paidOrderCount:1,orders:[{paidCents:29800}]}}});
   expect((await command(manager,'officer_state',{memberId:applicant.memberId,expectedVersion:1,state:'rejected'},true)).statusCode).toBe(422);
   const reason=codes.length?'已达到申请条件':undefined;
   const approval={memberId:applicant.memberId,expectedVersion:1,state:'active',...(reason?{reason}:{})};
   const approvalKey='sharing-approval-'+applicant.memberId;
   const approved=await expectOk(command(manager,'officer_state',approval,true,approvalKey));
   expect(await expectOk(command(manager,'officer_state',approval,true,approvalKey))).toEqual(approved);
   expect((await readQueue()).items).toEqual([]);
   expect((await readDetail(1)).statusCode).toBe(409);
   const reviewed=await expectOk(readDetail(2));
   expect(reviewed.detail).toMatchObject({review:{result:'active',occurredAt:expect.any(String),reviewer:'sharing-manager',reason:reason??''}});
   expect(reviewed.detail.agreement).toEqual({acceptedAt:application.agreement.acceptedAt,version:'V2.0.1'});
   expect((await service.mine(applicant.memberId)).policy).toMatchObject({basisPoints:3000});
   const evidence=await pool.query(`SELECT agreement_digest,verified_at,verification_reference,
    sharing_v2_approval_at(member_id,application_version) AS approval FROM sharing_v2_application WHERE member_id=$1`,[applicant.memberId]);
   expect(evidence.rows).toEqual([{agreement_digest:document.digest,verified_at:null,verification_reference:null,approval:new Date(reviewed.detail.review.occurredAt)}]);
   const {digest,...body}=document;
   const client=await pool.connect();
   try{
    const portable=await collectSharingPortableData(client,config,applicant.memberId);
    expect(portable.agreementConfirmations).toEqual([expect.objectContaining({agreement_digest:digest,document:body})]);
   }finally{client.release();}
   codes.push(application.referralCode);
  }
  expect((await pool.query('SELECT * FROM sharing_v2_agreement_document')).rowCount).toBe(1);
  const policy=(await service.mine(manager.memberId)).policy!;
  await expectOk(command(manager,'policy',{enabled:true,attributionDays:null,priority:'first',selfPurchase:false,
   basisPoints:policy.basisPoints,releaseDays:0,reason:'合成当日有效订单',expectedVersion:policy.version},true));
  const {shareId}=await expectOk(command(officer,'share',{productCode:'sharing-test-product'}));
  const {visitToken}=await expectOk(app.inject({method:'POST',url:'/v1/officer-shares/'+shareId+'/visits',payload:{visitKey:'sharing-v2-customer-visit'}}));
  await expectOk(command(customer,'bind_visit',{visitToken}));
  expect(await service.mine(customer.memberId)).toMatchObject({relation:null,pendingReferrer:{code:codes[0]}});
  const firstV2=await seedOrder(customer);
  await pay(firstV2);
  expect((await service.mine(customer.memberId)).relation).toBeNull();
  await ship(firstV2,true);
  await releaseSharingCommissions(pool);
  expect(await service.mine(customer.memberId)).toMatchObject({relation:{version:1,code:codes[0],agreementVersion:'V2.0.1'},pendingReferrer:null});
  expect((await service.orders(officer.memberId,{id:firstV2.id})).items[0]).toMatchObject({availableCents:2640,cashMerchandiseCents:8800,agreementVersion:'V2.0.1'});

  const customerPage=(filter:string,viewer=manager)=>expectOk(app.inject({method:'GET',headers:auth(viewer),
   url:`/v1/management/sharing-officer?section=customers&memberId=${officer.memberId}&customerFilter=${filter}&limit=1`}));
  const changeState=(state:string,expectedVersion:number)=>expectOk(command(manager,'officer_state',
   {memberId:officer.memberId,state,expectedVersion,reason:'合成资格调整'},true));
  async function expectSnapshot(expected:string|null){
   const order=await seedOrder(customer);
   const result=await pool.query('SELECT referrer_member_id FROM commission_order_snapshot WHERE order_id=$1',[order.id]);
   expect(result.rows[0]?.referrer_member_id??null).toBe(expected);
   return order.id;
  }
  const reviewedPage=()=>expectOk(app.inject({method:'GET',headers:auth(manager),
   url:`/v1/management/sharing-officer?section=officers&filter=reviewed&memberId=${officer.memberId}`}));
  const decisionAt=(await reviewedPage()).items[0].reviewedAt;
  await changeState('suspended',2);
  expect((await reviewedPage()).items[0]).toMatchObject({state:'suspended',reviewedAt:decisionAt});
  const pausedOrder=await expectSnapshot(null);
  expect((await customerPage('retained')).items).toEqual([expect.objectContaining({id:customer.memberId,version:1,controlVersion:1,
   cardNumber:expect.stringMatching(/^No\. \d{5,}$/),displayIdentity:'member',avatar:null,availablePoints:expect.any(Number)})]);
  const profileOnly=await identity('sharing-v2-profile-only-admin');
  for(const cap of ['member.manage','member.profile.read'])await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
   VALUES($1,$2,'fixture','sharing read scope','test','integration_fixture')`,[profileOnly.memberId,cap]);
  expect((await customerPage('retained',profileOnly)).items[0]).not.toHaveProperty('availablePoints');
  await changeState('active',3);
  await expectSnapshot(officer.memberId);

  const commandInput={memberId:officer.memberId,buyerId:customer.memberId,expectedVersion:1,expectedControlVersion:1,
   expectedOfficerVersion:4,reason:'合成归属调整',remove:true,confirmed:true};
  expect((await command(manager,'customer_relation',{...commandInput,confirmed:false},true)).json().code).toBe('SHARING_CUSTOMER_CONFIRM_REQUIRED');
  expect((await command(officer,'customer_relation',commandInput,true)).statusCode).toBe(403);
  const removeKey='sharing-customer-remove-exact';
  const removed=await expectOk(command(manager,'customer_relation',commandInput,true,removeKey));
  expect(removed).toEqual({controlVersion:2,removed:true});
  expect(await expectOk(command(manager,'customer_relation',commandInput,true,removeKey))).toEqual(removed);
  expect((await customerPage('retained')).items).toEqual([]);
  expect((await customerPage('removed')).items).toEqual([expect.objectContaining({id:customer.memberId,controlVersion:2,restorable:true})]);
  expect((await service.mine(customer.memberId)).relation).toBeNull();
  await expectSnapshot(null);
  const newVisit=await expectOk(app.inject({method:'POST',url:'/v1/officer-shares/'+shareId+'/visits',payload:{visitKey:'sharing-v2-removed-second-visit'}}));
  await expectOk(command(customer,'bind_visit',{visitToken:newVisit.visitToken}));
  expect((await service.mine(customer.memberId)).pendingReferrer).toBeNull();
  await changeState('suspended',4);
  await changeState('active',5);
  await expectSnapshot(null);
  const restore={...commandInput,expectedOfficerVersion:6,expectedControlVersion:2,remove:false};
  expect((await command(manager,'customer_relation',{...restore,expectedControlVersion:1},true)).json().code).toBe('VERSION_CONFLICT');
  expect(await expectOk(command(manager,'customer_relation',restore,true))).toEqual({controlVersion:3,removed:false});
  await expectSnapshot(officer.memberId);
  expect((await pool.query('SELECT 1 FROM commission_order_snapshot WHERE order_id=$1',[pausedOrder])).rowCount).toBe(0);
  expect((await pool.query('SELECT action FROM audit_log WHERE object_id=$1 AND action IN ($2,$3)',[customer.memberId,'sharing.customer.remove','sharing.customer.restore'])).rowCount).toBe(2);
  expect((await service.orders(officer.memberId,{id:firstV2.id})).items[0]?.availableCents).toBe(2640);

  await expectOk(command(customer,'change_referrer',{code:codes[1],confirmed:true,expectedVersion:1}));
  expect(await service.mine(customer.memberId)).toMatchObject({relation:{code:codes[0]},pendingReferrer:{code:codes[1]}});
  const refunded=await seedOrder(customer);
  await refund(refunded,8800,await pay(refunded));
  await ship(refunded,true);
  await releaseSharingCommissions(pool);
  expect(await service.mine(customer.memberId)).toMatchObject({relation:{code:codes[0]},pendingReferrer:{code:codes[1]}});
  const changed=await seedOrder(customer);
  await pay(changed);
  await ship(changed,true);
  await releaseSharingCommissions(pool);
  expect(await service.mine(customer.memberId)).toMatchObject({relation:{version:2,code:codes[1]},pendingReferrer:null});
  expect((await service.orders(next.memberId,{id:changed.id})).items[0]).toMatchObject({availableCents:2640});
  const latest={...commandInput,memberId:next.memberId,expectedOfficerVersion:2,expectedVersion:2,expectedControlVersion:3};
  await expectOk(command(manager,'customer_relation',latest,true));
  await expectOk(command(customer,'change_referrer',{code:codes[0],confirmed:true,expectedVersion:0}));
  expect((await command(manager,'customer_relation',{...latest,expectedControlVersion:4,remove:false},true)).json().code)
   .toBe('SHARING_CUSTOMER_REPLACEMENT_PENDING');
  expect(await service.mine(customer.memberId)).toMatchObject({relation:null,pendingReferrer:{code:codes[0]}});

  expect(sharingV2Period(new Date('2026-12-30T15:59:59Z'))).toBe('2026-12');
  expect(sharingV2Period(new Date('2026-12-30T16:00:00Z'))).toBe('2027-01');
  expect(sharingV2Cutoff('2027-02').toISOString()).toBe('2027-02-28T16:00:00.000Z');
  expect(sharingV2PaymentWindow('2026-12')).toEqual({start:'2027-01-10',end:'2027-01-15'});
  const releaseAt=(await pool.query<{occurred_at:Date}>("SELECT occurred_at FROM commission_ledger_entry WHERE order_id=$1 AND kind='release'",[changed.id])).rows[0]!.occurred_at;
  const [year,month]=sharingV2Period(releaseAt).split('-').map(Number);
  await assessSharingV2Performance(pool,25,new Date(Date.UTC(year!,month!+2,5)));
  expect((await service.mine(next.memberId)).officer?.state).toBe('active');
  expect(await assessSharingV2Performance(pool,25,new Date(Date.UTC(year!,month!+3,5)))).toBe(2);
  expect(await assessSharingV2Performance(pool,25,new Date(Date.UTC(year!,month!+3,5)))).toBe(0);
  expect(await service.mine(customer.memberId)).toMatchObject({relation:null,pendingReferrer:null});
  expect((await service.mine(next.memberId)).officer).toMatchObject({state:'terminated',reviewReason:'连续三个月有效推荐业绩为零'});
  expect((await service.orders(next.memberId,{id:changed.id})).items[0]).toMatchObject({availableCents:2640});
 }finally{config.sharingAgreementV2EffectiveOn=null;}
});

it('approves a pending V2.0 application using its original agreement and without a reference',async()=>{
 const applicant=await expectOk(app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'sharing-pending-old-agreement',displayName:'合成旧版申请',
  consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}}));
 await pay(await seedOrder(applicant,false,true));
 const application=await expectOk(command(applicant,'apply',{}));
 const {rows:[doc]}=await pool.query(`INSERT INTO sharing_v2_agreement_document(agreement_version,agreement_digest,effective_on,body_snapshot)
  SELECT 'V2.0',encode(digest(body,'sha256'),'hex'),'2026-11-27',body::json
  FROM (SELECT '{"version":"V2.0","effectiveOn":"2026-11-27","title":"Prior synthetic consent"}' AS body) fixture RETURNING agreement_digest`);
 await pool.query(`INSERT INTO sharing_v2_application(member_id,application_version,agreement_version,agreement_digest,effective_on,accepted_at)
  SELECT member_id,version,'V2.0',$2,'2026-11-27',updated_at FROM sharing_officer WHERE member_id=$1`,[applicant.memberId,doc.agreement_digest]);
 await pool.query('UPDATE sharing_officer SET v2_application_version=version WHERE member_id=$1',[applicant.memberId]);
 await expectOk(command(manager,'officer_state',{memberId:applicant.memberId,expectedVersion:application.version,state:'active'},true));
 expect(await service.mine(applicant.memberId)).toMatchObject({canShare:true,officer:{state:'active',agreementVersion:'V2.0'}});
 expect((await pool.query(`SELECT agreement_digest,verification_reference,sharing_v2_approval_at(member_id,application_version) AS approval
  FROM sharing_v2_application WHERE member_id=$1`,[applicant.memberId])).rows).toEqual([{agreement_digest:doc.agreement_digest,verification_reference:null,approval:expect.any(Date)}]);
});

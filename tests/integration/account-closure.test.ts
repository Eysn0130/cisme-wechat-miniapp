import { mkdtemp, chmod, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { createApp } from '../../services/api/src/server';
import { createApiGatewayStorage } from '../../services/api/src/storage';
import { AccountClosure, type Marker, type SuppressionRemote } from '../../services/api/src/accountClosure';

const pool=testPool();
let directory:string;
let app:Awaited<ReturnType<typeof createApp>>;
let remoteAvailable=true;
const remoteRows=new Map<string,Marker>();
const suppressionRemote:SuppressionRemote={
  async put(row){if(!remoteAvailable)throw new Error('REMOTE_UNAVAILABLE');const existing=remoteRows.get(row.memberId);
    if(existing&&JSON.stringify(existing)!==JSON.stringify(row))throw new Error('REMOTE_MARKER_CONFLICT');
    remoteRows.set(row.memberId,{...row});},
  async list(){if(!remoteAvailable)throw new Error('REMOTE_UNAVAILABLE');return [...remoteRows.values()].map(row=>({...row}));}
};
const appId='wx4eac2d4fb11d299b';
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'account-closure-test',
  UPLOAD_TOKEN_SECRET:'account-closure-upload',OBJECT_STORAGE_DRIVER:'api_gateway',
  WECHAT_APP_ID:appId,WECHAT_APP_SECRET:'controlled-wechat-secret',
  PRIVACY_SUPPRESSION_DIR:'/tmp/account-closure-test-placeholder'});
const consents=[{documentType:'terms',version:'test-v1'},{documentType:'privacy',version:'test-v1'}];
const identityFetcher=async(input:RequestInfo|URL)=>{
  const code=new URL(String(input)).searchParams.get('js_code');
  return new Response(JSON.stringify({openid:code?.startsWith('missing-')?'formal-shaped-missing-openid':
    code?.startsWith('hold-')?'formal-shaped-hold-openid':
    code?.startsWith('remote-')?'formal-shaped-remote-openid':'formal-shaped-closure-openid',
    unionid:'optional-unionid'}),{status:200});
};
const makeApp=()=>createApp({pool,config,storage:createApiGatewayStorage(config),wechatIdentityFetcher:identityFetcher,suppressionRemote});
beforeAll(async()=>{
  await resetDatabase(pool);
  directory=await mkdtemp(join(tmpdir(),'cisme-closure-'));
  await chmod(directory,0o700);
  config.privacy.suppressionDirectory=directory;
  app=await makeApp();
  for(const type of ['terms','privacy'])await pool.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active)
    VALUES($1,'test-v1','Test document','Isolated identity fixture','Fixture','小程序客服',true)`,[type]);
});

it('closes access while preserving a legally held profile until the hold is released',async()=>{
  const login=await app.inject({method:'POST',url:'/v1/identity/wechat',
    payload:{code:'hold-login',displayName:'Held name',consents}});
  expect(login.statusCode,login.body).toBe(200);
  const {memberId,sessionToken}=login.json() as {memberId:string;sessionToken:string};
  await pool.query("INSERT INTO member_profile(member_id,wechat_handle,handle_source) VALUES($1,'HeldHandle','self_reported')",[memberId]);
  const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
    VALUES('DISPUTE_EVIDENCE','Open customer dispute requires scoped retention','fixture',now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0].id;
  await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'member',$2)",[hold,memberId]);
  const result=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${sessionToken}`},
    payload:{kind:'close_account',message:'本人申请注销 CISME 账号'}});
  expect(result.statusCode,result.body).toBe(200);
  expect((await pool.query('SELECT status FROM member WHERE id=$1',[memberId])).rows[0].status).toBe('deleted');
  expect((await pool.query('SELECT wechat_handle FROM member_profile WHERE member_id=$1',[memberId])).rows[0].wechat_handle).toBe('HeldHandle');
  expect((await pool.query('SELECT resolution_code FROM privacy_request WHERE id=$1',[result.json().id])).rows[0].resolution_code)
    .toBe('SELF_ACCOUNT_CLOSED_WITH_LEGAL_HOLD');
  await pool.query("UPDATE legal_hold SET status='released',released_by='fixture',released_at=now() WHERE id=$1",[hold]);
  await app.close();
  app=await makeApp();
  expect((await pool.query('SELECT 1 FROM member_profile WHERE member_id=$1',[memberId])).rowCount).toBe(0);
  expect((await pool.query('SELECT display_name FROM member WHERE id=$1',[memberId])).rows[0].display_name).toBe('已注销用户');
});

it('keeps an identity closed when the restored database predates its registration',async()=>{
  const closure=new AccountClosure(directory);
  await closure.record(randomUUID(),AccountClosure.identityDigest('wechat_miniprogram',appId,'formal-shaped-missing-openid'),randomUUID());
  await app.close();
  app=await makeApp();
  const login=await app.inject({method:'POST',url:'/v1/identity/wechat',
    payload:{code:'missing-login',displayName:'Should not be created',consents}});
  expect(login.statusCode).toBe(410);
  expect((await pool.query("SELECT 1 FROM wechat_identity WHERE openid='formal-shaped-missing-openid'")).rowCount).toBe(0);
});

it('does not claim closure before the independent suppression marker is durable',async()=>{
  const login=await app.inject({method:'POST',url:'/v1/identity/wechat',
    payload:{code:'remote-login',displayName:'Remote failure case',consents}});
  expect(login.statusCode,login.body).toBe(200);
  const {memberId,sessionToken}=login.json() as {memberId:string;sessionToken:string};
  const headers={authorization:`Bearer ${sessionToken}`};
  remoteAvailable=false;
  try{
    const result=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers,
      payload:{kind:'close_account',message:'本人申请注销 CISME 账号'}});
    expect(result.statusCode).toBe(503);
    expect((await pool.query('SELECT status FROM member WHERE id=$1',[memberId])).rows[0].status).toBe('active');
    expect((await app.inject({url:'/v1/bootstrap/profile',headers})).statusCode).toBe(503);
  }finally{remoteAvailable=true;}
  expect((await app.inject({url:'/v1/bootstrap/profile',headers})).statusCode).toBe(401);
  expect((await pool.query('SELECT status FROM member WHERE id=$1',[memberId])).rows[0].status).toBe('deleted');
  expect(remoteRows.has(memberId)).toBe(true);
});
afterAll(async()=>{await app?.close();await pool.end();if(directory)await rm(directory,{recursive:true,force:true});});

it('closes a self-verified account, retains transaction facts, and suppresses old backup identity',async()=>{
  const login=await app.inject({method:'POST',url:'/v1/identity/wechat',payload:{code:'formal-shaped-code',displayName:'Private name',consents}});
  expect(login.statusCode,login.body).toBe(200);
  const {memberId,sessionToken}=login.json() as {memberId:string;sessionToken:string};
  const headers={authorization:`Bearer ${sessionToken}`};
  await pool.query(`INSERT INTO member_contact(member_id,phone_encrypted,phone_hmac,phone_masked,key_version)
    VALUES($1,'secret-phone',$2,'138****0000','test')`,[memberId,'f'.repeat(64)]);
  await pool.query("INSERT INTO member_profile(member_id,wechat_handle,handle_source) VALUES($1,'PrivateHandle','self_reported')",[memberId]);
  const addressId=randomUUID();
  await pool.query(`INSERT INTO member_delivery_address(id,member_id,encrypted_payload,payload_hmac,key_version,label,client_request_key)
    VALUES($1,$2,'secret-address',$3,'test','home','closure-address')`,[addressId,memberId,'a'.repeat(64)]);
  const product=(await pool.query(`INSERT INTO catalog_product(code,name,source_kind,qualification_status,publication_status,created_by,updated_by,published_at)
    VALUES('closure-product','Fixture','admin','eligible','published','fixture','fixture',now()) RETURNING id`)).rows[0].id;
  const sku=(await pool.query(`INSERT INTO catalog_sku(product_id,code,label,created_by,updated_by)
    VALUES($1,'CLOSURE_SKU','Fixture','fixture','fixture') RETURNING id`,[product])).rows[0].id;
  const quote=(await pool.query(`INSERT INTO commerce_checkout_quote(member_id,product_id,sku_id,address_id,address_version,quantity,currency,unit_price_cents,
    subtotal_cents,member_discount_cents,shipping_cents,total_cents,pricing_rule_version,product_version,sku_version,price_version,status,
    idempotency_key,request_hash,expires_at,consumed_at)
    VALUES($1,$2,$3,$4,1,1,'CNY',10000,10000,0,0,10000,'fixture-r1',1,1,1,'consumed','closure-quote-key',$5,now()+interval '1 day',now()) RETURNING id`,
    [memberId,product,sku,addressId,'b'.repeat(64)])).rows[0].id;
  const order=(await pool.query(`INSERT INTO commerce_order(order_number,member_id,source_quote_id,status,currency,subtotal_cents,member_discount_cents,
    shipping_cents,total_cents,pricing_rule_version,expires_at,cancelled_at,terminal_reason,transaction_source_kind)
    VALUES('CM20260923000000000001',$1,$2,'cancelled','CNY',10000,0,0,10000,'fixture-r1',now()+interval '1 day',now(),
    'Prior canceled transaction','verified_commerce') RETURNING id`,[memberId,quote])).rows[0].id;
  await pool.query(`INSERT INTO commercial_membership(member_id,state,effective_at,expires_at,changed_by,change_reason)
    VALUES($1,'active',now()-interval '1 day',now()+interval '1 year','fixture','Fixture membership')`,[memberId]);

  const result=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers,
    payload:{kind:'close_account',message:'本人申请注销 CISME 账号'}});
  expect(result.statusCode,result.body).toBe(200);
  expect(result.json()).toMatchObject({kind:'close_account',status:'completed',accountClosed:true});
  const requestId=result.json().id as string;
  expect((await app.inject({url:'/v1/me/privacy-requests',headers})).statusCode).toBe(401);
  expect((await app.inject({url:'/v1/bootstrap/profile',headers})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/v1/identity/wechat',payload:{code:'repeat-code',displayName:'New name',consents}})).statusCode).toBe(410);
  const member=(await pool.query('SELECT status,display_name FROM member WHERE id=$1',[memberId])).rows[0];
  expect(member).toMatchObject({status:'deleted',display_name:'已注销用户'});
  expect((await pool.query('SELECT 1 FROM member_contact WHERE member_id=$1',[memberId])).rowCount).toBe(0);
  expect((await pool.query('SELECT 1 FROM member_profile WHERE member_id=$1',[memberId])).rowCount).toBe(0);
  expect((await pool.query('SELECT encrypted_payload,key_version,deleted_at FROM member_delivery_address WHERE id=$1',[addressId])).rows[0])
    .toMatchObject({encrypted_payload:'',key_version:'erased',deleted_at:expect.any(Date)});
  expect((await pool.query('SELECT id FROM commerce_order WHERE id=$1',[order])).rowCount).toBe(1);
  expect((await pool.query('SELECT state FROM commercial_membership WHERE member_id=$1',[memberId])).rows[0].state).toBe('expired');
  expect((await pool.query('SELECT resolution_code FROM privacy_request WHERE id=$1',[requestId])).rows[0].resolution_code).toBe('SELF_ACCOUNT_CLOSED');

  const rights=await app.inject({method:'POST',url:'/v1/identity/wechat/privacy-rights',payload:{code:'fresh-rights-code'}});
  expect(rights.statusCode,rights.body).toBe(200);
  const rightsHeaders={authorization:`Bearer ${rights.json().sessionToken}`};
  expect((await app.inject({url:'/v1/me/privacy-requests',headers:rightsHeaders})).json()).toEqual(
    expect.arrayContaining([expect.objectContaining({id:requestId,status:'completed'})]));
  expect((await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:rightsHeaders,
    payload:{kind:'close_account',message:'again'}})).statusCode).toBe(409);

  // Simulate restoring a database snapshot made before account closure. The
  // independent marker must close and scrub the restored identity at startup.
  await pool.query("UPDATE member SET status='active',display_name='Restored private name' WHERE id=$1",[memberId]);
  await pool.query(`INSERT INTO member_contact(member_id,phone_encrypted,phone_hmac,phone_masked,key_version)
    VALUES($1,'restored-phone',$2,'139****0000','test')`,[memberId,'e'.repeat(64)]);
  await pool.query("UPDATE member_delivery_address SET encrypted_payload='restored-address',key_version='test',deleted_at=NULL WHERE id=$1",[addressId]);
  expect((await app.inject({method:'POST',url:'/v1/identity/wechat',payload:{code:'restored-login',displayName:'Restored',consents}})).statusCode).toBe(410);
  expect((await app.inject({url:'/v1/bootstrap/profile',headers})).statusCode).toBe(401);
  await app.close();
  await rm(directory,{recursive:true,force:true});
  await mkdir(directory,{mode:0o700});
  app=await makeApp();
  expect((await pool.query('SELECT status,display_name FROM member WHERE id=$1',[memberId])).rows[0]).toMatchObject({status:'deleted',display_name:'已注销用户'});
  expect((await pool.query('SELECT 1 FROM member_contact WHERE member_id=$1',[memberId])).rowCount).toBe(0);
  expect((await pool.query('SELECT encrypted_payload,key_version FROM member_delivery_address WHERE id=$1',[addressId])).rows[0])
    .toMatchObject({encrypted_payload:'',key_version:'erased'});
  expect((await pool.query('SELECT id FROM commerce_order WHERE id=$1',[order])).rowCount).toBe(1);
  await chmod(directory,0o755);
  try{
    expect((await app.inject({url:'/health/ready'})).statusCode).toBe(500);
    expect((await app.inject({url:'/v1/bootstrap/profile',headers})).statusCode).toBe(500);
  }finally{await chmod(directory,0o700);}
});

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
import { FormalPrivacyExecution } from '../../services/api/src/formalPrivacyExecution';

const pool=testPool();
let directory:string;
let app:Awaited<ReturnType<typeof createApp>>;
let remoteAvailable=true;
const remoteRows=new Map<string,Marker>();
const markerKey=(row:Marker)=>row.version===1?row.memberId:`${row.memberId}.profile.${row.requestId}`;
const suppressionRemote:SuppressionRemote={
  async put(row){if(!remoteAvailable)throw new Error('REMOTE_UNAVAILABLE');const existing=remoteRows.get(markerKey(row));
    if(existing&&JSON.stringify(existing)!==JSON.stringify(row))throw new Error('REMOTE_MARKER_CONFLICT');
    remoteRows.set(markerKey(row),{...row});},
  async list(){if(!remoteAvailable)throw new Error('REMOTE_UNAVAILABLE');return [...remoteRows.values()].map(row=>({...row}));}
};
const appId='wx4eac2d4fb11d299b';
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'account-closure-test',
  UPLOAD_TOKEN_SECRET:'account-closure-upload',OBJECT_STORAGE_DRIVER:'api_gateway',
  WECHAT_APP_ID:appId,WECHAT_APP_SECRET:'controlled-wechat-secret',
  PRIVACY_FORMAL_EXPORT_KEY:'9'.repeat(64),
  CONTACT_ENCRYPTION_KEY:'8'.repeat(64),CONTACT_HASH_KEY:'7'.repeat(64),
  PRIVACY_SUPPRESSION_DIR:'/tmp/account-closure-test-placeholder'});
const consents=[{documentType:'terms',version:'test-v1'},{documentType:'privacy',version:'test-v1'}];
const identityFetcher=async(input:RequestInfo|URL)=>{
  const code=new URL(String(input)).searchParams.get('js_code');
  return new Response(JSON.stringify({openid:code?.startsWith('missing-')?'formal-shaped-missing-openid':
    code?.startsWith('hold-')?'formal-shaped-hold-openid':
    code?.startsWith('concurrent-')?'formal-shaped-concurrent-openid':
    code?.startsWith('remote-')?'formal-shaped-remote-openid':
    code?.startsWith('profile-held-')?'formal-shaped-profile-held-openid':
    code?.startsWith('profile-')?'formal-shaped-profile-openid':'formal-shaped-closure-openid',
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
  const replayer=new AccountClosure(directory,suppressionRemote);
  expect(await replayer.replayPendingErasure(pool)).toBe(0);
  await pool.query("UPDATE legal_hold SET status='released',released_by='fixture',released_at=now() WHERE id=$1",[hold]);
  expect(await replayer.replayPendingErasure(pool)).toBe(1);
  expect((await pool.query('SELECT 1 FROM member_profile WHERE member_id=$1',[memberId])).rowCount).toBe(0);
  await app.close();
  app=await makeApp();
  expect((await pool.query('SELECT 1 FROM member_profile WHERE member_id=$1',[memberId])).rowCount).toBe(0);
  expect((await pool.query('SELECT display_name FROM member WHERE id=$1',[memberId])).rows[0].display_name).toBe('已注销用户');
});

it('honors a legal hold committed while closure is waiting for the hold decision',async()=>{
  const login=await app.inject({method:'POST',url:'/v1/identity/wechat',
    payload:{code:'concurrent-login',displayName:'Pending hold',consents}});
  expect(login.statusCode,login.body).toBe(200);
  const {memberId,sessionToken}=login.json() as {memberId:string;sessionToken:string};
  await pool.query("INSERT INTO member_profile(member_id,wechat_handle,handle_source) VALUES($1,'HeldDuringClosure','self_reported')",[memberId]);
  const blocker=await pool.connect();
  let pending:Promise<{statusCode:number;body:string}>|undefined;
  let blocked=false;
  try{
    await blocker.query('BEGIN');
    const blockerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const hold=(await blocker.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
      VALUES('PENDING_DISPUTE','Unresolved dispute evidence','fixture',now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0].id;
    await blocker.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'member',$2)",[hold,memberId]);
    pending=app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${sessionToken}`},
      payload:{kind:'close_account',message:'本人申请注销 CISME 账号'}});
    for(let attempt=0;attempt<100;attempt++){
      const waiting=await pool.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE pg_blocking_pids(pid) @> ARRAY[$1::int]) AS blocked`,[blockerPid]);
      if(waiting.rows[0]?.blocked){blocked=true;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await blocker.query('COMMIT');
    const result=await pending!;
    expect(blocked).toBe(true);
    expect(result.statusCode,result.body).toBe(200);
    expect((await pool.query('SELECT status FROM member WHERE id=$1',[memberId])).rows[0].status).toBe('deleted');
    expect((await pool.query('SELECT wechat_handle FROM member_profile WHERE member_id=$1',[memberId])).rows[0].wechat_handle)
      .toBe('HeldDuringClosure');
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
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

it('deletes optional live data for a verified member and suppresses it after restoring an older backup',async()=>{
  const login=await app.inject({method:'POST',url:'/v1/identity/wechat',
    payload:{code:'profile-login',displayName:'Original private name',consents}});
  expect(login.statusCode,login.body).toBe(200);
  const {memberId,sessionToken}=login.json() as {memberId:string;sessionToken:string};
  const headers={authorization:`Bearer ${sessionToken}`};
  await pool.query("INSERT INTO member_profile(member_id,wechat_handle,handle_source) VALUES($1,'PrivateHandle','self_reported')",[memberId]);
  const copyRequest=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers,
    payload:{kind:'access',message:'删除前获取资料副本'}});
  expect(copyRequest.statusCode,copyRequest.body).toBe(200);
  expect(await new FormalPrivacyExecution(pool,config,createApiGatewayStorage(config)).runExportOnce()).toBe(true);
  expect((await app.inject({url:`/v1/me/privacy-requests/${copyRequest.json().id}/export`,headers})).statusCode).toBe(200);
  await pool.query(`INSERT INTO member_contact(member_id,phone_encrypted,phone_hmac,phone_masked,key_version)
    VALUES($1,'private-phone',$2,'***1234','test')`,[memberId,'a'.repeat(64)]);
  const addressId=randomUUID();
  await pool.query(`INSERT INTO member_delivery_address(id,member_id,encrypted_payload,payload_hmac,key_version,label,client_request_key)
    VALUES($1,$2,'private-address',$3,'test','home','profile-erasure-address')`,[addressId,memberId,'b'.repeat(64)]);
  const deleted=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers,
    payload:{kind:'delete',scopeCode:'member_optional_profile_v1',message:'删除可清除的账户资料'}});
  expect(deleted.statusCode,deleted.body).toBe(200);
  expect(deleted.json()).toMatchObject({kind:'delete',status:'completed',scopeCode:'member_optional_profile_v1'});
  expect((await pool.query('SELECT status,display_name FROM member WHERE id=$1',[memberId])).rows[0])
    .toMatchObject({status:'active',display_name:'用户'});
  expect((await pool.query('SELECT 1 FROM member_contact WHERE member_id=$1',[memberId])).rowCount).toBe(0);
  expect((await pool.query('SELECT 1 FROM member_profile WHERE member_id=$1',[memberId])).rowCount).toBe(0);
  expect((await pool.query('SELECT key_version FROM member_delivery_address WHERE id=$1',[addressId])).rows[0].key_version).toBe('erased');
  expect((await app.inject({url:`/v1/me/privacy-requests/${copyRequest.json().id}/export`,headers})).statusCode).toBe(404);
  expect((await app.inject({url:'/v1/bootstrap/profile',headers})).statusCode).toBe(200);
  const marker=[...remoteRows.values()].find(row=>row.memberId===memberId&&row.version===2);
  expect(marker?.version).toBe(2);
  const prior=new Date(Date.parse(marker!.createdAt)-60_000);
  await pool.query("UPDATE member SET display_name='Original private name' WHERE id=$1",[memberId]);
  await pool.query(`INSERT INTO member_contact(member_id,phone_encrypted,phone_hmac,phone_masked,key_version,bound_at)
    VALUES($1,'restored-phone',$2,'***9999','test',$3)`,[memberId,'c'.repeat(64),prior]);
  await pool.query(`INSERT INTO member_profile(member_id,wechat_handle,handle_source,updated_at)
    VALUES($1,'RestoredHandle','self_reported',$2)`,[memberId,prior]);
  await pool.query(`UPDATE member_delivery_address SET encrypted_payload='restored-address',key_version='test',
    deleted_at=NULL,updated_at=$2 WHERE id=$1`,[addressId,prior]);
  const replayer=new AccountClosure(directory,suppressionRemote);
  expect(await replayer.replayPendingErasure(pool)).toBe(1);
  expect((await pool.query('SELECT display_name FROM member WHERE id=$1',[memberId])).rows[0].display_name).toBe('用户');
  expect((await pool.query('SELECT 1 FROM member_contact WHERE member_id=$1',[memberId])).rowCount).toBe(0);
  expect((await pool.query('SELECT 1 FROM member_profile WHERE member_id=$1',[memberId])).rowCount).toBe(0);
  expect((await pool.query('SELECT key_version FROM member_delivery_address WHERE id=$1',[addressId])).rows[0].key_version).toBe('erased');
  await pool.query("INSERT INTO member_profile(member_id,wechat_handle,handle_source) VALUES($1,'NewHandle','self_reported')",[memberId]);
  expect(await replayer.replayPendingErasure(pool)).toBe(0);
  expect((await pool.query('SELECT wechat_handle FROM member_profile WHERE member_id=$1',[memberId])).rows[0].wechat_handle).toBe('NewHandle');
});

it('keeps profile deletion pending during an active legal hold, then completes it without a new request',async()=>{
  const login=await app.inject({method:'POST',url:'/v1/identity/wechat',
    payload:{code:'profile-held-login',displayName:'Held optional name',consents}});
  expect(login.statusCode,login.body).toBe(200);
  const {memberId,sessionToken}=login.json() as {memberId:string;sessionToken:string};
  await pool.query("INSERT INTO member_profile(member_id,wechat_handle,handle_source) VALUES($1,'HeldOptional','self_reported')",[memberId]);
  const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
    VALUES('PROFILE_EVIDENCE','Scoped unresolved dispute','fixture',now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0].id;
  await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'member',$2)",[hold,memberId]);
  const result=await app.inject({method:'POST',url:'/v1/me/privacy-requests',
    headers:{authorization:`Bearer ${sessionToken}`},
    payload:{kind:'delete',scopeCode:'member_optional_profile_v1',message:'删除可清除的账户资料'}});
  expect(result.statusCode,result.body).toBe(200);
  expect(result.json()).toMatchObject({status:'executing',legalHold:true});
  expect((await pool.query('SELECT wechat_handle FROM member_profile WHERE member_id=$1',[memberId])).rows[0].wechat_handle).toBe('HeldOptional');
  const replayer=new AccountClosure(directory,suppressionRemote);
  expect(await replayer.replayPendingErasure(pool)).toBe(0);
  await pool.query("UPDATE legal_hold SET status='released',released_by='fixture',released_at=now() WHERE id=$1",[hold]);
  expect(await replayer.replayPendingErasure(pool)).toBe(1);
  expect((await pool.query('SELECT 1 FROM member_profile WHERE member_id=$1',[memberId])).rowCount).toBe(0);
  expect((await pool.query('SELECT status FROM privacy_request WHERE id=$1',[result.json().id])).rows[0].status).toBe('completed');
});

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { createApp } from '../../services/api/src/server';
import { createApiGatewayStorage } from '../../services/api/src/storage';
import { FormalPrivacyExecution } from '../../services/api/src/formalPrivacyExecution';
import { AccountClosure, applyAccountClosure, applyProfileErasure, type ProfileErasureMarker } from '../../services/api/src/accountClosure';
import { PrivacyRights } from '../../services/api/src/privacyRights';
import { MemberProfile } from '../../services/api/src/memberProfile';
import { transaction } from '../../services/api/src/db';
import { DeliveryAddressService } from '../../services/api/src/deliveryAddress';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,
  APP_SESSION_SECRET:'formal-privacy-export-fixture',UPLOAD_TOKEN_SECRET:'formal-privacy-storage',
  OBJECT_STORAGE_DRIVER:'api_gateway',PRIVACY_FORMAL_EXPORT_KEY:'9'.repeat(64),
  CONTACT_ENCRYPTION_KEY:'8'.repeat(64),CONTACT_HASH_KEY:'7'.repeat(64),
  WECHAT_APP_ID:'wx4eac2d4fb11d299b',WECHAT_APP_SECRET:'controlled-fixture'});
const storage=createApiGatewayStorage(config);
const app=await createApp({pool,config,storage,wechatIdentityFetcher:async(input:RequestInfo|URL)=>{
  const code=new URL(String(input)).searchParams.get('js_code');
  return new Response(JSON.stringify({openid:`formal-export-${code}`}),{status:200});
}});
const consents=[{documentType:'terms',version:'fixture'},{documentType:'privacy',version:'fixture'}];
async function login(code:string){
  const response=await app.inject({method:'POST',url:'/v1/identity/wechat',
    payload:{code,displayName:`Member ${code}`,consents}});
  expect(response.statusCode,response.body).toBe(200);
  return response.json() as {memberId:string;sessionToken:string};
}

beforeAll(async()=>{
  await resetDatabase(pool);
  for(const type of ['terms','privacy'])await pool.query(`INSERT INTO legal_document
    (document_type,version,title,body,operator_name,contact,active)
    VALUES($1,'fixture','Fixture','Controlled formal identity','Fixture','小程序客服',true)`,[type]);
});
afterAll(async()=>{await app.close();await pool.end();});

it('lets a verified WeChat member export their own data without a second administrator',async()=>{
  const owner=await login('owner'),other=await login('other');
  await pool.query(`INSERT INTO member_profile(member_id,wechat_handle,handle_source)
    VALUES($1,'OwnerHandle','self_reported'),($2,'OtherHandle','self_reported')`,
    [owner.memberId,other.memberId]);
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(config.contacts.encryptionKey!,'hex'),iv);
  cipher.setAAD(Buffer.from(owner.memberId));
  const encrypted=Buffer.concat([cipher.update('+8613800001234','utf8'),cipher.final()]);
  await pool.query(`INSERT INTO member_contact(member_id,phone_encrypted,phone_hmac,phone_masked,key_version)
    VALUES($1,$2,$3,'***1234',$4)`,[owner.memberId,
      Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64'),'a'.repeat(64),config.contacts.keyVersion]);
  await new DeliveryAddressService(pool,config).create(owner.memberId,'formal-address-1',{
    recipientName:'自有收货人',phone:'13800001234',province:'上海市',city:'上海市',district:'浦东新区',
    detail:'测试路 1 号',label:'home',isDefault:true});
  const response=await app.inject({method:'POST',url:'/v1/me/privacy-requests',
    headers:{authorization:`Bearer ${owner.sessionToken}`},
    payload:{kind:'access',message:'导出我的个人资料'}});
  expect(response.statusCode,response.body).toBe(200);
  const requestId=response.json().id as string;
  expect(response.json().status).toBe('approved');
  const job=(await pool.query(`SELECT execution_mode,status,requested_by,approved_by,scope
    FROM data_export_job WHERE privacy_request_id=$1`,[requestId])).rows[0];
  expect(job).toMatchObject({execution_mode:'generate_archive',status:'approved',
    requested_by:`member:${owner.memberId}`,approved_by:'system:verified-self'});
  expect(job.scope.formalSelfService).toBe(true);
  const executor=new FormalPrivacyExecution(pool,config,storage);
  expect(await executor.runExportOnce()).toBe(true);
  const list=await app.inject({url:'/v1/me/privacy-requests',
    headers:{authorization:`Bearer ${owner.sessionToken}`}});
  expect(list.statusCode,list.body).toBe(200);
  expect(list.json()[0]).toMatchObject({id:requestId,status:'completed',
    execution:{scope:'member_portable_copy_v1',downloadAvailable:true}});
  const denied=await app.inject({url:`/v1/me/privacy-requests/${requestId}/export`,
    headers:{authorization:`Bearer ${other.sessionToken}`}});
  expect(denied.statusCode).toBe(404);
  const downloaded=await app.inject({url:`/v1/me/privacy-requests/${requestId}/export`,
    headers:{authorization:`Bearer ${owner.sessionToken}`}});
  expect(downloaded.statusCode,downloaded.body).toBe(200);
  expect(downloaded.headers['cache-control']).toBe('private, no-store');
  const copy=downloaded.json();
  expect(copy.schema).toBe('cisme.member.portable.v1');
  expect(copy.sections.account.profile.wechat_handle).toBe('OwnerHandle');
  expect(copy.sections.account.phone).toBe('+8613800001234');
  expect(copy.sections.account.addresses[0].address.detail).toBe('测试路 1 号');
  expect(JSON.stringify(copy)).not.toContain('OtherHandle');
  expect(JSON.stringify(copy)).not.toContain('phone_encrypted');
  const revoked=await app.inject({method:'POST',url:`/v1/me/privacy-requests/${requestId}/export-revoke`,
    headers:{authorization:`Bearer ${owner.sessionToken}`}});
  expect(revoked.statusCode,revoked.body).toBe(200);
  expect((await app.inject({url:`/v1/me/privacy-requests/${requestId}/export`,
    headers:{authorization:`Bearer ${owner.sessionToken}`}})).statusCode).toBe(404);
});

it('keeps a failed formal export tied to its request and lets its owner retry',async()=>{
  const owner=await login('retry-owner'),other=await login('retry-other');
  const created=await app.inject({method:'POST',url:'/v1/me/privacy-requests',
    headers:{authorization:`Bearer ${owner.sessionToken}`},
    payload:{kind:'access',message:'请给我一份可携带的数据'}});
  expect(created.statusCode,created.body).toBe(200);
  const requestId=created.json().id as string;
  const executor=new FormalPrivacyExecution(pool,config,storage);
  for(let i=0;i<3;i++){
    expect(await executor.runExportOnce(()=>{throw new Error('CONTROLLED_EXPORT_FAILURE');})).toBe(true);
    await pool.query("UPDATE data_export_job SET next_attempt_at=now() WHERE privacy_request_id=$1",[requestId]);
  }
  expect((await pool.query('SELECT status FROM privacy_request WHERE id=$1',[requestId])).rows[0].status).toBe('failed');
  const denied=await app.inject({method:'POST',url:`/v1/me/privacy-requests/${requestId}/export-retry`,
    headers:{authorization:`Bearer ${other.sessionToken}`}});
  expect(denied.statusCode).toBe(404);
  const retried=await app.inject({method:'POST',url:`/v1/me/privacy-requests/${requestId}/export-retry`,
    headers:{authorization:`Bearer ${owner.sessionToken}`}});
  expect(retried.statusCode,retried.body).toBe(200);
  expect(await executor.runExportOnce()).toBe(true);
  expect((await pool.query('SELECT status FROM privacy_request WHERE id=$1',[requestId])).rows[0].status).toBe('completed');
  expect((await pool.query('SELECT count(*)::int AS count FROM data_export_job WHERE privacy_request_id=$1',
    [requestId])).rows[0].count).toBe(1);
});

it('delivers readable data while naming video and missing images as incomplete',async()=>{
  const owner=await login('partial-media-owner');
  const mediaIds=[];
  for(const [kind,mime] of [['video','video/mp4'],['image','image/png']] as const){
    const row=(await pool.query(`INSERT INTO ugc_media_asset(owner_member_id,kind,object_key,mime_type,size_bytes,
      state,authorization_expires_at,uploaded_at)
      VALUES($1,$2,gen_random_uuid()::text,$3,1024,'uploaded',now()+interval '1 day',now()) RETURNING id`,
      [owner.memberId,kind,mime])).rows[0];
    mediaIds.push(row.id);
  }
  const created=await app.inject({method:'POST',url:'/v1/me/privacy-requests',
    headers:{authorization:`Bearer ${owner.sessionToken}`},
    payload:{kind:'access',message:'获取我的数据副本和素材'}});
  expect(created.statusCode,created.body).toBe(200);
  const requestId=created.json().id as string;
  expect(await new FormalPrivacyExecution(pool,config,storage).runExportOnce()).toBe(true);
  const request=(await pool.query('SELECT status,resolution_code FROM privacy_request WHERE id=$1',[requestId])).rows[0];
  expect(request).toMatchObject({status:'partially_completed',resolution_code:'FORMAL_DATA_COPY_MEDIA_PENDING'});
  const downloaded=await app.inject({url:`/v1/me/privacy-requests/${requestId}/export`,
    headers:{authorization:`Bearer ${owner.sessionToken}`}});
  expect(downloaded.statusCode,downloaded.body).toBe(200);
  expect(downloaded.json().unavailableMedia).toEqual(expect.arrayContaining([
    expect.objectContaining({id:mediaIds[0],reason:'video_requires_separate_copy'}),
    expect.objectContaining({id:mediaIds[1],reason:'stored_copy_unavailable'})]));
});

it('recovers a stale third attempt as a failed request that its owner can retry',async()=>{
  const owner=await login('stale-owner');
  const created=await app.inject({method:'POST',url:'/v1/me/privacy-requests',
    headers:{authorization:`Bearer ${owner.sessionToken}`},
    payload:{kind:'access',message:'获取中断后的副本'}});
  expect(created.statusCode,created.body).toBe(200);
  const requestId=created.json().id as string;
  await pool.query("UPDATE privacy_request SET status='executing' WHERE id=$1",[requestId]);
  await pool.query(`UPDATE data_export_job SET status='running',attempts=3,
    next_attempt_at=now()-interval '1 second' WHERE privacy_request_id=$1`,[requestId]);
  const executor=new FormalPrivacyExecution(pool,config,storage);
  expect(await executor.runExportOnce()).toBe(true);
  expect((await pool.query('SELECT status FROM privacy_request WHERE id=$1',[requestId])).rows[0].status).toBe('failed');
  const retried=await app.inject({method:'POST',url:`/v1/me/privacy-requests/${requestId}/export-retry`,
    headers:{authorization:`Bearer ${owner.sessionToken}`}});
  expect(retried.statusCode,retried.body).toBe(200);
  expect(await executor.runExportOnce()).toBe(true);
  expect((await pool.query('SELECT status FROM privacy_request WHERE id=$1',[requestId])).rows[0].status).toBe('completed');
});

it('runs the verified self export in production mode with controlled WeChat identity and isolated storage',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cisme-formal-production-'));
  const productionConfig={...config,env:'production' as const,allowDevAdapters:false,
    privacy:{...config.privacy,suppressionDirectory:directory}};
  const fetchSpy=vi.spyOn(globalThis,'fetch').mockImplementation(async(input:RequestInfo|URL)=>
    new Response(JSON.stringify({openid:`formal-production-${new URL(String(input)).searchParams.get('js_code')}`}),{status:200}));
  const productionApp=await createApp({pool,config:productionConfig,
    storage:createApiGatewayStorage(productionConfig),
    suppressionRemote:{put:async()=>{},list:async()=>[]}});
  try{
    const login=await productionApp.inject({method:'POST',url:'/v1/identity/wechat',
      payload:{code:'self-export',displayName:'Production mode fixture',consents}});
    expect(login.statusCode,login.body).toBe(200);
    const {memberId,sessionToken}=login.json() as {memberId:string;sessionToken:string};
    const created=await productionApp.inject({method:'POST',url:'/v1/me/privacy-requests',
      headers:{authorization:`Bearer ${sessionToken}`},
      payload:{kind:'access',message:'获取个人信息副本'}});
    expect(created.statusCode,created.body).toBe(200);
    expect(await new FormalPrivacyExecution(pool,productionConfig,
      createApiGatewayStorage(productionConfig)).runExportOnce()).toBe(true);
    const copy=await productionApp.inject({url:`/v1/me/privacy-requests/${created.json().id}/export`,
      headers:{authorization:`Bearer ${sessionToken}`}});
    expect(copy.statusCode,copy.body).toBe(200);
    expect(copy.json().sections.account.id).toBe(memberId);
    const erased=await productionApp.inject({method:'POST',url:'/v1/me/privacy-requests',
      headers:{authorization:`Bearer ${sessionToken}`},
      payload:{kind:'delete',scopeCode:'member_optional_profile_v1',message:'删除可清除的账户资料'}});
    expect(erased.statusCode,erased.body).toBe(200);
    expect(erased.json()).toMatchObject({kind:'delete',status:'completed'});
    expect((await pool.query('SELECT status,display_name FROM member WHERE id=$1',[memberId])).rows[0])
      .toMatchObject({status:'active',display_name:'用户'});
    expect((await productionApp.inject({url:`/v1/me/privacy-requests/${created.json().id}/export`,
      headers:{authorization:`Bearer ${sessionToken}`}})).statusCode).toBe(404);
    const closed=await productionApp.inject({method:'POST',url:'/v1/me/privacy-requests',
      headers:{authorization:`Bearer ${sessionToken}`},
      payload:{kind:'close_account',message:'本人申请注销 CISME 账号'}});
    expect(closed.statusCode,closed.body).toBe(200);
    expect(closed.json().accountClosed).toBe(true);
    expect((await productionApp.inject({url:'/v1/bootstrap/profile',
      headers:{authorization:`Bearer ${sessionToken}`}})).statusCode).toBe(401);
  }finally{fetchSpy.mockRestore();await productionApp.close();await rm(directory,{recursive:true,force:true});}
});

it('rejects a pre-erasure snapshot when an older held deletion executes during materialization',async()=>{
  const owner=await login('held-export-race');
  await pool.query("INSERT INTO member_profile(member_id,wechat_handle,handle_source) VALUES($1,'BeforeHeldErasure','self_reported')",[owner.memberId]);
  const marker=await profileMarker(owner.memberId);
  const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
    VALUES('EXPORT_RACE_HOLD','Controlled isolation test','fixture',now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0].id;
  await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'member',$2)",[hold,owner.memberId]);
  expect((await transaction(pool,c=>applyProfileErasure(c,marker))).status).toBe('executing');
  const requestId=await exportRequest(owner);
  const executor=new FormalPrivacyExecution(pool,config,storage);
  // Request creation predates the snapshot. Only its later execution matters.
  expect(await executor.runExportOnce(async()=>{
    await pool.query("UPDATE legal_hold SET status='released',released_by='fixture',released_at=now() WHERE id=$1",[hold]);
    expect((await transaction(pool,c=>applyProfileErasure(c,marker))).status).toBe('completed');
  })).toBe(true);
  expect((await pool.query('SELECT count(*)::int AS count FROM privacy_export_artifact a JOIN data_export_job j ON j.id=a.job_id WHERE j.privacy_request_id=$1',[requestId])).rows[0].count).toBe(0);
  expect((await pool.query('SELECT last_error_code FROM data_export_job WHERE privacy_request_id=$1',[requestId])).rows[0].last_error_code).toBe('PRIVACY_EXECUTION_AUTHORITY_CHANGED');
  await pool.query('UPDATE data_export_job SET next_attempt_at=now() WHERE privacy_request_id=$1',[requestId]);
  expect(await executor.runExportOnce()).toBe(true);
  const copy=await executor.download(owner.memberId,requestId);
  expect(copy.toString()).not.toContain('BeforeHeldErasure');
  expect(JSON.parse(copy.toString()).sections.account.profile).toBeNull();
});

it('does not revoke a fresh post-erasure export on an unchanged marker replay',async()=>{
  const owner=await login('post-erasure-copy');
  const marker=await profileMarker(owner.memberId);
  expect((await transaction(pool,c=>applyProfileErasure(c,marker))).status).toBe('completed');
  const first=(await pool.query('SELECT status,version,resolution_code,completed_at FROM privacy_request WHERE id=$1',[marker.requestId])).rows[0];
  expect(first.status).toBe('completed');
  expect(first.resolution_code).toBe('SELF_PROFILE_ERASED');
  expect(first.completed_at).not.toBeNull();
  const requestId=await exportRequest(owner);
  const executor=new FormalPrivacyExecution(pool,config,storage);
  expect(await executor.runExportOnce()).toBe(true);
  await transaction(pool,c=>applyProfileErasure(c,marker));
  expect(JSON.parse((await executor.download(owner.memberId,requestId)).toString()).sections.account.id).toBe(owner.memberId);
  expect((await pool.query('SELECT version FROM privacy_request WHERE id=$1',[marker.requestId])).rows[0].version).toBe(first.version);
  expect((await pool.query("SELECT count(*)::int AS count FROM privacy_request_event WHERE privacy_request_id=$1 AND event_type='execution_succeeded'",[marker.requestId])).rows[0].count).toBe(1);
});

it('invalidates an in-flight copy when restored data is removed by an already completed erasure',async()=>{
  const owner=await login('restored-export-race');
  const marker=await profileMarker(owner.memberId);
  await transaction(pool,c=>applyProfileErasure(c,marker));
  // Simulate restored data only in this disposable database.
  await pool.query(`INSERT INTO member_profile(member_id,wechat_handle,handle_source,updated_at)
    VALUES($1,'RestoredOldProfile','self_reported',$2)`,[owner.memberId,marker.createdAt]);
  const requestId=await exportRequest(owner);
  expect(await new FormalPrivacyExecution(pool,config,storage).runExportOnce(async()=>{
    await transaction(pool,c=>applyProfileErasure(c,marker));
  })).toBe(true);
  expect((await pool.query('SELECT last_error_code FROM data_export_job WHERE privacy_request_id=$1',[requestId])).rows[0].last_error_code).toBe('PRIVACY_EXECUTION_AUTHORITY_CHANGED');
  expect((await pool.query('SELECT count(*)::int AS count FROM privacy_export_artifact a JOIN data_export_job j ON j.id=a.job_id WHERE j.privacy_request_id=$1',[requestId])).rows[0].count).toBe(0);
  await pool.query('UPDATE data_export_job SET next_attempt_at=now() WHERE privacy_request_id=$1',[requestId]);
  expect(await new FormalPrivacyExecution(pool,config,storage).runExportOnce()).toBe(true);
});

async function profileMarker(memberId:string):Promise<ProfileErasureMarker>{
  const identity=(await pool.query(`SELECT w.provider,w.app_id,w.openid,m.display_name,clock_timestamp() AS captured_at
    FROM wechat_identity w JOIN member m ON m.id=w.member_id WHERE w.member_id=$1`,[memberId])).rows[0];
  return {version:2,memberId,requestId:randomUUID(),identityDigest:AccountClosure.identityDigest(identity.provider,identity.app_id,identity.openid),
    createdAt:identity.captured_at.toISOString(),scope:'member_optional_profile_v1',
    displayNameSha256:createHash('sha256').update(identity.display_name).digest('hex')};
}
async function exportRequest(owner:{memberId:string;sessionToken:string}):Promise<string>{
  const response=await app.inject({method:'POST',url:'/v1/me/privacy-requests',
    headers:{authorization:`Bearer ${owner.sessionToken}`},payload:{kind:'access',message:'获取当前本人资料'}});
  expect(response.statusCode,response.body).toBe(200);return response.json().id;
}


it("keeps a closed member's newly generated rights copy available across an unchanged closure replay",async()=>{
  const owner=await login('closed-copy-replay');
  const profile=await profileMarker(owner.memberId);
  const marker={version:1 as const,memberId:profile.memberId,identityDigest:profile.identityDigest,
    requestId:profile.requestId,createdAt:profile.createdAt};
  await transaction(pool,c=>applyAccountClosure(c,marker));
  const request=await new PrivacyRights(pool,'test',undefined,true).submit(owner.memberId,
    {kind:'access',message:'获取注销后的历史资料'},true);
  const executor=new FormalPrivacyExecution(pool,config,storage);
  expect(await executor.runExportOnce()).toBe(true);
  await transaction(pool,c=>applyAccountClosure(c,marker));
  expect(JSON.parse((await executor.download(owner.memberId,request.id,true)).toString()).sections.account.id).toBe(owner.memberId);
});

it('preserves the same nickname when it was explicitly supplied again after deletion',async()=>{
  const owner=await login('name-resubmission');
  const originalName=(await pool.query('SELECT display_name FROM member WHERE id=$1',[owner.memberId])).rows[0].display_name;
  const marker=await profileMarker(owner.memberId);
  await transaction(pool,c=>applyProfileErasure(c,marker));
  await new MemberProfile(pool).update(owner.memberId,{displayName:originalName,expectedVersion:0});
  await transaction(pool,c=>applyProfileErasure(c,marker));
  expect((await pool.query('SELECT display_name FROM member WHERE id=$1',[owner.memberId])).rows[0].display_name).toBe(originalName);
});

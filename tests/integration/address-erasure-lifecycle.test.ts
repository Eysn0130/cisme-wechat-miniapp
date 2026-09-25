import { afterAll, beforeAll, expect, it } from 'vitest';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { createApp } from '../../services/api/src/server';
import { createApiGatewayStorage } from '../../services/api/src/storage';
import { AccountClosure, type Marker, type SuppressionRemote } from '../../services/api/src/accountClosure';
import { DeliveryAddressService } from '../../services/api/src/deliveryAddress';
import { transaction } from '../../services/api/src/db';

const pool=testPool();
let directory:string;
let app:Awaited<ReturnType<typeof createApp>>;
const markers=new Map<string,Marker>();
const markerKey=(row:Marker)=>row.version===3?`${row.memberId}:${row.addressId}:${row.requestId}`:
  row.version===2?`${row.memberId}:${row.requestId}`:row.memberId;
const remote:SuppressionRemote={
  async put(row){markers.set(markerKey(row),row);},
  async list(){return [...markers.values()];}
};
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,
  APP_SESSION_SECRET:'address-erasure-fixture',UPLOAD_TOKEN_SECRET:'address-erasure-upload',
  OBJECT_STORAGE_DRIVER:'api_gateway',CONTACT_ENCRYPTION_KEY:'8'.repeat(64),
  CONTACT_HASH_KEY:'7'.repeat(64),PRIVACY_SUPPRESSION_DIR:'/tmp/address-erasure-placeholder'});
const payload={recipientName:'仅用于合成测试',phone:'13800000001',province:'上海市',city:'上海市',
  district:'浦东新区',detail:'隔离测试路 1 号',label:'home' as const,isDefault:true};

beforeAll(async()=>{
  await resetDatabase(pool);
  directory=await mkdtemp(join(tmpdir(),'cisme-address-erasure-'));
  await chmod(directory,0o700);
  config.privacy.suppressionDirectory=directory;
  app=await createApp({pool,config,storage:createApiGatewayStorage(config),suppressionRemote:remote});
});
afterAll(async()=>{await app.close();await pool.end();await rm(directory,{recursive:true,force:true});});

async function member(suffix:string){
  const response=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:`address-erasure-${suffix}`,
    displayName:'合成用户',consents:[{documentType:'terms',version:'test'},{documentType:'privacy',version:'test'}]}});
  expect(response.statusCode,response.body).toBe(200);
  return response.json() as {memberId:string;sessionToken:string};
}
async function address(memberId:string,key:string){
  return new DeliveryAddressService(pool,config).create(memberId,key,payload);
}

it('erases the deleted address payload, revokes old copies, and suppresses an old backup restore',async()=>{
  const owner=await member('ordinary');
  const saved=await address(owner.memberId,'address-erasure-normal');
  const before=(await pool.query('SELECT encrypted_payload,payload_hmac,key_version,version FROM member_delivery_address WHERE id=$1',[saved.id])).rows[0];
  const response=await app.inject({method:'DELETE',url:`/v1/me/addresses/${saved.id}`,
    headers:{authorization:`Bearer ${owner.sessionToken}`},payload:{expectedVersion:saved.version}});
  expect(response.statusCode,response.body).toBe(200);
  expect(response.json()).toMatchObject({removed:true,erased:true,retainedForHold:false});
  const erased=(await pool.query('SELECT encrypted_payload,key_version,deleted_at FROM member_delivery_address WHERE id=$1',[saved.id])).rows[0];
  expect(erased.encrypted_payload).toBe('');
  expect(erased.key_version).toBe('erased');
  expect(erased.deleted_at).toBeInstanceOf(Date);
  const exported=await transaction(pool,client=>new DeliveryAddressService(pool,config).exportOwned(client,owner.memberId));
  expect(exported.find(row=>row.id===saved.id)?.address).toBeNull();
  expect([...markers.values()].some(row=>row.version===3&&row.addressId===saved.id)).toBe(true);
  await pool.query(`UPDATE member_delivery_address SET encrypted_payload=$2,payload_hmac=$3,
    key_version=$4,version=$5,deleted_at=NULL WHERE id=$1`,
    [saved.id,before.encrypted_payload,before.payload_hmac,before.key_version,before.version]);
  await new AccountClosure(directory,remote).replay(pool);
  const restored=(await pool.query('SELECT encrypted_payload,key_version,deleted_at FROM member_delivery_address WHERE id=$1',[saved.id])).rows[0];
  expect(restored.encrypted_payload).toBe('');
  expect(restored.key_version).toBe('erased');
  expect(restored.deleted_at).toBeInstanceOf(Date);
});

it('hides a held address while preserving its payload until the hold ends',async()=>{
  const owner=await member('held');
  const saved=await address(owner.memberId,'address-erasure-held');
  const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
    VALUES('DISPUTE_EVIDENCE','Synthetic isolated hold','fixture',now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0].id;
  await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'member_delivery_address',$2)",[hold,saved.id]);
  const response=await app.inject({method:'DELETE',url:`/v1/me/addresses/${saved.id}`,
    headers:{authorization:`Bearer ${owner.sessionToken}`},payload:{expectedVersion:saved.version}});
  expect(response.statusCode,response.body).toBe(200);
  expect(response.json()).toMatchObject({removed:true,erased:false,retainedForHold:true});
  expect((await pool.query('SELECT encrypted_payload FROM member_delivery_address WHERE id=$1',[saved.id])).rows[0].encrypted_payload).not.toBe('');
  expect((await app.inject({url:'/v1/me/addresses',headers:{authorization:`Bearer ${owner.sessionToken}`}})).json().addresses).toEqual([]);
  await pool.query("UPDATE legal_hold SET status='released',released_by='fixture',released_at=now() WHERE id=$1",[hold]);
  expect(await new AccountClosure(directory,remote).replayPendingErasure(pool)).toBeGreaterThan(0);
  expect((await pool.query('SELECT encrypted_payload,key_version FROM member_delivery_address WHERE id=$1',[saved.id])).rows[0])
    .toMatchObject({encrypted_payload:'',key_version:'erased'});
});

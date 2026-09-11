import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { createApp } from '../../services/api/src/server';
import { createApiGatewayStorage } from '../../services/api/src/storage';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'ugc-foundation-test',ADMIN_API_TOKEN:'ugc-foundation-admin',UPLOAD_TOKEN_SECRET:'ugc-foundation-upload',OBJECT_STORAGE_DRIVER:'api_gateway'});
const app=await createApp({pool,config,storage:createApiGatewayStorage(config)});
let firstMember:string,secondMember:string,firstSessionToken:string;

beforeAll(async()=>{
  await resetDatabase(pool);
  await pool.query("INSERT INTO principal_role(principal_id,role) VALUES('ugc-review-lead','review_lead')");
  for(const externalUserId of ['ugc-owner-a','ugc-owner-b']) {
    const response=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId,displayName:externalUserId,consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});
    expect(response.statusCode).toBe(200);
    if(!firstMember){firstMember=response.json().memberId;firstSessionToken=response.json().sessionToken;}else secondMember=response.json().memberId;
  }
});
afterAll(async()=>{await app.close();await pool.end();});

it('keeps formal UGC structurally separate and impossible to enable',async()=>{
  const current=(await pool.query("SELECT enabled,version FROM emergency_switch WHERE key='community'")).rows[0];
  expect(current).toMatchObject({enabled:false,version:1});
  const response=await app.inject({method:'PUT',url:'/v1/admin/switches/community',headers:{'x-admin-token':'ugc-foundation-admin','x-principal-id':'ugc-review-lead','idempotency-key':'formal-community-enable-v1'},payload:{enabled:true,reason:'premature test',expectedVersion:1}});
  expect(response.statusCode).toBe(409);expect(response.json().code).toBe('COMMUNITY_RELEASE_NOT_IMPLEMENTED');
  await expect(pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'")).rejects.toMatchObject({code:'23514'});
  expect((await app.inject({method:'GET',url:'/v1/ugc/posts',headers:{authorization:`Bearer ${firstSessionToken}`}})).statusCode).toBe(404);
});

it('requires an owned revision and rejects cross-member media attachment',async()=>{
  const postId='10000000-0000-4000-8000-000000000001';
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("INSERT INTO ugc_post(id,author_member_id,client_request_key) VALUES($1,$2,'ugc-post-owner-a-v1')",[postId,firstMember]);
    await client.query("INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,body) VALUES($1,1,$2,'护理记录草稿')",[postId,firstMember]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await expect(pool.query("INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,body) VALUES($1,2,$2,'越权修订')",[postId,secondMember])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query("UPDATE ugc_post_revision SET body='原地篡改' WHERE post_id=$1 AND revision=1",[postId])).rejects.toMatchObject({code:'55000'});
  await expect(pool.query("UPDATE ugc_post SET state='published',visibility='public',published_at=now() WHERE id=$1",[postId])).rejects.toMatchObject({code:'23514'});
  await pool.query("UPDATE ugc_post_revision SET moderation_state='pending' WHERE post_id=$1 AND revision=1",[postId]);
  await pool.query("UPDATE ugc_post_revision SET moderation_state='approved' WHERE post_id=$1 AND revision=1",[postId]);
  await pool.query("UPDATE ugc_post SET state='published',visibility='public',published_at=now() WHERE id=$1",[postId]);
  await expect(pool.query("UPDATE ugc_post SET author_member_id=$2 WHERE id=$1",[postId,secondMember])).rejects.toMatchObject({code:'55000'});
  const media=(await pool.query(`INSERT INTO ugc_media_asset(owner_member_id,kind,object_key,mime_type,authorization_expires_at)
    VALUES($1,'image','ugc/test/cross-owner.jpg','image/jpeg',now()+interval '10 minutes') RETURNING id`,[secondMember])).rows[0];
  await expect(pool.query("INSERT INTO ugc_post_media(post_id,revision,media_asset_id,position) VALUES($1,1,$2,0)",[postId,media.id])).rejects.toMatchObject({code:'23514'});
  expect((await pool.query('SELECT count(*)::int count FROM community_comment')).rows[0].count).toBe(0);
});

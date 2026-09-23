import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { createApp } from '../../services/api/src/server.js';
import { createApiGatewayStorage } from '../../services/api/src/storage.js';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,ALLOW_DEV_ADAPTERS:'true',
  APP_SESSION_SECRET:'test-session-secret',ADMIN_API_TOKEN:'test-admin-token',UPLOAD_TOKEN_SECRET:'test-upload-secret',
  OBJECT_STORAGE_DRIVER:'api_gateway'});
const storage=createApiGatewayStorage(config);
let app:FastifyInstance,memberId:string,token:string;
const headers=()=>({authorization:`Bearer ${token}`});

beforeAll(async()=>{
  await resetDatabase(pool);
  await storage.ensureReady();
  app=await createApp({config,pool,storage});
  const response=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:'cursor-precision-member',
    displayName:'游标会员',consents:[{documentType:'privacy',version:'v1'},{documentType:'terms',version:'v1'}]}});
  expect(response.statusCode).toBe(200);
  ({memberId,sessionToken:token}=response.json());
});
afterAll(async()=>{await app?.close();await pool.end();});

it('keeps microsecond points rows reachable across pages without exposing the cursor projection',async()=>{
  const ids:string[]=[];
  for(const fraction of ['123454','123455','123456']){
    const result=await pool.query<{id:string}>(`INSERT INTO points_entry(member_id,entry_type,business_key,occurred_at)
      VALUES($1,'adjustment',$2,$3::timestamptz) RETURNING id`,[memberId,`cursor-points-${fraction}`,`2026-09-23 12:00:00.${fraction}+00`]);
    ids.push(result.rows[0]!.id);
  }
  let cursor:string|undefined;
  const seen:string[]=[];
  for(let page=0;page<3;page++){
    const response=await app.inject({method:'GET',url:`/v1/me/points?limit=1${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,headers:headers()});
    expect(response.statusCode,response.body).toBe(200);
    const body=response.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).not.toHaveProperty('cursor_at');
    seen.push(body.entries[0].id);
    cursor=body.nextCursor??undefined;
  }
  expect(seen).toEqual(ids.reverse());
  expect(cursor).toBeUndefined();
});

it('keeps older care cycles with distinct microseconds reachable',async()=>{
  const ids:string[]=[];
  for(const fraction of ['123453','123454','123455','123456']){
    const fact=await pool.query<{id:string}>(`INSERT INTO qualification_fact(member_id,source,external_ref,occurred_at)
      VALUES($1,'test',$2,'2026-09-01T00:00:00Z') RETURNING id`,[memberId,`cursor-care-${fraction}`]);
    const cycle=await pool.query<{id:string}>(`INSERT INTO care_cycle(member_id,qualification_fact_id,phase,started_on,timezone,protocol_version,created_at)
      VALUES($1,$2,'terminated','2026-09-01','Asia/Shanghai','care-r0-v1',$3::timestamptz) RETURNING id`,
      [memberId,fact.rows[0]!.id,`2026-09-23 12:00:00.${fraction}+00`]);
    ids.push(cycle.rows[0]!.id);
  }
  let cursor:string|undefined;
  const seen:string[]=[];
  for(let page=0;page<3;page++){
    const response=await app.inject({method:'GET',url:`/v1/me/care?limit=1${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,headers:headers()});
    expect(response.statusCode,response.body).toBe(200);
    const body=response.json();
    expect(body.id).toBe(ids[3]);
    expect(body.history).toHaveLength(1);
    seen.push(body.history[0].id);
    cursor=body.nextCursor??undefined;
  }
  expect(seen).toEqual([ids[2],ids[1],ids[0]]);
  expect(cursor).toBeUndefined();
});

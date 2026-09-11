import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@cisme/config';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { createApp } from '../../services/api/src/server';
import { createApiGatewayStorage } from '../../services/api/src/storage';
const pool = testPool();
const config = loadConfig({APP_ENV:'test', DATABASE_URL:TEST_DATABASE_URL, APP_SESSION_SECRET:'access-test',ADMIN_API_TOKEN:'access-admin',UPLOAD_TOKEN_SECRET:'access-upload',OBJECT_STORAGE_DRIVER:'api_gateway'});
let app:FastifyInstance;
let member:any, team:any;
const headers=(token:string)=>({authorization:`Bearer ${token}`});
beforeAll(async()=>{
 await resetDatabase(pool); app=await createApp({config,pool,storage:createApiGatewayStorage(config)});
 const identity=async(id:string)=>(await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:id,displayName:id,consents:[{documentType:'privacy',version:'v1'},{documentType:'terms',version:'v1'}]}})).json();
 member=await identity('member');team=await identity('team');
 await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,'community.moderate','test-owner','Community moderation fixture','test','integration_fixture')",[team.memberId]);
});
afterAll(async()=>{await app.close();await pool.end();});
it('protects all native review routes against guests and forged client roles',async()=>{
 await pool.query("INSERT INTO member_team_access(member_id,role,granted_by) VALUES($1,'administrator','legacy-fixture')",[member.memberId]);
 for(const url of ['/v1/team/reviews','/v1/team/publications']) {
  expect((await app.inject({method:'GET',url})).statusCode).toBe(401);
  expect((await app.inject({method:'GET',url,headers:{...headers(member.sessionToken),'x-principal-id':team.principalId,'x-admin-token':config.adminApiToken}})).statusCode).toBe(403);
  expect((await app.inject({method:'GET',url,headers:headers(team.sessionToken)})).statusCode).toBe(200);
 }
 for(const action of ['review','publish']) expect((await app.inject({method:'POST',url:`/v1/team/submissions/00000000-0000-0000-0000-000000000000/${action}`,headers:{...headers(member.sessionToken),'idempotency-key':'forged-operation'},payload:{}})).statusCode).toBe(403);
 expect((await app.inject({method:'GET',url:'/v1/me/community-access',headers:headers(member.sessionToken)})).json()).toMatchObject({canReview:false});
});
it('persists follows idempotently and isolates each member',async()=>{
 const follow=()=>app.inject({method:'PUT',url:'/v1/me/follows/brand%3Acisme',headers:headers(member.sessionToken),payload:{active:true}});
 expect((await Promise.all([follow(),follow()])).map(r=>r.statusCode)).toEqual([200,200]);
 expect((await app.inject({method:'GET',url:'/v1/me/follows',headers:headers(member.sessionToken)})).json()).toEqual(['brand:cisme']);
 expect((await app.inject({method:'GET',url:'/v1/me/follows',headers:headers(team.sessionToken)})).json()).toEqual([]);
 expect((await app.inject({method:'PUT',url:'/v1/me/follows/brand%3Acisme',headers:headers(member.sessionToken),payload:{active:'true'}})).statusCode).toBe(422);
 await app.inject({method:'PUT',url:'/v1/me/follows/brand%3Acisme',headers:headers(member.sessionToken),payload:{active:false}});
 expect((await app.inject({method:'GET',url:'/v1/me/follows',headers:headers(member.sessionToken)})).json()).toEqual([]);
});
it('revokes native review access immediately despite a still-valid session',async()=>{
 await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='test-owner',revoke_reason='Immediate revocation fixture' WHERE member_id=$1 AND capability='community.moderate'",[team.memberId]);
 expect((await app.inject({method:'GET',url:'/v1/team/reviews',headers:headers(team.sessionToken)})).statusCode).toBe(403);
 expect((await app.inject({method:'GET',url:'/v1/me/community-access',headers:headers(team.sessionToken)})).json()).toMatchObject({canReview:false});
});

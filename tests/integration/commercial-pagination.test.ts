import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const pool=testPool();
const config=loadConfig({APP_ENV:"test",DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"paged-session",
  ADMIN_API_TOKEN:"paged-admin",UPLOAD_TOKEN_SECRET:"paged-upload",OBJECT_STORAGE_DRIVER:"api_gateway"});
let app:FastifyInstance;
let manager:{memberId:string;sessionToken:string};
let sponsor:{memberId:string;sessionToken:string};
const headers=(actor:{sessionToken:string})=>({authorization:`Bearer ${actor.sessionToken}`});
const identity=async(name:string)=>{
  const response=await app.inject({method:"POST",url:"/v1/identity/dev",payload:{externalUserId:name,displayName:name,
    consents:[{documentType:"privacy",version:"test"},{documentType:"terms",version:"test"}]}});
  expect(response.statusCode).toBe(200);return response.json();
};
const get=async(url:string)=>{const response=await app.inject({method:"GET",url,headers:headers(manager)});
  expect(response.statusCode).toBe(200);return response.json();};
beforeAll(async()=>{
  await resetDatabase(pool);
  app=await createApp({config,pool,storage:createApiGatewayStorage(config)});
  manager=await identity("paged-manager");sponsor=await identity("paged-sponsor");
  for(const capability of ["member.profile.read","commission.read","commission.rate.approve","commerce.order.read"]){
    await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
      VALUES($1,$2,'fixture','pagination boundary','test','integration_fixture')`,[manager.memberId,capability]);
  }
  await pool.query(`INSERT INTO commercial_membership(member_id,state,effective_at,expires_at,changed_by,change_reason)
    VALUES($1,'active',now()-interval '1 day',now()+interval '2 years','fixture','pagination fixture')`,[sponsor.memberId]);
  const code=(await pool.query(`INSERT INTO commercial_referral_code(member_id,code)
    VALUES($1,'CMPAGEDTEST2') RETURNING id`,[sponsor.memberId])).rows[0].id;
  const members=await pool.query(`INSERT INTO member(display_name,status,created_at)
    SELECT 'Paged member '||lpad(n::text,3,'0'),'active',now()+n*interval '1 microsecond'
    FROM generate_series(1,51) AS n RETURNING id,display_name`);
  for(let i=0;i<members.rows.length;i++){
    await pool.query(`INSERT INTO commercial_referral_relation(referred_member_id,referrer_member_id,referral_code_id,
      confirmation_key,confirmed_by,confirmed_at) VALUES($1,$2,$3,$4,'fixture',now()+$5*interval '1 microsecond')`,
      [members.rows[i]!.id,sponsor.memberId,code,`paged-referral-${i+1}`,i+1]);
  }
  await pool.query(`INSERT INTO commission_rate_rule(member_id,basis_points,state,effective_at,created_by,reason,created_at)
    SELECT NULL,2200,'proposed',now()+interval '2 days','fixture-'||n,'pagination fixture',now()+n*interval '1 microsecond'
    FROM generate_series(1,31) n`);
});
afterAll(async()=>{await app?.close();await pool.end();});

it("paginates 51 matching members and referrals without duplicate IDs or hidden counts",async()=>{
  const first=await get("/v1/management/members?q=Paged%20member&limit=30");
  expect(first.matchingTotal).toBe(51);expect(first.loadedCount).toBe(30);expect(first.hasMore).toBe(true);
  const second=await get(`/v1/management/members?q=Paged%20member&limit=30&cursor=${encodeURIComponent(first.nextCursor)}`);
  expect(second.items).toHaveLength(21);expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items,...second.items].map((item:{id:string})=>item.id)).size).toBe(51);
  const r1=await get(`/v1/management/members/${sponsor.memberId}/sections/referrals?limit=30`);
  expect(r1.matchingTotal).toBe(51);expect(r1.items).toHaveLength(30);
  const r2=await get(`/v1/management/members/${sponsor.memberId}/sections/referrals?limit=30&cursor=${encodeURIComponent(r1.nextCursor)}`);
  expect(r2.items).toHaveLength(21);
  expect(new Set([...r1.items,...r2.items].map((item:{id:string})=>item.id)).size).toBe(51);
  expect(r1.items.every((item:{verifiedOrderCount:number})=>item.verifiedOrderCount===0)).toBe(true);
  const wrongScope=await app.inject({method:"GET",url:`/v1/management/members?filter=ordinary&cursor=${encodeURIComponent(first.nextCursor)}`,headers:headers(manager)});
  expect(wrongScope.statusCode).toBe(422);
});

it("paginates 31 rate decisions while preserving total",async()=>{
  const first=await get("/v1/management/commission-rates/pending?limit=30");
  expect(first.matchingTotal).toBe(31);expect(first.items).toHaveLength(30);expect(first.hasMore).toBe(true);
  const second=await get(`/v1/management/commission-rates/pending?limit=30&cursor=${encodeURIComponent(first.nextCursor)}`);
  expect(second.items).toHaveLength(1);expect(second.hasMore).toBe(false);
  expect(new Set([...first.items,...second.items].map((item:{id:string})=>item.id)).size).toBe(31);
});

it("paginates 51 owned drafts without leaking them to member public-content sections",async()=>{
  const client=await pool.connect();await client.query("BEGIN");
  try{
    await client.query(`INSERT INTO ugc_post(author_member_id,client_request_key,updated_at)
      SELECT $1,'paged-draft-'||lpad(n::text,3,'0'),now()+n*interval '1 microsecond'
      FROM generate_series(1,51) n`,[sponsor.memberId]);
    await client.query(`INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,title,body)
      SELECT id,1,author_member_id,'分页草稿','仅本人可见'
      FROM ugc_post WHERE author_member_id=$1`,[sponsor.memberId]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const firstResponse=await app.inject({method:"GET",url:"/v1/me/ugc/posts?limit=30",headers:headers(sponsor)});
  expect(firstResponse.statusCode).toBe(200);
  const first=firstResponse.json();expect(first.matchingTotal).toBe(51);expect(first.items).toHaveLength(30);
  const secondResponse=await app.inject({method:"GET",url:`/v1/me/ugc/posts?limit=30&cursor=${encodeURIComponent(first.nextCursor)}`,headers:headers(sponsor)});
  expect(secondResponse.statusCode).toBe(200);
  const second=secondResponse.json();expect(second.items).toHaveLength(21);
  expect(new Set([...first.items,...second.items].map((item:{id:string})=>item.id)).size).toBe(51);
  const publicPosts=await get(`/v1/management/members/${sponsor.memberId}/sections/posts`);
  expect(publicPosts.matchingTotal).toBe(0);expect(publicPosts.items).toHaveLength(0);
});

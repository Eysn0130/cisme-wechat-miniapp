import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";
import { CommercialMembershipService } from "../../services/api/src/commercialMembership";
import { AuthorityService } from "../../services/api/src/authority";

const pool=testPool();
const config=loadConfig({APP_ENV:"test",DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"commercial-session",
  ADMIN_API_TOKEN:"commercial-admin",UPLOAD_TOKEN_SECRET:"commercial-upload",OBJECT_STORAGE_DRIVER:"api_gateway"});
let app:FastifyInstance;
type Actor={memberId:string;principalId:string;sessionToken:string};
let a:Actor,b:Actor,c:Actor,manager:Actor,checker:Actor;
const auth=(actor:Actor)=>({authorization:`Bearer ${actor.sessionToken}`});
const identity=async(name:string):Promise<Actor>=>{
  const response=await app.inject({method:"POST",url:"/v1/identity/dev",payload:{externalUserId:name,displayName:name,
    consents:[{documentType:"privacy",version:"test"},{documentType:"terms",version:"test"}]}});
  expect(response.statusCode).toBe(200);return response.json();
};
const grant=async(actor:Actor,capability:string)=>pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
  VALUES($1,$2,'fixture','isolated commercial test','test','integration_fixture')`,[actor.memberId,capability]);
beforeAll(async()=>{
  await resetDatabase(pool);
  app=await createApp({config,pool,storage:createApiGatewayStorage(config)});
  [a,b,c,manager,checker]=await Promise.all([identity("commercial-a"),identity("commercial-b"),identity("commercial-c"),
    identity("commercial-manager"),identity("commercial-checker")]);
});
afterAll(async()=>{await app?.close();await pool.end();});

it("separates ordinary accounts, commercial qualification, management scope and direct referrals",async()=>{
  const ordinary=await app.inject({method:"GET",url:"/v1/me/commercial-membership",headers:auth(a)});
  expect(ordinary.json()).toMatchObject({eligible:false,membershipState:"none",commission:{pendingCents:0,availableCents:0}});
  expect((await app.inject({method:"POST",url:"/v1/me/commercial-membership/code",headers:auth(a)})).statusCode).toBe(403);
  expect((await app.inject({method:"GET",url:"/v1/management/members",headers:auth(a)})).statusCode).toBe(403);
  await grant(manager,"member.manage");
  expect((await app.inject({method:"GET",url:"/v1/management/members",headers:auth(manager)})).statusCode).toBe(403);
  await grant(manager,"member.profile.read");
  expect((await app.inject({method:"POST",url:`/v1/management/members/${manager.memberId}/membership`,headers:auth(manager),
    payload:{state:"active",expiresAt:"2027-09-12T00:00:00Z",expectedVersion:0,reason:"不能自授资格"}})).statusCode).toBe(403);
  const makeMember=async(target:Actor)=>app.inject({method:"POST",url:`/v1/management/members/${target.memberId}/membership`,headers:auth(manager),
    payload:{state:"active",expiresAt:"2027-09-12T00:00:00Z",expectedVersion:0,reason:"测试管理员授予资格"}});
  expect((await makeMember(a)).statusCode).toBe(200);
  expect((await makeMember(b)).statusCode).toBe(200);
  expect((await makeMember(a)).statusCode).toBe(409);
  const issued=await app.inject({method:"POST",url:"/v1/me/commercial-membership/code",headers:auth(a)});
  expect(issued.statusCode).toBe(200);
  const codeA=issued.json().code;
  expect(codeA).toMatch(/^CM[A-HJ-NP-Z2-9]{10}$/);
  expect((await app.inject({method:"POST",url:"/v1/me/commercial-membership/code",headers:auth(a)})).json().code).toBe(codeA);
  expect((await app.inject({method:"POST",url:"/v1/me/referral/confirm",headers:auth(a),
    payload:{code:codeA,confirmationKey:"self-referral-0001"}})).statusCode).toBe(422);
  const confirm=await app.inject({method:"POST",url:"/v1/me/referral/confirm",headers:auth(b),
    payload:{code:codeA,confirmationKey:"direct-a-b-0001"}});
  expect(confirm.json()).toMatchObject({confirmed:true,alreadyConfirmed:false});
  expect((await app.inject({method:"POST",url:"/v1/me/referral/confirm",headers:auth(b),
    payload:{code:codeA,confirmationKey:"direct-a-b-replay"}})).json()).toMatchObject({alreadyConfirmed:true});
  const codeB=(await app.inject({method:"POST",url:"/v1/me/commercial-membership/code",headers:auth(b)})).json().code;
  expect((await app.inject({method:"POST",url:"/v1/me/referral/confirm",headers:auth(c),
    payload:{code:codeB,confirmationKey:"direct-b-c-0001"}})).statusCode).toBe(200);
  expect((await app.inject({method:"POST",url:"/v1/me/referral/confirm",headers:auth(c),
    payload:{code:codeA,confirmationKey:"attempt-second-binding"}})).statusCode).toBe(409);
  const relations=await pool.query(`SELECT referrer_member_id,referred_member_id FROM commercial_referral_relation ORDER BY referrer_member_id`);
  expect(relations.rows).toEqual(expect.arrayContaining([{referrer_member_id:a.memberId,referred_member_id:b.memberId},
    {referrer_member_id:b.memberId,referred_member_id:c.memberId}]));
  expect(relations.rowCount).toBe(2);
  expect((await app.inject({method:"GET",url:`/v1/management/members/${a.memberId}`,headers:auth(a)})).statusCode).toBe(403);
  const restricted=(await app.inject({method:"GET",url:`/v1/management/members/${a.memberId}`,headers:auth(manager)})).json();
  expect(restricted.scope).toEqual({referrals:false,orders:false});
  expect(restricted.member.referralCode).toBeNull();expect(restricted.referrals).toHaveLength(0);
  expect(restricted.rate).toBeNull();
  await grant(manager,"commission.read");
  const broader=(await app.inject({method:"GET",url:`/v1/management/members/${a.memberId}`,headers:auth(manager)})).json();
  expect(broader.scope).toEqual({referrals:true,orders:false});
  expect(broader.referrals).toHaveLength(1);
  expect((await pool.query("SELECT count(*)::int AS n FROM commission_ledger_entry")).rows[0].n).toBe(0);
});

it("rejects invalid rates and enforces a separate approver",async()=>{
  const effectiveAt=new Date(Date.now()+3600_000).toISOString();
  const payload=(basisPoints:unknown)=>({memberId:a.memberId,basisPoints,effectiveAt,reason:"合成费率调整测试"});
  expect((await app.inject({method:"POST",url:"/v1/management/commission-rates",headers:auth(manager),payload:payload(3500)})).statusCode).toBe(403);
  await grant(manager,"commission.rate.manage");
  for(const invalid of [1999,3501,20.5,"3500",null])expect((await app.inject({method:"POST",url:"/v1/management/commission-rates",
    headers:auth(manager),payload:payload(invalid)})).statusCode).toBe(422);
  const proposal=await app.inject({method:"POST",url:"/v1/management/commission-rates",headers:auth(manager),payload:payload(3500)});
  expect(proposal.statusCode).toBe(200);
  expect((await app.inject({method:"POST",url:`/v1/management/commission-rates/${proposal.json().id}/decision`,
    headers:auth(manager),payload:{decision:"active"}})).statusCode).toBe(403);
  await grant(checker,"commission.rate.approve");
  const approval=await app.inject({method:"POST",url:`/v1/management/commission-rates/${proposal.json().id}/decision`,
    headers:auth(checker),payload:{decision:"active"}});
  expect(approval.json()).toMatchObject({basis_points:3500,state:"active"});
  expect((await app.inject({method:"POST",url:`/v1/management/commission-rates/${proposal.json().id}/decision`,
    headers:auth(checker),payload:{decision:"active"}})).statusCode).toBe(409);
});

it("does not present expired or blocked accounts as eligible commercial members",async()=>{
  const blocked=(await pool.query("INSERT INTO member(display_name,status) VALUES('Blocked commercial fixture','blocked') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO commercial_membership(member_id,state,effective_at,expires_at,changed_by,change_reason)
    VALUES($1,'active',now()-interval '2 days',now()+interval '1 year','fixture','Blocked account fixture')`,[blocked]);
  await pool.query(`UPDATE commercial_membership SET effective_at=now()-interval '2 days',
    expires_at=now()-interval '1 day' WHERE member_id=$1`,[b.memberId]);
  const list=(await app.inject({method:"GET",url:"/v1/management/members?filter=members",headers:auth(manager)})).json();
  expect(list.items.map((item:{id:string})=>item.id)).toContain(a.memberId);
  expect(list.items.map((item:{id:string})=>item.id)).not.toContain(b.memberId);
  expect(list.items.map((item:{id:string})=>item.id)).not.toContain(blocked);
  expect(list.summary.members).toBe(1);
  const detail=(await app.inject({method:"GET",url:`/v1/management/members/${b.memberId}`,headers:auth(manager)})).json();
  expect(detail.member).toMatchObject({membershipState:"active",commercialEligible:false});
});

it("keeps unapproved commercial qualification and attribution writes closed outside engineering environments",async()=>{
  const closed=new CommercialMembershipService(pool,new AuthorityService(pool,"test"),"production");
  await expect(closed.ensureCode(a.memberId)).rejects.toMatchObject({code:"COMMERCIAL_RULES_NOT_APPROVED"});
  await expect(closed.setMembership(manager.memberId,manager.principalId,c.memberId,{state:"active",
    expiresAt:"2027-09-12T00:00:00Z",expectedVersion:0,reason:"未获正式业务批准"}))
    .rejects.toMatchObject({code:"COMMERCIAL_RULES_NOT_APPROVED"});
  expect(await closed.myStatus(a.memberId)).toMatchObject({eligible:false,referralCode:null});
});

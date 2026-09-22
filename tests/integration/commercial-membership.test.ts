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
  expect((await app.inject({method:"GET",url:"/v1/management/commission-rates/current",headers:auth(a)})).statusCode).toBe(403);
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
  const preview=await app.inject({method:"GET",url:`/v1/me/referral/preview?code=${codeA}`,headers:auth(b)});
  expect(preview.statusCode).toBe(200);expect(preview.json()).toMatchObject({code:codeA,relationState:"unbound",attributionLevel:1,confirmationRequired:true});
  expect(preview.json().sponsorLabel).toMatch(/CISME 商业会员/);
  expect((await app.inject({method:"GET",url:`/v1/me/referral/preview?code=${codeA}`,headers:auth(a)})).statusCode).toBe(422);
  expect((await app.inject({method:"POST",url:"/v1/me/referral/confirm",headers:auth(a),
    payload:{code:codeA,confirmationKey:"self-referral-0001"}})).statusCode).toBe(422);
  const confirm=await app.inject({method:"POST",url:"/v1/me/referral/confirm",headers:auth(b),
    payload:{code:codeA,confirmationKey:"direct-a-b-0001"}});
  expect(confirm.json()).toMatchObject({confirmed:true,alreadyConfirmed:false});
  expect((await app.inject({method:"GET",url:`/v1/me/referral/preview?code=${codeA}`,headers:auth(b)})).json().relationState).toBe("already_bound_same");
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
  expect(restricted.scope).toEqual({referrals:false,orders:false,ownOrders:false});
  expect(restricted.member.referralCode).toBeNull();expect(restricted.referrals).toBeUndefined();
  expect(restricted.rate).toBeNull();
  expect((await app.inject({method:"GET",url:`/v1/management/members/${a.memberId}/sections/referrals`,headers:auth(manager)})).statusCode).toBe(403);
  await grant(manager,"commission.read");
  expect((await app.inject({method:"GET",url:"/v1/management/commission-rates/current",headers:auth(manager)})).json())
    .toMatchObject({basisPoints:2000,policyKind:"engineering_fixture",paymentAvailable:false});
  const broader=(await app.inject({method:"GET",url:`/v1/management/members/${a.memberId}`,headers:auth(manager)})).json();
  expect(broader.scope).toEqual({referrals:true,orders:false,ownOrders:false});
  const direct=(await app.inject({method:"GET",url:`/v1/management/members/${a.memberId}/sections/referrals`,headers:auth(manager)})).json();
  expect(direct.matchingTotal).toBe(1);expect(direct.items).toHaveLength(1);
  expect((await pool.query("SELECT count(*)::int AS n FROM commission_ledger_entry")).rows[0].n).toBe(0);
});

it("rejects invalid rates and enforces a separate approver",async()=>{
  // Farther than the next Shanghai midnight at every runner time of day.
  // A future requested time is retained; only an earlier time is postponed.
  const effectiveAt=new Date(Date.now()+48*3600_000).toISOString();
  const payload=(basisPoints:unknown)=>({memberId:a.memberId,basisPoints,effectiveAt,reason:"合成费率调整测试"});
  expect((await app.inject({method:"POST",url:"/v1/management/commission-rates",headers:auth(manager),payload:payload(3500)})).statusCode).toBe(403);
  await grant(manager,"commission.rate.manage");
  for(const invalid of [1999,2100,2700,3400,3501,20.5,"3500",null])expect((await app.inject({method:"POST",url:"/v1/management/commission-rates",
    headers:auth(manager),payload:payload(invalid)})).statusCode).toBe(422);
  expect((await pool.query("SELECT rule_version FROM commission_rate_rule WHERE created_by='migration' LIMIT 1")).rows[0].rule_version)
    .toBe("legacy-v1");
  await expect(pool.query(`INSERT INTO commission_rate_rule(member_id,basis_points,state,effective_at,
    proposed_effective_at,created_by,reason) VALUES($1,2200,'proposed',now()+interval '2 days',
    now()+interval '2 days','fixture','新费率非法中间值')`,[a.memberId])).rejects.toMatchObject({code:"23514"});
  const rateHeaders={...auth(manager),"idempotency-key":"commercial-rate-proposal-0001"};
  const proposal=await app.inject({method:"POST",url:"/v1/management/commission-rates",headers:rateHeaders,payload:payload(3500)});
  expect(proposal.statusCode).toBe(200);
  const replay=await app.inject({method:"POST",url:"/v1/management/commission-rates",headers:rateHeaders,payload:payload(3500)});
  expect(replay.statusCode).toBe(200);expect(replay.json()).toMatchObject({id:proposal.json().id,alreadyCreated:true});
  expect((await app.inject({method:"GET",url:"/v1/management/commission-rates/by-request/commercial-rate-proposal-0001",headers:auth(manager)})).json().id).toBe(proposal.json().id);
  expect((await app.inject({method:"POST",url:"/v1/management/commission-rates",headers:rateHeaders,payload:payload(3000)})).statusCode).toBe(409);
  expect((await app.inject({method:"POST",url:`/v1/management/commission-rates/${proposal.json().id}/decision`,
    headers:{...auth(manager),"idempotency-key":"rate-self-approve-0001"},
    payload:{decision:"active",expectedVersion:1,reason:"不可自行批准费率"}})).statusCode).toBe(403);
  await grant(checker,"commission.rate.approve");
  const approval=await app.inject({method:"POST",url:`/v1/management/commission-rates/${proposal.json().id}/decision`,
    headers:{...auth(checker),"idempotency-key":"rate-approval-0001"},
    payload:{decision:"active",expectedVersion:1,reason:"独立批准会员费率"}});
  expect(approval.json()).toMatchObject({basis_points:3500,state:"active"});
  expect(new Date(approval.json().effective_at).getTime()).toBe(new Date(effectiveAt).getTime());
  expect((await app.inject({method:"POST",url:`/v1/management/commission-rates/${proposal.json().id}/decision`,
    headers:{...auth(checker),"idempotency-key":"rate-approval-0001"},
    payload:{decision:"active",expectedVersion:1,reason:"独立批准会员费率"}})).json()).toMatchObject({alreadyDecided:true});
  const lapsed=(await pool.query(`INSERT INTO commission_rate_rule(member_id,basis_points,state,effective_at,
    proposed_effective_at,rule_version,created_by,reason)
    VALUES($1,2500,'proposed',now()-interval '1 hour',now()-interval '1 hour','commercial-rate-v2',$2,'过期费率不能追溯批准') RETURNING id`,
    [a.memberId,manager.principalId])).rows[0].id;
  const late=await app.inject({method:"POST",url:`/v1/management/commission-rates/${lapsed}/decision`,
    headers:{...auth(checker),"idempotency-key":"rate-late-approval-0001"},
    payload:{decision:"active",expectedVersion:1,reason:"迟批顺延到上海次日"}});
  expect(late.statusCode).toBe(200);
  expect(new Date(late.json().effective_at).getTime()).toBeGreaterThan(Date.now());
});

it("persists only an audited, non-payable monthly candidate after the Shanghai 15th",async()=>{
  const endpoint="/v1/management/commission/settlement-cycles/prepare";
  const periodEnd=(await pool.query<{end:string}>(`SELECT
    (date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')-interval '1 month 1 day')::date::text AS "end"`)).rows[0]!.end;
  expect((await app.inject({method:"POST",url:endpoint,headers:auth(a),payload:{periodEnd}})).statusCode).toBe(403);
  await grant(checker,"commission.settlement.approve");
  expect((await app.inject({method:"POST",url:endpoint,headers:auth(checker),
    payload:{periodEnd:"2026-02-30"}})).statusCode).toBe(422);
  const prepared=await app.inject({method:"POST",url:endpoint,headers:auth(checker),payload:{periodEnd}});
  expect(prepared.statusCode).toBe(200);
  expect(prepared.json()).toMatchObject({periodEnd,policyVersion:"engineering-monthly-15-v1",
    thresholdCents:10000,state:"blocked_tax_and_payout_policy",payable:false,
    withholdingPolicyVersion:null,netCents:null,replay:false,members:[]});
  const replay=await app.inject({method:"POST",url:endpoint,headers:auth(checker),payload:{periodEnd}});
  expect(replay.json()).toMatchObject({id:prepared.json().id,replay:true,members:[]});
  const currentMonthEnd=(await pool.query<{end:string}>(`SELECT
    (date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Shanghai')+interval '1 month - 1 day')::date::text AS "end"`)).rows[0]!.end;
  const early=await app.inject({method:"POST",url:endpoint,headers:auth(checker),payload:{periodEnd:currentMonthEnd}});
  expect(early.statusCode).toBe(409);expect(early.json().code).toBe("SETTLEMENT_CYCLE_TOO_EARLY");
  expect((await pool.query(`SELECT count(*)::int AS n FROM commission_settlement_cycle`)).rows[0].n).toBe(1);
});

it("proposes global rates and member inheritance as audited separate approvals",async()=>{
  const effectiveAt=new Date(Date.now()+2*3600_000).toISOString();
  const global=await app.inject({method:"POST",url:"/v1/management/commission-rates",
    headers:{...auth(manager),"idempotency-key":"global-rate-proposal-0001"},
    payload:{action:"override",basisPoints:2500,effectiveAt,reason:"调整工程全局默认费率"}});
  expect(global.statusCode).toBe(200);
  expect(global.json()).toMatchObject({action:"override",basis_points:2500,state:"proposed"});
  const restored=await app.inject({method:"POST",url:"/v1/management/commission-rates",
    headers:{...auth(manager),"idempotency-key":"member-inherit-proposal-0001"},
    payload:{action:"inherit",memberId:a.memberId,effectiveAt,reason:"恢复会员继承全局费率"}});
  expect(restored.statusCode).toBe(200);
  expect(restored.json()).toMatchObject({action:"inherit",basis_points:null,state:"proposed"});
  expect((await app.inject({method:"POST",url:"/v1/management/commission-rates",
    headers:{...auth(manager),"idempotency-key":"member-inherit-proposal-0001"},
    payload:{action:"inherit",memberId:a.memberId,effectiveAt,reason:"恢复会员继承全局费率"}})).json())
    .toMatchObject({id:restored.json().id,alreadyCreated:true});
  expect((await app.inject({method:"POST",url:"/v1/management/commission-rates",
    headers:{...auth(manager),"idempotency-key":"invalid-inherit-proposal-01"},
    payload:{action:"inherit",basisPoints:2300,effectiveAt,reason:"无目标的继承操作无效"}})).statusCode).toBe(422);
  for(const proposal of [global,restored]){
    const self=await app.inject({method:"POST",url:`/v1/management/commission-rates/${proposal.json().id}/decision`,
      headers:{...auth(manager),"idempotency-key":`rate-self-${proposal.json().id}`},
      payload:{decision:"active",expectedVersion:1,reason:"同一提议人不得批准"}});
    expect(self.statusCode).toBe(403);
    const approval=await app.inject({method:"POST",url:`/v1/management/commission-rates/${proposal.json().id}/decision`,
      headers:{...auth(checker),"idempotency-key":`rate-check-${proposal.json().id}`},
      payload:{decision:"active",expectedVersion:1,reason:"独立复核新费率"}});
    expect(approval.statusCode).toBe(200);
    expect(approval.json().action).toBe(proposal.json().action);
  }
});

it("uses the database clock for fixture renewal and never shortens an existing term",async()=>{
  const before=(await app.inject({method:"GET",url:`/v1/management/members/${a.memberId}`,headers:auth(manager)})).json();
  expect(before.membershipPolicy).toMatchObject({kind:"engineering_calendar_v2",termMonths:12});
  const renewed=await app.inject({method:"POST",url:`/v1/management/members/${a.memberId}/membership`,headers:auth(manager),
    payload:{state:"active",term:"engineering_12_calendar_months",expectedVersion:before.member.version,reason:"工程资格续期测试"}});
  expect(renewed.statusCode).toBe(200);
  expect(new Date(renewed.json().expiresAt).getTime()).toBeGreaterThan(new Date(before.member.expiresAt).getTime());
  const shortened=await app.inject({method:"POST",url:`/v1/management/members/${a.memberId}/membership`,headers:auth(manager),
    payload:{state:"active",expiresAt:before.member.expiresAt,expectedVersion:renewed.json().version,reason:"尝试缩短现有资格"}});
  expect(shortened.statusCode).toBe(409);expect(shortened.json().code).toBe("MEMBERSHIP_EXPIRY_SHORTEN");
  const suspended=await app.inject({method:"POST",url:`/v1/management/members/${a.memberId}/membership`,headers:auth(manager),
    payload:{state:"suspended",expectedVersion:renewed.json().version,reason:"暂停保留原到期日期"}});
  expect(suspended.statusCode).toBe(200);expect(suspended.json().expiresAt).toBe(renewed.json().expiresAt);
  expect((await app.inject({method:"GET",url:"/v1/me/commercial-membership",headers:auth(a)})).json().eligible).toBe(false);
  const resumed=await app.inject({method:"POST",url:`/v1/management/members/${a.memberId}/membership`,headers:auth(manager),
    payload:{state:"active",term:"engineering_12_calendar_months",expectedVersion:suspended.json().version,reason:"恢复工程资格供后续测试"}});
  expect(resumed.statusCode).toBe(200);
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

it("renews twelve Shanghai calendar months at month ends without shortening lifetime grants",async()=>{
  for(const [suffix,initial,expected] of [
    ["january","2028-01-30T16:00:00.000Z","2029-01-30T16:00:00.000Z"],
    ["leap","2028-02-28T16:00:00.000Z","2029-02-27T16:00:00.000Z"]
  ]){
    const target=await identity(`calendar-${suffix}`);
    await pool.query(`INSERT INTO commercial_membership(member_id,state,effective_at,expires_at,changed_by,change_reason)
      VALUES($1,'active',now(),$2,'fixture','历史资格供月末续期测试')`,[target.memberId,initial]);
    const response=await app.inject({method:"POST",url:`/v1/management/members/${target.memberId}/membership`,headers:auth(manager),
      payload:{state:"active",term:"engineering_12_calendar_months",expectedVersion:1,reason:"上海日历月续期回归"}});
    expect(response.statusCode).toBe(200);expect(new Date(response.json().expiresAt).toISOString()).toBe(expected);
  }
  const lifetime=await identity("calendar-lifetime");
  await pool.query(`INSERT INTO commercial_membership(member_id,state,effective_at,expires_at,changed_by,change_reason)
    VALUES($1,'active',now(),NULL,'fixture','历史长期资格不可缩短')`,[lifetime.memberId]);
  const response=await app.inject({method:"POST",url:`/v1/management/members/${lifetime.memberId}/membership`,headers:auth(manager),
    payload:{state:"active",term:"engineering_12_calendar_months",expectedVersion:1,reason:"保护历史长期资格"}});
  expect(response.statusCode).toBe(200);expect(response.json().expiresAt).toBeNull();
});

it("keeps unapproved commercial qualification and attribution writes closed outside engineering environments",async()=>{
  const closed=new CommercialMembershipService(pool,new AuthorityService(pool,"test"),"production");
  await expect(closed.ensureCode(a.memberId)).rejects.toMatchObject({code:"COMMERCIAL_RULES_NOT_APPROVED"});
  await expect(closed.setMembership(manager.memberId,manager.principalId,c.memberId,{state:"active",
    expiresAt:"2027-09-12T00:00:00Z",expectedVersion:0,reason:"未获正式业务批准"}))
    .rejects.toMatchObject({code:"COMMERCIAL_RULES_NOT_APPROVED"});
  expect(await closed.myStatus(a.memberId)).toMatchObject({eligible:false,referralCode:null});
});

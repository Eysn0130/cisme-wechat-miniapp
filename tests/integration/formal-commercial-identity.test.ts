import { afterAll, beforeAll, expect, it } from 'vitest';
import { TEST_DATABASE_URL, resetDatabase, testPool } from '@cisme/testkit';
import { AuthorityService } from '../../services/api/src/authority';
import { CommercialMembershipService } from '../../services/api/src/commercialMembership';

const pool=testPool();
const authority=new AuthorityService(pool,'production');
const commercial=new CommercialMembershipService(pool,authority,'production');

async function wechatMember(label:string){
  const member=(await pool.query<{id:string}>(
    'INSERT INTO member(display_name) VALUES($1) RETURNING id',[label])).rows[0]!;
  const identity=(await pool.query<{id:string}>(`INSERT INTO wechat_identity
    (member_id,provider,app_id,openid,adapter) VALUES($1,'wechat_miniprogram','wx-formal-fixture',$2,'wechat') RETURNING id`,
    [member.id,`formal-${label}`])).rows[0]!;
  return {id:member.id,principal:`wechat_miniprogram:${identity.id}`};
}

async function grant(id:string,capability:string){
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,$2,'formal-fixture','isolated production-mode path','production','integration_fixture')`,[id,capability]);
}

beforeAll(async()=>{await resetDatabase(pool);});
afterAll(async()=>{await pool.end();});

it('uses formal WeChat identity, explicit expiry and an approved operator rate without engineering defaults',async()=>{
  const operator=await wechatMember('formal-operator');
  const reviewer=await wechatMember('formal-reviewer');
  const sponsor=await wechatMember('formal-sponsor');
  const buyer=await wechatMember('formal-buyer');
  await grant(operator.id,'member.manage');
  await grant(operator.id,'member.profile.read');
  await grant(operator.id,'commission.read');
  await grant(operator.id,'commission.rate.manage');
  await grant(reviewer.id,'commission.rate.approve');

  expect(await commercial.currentGlobalRate(operator.id)).toMatchObject({basisPoints:null,policyKind:'unconfigured'});
  await expect(commercial.setMembership(operator.id,operator.principal,sponsor.id,
    {state:'active',term:'engineering_12_calendar_months',expectedVersion:0,reason:'正式身份不可沿用工程期限'}))
    .rejects.toMatchObject({code:'MEMBERSHIP_TERM_UNAVAILABLE'});
  const expiry=new Date(Date.now()+180*24*3600_000).toISOString();
  const membership=await commercial.setMembership(operator.id,operator.principal,sponsor.id,
    {state:'active',expiresAt:expiry,expectedVersion:0,reason:'正式会员资格到期日'});
  expect(membership).toMatchObject({state:'active',policyKind:'operator_explicit'});
  expect(new Date(membership.expiresAt!).toISOString()).toBe(expiry);
  await expect(commercial.ensureCode(sponsor.id)).rejects.toMatchObject({code:'REFERRAL_POLICY_UNAVAILABLE'});

  const proposal=await commercial.proposeRate(operator.id,operator.principal,'formal-global-rate-0001',
    {action:'override',basisPoints:1750,reason:'正式运营全局费率提议'});
  expect(proposal).toMatchObject({basis_points:1750,state:'proposed'});
  await expect(commercial.approveRate(operator.id,operator.principal,proposal.id,'formal-self-approval-0001',
    {decision:'active',expectedVersion:1,reason:'不得自己复核费率'}))
    .rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
  const approved=await commercial.approveRate(reviewer.id,reviewer.principal,proposal.id,'formal-rate-review-0001',
    {decision:'active',expectedVersion:1,reason:'复核正式运营费率'});
  expect(approved).toMatchObject({basis_points:1750,state:'active'});

  // A previously reviewed and already effective rate represents the policy
  // currently in force. The new proposal above remains future effective.
  await pool.query(`INSERT INTO commission_rate_rule(member_id,action,basis_points,state,effective_at,
    proposed_effective_at,rule_version,created_by,approved_by,reason,decided_at)
    VALUES(NULL,'override',1800,'active',now()-interval '1 day',now()-interval '2 days',
      'operator-rate-v1',$1,$2,'先前已复核正式费率',now()-interval '1 day')`,
    [operator.principal,reviewer.principal]);
  expect(await commercial.currentGlobalRate(operator.id)).toMatchObject({basisPoints:1800,policyKind:'approved_rule'});
  const code=(await commercial.ensureCode(sponsor.id)).code;
  expect(await commercial.previewReferral(buyer.id,code)).toMatchObject({code,relationState:'unbound'});
  expect(await commercial.confirmReferral(buyer.id,buyer.principal,code,'formal-referral-0001'))
    .toMatchObject({confirmed:true,alreadyConfirmed:false});
  expect(await commercial.confirmReferral(buyer.id,buyer.principal,code,'formal-referral-replay-0001'))
    .toMatchObject({confirmed:true,alreadyConfirmed:true});
  const detail=await commercial.memberDetail(operator.id,sponsor.id);
  expect(detail.membershipPolicy).toMatchObject({kind:'operator_explicit',termMonths:null,rateOptions:[]});
  expect(detail.rate).toMatchObject({basisPoints:1800,source:'global'});
  expect((await pool.query("SELECT count(*)::int AS n FROM wechat_identity WHERE provider='dev_test'")).rows[0]!.n).toBe(0);
});

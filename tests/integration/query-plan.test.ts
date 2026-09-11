import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDatabase, testPool } from "@cisme/testkit";

const pool = testPool();
let memberId = "";
beforeAll(async () => {
  await resetDatabase(pool);
  memberId = (await pool.query("INSERT INTO member(display_name) VALUES ('plan-member') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO points_entry(member_id,entry_type,frozen_delta,business_key,occurred_at)
    SELECT $1,'grant_frozen',1,'plan-'||n,now()-(n||' seconds')::interval FROM generate_series(1,250) n`, [memberId]);
  await pool.query(`INSERT INTO qualification_fact(member_id,source,external_ref,occurred_at)
    SELECT $1,'plan','plan-'||n,now()-(n||' seconds')::interval FROM generate_series(1,250)n`, [memberId]);
  await pool.query(`INSERT INTO care_cycle(member_id,qualification_fact_id,phase,timezone,protocol_version,created_at)
    SELECT member_id,id,'completed','Asia/Shanghai','plan-v1',created_at FROM qualification_fact WHERE source='plan'`);
  await pool.query(`INSERT INTO eligibility_campaign(code,qualifying_milestone,capacity,reward_points,starts_at,ends_at,active)
    SELECT 'plan-'||n,'D7',1000,1,now()-interval '1 day',now()+interval '1 day',true FROM generate_series(1,250)n`);
  await pool.query(`INSERT INTO eligibility_decision(campaign_id,cycle_id,fact_key,eligible,reason_code,decided_at)
    SELECT campaign.id,cycle.id,campaign.code,true,'PLAN',now()
    FROM eligibility_campaign campaign JOIN qualification_fact fact ON fact.external_ref=campaign.code
    JOIN care_cycle cycle ON cycle.qualification_fact_id=fact.id WHERE campaign.code LIKE 'plan-%'`);
  await pool.query(`INSERT INTO eligibility_task(decision_id,campaign_id,member_id,expires_at)
    SELECT decision.id,decision.campaign_id,$1,now()+(right(campaign.code,length(campaign.code)-5)||' seconds')::interval
    FROM eligibility_decision decision JOIN eligibility_campaign campaign ON campaign.id=decision.campaign_id WHERE campaign.code LIKE 'plan-%'`, [memberId]);
  await pool.query(`INSERT INTO submission(member_id,status,post_url,platform_account,disclosure,created_at,updated_at)
    SELECT $1,'approved','https://plan.invalid/'||n,'plan','plan',now()-(n||' seconds')::interval,now()-(n||' seconds')::interval FROM generate_series(1,300)n`, [memberId]);
  await pool.query(`INSERT INTO consent_grant(submission_id,member_id,purpose,granted_at)
    SELECT id,member_id,'feed_readonly',created_at FROM submission WHERE platform_account='plan'`);
  await pool.query(`INSERT INTO feed_item(submission_id,member_id,title,excerpt,published_at,visible)
    SELECT id,member_id,'Plan','Plan',created_at,true FROM submission WHERE platform_account='plan'`);
  await pool.query("INSERT INTO review_case(submission_id,status,updated_at) SELECT id,'pending',created_at FROM submission WHERE platform_account='plan'");
  await pool.query(`INSERT INTO review_action(review_case_id,actor_principal_id,action,reason_code,created_at)
    SELECT (SELECT id FROM review_case ORDER BY id LIMIT 1),'plan','submit','PLAN',now()-(n||' seconds')::interval FROM generate_series(1,250)n`);
  await pool.query(`INSERT INTO community_comment(post_id,member_id,body,status,was_public,operation_id,created_at)
    SELECT 'brand-scalp-ritual',$1,'Plan comment','published',true,'plan-'||n,now()-(n||' seconds')::interval FROM generate_series(1,250)n`, [memberId]);
  await pool.query("INSERT INTO community_comment_like(member_id,comment_id) SELECT $1,id FROM community_comment WHERE post_id='brand-scalp-ritual'", [memberId]);
  await pool.query(`INSERT INTO outbox_event(event_type,aggregate_type,aggregate_id,aggregate_version,business_key,payload,occurred_at,next_attempt_at,processed_at)
    SELECT 'identity.accepted.v1','member',gen_random_uuid(),1,'plan-done-'||n,'{}',now(),now(),now() FROM generate_series(1,1000)n`);
  await pool.query(`INSERT INTO outbox_event(event_type,aggregate_type,aggregate_id,aggregate_version,business_key,payload,occurred_at,next_attempt_at)
    SELECT 'identity.accepted.v1','member',gen_random_uuid(),1,'plan-ready-'||n,'{}',now()-(n||' seconds')::interval,now()-interval '1 second' FROM generate_series(1,100)n`);
  await pool.query(`INSERT INTO media_object(submission_id,kind,object_key,mime_type,upload_state,is_current)
    SELECT id,'original','plan/'||id||'.jpg','image/jpeg','deleted',false FROM submission WHERE platform_account='plan'`);
  await pool.query(`INSERT INTO media_cleanup_queue(media_id,object_key,reason,next_attempt_at,processed_at)
    SELECT id,object_key,'replaced',now()-interval '1 second',CASE WHEN row_number() OVER(ORDER BY id)<=250 THEN now() ELSE NULL END
    FROM media_object WHERE object_key LIKE 'plan/%'`);
  await pool.query("ANALYZE points_entry,care_cycle,eligibility_task,consent_grant,feed_item,community_comment,community_comment_like,community_post_stats,review_action,outbox_event,media_cleanup_queue");
});
afterAll(async () => { await pool.end(); });

async function plan(sql: string, params: unknown[] = []) {
  const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  return JSON.stringify(result.rows[0]["QUERY PLAN"]);
}

describe("performance query plans", () => {
  it("uses the stable member pagination index", async () => {
    const client = await pool.connect();
    try {
      await client.query("SET enable_seqscan=off");
      const plan = await client.query("EXPLAIN (FORMAT JSON) SELECT id,occurred_at FROM points_entry WHERE member_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT 20", [memberId]);
      expect(JSON.stringify(plan.rows[0]["QUERY PLAN"])).toContain("points_entry_member_page_idx");
    } finally { client.release(); }
  });

  it("uses query-shaped indexes for member, feed and comment pages", async () => {
    expect(await plan("SELECT id FROM care_cycle WHERE member_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20", [memberId])).toContain("care_cycle_member_page_idx");
    expect(await plan("SELECT id FROM eligibility_task WHERE member_id=$1 ORDER BY expires_at DESC,id DESC LIMIT 20", [memberId])).toContain("eligibility_task_member_page_idx");
    expect(await plan("SELECT id FROM consent_grant WHERE member_id=$1 ORDER BY granted_at DESC,id DESC LIMIT 20", [memberId])).toContain("consent_grant_member_page_idx");
    expect(await plan("SELECT id FROM feed_item WHERE visible=true ORDER BY published_at DESC,id DESC LIMIT 20")).toContain("feed_item_visible_page_idx");
    expect(await plan("SELECT id FROM community_comment WHERE post_id='brand-scalp-ritual' ORDER BY created_at,id LIMIT 50")).toContain("community_comment_post");
    expect(await plan("SELECT comment_id FROM community_comment_like WHERE comment_id=(SELECT id FROM community_comment ORDER BY id LIMIT 1)")).toContain("community_comment_like_comment_idx");
    expect(await plan("SELECT id FROM review_action WHERE review_case_id=(SELECT review_case_id FROM review_action LIMIT 1) ORDER BY created_at DESC,id DESC LIMIT 20")).toContain("review_action_case_page_idx");
  });

  it("keeps exact community aggregates constant-time", async () => {
    const aggregate = await plan("SELECT like_count,save_count,comment_count,version FROM community_post_stats WHERE post_id='brand-scalp-ritual'");
    expect(aggregate).toContain("community_post_stats_pkey");
    expect((await pool.query("SELECT comment_count FROM community_post_stats WHERE post_id='brand-scalp-ritual'")).rows[0].comment_count).toBe(250);
  });

  it("uses partial ready-queue indexes", async () => {
    const outbox = await plan(`SELECT id FROM outbox_event WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND next_attempt_at<=now()
      AND event_type=ANY(ARRAY['identity.accepted.v1']) ORDER BY next_attempt_at,occurred_at,id LIMIT 50 FOR UPDATE SKIP LOCKED`);
    expect(outbox).toContain("outbox_event_worker_ready_idx");
    const cleanup = await plan(`SELECT id FROM media_cleanup_queue WHERE processed_at IS NULL AND dead_lettered_at IS NULL AND next_attempt_at<=now()
      AND (leased_until IS NULL OR leased_until<=now()) ORDER BY next_attempt_at,created_at,id LIMIT 50 FOR UPDATE SKIP LOCKED`);
    expect(cleanup).toContain("media_cleanup_worker_ready_idx");
  });
});

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, assertDisposableTarget, testPool } from "@cisme/testkit";
import { assertFinalSchemaContract } from "../../scripts/final-schema-contract";

const exec = promisify(execFile);
const adminUrl = new URL(TEST_DATABASE_URL);
adminUrl.pathname = "/postgres";
const databaseName = `cisme_migration_${randomUUID().replaceAll("-", "")}`;
const migrationUrl = new URL(adminUrl);
migrationUrl.pathname = `/${databaseName}`;
const admin = new pg.Pool({ connectionString: adminUrl.toString() });
let databaseCreated = false;
const openPools = new Set<pg.Pool>();
function migrationPool() { const pool = new pg.Pool({ connectionString: migrationUrl.toString() }); openPools.add(pool); return pool; }
async function closePool(pool: pg.Pool) { openPools.delete(pool); await pool.end(); }

beforeAll(async () => {
  const owned = testPool();
  try { await assertDisposableTarget(owned); } finally { await owned.end(); }
  await admin.query(`CREATE DATABASE ${databaseName}`);
  databaseCreated = true;
});
afterAll(async () => {
  try {
    for (const pool of openPools) await closePool(pool);
    if (databaseCreated) await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

describe("empty and N-1 database lifecycle", () => {
  it("migrates empty, rolls back latest, and reapplies", async () => {
    const env = { ...process.env, DATABASE_URL: migrationUrl.toString() };
    const migrationFiles = (await readdir("db/migrations")).filter((file) => file.endsWith(".sql")).sort();
    // Keep historical fixture round-trips at their named schema boundary.
    // Newer migrations are still exercised at the current tip, then removed
    // only inside this separately owned disposable lifecycle database.
    let migrationTip = migrationFiles.at(-1)!;
    const migrate = async (direction:"up"|"down") => {
      const result = await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", direction], { env });
      if(direction === "up")for(const newer of migrationFiles.filter(name=>name>migrationTip).reverse()){
        const rolled = await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "down"], { env });
        expect(rolled.stdout).toContain(`rolled back ${newer}`);
      }
      return result;
    };
    let migrationCount = migrationFiles.length;
    let extensionCount = migrationFiles.filter((file) => file >= "202609120002_commercial_membership_referral.sql").length;
    await migrate('up');
    let pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount);
    expect(await assertFinalSchemaContract(pool)).toEqual({tables:43,constraints:49,indexes:36,triggers:36});
    const damaged=await pool.connect();
    try{
      await damaged.query("BEGIN");
      await damaged.query("ALTER TABLE commission_rate_rule DROP CONSTRAINT commission_rate_request_pair_check");
      await expect(assertFinalSchemaContract(damaged)).rejects.toThrow("FINAL_SCHEMA_CONSTRAINT_MISSING:commission_rate_rule.commission_rate_request_pair_check");
    }finally{await damaged.query("ROLLBACK");damaged.release();}
    expect((await pool.query("SELECT to_regclass('public.community_comment') name")).rows[0].name).toBe("community_comment");
    expect((await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='share_link_target_type_check'")).rows[0].definition).toContain("invite");
    expect((await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='share_link_invite_target_check'")).rows[0].definition).toContain("home");
    expect((await pool.query("SELECT to_regclass('public.points_entry') name")).rows[0].name).toBe("points_entry");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='feed_item' AND column_name='ai_usage'")).rowCount).toBe(1);
    expect((await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='media_hash_unique'")).rows[0].indexdef).toContain("is_current");
    expect((await pool.query("SELECT to_regclass('public.share_attribution') name")).rows[0].name).toBe("share_attribution");
    expect((await pool.query("SELECT to_regclass('public.care_cycle_pause') name")).rows[0].name).toBe("care_cycle_pause");
    expect((await pool.query("SELECT to_regclass('public.points_action_request') name")).rows[0].name).toBe("points_action_request");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='emergency_switch' AND column_name='version'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='outbox_event' AND column_name='dead_lettered_at'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='outbox_event' AND column_name='processing_outcome'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='media_cleanup_queue' AND column_name='next_attempt_at'")).rowCount).toBe(1);
    expect((await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='media_cleanup_queue_reason_check'")).rows[0].definition).toContain("authorization_expired");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='eligibility_campaign' AND column_name='version'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='care_record' AND column_name='self_assessment'")).rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('public.care_record_step') name")).rows[0].name).toBe("care_record_step");
    expect((await pool.query("SELECT to_regclass('public.member_delivery_address') name")).rows[0].name).toBe("member_delivery_address");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='media_cleanup_queue' AND column_name='leased_until'")).rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('public.points_entry_member_page_idx') name")).rows[0].name).toBe("points_entry_member_page_idx");
    expect((await pool.query("SELECT to_regclass('public.community_post_stats') name")).rows[0].name).toBe("community_post_stats");
    expect((await pool.query("SELECT to_regclass('public.processing_purpose') name")).rows[0].name).toBe("processing_purpose");
    expect((await pool.query("SELECT to_regclass('public.data_retention_policy') name")).rows[0].name).toBe("data_retention_policy");
    expect((await pool.query("SELECT to_regclass('public.processor_registry') name")).rows[0].name).toBe("processor_registry");
    expect((await pool.query("SELECT to_regclass('public.consent_receipt') name")).rows[0].name).toBe("consent_receipt");
    expect((await pool.query("SELECT to_regclass('public.legal_hold') name")).rows[0].name).toBe("legal_hold");
    expect((await pool.query("SELECT to_regclass('public.data_export_job') name")).rows[0].name).toBe("data_export_job");
    expect((await pool.query("SELECT to_regclass('public.data_erasure_job') name")).rows[0].name).toBe("data_erasure_job");
    expect((await pool.query("SELECT to_regclass('public.privacy_request_event') name")).rows[0].name).toBe("privacy_request_event");
    expect((await pool.query("SELECT to_regclass('public.ugc_post') name")).rows[0].name).toBe("ugc_post");
    expect((await pool.query("SELECT to_regclass('public.moderation_case') name")).rows[0].name).toBe("moderation_case");
    expect((await pool.query("SELECT to_regclass('public.authority_grant') name")).rows[0].name).toBe("authority_grant");
    expect((await pool.query("SELECT to_regclass('public.support_conversation') name")).rows[0].name).toBe("support_conversation");
    expect((await pool.query("SELECT to_regclass('public.support_message') name")).rows[0].name).toBe("support_message");
    expect((await pool.query("SELECT to_regclass('public.support_presence') name")).rows[0].name).toBe("support_presence");
    expect((await pool.query("SELECT to_regclass('public.support_operator_profile') name")).rows[0].name).toBe("support_operator_profile");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='support_message' AND column_name='content_type'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='wechat_identity' AND column_name='provider'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='authority_grant' AND column_name='environment'")).rowCount).toBe(1);
    expect((await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='authority_grant_one_active_capability'")).rows[0].indexdef).toContain("environment");
    expect((await pool.query("SELECT pg_get_functiondef(oid) definition FROM pg_proc WHERE proname='audit_authority_grant_change'")).rows[0].definition).toContain("grantSource");
    for (const table of ["catalog_product","catalog_sku","catalog_price","catalog_inventory_level","catalog_inventory_adjustment","catalog_qualification_decision"])
      expect((await pool.query("SELECT to_regclass($1) name", [`public.${table}`])).rows[0].name).toBe(table);
    for (const table of ["commerce_checkout_quote","commerce_order","commerce_order_line","commerce_order_address","commerce_inventory_reservation","commerce_order_transition"])
      expect((await pool.query("SELECT to_regclass($1) name", [`public.${table}`])).rows[0].name).toBe(table);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='catalog_inventory_level' AND column_name='reserved_quantity'")).rowCount).toBe(1);
    expect((await pool.query("SELECT count(*)::int count FROM catalog_product WHERE source_kind='legacy_preview' AND qualification_status='pending' AND publication_status='draft'")).rows[0].count).toBe(3);
    expect((await pool.query("SELECT count(*)::int count FROM catalog_sku s JOIN catalog_price p ON p.sku_id=s.id JOIN catalog_inventory_level i ON i.sku_id=s.id WHERE i.stock_on_hand=0")).rows[0].count).toBe(3);
    //111 adds only approved image paths. Down must not silently rewrite products in use.
    expect(migrationTip).toBe('202611100003_commerce_approved_media.sql');
    const imageConstraint=async()=>(await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='catalog_product_image_path_check'")).rows[0].definition as string;
    expect(await imageConstraint()).toContain('/assets/commerce/product1-glass-v4b.jpg');
    expect(await imageConstraint()).toContain('/assets/commerce/product2-glass-v4b.jpg');
    const catalogBeforeMediaRollback=(await pool.query('SELECT id,image_path FROM catalog_product ORDER BY id LIMIT 1')).rows[0];
    await pool.query('UPDATE catalog_product SET image_path=$2 WHERE id=$1',[catalogBeforeMediaRollback.id,'/assets/commerce/product1-glass-v4b.jpg']);
    await closePool(pool);await expect(migrate('down')).rejects.toThrow();pool=migrationPool();
    await pool.query('UPDATE catalog_product SET image_path=$2 WHERE id=$1',[catalogBeforeMediaRollback.id,catalogBeforeMediaRollback.image_path]);
    await closePool(pool);await migrate('down');pool=migrationPool();expect(await imageConstraint()).not.toContain('/assets/commerce/');
    await closePool(pool);await migrate('up');pool=migrationPool();expect(await imageConstraint()).toContain('/assets/commerce/product1-glass-v4b.jpg');
    await closePool(pool);await migrate('down');pool=migrationPool();migrationCount-=1;extensionCount-=1;migrationTip='202611040004_ugc_comment_likes.sql';

    //110 adds empty owner-scoped comment likes without rewriting existing posts.
    expect(migrationTip).toBe('202611040004_ugc_comment_likes.sql');
    const commentLikeTable=async()=> (await pool.query("SELECT to_regclass('public.ugc_comment_like') name")).rows[0].name;
    expect(await commentLikeTable()).toBe('ugc_comment_like');
    await closePool(pool);await migrate('down');pool=migrationPool();expect(await commentLikeTable()).toBeNull();
    await closePool(pool);await migrate('up');pool=migrationPool();expect(await commentLikeTable()).toBe('ugc_comment_like');
    await closePool(pool);await migrate('down');pool=migrationPool();migrationCount-=1;extensionCount-=1;migrationTip='202611040003_official_editorial_publisher.sql';

    //109 separates the public publisher without inventing a member identity.
    expect(migrationTip).toBe('202611040003_official_editorial_publisher.sql');
    const publisherColumn=async()=>(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='editorial_article' AND column_name='publisher_id'")).rows;
    expect(await publisherColumn()).toHaveLength(1);
    expect((await pool.query('SELECT * FROM editorial_publisher')).rows).toEqual([{id:'cisme-scalp-lab',biography:'',profile_revision:0}]);
    await closePool(pool);await migrate('down');pool=migrationPool();expect(await publisherColumn()).toEqual([]);
    await closePool(pool);await migrate('up');pool=migrationPool();expect(await publisherColumn()).toHaveLength(1);
    await closePool(pool);await migrate('down');pool=migrationPool();migrationCount-=1;extensionCount-=1;migrationTip='202611040002_community_biography.sql';

    //108 adds an independent owner biography without changing nickname review.
    expect(migrationTip).toBe('202611040002_community_biography.sql');
    const biographyColumns=async()=>(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='member_profile' AND column_name IN ('community_bio','community_bio_revision')")).rows;
    expect(await biographyColumns()).toHaveLength(2);
    const bioClient=await pool.connect();
    try{
      await bioClient.query('BEGIN');
      const owner=(await bioClient.query("INSERT INTO member(display_name) VALUES('synthetic bio lifecycle') RETURNING id")).rows[0].id;
      await bioClient.query("INSERT INTO member_profile(member_id,handle_source,community_bio,community_bio_revision) VALUES($1,'self_reported','synthetic saved bio',1)",[owner]);
      const down=(await readFile('db/migrations/202611040002_community_biography.sql','utf8')).split('-- migrate:down')[1]!;
      await expect(bioClient.query(down)).rejects.toMatchObject({message:'COMMUNITY_BIO_ROLLBACK_REQUIRES_DATA_PRESERVATION'});
    }finally{await bioClient.query('ROLLBACK');bioClient.release();}
    await closePool(pool);await migrate('down');pool=migrationPool();expect(await biographyColumns()).toEqual([]);
    await closePool(pool);await migrate('up');pool=migrationPool();expect(await biographyColumns()).toHaveLength(2);
    await closePool(pool);await migrate('down');pool=migrationPool();migrationCount-=1;extensionCount-=1;migrationTip='202611040001_ugc_synchronous_image_safety.sql';

    //107 names the real synchronous WeChat provider, without changing scans.
    const providerConstraint=async()=>String((await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='ugc_safety_scan_provider_check'")).rows[0].definition);
    expect(await providerConstraint()).toContain('wechat_v1_sync');
    await closePool(pool);await migrate('down');pool=migrationPool();expect(await providerConstraint()).not.toContain('wechat_v1_sync');
    await closePool(pool);await migrate('up');pool=migrationPool();expect(await providerConstraint()).toContain('wechat_v1_sync');
    await closePool(pool);await migrate('down');pool=migrationPool();migrationCount-=1;extensionCount-=1;migrationTip='202611030001_direct_publication_lookup.sql';

    //106 adds only the current direct-publication audit lookup index.
    expect(migrationTip).toBe('202611030001_direct_publication_lookup.sql');
    const directIndex=async()=>(await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='ugc_direct_publication_intent_idx'")).rows;
    expect(await directIndex()).toEqual([expect.objectContaining({indexdef:expect.stringContaining("'directPublication'::text")} )]);
    await closePool(pool);await migrate('down');pool=migrationPool();
    expect(await directIndex()).toEqual([]);
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount-1);
    await closePool(pool);await migrate('up');pool=migrationPool();
    expect(await directIndex()).toHaveLength(1);
    await closePool(pool);await migrate('down');pool=migrationPool();
    migrationCount-=1;extensionCount-=1;migrationTip='202611020001_ugc_publish_intent.sql';

    //105 changes only the post guard. It preserves immutable historical
    // declarations and refuses down once a publish-action fact would be lost.
    expect(migrationTip).toBe('202611020001_ugc_publish_intent.sql');
    const publicationGuard=async()=>String((await pool.query("SELECT pg_get_functiondef('guard_ugc_post_update()'::regprocedure) AS definition")).rows[0].definition);
    expect(await publicationGuard()).not.toContain('rights_ok');
    expect(await publicationGuard()).toContain('consent_ok IS DISTINCT FROM true');
    const immutableGuard=String((await pool.query("SELECT pg_get_functiondef('guard_ugc_revision_mutation()'::regprocedure) AS definition")).rows[0].definition);
    expect(immutableGuard).toContain('NEW.public_consent_confirmed');
    const intentClient=await pool.connect();
    try{
      await intentClient.query('BEGIN');
      await intentClient.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES('synthetic-105','ugc.post_submitted','ugc_post',$1,'SYNTHETIC_FIXTURE',$2,gen_random_uuid()::text)`,
        [randomUUID(),{publicConsentSource:'publish_action'}]);
      const down=(await readFile('db/migrations/202611020001_ugc_publish_intent.sql','utf8')).split('-- migrate:down')[1]!;
      await expect(intentClient.query(down)).rejects.toMatchObject({message:'UGC_PUBLISH_INTENT_ROLLBACK_REQUIRES_DATA_PRESERVATION'});
    }finally{await intentClient.query('ROLLBACK');intentClient.release();}
    await closePool(pool);await migrate('down');pool=migrationPool();
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount-1);
    expect(await publicationGuard()).toContain('rights_ok IS DISTINCT FROM true');
    await closePool(pool);await migrate('up');pool=migrationPool();
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount);
    expect(await publicationGuard()).not.toContain('rights_ok');
    await closePool(pool);await migrate('down');pool=migrationPool();
    migrationCount-=1;extensionCount-=1;migrationTip='202610310001_support_ai_human_collaboration.sql';

    // Latest104 adds question-scoped collaboration metadata without changing prior rows.
    expect(migrationTip).toBe('202610310001_support_ai_human_collaboration.sql');
    const supportGuard=async()=>String((await pool.query("SELECT pg_get_functiondef('enforce_support_conversation_transition()'::regprocedure) AS definition")).rows[0].definition);
    expect(await supportGuard()).toContain('cisme.support_resume_ai_conversation_id');
    expect(await supportGuard()).toContain('cisme.support_human_request_transition');
    await closePool(pool);await migrate('down');pool=migrationPool();
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount-1);
    expect(await supportGuard()).toContain('cisme.support_resume_ai_conversation_id');
    expect(await supportGuard()).not.toContain('cisme.support_human_request_transition');
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='support_message' AND column_name='reply_to_message_id'")).rowCount).toBe(0);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='daily_care_record' AND column_name='care_day'")).rowCount).toBe(1);
    await closePool(pool);await migrate('up');pool=migrationPool();
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount);
    expect(await supportGuard()).toContain('cisme.support_resume_ai_conversation_id');
    expect(await supportGuard()).toContain('cisme.support_human_request_transition');

    // Migration99 is independent from the existing98 article facts. Verify
    // its empty round-trip, then its comment preservation refusal, before
    // testing the older article-evidence rollback guard.
    for(const table of ['editorial_article','editorial_article_revision'])
      expect((await pool.query('SELECT to_regclass($1) name',[`public.${table}`])).rows[0].name).toBe(table);
    const capabilityNames=async()=>{
      const definition=(await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='authority_grant'::regclass AND conname='authority_grant_capability_check'")).rows[0].definition as string;
      return [...definition.matchAll(/'([a-z][a-z_.]+)'/g)].map(match=>match[1]!).sort();
    };
    const extendedCapabilities=await capabilityNames();
    expect(extendedCapabilities).toContain('editorial.manage');
    const evidenceOwner=(await pool.query("INSERT INTO member(display_name) VALUES('synthetic migration evidence author') RETURNING id")).rows[0].id;
    const evidence=(await pool.query(`INSERT INTO editorial_article(external_ref,author_member_id,author_display_name,title,excerpt,body,
      authorization_ref,rights_evidence,content_sha256,status,published_by,published_principal_id)
      VALUES('synthetic-migration-preservation',$1,'合成测试作者','合成测试标题','','合成测试正文','synthetic-test','{}',$2,'draft',$1,'synthetic-test') RETURNING id`,
      [evidenceOwner,'a'.repeat(64)])).rows[0].id;
    const rollbackFrom=migrationTip;
    migrationTip='202610300001_daily_care_daily_latest.sql';
    for(const newer of migrationFiles.filter(name=>name>migrationTip&&name<=rollbackFrom).reverse()){
      await closePool(pool);const rolled=await migrate('down');pool=migrationPool();
      expect(rolled.stdout).toContain(`rolled back ${newer}`);
      migrationCount-=1;extensionCount-=1;
    }
    //101 preserves every original100 column while selecting only one live
    // record per owner/day; already suppressed QA/privacy rows stay excluded.
    expect((await pool.query("SELECT to_regclass('public.daily_care_record_revision') name")).rows[0].name).toBe('daily_care_record_revision');
    await closePool(pool);await migrate('down');pool=migrationPool();
    migrationCount-=1;extensionCount-=1;
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='daily_care_record' AND column_name='care_day'")).rowCount).toBe(0);
    const legacy=[];
    for(let n=0;n<4;n++)legacy.push((await pool.query(`INSERT INTO daily_care_record(member_id,operation_id,request_sha256,completed_at,
      protocol_version,step_codes,self_assessment,suppressed_at) VALUES($1,$2,$3,$4,'daily-care-v1',ARRAY['00','01','02','03'],'neutral',$5)
      RETURNING to_jsonb(daily_care_record) AS row`,[evidenceOwner,randomUUID(),'d'.repeat(64),new Date(Date.UTC(2026,9,29,n)),n>=2?new Date('2026-10-29T05:00:00Z'):null])).rows[0].row);
    await closePool(pool);await migrate('up');pool=migrationPool();
    const migrated=(await pool.query(`SELECT to_jsonb(d)-ARRAY['care_day','version','updated_at','latest_operation_id','deleted_at','superseded_by'] AS row
      FROM daily_care_record d WHERE member_id=$1 ORDER BY completed_at,id`,[evidenceOwner])).rows.map(r=>r.row);
    expect(migrated).toEqual(legacy);
    expect((await pool.query('SELECT count(*)::int n FROM daily_care_record_revision WHERE member_id=$1',[evidenceOwner])).rows[0].n).toBe(4);
    const current=(await pool.query('SELECT id FROM daily_care_record WHERE member_id=$1 AND suppressed_at IS NULL AND superseded_by IS NULL',[evidenceOwner])).rows;
    expect(current).toEqual([{id:legacy[1].id}]);
    expect((await pool.query('SELECT id FROM daily_care_record WHERE member_id=$1 AND suppressed_at IS NOT NULL ORDER BY completed_at',[evidenceOwner])).rows.map(r=>r.id)).toEqual([legacy[2].id,legacy[3].id]);
    await closePool(pool);await migrate('down');pool=migrationPool();
    expect((await pool.query('SELECT to_jsonb(d) AS row FROM daily_care_record d WHERE member_id=$1 ORDER BY completed_at,id',[evidenceOwner])).rows.map(r=>r.row)).toEqual(legacy);
    await pool.query('DELETE FROM daily_care_record WHERE member_id=$1',[evidenceOwner]);
    expect((await pool.query("SELECT to_regclass('public.daily_care_record') name")).rows[0].name).toBe('daily_care_record');
    const daily=(await pool.query(`INSERT INTO daily_care_record(member_id,operation_id,request_sha256,protocol_version,step_codes,self_assessment)
      VALUES($1,$2,$3,'daily-care-v1',ARRAY['00','01','02','03'],'comfortable') RETURNING id`,[evidenceOwner,randomUUID(),'c'.repeat(64)])).rows[0].id;
    await expect(migrate('down')).rejects.toMatchObject({stderr:expect.stringContaining('DAILY_CARE_RECORDS_EXIST')});
    expect((await pool.query('SELECT step_codes FROM daily_care_record WHERE id=$1',[daily])).rows[0].step_codes).toEqual(['00','01','02','03']);
    await pool.query('DELETE FROM daily_care_record WHERE id=$1',[daily]);await closePool(pool);
    await migrate('down');pool=migrationPool();
    expect((await pool.query("SELECT to_regclass('public.daily_care_record') name")).rows[0].name).toBeNull();
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount-1);
    await closePool(pool);await migrate('up');await migrate('down');pool=migrationPool();
    expect((await pool.query("SELECT to_regclass('public.daily_care_record') name")).rows[0].name).toBe('daily_care_record');
    await closePool(pool);await migrate('down');pool=migrationPool();migrationCount-=1;extensionCount-=1;
    const commentTables=['editorial_comment','editorial_comment_like','editorial_comment_policy','editorial_comment_report','editorial_comment_safety_scan','editorial_comment_scan_claim'];
    for(const table of commentTables)expect((await pool.query('SELECT to_regclass($1) name',[`public.${table}`])).rows[0].name).toBe(table);
    await closePool(pool);
    await migrate('down');
    pool=migrationPool();
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount-1);
    for(const table of commentTables)expect((await pool.query('SELECT to_regclass($1) name',[`public.${table}`])).rows[0].name).toBeNull();
    expect((await pool.query('SELECT body FROM editorial_article WHERE id=$1',[evidence])).rows[0].body).toBe('合成测试正文');
    expect(await capabilityNames()).toEqual(extendedCapabilities);
    await closePool(pool);
    await migrate('up');
    await migrate('down');
    // Keep the independent99 rollback assertions below targeted at99.
    await migrate('down');
    pool=migrationPool();
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount);
    for(const table of commentTables)expect((await pool.query('SELECT to_regclass($1) name',[`public.${table}`])).rows[0].name).toBe(table);
    const comment=(await pool.query(`INSERT INTO editorial_comment(article_id,author_member_id,body,operation_id,request_sha256)
      VALUES($1,$2,'需要保留的合成评论',$3,$4) RETURNING id`,[evidence,evidenceOwner,randomUUID(),'b'.repeat(64)])).rows[0].id;
    await expect(migrate('down')).rejects.toMatchObject({
      stderr:expect.stringContaining('EDITORIAL_COMMENT_ROLLBACK_REQUIRES_DATA_PRESERVATION')
    });
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount);
    expect((await pool.query('SELECT body,state FROM editorial_comment WHERE id=$1',[comment])).rows[0]).toEqual({body:'需要保留的合成评论',state:'pending_review'});
    expect((await pool.query('SELECT id FROM editorial_article WHERE id=$1',[evidence])).rowCount).toBe(1);
    // Only explicit disposable-fixture cleanup makes the empty99 down valid.
    await pool.query('DELETE FROM editorial_comment WHERE id=$1',[comment]);await closePool(pool);
    await migrate('down');
    pool=migrationPool();migrationCount-=1;extensionCount-=1;
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount);
    for(const table of commentTables)expect((await pool.query('SELECT to_regclass($1) name',[`public.${table}`])).rows[0].name).toBeNull();
    expect(await capabilityNames()).toEqual(extendedCapabilities);
    // Now the latest remaining migration is98: its original article evidence
    // must still prevent rollback exactly as before99 was introduced.
    await expect(migrate('down')).rejects.toMatchObject({
      stderr:expect.stringContaining('EDITORIAL_EVIDENCE_REQUIRES_DATA_PRESERVATION')
    });
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount);
    expect((await pool.query('SELECT id FROM editorial_article WHERE id=$1',[evidence])).rowCount).toBe(1);
    await pool.query('DELETE FROM editorial_article WHERE id=$1',[evidence]);
    await closePool(pool);
    await migrate('down');
    pool=migrationPool();
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount-1);
    for(const table of ['editorial_article','editorial_article_revision'])
      expect((await pool.query('SELECT to_regclass($1) name',[`public.${table}`])).rows[0].name).toBeNull();
    expect(await capabilityNames()).toEqual(extendedCapabilities.filter(name=>name!=='editorial.manage'));
    expect((await pool.query("SELECT to_regclass('public.commerce_wechat_receipt_watch_control') name")).rows[0].name).toBe('commerce_wechat_receipt_watch_control');
    await closePool(pool);
    await migrate('up');
    // up reapplies the full latest set (98+99+100+101); remove empty101/100/99 before
    // checking the independently restored98 tables/capability set below.
    await migrate('down');
    await migrate('down');
    await migrate('down');
    pool=migrationPool();
    expect((await pool.query('SELECT count(*)::int count FROM schema_migration')).rows[0].count).toBe(migrationCount);
    for(const table of ['editorial_article','editorial_article_revision'])
      expect((await pool.query('SELECT to_regclass($1) name',[`public.${table}`])).rows[0].name).toBe(table);
    expect(await capabilityNames()).toEqual(extendedCapabilities);
    await closePool(pool);
    await migrate('down');
    pool=migrationPool();migrationCount-=1;extensionCount-=1;

    // Round-trip the watcher and observation separately before the older
    // catalog migration guard. This fixture has no receipt observations.
    await closePool(pool);
    await migrate('down');
    pool = migrationPool(); migrationCount -= 1; extensionCount -= 1;
    expect((await pool.query("SELECT to_regclass('public.commerce_wechat_receipt_watch_control') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.commerce_wechat_receipt_observation') name")).rows[0].name).toBe('commerce_wechat_receipt_observation');
    await closePool(pool);
    await migrate('down');
    pool = migrationPool(); migrationCount -= 1; extensionCount -= 1;
    expect((await pool.query("SELECT to_regclass('public.commerce_wechat_receipt_observation') name")).rows[0].name).toBeNull();
    await pool.query("UPDATE catalog_product SET version=3,updated_by='synthetic-rollback-guard' WHERE id='c1000000-0000-4000-8000-000000000001'");
    await expect(migrate('down')).rejects.toMatchObject({
      stderr: expect.stringContaining("CATALOG_IMAGE_RETIREMENT_ROLLBACK_REQUIRES_DATA_PRESERVATION")
    });
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount);
    await pool.query("UPDATE catalog_product SET version=2,updated_by='migration:retire-unapproved-images' WHERE id='c1000000-0000-4000-8000-000000000001'");
    expect((await pool.query("SELECT active FROM processing_purpose WHERE code='support_service'")).rows[0].active).toBe(false);
    expect((await pool.query("SELECT enabled FROM emergency_switch WHERE key='community'")).rows[0].enabled).toBe(false);
    expect((await pool.query("SELECT count(*)::int count FROM emergency_switch")).rows[0].count).toBe(8);
    await closePool(pool);

    // Roll back this commercial/UGC extension before checking the older
    // lifecycle milestones below. Each new migration must round-trip alone.
    for (let step = 1; step <= extensionCount; step += 1) {
      await migrate('down');
      pool = migrationPool();
      expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - step);
      await closePool(pool);
    }
    pool = migrationPool();
    expect((await pool.query("SELECT to_regclass('public.commercial_membership') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.commission_payment_inbox') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.ugc_go_live_approval') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.ugc_safety_scan') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.ugc_comment_safety_scan') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.support_presence') name")).rows[0].name).toBe('support_presence');
    await closePool(pool);

    await migrate('down');
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 1);
    expect((await pool.query("SELECT to_regclass('public.support_presence') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.support_operator_profile') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='support_message' AND column_name='content_type'")).rowCount).toBe(0);
    expect((await pool.query("SELECT to_regclass('public.commerce_order') name")).rows[0].name).toBe("commerce_order");
    expect((await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='media_hash_unique'")).rows[0].indexdef).toContain("is_current");
    await closePool(pool);

    await migrate('down');
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 2);
    expect((await pool.query("SELECT to_regclass('public.commerce_order') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='catalog_inventory_level' AND column_name='reserved_quantity'")).rowCount).toBe(0);
    expect((await pool.query("SELECT to_regclass('public.catalog_product') name")).rows[0].name).toBe("catalog_product");
    await closePool(pool);

    await migrate('down');
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 3);
    expect((await pool.query("SELECT to_regclass('public.catalog_product') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='wechat_identity' AND column_name='provider'")).rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('public.support_conversation') name")).rows[0].name).toBe("support_conversation");
    await closePool(pool);

    await migrate('down');
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 4);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='wechat_identity' AND column_name='provider'")).rowCount).toBe(0);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='authority_grant' AND column_name='environment'")).rowCount).toBe(0);
    expect((await pool.query("SELECT to_regclass('public.support_conversation') name")).rows[0].name).toBe("support_conversation");
    await closePool(pool);

    await migrate('down');
    pool = migrationPool();
    expect((await pool.query("SELECT to_regclass('public.member') name")).rows[0].name).toBe("member");
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 5);
    expect((await pool.query("SELECT count(*)::int count FROM emergency_switch")).rows[0].count).toBe(8);
    expect((await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='media_hash_unique'")).rows[0].indexdef).toContain("is_current");
    expect((await pool.query("SELECT to_regclass('public.share_attribution') name")).rows[0].name).toBe("share_attribution");
    expect((await pool.query("SELECT to_regclass('public.care_cycle_pause') name")).rows[0].name).toBe("care_cycle_pause");
    expect((await pool.query("SELECT to_regclass('public.points_action_request') name")).rows[0].name).toBe("points_action_request");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='emergency_switch' AND column_name='version'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='outbox_event' AND column_name='dead_lettered_at'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='outbox_event' AND column_name='processing_outcome'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='media_cleanup_queue' AND column_name='next_attempt_at'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='eligibility_campaign' AND column_name='version'")).rowCount).toBe(1);
    expect((await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='media_cleanup_queue_reason_check'")).rows[0].definition).toContain("authorization_expired");
    expect((await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='share_link_target_type_check'")).rows[0].definition).toContain("invite");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='member_profile' AND column_name='avatar_revision'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='care_record' AND column_name='self_assessment'")).rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('public.care_record_step') name")).rows[0].name).toBe("care_record_step");
    expect((await pool.query("SELECT to_regclass('public.member_delivery_address') name")).rows[0].name).toBe("member_delivery_address");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='media_cleanup_queue' AND column_name='leased_until'")).rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('public.points_entry_member_page_idx') name")).rows[0].name).toBe("points_entry_member_page_idx");
    expect((await pool.query("SELECT to_regclass('public.community_post_stats') name")).rows[0].name).toBe("community_post_stats");
    expect((await pool.query("SELECT to_regclass('public.processing_purpose') name")).rows[0].name).toBe("processing_purpose");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='privacy_request' AND column_name='version'")).rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('public.support_conversation') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.support_message') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.authority_grant') name")).rows[0].name).toBe("authority_grant");
    expect((await pool.query("SELECT 1 FROM processing_purpose WHERE code='support_service'")).rowCount).toBe(0);
    expect((await pool.query("SELECT to_regclass('public.ugc_post') name")).rows[0].name).toBe("ugc_post");
    await closePool(pool);

    await migrate('down');
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 6);
    expect((await pool.query("SELECT to_regclass('public.authority_grant') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.ugc_post') name")).rows[0].name).toBe("ugc_post");
    await closePool(pool);

    await migrate('down');
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 7);
    expect((await pool.query("SELECT to_regclass('public.ugc_post') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT 1 FROM emergency_switch WHERE key='community'")).rowCount).toBe(0);
    await pool.query(`INSERT INTO data_retention_policy(code,data_class,trigger_event,duration_days,disposition,legal_basis)
      VALUES('rollback_guard','synthetic rollback guard','test finished',1,'delete','test-only rollback preservation')`);
    await expect(migrate('down')).rejects.toMatchObject({
      stderr: expect.stringContaining("PRIVACY_LIFECYCLE_ROLLBACK_REQUIRES_DATA_PRESERVATION")
    });
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 7);
    await pool.query("DELETE FROM data_retention_policy WHERE code='rollback_guard'");
    await closePool(pool);

    await migrate('down');
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 8);
    expect((await pool.query("SELECT to_regclass('public.data_retention_policy') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='privacy_request' AND column_name='version'")).rowCount).toBe(0);
    expect((await pool.query("SELECT to_regclass('public.member') name")).rows[0].name).toBe("member");
    expect((await pool.query("SELECT count(*)::int count FROM emergency_switch")).rows[0].count).toBe(7);
    await closePool(pool);

    migrationTip=migrationFiles.at(-1)!;
    await migrate('up');
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationFiles.length);
    for(const table of ['editorial_article','editorial_article_revision'])
      expect((await pool.query('SELECT to_regclass($1) name',[`public.${table}`])).rows[0].name).toBe(table);
    expect(await capabilityNames()).toEqual(extendedCapabilities);
    expect((await pool.query("SELECT to_regclass('public.community_comment') name")).rows[0].name).toBe("community_comment");
    expect((await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='share_link_target_type_check'")).rows[0].definition).toContain("invite");
    expect((await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='share_link_invite_target_check'")).rows[0].definition).toContain("home");
    expect((await pool.query("SELECT count(*)::int count FROM emergency_switch")).rows[0].count).toBe(8);
    expect((await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='media_hash_unique'")).rows[0].indexdef).toContain("is_current");
    expect((await pool.query("SELECT to_regclass('public.share_attribution') name")).rows[0].name).toBe("share_attribution");
    expect((await pool.query("SELECT to_regclass('public.care_cycle_pause') name")).rows[0].name).toBe("care_cycle_pause");
    expect((await pool.query("SELECT to_regclass('public.points_action_request') name")).rows[0].name).toBe("points_action_request");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='emergency_switch' AND column_name='version'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='outbox_event' AND column_name='dead_lettered_at'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='outbox_event' AND column_name='processing_outcome'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='media_cleanup_queue' AND column_name='next_attempt_at'")).rowCount).toBe(1);
    expect((await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='media_cleanup_queue_reason_check'")).rows[0].definition).toContain("authorization_expired");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='eligibility_campaign' AND column_name='version'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='member_profile' AND column_name='avatar_revision'")).rowCount).toBe(1);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='care_record' AND column_name='self_assessment'")).rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('public.care_record_step') name")).rows[0].name).toBe("care_record_step");
    expect((await pool.query("SELECT to_regclass('public.member_delivery_address') name")).rows[0].name).toBe("member_delivery_address");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='media_cleanup_queue' AND column_name='leased_until'")).rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('public.community_post_stats') name")).rows[0].name).toBe("community_post_stats");
    expect((await pool.query("SELECT to_regclass('public.processing_purpose') name")).rows[0].name).toBe("processing_purpose");
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='privacy_request' AND column_name='version'")).rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('public.ugc_post') name")).rows[0].name).toBe("ugc_post");
    expect((await pool.query("SELECT enabled FROM emergency_switch WHERE key='community'")).rows[0].enabled).toBe(false);
    await closePool(pool);
  }, 90_000);
});

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFinalSchemaContract } from "../../scripts/final-schema-contract";

const exec = promisify(execFile);
const adminUrl = "postgres://cisme:cisme-dev-only@127.0.0.1:55432/postgres";
const databaseName = `cisme_migration_${randomUUID().replaceAll("-", "")}`;
const migrationUrl = new URL(adminUrl);
migrationUrl.pathname = `/${databaseName}`;
const admin = new pg.Pool({ connectionString: adminUrl });
let databaseCreated = false;
const openPools = new Set<pg.Pool>();
function migrationPool() { const pool = new pg.Pool({ connectionString: migrationUrl.toString() }); openPools.add(pool); return pool; }
async function closePool(pool: pg.Pool) { openPools.delete(pool); await pool.end(); }

beforeAll(async () => {
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
    const migrationCount = migrationFiles.length;
    const extensionCount = migrationFiles.filter((file) => file >= "202609120002_commercial_membership_referral.sql").length;
    await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "up"], { env });
    let pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount);
    expect(await assertFinalSchemaContract(pool)).toEqual({tables:35,constraints:33,indexes:31,triggers:27});
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
    expect((await pool.query("SELECT active FROM processing_purpose WHERE code='support_service'")).rows[0].active).toBe(false);
    expect((await pool.query("SELECT enabled FROM emergency_switch WHERE key='community'")).rows[0].enabled).toBe(false);
    expect((await pool.query("SELECT count(*)::int count FROM emergency_switch")).rows[0].count).toBe(8);
    await closePool(pool);

    // Roll back this commercial/UGC extension before checking the older
    // lifecycle milestones below. Each new migration must round-trip alone.
    for (let step = 1; step <= extensionCount; step += 1) {
      await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "down"], { env });
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

    await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "down"], { env });
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 1);
    expect((await pool.query("SELECT to_regclass('public.support_presence') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.support_operator_profile') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='support_message' AND column_name='content_type'")).rowCount).toBe(0);
    expect((await pool.query("SELECT to_regclass('public.commerce_order') name")).rows[0].name).toBe("commerce_order");
    expect((await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='media_hash_unique'")).rows[0].indexdef).toContain("is_current");
    await closePool(pool);

    await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "down"], { env });
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 2);
    expect((await pool.query("SELECT to_regclass('public.commerce_order') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='catalog_inventory_level' AND column_name='reserved_quantity'")).rowCount).toBe(0);
    expect((await pool.query("SELECT to_regclass('public.catalog_product') name")).rows[0].name).toBe("catalog_product");
    await closePool(pool);

    await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "down"], { env });
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 3);
    expect((await pool.query("SELECT to_regclass('public.catalog_product') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='wechat_identity' AND column_name='provider'")).rowCount).toBe(1);
    expect((await pool.query("SELECT to_regclass('public.support_conversation') name")).rows[0].name).toBe("support_conversation");
    await closePool(pool);

    await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "down"], { env });
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 4);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='wechat_identity' AND column_name='provider'")).rowCount).toBe(0);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='authority_grant' AND column_name='environment'")).rowCount).toBe(0);
    expect((await pool.query("SELECT to_regclass('public.support_conversation') name")).rows[0].name).toBe("support_conversation");
    await closePool(pool);

    await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "down"], { env });
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

    await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "down"], { env });
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 6);
    expect((await pool.query("SELECT to_regclass('public.authority_grant') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT to_regclass('public.ugc_post') name")).rows[0].name).toBe("ugc_post");
    await closePool(pool);

    await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "down"], { env });
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 7);
    expect((await pool.query("SELECT to_regclass('public.ugc_post') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT 1 FROM emergency_switch WHERE key='community'")).rowCount).toBe(0);
    await pool.query(`INSERT INTO data_retention_policy(code,data_class,trigger_event,duration_days,disposition,legal_basis)
      VALUES('rollback_guard','synthetic rollback guard','test finished',1,'delete','test-only rollback preservation')`);
    await expect(exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "down"], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining("PRIVACY_LIFECYCLE_ROLLBACK_REQUIRES_DATA_PRESERVATION")
    });
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 7);
    await pool.query("DELETE FROM data_retention_policy WHERE code='rollback_guard'");
    await closePool(pool);

    await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "down"], { env });
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount - extensionCount - 8);
    expect((await pool.query("SELECT to_regclass('public.data_retention_policy') name")).rows[0].name).toBeNull();
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='privacy_request' AND column_name='version'")).rowCount).toBe(0);
    expect((await pool.query("SELECT to_regclass('public.member') name")).rows[0].name).toBe("member");
    expect((await pool.query("SELECT count(*)::int count FROM emergency_switch")).rows[0].count).toBe(7);
    await closePool(pool);

    await exec("./node_modules/.bin/tsx", ["scripts/migrate.ts", "up"], { env });
    pool = migrationPool();
    expect((await pool.query("SELECT count(*)::int count FROM schema_migration")).rows[0].count).toBe(migrationCount);
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

import { createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { createRequire } from "node:module";

if (process.env.APP_ENV !== "staging" || !process.env.DATABASE_URL) throw new Error("STAGING_ENV_REQUIRED");
const require = createRequire(process.env.CISME_RUNTIME_REQUIRE_PATH ?? "/opt/cisme/current/index.js");
const pg = require("pg"); const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const scalar = async sql => (await pool.query(sql)).rows[0].value;
const sha = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const runtime = process.env.CISME_RUNTIME_DIR ?? "/opt/cisme/current";
const expectedDatabase = process.env.EXPECTED_DATABASE_NAME ?? "cisme_staging";
const healthOrigin = (process.env.HEALTH_ORIGIN ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const state = {
  database: await scalar("SELECT current_database() AS value"),
  schema: { canonicalRule: "information_schema.tables: public BASE TABLE including schema_migration",
    migrations: Number(await scalar("SELECT count(*) AS value FROM schema_migration")),
    tables: Number(await scalar("SELECT count(*) AS value FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")),
    indexes: Number(await scalar("SELECT count(*) AS value FROM pg_indexes WHERE schemaname='public'")),
    constraints: Number(await scalar("SELECT count(*) AS value FROM information_schema.table_constraints WHERE table_schema='public'")),
    invalidIndexes: Number(await scalar("SELECT count(*) AS value FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT i.indisvalid")),
    unvalidatedConstraints: Number(await scalar("SELECT count(*) AS value FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT c.convalidated")) },
  foundations: { governanceTables: Number(await scalar("SELECT count(*) AS value FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('data_retention_policy','processing_purpose','processor_registry','consent_receipt','legal_hold','legal_hold_binding','data_export_job','data_erasure_job','privacy_request_event')")),
    ugcTables: Number(await scalar("SELECT count(*) AS value FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ugc_post','ugc_post_revision','ugc_media_asset','ugc_post_media','ugc_comment','ugc_report','moderation_case','moderation_action')")),
    supportTables: Number(await scalar("SELECT count(*) AS value FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('authority_grant','support_conversation','support_message')")) },
  data: { members: Number(await scalar("SELECT count(*) AS value FROM member")), authorityGrants: Number(await scalar("SELECT count(*) AS value FROM authority_grant")), conversations: Number(await scalar("SELECT count(*) AS value FROM support_conversation")), messages: Number(await scalar("SELECT count(*) AS value FROM support_message")), activeHolds: Number(await scalar("SELECT count(*) AS value FROM legal_hold WHERE status='active' AND expires_at>now()")), pendingOutbox: Number(await scalar("SELECT count(*) AS value FROM outbox_event WHERE processed_at IS NULL AND dead_lettered_at IS NULL")), deadLetterOutbox: Number(await scalar("SELECT count(*) AS value FROM outbox_event WHERE dead_lettered_at IS NOT NULL")) },
  policy: { pendingRows: Number(await scalar("SELECT count(*) AS value FROM data_retention_policy WHERE code IN ('support_conversation_policy_pending','support_audit_policy_pending') AND duration_days IS NULL AND active=false AND enforcement_state='declared'")), supportPurposeInactive: await scalar("SELECT active=false AS value FROM processing_purpose WHERE code='support_service'") },
  switches: { uploads: await scalar("SELECT enabled AS value FROM emergency_switch WHERE key='uploads'"), community: await scalar("SELECT enabled AS value FROM emergency_switch WHERE key='community'") },
  release: await readlink(runtime), artifacts: { apiSha256: await sha(`${runtime}/index.js`), workerSha256: await sha(`${runtime}/worker.js`), workerOnceSha256: await sha(`${runtime}/worker-once.js`) }
};
await pool.end();
const ready = await (await fetch(`${healthOrigin}/health/ready`)).json();
if (state.database!==expectedDatabase || state.schema.migrations!==31 || state.schema.tables!==69 || state.schema.invalidIndexes!==0 || state.schema.unvalidatedConstraints!==0 || state.foundations.governanceTables!==9 || state.foundations.ugcTables!==8 || state.foundations.supportTables!==3 || state.data.members!==0 || state.data.authorityGrants!==0 || state.data.conversations!==0 || state.data.messages!==0 || state.data.activeHolds!==0 || state.data.pendingOutbox!==0 || state.data.deadLetterOutbox!==0 || state.policy.pendingRows!==2 || !state.policy.supportPurposeInactive || state.switches.uploads || state.switches.community || ready.status!=="ready") throw new Error("R1_R2_FINAL_STATE_INVALID");
console.log(JSON.stringify({verified:true,...state,ready},null,2));

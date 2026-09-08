import { readFile, readdir } from "node:fs/promises";

const migrationFiles = (await readdir("db/migrations")).filter((file) => file.endsWith(".sql")).sort();
const migration = (await Promise.all(migrationFiles.map((file) => readFile(`db/migrations/${file}`, "utf8")))).join("\n");
const openapi = await readFile("openapi/openapi.yaml", "utf8");
const events = await readFile("docs/EVENT-CATALOG.md", "utf8");
const requiredTables = ["member", "wechat_identity", "qualification_fact", "care_cycle", "care_cycle_pause", "care_record", "eligibility_campaign", "eligibility_decision", "eligibility_task", "task_claim", "submission", "media_object", "media_cleanup_queue", "review_case", "appeal", "reward_claim", "points_grant", "points_lot", "points_entry", "points_projection", "points_action_request", "consent_grant", "revocation_request", "feed_item", "share_link", "share_visit", "share_attribution", "outbox_event", "audit_log"];
const requiredPaths = ["/v1/identity/dev", "/v1/identity/wechat", "/v1/care-cycles", "/v1/care-cycles/{cycleId}/activate", "/v1/care-cycles/{cycleId}/milestones/{milestone}/complete", "/v1/tasks/{taskId}/claim", "/v1/submissions/{submissionId}/draft", "/v1/submissions/{submissionId}/submit", "/v1/admin/tester-enrollments", "/v1/admin/campaigns", "/v1/admin/campaigns/{campaignId}", "/v1/admin/submissions/{submissionId}/review", "/v1/admin/submissions/{submissionId}/publish", "/v1/admin/points/grants", "/v1/admin/points/grants/{grantId}/actions", "/v1/admin/points/actions/{requestId}/approve", "/v1/admin/switches", "/v1/admin/worker-backlog", "/v1/admin/worker-failures", "/v1/admin/worker-failures/{queue}/{itemId}/redrive", "/v1/me/points", "/v1/feed", "/v1/shares/{shareId}/attributions/identity"];
const requiredEvents = ["identity.accepted.v1", "care.cycle.paused.v1", "care.cycle.resumed.v1", "care.cycle.terminated.v1", "care.milestone.completed.v1", "eligibility.decided.v1", "task.claimed.v1", "submission.reviewed.v1", "submission.publication.approved.v1", "reward.grant.created.v1", "points.grant.unfrozen.v1", "points.grant.expired.v1", "points.grant.reversed.v1", "consent.revocation.requested.v1", "share.identity.attributed.v1"];
for (const table of requiredTables) if (!migration.includes(`CREATE TABLE ${table}`)) throw new Error(`MISSING_TABLE:${table}`);
for (const path of requiredPaths) if (!openapi.includes(path)) throw new Error(`MISSING_OPENAPI_PATH:${path}`);
for (const event of requiredEvents) if (!events.includes(event)) throw new Error(`MISSING_EVENT:${event}`);
if (!migration.includes("UNIQUE (app_id, openid)")) throw new Error("IDENTITY_APP_OPENID_KEY_MISSING");
if (!migration.includes("media_object_current_kind_unique")) throw new Error("MEDIA_CURRENT_POINTER_MISSING");
if (!openapi.includes("feed_readonly: {type: boolean")) throw new Error("OPTIONAL_PUBLICATION_CONSENT_NOT_DOCUMENTED");
for (const path of ["/v1/care-cycles/{cycleId}/activate", "/v1/care-cycles/{cycleId}/milestones/{milestone}/complete"]) {
  const start = openapi.indexOf(`  ${path}:`);
  const end = openapi.indexOf("\n  /v1/", start + path.length + 3);
  const operation = openapi.slice(start, end === -1 ? openapi.length : end);
  if (!operation.includes("#/components/parameters/IdempotencyKey")) throw new Error(`CARE_COMMAND_IDEMPOTENCY_MISSING:${path}`);
  if (!operation.includes("#/components/schemas/CareVersionCommandInput")) throw new Error(`CARE_COMMAND_EXPECTED_VERSION_MISSING:${path}`);
}
if (!openapi.includes("CareVersionCommandInput: {type: object, additionalProperties: false, required: [expectedVersion]")) throw new Error("CARE_VERSION_COMMAND_SCHEMA_MISSING");
console.log(`${migrationFiles.length} migrations, ${requiredTables.length} tables, ${requiredPaths.length} paths and ${requiredEvents.length} events cross-checked`);

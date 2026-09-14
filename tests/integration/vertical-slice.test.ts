import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, seedTestCampaign, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";
import { processOutboxBatch } from "../../services/worker/src/main";
import { operatorHeaders } from "./operator-session";

const pool = testPool();
const config = loadConfig({ APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, ALLOW_DEV_ADAPTERS: "true", APP_SESSION_SECRET: "test-session-secret", ADMIN_API_TOKEN: "test-admin-token", UPLOAD_TOKEN_SECRET: "test-upload-secret", OBJECT_STORAGE_DRIVER: "api_gateway", POINTS_RULES_ENABLED: "true", POINTS_FINANCE_APPROVAL_ID: "test-only-finance-approval", POINTS_FINANCE_APPROVAL_EXPIRES_AT: "2099-12-31T23:59:59Z", POINTS_MAKER_CHECKER_READY: "true", POINTS_HOLD_DAYS: "7", POINTS_EXPIRY_DAYS: "365", POINTS_RULE_IDS: "CARE_D7_STORY_R0,CARE_D28_RECORD_R0,ORDER_REWARD_R0", CARE_PAUSE_POLICY_VERSION: "care-pause-test-v1", CARE_PAUSE_MAX_DAYS: "14", CARE_PAUSE_REASON_CODES: "MEMBER_REQUEST", UGC_GO_LIVE_GATE: "true", UGC_LEGAL_APPROVAL_ID: "test-only-legal-approval", UGC_PROVENANCE_READY: "true", UGC_CONTENT_SAFETY_READY: "true", UGC_MODERATION_READY: "true" });
const storage = createApiGatewayStorage(config);
let app: FastifyInstance;
let token = "";
let memberId = "";
let cycleId = "";
let taskId = "";
let submissionId = "";
const originalBytes = Buffer.from([0xff, 0xd8, 0xff, ...Buffer.from("original-care-evidence")]);
const screenshotBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("published-care-screenshot")]);

function auth(clock = "2026-08-07T12:00:00+08:00") { return { authorization: `Bearer ${token}`, "x-dev-clock": clock }; }
function careHeaders(key: string, clock = "2026-08-07T12:00:00+08:00") { return { ...auth(clock), "idempotency-key": key }; }
function careCompletion(expectedVersion: number) { return { expectedVersion, stepCodes: ["00", "01", "02", "03"], selfAssessment: "comfortable" }; }
function legacy(principal: string, extras: Record<string, string> = {}) { return operatorHeaders(config, principal, memberId, extras); }
async function json(response: Awaited<ReturnType<FastifyInstance["inject"]>>) { const body = response.json(); expect(response.statusCode, JSON.stringify(body)).toBeLessThan(400); return body; }
function multipart(tokenValue: string, bytes: Buffer, mime = "image/jpeg") {
  const boundary = "----cisme-test-boundary";
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${tokenValue}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="care.jpg"\r\nContent-Type: ${mime}\r\n\r\n`);
  return { boundary, payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

beforeAll(async () => {
  await resetDatabase(pool); await seedTestCampaign(pool);
  await pool.query("INSERT INTO principal_role(principal_id,role) VALUES ('admin-reviewer','reviewer'),('admin-reviewer','review_lead'),('admin-lead','review_lead'),('finance-maker','finance_operator'),('finance-checker','finance_approver'),('finance-dual','finance_operator'),('finance-dual','finance_approver')");
  await storage.ensureReady(); app = await createApp({ config, pool, storage });
});
afterAll(async () => { await app?.close(); await pool.end(); });

describe("unforgeable R0 vertical slice", () => {
  it("creates identity, audited experience qualification, explicit care and time-derived D7 eligibility", async () => {
    const identity = await json(await app.inject({ method: "POST", url: "/v1/identity/dev", headers: { "x-dev-clock": "2026-08-01T08:00:00+08:00" }, payload: { externalUserId: "vertical-member", displayName: "纵切会员", consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }] } }));
    token = identity.sessionToken; memberId = identity.memberId;
    const renamed = await json(await app.inject({ method: "POST", url: "/v1/identity/dev", payload: { externalUserId: "vertical-member", displayName: "佳静", consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }] } }));
    token = renamed.sessionToken;
    await json(await app.inject({method:"PUT",url:"/v1/me/profile",headers:auth(),payload:{displayName:"佳静",expectedVersion:0}}));
    expect(await json(await app.inject({ method: "GET", url: "/v1/me", headers: auth("2026-08-01T08:10:00+08:00") }))).toMatchObject({ id: memberId, display_name: "佳静" });
    const relogged = await json(await app.inject({ method: "POST", url: "/v1/identity/dev", payload: { externalUserId: "vertical-member", displayName: "CISME 会员", consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }] } }));
    token = relogged.sessionToken;
    expect(await json(await app.inject({ method: "GET", url: "/v1/me", headers: auth("2026-08-01T08:11:00+08:00") }))).toMatchObject({ id: memberId, display_name: "佳静" });
    const invalidName = await app.inject({ method: "POST", url: "/v1/identity/dev", payload: { externalUserId: "invalid-name", displayName: "超".repeat(41), consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }] } });
    expect(invalidName.statusCode).toBe(422); expect(invalidName.json().code).toBe("IDENTITY_DISPLAY_NAME_INVALID");
    const enrollmentPayload = { memberId, qualificationType: "approved_tester_fulfillment", externalRef: "tester-fulfillment-001", occurredAt: "2026-08-01T08:30:00+08:00", timezone: "Asia/Shanghai", protocolVersion: "care-r0-v1", reasonCode: "EXPERIENCE_QUALIFICATION_VERIFIED", evidence: { batch: "R0-A", delivered: true } };
    const plannedResult = await json(await app.inject({ method: "POST", url: "/v1/admin/tester-enrollments", headers: legacy("admin-lead", { "x-dev-clock": "2026-08-01T09:00:00+08:00" }), payload: enrollmentPayload }));
    const replayedPlan = await json(await app.inject({ method: "POST", url: "/v1/admin/tester-enrollments", headers: legacy("admin-lead", { "x-dev-clock": "2026-08-01T09:01:00+08:00" }), payload: enrollmentPayload }));
    const planned = plannedResult.cycle;
    expect(replayedPlan.cycle.id).toBe(planned.id);
    const overlapping = await app.inject({ method: "POST", url: "/v1/admin/tester-enrollments", headers: legacy("admin-lead", { "x-dev-clock": "2026-08-01T09:02:00+08:00" }), payload: { ...enrollmentPayload, externalRef: "tester-fulfillment-overlap" } });
    expect(overlapping.statusCode).toBe(409); expect(overlapping.json().code).toBe("CARE_CYCLE_ALREADY_OPEN");
    cycleId = planned.id; expect(planned.phase).toBe("planned"); expect(planned.startedOn).toBeNull();
    const missingActivateKey = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/activate`, headers: auth("2026-08-01T10:00:00+08:00"), payload: { expectedVersion: planned.version } });
    expect(missingActivateKey.statusCode).toBe(400); expect(missingActivateKey.json().code).toBe("IDEMPOTENCY_KEY_INVALID");
    const missingActivateVersion = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/activate`, headers: careHeaders(`care-${cycleId}-activate-missing-version`, "2026-08-01T10:00:00+08:00"), payload: {} });
    expect(missingActivateVersion.statusCode).toBe(422); expect(missingActivateVersion.json().code).toBe("EXPECTED_VERSION_INVALID");
    const activateHeaders = careHeaders(`care-${cycleId}-activate-v${planned.version}`, "2026-08-01T10:00:00+08:00");
    const activatePayload = { expectedVersion: planned.version };
    const [activateFirst, activateSecond] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/activate`, headers: activateHeaders, payload: activatePayload }),
      app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/activate`, headers: activateHeaders, payload: activatePayload })
    ]);
    const active = await json(activateFirst);
    const activateReplay = await json(activateSecond);
    expect(activateReplay).toEqual(active);
    const activateLaterReplay = await json(await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/activate`, headers: careHeaders(`care-${cycleId}-activate-v${planned.version}`, "2026-08-02T10:00:00+08:00"), payload: activatePayload }));
    expect(activateLaterReplay).toEqual(active);
    const activateConflict = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/activate`, headers: activateHeaders, payload: { expectedVersion: active.version } });
    expect(activateConflict.statusCode).toBe(409); expect(activateConflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
    const activateExtraBodyConflict = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/activate`, headers: activateHeaders, payload: { ...activatePayload, unexpected: "different-body" } });
    expect(activateExtraBodyConflict.statusCode).toBe(409); expect(activateExtraBodyConflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
    expect(active.startedOn).toBe("2026-08-01"); expect(active.due).toBe("D1");
    const incompleteCare = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D1/complete`, headers: careHeaders(`care-${cycleId}-D1-incomplete-v${active.version}`, "2026-08-01T10:09:00+08:00"), payload: { expectedVersion: active.version, stepCodes: ["00", "01", "02"], selfAssessment: "comfortable" } });
    expect(incompleteCare.statusCode).toBe(422); expect(incompleteCare.json().code).toBe("CARE_PROTOCOL_STEPS_INCOMPLETE");
    const missingAssessment = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D1/complete`, headers: careHeaders(`care-${cycleId}-D1-no-assessment-v${active.version}`, "2026-08-01T10:09:30+08:00"), payload: { expectedVersion: active.version, stepCodes: ["00", "01", "02", "03"] } });
    expect(missingAssessment.statusCode).toBe(422); expect(missingAssessment.json().code).toBe("CARE_SELF_ASSESSMENT_REQUIRED");
    const d1Headers = careHeaders(`care-${cycleId}-D1-v${active.version}`, "2026-08-01T10:10:00+08:00");
    const d1Payload = careCompletion(active.version);
    const [d1First, d1Second] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D1/complete`, headers: d1Headers, payload: d1Payload }),
      app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D1/complete`, headers: d1Headers, payload: d1Payload })
    ]);
    const d1 = await json(d1First);
    const d1Replay = await json(d1Second);
    expect(d1Replay).toEqual(d1);
    expect(d1.cycle.version).toBe(active.version + 1);
    expect(d1.cycle.records[0]).toMatchObject({ milestone: "D1", stepCodes: ["00", "01", "02", "03"], selfAssessment: "comfortable" });
    const persistedCareDetails = await pool.query(`SELECT cr.self_assessment, array_agg(crs.step_code ORDER BY crs.sequence) AS step_codes
      FROM care_record cr JOIN care_record_step crs ON crs.record_id=cr.id WHERE cr.cycle_id=$1 AND cr.milestone='D1' GROUP BY cr.id`, [cycleId]);
    expect(persistedCareDetails.rows[0]).toMatchObject({ self_assessment: "comfortable", step_codes: ["00", "01", "02", "03"] });
    const d1LaterReplay = await json(await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D1/complete`, headers: careHeaders(`care-${cycleId}-D1-v${active.version}`, "2026-08-02T10:10:00+08:00"), payload: d1Payload }));
    expect(d1LaterReplay).toEqual(d1);
    const d1Conflict = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D1/complete`, headers: d1Headers, payload: { ...d1Payload, expectedVersion: active.version + 1 } });
    expect(d1Conflict.statusCode).toBe(409); expect(d1Conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
    const d1ExtraBodyConflict = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D1/complete`, headers: d1Headers, payload: { ...d1Payload, unexpected: "different-body" } });
    expect(d1ExtraBodyConflict.statusCode).toBe(409); expect(d1ExtraBodyConflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
    const early = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D7/complete`, headers: careHeaders(`care-${cycleId}-D7-early-v${d1.cycle.version}`, "2026-08-03T10:00:00+08:00"), payload: careCompletion(d1.cycle.version) });
    expect(early.statusCode).toBe(409); expect(early.json().code).toBe("CARE_NO_DUE_MILESTONE");
    const d7Headers = careHeaders(`care-${cycleId}-D7-v${d1.cycle.version}`);
    const d7Payload = careCompletion(d1.cycle.version);
    const d7 = await json(await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D7/complete`, headers: d7Headers, payload: d7Payload }));
    expect(d7.cycle.version).toBe(d1.cycle.version + 1);
    taskId = d7.task.id; expect(taskId).toBeTruthy();
    const repeated = await json(await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D7/complete`, headers: d7Headers, payload: d7Payload }));
    expect(repeated).toEqual(d7);
    expect(repeated.task.id).toBe(taskId);
    const task = await json(await app.inject({ method: "GET", url: `/v1/tasks/${taskId}`, headers: auth() }));
    expect(task).toMatchObject({ name: "第 7 天真实护理日记", state: "available", claimable: true, submission_id: null });
  });

  it("keys WeChat identities by app and openid while allowing multiple identities per member", async () => {
    await pool.query(`INSERT INTO wechat_identity(member_id, provider, app_id, openid, adapter)
      VALUES ($1,'wechat_miniprogram','wx-app-a','shared-openid','wechat'),($1,'wechat_miniprogram','wx-app-b','shared-openid','wechat')`, [memberId]);
    const identities = await pool.query("SELECT app_id, openid FROM wechat_identity WHERE member_id=$1 ORDER BY app_id", [memberId]);
    expect(identities.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ app_id: "wx-app-a", openid: "shared-openid" }),
      expect.objectContaining({ app_id: "wx-app-b", openid: "shared-openid" })
    ]));
    await expect(pool.query("INSERT INTO wechat_identity(member_id, provider, app_id, openid, adapter) VALUES ($1,'wechat_miniprogram','wx-app-a','shared-openid','wechat')", [memberId]))
      .rejects.toMatchObject({ code: "23505" });
  });

  it("serializes concurrent first identity creation to one member", async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject({
      method: "POST",
      url: "/v1/identity/dev",
      payload: {
        externalUserId: "concurrent-first-identity",
        displayName: "并发身份会员",
        consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }]
      }
    })));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const identities = responses.map((response) => response.json());
    expect(new Set(identities.map((identity) => identity.memberId)).size).toBe(1);
    expect(new Set(identities.map((identity) => identity.identityId)).size).toBe(1);
    const count = await pool.query(`SELECT
      (SELECT count(*)::int FROM wechat_identity WHERE app_id='dev' AND openid='dev:concurrent-first-identity') identities,
      (SELECT count(*)::int FROM member WHERE display_name='并发身份会员') members`);
    expect(count.rows[0]).toMatchObject({ identities: 1, members: 1 });
  });

  it("rejects protected API access after member access is revoked", async () => {
    const revoked = await json(await app.inject({
      method: "POST",
      url: "/v1/identity/dev",
      payload: {
        externalUserId: "revoked-member",
        displayName: "停用会员",
        consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }]
      }
    }));
    await pool.query("UPDATE member SET status='blocked' WHERE id=$1", [revoked.memberId]);
    let response = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${revoked.sessionToken}` } });
    expect(response.statusCode).toBe(401); expect(response.json().code).toBe("AUTH_REVOKED");
    await pool.query("UPDATE member SET status='deleted' WHERE id=$1", [revoked.memberId]);
    response = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${revoked.sessionToken}` } });
    expect(response.statusCode).toBe(401); expect(response.json().code).toBe("AUTH_REVOKED");
  });

  it("records a real share visit and first-touch identity attribution without self-credit", async () => {
    const shareClock = { "x-dev-clock": "2026-08-07T12:00:00+08:00" };
    const created = await json(await app.inject({
      method: "POST", url: "/v1/shares", headers: { ...auth(), "idempotency-key": "share-post-editorial-1" },
      payload: { targetType: "post", targetRef: "editorial-scalp-ritual" }
    }));
    const replay = await json(await app.inject({
      method: "POST", url: "/v1/shares", headers: { ...auth(), "idempotency-key": "share-post-editorial-2" },
      payload: { targetType: "post", targetRef: "editorial-scalp-ritual" }
    }));
    expect(replay.shareId).toBe(created.shareId);
    const resolved = await json(await app.inject({ method: "GET", url: `/v1/shares/${created.shareId}`, headers: shareClock }));
    expect(resolved).toMatchObject({ targetType: "post", targetRef: "editorial-scalp-ritual" });
    const visitKey = "visit-integration-visitor-0001";
    const visit = await json(await app.inject({ method: "POST", url: `/v1/shares/${created.shareId}/visits`, headers: shareClock, payload: { visitKey } }));
    const visitReplay = await json(await app.inject({ method: "POST", url: `/v1/shares/${created.shareId}/visits`, headers: shareClock, payload: { visitKey } }));
    expect(visitReplay.visitId).toBe(visit.visitId);

    const converted = await json(await app.inject({ method: "POST", url: "/v1/identity/dev", payload: { externalUserId: "share-conversion-member", displayName: "分享访问会员", consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }] } }));
    const attributed = await json(await app.inject({ method: "POST", url: `/v1/shares/${created.shareId}/attributions/identity`, headers: { ...shareClock, authorization: `Bearer ${converted.sessionToken}` }, payload: { visitKey } }));
    expect(attributed).toMatchObject({ credited: true });
    const attributedReplay = await json(await app.inject({ method: "POST", url: `/v1/shares/${created.shareId}/attributions/identity`, headers: { ...shareClock, authorization: `Bearer ${converted.sessionToken}` }, payload: { visitKey } }));
    expect(attributedReplay).toMatchObject({ credited: true, reason: "ALREADY_RECORDED" });

    const selfVisitKey = "visit-integration-sharer-0001";
    await json(await app.inject({ method: "POST", url: `/v1/shares/${created.shareId}/visits`, headers: shareClock, payload: { visitKey: selfVisitKey } }));
    const self = await json(await app.inject({ method: "POST", url: `/v1/shares/${created.shareId}/attributions/identity`, headers: auth(), payload: { visitKey: selfVisitKey } }));
    expect(self).toMatchObject({ credited: false, reason: "SELF_ATTRIBUTION" });
    const facts = await pool.query("SELECT (SELECT count(*) FROM share_attribution)::int attributions, (SELECT count(*) FROM outbox_event WHERE event_type='share.identity.attributed.v1')::int events");
    expect(facts.rows[0]).toMatchObject({ attributions: 1, events: 1 });
  });

  it("covers pause, resume, no-due, D28 completion, termination and a new cycle", async () => {
    const beforePause = await json(await app.inject({ method: "GET", url: "/v1/me/care", headers: auth("2026-08-13T12:00:00+08:00") }));
    const pauseHeaders = { ...auth("2026-08-13T12:00:00+08:00"), "idempotency-key": `care-${cycleId}-pause-v${beforePause.version}` };
    const [pauseFirst, pauseSecond] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/pause`, headers: pauseHeaders, payload: { reasonCode: "MEMBER_REQUEST", expectedVersion: beforePause.version } }),
      app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/pause`, headers: pauseHeaders, payload: { reasonCode: "MEMBER_REQUEST", expectedVersion: beforePause.version } })
    ]);
    const paused = await json(pauseFirst);
    const pauseReplay = await json(pauseSecond);
    expect(pauseReplay).toEqual(paused);
    expect(paused.phase).toBe("paused");
    const blocked = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D14/complete`, headers: careHeaders(`care-${cycleId}-D14-paused-v${paused.version}`, "2026-08-14T12:00:00+08:00"), payload: careCompletion(paused.version) });
    expect(blocked.statusCode).toBe(409); expect(blocked.json().code).toBe("CARE_NOT_ACTIVE");
    const resumed = await json(await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/resume`, headers: { ...auth("2026-08-14T08:00:00+08:00"), "idempotency-key": `care-${cycleId}-resume-v${paused.version}` }, payload: { reasonCode: "MEMBER_RESUME", expectedVersion: paused.version } }));
    expect(resumed.phase).toBe("active"); expect(resumed.scheduleOffsetDays).toBe(1);
    const shifted = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D14/complete`, headers: careHeaders(`care-${cycleId}-D14-early-v${resumed.version}`, "2026-08-14T12:00:00+08:00"), payload: careCompletion(resumed.version) });
    expect(shifted.statusCode).toBe(409); expect(shifted.json().code).toBe("CARE_NO_DUE_MILESTONE");
    const d14 = await json(await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D14/complete`, headers: careHeaders(`care-${cycleId}-D14-v${resumed.version}`, "2026-08-15T12:00:00+08:00"), payload: careCompletion(resumed.version) }));
    const noDue = await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D28/complete`, headers: careHeaders(`care-${cycleId}-D28-early-v${d14.cycle.version}`, "2026-08-15T12:00:00+08:00"), payload: careCompletion(d14.cycle.version) });
    expect(noDue.statusCode).toBe(409); expect(noDue.json().code).toBe("CARE_NO_DUE_MILESTONE");
    const completed = await json(await app.inject({ method: "POST", url: `/v1/care-cycles/${cycleId}/milestones/D28/complete`, headers: careHeaders(`care-${cycleId}-D28-v${d14.cycle.version}`, "2026-08-29T12:00:00+08:00"), payload: careCompletion(d14.cycle.version) }));
    expect(completed.cycle.phase).toBe("completed");
    const milestoneVersions = await pool.query<{ milestone: string; aggregate_version: number }>(`SELECT payload->>'milestone' AS milestone, aggregate_version
      FROM outbox_event WHERE event_type='care.milestone.completed.v1' AND aggregate_id=$1 ORDER BY aggregate_version`, [cycleId]);
    expect(milestoneVersions.rows.map((row) => row.milestone)).toEqual(["D1", "D7", "D14", "D28"]);
    for (let index = 1; index < milestoneVersions.rows.length; index += 1) {
      expect(milestoneVersions.rows[index]!.aggregate_version).toBeGreaterThan(milestoneVersions.rows[index - 1]!.aggregate_version);
    }
    expect(milestoneVersions.rows.at(-2)!.aggregate_version).toBe(d14.cycle.version);
    expect(milestoneVersions.rows.at(-1)!.aggregate_version).toBe(completed.cycle.version);
    const pauseFact = await pool.query("SELECT reason_code, policy_version, duration_days, end_action FROM care_cycle_pause WHERE cycle_id=$1", [cycleId]);
    expect(pauseFact.rows[0]).toMatchObject({ reason_code: "MEMBER_REQUEST", policy_version: "care-pause-test-v1", duration_days: 1, end_action: "resume" });

    const qualification = await json(await app.inject({ method: "POST", url: "/v1/qualifications/dev", headers: auth("2026-09-01T09:00:00+08:00"), payload: { externalRef: "purchase-qualified-002", occurredAt: "2026-09-01T08:30:00+08:00" } }));
    const planned = await json(await app.inject({ method: "POST", url: "/v1/care-cycles", headers: auth("2026-09-01T09:00:00+08:00"), payload: { qualificationFactId: qualification.id, timezone: "Asia/Shanghai", protocolVersion: "care-r0-v1" } }));
    expect(planned.startedOn).toBeNull();
    const nextActive = await json(await app.inject({ method: "POST", url: `/v1/care-cycles/${planned.id}/activate`, headers: careHeaders(`care-${planned.id}-activate-v${planned.version}`, "2026-09-01T10:00:00+08:00"), payload: { expectedVersion: planned.version } }));
    const terminated = await json(await app.inject({ method: "POST", url: `/v1/care-cycles/${planned.id}/terminate`, headers: { ...auth("2026-09-01T10:05:00+08:00"), "idempotency-key": `care-${planned.id}-terminate-v${nextActive.version}` }, payload: { reasonCode: "MEMBER_TERMINATION", expectedVersion: nextActive.version } }));
    expect(nextActive.phase).toBe("active"); expect(terminated.phase).toBe("terminated");
    const archive = await json(await app.inject({ method: "GET", url: "/v1/me/care", headers: auth("2026-09-01T10:06:00+08:00") }));
    expect(archive).toMatchObject({ id: planned.id, phase: "terminated" });
    expect(archive.history).toHaveLength(1);
    expect(archive.history[0]).toMatchObject({ id: cycleId, phase: "completed" });
    expect(archive.history[0].records).toHaveLength(4);
    expect(archive.history[0].records[0]).toMatchObject({ protocolVersion: "care-r0-v1", stepCodes: ["00", "01", "02", "03"] });
  });

  it("atomically replays concurrent task claims to one claim and submission", async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => app.inject({ method: "POST", url: `/v1/tasks/${taskId}/claim`, headers: { ...auth(), "idempotency-key": `claim-key-${index}` } })));
    const bodies = await Promise.all(responses.map(json));
    expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.submissionId)).size).toBe(1);
    submissionId = bodies[0].submissionId;
    const counts = await pool.query("SELECT (SELECT count(*) FROM task_claim)::int claims, (SELECT count(*) FROM submission)::int submissions");
    expect(counts.rows[0]).toMatchObject({ claims: 1, submissions: 1 });
  });

  it("uploads original and screenshot through the real API gateway with retry semantics", async () => {
    const fixtures: Array<["original" | "screenshot", Buffer, "image/jpeg" | "image/png"]> = [
      ["original", originalBytes, "image/jpeg"],
      ["screenshot", screenshotBytes, "image/png"]
    ];
    for (const [kind, bytes, mime] of fixtures) {
      const authorization = await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/media/authorize`, headers: auth(), payload: { kind, mimeType: mime, maxBytes: 2048 } }));
      const tokenValue = authorization.fields.token;
      const { boundary, payload } = multipart(tokenValue, bytes, mime);
      const uploadPath = new URL(authorization.url).pathname;
      await json(await app.inject({ method: "POST", url: uploadPath, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload }));
      await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/media/${authorization.mediaId}/complete`, headers: auth() }));
    }
    const submission = await json(await app.inject({ method: "GET", url: `/v1/submissions/${submissionId}`, headers: auth() }));
    expect(submission.media_uploads_enabled).toBe(true);
    expect(submission.media).toHaveLength(2); expect(submission.media.every((item: any) => item.upload_state === "uploaded")).toBe(true);
  });

  it("handles upload failure, retry, explicit delete and duplicate hash", async () => {
    let submission = await json(await app.inject({ method: "GET", url: `/v1/submissions/${submissionId}`, headers: auth() }));
    let screenshot = submission.media.find((item: any) => item.kind === "screenshot");
    const originalScreenshotId = screenshot.id;

    let authorization = await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/media/authorize`, headers: auth(), payload: { kind: "screenshot", mimeType: "image/png", maxBytes: 2048 } }));
    let upload = multipart(authorization.fields.token, Buffer.from("not-an-image"), "image/png");
    let response = await app.inject({ method: "POST", url: new URL(authorization.url).pathname, headers: { "content-type": `multipart/form-data; boundary=${upload.boundary}` }, payload: upload.payload });
    expect(response.statusCode).toBe(422); expect(response.json().code).toBe("UPLOAD_CONTENT_INVALID");
    submission = await json(await app.inject({ method: "GET", url: `/v1/submissions/${submissionId}`, headers: auth() }));
    expect(submission.media.find((item: any) => item.kind === "screenshot")).toMatchObject({ id: originalScreenshotId, upload_state: "uploaded" });

    authorization = await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/media/authorize`, headers: auth(), payload: { kind: "screenshot", mimeType: "image/png", maxBytes: 2048 } }));
    upload = multipart(authorization.fields.token, screenshotBytes, "image/png");
    await json(await app.inject({ method: "POST", url: new URL(authorization.url).pathname, headers: { "content-type": `multipart/form-data; boundary=${upload.boundary}` }, payload: upload.payload }));
    await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/media/${authorization.mediaId}/complete`, headers: auth() }));

    submission = await json(await app.inject({ method: "GET", url: `/v1/submissions/${submissionId}`, headers: auth() }));
    screenshot = submission.media.find((item: any) => item.kind === "screenshot");
    expect(screenshot.id).not.toBe(originalScreenshotId);
    const replacementCleanup = await pool.query("SELECT reason, processed_at FROM media_cleanup_queue WHERE media_id=$1", [originalScreenshotId]);
    expect(replacementCleanup.rows[0]).toMatchObject({ reason: "replaced", processed_at: null });
    await json(await app.inject({ method: "DELETE", url: `/v1/submissions/${submissionId}/media/${screenshot.id}`, headers: auth() }));
    authorization = await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/media/authorize`, headers: auth(), payload: { kind: "screenshot", mimeType: "image/jpeg", maxBytes: 2048 } }));
    upload = multipart(authorization.fields.token, originalBytes, "image/jpeg");
    await json(await app.inject({ method: "POST", url: new URL(authorization.url).pathname, headers: { "content-type": `multipart/form-data; boundary=${upload.boundary}` }, payload: upload.payload }));
    response = await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/media/${authorization.mediaId}/complete`, headers: auth() });
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe("MEDIA_DUPLICATE_HASH");

    authorization = await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/media/authorize`, headers: auth(), payload: { kind: "screenshot", mimeType: "image/png", maxBytes: 2048 } }));
    upload = multipart(authorization.fields.token, screenshotBytes, "image/png");
    await json(await app.inject({ method: "POST", url: new URL(authorization.url).pathname, headers: { "content-type": `multipart/form-data; boundary=${upload.boundary}` }, payload: upload.payload }));
    await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/media/${authorization.mediaId}/complete`, headers: auth() }));
  });

  it("allows private reward submission without optional feed publication consent", async () => {
    const draft = await pool.query<{ id: string }>("INSERT INTO submission(member_id) VALUES ($1) RETURNING id", [memberId]);
    const privateSubmissionId = draft.rows[0]!.id;
    await pool.query(`INSERT INTO media_object(submission_id, kind, object_key, mime_type, upload_state, size_bytes, uploaded_at)
      VALUES ($1,'original',$2,'image/jpeg','uploaded',8,now()),($1,'screenshot',$3,'image/png','uploaded',8,now())`,
    [privateSubmissionId, `submissions/${privateSubmissionId}/original/private-test`, `submissions/${privateSubmissionId}/screenshot/private-test`]);
    const response = await app.inject({
      method: "POST",
      url: `/v1/submissions/${privateSubmissionId}/submit`,
      headers: { ...auth(), "idempotency-key": "private-submit-v1" },
      payload: {
        postUrl: "https://example.test/care-story/private-review-only",
        platformAccount: "小红书@私有审核用户",
        disclosure: "本次内容可能获得 CISME 积分奖励",
        license: { content_storage: true, human_review: true, feed_readonly: false },
        expectedVersion: 1
      }
    });
    expect(response.statusCode).toBe(200);
    const grants = await pool.query<{ purpose: string }>("SELECT purpose FROM consent_grant WHERE submission_id=$1 ORDER BY purpose", [privateSubmissionId]);
    expect(grants.rows.map((row) => row.purpose)).toEqual(["content_storage", "human_review"]);
  });

  it("supports supplement, reject, appeal and exactly-once approval grant", async () => {
    const payload = { postUrl: "https://example.test/care-story/vertical-1", platformAccount: "小红书@护理用户", disclosure: "本次内容可能获得 CISME 积分奖励", license: { content_storage: true, human_review: true, feed_readonly: true }, expectedVersion: 1 };
    const first = await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/submit`, headers: { ...auth(), "idempotency-key": "submit-v1" }, payload }));
    const replay = await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/submit`, headers: { ...auth(), "idempotency-key": "submit-v1" }, payload }));
    expect(replay).toEqual(first);
    const adminHeaders = legacy("admin-reviewer", { "x-dev-clock": "2026-08-07T12:00:00+08:00" });
    const needs = await json(await app.inject({ method: "POST", url: `/v1/admin/submissions/${submissionId}/review`, headers: { ...adminHeaders, "idempotency-key": `review-${submissionId}-v2` }, payload: { decision: "request_changes", reasonCode: "EVIDENCE_INCOMPLETE", evidence: { field: "caption" }, expectedVersion: 2 } }));
    const resubmitted = await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/submit`, headers: { ...auth(), "idempotency-key": "submit-v3" }, payload: { ...payload, expectedVersion: needs.version } }));
    const rejected = await json(await app.inject({ method: "POST", url: `/v1/admin/submissions/${submissionId}/review`, headers: { ...adminHeaders, "idempotency-key": `review-${submissionId}-v${resubmitted.version}` }, payload: { decision: "reject", reasonCode: "POLICY_REVIEW", evidence: { note: "needs appeal" }, expectedVersion: resubmitted.version } }));
    const appealed = await json(await app.inject({ method: "POST", url: `/v1/submissions/${submissionId}/appeal`, headers: { ...auth(), "idempotency-key": `appeal-${submissionId}-v${rejected.version}` }, payload: { reason: "补充完整事实", expectedVersion: rejected.version } }));
    const approvals = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: "POST", url: `/v1/admin/submissions/${submissionId}/review`, headers: { ...adminHeaders, "idempotency-key": `review-${submissionId}-v${appealed.version}` }, payload: { decision: "approve", reasonCode: "APPEAL_UPHELD", evidence: { checked: true }, expectedVersion: appealed.version } })));
    const approvalBodies = await Promise.all(approvals.map(json));
    expect(new Set(approvalBodies.map((body) => body.pointsGrantId)).size).toBe(1);
    const conserved = await pool.query("SELECT (SELECT count(*) FROM reward_claim)::int rewards, (SELECT count(*) FROM points_grant)::int grants, (SELECT count(*) FROM points_entry)::int entries, frozen, available FROM points_projection WHERE member_id=$1", [memberId]);
    expect(conserved.rows[0]).toMatchObject({ rewards: 1, grants: 1, entries: 1, frozen: 300, available: 0 });
    await expect(pool.query("UPDATE points_entry SET frozen_delta=301")).rejects.toMatchObject({ code: "55000" });
  });

  it("locks media mutations after submission and honors upload, submission and review switches", async () => {
    const lockedSubmission = await pool.query<{ id: string }>("INSERT INTO submission(member_id,status) VALUES ($1,'submitted') RETURNING id", [memberId]);
    const lockedMedia = await pool.query<{ id: string }>(`INSERT INTO media_object(submission_id,kind,object_key,mime_type,upload_state,is_current)
      VALUES ($1,'original',$2,'image/jpeg','uploaded',true) RETURNING id`, [lockedSubmission.rows[0]!.id, `switch-test/${lockedSubmission.rows[0]!.id}/locked.jpg`]);
    let response = await app.inject({ method: "DELETE", url: `/v1/submissions/${lockedSubmission.rows[0]!.id}/media/${lockedMedia.rows[0]!.id}`, headers: auth() });
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe("SUBMISSION_LOCKED");

    const draft = await pool.query<{ id: string }>("INSERT INTO submission(member_id) VALUES ($1) RETURNING id", [memberId]);
    const media = await pool.query<{ id: string }>(`INSERT INTO media_object(submission_id,kind,object_key,mime_type,upload_state,is_current)
      VALUES ($1,'original',$2,'image/jpeg','uploaded',true) RETURNING id`, [draft.rows[0]!.id, `switch-test/${draft.rows[0]!.id}/draft.jpg`]);
    await pool.query("UPDATE emergency_switch SET enabled=false, reason='upload drill' WHERE key='uploads'");
    const uploadsDisabledView = await json(await app.inject({ method: "GET", url: `/v1/submissions/${draft.rows[0]!.id}`, headers: auth() }));
    expect(uploadsDisabledView.media_uploads_enabled).toBe(false);
    response = await app.inject({ method: "DELETE", url: `/v1/submissions/${draft.rows[0]!.id}/media/${media.rows[0]!.id}`, headers: auth() });
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe("SWITCH_UPLOADS_OFF");
    await pool.query("UPDATE emergency_switch SET enabled=true, reason='normal' WHERE key='uploads'");
    const uploadsEnabledView = await json(await app.inject({ method: "GET", url: `/v1/submissions/${draft.rows[0]!.id}`, headers: auth() }));
    expect(uploadsEnabledView.media_uploads_enabled).toBe(true);
    await pool.query("UPDATE emergency_switch SET enabled=false, reason='submission drill' WHERE key='submissions'");
    response = await app.inject({ method: "DELETE", url: `/v1/submissions/${draft.rows[0]!.id}/media/${media.rows[0]!.id}`, headers: auth() });
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe("SWITCH_SUBMISSIONS_OFF");
    await pool.query("UPDATE emergency_switch SET enabled=true, reason='normal' WHERE key='submissions'");
    response = await app.inject({ method: "DELETE", url: `/v1/submissions/${draft.rows[0]!.id}/media/${media.rows[0]!.id}`, headers: auth() });
    expect(response.statusCode).toBe(200);

    const rejected = await pool.query<{ id: string }>("INSERT INTO submission(member_id,status,version) VALUES ($1,'rejected',3) RETURNING id", [memberId]);
    await pool.query("INSERT INTO review_case(submission_id,status,version) VALUES ($1,'rejected',3)", [rejected.rows[0]!.id]);
    await pool.query("UPDATE emergency_switch SET enabled=false, reason='review drill' WHERE key='reviews'");
    response = await app.inject({
      method: "POST",
      url: `/v1/submissions/${rejected.rows[0]!.id}/appeal`,
      headers: { ...auth(), "idempotency-key": `switch-appeal-${rejected.rows[0]!.id}` },
      payload: { reason: "请求重新核验", expectedVersion: 3 }
    });
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe("SWITCH_REVIEWS_OFF");
    expect((await pool.query("SELECT count(*)::int count FROM appeal WHERE review_case_id=(SELECT id FROM review_case WHERE submission_id=$1)", [rejected.rows[0]!.id])).rows[0].count).toBe(0);
    await pool.query("UPDATE emergency_switch SET enabled=true, reason='normal' WHERE key='reviews'");
  });

  it("requires four-eyes finance approval and conserves unfreeze, expiry and reversal", async () => {
    const grant = await pool.query<{ id: string }>("SELECT id FROM points_grant WHERE member_id=$1 ORDER BY created_at LIMIT 1", [memberId]);
    const grantId = grant.rows[0]!.id;
    const finance = (principal: string, clock: string, key: string) => legacy(principal, { "x-dev-clock": clock, "idempotency-key": key });
    const operatorQueue = await json(await app.inject({ method: "GET", url: "/v1/admin/points/grants", headers: finance("finance-maker", "2026-08-10T12:00:00+08:00", "unused-read-key") }));
    expect(operatorQueue.some((item: any) => item.id === grantId)).toBe(true);
    const held = await app.inject({ method: "POST", url: `/v1/admin/points/grants/${grantId}/actions`, headers: finance("finance-dual", "2026-08-10T12:00:00+08:00", `points-unfreeze-held-${grantId}`), payload: { action: "unfreeze", expectedGrantVersion: 1, reasonCode: "HOLD_COMPLETE", evidence: { approval: "finance-test" } } });
    expect(held.statusCode).toBe(409); expect(held.json().code).toBe("POINTS_HOLD_ACTIVE");

    const requested = await json(await app.inject({ method: "POST", url: `/v1/admin/points/grants/${grantId}/actions`, headers: finance("finance-dual", "2026-08-15T12:00:00+08:00", `points-unfreeze-${grantId}`), payload: { action: "unfreeze", expectedGrantVersion: 1, reasonCode: "HOLD_COMPLETE", evidence: { approval: "finance-test" } } }));
    const selfApproval = await app.inject({ method: "POST", url: `/v1/admin/points/actions/${requested.requestId}/approve`, headers: finance("finance-dual", "2026-08-15T12:01:00+08:00", `points-self-approve-${requested.requestId}`), payload: { reasonCode: "CHECKED", evidence: { ticket: "same-person" } } });
    expect(selfApproval.statusCode).toBe(409); expect(selfApproval.json().code).toBe("FOUR_EYES_REQUIRED");
    const approveHeaders = finance("finance-checker", "2026-08-15T12:02:00+08:00", `points-approve-${requested.requestId}`);
    const unfrozen = await json(await app.inject({ method: "POST", url: `/v1/admin/points/actions/${requested.requestId}/approve`, headers: approveHeaders, payload: { reasonCode: "CHECKED", evidence: { ticket: "finance-001" } } }));
    const unfrozenReplay = await json(await app.inject({ method: "POST", url: `/v1/admin/points/actions/${requested.requestId}/approve`, headers: approveHeaders, payload: { reasonCode: "CHECKED", evidence: { ticket: "finance-001" } } }));
    expect(unfrozenReplay).toEqual(unfrozen); expect(unfrozen).toMatchObject({ grantState: "available", frozenDelta: -300, availableDelta: 300 });

    const reversal = await json(await app.inject({ method: "POST", url: `/v1/admin/points/grants/${grantId}/actions`, headers: finance("finance-maker", "2026-08-16T12:00:00+08:00", `points-reverse-${grantId}`), payload: { action: "reverse_remaining", expectedGrantVersion: 2, reasonCode: "REWARD_VOIDED", evidence: { case: "fraud-confirmed" } } }));
    await json(await app.inject({ method: "POST", url: `/v1/admin/points/actions/${reversal.requestId}/approve`, headers: finance("finance-checker", "2026-08-16T12:01:00+08:00", `points-approve-${reversal.requestId}`), payload: { reasonCode: "REVERSAL_CONFIRMED", evidence: { ticket: "finance-002" } } }));

    const campaign = await pool.query<{ id: string }>("SELECT id FROM eligibility_campaign WHERE code='care-d7-story-r0'");
    const expiringSubmission = await pool.query<{ id: string }>("INSERT INTO submission(member_id) VALUES ($1) RETURNING id", [memberId]);
    const expiringClaim = await pool.query<{ id: string }>(`INSERT INTO reward_claim(submission_id, member_id, campaign_id, rule_code, amount, state)
      VALUES ($1,$2,$3,'EXPIRY_TEST',20,'approved') RETURNING id`, [expiringSubmission.rows[0]!.id, memberId, campaign.rows[0]!.id]);
    const expiringGrant = await pool.query<{ id: string }>(`INSERT INTO points_grant(reward_claim_id, member_id, amount, state, available_after, expires_at)
      VALUES ($1,$2,20,'available','2026-01-01','2027-01-01') RETURNING id`, [expiringClaim.rows[0]!.id, memberId]);
    const expiringLot = await pool.query<{ id: string }>(`INSERT INTO points_lot(grant_id, original_amount, frozen_amount, available_amount, expires_at)
      VALUES ($1,20,0,20,'2027-01-01') RETURNING id`, [expiringGrant.rows[0]!.id]);
    await pool.query(`INSERT INTO points_entry(member_id, grant_id, lot_id, entry_type, frozen_delta, business_key, occurred_at)
      VALUES ($1,$2,$3,'grant_frozen',20,$4,'2026-01-01')`, [memberId, expiringGrant.rows[0]!.id, expiringLot.rows[0]!.id, `grant:${expiringGrant.rows[0]!.id}:frozen`]);
    await pool.query(`INSERT INTO points_entry(member_id, grant_id, lot_id, entry_type, frozen_delta, available_delta, business_key, occurred_at)
      VALUES ($1,$2,$3,'unfreeze',-20,20,$4,'2026-01-02')`, [memberId, expiringGrant.rows[0]!.id, expiringLot.rows[0]!.id, `grant:${expiringGrant.rows[0]!.id}:unfreeze`]);
    await pool.query("UPDATE points_projection SET available=available+20, version=version+1 WHERE member_id=$1", [memberId]);
    const rejectedExpiry = await json(await app.inject({ method: "POST", url: `/v1/admin/points/grants/${expiringGrant.rows[0]!.id}/actions`, headers: finance("finance-maker", "2027-01-02T12:00:00+08:00", `points-expire-draft-${expiringGrant.rows[0]!.id}`), payload: { action: "expire", expectedGrantVersion: 1, reasonCode: "EXPIRY_REACHED", evidence: { schedule: "unsigned-copy" } } }));
    const rejectedDecision = await json(await app.inject({ method: "POST", url: `/v1/admin/points/actions/${rejectedExpiry.requestId}/reject`, headers: finance("finance-checker", "2027-01-02T12:00:30+08:00", `points-reject-${rejectedExpiry.requestId}`), payload: { reasonCode: "EVIDENCE_INCOMPLETE", evidence: { ticket: "finance-003-rework" } } }));
    expect(rejectedDecision).toMatchObject({ state: "rejected", grantVersion: 2 });
    const expiry = await json(await app.inject({ method: "POST", url: `/v1/admin/points/grants/${expiringGrant.rows[0]!.id}/actions`, headers: finance("finance-maker", "2027-01-02T12:01:00+08:00", `points-expire-final-${expiringGrant.rows[0]!.id}`), payload: { action: "expire", expectedGrantVersion: 2, reasonCode: "EXPIRY_REACHED", evidence: { schedule: "signed-policy" } } }));
    await json(await app.inject({ method: "POST", url: `/v1/admin/points/actions/${expiry.requestId}/approve`, headers: finance("finance-checker", "2027-01-02T12:02:00+08:00", `points-approve-${expiry.requestId}`), payload: { reasonCode: "EXPIRY_CONFIRMED", evidence: { ticket: "finance-003" } } }));

    const conserved = await pool.query(`SELECT pp.frozen, pp.available, pp.debt,
      (SELECT count(*)::int FROM points_action_request WHERE state='approved') approved_actions,
      (SELECT count(*)::int FROM outbox_event WHERE event_type IN ('points.grant.unfrozen.v1','points.grant.expired.v1','points.grant.reversed.v1')) lifecycle_events,
      (SELECT bool_and(original_amount=frozen_amount+available_amount+expired_amount+reversed_amount) FROM points_lot) lots_conserve
      FROM points_projection pp WHERE pp.member_id=$1`, [memberId]);
    expect(conserved.rows[0]).toMatchObject({ frozen: 0, available: 0, debt: 0, approved_actions: 3, lifecycle_events: 3, lots_conserve: true });
  });

  it("separates reward review from four-eyes public publication and safely replays it", async () => {
    await processOutboxBatch(pool, new Date("2026-08-08T10:00:00+08:00"), 50, { ugcGoLiveGate: true });
    const privateAfterReview = await json(await app.inject({ method: "GET", url: "/v1/feed" })); expect(privateAfterReview).toHaveLength(0);
    const publishPayload = { title: "第 7 天护理记录", excerpt: "一份经过人工核验的护理阶段记录。", aiUsage: "none", reasonCode: "PUBLICATION_CLEAR", evidence: { rightsChecked: true, contentSafetyChecked: true } };
    const sameReviewer = await app.inject({ method: "POST", url: `/v1/admin/submissions/${submissionId}/publish`, headers: legacy("admin-reviewer", { "idempotency-key": `publish-self-${submissionId}` }), payload: publishPayload });
    expect(sameReviewer.statusCode).toBe(409); expect(sameReviewer.json().code).toBe("FOUR_EYES_REQUIRED");
    const lead = legacy("admin-lead", { "idempotency-key": `publish-${submissionId}-v1`, "x-dev-clock": "2026-08-08T10:00:00+08:00" });
    const queued = await json(await app.inject({ method: "POST", url: `/v1/admin/submissions/${submissionId}/publish`, headers: lead, payload: publishPayload }));
    const replay = await json(await app.inject({ method: "POST", url: `/v1/admin/submissions/${submissionId}/publish`, headers: lead, payload: publishPayload }));
    expect(queued.eventId).toBe(replay.eventId); expect(queued.status).toBe("publication_queued");
    await processOutboxBatch(pool, new Date("2026-08-08T10:00:30+08:00"), 50, { ugcGoLiveGate: false });
    const held = await pool.query("SELECT processed_at, attempts, last_error FROM outbox_event WHERE id=$1", [queued.eventId]);
    expect(held.rows[0].processed_at).toBeNull(); expect(held.rows[0].attempts).toBe(1); expect(held.rows[0].last_error).toContain("UGC_GO_LIVE_GATE_CLOSED");
    const stillPrivate = await json(await app.inject({ method: "GET", url: "/v1/feed" })); expect(stillPrivate).toHaveLength(0);
    await processOutboxBatch(pool, new Date("2026-08-08T10:01:00+08:00"), 50, { ugcGoLiveGate: true });
    await pool.query("UPDATE outbox_event SET processed_at=NULL WHERE event_type='submission.publication.approved.v1'");
    await processOutboxBatch(pool, new Date("2026-08-08T10:02:00+08:00"), 50, { ugcGoLiveGate: true });
    const feedBefore = await json(await app.inject({ method: "GET", url: "/v1/feed" })); expect(feedBefore).toHaveLength(1); expect(feedBefore[0].ai_usage).toBe("none");
    const feedPage = await json(await app.inject({ method: "GET", url: "/v1/feed/page?limit=1" }));
    expect(feedPage).toMatchObject({ items: [expect.objectContaining({ id: feedBefore[0].id })], nextCursor: null, authors: expect.any(Object), asOf: expect.any(String) });
    expect(await json(await app.inject({ method: "GET", url: `/v1/feed/${feedBefore[0].id}` }))).toMatchObject({ id: feedBefore[0].id, asOf: expect.any(String) });
    expect((await app.inject({ method: "GET", url: "/v1/feed/page?cursor=invalid" })).statusCode).toBe(422);
    const consents = await json(await app.inject({ method: "GET", url: "/v1/me/consents", headers: auth() }));
    const feedGrant = consents.find((item: any) => item.purpose === "feed_readonly");
    const pointsBeforeRevocation = await pool.query("SELECT blocked_for_use, (SELECT count(*)::int FROM points_entry) entries FROM points_grant WHERE id=(SELECT id FROM points_grant ORDER BY created_at LIMIT 1)");
    await json(await app.inject({ method: "POST", url: `/v1/consents/${feedGrant.id}/revoke`, headers: { ...auth(), "idempotency-key": `consent-revoke-${feedGrant.id}` }, payload: { reason: "MEMBER_REQUEST" } }));
    const feedAfter = await json(await app.inject({ method: "GET", url: "/v1/feed" })); expect(feedAfter).toHaveLength(0);
    const pointsAfterRevocation = await pool.query("SELECT blocked_for_use, (SELECT count(*)::int FROM points_entry) entries FROM points_grant WHERE id=(SELECT id FROM points_grant ORDER BY created_at LIMIT 1)");
    expect(pointsAfterRevocation.rows[0]).toEqual(pointsBeforeRevocation.rows[0]);
  });

  it("enforces object-level authorization and four independent switches", async () => {
    const outsider = await json(await app.inject({ method: "POST", url: "/v1/identity/dev", payload: { externalUserId: "outsider", displayName: "外部会员", consents: [{ documentType: "privacy", version: "v1" }, { documentType: "terms", version: "v1" }] } }));
    await expect(pool.query("INSERT INTO submission(member_id, post_url) VALUES ($1,$2)", [outsider.memberId, "https://example.test/care-story/vertical-1"])).rejects.toMatchObject({ code: "23505" });
    const forbidden = await app.inject({ method: "GET", url: `/v1/submissions/${submissionId}`, headers: { authorization: `Bearer ${outsider.sessionToken}` } });
    expect(forbidden.statusCode).toBe(404);
    const lead = legacy("admin-lead");
    const switchRows = await json(await app.inject({ method: "GET", url: "/v1/admin/switches", headers: lead }));
    const switchVersions = new Map<string, number>(switchRows.map((item: any) => [item.key, item.version]));
    for (const key of ["rewards", "redemption", "submissions", "commerce"] as const) {
      const version = switchVersions.get(key)!;
      const disabledHeaders = { ...lead, "idempotency-key": `switch-${key}-v${version}-disable` };
      const result = await json(await app.inject({ method: "PUT", url: `/v1/admin/switches/${key}`, headers: disabledHeaders, payload: { enabled: false, reason: "integration drill", expectedVersion: version } }));
      expect(result.enabled).toBe(false);
      const replay = await json(await app.inject({ method: "PUT", url: `/v1/admin/switches/${key}`, headers: disabledHeaders, payload: { enabled: false, reason: "integration drill", expectedVersion: version } }));
      expect(replay).toEqual(result);
      await json(await app.inject({ method: "PUT", url: `/v1/admin/switches/${key}`, headers: { ...lead, "idempotency-key": `switch-${key}-v${result.version}-enable` }, payload: { enabled: true, reason: "drill complete", expectedVersion: result.version } }));
    }
    const audits = await pool.query("SELECT count(*)::int count FROM audit_log WHERE action='emergency_switch.update'"); expect(audits.rows[0].count).toBe(8);
  });

  it("approves content without creating points assets when finance rules are disabled", async () => {
    const campaign = await pool.query<{ id: string }>(`INSERT INTO eligibility_campaign(code, qualifying_milestone, capacity, reward_points, starts_at, ends_at, active)
      VALUES ('NO_POINTS_TRIAL','D7',10,300,'2026-01-01','2027-01-01',true) RETURNING id`);
    const decision = await pool.query<{ id: string }>(`INSERT INTO eligibility_decision(campaign_id, cycle_id, fact_key, eligible, reason_code, decided_at)
      VALUES ($1,$2,$3,true,'TRIAL_ONLY','2026-08-08') RETURNING id`, [campaign.rows[0]!.id, cycleId, `${cycleId}:D7:no-points`]);
    const task = await pool.query<{ id: string }>(`INSERT INTO eligibility_task(decision_id, campaign_id, member_id, state, expires_at)
      VALUES ($1,$2,$3,'claimed','2027-01-01') RETURNING id`, [decision.rows[0]!.id, campaign.rows[0]!.id, memberId]);
    const trialSubmission = await pool.query<{ id: string }>(`INSERT INTO submission(member_id, status, post_url, platform_account, disclosure, license_payload, submitted_at)
      VALUES ($1,'submitted','https://example.test/care-story/no-points','体验账号','体验环境不发放真实积分','{"content_storage":true,"human_review":true,"feed_readonly":true}','2026-08-08') RETURNING id`, [memberId]);
    await pool.query("INSERT INTO task_claim(task_id, member_id, submission_id, claimed_at) VALUES ($1,$2,$3,'2026-08-08')", [task.rows[0]!.id, memberId, trialSubmission.rows[0]!.id]);
    await pool.query("INSERT INTO review_case(submission_id) VALUES ($1)", [trialSubmission.rows[0]!.id]);

    const disabledConfig = loadConfig({ APP_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, ALLOW_DEV_ADAPTERS: "true", APP_SESSION_SECRET: "test-session-secret", ADMIN_API_TOKEN: "test-admin-token", UPLOAD_TOKEN_SECRET: "test-upload-secret", OBJECT_STORAGE_DRIVER: "api_gateway" });
    const disabledApp = await createApp({ config: disabledConfig, pool, storage });
    try {
      const approved = await json(await disabledApp.inject({ method: "POST", url: `/v1/admin/submissions/${trialSubmission.rows[0]!.id}/review`, headers: legacy("admin-reviewer", { "idempotency-key": `review-${trialSubmission.rows[0]!.id}-v1` }), payload: { decision: "approve", reasonCode: "TRIAL_APPROVED", evidence: { checked: true }, expectedVersion: 1 } }));
      expect(approved).not.toHaveProperty("pointsGrantId");
      const assets = await pool.query("SELECT count(*)::int count FROM reward_claim WHERE submission_id=$1", [trialSubmission.rows[0]!.id]);
      expect(assets.rows[0]!.count).toBe(0);
      const publication = await disabledApp.inject({ method: "POST", url: `/v1/admin/submissions/${trialSubmission.rows[0]!.id}/publish`, headers: legacy("admin-lead", { "idempotency-key": `publish-disabled-${trialSubmission.rows[0]!.id}` }), payload: { title: "不应公开", excerpt: "门禁关闭时不应创建发布事件。", aiUsage: "none", reasonCode: "PUBLICATION_CLEAR", evidence: { checked: true } } });
      expect(publication.statusCode).toBe(503); expect(publication.json().code).toBe("UGC_GO_LIVE_GATE_CLOSED");
      const publicationEvents = await pool.query("SELECT count(*)::int count FROM outbox_event WHERE aggregate_id=$1 AND event_type='submission.publication.approved.v1'", [trialSubmission.rows[0]!.id]);
      expect(publicationEvents.rows[0]!.count).toBe(0);
    } finally {
      await disabledApp.close();
    }
  });

  it("stops advertising rewards when the finance approval expires during a long-running process", async () => {
    const expiredClock = "2100-01-01T00:00:00Z";
    const tasks = await json(await app.inject({ method: "GET", url: "/v1/me/tasks", headers: auth(expiredClock) }));
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((task: any) => task.reward_enabled === false && task.reward_points === null)).toBe(true);
    const task = await json(await app.inject({ method: "GET", url: `/v1/tasks/${taskId}`, headers: auth(expiredClock) }));
    expect(task).toMatchObject({ reward_enabled: false, reward_points: null });
    const submission = await json(await app.inject({ method: "GET", url: `/v1/submissions/${submissionId}`, headers: auth(expiredClock) }));
    expect(submission.reward_enabled).toBe(false);
    const points = await json(await app.inject({ method: "GET", url: "/v1/me/points", headers: auth(expiredClock) }));
    expect(points.rulesEnabled).toBe(false);

    const queued = await pool.query<{ id: string }>(`INSERT INTO submission(member_id,status,post_url,platform_account,disclosure,submitted_at)
      VALUES ($1,'submitted','https://example.test/care-story/expired-policy-read','审批到期测试','到期后不得宣称积分启用',$2) RETURNING id`, [memberId, new Date("2099-12-31T23:59:58Z")]);
    await pool.query("INSERT INTO review_case(submission_id) VALUES ($1)", [queued.rows[0]!.id]);
    const reviewQueue = await json(await app.inject({ method: "GET", url: "/v1/admin/reviews", headers: legacy("admin-reviewer", { "x-dev-clock": expiredClock }) }));
    expect(reviewQueue.find((item: any) => item.id === queued.rows[0]!.id)).toMatchObject({ reward_enabled: false });
  });

  it("operates invitation campaigns through versioned RBAC and audit instead of seed-only mutation", async () => {
    const adminHeaders = legacy("admin-reviewer", { "x-dev-clock": "2026-08-15T15:00:00+08:00" });
    const campaigns = await json(await app.inject({ method: "GET", url: "/v1/admin/campaigns", headers: adminHeaders }));
    const campaign = campaigns.find((item: any) => item.code === "care-d7-story-r0");
    expect(campaign).toBeTruthy();
    const payload = {
      active: campaign.active,
      capacity: Math.max(campaign.capacity, campaign.allocated_count),
      startsAt: campaign.starts_at,
      endsAt: campaign.ends_at,
      expectedVersion: campaign.version,
      reasonCode: "R0_CAPACITY_RECONFIRMED",
      evidence: { approval: "integration-reviewed" }
    };
    const denied = await app.inject({ method: "PUT", url: `/v1/admin/campaigns/${campaign.id}`, headers: legacy("finance-maker", { "idempotency-key": "campaign-update-denied" }), payload });
    expect(denied.statusCode).toBe(403);
    const headers = { ...adminHeaders, "idempotency-key": `campaign-${campaign.id}-v${campaign.version}` };
    const updated = await json(await app.inject({ method: "PUT", url: `/v1/admin/campaigns/${campaign.id}`, headers, payload }));
    const replay = await json(await app.inject({ method: "PUT", url: `/v1/admin/campaigns/${campaign.id}`, headers, payload }));
    expect(replay).toEqual(updated);
    expect(updated).toMatchObject({ version: campaign.version + 1, updated_by: "admin-reviewer", update_reason_code: "R0_CAPACITY_RECONFIRMED" });
    expect((await pool.query("SELECT count(*)::int count FROM audit_log WHERE action='eligibility_campaign.update' AND object_id=$1", [campaign.id])).rows[0].count).toBe(1);
  });
});

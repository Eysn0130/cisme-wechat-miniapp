import { communityAuthors } from './memberProfile.js';
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { CARE_PROTOCOL_STEPS, CARE_SELF_ASSESSMENTS, type CareMilestone, type CareMilestoneCommandInput, type CarePhase, type CareVersionCommandInput, type EmergencySwitchKey, type ReviewDecision, type ReviewResult, type ShareTargetType, type TaskClaimView, type UploadAuthorization, type WorkerQueue } from "@cisme/contracts";
import { assertMilestone, assertTimezone, deriveDueMilestone, DomainError, milestoneDueOn } from "@cisme/domain";
import type { AppConfig } from "@cisme/config";
import { readSnapshot, transaction, type DbClient } from "./db.js";
import { enqueue } from "./outbox.js";
import { objectKey, type ObjectStorage } from "./storage.js";
import { EVENT_DELIVERY_POLICIES, type EventType } from "@cisme/contracts";

type JsonObject = Record<string, unknown>;

interface CycleRow {
  id: string;
  member_id: string;
  phase: CarePhase;
  started_on: string | Date | null;
  timezone: string;
  protocol_version: string;
  version: number;
  schedule_offset_days: number;
  created_at: Date;
}

interface CareRecordRow {
  id: string;
  cycle_id: string;
  milestone: CareMilestone;
  completed_at: Date;
  protocol_version: string;
  self_assessment: string | null;
}

interface CareRecordStepRow {
  record_id: string;
  step_code: string;
}

function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const map = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function dateString(value: string | Date | null): string | null {
  if (!(value instanceof Date)) return value;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function calendarDayDifference(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000));
}

function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

function requireMember(memberId: string | undefined): string {
  if (!memberId) throw new DomainError("MEMBER_REQUIRED", "Member identity is required", 401);
  return memberId;
}

function requireExpectedVersion(input: CareVersionCommandInput | undefined): number {
  if (!Number.isInteger(input?.expectedVersion) || input!.expectedVersion < 1) {
    throw new DomainError("EXPECTED_VERSION_INVALID", "expectedVersion must be a positive integer", 422);
  }
  return input!.expectedVersion;
}

function requireCareRecordDetails(input: CareMilestoneCommandInput | undefined): Pick<CareMilestoneCommandInput, "stepCodes" | "selfAssessment"> {
  const stepCodes = input?.stepCodes;
  if (!Array.isArray(stepCodes) || stepCodes.length !== CARE_PROTOCOL_STEPS.length || stepCodes.some((step, index) => step !== CARE_PROTOCOL_STEPS[index])) {
    throw new DomainError("CARE_PROTOCOL_STEPS_INCOMPLETE", "All care protocol steps must be completed in order", 422);
  }
  if (!CARE_SELF_ASSESSMENTS.includes(input?.selfAssessment as (typeof CARE_SELF_ASSESSMENTS)[number])) {
    throw new DomainError("CARE_SELF_ASSESSMENT_REQUIRED", "A supported post-care self-assessment is required", 422);
  }
  return { stepCodes: [...stepCodes], selfAssessment: input!.selfAssessment };
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pageCursor(value: { at: Date | string; id: string }): string {
  return Buffer.from(JSON.stringify([new Date(value.at).toISOString(), value.id])).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    const at = new Date(String(parsed[0]));
    const id = String(parsed[1]);
    if (!Number.isFinite(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error();
    return { at, id };
  } catch { throw new DomainError("CURSOR_INVALID", "Pagination cursor is invalid", 422); }
}

function pageLimit(value: number | undefined, fallback = 20, maximum = 100): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new DomainError("PAGE_LIMIT_INVALID", `Page limit must be between 1 and ${maximum}`, 422);
  return value;
}

function taskStoryName(milestone: string): string {
  const day = milestone.match(/^D(\d+)$/)?.[1];
  return day ? `第 ${day} 天真实护理日记` : `${milestone} 真实护理日记`;
}

function reviewReasonSummary(reasonCode: string | null | undefined): string | null {
  if (!reasonCode) return null;
  const reasons: Record<string, string> = {
    EVIDENCE_INCOMPLETE: "提交的证明材料不完整，请按要求补充原图、截图或发布信息。",
    DISCLOSURE_INCOMPLETE: "利益关系披露不完整，请补充后再次提交。",
    POLICY_REVIEW: "材料需要进一步核验，请在申诉中补充真实情况与相关依据。",
    POLICY_VIOLATION: "本次内容未满足活动发布规则，可提交申诉说明具体情况。"
  };
  return reasons[reasonCode] ?? "审核团队已记录处理说明；如需补充或申诉，请按当前页面提示操作。";
}

export class PlatformService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AppConfig,
    private readonly storage: ObjectStorage,
    private readonly clock: () => Date = () => new Date()
  ) {}

  now(override?: string): Date {
    if (override && this.config.allowDevAdapters) return new Date(override);
    if (this.config.devClock && this.config.allowDevAdapters) return new Date(this.config.devClock);
    return this.clock();
  }

  private async idempotencyLookup<T>(client: DbClient, input: { principalId: string; operation: string; idempotencyKey: string; businessKey: string; requestHash: string }): Promise<T | null> {
    const result = await client.query<{ request_hash: string; response_body: T }>(`SELECT request_hash, response_body FROM idempotency_operation
      WHERE principal_id=$1 AND operation=$2 AND (idempotency_key=$3 OR business_key=$4)
      ORDER BY (idempotency_key=$3) DESC LIMIT 1`, [input.principalId, input.operation, input.idempotencyKey, input.businessKey]);
    const existing = result.rows[0];
    if (!existing) return null;
    if (existing.request_hash !== input.requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key or business operation was reused with different input", 409);
    return existing.response_body;
  }

  private async idempotencySave(client: DbClient, input: { principalId: string; operation: string; idempotencyKey: string; businessKey: string; requestHash: string; response: unknown }): Promise<void> {
    await client.query(`INSERT INTO idempotency_operation(principal_id, operation, idempotency_key, business_key, request_hash, response_status, response_body)
      VALUES ($1,$2,$3,$4,$5,200,$6)`, [input.principalId, input.operation, input.idempotencyKey, input.businessKey, input.requestHash, input.response]);
  }

  async assertSwitch(client: DbClient, key: EmergencySwitchKey): Promise<void> {
    const result = await client.query<{ enabled: boolean; reason: string }>("SELECT enabled, reason FROM emergency_switch WHERE key=$1", [key]);
    if (!result.rows[0]?.enabled) throw new DomainError(`SWITCH_${key.toUpperCase()}_OFF`, `Operation disabled: ${result.rows[0]?.reason ?? "emergency switch"}`, 503);
  }

  async identity(input: { provider: "wechat_miniprogram" | "dev_test"; appId: string; openid: string; unionid?: string; displayName: string; adapter: "wechat" | "dev"; consents: Array<{ documentType: string; version: string }> }, now: Date) {
    if (input.adapter === "dev" && !this.config.allowDevAdapters) throw new DomainError("DEV_ADAPTER_FORBIDDEN", "Development identity adapter is disabled", 503);
    const displayName = input.displayName?.trim();
    if (!displayName || Array.from(displayName).length > 40) throw new DomainError("IDENTITY_DISPLAY_NAME_INVALID", "Display name is required and must not exceed 40 characters", 422);
    if (!Array.isArray(input.consents) || input.consents.some(c => !c || typeof c.documentType !== "string" || typeof c.version !== "string") || !input.consents.some((c) => c.documentType === "privacy") || !input.consents.some((c) => c.documentType === "terms")) {
      throw new DomainError("CONSENT_REQUIRED", "Privacy and terms acceptance are required", 422);
    }
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "identity");
      if (input.adapter === "wechat") {
        const documents = await client.query("SELECT document_type,version FROM legal_document WHERE active=true FOR SHARE");
        if (!(["terms", "privacy"].every(type => documents.rows.some(doc => doc.document_type === type))) || documents.rows.some(document => !input.consents.some(consent => consent.documentType === document.document_type && consent.version === document.version))) throw new DomainError("LEGAL_VERSION_REQUIRED", "请阅读并同意当前版本的用户协议和隐私指引", 409);
      }
      // A row lock cannot protect the first login because no identity row exists
      // yet. Serialize the natural identity key before checking/inserting it.
      if ((input.provider === "wechat_miniprogram") !== (input.adapter === "wechat")) throw new DomainError("IDENTITY_PROVIDER_INVALID", "Identity provider and adapter do not match", 422);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`external-identity:${input.provider}:${input.appId}:${input.openid}`]);
      const existing = await client.query<{ member_id: string; identity_id: string }>(
        "SELECT member_id, id AS identity_id FROM wechat_identity WHERE provider=$1 AND app_id=$2 AND openid=$3 FOR UPDATE", [input.provider, input.appId, input.openid]
      );
      let memberId = existing.rows[0]?.member_id;
      let identityId = existing.rows[0]?.identity_id;
      if (!memberId || !identityId) {
        memberId = randomUUID();
        identityId = randomUUID();
        await client.query("INSERT INTO member(id, display_name) VALUES ($1,$2)", [memberId, displayName]);
        await client.query(
          "INSERT INTO wechat_identity(id, member_id, provider, app_id, openid, unionid, adapter) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [identityId, memberId, input.provider, input.appId, input.openid, input.unionid ?? null, input.adapter]
        );
        await client.query("INSERT INTO points_projection(member_id) VALUES ($1) ON CONFLICT DO NOTHING", [memberId]);
      }
      // Re-authentication never overwrites member-managed or reviewed profile data.
      const principalId = `${input.provider}:${identityId}`;
      for (const consent of input.consents) {
        await client.query(`
          INSERT INTO consent_acceptance(member_id, document_type, document_version, accepted_at, principal_id)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
        `, [memberId, consent.documentType, consent.version, now, principalId]);
      }
      await enqueue(client, {
        eventType: "identity.accepted.v1", aggregateType: "member", aggregateId: memberId, aggregateVersion: 1,
        businessKey: `identity:${identityId}:accepted`, payload: { memberId, provider: input.provider, appId: input.appId }, occurredAt: now
      });
      return { memberId, identityId, principalId };
    });
  }

  async recordQualification(memberId: string | undefined, input: { source: string; externalRef: string; occurredAt: string; payload?: JsonObject }, now: Date) {
    const owner = requireMember(memberId);
    if (!this.config.allowDevAdapters && input.source.startsWith("dev")) throw new DomainError("DEV_ADAPTER_FORBIDDEN", "Development qualification adapter is disabled", 503);
    return transaction(this.pool, async (client) => {
      const existing = await client.query<{ id: string }>("SELECT id FROM qualification_fact WHERE source=$1 AND external_ref=$2", [input.source, input.externalRef]);
      if (existing.rows[0]) return existing.rows[0];
      const id = randomUUID();
      await client.query(`INSERT INTO qualification_fact(id, member_id, source, external_ref, occurred_at, payload)
        VALUES ($1,$2,$3,$4,$5,$6)`, [id, owner, input.source, input.externalRef, input.occurredAt, input.payload ?? {}]);
      await enqueue(client, {
        eventType: "qualification.recorded.v1", aggregateType: "qualification_fact", aggregateId: id, aggregateVersion: 1,
        businessKey: `qualification:${input.source}:${input.externalRef}`, payload: { memberId: owner }, occurredAt: now
      });
      return { id };
    });
  }

  async enrollExperienceMember(principalId: string, input: { memberId: string; qualificationType: "verified_delivery" | "approved_tester_fulfillment"; externalRef: string; occurredAt: string; timezone: string; protocolVersion: string; reasonCode: string; evidence: JsonObject }, now: Date) {
    assertTimezone(input.timezone);
    const occurredAt = new Date(input.occurredAt);
    if (!input.memberId || !input.externalRef?.trim() || !input.protocolVersion?.trim() || !input.reasonCode?.trim() || !input.evidence || Object.keys(input.evidence).length === 0) {
      throw new DomainError("TESTER_ENROLLMENT_FIELDS_REQUIRED", "Member, qualification reference, protocol, reason and evidence are required", 422);
    }
    if (Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > now.getTime() + 5 * 60_000) throw new DomainError("QUALIFICATION_TIME_INVALID", "Qualification time must be valid and cannot be in the future", 422);
    const source = input.qualificationType === "verified_delivery" ? "admin_verified_delivery" : "admin_approved_tester_fulfillment";
    return transaction(this.pool, async (client) => {
      await this.assertAdminRole(client, principalId, ["review_lead", "support"]);
      const member = await client.query("SELECT id FROM member WHERE id=$1", [input.memberId]);
      if (!member.rows[0]) throw new DomainError("MEMBER_NOT_FOUND", "Member not found", 404);
      const existingFact = await client.query<{ id: string; member_id: string }>("SELECT id, member_id FROM qualification_fact WHERE source=$1 AND external_ref=$2 FOR UPDATE", [source, input.externalRef.trim()]);
      if (existingFact.rows[0] && existingFact.rows[0].member_id !== input.memberId) throw new DomainError("QUALIFICATION_REFERENCE_CONFLICT", "Qualification reference belongs to another member", 409);
      let qualificationFactId = existingFact.rows[0]?.id;
      if (!qualificationFactId) {
        qualificationFactId = randomUUID();
        await client.query(`INSERT INTO qualification_fact(id, member_id, source, external_ref, occurred_at, payload)
          VALUES ($1,$2,$3,$4,$5,$6)`, [qualificationFactId, input.memberId, source, input.externalRef.trim(), occurredAt, { qualificationType: input.qualificationType, evidence: input.evidence, recordedBy: principalId }]);
        await enqueue(client, {
          eventType: "qualification.recorded.v1", aggregateType: "qualification_fact", aggregateId: qualificationFactId, aggregateVersion: 1,
          businessKey: `qualification:${source}:${input.externalRef.trim()}`, payload: { memberId: input.memberId, source, recordedBy: principalId }, occurredAt: now
        });
      }
      const existingCycle = await client.query<CycleRow>("SELECT * FROM care_cycle WHERE qualification_fact_id=$1", [qualificationFactId]);
      if (existingCycle.rows[0]) return { qualificationFactId, cycle: await this.cycleView(client, existingCycle.rows[0], now) };
      const openCycle = await client.query("SELECT id FROM care_cycle WHERE member_id=$1 AND phase IN ('planned','active','paused') FOR UPDATE", [input.memberId]);
      if (openCycle.rows[0]) throw new DomainError("CARE_CYCLE_ALREADY_OPEN", "Member already has an open care cycle", 409);
      const cycleId = randomUUID();
      await client.query(`INSERT INTO care_cycle(id, member_id, qualification_fact_id, timezone, protocol_version)
        VALUES ($1,$2,$3,$4,$5)`, [cycleId, input.memberId, qualificationFactId, input.timezone, input.protocolVersion.trim()]);
      await enqueue(client, {
        eventType: "care.cycle.planned.v1", aggregateType: "care_cycle", aggregateId: cycleId, aggregateVersion: 1,
        businessKey: `care:${cycleId}:planned`, payload: { memberId: input.memberId, qualificationFactId, source, recordedBy: principalId }, occurredAt: now
      });
      await this.audit(client, principalId, "tester_enrollment.qualify", "care_cycle", cycleId, input.reasonCode, null, { memberId: input.memberId, qualificationFactId, source, protocolVersion: input.protocolVersion });
      const cycle = await client.query<CycleRow>("SELECT * FROM care_cycle WHERE id=$1", [cycleId]);
      return { qualificationFactId, cycle: await this.cycleView(client, cycle.rows[0]!, now) };
    }, "SERIALIZABLE");
  }

  async planCycle(memberId: string | undefined, input: { qualificationFactId: string; timezone: string; protocolVersion: string }, now: Date) {
    const owner = requireMember(memberId);
    assertTimezone(input.timezone);
    return transaction(this.pool, async (client) => {
      const fact = await client.query<{ member_id: string }>("SELECT member_id FROM qualification_fact WHERE id=$1", [input.qualificationFactId]);
      if (!fact.rows[0] || fact.rows[0].member_id !== owner) throw new DomainError("QUALIFICATION_NOT_FOUND", "Qualification fact not found", 404);
      const existing = await client.query<CycleRow>("SELECT * FROM care_cycle WHERE qualification_fact_id=$1", [input.qualificationFactId]);
      if (existing.rows[0]) return this.cycleView(client, existing.rows[0], now);
      const openCycle = await client.query("SELECT id FROM care_cycle WHERE member_id=$1 AND phase IN ('planned','active','paused') FOR UPDATE", [owner]);
      if (openCycle.rows[0]) throw new DomainError("CARE_CYCLE_ALREADY_OPEN", "Member already has an open care cycle", 409);
      const id = randomUUID();
      await client.query(`INSERT INTO care_cycle(id, member_id, qualification_fact_id, timezone, protocol_version)
        VALUES ($1,$2,$3,$4,$5)`, [id, owner, input.qualificationFactId, input.timezone, input.protocolVersion]);
      await enqueue(client, {
        eventType: "care.cycle.planned.v1", aggregateType: "care_cycle", aggregateId: id, aggregateVersion: 1,
        businessKey: `care:${id}:planned`, payload: { memberId: owner, qualificationFactId: input.qualificationFactId }, occurredAt: now
      });
      const cycle = await client.query<CycleRow>("SELECT * FROM care_cycle WHERE id=$1", [id]);
      return this.cycleView(client, cycle.rows[0]!, now);
    });
  }

  async activateCycle(memberId: string | undefined, cycleId: string, idempotencyKey: string, input: CareVersionCommandInput | undefined, now: Date) {
    const owner = requireMember(memberId);
    const expectedVersion = requireExpectedVersion(input);
    return transaction(this.pool, async (client) => {
      const idem = {
        principalId: `member:${owner}`,
        operation: "care.activate",
        idempotencyKey,
        businessKey: `care:${cycleId}:v${expectedVersion}:activate`,
        requestHash: requestHash({ cycleId, ...(input ?? {}) })
      };
      const cycle = await this.lockCycle(client, cycleId, owner);
      const replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      if (cycle.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT", "Care-cycle version changed", 409);
      if (cycle.phase !== "planned") {
        const response = await this.cycleView(client, cycle, now);
        await this.idempotencySave(client, { ...idem, response });
        return response;
      }
      const startedOn = localDate(now, cycle.timezone);
      const updated = await client.query<CycleRow>(`UPDATE care_cycle SET phase='active', started_on=$1, version=version+1, updated_at=$2 WHERE id=$3 RETURNING *`, [startedOn, now, cycleId]);
      await enqueue(client, {
        eventType: "care.cycle.activated.v1", aggregateType: "care_cycle", aggregateId: cycleId, aggregateVersion: updated.rows[0]!.version,
        businessKey: `care:${cycleId}:activated`, payload: { memberId: owner, startedOn }, occurredAt: now
      });
      const response = await this.cycleView(client, updated.rows[0]!, now);
      await this.idempotencySave(client, { ...idem, response });
      return response;
    });
  }

  async changeCyclePhase(memberId: string | undefined, cycleId: string, action: "pause" | "resume" | "terminate", idempotencyKey: string, input: { reasonCode: string; expectedVersion: number }, now: Date) {
    const owner = requireMember(memberId);
    const reasonCode = input.reasonCode?.trim();
    if (!reasonCode) throw new DomainError("CARE_REASON_REQUIRED", "A reason code is required for every care-cycle state change", 422);
    return transaction(this.pool, async (client) => {
      const idem = { principalId: `member:${owner}`, operation: `care.${action}`, idempotencyKey, businessKey: `care:${cycleId}:v${input.expectedVersion}:phase`, requestHash: requestHash({ cycleId, action, ...input }) };
      let replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      const cycle = await this.lockCycle(client, cycleId, owner);
      replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      if (cycle.version !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "Care-cycle version changed", 409);
      const transitions: Record<typeof action, [CarePhase, CarePhase]> = {
        pause: ["active", "paused"], resume: ["paused", "active"], terminate: [cycle.phase, "terminated"]
      };
      const [required, next] = transitions[action];
      if (action === "terminate" && !["active", "paused"].includes(cycle.phase)) throw new DomainError("CARE_TRANSITION_INVALID", "Only active or paused cycles can be terminated");
      if (action !== "terminate" && cycle.phase !== required) throw new DomainError("CARE_TRANSITION_INVALID", `Cannot ${action} a ${cycle.phase} cycle`);
      const today = localDate(now, cycle.timezone);
      let offsetDelta = 0;
      let pauseId: string | null = null;
      if (action === "pause") {
        const policy = this.config.carePausePolicy;
        if (!policy.version || policy.maxDays < 1 || !policy.reasonCodes.includes(reasonCode)) {
          throw new DomainError("CARE_PAUSE_POLICY_NOT_APPROVED", "Pause is unavailable until an approved reason and maximum duration are configured", 503);
        }
        pauseId = randomUUID();
        await client.query(`INSERT INTO care_cycle_pause(id, cycle_id, reason_code, policy_version, paused_at, paused_on)
          VALUES ($1,$2,$3,$4,$5,$6)`, [pauseId, cycleId, reasonCode, policy.version, now, today]);
      } else if (cycle.phase === "paused") {
        const openPause = await client.query<{ id: string; paused_on: string | Date }>("SELECT id, paused_on FROM care_cycle_pause WHERE cycle_id=$1 AND ended_at IS NULL FOR UPDATE", [cycleId]);
        const pause = openPause.rows[0];
        if (!pause) throw new DomainError("CARE_PAUSE_FACT_MISSING", "The open pause fact is missing", 500);
        const pausedOn = dateString(pause.paused_on)!;
        const durationDays = calendarDayDifference(pausedOn, today);
        if (action === "resume" && durationDays > this.config.carePausePolicy.maxDays) {
          throw new DomainError("CARE_PAUSE_LIMIT_EXCEEDED", "The approved maximum pause duration was exceeded; support review is required", 409);
        }
        pauseId = pause.id;
        offsetDelta = action === "resume" ? durationDays : 0;
        await client.query(`UPDATE care_cycle_pause SET ended_at=$1, ended_on=$2, end_action=$3, duration_days=$4 WHERE id=$5`, [now, today, action, durationDays, pause.id]);
      }
      const updated = await client.query<CycleRow>("UPDATE care_cycle SET phase=$1, schedule_offset_days=schedule_offset_days+$2, version=version+1, updated_at=$3 WHERE id=$4 RETURNING *", [next, offsetDelta, now, cycleId]);
      const eventType = action === "pause" ? "care.cycle.paused.v1" : action === "resume" ? "care.cycle.resumed.v1" : "care.cycle.terminated.v1";
      await enqueue(client, {
        eventType, aggregateType: "care_cycle", aggregateId: cycleId, aggregateVersion: updated.rows[0]!.version,
        businessKey: `care:${cycleId}:${action}:v${updated.rows[0]!.version}`, payload: { memberId: owner, reasonCode, pauseId, scheduleOffsetDaysAdded: offsetDelta }, occurredAt: now
      });
      await this.audit(client, `member:${owner}`, `care_cycle.${action}`, "care_cycle", cycleId, reasonCode,
        { phase: cycle.phase, version: cycle.version, scheduleOffsetDays: cycle.schedule_offset_days },
        { phase: next, version: updated.rows[0]!.version, scheduleOffsetDays: updated.rows[0]!.schedule_offset_days, pauseId });
      const response = await this.cycleView(client, updated.rows[0]!, now);
      await this.idempotencySave(client, { ...idem, response });
      return response;
    });
  }

  async completeMilestone(memberId: string | undefined, cycleId: string, milestoneRaw: string, idempotencyKey: string, input: CareMilestoneCommandInput | undefined, now: Date) {
    const owner = requireMember(memberId);
    assertMilestone(milestoneRaw);
    const milestone = milestoneRaw;
    const expectedVersion = requireExpectedVersion(input);
    const details = requireCareRecordDetails(input);
    return transaction(this.pool, async (client) => {
      const idem = {
        principalId: `member:${owner}`,
        operation: "care.milestone.complete",
        idempotencyKey,
        businessKey: `care:${cycleId}:${milestone}:v${expectedVersion}:complete`,
        requestHash: requestHash({ cycleId, milestone, ...(input ?? {}) })
      };
      let cycle = await this.lockCycle(client, cycleId, owner);
      const replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      if (cycle.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT", "Care-cycle version changed", 409);
      const existing = await client.query("SELECT * FROM care_record WHERE cycle_id=$1 AND milestone=$2", [cycleId, milestone]);
      if (existing.rows[0]) {
        const response = { cycle: await this.cycleView(client, cycle, now), record: existing.rows[0], task: await this.taskForCycle(client, cycleId) };
        await this.idempotencySave(client, { ...idem, response });
        return response;
      }
      if (cycle.phase !== "active") throw new DomainError("CARE_NOT_ACTIVE", "Only an active cycle can complete a milestone");
      const records = await client.query<{ milestone: CareMilestone }>("SELECT milestone FROM care_record WHERE cycle_id=$1 ORDER BY due_on", [cycleId]);
      const due = deriveDueMilestone(dateString(cycle.started_on), records.rows.map((row) => row.milestone), now, cycle.timezone, cycle.schedule_offset_days);
      if (!due) throw new DomainError("CARE_NO_DUE_MILESTONE", "No care milestone is due", 409);
      if (due !== milestone) throw new DomainError("CARE_MILESTONE_NOT_DUE", `${milestone} is not the current due milestone`, 409);
      const recordId = randomUUID();
      const dueOn = milestoneDueOn(dateString(cycle.started_on)!, milestone, cycle.schedule_offset_days);
      await client.query(`INSERT INTO care_record(id, cycle_id, milestone, due_on, completed_at, protocol_version, self_assessment)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [recordId, cycleId, milestone, dueOn, now, cycle.protocol_version, details.selfAssessment]);
      for (const [sequence, stepCode] of details.stepCodes.entries()) {
        await client.query(`INSERT INTO care_record_step(record_id, step_code, sequence, completed_at, protocol_version)
          VALUES ($1,$2,$3,$4,$5)`, [recordId, stepCode, sequence, now, cycle.protocol_version]);
      }
      const updated = await client.query<CycleRow>(`UPDATE care_cycle
        SET phase=CASE WHEN $2='D28' THEN 'completed' ELSE phase END,
          version=version+1, updated_at=$3
        WHERE id=$1 RETURNING *`, [cycleId, milestone, now]);
      cycle = updated.rows[0]!;
      await enqueue(client, {
        eventType: "care.milestone.completed.v1", aggregateType: "care_cycle", aggregateId: cycleId, aggregateVersion: cycle.version,
        businessKey: `care:${cycleId}:${milestone}`, payload: { memberId: owner, milestone, recordId, stepCodes: details.stepCodes, selfAssessment: details.selfAssessment }, occurredAt: now
      });
      let task = null;
      if (milestone === "D7") task = await this.decideEligibility(client, cycle, recordId, now);
      const record = await client.query("SELECT * FROM care_record WHERE id=$1", [recordId]);
      const response = { cycle: await this.cycleView(client, cycle, now), record: { ...record.rows[0], stepCodes: details.stepCodes, selfAssessment: details.selfAssessment }, task };
      await this.idempotencySave(client, { ...idem, response });
      return response;
    }, "SERIALIZABLE");
  }

  private async careSnapshot(client: DbClient, owner: string, now: Date, options: { limit?: number; cursor?: string } = {}) {
      const limit = pageLimit(options.limit);
      const cursor = decodeCursor(options.cursor);
      const current = await client.query<CycleRow>("SELECT * FROM care_cycle WHERE member_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [owner]);
      if (!current.rows[0]) return null;
      const history = await client.query<CycleRow>(`SELECT * FROM care_cycle WHERE member_id=$1 AND id<>$2
        AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5`,
        [owner, current.rows[0].id, cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
      const selected = [current.rows[0], ...history.rows.slice(0, limit)];
      const cycleIds = selected.map((cycle) => cycle.id);
      const records = await client.query<CareRecordRow>(`SELECT id, cycle_id, milestone, completed_at, protocol_version, self_assessment
        FROM care_record WHERE cycle_id = ANY($1::uuid[]) ORDER BY cycle_id, due_on`, [cycleIds]);
      const recordIds = records.rows.map((record) => record.id);
      const steps = recordIds.length
        ? await client.query<CareRecordStepRow>("SELECT record_id, step_code FROM care_record_step WHERE record_id = ANY($1::uuid[]) ORDER BY record_id, sequence", [recordIds])
        : { rows: [] as CareRecordStepRow[] };
      const recordsByCycle = new Map<string, CareRecordRow[]>();
      for (const record of records.rows) recordsByCycle.set(record.cycle_id, [...(recordsByCycle.get(record.cycle_id) ?? []), record]);
      const stepsByRecord = this.groupCareRecordSteps(steps.rows);
      const views = selected.map((cycle) => this.cycleViewFromRows(cycle, recordsByCycle.get(cycle.id) ?? [], stepsByRecord, now));
      const last = history.rows.length > limit ? history.rows[limit - 1] : null;
      return { ...views[0]!, history: views.slice(1), nextCursor: last ? pageCursor({ at: last.created_at, id: last.id }) : null };
  }

  async getCare(memberId: string | undefined, now: Date, options: { limit?: number; cursor?: string } = {}) {
    const owner = requireMember(memberId);
    return readSnapshot(this.pool, (client) => this.careSnapshot(client, owner, now, options));
  }

  async getMember(memberId: string | undefined) {
    const owner = requireMember(memberId);
    const member = await this.pool.query(`SELECT m.id,m.display_name,m.status,m.created_at,p.avatar_data_url,p.avatar_revision,COALESCE(p.profile_revision,0) AS profile_revision,p.completed_at,COALESCE(p.public_status,'private') AS public_status,c.phone_masked FROM member m LEFT JOIN member_profile p ON p.member_id=m.id LEFT JOIN member_contact c ON c.member_id=m.id WHERE m.id=$1`, [owner]);
    if (!member.rows[0]) throw new DomainError("MEMBER_NOT_FOUND", "Member not found", 404);
    return member.rows[0];
  }

  async assertActiveMember(memberId: string | undefined): Promise<void> {
    const owner = requireMember(memberId);
    const member = await this.pool.query<{ status: string }>("SELECT status FROM member WHERE id=$1", [owner]);
    if (member.rows[0]?.status !== "active") {
      throw new DomainError("AUTH_REVOKED", "Member session is no longer active", 401);
    }
  }

  async createShare(memberId: string | undefined, idempotencyKey: string, input: { targetType: ShareTargetType; targetRef: string }, now: Date) {
    const owner = requireMember(memberId);
    const targetRef = input.targetRef?.trim();
    if (!(["post", "product", "invite"] as string[]).includes(input.targetType) || !targetRef || targetRef.length > 200 || (input.targetType === "invite" && targetRef !== "home")) {
      throw new DomainError("SHARE_TARGET_INVALID", "A supported share target and reference are required", 422);
    }
    const idem = {
      principalId: `member:${owner}`,
      operation: "share.create",
      idempotencyKey,
      businessKey: `share:${owner}:${input.targetType}:${targetRef}`,
      requestHash: requestHash({ targetType: input.targetType, targetRef })
    };
    return transaction(this.pool, async (client) => {
      const replay = await this.idempotencyLookup<{ shareId: string; targetType: ShareTargetType; targetRef: string; expiresAt: string }>(client, idem);
      if (replay) return replay;
      await client.query(`UPDATE share_link SET state='expired'
        WHERE member_id=$1 AND target_type=$2 AND target_ref=$3 AND state='active' AND expires_at<=$4`, [owner, input.targetType, targetRef, now]);
      const shareId = randomUUID().replaceAll("-", "");
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const link = await client.query<{ share_id: string; target_type: ShareTargetType; target_ref: string; expires_at: Date }>(`INSERT INTO share_link(share_id, member_id, target_type, target_ref, expires_at)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (member_id, target_type, target_ref) WHERE state='active'
        DO UPDATE SET member_id=EXCLUDED.member_id
        RETURNING share_id, target_type, target_ref, expires_at`, [shareId, owner, input.targetType, targetRef, expiresAt]);
      const row = link.rows[0]!;
      const response = { shareId: row.share_id, targetType: row.target_type, targetRef: row.target_ref, expiresAt: row.expires_at.toISOString() };
      await this.idempotencySave(client, { ...idem, response });
      return response;
    }, "SERIALIZABLE");
  }

  async getShareLinks(memberId: string | undefined, now: Date, targetType?: string) {
    const owner = requireMember(memberId);
    if (targetType !== undefined && !["post", "product", "invite"].includes(targetType)) throw new DomainError("SHARE_TARGET_INVALID", "Unsupported share target", 422);
    const result = await this.pool.query<{ share_id: string; target_type: ShareTargetType; target_ref: string; state: string; created_at: Date; expires_at: Date }>(
      "SELECT share_id, target_type, target_ref, state, created_at, expires_at FROM share_link WHERE member_id=$1 AND ($2::text IS NULL OR target_type=$2) ORDER BY created_at DESC, id DESC LIMIT 20", [owner, targetType ?? null]
    );
    return result.rows.map((row) => ({ shareId: row.share_id, targetType: row.target_type, targetRef: row.target_ref, state: row.state === "active" && row.expires_at.getTime() <= now.getTime() ? "expired" : row.state, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() }));
  }

  async resolveShare(shareId: string, now: Date) {
    if (!/^[0-9a-f]{32}$/.test(shareId)) throw new DomainError("SHARE_NOT_FOUND", "Share link is invalid or expired", 404);
    return transaction(this.pool, async (client) => {
      const link = await client.query<{ id: string; target_type: ShareTargetType; target_ref: string; expires_at: Date; state: string }>(
        "SELECT id, target_type, target_ref, expires_at, state FROM share_link WHERE share_id=$1 FOR UPDATE", [shareId]
      );
      const row = link.rows[0];
      if (!row || row.state !== "active" || row.expires_at.getTime() <= now.getTime()) {
        if (row?.state === "active") await client.query("UPDATE share_link SET state='expired' WHERE id=$1", [row.id]);
        throw new DomainError("SHARE_NOT_FOUND", "Share link is invalid or expired", 404);
      }
      return { shareId, targetType: row.target_type, targetRef: row.target_ref, expiresAt: row.expires_at.toISOString() };
    });
  }

  async recordShareVisit(shareId: string, visitKey: string, now: Date) {
    const normalizedVisitKey = visitKey?.trim();
    if (!normalizedVisitKey || normalizedVisitKey.length < 16 || normalizedVisitKey.length > 100) {
      throw new DomainError("SHARE_VISIT_KEY_INVALID", "Visit key must be 16 to 100 characters", 422);
    }
    return transaction(this.pool, async (client) => {
      const link = await client.query<{ id: string; state: string; expires_at: Date }>("SELECT id, state, expires_at FROM share_link WHERE share_id=$1 FOR UPDATE", [shareId]);
      const row = link.rows[0];
      if (!row || row.state !== "active" || row.expires_at.getTime() <= now.getTime()) {
        if (row?.state === "active") await client.query("UPDATE share_link SET state='expired' WHERE id=$1", [row.id]);
        throw new DomainError("SHARE_NOT_FOUND", "Share link is invalid or expired", 404);
      }
      const visit = await client.query<{ id: string }>(`INSERT INTO share_visit(id, share_link_id, visit_key, first_seen_at, last_seen_at)
        VALUES ($1,$2,$3,$4,$4)
        ON CONFLICT (share_link_id, visit_key) DO UPDATE SET last_seen_at=GREATEST(share_visit.last_seen_at, EXCLUDED.last_seen_at)
        RETURNING id`, [randomUUID(), row.id, normalizedVisitKey, now]);
      return { visitId: visit.rows[0]!.id, shareId, recorded: true };
    });
  }

  async attributeShareIdentity(memberId: string | undefined, shareId: string, visitKey: string, now: Date) {
    const owner = requireMember(memberId);
    return transaction(this.pool, async (client) => {
      const visit = await client.query<{ visit_id: string; sharer_member_id: string; visitor_member_id: string | null; first_seen_at: Date; state: string }>(`SELECT sv.id AS visit_id, sl.member_id AS sharer_member_id, sv.visitor_member_id, sv.first_seen_at, sl.state
        FROM share_visit sv JOIN share_link sl ON sl.id=sv.share_link_id
        WHERE sl.share_id=$1 AND sv.visit_key=$2 FOR UPDATE OF sv`, [shareId, visitKey]);
      const row = visit.rows[0];
      if (!row) throw new DomainError("SHARE_VISIT_NOT_FOUND", "Share visit must be recorded before attribution", 404);
      if (row.visitor_member_id && row.visitor_member_id !== owner) throw new DomainError("SHARE_VISIT_ALREADY_BOUND", "This visit belongs to another member", 409);
      if (row.state === "revoked" || now.getTime() < row.first_seen_at.getTime() || now.getTime() - row.first_seen_at.getTime() > 30 * 86400_000) return { shareId, credited: false, reason: "ATTRIBUTION_WINDOW_EXPIRED" };
      await client.query("UPDATE share_visit SET visitor_member_id=COALESCE(visitor_member_id,$1), last_seen_at=GREATEST(last_seen_at,$2) WHERE id=$3", [owner, now, row.visit_id]);
      if (row.sharer_member_id === owner) return { shareId, credited: false, reason: "SELF_ATTRIBUTION" };
      const attributionId = randomUUID();
      const created = await client.query<{ id: string }>(`INSERT INTO share_attribution(id, share_visit_id, sharer_member_id, converted_member_id, conversion_type, occurred_at)
        VALUES ($1,$2,$3,$4,'identity',$5)
        ON CONFLICT (converted_member_id, conversion_type) DO NOTHING
        RETURNING id`, [attributionId, row.visit_id, row.sharer_member_id, owner, now]);
      if (!created.rows[0]) {
        const existing = await client.query<{ share_visit_id: string }>("SELECT share_visit_id FROM share_attribution WHERE converted_member_id=$1 AND conversion_type='identity'", [owner]);
        return { shareId, credited: existing.rows[0]?.share_visit_id === row.visit_id, reason: existing.rows[0]?.share_visit_id === row.visit_id ? "ALREADY_RECORDED" : "FIRST_TOUCH_ALREADY_RECORDED" };
      }
      await enqueue(client, {
        eventType: "share.identity.attributed.v1", aggregateType: "share_attribution", aggregateId: attributionId, aggregateVersion: 1,
        businessKey: `share:${shareId}:identity:${owner}`, payload: { shareId, shareVisitId: row.visit_id, sharerMemberId: row.sharer_member_id, convertedMemberId: owner }, occurredAt: now
      });
      return { shareId, credited: true, attributionId };
    }, "SERIALIZABLE");
  }

  async getEligibleTasks(memberId: string | undefined, now = this.now()) {
    const owner = requireMember(memberId);
    const result = await this.pool.query(`SELECT t.id, t.state, t.expires_at, c.code, c.qualifying_milestone, c.reward_points,
      tc.submission_id, s.status AS submission_status
      FROM eligibility_task t JOIN eligibility_campaign c ON c.id=t.campaign_id
      LEFT JOIN task_claim tc ON tc.task_id=t.id LEFT JOIN submission s ON s.id=tc.submission_id
      WHERE t.member_id=$1 ORDER BY t.expires_at DESC, t.id DESC`, [owner]);
    const rewardEnabled = this.pointsPolicyEnabled(now);
    return result.rows.map((row) => {
      const expired = new Date(row.expires_at).getTime() <= now.getTime();
      const claimable = !row.submission_id && row.state === "available" && !expired;
      return {
        ...row,
        name: taskStoryName(row.qualifying_milestone),
        claimable,
        claim_block_reason: claimable ? null : row.submission_id ? null : expired ? "邀请已过有效期" : "邀请当前不可领取",
        reward_enabled: rewardEnabled,
        reward_points: rewardEnabled ? row.reward_points : null
      };
    });
  }

  async getTask(memberId: string | undefined, taskId: string, now = this.now()) {
    const owner = requireMember(memberId);
    const result = await this.pool.query(`SELECT t.id, t.state, t.expires_at, t.version, c.code, c.qualifying_milestone, c.reward_points,
      tc.id AS claim_id, tc.submission_id, s.status AS submission_status
      FROM eligibility_task t JOIN eligibility_campaign c ON c.id=t.campaign_id
      LEFT JOIN task_claim tc ON tc.task_id=t.id LEFT JOIN submission s ON s.id=tc.submission_id
      WHERE t.id=$1 AND t.member_id=$2`, [taskId, owner]);
    if (!result.rows[0]) throw new DomainError("TASK_NOT_FOUND", "Task not found", 404);
    const row = result.rows[0];
    const expired = new Date(row.expires_at).getTime() <= now.getTime();
    const claimable = !row.submission_id && row.state === "available" && !expired;
    const rewardEnabled = this.pointsPolicyEnabled(now);
    return {
      ...row,
      name: taskStoryName(row.qualifying_milestone),
      claimable,
      claim_block_reason: claimable ? null : row.submission_id ? null : expired ? "邀请已过有效期" : "邀请当前不可领取",
      reward_enabled: rewardEnabled,
      reward_points: rewardEnabled ? row.reward_points : null
    };
  }

  async getConsentGrants(memberId: string | undefined) {
    const owner = requireMember(memberId);
    const result = await this.pool.query(`SELECT cg.id, cg.submission_id, cg.purpose, cg.granted_at,
      rr.requested_at AS revoked_at, rr.reason AS revocation_reason
      FROM consent_grant cg LEFT JOIN revocation_request rr ON rr.consent_grant_id=cg.id
      WHERE cg.member_id=$1 ORDER BY cg.granted_at DESC`, [owner]);
    return result.rows;
  }

  catalog() {
    return {
      currency: "CNY",
      transactionProfile: this.config.selectedTransactionProfile,
      checkoutEnabled: false,
      items: [
        { id: "care-serum-30", name: "头皮护理精华 30ml", subtitle: "轻盈日常护理", price: 26900, image: "/assets/cisme/community-card-purple-bottle-v1.webp" },
        { id: "care-set-r0", name: "28 天护理组合", subtitle: "精华与护理手册", price: 48900, image: "/assets/cisme/community-card-care-flatlay-v2.webp" },
        { id: "travel-serum-10", name: "随行护理精华 10ml", subtitle: "便携装", price: 9900, image: "/assets/cisme/community-card-care-journal-v2.webp" }
      ]
    };
  }

  private async cycleView(client: DbClient, cycle: CycleRow, now: Date) {
    const records = await client.query<CareRecordRow>("SELECT id, cycle_id, milestone, completed_at, protocol_version, self_assessment FROM care_record WHERE cycle_id=$1 ORDER BY due_on", [cycle.id]);
    const recordIds = records.rows.map((row) => row.id);
    const steps = recordIds.length
      ? await client.query<CareRecordStepRow>("SELECT record_id, step_code FROM care_record_step WHERE record_id = ANY($1::uuid[]) ORDER BY record_id, sequence", [recordIds])
      : { rows: [] as CareRecordStepRow[] };
    return this.cycleViewFromRows(cycle, records.rows, this.groupCareRecordSteps(steps.rows), now);
  }

  private groupCareRecordSteps(rows: CareRecordStepRow[]): Map<string, string[]> {
    const byRecord = new Map<string, string[]>();
    for (const step of rows) byRecord.set(step.record_id, [...(byRecord.get(step.record_id) ?? []), step.step_code]);
    return byRecord;
  }

  private cycleViewFromRows(cycle: CycleRow, records: CareRecordRow[], stepsByRecord: Map<string, string[]>, now: Date) {
    const completed = records.map((row) => row.milestone);
    const startedOn = dateString(cycle.started_on);
    const due = cycle.phase === "active" ? deriveDueMilestone(startedOn, completed, now, cycle.timezone, cycle.schedule_offset_days) : null;
    const all: CareMilestone[] = ["D1", "D7", "D14", "D28"];
    return {
      id: cycle.id, phase: cycle.phase, startedOn, timezone: cycle.timezone,
      protocolVersion: cycle.protocol_version, completed, due,
      next: all.find((item) => !completed.includes(item)) ?? null, version: cycle.version,
      scheduleOffsetDays: cycle.schedule_offset_days,
      pausePolicy: { enabled: Boolean(this.config.carePausePolicy.version && this.config.carePausePolicy.maxDays > 0), maxDays: this.config.carePausePolicy.maxDays, version: this.config.carePausePolicy.version },
      records: records.map((row) => ({
        milestone: row.milestone,
        completedAt: row.completed_at.toISOString(),
        protocolVersion: row.protocol_version,
        selfAssessment: row.self_assessment,
        stepCodes: stepsByRecord.get(row.id) ?? []
      }))
    };
  }

  private async lockCycle(client: DbClient, cycleId: string, memberId: string): Promise<CycleRow> {
    const result = await client.query<CycleRow>("SELECT * FROM care_cycle WHERE id=$1 FOR UPDATE", [cycleId]);
    const cycle = result.rows[0];
    if (!cycle || cycle.member_id !== memberId) throw new DomainError("CARE_CYCLE_NOT_FOUND", "Care cycle not found", 404);
    return cycle;
  }

  private async decideEligibility(client: DbClient, cycle: CycleRow, recordId: string, now: Date) {
    const campaignResult = await client.query<{ id: string; capacity: number; ends_at: Date }>(`
      SELECT id, capacity, ends_at FROM eligibility_campaign
      WHERE active=true AND qualifying_milestone='D7' AND starts_at <= $1 AND ends_at > $1
      ORDER BY starts_at LIMIT 1 FOR UPDATE
    `, [now]);
    const campaign = campaignResult.rows[0];
    if (!campaign) return null;
    const factKey = `${cycle.id}:D7`;
    const existing = await client.query("SELECT id, eligible FROM eligibility_decision WHERE campaign_id=$1 AND fact_key=$2", [campaign.id, factKey]);
    if (existing.rows[0]) return this.taskForCycle(client, cycle.id);
    const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM eligibility_task WHERE campaign_id=$1 AND state <> 'expired'", [campaign.id]);
    const eligible = Number(count.rows[0]?.count ?? 0) < campaign.capacity;
    const decisionId = randomUUID();
    await client.query(`INSERT INTO eligibility_decision(id, campaign_id, cycle_id, fact_key, eligible, reason_code, decided_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [decisionId, campaign.id, cycle.id, factKey, eligible, eligible ? "D7_AND_CAPACITY" : "CAPACITY_EXHAUSTED", now]);
    let task = null;
    if (eligible) {
      const taskId = randomUUID();
      await client.query(`INSERT INTO eligibility_task(id, decision_id, campaign_id, member_id, expires_at)
        VALUES ($1,$2,$3,$4,$5)`, [taskId, decisionId, campaign.id, cycle.member_id, campaign.ends_at]);
      task = { id: taskId, state: "available", expiresAt: campaign.ends_at.toISOString() };
    }
    await enqueue(client, {
      eventType: "eligibility.decided.v1", aggregateType: "eligibility_decision", aggregateId: decisionId, aggregateVersion: 1,
      businessKey: `eligibility:${campaign.id}:${factKey}`, payload: { cycleId: cycle.id, recordId, eligible, taskId: task?.id ?? null }, occurredAt: now
    });
    return task;
  }

  private async taskForCycle(client: DbClient, cycleId: string) {
    const result = await client.query(`SELECT t.id, t.state, t.expires_at FROM eligibility_task t
      JOIN eligibility_decision d ON d.id=t.decision_id WHERE d.cycle_id=$1`, [cycleId]);
    const row = result.rows[0];
    return row ? { id: row.id as string, state: row.state as string, expiresAt: (row.expires_at as Date).toISOString() } : null;
  }

  async claimTask(memberId: string | undefined, taskId: string, idempotencyKey: string, now: Date): Promise<TaskClaimView> {
    const owner = requireMember(memberId);
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "submissions");
      const idem = { principalId: `member:${owner}`, operation: "task.claim", idempotencyKey, businessKey: `task:${taskId}:claim`, requestHash: requestHash({ taskId }) };
      const replay = await this.idempotencyLookup<TaskClaimView>(client, idem);
      if (replay) return replay;
      const task = await client.query<{ member_id: string; state: string; expires_at: Date; version: number }>("SELECT member_id, state, expires_at, version FROM eligibility_task WHERE id=$1 FOR UPDATE", [taskId]);
      const row = task.rows[0];
      if (!row || row.member_id !== owner) throw new DomainError("TASK_NOT_FOUND", "Task not found", 404);
      const existing = await client.query<{ id: string; submission_id: string; claimed_at: Date }>("SELECT id, submission_id, claimed_at FROM task_claim WHERE task_id=$1", [taskId]);
      if (existing.rows[0]) {
        const response = { id: existing.rows[0].id, taskId, submissionId: existing.rows[0].submission_id, claimedAt: existing.rows[0].claimed_at.toISOString() };
        await this.idempotencySave(client, { ...idem, response });
        return response;
      }
      if (row.state !== "available" || row.expires_at <= now) throw new DomainError("TASK_NOT_AVAILABLE", "Task is not available", 409);
      const submissionId = randomUUID();
      const claimId = randomUUID();
      await client.query("INSERT INTO submission(id, member_id) VALUES ($1,$2)", [submissionId, owner]);
      await client.query("INSERT INTO task_claim(id, task_id, member_id, submission_id, claimed_at) VALUES ($1,$2,$3,$4,$5)", [claimId, taskId, owner, submissionId, now]);
      await client.query("UPDATE eligibility_task SET state='claimed', version=version+1 WHERE id=$1", [taskId]);
      await enqueue(client, {
        eventType: "task.claimed.v1", aggregateType: "eligibility_task", aggregateId: taskId, aggregateVersion: row.version + 1,
        businessKey: `task:${taskId}:claimed`, payload: { memberId: owner, claimId, submissionId }, occurredAt: now
      });
      const response = { id: claimId, taskId, submissionId, claimedAt: now.toISOString() };
      await this.idempotencySave(client, { ...idem, response });
      return response;
    }, "SERIALIZABLE");
  }

  async authorizeMedia(memberId: string | undefined, submissionId: string, input: { kind: "original" | "screenshot"; mimeType: string; maxBytes: number; baseUrl: string }, now: Date): Promise<UploadAuthorization> {
    const owner = requireMember(memberId);
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "uploads");
      const submission = await client.query<{ member_id: string; status: string }>("SELECT member_id, status FROM submission WHERE id=$1 FOR UPDATE", [submissionId]);
      const row = submission.rows[0];
      if (!row || row.member_id !== owner) throw new DomainError("SUBMISSION_NOT_FOUND", "Submission not found", 404);
      if (!["draft", "needs_changes", "appealed"].includes(row.status)) throw new DomainError("SUBMISSION_LOCKED", "Submission no longer accepts uploads", 409);
      const current = await client.query<{ id: string; object_key: string; mime_type: string; upload_state: string }>(
        "SELECT id, object_key, mime_type, upload_state FROM media_object WHERE submission_id=$1 AND kind=$2 AND is_current=true FOR UPDATE",
        [submissionId, input.kind]
      );
      const active = current.rows[0];
      if (active?.upload_state === "authorized") {
        await client.query("UPDATE media_object SET authorized_max_bytes=$2 WHERE id=$1", [active.id, input.maxBytes]);
        return this.storage.authorize({ mediaId: active.id, objectKey: active.object_key, mimeType: active.mime_type, maxBytes: input.maxBytes, baseUrl: input.baseUrl, now });
      }
      const id = randomUUID();
      const key = objectKey(submissionId, input.kind);
      await client.query(`INSERT INTO media_object(id, submission_id, kind, object_key, mime_type, is_current, authorized_max_bytes)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, submissionId, input.kind, key, input.mimeType, !active, input.maxBytes]);
      return this.storage.authorize({ mediaId: id, objectKey: key, mimeType: input.mimeType, maxBytes: input.maxBytes, baseUrl: input.baseUrl, now });
    });
  }

  async gatewayUpload(mediaId: string, input: { token: string; bytes: Uint8Array; mimeType: string }, now: Date) {
    const write = this.storage.writeGatewayObject?.bind(this.storage);
    if (!this.storage.acceptsGatewayUpload || !write) throw new DomainError("UPLOAD_GATEWAY_DISABLED", "Direct S3 upload is configured", 404);
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "uploads");
      // Every media mutation locks the parent before touching media or storage.
      // Keep this lock through the write so completion cannot verify stale bytes.
      const parent = await client.query<{ submission_id: string }>("SELECT submission_id FROM media_object WHERE id=$1", [mediaId]);
      const submissionId = parent.rows[0]?.submission_id;
      if (!submissionId) throw new DomainError("MEDIA_NOT_FOUND", "Media authorization not found", 404);
      const submission = await client.query<{ status: string }>("SELECT status FROM submission WHERE id=$1 FOR UPDATE", [submissionId]);
      if (!["draft", "needs_changes", "appealed"].includes(submission.rows[0]?.status ?? "")) throw new DomainError("SUBMISSION_LOCKED", "Submission no longer accepts uploads", 409);
      const media = await client.query<{ object_key: string; mime_type: string }>("SELECT object_key, mime_type FROM media_object WHERE id=$1 AND upload_state='authorized' FOR UPDATE", [mediaId]);
      const row = media.rows[0];
      if (!row) throw new DomainError("MEDIA_NOT_FOUND", "Media authorization not found", 404);
      if (input.mimeType !== "application/octet-stream" && row.mime_type !== input.mimeType) throw new DomainError("UPLOAD_MIME_MISMATCH", "Upload MIME type does not match authorization", 422);
      return write({ token: input.token, mediaId, objectKey: row.object_key, bytes: input.bytes, mimeType: input.mimeType, now });
    });
  }

  async completeMedia(memberId: string | undefined, submissionId: string, mediaId: string, now: Date) {
    const owner = requireMember(memberId);
    const outcome = await transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "uploads");
      const submission = await client.query<{ member_id: string; status: string }>("SELECT member_id, status FROM submission WHERE id=$1 FOR UPDATE", [submissionId]);
      if (submission.rows[0]?.member_id !== owner) throw new DomainError("MEDIA_NOT_FOUND", "Media not found", 404);
      const media = await client.query<{ id: string; kind: string; object_key: string; mime_type: string; upload_state: string; is_current: boolean; authorized_max_bytes: number }>(
        "SELECT * FROM media_object WHERE id=$1 AND submission_id=$2 FOR UPDATE", [mediaId, submissionId]);
      const row = media.rows[0];
      if (!row) throw new DomainError("MEDIA_NOT_FOUND", "Media not found", 404);
      if (row.upload_state === "uploaded" && row.is_current) return { media: row };
      if (row.upload_state !== "authorized") throw new DomainError("MEDIA_NOT_FOUND", "Media authorization not found", 404);
      if (!["draft", "needs_changes", "appealed"].includes(submission.rows[0].status)) throw new DomainError("SUBMISSION_LOCKED", "Submission no longer accepts uploads", 409);
      const stored = await this.storage.verify(row.object_key);
      const failUpload = async (error: DomainError) => {
        // Commit the failed state while still holding the lock. Never delete a
        // verified object in a catch after releasing its transaction lock.
        await this.storage.delete(row.object_key);
        await client.query("UPDATE media_object SET upload_state='failed' WHERE id=$1", [mediaId]);
        return { error };
      };
      if (stored.bytes < 1 || stored.bytes > Number(row.authorized_max_bytes)) return failUpload(new DomainError("UPLOAD_SIZE_INVALID", "Uploaded image exceeds the authorized size", 422));
      if (stored.detectedMime !== row.mime_type) return failUpload(new DomainError("UPLOAD_CONTENT_MISMATCH", "Uploaded image content does not match the authorized MIME type", 422));
      const current = await client.query<{ id: string; object_key: string }>(
        "SELECT id, object_key FROM media_object WHERE submission_id=$1 AND kind=$2 AND is_current=true FOR UPDATE", [submissionId, row.kind]);
      const previous = current.rows.find((item) => item.id !== mediaId);
      await client.query("SAVEPOINT media_completion");
      try {
        if (previous) await client.query("UPDATE media_object SET is_current=false WHERE id=$1", [previous.id]);
        const result = await client.query(`UPDATE media_object
          SET upload_state='uploaded', content_hash=$1, size_bytes=$2, uploaded_at=$3, is_current=true
          WHERE id=$4 RETURNING *`, [stored.checksumBase64, stored.bytes, now, mediaId]);
        if (previous) await client.query(`INSERT INTO media_cleanup_queue(media_id, object_key, reason)
          VALUES ($1,$2,'replaced') ON CONFLICT DO NOTHING`, [previous.id, previous.object_key]);
        await client.query("DELETE FROM upload_chunk WHERE media_id=$1", [mediaId]);
        await client.query("RELEASE SAVEPOINT media_completion");
        return { media: result.rows[0] };
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
        await client.query("ROLLBACK TO SAVEPOINT media_completion");
        return failUpload(new DomainError("MEDIA_DUPLICATE_HASH", "This media has already been submitted", 409));
      }
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.media;
  }

  async deleteMedia(memberId: string | undefined, submissionId: string, mediaId: string, now: Date) {
    const owner = requireMember(memberId);
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "uploads");
      await this.assertSwitch(client, "submissions");
      await client.query("SELECT id FROM submission WHERE id=$1 FOR UPDATE", [submissionId]);
      const result = await client.query<{ object_key: string; member_id: string; status: string; upload_state: string }>(`
        SELECT m.object_key, m.upload_state, s.member_id, s.status
        FROM media_object m JOIN submission s ON s.id=m.submission_id
        WHERE m.id=$1 AND m.submission_id=$2 FOR UPDATE OF m, s`, [mediaId, submissionId]);
      const row = result.rows[0];
      if (!row || row.member_id !== owner || row.upload_state === "deleted") throw new DomainError("MEDIA_NOT_FOUND", "Media not found", 404);
      if (!["draft", "needs_changes", "appealed"].includes(row.status)) {
        throw new DomainError("SUBMISSION_LOCKED", "Submission no longer accepts media changes", 409);
      }
      await client.query("UPDATE media_object SET upload_state='deleted', deleted_at=$1, is_current=false WHERE id=$2", [now, mediaId]);
      await client.query(`INSERT INTO media_cleanup_queue(media_id, object_key, reason)
        VALUES ($1,$2,'member_deleted') ON CONFLICT DO NOTHING`, [mediaId, row.object_key]);
      await client.query("DELETE FROM upload_chunk WHERE media_id=$1", [mediaId]);
      return { deleted: true, cleanupQueued: true };
    });
  }

  async saveSubmissionDraft(memberId: string | undefined, submissionId: string, input: { postUrl: string; platformAccount: string; disclosure: string; license: JsonObject; expectedVersion: number }, now: Date) {
    const owner = requireMember(memberId);
    const postUrl = input.postUrl.trim();
    const platformAccount = input.platformAccount.trim();
    const disclosure = input.disclosure.trim();
    if (postUrl && !postUrl.startsWith("https://")) throw new DomainError("POST_URL_INVALID", "A HTTPS post URL is required", 422);
    if (postUrl.length > 500 || platformAccount.length > 120 || disclosure.length > 300) throw new DomainError("SUBMISSION_FIELDS_TOO_LONG", "Draft fields exceed the accepted limits", 422);
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "submissions");
      const result = await client.query<{ member_id: string; status: string; version: number }>(
        "SELECT member_id, status, version FROM submission WHERE id=$1 FOR UPDATE", [submissionId]
      );
      const row = result.rows[0];
      if (!row || row.member_id !== owner) throw new DomainError("SUBMISSION_NOT_FOUND", "Submission not found", 404);
      if (!["draft", "needs_changes", "appealed"].includes(row.status)) throw new DomainError("SUBMISSION_LOCKED", "Submission no longer accepts draft changes", 409);
      if (row.version !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "Submission version changed", 409);
      const nextVersion = row.version + 1;
      const updated = await client.query(`UPDATE submission
        SET post_url=$1, platform_account=$2, disclosure=$3, license_payload=$4, version=$5, updated_at=$6
        WHERE id=$7 RETURNING id, status, version, post_url, platform_account, disclosure, license_payload`,
      [postUrl || null, platformAccount || null, disclosure || null, input.license, nextVersion, now, submissionId]);
      return updated.rows[0];
    });
  }

  async submit(memberId: string | undefined, submissionId: string, idempotencyKey: string, input: { postUrl: string; platformAccount: string; disclosure: string; license: JsonObject; expectedVersion: number }, now: Date) {
    const owner = requireMember(memberId);
    if (!input.postUrl.startsWith("https://")) throw new DomainError("POST_URL_INVALID", "A HTTPS post URL is required", 422);
    if (!input.platformAccount.trim() || !input.disclosure.trim()) throw new DomainError("SUBMISSION_FIELDS_REQUIRED", "Account and benefit disclosure are required", 422);
    const requiredPurposes = ["content_storage", "human_review"];
    if (requiredPurposes.some((purpose) => input.license[purpose] !== true)) throw new DomainError("LICENSE_REQUIRED", "All R0 usage permissions must be explicit", 422);
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "submissions");
      const idem = { principalId: `member:${owner}`, operation: "submission.submit", idempotencyKey, businessKey: `submission:${submissionId}:v${input.expectedVersion}:submit`, requestHash: requestHash({ submissionId, ...input }) };
      const replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      const submission = await client.query<{ member_id: string; status: string; version: number }>("SELECT member_id, status, version FROM submission WHERE id=$1 FOR UPDATE", [submissionId]);
      const row = submission.rows[0];
      if (!row || row.member_id !== owner) throw new DomainError("SUBMISSION_NOT_FOUND", "Submission not found", 404);
      if (row.version !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "Submission version changed", 409);
      if (!["draft", "needs_changes", "appealed"].includes(row.status)) throw new DomainError("SUBMISSION_STATE_INVALID", "Submission cannot be sent in its current state", 409);
      const media = await client.query<{ kind: string }>("SELECT kind FROM media_object WHERE submission_id=$1 AND upload_state='uploaded' AND is_current=true", [submissionId]);
      const kinds = new Set(media.rows.map((item) => item.kind));
      if (!kinds.has("original") || !kinds.has("screenshot")) throw new DomainError("MEDIA_REQUIRED", "Original and screenshot media are required", 422);
      const nextVersion = row.version + 1;
      await client.query(`UPDATE submission SET status='submitted', post_url=$1, platform_account=$2, disclosure=$3, license_payload=$4,
        version=$5, submitted_at=$6, updated_at=$6 WHERE id=$7`, [input.postUrl, input.platformAccount, input.disclosure, input.license, nextVersion, now, submissionId]);
      const caseResult = await client.query<{ id: string }>(`INSERT INTO review_case(id, submission_id) VALUES ($1,$2)
        ON CONFLICT (submission_id) DO UPDATE SET status='pending', version=review_case.version+1, updated_at=$3 RETURNING id`, [randomUUID(), submissionId, now]);
      const reviewCaseId = caseResult.rows[0]!.id;
      await client.query("INSERT INTO review_action(review_case_id, actor_principal_id, action, reason_code) VALUES ($1,$2,'submit','MEMBER_SUBMITTED')", [reviewCaseId, `member:${owner}`]);
      for (const purpose of requiredPurposes) {
        await client.query(`INSERT INTO consent_grant(submission_id, member_id, purpose, granted_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [submissionId, owner, purpose, now]);
      }
      if (input.license.feed_readonly === true) {
        await client.query(`INSERT INTO consent_grant(submission_id, member_id, purpose, granted_at)
          VALUES ($1,$2,'feed_readonly',$3) ON CONFLICT DO NOTHING`, [submissionId, owner, now]);
      } else {
        const optionalGrant = await client.query<{ id: string }>("SELECT id FROM consent_grant WHERE submission_id=$1 AND purpose='feed_readonly' AND active=true", [submissionId]);
        if (optionalGrant.rows[0]) {
          await client.query(`INSERT INTO revocation_request(consent_grant_id, requested_by, reason, requested_at)
            VALUES ($1,$2,'MEMBER_OPT_OUT',$3) ON CONFLICT DO NOTHING`, [optionalGrant.rows[0].id, owner, now]);
          await client.query("UPDATE consent_grant SET active=false WHERE id=$1", [optionalGrant.rows[0].id]);
          await client.query("UPDATE feed_item SET visible=false WHERE submission_id=$1", [submissionId]);
        }
      }
      const pendingReward = await client.query<{ id: string }>(`INSERT INTO reward_claim(submission_id, member_id, campaign_id, rule_code, amount, state)
        SELECT $1,$2,t.campaign_id,'CARE_D7_STORY_R0',c.reward_points,'pending'
        FROM task_claim tc JOIN eligibility_task t ON t.id=tc.task_id JOIN eligibility_campaign c ON c.id=t.campaign_id
        WHERE tc.submission_id=$1
        ON CONFLICT (submission_id) DO UPDATE SET state='pending'
        RETURNING id`, [submissionId, owner]);
      await enqueue(client, {
        eventType: "submission.submitted.v1", aggregateType: "submission", aggregateId: submissionId, aggregateVersion: nextVersion,
        businessKey: `submission:${submissionId}:v${nextVersion}:submitted`, payload: { memberId: owner, reviewCaseId }, occurredAt: now
      });
      const response = { id: submissionId, status: "submitted", version: nextVersion, reviewCaseId, ...(pendingReward.rows[0] ? { rewardClaimId: pendingReward.rows[0].id } : {}) };
      await this.idempotencySave(client, { ...idem, response });
      return response;
    });
  }

  async review(principalId: string, submissionId: string, idempotencyKey: string, input: { decision: ReviewDecision; reasonCode: string; evidence?: JsonObject; expectedVersion: number }, now: Date, authorization: "legacy_role" | "capability" = "legacy_role"): Promise<ReviewResult> {
    if (!["approve", "reject", "request_changes"].includes(input.decision)) throw new DomainError("REVIEW_DECISION_INVALID", "Invalid review decision", 422);
    if (!input.reasonCode?.trim() || !input.evidence || Object.keys(input.evidence).length === 0) throw new DomainError("REVIEW_EVIDENCE_REQUIRED", "Review reason code and evidence are required", 422);
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "reviews");
      if (authorization === "legacy_role") await this.assertAdminRole(client, principalId, ["reviewer", "review_lead"]);
      const idem = { principalId, operation: "submission.review", idempotencyKey, businessKey: `submission:${submissionId}:v${input.expectedVersion}:review`, requestHash: requestHash({ submissionId, ...input }) };
      let replay = await this.idempotencyLookup<ReviewResult>(client, idem);
      if (replay) return replay;
      const submission = await client.query<{ status: string; version: number; member_id: string }>("SELECT status, version, member_id FROM submission WHERE id=$1 FOR UPDATE", [submissionId]);
      const row = submission.rows[0];
      if (!row) throw new DomainError("SUBMISSION_NOT_FOUND", "Submission not found", 404);
      const caseResult = await client.query<{ id: string; status: string; version: number }>("SELECT id, status, version FROM review_case WHERE submission_id=$1 FOR UPDATE", [submissionId]);
      const reviewCase = caseResult.rows[0];
      if (!reviewCase) throw new DomainError("REVIEW_NOT_FOUND", "Review case not found", 404);
      replay = await this.idempotencyLookup<ReviewResult>(client, idem);
      if (replay) return replay;
      if (row.status === "approved") {
        const existing = await client.query<{ reward_claim_id: string; grant_id: string }>(`SELECT rc.id AS reward_claim_id, pg.id AS grant_id
          FROM reward_claim rc LEFT JOIN points_grant pg ON pg.reward_claim_id=rc.id WHERE rc.submission_id=$1`, [submissionId]);
        const response: ReviewResult = {
          submissionId,
          status: "approved",
          version: row.version,
          ...(existing.rows[0]?.reward_claim_id ? { rewardClaimId: existing.rows[0].reward_claim_id } : {}),
          ...(existing.rows[0]?.grant_id ? { pointsGrantId: existing.rows[0].grant_id } : {})
        };
        await this.idempotencySave(client, { ...idem, response });
        return response;
      }
      if (row.version !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "Submission version changed", 409);
      if (!["submitted", "appealed"].includes(row.status)) throw new DomainError("REVIEW_STATE_INVALID", "Submission is not reviewable", 409);
      const status = input.decision === "request_changes" ? "needs_changes" : input.decision === "reject" ? "rejected" : "approved";
      const nextVersion = row.version + 1;
      await client.query("UPDATE submission SET status=$1, version=$2, updated_at=$3 WHERE id=$4", [status, nextVersion, now, submissionId]);
      await client.query("UPDATE review_case SET status=$1, version=version+1, assigned_to=$2, updated_at=$3 WHERE id=$4", [status, principalId, now, reviewCase.id]);
      await client.query(`INSERT INTO review_action(review_case_id, actor_principal_id, action, reason_code, evidence)
        VALUES ($1,$2,$3,$4,$5)`, [reviewCase.id, principalId, input.decision, input.reasonCode, input.evidence ?? {}]);
      let rewardClaimId: string | undefined;
      let pointsGrantId: string | undefined;
      if (input.decision === "approve" && this.config.pointsRulesEnabled) {
        await this.assertSwitch(client, "rewards");
        this.assertPointsPolicyActive(now);
        if (!this.config.pointsRuleIds.includes("CARE_D7_STORY_R0")) {
          throw new DomainError("REWARD_RULE_NOT_APPROVED", "The reward rule is not in an active finance approval", 503);
        }
        const claim = await client.query<{ id: string; amount: number }>("SELECT id, amount FROM reward_claim WHERE submission_id=$1 FOR UPDATE", [submissionId]);
        if (!claim.rows[0]) throw new DomainError("REWARD_CONTEXT_MISSING", "Reward claim was not prepared at submission", 500);
        rewardClaimId = claim.rows[0].id;
        pointsGrantId = randomUUID();
        const lotId = randomUUID();
        const amount = claim.rows[0].amount;
        await client.query("UPDATE reward_claim SET state='approved' WHERE id=$1", [rewardClaimId]);
        const availableAfter = addDays(now, this.config.pointsHoldDays);
        const expiresAt = addDays(now, this.config.pointsExpiryDays);
        await client.query("INSERT INTO points_grant(id, reward_claim_id, member_id, amount, available_after, expires_at) VALUES ($1,$2,$3,$4,$5,$6)", [pointsGrantId, rewardClaimId, row.member_id, amount, availableAfter, expiresAt]);
        await client.query("INSERT INTO points_lot(id, grant_id, original_amount, frozen_amount, expires_at) VALUES ($1,$2,$3,$3,$4)", [lotId, pointsGrantId, amount, expiresAt]);
        await client.query(`INSERT INTO points_entry(member_id, grant_id, lot_id, entry_type, frozen_delta, business_key, occurred_at)
          VALUES ($1,$2,$3,'grant_frozen',$4,$5,$6)`, [row.member_id, pointsGrantId, lotId, amount, `grant:${pointsGrantId}:frozen`, now]);
        await client.query(`INSERT INTO points_projection(member_id, frozen) VALUES ($1,$2)
          ON CONFLICT (member_id) DO UPDATE SET frozen=points_projection.frozen+EXCLUDED.frozen, version=points_projection.version+1, updated_at=$3`, [row.member_id, amount, now]);
        await enqueue(client, {
          eventType: "reward.grant.created.v1", aggregateType: "points_grant", aggregateId: pointsGrantId, aggregateVersion: 1,
          businessKey: `reward:${submissionId}:grant`, payload: { submissionId, memberId: row.member_id, rewardClaimId, pointsGrantId, amount }, occurredAt: now
        });
      }
      await enqueue(client, {
        eventType: "submission.reviewed.v1", aggregateType: "submission", aggregateId: submissionId, aggregateVersion: nextVersion,
        businessKey: `submission:${submissionId}:v${nextVersion}:${status}`, payload: { submissionId, memberId: row.member_id, status }, occurredAt: now
      });
      await this.audit(client, principalId, `submission.${input.decision}`, "submission", submissionId, input.reasonCode, { status: row.status, version: row.version }, { status, version: nextVersion });
      const response: ReviewResult = {
        submissionId,
        status,
        version: nextVersion,
        ...(rewardClaimId ? { rewardClaimId } : {}),
        ...(pointsGrantId ? { pointsGrantId } : {})
      };
      await this.idempotencySave(client, { ...idem, response });
      return response;
    }, "SERIALIZABLE");
  }

  async appeal(memberId: string | undefined, submissionId: string, idempotencyKey: string, reason: string, expectedVersion: number, now: Date) {
    const owner = requireMember(memberId);
    if (!reason.trim()) throw new DomainError("APPEAL_REASON_REQUIRED", "Appeal reason is required", 422);
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "reviews");
      const idem = { principalId: `member:${owner}`, operation: "submission.appeal", idempotencyKey, businessKey: `submission:${submissionId}:v${expectedVersion}:appeal`, requestHash: requestHash({ submissionId, reason, expectedVersion }) };
      const replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      const submission = await client.query<{ member_id: string; status: string; version: number }>("SELECT member_id, status, version FROM submission WHERE id=$1 FOR UPDATE", [submissionId]);
      const row = submission.rows[0];
      if (!row || row.member_id !== owner) throw new DomainError("SUBMISSION_NOT_FOUND", "Submission not found", 404);
      if (row.status !== "rejected" || row.version !== expectedVersion) throw new DomainError("APPEAL_STATE_INVALID", "Only the current rejected version can be appealed", 409);
      const reviewCase = await client.query<{ id: string }>("SELECT id FROM review_case WHERE submission_id=$1", [submissionId]);
      await client.query("INSERT INTO appeal(review_case_id, member_id, reason) VALUES ($1,$2,$3)", [reviewCase.rows[0]!.id, owner, reason]);
      await client.query("UPDATE submission SET status='appealed', version=version+1, updated_at=$2 WHERE id=$1", [submissionId, now]);
      await client.query("UPDATE review_case SET status='appealed', version=version+1, updated_at=$2 WHERE id=$1", [reviewCase.rows[0]!.id, now]);
      await client.query("INSERT INTO review_action(review_case_id, actor_principal_id, action, reason_code, evidence) VALUES ($1,$2,'appeal','MEMBER_APPEAL',$3)", [reviewCase.rows[0]!.id, `member:${owner}`, { reason }]);
      const response = { submissionId, status: "appealed", version: expectedVersion + 1 };
      await this.idempotencySave(client, { ...idem, response });
      return response;
    });
  }

  async revokeConsent(memberId: string | undefined, consentGrantId: string, idempotencyKey: string, reason: string, now: Date) {
    const owner = requireMember(memberId);
    if (!reason.trim()) throw new DomainError("REVOCATION_REASON_REQUIRED", "Revocation reason is required", 422);
    return transaction(this.pool, async (client) => {
      const idem = { principalId: `member:${owner}`, operation: "consent.revoke", idempotencyKey, businessKey: `consent:${consentGrantId}:revoke`, requestHash: requestHash({ consentGrantId, reason }) };
      const replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      const grant = await client.query<{ member_id: string; submission_id: string; purpose: string; active: boolean }>("SELECT member_id, submission_id, purpose, active FROM consent_grant WHERE id=$1 FOR UPDATE", [consentGrantId]);
      const row = grant.rows[0];
      if (!row || row.member_id !== owner) throw new DomainError("CONSENT_GRANT_NOT_FOUND", "Consent grant not found", 404);
      const revocation = await client.query<{ id: string }>(`INSERT INTO revocation_request(id, consent_grant_id, requested_by, reason, requested_at)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (consent_grant_id) DO UPDATE SET consent_grant_id=EXCLUDED.consent_grant_id
        RETURNING id`, [randomUUID(), consentGrantId, owner, reason, now]);
      const id = revocation.rows[0]!.id;
      await client.query("UPDATE consent_grant SET active=false WHERE id=$1", [consentGrantId]);
      if (row.purpose === "feed_readonly") await client.query("UPDATE feed_item SET visible=false WHERE submission_id=$1", [row.submission_id]);
      await enqueue(client, {
        eventType: "consent.revocation.requested.v1", aggregateType: "consent_grant", aggregateId: consentGrantId, aggregateVersion: 1,
        businessKey: `consent:${consentGrantId}:revoked`, payload: { submissionId: row.submission_id, memberId: owner, purpose: row.purpose }, occurredAt: now
      });
      await this.audit(client, `member:${owner}`, "consent.revoke", "consent_grant", consentGrantId, "MEMBER_REQUEST", null, { requestId: id });
      const response = { requestId: id, blocksNewUse: true, historyPreserved: true };
      await this.idempotencySave(client, { ...idem, response });
      return response;
    });
  }

  async listPointsActions(principalId: string) {
    const client = await this.pool.connect();
    try {
      await this.assertAdminRole(client, principalId, ["finance_operator", "finance_approver", "auditor"]);
      const result = await client.query(`SELECT par.id, par.grant_id, par.action, par.amount, par.expected_grant_version,
        par.reason_code, par.evidence, par.state, par.requested_by, par.requested_at, par.decided_by, par.decided_at,
        pg.member_id, pg.state AS grant_state, pg.version AS grant_version, pg.available_after, pg.expires_at,
        pl.frozen_amount, pl.available_amount, pl.expired_amount, pl.reversed_amount
        FROM points_action_request par
        JOIN points_grant pg ON pg.id=par.grant_id JOIN points_lot pl ON pl.grant_id=pg.id
        ORDER BY (par.state='pending') DESC, par.requested_at ASC LIMIT 100`);
      return result.rows;
    } finally { client.release(); }
  }

  async listPointsGrants(principalId: string) {
    const client = await this.pool.connect();
    try {
      await this.assertAdminRole(client, principalId, ["finance_operator", "finance_approver", "auditor"]);
      const result = await client.query(`SELECT pg.id, pg.member_id, pg.amount, pg.state, pg.blocked_for_use, pg.version,
        pg.available_after, pg.expires_at, pg.created_at, rc.rule_code, rc.state AS reward_state,
        pl.frozen_amount, pl.available_amount, pl.expired_amount, pl.reversed_amount,
        par.id AS pending_action_id, par.action AS pending_action, par.requested_by
        FROM points_grant pg JOIN reward_claim rc ON rc.id=pg.reward_claim_id JOIN points_lot pl ON pl.grant_id=pg.id
        LEFT JOIN points_action_request par ON par.grant_id=pg.id AND par.state='pending'
        ORDER BY (par.id IS NOT NULL) DESC, pg.created_at ASC LIMIT 100`);
      return result.rows;
    } finally { client.release(); }
  }

  async requestPointsAction(principalId: string, grantId: string, idempotencyKey: string, input: { action: "unfreeze" | "expire" | "reverse_remaining"; expectedGrantVersion: number; reasonCode: string; evidence: JsonObject }, now: Date) {
    if (!input.reasonCode?.trim() || !input.evidence || Object.keys(input.evidence).length === 0) throw new DomainError("POINTS_ACTION_EVIDENCE_REQUIRED", "A reason code and evidence are required", 422);
    if (!["unfreeze", "expire", "reverse_remaining"].includes(input.action)) throw new DomainError("POINTS_ACTION_INVALID", "Unsupported points action", 422);
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "rewards");
      await this.assertAdminRole(client, principalId, ["finance_operator"]);
      this.assertPointsPolicyActive(now);
      const idem = { principalId, operation: "points.action.request", idempotencyKey, businessKey: `points-grant:${grantId}:v${input.expectedGrantVersion}:action`, requestHash: requestHash({ grantId, ...input }) };
      const replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      const result = await client.query<{ member_id: string; state: string; version: number; available_after: Date | null; expires_at: Date | null; frozen_amount: number; available_amount: number }>(`SELECT pg.member_id, pg.state, pg.version, pg.available_after, pg.expires_at, pl.frozen_amount, pl.available_amount
        FROM points_grant pg JOIN points_lot pl ON pl.grant_id=pg.id WHERE pg.id=$1 FOR UPDATE OF pg, pl`, [grantId]);
      const row = result.rows[0];
      if (!row) throw new DomainError("POINTS_GRANT_NOT_FOUND", "Points grant not found", 404);
      if (row.version !== input.expectedGrantVersion) throw new DomainError("VERSION_CONFLICT", "Points-grant version changed", 409);
      let amount = 0;
      if (input.action === "unfreeze") {
        if (row.frozen_amount < 1 || row.state !== "frozen") throw new DomainError("POINTS_UNFREEZE_STATE_INVALID", "Only a frozen grant with a remaining frozen balance can be unfrozen", 409);
        if (!row.available_after || now < row.available_after) throw new DomainError("POINTS_HOLD_ACTIVE", "The finance-approved hold period has not ended", 409);
        amount = row.frozen_amount;
      } else if (input.action === "expire") {
        if (row.available_amount < 1 || row.state !== "available") throw new DomainError("POINTS_EXPIRY_STATE_INVALID", "Only an available grant can expire", 409);
        if (!row.expires_at || now < row.expires_at) throw new DomainError("POINTS_NOT_EXPIRED", "The finance-approved expiry date has not arrived", 409);
        amount = row.available_amount;
      } else {
        amount = row.frozen_amount + row.available_amount;
        if (amount < 1 || row.state === "blocked" || row.state === "expired") throw new DomainError("POINTS_REVERSAL_STATE_INVALID", "The grant has no reversible balance", 409);
      }
      const requestId = randomUUID();
      await client.query(`INSERT INTO points_action_request(id, grant_id, action, amount, expected_grant_version, reason_code, evidence, requested_by, requested_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [requestId, grantId, input.action, amount, input.expectedGrantVersion, input.reasonCode.trim(), input.evidence, principalId, now]);
      await this.audit(client, principalId, "points_action.request", "points_grant", grantId, input.reasonCode.trim(),
        { state: row.state, version: row.version, frozen: row.frozen_amount, available: row.available_amount }, { requestId, action: input.action, amount, state: "pending" });
      const response = { requestId, grantId, action: input.action, amount, state: "pending", expectedGrantVersion: input.expectedGrantVersion };
      await this.idempotencySave(client, { ...idem, response });
      return response;
    }, "SERIALIZABLE");
  }

  async decidePointsAction(principalId: string, requestId: string, decision: "approve" | "reject", idempotencyKey: string, input: { reasonCode: string; evidence: JsonObject }, now: Date) {
    if (!input.reasonCode?.trim() || !input.evidence || Object.keys(input.evidence).length === 0) throw new DomainError("POINTS_DECISION_EVIDENCE_REQUIRED", "A decision reason and evidence are required", 422);
    return transaction(this.pool, async (client) => {
      await this.assertAdminRole(client, principalId, ["finance_approver"]);
      if (decision === "approve") {
        await this.assertSwitch(client, "rewards");
        this.assertPointsPolicyActive(now);
      }
      const idem = { principalId, operation: `points.action.${decision}`, idempotencyKey, businessKey: `points-action:${requestId}:decision`, requestHash: requestHash({ requestId, decision, ...input }) };
      let replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      const result = await client.query<{ grant_id: string; action: "unfreeze" | "expire" | "reverse_remaining"; amount: number; expected_grant_version: number; state: string; requested_by: string; member_id: string; grant_state: string; grant_version: number; frozen_amount: number; available_amount: number }>(`SELECT par.grant_id, par.action, par.amount, par.expected_grant_version, par.state, par.requested_by,
        pg.member_id, pg.state AS grant_state, pg.version AS grant_version, pl.frozen_amount, pl.available_amount
        FROM points_action_request par JOIN points_grant pg ON pg.id=par.grant_id JOIN points_lot pl ON pl.grant_id=pg.id
        WHERE par.id=$1 FOR UPDATE OF par, pg, pl`, [requestId]);
      const row = result.rows[0];
      if (!row) throw new DomainError("POINTS_ACTION_NOT_FOUND", "Points action request not found", 404);
      replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      if (row.state !== "pending") throw new DomainError("POINTS_ACTION_ALREADY_DECIDED", "Points action request was already decided", 409);
      if (row.requested_by === principalId) throw new DomainError("FOUR_EYES_REQUIRED", "The points-action maker and checker must be different principals", 409);
      if (decision === "reject") {
        await client.query("UPDATE points_action_request SET state='rejected', decided_by=$1, decided_at=$2, decision_reason_code=$3 WHERE id=$4", [principalId, now, input.reasonCode.trim(), requestId]);
        await client.query("UPDATE points_grant SET version=version+1 WHERE id=$1", [row.grant_id]);
        await this.audit(client, principalId, "points_action.reject", "points_grant", row.grant_id, input.reasonCode.trim(), { requestId, state: "pending", version: row.grant_version }, { requestId, state: "rejected", version: row.grant_version + 1 });
        const response = { requestId, grantId: row.grant_id, state: "rejected", grantVersion: row.grant_version + 1 };
        await this.idempotencySave(client, { ...idem, response });
        return response;
      }
      if (row.grant_version !== row.expected_grant_version) throw new DomainError("VERSION_CONFLICT", "Points grant changed after the action was requested", 409);
      const lotResult = await client.query<{ id: string }>("SELECT id FROM points_lot WHERE grant_id=$1", [row.grant_id]);
      const lotId = lotResult.rows[0]!.id;
      let frozenDelta = 0;
      let availableDelta = 0;
      let nextState = row.grant_state;
      let eventType: "points.grant.unfrozen.v1" | "points.grant.expired.v1" | "points.grant.reversed.v1";
      let entryType: "unfreeze" | "expire" | "reversal";
      if (row.action === "unfreeze") {
        if (row.frozen_amount !== row.amount || row.available_amount !== 0) throw new DomainError("POINTS_ACTION_STALE", "The frozen balance no longer matches the approved request", 409);
        await client.query("UPDATE points_lot SET frozen_amount=0, available_amount=available_amount+$1 WHERE grant_id=$2", [row.amount, row.grant_id]);
        frozenDelta = -row.amount; availableDelta = row.amount; nextState = "available"; eventType = "points.grant.unfrozen.v1"; entryType = "unfreeze";
      } else if (row.action === "expire") {
        if (row.available_amount !== row.amount || row.frozen_amount !== 0) throw new DomainError("POINTS_ACTION_STALE", "The available balance no longer matches the approved request", 409);
        await client.query("UPDATE points_lot SET available_amount=0, expired_amount=expired_amount+$1 WHERE grant_id=$2", [row.amount, row.grant_id]);
        availableDelta = -row.amount; nextState = "expired"; eventType = "points.grant.expired.v1"; entryType = "expire";
      } else {
        if (row.frozen_amount + row.available_amount !== row.amount) throw new DomainError("POINTS_ACTION_STALE", "The reversible balance no longer matches the approved request", 409);
        await client.query("UPDATE points_lot SET frozen_amount=0, available_amount=0, reversed_amount=reversed_amount+$1 WHERE grant_id=$2", [row.amount, row.grant_id]);
        frozenDelta = -row.frozen_amount; availableDelta = -row.available_amount; nextState = "blocked"; eventType = "points.grant.reversed.v1"; entryType = "reversal";
        await client.query("UPDATE reward_claim SET state='voided' WHERE id=(SELECT reward_claim_id FROM points_grant WHERE id=$1)", [row.grant_id]);
      }
      await client.query("UPDATE points_grant SET state=$1, blocked_for_use=$2, version=version+1 WHERE id=$3", [nextState, row.action === "reverse_remaining", row.grant_id]);
      await client.query(`INSERT INTO points_entry(member_id, grant_id, lot_id, entry_type, frozen_delta, available_delta, business_key, occurred_at, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [row.member_id, row.grant_id, lotId, entryType, frozenDelta, availableDelta, `points-action:${requestId}:approved`, now, { requestId, approvedBy: principalId, reasonCode: input.reasonCode.trim() }]);
      await client.query(`UPDATE points_projection SET frozen=frozen+$1, available=available+$2, version=version+1, updated_at=$3 WHERE member_id=$4`, [frozenDelta, availableDelta, now, row.member_id]);
      await client.query("UPDATE points_action_request SET state='approved', decided_by=$1, decided_at=$2, decision_reason_code=$3 WHERE id=$4", [principalId, now, input.reasonCode.trim(), requestId]);
      await enqueue(client, { eventType, aggregateType: "points_grant", aggregateId: row.grant_id, aggregateVersion: row.grant_version + 1,
        businessKey: `points-action:${requestId}:event`, payload: { requestId, memberId: row.member_id, amount: row.amount, approvedBy: principalId }, occurredAt: now });
      await this.audit(client, principalId, `points_action.${row.action}.approve`, "points_grant", row.grant_id, input.reasonCode.trim(),
        { state: row.grant_state, version: row.grant_version, frozen: row.frozen_amount, available: row.available_amount },
        { requestId, state: nextState, version: row.grant_version + 1, frozenDelta, availableDelta });
      const response = { requestId, grantId: row.grant_id, state: "approved", grantState: nextState, grantVersion: row.grant_version + 1, frozenDelta, availableDelta };
      await this.idempotencySave(client, { ...idem, response });
      return response;
    }, "SERIALIZABLE");
  }

  private async pointsSnapshot(client: DbClient, owner: string, now: Date, options: { limit?: number; cursor?: string } = {}) {
    const limit = pageLimit(options.limit, 50);
    const cursor = decodeCursor(options.cursor);
    const projection = await client.query("SELECT frozen, available, debt, version FROM points_projection WHERE member_id=$1", [owner]);
    const entries = await client.query(`SELECT id, entry_type, frozen_delta, available_delta, debt_delta, business_key, occurred_at FROM points_entry
      WHERE member_id=$1 AND ($2::timestamptz IS NULL OR (occurred_at,id)<($2,$3::uuid)) ORDER BY occurred_at DESC,id DESC LIMIT $4`, [owner, cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
    const page = entries.rows.slice(0, limit);
    const last = entries.rows.length > limit ? page[page.length - 1] : null;
    return { rulesEnabled: this.pointsPolicyEnabled(now), projection: projection.rows[0] ?? { frozen: 0, available: 0, debt: 0, version: 1 }, entries: page,
      nextCursor: last ? pageCursor({ at: last.occurred_at, id: last.id }) : null };
  }

  async getPoints(memberId: string | undefined, now = this.now(), options: { limit?: number; cursor?: string } = {}) {
    const owner = requireMember(memberId);
    return readSnapshot(this.pool, (client) => this.pointsSnapshot(client, owner, now, options));
  }

  pointsPolicyEnabled(now = this.now()): boolean {
    const expiry = this.config.pointsFinanceApprovalExpiresAt ? new Date(this.config.pointsFinanceApprovalExpiresAt) : null;
    return Boolean(this.config.pointsRulesEnabled && this.config.pointsFinanceApprovalId && expiry && expiry > now && this.config.pointsHoldDays >= 1 && this.config.pointsExpiryDays >= 30);
  }

  private assertPointsPolicyActive(now: Date) {
    if (!this.pointsPolicyEnabled(now)) {
      throw new DomainError("REWARD_RULE_NOT_APPROVED", "The points policy is disabled or its finance approval is no longer active", 503);
    }
  }

  async getSubmission(memberId: string | undefined, submissionId: string, now = this.now()) {
    const owner = requireMember(memberId);
    return readSnapshot(this.pool, async (client, asOf) => {
    const result = await client.query("SELECT id, status, post_url, platform_account, disclosure, license_payload, version, submitted_at FROM submission WHERE id=$1 AND member_id=$2", [submissionId, owner]);
    if (!result.rows[0]) throw new DomainError("SUBMISSION_NOT_FOUND", "Submission not found", 404);
    const uploadSwitch = await client.query<{ enabled: boolean }>("SELECT enabled FROM emergency_switch WHERE key='uploads'");
    const media = await client.query("SELECT id, kind, mime_type, size_bytes, upload_state FROM media_object WHERE submission_id=$1 AND is_current=true ORDER BY kind", [submissionId]);
    const review = await client.query(`SELECT rc.status, rc.version, rc.updated_at,
      latest.reason_code, latest.evidence
      FROM review_case rc
      LEFT JOIN LATERAL (
        SELECT reason_code, evidence FROM review_action
        WHERE review_case_id=rc.id AND action IN ('request_changes','reject')
        ORDER BY created_at DESC LIMIT 1
      ) latest ON true
      WHERE rc.submission_id=$1`, [submissionId]);
    const reviewRow = review.rows[0];
    return {
      ...result.rows[0],
      asOf: asOf.toISOString(), businessVersion: Math.max(Number(result.rows[0].version), Number(reviewRow?.version ?? 0)),
      reward_enabled: this.pointsPolicyEnabled(now),
      media_uploads_enabled: uploadSwitch.rows[0]?.enabled === true,
      media: media.rows,
      review: reviewRow ? { ...reviewRow, reason_summary: reviewReasonSummary(reviewRow.reason_code as string | null) } : null
    };
    });
  }

  async bootstrap(memberId: string | undefined, scope: "home" | "profile" | "settings", now = this.now()) {
    const owner = requireMember(memberId);
    return readSnapshot(this.pool, async (client, asOf) => {
      const member = await client.query(`SELECT m.id,m.display_name,m.status,m.created_at,p.wechat_handle,p.avatar_data_url,p.avatar_revision,
        COALESCE(p.profile_revision,0) AS profile_revision,p.completed_at,COALESCE(p.community_visible,false) AS community_visible,
        COALESCE(p.public_status,'private') AS public_status,p.public_review_note,c.phone_masked,c.bound_at
        FROM member m LEFT JOIN member_profile p ON p.member_id=m.id LEFT JOIN member_contact c ON c.member_id=m.id WHERE m.id=$1`, [owner]);
      const memberRow = member.rows[0];
      if (!memberRow || memberRow.status !== "active") throw new DomainError("AUTH_REVOKED", "Member session is no longer active", 401);
      const care = scope === "settings" ? null : await this.careSnapshot(client, owner, now, { limit: scope === "home" ? 5 : 10 });
      const points = scope === "profile" ? await this.pointsSnapshot(client, owner, now, { limit: 10 }) : null;
      const consents = scope === "settings" ? await client.query(`SELECT cg.id,cg.submission_id,cg.purpose,cg.granted_at,rr.requested_at AS revoked_at,rr.reason AS revocation_reason
        FROM consent_grant cg LEFT JOIN revocation_request rr ON rr.consent_grant_id=cg.id WHERE cg.member_id=$1 ORDER BY cg.granted_at DESC,id DESC LIMIT 21`, [owner]) : null;
      const businessVersion = Math.max(Number(memberRow.profile_revision ?? 0), Number(care?.version ?? 0), Number(points?.projection?.version ?? 0));
      return { scope, asOf: asOf.toISOString(), businessVersion, member: memberRow, care, points,
        settings: scope === "settings" ? { profile: memberRow, phone: { enabled: Boolean(this.config.wechat.phoneBindingEnabled), bound: Boolean(memberRow.bound_at), masked: memberRow.phone_masked ?? null }, consents: consents!.rows.slice(0, 20), consentsNextCursor: consents!.rows.length > 20 ? pageCursor({ at: consents!.rows[19].granted_at, id: consents!.rows[19].id }) : null } : null };
    });
  }

  async adminQueue(principalId: string, now = this.now(), authorization: "legacy_role" | "capability" = "legacy_role") {
    const client = await this.pool.connect();
    try {
      if (authorization === "legacy_role") await this.assertAdminRole(client, principalId, ["reviewer", "review_lead", "auditor"]);
      const result = await client.query(`SELECT s.id, s.status, s.version, s.post_url, s.platform_account, s.disclosure,
        rc.id AS review_case_id, rc.status AS review_status, rc.version AS review_version, s.submitted_at
        FROM submission s JOIN review_case rc ON rc.submission_id=s.id
        WHERE s.status IN ('submitted','appealed') ORDER BY s.submitted_at ASC, s.id ASC LIMIT 100`);
      return result.rows.map((row) => ({ ...row, reward_enabled: this.pointsPolicyEnabled(now) }));
    } finally { client.release(); }
  }

  async adminPublicationQueue(principalId: string, authorization: "legacy_role" | "capability" = "legacy_role") {
    const client = await this.pool.connect();
    try {
      if (authorization === "legacy_role") await this.assertAdminRole(client, principalId, ["review_lead", "auditor"]);
      const result = await client.query(`SELECT s.id, s.status, s.version, s.post_url, s.platform_account, s.disclosure,
        s.updated_at AS reviewed_at, rc.assigned_to AS reviewed_by, fi.id AS feed_item_id, fi.visible,
        EXISTS (
          SELECT 1 FROM consent_grant cg JOIN revocation_request rr ON rr.consent_grant_id=cg.id
          WHERE cg.submission_id=s.id AND cg.purpose='feed_readonly' AND cg.active=false
        ) AS consent_revoked,
        EXISTS (
          SELECT 1 FROM outbox_event oe
          WHERE oe.event_type='submission.publication.approved.v1' AND oe.aggregate_id=s.id
            AND oe.processed_at IS NULL AND oe.dead_lettered_at IS NULL
        ) AS publication_queued,
        EXISTS (
          SELECT 1 FROM outbox_event oe
          WHERE oe.event_type='submission.publication.approved.v1' AND oe.aggregate_id=s.id
            AND oe.processed_at IS NULL AND oe.dead_lettered_at IS NOT NULL
        ) AS publication_dead_lettered
        FROM submission s JOIN review_case rc ON rc.submission_id=s.id
        LEFT JOIN feed_item fi ON fi.submission_id=s.id
        WHERE s.status='approved' ORDER BY s.updated_at ASC LIMIT 100`);
      return result.rows.map((row) => ({ ...row, publication_enabled: this.config.ugcGoLiveGate }));
    } finally { client.release(); }
  }

  async publishSubmission(principalId: string, submissionId: string, idempotencyKey: string, input: { title: string; excerpt: string; aiUsage: "none" | "assisted" | "generated" | "unknown"; reasonCode: string; evidence: JsonObject }, now: Date, authorization: "legacy_role" | "capability" = "legacy_role") {
    if (!this.config.ugcGoLiveGate) throw new DomainError("UGC_GO_LIVE_GATE_CLOSED", "Public user content is disabled until the UGC go-live gate is approved", 503);
    const title = input.title?.trim();
    const excerpt = input.excerpt?.trim();
    if (!title || title.length > 60 || !excerpt || excerpt.length > 240) throw new DomainError("PUBLICATION_COPY_INVALID", "Publication title and excerpt are required and must fit the R0 limits", 422);
    if (!input.reasonCode?.trim() || !input.evidence || Object.keys(input.evidence).length === 0) throw new DomainError("PUBLICATION_EVIDENCE_REQUIRED", "Publication reason code and evidence are required", 422);
    if (!["none", "assisted", "generated", "unknown"].includes(input.aiUsage)) throw new DomainError("AI_USAGE_INVALID", "A structured AI usage declaration is required", 422);
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "submissions");
      if (authorization === "legacy_role") await this.assertAdminRole(client, principalId, ["review_lead"]);
      const idem = { principalId, operation: "submission.publish", idempotencyKey, businessKey: `submission:${submissionId}:publication:v1`, requestHash: requestHash({ submissionId, ...input }) };
      let replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      const submission = await client.query<{ status: string; version: number; member_id: string; assigned_to: string | null }>(`
        SELECT s.status, s.version, s.member_id, rc.assigned_to FROM submission s
        JOIN review_case rc ON rc.submission_id=s.id WHERE s.id=$1 FOR UPDATE OF s, rc`, [submissionId]);
      const row = submission.rows[0];
      if (!row) throw new DomainError("SUBMISSION_NOT_FOUND", "Submission not found", 404);
      replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      if (row.status !== "approved") throw new DomainError("PUBLICATION_STATE_INVALID", "Only an approved submission can enter publication review", 409);
      if (row.assigned_to === principalId) throw new DomainError("FOUR_EYES_REQUIRED", "The reward reviewer and public-content publisher must be different principals", 409);
      const consent = await client.query(`SELECT cg.id FROM consent_grant cg
        LEFT JOIN revocation_request rr ON rr.consent_grant_id=cg.id
        WHERE cg.submission_id=$1 AND cg.purpose='feed_readonly' AND cg.active=true AND rr.id IS NULL`, [submissionId]);
      if (!consent.rows[0]) throw new DomainError("PUBLICATION_CONSENT_MISSING", "Active feed publication consent is required", 409);
      const existing = await client.query<{ id: string; visible: boolean }>("SELECT id, visible FROM feed_item WHERE submission_id=$1", [submissionId]);
      if (existing.rows[0]?.visible) {
        const response = { submissionId, status: "published", feedItemId: existing.rows[0].id };
        await this.idempotencySave(client, { ...idem, response });
        return response;
      }
      const pending = await client.query<{ id: string }>(`SELECT id FROM outbox_event
        WHERE event_type='submission.publication.approved.v1' AND aggregate_id=$1 AND processed_at IS NULL`, [submissionId]);
      if (pending.rows[0]) {
        const response = { submissionId, status: "publication_queued", eventId: pending.rows[0].id };
        await this.idempotencySave(client, { ...idem, response });
        return response;
      }
      await enqueue(client, {
        eventType: "submission.publication.approved.v1", aggregateType: "submission", aggregateId: submissionId, aggregateVersion: row.version,
        businessKey: `submission:${submissionId}:publication:v1`,
        payload: { submissionId, memberId: row.member_id, title, excerpt, aiUsage: input.aiUsage, publishedBy: principalId, reasonCode: input.reasonCode, evidence: input.evidence },
        occurredAt: now
      });
      const queued = await client.query<{ id: string }>("SELECT id FROM outbox_event WHERE business_key=$1", [`submission:${submissionId}:publication:v1`]);
      await this.audit(client, principalId, "submission.publish_approved", "submission", submissionId, input.reasonCode, { status: row.status, publication: "not_public" }, { publication: "queued", aiUsage: input.aiUsage });
      const response = { submissionId, status: "publication_queued", eventId: queued.rows[0]!.id };
      await this.idempotencySave(client, { ...idem, response });
      return response;
    });
  }

  async feed(followingMemberId?: string) {
    const page = await this.feedPage(followingMemberId, { limit: 50 });
    return page.items.map(row => ({ ...row, author_name: page.authors[row.author_id]?.name || "CISME 会员", author_avatar: page.authors[row.author_id]?.avatar || "", author_avatar_revision: page.authors[row.author_id]?.avatarRevision || null }));
  }

  async feedPage(followingMemberId: string | undefined, options: { cursor?: string; limit?: number } = {}) {
    if (!this.config.ugcGoLiveGate) return { items: [], authors: {}, nextCursor: null, asOf: this.now().toISOString() };
    const limit = pageLimit(options.limit, 20, 50);
    const cursor = decodeCursor(options.cursor);
    return readSnapshot(this.pool, async (client, asOf) => {
      const result = await client.query(`SELECT f.id, f.submission_id, f.title, f.excerpt, f.cover_object_key, f.ai_usage, f.published_at, s.member_id AS author_id
        FROM feed_item f JOIN submission s ON s.id=f.submission_id JOIN member m ON m.id=s.member_id AND m.status='active'
        WHERE f.visible=true
          AND ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM community_follow cf WHERE cf.member_id=$1 AND cf.author_id=s.member_id::text))
          AND ($2::timestamptz IS NULL OR (f.published_at,f.id) < ($2::timestamptz,$3::uuid))
        ORDER BY f.published_at DESC,f.id DESC LIMIT $4`, [followingMemberId ?? null, cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
      const items = result.rows.slice(0, limit);
      const authors = await communityAuthors(client, items.map(row => row.author_id));
      const last = result.rows.length > limit ? items[items.length - 1] : null;
      return { items, authors, nextCursor: last ? pageCursor({ at: last.published_at, id: last.id }) : null, asOf: asOf.toISOString() };
    });
  }

  async feedItem(postId: string) {
    if (!this.config.ugcGoLiveGate) throw new DomainError("FEED_ITEM_NOT_FOUND", "Feed item not found", 404);
    if (!/^[0-9a-f-]{36}$/i.test(postId)) throw new DomainError("FEED_ITEM_NOT_FOUND", "Feed item not found", 404);
    return readSnapshot(this.pool, async (client, asOf) => {
      const result = await client.query(`SELECT f.id, f.submission_id, f.title, f.excerpt, f.cover_object_key, f.ai_usage, f.published_at, s.member_id AS author_id
        FROM feed_item f JOIN submission s ON s.id=f.submission_id JOIN member m ON m.id=s.member_id AND m.status='active'
        WHERE f.id=$1 AND f.visible=true`, [postId]);
      const item = result.rows[0];
      if (!item) throw new DomainError("FEED_ITEM_NOT_FOUND", "Feed item not found", 404);
      const authors = await communityAuthors(client, [item.author_id]);
      const author = authors[item.author_id];
      return { ...item, author_name: author?.name || "CISME 会员", author_avatar: author?.avatar || "", author_avatar_revision: author?.avatarRevision || null, asOf: asOf.toISOString() };
    });
  }

  async listEmergencySwitches(principalId: string) {
    const client = await this.pool.connect();
    try {
      await this.assertAdminRole(client, principalId, ["review_lead", "auditor"]);
      const result = await client.query("SELECT key, enabled, reason, updated_by, updated_at, version FROM emergency_switch ORDER BY key");
      return result.rows;
    } finally { client.release(); }
  }

  async listCampaigns(principalId: string) {
    const client = await this.pool.connect();
    try {
      await this.assertAdminRole(client, principalId, ["review_lead", "auditor", "support"]);
      const result = await client.query(`SELECT c.id, c.code, c.qualifying_milestone, c.capacity, c.reward_points,
        c.starts_at, c.ends_at, c.active, c.version, c.updated_at, c.updated_by, c.update_reason_code, c.update_evidence,
        count(t.id) FILTER (WHERE t.state <> 'expired')::int AS allocated_count
        FROM eligibility_campaign c LEFT JOIN eligibility_task t ON t.campaign_id=c.id
        GROUP BY c.id ORDER BY c.starts_at DESC, c.code`);
      return result.rows;
    } finally { client.release(); }
  }

  async updateCampaign(principalId: string, campaignId: string, idempotencyKey: string, input: { active: boolean; capacity: number; startsAt: string; endsAt: string; expectedVersion: number; reasonCode: string; evidence: JsonObject }, now: Date) {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 100_000) throw new DomainError("CAMPAIGN_CAPACITY_INVALID", "Campaign capacity must be between 1 and 100000", 422);
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) throw new DomainError("CAMPAIGN_WINDOW_INVALID", "Campaign start and end must define a valid increasing window", 422);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new DomainError("EXPECTED_VERSION_INVALID", "expectedVersion must be a positive integer", 422);
    if (!input.reasonCode?.trim() || !input.evidence || Object.keys(input.evidence).length === 0) throw new DomainError("CAMPAIGN_EVIDENCE_REQUIRED", "A reason code and evidence are required", 422);
    return transaction(this.pool, async (client) => {
      await this.assertAdminRole(client, principalId, ["review_lead"]);
      const idem = { principalId, operation: "campaign.update", idempotencyKey, businessKey: `campaign:${campaignId}:v${input.expectedVersion}:update`, requestHash: requestHash({ campaignId, ...input }) };
      let replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      const before = await client.query<{ id: string; code: string; capacity: number; active: boolean; starts_at: Date; ends_at: Date; version: number }>("SELECT id, code, capacity, active, starts_at, ends_at, version FROM eligibility_campaign WHERE id=$1 FOR UPDATE", [campaignId]);
      const row = before.rows[0];
      if (!row) throw new DomainError("CAMPAIGN_NOT_FOUND", "Eligibility campaign not found", 404);
      replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      if (row.version !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "Campaign version changed", 409);
      const allocated = await client.query<{ count: number }>("SELECT count(*)::int count FROM eligibility_task WHERE campaign_id=$1 AND state <> 'expired'", [campaignId]);
      if (input.capacity < allocated.rows[0]!.count) throw new DomainError("CAMPAIGN_CAPACITY_BELOW_ALLOCATION", "Campaign capacity cannot be lower than active allocations", 409);
      const updated = await client.query(`UPDATE eligibility_campaign SET active=$1, capacity=$2, starts_at=$3, ends_at=$4,
        version=version+1, updated_at=$5, updated_by=$6, update_reason_code=$7, update_evidence=$8
        WHERE id=$9 RETURNING *`, [input.active, input.capacity, startsAt, endsAt, now, principalId, input.reasonCode.trim(), input.evidence, campaignId]);
      const response = { ...updated.rows[0], allocated_count: allocated.rows[0]!.count };
      await this.audit(client, principalId, "eligibility_campaign.update", "eligibility_campaign", campaignId, input.reasonCode.trim(), row, response);
      await this.idempotencySave(client, { ...idem, response });
      return response;
    });
  }

  async listWorkerBacklog(principalId: string) {
    const client = await this.pool.connect();
    try {
      await this.assertAdminRole(client, principalId, ["review_lead", "auditor", "support"]);
      const result = await client.query<{ event_type: string; pending_count: number; dead_letter_count: number; oldest_occurred_at: Date }>(`SELECT event_type,
        count(*) FILTER (WHERE dead_lettered_at IS NULL)::int AS pending_count,
        count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_letter_count,
        min(occurred_at) AS oldest_occurred_at
        FROM outbox_event WHERE processed_at IS NULL
        GROUP BY event_type ORDER BY oldest_occurred_at, event_type`);
      return result.rows.map((row) => ({
        ...row,
        oldest_age_seconds: Math.max(0, Math.floor((Date.now() - new Date(row.oldest_occurred_at).getTime()) / 1000)),
        handler_state: EVENT_DELIVERY_POLICIES[row.event_type as EventType] ?? "unsupported"
      }));
    } finally { client.release(); }
  }

  async setEmergencySwitch(principalId: string, key: EmergencySwitchKey, idempotencyKey: string, input: { enabled: boolean; reason: string; expectedVersion: number }, now: Date) {
    if (!input.reason?.trim()) throw new DomainError("SWITCH_REASON_REQUIRED", "An emergency-switch reason is required", 422);
    if (key === "community" && input.enabled) throw new DomainError("COMMUNITY_RELEASE_NOT_IMPLEMENTED", "Formal community routes, moderation and privacy gates are not complete", 409);
    return transaction(this.pool, async (client) => {
      await this.assertAdminRole(client, principalId, ["review_lead"]);
      const idem = { principalId, operation: "emergency_switch.update", idempotencyKey, businessKey: `switch:${key}:v${input.expectedVersion}:update`, requestHash: requestHash({ key, ...input }) };
      const replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      const before = await client.query<{ enabled: boolean; reason: string; version: number }>("SELECT enabled, reason, version FROM emergency_switch WHERE key=$1 FOR UPDATE", [key]);
      const row = before.rows[0];
      if (!row) throw new DomainError("SWITCH_NOT_FOUND", "Emergency switch not found", 404);
      if (row.version !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "Emergency-switch version changed", 409);
      const response = { key, enabled: input.enabled, reason: input.reason.trim(), version: row.version + 1 };
      await client.query("UPDATE emergency_switch SET enabled=$1, reason=$2, updated_by=$3, updated_at=$4, version=version+1 WHERE key=$5", [input.enabled, input.reason.trim(), principalId, now, key]);
      await this.audit(client, principalId, "emergency_switch.update", "emergency_switch", null as unknown as string, input.reason.trim(), { key, ...row }, response);
      await this.idempotencySave(client, { ...idem, response });
      return response;
    });
  }

  async listWorkerFailures(principalId: string) {
    const client = await this.pool.connect();
    try {
      await this.assertAdminRole(client, principalId, ["review_lead", "auditor", "support"]);
      const result = await client.query(`
        SELECT 'outbox'::text AS queue_name, id, event_type AS item_type, business_key,
          attempts, last_error, dead_letter_reason, dead_lettered_at, redrive_count
        FROM outbox_event WHERE processed_at IS NULL AND dead_lettered_at IS NOT NULL
        UNION ALL
        SELECT 'media_cleanup'::text AS queue_name, id, reason AS item_type, object_key AS business_key,
          attempts, last_error, dead_letter_reason, dead_lettered_at, redrive_count
        FROM media_cleanup_queue WHERE processed_at IS NULL AND dead_lettered_at IS NOT NULL
        ORDER BY dead_lettered_at, queue_name, id
      `);
      return result.rows;
    } finally { client.release(); }
  }

  async redriveWorkerFailure(principalId: string, queue: WorkerQueue, itemId: string, idempotencyKey: string, input: { reason: string; expectedAttempts: number }, now: Date) {
    if (queue !== "outbox" && queue !== "media_cleanup") throw new DomainError("WORKER_QUEUE_INVALID", "Worker queue must be outbox or media_cleanup", 422);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(itemId)) throw new DomainError("WORKER_ITEM_ID_INVALID", "Worker item id must be a UUID", 422);
    if (!input.reason?.trim()) throw new DomainError("WORKER_REDRIVE_REASON_REQUIRED", "A redrive reason is required", 422);
    if (!Number.isInteger(input.expectedAttempts) || input.expectedAttempts < 1) throw new DomainError("WORKER_ATTEMPTS_INVALID", "expectedAttempts must be a positive integer", 422);
    return transaction(this.pool, async (client) => {
      await this.assertAdminRole(client, principalId, ["review_lead"]);
      const idem = {
        principalId,
        operation: "worker_failure.redrive",
        idempotencyKey,
        businessKey: `worker:${queue}:${itemId}:redrive:a${input.expectedAttempts}`,
        requestHash: requestHash({ queue, itemId, ...input })
      };
      let replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      const table = queue === "outbox" ? "outbox_event" : "media_cleanup_queue";
      const found = await client.query<{ attempts: number; last_error: string | null; dead_letter_reason: string | null; dead_lettered_at: Date | null; redrive_count: number }>(
        `SELECT attempts, last_error, dead_letter_reason, dead_lettered_at, redrive_count FROM ${table} WHERE id=$1 FOR UPDATE`, [itemId]
      );
      const row = found.rows[0];
      if (!row) throw new DomainError("WORKER_FAILURE_NOT_FOUND", "Worker delivery item was not found", 404);
      replay = await this.idempotencyLookup<Record<string, unknown>>(client, idem);
      if (replay) return replay;
      if (!row.dead_lettered_at) throw new DomainError("WORKER_ITEM_NOT_DEAD_LETTERED", "Only a dead-lettered worker item can be redriven", 409);
      if (row.attempts !== input.expectedAttempts) throw new DomainError("VERSION_CONFLICT", "Worker delivery attempts changed", 409);
      const response = { queue, itemId, status: "queued", attempts: row.attempts, redriveCount: row.redrive_count + 1 };
      await client.query(`UPDATE ${table}
        SET dead_lettered_at=NULL, dead_letter_reason=NULL, next_attempt_at=$1, redrive_count=redrive_count+1
        WHERE id=$2`, [now, itemId]);
      await this.audit(client, principalId, "worker_failure.redrive", "worker_delivery", itemId, input.reason.trim(),
        { queue, attempts: row.attempts, lastError: row.last_error, deadLetterReason: row.dead_letter_reason, redriveCount: row.redrive_count }, response);
      await this.idempotencySave(client, { ...idem, response });
      return response;
    });
  }

  private async assertAdminRole(client: DbClient, principalId: string, allowed: string[]) {
    const result = await client.query<{ role: string }>("SELECT role FROM principal_role WHERE principal_id=$1", [principalId]);
    if (!result.rows.some((row) => allowed.includes(row.role))) throw new DomainError("RBAC_FORBIDDEN", "Principal lacks the required role", 403);
  }

  private async audit(client: DbClient, principalId: string, action: string, objectType: string, objectId: string | null, reasonCode: string, before: JsonObject | null, after: JsonObject | null) {
    await client.query(`INSERT INTO audit_log(principal_id, action, object_type, object_id, reason_code, before_state, after_state, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [principalId, action, objectType, objectId, reasonCode, before, after, randomUUID()]);
  }
}

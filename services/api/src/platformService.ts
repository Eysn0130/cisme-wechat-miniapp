import {memberCardNumberProjection} from './memberCard.js';
import { taskProofRetired } from "./taskProofRetired.js";
import { requireActiveUploadOwner } from "./uploadAuthority.js";
import { requireCareRecordDetails } from "./careRecordDetails.js";
import { communityAuthors } from './memberProfile.js';
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { type CareMilestone, type CareMilestoneCommandInput, type CarePhase, type CareVersionCommandInput, type EmergencySwitchKey, type ReviewDecision, type ReviewResult, type ShareTargetType, type TaskClaimView, type UploadAuthorization, type WorkerQueue } from "@cisme/contracts";
import { assertMilestone, assertTimezone, deriveDueMilestone, DomainError, milestoneDueOn } from "@cisme/domain";
import type { AppConfig } from "@cisme/config";
import { readSnapshot, transaction, type DbClient } from "./db.js";
import {memberPointsExtras} from './memberPointsClub.js';
import {activePointPolicy,sweepMemberPoints} from './pointsLedger.js';
import { enqueue } from "./outbox.js";
import { type ObjectStorage } from "./storage.js";
import { EVENT_DELIVERY_POLICIES, type EventType } from "@cisme/contracts";
import { cursorTimestamp } from "./keysetPage.js";
import type { AccountClosure } from './accountClosure.js';

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

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pageCursor(value: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify([value.at, value.id])).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 600 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (!Array.isArray(parsed) || parsed.length !== 2 || !cursorTimestamp(parsed[0]) ||
      typeof parsed[1] !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed[1])) throw new Error();
    const at = parsed[0];
    const id = parsed[1];
    return { at, id };
  } catch { throw new DomainError("CURSOR_INVALID", "Pagination cursor is invalid", 422); }
}

function pageLimit(value: number | undefined, fallback = 20, maximum = 100): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new DomainError("PAGE_LIMIT_INVALID", `Page limit must be between 1 and ${maximum}`, 422);
  return value;
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
    private readonly clock: () => Date = () => new Date(),
    private readonly accountClosure?: AccountClosure
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
      if(await this.accountClosure?.hasIdentity(input.provider,input.appId,input.openid))
        throw new DomainError('ACCOUNT_CLOSED','账号已注销；可从登录页核验微信身份后处理历史隐私请求',410);
      const existing = await client.query<{ member_id: string; identity_id: string }>(
        "SELECT member_id, id AS identity_id FROM wechat_identity WHERE provider=$1 AND app_id=$2 AND openid=$3 FOR UPDATE", [input.provider, input.appId, input.openid]
      );
      let memberId = existing.rows[0]?.member_id;
      let identityId = existing.rows[0]?.identity_id;
      if (!memberId || !identityId) {
        memberId = randomUUID();
        identityId = randomUUID();
        // Registration, share visits and attribution use the same trusted
        // service clock; database-host clock skew must not invert that order.
        await client.query("INSERT INTO member(id, display_name, created_at) VALUES ($1,$2,$3)", [memberId, displayName, now]);
        await client.query(
          "INSERT INTO wechat_identity(id, member_id, provider, app_id, openid, unionid, adapter) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [identityId, memberId, input.provider, input.appId, input.openid, input.unionid ?? null, input.adapter]
        );
        await client.query("INSERT INTO points_projection(member_id) VALUES ($1) ON CONFLICT DO NOTHING", [memberId]);
        await client.query(`INSERT INTO member_care_profile(member_id,required,created_at,updated_at)
          VALUES($1,true,$2,$2)`,[memberId,now]);
      } else {
        const state=(await client.query<{status:string}>(
          'SELECT status FROM member WHERE id=$1 FOR UPDATE',[memberId])).rows[0]?.status;
        if(state==='deleted')throw new DomainError('ACCOUNT_CLOSED','账号已注销；可从登录页核验微信身份后处理历史隐私请求',410);
        if(state!=='active')throw new DomainError('MEMBER_NOT_ACTIVE','账号暂不可登录',403);
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
      const onboardingRequired=Boolean((await client.query(`SELECT 1 FROM member_care_profile
        WHERE member_id=$1 AND required AND completed_at IS NULL`,[memberId])).rowCount);
      return { memberId, identityId, principalId, onboardingRequired };
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
        const response = { cycle: await this.cycleView(client, cycle, now), record: existing.rows[0], task: null };
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
      const record = await client.query("SELECT * FROM care_record WHERE id=$1", [recordId]);
      const response = { cycle: await this.cycleView(client, cycle, now), record: { ...record.rows[0], stepCodes: details.stepCodes, selfAssessment: details.selfAssessment }, task: null };
      await this.idempotencySave(client, { ...idem, response });
      return response;
    }, "SERIALIZABLE");
  }

  private async careSnapshot(client: DbClient, owner: string, now: Date, options: { limit?: number; cursor?: string } = {}) {
      const limit = pageLimit(options.limit);
      const cursor = decodeCursor(options.cursor);
      const current = await client.query<CycleRow>("SELECT * FROM care_cycle WHERE member_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [owner]);
      if (!current.rows[0]) return null;
      const history = await client.query<CycleRow & {cursor_at:string}>(`SELECT *,created_at::text AS cursor_at FROM care_cycle WHERE member_id=$1 AND id<>$2
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
      return { ...views[0]!, history: views.slice(1), nextCursor: last ? pageCursor({ at: last.cursor_at, id: last.id }) : null };
  }

  async getCare(memberId: string | undefined, now: Date, options: { limit?: number; cursor?: string } = {}) {
    const owner = requireMember(memberId);
    return readSnapshot(this.pool, (client) => this.careSnapshot(client, owner, now, options));
  }

  async getMember(memberId: string | undefined) {
    const owner = requireMember(memberId);
    const member = await this.pool.query(`SELECT m.id,${memberCardNumberProjection} AS card_number,m.display_name,m.status,m.created_at,p.avatar_data_url,p.avatar_revision,COALESCE(p.profile_revision,0) AS profile_revision,p.completed_at,COALESCE(p.public_status,'private') AS public_status,c.phone_masked FROM member m LEFT JOIN member_card_number mc ON mc.member_id=m.id LEFT JOIN member_profile p ON p.member_id=m.id LEFT JOIN member_contact c ON c.member_id=m.id WHERE m.id=$1`, [owner]);
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
      // The active-link index deduplicates the target while it is live.
      // A new request after expiry must not replay an expired link forever.
      businessKey: `share:${owner}:${input.targetType}:${targetRef}:request:${requestHash(idempotencyKey)}`,
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
      const visit = await client.query<{ target_type:string;visit_id: string; sharer_member_id: string; visitor_member_id: string | null; first_seen_at: Date; state: string }>(`SELECT sl.target_type,sv.id AS visit_id, sl.member_id AS sharer_member_id, sv.visitor_member_id, sv.first_seen_at, sl.state
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
      const registered=(await client.query<{created_at:Date}>('SELECT created_at FROM member WHERE id=$1',[owner])).rows[0];
      if(row.target_type==='invite'&&registered&&registered.created_at>=row.first_seen_at&&registered.created_at<=now&&await activePointPolicy(client,registered.created_at))
        await client.query(`INSERT INTO member_points_referral(member_id,referrer_member_id,share_attribution_id,created_at)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[owner,row.sharer_member_id,attributionId,now]);
      return { shareId, credited: true, attributionId };
    }, "SERIALIZABLE");
  }

  async getEligibleTasks(memberId: string | undefined, now = this.now()) {
    requireMember(memberId);
    return [] as any[];
  }

  async getTask(memberId: string | undefined, taskId: string, now = this.now()) {
    return taskProofRetired();
  }

  async getConsentGrants(memberId: string | undefined) {
    const owner = requireMember(memberId);
    const result = await this.pool.query(`SELECT cg.id, cg.submission_id, cg.purpose, cg.active, cg.granted_at,
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
        { id: "care-serum-30", name: "头皮护理精华 30ml", subtitle: "轻盈日常护理", price: 26900, image: "/assets/icons/spray-bottle-plum.svg" },
        { id: "care-set-r0", name: "28 天护理组合", subtitle: "精华与护理手册", price: 48900, image: "/assets/icons/spray-bottle-plum.svg" },
        { id: "travel-serum-10", name: "随行护理精华 10ml", subtitle: "便携装", price: 9900, image: "/assets/icons/spray-bottle-plum.svg" }
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

  async claimTask(memberId: string | undefined, taskId: string, idempotencyKey: string, now: Date): Promise<TaskClaimView> {
    return taskProofRetired();
  }

  async authorizeMedia(memberId: string | undefined, submissionId: string, input: { kind: "original" | "screenshot"; mimeType: string; maxBytes: number; baseUrl: string }, now: Date): Promise<UploadAuthorization> {
    return taskProofRetired();
  }

  async gatewayUpload(mediaId: string, input: { token: string; bytes: Uint8Array; mimeType: string }, now: Date) {
    const write = this.storage.writeGatewayObject?.bind(this.storage);
    if (!this.storage.acceptsGatewayUpload || !write) throw new DomainError("UPLOAD_GATEWAY_DISABLED", "Direct S3 upload is configured", 404);
    return transaction(this.pool, async (client) => {
      await this.assertSwitch(client, "uploads");
      // Every media mutation locks the parent before touching media or storage.
      // Keep this lock through the write so completion cannot verify stale bytes.
      const parent = await client.query<{ submission_id: string | null; support_conversation_id: string | null; support_expires_at: Date | null }>(
        "SELECT submission_id,support_conversation_id,support_expires_at FROM media_object WHERE id=$1", [mediaId]);
      const parentRow = parent.rows[0];
      if (parentRow?.submission_id) {
        return taskProofRetired();
      } else if (parentRow?.support_conversation_id) {
        const supportConversation = await client.query<{ status: string;member_id:string }>("SELECT status,member_id FROM support_conversation WHERE id=$1 FOR UPDATE", [parentRow.support_conversation_id]);
        await requireActiveUploadOwner(client,supportConversation.rows[0]?.member_id);
        if (!supportConversation.rows[0] || !parentRow.support_expires_at || parentRow.support_expires_at <= now) {
          throw new DomainError("UPLOAD_UNAVAILABLE", "Support image authorization has expired", 409);
        }
      } else {
        throw new DomainError("MEDIA_NOT_FOUND", "Media authorization not found", 404);
      }
      const media = await client.query<{ object_key: string; mime_type: string }>("SELECT object_key, mime_type FROM media_object WHERE id=$1 AND upload_state='authorized' FOR UPDATE", [mediaId]);
      const row = media.rows[0];
      if (!row) throw new DomainError("MEDIA_NOT_FOUND", "Media authorization not found", 404);
      if (input.mimeType !== "application/octet-stream" && row.mime_type !== input.mimeType) throw new DomainError("UPLOAD_MIME_MISMATCH", "Upload MIME type does not match authorization", 422);
      return write({ token: input.token, mediaId, objectKey: row.object_key, bytes: input.bytes, mimeType: input.mimeType, now });
    });
  }

  async completeMedia(memberId: string | undefined, submissionId: string, mediaId: string, now: Date) {
    return taskProofRetired();
  }

  async deleteMedia(memberId: string | undefined, submissionId: string, mediaId: string, now: Date) {
    return taskProofRetired();
  }

  async saveSubmissionDraft(memberId: string | undefined, submissionId: string, input: { postUrl: string; platformAccount: string; disclosure: string; license: JsonObject; expectedVersion: number }, now: Date) {
    return taskProofRetired();
  }

  async submit(memberId: string | undefined, submissionId: string, idempotencyKey: string, input: { postUrl: string; platformAccount: string; disclosure: string; license: JsonObject; expectedVersion: number }, now: Date) {
    return taskProofRetired();
  }

  async review(principalId: string, submissionId: string, idempotencyKey: string, input: { decision: ReviewDecision; reasonCode: string; evidence?: JsonObject; expectedVersion: number }, now: Date, authorization: "legacy_role" | "capability" = "legacy_role"): Promise<ReviewResult> {
    return taskProofRetired();
  }

  async appeal(memberId: string | undefined, submissionId: string, idempotencyKey: string, reason: string, expectedVersion: number, now: Date) {
    return taskProofRetired();
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

  private async pointsSnapshot(client: DbClient, owner: string, now: Date, options: { limit?: number; cursor?: string;source?:string } = {}) {
    const limit = pageLimit(options.limit, 50);
    const cursor = decodeCursor(options.cursor);
    const source=options.source??'all';if(!['all','earn','spend','expiry','adjustment'].includes(source))throw new DomainError('POINTS_FILTER_INVALID','积分筛选无效',422);
    const projection = await client.query("SELECT frozen, available, debt,reserved, version FROM points_projection WHERE member_id=$1", [owner]);
    const filter=`($5='all' OR $5='earn' AND e.entry_type IN ('grant_frozen','grant_available') OR $5='spend' AND e.entry_type='spend' OR $5='expiry' AND (e.entry_type='expire' OR e.expired_delta>0)
      OR $5='adjustment' AND e.entry_type NOT IN ('grant_frozen','grant_available','spend','expire'))`;
    const entries = await client.query(`SELECT e.id,e.entry_type,e.frozen_delta,e.available_delta,e.debt_delta,e.reserved_delta,e.used_delta,e.expired_delta,
      e.business_key,e.occurred_at,e.occurred_at::text AS cursor_at,g.source_type,g.component,e.metadata->>'amount' AS amount_points
      FROM points_entry e LEFT JOIN points_grant g ON g.id=e.grant_id
      WHERE e.member_id=$1 AND ($2::timestamptz IS NULL OR (e.occurred_at,e.id)<($2,$3::uuid)) AND ${filter}
      ORDER BY e.occurred_at DESC,e.id DESC LIMIT $4`, [owner, cursor?.at ?? null, cursor?.id ?? null, limit + 1,source]);
    const page = entries.rows.slice(0, limit);
    const last = entries.rows.length > limit ? page[page.length - 1] : null;
    const extras=await memberPointsExtras(client,owner,now);
    const filtered=(await client.query(`SELECT count(*)::int AS n FROM points_entry e WHERE e.member_id=$1 AND ${filter.replaceAll('$5','$2')}`,[owner,source])).rows[0].n;
    return { ...extras,totalCount:filtered,rulesEnabled: this.pointsPolicyEnabled(now)||Boolean(extras.clubPolicy), projection: projection.rows[0] ?? { frozen: 0, available: 0, debt: 0,reserved:0, version: 1 }, entries: page.map(({cursor_at: _cursorAt,...entry})=>entry),
      nextCursor: last ? pageCursor({ at: last.cursor_at, id: last.id }) : null };
  }

  async getPoints(memberId: string | undefined, now = this.now(), options: { limit?: number; cursor?: string;source?:string } = {}) {
    const owner = requireMember(memberId);
    await transaction(this.pool,c=>sweepMemberPoints(c,owner,now));
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
      media_uploads_enabled: false,
      workflowRetired: true,
      media: media.rows,
      review: reviewRow ? { ...reviewRow, reason_summary: reviewReasonSummary(reviewRow.reason_code as string | null) } : null
    };
    });
  }

  async bootstrap(memberId: string | undefined, scope: "home" | "profile" | "settings", now = this.now()) {
    const owner = requireMember(memberId);
    if(scope==='profile')await transaction(this.pool,c=>sweepMemberPoints(c,owner,now));
    return readSnapshot(this.pool, async (client, asOf) => {
      const member = await client.query(`SELECT m.id,${memberCardNumberProjection} AS card_number,m.display_name,m.status,m.created_at,p.wechat_handle,p.avatar_data_url,p.avatar_revision,
        COALESCE(p.profile_revision,0) AS profile_revision,p.completed_at,COALESCE(p.community_visible,false) AS community_visible,
        COALESCE(p.public_status,'private') AS public_status,p.public_review_note,c.phone_masked,c.bound_at,
        EXISTS(SELECT 1 FROM member_care_profile cp WHERE cp.member_id=m.id AND cp.required AND cp.completed_at IS NULL) AS care_onboarding_required
        FROM member m LEFT JOIN member_card_number mc ON mc.member_id=m.id LEFT JOIN member_profile p ON p.member_id=m.id LEFT JOIN member_contact c ON c.member_id=m.id WHERE m.id=$1`, [owner]);
      const memberRow = member.rows[0];
      if (!memberRow || memberRow.status !== "active") throw new DomainError("AUTH_REVOKED", "Member session is no longer active", 401);
      const care = scope === "settings" ? null : await this.careSnapshot(client, owner, now, { limit: scope === "home" ? 5 : 10 });
      const points = scope === "profile" ? await this.pointsSnapshot(client, owner, now, { limit: 10 }) : null;
      const consents = scope === "settings" ? await client.query(`SELECT cg.id,cg.submission_id,cg.purpose,cg.granted_at,cg.granted_at::text AS cursor_at,rr.requested_at AS revoked_at,rr.reason AS revocation_reason
        FROM consent_grant cg LEFT JOIN revocation_request rr ON rr.consent_grant_id=cg.id WHERE cg.member_id=$1 ORDER BY cg.granted_at DESC,id DESC LIMIT 21`, [owner]) : null;
      const businessVersion = Math.max(Number(memberRow.profile_revision ?? 0), Number(care?.version ?? 0), Number(points?.projection?.version ?? 0));
      return { scope, asOf: asOf.toISOString(), businessVersion, member: memberRow, care, points, onboardingRequired:memberRow.care_onboarding_required,
        settings: scope === "settings" ? { profile: memberRow, phone: { enabled: Boolean(this.config.wechat.phoneBindingEnabled), bound: Boolean(memberRow.bound_at), masked: memberRow.phone_masked ?? null }, consents: consents!.rows.slice(0, 20).map(({cursor_at: _cursorAt,...grant})=>grant), consentsNextCursor: consents!.rows.length > 20 ? pageCursor({ at: consents!.rows[19].cursor_at, id: consents!.rows[19].id }) : null } : null };
    });
  }

  async adminQueue(principalId: string, now = this.now(), authorization: "legacy_role" | "capability" = "legacy_role") {
    if (authorization === "legacy_role") {
      const client = await this.pool.connect();
      try { await this.assertAdminRole(client, principalId, ["reviewer", "review_lead", "auditor"]); } finally { client.release(); }
    }
    return [] as any[];
  }

  async adminPublicationQueue(principalId: string, authorization: "legacy_role" | "capability" = "legacy_role") {
    if (authorization === "legacy_role") {
      const client = await this.pool.connect();
      try { await this.assertAdminRole(client, principalId, ["review_lead", "auditor"]); } finally { client.release(); }
    }
    return [] as any[];
  }

  async publishSubmission(principalId: string, submissionId: string, idempotencyKey: string, input: { title: string; excerpt: string; aiUsage: "none" | "assisted" | "generated" | "unknown"; reasonCode: string; evidence: JsonObject }, now: Date, authorization: "legacy_role" | "capability" = "legacy_role") {
    return taskProofRetired();
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
      const result = await client.query(`SELECT f.id, f.submission_id, f.title, f.excerpt, f.cover_object_key, f.ai_usage, f.published_at,f.published_at::text AS cursor_at, s.member_id AS author_id
        FROM feed_item f JOIN submission s ON s.id=f.submission_id JOIN member m ON m.id=s.member_id AND m.status='active'
        WHERE f.visible=true
          AND ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM community_follow cf WHERE cf.member_id=$1 AND cf.author_id=s.member_id::text))
          AND ($2::timestamptz IS NULL OR (f.published_at,f.id) < ($2::timestamptz,$3::uuid))
        ORDER BY f.published_at DESC,f.id DESC LIMIT $4`, [followingMemberId ?? null, cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
      const items = result.rows.slice(0, limit);
      const authors = await communityAuthors(client, items.map(row => row.author_id));
      const last = result.rows.length > limit ? items[items.length - 1] : null;
      return { items:items.map(({cursor_at: _cursorAt,...item})=>item), authors, nextCursor: last ? pageCursor({ at: last.cursor_at, id: last.id }) : null, asOf: asOf.toISOString() };
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
    return taskProofRetired();
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

  async requireOperationsReader(principalId: string) {
    const client = await this.pool.connect();
    try { await this.assertAdminRole(client, principalId, ["review_lead", "auditor", "support"]); }
    finally { client.release(); }
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

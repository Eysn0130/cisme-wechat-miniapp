export const CARE_MILESTONES = ["D1", "D7", "D14", "D28"] as const;
export type CareMilestone = (typeof CARE_MILESTONES)[number];
export type CarePhase = "planned" | "active" | "paused" | "terminated" | "completed";

export type SubmissionStatus =
  | "draft"
  | "submitted"
  | "needs_changes"
  | "rejected"
  | "appealed"
  | "approved";

export type ReviewDecision = "request_changes" | "reject" | "approve";
export type AdminRole = "reviewer" | "review_lead" | "auditor" | "support" | "finance_operator" | "finance_approver";
export type EmergencySwitchKey = "identity" | "uploads" | "reviews" | "rewards" | "submissions" | "redemption" | "commerce";
export type ShareTargetType = "post" | "product";
export type WorkerQueue = "outbox" | "media_cleanup";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  trace_id?: string;
}

export interface Principal {
  id: string;
  memberId?: string;
  roles: AdminRole[];
  adapter: "wechat" | "dev" | "admin";
}

export interface CareCycleView {
  id: string;
  phase: CarePhase;
  startedOn: string | null;
  timezone: string;
  protocolVersion: string;
  completed: CareMilestone[];
  due: CareMilestone | null;
  next: CareMilestone | null;
  version: number;
  scheduleOffsetDays: number;
  pausePolicy: { enabled: boolean; maxDays: number; version: string | null };
}

export interface CareVersionCommandInput {
  expectedVersion: number;
}

export interface TaskClaimView {
  id: string;
  taskId: string;
  submissionId: string;
  claimedAt: string;
}

export interface UploadAuthorization {
  mediaId: string;
  method: "POST";
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
}

export interface ReviewResult {
  submissionId: string;
  status: SubmissionStatus;
  version: number;
  rewardClaimId?: string;
  pointsGrantId?: string;
}

export const EVENT_TYPES = [
  "identity.accepted.v1",
  "qualification.recorded.v1",
  "care.cycle.planned.v1",
  "care.cycle.activated.v1",
  "care.cycle.paused.v1",
  "care.cycle.resumed.v1",
  "care.cycle.terminated.v1",
  "care.milestone.completed.v1",
  "eligibility.decided.v1",
  "task.claimed.v1",
  "submission.submitted.v1",
  "submission.reviewed.v1",
  "submission.publication.approved.v1",
  "reward.grant.created.v1",
  "points.grant.unfrozen.v1",
  "points.grant.expired.v1",
  "points.grant.reversed.v1",
  "consent.revocation.requested.v1",
  "share.identity.attributed.v1"
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface OutboxEvent<T = Record<string, unknown>> {
  id: string;
  eventType: EventType;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  businessKey: string;
  occurredAt: string;
  payload: T;
}

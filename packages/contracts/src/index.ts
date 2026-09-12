export const CARE_MILESTONES = ["D1", "D7", "D14", "D28"] as const;
export type CareMilestone = (typeof CARE_MILESTONES)[number];
export type CarePhase = "planned" | "active" | "paused" | "terminated" | "completed";
export const CARE_PROTOCOL_STEPS = ["00", "01", "02", "03"] as const;
export type CareProtocolStep = (typeof CARE_PROTOCOL_STEPS)[number];
export const CARE_SELF_ASSESSMENTS = ["comfortable", "neutral", "attention"] as const;
export type CareSelfAssessment = (typeof CARE_SELF_ASSESSMENTS)[number];

export type SubmissionStatus =
  | "draft"
  | "submitted"
  | "needs_changes"
  | "rejected"
  | "appealed"
  | "approved";

export type ReviewDecision = "request_changes" | "reject" | "approve";
export type AdminRole = "reviewer" | "review_lead" | "auditor" | "support" | "finance_operator" | "finance_approver";
export const CAPABILITIES = [
  "support.read", "support.reply", "support.assign",
  "commerce.product.manage", "commerce.qualification.manage", "commerce.inventory.manage", "commerce.order.read",
  "commerce.fulfillment.manage", "commerce.refund.approve",
  "community.moderate", "member.support_view", "member.profile.read", "member.manage",
  "commission.read", "commission.rate.manage", "commission.rate.approve", "privacy.request.manage"
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type SupportConversationStatus = "ai_active" | "waiting_human" | "human_active" | "resolved";
export type SupportSenderType = "user" | "ai" | "admin" | "system";
export type SupportMessageContentType = "text" | "image" | "order" | "mixed" | "system";

export interface AuthorityProjection {
  version: 1;
  capabilities: Capability[];
  managementAvailable: boolean;
}

export type CatalogQualificationStatus = "pending" | "eligible" | "blocked";
export type CatalogPublicationStatus = "draft" | "published" | "unpublished";
export interface CatalogSkuView {
  id: string;
  code: string;
  label: string;
  currency: "CNY";
  priceCents: number;
  priceVersion: number;
  stockOnHand: number;
  reservedQuantity?: number;
  availableQuantity: number;
  inventoryVersion: number;
  inStock: boolean;
  purchaseEnabled: boolean;
  active: boolean;
  sortOrder: number;
  version: number;
}
export interface CatalogProductView {
  id: string;
  productId: string;
  code: string;
  name: string;
  subtitle: string;
  description: string;
  image: string | null;
  sourceKind: "admin" | "legacy_preview" | "synthetic_test";
  qualificationStatus: CatalogQualificationStatus;
  publicationStatus: CatalogPublicationStatus;
  version: number;
  currency: "CNY";
  price: number | null;
  stockOnHand: number;
  inStock: boolean;
  purchaseEnabled: boolean;
  sellability: "purchasable" | "browse_only" | "out_of_stock";
  variants: CatalogSkuView[];
}

export type CommerceOrderStatus = "pending_payment" | "cancelled" | "expired" | "paid";
export interface CommerceQuoteView {
  id: string;
  status: "active" | "consumed" | "expired";
  currency: "CNY";
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  memberDiscountCents: number;
  shippingCents: number;
  totalCents: number;
  pricingRuleVersion: string;
  addressId: string;
  addressVersion: number;
  expiresAt: string;
  serverTime: string;
  paymentAvailable: false;
  item: { productId: string; productCode: string; productName: string; image: string | null; skuId: string; skuCode: string; skuLabel: string };
}
export interface CommerceOrderLineView {
  id: string;
  lineNumber: number;
  productCode: string;
  productName: string;
  skuCode: string;
  skuLabel: string;
  image: string | null;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}
export interface CommerceOrderView {
  id: string;
  orderNumber: string;
  status: CommerceOrderStatus;
  currency: "CNY";
  subtotalCents: number;
  memberDiscountCents: number;
  shippingCents: number;
  totalCents: number;
  pricingRuleVersion: string;
  version: number;
  expiresAt: string;
  cancelledAt: string | null;
  expiredAt: string | null;
  terminalReason: string | null;
  createdAt: string;
  updatedAt: string;
  paymentAvailable: false;
  lines: CommerceOrderLineView[];
  address: Record<string, string> | null;
}
export type CommerceOrderSummaryView = Omit<CommerceOrderView, "address"> & { address: null };

export interface SupportMessageView {
  id: string;
  sequence: number;
  senderType: SupportSenderType;
  body: string;
  contentType: SupportMessageContentType;
  attachments: Array<{ id: string; mimeType: "image/jpeg" | "image/png" | "image/webp"; sizeBytes: number; previewPath: string }>;
  orderCard: null | { orderId: string; orderNumberTail: string; status: CommerceOrderStatus; currency: "CNY"; totalCents: number; productName: string; productImage: string | null; itemSummary: string };
  deliveryState: "server_accepted" | "read";
  createdAt: string;
}

export interface SupportConversationView {
  id: string;
  status: SupportConversationStatus;
  priority: "normal" | "high" | "urgent";
  memberUnreadCount: number;
  teamUnreadCount: number;
  memberReadSequence: number;
  teamReadSequence: number;
  version: number;
  updatedAt: string;
}
export interface SupportPresenceView {
  serverTime: string;
  agentDisplayName: string;
  operatorOnline: boolean;
  operatorTyping: boolean;
  memberOnline: boolean;
  memberTyping: boolean;
}
export type SupportRetentionReason = "policy_pending" | "not_resolved" | "legal_hold" | "not_due" | "eligible";
export interface SupportRetentionEligibility {
  eligible: boolean;
  reason: SupportRetentionReason;
  policyCode: string;
  policyVersion: number;
  durationDays: number | null;
  eligibleAt: string | null;
  activeLegalHolds: number;
}
export interface SupportPurgeReceipt {
  conversationId: string;
  purged: true;
  messagesPurged: number;
  policyCode: string;
  policyVersion: number;
  auditTombstoneId: string;
}
export type EmergencySwitchKey = "identity" | "uploads" | "reviews" | "rewards" | "submissions" | "redemption" | "commerce" | "community";
export type ShareTargetType = "post" | "product" | "invite";
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

export interface CareRecordView {
  milestone: CareMilestone;
  completedAt: string;
  protocolVersion: string;
  stepCodes: CareProtocolStep[];
  selfAssessment: CareSelfAssessment | null;
}

export interface CareCycleArchiveView {
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
  records: CareRecordView[];
}

export interface CareCycleView extends CareCycleArchiveView {
  history?: CareCycleArchiveView[];
}

export interface CareVersionCommandInput {
  expectedVersion: number;
}

export interface CareMilestoneCommandInput extends CareVersionCommandInput {
  stepCodes: CareProtocolStep[];
  selfAssessment: CareSelfAssessment;
}

export interface TaskClaimView {
  id: string;
  taskId: string;
  submissionId: string;
  claimedAt: string;
}

export interface UploadAuthorization {
  mediaId: string;
  method: "POST" | "PUT";
  url: string;
  fields: Record<string, string>;
  headers?: Record<string, string>;
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
  "share.identity.attributed.v1",
  "support.message.created.v1",
  "support.conversation.handoff_requested.v1",
  "support.conversation.claimed.v1",
  "support.conversation.resolved.v1",
  "support.conversation.purged.v1",
  "catalog.product.changed.v1",
  "catalog.product.qualified.v1",
  "catalog.product.publication_changed.v1",
  "catalog.inventory.adjusted.v1",
  "commerce.order.created.v1",
  "commerce.order.cancelled.v1",
  "commerce.order.paid.v1",
  "commerce.order.expired.v1"
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type EventDeliveryPolicy = "consumer" | "audit_only";
export const EVENT_DELIVERY_POLICIES: Readonly<Record<EventType, EventDeliveryPolicy>> = Object.freeze(Object.fromEntries(
  EVENT_TYPES.map((eventType) => [eventType, eventType === "submission.publication.approved.v1" ? "consumer" : "audit_only"])
) as Record<EventType, EventDeliveryPolicy>);

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

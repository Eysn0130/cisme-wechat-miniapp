# CISME R1/R2 Role-aware Support Verification — 2026-09-11

Status: **LOCAL VERIFIED / NOT DEPLOYED**

Scope: One App / Role-Aware Experience. This report covers R1 Role-aware Shell, R2 Support Foundation, and the commerce authority audit/ADR only. It does not authorize or claim R3, R4, staging deployment, production change, database migration outside the disposable test database, mini-program upload, or real user processing.

## Implemented

- The existing CISME member remains the only app identity. Management is a capability enhancement of that member, not a second product, account, database, API, or conversation authority.
- The same PostgreSQL support conversation is presented to the member and to a capability-checked mobile operator.
- R2 is human-first: a new conversation starts `waiting_human`. The schema represents `ai_active`, but no AI runtime or AI reply route is enabled.
- Existing Web Admin and legacy role tables remain unchanged and are explicitly classified as `LEGACY / INTERNAL OPERATIONS CANDIDATE`.
- Chatwoot and Medusa were used as domain references only. Neither was installed or made authoritative.

## Schema

- Migration `202609110003_role_aware_authority.sql` adds append-preserving `authority_grant` history for 11 named capabilities, one active grant per member/capability, immutable grant evidence, immutable revocation, and database-authored grant/revoke audit rows.
- Migration `202609110004_support_foundation.sql` adds one `support_conversation` per member and immutable, monotonically sequenced `support_message` facts.
- Database guards enforce sequence allocation, assigned-operator replies, AI-only-while-`ai_active`, legal lifecycle transitions, version progression, and rollback refusal when support/authority facts would be lost.
- This local-verification snapshot originally recorded an inactive 180-day placeholder and no purge. It is superseded for staging closure by ADR 0006: duration is now `POLICY PENDING`, conversation/message and audit policies are separate, and a capability-checked legal-hold-aware targeted purge is implemented and must still be proven on staging.

## Contract

- `@cisme/contracts` defines 11 capabilities, authority projection, support conversation/message views, and four audit-only support events.
- OpenAPI contains 11 new paths / 13 operations for authority projection, member support, and mobile management support.
- Contract validation cross-checks 31 migrations, 59 required tables, 57 paths, and 19 event types.
- Support Outbox payloads contain conversation/message identifiers, sender type, and sequence; they do not contain message text or member profile data.

## API

- Member: authority projection, summary/unread, latest/older/incremental message pages, idempotent send, human handoff, and monotonic read cursor.
- Operator: opaque-cursor queue, latest/older/incremental messages, versioned single-winner claim, idempotent reply, shared-team read cursor, versioned resolve, and audited minimal member context.
- Message retries with the same client ID and text return the same message; reuse with different text is rejected.
- Queue and history pagination are cursor-based. History pages over 50 messages are gap-free and non-overlapping.
- Empty or malformed mutation payloads fail as 4xx domain errors rather than unhandled 500 errors.

## Permissions

- Every management operation uses the normal signed member bearer session and independently re-reads the exact active capability from PostgreSQL.
- `support.read`, `support.reply`, `support.assign`, and `member.support_view` are separate checks. Claiming is required before reply/resolve.
- Client visibility, member status, `member_team_access`, legacy roles, and fake `isAdmin`/header flags do not grant R1/R2 authority.
- Revocation takes effect on the next request; no stale token embeds an operational grant.

## User UX

- Home top-left now uses the existing semantic message-circle icon and a bounded `1–99+` unread badge.
- Profile exposes Support to members and conditionally exposes Management Center only from the server authority projection.
- The member chat is mobile-first, text-only, labels user/AI/human/system identities explicitly, polls every five seconds, appends incremental results, and loads older history on demand.
- Failed sends preserve both the text and client message ID, so a response-lost retry cannot silently create a duplicate.
- Attachment affordance is visibly disabled and labeled as a later capability.

## Admin UX

- The same mini-program provides a capability-filtered Management Center, mobile queue, operator chat, claim/reply/resolve controls, and a separate audited context sheet.
- Queue ordering prioritizes waiting-human, unread, and recent conversations and uses an opaque tuple cursor rather than offsets.
- Member context is limited to nickname, member state, masked phone, and join time. Address, care history, attachments, and full member objects are not exposed.
- Competing claims produce one winner. A different operator cannot reply, and the assigned operator must explicitly confirm resolution.

## Tests

- Unit suite: 34 files / 237 tests passed after the R1/R2 changes.
- Integration suite: 19 files / 92 tests passed serially against the disposable test database.
- R1/R2 focused integration: capability isolation, immediate revocation, exact retry, 8-way message ordering, one-of-two claim, wrong-operator rejection, partial/full read counts, resolve/reopen, immutable facts, stale AI rejection, payload minimization, opaque queue pagination, and more-than-50-message history pagination.
- Migration lifecycle covers forward and guarded rollback through migrations 31 → 30 → 29.
- TypeScript checks and production API/Worker/Admin builds passed.

## Privacy

- `support_message.body` and the minimal support member-context surface are present in the personal-data inventory.
- The model-safe projection contains only conversation ID/status plus message sequence, sender type, and body; it excludes profile, phone, address, care, and attachment objects.
- Member-context views are audited with the field names accessed. Operational audit/Outbox records do not duplicate support text.
- Production release remains blocked until the support purpose/legal wording and actual duration are approved. Staging closure now includes an executable targeted purge and synthetic legal-hold proof while leaving the final policy inactive and `POLICY PENDING`.

## Performance

- Local bounded run: 100 isolated members sent their first support message concurrently with zero failures; observed p95 was 93.90 ms.
- The same run returned the 100-conversation management queue in 6.14 ms.
- These are local disposable-database measurements, not staging capacity claims. They support the requested <=100-user R2 design but do not replace staging soak or device/network evidence.

## Evidence

- ADR: `docs/adr/0004-one-app-role-aware-support.md`
- Commerce audit/ADR: `docs/adr/0005-commerce-authority-direction.md`
- Migrations: `db/migrations/202609110003_role_aware_authority.sql`, `db/migrations/202609110004_support_foundation.sql`
- API authority: `services/api/src/authority.ts`, `services/api/src/supportService.ts`
- Contract/API: `packages/contracts/src/index.ts`, `openapi/openapi.yaml`, `docs/EVENT-CATALOG.md`
- Focused verification: `tests/integration/role-aware-support.test.ts`, `tests/integration/support-performance.test.ts`, `tests/unit/role-aware-support-ui.test.ts`, `tests/unit/support-model-projection.test.ts`
- Route/state acceptance contract: `docs/ROUTE-STATE-ACTION-API-ACCEPTANCE.md`
- Current mini-program package: 169 files / 20 routes / 1,631,963 bytes; main package 1,332,716 bytes; global WXSS 8,124 bytes; source SHA-256 `2d891f64556eff7e9ebd8760183125b7214804bf213f163db063976686b8993e`.
- Design structure check passes, while release readiness remains honestly blocked with no current-source route matrix or iOS/Android evidence.

## Unverified

- No staging migration or deployment; no production access or change.
- No WeChat DevTools current-source runtime/Console/Network verification and no iOS/Android physical-device flow.
- No mini-program preview/upload/release and no real member/support data.
- No notification delivery, attachments, SLA/escalation, per-agent unread state, AI answer/suggestion, external processor, or WebSocket transport.
- No grant-management API/UI; R1 grants are currently an audited database administration operation.

## Risks

- Shared-team unread is intentionally coarse for R2; multiple operators do not yet have independent read cursors.
- Five-second polling is bounded and simple but has foreground latency and request overhead; any later WebSocket layer must remain a transport over the same PostgreSQL authority.
- Retention is not enforced, so deployment would collect support text without a completed lifecycle control.
- Authority history deliberately restricts deletion and retains a member foreign key; the future erasure/account-closure design must define lawful retention or irreversible pseudonymization without erasing grant/revocation evidence.
- Dedicated support abuse/rate controls and operational SLA/notification workflows require a later bounded slice before public availability.
- Current visual evidence does not cover the four new routes; static correctness must not be described as product-release readiness.

## Commerce audit

- The existing catalog is three hard-coded, read-only preview items with integer CNY minor units and `checkoutEnabled: false`.
- There is no authoritative Product, Variant/SKU, Price, Inventory, Reservation, Cart, Order, Payment, Fulfillment, Return, or Refund schema.
- ADR 0005 keeps CISME PostgreSQL/Fastify as the future authority, uses Medusa only as a reference, and deliberately adds no commerce schema in R1/R2.

## Next Slice

Do not enter R3 or R4 yet. The next bounded gate is R1/R2 staging rehearsal and current-source WeChat validation: rehearse migrations 29 → 31 → 29 → 31 on isolated staging, deploy the exact API/Worker/mini candidate only after a separate deployment confirmation, bind narrowly scoped test grants, verify audit-only support Outbox drain plus member/operator flows in DevTools and iOS/Android, and close the support legal/retention blocker. After that evidence is reviewed, make a separate go/no-go decision for R3 AI dependency evaluation or R4 commerce schema work.

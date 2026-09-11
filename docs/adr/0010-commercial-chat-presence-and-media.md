# ADR 0010 — Commercial chat presence, read facts and private attachments

Status: Accepted for local implementation; staging/device deployment not approved
Date: 2026-09-12

## Context

The R1/R2 support foundation had one PostgreSQL conversation, immutable ordered messages, cursor polling, human claim, read cursors and retention controls. It did not have a truthful online signal, typing state, message grouping semantics, support media, or an owned-order reference. Treating `human_active` as online would mislead members. Writing every keystroke to the conversation row would create a hot authority row, and exposing object keys would weaken the existing private-media boundary.

## Decision

- PostgreSQL remains the sole support authority. `support_presence` is an ephemeral table keyed by conversation and actor type, separate from `support_conversation`.
- Foreground clients publish at most one heartbeat per three seconds. Online leases expire after 10 seconds and typing leases after 9 seconds. Send, blur, page hide, assignment loss and resolution publish a stop; expiry remains the disconnect fallback.
- A green indicator requires both `human_active` assignment and an unexpired assigned-operator lease evaluated against server time. Assignment without presence is presented neutrally. Operator display names come from `support_operator_profile`, never from a personal WeChat profile.
- Active clients use single-flight cursor polling at about two seconds and idle clients at about five seconds, with bounded failure backoff. Hidden pages stop. No Redis, WebSocket or second conversation store is introduced.
- Send acknowledgement and synchronization are separate facts. Only a message-list response advances the sync watermark; the opposite monotonic read cursor is the only source of `read`. A committed row is labelled `server_accepted`, not delivered or read.
- Claim inserts one immutable `system` message in the same locked sequence stream. The existing database sender/state guard continues to reject late AI writes after human takeover; human inactivity never returns authority to AI.
- Member messages may contain text, up to three verified images, one owned order, or a mixture. The server validates content shape, media ownership/state and `commerce_order.member_id` transactionally before inserting the immutable message.
- Support images reuse the existing storage abstraction and upload switch. The server creates the object key, binds authorization to member and conversation, verifies byte count and detected MIME, and returns only authenticated preview paths. Unbound support objects expire after 24 hours; deletion and purge enqueue durable object cleanup.
- An order message stores `linked_order_id` plus only a minimal immutable display snapshot: order-number tail, status, CNY integer amount, product label/image and item summary. It excludes recipient, phone and address. Opening management order detail remains a separate `commerce.order.read` operation.

## Privacy, retention and operational limits

Typing/presence never enters message history, analytics text, audit or outbox payloads. Message bodies, image bytes and order snapshots follow the still-pending support retention policy and legal-hold checks. An unbound image has a separate 24-hour orphan lifetime. A conversation purge removes message rows and queues attached objects, while the existing body-free tombstone remains minimal.

The upload path is implemented and locally testable, but the current staging COS/upload gate remains disabled. Production domains, legal retention duration, content-safety operations, backup deletion propagation, iOS/Android behavior and physical-keyboard/accessibility verification remain external gates. This ADR does not authorize a deployment, real user data, payment, or a model provider.

## Consequences

Members can distinguish AI, waiting, assigned-offline, assigned-online and resolved states without fabricated availability. Both Mini Program roles share grouping, sparse server time, real read receipts, adaptive polling and history-anchor behavior. The design adds two support tables and support-owned media columns but no runtime dependency. Later WebSocket transport may replace polling only after measured need; it must preserve these authorities and contracts.

References and acceptance rules are recorded in `docs/product/reference/support/CISME-COMMERCIAL-CHAT-UX-CONTRACT.md`.

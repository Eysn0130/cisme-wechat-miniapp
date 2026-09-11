# ADR 0006 — Support retention and purge lifecycle

Status: accepted for R1/R2 staging closure; production duration remains `POLICY PENDING`  
Date: 2026-09-11

## Context

Support messages can contain user-authored personal content, while conversation state and handling audit may be needed for service continuity, after-sales disputes, complaints, security, accountability, and legal duties. Keeping every conversation forever is not an acceptable default. Choosing an arbitrary number of days without operations and legal review is also not acceptable.

## Decision

`support_conversation` and `support_message` share a policy triggered by `conversation resolved`. `support_audit` has a separate policy because its purpose and minimum necessary period may differ. Both durations remain `NULL`, inactive, and declared until operations and legal jointly approve the business/legal basis and duration. This is intentionally represented as `POLICY PENDING`; pending policy can never make data eligible or execute deletion.

The executable lifecycle is:

1. a privacy-capability operator asks for eligibility of one conversation;
2. the service requires an active, enforced policy with a positive duration;
3. the conversation must be `resolved` and its `resolved_at + duration` must have elapsed;
4. active legal holds bound to either the member or the conversation block deletion;
5. a versioned and idempotent command deletes exactly that conversation and its messages in one transaction;
6. a body-free outbox fact and a minimal audit tombstone remain.

The tombstone retains only conversation UUID, policy code/version, resolved timestamp, message count, actor/action/time, and `purged=true`. It does not retain message text, attachment data, member ID, display name, phone, order data, or handler context. The support-audit retention duration remains separately pending and must be approved before any later audit-purge implementation is activated.

## Authority and safety

- CISME PostgreSQL remains the sole Support Authority.
- Eligibility and purge require `privacy.request.manage`; `support.read`, membership, legacy roles, team roles, and client flags are insufficient.
- Purge has no bulk or wildcard target. It accepts one UUID, expected conversation version, and idempotency key.
- Direct deletes are rejected by database triggers. Message immutability is relaxed only inside the transaction carrying the exact conversation purge marker.
- A member-level hold protects all of that member's support conversations; a conversation-level hold protects only its target.
- Policy activation and the production duration are governance changes outside this ADR's automatic authority and require a new legal/operations decision plus deployment review.

## Staging verification

Staging may temporarily activate a one-day synthetic-only duration solely to prove eligibility, legal-hold blocking, exact-target isolation, transactionality, minimal tombstone, and idempotent replay. Synthetic rows and temporary policy activation must be removed/reverted after the test; final staging remains `POLICY PENDING` unless a real policy is separately approved.

## Consequences

The mechanism is executable without inventing a production duration, and a failed/held/not-due attempt cannot partially delete a conversation. Scheduled scanning, automatic bulk purge, attachment deletion, backup erasure propagation, and support-audit purge are not part of R1/R2 and remain future bounded work after their policies and storage surfaces are approved.

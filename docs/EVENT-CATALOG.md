# Event catalog

All events use the transactional `outbox_event`, server UUID, aggregate version, unique business key, occurrence timestamp and JSON payload. Consumers must be replay-safe and may receive duplicates or out-of-order events. The current local worker applies `submission.publication.approved.v1`; per-item SAVEPOINT isolation preserves retry/DLQ accounting after SQL statement errors, and the durable outcome distinguishes `applied` from consent-safe `suppressed`. Events explicitly classified `audit_only`, including the bounded commerce events below, are acknowledged without a business side effect. A production dispatcher/sink, delivery SLO, alert routing and staging replay evidence for any future external delivery are still required and are not inferred from durable insertion alone.

| Event | Aggregate | Business key | Producer | Consumer / invariant |
|---|---|---|---|---|
| `identity.accepted.v1` | member | identity ID | identity transaction | analytics/audit only; never creates care |
| `qualification.recorded.v1` | qualification_fact | source + external ref | transaction adapter or audited experience-member enrollment | ordinary purchase planning remains explicit; the experience enrollment command atomically creates the paired PLANNED cycle and is not a production order substitute |
| `care.cycle.planned.v1` | care_cycle | cycle planned | planning transaction | `started_on` remains null |
| `care.cycle.activated.v1` | care_cycle | cycle activated | explicit activation | one start date and protocol version |
| `care.cycle.paused.v1` | care_cycle | cycle + pause version | signed pause transition | approved reason/policy version and open pause fact are recorded |
| `care.cycle.resumed.v1` | care_cycle | cycle + resume version | signed resume transition | completed facts stay fixed; future milestones shift by recorded calendar days |
| `care.cycle.terminated.v1` | care_cycle | cycle + terminate version | confirmed member transition | termination reason is audited and never implies refund |
| `care.milestone.completed.v1` | care_cycle | cycle + milestone | idempotent milestone transaction | every new D1/D7/D14/D28 fact advances aggregate version and includes ordered 00–03 step codes plus the member's post-care self-assessment; duplicate replay does not add a record or version |
| `eligibility.decided.v1` | eligibility_decision | campaign + fact key | D7 transaction | one decision and at most one task |
| `task.claimed.v1` | eligibility_task | task claimed | claim transaction | claim and submission are atomic |
| `submission.submitted.v1` | submission | submission + version | submit transaction | one review case; versioned supplement |
| `submission.reviewed.v1` | submission | submission + version + status | reward/evidence review transaction | never publishes content; may create the conditional reward in the same transaction |
| `submission.publication.approved.v1` | submission | submission + publication revision | separate review-lead decision | worker revalidates UGC gate, approved state, active consent and media; publisher must differ from reward reviewer; replay upserts one feed item |
| `reward.grant.created.v1` | points_grant | submission reward | approval transaction | replay never creates another reward or entry |
| `points.grant.unfrozen.v1` | points_grant | points action request | different finance approver | whole frozen lot moves to available atomically after the approved hold; projection and append-only entry conserve |
| `points.grant.expired.v1` | points_grant | points action request | different finance approver | whole available lot expires only after its signed expiry; projection and append-only entry conserve |
| `points.grant.reversed.v1` | points_grant | points action request | different finance approver | remaining frozen/available balance is removed, grant is blocked and reward claim is voided; it does not fabricate consumption debt |
| `consent.revocation.requested.v1` | consent_grant | consent revoked | revocation transaction | hides feed and blocks new grant use; preserves history |
| `share.identity.attributed.v1` | share_attribution | share + converted member | first-touch identity transaction | self-attribution is rejected; one identity conversion is credited once |
| `support.message.created.v1` | support_conversation | message ID | member or assigned operator message transaction | contains identifiers, sender type and sequence but never message body or member PII; notification delivery is not implemented |
| `support.conversation.handoff_requested.v1` | support_conversation | conversation + version | explicit member handoff | state becomes waiting_human; no AI response may write after human_active |
| `support.conversation.claimed.v1` | support_conversation | conversation + version | capability-checked operator claim | row lock and expected version allow one current human handler |
| `support.conversation.resolved.v1` | support_conversation | conversation + version | assigned operator resolution | history remains; a later member message reopens the same conversation into waiting_human |
| `support.conversation.purged.v1` | support_conversation | conversation ID | privacy-capability retention operation | emitted only after an enforced active policy is due and legal holds are clear; contains counts and policy identifiers, never message body or member identity; minimal audit tombstone remains |
| `catalog.product.changed.v1` | catalog_product | product + version | commerce.product.manage command | product/SKU/price facts are versioned; payload contains identifiers and action only |
| `catalog.product.qualified.v1` | catalog_product | product + version | commerce.qualification.manage decision | eligible requires an evidence reference; decision history is immutable |
| `catalog.product.publication_changed.v1` | catalog_product | product + version | commerce.product.manage publication command | publish requires eligible qualification and an active priced SKU; unpublish preserves history |
| `catalog.inventory.adjusted.v1` | catalog_sku | adjustment ID | commerce.inventory.manage command | row lock and expected inventory version prevent lost updates; reasoned adjustment evidence is immutable |
| `commerce.order.created.v1` | commerce_order | order + version | member order transaction | creates only `pending_payment`; payload contains order ID/number, status, currency and total, never address or member identity |
| `commerce.order.cancelled.v1` | commerce_order | order + version | member cancel transaction | terminal transition and active reservation release are atomic; payload contains no free-text cancel reason or address |
| `commerce.order.expired.v1` | commerce_order | order + version | worker expiry transaction | terminal transition and active reservation release are atomic and replay-safe; no payment-provider conclusion is implied |

Adding or changing an event requires a new suffix version, OpenAPI/contract update, replay test and migration assessment. Events are not a substitute for current-state authorization.

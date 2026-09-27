# Native whole-order aftersale implementation

Continues PR22 at a659e050ef32ad4dd50d1043e5d9faaf98db4b2f, PRD R4 §8.2 / P18 / AFS-01..03. Inspection found refund requests and support messages but no structured return receipt/inspection case. This change adds that missing local fact model without replacing the existing payment, fulfillment, Excel or refund systems. This is an implementation review, not an independent approval or full release acceptance.

The native management centre remains the only phase-one management UI. Owners enter from paid order detail. Case review, receipt and inspection have separate server capabilities; refund approval uses the existing money authority. A reviewer cannot process their own case. The whole-order line and amount snapshot is immutable. A case and its refund request commit atomically, with no provider I/O in that transaction. An accepted or approved refund does not resolve the case: only the linked channel-success fact does. Active cases stop new dispatch preparation. Existing provider-sync recovery is preserved.

The seven new HTTP operations cover owner creation/list/detail/actions and manager list/detail/actions. The following review is scoped to these operations and their integration points; it does not assert completion of the full 246-operation audit.

| Dimension | Implemented evidence and limit |
| --- | --- |
| Identity and permission | Session middleware, active-member check, owner predicate, action-specific grant locks; HTTP boundary and capability/revocation integration tests. No UI mode is trusted. |
| Object and field access | Non-owner detail denied; bounded projection and customer-visible handling notes. Internal return approval reference excluded. Notes are not a private staff channel. |
| Input | UUID/key/version/reason/kind/carrier/tracking/quality validation and database constraints. Tracking syntax is not proof of carrier existence. |
| Concurrency | SERIALIZABLE writes, actor-key advisory lock, order-before-case row locks, version check and unique active case; dispatch/refund integration uses same order lock. Existing transaction retry behavior applies. |
| Idempotency | Per-actor key plus canonical command fingerprint; original-key retry and conflicts tested. Native uncertain response freezes payload and requires fresh reconciliation after leaving. |
| Amount | Whole-order integer-cent snapshot; existing refund request remaining-amount and financial approval gates. No partial claim or real payment executed. |
| State | Explicit request/supplement/return/receipt/inspection/refund transitions; reopen only after rejected or closed refund. Success is derived from verified channel state. |
| Provider and timeout | No new provider call inside database transaction. Uses existing refund/outbox protocol; signed synthetic success tested, not actual WeChat qualification. |
| Failure recovery | Injected event failure rolls back both case and refund request. Native late response/account change/revocation and uncertain retry tests. |
| Audit | Append-only case events, immutable snapshots, minimal audit state; histories bounded to last 100 with truncation disclosed. |
| Privacy and files | No device case persistence, hide clears personal fields; return destination is a bounded deployment-owned file, never a request input. Missing approved file fails closed. Full production export/erasure is still unfinished. |
| Rate/response boundary | Existing server session/rate hooks and all-/v1 no-store boundary apply; route inventories updated. No new production capacity/SLA claim. |
| Consistency and migration | 76 migrations exercised on new owned PG18 and production-compatible PG16.15 synthetic databases. No existing production database touched. Return inventory is explicitly separate and not auto-restocked. |

Exact local run summaries and log digests: AFTERSALE-LOCAL-VALIDATION.json. New tests include native account isolation, late callbacks, explicit reconciliation; missing/untrusted destination files; object denial, duplicate case/key, separate permissions, return sequence, refund atomicity and signed synthetic success. Full native interaction/device acceptance is separate and remains incomplete.

Remaining source work is real: exchange/reship and any partial-claim product requirement, audited correction of a recorded return waybill, return inventory disposition, broader privacy execution, all-entry 13-dimension review and the production preserve-data deployment entry. The page does not promise these are complete. No customer return address, phone, policy approval or alert recipient was invented.

The old cisme_test incident remains impact UNKNOWN / 未恢复. These newly created synthetic resources do not recover that incident.

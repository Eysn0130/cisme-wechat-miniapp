# CISME R0 production scope

Status: corrected on 2026-08-15. This is the intended R0 boundary, not a claim that every item is complete. The repository is production-oriented engineering, but it is not a delivery candidate or released WeChat mini program and it has no public remote.

## Implemented vertical slice

1. WeChat identity adapter boundary with a visibly separate development adapter. Staging and production reject the dev adapter at startup.
2. Purchased/qualified fact → `planned` care cycle → explicit member activation → clock-derived D1/D7/D14/D28 records.
3. D7 eligibility decision → unique private task; atomic claim returns one `task_claim` and one `submission` under concurrency.
4. Original and screenshot upload through an object-storage adapter; metadata, checksum, account, HTTPS link and benefit disclosure are authoritative server records. Storage/review purposes are necessary; read-only publication is separate, optional and default-off.
5. Human review, supplement, reject, appeal and approve flows with RBAC, versions, reason codes, evidence and audit logs.
6. Claiming creates one pending reward claim. Approval may create one frozen points grant and lot only when signed points rules are active. A finance operator may propose whole-lot unfreeze, expiry or remaining-balance reversal; a different finance approver must decide it. Approval atomically conserves four lot buckets, projection, append-only entry, event and audit. Rules disabled means no asset; spend/debt/recovery/reconciliation remain blocked.
7. Reward/evidence approval never publishes content. Only a separate four-eyes publication decision under the UGC gate creates a transactional outbox event; the worker revalidates state, active consent and media before idempotently creating one read-only feed item. Applied and consent-suppressed outcomes are durable; invalid source/SQL failures retry under per-item isolation, and unimplemented handlers remain visible but unconsumed.
8. Optional publication revocation immediately hides feed use and blocks that purpose from new use without changing the base reward or rewriting historical evidence.
9. Native WeChat pages for account, home, records, task, submit, progress, points, read-only community/post, read-only shop/product, profile and settings.
10. Versioned, RBAC/audited invitation campaign operations and worker backlog/dead-letter APIs; one internal Web operations console for review, publication and finance maker-checker queues. Its shared local token is not production authentication. No consumer AI or Feishu entry exists.

## Enabled R0 product surface

- Home/account/profile and minimal settings/data-rights view.
- Authoritative care records.
- Valid invitation only: task → submit → progress.
- Points acquisition and ledger explanation only.
- Basic `share_id` creation, public visit fact and first-touch identity attribution are implemented and replay-safe. Purchase/refund attribution remains closed with the transaction profile; native share completion still requires real-device evidence.
- Three ordinary currency SKUs for read-only browsing.
- Reviewed, licensed, read-only care stories; private external submissions only.

## Closed gates

- `selected_transaction_profile = null`: no checkout, order, payment, refund or logistics.
- `POINTS_REDEMPTION_ENABLED=false`: no points spend or checkout deduction; this gate is independent from points earning.
- `UGC_GO_LIVE_GATE=false`: no public publish, comments, follows, search, public profiles or public task center.
- `POINTS_RULES_ENABLED=false`: candidate reward rules are not financially approved; approval must not create reward or points assets.
- Production object-storage supplier is unset; SeaweedFS is only the tested local S3-compatible adapter.
- Native upload, login, share and payment cannot be called complete until credentialed device acceptance. Payment is outside this slice because transaction selection is unset.

## Explicitly excluded

Growth levels, messages as a destination, pure-points physical goods, public social graph, cart, coupons, complex promotions, detailed attribution, consumer AI entry, device QA controls, fake orders, fake payment, fake upload success and localStorage authority.

## Completion claim

The accurate claim is: **a corrected R0 vertical slice is locally runnable, database-backed, object-storage-backed, testable and reviewable, with remaining P0/P1 recorded in the release audit**. It is not “complete R0,” “experience candidate,” “online,” “submitted to WeChat,” “production deployed,” or “zero bug.”

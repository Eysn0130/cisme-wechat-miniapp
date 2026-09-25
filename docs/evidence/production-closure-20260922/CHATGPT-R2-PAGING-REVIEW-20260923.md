# ChatGPT R2 source review — 2026-09-23

Received candidate: d5611b218b671d57df6e286d209c7a747473a0e1. Main at receipt: 5740e18544fa37dd473c36934a2a12a07a2d5ec9. Original PR22 and branch retained; no production or staging operation, real provider call, credential/network change, native capture, or release approval in this slice.

## Confirmed defects and fixes

1. `management-privacy/index.ts`: loadMore stopped the timer permanently after success or failure; startPolling also refused expanded lists. Server-side revocation therefore no longer caused the existing periodic cleanup of already-rendered private rows and drafts. This is a client data-retention regression, not evidence of a backend authorization bypass. The existing six-second check is restored; after expansion the poll checks authority only and does not replace the first-page/expanded rows or draft. Explicit refresh remains a full first-page read. Hidden pages and changed identities never accept late results.
2. `keysetPage.ts`: Date.parse alone admitted ambiguous or impossible SQL cursor boundaries, including `0`, date-only forms, normalized February 30, year zero and precision beyond PostgreSQL microseconds. The cursor reader now accepts the canonical UTC forms emitted by existing producers, checks the calendar, and returns the original timestamp string unchanged. JavaScript Date is not used to round the SQL boundary. Existing scope/UUID/malformed-container guards remain. No SQL injection or production incident is claimed.

Code and tests: 2e22a17d1f97f871981a39d6cd2b1c73c07e38a2. Two runtime files changed, two Vitest files added, 27 test cases defined. No dependency, schema, workflow or permission change.

## Evidence boundary

The ChatGPT container ran a separate offline source-transpilation/behavioral-stub harness: baseline 4 PASS / 9 FAIL, repaired candidate 13 PASS / 0 FAIL. Node22.16.0 and TypeScript5.8.3 were used only for that narrow reproduction; this is not the project Node24/TS toolchain, PostgreSQL, WeChat, or full CI verification. RED/GREEN and the harness are in the downloadable handoff.

CI35835943400 on the code commit passed type checking, 102 Python guards and package checks, then stopped at route-audit because the current native manifest still bound the previous source hash. Unit/integration/build stages after that failure did not execute. Its artifact10738864321 has SHA256 d1aff4a10c9a831f2fc0a0e7d84c8b0ef043285515eaffe5f54fbc471591a831; downloaded bytes were verified. The package check measured 272 files, 40 routes, source hash 5fa5253ed6ca3b8d25001212d28ad69071cfd2c146d85b9fcf53f2872b9d07ef. The subsequent manifest update archives the original blob unchanged and keeps native/device acceptance blocked. Read the exact subsequent HEAD CI rather than treating this first failed run as a complete test pass.

## Remaining review targets, not completed by these fixes

- Formal privacy execution still needs scope/retention/hold/actual-executor/receipt evidence. Pagination is not execution.
- Privacy queue terminal ordering omits `partially_completed`, while respond treats it as closed: reconcile queue semantics with the existing state machine and test mixed pages before changing it.
- Shipped lost/damaged/no-return refund exceptions need an authorized case path; never re-open the obsolete unscoped formal refund route.
- Refund eligibility rejects nonzero freight/discounts: validate that the enabled checkout policy cannot accept orders with no supported refund path. This is a conditional business compatibility risk, not a demonstrated live failing order.
- Production restore, actual historical artifact/schema compatibility, legacy consumers, public TLS, incident containment and native/device acceptance remain separate.

GitHub main reports protected=false and the effective repository ruleset list is empty at this review. Another GitHub account Approve is not an enforced branch prerequisite. A technical review receipt and a GitHub APPROVED review are distinct; neither source fixes nor an own-account COMMENT constitutes a full independent release approval. Do not silently change a project review requirement, waive checks, or merge on this limited slice alone.

# Local acceptance evidence — 2026-08-15

Scope: evidence-capture snapshots from the dirty working tree in `/Users/mini/CISME/cisme-r0-platform`; no remote, commit, GitHub Actions run, preview upload or real-device claim. This document does not automatically describe later source edits.

## Passed gates

| Gate | Result |
|---|---|
| `npm run typecheck` | passed: root and native mini-program TypeScript |
| `npm run lint:contracts` | passed: 14 migrations, 29 tables, 23 paths, 15 events cross-checked |
| `npm run miniprogram:package-gate` | historical `64561172…` capture snapshot passed: 13 routes/127 files; 1,230,143 bytes; global WXSS 5,611 bytes. Its DevTools evidence does not describe later source. |
| `npm test` | historical `64561172…` capture snapshot passed: 6 files / 45 unit tests. Later checkpoints have additional tests and must be reported separately. |
| `npm run test:storage-contract` | passed: 1 storage contract test |
| `npm run test:integration` | passed sequentially: 5 files / 22 integration tests, including migration lifecycle, care aggregate version/concurrent exact replay, campaign RBAC/audit, finance maker-checker points lifecycle and worker applied/suppressed/SQL-failure/dead-letter/redrive behavior |
| `npm run build` | passed: API/worker ESM bundles and admin Vite production build |
| root `npm audit --audit-level=low` | passed: 0 vulnerabilities |
| `npm run sbom` | generated CycloneDX 1.6 SBOM |
| `npm run license:report` | passed: 478 dependency rows, 0 unknown |
| `npm run wechat:preflight:local` | passed for local origin/tooling and printed tracked AppID-shaped value `wxf639399a761abc01`; the command does not validate ownership or runtime reconciliation, and the evidence-capture DevTools session reported `touristappid` |

The current Design QA evidence index uses schema v2. Its unit gate verifies artifact digest, byte size, MIME/image dimensions, kind, actual package hash and route/state/platform metadata, rejects duplicate reuse, and requires distinct reference/native/comparison evidence for each applicable state. The credentialed preview job now depends on the complete verify job; the direct isolated entrypoint also fails before loading preview tooling when engineering, package, AppID, legal/domain/manual/risk or strict Design QA gates are incomplete.

The first attempt to run the full integration suite and the storage-contract suite concurrently collided because both intentionally reset the same disposable test database. They were rerun sequentially and passed; CI already runs database suites sequentially. This is test isolation evidence, not a product defect or a suppressed failure.

After adding the worker-outcome and campaign-operation migrations, the migration lifecycle gate correctly failed because its N-1 assertion still assumed the prior worker-control migration was latest. The assertion was updated to verify rollback/reapply of campaign columns while retaining the earlier worker columns; the complete sequential suite was rerun and passed 5 files / 22 tests. The initial failure is not counted as a pass.

The first final `npm audit` request hit a transient registry TLS disconnect; the immediately repeated full audit completed and returned 0 vulnerabilities. The failed network call is not reported as a security pass.

After the current-source gate run, the local API was restarted against the migrated disposable database. `GET /health/ready` returned `transactionProfile:null`, `pointsRedemptionEnabled:false`, `ugcGoLiveGate:false` and `pointsRulesEnabled:false`; `GET /v1/catalog` returned `checkoutEnabled:false`. This is local runtime/source parity for fail-closed configuration, not production readiness or a transaction implementation.

## Expected fail-closed gates

| Gate | Result |
|---|---|
| `npm run wechat:preflight:preview` | blocked: public preview HTTPS origin, privacy-guide proof, legal approval, domain allowlist proof and demo-scope approval absent |
| `npm run wechat:preflight:trial` | blocked by the same items plus experience-member proof |
| `npm run wechat:ci:isolated` | failed closed before tool execution: strict Design QA is blocked and verified target AppID/private key, AppID reconciliation, public preview origin, legal/privacy/domain/demo approvals and explicit risk acceptance are absent |
| isolated `npm audit --prefix tools/wechat-ci` | blocked by 73 advisories: 41 critical, 16 high, 15 moderate, 1 low |

## Visual/interactive evidence boundary

- Historical package `64561172…` was compiled in WeChat DevTools Stable 2.01.2510290 under `touristappid`: Project Errors `0` / Problems `0`; retained post-compile and post-traversal Console windows contain no rows. All 13 modules were requested at public/no-session boundaries. Eight protected routes were repeated individually; the client precheck stopped required-auth `wx.request` calls before network dispatch and each route ended at Account with `0` HTTP 401, `0` Console error rows and `0` Console-input syntax errors. The built-in screenshot action produced raw 750×1624 Account/Community frames. Their combined review confirms the capture-time disabled primary hierarchy and Community hero title, while scope-correct copy/state mismatches prevent a visual pass. A fresh public Community window recorded 41 requests partitioned exactly as `1×200 + 20×304 + 20×307`, with no status 0/4xx/5xx. No HAR is claimed. See `docs/evidence/DEVTOOLS-ACCEPTANCE-64561172-2026-08-15.md`.
- Historical `9e536f82…` was compiled and traversed across all 13 modules. Its fresh public-community HAR contains 41 entries: one API `200`, twenty DevTools-local `307` redirects and twenty cached `304` asset responses; no status 0/4xx/5xx. It is a bounded historical window, not an all-flow HAR and not inherited by the current hash. See `docs/evidence/DEVTOOLS-ACCEPTANCE-9e536f82-2026-08-15.md`.
- Historical `5e2b2801…` same-state Home/Records evidence uses exact frozen-Web 375×812 captures and native 750×1624 originals. Home's same-coordinate full/y44-y44 comparisons contain no visible product P0/P1; the asymmetric Web-y44/native-y0 file is a documented crop-method failure. The Records finding drove a current-source density/typography fix, which is not passed until the current hash is recaptured. See `docs/evidence/visual/current-run/README.md` and `design-qa.md`.
- Package `f2ec3156…` remains the historical all-13-route/default-state traversal, claim/draft interaction and profile scroll/repeat-tab snapshot. Those files are not current-source evidence and are not inherited by `5e2b2801…`.
- Package `812a483f…` account evidence is `docs/evidence/visual/current-run/native/account-package-812a483f-375x812-2x-2026-08-15.png` (DevTools original 750×1624, iPhone X logical 375×812) and `docs/evidence/visual/current-run/comparisons/account-web-native-package-812a483f-375x812-2x-2026-08-15.png`. Account typography changed after this capture, so the images are now a pre-remediation finding/geometry diagnostic only. The frozen Web also says optional phone authorization, while production-correct native copy says conditionally enabled/currently unavailable; no exact/pass verdict is assigned.
- Account/community/task/submit/progress/profile interaction screenshots remain capture-specific diagnostics. In particular, the valid-invite task → claim → authoritative draft/resume trail belongs to `f2ec3156…`; the later database reset means its IDs are historical evidence, not current rows or a current-package continuous media E2E.
- During that traversal, a token that still verified cryptographically but referenced a member removed by an earlier database reset produced `MEMBER_NOT_FOUND`. The client fix now clears the stale token and resumes authentication; unit coverage and a DevTools logout/re-entry regression both passed.
- Task and submit screenshots are preserved, but neither is promoted to a formal visual pass: task reward copy differs because unsigned points rules are fail-closed, and submit's frozen Web fixture has obsolete fields/consents. The submit diagnostic also found WeChat's native textarea default height; the explicit-height fix was recaptured in r2 and restores first-screen rhythm without pretending the mismatched business fixtures are exact.
- A labeled local review-state fixture then exercised progress `submitted` and `needs_changes` without pretending that local bytes were real device media. It found and fixed a blank status-title mapping defect, recaptured the corrected hierarchy against the frozen Web, displayed a server-produced public review-reason summary, scrolled to the bottom, reopened supplementation with the same ID, and returned to the task without a navigation loop. `rejected`, `appealed`, `approved`, real media and real-device variants remain open.
- The `64561172…` capture snapshot has compile/Console/bounded public-network evidence, a 13-module public/no-session traversal and Account/Community raw frames; it is now historical and not inherited by current source. Whole-product same-state/copy/crop recapture and the authenticated route-state grid were not complete. `design-qa.md` remains `final result: blocked`.
- No real AppID ownership, real WeChat login, iOS/Android, camera/album, end-to-end media upload, weak-network or keyboard acceptance exists. The local object-storage adapter and simulator chooser are not counted as real upload proof.

## Reproduction

Run database tests sequentially. Re-run `npm run miniprogram:package-gate` immediately before binding a release artifact because any source or asset change changes the aggregate hash. Then compile in WeChat DevTools and record project console/network output separately from DevTools/base-library warnings.

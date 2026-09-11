> 2026-09-09 17:18 最新状态：数据库、API、Worker 与对象存储已切换腾讯云；现行协议为 `2026-09-09-v2-domestic`。开发版 `0.1.2-dev.20260909` 已上传，体验版设置、备案及真机验收尚未完成。详见 [会员与迁移复盘](docs/MEMBER-PERFORMANCE-DOMESTIC-2026-09-09.md)；下方旧记录保留原时间范围。

> 当前状态更正（2026-09-09）：协议正文、项目主体与隐私受理入口已完成并发布；详见 docs/legal/发布缺口说明.md。历史“协议未发布/没有主体资料”不再适用。整体真机与微信上架验收另行记录。

# CISME delivery handoff

Status: **local reviewable work-in-progress; not a delivery, experience, review-submission or release candidate.**

## Reviewable now

- Native WeChat consumer source, modular TypeScript API/worker, PostgreSQL migrations, object-storage adapter, contracts/config/test packages and internal review console.
- DevTools interaction evidence covers local API-backed invitation → atomic claim → authoritative draft/resume. Upload, submit, review, appeal and points lifecycles are covered separately by automated integration/contract tests. Submitted/needs-changes screenshots use explicitly labeled visual fixtures; they are not one continuous media E2E. Real-device media upload is not claimed.
- Corrected identity isolation, optional publication consent, atomic media replacement, durable cleanup, session recovery, source-aware navigation, stale-response rejection, foreground UGC revalidation and dynamic native chrome.
- Member-managed display names survive placeholder re-login; core mutation pages now block/confirm in-flight exit, preserve upload-time draft edits, expose discard-and-leave recovery and distinguish task-sync failure from a true empty invitation state.
- Care activation/phase/milestone commands and their current consumers use explicit Idempotency-Key plus aggregate version; concurrent phase replay is exact and every milestone advances the version. The publication/media-cleanup worker now has per-item SQL isolation, applied/suppressed outcomes, bounded retry, dead-lettering, backlog visibility and audited redrive; unsupported event types remain durable instead of being falsely marked delivered.
- MAKE is the only planned transaction direction while runtime remains UNSET; points redemption is separately gated and remains disabled.
- PRD/range delta, route-state acceptance matrix, Design QA, release audit, ADRs, ERD/OpenAPI/events/permissions/NFR/threat/recovery/runbook/SBOM/licenses.
- Evidence/preview gates now bind artifacts to the actual package hash, digest, byte size, MIME/real image structure/dimensions and route/state/platform metadata; unreferenced evidence-index entries fail. Credentialed preview cannot bypass the full verify job, package budget, strict Design QA, AppID, legal/domain/manual or risk gates.
- Current 2026-09-08 verification: 94 unit tests, 37 isolated-database integration tests, TypeScript, contract checks, Web/runtime integrity and service/admin build pass. Native package checks pass. These are scoped checks, not a whole-product release acceptance; see `docs/evidence/visual/community-app-2026-09-08/verification.md`. The strict design/release gates remain blocked by incomplete route/device/network/legal evidence.

## Not delivered or claimed

- A temporary public-HTTPS true-device debug QR was intentionally generated on 2026-09-01 with the dedicated develop-only condition and LAN mode off. An authorized iPhone 17 Pro Max / iOS 26.5.2 connected over 4G, but the first QR targeted Android; DevTools warned about the mismatch and no business API request reached the tunnel. That session proves remote transport only, not iOS acceptance. It was ended and replaced with an iOS-specific QR, which still awaits scan. There is still no experience upload, WeChat review submission, durable public deployment or production cloud. The separate interface-test-account Preview QR accidentally generated on 2026-08-30 was not scanned, distributed or accepted and is not release evidence.
- Config contains an AppID value, but there is no verified ownership/project role or real AppID login; iOS/Android acceptance, merchant/payment/logistics and an implemented transaction profile are also absent. MAKE is only a signed target direction, not a runtime selection. Base `share_id` visit→identity attribution is implemented locally; purchase/refund attribution remains impossible without transaction facts.
- No production IdP/MFA/RBAC, spent-points debt/repayment, erroneous-transfer recovery or reconciliation. Local whole-lot unfreeze/expiry/remaining-balance reversal uses maker-checker, but points remain fail-closed without signed production policy/role ownership.
- No production public UGC, comments, follows, personalization, complex growth, pure-points goods or consumer AI. Development/test-only brand-story likes, saves and moderated comments now persist to the local API. Pending comments remain owner-only and do not raise public counts; this does not enable production UGC.
- No final whole-product visual pass: current package `23691a4cfe64bb6e0e81c909f2ee7b134707663d8b3715d3ee98675185ea36d1` has 138 files / 14 routes / 1,693,253 bytes; global WXSS is 8,117 bytes. The current-source manifest is structurally valid and explicitly blocked. Local community and invitation refinements have native UI evidence; the complete route/state matrix and iOS/Android device evidence remain incomplete. DevTools RC recorded an internal WAWebview error during automated photo-preview interaction even though full-screen images and swiping worked; this remains a documented simulator/device follow-up. Historical compile, network and device checkpoints are not inherited.

## Release decision

Use `RELEASE-AUDIT.md` and `design-qa.md` as the binding status. Do not inherit older “local scope P0/P1 = 0” or “local candidate” wording. Only after their blockers close may the team label a build “体验版候选” or “候选成品”.

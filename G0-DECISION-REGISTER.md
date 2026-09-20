# G0 decision register

> Historical decision snapshot (2026-08-14). Several implementation/version entries below predate the current code. For current product decisions and performance targets, use `docs/product/CISME-产品需求文档-PRD-V2.1-R4.md` and `docs/NFR-MEASUREMENT.md`; verify runtime status against the latest main and evidence. This notice preserves the original record and does not imply new G0 sign-off.

Decision date: 2026-08-14. `Selected` means frozen for this repository; `UNSET` means the corresponding consumer capability must remain closed.

| Decision | Status | Evidence / acceptance condition | Exit path |
|---|---|---|---|
| Runtime: Node.js 24.18 LTS | Selected for CI | Node 24 is LTS; local evidence was run on 24.14 and is recorded as such. [Node releases](https://nodejs.org/en/about/previous-releases), [24.18 release](https://nodejs.org/en/blog/release/v24.18.0) | Standard ESM/HTTP/SQL code; upgrade one LTS at a time |
| TypeScript 7.0.2, Fastify 5.12.0, pg 8.23.0 | Selected | Exact npm lock; Apache-2.0/MIT/MIT | Contracts and service modules do not depend on proprietary runtime |
| PostgreSQL 18.4 | Selected | Officially supported through 2030-11-14. [PostgreSQL versioning](https://www.postgresql.org/support/versioning/) | SQL migrations and pg_dump are provider-neutral |
| Monorepo: npm workspaces | Selected | Native Node tool, no separate orchestration platform | Workspaces can be split without changing API/DB contracts |
| Architecture: TypeScript modular monolith + worker | Selected | Small-team operations; transaction boundaries stay in one database | Outbox permits later service extraction without dual-write |
| Local object storage: SeaweedFS 4.29 path-style S3 | Selected for local test only | Actual SigV4 multipart POST/HEAD/checksum/delete contract passed with AWS SDK 3.1110 and `wx.uploadFile` form shape. Apache-2.0. [Releases](https://github.com/seaweedfs/seaweedfs/releases), [license](https://github.com/seaweedfs/seaweedfs/blob/master/LICENSE) | `ObjectStorage` adapter; production supplier remains unset; controlled API multipart gateway is retained |
| MinIO | Rejected | Current upstream repository/archive and AGPL/source-only distribution do not fit the small-team local runtime decision | No MinIO-specific API in contracts |
| WeChat native mini program, base library 2.32.3 | Selected | Official `wx.login`, privacy APIs, `wx.chooseMedia`, `wx.uploadFile` and lifecycle APIs; official DevTools 2.01.2510290 is installed and signature-verified; real AppID/account/domain/device remain external blockers | API contracts are transport-neutral; visual tokens are plain WXSS |
| Transaction MAKE/BUY | **MAKE target / runtime UNSET** | MAKE is the only planned implementation direction for the current few-SKU/direct-cash R0; no payment, refund, shipment, reconciliation, merchant or sandbox evidence yet proves it runnable. BUY may reopen only through a time-boxed named-supplier evidence packet | Checkout routes stay absent; compiled runtime rejects both profile values until implementation exists. Never dual-write |
| Points redemption | **Closed independently** | Earning/ledger readiness is not redemption readiness. An implemented selected transaction profile, time-bounded finance approval and prepare/commit/release/refund-allocation evidence are required | `POINTS_REDEMPTION_ENABLED=false`; cash transaction work must not be blocked by this optional gate |
| Public UGC | Closed | Provenance, content safety, moderation SLA and legal approval incomplete | `UGC_GO_LIVE_GATE=false`; external task evidence stays private; only brand-owned or separately approved read-only content may be shown |
| Points rules | Closed | Finance/product signature unavailable | Candidate rules and budget below remain disabled |

## Candidate points budget — not approved

These are modelling inputs, not active rules:

| Candidate rule | Points | Monthly cap assumption | Maximum modelled monthly liability at ¥0.01/point |
|---|---:|---:|---:|
| D7 reviewed care story | 300 | 50 | ¥150 |
| D28 completed care record | 80 | 500 | ¥400 |
| Verified replenishment fact | 50 | 300 | ¥150 |
| Approved appeal correction | Same as original, not additive | included above | ¥0 incremental |

Modelled ceiling: ¥700/month before breakage, expiry or tax treatment. Finance and product must approve denomination, liability treatment, hold, expiry, caps and fraud policy before `POINTS_RULES_ENABLED=true`. The integration configuration exercises frozen grant → separate maker/checker unfreeze, expiry and remaining-balance reversal; this proves conservation and replay only, not financial approval. Disabled environments create no points asset.

## Transaction and redemption acceptance split

The current build has no implemented transaction profile, so any non-empty `SELECTED_TRANSACTION_PROFILE` fails with `TRANSACTION_PROFILE_NOT_IMPLEMENTED`; environment booleans cannot make `/health/ready` claim checkout readiness.

When a profile implementation exists, its cash baseline must independently prove payment/order truth, refund, shipment, export and sandbox reconciliation. `POINTS_REDEMPTION_ENABLED=true` is a second gate requiring a selected profile, an unexpired finance approval plus prepare, commit, release and refund-allocation evidence. It does not require new-points earning rules to be enabled. A signed statement or green configuration value is insufficient; executable contract tests and reconciliation output are required.


## 2026-09-20 implementation overlay — supersedes stale implementation claims above

This overlay is not a new Owner, finance, legal or operations signature. The 2026-08-14 snapshot above is preserved for traceability; do not use it to delete subsequently implemented capabilities.

| Historical entry | Verified current source / effective requirement | Remaining boundary |
|---|---|---|
| Fastify 5.12.0 / old local runtime | Root lock selects Fastify 5.12.3, pg 8.23.0, TypeScript 7.0.2; current CI and cloud repair use Node 24.18.0 | No dependency upgrade in this repair |
| Base library 2.32.3 / old DevTools | `apps/miniprogram/project.config.json` selects 3.15.2; prior 2026-09-20 consolidation observed Stable 2.02.2608070 | That old observation is not a new-device pass for the repaired package |
| MAKE runtime UNSET / checkout absent | PRD §0.1.1 selects MAKE; `commerceService.ts`, `commerceRoutes.ts` and native product/checkout/order routes exist | Actual cash movement, merchant configuration, finance sign-off and live release remain separately gated |
| Old 800ms write / 99.5% appendix | PRD §13 / current NFR appendix: core API P95≤500ms, core-page interactive P95≤2s; G0 high capacity +30% headroom | 99.9% monthly availability remains conditional and unsigned; no deployed NFR pass asserted |
| A timer proves cancellation | One monotonic operation budget, server SQL timeouts and disposal of cancelled leases; dependency cooperation; unknown COMMIT recovery | Confirm using real PostgreSQL faults and authorised staging, not handlerTimeout configuration alone |
| Source sync implies release | New package gets a new manifest; historical screenshots keep original hash and scope | `releaseReady=false`; local Mac sync and 37-route/device states require their own evidence |

The root audit and optional `tools/wechat-ci` audit are separate. The historical uploader count (80) is not silently repaired or waived by this work; the optional uploader and its credential workflow remain unenabled. See `docs/CISME-NATIVE-REPAIR-2026-09-20.md`.

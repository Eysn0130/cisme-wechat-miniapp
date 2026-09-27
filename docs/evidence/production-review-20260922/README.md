# PR22 production closure: scoped independent review

Date: 2026-09-22. Reviewed PR22 source: `4ef5c92e36cd24b6b030a86cf0b23e9e8c5c4530`; main observed: `5740e18544fa37dd473c36934a2a12a07a2d5ec9`.

## What changed in this increment

`release-migrate.mjs verify` previously checked SQL hashes only. A changed/missing API or Worker bundle, malformed source identity, duplicate/out-of-order migration list, or extra unlisted SQL could pass that limited verification. Its static `pg` import also prevented dependency-free verification. The packager and staging installer have separate checks; this finding is a gap in the migration entrypoint's own verification, not proof that a corrupted release was deployed.

The entrypoint now checks the exact schema-1 artifact/hash set, all runtime/lock/migration/self hashes, ordered unique migration names, actual SQL file set, source SHA/tree shapes, file types, symlinks, bounded sizes and UTF-8 SQL before loading `pg`. Existing approval/backup references, advisory lock, prefix history, transactions and sanitized errors remain. Manifest hashes establish consistency, not authenticity: the caller must pin the archive and source to independently verified CI/main and protect the release directory.

`infra/tencent/production-target.py` adds a read-only consistency/freshness check for the existing production instance, IP/DNS/domain, candidate production runtime, existing database and COS identity, and reviewed main SHA/tree. It rejects staging and historical observations. It DOES NOT query a cloud service, authenticate its JSON input, grant permission, migrate, deploy or enable sales. Codex must collect authenticated live observations and wire this guard into the production deployment path; a fabricated JSON file is not evidence. Legitimate infrastructure changes require review of the binding, not bypassing it.

## Validation actually performed

- Reconstructed original migration entrypoint matched Git blob `9ede653097e6ac3717d326ff0b7aab5447bf5e90`.
- Original-entrypoint regression run: 20 test methods ran, exit 1, 31 reported failures including subtests. This is NOT 31 distinct test methods.
- Fixed entrypoint: 20 methods pass. Production-target guard: 14 methods pass. Final combined run: 34 methods pass.
- `node --check scripts/release-migrate.mjs` passes.
- Local environment: Linux, Python 3.13, Node 22.16.0; a temporary review subset, not the user's Mac project. This is NOT the repository's required Node 24 full test run, SQL migration validation, native acceptance or cloud deployment.
- New tests use the existing CI `test_staging_*.py` discovery pattern. No workflow, dependency, privilege or gate was weakened. Actual updated-head CI must be checked separately.
- All test inputs are synthetic temporary files. The fake `pg` module is an import/connection tripwire, not a database implementation.

## Production destination and unresolved findings

Production remains `lhins-61ikz4mi` / `124.223.74.198` / `api.cisme.cn`; staging `lhins-ei4hz4fi` is not the final delivery destination. Source: existing `../launch-unblock-20260922/ENVIRONMENTS.json` and `../fulfillment-lifecycle-20260922/STAGING-DEPLOYMENT.json`.

The uploaded/environment observations are historical, not new live probes from this review. Production's misleading `APP_ENV=staging`, missing recorded cloud 443 rule plus external timeout, public 5432/22, unverified certificate renewal, legacy legal texts and unverified restore remain to investigate. Do not infer the single root cause of the timeout from one probe. Production also has an expiry date (displayed 2026-12-08), not lifetime service.

The staging deployment is `0f1b4c3...`, not latest PR22. It uses a local object gateway, not production COS. Its 129-table/count restore, 30-second sample, monitor without external notifications, and retained-but-not-executed rollback are narrower than full production recovery/operations acceptance.

The existing staging installer intentionally creates a new empty acceptance database and removes production-like settings. It MUST NOT be renamed or pointed at production. Preserve the existing production `cisme` database and COS objects; perform reviewed forward-compatible migrations with backup and tested recovery.

Official WeChat logistics assistant, shipping-information reporting and logistics-query component are separate capabilities. The query component's `trace_waybill` / `query_trace` / `openWaybillTracking` path should be checked for manual waybills; do not assume the existing `getPath` integration provides universal or free production tracking. Existing unavailable/unknown fallbacks remain honest.

Formal commerce commands, operator authentication, after-sales, durable sync recovery, full privacy execution, full 13-axis review and current native/device validation remain unresolved. A source-level shipping promise or assistant suggestion is not proof of business approval. No main merge, production deployment, payment, renewal, platform submission/release or old-incident repair is claimed by this increment.

## Next execution

Read `NEXT-CODEX-EXECUTION.md` in this directory in full. Continue the existing project and PR22; do not replay these changes if already present. Preserve exact source/CI/deployment/native evidence boundaries.

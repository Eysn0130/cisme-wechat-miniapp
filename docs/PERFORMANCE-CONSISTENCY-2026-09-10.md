# Performance and consistency delivery — 2026-09-10

Status: implementation complete locally; production deployment, migration and Mini Program upload remain gated.

## Delivered behavior

- Database pools have a per-instance maximum, aggregate connection budget, short acquisition/statement/lock/idle-transaction limits, and fail closed when declared instance capacity exceeds the global budget.
- Serializable/deadlock retries use capped exponential jitter inside one total deadline. Pool wait, SQL duration and retry counts use bounded in-memory series; structured HTTP logs redact request headers and never log SQL text or member identifiers.
- `/health/ready` proves only database readiness. `/v1/capabilities` is a cheap public feature projection. Object storage is initialized lazily instead of extending every cold start.
- Home, profile, settings, care, points and submission compound reads use repeatable-read snapshots and return `asOf` plus `businessVersion`; Mini Program pages reject stale-version overwrites.
- Feed, following, care, points and comments use bounded stable tuple cursors. Feed author data is projected once per unique author. Post detail no longer downloads the entire feed, comment likes use one aggregate CTE, and admin review queues are bounded.
- The Mini Program request coordinator isolates cache entries by session, coalesces duplicate reads, applies short domain-specific TTL/SWR windows, invalidates tagged data around mutations, propagates request IDs and retries only idempotent GET network/502/503 failures once.
- Admin queue loading aborts the previous epoch, imposes an 8-second request bound and retrieves four independently authorized queues with `Promise.allSettled`.
- Worker cleanup claims a short database lease, performs COS deletion outside the transaction, and uses compare-and-set completion. Expired leases are reclaimable. Every registered outbox event now has either the publication consumer or an explicit terminal `audit_only` policy; backlog reports age and handler state.
- Four Tab pages remain in the main package; 12 non-first-screen routes are ordinary subpackages. The package gate measures each boundary instead of treating every source file as main-package bytes.

## Direct COS upload boundary

`COS_DIRECT_UPLOAD_ENABLED` defaults to false. When explicitly enabled with `cos_gateway`, the API issues a 10-minute, single-random-object PUT authorization. Signed headers bind MIME, media ID and `x-cos-forbid-overwrite:true`; completion independently downloads/verifies byte count, magic-byte MIME and SHA-256 before switching the current pointer. The existing CloudBase 512 KiB chunk relay remains the rollback path.

Tencent's official guidance confirms both Mini Program `wx.request` PUT upload and server-issued single-object presigning, and recommends the shortest validity plus least-privilege credentials: [Mini Program direct upload](https://cloud.tencent.com/document/product/436/34929), [presigned upload](https://cloud.tencent.com/document/product/436/14114), [Mini Program presigned PUT](https://cloud.tencent.com/document/product/436/36162). COS also documents `x-cos-forbid-overwrite`; it is ineffective when bucket versioning is enabled, so direct upload must stay disabled unless deployment preflight proves versioning is off and the CAM policy requires that header: [PUT Object overwrite protection](https://cloud.tencent.com/document/product/436/7749).

Required external evidence before enabling direct upload:

1. the exact bucket host is registered as a WeChat request domain and works on iOS/Android;
2. COS CORS allows only the owned Mini Program origin/method/required headers;
3. the server signer is a dedicated CAM identity restricted to `cos:PutObject` on the generated `submissions/*` resource scope and requires `cos:x-cos-forbid-overwrite=true`;
4. bucket versioning is disabled, private-read ACL is retained, lifecycle cleanup is configured, and one replay attempt demonstrably fails;
5. interrupted upload, oversize, MIME mismatch, completion race and cleanup recovery pass against the real bucket.

## Verification and capacity

Local gates:

```bash
npm run typecheck
npm run lint:contracts
npm run miniprogram:package-gate
npm run test:all
npm run build
PERF_ALLOW_RESET=true TEST_DATABASE_URL=postgres://.../cisme_test npm run perf:smoke
```

The smoke harness resets only a database whose name matches `cisme_*test*`, uses a configurable bounded concurrency, and fails on p95/error-rate regression. `tests/integration/query-plan.test.ts` protects the stable points cursor plan. It is intentionally not evidence of public-network, CloudBase cold-start, COS or production capacity.

Observed on the local 2026-09-10 run (200 mixed requests, concurrency 10): 0 errors, p50 3.16 ms, p95 9.27 ms, p99 27.83 ms, maximum 29.11 ms and about 2,512 requests/second. These values are a regression checkpoint for this workstation and isolated database only.

Production/staging acceptance must record request p50/p95/p99, error rate, database pool wait p95, pool saturation, SQL p95, transaction retry rate, Worker oldest age, dead-letter count, cold starts and COS completion/cleanup failure rate. Increase service concurrency only while `instance_count × pool_max <= global_connection_budget`; reserve separate connections for migrations, operations and failover.

Dependency audit after the build reports 0 production vulnerabilities with `npm audit --omit=dev`. The full development tree retains 4 high-severity findings inside `miniprogram-simulate@1.6.2` through its private Less 3/PostCSS 7/image-size 0.5 toolchain. npm offers only a breaking downgrade to `miniprogram-simulate@0.0.1`; it was not forced. Keep the simulator limited to trusted repository fixtures and replace or isolate that test harness before a release gate is approved.

## Deployment gate

No production action has been performed. The operator must review the deployment diff, backup/restore evidence, connection headroom and [concurrent index script](deployment/202609100003-indexes-concurrently.sql). Apply its short metadata DDL and each concurrent index individually, validate plans and invalid indexes, and record the migration version only after verification. Roll back the application first; do not drop useful indexes during an incident. Schema rollback of lease/max-byte columns is allowed only after all running versions no longer reference them.

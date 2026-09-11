# Fastify staging lane gate evidence — 2026-09-10

Status: **REMOTE DEPLOYMENT NO-OP / FINAL LOCAL ARTIFACT REBUILD + DIRECT RUNTIME PASS / REMOTE DATA-PLANE ISOLATION PENDING**

> Supersession note: the original full wrapper/migration rehearsal predates the final transactional community-counter migration `202609100004_community_post_stats.sql` and final index changes. Its remote no-op/isolation finding remains valid. Final API, Worker and Tencent artifacts were rebuilt after those changes and their current hashes/direct-runtime checks are recorded below. The production-shaped migration-duration/lock exercise and exact combined CloudBase wrapper rehearsal still require an isolated staging data plane.

This record covers only the Fastify API, scheduled Worker, Admin build artifact, migration rehearsal, and their deployment prerequisites. It does not authorize or describe a production action.

## Safety boundary

- No production database, production service, public route, COS permission, Mini Program upload, WeChat review/release, secret, certificate, or trigger was changed.
- No CloudBase function code was deployed in this run.
- No remote database migration or load test was run.
- The Shanghai target was not touched. `docs/evidence/deployment/tencent-final-migration-2026-09-09.json` records `productionCutover:true`; it is therefore production for this gate even though an older runtime file still says `APP_ENV=staging`.
- COS direct upload remained off. The current local staging-like runtime returned `directMediaUploadEnabled:false`; the stored CloudBase config has no override, so current code would retain its fail-closed default.
- Sensitive configuration was inspected only through key presence, permissions, and non-secret classifications. No value, full environment, credential, request header set, or `x-cloudbase-context` was printed or copied into this evidence.

## Current source and artifact identity

- Git base: `3b9bca10f2f74adc505b7329affdf33b93e0a810`.
- The working tree is intentionally dirty and includes user-owned changes; no reset, checkout, clean, commit, push, merge, or tag was performed.
- The pre-final relevant-source aggregate was `c12cc776a245b9c8cbc64c5e413ca1e4b4daa93976b71a76074d8720dc7de3bf`; it is retained only to identify the earlier rehearsal and is not asserted as the final source hash. Final source is instead bound by the current artifact hashes plus the final test/contract/package evidence below.
- Current CloudBase API entry SHA-256: `24a04e2ed2e506a3d71aeab2c2841bdf2e5a717efe35fc75e8ec81806605cc44`.
- Current CloudBase API bootstrap SHA-256: `6a2d3c9fbdf8e8997bb257268d53c3f9d6d75ae9f704940ee9c77ef15092dd62`.
- Current CloudBase Worker wrapper SHA-256: `2978b24cb2445d4f6134a353c2fc9f0a1ee399370c1640be443d234e622135e2`.
- Current CloudBase Worker business entry SHA-256: `92991aa4ce0da619ca771216224740b00dcfd479f0fb2861fbdf0d5af3df4696`.
- Current Admin artifact: 3 files; HTML SHA-256 `d268c0e1e4224accbd3feeec7ebd065037f3d6be7f90d568f79f39c0c468ef98`, CSS SHA-256 `0fb4d6d46f7c3b23fe30739aa9ca8bb0edd0e205dc1bd07e7e75dd1c09d022a5`, JS SHA-256 `f33306bfb2038c8b70e4a4b01501a202288c24bc0cb936362bbf09abfdcbcf47`.
- `dist/tencent-release/release-manifest.json` was regenerated at `2026-09-10T15:26:54.814Z`, declares Node `>=24.14 <25`, `configurationIncluded:false`, and `deployed:false`; current API/Worker/Worker-once hashes are `24a04e2e…`, `25d2ef87…`, and `92991aa4…` respectively.

These hashes identify the locally verified artifacts only. They are not claims about the code currently active in CloudBase or Shanghai.

## Control-plane and authentication checks

| Check | Result | Evidence / boundary |
| --- | --- | --- |
| CloudBase MCP available in this session | `PENDING` | No CloudBase MCP tool was available. No plugin was installed as a workaround. |
| Standalone `tcb`, `tccli`, or `cloudbase` CLI | `PENDING` | None was installed on PATH or in this workspace. |
| Official WeChat IDE cloud tooling | `PASS` | `wechatide` skill CLI v0.3.9 reported `loginExpired:false`, a present login user, `tokenRequired:false`, and matching skill version. User identity was not recorded. |
| Cloud environment inventory | `PASS, SCOPE LIMITED` | Exactly one environment was returned: `cloud1-d4g0khuk495d48600`. |
| Non-release mapping | `PASS, CONTROL PLANE ONLY` | `apps/miniprogram/release-config.ts` maps this environment only to `devtools`, `preview`, and `trial`; `release` has no Cloud target or public API origin. |
| Function inventory | `PASS` | `cismeApi` and `cismeWorker` are `Active`, runtime `Nodejs24.11`, timeout 60 seconds. Two diagnostic functions also exist. |
| Current plan / quota / paid-resource boundary | `PENDING` | Historical evidence says this is a free development environment, but the available read-only tooling did not provide a current plan/quota readback. Existing active functions prove capability, not current billing terms. |
| Current remote environment variables | `PENDING` | Local 0600 deployment records contain the required key set and `APP_ENV=staging`, but the current cloud-info tool does not read back environment variables. No secret value was queried or exposed. |
| Current Worker trigger state | `PENDING` | Historical evidence conflicts: an earlier timer run succeeded, while the later production-cutover record says the old cloud Worker was paused. Current read-only function info does not expose triggers. |

The sole CloudBase control plane is demonstrably non-release, but that is not enough to establish an isolated staging data plane.

## Database and network gate

The gate is **not closed**:

- The stored CloudBase API and Worker configurations point to a public Supabase DNS endpoint and database name `postgres`.
- Neither hostname nor database name contains a `test`, `staging`, `stage`, or `preview` isolation marker.
- Historical final-migration evidence records that the source contained real member, identity, consent, projection, and audit rows before the production cutover.
- There is no current readback proving that this old source is an independently scrubbed staging copy, remains write-blocked, or is safe for migration/Worker processing.
- No VPC ID, subnet ID, or private staging database endpoint is present in the reviewed deployment evidence.
- For the current CloudBase-function-to-public-Supabase topology, VPC egress is not technically required, but positive staging isolation is still missing. If the target changes to a private PostgreSQL endpoint or CloudRun, real VPC/subnet evidence becomes mandatory; ingress configuration cannot substitute for egress VPC attachment.

Therefore no CloudBase API deployment, Worker deployment/invocation, migration, or pressure test was performed. A code-only update was also withheld because the existing Worker trigger state and remote data-plane identity could not both be proven safe.

## Local isolated migration rehearsal

Two independent disposable-database paths passed against local PostgreSQL 18.4:

1. `tests/integration/migration-lifecycle.test.ts` created a random empty database, applied all migrations, rolled back the latest migration, reapplied it, verified retained schema objects and latest objects, and force-dropped only its own database. Result: 1/1 passed in 602 ms.
2. A separately named isolated database was created only for this gate and run through explicit `up -> verify -> down -> verify -> up -> verify`:
   - first `up`: 26 migration records; latest `202609100003_performance_consistency.sql`;
   - `down`: 25 records; `leased_until` absent; `points_entry_member_page_idx` absent; earlier schema retained;
   - second `up`: 26 records; zero member rows; both lease columns present; all 11 expected current indexes present; zero invalid public indexes; the Outbox outcome constraint includes `audit_only`;
   - after every runtime exited, database connection count was zero;
   - the dedicated database was dropped and absence was verified.

This proves the local empty-database migration lifecycle. It is not evidence for Supabase, CloudBase, Shanghai PostgreSQL 16, production-sized data, concurrent index build duration, or production lock/write impact.

## Current API artifact rehearsal

The exact current `dist/cloudbase-api` package was mounted read-only into an explicitly `linux/amd64` Node 24.14.0 container. The container recreated the CloudBase `/var/lang/node24/bin/node` launcher path and executed the packaged `scf_bootstrap`, which decompressed and hash-verified the pinned Node binary before starting Fastify.

- Bootstrap forced port 9000 as intended; host port 39018 was only a local loopback mapping.
- `RUN_BACKGROUND_WORKER=false`.
- `APP_ENV=staging`, development adapters off, database pool max 4, declared instance count 1, global connection budget 8.
- `/health/live`: 200 `{status:"ok"}`.
- `/health/ready`: 200 `{status:"ready"}` against the isolated database.
- `/v1/capabilities`: 200 and all gated business switches remained false, including direct media upload.
- unauthenticated `/v1/me`: ordinary transport 401 `AUTH_REQUIRED`; cloud transport returned the designed HTTP-200 error envelope with embedded business status 401.
- SIGINT closed Fastify and the pool; zero remaining database connections were observed.
- Container start to `Server listening` was 11,078 ms under x86 emulation on an ARM Mac. This is only an artifact decompression/startup regression observation, **not** a CloudBase cold-start result or an SLO measurement.

Observed structured request logs contained the standard allowlisted request facts and the explicit application fields; they did not contain request headers, environment objects, member identifiers, or SQL text.

After migration 004 and the final service changes, the current `24a04e2e…` API entry was rebuilt and mounted read-only into Linux/arm64 Node 24.14 with one CPU, 512 MiB, background Worker disabled, and the isolated `cisme_*test*` database. The direct packaged entry returned live 200, ready 200, capabilities 200 with direct media upload false, and unauthenticated `/v1/me` 401; it was not OOM-killed. The `scf_bootstrap` hash is unchanged from the earlier exact linux/amd64 wrapper pass, but the final combined x64 bootstrap/package was not rerun and remains part of isolated staging.

## Current Worker artifact rehearsal

- Targeted unit tests verified rejection of missing/malformed/spoofed credentials, acceptance of the configured manual/timer credential, removal of child `NODE_OPTIONS`, non-overlapping ticks, post-failure continuation, and connection release.
- Running the current business entry with Node 24.14.0 against an isolated empty database and local S3-compatible storage returned `{published:0,cleaned:0}`.
- Running the exact CloudBase wrapper/package in an explicitly `linux/amd64` container returned `{completed:true,summary:{published:0,cleaned:0}}`.
- The Worker database had zero remaining connections and was deleted after the check.

The final Worker business entry and CloudBase wrapper hashes remained byte-identical (`92991aa4…` and `2978b24c…`). A final read-only-artifact/direct Node 24 Linux/arm64 check, with only `/tmp` writable, processed three supported events in the isolated Rust PoC test database and left pending 0 / DLQ 0. This did not access COS or any remote environment.

### Architecture-specific false start and resolution

The packaged Worker initially failed in the default ARM container before business code because its intentionally pinned CloudBase runtime is Linux x64. Repeating an ARM-rootfs run reproduced exit 255; direct execution identified the missing x86_64 dynamic loader. Incremental retries stopped. The complete impact is limited to simulating an x64 CloudBase package inside an ARM root filesystem; the source, direct Worker path, and CloudBase x64 design are unaffected. The holistic correction was to use an explicit `linux/amd64` container, after which the exact wrapper passed without a code change.

## Build, contract, and sensitive-data checks

| Check | Result |
| --- | --- |
| TypeScript, including Mini Program project | pass on final source |
| Final unit / integration suites | pass: 225/225 across 31 files; 79/79 across 16 files |
| Contract cross-check | pass: 27 migrations, 39 tables, 45 paths, 15 events |
| Targeted API/config/DB/Worker unit tests | pass: 31/31 across 7 files |
| API + Worker + Admin production build | pass |
| CloudBase API package | pass: 6,430 expanded files |
| CloudBase Worker package | pass: 6,429 expanded files |
| Tencent API/Worker release package | pass on final source; manifest says configuration excluded and not deployed |
| Actual stored credential-value scan | pass: 30 sensitive values checked across current API/Worker/Admin/Tencent artifacts, zero matches |
| Previous rollback package credential-value scan | pass: zero matches |
| Forbidden runtime echo scan | pass: no `x-cloudbase-context`, full-header response, or `process.env` serialization pattern in API/Worker/CloudBase source or built entries |

The scan records only counts and result; it does not record values.

## Rollback readiness

The last known CloudBase deployment package is retained locally under `tmp/member-performance-deploy/` and differs from the current build:

- previous API entry SHA-256: `296b938780be075b0f002e5cbbba79beb0c689e8e22bcdc7f370e41cb8cbcfae`;
- previous API bootstrap SHA-256: `6a2d3c9fbdf8e8997bb257268d53c3f9d6d75ae9f704940ee9c77ef15092dd62`;
- previous Worker wrapper SHA-256: `2978b24cb2445d4f6134a353c2fc9f0a1ee399370c1640be443d234e622135e2`;
- previous Worker business entry SHA-256: `04c3eff83eb0fce48039f664daa39dcb5c59ad0f4d6d230955441c8ce214d8ed`;
- historical deploy log records API 6,421 files / 35.1 MB and Worker 6,420 files / 35.0 MB with successful uploads.

This is a code-package rollback candidate, not a complete remote rollback proof. Current cloud environment-variable revisions, trigger configuration, traffic behavior, and rollback redeployment have not been read back or exercised. Because this run made no remote mutation, no rollback was needed.

## Admin staging status

The Admin production build is valid and credential-free, but deployment is `PENDING`:

- no existing, positively identified non-production Admin hosting target was found;
- no current CloudBase static-hosting plan/quota, ACL, rendering headers, access policy, route, or previous version was available for readback;
- the API does not serve `dist/admin`;
- deploying it to the Shanghai host would touch the production-cutover target and is prohibited.

No static hosting, gateway, domain, certificate, or access-control change was attempted.

## Exact pending gates before a remote staging run

1. `PENDING-STG-DB-01`: identify an existing isolated non-production PostgreSQL database, with proof that it contains no production users/data and is approved for migration, Worker processing, fixtures, and load.
2. `PENDING-STG-NET-02`: if that database is private, provide/verify the real VPC ID, subnet ID, private endpoint, routing, TLS chain, and connection budget. Do not invent identifiers.
3. `PENDING-CB-CONFIG-03`: read back current API/Worker environment key presence and safe non-secret flags, especially the isolated database identity, pool/instance budget, `RUN_BACKGROUND_WORKER=false`, `COS_DIRECT_UPLOAD_ENABLED=false`, and `CISME_WORKER_PAUSED=true` during rollout.
4. `PENDING-CB-TRIGGER-04`: prove the current Worker trigger is paused before code deployment, then identify the exact timer/config to restore only after an isolated manual cycle succeeds.
5. `PENDING-CB-PLAN-05`: verify current plan/quota and that API/Worker deployment plus intended staging execution will not create a new paid resource or obvious new cost.
6. `PENDING-ADMIN-TARGET-06`: identify an existing non-production Admin host, access policy, cache/rendering headers, versioned rollback artifact, and API origin.
7. `PENDING-REMOTE-OBS-07`: after the above, record the current artifact hash, remote live/ready/capabilities/auth checks, pool wait/SQL metrics, Worker backlog/DLQ, cold/warm behavior, and rollback drill without exposing runtime secrets.

Until all applicable items are proven, the honest remote result is **NO-OP / PENDING**, not deployment success.

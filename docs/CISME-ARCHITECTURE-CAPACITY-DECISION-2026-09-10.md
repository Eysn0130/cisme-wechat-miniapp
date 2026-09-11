# CISME Architecture & Capacity Decision Record — 2026-09-10

Decision: **KEEP FASTIFY**

Release status: Fastify remains the production candidate. Local correctness, synthetic capacity, failure and packaging work is substantially complete. Remote staging, production-like network/cold-start, physical-device UX, real COS, horizontal scaling and final production capacity are **PENDING / UNVERIFIED**. Deployment Gate is not closed.

## 1. Executive outcome

The first 100k-fixture run found a database query-shape defect, not a Node.js runtime limit: every popular-post read scanned about 26.6k reactions and 20k comments. At only 50 mixed in-flight requests, SQL P95 reached 249–293 ms and request P95 reached 515–628 ms.

Migration `202609100004_community_post_stats.sql` replaces those scans with exact PostgreSQL-authoritative counters updated in the same transaction as reactions, comment publication/deletion and member active-status changes. It does not add Redis or make cache authoritative. The aggregate plan fell to 0.028 ms in the warm local plan and the final full-mix 100k matrix met every declared server SLO in all three 50-concurrency rounds.

After that correction, the first repeatable limit is pool wait: 100 concurrency passed two rounds but missed the 50 ms pool-wait SLO in one; 200 and above missed it consistently while individual SQL P95 remained below 16 ms. This is evidence to control concurrency and connection topology, not evidence to rewrite the service.

The Rust PoC passed the implemented parity gates and, after replacing the initial asymmetric developer smoke with a same-container-class comparison, produced a real positive signal on its two narrow paths. At concurrency 50, Rust had lower median P95/P99, CPU/request and peak RSS for both the DB-free capabilities route and authenticated settings bootstrap. This is decision-grade for those implemented paths only—not for migrating CISME: Feed, comments, writes, Worker, media, broad high-concurrency behavior, soak and deployment rollback still lack parity. The current system already meets its local SLO and its first limit is the shared database pool, so operating a second stack for one non-bottleneck bootstrap is not justified. Neither HYBRID nor MIGRATE is eligible now.

## 2. Evidence scope and language

Capacity terms are not interchangeable:

| Term | What this run establishes |
| --- | --- |
| Registered users | Parameterized fixtures of 100, 1k, 10k and 100k; final matrix uses 100k |
| MAU / DAU | **UNVERIFIED**; no analytics or production-user assumption was fabricated |
| Concurrent online sessions | **UNVERIFIED**; tokens are synthetic and session dwell time was not modeled |
| Concurrent in-flight requests | Directly tested at 50, 100, 200, 500 and 1000 |
| Requests/second | Closed-loop local throughput observed during those tests; not an Internet arrival-rate guarantee |
| Hotspot concurrency | Final full mix directs 12.5% of calls to one 20k-comment post and 8.3% to transactional reaction writes on that post |

The final 24-request full-mix cycle is: 2 capabilities, 6 Home bootstrap, 4 Feed, 3 same-post comments, 2 Profile bootstrap, 1 Settings bootstrap, 2 Points, 2 Care, and 2 reaction mutations. Reads and writes retain normal auth, snapshot, timeout and database behavior.

All capacity evidence is local loopback against isolated PostgreSQL 18.4 on an unconstrained workstation. It is useful for finding software bottlenecks and regression boundaries; it is not CloudBase, Shanghai, real-network, device or production certification.

## 3. Server SLO and final matrix

Declared first-release server SLO: request P95 <= 400 ms; P99 <= 800 ms; pool wait P95 <= 50 ms; SQL P95 <= 50 ms; timeout <= 0.1%; 5xx <= 0.5%. Bootstrap DB phase <= 150 ms and authoritative write state readable within two seconds remain functional/staging gates; the local harness records route/SQL/pool timing but not a separate bootstrap-phase histogram.

Final 100k full-mix results (range across three measured rounds):

| In-flight | Request P95 | P99 | Throughput | Pool wait P95 | SQL P95 | Errors | Strict SLO |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 50 | 57.58–104.09 ms | 71.02–156.89 ms | 925–1,646 rps | 17.68–41.75 ms | 6.41–14.63 ms | 0 | **3/3 pass** |
| 100 | 117.01–146.78 ms | 132.25–182.27 ms | 1,378–1,764 rps | 38.81–59.35 ms | 6.76–9.94 ms | 0 | 2/3 pass; pool unstable |
| 200 | 222.85–240.82 ms | 251.47–303.53 ms | 1,601–1,867 rps | 80.77–117.67 ms | 6.76–9.62 ms | 0 | fail: pool wait |
| 500 | 632.64–782.44 ms | 656.87–872.85 ms | 1,331–1,785 rps | 230.54–342.30 ms | 7.46–13.70 ms | 0 | fail: pool and tails |
| 1000 | 1,269.94–1,379.81 ms | 1,351.20–1,673.16 ms | 1,457–1,593 rps | 582.15–694.35 ms | 6.67–15.80 ms | 0 | fail: pool and tails |

Startup to local listener was 114.92 ms; the first mixed request was 16.15 ms and the next 1.79 ms. These are process/loopback observations, not CloudBase cold-start numbers.

Response payloads remained within the declared size budgets in measured routes: bootstrap payloads were far below 50 KiB and Feed first page was about 8.2 KiB; the largest measured community response was about 21.5 KiB, below the 200 KiB Feed budget.

The two 60-second final full-mix soak rounds completed 98,155 and 100,944 requests (199,099 total) with zero errors. P95 was 66.68/65.34 ms, P99 110.70/104.22 ms, throughput 1,635/1,682 rps, pool-wait P95 20.45/27.53 ms and SQL P95 10.12/10.20 ms; both rounds met SLO. RSS rose from 121.8 MB to 353.6 MB during the first large sample allocation, then fell by 8.2 MB across the second round rather than growing progressively. This rejects a two-round progressive-leak signal but is not a long production soak or GC proof.

### Three required capacity answers

1. **Observed maximum capacity:** 1000 in-flight local requests, 4000 requests per round, three rounds, zero transport/HTTP errors. This is successful completion capacity, not acceptable latency capacity.
2. **SLO capacity:** 50 in-flight requests for the final full mix on one Fastify process with a 20-connection pool. It is the highest tested level for which every repeat met every SLO. 100 is not accepted because one of three rounds exceeded pool-wait P95.
3. **Recommended safe production capacity:** final production certification is **UNVERIFIED** until isolated production-like staging exists. The provisional launch/admission-control ceiling is **35 in-flight per equivalent instance** (70% of the measured local SLO concurrency), with no claim that multiple instances add linearly. Raise it only from remote SLO/backlog evidence. This 30% margin covers ordinary variance, not a database or zone failure.

The current database connection budget permits at most `floor(40 / 20) = 2` such pool-20 instances and leaves no connections inside that declared application budget for a third. Migrations, operations and failover also need separate database headroom. A two-instance capacity number is **UNVERIFIED** because shared-PostgreSQL horizontal load was not run; do not publish 70 in-flight or twice the RPS as a guarantee.

## 4. Bottleneck and scale path

Before migration 004, the bottleneck was repeated exact hotspot aggregation in PostgreSQL. After it, ordinary SQL remains fast and the first limit is waiting for the bounded pool; event-loop utilization is material but did not become the proven first failure. At 1000, pool wait dominates the tail while SQL P95 remains low.

Scale in this order:

1. keep route deadlines, pool acquisition timeout and provisional admission control;
2. validate min-one-instance Fastify plus the real PostgreSQL connection/CPU budget in isolated staging;
3. tune per-instance pool and maximum instances together; never allow `instances * pool > global budget`;
4. scale PostgreSQL CPU/I/O or connection capacity when remote pool/SQL evidence shows it, not from registered-user count;
5. use dedicated Worker concurrency/budget so API requests cannot lose all connections;
6. use COS/CDN/thumbnail delivery for media after its separate security gate;
7. evaluate shared cache only if repeated public reads again dominate database work across instances.

Redis is rejected for this release. The observed hotspot was eliminated with an O(1), transactionally exact database projection. L1 Mini Program SWR already handles safe presentation data; permissions, points, consent, review and care remain PostgreSQL-authoritative.

PgBouncer is also deferred. It becomes relevant only when the validated instance count approaches the database connection budget. Before transaction pooling, validate node-postgres/SQLx prepared statements, explicit transactions, `SET`/`SET LOCAL`, session state, migrations, temporary tables and LISTEN/NOTIFY. It is not a free capacity multiplier.

## 5. Failure behavior

The system now has bounded pools, acquisition/statement/lock/idle-transaction timeouts, route deadlines, capped transactional retry with jitter, GET-only one-shot network/502/503 retry, idempotent writes, CAS/version checks, Worker `SKIP LOCKED`, short cleanup leases and dead-letter/redrive controls.

Evidence:

- deliberately holding the complete pool produced 200/200 bounded HTTP 503 `DATABASE_SATURATED` responses at about 0.26 seconds; after release, 200/200 recovery requests succeeded;
- the final 50 -> 1000 -> 50 spike has zero retry storm or persistent error condition; overload misses latency/pool SLO and recovery is evaluated separately in the raw artifact;
- transaction retries are capped by attempts and total deadline; non-retryable pool timeout does not enter the transaction retry loop;
- PostgreSQL `57014` maps to bounded 504, pool acquisition/`53300` to 503, and `55P03` to 409;
- Worker failures are isolated by savepoints, use exponential backoff, dead-letter at the attempt cap, support audited/idempotent redrive, and reclaim expired media leases after crash.

Under ordinary overload the expected sequence is controlled latency growth, then 503/504 at bounded deadlines, then recovery after pressure clears. 429 is not yet a general route behavior; expensive-endpoint rate protection should be added only with real abuse/load evidence. No evidence supports claiming protection from regional database or COS failure; those remain staging exercises.

## 6. PostgreSQL consistency and query plans

The critical state remains authoritative in PostgreSQL. Compound points/care/submission/profile/settings reads use a single SQL or read-only repeatable-read snapshot and emit `asOf` plus business/snapshot version. Writes keep database authorization, transaction, idempotency, optimistic version/CAS and Outbox behavior. Client request/session epochs prevent older results from replacing newer state.

Community aggregates now have the same property: source interaction and counter change commit together; `aggregateVersion` is monotonic. Migration backfill takes a `SHARE ROW EXCLUSIVE` lock on member/reaction/comment tables so no write can land between backfill and trigger installation. Reads continue; community/member-status writes wait. Counter underflow raises a constraint error instead of being clamped or hidden.

After the final 199,099-request soak, direct reconciliation remained exact: stats/source were 19,875/19,875 likes, 6,667/6,667 saves and 20,000/20,000 published active-member comments.

At 100k fixture size:

- pre-fix reaction and comment count plans took 39.906 ms and 18.377 ms warm and touched 1,281 and 1,457 shared buffers;
- the post-fix aggregate PK lookup took 0.028 ms and two shared buffers;
- first 51 comments used the stable post cursor index and took 0.232 ms;
- first 21 Feed items used the partial visible-page index and took 0.737 ms.

The populated integration plan suite now checks points, care, eligibility, consent, Feed, comments, comment likes, review actions, community stats, Outbox and media-cleanup shapes with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. Two unused indexes were removed rather than paying write amplification: the old post/kind reaction index after counters, and a review-case queue index that matched no live query. Queue index key order now follows scheduling order and carries filter-only fields with `INCLUDE`.

Full evidence: `docs/evidence/performance/QUERY-PLAN-CAPACITY-EVIDENCE-2026-09-10.md`. Production cold-buffer reads, disk I/O, row estimates, build duration, invalid concurrent indexes, lock time and write amplification remain **UNVERIFIED**.

## 7. Worker capacity and recovery

The isolated Worker capacity harness seeds 10,000 supported `audit_only` Outbox events, uses the real claim/finalize transaction and batch size 50, and asserts zero pending/DLQ after every run.

| Concurrent batch loops | Throughput across 3 rounds | CPU/event | End state |
| ---: | ---: | ---: | --- |
| 1 | 1,661–1,684 events/s | 0.06–0.08 ms | 10k processed; pending 0; DLQ 0 |
| 2 | 2,714–2,860 events/s | 0.06 ms | same |
| 4 | 3,270–3,698 events/s | 0.06–0.07 ms | same |
| 8 | 4,459–4,726 events/s | 0.07 ms | same |

The operational recommendation is a maximum of four concurrent batch loops until remote database contention is measured; eight improves audit-only throughput but uses more peak memory and connection concurrency. One loop alone can drain roughly 99k cheap events inside 60 seconds in this local test.

This is not a universal Worker safe rate. Publication events execute additional consistency SQL, media cleanup depends on COS latency, and the current harness does not time process-kill recovery. Therefore production Worker throughput and supported oldest-age at a real event mix are **UNVERIFIED**. Functional integration tests do prove crash-lease reclaim, retry, DLQ, redrive, consent suppression, publication idempotency and batch failure isolation.

## 8. Mini Program user-perceived performance

All 16 declared routes were audited. The current package gate passes: 4 main-package Tab pages, 12 ordinary subpackages, total 1,588,808 bytes, main 1,327,578 bytes, largest subpackage 66,031 bytes and no asset above the internal 200 KiB cap.

Delivered improvements include real stale-while-revalidate behavior, coalesced reads, session-isolated keys, mutation-tag invalidation, one bounded GET retry for WeChat/network/502/503 only, cancelable direct requests, Profile parallel fetch, Community single-pass columns/lazy images, and token/attempt guards against late responses.

The required “representative mid-range device + real 4G, core-content P95 <= 2.5 s” remains **UNVERIFIED**. No server benchmark substitutes for DNS/TLS, CloudBase cold start, image decode, rendering, bridge cost or device behavior. The exact current source also has no matching DevTools/physical-device evidence, so visual/Deployment Gate remains blocked.

Known product-performance gaps:

- Records, Community/Following, Points and Post comments expose server cursors but do not consume subsequent pages;
- pages prevent stale UI writes but do not yet share a subscriber-aware coordinator abort, so some hidden-page reads continue until completion/12-second timeout;
- low-end-device evidence is needed before changing Submit/Settings `setData`/storage behavior;
- Product non-current images and public-asset placement need device/package evidence, not guesswork.

Detailed route-by-route record: `docs/MINIPROGRAM-UX-PERFORMANCE-AUDIT-2026-09-10.md`.

## 9. Rust / Fastify decision

The isolated Rust lane uses stable Rust 1.98.1, Axum 0.8.9, Tokio 1.53.1, SQLx 0.9.0, tracing 0.1.44 and tower-http 0.7.1. Direct dependencies are MIT or MIT/Apache-2.0 and the lockfile pins the transitive graph. Formatting, Clippy with warnings denied, 3/3 unit tests, 1/1 isolated-DB integration, semantic parity, Docker build and image health checks passed.

Implemented parity is deliberately narrow: `/v1/capabilities` and authenticated `/v1/bootstrap/settings` with compatible HMAC session, existing SQL projection, `REPEATABLE READ READ ONLY`, transaction timestamp, pool budget and timeouts. Feed, comments, reactions, writes, Worker, media, admin, metrics and deployment are **UNVERIFIED** in Rust.

The final narrow comparison ran each candidate one at a time as Linux/arm64 containers through the same host-port/bridge path, against the same isolated database and immutable identity. Both had 1 CPU, 512 MiB, pool 10, identical timeouts/auth/SQL/contracts, 200 warm-ups, concurrency 50, five alternating rounds, and 1,000 measured calls per route/candidate/round. All 20,000 measured requests were 2xx and semantic parity passed. Median-of-five results:

| Route / runtime | P50 | P90 | P95 | P99 | Max | Throughput | CPU/request | Process peak RSS | Container memory peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| capabilities / Fastify | 4.75 ms | 8.32 ms | 9.55 ms | 14.36 ms | 21.11 ms | 9,450 rps | 0.11 ms | 96.69 MiB | 55.05 MiB |
| capabilities / Rust | 3.61 ms | 5.54 ms | 6.31 ms | 7.08 ms | 9.51 ms | 13,538 rps | 0.03 ms | 7.48 MiB | 5.56 MiB |
| settings / Fastify | 20.08 ms | 29.45 ms | 31.01 ms | 35.00 ms | 39.95 ms | 2,332 rps | 0.34 ms | 107.02 MiB | 65.86 MiB |
| settings / Rust | 8.63 ms | 11.36 ms | 12.05 ms | 13.64 ms | 15.39 ms | 5,597 rps | 0.11 ms | 9.07 MiB | 7.12 MiB |

Median container-ready time was 333.42 ms for Fastify and 209.71 ms for Rust; median first post-readiness capabilities request was 2.79/2.53 ms. These are local container lifecycle observations, not CloudBase cold starts. Server CPU came from cgroup `cpu.stat`; process peak RSS is PID 1 `VmHWM`; container memory peak is cgroup `memory.peak`. RSS includes shared file-backed resident pages and can exceed memory charged to an individual cgroup, so capacity/cost sizing should use both rather than subtracting one from the other.

This replaces the earlier non-symmetric macOS-versus-Docker smoke for performance judgment. The result proves a material Rust advantage for the implemented narrow surface, but not an end-to-end benefit: only 2 of 45 API paths exist, the fixture is small, and Feed, comments/reactions, writes, Worker, media, operational metrics, 100–1000-concurrency comparison, long soak, staging topology and rollback are absent. The full Fastify mix also shows pool wait—not the Node event loop—as the first accepted-capacity limit. A one-route hybrid would add two auth/contract/deploy/observability stacks without removing that shared bottleneck.

Therefore the decision remains **KEEP FASTIFY**. Rust becomes a justified follow-on candidate for a bounded Worker or measured CPU-heavy path, but HYBRID requires broad parity plus independent deployment/rollback and a full-mix win. MIGRATE TO RUST requires broad real-workload and operational superiority and is ineligible from this PoC.

Evidence: `experiments/rust-poc/README.md`, `experiments/rust-poc/FAIRNESS.md`, `experiments/rust-poc/evidence/symmetric-container-2026-09-10.json`, and the remaining `experiments/rust-poc/evidence/` records.

## 10. Runtime topology and cost decision

| Candidate | Decision | Evidence and caveat |
| --- | --- | --- |
| A. scale-to-zero CloudBase/Run | Reject for core user API | Tencent documents that low-cost min=0 may add up to 30 seconds on cold start, incompatible with a 2.5-second core-content goal absent contrary measurement |
| B. CloudBase Run, min >= 1, autoscaling | Preferred isolated-staging topology for Fastify | Avoids scale-to-zero for “open immediately”; max/min instances and CPU-only autoscaling must be measured and connection-capped |
| C. Shanghai resident Core API + thin CloudBase ingress | Keep as production topology candidate, not touched | Could avoid function cold start but adds an ingress hop and operational surface; current Shanghai target is production-marked and no authorized benchmark was run |
| D. Rust Core API on CloudBase Run | Reject now | Positive signal exists on two narrow routes, but broad parity, production-topology and rollback evidence do not; migration cost still exceeds the proven benefit |

Tencent's current docs state that low-cost mode can scale to zero and may incur a 30-second cold start; high-availability mode keeps 1–50 minimum replicas and incurs continuous resource cost; autoscaling is CPU-based. They also warn that background async work can be terminated by scale-down, so a continuously consuming Worker cannot be assumed to share the API's scale-to-zero lifecycle. Sources: [version/autoscaling configuration](https://cloud.tencent.com/document/product/1243/49177/), [deployment and cold start](https://cloud.tencent.com/document/product/1243/46127/), [service/background-task guidance](https://cloud.tencent.com/document/product/1243/53551), and [CloudBase Run overview](https://cloud.tencent.com/document/product/876/121989).

Exact monthly baseline/burst RMB is **UNVERIFIED** because the current plan/quota and intended CPU/memory/min/max configuration could not be safely read back. Official billing is resource/time based; no new paid resource was created. Cost per million requests, required instance count, production RSS, image pull/start time and database connection cost remain remote-measurement items.

## 11. Staging and Deployment Gate

Remote staging is a deliberate **NO-OP / PENDING**, not a failed deploy. Only one CloudBase environment exists. Its control-plane mapping is devtools/preview/trial, but its stored database target is a generic Supabase `postgres` database with historical evidence of real members and prior production-source use. No current readback proves an isolated data plane, Worker trigger state, VPC/subnet/private DB, plan/quota, or non-production Admin host. The Shanghai target is production-marked and was not touched.

Final local API/Worker/Tencent artifacts were rebuilt with configuration excluded and `deployed:false`. The current packaged API entry passed Linux/arm64 live/readiness/capabilities/auth checks against an isolated test database; the byte-identical Worker entry passed again and left pending/DLQ at zero. The earlier exact linux/amd64 CloudBase-wrapper and full migration rehearsals predate migration 004; the wrapper hashes are unchanged and final-source migration integration tests still pass. Production-shaped migration duration/locks and the exact combined final wrapper remain staging gates after a safe database is identified.

Required staging order:

1. positively identify an isolated non-production PostgreSQL target with no production users/data and a declared connection budget;
2. prove VPC/subnet/TLS/routing where private access applies, current CloudBase config key presence, Worker trigger paused state, and plan/cost boundary;
3. rebuild final API/Worker/Admin artifacts and record hashes without embedding secrets;
4. apply all migrations to staging; for 003 use query-plan/index validation, and for 004 measure the write-lock/backfill duration and reconcile source counts to stats;
5. deploy API at zero/non-public traffic, validate live/ready/capabilities/auth/transport/timeouts/log whitelist, then run a manual isolated Worker cycle;
6. execute final full-mix matrix, spike, pool saturation, publication/media Worker mix and soak under production-like quotas/network;
7. exercise code and migration rollback, then reapply; record cold/warm, pool/SQL, backlog oldest age, DLQ and artifact identity;
8. deploy Admin only to a proven non-production host/access policy.

Exact remote blockers are recorded in `docs/evidence/deployment/FASTIFY-STAGING-GATE-2026-09-10.md`.

## 12. Production migration, rollback and monitoring proposal

No production authorization exists. If later authorized after staging:

1. freeze the exact source/artifact and confirm backup plus restore evidence;
2. pause Worker triggers and verify connection headroom;
3. apply migration 003 metadata DDL and each index from `docs/deployment/202609100003-indexes-concurrently.sql` individually, checking progress, invalid indexes and live plans;
4. apply migration 004 before the new API. It creates stats/functions/triggers, briefly blocks community/member-status writes for an exact backfill, and leaves reads available. Expected lock duration/downtime is **UNVERIFIED** until staging-sized rehearsal;
5. reconcile counts, constraints and versions, deploy Fastify with zero traffic, smoke it, then shift traffic gradually while watching SLO/error/backlog;
6. resume Worker only after manual consumption and oldest-age/DLQ checks;
7. keep COS direct upload off and do not upload/release the Mini Program under this authorization.

Rollback: stop traffic to the new app first and restore the previous Fastify artifact. The old app can ignore the additive stats table and continues scanning source interactions. Only after no new app uses stats may migration 004 be rolled back; the table is derived, but source interaction rows must never be deleted. During an incident, do not drop useful 003 indexes merely to mirror schema history. Roll back 003 columns/indexes only after all running versions are compatible and lock impact is reviewed.

Monitor/alert at minimum: route P50/P95/P99 and bytes; cold start; pool total/idle/waiting and wait P95; SQL P95/P99; transaction retries; 503/504/429/5xx; Worker throughput, pending, oldest age >60 s and DLQ >0; cleanup lease age; database connections/CPU/I/O/locks; aggregate counter reconciliation; external I/O; and sampled/log-volume budget. Logs remain field-allowlisted and must exclude phone, address, OpenID, tokens, secrets, content bodies, image data, complete headers and SQL text.

## 13. Final truth matrix

| Gate | Result |
| --- | --- |
| Unit tests | **PASS: 225/225 across 31 files** on the final source |
| Integration tests | **PASS: 79/79 across 16 files** on the final source, including migration 004 lifecycle, aggregate reconciliation and populated query plans |
| Typecheck / contracts / package / build / diff hygiene | **PASS**; contracts report 27 migrations, 39 tables, 45 paths and 15 events; Mini Program package gate passes; `git diff --check` passes |
| Production dependency audit | **PASS: 0 vulnerabilities** from `npm audit --omit=dev`; license inventory has 624 rows and one `UNKNOWN` metadata entry (`string.fromcodepoint@0.2.1`) requiring manual review before production |
| Migration empty up/down/up | passes locally including migration 004; remote/staging-size pending |
| Query shapes | populated local suite passes; production cold I/O/build impact pending |
| 100k 50/100/200/500/1000 matrix | measured locally; strict SLO capacity 50 |
| Spike / pool saturation / recovery | measured locally; overload bounded and every final 50-concurrency recovery round passed |
| Soak | **PASS locally:** two 60-second full-mix rounds, 199,099 requests total, zero errors, both within SLO; not a production-duration proof |
| Worker functional recovery | passes locally |
| Worker audit-only throughput | measured locally; publication/COS production rate unverified |
| Rust/Fastify implemented-scope parity and symmetric comparison | **PASS for capabilities + settings at concurrency 50:** 20,000/20,000 2xx; positive Rust signal, but broad migration evidence remains incomplete |
| Mini Program structural/package QA | **PASS** on final source; 16 routes and package budgets checked |
| Mini Program visual/device Deployment Gate | **BLOCKED:** final-source DevTools and physical-device evidence is absent; `releaseReady=false` |
| Midrange iOS/Android + real 4G P95 | **UNVERIFIED** |
| CloudBase/Shanghai cold/warm and scale-out | **UNVERIFIED** |
| Isolated remote staging deploy/migration | **PENDING: no proven staging data plane** |
| Real COS CORS/CAM/replay/direct upload | **PENDING; flag remains off** |
| Horizontal two-instance capacity | **UNVERIFIED** |
| Exact monthly/cost-per-million comparison | **UNVERIFIED** |
| Production Deployment Gate | **BLOCKED / no authorization requested or implied** |

Primary raw artifacts:

- `docs/evidence/performance/capacity-fixture-100000-mixed-post-stats-matrix-2026-09-10.json`
- `docs/evidence/performance/capacity-fixture-100000-mixed-post-stats-spike-2026-09-10.json`
- `docs/evidence/performance/capacity-fixture-100000-mixed-post-stats-soak-2026-09-10.json`
- `docs/evidence/performance/capacity-harness-pool-smoke-2026-09-10.json`
- `docs/evidence/performance/worker-capacity-audit-only-10000-2026-09-10.json`
- `docs/evidence/performance/QUERY-PLAN-CAPACITY-EVIDENCE-2026-09-10.md`
- `experiments/rust-poc/evidence/symmetric-container-2026-09-10.json`

Diagnostic/pre-fix artifacts are named explicitly with `diagnostic`, `pre-analyze`, `pre-delete-fix`, `pre-stats`, or `pre-full-mix` and must not replace the final artifacts above in a release decision.

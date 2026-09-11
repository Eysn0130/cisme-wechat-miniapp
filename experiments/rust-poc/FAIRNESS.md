# Rust PoC parity and benchmark decision rules

Status: criteria frozen before implementation on 2026-09-10. This experiment is not a production migration.

## Scope and safety gate

- The candidate implements only `GET /health/live`, `GET /health/ready`, `GET /v1/capabilities`, and authenticated `GET /v1/bootstrap/settings`.
- It may connect only to a database whose decoded name starts with `cisme_` and contains `test` as a full underscore-delimited segment. The intended database is `cisme_rust_poc_test`.
- It must never run migrations, reset schemas, write application rows, access object storage, or receive production traffic.
- Fastify source, deployment configuration, production data, and the Mini Program remain unchanged.

## Contract parity gate

The Rust candidate passes this gate only when automated tests show all of the following:

1. `/v1/capabilities` has the same status, JSON types, and field values as Fastify under the same feature environment. Key order is irrelevant.
2. A Fastify-compatible HMAC-SHA256 session token is accepted. Missing, malformed, tampered, and expired tokens return the same HTTP status and problem `code` as Fastify.
3. `/v1/bootstrap/settings` uses the existing SQL projection and returns the same semantic JSON as Fastify for the same member fixture. Volatile `asOf` timestamps may differ but must be valid transaction timestamps; `trace_id` may differ.
4. The bootstrap is executed inside one PostgreSQL `REPEATABLE READ READ ONLY` transaction and reports `asOf` from `transaction_timestamp()`.
5. Pool maximum, aggregate connection budget, acquire timeout, statement timeout, lock timeout, idle-in-transaction timeout, and route timeout use the same environment variables and defaults as Fastify. Invalid connection math fails at startup.

Any mismatch is a failed parity gate, not a benchmark caveat.

## Fair benchmark gate

Performance numbers are decision-grade only when both servers are measured:

- on the same host and architecture, through loopback TCP rather than Fastify injection;
- against the same isolated database and immutable fixture, with the same SQL, auth token, response contract, feature flags, pool maximum, and timeouts;
- one candidate at a time, with no other experiment load, identical warm-up and sample counts, and alternating candidate order across at least five measured rounds;
- separately for the DB-free capabilities route and the DB-backed settings bootstrap;
- at the same declared concurrency, recording completed requests, non-2xx responses, p50/p95/p99/max latency, elapsed time, and throughput as raw JSON per round;
- with CPU and peak RSS gathered by the same operating-system mechanism for both candidates before making any resource-efficiency claim.

The legacy harness defaults are a developer smoke test, not capacity proof. `scripts/symmetric-comparison.mjs` satisfies the same-runtime/resource/measurement gate for the two implemented routes at concurrency 50 and records cgroup CPU and memory. A migration recommendation additionally requires repeatable measurements at concurrency 100, 200, 500, and 1000 where safe, pool-saturation and recovery evidence, error-budget thresholds set before the run, representative datasets, a soak period, and production-topology/cold-start validation. Unmeasured broad-route concurrency, cost, and user capacity remain `UNVERIFIED`.

## Decision rule

- **KEEP FASTIFY** unless the full parity gate passes and repeated decision-grade evidence shows a material operational benefit after migration cost and failure risk.
- **HYBRID** is eligible only for a bounded route or worker path with independent rollback and proven end-to-end benefit.
- **MIGRATE TO RUST** is ineligible from this PoC alone.

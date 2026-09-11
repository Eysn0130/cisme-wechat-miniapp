# CISME Rust H-lane PoC

This is an isolated, non-production Axum/Tokio/SQLx experiment. It does not replace or modify Fastify.

## Implemented surface

- `GET /health/live`
- `GET /health/ready`
- `GET /v1/capabilities` with the current Fastify feature projection and no DB readiness probe
- `GET /v1/bootstrap/settings` with Fastify-compatible HMAC-SHA256 bearer auth, the existing SQL projection, and one `REPEATABLE READ READ ONLY` PostgreSQL snapshot

The candidate mirrors Fastify defaults for pool max (10), aggregate connection budget (40), acquire timeout (2 s), statement timeout (2.5 s), lock timeout (750 ms), idle-in-transaction timeout (5 s), and route deadline (8 s). Startup fails when `pool_max × instance_count > global_budget`. The hard test-database guard rejects any database name outside `cisme_*test*`.

The contract intentionally stops here. Feed, comments/reactions, write paths, worker/outbox delivery, admin auth, object storage, metrics parity, full configuration gating, and deployment integration are not implemented and remain `UNVERIFIED`.

## Stable dependency record

The versions were checked on 2026-09-10 against the official [Rust release feed](https://blog.rust-lang.org/releases/latest/) and each crate's first-party crates.io API record. See `evidence/dependency-check-2026-09-10.json`. The lockfile pins the complete transitive graph.

The host had no Rust toolchain. Validation used the official `rust:1.98.1-slim-bookworm` Linux/arm64 image, keeping the host unchanged.

## Reproduce safely

From the repository root, create the isolated database once and apply the existing migrations:

```sh
docker exec cisme-r0-postgres-1 createdb -U cisme cisme_rust_poc_test
DATABASE_URL='postgres://cisme:cisme-dev-only@127.0.0.1:55432/cisme_rust_poc_test' \
  APP_ENV=test APP_SESSION_SECRET=rust-poc-test ADMIN_API_TOKEN=rust-poc-admin \
  UPLOAD_TOKEN_SECRET=rust-poc-upload OBJECT_STORAGE_DRIVER=api_gateway npm run db:migrate
```

Run formatting, unit tests, and the explicit DB integration test:

```sh
docker run --rm -v "$PWD/experiments/rust-poc:/src" -w /src \
  rust:1.98.1-slim-bookworm sh -c 'cargo fmt --check && cargo test --locked'

docker run --rm \
  -e DATABASE_URL='postgres://cisme:cisme-dev-only@host.docker.internal:55432/cisme_rust_poc_test' \
  -e APP_ENV=test -e APP_SESSION_SECRET=rust-poc-test \
  -v "$PWD/experiments/rust-poc:/src" -w /src rust:1.98.1-slim-bookworm \
  cargo test --locked --test settings_bootstrap -- --ignored --test-threads=1
```

The ignored integration test inserts and removes only its own fixture. It does not reset or migrate the database.

Build or run the service:

```sh
docker build -t cisme-rust-poc:local experiments/rust-poc
docker run --rm -p 3210:3210 \
  -e DATABASE_URL='postgres://cisme:cisme-dev-only@host.docker.internal:55432/cisme_rust_poc_test' \
  -e APP_ENV=test -e APP_SESSION_SECRET=rust-poc-test -e RUST_POC_BIND=0.0.0.0:3210 \
  cisme-rust-poc:local
```

With Fastify at `127.0.0.1:3110` and Rust at `127.0.0.1:3210`, run semantic parity and the legacy developer smoke harness:

```sh
APP_SESSION_SECRET=rust-poc-test node experiments/rust-poc/scripts/parity.mjs
node experiments/rust-poc/scripts/run-comparison.mjs
```

`run-comparison.mjs` alternates candidate order and writes one JSON object per route/candidate/round to standard output. The checked-in historical run is `evidence/smoke-2026-09-10.json`; because its runtimes were asymmetric, do not use it for the architecture decision.

After building `cisme-fastify-benchmark:local` from the repository Dockerfile and `cisme-rust-poc:local` from this directory, the symmetric harness runs one candidate at a time with the same Linux/arm64 architecture, CPU/memory limits, Docker network, database, pool and timeout settings:

```sh
node experiments/rust-poc/scripts/symmetric-comparison.mjs
```

It owns and removes only the `cisme-rust-fair-benchmark` container and writes `evidence/symmetric-container-2026-09-10.json`. The database must already exist and remains guarded as `cisme_*test*` by the Rust candidate.

## Observed result and decision

Parity passed for capabilities, settings bootstrap, and missing/tampered/expired auth. Unit tests passed 3/3 and the isolated DB integration test passed 1/1.

The final narrow comparison used five alternating rounds at concurrency 50, with 200 warm-ups and 1,000 measured requests per route/candidate/round. Candidates ran one at a time with 1 CPU, 512 MiB and pool 10. Semantic parity passed and all 20,000 measured requests returned 2xx.

| Route / runtime | Median P95 | Median P99 | Median throughput | CPU/request | Process peak RSS | Container memory peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| capabilities / Fastify | 9.55 ms | 14.36 ms | 9,450 rps | 0.11 ms | 96.69 MiB | 55.05 MiB |
| capabilities / Rust | 6.31 ms | 7.08 ms | 13,538 rps | 0.03 ms | 7.48 MiB | 5.56 MiB |
| settings / Fastify | 31.01 ms | 35.00 ms | 2,332 rps | 0.34 ms | 107.02 MiB | 65.86 MiB |
| settings / Rust | 12.05 ms | 13.64 ms | 5,597 rps | 0.11 ms | 9.07 MiB | 7.12 MiB |

This is decision-grade evidence for the two implemented paths and a positive Rust signal. It is not migration-grade: only 2 of 45 API paths are present, the identity fixture is small, and Feed, comments, writes, Worker, media, broader concurrency, long soak, production topology and rollback remain unverified. The production candidate therefore remains **KEEP FASTIFY**. A hybrid can be reconsidered for a bounded Worker/CPU path only after broad parity, independent rollback and full-workload evidence.

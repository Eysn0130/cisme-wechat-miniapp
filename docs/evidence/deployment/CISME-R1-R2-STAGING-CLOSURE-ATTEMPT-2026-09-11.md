# CISME R1/R2 staging closure attempt — 2026-09-11

## Gate result

`R1/R2 BLOCKED`

R1/R2 remains locally verified and is not frozen as staging-verified. R3 AI Support and R4 Commerce Catalog were not started. This attempt made no staging database, runtime, service, legal-publication, mini-program upload, production, payment, credential, or Git mutation.

The blocking conditions are operational evidence gaps, not a schema ambiguity:

1. the authenticated cloud-console control session could not initialize after a full session reset, so a temporary staging SSH key could not be installed and the live migration-29 baseline could not be read or changed safely;
2. the WeChat DevTools simulator compiled all 20 routes, but its Automator endpoint timed out, so it produced no current-source screenshots and could not drive stateful UI assertions;
3. no authorized iOS or Android device session was available.

No long-lived local SSH key, disabled host verification, alternate authority, production credential, formal mini-program upload, or error suppression was used as a workaround.

## Canonical schema count resolution

The canonical rule is:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
```

This includes `schema_migration`. A disposable PostgreSQL replay established:

| State | Ledger rows | Canonical public base tables | `pg_indexes` | `information_schema.table_constraints` |
| --- | ---: | ---: | ---: | ---: |
| P0/P1 baseline, migration 29 | 29 | 66 | 147 | 849 |
| R1/R2 candidate, migration 31 | 31 | 69 | 158 | 905 |

The contract validator's `59 tables` is not a physical schema count. It is a curated required-table allowlist. At migration 29 that allowlist contains 56 entries; at migration 31 it contains 59. It intentionally excludes these 10 existing physical tables:

`community_comment`, `community_comment_like`, `community_post_stats`, `community_reaction`, `consent_acceptance`, `emergency_switch`, `idempotency_operation`, `principal_role`, `review_action`, `schema_migration`.

Physical candidate diff from 29 to 31:

- added by `202609110003_role_aware_authority.sql`: `authority_grant`;
- added by `202609110004_support_foundation.sql`: `support_conversation`, `support_message`;
- removed: none;
- renamed: none;
- destructive DDL in either up migration: none.

Therefore the consistent physical count is `66 + 3 = 69`. No P0/P1 table was deleted.

## Independent staging slice

The staging-only slice is [r1-r2-staging-slice-20260911T080300Z](/Users/mini/CISME/cisme-r0-platform/dist/r1-r2-staging-slice-20260911T080300Z). It contains the migration-29 baseline API artifact, complete candidate API/Worker artifacts, migrations 30 and 31, the full 20-route mini-program candidate, source snapshots, legal/privacy material, and the four staging verification programs.

- manifest SHA-256: `046a4833a554171e2f1814db2484eff3ca60b6a56fdeb17c9bf8d372e19363c2`;
- checksum manifest SHA-256: `c2da6e8c19710d5d54f8810c18591aeb9f0b5ce6ad46b10fdd2531627e8300c6`;
- all 240 entries passed `shasum -a 256 -c`;
- API reconstruction from the verified migration-29 artifact plus `runtime/index.patch` reproduced the candidate API byte-for-byte;
- no `.env`, private project config, key, certificate, PEM private key, or Tencent secret-id signature is present;
- production, payment, formal mini-program upload, Web Admin change, and credential inclusion are explicitly false in the manifest.

Candidate hashes:

| Artifact | SHA-256 |
| --- | --- |
| API | `b7bce249e665b498a4966c9b52a2a15756b4c50e81cb997b514167a2460002d4` |
| Worker | `16d871d89913284cd5fb3692f91f5a6f044b59e44d4de49052eb2c7741da36ef` |
| Worker one-shot | `980e509f9a8897960ba2a055ce862ebda425f69b13f7cb565ec1acd25f3e16f3` |
| Runtime lock | `a51f71d7721523b9c06cd728857d3c23a3aff3f73e6093ac1c48b60cf63e8293` |
| Migration 30 | `af94ea1451eda621d2c28bbd559ce4c7b100314d82e02c858e8c611fc220e797` |
| Migration 31 | `f36f45d1ed45ed3e05537e0a0ca5fd4bcf20e47749c8413fbdebd30a280f86be` |
| Mini-program source | `2d891f64556eff7e9ebd8760183125b7214804bf213f163db063976686b8993e` |

## Local rehearsal and runtime evidence

The dedicated disposable database completed exactly:

`29 → 30 → verify → 31 → verify → rollback 31 → 30 → rollback 30 → 29 → baseline fingerprint verify → 30 → 31 → final verify`.

The migration-29 table fingerprint was `1cec31bece979e11b35ce6d36af5e5f7`; the migration-ledger fingerprint was `ff852f21661b676105733b58def8dd92`. Both matched after the full rollback. The final state was 31 migrations, 69 tables, 158 indexes, 905 constraints, zero invalid indexes and zero unvalidated constraints, with all nine governance and eight UGC foundation tables intact. `uploads=false` and `community=false` were checked throughout.

The staging-profile local runtime verifier created only synthetic identities and passed:

- ordinary/member/client-flag/legacy-admin isolation;
- exact capability restriction and immediate revocation;
- first message, queue visibility, one-of-two exclusive claim, current-handler reply, user receive, unread/read cursor, resolve and reopen;
- client-message retry/conflict, monotonic incremental poll, stale poll, new session recovery, and cross-account isolation;
- stale automatic reply rejection after human ownership;
- `POLICY PENDING` fail-closed behavior, a temporary synthetic one-day policy, legal-hold blocking, exact-conversation purge, semantic idempotent replay, and PII-free tombstone;
- exact synthetic count cleanup and return to the pending policy.

The final-state verifier observed zero member, authority grant, conversation, message, active hold, pending-outbox and dead-letter rows in the disposable database. This is local rehearsal evidence only.

## Tests and package gates

- build and both TypeScript checks: pass;
- unit: 34 files, 238 tests passed;
- integration: 19 files, 93 tests passed;
- contracts: 31 migrations, 59 required tables, 59 paths, 20 events cross-checked;
- targeted privacy/support/native checks: 3 files, 13 tests passed;
- mini-program package: 169 files, 20 routes, 1,631,963 bytes total, 1,332,716-byte main package, 8,124-byte global WXSS, all internal budgets pass;
- structural design QA: pass; release QA: fail closed because current screenshot, route-state, iOS/Android, and open P0/P1 evidence is incomplete.

## Local performance baseline

This is `local_staging_profile_http`, not real staging HTTPS. Twenty-five sequential samples per path produced zero errors:

| Path | P50 ms | P95 ms | P99 ms | P95 bytes |
| --- | ---: | ---: | ---: | ---: |
| first message | 6.51 | 11.76 | 26.09 | 424 |
| incremental poll | 1.30 | 3.16 | 5.01 | 446 |
| conversation history | 1.32 | 2.10 | 2.25 | 446 |
| admin queue | 1.54 | 2.33 | 2.94 | 8,334 |
| admin open conversation | 1.77 | 2.57 | 2.59 | 554 |
| admin reply | 3.61 | 5.63 | 6.16 | 427 |

Observed SQL P95 was 1.24 ms, pool-wait P95 was 0.018 ms, pool waiting was zero, and all synthetic rows were removed. These numbers must not be represented as staging performance.

## Privacy, legal text, and purge mechanism

The personal-data inventory now covers conversation, message body, future attachment, sender, handler, linked member, future linked order, status, context and support audit boundaries. The staging legal candidate explains user-initiated support content, necessary linked data, support/complaint/service-quality purposes, low-risk AI assistance, human handoff, and the prohibition on AI high-risk writes.

ADR 0006 keeps both conversation and support-audit durations at `POLICY PENDING`; no retention duration was invented. The implementation is fail-closed until an active, enforced, positive-duration policy exists. Eligibility, legal hold, exact purge, idempotency, minimal tombstone and body-free outbox are implemented and locally verified. The staging legal text was not published because staging access was unavailable.

## DevTools and device evidence

- WeChat DevTools login and skill compatibility: valid, v0.3.9 equal;
- full-mode project window: opened/reused successfully;
- 20/20 routes: `simulator_open_page` compiled and opened successfully;
- screenshots: 0/20; `simulator_screenshot` failed with `waitForAutomatorReady timeout: timeout waiting for automator response`;
- Automator runtime probe also timed out, so repeated incremental retries were stopped;
- iOS: unverified;
- Android: unverified;
- formal upload/release: not attempted and not authorized.

## Live staging work not executed

The following remain unverified because no safe authenticated staging shell could be established:

- live confirmation that staging still exactly matches the canonical migration-29/66-table baseline;
- the required migration rehearsal on staging and its final 31/69/158/constraint count;
- API/Worker/miniprogram staging-candidate deployment;
- real staging synthetic capability/support/retention chain;
- real HTTPS performance, SQL and pool evidence;
- legal staging publication;
- readiness removal, graceful drain, in-flight completion, restart, readiness restoration, and transient-502 root-cause result;
- the required 16-state screenshot pack and iOS/Android route QA.

Until those are completed, `R1/R2 STAGING VERIFIED` is prohibited, R1/R2 is not frozen, and R3/R4 must not begin.

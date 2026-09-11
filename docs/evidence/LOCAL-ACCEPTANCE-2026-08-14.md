# Local acceptance evidence — 2026-08-14

Superseded historical snapshot. Current isolated command is `npm run wechat:ci:isolated`; the 2026-08-15 isolated lock audit reports 73 advisories. Historical commands and counts below are preserved as capture facts, not current instructions.

Host timezone: Asia/Shanghai. Local runtime: Node.js 24.14.0, npm 11.9.0. CI target is Node.js 24.18.0; local output is not mislabeled as 24.18.

PRD SHA-256: `72bdde4b2003bb0639ed41aab180384d936a8ce135bdd5e1102be5c4667e8d07`.

## Reproducible gates

| Gate | Result |
|---|---|
| `npm ci` | pass |
| `npm audit --audit-level=low` | pass; 0 vulnerabilities in root lock, 491 total dependency nodes |
| `npm run typecheck` | pass; API/worker/admin plus native mini-program TypeScript |
| `npm test` | 3 files, 10 unit/contract tests passed |
| `npm run test:integration` | 4 files, 11 tests passed against real PostgreSQL and storage |
| `npm run test:storage-contract` | path-style SigV4 multipart POST, HEAD, SHA-256 and delete passed |
| `npm run build` | API 60.55 KB, worker 3.12 KB, admin JS 5.06 KB/CSS 2.25 KB (uncompressed build output) |
| `npm run lint:contracts` | 21 tables, 8 required paths, 7 events cross-checked |
| `npm run sbom` | CycloneDX 1.6 JSON generated |
| `npm run license:report` | 477 exact lock rows, 0 unknown licenses |
| empty/N-1 migration | empty migrate, latest rollback and reapply passed |
| backup/restore | custom-format pg_dump restored to isolated DB; migration count 1; disposable DB removed |
| `npm run miniprogram:ci` without credentials | intentionally failed with `FAIL_CLOSED:WECHAT_APP_ID_AND_PRIVATE_KEY_REQUIRED` |

## Container evidence

- PostgreSQL image: `postgres@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`; healthy.
- SeaweedFS image: `chrislusf/seaweedfs@sha256:d47c7ee99fcb951351d7194915f4e3a5ea604a8e8871183d713907dec4fb9bf5`; version label 4.29, upstream revision `1355c7a102194d6c461baf090eff50367b575afb`, Apache-2.0.

## Invariants exercised

- `planned.started_on = null`; explicit activation sets the local date.
- D1/D7/D14/D28 are due by started date and QA clock; early completion is rejected; repeat completion is idempotent.
- Pause/resume/terminate, D28 completion and a second cycle are covered.
- Five simultaneous D7 decisions respect capacity 2; expiry releases a slot for a later qualified member.
- Eight simultaneous claims converge to one task claim and submission.
- Upload failure/retry/delete, byte-signature MIME verification, duplicate hash and object-level authorization are covered.
- Supplement, reject, appeal and six simultaneous approvals converge to one reward, grant, lot and entry.
- Points entry update/delete is rejected by database trigger; projection conservation is asserted.
- Outbox replay creates no duplicate reward/feed; revocation hides feed, blocks new use and preserves history.
- Duplicate link, four independent emergency switches, RBAC and audit logging are covered.

## WeChat tool isolation

The current official `miniprogram-ci` 2.1.31 tree was evaluated separately and reported 75 advisories (41 critical, 18 high, 15 moderate, 1 low), primarily old transitive build tooling, with no direct-package fix. It was removed from the root production lock and placed as an uninstalled, risk-gated package under `tools/wechat-ci`. Credentialed preview remains blocked until a security owner accepts the isolated runner or upstream publishes a safe version.

## Evidence boundary

No WeChat AppID/private key, DevTools application or physical-device session was available. Therefore no native screenshot, real login, native share, upload-domain acceptance or review submission is claimed. Prototype screenshots are not presented as native evidence.

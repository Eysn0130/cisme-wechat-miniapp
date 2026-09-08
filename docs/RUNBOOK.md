# CISME local / release runbook

Status: local engineering path is runnable; credentialed WeChat preview/trial/release is fail-closed.

## Prerequisites

- Node.js 24.18 LTS for CI; package policy accepts `>=24.14 <25`.
- Docker-compatible runtime.
- Local development may use the explicit dev identity adapter. Preview/trial/release require real WeChat credentials and a public HTTPS environment.

## Start local stack

```bash
npm ci
docker compose -f infra/compose.yaml up -d --wait
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev:api
```

Run `npm run dev:worker` and `npm run dev:admin` in separate terminals. Open `apps/miniprogram` in WeChat DevTools. `project.private.config.json` may disable domain checks only for local DevTools; tracked production `project.config.json` keeps URL checking enabled.

## Same-LAN true-device debugging

This path is for a developer-controlled physical-device session, not an experience version or release. The Mac and phone must be on the same trusted LAN, the API must still be listening on `0.0.0.0:3100`, and the scanning WeChat account must already be authorized for the Mini Program project.

```bash
curl -fsS http://127.0.0.1:3100/health/ready
npm run wechat:device-debug:configure
```

The configure command detects a private IPv4 address, writes only the ignored `apps/miniprogram/project.private.config.json`, enables LAN debugging, and creates the `CISME 真机调试` compile condition. If auto-detection chooses the wrong interface, pass an explicit private-LAN origin, for example `npm run wechat:device-debug:configure -- --origin=http://192.168.1.20:3100`, then confirm the phone can reach that origin before scanning.

In WeChat DevTools, select `CISME 真机调试`, compile, click `真机调试`, enable `局域网模式`, and scan the short-lived QR. The compile query permits this private HTTP origin only when `envVersion=develop`, the runtime is a physical device and `cisme_remote_debug=1`; localhost, public HTTP, paths, trial and release are rejected. Keep the API and DevTools running for the entire session. Record device model, OS, WeChat version, route/state, source hash, console and Network outcome after connection, but never commit the QR itself.

If the device cannot connect, verify in order: authorized project membership, same Wi-Fi/VLAN, Mac firewall, selected LAN IP, `/health/ready`, compile condition, then DevTools/WeChat version. Do not weaken trial/release domain checks to fix a LAN-debug problem. Team members outside the LAN require the separately gated public-HTTPS development/experience path in `docs/WECHAT-DEMO-RELEASE.md`.

## Isolated test database

Fresh local stacks create `cisme_test` separately from preview data. For an existing Docker volume, run `docker compose -f infra/compose.yaml exec postgres createdb -U cisme cisme_test` once if it does not exist. Tests prefer `TEST_DATABASE_URL`, then `DATABASE_URL`, and otherwise use local `cisme_test`. Reset helpers reject database names without a separate `test` segment and check the actual connected database before dropping schemas. Never target the preview or public database.

## Required local gates

```bash
npm run typecheck
npm run lint:contracts
npm run miniprogram:package-gate
npm run design:qa:status
npm test
npm run test:storage-contract
npm run test:integration
npm run build
npm audit --audit-level=low
npm run sbom
npm run license:report
npm run wechat:preflight:local
```

The package gate verifies all 13 route file sets, an internal 1.8 MB source budget, an 8 KB global WXSS budget, a 200 KB single-asset budget and a deterministic source SHA-256. These are conservative project gates, not claims about a current WeChat platform limit.

`design:qa:status` verifies that the evidence manifest is structurally valid and bound to the current package hash; it may honestly report `releaseReady:false` without failing ordinary push/PR engineering CI. Manual workflow dispatch and `candidate-*` tags add `candidate-design-qa`, which runs the strict gate after the full verify job. `design:qa:gate` is also mandatory for credentialed preview/release: it remains non-zero until current-hash DevTools compile/console/network evidence, all 13 route matrices, iOS and Android proof, and zero open P0/P1 are recorded. Never edit the manifest to green without the referenced files.

After CLI gates, compile inside WeChat DevTools and record: 0 project compile errors, 0 project console errors, 0 failed application requests, package analysis and route-state screenshots. System/base-library warnings must be identified separately; they are not silently counted as app pass or app fail.

## Credentialed preview/trial

Follow `docs/WECHAT-DEMO-RELEASE.md`. The local signed DevTools CLI is the first path. Official `miniprogram-ci` remains an isolated, protected-environment option after the upload key and IP allowlist exist and its advisory tree is accepted. Its standalone entry point repeats AppID, legal/domain/manual and strict current-source Design QA checks, so invoking it outside the workflow is not a bypass. Neither path auto-publishes a formal release.

Required proof before any upload: strict `design:qa:gate` pass, real AppID/project role, public HTTPS API/upload/download domains, privacy guide, approved legal texts, independent test DB/storage, experience members, version/description, commit and source hash. Upload uses an explicit confirmation flag.

## Incidents and recovery

### WeChat preview boundary

On 2026-08-30, WeChat DevTools RC interpreted a shortcut intended for Security Settings as Preview and generated a short-lived QR for the logged-in interface test account. It was not scanned, distributed, promoted to trial, submitted for review or released. The QR-bearing screenshot was deleted; only a non-QR context image remains outside the acceptance manifest. Treat this as an operator incident, not as preview/upload evidence. Do not enable the DevTools CLI service port merely to reproduce it. A controlled preview still requires strict current-source Design QA, verified AppID/project role, approved legal/privacy/domain configuration, public HTTPS test environment and an authorized operator.

Operational switches stop `identity`, `uploads`, `reviews` or `rewards`; business switches independently hold submissions, rewards, redemption and commerce. Read the authoritative switch list first, then update with its expected version, a unique Idempotency-Key and a reason. Only authorized roles may change them; exact replays do not add audit rows. Do not disable unrelated capabilities.

When points rules are approved, set an unexpired `POINTS_FINANCE_APPROVAL_EXPIRES_AT`, 3–5 approved rule IDs, `POINTS_HOLD_DAYS`, `POINTS_EXPIRY_DAYS` and the maker-checker readiness gate. Seed or provision separate `finance_operator` and `finance_approver` principals through the future production IdP; never give one person both roles. Operators use the grant queue to propose a whole-lot action; approvers use the action queue. Rejections advance grant version so corrected evidence can be resubmitted. Redemption stays disabled until spend/debt/refund reconciliation is implemented.

Outbox and media-cleanup delivery use per-item transaction savepoints, capped exponential backoff and dead-letter after five failed attempts. Inspect all unprocessed event counts and explicit implemented/unimplemented handler state through `GET /v1/admin/worker-backlog`; inspect dead letters through `GET /v1/admin/worker-failures` as `review_lead`, `auditor` or `support`. A processed publication row must carry `processing_outcome=applied|suppressed`; `applied` requires a real feed row, while revoked/missing consent may only be `suppressed`. Repair and verify the dependency before redrive. A `review_lead` then calls `POST /v1/admin/worker-failures/{outbox|media_cleanup}/{itemId}/redrive` with a unique `Idempotency-Key` and `{ "reason": "<incident reason>", "expectedAttempts": 5 }`. Redrive is one-item-only, expected-attempt guarded, exact-replay safe and audited; it never resets the attempts counter. Do not update queue rows, campaign rows or points entries by hand. Use `docs/DATA-RECOVERY.md` for backup/restore acceptance.

Eligibility campaign bootstrap remains a migration/seed concern, but live availability, window and capacity are operated through `GET /v1/admin/campaigns` and `PUT /v1/admin/campaigns/{campaignId}`. Updates require a `review_lead`, an Idempotency-Key, expected version, reason code and evidence; capacity cannot fall below active allocations. Reward amount, qualifying milestone and campaign code are immutable through this endpoint. Production IdP ownership and alert routing remain external release requirements.

## Shutdown

`docker compose -f infra/compose.yaml stop` preserves volumes. `down -v` destroys local database/object data and is allowed only for an explicitly disposable environment.

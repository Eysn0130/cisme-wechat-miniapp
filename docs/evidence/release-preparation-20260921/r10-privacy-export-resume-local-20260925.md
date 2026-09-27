# PR22 privacy export resume — local R10 evidence, 2026-09-25

Scope: uncommitted local working tree on `codex/fulfillment-lifecycle-20260922`, based on remote PR22 HEAD `5ab4a00d4e71d8a9a2de14e31b64fca0bbe92e88`. This is source and automated-test evidence only. It does not certify a WeChat preview, iOS or Android journey, public API reachability from a handset, or production release.

## Finding and repair

The privacy-rights page cleared its selected multipart export when `wx.shareFileMessage` hid the page. On return, its first-page refresh could also remove the selected request when that request was on an older page. A member sending a large copy, for example part 57 of 101 and verification manifest page 2, had to find the request and position again.

The page now keeps only the selected request identifier, export identifier, part and manifest position, and counts across `onHide`. Before restoring controls on `onShow`, it refreshes the request list and checks the export's first manifest page against the saved request/export identifiers and counts. A changed account or commerce-context revision, revoked or expired export, changed export, access denial, and confirmed or uncertain revocation clear the saved position. When the selected request is beyond page one, a visibly marked resume-only item uses the just-verified export facts and no cached request body, status, response, or reply history. It offers only the verified part/manifest continuation controls; the general export and revoke actions wait for the actual record. Subsequent pages place the fresh row in server list order; an unavailable export removes the controls. If the final refreshed page still lacks the selected request, recovery clears the resume item instead of leaving an orphan row. Export content and downloaded files are not retained for this feature.

`tests/unit/native-privacy-export-resume.test.ts` exercises the share-induced hide/return, 101-part later-page recovery, neutral placeholder and server-order replacement, absent first/final-page request, account switch including A→B→A, denial, expiry, regenerated export, page-two revocation, revoke outcomes, and a stale asynchronous response. The account protocol retry disabled styling and existing page-state assertions from the prior R9 local repair are also present in this working tree.

## Verification in the local worktree

- Mini Program source SHA-256: `899c475e7b1e1df414a5820818039054959e7c1a60e09d91eabe5ea89920b207`.
- `npm run test -- --reporter=dot`: 124 files, 1425 passed, 1 skipped, 0 failed.
- `npm run test:integration -- --reporter=dot`: 57 files, 916 passed, 0 failed before the last native-only TypeScript and WXML refinements. The backend was unchanged throughout; the run's disposable PostgreSQL and object storage targets were removed.
- `npm run build`, `npm run miniprogram:route-audit`, `npm run miniprogram:package-gate`, and `git diff --check`: passed at the source hash above. The route audit covers 40 routes. `npm run lint:contracts` also passed before the final WXML-only condition; contracts and backend were unchanged.
- `npm run restore:verify`: passed against a disposable synthetic database with 94 migrations before the final native-only edit; the backend source did not change. Its generated evidence is `recovery/synthetic-restore.json`.
- `npm run design:qa:status`: `releaseReady=false`; current-source DevTools, iOS, Android, and complete route-state evidence remain required. `docs/evidence/visual/current-source-acceptance.json` binds this exact source hash and records all native acceptance as blocked. Older screenshots remain bound to their original source manifests.

## Release boundary

This candidate is not committed or pushed. An earlier attempted GitHub `create_tree` remote write was rejected by automatic approval review; this local repair does not route around that rejection. PR22 remains open as a draft at its previous remote HEAD. Its `verify` check failed on four account-page assertions against that old HEAD; the corresponding local assertions now pass, but that CI result does not test this working tree. Remote `main` remains `5740e18544fa37dd473c36934a2a12a07a2d5ec9` and has not been changed by this repair.

The public legal bootstrap is still failing from this Mac with `NETWORK_ERROR`, and the same iPhone Safari attempt previously failed; see the R9 triage note for the exact scope of network observations and the Tencent filing state. The Mini Program filing and separate website/domain filing remain release gates. Do not infer the exact connection-close cause from the rejected website order, and do not treat an approved Mini Program filing alone as proof that the API domain is usable. Native sharing, resume behavior, route states, and the real API path still need current-package DevTools and authorized device evidence after access is available.

## Read-only production entry review

`infra/tencent/production-release.py` requires a root-owned immutable prepared release whose manifest matches the exact current GitHub `main` SHA/tree, with its migration entry identical to reviewed main source and a successful latest `main` push CI. Its candidate guard binds the original production database and COS, requires `APP_ENV=production`, and defaults to closed commerce (`COMMERCE_ORDER_FLOW_ENABLED=false`), `CISME_MIGRATION_READ_ONLY=true`, no dev adapters, and `RUN_BACKGROUND_WORKER=false`.

Before apply, protected current-candidate qualifications must prove an encrypted backup with matching digest, complete production restore including roles/COS/keys/privacy suppression, same-data application rollback preserving new writes, external writer inventory and drain, and migration history/SQL review. The writer receipt must be at most 15 minutes old and the other receipts at most 24 hours old. The entry repeats exact main/CI, target, configuration, previous artifact, and migration checks after stopping API and worker, before migration. A successful cutover still reports `productionValidated=false`, `commerceEnabled=false`, `maintenanceEnabled=true`; it does not establish trading readiness.

The last read-only production observation, on 2026-09-24, recorded no TCP 443 rule in the displayed cloud firewall, `APP_ENV="staging"`, and `/opt/cisme/current` resolving to `/opt/cisme/releases/20260909-native-login`. These are historical observations, not current state or proof of the exact public-network failure. Recheck the original production instance, 443/TLS, live APP_ENV, and previous release path immediately before any production preflight. PR22 is still draft with failed old-head CI, there is no reviewed main candidate or current native acceptance, and no production apply was attempted.

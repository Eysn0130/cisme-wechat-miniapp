# CISME Visual Review Pack — u0-u1-949fcf9d-20260912T0220Z

Generated: 2026-09-11T18:25:12.632Z

This pack is bound to Mini Program source SHA-256 `949fcf9da6d4777d17eab31ba42b46394d9268fed3c30bbab09fc5533759ad99` and local Git HEAD `8e843a6b0a28628544202889217deda255e86c81` on branch `main`. The worktree is dirty by design and has not been committed or pushed; the source hash, not HEAD alone, is the review identity.

## Honest result

- Dynamic route inventory: 27/27 routes indexed from `app.json`.
- Current-source raw native screenshots: 27/27; each is an untouched 484×1048 simulator frame.
- Historical comparison screenshots: 27/27 untouched baseline frames copied from the Owner-supplied `CISME-AUDIT-8e843a6` pack; their original scope remains commit `8e843a6` / Mini source `7f5fad5f…`.
- Timed interaction evidence: 6 sequences / 25 untouched keyframes. Video recordings: 0; iOS sessions: 0; Android sessions: 0.
- The earlier diagnostic pack exposed two real blockers: the configured loopback origin had no listener, and protected pages had no authenticated session. This pack was captured only after a loopback-only schema-34 acceptance API passed ready/legal/order checks and the Account UI completed its explicit local-fixture consent/login flow.
- All 27 route-specific queries then settled with `loading=false`, an empty page error and the expected current route before capture. One clean project-window restart was used to recover the screenshot bridge; no web mock, generated image or historical frame is relabelled as current native evidence.
- The six simulator sequences verify message failure/retry, reading-history anchoring and new-message notice persistence, checkout return/expiry/requote, product draft return/conflict recovery, multiline composer geometry, and permission-revocation scrubbing. Runtime-injected network failure and clock advance are labelled as such; all other actions used the current native page and isolated local API/database.
- Final visual status: **LOCAL REPRESENTATIVE PASS / RELEASE BLOCKED**. The current source closes the audited representative U1 defects in the DevTools simulator, while responsive state coverage, physical keyboard behavior and iOS/Android device evidence remain open.

## Contents

- `source-manifest.json`: source and package binding.
- `routes.csv`: one default-entry row for every reachable route, with capture status and missing reason.
- `journeys.md`: core review journeys and required state evidence.
- `capture-manual.md`: bounded Owner-assisted native capture procedure.
- `design-tokens.json`: source-extracted token baseline, not a device pass.
- `performance-summary.json`: target and provenance-separated measurements.
- `performance-summary.md`: human-readable performance delta and limitations.
- `interaction-evidence.json` / `.md`: steps, assertions and provenance for the six timed keyframe sequences.
- `route-state-inventory.csv`: all 27 default route states plus important verified and pending substates.
- `design-audit-u0-u1.md`: evidence-backed V01–V03 and representative-page review.
- `issues.csv`: the consolidated first-batch issue ledger.
- `screenshots/`, `contact-sheets/`, `recordings/`, `keyframes/`: raw evidence folders; empty folders contain a README explaining the missing evidence.
- `SHA256SUMS`: digest list generated after all files.

## Review rule

A screenshot becomes reviewable only when its filename, route/state, capture time or sequence, simulator/device, tool/base-library version and exact source revision are recorded in `routes.csv` or `interaction-evidence.json`. A raw frame is not automatically accepted; contact sheets never replace the raw original. The baseline images prove only the old baseline, the current images prove only this exact package source hash, and no simulator artifact is labelled as physical-device evidence.

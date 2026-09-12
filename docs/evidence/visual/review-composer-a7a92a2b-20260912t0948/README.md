# CISME Visual Review Pack — composer-a7a92a2b-20260912t0948

Generated: 2026-09-12T01:53:02.266Z

This pack is bound to Mini Program source SHA-256 `a7a92a2b41ef6a2efcdf3e22401ccfc28152b54604e404f5023472bc7cc6f855` and local Git HEAD `b346cb6c51a6a61b8f7e41154fc7f5c2dae02e33` on branch `codex/u0-u1-review`. The worktree is dirty by design and has not been committed or pushed; the source hash, not HEAD alone, is the review identity.

## Honest result

- Dynamic route inventory: 27/27 routes indexed from `app.json`.
- Current-source raw native screenshots: 27/27; each is an untouched 484×1048 simulator frame.
- Interaction recordings: 0; iOS sessions: 0; Android sessions: 0.
- The earlier diagnostic pack exposed two real blockers: the configured loopback origin had no listener, and protected pages had no authenticated session. This pack was captured only after a loopback-only schema-35 acceptance API passed ready/legal/order checks and the Account UI completed its explicit local-fixture consent/login flow.
- All 27 route-specific queries then settled with `loading=false`, an empty page error and the expected current route before capture. One clean project-window restart was used to recover the screenshot bridge; no web mock, generated image or historical frame is relabelled as current native evidence.
- Final visual status: **BLOCKED**. Source/package tests may pass while visual/device evidence remains blocked.

## Contents

- `source-manifest.json`: source and package binding.
- `routes.csv`: one default-entry row for every reachable route, with capture status and missing reason.
- `journeys.md`: core review journeys and required state evidence.
- `capture-manual.md`: bounded Owner-assisted native capture procedure.
- `design-tokens.json`: source-extracted token baseline, not a device pass.
- `performance-summary.json`: target and provenance-separated measurements.
- `issues.csv`: the consolidated first-batch issue ledger.
- `screenshots/`, `contact-sheets/`, `recordings/`, `keyframes/`: raw evidence folders; empty folders contain a README explaining the missing evidence.
- `SHA256SUMS`: digest list generated after all files.

## Review rule

A screenshot becomes reviewable only when its filename, route/state, capture time, simulator/device, tool/base-library version and exact source revision are recorded in `routes.csv`. A raw frame is not automatically accepted; annotated images and contact sheets never replace the raw original.

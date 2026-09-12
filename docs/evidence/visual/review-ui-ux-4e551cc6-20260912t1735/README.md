# CISME Visual Review Pack — ui-ux-4e551cc6-20260912t1735

Generated: 2026-09-12T09:39:32.604Z

This pack is bound to Mini Program source SHA-256 `4e551cc6c41528a052af595e4ae48d569b9b17345a30db5a40bf2f1aec69175b` and local Git HEAD `2d1104d0f88cd1ead6054be8a9cc9bce90fe1dfc` on branch `codex/u0-u1-review`. The worktree is dirty by design and has not been committed or pushed; the source hash, not HEAD alone, is the review identity.

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
- `interaction-evidence.json`: current-hash queue preview/full-thread and product-to-checkout interaction paths.
- `composer-current/visual-evidence-manifest.json`: 16 current-hash Composer screenshots; the keyboard inset is simulated, not a physical-device keyboard.
- `SHA256SUMS`: digest list generated after all files.

## Review rule

A route screenshot becomes reviewable only when its filename, route/state, capture time, simulator/device, tool/base-library version and exact source revision are recorded in `routes.csv`; Composer and interaction screenshots use their dedicated manifests. A raw frame is not automatically accepted; annotated images and contact sheets never replace the raw original.

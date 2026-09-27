# INCOMPLETE CAPTURE — DO NOT USE FOR ACCEPTANCE

See `CAPTURE-FAILURE.md`.

# CISME Visual Review Pack — r16-pr22-current-6e1f8edc-20260925

Generated: 2026-09-25T16:25:20.159Z

This pack is bound to Mini Program source SHA-256 `6e1f8edcf0f13a13ab8693f2d633aecb0a32d5f6171e5cb833124d84ef7acb98` and local Git HEAD `129b3e701e0717f212790bbddf366dfcbaa37bf3` on branch `codex/fulfillment-lifecycle-20260922`. Observed worktree dirty: true. The source hash, not HEAD alone, is the review identity; this generator does not infer push or merge status.

## Honest result

- Dynamic route inventory: 40/40 routes indexed from `app.json`.
- Current-source raw native screenshots: 0/40; each is an untouched unknown×unknown simulator frame.
- Interaction recordings: 0; iOS sessions: 0; Android sessions: 0.
- Fixture schema: 94. Environment checks, when present, are local synthetic checks only.
- Route runtime results are supplied separately by the capture runner. This generator does not turn captured frames into passed interactions or visual review.
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

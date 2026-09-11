# CISME Visual Review Pack — commercial-r4b-7f5fad5f-20260911T194328+0800

Generated: 2026-09-11T12:07:36.319Z

This pack is bound to Mini Program source SHA-256 `7f5fad5fe84c122a28a9c54234690515a64c09cf86a666daced4ba635672957d` and local Git HEAD `3b9bca10f2f74adc505b7329affdf33b93e0a810` on branch `main`. The worktree is dirty by design and has not been committed or pushed; the source hash, not HEAD alone, is the review identity.

## Honest result

- Dynamic route inventory: 27/27 routes indexed from `app.json`.
- Current-source raw native screenshots: 27/27; each is an untouched 362×783 simulator frame.
- Interaction recordings: 0; iOS sessions: 0; Android sessions: 0.
- The first screenshot call hit the existing bridge timeout. One clean project-window restart recovered it; 27 routes then opened and were captured with a four-second stability window. No web mock, generated image or historical frame is relabelled as current native evidence.
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

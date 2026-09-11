# WeChat DevTools checkpoint — package `ecd59318…`

Capture date: 2026-08-16. This checkpoint is bound only to mini-program source SHA-256 `ecd59318d2df58a00d6d8cb9b409b9ec5defd80f8c165d6c68e159eb0bf7d2b3` (128 files, 13 routes, 1,287,869 bytes, global WXSS 7,844 bytes). The runtime is WeChat DevTools Stable 2.01.2510290, base library 2.32.3 and `touristappid`; it is not evidence of the tracked AppID, a development QR or a physical device.

## Current evidence

- `visual/current-run/native/devtools-package-ecd59318-compile-0-problems-2026-08-16.jpg`: current source after compile; Problems reports zero detected issues.
- `visual/current-run/native/devtools-package-ecd59318-console-0-errors-warnings-3-2026-08-16.jpg`: Console with the Errors-only level selected and no error row. The debugger reports three tool/base-library warnings; this is not warning-clean evidence.
- `visual/current-run/native/devtools-package-ecd59318-account-unchecked-button-baseline-2026-08-16.jpg`: full DevTools window for Account with the explicit local-only legal fixture, agreement unchecked and primary CTA disabled.
- `visual/current-run/native/account-unchecked-ecd59318-375x812-2x-2026-08-16.png`: raw 750×1624 page-frame exported by DevTools for the iPhone X 375×812 logical simulator.
- `visual/current-run/comparisons/account-unchecked-ecd59318-web-vs-native-375x812-diagnostic-2026-08-16.png`: frozen 375×812 Web device-frame and normalized 375×812 native page-frame side by side. It is a diagnostic, not a formal same-state acceptance input, because device chrome and legal copy differ.

No current-hash Network trace is recorded. `networkFailures` remains unknown and the strict gate fails closed. Prior filtered empty Network screenshots are historical bounded views, not structured current-source evidence.

## Account button finding and retest

The preceding `ea24ffe9…` raw comparison showed that the button label itself was centered inside the fixed 50px native capsule, while equal-height authorization rows pushed the entire safety/CTA group down. The current source restores a denser first/last row and a dedicated agreement-row height. The first CTA moves about 33px upward relative to that preceding native frame and is about 8px from the frozen screenshot in this diagnostic. This closes the locally measurable row-height P1, but checked/enabled rendering, matching-copy comparison and real-device typography remain open.

## Engineering checkpoint and verdict

Current target gates include 57 unit tests, including three executable Page-harness cases for navigation serialization and appeal authority conflict; 22 integration tests; the storage contract; typecheck; contract validation; build; package budget; audit; and local preflight. The manifest is structurally bound to this hash and its five referenced evidence artifacts. The non-strict Design QA status may be structurally valid while the strict gate must remain non-zero.

This is not a release pass. The 13-route state matrix, same-state Web/reference/native/comparison triplets, checked/enabled Account state, authenticated flows, raw Network evidence and real iOS/Android proof are incomplete. `final result: blocked`.

# WeChat DevTools checkpoint — package `59855054…`

Capture date: 2026-08-16. This checkpoint is bound only to mini-program source SHA-256 `5985505493313ce2df3c19298a1be0fe4ae7a434584ecbff3115c87391d3cf18` (128 files, 13 routes, 1,284,860 bytes, global WXSS 7,844 bytes). The runtime is WeChat DevTools Stable 2.01.2510290, base library 2.32.3 and `touristappid`; it is not evidence of the tracked AppID, a development QR or a physical device.

## Retained evidence

- `visual/current-run/native/devtools-package-59855054-compile-0-problems-2026-08-16.jpg`: current source after compile; editor Problems reports no detected issue and the debugger tab reports Errors 0.
- `visual/current-run/native/devtools-package-59855054-console-0-errors-system-warnings-2-2026-08-16.jpg`: Console with the Errors-only level selected and no error row. The debugger still reports two separately classified tool/base-library warnings; this is not warning-clean evidence.
- `visual/current-run/native/devtools-package-59855054-network-filter-no-status-outside-200-304-307-2026-08-16.jpg`: after clearing Network and compiling Account, the same live window reported 16 requests. Applying `-status-code:200 -status-code:304 -status-code:307` produced no visible row. The retained screenshot proves that filtered view; it is not a HAR, authenticated traffic capture or exhaustive route traversal.
- `visual/current-run/native/devtools-package-59855054-account-unchecked-button-baseline-2026-08-16.jpg`: full DevTools window for Account with the explicit local-only legal fixture, agreement unchecked and primary CTA disabled. It is a layout checkpoint, not a same-viewport native original.

## Acceptance boundary

The checked/enabled button state was not re-captured because accepting the agreement must be performed by the user. No route is marked visually passed: all 13 route-state matrices, authenticated flows, same-fixture Web/reference/comparison triples, iOS/Android hardware, media permission/upload, keyboard, weak-network and gesture-back evidence remain open. Formal terms/privacy text and versions are unsigned, so non-DevTools identity stays fail-closed.

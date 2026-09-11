# WeChat DevTools checkpoint `d68a641e…`

Date: 2026-08-16  
Scope: current-source compile and a bounded unauthenticated Account window. This checkpoint is not a 13-route traversal, authenticated E2E, legal-consent acceptance, development QR, real AppID proof, or iOS/Android sign-off.

- Package SHA-256: `d68a641e81060ca5d8f825d4f75566292e39b235f9ea6d832f3c68ce158a8e8d`.
- Package: 128 files / 13 routes / 1,279,766 bytes; global WXSS 7,844 bytes.
- Tool: WeChat DevTools Stable `2.01.2510290`, base library `2.32.3`, runtime `touristappid`.
- Project Errors `0`; Problems `0` after current-source compile.
- After clearing Console and recompiling: project error rows `0`; two visible warnings are DevTools/base-library warnings (SharedArrayBuffer deprecation and HarmonyOS/getSystemInfo guidance). Current source contains `wx.getWindowInfo()` and `wx.getMenuButtonBoundingClientRect()` and no `getSystemInfo` call.
- Account static-asset Network window: 16 requests. Status filters prove all 16 are in `{200, 304, 307}` and filtering those three statuses yields `0 / 16`; no status `0`, `4xx`, or `5xx` is present in this bounded window. No HAR and no authenticated API traffic are claimed.
- The detached Account screenshot is a 375×733 app-frame unchecked baseline only. It confirms the disabled primary button after the latest typography/alignment corrections; it is not a same-viewport comparison and does not cover the checked/enabled button.
- Agreement was not checked by automation. The current checked/enabled Account capture remains pending explicit user action.
- The 13-route route × state × action × API matrix, real camera/album/keyboard/weak-network cases, and iOS/Android hardware evidence remain blocked.

Evidence:

- `docs/evidence/visual/current-run/native/devtools-package-d68a641e-compile-0-project-errors-0-problems-2026-08-16.jpg`
- `docs/evidence/visual/current-run/native/devtools-package-d68a641e-console-0-errors-system-warnings-2-2026-08-16.jpg`
- `docs/evidence/visual/current-run/native/devtools-package-d68a641e-network-0-failures-16-requests-200-304-307-2026-08-16.jpg`
- `docs/evidence/visual/current-run/native/devtools-package-d68a641e-account-unchecked-button-baseline-2026-08-16.jpg`

Result: **blocked**.

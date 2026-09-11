# WeChat DevTools checkpoint `4584a4c2…`

Historical checkpoint. It was superseded by `792d18cd…` after the protected-request authentication precheck changed source behavior; none of the evidence below is inherited by the current package.

Date: 2026-08-15  
Scope: current-source local WeChat DevTools, all 13 modules at public/unauthenticated boundaries, two raw route frames and one bounded public-network window. This is not a development QR, real AppID proof, authenticated business E2E, complete route-state traversal, or iOS/Android sign-off.

- Package SHA-256: `4584a4c2ac7580059c355d5d52b0018f788c055615119e2ae3ea65a1d7ce9eff`
- Package: 127 files / 13 routes / 1,225,109 bytes; global WXSS 5,611 bytes.
- Tool: WeChat DevTools Stable `2.01.2510290`, base library `2.32.3`, runtime `touristappid`.
- Simulator: iPhone X, logical viewport `375×812`; built-in page screenshots are original `750×1624` PNGs.
- Compile: Project Errors `0`; Problems `0`. Four visible startup warnings were tool/base-library/development-environment notices, not silently counted as product success.
- Console: after classification and clear, the captured window reports Errors `0`, Warnings `0`; Problems remains `0`.
- Module traversal: current-hash navigation exercised all 13 registered modules. Account, Community, Shop, Product (`care-serum-30`) and Post (`brand-scalp-ritual`) reached public/default views. Home, Records, Profile, Points, Settings, Task, Submit and Progress were exercised only at the no-session boundary and ended at Account; routes that request authority first recorded expected local `401 Unauthorized` entries before redirect. Each protected route was repeated separately with Console cleared first; no retained run contains a Console-input `SyntaxError`.
- Post-traversal Console: expected unauthenticated request entries were classified, then Console was cleared again. The retained final window contains no error/warning entries and Problems remains `0`.
- Public-network window: Network was cleared, then Community was freshly loaded without an authenticated session. The panel recorded 82 requests. DevTools status filters partition the entire set as `2×200 + 40×304 + 40×307 = 82`; therefore this bounded window contains no status `0`, 4xx or 5xx. Both XHR requests are included in the `200` count.
- HAR boundary: DevTools' HAR exporter stalled at 78% while collecting content. It was cancelled and its zero-byte output was removed. The three status-filter screenshots are the evidence for the exact partition; no HAR is claimed.
- Account/unlogged: current raw 2× frame and frozen-Web combined inputs show the explicit disabled primary hierarchy. The legal agreement remained unchecked and the login action was not performed by the agent.
- Community/brand-editorial: the prior `9 + 1` hero-title orphan is absent in the current raw frame and combined comparison. The title now forms two balanced lines.

## Evidence

- `docs/evidence/visual/current-run/native/devtools-package-4584a4c2-compile-0-project-errors-4-system-warnings-2026-08-15.jpg`
- `docs/evidence/visual/current-run/native/devtools-package-4584a4c2-console-cleared-0-error-0-warning-2026-08-15.jpg`
- `docs/evidence/visual/current-run/native/devtools-package-4584a4c2-13-module-console-cleared-0-error-0-warning-2026-08-15.jpg`
- `docs/evidence/visual/current-run/native/devtools-package-4584a4c2-community-network-82-requests-2026-08-15.jpg`
- `docs/evidence/visual/current-run/native/devtools-package-4584a4c2-community-network-status-200-2-of-82-2026-08-15.jpg`
- `docs/evidence/visual/current-run/native/devtools-package-4584a4c2-community-network-status-304-40-of-82-2026-08-15.jpg`
- `docs/evidence/visual/current-run/native/devtools-package-4584a4c2-community-network-status-307-40-of-82-2026-08-15.jpg`
- `docs/evidence/visual/current-run/native/account-unlogged-4584a4c2-375x812-2x-2026-08-15.png`
- `docs/evidence/visual/current-run/comparisons/account-unlogged-4584a4c2-web-vs-native-375x812.png`
- `docs/evidence/visual/current-run/native/community-brand-editorial-4584a4c2-375x812-2x-2026-08-15.png`
- `docs/evidence/visual/current-run/comparisons/community-brand-editorial-4584a4c2-web-vs-native-375x812.png`
- `docs/evidence/visual/current-run/native/devtools-package-4584a4c2-route-*.jpg` (13 full-window public/unauthenticated boundary captures; protected routes are Account redirects, not visual passes)

## Boundaries and verdict

- Account remains blocked as a route matrix: the frozen source includes optional-phone semantics that production intentionally holds closed, and busy/success/WeChat-failure/privacy/session-expiry/source-return/device states are not current-hash evidence.
- Community remains blocked as a route matrix: frozen public UGC/recommendation semantics intentionally differ from production brand editorial/manual review, and invitation/error/top-bottom/device states remain open.
- The 13 full-window route files prove module loading and public/no-session recovery only. They are not raw page-frame visual inputs and do not satisfy loading/empty/error/no-permission/long-copy/keyboard/scroll/crop matrices.
- No historical DevTools, authenticated fixture or device evidence is inherited by this hash.

Result: the current compile, clean Console and bounded public-network checkpoint pass; the Community orphan P1 is fixed and retested. Whole-product Design QA remains `blocked`.

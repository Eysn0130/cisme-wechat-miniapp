# Bounded native capture procedure

1. This procedure is only for the disposable local synthetic boundary. Confirm the database is loopback `cisme_test`; never point the runner at staging, production or a real-user database.
2. Start `npm run miniprogram:acceptance`. It requires an explicit reset, binds only `127.0.0.1:18080`, loads schema 34 and synthetic fixtures, keeps payment unavailable, and writes a credential-free fixture manifest under `tmp/miniprogram-acceptance`.
3. Open `/Users/mini/CISME/cisme-r0-platform/apps/miniprogram` in WeChat DevTools, confirm AppID `wx4eac2d4fb11d299b`, base library `3.15.2`, develop mode and API origin `http://127.0.0.1:18080`. Use Account to explicitly accept the local fixture notice and perform the development login; do not inject a session token.
4. Before screenshots, require ready/legal/order-boundary checks, a stored session, the fixed synthetic development identity and one protected read. Approve project-action permission without changing business authorization, privacy checks or TLS validation.
5. Restart the project window at most once if the bridge is stale. If `waitForAutomatorReady` recurs, stop automation and use the built-in screenshot control.
6. Follow `routes.csv` with its exact synthetic queries. After the four-second window, assert current route, `loading=false` where exposed, and an empty page error. A redirect, spinner or missing-id page is a failed healthy capture.
7. Record application console/network errors separately from tool warnings; do not erase failed frames.
8. Record interactions from the first tap through the server-authoritative result; video FPS is not app FPS.
9. Exclude QR codes, personal data, tokens, complete OpenID/session keys, secrets and real conversations. This fixture is synthetic only.
10. Recompute checksums and stop the acceptance process after finalization. Full visual acceptance still requires interaction, responsive and physical-device checks.

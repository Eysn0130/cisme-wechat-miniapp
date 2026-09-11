# WeChat DevTools checkpoint — 405ae15c — 2026-09-01

Result: **blocked**. This checkpoint proves current-source local compilation and temporary public-HTTPS transport to one physical iPhone. The first session used the wrong Android target profile, so it is not iOS acceptance. Route matrices, correct-profile iOS traversal, Android, experience upload and release remain unproved.

## Bound source

- Source SHA-256: `405ae15c319e5d4c92d157edebf4c0a57f5ae0cd72741a9d0b27b0b97856efde`
- Package gate: 129 files / 13 routes / 1,301,625 bytes
- Global WXSS: 8,117 bytes
- WeChat DevTools: RC 2.02.2608031
- Base library: 2.32.3
- Simulator: iPhone X at 50%; screenshots are 1250×733 full-window JPEG diagnostics, not exact 375×812 page frames

## Current evidence

| Evidence | Bytes | SHA-256 | Observation |
|---|---:|---|---|
| `docs/evidence/visual/current-run/native/devtools-package-405ae15c-compile-0-problems-2026-09-01.jpg` | 112704 | `625773f6bc0971d0b4f2785668eba20f21eafdff5756fa69074599d17e20ae2b` | final compile, Problems total 0, no QR present |
| `docs/evidence/visual/current-run/native/devtools-package-405ae15c-console-0-errors-0-warnings-2026-09-01.jpg` | 105796 | `f1a74c6daff08faaeb4104313d67bef9f391e0d1ae7314163b2fd0b578790d87` | stable Debugger Errors 0 / Warnings 0, no QR present |
| `docs/evidence/visual/current-run/native/devtools-community-405ae15c-brand-editorial-2026-09-01.jpg` | 106269 | `1a112961c92045aa55541144e04281109aea794e30e89ad12795fbfe9eef11b1` | Community brand editorial, UGC gate off, local API through controlled tunnel; diagnostic only |
| `docs/evidence/visual/current-run/native/devtools-ios-405ae15c-remote-4g-connected-2026-09-01.jpg` | 49894 | `1ee01353566d21e58543a0a7dbfc4ad9b52d88782dc396c22f1f74a8633f9a69` | hardware iPhone 17 Pro Max / iOS 26.5.2 / WeChat 8.0.76 connected over 4G while DevTools warned the QR targeted Android; transport diagnostic only |

The first three files are real baseline JPEG at 1250×733; the hardware connection window is a real 1024×733 JPEG. `current-source-acceptance.json` binds all four with the byte sizes and digests above.

## Controlled remote true-device path

The local API remained bound to port 3100 and `/health/ready` returned ready with transaction profile unset and points redemption, public UGC and points rules disabled. A Cloudflare Quick Tunnel exposed that endpoint at a random `https://*.trycloudflare.com` origin for this short-lived development session. Quick Tunnels are development/testing infrastructure without an uptime SLA, not a production environment.

Runtime code accepts the remote origin only when all of these are true: physical-device platform, `envVersion=develop`, explicit `cisme_remote_debug=1`, and an origin-only `https://*.trycloudflare.com` value. DevTools, trial and release cannot consume the override. The private project configuration selected `CISME 异地真机调试`, disabled LAN mode, and generated a 262 KB QR expiring at 09:41 China Standard Time. The QR was shared only as an ephemeral operator artifact and is not committed or indexed as acceptance evidence.

An authorized hardware iPhone 17 Pro Max subsequently connected over 4G. DevTools reported iOS 26.5.2, WeChat 8.0.76, base library 3.17.2, normal service state and roughly 293–309 ms round-trip latency, but also warned that the session targeted Android. No business API request reached the tunnel. The mismatched session was ended and a corrected iOS-specific, LAN-off QR was generated with expiry 09:56 China Standard Time; it had not been rescanned at checkpoint time. Therefore the artifact proves remote transport discovery only and does not close iOS acceptance. No handset page-frame, route traversal, API Network trace or production identity was captured; iOS, Android, experience-version and release remain blocked.

## Engineering gates

- TypeScript: passed
- Unit: 9 files / 73 tests passed, including 9 remote-debug/release-boundary tests
- Package gate: passed
- Design QA structure: passed after current-source evidence rebinding; `releaseReady:false`

## Binding blockers

- no current structured Network trace;
- 0/13 route matrices complete and no formal same-state Web/native/comparison triplet;
- no valid iOS or Android acceptance; the first iPhone transport used an Android target profile and the corrected iOS QR still awaits scan;
- Account checked/enabled and current-hash button baseline not captured;
- production legal texts, AppID ownership/formal role, public production HTTPS domains and real WeChat identity remain unproved;
- public UGC remains closed; the feed DTO and controlled cover URL contract are incomplete.

Final result remains **blocked**.

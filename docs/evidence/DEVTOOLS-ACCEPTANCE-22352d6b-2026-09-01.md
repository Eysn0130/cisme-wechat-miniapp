# WeChat DevTools checkpoint — 22352d6b — 2026-09-01

Result: **blocked**. This checkpoint proves current-source local compilation and a controlled same-LAN true-device entry path; it does not prove a connected physical device, route-matrix completion, experience upload or release.

## Bound source

- Source SHA-256: `22352d6b73589eb023d67994312bb2bf4fcee9cbf1e82d3cfdb0ee6673ddc5cf`
- Package gate: 129 files / 13 routes / 1,301,126 bytes
- Global WXSS: 8,117 bytes
- WeChat DevTools: RC 2.02.2608031
- Base library: 2.32.3
- Simulator: iPhone X at 50%; screenshots are 1250×733 full-window JPEG diagnostics, not exact 375×812 page frames

## Current evidence

| Evidence | Bytes | SHA-256 | Observation |
|---|---:|---|---|
| `docs/evidence/visual/current-run/native/devtools-package-22352d6b-compile-0-problems-2026-09-01.jpg` | 107881 | `843ed74f8a065ca6da71140071e428f6a1c951910d88be12be9488914e478484` | final compile, Problems total 0, no QR present |
| `docs/evidence/visual/current-run/native/devtools-package-22352d6b-console-0-errors-0-warnings-2026-09-01.jpg` | 105513 | `f0cb4dbed1eae19dc0db908e770b0c823e10f1d2fb46c9abe44de21f314fd3a3` | stable Debugger Errors 0 / Warnings 0, no QR present |
| `docs/evidence/visual/current-run/native/devtools-package-22352d6b-community-brand-editorial-2026-09-01.jpg` | 106018 | `66b525ecb03fd61c0924bf685343b22553d2771112ba7f432a651cf496dd4c76` | Community brand editorial, UGC gate off, local API; diagnostic only |

All three files were checked as real baseline JPEG, 1250×733, with the byte sizes and digests above. `current-source-acceptance.json` references exactly these files and `design:qa:status` is structurally valid.

## Controlled same-LAN true-device path

The API listened on `0.0.0.0:3100`; both `http://192.168.31.68:3100/health/live` and `/health/ready` returned success. The ready response kept transaction profile unset and points redemption, public UGC and points rules disabled.

`npm run wechat:device-debug:configure -- --origin=http://192.168.31.68:3100` validated the private origin and ready response, then updated only ignored `project.private.config.json` with `useLanDebug:true` and the `CISME 真机调试` compile condition. Runtime code accepts this origin only for a physical-device `develop` session with explicit `cisme_remote_debug=1`; localhost/public HTTP/path origins and trial/release are rejected by tests.

WeChat DevTools was explicitly set to `CISME 真机调试`; Community compiled with Problems 0 and Debugger 0/0. The operator then clicked `真机调试`, enabled `局域网模式`, and generated a 262 KB short-lived QR. It remained waiting for an authorized phone; no non-local connection reached port 3100 before the QR panel was closed for non-QR evidence capture. The QR image was not saved or added to the manifest. This event is controlled setup evidence, not device acceptance, public preview, experience upload or release.

## Engineering gates

- TypeScript: passed
- Contract cross-check: 15 migrations / 29 tables / 23 paths / 15 events
- Unit: 9 files / 72 tests passed
- Integration: 5 files / 26 tests passed
- Production build: passed
- `npm audit --audit-level=low`: 0 vulnerabilities
- Package gate: passed
- Design QA structure: passed; `releaseReady:false`

## Binding blockers

- no current structured Network trace;
- 0/13 route matrices complete and no formal same-state Web/native/comparison triplet;
- no connected iOS or Android evidence;
- Account checked/enabled and current-hash button baseline not captured;
- production legal texts, AppID ownership/formal role, public HTTPS domains and real WeChat identity remain unproved;
- public UGC remains closed; the feed DTO and controlled cover URL contract are incomplete.

Final result remains **blocked**.

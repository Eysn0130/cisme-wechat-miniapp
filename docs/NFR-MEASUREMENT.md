# NFR measurement appendix

These are acceptance targets, not claims about an unmeasured production deployment.

| Area | R0 target | Measurement method | Current evidence |
|---|---|---|---|
| API correctness | zero invariant failures under specified concurrency | real PostgreSQL integration suite | 8 concurrent claims → one claim/submission; 6 approvals → one grant |
| Availability | 99.5% monthly after production launch | external probe on `/health/live` and `/health/ready` | not measurable locally |
| Read latency | p95 < 300 ms at 20 RPS | k6/staging with representative rows | pending staging account |
| Write latency | p95 < 800 ms excluding media transfer | k6/staging | pending staging account |
| Upload | 10 MB maximum, resumable by reauthorization | interrupted upload/device test; object HEAD/checksum | local retry and contract test passed; device pending |
| Recovery | RPO ≤ 24 h, RTO ≤ 4 h for R0 | scheduled backup and quarterly restore drill | local backup/restore scripts present; local drill required per release |
| Audit | 100% admin decisions and switch changes have principal, reason, version and trace | SQL reconciliation | integration tests cover review/switch audit |
| Security | production missing secret/credential fails startup | config tests | passed locally |
| Accessibility | text scaling, focus/keyboard behavior in admin; WeChat screen reader labels for controls | manual three-device checklist | pending credentialed devices |

Production load, weak-network and recovery measurements must record tool version, dataset, timestamp, p50/p95/p99, errors and raw output under `docs/evidence/`.

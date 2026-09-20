# NFR measurement appendix

Effective alignment: 2026-09-20, PRD V2.1-R4 §13 and NFR-01–04. These are acceptance targets, not claims about an unmeasured deployment. This update is not a signed G0 measurement contract.

The prior appendix's 800ms write target and 99.5% availability are superseded by the current PRD. Historical text remains in Git at `e1d31d877f36d9245c5844786a769319558cb546`. Prior RPO 24h / RTO 4h numbers are not treated as signed commitments.

| Area | Current PRD requirement / target | Measurement and remaining evidence |
|---|---|---|
| Correctness | Zero business-invariant failures under specified concurrency | Isolated PostgreSQL tests: ownership, versions, ordered care facts, idempotency, late responses and cancellation. Test counts are not proof of complete coverage |
| Core API / NFR-01 | P95 ≤500ms under the agreed baseline | Freeze methods, geography, dataset, load, sample size, window and timing boundary; separate server from client end-to-end latency. Staging report pending |
| Core page / NFR-01 | P95 ≤2s under the agreed baseline, excluding third-party payment/media upload | Critical action must be safely usable, not merely a placeholder. Separate cold/warm, iOS/Android, network and state; native device evidence pending |
| Weak network | At least 400ms RTT, 5% packet loss, upload interruption/recovery and offline repeat submission | Timely feedback, bounded waiting, no duplicate writes, recoverable state; report separately from normal-network cohorts |
| Capacity / NFR-03 | G0 low/base/high model, covering high demand with 30% headroom | DAU, peak QPS, media, content/comments, orders/refunds, review queues, messages; include API + worker + operational DB connections across instances |
| Availability / NFR-02 | ≥99.9% monthly is a conditional candidate, not an established SLA | Requires named operations coverage, fault-domain capability and budget. Define business SLI and eligible minutes; health probes alone do not prove business availability |
| Recovery / NFR-04 | G0 must agree RPO/RTO and recovery dataset; automatic backups and quarterly restore drill | Release-specific restore evidence required; scripts alone do not prove recovery |
| Media | Pagination, compression/CDN, first-screen/package budgets, public/private isolation | Endpoint-specific sizes, interruption, reauthorization, finish validation and device behavior; retry is not proof of byte-level resumability |
| Observability | request_id, business IDs, error codes, metrics, logs and traces | Bounded route-method coverage; timeouts/cancellation/retries, pool/SQL/storage and device phases. No tokens, personal data, message bodies or signed URLs |
| Security/privacy | HTTPS, authorization, validated files, signatures, rate limits, secrets/dependency governance | Current enabled capability scope; subject × object × field × action tests; switches alone do not establish production readiness |
| Accessibility | Readable text, explicit states, focus/keyboard, recoverable errors, more than color alone | Native reader/control semantics, scaling, safe areas, keyboard, navigation and reduced motion; device evidence pending |

## G0 measurement contract to complete

Record owner/signature/date; core API/journeys; SLI numerator/denominator/exclusions; deployment/region/device/WeChat/base-library versions; network; cold/warm definitions; data volume/version; concurrency and arrival model; sample count and percentile window; timeout budget; upload/payment separation; operations coverage; RPO/RTO and recovery dataset. Do not invent sign-off or weaken the PRD.

Suggested sampling, subject to the contract: at least 100 valid actions per device/network/startup/journey cohort and 1,000 requests per core API scenario, plus sustained and stepped load. Insufficient samples must be marked exploratory. Never average instance percentiles or mix weak/normal networks to hide failures.

## Evidence discipline

Attach commit, package SHA-256, build, environment, dataset, timestamp, tool versions, raw output, p50/p95/p99, error rate, timeout/cancellation counts, volume and excluded cases. In-process `app.inject` does not measure DNS/TLS/mobile networks or rendering. Old simulator screenshots and latency numbers remain scoped to their original package/environment.

See [the current research and construction plan](CISME-NATIVE-PERFORMANCE-UX-RESEARCH-2026-09-20.md). No full-device or production NFR pass is asserted.

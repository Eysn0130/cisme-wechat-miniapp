# R0 threat model

Method: STRIDE-style review of identity, qualification, care, upload, review, points, feed and operations.

| Threat | Boundary / asset | Mitigation in this slice | Remaining release work |
|---|---|---|---|
| Forged member identity | WeChat code → member | server-side `jscode2session`, signed short-lived session; dev adapter forbidden outside dev/test | AppID/Secret, domain and device verification |
| Forged purchase/qualification | adapter → qualification fact | source + external ref uniqueness; production rejects dev adapter | select transaction/qualification supplier and signed/pull evidence |
| Task enumeration / IDOR | task/submission/media | server UUID and `member_id` object checks; unauthorized returns not found | rate limits and WAF policy |
| Claim race | task capacity and submission | serializable transaction, row lock, unique constraints, idempotency record | staging load test |
| Upload tamper / oversized media | device → object storage | signed 10-minute authorization, MIME/size conditions, server HEAD/checksum, generated key | malware/content safety supplier and HTTPS allowlist |
| Duplicate evidence | media/link | unique normalized post URL and uploaded content hash | perceptual duplicate policy if legally approved |
| Reviewer impersonation / overreach | admin API | token + principal, RBAC, version, reason, audit | enterprise IdP, MFA, key rotation, session expiry |
| Double reward / ledger rewrite | review/outbox/points | unique submission reward, serializable approval, unique business key, append-only trigger, replay tests | finance-approved rules and reconciliation |
| Revoked content remains visible | consent → feed | revocation transaction hides feed and blocks new use | legal retention/deletion SLA |
| Event replay / reordering | worker | business-key uniqueness and current-state checks | dead-letter alerts and replay runbook in staging |
| Secret leakage | config/logs | environment injection; response redaction; production fail-closed | managed secret store and log scanner |
| Emergency shutdown coupling | incidents | four independent identity/upload/review/reward switches | on-call ownership and tested operational access |

Out of scope is not risk acceptance: payments, public UGC, content safety, logistics and public release remain closed, so their unresolved threats are G0 blockers rather than P2 work.

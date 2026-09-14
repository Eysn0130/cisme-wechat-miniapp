# Permission and data access matrix

| Operation | Member | Reviewer | Review lead | Auditor | Support | Object check / field rule |
|---|---:|---:|---:|---:|---:|---|
| Create identity/acceptance | self | — | — | — | — | WeChat/dev adapter boundary; required document versions |
| Read care/tasks/submission/points/consents | self | — | — | — | — | `member_id` must equal signed session member |
| Activate/pause/resume/terminate/complete care | self | — | — | — | — | owned cycle; transition and clock enforced |
| Claim task | self | — | — | — | — | owned, unexpired task; idempotency + unique claim |
| Upload/delete media | self | — | — | — | — | owned draft/needs-changes/appealed submission; MIME/size/token |
| Submit/appeal/revoke | self | — | — | — | — | expected version; explicit purpose grant |
| Read review queue | — | yes | yes | yes | — | sensitive member identifiers excluded from queue projection |
| Request changes/reject/approve | — | yes | yes | no | no | expected version, reason code and evidence required |
| Toggle emergency switches | — | no | yes | no | no | audited before/after state and reason |
| Read audit log | — | no API in R0 | no API in R0 | direct controlled DB only | no | field-level API intentionally absent |
| Read public feed | read-only | read-only | read-only | read-only | read-only | only visible, reviewed, licensed, non-revoked items |
| Approve synthetic profile export | — | no | second reviewer only | no | no | `APP_ENV=test`, separate test key, `dev_test` identity, current version, fixed profile subset; never production apply |
| View/revoke synthetic profile export | self | — | — | — | — | signed active member, exact request owner, unexpired/unrevoked private artifact; audited; no full-account export claim |
| Approve synthetic profile-handle erasure | — | no | second reviewer only | no | no | immutable member-requested scope, active synthetic policy, no legal hold, test environment and dev_test identity; only profile row is affected |
| Redrive exhausted synthetic privacy job | — | no | yes | no | no | fixed scope, current request version, policy/hold recheck where applicable, reason and audit; production path disabled |

Legacy `/v1/admin/*` routes now require a signed, active operator session. `x-admin-token` grants no access, and `x-principal-id` cannot replace the session actor. The existing role checks remain in each operation. The browser operator console still lacks an approved production login/session-issuance flow; enterprise identity and MFA remain deployment gates, not implemented controls.

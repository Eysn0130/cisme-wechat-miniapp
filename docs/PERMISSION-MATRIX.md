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

Admin authentication currently uses an environment token plus principal ID for local integration. Production must replace it with an enterprise identity provider, MFA and short-lived role claims before deployment.

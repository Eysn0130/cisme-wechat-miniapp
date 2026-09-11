# R0 entity relationship model

The SQL migration is authoritative; this view highlights the first vertical slice.

```mermaid
erDiagram
  MEMBER ||--o| WECHAT_IDENTITY : owns
  MEMBER ||--o{ CONSENT_ACCEPTANCE : accepts
  MEMBER ||--o{ QUALIFICATION_FACT : receives
  QUALIFICATION_FACT ||--|| CARE_CYCLE : plans
  CARE_CYCLE ||--o{ CARE_RECORD : records
  CARE_CYCLE ||--o{ ELIGIBILITY_DECISION : evaluates
  ELIGIBILITY_CAMPAIGN ||--o{ ELIGIBILITY_DECISION : governs
  ELIGIBILITY_DECISION ||--o| ELIGIBILITY_TASK : creates
  ELIGIBILITY_TASK ||--o| TASK_CLAIM : claimed_as
  TASK_CLAIM ||--|| SUBMISSION : starts
  SUBMISSION ||--o{ MEDIA_OBJECT : contains
  SUBMISSION ||--o| REVIEW_CASE : reviewed_in
  REVIEW_CASE ||--o{ REVIEW_ACTION : records
  REVIEW_CASE ||--o{ APPEAL : receives
  SUBMISSION ||--o| REWARD_CLAIM : earns
  REWARD_CLAIM ||--o| POINTS_GRANT : grants
  POINTS_GRANT ||--|| POINTS_LOT : allocates
  POINTS_GRANT ||--o{ POINTS_ENTRY : posts
  MEMBER ||--|| POINTS_PROJECTION : projects
  SUBMISSION ||--o{ CONSENT_GRANT : licenses
  CONSENT_GRANT ||--o| REVOCATION_REQUEST : revokes
  SUBMISSION ||--o| FEED_ITEM : publishes
```

Cross-cutting tables are `outbox_event`, `idempotency_operation`, `principal_role`, `audit_log` and `emergency_switch`. Server-generated UUIDs and uniqueness constraints are the authority; clients do not allocate business identifiers.

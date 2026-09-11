# ADR 0005 — points, feed and revocation

Status: accepted, 2026-08-14.

Points are an append-only entry stream plus lots and a derived projection. Approval creates one frozen grant; availability or spending is not part of this slice. Database constraints, a no-update/no-delete trigger, unique business keys and review/reward uniqueness are authoritative.

Public UGC is closed. The worker may create only a reviewed, purpose-licensed, non-revoked read-only feed item. Revocation creates a separate request, immediately hides future feed use and blocks the grant for new use while preserving review, audit and ledger history. Historical facts are never deleted by an event replay.

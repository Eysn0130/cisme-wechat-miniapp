# CI savepoint recovery correction — 2026-09-20

Candidate `9c31b933d8b914b9c99c139a32fe9e2784f603db`, Actions run `35543731617`, artifact `10615559087` (`cisme-r0-evidence`). The downloaded artifact ZIP SHA-256 is `a3acf511d8f17bde8856c87523b98e9b64b08277cf05ed224e7f7922f3fdd699`.

The actual artifact `test-integration.log` reports **562 passed / 7 failed (569 tests, 36 files)**. The new seven real PostgreSQL deadline/connection fault cases passed, but do not substitute for the existing suite. Five vertical-slice and two worker-delivery cases failed: after a SQL constraint failure, the new per-statement timeout setup inserted a SELECT before ROLLBACK TO SAVEPOINT; PostgreSQL correctly rejected it in the aborted transaction. Later vertical-slice failures followed missing earlier facts.

Repair: let ROLLBACK statements reach PostgreSQL without prepending set_config. The same absolute budget, cancellation listener and query serialization remain active. Subsequent normal SQL still gets the remaining statement/lock budget. No business test, timeout target, authorization or transaction assertion is removed or relaxed.

A formal unit regression failed with SQLSTATE 25P02 before this change and passes after it. A real PostgreSQL savepoint/constraint-recovery test asserts both the pre-savepoint and recovered facts; full integration and performance still require the new commit's CI, not the failed run above. Source-only native package hash is unchanged by this backend correction. `releaseReady=false`.

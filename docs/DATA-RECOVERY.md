# Backup, migration and recovery

## Database

Migrations are ordered SQL and run transactionally. Empty-database and rollback/reapply tests are release gates. N-1 compatibility in R0 means the latest migration can be rolled back locally and reapplied before any irreversible production data migration is approved.

`npm run backup` writes a timestamped custom-format `pg_dump` under the explicit `CISME_BACKUP_DIR` or `./backups`. `npm run restore:verify -- /absolute/path.dump` restores to an isolated `cisme_restore_verify` database, queries the migration table and removes only that disposable database.

Production policy target: daily encrypted backup, RPO ≤ 24 hours, RTO ≤ 4 hours, quarterly restore drill, checksum and row-count reconciliation. Provider retention and cross-region copy remain production-cloud decisions.

## Objects

Database `media_object.object_key`, byte count and checksum reconcile to object storage. A storage export must preserve keys and checksums. Revoked or deleted media follows the approved legal retention schedule; this schedule is an external legal blocker.

## Recovery order

1. Stop identity/uploads/reviews/rewards independently as needed.
2. Preserve database, object and logs; record trace and incident times.
3. Restore database to an isolated environment.
4. Reconcile migrations, members, submissions, grants, points conservation and outbox.
5. Restore or relink objects by key/checksum.
6. Replay unprocessed outbox events; verify no duplicate grants/feed.
7. Re-enable one switch at a time with audited reason.

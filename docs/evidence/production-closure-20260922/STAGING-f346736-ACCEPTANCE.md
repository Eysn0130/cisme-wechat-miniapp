# Exact staging candidate f346736

Only staging lhins-ei4hz4fi / 150.158.39.74 / staging-api.cisme.cn changed. Run rc20260922-35bce2d8 owns the new database cisme_accept_rc20260922_35bce2d8, its _baseline and _restore databases, and /opt/cisme/tmp/rc20260922-35bce2d8 object directory. Existing databases and production were not reset, seeded, replaced or deleted.

Source f346736d379e9d8b177426f17ffb58a4e4e32cca; tree 1faa782a8546c9b090ab96072f3318812b04f783. CI35807929752 success: 1122 unit / 102 files, 835 integration / 48 files, 52 Python checks. The CI checkout was synthetic merge 1fca0eccc66841dff8c8839167a450438e14b053, with the same tree; this does not mean main was merged. Preview/design were skipped and no physical device was accepted.

Artifact tmp/tencent-release-f346736d379e.tar.gz: 441202 bytes, SHA256 6c6d91286e62152b6fd3307e346a3b98775ee65baa094d81fc780aba0230be61. It contains 82 hashed artifacts plus release-manifest.json, 76 SQL migrations, API and workers. No PC Admin or runtime credentials. Local immutable-bundle rehearsal applied 76, repeated 0, health200 / unauthenticated metrics401 in a newly owned PG/S3 run which was cleaned.

Actual staging release is /opt/cisme/releases/rc20260922-35bce2d8-f346736d379e. Candidate preparation verified artifact hashes, applied 76 migrations and repeated zero; activation checked HTTPS200, protected metrics401 and the existing staging-only policy versions. Real money remains disabled. These documents are not production-approved policies.

Executed evidence:

- 20 synthetic HTTP business assertions and 23 private,no-store checks, including aftersale session denial, owner empty list, capability-only management queue and immediate revocation. These new staging aftersale probes are authorization/empty-state probes, not the full return/refund lifecycle; the latter was exercised in local PG16/18 integration tests.
- PostgreSQL16.15 baseline 23→76: synthetic legacy member/consent/request preserved, injected migration-journal failure rolled back, repeated migration applied zero.
- Backup restored into this run's distinct _restore database: 76 migration rows, 131 tables and matching selected business counts/digest. Local object marker backup/restore matched. This is not COS, production-role or production-key recovery.
- Five-minute stability: 61 samples, health200, API/Worker active/running with zero restart counts.
- Actual application rollback f346736→202653d→f346736 used the same new database and object root. A write and object created after the backup remained readable/present in both versions. No database backup restoration or down migration was used.
- Existing read-only monitor pinned to f346736; service Result=success. External alert delivery is still unverified and has no approved recipient.

Raw downloaded receipt STAGING-f346736-RAW.json: 25715 bytes, SHA256 27e47586145f8ca02db6fcfb572fc6d59ea8743bbeaf2b1a9d0773e03145f811, matched to the server-produced digest. Exact executed inputs and CI/local bundle binding are under staging-f346736-inputs/.

A separate TLS-validating request from staging at 2026-09-23T02:10:13Z resolved production api.cisme.cn to 124.223.74.198 and was unreachable (URLError). At 02:10:21Z staging resolved to 150.158.39.74 and returned200. This repeats a production external-path problem but does not establish its sole cause. It is not a claim that the staging host is production.

No production release, main merge, live payment/refund, formal policy approval, COS recovery, full 13-dimension all-entry acceptance, physical-device acceptance or WeChat release occurred. Old cisme_test remains UNKNOWN / 未恢复.

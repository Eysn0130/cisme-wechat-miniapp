# staging f4c8df9 — exact candidate acceptance

Target lhins-ei4hz4fi / 150.158.39.74 / staging-api.cisme.cn. Never production. Run rc20260922-c8e5a26d activated source f4c8df9e5be091b246e9893b1c357bc004d943b0, tree 85f77830c8234403672108d9f905b6777b0e575a, after successful exact CI 35799462097. CI: 1086 unit / 818 integration / 52 Python checks; credentialed preview and candidate design gates skipped, not device acceptance.

Artifact tencent-release-f4c8df9e5be0.tar.gz: 435190 bytes, SHA256 1a075a3792b8035f3e0bcf8ca0de532311785a6e69bccf9a16ebe4573d360d49. Complete verifier checked 81 artifacts / 75 migrations. No PC Admin artifact. Prepared c63768a candidate was never activated after its native evidence resolution gate failed; its owned resources remain separate.

Fresh database cisme_accept_rc20260922_c8e5a26d; restore database uses its `_restore` suffix. Original staging database cisme_accept_rc20260922_690f9382 untouched. Local object storage only. Normal-certificate public HTTPS health 200; unauthenticated metrics 401. Published staging policies remain terms v4-staging / privacy v7-staging-support, not approved production policies.

15 actual synthetic HTTP checks passed: privacy owner isolation, deduplication and version race; native privacy capability grant/revocation and denied write having no effect; order capability revocation; real-money gate remaining disabled. Tokens were generated only in process memory for the owned synthetic test. This does not verify real WeChat identity or merchant services.

Fresh backup restored 75 migrations / 129 tables, 2 members, 1 privacy request, 3 privacy events, 6 audit events, 2 revoked grants, 2 legal documents and 1 marker. Synthetic business row digest matched. Backup SHA256 89206f170e8077d4258225fae6e95f327e520d78451a3295973150d91d9dd677. Local object marker copied and verified, **COS restore unverified**.

61 health samples from 2026-09-23T00:03:36Z to 00:08:37Z: health 200, both API/Worker running, restart counters zero. This is a five-minute sample, not a long-duration SLO claim. Monitor's old source pin correctly failed after activation; exact old script hash was verified and backed up, only expected SHA changed. New monitor SHA256 d21bea1cd312d20c0d0aad18b5b863c40330b0ca5934e5e4cb458fbc3ed52c67; service Result=success. External alert delivery remains unverified.

Raw receipt downloaded through authenticated Tencent OrcaTerm: STAGING-f4c8df9-RAW.json, 23458 bytes, SHA256 bff765d75f7849ba9cd1ec28d561afc285776f8d3d4b9ce02e4033efd9c51842. Secret configuration was not included. A subsequent actual application rollback exercised f4c8df9 → 2df3018 → f4c8df9 with the SAME current owned database and object root. A new post-backup privacy request and object remained readable/unchanged in both versions. No database restore or down migration. Monitor returned Result=success after the current candidate was restored. STAGING-ROLLBACK-f4c8df9-RAW.json was transcribed from the observed OrcaTerm JSON and checked against the host file: exactly 527 bytes / SHA256 1a3e82851b021656ce33fce75f4e643f463c355e3c4e4b5f6ef49f4a7cdd3898. This does not verify production schema/application rollback compatibility.

production untouched. Main not merged. Full acceptance and releaseReady remain false. Old cisme_test accident: impact UNKNOWN / not recovered.

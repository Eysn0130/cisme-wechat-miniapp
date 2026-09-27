# Staging candidate 2df3018 — bounded live acceptance

Target: lhins-ei4hz4fi / VM-4-15-ubuntu / staging-api.cisme.cn, never production. Source 2df301818c550ae6d19649d44f785d02fb58b276, tree 4b9aa15850e5728556071b9c92a58c63068b319f; exact successful CI 35750330009. Artifact tar SHA256 6f6cc7cb51aad235282be0bb70d1fa18ee597860a07b43facd03ae910caf155a; 435015 bytes. Full artifact verifier: 75 migrations / 81 files. No PC Admin release files.

The uploaded wrapper ran with SHA256 7dd582117d3bc4e5816d282a2a7ed864104ba7bf1dd9e3b143792cb8c1354e72. Its later local source resolves the base script as a sibling instead of hardcoded /home/ubuntu; do not equate those byte hashes. Base script hash remains pinned and full migrate.mjs verify is required before prepare/activation.

## Live candidate

- Owned run rc20260922-690f9382; DB cisme_accept_rc20260922_690f9382, role cisme_staging; local objects /opt/cisme/tmp/rc20260922-690f9382/object-storage. Original prior staging DB/release retained.
- API and Worker activated at /opt/cisme/releases/rc20260922-690f9382-2df301818c55. Real commerce and dev adapters remain disabled.
- Actual PG16.15: 75 migrations, second application 0; synthetic 23-migration baseline forward migration preserves member/consent facts; injected journal failure leaves 23 migrations and no partially created table.
- 10 actual HTTP synthetic checks: anonymous denial, privacy dedup/owner isolation/operator denial/version race, truthful response versus execution, authorized management order read, immediate revocation/projection removal, real-money gate remains off. Tokens stayed only in process memory. This is not real WeChat login or complete commerce acceptance.
- Database restore compares 129 tables, 75 migrations and synthetic business facts/digest. Local object marker restored. This is not COS restoration, cluster-role recovery, or old cisme_test recovery.
- 61 HTTPS/service observations, 16:02:23–16:07:24 UTC (301 seconds), all ready; API/Worker running, restart counters 0. Bounded sample, not prolonged production stability. Public paths ready/legal/capability 200; unauthenticated metrics/me 401.
- Production host independently resolved staging-api.cisme.cn to 150.158.39.74 and validated HTTPS 200 at 16:05:29 UTC. The same probe of api.cisme.cn failed with URLError; this does not by itself prove a unique cause.

## Rollback preserving new writes

First script (9bb818b11ac79aa2347e8514568cdc64f77722fd2659f2aa314fabd3ab1bb43c) failed before service switching: synthetic INSERT omitted required due_at. Candidate and both services remained active; failure marker retained.

Corrected script d984e53e0e49a6899ec965ed3399398edd8cf6084d69b3c2ac03c5f5c872be61 used a separate v2 attempt. A synthetic request and local object created after the backup remained readable through actual API/Worker switch to prior 0f1b4c346173ed26d6ffd3d6e3612ef893b14212 and return to 2df3018. Both used the same current new DB/object root; no down migration or old DB restore. This does not validate production's older binary/schema combination.

Staging monitor was still pinned to prior SHA and correctly failed after activation. After checking old script hash and preserving it, only expected source SHA changed. New script hash 820afaf4dd2dbf6550c1bd837bcdf685db82741d810017e30c0494ce434cae33; service Result=success after activation and after rollback return. External alert delivery remains unconfigured/unverified.

Raw receipts: STAGING-2df3018-RAW.json (SHA256 71e99c11e6c01b3caf2e3003e5ee6df7ce9339bbb1bddccca14792abbecc95a1); STAGING-ROLLBACK-2df3018-RAW.json (be65e27c530b526bb2612bba4c9c90b429cb322a9a44dafbf633371fc8cf9ef9). Downloaded from authenticated Tencent OrcaTerm; secret fields omitted before export.

Production credentials, firewall, permissions, database and deployment were not changed. Old cisme_test incident: UNKNOWN / 未恢复. Full source, platform, COS, device and production acceptance remain open.

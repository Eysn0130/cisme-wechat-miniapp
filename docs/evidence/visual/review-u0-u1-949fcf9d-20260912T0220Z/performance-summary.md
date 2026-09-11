# U0/U1 performance evidence

Exact Mini source: `949fcf9da6d4777d17eab31ba42b46394d9268fed3c30bbab09fc5533759ad99`.

| Concern | Before | After | Evidence / limit |
|---|---:|---:|---|
| Order-list business SQL | `1 + 2N` (41 at 20; 101 at 50) | exactly 2 at limits 20 and 50 | Isolated PostgreSQL integration test; list address reads/decryptions are 0 |
| Empty support poll with 21 visible messages | 1 `setData`, 5,966 UTF-8 bytes | 1 `setData`, 333 bytes; message-array identity preserved | DevTools runtime wrapper; 94.42% payload reduction |
| Healthy visible polling | 12 requests/min | 12 requests/min | Required 5-second incremental refresh retained |
| Sustained failed polling | 12 requests/min | 2 requests/min at 30-second cap | Bounded 5/10/20/30-second backoff, maximum one in flight |
| Hidden-page polling | behavior had lifecycle races | 0 requests/min after hide; stale results discarded | Page lifecycle regression tests |
| Three-line composer | fixed assumptions could overlap | composer 390×144 px; thread bottom 144 px; notice bottom 156 px | 484×1048 DevTools simulator; physical keyboard remains unverified |

The observed 1,920 ms before and 2,311 ms after command round trips include DevTools automation and CLI transport, so they are deliberately excluded from API-latency claims. Staging/public-network latency, pool wait, 4G content P95, cold/hot start and scrolling long-frame metrics are `UNVERIFIED` until the corresponding environment/device sessions exist.

# Query-plan and hotspot evidence — 2026-09-10

Scope: local PostgreSQL 18.4, synthetic `cisme_test` only. This is not staging or production evidence.

## 100k fixture observations

The pre-counter community summary scanned the full hotspot on every request:

| Shape | Plan | Actual rows | Buffers | Planning | Execution |
| --- | --- | ---: | ---: | ---: | ---: |
| reaction like/save counts | sequential scans + hash join to active members | 26,617 | 1,281 shared hits | 1.485 ms | 39.906 ms |
| published comment count | sequential scans + hash join to active members | 20,000 | 1,457 shared hits | 0.528 ms | 18.377 ms |
| first 51 comments | `community_comment_post` + member PK nested loop | 51 | 212 shared hits | 0.185 ms | 0.610 ms |

Under 50 mixed in-flight requests this repeated aggregate work produced SQL P95 249–293 ms and request P95 515–628 ms. That evidence caused migration `202609100004_community_post_stats.sql`; no cache or weaker consistency was used.

After the migration, exact counts are read from a PostgreSQL-authoritative row updated in the interaction transaction:

| Shape | Plan | Actual rows | Buffers | Planning | Execution |
| --- | --- | ---: | ---: | ---: | ---: |
| exact post aggregate | `community_post_stats_pkey` index scan | 1 | 2 shared hits | 0.238 ms | 0.028 ms |
| first 51 comments | `community_comment_post` + member PK nested loop | 51 | 214 shared hits | 0.433 ms | 0.232 ms |
| first 21 visible Feed items | `feed_item_visible_page_idx` + PK joins | 21 | 155 shared hits | 1.629 ms | 0.737 ms |

The final 100k full-mix matrix improved 50-concurrency request P95 to 57.58–104.09 ms and SQL P95 to 6.41–14.63 ms across three rounds.

After the later final 199,099-request full-mix soak, the transactional counters still reconciled exactly to source rows: 19,875 likes, 6,667 saves and 20,000 published active-member comments.

Fixture relation sizes at observation time were: `member` 8,248 KiB table / 4,312 KiB indexes; `community_comment` 3,408 / 4,368 KiB; `community_reaction` 2,000 / 2,064 KiB; `feed_item` 776 / 768 KiB; and `community_post_stats` 8 / 16 KiB. All reads were cache-warm (`shared hit`); disk-read and production I/O behavior remain **UNVERIFIED**.

## Queue and index decisions

With 10,000 processed Outbox rows and 100 ready rows, the ready query used `outbox_event_worker_ready_idx`, returned 50 rows in 0.097 ms, read 53 shared-hit buffers, and used a 35 KiB in-memory quicksort with no spill. The index keys now preserve queue priority (`next_attempt_at, occurred_at, id`) and carry `event_type` as an included filter column. The media-cleanup index likewise preserves `next_attempt_at, created_at, id` and includes `leased_until`.

Two proposed indexes were removed after source/query-shape review:

- `community_reaction_post_kind_idx`: the hot post-wide count was replaced by transactional counters; personalized state uses the existing `(member_id, post_id, kind)` primary key.
- `review_case_pending_queue_idx`: no live queue ordered or filtered by its `(updated_at,id) WHERE status...` shape; keeping it would add write amplification without serving a query.

`tests/integration/query-plan.test.ts` now runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against synthetic populated tables and asserts the intended points, care, eligibility, consent, Feed, comment, comment-like, review-action, community-stats, Outbox, and cleanup indexes. Production row estimates, cold buffers, disk reads, sort spill, index-build duration, lock wait, and write amplification under production traffic remain **UNVERIFIED** and are staging/Deployment Gate requirements.

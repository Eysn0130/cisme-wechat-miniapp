# CISME Commercial Chat UX Contract

Status: implementation contract
Baseline: PRD V2.1-R4.1 §2.1, §3.3, §4, §14–§15
Scope: native WeChat Mini Program member support and mobile management support conversation
Decision order: PRD/business facts → native Mini Program constraints → mobile UX → visual polish

## Product promise

The conversation must let a member answer four questions without inference: who is replying, whether the reply is AI or human, whether the member message reached CISME, and whether a human actually read it. Presence, typing and read labels are server facts, never decorative claims.

## Authoritative state contract

| State | Member header | Dot | Authority |
| --- | --- | --- | --- |
| `ai_active` | `CISME AI 助手` | plum | persisted conversation status |
| `waiting_human` | `等待人工客服` | amber | persisted conversation status |
| `human_active` + unexpired operator heartbeat | `{operating alias} · 人工客服已接入` | green | assignment plus `support_presence.online_expires_at > server_time` |
| `human_active` without unexpired heartbeat | `人工客服处理中` | neutral plum | assignment only; no online claim |
| `resolved` | `本次服务已结束` | gray | persisted conversation status |

An operating alias is independent of administrator WeChat identity. The fallback alias is `CISME 客服`; a seeded/local acceptance profile may use `小熹`. AI does not regain send authority when a human becomes idle. A late AI result must fail the existing publish-time status/ownership check and can only become an operator-reviewed draft.

Message facts are separate:

- `local_pending`: client-only optimistic item; label `正在发送`.
- `server_accepted`: the immutable message row was committed; label `已发送`. This is not delivery-to-device and not read.
- `read`: the opposite party's monotonic read cursor covers the sequence; label `已读`.
- `failed`: the POST has no accepted response; original body and client message id remain; label `发送失败 · 重试`.

The synchronization watermark advances only from a message-list response. A send acknowledgement may update the displayed maximum sequence but never the sync watermark. Regression case `100 known → 101 remote unseen → own ACK 102 → next sync` must retain 100, 101 and 102 on both clients.

## Presence and typing

- Dedicated ephemeral storage is keyed by conversation and actor kind; it does not mutate the hot conversation row and is excluded from message history/model projections.
- Foreground conversation pages heartbeat at most once per three seconds. Operator online TTL is 10 seconds. Typing TTL is 9 seconds.
- Empty input, successful send, page hide/unload, assignment loss and session/capability change explicitly stop typing. Network loss is bounded by TTL.
- No Redis, WebSocket, fake typing timer or estimated response time is introduced in this slice.
- Polling is single-flight: approximately 2 seconds during recent activity/typing and 5 seconds while idle, with bounded failure backoff; hidden pages issue no polls.

## Message presentation

- Identity classes are member, AI, human and system. Member messages are right-aligned with no repeated `你` label or avatar. AI/human messages are left-aligned with a 68rpx branded avatar and a visible role label at the start of a group. System events are centered, not rendered as agent bubbles.
- Consecutive messages group only when identity is equal, both timestamps are valid and the gap is at most five minutes. Same-group spacing is 10rpx; sender changes use 26rpx.
- A time separator appears for the first message, date changes, or gaps over five minutes. Group-end metadata uses the server `createdAt`, formatted in the client timezone. Invalid/missing server timestamps show no invented time.
- Member bubbles use Plum at no more than 74% width. Human bubbles use white plus a subtle border. AI bubbles use a restrained Lilac tint. Status is text plus color; color alone never carries meaning.
- While the reader is away from the bottom, incoming items do not change the scroll anchor. A chip shows the exact count and moves only on explicit activation. Older-page loads anchor the previous first item.

## Composer and attachments

- Natural/dynamically measured layout: one rounded Composer surface with a top-left textarea and bottom-right actions. The member order is `图片`, `关联订单`, `发送`; operator reply remains text-only because the operator message contract does not accept uploads. Controls have 44px targets, the empty field reserves about three lines, lines four through six expand upward, and longer input scrolls inside a capped textarea. Safe-area padding and a distinct focus border remain outside the text hit area. Typed text is never cleared by upload, poll or unrelated failures.
- The image action opens only `从相册选择` and `拍照`; the paperclip action opens only the currently supported owned-order attachment. Both sheets include `取消`; 220ms translate/opacity motion is nonessential. Reduced-motion behavior remains a physical-device validation item.
- Image flow is explicit: privacy authorization → `wx.chooseMedia` with the requested source → local preview → MIME/size validation (JPG/PNG/WEBP, 5 MiB) → authorized object key → upload progress/state → server content verification → immutable message reference. A failed image stays separately retryable/removable and does not fail the text draft.
- A support media row is owned by one member conversation. Temporary device paths never reach the database. The upload token binds media id, object key, MIME, size and expiry; completion verifies magic bytes and storage metadata. Unsaved/failed/orphaned objects enter the existing cleanup workflow.
- The order selector reads only the signed-in member's orders. Sending stores `linked_order_id` plus a minimal immutable display snapshot (product label/image, order-number tail, status, currency/amount). The server rechecks membership. Management navigation uses the authoritative management order-detail route and capability check.
- Media preview is an authenticated member/operator endpoint; object keys and permanent credentials are never returned to the Mini Program.

## Interaction limits and recovery

Primary interaction set (8): send/retry, request/claim human, type/stop, jump to new messages, load history, open attachment sheet, choose/remove/retry image, choose/open order. Important states (10): loading, empty, AI, waiting, assigned-offline, assigned-online, typing, resolved, send failure, attachment failure. Network/presence failures are inline and recoverable; a toast is supplementary only.

## Accessibility and responsive behavior

- Minimum 44px interactive targets; body/secondary text meets WCAG AA on its actual surfaces; all status dots have adjacent text.
- Names, metadata and controls wrap without overlapping the WeChat capsule. Large text can increase composer and header height; scroll space follows measured height rather than a fixed guess.
- Images have meaningful labels and explicit preview/remove controls. Typing animation is nonessential; text remains visible if animation is disabled.
- Simulator evidence can verify structure and state transitions. Physical keyboard, screen reader, iOS and Android results remain `UNVERIFIED` until authorized-device sessions exist.

## Visual tokens

Plum `#56306F`; deep ink `#352A3A`; muted text `#75697A`; Lilac `#EEE4F2`; pearl surface `#FFFCFF`; line `rgba(78,47,91,.12)`; presence green `#2F7D5A`; waiting amber `#A66518`. Motion: message 140ms, sheet 220ms, pressed 100ms, typing 720ms loop. These values may be tuned only after native-device evidence and may not change state semantics.

## Reference implementations reviewed (behavior only)

- Chatwoot, commit `2f1ed80f894ed9a3eba636ebab90ca61deec110a`, MIT Expat outside its enterprise directory: `app/controllers/api/v1/widget/conversations_controller.rb` and `app/controllers/api/v1/accounts/conversations_controller.rb`. Borrowed separation of typing toggles and last-seen/read updates, plus write-throttling rationale; no Chatwoot code or deployment is included.
- Tencent TDesign MiniProgram, commit `faaa4bbe4453909ee2d6683cbc958e546f426899`, MIT: `packages/components/upload/type.ts` and `packages/components/upload/upload.ts`. Borrowed explicit `loading/reload/failed/done`, progress, source, preview and remove behavior; no TDesign dependency or visual theme is added.
- WeChat native APIs remain the engineering authority: `wx.chooseMedia`, `wx.previewImage`, `wx.uploadFile`, textarea keyboard events, `scroll-view` and privacy authorization. CISME retains native WXML/WXSS and its existing design tokens.

## Acceptance IDs

`CHAT-COR-01` sync watermark; `CHAT-COR-02` idempotent send; `CHAT-PRE-01` online TTL; `CHAT-TYP-01` typing throttle/TTL/stop; `CHAT-READ-01` cursor-backed receipt; `CHAT-VIS-01` grouping/time/identity; `CHAT-SCR-01` history anchor/new-count; `CHAT-CMP-01` multiline/safe area; `CHAT-MED-01` secure image lifecycle; `CHAT-ORD-01` owned order card; `CHAT-HOF-01` system handoff event/CAS; `CHAT-ADM-01` operator symmetry. These are supplemental implementation IDs and do not replace canonical PRD acceptance language.

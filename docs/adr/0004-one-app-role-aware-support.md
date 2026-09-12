# ADR 0004 — One App role-aware authority and Support foundation

Status: Accepted for local R1/R2 implementation; not deployed

## Context

CISME has one WeChat member identity, one PostgreSQL database and one Fastify API. The existing `member_team_access` and `principal_role` paths support legacy review/admin operations, while the browser Admin uses a separate internal token. Neither is a suitable long-term authorization contract for fine-grained mobile operations. Chatwoot is useful as a reference for inbox, conversation, assignment, unread and resolved/reopen behavior, but deploying it would create a second contact/conversation authority.

## Decision

- An operator remains an ordinary CISME member. `authority_grant.member_id` adds named server-side capabilities; no `isAdmin` boolean and no second account are introduced.
- Every management request uses the normal signed member bearer session and re-reads its exact capability. The mini-program projection only controls visibility and is never the authorization boundary.
- Existing Web Admin and legacy role tables remain intact as a `LEGACY / INTERNAL OPERATIONS CANDIDATE`; they are not expanded by R1/R2.
- One `support_conversation` exists per member. Both the Home/Profile entry and the management queue read the same conversation and message rows.
- `support_message.sequence` is assigned under a conversation row lock. A server trigger rejects gaps, rejects an admin who is not the current handler, and rejects any AI message unless the conversation is still `ai_active`.
- R2 begins in `waiting_human` because no AI runtime is installed. AI does not impersonate a person. `human_active` requires one current handler; competing claims use the same row lock and expected version.
- PostgreSQL is the message authority. Five-second cursor polling is selected for the first slice. Background/foreground and network switches naturally recover with an incremental `after` fetch. WebSocket remains a transport option for later evidence, never an authority.
- Message Outbox events contain IDs, sender type and sequence only—not the support body or member profile. Member context is a separate audited POST requiring `member.support_view` and returns nickname, member state, masked phone and join time only.
- The support retention/purpose registry entries are declared inactive. Release remains blocked until legal wording and an enforced retention/purge policy are approved; R1/R2 source completion does not misstate that as complete governance.

## Consequences

The mobile flow is reliable on the existing Fastify/PostgreSQL footprint and adds no Redis, queue, WebSocket server, Chatwoot, Dify or LangGraph dependency. This foundation originally deferred presence, attachments and order links; ADR 0010 now specifies and implements their bounded local successor without changing the single-conversation authority. Per-agent read state, SLA, notifications and real AI suggested replies remain future bounded slices.

References: [WeChat `wx.connectSocket`](https://developers.weixin.qq.com/miniprogram/dev/api/network/websocket/wx.connectSocket.html), [Chatwoot inbox/conversation model](https://www.chatwoot.com/hc/user-guide/articles/1677492191-adding-inboxes), [Chatwoot conversation controller](https://github.com/chatwoot/chatwoot/blob/develop/app/controllers/api/v1/accounts/conversations_controller.rb).

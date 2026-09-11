# ADR 0007 — Enterprise WeChat identity namespace

Status: Accepted locally; remote environment reconciliation pending

## Decision

The canonical Mini Program target is the new enterprise AppID `wx4eac2d4fb11d299b`, owned by 熹芃（上海）生物科技有限公司. It was not a subject transfer on the former AppID. Because no prior Mini Program was launched and there are no real production users, CISME will not build a speculative old-account migration or UnionID linking system.

An external login identity is uniquely named by `(provider, app_id, openid)`. Runtime WeChat uses `provider=wechat_miniprogram` with the canonical AppID; isolated development/test uses `provider=dev_test`. Session claims carry provider and AppID and are checked against the runtime audience. Nickname, avatar, client fields and unverified phone numbers never link identities. UnionID remains optional metadata and is not an authority or automatic merge key.

WeChat platform administrators/developers and CISME business operators are separate. Business capabilities come only from an environment-scoped, auditable `authority_grant`, may expire, can be revoked immediately, and are never granted to the first login. Legacy grants backfill as `legacy_unspecified` and therefore fail closed in development, test, staging and production until re-issued through a controlled operation.

## Consequences

Staging and production fail startup if configured with another AppID. The pre-existing immutable R1/R2 candidate remains historical and is not overwritten; this identity correction belongs to a later follow-up slice. Staging identity rows and configuration remain unverified until an authorized remote channel is restored. Open Platform binding is not required for the current single-Mini-Program architecture; certification, filing, category/domain evidence and WeChat Pay setup remain separate owner/platform gates.

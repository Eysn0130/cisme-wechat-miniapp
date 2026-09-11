# Six native interaction keyframe sequences

All sequences use the exact Mini package source SHA-256 `949fcf9da6d4777d17eab31ba42b46394d9268fed3c30bbab09fc5533759ad99`, WeChat DevTools simulator 484×1048, base library 3.15.2, `wechatide` 0.3.9, and a disposable local schema-34 fixture. Login used the visible Account consent/login UI; no session token was injected. The 25 PNGs are timed keyframes, not video or physical-device evidence.

| Sequence | Actual native actions and authoritative facts | Result | Evidence |
|---|---|---|---|
| Message retry | Native textarea input → injected unused loopback port failure → draft/error retained → real local API retry; UI and DB each contain exactly one body and one distinct client key | PASS local simulator | `keyframes/01-message-retry/` |
| Reading history | 18 real history messages → native scroll away from bottom → real operator API reply → notice survives arrival and a later empty poll → native tap returns to latest | PASS local simulator | `keyframes/02-reading-history/` |
| Quote return/expiry | Real quote → native address-page navigation/back → synthetic clock advance only → recoverable “重新确认价格” → real requote preserving one selected address | PASS local simulator | `keyframes/03-checkout-return-expiry/` |
| Product draft return | Native input → hide → real remote version change → return with visible conflict/local draft intact → keep-local rebase | PASS local simulator | `keyframes/04-product-draft-return/` |
| Multiline composer | Native three-line input and line-change measurement; composer 390×144, thread bottom 144, notice bottom 156 | PASS geometry; physical keyboard UNVERIFIED | `keyframes/05-keyboard-multiline/` |
| Permission revocation | Native dirty draft → hide → revoke three product capabilities in disposable DB → return transition → fail-closed redirect with product/draft scrubbed | PASS local simulator | `keyframes/06-permission-revocation/` |

The injected network fault and clock advance are explicitly scoped test conditions. The permission change used the database authority rather than a visual-only page-state override. Exact steps, assertions and frame lists are in `interaction-evidence.json`.

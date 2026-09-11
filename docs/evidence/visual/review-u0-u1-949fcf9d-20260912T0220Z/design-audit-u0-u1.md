# U0/U1 native design and interaction audit

Review source: Mini package SHA-256 `949fcf9da6d4777d17eab31ba42b46394d9268fed3c30bbab09fc5533759ad99`.

The audit follows the product truth and WeChat-native constraints first, then applies the mobile interaction contract and visual consistency review. It covers 27 current default-entry simulator frames, 27 immutable baseline frames, and 6 current-source interaction sequences. It does not claim a completed device or full state matrix.

## Audited root causes

| ID | Change | Evidence-backed result | Remaining boundary |
|---|---|---|---|
| V01 message/queue clipping | Applied global border-box coverage to native scroll surfaces and explicit message/queue widths and padding; retained visible text rather than hiding overflow | User support and management queue/chat current frames show no right-edge crop; history/new-message sequence remains readable while scrolling | Compact widths, font scaling, iOS and Android remain open |
| V02 system-bar contrast | Set the supported `navigationBarTextStyle` to `black` for the light native surface; did not confuse it with pull-down `backgroundTextStyle` or draw a fake status bar | Current DevTools frames show dark system chrome on the light navigation background | iOS/Android system-bar rendering remains required |
| V03 fixed footer/composer | The scroll bottom inset and new-message control are driven by measured composer height; user and operator message pages share the dynamic behavior | Three-line user composer measured 390×144 px; thread bottom is 144 px and new-message bottom is 156 px with no overlap in the simulator | Physical keyboard, safe-area variants, operator three-line device measurement and font scaling remain open |

## Representative U1 page review

| Area | Before finding | Current result | Verdict |
|---|---|---|---|
| Home/care | No due milestone could be described as “today completed” | State copy now distinguishes next milestone, actually completed today, due, overdue, paused and ended; deterministic timezone tests pass | Correctness fixed; native care-state matrix pending |
| Support | Cursor could skip an unseen message; polling pulled readers to bottom; right edge clipped; failures and late replies could cross lifecycle/session boundaries | Shared message state separates server sync watermark from visible/read facts, preserves anchors and notices, rejects stale ownership, retains failed draft and reduces empty-poll payload by 94.42% | Representative local interaction pass |
| Product detail | Gallery behavior and engineering-style delivery copy competed with the purchase task | Native swiper is user-controlled, unnecessary observer logic removed, and delivery/quote wording is customer-facing | Current default frame pass; SKU/sold-out matrix pending |
| Checkout | Background expiry could dead-end; address/session facts could leak or be cleared incorrectly; errors could disappear | Session/request epochs scrub cross-account facts, return recomputes from server time, expired quotes expose requote, selected address survives quote-only invalidation, and submit is single-flight | Representative local interaction pass |
| Product editor | `onShow` and inventory updates could erase dirty fields; remote updates were silent | Server snapshot and local draft are separated; conflict is explicit; keep-local rebase and permission-loss scrub are captured | Representative local interaction pass; media/multi-SKU later slice |
| Orders/management orders | Long identifiers and per-order detail hydration increased noise and cost | Summary DTO omits list address and prioritizes short order/status/product facts; integration query bound is fixed at two | Source/DB pass; broader visual states pending |

## 27-route conclusion

All 27 registered routes reached their expected current route with `loading=false`, no page error, and zero filtered compile/console/network matches before the untouched current screenshot was taken. This is a structural/local-runtime baseline, not evidence that every route's loading, empty, failure, long-copy, permission, keyboard and device states pass. Those open cells are explicit in `route-state-inventory.csv` and keep strict Design QA non-release-ready.

The global palette keeps the existing plum/lilac brand. Ordinary small-text colors were darkened from the previous low-contrast token to measured combinations in the 4.68–5.17:1 range on the primary light surfaces; translucent/image-backed combinations and device font scaling still require state-specific inspection.

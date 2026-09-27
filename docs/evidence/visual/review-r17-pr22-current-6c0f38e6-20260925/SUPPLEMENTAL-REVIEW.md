# Exact-source supplemental native review

Source SHA-256: `6c0f38e621519cf1354e5d7adc0e3f52936554ec749ccbb3af0d343c06a309dc`. Local synthetic fixture and 390×844 WeChat DevTools simulator only.

- `screenshots/supplemental/checkout-quote-qty3-top.png`: quote for quantity 3; fixed submit button obscures part of the shipping promise at the initial viewport.
- `screenshots/supplemental/checkout-quote-qty3-bottom.png`: native page scroll to 1200; all four shipping/returns promise paragraphs and the unavailable-payment note are readable above the fixed submit button. This resolves the permanent-obstruction question for this viewport, not a full checkout acceptance.
- `screenshots/supplemental/privacy-rights-records-bottom.png`: page scroll to 470; first request status, message, and copyable request ID are visible. It also shows body text ghosting through the translucent fixed top bar, prompting a separate global opaque-header correction.

The privacy-rights customer-service button was tapped after entering a draft; the route became `pages/support/index`. Tapping the support back button returned to `pages/privacy-rights/index` with the draft still present. These interaction facts have no screen recording and remain partial native evidence.

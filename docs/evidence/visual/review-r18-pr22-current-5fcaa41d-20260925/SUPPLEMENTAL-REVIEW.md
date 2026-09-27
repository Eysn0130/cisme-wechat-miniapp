# Exact-source supplemental native review

Source SHA-256: `5fcaa41d38a31319f67f34ad4a0ed90482affc372fcee5be790034c67ecfa025`. Local synthetic fixture and 390×844 WeChat DevTools simulator only.

- `screenshots/supplemental/checkout-quote-qty3-top.png`: quantity 3 quote at initial viewport; fixed submit button covers part of the shipping promise as the page begins to scroll.
- `screenshots/supplemental/checkout-quote-qty3-bottom.png`: native page scroll to 1200; all four shipping/returns promise paragraphs and the unavailable-payment note are readable above the fixed submit button. No permanent obstruction at this viewport.
- `screenshots/supplemental/privacy-rights-records-bottom.png`: native page scroll to 470; first application status, message and copyable application ID are visible. The fixed header is opaque and body text no longer shows through it.

The privacy-rights customer-service button was tapped after entering a draft; the route became `pages/support/index`. Tapping the support back button returned to `pages/privacy-rights/index` with the draft still present. These interaction facts have no screen recording and remain partial native evidence.

The route matrix, real-device checks, and release gates remain blocked.

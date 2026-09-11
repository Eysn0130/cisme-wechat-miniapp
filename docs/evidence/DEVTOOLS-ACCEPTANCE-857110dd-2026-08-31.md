# WeChat DevTools checkpoint — 857110dd — 2026-08-31

## Bound source

- Mini-program source SHA-256: `857110dd41fdf38bf19d1e7e93cc1ccf1f3d0bcabba7b3bb249227077178ca72`.
- Package gate: 129 files / 13 routes / 1,299,403 bytes; global WXSS 8,117 bytes.
- Tool: WeChat DevTools RC 2.02.2608031, base library 2.32.3, interface-test-account project, iPhone X simulator at 50%.
- This is local diagnostic evidence, not a controlled development QR, experience upload, review submission, release or real-device pass.

## Current-hash evidence

The manifest binds exactly three 1250×733 JPEG full-window captures:

1. final compile with Problems `0`;
2. settled Debugger with Errors `0`, Warnings `0`;
3. Account local legal fixture, unchecked, after compact-height correction.

The Account frame shows the 50px primary and secondary actions fully inside the 812px logical viewport, with 16/20px action labels centered on the shared 1px optical baseline. The correction is a viewport-height media rule that only tightens card/safety/action spacing; it does not reduce font sizes, touch targets or CISME’s title/glass/button hierarchy.

## Retested interaction

- “暂不登录，浏览公开社区” switches to public Community.
- A single-page Account topbar Back also reaches the safe public Community fallback.
- Source-aware protected-route Back behavior remains unit-locked; its prior `6857791b…` simulator traversal is historical and must be recaptured before current acceptance.
- The legal checkbox remained `Value: 0`; checked/enabled geometry and login were not exercised.

## Remaining acceptance gaps

- Account is still `matrixComplete:false`; checked/enabled, busy/success/failure, long-copy/large-text, exact page-frame, same-state Web comparison and device states are open.
- The other 12 routes have no current-hash route evidence. The `18672702…` Progress fixtures are historical after this Account-only source change and are not inherited.
- Network, iOS/Android, signed legal text, production identity, real media and the complete review/points loop remain blocked.

`final result: blocked`

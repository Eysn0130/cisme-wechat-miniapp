# Native privacy triage interaction review

Observed 2026-09-22 23:32–23:35 UTC, native WeChat Developer Tools 2.02.2608070, base library 3.15.2. Package f376c8e0a5ad8b924154acaf9528a3bbbea4772106396fdc4fe632bcc624dcda; application source committed as 11eff1689b5271fef792ee6061a6bb4c2d413993. Local disposable run fc11f18b9a951bbbced4fb05; synthetic records only.

The actual native UI opened a pending access request, entered a synthetic response through the textarea, saved it, returned to the queue showing reviewing, and reopened the same request. The response persisted. Both queue and detail explicitly distinguish a response from data export or deletion; no execution task was created by this operation. Evidence: screenshots/raw/privacy-response-saved.png and privacy-response-reopened.png. AX clicks on the native textarea/save control did not initially actuate them; screen-coordinate input then succeeded and the resulting visible state was verified. No page state, session or token was injected.

The queue screenshot was visually inspected for title/capsule separation, wrapping, card bounds and safe-area placement. The detail can scroll; keyboard behavior on physical devices is unverified. This review does not claim all interaction states, permission revocation on device, accessibility, iOS or Android acceptance. The unit/integration tests separately cover stale callbacks, revocation races and uncertain writes. All full acceptance gates remain blocked.

38 baseline frames: 37 runtime healthy, one expected money-disabled finance state. Console/network filters returned zero matches within their bounded capture scope; this is not a full network audit. The three earlier 728cdc capture attempts are incomplete historical runs, not current-source acceptance.

A later native foreground check revoked exactly one privacy.request.manage grant in owned disposable run fc11f18b9a951bbbced4fb05. The already-open detail cleared and displayed the no-authority retry state; screenshot privacy-authority-revoked.png records the result. No elapsed-time upper bound was measured. A new one-hour synthetic grant was then created for recapture; the old revocation audit was preserved. No production permissions changed.

CI 35798389847 correctly rejected the 242×524 baseline frames as too narrow for the existing 320×480 minimum. This batch is historical runtime/interaction evidence and is not acceptable visual evidence. The original images are retained without enlargement. A separate capture at native simulator 100% display scale replaces its current acceptance references.

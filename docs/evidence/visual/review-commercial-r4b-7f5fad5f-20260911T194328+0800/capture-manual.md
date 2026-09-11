# Bounded native capture procedure

1. Open `/Users/mini/CISME/cisme-r0-platform/apps/miniprogram` in WeChat DevTools, confirm AppID `wx4eac2d4fb11d299b`, base library `3.15.2`, URL validation enabled and no production fixture.
2. Approve the separate project-action permission prompt. Do not change business authorization, privacy checks or TLS validation for screenshots.
3. Restart the project window once, compile once, then try one page only. If the screenshot API again reports `waitForAutomatorReady`, stop automation and use the DevTools built-in simulator screenshot control.
4. Follow `routes.csv` in order. Save the untouched PNG as `screenshots/raw/<route with / replaced by __>.png`; record exact capture time and update the row. Dynamic/detail routes may first show a truthful missing-id/error state; capture that default, then add separate fixture rows for success.
5. Clear or filter console/network immediately before each journey. Record application errors separately from tool/system warnings; do not erase a failed frame.
6. For recordings, start before the first tap and stop after the authority response is rendered. Add operation steps, timestamps, expected/actual and keyframe paths; never infer app FPS from video FPS.
7. Exclude login QR codes, personal profile data, tokens, complete OpenID/session keys, secrets and real conversations. If redaction is necessary, retain the unedited evidence only in an approved secure location and record the redaction boundary.
8. Run this generator again with the same review ID to refresh route status and SHA256SUMS. Do not mark any route passed until visual, interaction and applicable device checks are reviewed.

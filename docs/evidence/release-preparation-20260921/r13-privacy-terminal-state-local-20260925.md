# PR22 R13 — privacy export terminal state, local source 390cfba7, 2026-09-25

Scope: local `codex/fulfillment-lifecycle-20260922` candidate based on local `0c93f03de52d8b2f8852d700f27e5311c0e8e3e3`. Mini Program source SHA-256 is `390cfba7a226f8bae2fa5ccfd6dbf8580be6823a3d45eb36a5b8de4e3adfefcd`. This note records local tests and WeChat DevTools simulator observations only. It does not grant phone, PR CI, staging, or production acceptance.

## Reviewed behavior and repair

The `PRIVACY_EXPORT_TOO_LARGE` condition is terminal: the existing server integration case returns `409 PRIVACY_EXPORT_RETRY_NOT_SUPPORTED` for an unchanged oversized export. The WXML correctly hides the retry button for this code, and `retryExport` correctly refuses that code. An initial suggestion that the button condition was inverted was withdrawn after checking both guards and the server test. No retry rule was changed.

The actual UX defect was the dead end on the failed request card: it showed only “处理遇到问题” while offering no retry or explanation. The card now says: “副本过大，无法自动生成。请复制申请编号，选择‘其他隐私咨询’说明所需资料。” Both normal membership and historical privacy-rights identities can select that existing request kind. No new capability, API, or status was added.

## Verification and provenance

- `wechatide 0.3.11 compile_wxml` compiled `pages/privacy-rights/index.wxml`; `npm run typecheck`, `npm run miniprogram:package-gate`, `npm run miniprogram:route-audit`, and `git diff --check` passed.
- The exact updated source passed 124 unit test files (1,425 tests passed, 1 skipped) and 57 isolated integration test files (916 tests passed). `npm run build` and `npm run lint:contracts` passed. The integration runner removed its own disposable PostgreSQL and object-storage targets after completion. These local results are not the remote PR check for the new HEAD.
- A synthetic terminal-size record was injected into the local simulator page data to check the rendered card. The 390×844 raw image is `docs/evidence/visual/privacy-rights-terminal-size-simulator-390cfba7.png`, SHA-256 `627f38f90fa8cba2087fba81dff068a3519160bfa069dfba8e71b68352880702`, 65,930 bytes. It shows the explanatory text, the existing request-ID copy control, and no retry button. This is a targeted UI state, not evidence that a real export job or WeChat file sharing succeeded. The unrelated legal-contact area was not loaded in this injected frame.
- A newly owned disposable local PostgreSQL and object-storage pair, with synthetic community and fulfillment fixtures, supported `review-r13-pr22-terminal-size-390cfba7-20260925`. Its WeChat DevTools run opened all 40 routes and captured 40 original PNGs: 39 passed local synthetic default-state checks and the finance route passed its expected money-disabled check. The bounded console/network filters matched 0/0 lines; those filters are not a full HAR or physical-device result. The pack's 59 SHA256SUMS entries verified. The two disposable containers and the local API listener were removed after capture.
- `scripts/update-current-source-manifest.ts` archived the old `6c14135c…` acceptance file unchanged and bound `current-source-acceptance.json` to `390cfba7…`. `npm run design:qa:status -- --json` has no structural errors and still returns `releaseReady=false`: route state matrices and iOS/Android current-package evidence remain incomplete.

PR22 remains Draft at remote `5ab4a00d4e71d8a9a2de14e31b64fca0bbe92e88`; remote `main` remains `5740e18544fa37dd473c36934a2a12a07a2d5ec9`. The local patch has not been pushed through an alternate channel after the earlier automatic safety rejection. No preview upload, merge, staging redeploy, production apply, or firewall/filing change was performed.

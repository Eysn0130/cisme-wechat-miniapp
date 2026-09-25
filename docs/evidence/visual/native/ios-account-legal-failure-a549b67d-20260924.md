# Current-package iPhone account failure

- Source: user-provided iPhone screenshot after scanning the `wechatide` preview QR generated from `4d41bfc3bb25de9f24c37dd1b66ae2d6e279f9ad`, with `--page-path pages/home/index` and no remote-debug query.
- Mini-program package source SHA-256: `a549b67d00edceabca73517e63a81bbeef9252541294e1f71d45bdfbf9a33b01`. No mini-program source changed between that commit and this evidence update.
- Original attachment: `codex-clipboard-b907619b-ab50-4791-b0e2-f25fa638ec88.png`; copied unchanged to `ios-account-legal-failure-a549b67d-20260924.png` (SHA-256 `8d6dfa71c22fa8650937bda3e14f82cfaa4497a2f1df425540869d7a1f2a8966`, 590 × 1280).
- Observed: account page displays “协议服务暂时无法连接，请重试”; “重试读取协议” is offered and “暂时无法登录” is disabled. The user reports login could not proceed. The screenshot does not show a completed `wx.login` call or an identity response.
- Runtime expectation from `apps/miniprogram/release-config.ts`: a physical-device `develop` preview without `cisme_remote_debug=1` targets `https://staging-api.cisme.cn`. The exact request, status, DNS, TLS, and server log for this phone session were not captured.

Result: **blocked** for iPhone account/legal/authentication. This is a real current-package failure observation, not a pass for the rest of the iPhone journey. Android was unavailable, and its acceptance remains blocked. Do not reuse older `f9f72432` evidence as this package's pass or conclude ICP is the sole cause from this screenshot.

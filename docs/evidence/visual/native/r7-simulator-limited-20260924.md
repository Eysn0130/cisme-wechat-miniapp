# R7 current-source DevTools simulator observation

- Project: `/Users/mini/CISME/apps/miniprogram`, original imported AppID project.
- Source package SHA-256: `a549b67d00edceabca73517e63a81bbeef9252541294e1f71d45bdfbf9a33b01`.
- Observed from branch commit `351d4ecdeddc86a4c7afefaba3cb723f549f3ffa` plus a backend-only pending fix; the mini-program source files did not change.
- Tool: installed `wechatide` CLI/skill 0.3.11, logged-in WeChat Developer Tools, 390 × 844 simulator viewport.
- `compile_wxml` and `compile_wxss` succeeded for `pages/privacy-rights/index`.
- Simulator opened `pages/privacy-rights/index`; screenshot `r7-privacy-rights-simulator-20260924.png` shows the network failure state and a visible request form. No real request was submitted.
- Simulator opened `pages/account/index`; after loading it displayed the home route and a care-status network error. Screenshot `r7-account-simulator-delayed-20260924.png` records that observed state. The initial blank loading frame is not counted as a pass.

These are simulator observations only. They do not establish real WeChat identity, working public API/TLS, iPhone or Android acceptance, or completed privacy operations. The 40-route matrix and device results remain blocked until actual current-package observations satisfy their criteria.

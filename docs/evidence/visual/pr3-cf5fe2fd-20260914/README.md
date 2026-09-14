# PR3 current-source native simulator: two guest default frames

- Source: branch `codex/native-closure-20260913`, commit `a80040cab5a17e632af3470ff0e55b0ade7f78d5`; Mini Program source SHA-256 `cf5fe2fd9baadf7a71d8bdfb4629b832ddd44559739c2226d2199d402c83c791` (package inspection, not inferred from Git SHA).
- Project: `/Users/mini/.codex/worktrees/91ad/CISME/apps/miniprogram`, AppID `wx4eac2d4fb11d299b`, `miniprogramRoot=./`; WeChat DevTools app 2.02.2608070, `wechatide` skill 0.3.9, separate lightweight simulator window `s3`, iPhone 12/13 (Pro) simulator at 62%. Existing PR2 project registration remained untouched.
- Time: 2026-09-14 11:23–11:25 Asia/Shanghai. `wechatide automation_runtime_info` returned `pages/privacy-rights/index` and `pages/home/index` respectively. Native accessibility tree showed the guest privacy actions and home “授权身份并开始”. `get_simulator_console` / `get_simulator_network` with filtered error query returned empty strings during the home sample; that does not prove the entire buffers or all routes clean.
- Capture method: after three earlier hangs of the same `wechatide simulator_screenshot` method, no fourth attempt was made. macOS `screencapture` captured the on-screen 242×524 simulator rectangle directly (`-R838,206,242,524`), with no postprocessing. A full DevTools window screenshot was inspected locally to verify source-path/window identity but is not committed because its chrome contains a personal account avatar. The raw simulator-only PNGs are preserved below; they are not Web screenshots.

| Raw frame | SHA-256 | Observed scope |
|---|---|---|
| `raw/home-guest.png` | `746ac4e0873490bb4de72c12521e0b2289289287e122b61aa7f2ba60660e44de` | Guest home default; authorization CTA and 00–03 guidance visible. No login, cycle, records, or interface-state pass implied. |
| `raw/privacy-rights-guest.png` | `2d68c242a9182c34a65d811f27a288950c2349b7bfd9feb74f739d424e39cef8` | Guest rights default; request guidance, login CTA and WeChat feedback visible. Authenticated request/export/erasure states not exercised. |

Result: `CURRENT_SOURCE_DEVTOOLS_GUEST_DEFAULT_OBSERVED` for only these two frames. `docs/evidence/visual/current-source-acceptance.json` remains `finalResult=blocked`; route-state, cloud, iOS, Android and final design acceptance are not promoted by this limited capture.

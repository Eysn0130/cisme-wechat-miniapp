# Historical WeChat DevTools checkpoint `8b593ce9…`

Date: 2026-08-15  
Tool: WeChat DevTools Stable 2.01.2510290 / base library 2.32.3 / runtime `touristappid`  
Package SHA-256: `8b593ce993027e7cbf0056f07535f3dbb4ed2688503c16064af06a12ae8371d2`

## Verified

- Package: 127 files / 13 routes / 1,225,088 bytes; global WXSS 5,611 bytes.
- Compile: Project Errors `0`; Problems `0`. Two startup tool/base-library warnings were visible in the captured window and are not classified as product compile errors.
- Raw simulator frames: the built-in `模拟操作 → 截屏` result was recovered from the clipboard as original 750×1624 PNGs for Account/unlogged and Community/brand-editorial on the iPhone X 375×812 logical viewport.
- Product Design comparison: each 2× native frame was mechanically reduced to 375×812 and placed beside the existing 375×812 frozen Web source. The comparison itself, not either screenshot alone, drove the verdict.
- Account finding: WeChat's native disabled-button style overrode the intended primary hierarchy. The shared `.primary--disabled` modifier now explicitly owns color/background/shadow/opacity; this hash's recapture restores a visible muted-purple primary CTA.
- Community finding: the same hero title wrapped as `9 + 1`, leaving “式” orphaned. That P1 drove the later `4584a4c2…` source geometry fix; this checkpoint does not prove the fix.

## Boundaries

- Account is not marked visually passed: the frozen Web includes optional phone authorization, while production correctly keeps phone capability closed until a transaction profile and fulfillment scope are signed. The legal agreement checkbox and login action were not clicked by the agent.
- Community is not marked visually passed: the frozen Web contains public UGC/recommendation semantics, while production correctly renders brand editorial/manual review under the closed UGC gate. Hero/grid/TabBar geometry is diagnostic only.
- The Mac locked before a fresh public HAR and final clean-console window could be exported. Source then changed, so this entire checkpoint is historical and is not referenced by the current-source manifest.
- No authenticated route-state traversal, real AppID reconciliation, iOS/Android device, camera/album, keyboard or weak-network evidence is claimed.

## Evidence

- `docs/evidence/visual/current-run/native/devtools-package-8b593ce9-compile-0-project-errors-2-system-warnings-2026-08-15.jpg`
- `docs/evidence/visual/current-run/native/account-unlogged-8b593ce9-375x812-2x-2026-08-15.png`
- `docs/evidence/visual/current-run/comparisons/account-unlogged-8b593ce9-web-vs-native-375x812.png`
- `docs/evidence/visual/current-run/native/community-brand-editorial-8b593ce9-375x812-2x-2026-08-15.png`
- `docs/evidence/visual/current-run/comparisons/community-brand-editorial-8b593ce9-web-vs-native-375x812.png`

Verdict: `blocked`.

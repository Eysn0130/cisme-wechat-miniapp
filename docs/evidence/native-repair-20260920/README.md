# Native repair evidence

Baseline main 56432fb9b42777ffd4b3aeaf17134a666c7f243c; source package ce7c06c1bac5e3efaaf6151783e2353cb896f1ed7087a2c0b97ab1cf71e19b3e. These are actual cloud source/loopback results, not native-device or production measurements.

Raw red logs preserve why new regressions were needed; green logs are scoped to their named run. The failed storage loopback diagnostic is intentionally preserved: it found an SDK retry escaping an initial cancellation implementation; the subsequent green SDK test verifies the correction. `interaction-contracts.json` enumerates requirements and observed source tokens, not 37 passed pages. Current full-unit log is 427/427. CI integration/audit/performance will have their own exact commit/run artifact; they are not predeclared here. Source-location/test details and rollback are in ../../CISME-NATIVE-REPAIR-2026-09-20.md.

Committed log copies normalize only blank lines at EOF for git diff hygiene; original cloud log bytes are preserved in the downloadable run evidence bundle. ANSI/source/error content is not rewritten.

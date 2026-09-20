# Isolated WeChat CI tool

The official `miniprogram-ci` 2.1.31 dependency tree reports **80 npm advisories on 2026-09-20** (41 critical, 19 high, 19 moderate, 1 low). The registry still identifies 2.1.31 as the latest version and reports no available fix for the direct package. The 73-advisory figure from 2026-08-15 is historical. This tool remains outside the root lockfile and SBOM; the root audit's zero vulnerabilities does not cover this separate tree. See the [current scoped audit](../../docs/evidence/main-consolidation-20260920/wechat-ci-audit-summary.json).

The 2026-09-20 consolidation did not install or load this package, provide it with credentials, enable its workflow, or execute an upload. Native compilation and the guest-page observation used the installed WeChat Developer Tools. Do not enable the optional tool merely because main or its ordinary CI is green; its upstream findings remain unresolved.

Credentialed CI must run this tool in a disposable, network-restricted runner that accepts only reviewed repository source and the WeChat private key. Install with `npm ci` in this directory only after a security owner accepts the current advisory report. Root production dependencies audit at zero.

This isolation is not a release bypass: the standalone script itself requires explicit advisory-risk acceptance, a matching real AppID, private key, public preview HTTPS origin, privacy/legal/domain/demo approvals and a fully passed current-source Design QA manifest before it loads the tool. Absence of any prerequisite causes `npm run wechat:ci:isolated` to fail closed even outside GitHub Actions.

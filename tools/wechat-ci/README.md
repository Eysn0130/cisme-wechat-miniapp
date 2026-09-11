# Isolated WeChat CI tool

The current official `miniprogram-ci` 2.1.31 dependency tree reported 73 npm advisories on 2026-08-15 (41 critical, 16 high, 15 moderate, 1 low), with no upstream fix for the direct package. It is therefore excluded from the production root lockfile and SBOM.

Credentialed CI must run this tool in a disposable, network-restricted runner that accepts only reviewed repository source and the WeChat private key. Install with `npm ci` in this directory only after a security owner accepts the current advisory report. Root production dependencies audit at zero.

This isolation is not a release bypass: the standalone script itself requires explicit advisory-risk acceptance, a matching real AppID, private key, public preview HTTPS origin, privacy/legal/domain/demo approvals and a fully passed current-source Design QA manifest before it loads the tool. Absence of any prerequisite causes `npm run wechat:ci:isolated` to fail closed even outside GitHub Actions.

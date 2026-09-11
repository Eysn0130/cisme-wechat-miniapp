> 当前状态更正（2026-09-09）：协议正文、项目主体与隐私受理入口已完成并发布；详见 legal/发布缺口说明.md。历史“协议未发布/没有主体资料”不再适用。整体真机与微信上架验收另行记录。

# External blocker register

These are external inputs or approvals that local engineering cannot safely fabricate. Satisfying one does not imply the remaining internal implementation or acceptance is complete. None is represented by fake data or a success screen.

## Current status — 2026-09-10

Current delivery assessment and prioritized engineering/external work: [NATIVE-SYSTEM-PARITY-AUDIT-2026-09-10.md](NATIVE-SYSTEM-PARITY-AUDIT-2026-09-10.md). The current full suite passes (196 unit, 65 dedicated-database integration tests), build and contract cross-check pass. A native multipart ArrayBuffer probe is rejected by the SDK; a storage probe shows replayable PUT despite If-None-Match. Neither transport is enabled as a workaround. Network/route-matrix/device acceptance, upload lifecycle and worker scheduling still require engineering or external evidence.

The native source hash is `14226538c2a70d76f5112aa04acddc656263ffa1aaa66babfb86a94124777100`: 16 routes, 149 files, 1,791,182 bytes; the internal 1.8 MB package budget check passes with 8,818 bytes of headroom. Historical screenshots are not automatically accepted for this hash. Current route/state comparisons, Network evidence and valid iOS/Android device evidence remain incomplete.

Historical RC observation: the 3.15.2 simulator emitted `SystemError (appServiceSDKScriptError): timeout` after compilation. A separate minimal project containing only an empty page and an `onLaunch` console marker reproduced the same error with no CISME business code or network calls. The page and marker were observed; this narrows the problem to the development-tool/base-library environment, without proving its exact cause. On Stable 2.02.2608070, a fresh compile of the current source and native community cloud-call test showed 0 errors and 5 warnings; the timeout was not observed in this run. This does not establish compatibility on all devices. Reproduction source and result: `docs/evidence/deployment/sdk-timeout-repro-2026-09-09/`.

The project now uses AppID `wx4eac2d4fb11d299b`. The official WeChat stable-token endpoint accepted the provided AppID/AppSecret, and authenticated cloud deployment succeeded. This resolves the old “only an interface test account” description; it does not prove real-user login, release qualification or team trial access.

CloudBase `cloud1-d4g0khuk495d48600` has verified ordinary and HTTP diagnostic functions. The HTTP probe executed the packaged Node.js 24.14 runtime with status 200. The full `cismeApi` code package uploaded successfully (5668 files, 33.9 MB). The user explicitly authorized credential configuration; all 18 values and the 60-second timeout were saved and read back on 2026-09-09. The business function returned 200 from `/health/ready` (actual database query and storage readiness), 200 `[]` from `/v1/feed`, and 401 `AUTH_INVALID` from unauthenticated `/v1/me`. Database certificate path was corrected to `/var/user/supabase-prod-ca.crt`. Cloud log retrieval reports `ResourceNotFound.TopicNotExist`. Native SDK health checks and the current-source guest Community page now pass through the business function. The temporary page transport override was restored after testing. Authenticated flows, permanent release transport, upload lifecycle and scheduled worker deployment remain incomplete. Evidence: `docs/evidence/deployment/cloudbase-api-configured-2026-09-09.json`.

The current trial preflight fails. Remaining requirements include the trial API origin, privacy-console proof, approved legal texts and scope, experience members, current route/state evidence, and physical-device evidence. The current checker assumes public HTTPS domain access; if the app adopts official cloud calls, its transport-specific requirements must be updated and validated before release, rather than blindly asserting that a custom domain is required for every route.

Evidence: `docs/evidence/deployment/cloudbase-custom-probe-2026-09-09.json`, `cloudbase-bundled-runtime-2026-09-09.json`, `cloudbase-api-deploy-2026-09-09.json`. Worker delivery integration tests passed against the dedicated `cisme_test` database on 2026-09-09; this is not cloud database acceptance.

| Blocker | Owner / proof required | Capability held closed |
|---|---|---|
| WeChat release qualification, real-user login and optional CI upload key | current AppID/AppSecret and cloud deployment verified as described above; administrator/release proof and actual end-user/device acceptance still required | verified trial delivery and audit submission |
| Registered HTTPS API/upload domains and TLS | domain owner + WeChat allowlist screenshot + certificate monitoring | real-device API and upload |
| iOS/Android/lower-width physical devices and authorized testers | product QA; signed three-device matrix | true-device visual, keyboard, weak-network and native sharing acceptance |
| Enterprise admin identity provider, MFA and role owners | security/IT approval | production admin access |
| Production cloud account, region and object-storage supplier | infrastructure/security approval; encryption, export, retention and deletion evidence | production storage adapter |
| Content safety/moderation supplier and SLA | legal/trust & safety approval | public UGC and unreviewed media publication |
| Final privacy, terms, content license, retention/deletion and appeal text | legal signature and version identifiers | public release and final data-rights SLA |
| Finance/product points earning signature | denomination, budget, liability, grant expiry, cap, fraud and tax sign-off | new points grants/activation |
| Points redemption policy and evidence | independently versioned finance approval with expiry, deduction cap, prepare/commit/release/refund-allocation contracts and reconciliation | points spending/deduction; does not block cash checkout |
| One implemented transaction profile | signed MAKE evidence packet, implementation, sandbox and reconciliation; BUY may reopen only through a time-boxed named-supplier cash-baseline packet | checkout, order, payment, refund and logistics |
| Merchant account, payment certificates and webhook domain | verified merchant administrator | WeChat payment/refund |
| Logistics supplier credentials and reconciliation | operations/procurement | fulfillment status |
| Public repository, deployment and release authorization | repository owner/release manager | remote push, public deployment and WeChat review submission |

Historical record (405ae15c source; not current acceptance): The official WeChat DevTools application and local release preflight were installed. Recorded status was “temporary remote true-device transport reachable; valid device acceptance unproven.” Tracked config and DevTools show an interface-test-account AppID-shaped value, but ownership/project role, AppSecret and production execution are unverified; the current `405ae15c…` package has Problems 0 and, after a final-compile/settle window, Debugger Errors 0 / Warnings 0. Three desktop diagnostics bind compile/console and Community brand-editorial. One additional artifact records a hardware iPhone 17 Pro Max / iOS 26.5.2 / 4G transport connection, but the QR targeted Android, DevTools warned about the mismatch and no business API request reached the tunnel. The mismatched session was ended and a corrected iOS QR generated; it still awaits scan. There is no current-hash structured API Network trace, production-authenticated complete traversal, exact handset page-frame or valid iOS/Android route evidence. Every older hash is historical and not inherited. The temporary `https://*.trycloudflare.com` channel is not a durable public environment, experience-version or visual acceptance. Legal/domain proof, an owned public test environment, experience upload, valid iOS/Android evidence and WeChat review submission remain absent.


## Historical takeover verification — 2026-09-08 (superseded by current status above)

Current source: `7bbb0a92cfa52241fef7b4cc74b5d7864df31a0e9186cf0c3b62dc7a04fceffe`. Native build log shows compile completion and successful analysis. The current Console has **6 errors / 4 warnings**; observed request errors reject `http://127.0.0.1:3100` because it is not a registered request domain. CLI `/health/ready` and `/v1/feed` both returned HTTP 200, so CLI reachability is not DevTools network acceptance. No security validation was disabled during this takeover.

Account checkbox and return, guest Community fallback, and local brand Post reading/return were observed. Authenticated and network-dependent routes remain blocked in the simulator. Exact page-frame comparison, current API Network trace, production identity, and hardware acceptance remain incomplete. The active manifest records these failures; screenshots 07/09/10/11 are diagnostics, not release approval. Formal AppID for the new account, owned HTTPS infrastructure/domain and required signed documents are still needed. No new experience upload or team QR was created.

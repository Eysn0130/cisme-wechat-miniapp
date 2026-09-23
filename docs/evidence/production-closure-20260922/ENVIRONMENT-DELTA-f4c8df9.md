# Environment delta — separate production and staging

## production (unchanged)

Target lhins-61ikz4mi / cisme-app-shanghai / 124.223.74.198 / api.cisme.cn. Read-only Tencent Lighthouse firewall view at this continuation again showed all-IPv4 allow rules for TCP 22, 80, 5432 and ICMP, with no TCP 443 rule. This is the cloud rule view, not a claim about OS rules or end-to-end reachability by itself.

An independent HTTPS probe executed from the authorized staging host at 2026-09-22T23:47:30.583635Z resolved api.cisme.cn to 124.223.74.198 and failed with URLError after the normal-certificate 8-second connection budget. This reproduces external production unreachability, but does not prove a single firewall root cause. The same probe of staging-api.cisme.cn at 23:47:38.626987Z resolved 150.158.39.74 and returned 200.

The earlier production release path remains the last verified observation, /opt/cisme/releases/20260909-native-login; exact source SHA UNKNOWN. It has not been replaced by staging's deployment evidence. Production credentials, firewall, permissions, data and review flow were not changed. The database credential incident remains open and password not rotated. See SECURITY-INCIDENT.md and ROTATION-AND-NETWORK-PLAN.md for verified scope and remaining legacy-consumer uncertainty.

## staging

f4c8df9 activated and tested on lhins-ei4hz4fi only; exact receipts in STAGING-f4c8df9-RAW.json and interpretation in STAGING-f4c8df9-ACCEPTANCE.md. Local owned DB and objects, no real payment. Monitor source pin updated with preserved prior script and successful service result. No claim of production deployment, COS restore, long stability or external alert delivery.

## Confirmed policy boundary for missing business inputs

Owner explicitly stated no separately approved package currently exists for actual return recipient/contact, final policies/data retention, or production alert recipients. Rechecked repository candidates and subject-data map continue to say pending; no formal values may be invented. Existing real verified sources may be reused if subsequently found. These are pre-production external confirmations, not reasons to stop independent source, synthetic or staging work. Native export disclosure is a candidate behavior and does not turn a pending retention policy into approved policy.

WeChat filing remains the owner's original “小程序备案 管局审核中”. No new platform observation, code-review approval, withdrawal, submission or publication occurred. Tool-restricted platform access is not a reason to attempt another login route. Old cisme_test impact remains UNKNOWN / not recovered.

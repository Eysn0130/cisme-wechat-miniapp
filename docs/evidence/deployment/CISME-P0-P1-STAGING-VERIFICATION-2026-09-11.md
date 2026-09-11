# CISME P0/P1 staging verification

验证日期：2026-09-11  
环境：仅 `cisme_staging`  
判定：P0/P1 的隔离 staging 迁移、API runtime、关闭态约束与清理已验证；这不是小程序发布就绪或生产发布批准。

## 结果摘要

- 迁移演练按 27→28→29→28→27→28→29 完成，9 个隐私生命周期表、8 个正式 UGC/治理基础表和原有事实均被验证。
- API-only release `/opt/cisme/releases/20260911T051500Z-p0p1-staging` 已启用；API SHA-256 为 `7df242062417c1190b5c714ba4a34fb46cf927508989514d9e9aa5c088ed7f8b`。worker、worker-once 和 lockfile 保持已部署基线哈希。
- 合成验证覆盖 P0 上传关闭投影/授权拒绝/零媒体写入/跨会员隔离，以及 P1 请求幂等、plan-only 导出、dry-run 擦除、非法状态阻断、hold/consent/registry/审计约束；community 的 API 与 DB 开启均被拒绝，且无 UGC 路由。
- 合成数据已清理。最终数据库为 29 migrations、66 张 public base tables（含 ledger），member、identity、privacy request/event/job、UGC、pending outbox 与 DLQ 均为 0；uploads/community 均为 false。
- API、worker、Nginx、PostgreSQL active+enabled，API/worker 自部署以来 error journal 均为 0。HTTPS 证书 SAN、有效期、TLS 1.2 与禁用 TLS 1.1 已复核。
- 本地回归通过：32 个 unit files / 232 tests、17 个 integration files / 84 tests、typecheck、build、contract lint、包体结构、dependency audit 和 license gate。

## 边界

小程序 hunk 仅在 release slice 中审计，没有上传。DevTools 当前源码、16 路由、iOS/Android 真机和微信隐私后台证据仍未完成，所以 `design:qa:status` 的 `releaseReady=false` 是预期且诚实的产品发布门，不否定本轮 staging API/schema 验证。

真实导出归档、擦除执行、账号注销、retention purge 和 UGC runtime 均为 `NOT IMPLEMENTED`。生产、COS、社区开放、新微信权限与 P2+ 均未触碰。

机器可读明细见同目录 `CISME-P0-P1-STAGING-VERIFICATION-2026-09-11.json`。

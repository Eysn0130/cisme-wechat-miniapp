# CISME P0/P1 staging scope audit

审计日期：2026-09-11  
候选标识：`p0-p1-staging-slice-20260911T045758Z`  
基线：staging 已部署 API `index.js` SHA-256 `557a190d3f898bd8bfeb67f421d31cb0637988d575f193876670ed72ab3d2bcf`，27 migrations。  
结论：当前 working tree 不可整体发布。staging runtime 只能用基线哈希校验后的 compiled hunk patch 重建；小程序 hunk 只进审计包，不上传。

## 1. 冻结范围与隔离原则

本候选只含：上传关闭时的个人信息最小化、personal-data inventory、隐私权利 plan-only/dry-run 生命周期、关闭态正式 UGC 最小 schema、直接相关 contract/tests/docs，以及 rollback 所需的最小约束修正。商城、订单/支付、客服、邮箱、正式社区开放、COS direct upload、新微信权限、无关 UI 与生产均排除。

混合文件不得整体复制到 staging。API 以已部署 `index.js` 为唯一 clean baseline：先验证 baseline SHA，再应用 `runtime/index.patch`，重建结果必须与包内 `runtime/index.js` 的 SHA 完全一致。`worker.js`、`worker-once.js` 和 dependency lock 与已部署基线逐字节一致。投稿页只提供针对两个文件的 `miniprogram/submit-media-closed.patch`，本轮不上传。

## 2. Canonical change manifest

“范围”使用稳定 symbol/anchor，而不是会随 dirty tree 漂移的行号。`是（若晋级）`表示只有未来将同一变更晋级生产才会产生影响，本轮没有生产动作。

| 文件 | diff 范围 | 纳入理由 | runtime | migration | contract | test | doc | 可能影响 production candidate | 进入 staging slice |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `services/api/src/platformService.ts` | `getSubmission` 的 `media_uploads_enabled`；`setEmergencySwitch` 的 community hard-close | P0 前置媒体阻断；P1 社区关闭 | 是 | 否 | 响应行为 | 否 | 否 | 是（若晋级） | 仅 compiled hunk |
| `services/api/src/privacyRights.ts` | 全文件当前 P1 lifecycle 实现 | versioned reply、member isolation、plan-only/dry-run、幂等与最小审计 | 是 | 否 | API 行为 | 否 | 否 | 是（若晋级） | 仅 compiled hunk |
| `services/api/src/server.ts` | `PrivacyRights` 初始化与 `/execution-plan` 路由 | 暴露受控计划入口 | 是 | 否 | route | 否 | 否 | 是（若晋级） | 仅 compiled hunk |
| `packages/contracts/src/index.ts` | `EmergencySwitchKey` 增加 `community` | API 与 migration 的关闭态键一致 | 是 | 否 | type | 否 | 否 | 是（若晋级） | 已编入 runtime hunk |
| `openapi/openapi.yaml` | execution-plan path、submission 上传开关说明、community switch enum | 精确表达 P0/P1 contract；不把计划称为完成 | 否 | 否 | 是 | 否 | 是 | 否 | manifest reference，不整体替换远端 |
| `apps/miniprogram/pages/submit/index.ts` | `mediaUploadsEnabled` default/map/early-return；`clearMemberSnapshot` | 上传关闭时在 draft/privacy/chooser/network 之前停止；账号切换时清除上一会员投稿/授权/媒体字段 | 小程序 | 否 | 客户端行为 | 否 | 否 | 是（若上传） | hunk patch；不上传 |
| `apps/miniprogram/pages/submit/index.wxml` | 关闭提示与两个 disabled 条件 | 禁止虚假成功或可点击状态 | 小程序 | 否 | 客户端 UI | 否 | 否 | 是（若上传） | hunk patch；不上传 |
| `db/migrations/202609110001_privacy_lifecycle_foundation.sql` | 全文件 | P1 可审计 control plane；当前强制 plan-only/dry-run | 否 | 是 | schema | 否 | 注释 | 是（若晋级） | 是 |
| `db/migrations/202609110002_formal_ugc_foundation.sql` | 全文件，最终 8 表 | P1 关闭态内容/治理最小骨架；无 route、开关不可开启 | 否 | 是 | schema | 否 | 注释 | 是（若晋级） | 是 |
| `apps/admin/src/main.ts` | privacy queue/reply/plan UI anchors | 正确展示“计划不等于执行” | 管理端 | 否 | 客户端行为 | 否 | 否 | 是（若部署） | 否；文件混有大量无关改动 |
| `scripts/privacy-requests.ts` | `plan` command | 仅本地/受控 operator 验证 | 工具 | 否 | CLI | 否 | 否 | 否 | 否；staging 用直接受控验证脚本 |
| `scripts/validate-contracts.ts` | 001/002 required tables、execution-plan path、community closed constraint | CI contract gate | 否 | 否 | 是 | gate | 否 | 否 | 否 |
| `tests/integration/privacy-rights.test.ts` | P1 全链路用例 | member isolation、幂等、状态机、evidence、hold、无删除 | 否 | 否 | 否 | 是 | 否 | 否 | 否 |
| `tests/integration/formal-ugc-foundation.test.ts` | 002 约束用例 | closed flag、无 route、ownership、immutability、publication guard | 否 | 否 | 否 | 是 | 否 | 否 | 否 |
| `tests/integration/migration-lifecycle.test.ts` | 28/29 up/down/up 与 down preservation guard | clean DB rollback/reapply | 否 | 否 | 否 | 是 | 否 | 否 | 否 |
| `tests/integration/vertical-slice.test.ts` | submission authoritative upload switch | P0 服务端读模型证据 | 否 | 否 | 否 | 是 | 否 | 否 | 否 |
| `tests/unit/miniprogram-page-behavior.test.ts` | media-closed、privacy-refused、account-switch behavior | 证明不调用 chooser/network且不保留前一会员数据 | 否 | 否 | 否 | 是 | 否 | 否 | 否 |
| `tests/unit/miniprogram-flow-safety.test.ts` | source-order assertions | 防止阻断逻辑后移 | 否 | 否 | 否 | 是 | 否 | 否 | 否 |
| `tests/unit/privacy-inventory-gate.test.ts` | API/WXML/migration/egress hashes | inventory 不是静态文档，缺项使 gate 失败 | 否 | 否 | gate | 是 | 否 | 否 | 否 |
| `scripts/license-report.ts` | legacy `licenses[].type` fallback | 完整执行本轮要求的 dependency/license gate；不改依赖 | 否 | 否 | gate | 否 | 否 | 否 | 否 |
| `docs/privacy/miniprogram-personal-data-inventory.json` | 全文件 + current hashes | canonical personal-data inventory | 否 | 否 | machine gate | 否 | 是 | 否 | 是 |
| `docs/CISME-PRIVACY-PERSONAL-DATA-ARCHITECTURE-AUDIT-2026-09-11.md` | P0/P1事实、矩阵、生命周期与未实现清单 | 人类可审计边界 | 否 | 否 | 否 | 否 | 是 | 否 | 是 |
| 本文件与 release `MANIFEST.json`/`SHA256SUMS`/verifier | 全文件 | 重建、部署与回滚证据 | 否 | 否 | release contract | gate | 是 | 否 | 是 |

明确排除 `apps/admin/src/main.ts` 全文件、`openapi/openapi.yaml` 全文件、working tree 中其他修改、任何 `.env`/key/token/cert、现有 legal documents、release-config、COS 配置、生产配置和小程序上传产物。

## 3. Migration 001 critical audit

| 域 | 最终决定 | 当前可执行性与防误报 |
|---|---|---|
| `privacy_request` 状态机 | 保留 version/due/resolution/completion 与单向 transition trigger | request 可处于 received/verifying/reviewing/responded/approved/executing/completed/partially_completed/failed/rejected/canceled；当前 API 只创建 received、回复 reviewing/responded、计划后 reviewing。非法跳转由 DB 拒绝。 |
| consent evidence | 保留 `consent_receipt` | purpose/version/document/scope/channel/hash/granted 时间不可改；只允许 active→withdrawn，不能恢复；当前没有自动采集所有历史 consent。 |
| retention policy | 保留 inactive registry | active 要求 enforcement_state=enforced，但当前没有 purge executor；默认空且不得宣称执行。 |
| legal hold | 保留 hold + binding | 理由/依据/批准/复核/到期证据不可改；只允许 active→released/expired，释放证据随后不可改；dry-run 记录 active hold 数。 |
| export job | 保留但 DB 强制 `plan_only` | 只能 planned/canceled；不允许批准、租约、attempt、archive key、hash 或 completion。真实导出 `NOT IMPLEMENTED`。 |
| erasure job | 保留但 DB 强制 `dry_run` | 只能 planned/canceled；不允许批准、租约、attempt、结果 hash 或 completion；不删除 member。真实删除/注销 `NOT IMPLEMENTED`。 |
| processor registry | 保留 inactive registry | 仅数据处理者审计边界；默认空、无 provider gate runtime，不能宣称已完成处理者治理。 |
| rollback | 收紧并保留 | governance registries、receipt、hold、job、event 或非基线 request 状态存在时必须拒绝 down；不会静默丢弃 control-plane 数据。 |

`planned`、`running`、`completed`、`failed`、`canceled` 在 schema vocab 中区分，但当前 plan-only/dry-run job 只能达到 `planned` 或 `canceled`。`running/completed/failed` 只是未来执行 migration 的状态词，不是当前能力；API/UI 不得显示“已导出”或“已删除”。

## 4. Migration 002 table-by-table audit

所有 8 表都与现有 `community_*` 品牌预览表物理隔离；当前 `community` switch 由 DB check 固定为 false，API 也拒绝开启，并且没有 `/v1/ugc/*` 路由。以下“删除策略”是未来实现要求，当前因为没有写入 route 不构成已交付能力。

| 表 | 业务责任 / 未来功能 | 与现有表重复 | 为什么现在保留 / 能否推迟 | FK / unique / index / version / delete / audit / retention | 个人信息与账号删除策略 |
|---|---|---|---|---|---|
| `ugc_post` | 正式帖子身份、作者、状态、可见性、当前版本 | 不重复；旧 `submission` 是邀请投稿，`community_*` 是固定品牌预览 | revision/media/moderation 的根对象；002 最小核心，不推迟 | author FK；作者+request key unique；public/author indexes；version；deleted_at；状态/公开时间 checks | 作者 member ID；未来删草稿，已发布内容按用户选择删除或匿名化，hold 时限制处理 |
| `ugc_post_revision` | 不可变帖子正文版本与审核状态 | 不重复；旧 feed/submission 不是可编辑 UGC source of truth | 发布必须绑定已批准版本；保留 | post/member FK；复合 PK；deferred current-revision FK；正文不可变；审核单向；无 soft delete | 作者 ID + 正文；账号删除前先删除草稿或把保留公开内容迁到匿名主体 |
| `ugc_media_asset` | 正式 UGC 私有媒体对象的授权/扫描生命周期 | 不重复；旧 `media_object` 绑定邀请投稿 | publication guard 需要可信媒体状态；保留，但 COS/上传不开 | owner FK；object key unique；owner/expiry indexes；状态/大小/hash checks；deleted_at | owner ID、对象 metadata；未来对象 GC 后保留最小删除证明 |
| `ugc_post_media` | revision 与媒体的有序绑定 | 不重复 | 防跨账号/跨版本媒体混用；保留 | revision/media FK；media unique；position PK/check；owner trigger；硬删 binding | alt text 可能个人信息；随草稿/帖子删除，hold 时限制处理 |
| `ugc_comment` | 正式评论线程和 tombstone 结构 | 不重复；旧 preview comment 只允许 dev/test 固定内容 | 正式社区的核心治理对象；保留，route 推迟 | post/author/self FK；author+operation unique；post index；version；deleted body 必须清空；thread trigger | author ID + 正文；删除时清正文并去身份化 tombstone，治理 hold 除外 |
| `ugc_report` | 举报提交与治理队列 | 不重复 | UGC 不可在无举报治理基础时开放；保留 | reporter FK；open-category partial unique；queue index；version；polymorphic target 尚无存在性 trigger | 举报人 ID/说明；仅治理角色可见，结案后按 policy 删除非必要说明 |
| `moderation_case` | 针对内容/媒体/会员的治理案件 | 不重复；旧 review_case 只处理邀请投稿 | publication safety 的最小治理根；保留 | report FK；active target unique；severity queue index；version；resolution checks | assigned operator、可能关联个人目标；账号删除不删除法定处置证据，仅最小化 |
| `moderation_action` | 不可变审核决定时间线 | 不重复 | 防止审核结论被原地改写；保留 | case FK；timeline index；immutable trigger；evidence 必须非空；无 update/delete | principal ID、最小 evidence；按治理/法定期限保留并限制访问 |

从原始 14 表候选中删除并推迟 6 表：`ugc_post_stats`（可重建投影）、`moderation_appeal`（产品状态机未定义）、`ugc_post_reaction`、`ugc_comment_reaction`、`ugc_follow`、`ugc_saved_item`（全部没有当前 runtime，且可在对应互动/删除/导出规则确定后独立迁移）。这不是功能删减；这些功能本来就未实现、未开放。

## 5. Release/rollback contract

执行顺序固定为 27→`202609110001`→verify→`202609110002`→verify。rollback 必须先 002 再 001；任一 guard 报数据保全错误即停止，不得绕过。rehearsal 只能在已核验的 `cisme_staging` 独立数据库进行，先在无 001/002 业务行时完成 down/up，再部署 API，再运行 synthetic rights 验证并清理合成数据。

runtime 发布只替换 API `index.js`，worker 文件与 lockfile 不变；release 目录从当前 staging release 复制后再放入已验证的 candidate。任何 baseline SHA 不匹配、migration ledger 不为 27、数据库含非预期 member/identity/rights/UGC 数据、community/uploads 开关不为 false、secret scan 命中或 reconstruction hash 不一致，均立即阻断。

## 6. 明确未实现

真实 export archive、下载、字段级 erasure、账号注销、任务 worker、maker-checker 批准、retention purge、processor runtime gate、UGC API/UI/审核 worker、举报目标存在性、申诉、互动关系、COS media、社区开放均为 `NOT IMPLEMENTED`。本候选不改变微信后台类别、不新增权限、不上传小程序，也不建议进入 P2，直到 P0/P1 staging 与设备/微信后台门完成。

## 7. Staging 执行与关闭证据

- 已在独立数据库 `cisme_staging` 完成 27→28→29→28→27→28→29 的逐步迁移、逐步验证、回滚和重放；9 个隐私表、8 个 UGC/治理表及原有事实均符合预期。
- runtime 由已部署 baseline `index.js` SHA-256 `557a190d3f898bd8bfeb67f421d31cb0637988d575f193876670ed72ab3d2bcf` 应用 compiled hunk 重建为 `7df242062417c1190b5c714ba4a34fb46cf927508989514d9e9aa5c088ed7f8b`，发布目录为 `/opt/cisme/releases/20260911T051500Z-p0p1-staging`。`worker.js`、`worker-once.js` 与 lockfile 保持基线哈希不变。
- 合成 runtime 验证覆盖上传开关权威投影、授权拒绝、零媒体写入、跨会员隔离、权利请求幂等、plan-only 导出、dry-run 擦除、非法状态阻断、legal hold、consent 单向撤回、inactive registry、审计最小化、community API/DB 双重关闭及无 `/v1/ugc/*` 路由；随后恢复精确空基线。
- 最终状态为 29 migrations、66 张 public base tables（含 `schema_migration`）、9/8 个基础表、0 member/identity/privacy request/event/job/UGC/pending outbox/DLQ 行，`uploads=false`、`community=false`，API/worker/Nginx/PostgreSQL 均 active+enabled，发布后 error journal 为 0。
- HTTPS 域名权威解析至隔离 staging，证书 SAN 为 `staging-api.cisme.cn`，有效期至 2026-12-09，TLS 1.2 验证通过且 TLS 1.1 被拒绝。本轮没有触碰生产、上传小程序、启用社区/COS 或增加微信权限。
- 小程序 hunk 仍是 audit-only：当前源码包结构门通过，但 DevTools 当前源码、16 路由、iOS/Android 真机与微信隐私后台证据未完成，因此不把 P0/P1 staging 验证误写为小程序发布就绪，也不建议进入 P2。

# CISME Owner 唯一交付门禁账本 — 2026-09-13

`ENGINEERING_MERGE_READY = FALSE`。本账本区分源码工程、GitHub 审查、独立 staging、微信平台、体验版和真机；任何一层 PASS 都不替代下一层。最终以 PR #3 的当前 HEAD 和小程序包 SHA 双重绑定验收。PRD 基线为 `docs/product/CISME-产品需求文档-PRD-V2.1-R4.md`，尤其 §6.3.1、§6.6.2、§6.8、§15.4–15.6。

## 2026-09-14 11:27 现况（优先于下方历史快照）

PR #3 仍为 Draft，最新代码提交 `a80040c`；小程序包源码 SHA-256 `cf5fe2fd9baadf7a71d8bdfb4629b832ddd44559739c2226d2199d402c83c791`。本地隔离回归为 366 单测、175 集成测试，构建、契约和包门禁通过；224 个注册 `/v1` 方法中严格主体/对象/字段/动作实测 10 个，剩余 214 个未逐项闭环。合成数据本地完整栈及恢复演练完成，但云端独立 staging 未部署。隐私导出仅限测试环境明确资料子集；擦除仅限获二人审批的合成自报微信号，正式导出/删除/注销/撤回均未放行。A 限流和身份源码回归完成，B/C 其余工作仍开放；详见对应分项证据。

当前包在微信开发者工具独立轻量窗口中只观察到游客首页及游客隐私权利页默认态，两张未经处理的原始模拟器截图与 SHA、采集路径见 `docs/evidence/visual/pr3-cf5fe2fd-20260914/README.md`。这是 **2 个默认态观察，不是 2/37 页面矩阵 PASS**：完整 DevTools 路由状态 0/37、iOS 真机 0/37、Android 真机 0/37、体验版 0，`current-source-acceptance.json` 仍 `finalResult=blocked`。用户使用开发者工具时不抢占其页面。

`a80040c` 对应 GitHub `verify` 首次失败，原因是 Gitleaks 将隔离擦除测试中的固定 `idempotency-key` 误识别为 `generic-api-key`，精确指纹为 `a80040c:tests/integration/privacy-rights.test.ts:generic-api-key:212`；该值只用于合成幂等测试，非凭据。本次仅对该已审阅指纹加例外，仍需新 HEAD 的 CI/secret scan 绿色结果，不能因本地通过而宣称 PR 工程门通过。GitHub ruleset、独立云 staging、微信主体/隐私/域名、合法支付、获授权双平台真机均缺外部证据。`CODE_SECURITY_READY=false`、`CLOUD_STAGING_STATUS=BLOCKED`、`ENGINEERING_MERGE_READY=false`、`RELEASE_READY=false`。以下 A 阶段及 2026-09-13 段落是带时间戳的历史记录，不代表此刻状态。

## 2026-09-14 A 阶段历史快照

本账本下方 `2026-09-13` 的 345/162、46 提交与 `8c1185cf…` 是当时基线，**不能转写为当前版本结果**。本轮从 PR3 `557243a` 起步，PR2 base 仍为 `f655fff`；A 阶段源码候选小程序 SHA-256 为 `cbeec1e98b46de2ce297915c48a29ad4795b12b2d6248964fad25b491fe27aef`。当前本地 51 文件/348 单测、33 文件/168 集成测试、build/typecheck、219 方法契约、37 路由静态审计、250 文件包门禁通过；设计 QA 仍 `releaseReady=false`。详见 `docs/evidence/CISME-A-TRUSTED-ACTOR-RATE-LIMIT-2026-09-14.md`。候选提交及 CI 状态在提交/推送后以 PR3 实时状态为准，避免文件自指 SHA 无限提交。

原旧管理共享口令 actor 冒用已由合成测试复现并修复；入口与鉴权后分层限流、原生 429 恢复已完成源码/合成回归，**尚未完成 B 的 219 接口授权与日志、C 的隐私执行、D 本地完整部署、E 当前包 DevTools/真机**。独立测试容器是本地环境，不是云端 staging。当前总状态：`CODE_SECURITY_READY=false`、`LOCAL_STACK_VERIFIED=false`、`CLOUD_STAGING_STATUS=BLOCKED`、`NATIVE_RUNTIME_ACCEPTANCE=0/37`、`PRIVACY_EXECUTION_STATUS=PLAN_ONLY/DRY_RUN`、`ENGINEERING_MERGE_READY=false`、`RELEASE_READY=false`。旧章节中“下一件可独立执行：等待限流确认”已由 2026-09-14 Owner 明确授权取代，不再是阻塞项。

## BASELINE

| 项 | 实时核验结果 |
| --- | --- |
| main | `8e843a6b0a28628544202889217deda255e86c81`，本轮 fetch 后未前移 |
| PR #1 | `codex/u0-u1-review` → main；HEAD `6495101e27b26944ded2435605cc1835b76d51dd`；open、非 Draft，`verify` success；未合并 |
| PR #2 | `codex/commercial-closure-20260912` → PR1 branch；HEAD `f655fffffaa5567f5c6bbad98fef3c1e1f03ef7d`；open Draft，`verify` success；未合并 |
| PR #3 | `codex/native-closure-20260913` → PR2 branch；初始代码提交 `2ece6653f9bfdf76c600838a04e3fcd6ce692de7`；[Draft PR #3](https://github.com/Eysn0130/cisme-wechat-miniapp/pull/3)，未合并；本账本文档提交后须重核 HEAD/CI |
| 小程序包 | SHA-256 `8c1185cf3b7968c1d8ef32fe31f05270cda41d2ea26b9ed1e644d7004d41aa37`，250 文件、37 路由；文档修改不改变该源码 SHA，仍须每次验收重算 |
| 工作树 | 本独立工作树在开始时完全干净；其他三个工作树有各自未追踪的历史视觉/商业证据，无当时已跟踪的同文件修改；不能据此断言其他线程未来不会写入 |

## CHANGES / TESTS

`2ece665` 的范围是原生会话恢复/会员快照隔离、迟到地址回调拒绝、points/orders/invite/task/progress/settings 等状态归属及 37 路由静态审计；不修改旧 PR2 工作树。本轮新增的只是隐私 API 矩阵、微信平台只读门禁、主体决策和本账本；尚未改 API 限流、UGC provider、数据库、部署配置或平台设置。

| 当前代码 HEAD 本机检查 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run build` | PASS / PASS |
| `npm test` | 51 files / 345 tests PASS |
| `npm run test:integration` | 31 files / 162 tests PASS；专用 `cisme_closure_test_20260913_91ad` 先确认不存在后创建，仅测试合成数据，结束时活动连接 0，`dropdb` 后存在数 0；未接触生产库 |
| `npm run lint:contracts` | 219 个注册 `/v1` 方法与 OpenAPI 对齐、32 个事件对齐；PASS，不证明授权矩阵 |
| `npm run miniprogram:route-audit` / `npm run miniprogram:package-gate` | 37 路由静态清单 / 250 文件预算 PASS；不等于运行时通过 |
| `npm run design:qa:status` | 结构 PASS，`releaseReady=false`：37 路由状态、当前 DevTools、iOS/Android、开放 P0/P1 缺证 |
| Gitleaks 8.30.1 / `git diff --check` | 46 提交无泄漏 / PASS；本轮文档提交后重跑 diff check 与 GitHub CI |
| `npm audit --omit=dev --audit-level=high` | 0 漏洞；`npm audit --audit-level=critical` 退出 0，但报告开发期 `miniprogram-simulate` → `less/image-size`、`postcss` 共 4 个 high；未证明 CI 接收恶意输入时无风险，禁用 `npm audit fix --force` 大范围破坏性降级 |

## GITHUB GOVERNANCE

2026-09-13 GitHub API 返回仓库 rulesets `[]`、`main` branch protection 404；PR1/PR2 review threads 均 0；Actions 只有 `.github/workflows/ci.yml` 的 `CISME R0 gates`，PR3 两次 `verify` success。`candidate-design-qa` 与 `wechat-credentialed-preview` 均因条件不满足而 skipped，绝非设计/体验版 PASS。仓库 environments、Actions secrets、variables 的 API total_count 均为 0；这不证明云上没有旧服务，只证明当前 GitHub 没有可见的受保护部署门。

Owner 可审查的 ruleset 建议（**本轮不修改设置**）：目标 `main`；要求 PR、当前 HEAD 的 `verify`/设计候选检查、解决 review conversations、分支保持 up-to-date、禁止 force push/删除；在独立 staging 环境完成并能产出可信 deployment status 后，再评估 require staging deployment before merge。先确认 GitHub 套餐与保护能力，再以测试 PR 演练，不把 `verify` 的成功冒充微信或 staging 门。PR 合并只在所有工程门齐备后依 PR1→PR2→PR3 顺序执行。

## WECHAT PLATFORM / SUBJECT

平台后台访问被浏览器安全策略阻止，未尝试绕过。账号主体、认证、类目/资质、备案、隐私指引、合法域名、接口/插件、体验/正式版状态均为 `HUMAN VERIFICATION REQUIRED`；见 `docs/evidence/platform/CISME-WECHAT-PLATFORM-GATE-2026-09-13.md`。源码 AppID 仅掩码 `wx4e…299b`，不得推断与运营/商户主体一致。A 微信、B 计划运营、C 域名实名/ICP、D 商户、E COS/云账户尚缺同日脱敏对照；`PRODUCTION SUBJECT GATE = BLOCKED`，见 `CISME-SUBJECT-ALIGNMENT-DECISION.md`。

## STAGING

**未部署 PR3**。先前文档记载旧版本的 `staging-api.cisme.cn`、独立 `cisme_staging` 与迁移 29；这是历史证据，不是当前 PR3 的目标隔离、DB role、worker、COS、secrets、logs、队列、支付、UGC、回调或 rollback 证明。本机 DNS 返回保留测试地址 `198.18.0.147`，本机 HTTPS 握手失败；不能把这次网络环境故障判为线上宕机，也不能作为 staging smoke。当前无可用的受保护 GitHub deployment environment，且未核实云目标的实时 owner/资源/费用。故 `STAGING_DEPLOYMENT=BLOCKED`；不使用旧主机、不创建资源、不改域名、不连接可能包含真实用户数据的库。

解锁最小证据：Owner 提供当前独立 staging 的脱敏资源清单与可授权的只读/部署通道；确认 API/DB+DB role/worker/COS 私有桶或前缀/secrets/logs/queue/payment disabled/UGC closed/callback 全部不指向生产；再做备份、migration/向后兼容、rollback、TLS/domain/config diff。只有当前 PR3 CI+secret scan 绿且 exact SHA 固定才可部署，之后以 synthetic data 验证 health/read/write/worker/COS/auth/UGC pending/failure/restore/restart。

## ROUTE / DEVICE ACCEPTANCE

37/37 路由已静态编目；**当前源码运行时 0/37 PASS，剩余 37**。DevTools 当前 SHA 的完整状态矩阵 0/37；iOS 0/37；Android 0/37；体验版 0。旧截图来源须保留但不可转为当前结果。用户正在使用开发者工具时不抢占其页面；此前相同 simulator screenshot Automator 根因已连续出现三次，不再重试同一 CLI 截图方式。后续须经可用桌面/人工/获授权真机路径取证，逐路由记 role、loading/empty/normal/error/retry/interruption/resume、网络慢/超时/离线、会话切换、请求/响应/截图/录屏与缺陷 ID。

## SECURITY / PRIVACY / UGC

源码范围的 45 个 `wx.*` 名称、全部 `open-type`、nickname input、唯一内部 `address-editor` 组件已列入 `docs/evidence/privacy/CISME-WECHAT-PRIVACY-API-MATRIX-8c1185cf3b7968c1.md`。平台声明与真机授权仍未闭环。`/v1` 入口未见通用限流，且旧 `/v1/admin/*` 仍以单个 admin token 加请求给出的 principal 标识作粗边界；不能仅凭幂等/请求体上限称防刷已完成。需按匿名 IP+端点、会员 principal+端点、管理 principal+capability+端点、资金 object+幂等、UGC action/resource 分别设计 429/Retry-After 和正反向测试；任何真实边缘/代理的 client IP 可信性需先核。

UGC 源码已有 WeChat v2 文字/图片安全适配器、可注入测试 fetch、扫描超时留 pending/error、作者草稿、版本化审核、双人公开复核、审核日志与公共开关；生产微信凭据/回调、COS 权限和人工排班未验证。当前配置/数据库门保持公众 UGC 关闭，staging 无真实 provider 时应维持关闭并测试 pending/失败路径，不能 fail-open。`community-compose` 选图未显式调用 `requirePrivacyAuthorize`，需当前微信环境验证并可能补代码。219 路由的主体×对象×字段×动作权限矩阵与系统化 IDOR/越权/过度披露覆盖尚未完成；现有集成测试不是全量证明。

## PAYMENT

本轮无真实资金。源码 `formalPaymentProtocol` 默认 outbound disabled，只有 `APP_ENV=test` 注入 synthetic transport 的测试路径；`isolatedPaymentProtocol` 也仅允 test。支付意图、主动查单、签名/解密回调、inbox 幂等与乱序、订单/金额/币种/OpenID 绑定、关单、退款、对账存在代码和合成测试，但真实商户/AppID 绑定、支付能力、APIv3 key **存在性**、证书状态、发货管理、真实回调、退款能力全部 `HUMAN VERIFICATION REQUIRED`。不得读取/暴露密钥材料；staging 只能 disabled/mock，production 真实支付/退款/商家转账分别为独立 Owner gate。

## 真正外部门禁与下一件可执行事项

1. Owner 在安全会话中提供脱敏的微信平台 A–E 主体/隐私/备案/类目/合法域名/商户绑定状态；浏览器策略阻止本代理直接读取，不能绕过。
2. Owner 证明或授权一个与 production 完全隔离、成本/资源范围明确的 staging 目标及合法部署访问；否则不得接旧环境。
3. Owner 提供可使用的 DevTools 当前包与获授权 iOS/Android 真机取证窗口；不得复用旧截图或同根因失败的 Automator CLI。

下一件可独立执行：把本文档证据提交到 PR3 并核 CI；等待 change-safety 对限流代码影响范围的明确确认后实施代码与定向测试。上述外部门未关闭前，PR3 始终 Draft，PR1/PR2/PR3 均不 Merge。

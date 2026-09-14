# A 阶段：可信管理身份与分层限流（本地合成验证）

基线为 PR3 `557243a56bc7e80a6519b759f4e26470d5c7fd89`，base PR2 `f655fffffaa5567f5c6bbad98fef3c1e1f03ef7d`。本文件记录代码与合成测试，不是 staging、微信后台或真机证据。小程序当前源码包 SHA-256 为 `cbeec1e98b46de2ce297915c48a29ad4795b12b2d6248964fad25b491fe27aef`；37 路由运行验收仍为 0。

## 问题、攻击前提与修复

原 `/v1/admin/*` 的 `adminPrincipal` 只比对全员共用的 `x-admin-token`，随后把客户端 `x-principal-id` 用作角色查询、双人复核和审计 actor。合成复现：**没有凭据**为 401；**掌握共享 token** 并填写数据库中另一位 `review_lead` 的 principal 时，`GET /v1/admin/reviews` 原实现返回 200（测试先失败）。这是共享凭据持有者间的 actor 冒用，不是无凭据游客越权。

现在旧管理路径仍保留，但进入相同的签名 Bearer 会话校验、账号活跃性校验；actor 只能来自验证后的会话，手填 `x-principal-id` 若与其不符直接 403。`principal_role` 的旧业务判定和审计、幂等、双人复核未删除，角色撤销立即 403，会员停用立即 401。`ADMIN_API_TOKEN` 不再授予权限，也不再是启动必需密钥；旧共享口令单独请求为 401。现代 `/v1/management/*` 继续使用 `AuthorityService` / `authority_grant`。受影响的真实旧调用方：`apps/admin` 浏览器运维台、`scripts/miniprogram-acceptance.ts` 本地合成夹具；两者已改为签名会话。历史 `scripts/r1-r2-staging-performance.mjs` 仍含旧接口/旧 token 格式，禁止作为当前验收或部署命令，待 B/D 阶段移除或迁移。正式运维台尚无获批准的会话签发/登录流程，**不得以手工复制生产会员 token 代替此门禁**。

## 限流边界

采用官方 `@fastify/rate-limit@11.2.0`（MIT、Fastify 5 兼容；官方 11.2.0 修复 IPv6 轮换相关安全问题）。入口 `onRequest` 在正文解析和数据库鉴权前按连接对端 IP（IPv6 `/64` 规范化）、method、Fastify 已注册 route template 计数；未匹配路径归一化为固定 `_unmatched`，不使用完整 URL、query、转发头、token 或 Idempotency-Key。`trustProxy` 仍是 Fastify 默认关闭：没有当前生产代理链证据，故不信任 `x-forwarded-for`。登录、分享访问、短期媒体上传、平台回调、DB readiness 使用独立阈值；liveness 无 DB 操作，明确豁免。支付/退款/转账与 UGC 安全回调仍走原验签/幂等链，没有被强加会员登录，但有入口桶。

鉴权后只对有效签名、当前活跃会员进行第二层计数：会员按 member + method + route template，旧管理按签名 principal + 能力组 + method + route template；管理写入、资金写入、UGC 写入分开阈值。资金/媒体等动态对象 ID 不单独作为唯一桶，轮换 ID、query、Idempotency-Key 不能摆脱主体桶。超过阈值返回 `application/problem+json`、稳定 `RATE_LIMITED`、429、`Retry-After` 秒数及 cloud HTTP 可保留的 `retryAfterSeconds`；不记录原始 token 或请求正文。

默认值只用于待压测校准的**单 API 进程**本地容量保护：60 秒窗、10,000 LRU key，入口 600、登录 30、分享访问 120、回调 1000、上传 30、readiness 120、会员 180、管理写入 60、资金写入 30、UGC 写入 60。均可由 `API_RATE_*` 环境变量覆盖，范围有校验；合成测试把窗口缩到 1 秒、会员限 2、特殊入口限 2，并为 100 并发登录测试单独设 200。计数随进程重启消失，多个 worker/实例互不共享，LRU 满时旧 key 可被淘汰；**绝不宣称全局配额或已抵御分布式/代理层流量**。云端隔离、真实代理链与 P50/P95 未核，生产阈值未批准。

原生客户端保留 401、403、429、网络异常区分：429 不清会话、不清草稿、不自动重建订单；写操作不自动重发。仅首页/会员/配置等必要 GET 在 `Retry-After` 为 1–2 秒时最多退避一次，切号或离页后不发第二请求；其他 429 交给页面显式恢复。真机与云函数传输仍待当前 SHA 取证。

## 验证与剩余项

本轮独立容器 `cisme-pr3-local-postgres`、独立数据卷 `cisme_pr3_local_postgres_20260914`、数据库 `cisme_pr3_test`，仅使用合成身份及数据；未连接旧 staging/production。`npm test`：51 文件 / 348 PASS；`npm run test:integration`：33 文件 / 168 PASS；`npm run build`、`lint:contracts`（219 `/v1` 方法、32 事件）、37 路由静态审计、250 文件包门禁、`git diff --check` 均 PASS。设计 QA 结构正确但 `releaseReady=false`。新增针对共享凭据 actor 冒用、签名 actor、撤权/停用、同 NAT 会员隔离、伪造转发头、动态 URL/幂等键轮换、窗口恢复、回调/上传/readiness 桶与原生 429 不重试写入的定向回归。

`npm audit --omit=dev --audit-level=high`：生产依赖 0；完整图仍有开发期 `miniprogram-simulate` 传递链 4 high，不能等同于 CI 不可信输入风险已关闭。当前补丁 Gitleaks stdin 扫描无发现，提交后须扫描完整 Git 历史与 GitHub CI。B 阶段仍需逐路由对象/字段权限映射、合成敏感标记日志回归，以及正式运维登录迁移裁决；因此 `CODE_SECURITY_READY=false`、`ENGINEERING_MERGE_READY=false`。

官方依据：[Fastify rate-limit 用法与单实例/外部 store 说明](https://github.com/fastify/fastify-rate-limit/blob/v11.2.0/README.md)、[v11.2.0 安全发布](https://github.com/fastify/fastify-rate-limit/releases/tag/v11.2.0)。

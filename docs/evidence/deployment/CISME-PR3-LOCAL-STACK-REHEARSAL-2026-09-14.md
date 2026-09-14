# PR #3 本地隔离服务端演练

状态：`LOCAL_STACK_VERIFIED`，仅指下列本地合成场景；`CLOUD_STAGING_PASS`、真实 COS/微信互通、生产权限与应用旧二进制回退均未验证。需求基线是 `docs/product/CISME-产品需求文档-PRD-V2.1-R4.md`（正文 R4.2）。本轮未读取真实凭据、远程数据库或真实业务记录；无支付、退款、商家转账或公众 UGC 出站。

候选提交回归：单测 362/362、仅指向本轮 `55433` 的集成测试 169/169、`build`、`lint:contracts`（219 个 `/v1` 方法）与小程序包预算通过；这不是微信原生页面验收。

隔离资源：`cisme-pr3-local-postgres`（PostgreSQL 18.4，独立卷 `cisme_pr3_local_postgres_20260914`，只映射 `127.0.0.1:55433`）；新库 `cisme_pr3_stack_20260914`、恢复库 `cisme_pr3_restore_20260914`；运行角色 `cisme_pr3_runtime` 无 superuser/建库/建角色/建表权限，只有当前本地 schema 的 DML 与序列权限，`schema_migration` 禁止写。它是演练用受限角色，不代表已完成生产表级最小权限设计。API 仅监听 `127.0.0.1:18191`（制品复测 `18192`），独立 worker 进程；媒体在本轮专用临时目录 `/tmp/cisme-pr3-stack-20260914.v38y77/tmp/object-storage`，未复用 `infra/compose.yaml` 的 `cisme-r0` 卷。测试密码只在本地进程环境中提供，不入仓库或证据。

| 验证项 | 实际结果 |
| --- | --- |
| 空库迁移 | `scripts/migrate.ts up` 从空库应用 70 个迁移；运行角色能读迁移数，`CREATE TABLE` 被 PostgreSQL 拒绝。 |
| 旧 schema 前向升级 | `commercial-forward-upgrade.test.ts` 与 `migration-lifecycle.test.ts` 在 `TEST_DATABASE_URL=127.0.0.1:55433/cisme_pr3_test` 的临时库 2/2 通过；包括 PR1/PR2 合成旧事实及 N-1 迁移生命周期。 |
| API/身份 | `/health/live`、`/health/ready` 均 200；合成 dev 身份创建、`/v1/me` 读取、`PUT /v1/me/profile` 写入与版本 1 通过。此 dev 适配器只在 loopback 本地演练启用。 |
| worker | 独立进程消费 `support.message.created.v1` 为 `audit_only`；合成无效发布事件记录安全错误码 `UGC_GO_LIVE_GATE_CLOSED`，停止/重启后由 2 次增至 3 次，最终 5 次进入 `MAX_ATTEMPTS_EXCEEDED`，没有错误正文或 UGC 公开事实。 |
| 受控媒体 | `scripts/pr3-local-stack-smoke.ts` 实际走客服媒体 authorize → chunk → assemble → complete → 消息绑定 → 本人读取；另一合成会员读取 404。另一张已完成但未发送的图经本人删除，worker 队列 `processed=true,attempts=1`，本机对象文件数 2→1。首次 `assemble` 因本机目录未初始化返回 500；最小修复在授权写入前幂等 `mkdir`，针对性单测和重跑 smoke 已通过。 |
| 备份与恢复 | 使用本轮容器 `pg_dump -Fc` 备份到 `/tmp/cisme-pr3-stack-20260914.v38y77/backups/cisme-pr3-stack.dump`（561 KiB，SHA-256 `ad5a9392f20f8da02d833f1812b836fd3e522a3a2045b08064af048292c9ddbe`），恢复到另一新库。恢复前源/目标同为迁移 70、会员 5、资料 3、已上传媒体 1、已删媒体 1、audit-only 事件 1；重启 API 指向恢复库后 readiness 200、旧合成资料仍为版本 1。随后在恢复库另跑一次独立 smoke 通过。 |
| 制品/配置 | `node scripts/package-tencent-release.mjs` 产出 API、独立 worker、one-shot worker 与锁定生产依赖；4 个 manifest 文件哈希重新计算一致，`configurationIncluded=false,deployed=false`。该制品 API 在恢复库 readiness 200，完整合成 smoke 通过；worker 制品能独立启动。`scripts/validate-pr3-runtime-config.ts` 在本地 API/worker 两角色通过，错误角色与非本轮库被单测拒绝。 |

安全与限制：本地网关存储是进程工作目录下受控文件，不等于 COS/IAM/跨实例持久化证明；PostgreSQL 与文件对象备份非原子，本次只验证 DB 备份及仍在同一受控目录中的媒体，不宣称跨主机完整对象恢复。旧应用二进制在新 schema 上的兼容性未实测；数据库恢复到独立库并由当前制品读取事实是已验证的回退替代路径。正式部署仍须单独确认目标、资源隔离、配置、对象备份、回滚和外部授权。

隔离修正：原两份迁移测试硬编码了本机 `55432`。本轮早先整包运行使它们在旧本地 PostgreSQL 实例临时建库并按测试清理逻辑删库；未连接远程 staging 或旧主业务库，但违反本轮仅用本轮容器的操作边界。现已改为从 `TEST_DATABASE_URL` 派生管理连接，定向 2/2 在 `55433` 重跑；之后不再使用 `55432`，也未改动旧容器。临时库清理为测试代码结果，未再对旧实例做额外检查。

复现命令入口：`npm run build`、`node scripts/package-tencent-release.mjs`、`npx tsx scripts/validate-pr3-runtime-config.ts local-stack api|worker`、`CISME_PR3_LOCAL_STACK=true CISME_PR3_API_ORIGIN=http://127.0.0.1:18191 npx tsx scripts/pr3-local-stack-smoke.ts`。数据库、会话与上传密钥等变量须由本轮独立的本地合成配置提供；预览/云端配置不复用这些密钥。当前本地 API 和 worker 已停止，隔离容器与合成数据库/备份保留供复核，不删除任何其他资源。

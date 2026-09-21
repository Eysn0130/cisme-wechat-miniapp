# 本轮测试目标误重置记录

2026-09-21 06:43:52 America/Los_Angeles，一次 `commerce-history-gates.test.ts` 定向补跑漏传 `TEST_DATABASE_URL`。当时测试工具回退到 `127.0.0.1:55432/cisme_test`，resetDatabase 执行了 public schema 重置及现有迁移，然后 126 项合成测试通过。这次成功不能算安全隔离验证。

发现后立即尝试停止，但命令已经完成。只读环境检查确认调用进程没有 TEST_DATABASE_URL/DATABASE_URL；Docker 端口元数据将 55432 归于现有 `cisme-r0-postgres-1`，Compose 来源为本仓库 infra/compose.yaml。代码在 reset 前查询实际 current_database 并限制 cisme_*test* 名称，因此目标是默认本机测试库，不能据此推断其中没有有用数据。未提前备份该旧库，原内容与受影响的其他本地测试会话未知；不能声称已恢复或无损。没有继续写入/尝试重建旧库，也没有读取其个人数据。默认测试库数据需要其使用者根据已有备份或已知夹具恢复；本轮未自行作出恢复决定。

正式本批全量集成验证始终以显式 URL 指向本轮新建 `cisme-pr7-followup-test-20260921` 容器的 `cisme_pr7_followup_test`（127.0.0.1:32768），两者分开记录。误运行日志保留在 tmp/pr7-followup/unused-env-check.log，SHA 见 receipt.json。该日志不计入隔离测试成绩。

修复：testkit 不再默认选择 URL，也不回退 DATABASE_URL；testPool 创建前须有显式 TEST_DATABASE_URL；resetDatabase 在发出查询前验证显式目标，并在任何 DROP 前比对实际库名。用模拟 pool 证明缺目标不查库、目标不一致不执行破坏性 SQL、普通/生产名拒绝。旧规则下 3 项失败，新规则下通过。README 同步说明，CI 已设置显式 URL，未降低任何验证门。

这项保护防止相同的遗漏，不能取代操作前确认实际主机、库、角色、用途和可重置性，也不能撤销本次误重置。没有调用真实资金、公开 UGC、正式隐私删除接口，也没有生产发布。上述数据库误重置的原数据影响仍记未知，不能据此保证旧测试库中没有个人资料。

PR8 合并后入口复核补充：导出的 TEST_DATABASE_URL 在显式存在时也执行测试库名验证，防止不经 testPool 的直接消费者跳过原有校验；无目标仍不在导入时建立连接。新增动态导入反例在修复前失败、修复后通过。该补充不改变小程序包或数据库状态。

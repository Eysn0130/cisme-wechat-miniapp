# 生产基线迁移事务修复

生产只读观察为 PostgreSQL 16.15、23 项迁移（止于 202609090006），当前源码含 75 项。此次没有执行生产迁移。

根因：14 个历史迁移 up 段自带完整 BEGIN/COMMIT；源码/制品迁移器又包外层事务。PostgreSQL 不提供嵌套 BEGIN 事务，内部 COMMIT 会提前提交结构修改。随后 schema_migration 写入失败时，外层 ROLLBACK 已无法撤回 DDL。官方说明：https://www.postgresql.org/docs/18/sql-begin.html 。

隔离复现 run `942fe11817bd8e73a8ec8c57`：在 schema_migration 上注入仅拒绝首项新迁移的触发器。旧执行器报错后 care_record_step 仍存在，测试按预期失败。资源已按本轮归属清理，未访问旧 cisme_test。

修复只在执行内存中剥离完整、首尾锚定的历史 BEGIN/COMMIT 包装，保留 SQL 文件原字节与哈希，由执行器原事务同时提交 DDL 和迁移记录。完整制品校验仍先于驱动加载/DB 连接；production 制品仍不提供 down。

新回归同时运行源码迁移器与完整 manifest 校验后的制品迁移入口。记录失败后两者都必须不留下 DDL；解除合成故障后升级 23→75，再重复执行为零增量。验证原成员、同意记录、护理记录和隐私请求保留，旧护理明细保持未知，不虚构步骤；不自动产生订单。模拟包中 API/Worker 为明确 inert fixture，本测试不是完整制品业务验收。

定向两项通过，run `f81bcc9d6252ca112317ef47`；全量集成 807 项/46 文件通过，run `7361d37065e36095eee76c18`。全量单元 1072 通过、1 跳过；Python 47 通过，构建/类型/契约通过。

本地默认隔离 PostgreSQL 为 18.4。增加限定白名单的 16.15 镜像选择，是为了匹配实际 production；16.15 镜像下载未完成，本轮已停止挂起下载且未创建该 run 容器，不计 PG16 验证通过。Docker 控制调用现在有 120 秒上限。production 的 Ubuntu 打包/扩展、现场 SQL 历史哈希、真实数据不变量与回滚兼容仍需进一步验收，不能以本测试代替。

原始生产加密 COS 备份已只读验证最近副本 SHA 与原回执一致，没有执行生产恢复，也没有运行带自动删除的备份任务。旧 cisme_test 事故：UNKNOWN / 未恢复。

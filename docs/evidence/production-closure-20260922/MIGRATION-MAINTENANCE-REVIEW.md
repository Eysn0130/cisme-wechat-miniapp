# 迁移维护与保留数据升级入口

范围：PRD R4 的真实权限、资金/履约事实保持不变；承接 NEXT-CODEX-EXECUTION.md M 节。第一阶段正式管理客户端仍只有微信小程序；不新增 PC 登录、Session 或 Web Admin 制品。

## 复现与修复

原 CISME_MIGRATION_READ_ONLY 只拦截 API 非读取请求；后台循环、单次定时 Worker 和 UGC 扫描仍可以启动任务。两项 Worker 回归在修改前失败（tmp/migration-maintenance-reproduction.log：2 failed /6 passed）；UGC 维护/排空两项也独立复现失败。

现在 API 与 Worker 共用严格解析：仅省略/false 表示关闭，true 表示维护，其他值拒绝而不输出原值。共享 Worker 循环暂停新任务准入；单次入口在初始化存储/数据库之前返回 maintenance=true/workExecuted=false。UGC 扫描复用已有循环并等待已接收任务完成。API/Worker 关闭时同时停止各通道准入，再等待在途任务结束，最后关闭连接池。

此开关不是数据库全局写锁，也不会取消已执行到一半的 Provider 调用。正式迁移仍须停止并排空全部本机服务、定时调用与外部旧消费者；不能仅设置开关后立即迁移。

本地最终验证：1133 单元通过、1 跳过（103 文件），835 集成通过（48 文件），build/typecheck 与246项/v1契约、32事件检查通过。精确日志为 tmp/migration-maintenance-final-{full,build,contract}.log。未用前一版本 CI 代替新增代码 CI。

## production 真实历史

production-migration-audit.py 在认证的原 production TAT 会话中实际执行，仅本地 peer 身份只读查询原 cisme。原始报告 PRODUCTION-JOURNAL-20260923-RAW.json：23项已执行迁移、46表、202约束、0未验证约束。其23个迁移名称是44e1789候选76个名称的前缀，待执行53项，详见 PRODUCTION-MIGRATION-PLAN-44e1789.json。

首个探测因受限 PATH 未含 runuser 路径而停止，输出仅固定失败码；已改用 /usr/sbin/runuser 与 /usr/bin/psql，重新实测成功。未创建、迁移、清空或恢复生产库。名称前缀匹配不证明历史 SQL 内容或真实生产恢复通过。

## 实际升级入口

infra/tencent/production-release.py 已直接调用 production-observation.guard_for_upgrade 及原 production-target.py。preflight只读；apply必须显式提供批准引用与受保护的独立审查材料。没有创建可供生产消费的通过/批准标志文件，没有执行 production apply。

入口核对现场实例/DNS/原DB/COS，实时读取 GitHub main SHA/tree 与该 main 最新 push CI；PR CI不能替代。先从准确main读取迁移入口源码并比对，再运行完整制品verify。拒绝秘密/数据库/COS隐式替换、API监听变化、环境注入和打开交易/后台写入的候选。

迁移前必须提供绑定准确新旧制品的真实保护环境恢复、角色/全局对象、COS、密钥恢复、历史SQL审查、外部写入方排空和保留新写入的回滚证据。资料须新鲜、根账户保护并按哈希绑定；缺少任一项拒绝。测试中的假资料只存在于 mocked reader，不能作为生产批准文件。

实际切换路径会停止API/Worker、拒绝残留DB客户端、重新核对main与现场，再对原库执行前向迁移、切换原有服务与配置、核对运行进程目录和TLS。失败仅在已审查的兼容范围内恢复旧应用/配置；没有数据库恢复、down、reset、seed、创建空库或生产防火墙/凭据操作。遇到其他人并发改配置会保持现场并要求人工恢复，不覆盖未知修改。成功返回也只代表关闭交易的维护部署，不代表 productionValidated 或 commerceEnabled。

离线测试覆盖wrong-host早拒绝、真实main/PR CI边界、较新失败CI、伪造verify入口、隐式改密/环境注入、未完成恢复/旧消费者、切换失败、部分迁移、原库新写入保持与并发配置保护。完整Python组91+4=95通过；这些是离线编排/拒绝路径证据，不是production实测切换证明。

## 尚未完成

- 生产完整恢复与历史SQL完整性、旧CloudBase消费者收口、旧生产制品对新schema的兼容实测；缺失材料不能伪造给入口通行。
- production凭据泄露事件未轮换，5432/22范围未收敛，443仍需对应批准后解决。
- 正式全主体隐私导出/删除/保留、交换/重新寄出与退货库存处置、真实手工运单适用资格、全部接口13维结论、全状态/iOS/Android验收仍有技术或平台缺口。
- 用户确认退货地址/电话、正式政策/保留期限、生产告警接收渠道尚无单独批准资料，继续作为上线前外部待确认项。
- 备案仍为用户提供的“小程序备案 管局审核中”；不推断代码审核，不撤回/重提。旧cisme_test事故影响UNKNOWN/未恢复。

## 本机TLS与公网权限分离

后续复核将升级入口的健康检查明确限定为127.0.0.1传输、api.cisme.cn SNI与完整证书验证，避免要求先把旧生产版本公开暴露才能准备关闭交易的新候选。无--insecure、无网络规则修改。新增一项边界回归后完整Python组92+4=96通过；公网443放行与外部HTTPS验收仍须对应批准及实测，不由本机200代替。

## 停服后的复核顺序修正

继续独立复核发现：cutover 停止 API/Worker 后再次调用 preflight，而 preflight 原本无条件要求旧 API 的本机 HTTPS 返回200，导致正常停服也会触发应用回滚。离线状态回归先复现失败（26项中1项错误，`UPGRADE_FAILED_APPLICATION_RESTORED_REVIEW_REQUIRED`），再修正为：首次预检仍验证本机 TLS；停服后的复核保留来源、现场目标、配置、迁移历史全部检查，并明确要求两个服务均为 inactive 且 MainPID=0。切换启动后仍验证两个实际进程及完整 TLS。没有跳过正式验收、没有修改网络或生产状态。

修正后 Python 全组95+4=99项通过。3976f4f 的准确 CI35813185461 为1134单元、835集成、96项Python；它绑定修正前源码，不能作为此次修正的CI回执。后续准确HEAD/CI以PR Checks为准。所有证据均不代表production已经部署。

## 制品内部权限边界

继续复核发现：原目录检查只验证release顶层，未拒绝内部由服务账号持有或组/其他人可写的依赖，也未拒绝依赖符号链接越出release。离线真实文件夹回归复现3个失败断言。现逐项检查制品内容的root归属和只读权限；仅允许解析到同一受保护release内的链接（保留npm `.bin`正常链接），拒绝特殊文件及超限树。没有更改服务器文件权限或扩大服务账号权限。

修正后Python全组98+4=102项通过。上述测试的root归属为本地stat替身，不创建生产批准资料、不运行生产切换。完整最新CI仍须绑定此次新HEAD。

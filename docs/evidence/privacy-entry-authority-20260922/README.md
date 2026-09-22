# 隐私入口事务授权续作（PR16 合并之后）

起点 main `302d0f602a407e9dd512c2c0fb69bc14a22793c4`，PR16 已普通合并且 main CI `35691669873` 成功。本目录接续该事实，不改写 PR16 施工时的历史快照。唯一工程仍 `/Users/mini/CISME`，未创建 Goal 或第二项目。

## 本次源码

- 会员请求列表/提交/导出撤销在各自事务内锁定并复核 active member。
- 管理队列、回复、计划、导出/删除批准、失败恢复将签名 HTTP 会话的 member 带入事务，复核 active actor 与当前 principal_role；客户端输入不能选择 actor。缺少 member 的管理会话拒绝。
- 作业操作按 job → request → actor → role 锁序，与后台执行保持一致。角色撤销和账号封禁若先持有锁，后到动作必须等其提交并拒绝，不能沿用 preHandler 的旧判断。CLI 无会员会话，仍以受保护运维 principal 的当前角色授权。
- 计划按 operation/principal/key 加事务 advisory lock；成功重放仍重新核权，同键不同内容保持冲突。重复并发只有一个 job、一个 audit。
- 迁移升级测试在关闭自己的连接池后普通 DROP 自己新建的随机库；移除不必要的 FORCE，避免服务器强制终止尚在关闭的连接而产生未处理错误。没有访问旧 cisme_test。

## 验证与失败保留

Node 24.18.0。完整本地：985 单元 PASS、1 平台条件 SKIP；753 集成 PASS（45 文件）。build/typecheck/contracts PASS。226 个 /v1 方法 + 2 health = 228，32 个 typed event，无新增 HTTP 路由。原生源码未修改；不是新的原生/真机全状态验收。

新文件 `tests/integration/privacy-entry-authority.test.ts` 共 16 项。第一阶段旧源码 10/10 RED，第二阶段仅角色修复后账号封禁 6/6 RED；最终完整回归全部通过。独立 PG 事务真实持锁并检查无错误 job、状态、回复、审计、制品撤销副作用。既有 privacy-rights 13、privacy-execution-authority 9 项继续通过。

一次早期完整运行的 747 断言虽通过，但出现临时升级库清理的未处理 57P01，整次记为失败；修复后重新完整运行 753 项无未处理错误。一次定向命令因 PATH 未包含 vitest 返回 ENOENT，未计为测试通过；另一次在三个 HTTP caller 尚未接入 actor 参数的中间状态运行，3 项失败，已接线后由最终完整回归覆盖。这些失败没有被删除或包装为通过。

最终 disposable run `61e9f8140f035b5b88674c55`，runner 记录本轮专属 DB/S3 创建与移除。旧事故仍为影响 UNKNOWN、未恢复。本轮没有生产删除、真实资金、正式提审或发布。

## 审阅边界

`reviewed-13-axes.json` 对 10 个隐私方法逐项记录 13 维。本次是实际复核切片，不是全接口安全通过。完整主体 resolver、多主体字段投影、二次验证、全范围导出/撤回/注销、媒体/链接/缓存/日志/备份政策执行仍为工程缺口。正式交易、履约、全部原生状态/设备、多实例告警恢复亦未完成，不能改列为负责人补截图。

当前批准政策/保留规则、staging 实例归属仍待真实材料；公众/商户站点策略阻止及云控制台超时只阻断对应核验，不代表服务未开通。备案仍按用户报告审核中。

# PR #3 数据权利合成执行 schema 增量

本迁移 `202609140001_privacy_synthetic_execution.sql` 的必要性：既有 `data_export_job` 明确禁止 `plan_only` 以外的执行状态，`data_erasure_job_dry_run_only` 明确禁止任何 apply；没有持有私有导出结果的表。因此不能只把应用布尔值改为 false 或伪造 `completed`。本迁移先提供最小、向后兼容的执行状态保护与加密结果容器；它本身**尚未实现执行器、用户交付或删除**，正式环境仍不得执行。

数据影响：新增 `privacy_export_artifact`（每个导出作业至多一行；仅密文、随机 IV、认证标签、到期/撤销时间，不存明文密钥）；放宽擦除约束仅允许 `syntheticOnly=true` 且 `delete_scope`/`withdraw_purpose`，并以触发器再次要求关联 `dev_test` 微信身份命名空间。现有计划作业、旧成员、原表字段和默认值均不改变；非 dev 身份即使直接改 DB 也被拒绝。未修改率限迁移。真实数据保留、法定期限、二次身份核验和生产执行策略仍 `POLICY PENDING`。

兼容/恢复：旧应用可继续读写原 `plan_only`/`dry_run_only` 路径；新表无人使用时可安全 down。若已存在加密制品或任何非计划/非 dry-run 作业，down 明确拒绝，必须先保全数据并走备份恢复，不强行逆转。只在本轮 `55433` 隔离测试实例上验证前向迁移与 N-1 生命周期；未授权也未执行任何远程迁移。

验证：`privacy-rights.test.ts` 8/8，包括无 `syntheticOnly` 的 dev 作业和有 `syntheticOnly` 的非 dev 作业都被 DB 拒绝；旧 plan-only/dry-run 回归仍通过。整包单测 362/362、隔离库集成测试 170/170、构建与契约通过。个人数据清单新增 `privacy_request` 与 `privacy_export_artifact` 两项并刷新迁移集 SHA-256 `bef18371e81e95efa778221dbe978fa30c60deea05d251711f23e5a8a8ec9c81`；没有把 schema 能力冒充实际运行证据。

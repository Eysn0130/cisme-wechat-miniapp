# PR3 合成资料字段删除：隔离执行边界

需求基线：`docs/product/CISME-产品需求文档-PRD-V2.1-R4.md`（正文 R4.2）P20/A11、§7.7。本文只记录本轮合成数据、隔离数据库的行为；不是正式删除政策、法律结论、云端联调或真机验收。

## 实际执行的最小范围

`POST /v1/me/privacy-requests` 的可选 `scopeCode=member_profile_handle_v1` 只在 `APP_ENV=test` 的 `dev_test` 会话和 `kind=delete` 下接受，落库后数据库触发器拒绝更改。自由文本或旧请求没有这个范围码，不能自动升级成删除授权。第一名签名 `review_lead` 建立 `dry_run` 计划；第二名不同的签名 `review_lead` 以请求当前版本和原因码批准，逐项核对原请求与计划范围、测试身份、`synthetic_profile_handle_v1` 明确启用的测试保留政策及 `member`/`member_profile` 法定保留。未知或未启用政策、未清除保留一律拒绝。

仅隔离 worker 执行 `DELETE FROM member_profile WHERE member_id=$1`，不删除 `member`、手机号、地址、护理、订单、积分、UGC、审计或任何对象存储文件。执行前重新锁定并核对保留与测试政策；删除、job/result manifest、请求 `partially_completed`、不可变事件和审计在一个事务内提交。任一步失败回滚删除，仅保存安全故障码。尝试次数上限 3；耗尽后仅签名 `review_lead` 可在重新核验原固定范围、政策和保留后以当前版本、原因码审计恢复。没有更大的自动化删除范围，也未把注销、撤回等不同权利等同于本项删除。

## 已验证与未验证

`tests/integration/privacy-rights.test.ts` 在本轮专用 `cisme_pr3_local_postgres_20260914` / `cisme_pr3_test` 中覆盖：显式范围提交与去重、无范围请求不能借用该范围、非 test 环境拒绝、相异双人审批、未知政策/旧版本/伪造 actor/审批前 legal hold 拒绝、审批后新保留导致 worker 拒绝、故障发生在数据库 DELETE 后仍回滚、第三次失败后审计恢复、他人资料/本人手机号与会员行不受影响、部分完成状态和无私密错误传播。合成导出耗尽后的恢复也有独立用例。

候选源码门禁：55 个单测文件 / 366 项通过；33 个隔离集成测试文件 / 175 项通过；`npm run build`、`npm run lint:contracts` 通过。运行时与 OpenAPI 目前一致为 224 个 `/v1` 方法（另 2 个 health 方法）；当前 B 阶段严格逐路由口径仅 10/224，不能扩展解释为全面授权通过。

本范围是单表数据库删除，因此没有 DB 与对象存储跨系统非原子问题；本测试不能替代未来媒体删除的补偿、共享内容处置、订单快照和备份再删除演练。真实用户的删除/注销/撤回、正式保留策略与二次身份核验仍未完成；`APP_ENV=staging/production` 不接受合成执行密钥，正式 apply 关闭。当前小程序源码 SHA-256 `cf5fe2fd9baadf7a71d8bdfb4629b832ddd44559739c2226d2199d402c83c791`，当前视觉门禁 `blocked`；没有将旧截图重标为本版证据。

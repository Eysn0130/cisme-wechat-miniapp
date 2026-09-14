# PR3 合成会员资料子集导出：源码与隔离测试证据

基线为 `docs/product/CISME-产品需求文档-PRD-V2.1-R4.md`（正文 R4.2）P20/A11、§7.7 授权分层及数据权利路径。本文件只证明本轮隔离代码/合成库行为，不是正式个人信息处理政策、微信后台批准、DevTools 或真机验收。

## 固定范围与启动条件

- 先有本人 `access` 请求；第一位签名 `review_lead` 建立 `plan_only` 计划，第二位不同的签名 `review_lead` 用当前版本和原因码批准固定 `member_profile_only` 范围。拒绝同人自批、`support`、过期版本和客户端自报 actor。
- 只有 `APP_ENV=test` 且配置独立 `PRIVACY_SYNTHETIC_EXPORT_KEY`（64 hex，密钥不入库/日志）时 API 与 worker 才允许执行；数据库迁移另以 `syntheticOnly` 与 `dev_test` 身份守卫。development、staging、production 即使误配该键也启动失败。不得把远程 staging 改为 test 解锁。
- 本版本仅白名单导出会员 ID、显示名、创建时间及自报微信号；不读取手机号/地址密文、openid、会话、密钥、其他会员、订单、UGC、内部审计和安全配置。它不是完整账号导出，请求标为 `partially_completed`、`SYNTHETIC_PROFILE_EXPORT_ONLY`。
- worker 在单个数据库事务中完成选取、AES-256-GCM 加密、私有 PostgreSQL artifact 写入、作业状态与不可变事件；进程中断回滚整个事务。模拟故障保留安全错误码并按 5 秒测试退避最多尝试 3 次；不会把异常 message/stack 持久化。这个路径没有对象存储出站，因此不能证明 DB/COS 非原子删除补偿。
- artifact 最多 1 MiB，测试到期为生成后 1 小时。这是合成测试参数，不是正式保留期限或对外时限。下载只通过本人 active 会话、请求归属、未到期/未撤销检查；no-store；读取与撤销写审计。本人在原生页面显式查看子集，离页/切号清除显示，显式撤销后不可再取；worker 清理过期/撤销密文。

## 实证与未闭环

`tests/integration/privacy-rights.test.ts` 在本轮专用 `cisme_pr3_local_postgres_20260914` 容器的 `cisme_pr3_test` 合成库中验证第二审批人、旧版本/伪造 actor 拒绝、故障重试、密文不含合成标记、跨会员 404、无手机号密文/他人字段、过期/撤销 404、逐次读取与撤销审计及密文清理。`tests/unit/config.test.ts` 验证非 test 环境拒绝密钥；`tests/unit/miniprogram-page-behavior.test.ts` 验证迟到响应不回填到离页/新会话。运行时/OpenAPI 共 222 个 `/v1` 方法；这 3 个新入口列入 B 阶段严格矩阵。

候选源码门禁：55 个单测文件 / 365 项通过；33 个隔离集成测试文件 / 171 项通过；`npm run build`、`npm run lint:contracts` 通过。先前全量集成曾因新增管理路由使一条固定 22 数量断言失败，已改为动态枚举且再次全量通过；没有把失败那次算作成功。

真实用户导出、删除、注销、撤回、共享内容和订单快照的逐类执行仍未完成。`data_erasure_job` 正式仍 dry-run，未知保留政策不得自动删除；本次既未改用户资料也未使用真实身份。小程序源码 SHA-256 `affa2f606e807041a4c60606ab6c76a5535e11447fe6224572ce95cb09618e4c`，当前状态门禁仍 `finalResult=blocked`；旧截图只作为历史资料，不是该哈希的运行证据。

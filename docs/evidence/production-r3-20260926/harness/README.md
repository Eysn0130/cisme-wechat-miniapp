# R3 现场执行源快照

这些文件是本轮实际演练使用的源码，哈希见 `source-sha256.json`。不是常驻服务，不是 main 制品，也不是自动取得生产授权的脚本。已包含明确的旧候选SHA、私有路径和隔离库断言。现场临时数据库及运行凭据已清理；不可直接对生产 DSN 执行。

TypeScript 文件按执行时原样保留，原位置为仓库 `tmp/r3/`，其中的相对 import 依赖该位置。复现应先在原始绑定提交核对依赖，再复制回隔离临时目录并使用仓库已有 esbuild/tsx 工具编译；不要为了运行证据快照修改产品目录。编译后的实际 API/worker 来自 manifest 绑定的完整 tar，演练 harness 不替代它们。

执行顺序：`setup-rehearsal-v3.py` → 编译并运行 `runtime-harness.ts` / `run-runtime.py` → `run-standalone.py` → `storage-runtime.ts` → `legacy-recovery.ts` → `privacy-probe-v2.mjs` → `prepare-config.py` → `final-run.py` → `partial-resume.mjs` → `finalize.py`。现场按各步骤所需创建 work/tmp/harness目录；外部副作用工作采用 systemd IPAddressDeny=any/IPAddressAllow=localhost，真实COS探针则单独使用已授权原应用身份及指定前缀。

- `generate-runtime-harness.py` 记录怎样从已有验收与fixture派生现场合成场景，生成结果也已保留。
- `prepare-config.py` 是现场原稿；其 directory/drop-in待办已通过实际检查消除，其两个简写授权字段不作为最终判断。最终准备状态见 `server/receipts.json`，真实配置键存在性见 `server/final-receipts.json`。
- `partial-resume.mjs` 为最终修正版本，真实锁超时需要同时核验脱敏迁移器输出与服务器PG日志，未修改SQL。
- `finalize.py` 只清理两个硬编码本轮临时目录，先确认运行进程/端口停止，保留真实源备份、对象、私有回执和探针备份。
- 此目录没有实际生产密码、令牌、转储或用户行内容；随机生成的演练凭据曾只存于主机0700边界，已随临时集群清理。

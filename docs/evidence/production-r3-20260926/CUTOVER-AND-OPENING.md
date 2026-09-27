# 受控安装、营业开通与有限恢复

这是待前置条件满足后执行的顺序，不是部署或营业通过回执。本轮真正执行的结果以 README 和 server 下机器回执为准。

## 1. 源码链恢复

OpenAI 官方支持请求已发送，页面停在邮箱/本人登录；无正式单号、人工答复或有效允许。现存窗口需本人完成身份步骤。仅当原拒绝适用的正规流程明确允许后，才正常同步原 PR22 分支；回读远端完整 HEAD，核对该 HEAD 的 CI、审阅、Draft→Ready 与合并。随后独立读取 main SHA/tree 和该 main 的成功 push CI。不得合并旧 `5ab4a00d` 或把本地测试当作远端 CI。

## 2. main 制品及受控切换

1. 从干净、已验证 main 构建完整 Linux x64 制品，现有命令为 `npm_config_os=linux npm_config_cpu=x64 npm_config_libc=glibc node scripts/package-tencent-release.mjs`。在目标 Linux 校验归档 SHA、manifest、原生 Sharp、API/worker 入口。将业务文件、迁移器、95份SQL与 `server/runtime-artifact-manifest.json` 比较；仅差异影响的流程补测。本轮826制品不得改写成 main 制品。
2. 正确目标仍为 `lhins-61ikz4mi`、原库 `cisme`、原两桶。刷新私有 DB/roles/ACL 保护点、加密密钥可恢复性及实际业务对象清单；为清单中的需保护对象保留不可覆盖的私有副本及摘要。探针恢复成功仅覆盖下述四个探针，不代替业务对象覆盖。禁止使用共享挂载删除来清理备份。
3. 切换窗口停止并确认 API/独立 worker 与其他写入者已排空，保存时间与连接清单。复核 live schema/恢复副本，沿用 R2 已知锁及回填风险审阅；旧23份SQL安装字节缺失须明确记录，不能填写 `historicalSqlIntegrityVerified=true`。
4. 用现有 `infra/tencent/production-release.py preflight/apply` 接口，绑定实际 main、manifest、候选 env、旧版本、精确 pending SQL 集合和新鲜资格材料。选择已审阅的 `recoveryMode=forward-only` 或有充分兼容证据的同数据应用回退模式。所有资格 `verified` 只能来自实际通过的材料；本目录演练不能直接冒充 main 生产资格。
5. 安装私有准备配置并切换 current 后，核对两个实际 PID/入口文件 SHA、迁移95条、ready/TLS、独立 worker 心跳和两条旧事件实际处理结果；核对 COS/隐私目录。两条 identity 事件允许的处理结果为合同所定义的审计完成，不补造会员业务事实；重试不得重复效果。
6. 服务安全后，按当时已授权来源给云防火墙与 UFW 各增加最小 TCP443规则；保留22，5432不公开。分别核对回环与获准外部来源的 SNI/TLS/HTTP。失败只撤销本轮新建规则。本轮未执行该网络变更。

## 3. 配置差异

私有安装候选在 `/opt/cisme/prepared/r3-20260926/runtime.production.closed.env`，root0600；尚未替换 live。已有会话、联系方式加密和对象密钥保留，新隐私导出密钥只初始化到该候选；后续切换/恢复必须保存这一密钥与目录，不能每次部署重新生成。

| 项目 | 安装期 | 营业前所需实际变化/证明 |
| --- | --- | --- |
| 环境与适配器 | production；ALLOW_DEV_ADAPTERS=false | 保持正式身份与实际 COS；不改 staging 规避校验 |
| 写入围栏 | CISME_MIGRATION_READ_ONLY=true | 完成实际 main 切换与读回后按已审核范围解除；先确认写入者和对账入口 |
| worker | RUN_BACKGROUND_WORKER=false；UGC_SCAN_WORKER_MODE=standalone | 保持独立服务；核验活跃任务和错误，禁止双拓扑 |
| 商务 | COMMERCE_ORDER_FLOW_ENABLED=false | 正式 merchant ID/serial、私钥文件、APIv3文件、平台信任文件、付款/退款通知URL、商务及恢复授权材料，然后按能力开通并验证回调/重试/对账 |
| 履约 | COMMERCE_FULFILLMENT_ENABLED=false | 对应 merchant ID与授权文件，真实平台订单绑定及履约读回 |
| 内容安全 | 独立调度已修复 | WECHAT_MESSAGE_TOKEN/AES_KEY、UGC_SCAN_BASE_URL、UGC_LEGAL_APPROVAL_ID以及真实回调/超时重试证据；当前全部未配置 |
| 原生微信客服 | 按钮可见且触发原生接口 | 正式接待配置和实际送达未证实；此前站点拒绝未恢复，不能换入口绕行 |
| TLS | DNS01 dry-run成功，hook状态已清理 | main服务安装后完成受控443真实外部验证；按备案/平台条件决定公众开放 |

`server/final-receipts.json` 用**当前代码的真实配置键**核验了以上正式商务/履约/UGC字段，均未配置。早期 `prepared-config-result.json` 内两个简写授权字段不是当前代码读取键，以最终回执为准。商户证书文件为可选项，不能把它单独作为必填阻碍；必需项由当前 config 守卫判断。现有事实不足以承诺备案通过便能直接完整营业。

## 4. 两类恢复

**尚无新业务写入/外部动作：** 保持围栏、排空所有写入者，记录维护窗口保护点；确认此后无新事实，才可按已验证的保护点恢复方案恢复。R3对46个旧表的实际恢复与全行摘要一致，证明了该备份副本的可恢复性，切换时仍须新鲜保护点及对象/密钥对应性。

**已经有新业务事实或迁移部分完成：** 保留数据库、outbox/inbox及业务幂等键，停止不安全消费者，检查失败点并前向修复。R3原迁移器真实锁超时停在24，解除锁后续跑71，重跑0；维护期间HTTP写入503；API重启后订单幂等返回原单。已有新事实再 dump/restore 到独立目标，135个表摘要一致。不得用旧备份覆盖新事实，也不能把切旧程序当作通用回滚。

`forward-only` 自动失败分支只负责停服务、保留状态并生成 `forward-recovery-required.json`。人工/后续施工据该状态修复、重新核验资格并恢复；它不自动宣布恢复完成。无需为72份迁移强写down，也未假定旧程序兼容所有未来交易。

## 5. 对象保全覆盖清单

| 桶 | 原键 / 恢复键 | 私有备份和范围 |
| --- | --- | --- |
| lhcos-81ddf-1257392443 | `submissions/00000000-0000-4000-8000-000000000026/probe/r3-20260926-1035z-original.txt` / 同目录 `r3-20260926-1035z-restored.txt` | `/opt/cisme/backups/r3-20260926-1035z.bin`，41字节，SHA见README；原键也作为只读ready标记，保留 |
| cisme-privacy-1257392443 | `cisme-probes/r3-20260926/r3-20260926-1135z-original.txt` / 同目录 `r3-20260926-1135z-restored.txt` | `/opt/cisme/backups/r3-20260926-1135z.bin`，51字节，SHA见最终回执；保留 |
| 隐私业务前缀 | `privacy-suppression/v1/wx4eac2d4fb11d299b/` | 原应用身份实际完整列表为0、未截断；此时没有对象可备份，不向该前缀写假抑制记录 |
| 应用桶备份目录 | `backups/postgres/` | 控制面观察21份加密转储及1份清单；不代表已逐份解密恢复，不覆盖其余业务媒体 |

以上是本轮实际覆盖范围；切换窗口的全量业务对象清单及保护副本仍需生成并绑定新鲜保护点。不要求 Lighthouse 应用身份调用不支持的桶接口，不扩大全桶权限。

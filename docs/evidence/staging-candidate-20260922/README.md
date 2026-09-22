# CISME staging 候选部署与发货源码进展 — 2026-09-22

本轮在唯一工程 `/Users/mini/CISME` 接续 PR20。PR20 已于 08:51:01Z 合并，merge SHA `547c9e64e8eca5c0e8a2fd150f42d2c52d3c9d4b`，PR head `1075460866741bbb6a542adbcdb444205d2949dd` 的 CI 35705390142 verify success；两个设计/凭据条件 job skipped。PR20 是环境事实证据，不是正式发布批准。

## 实际部署与环境边界

- **staging** `lhins-ei4hz4fi` / `150.158.39.74` / `staging-api.cisme.cn`：本轮实际部署 `ae31437652e2fe3fbb24e7ac493d3b60ad747d27`，源 CI 35697496015 成功；新建归属明确的 `cisme_accept_rc20260922_8d13f6a2` 和独立对象目录。72 项迁移成功、重跑 0；HTTPS200，未认证运维/本人接口401。隐私已统一 v7-staging-support、协议 v4-staging。原 `cisme_staging`、原对象与旧 release 保留。
- **production** `lhins-61ikz4mi` / `124.223.74.198` / `api.cisme.cn`：本轮只读；旧 manifest 不含 Git SHA，不能拿产物哈希代替 SHA。独立公网探测超时，loopback TLS200；实例防火墙未见443。这是 production 自身证据，不是 staging 推断。未修改网络、配置、数据库或运行版本。
- 当前新增发货源码、73号迁移尚未部署。staging 仍是上述 **ae314**，不能把本 PR 的 CI 或本地测试计数写成服务器版本。
- 完整实例、网络、DNS、DB、对象、到期与续费报价见 [环境账本](../launch-unblock-20260922/ENVIRONMENTS.json)。staging TCP80 按用户决定不修改；未续费/付款/开启自动续费。

## staging 恢复与监测

[deployment.json](deployment.json) 是腾讯 TAT 终端结果的脱敏转录。原始 JSON、备份及回退环境位于 staging `/opt/cisme/staging-acceptance/rc20260922-8d13f6a2`，仅 root 可读，未导出配置或业务数据。当前 release `/opt/cisme/releases/rc20260922-8d13f6a2-ae31437652e2`。

备份还原至另一新库 `cisme_accept_rc20260922_8d13f6a2_restore`，72迁移、125表、2份法律文档、1个合成 marker 数量一致。对象验收只有本轮本地 marker 的复制与哈希一致，**不是 COS/S3 恢复验收**。6次短窗口健康检查均200，API/worker运行且重启次数0；不是长期稳定性结论。

安装只读 `cisme-staging-health-20260922.timer`，每分钟检查 staging 身份、固定部署 SHA、HTTPS、服务及磁盘。09:28:25Z 实际 journal healthy=true，timer active。无自动修复、无外部告警接收器；后续部署必须有意更新监测的 SHA 绑定。脚本 `infra/tencent/staging-*.py` 全部是本轮固定目标执行器，不能直接泛化为 production 部署脚本。

旧 `cisme_test` 事故影响 **UNKNOWN**，未恢复、未接触。没有真实资金交易，没有 production 破坏性测试。

## 微信开发者工具证据

当前原生包 source SHA-256 `a296da16a0edafe3d1fc988b94539a52a23f2d7e8b1fa85d9702e96b4276161c`；259文件、37路由。使用 Nightly 的官方 wechatide CLI，模拟器临时切到真实 staging 的**游客**来源，会话与本地来源分开。测试结束恢复本地来源及原存储会话，仅验证会话是否存在，没有读取/记录 token。

- `native-home.jpg`：游客看到“授权身份并开始”，未自动跳走。
- `native-privacy.jpg`：首次请求失败，错误态证据保留；不能标成成功。
- `native-privacy-loaded.jpg`：调用页面重试后实际接口200，显示 v7-staging-support。首次失败根因未确认。
- `native-terms.jpg`：真实 staging 文档 v4-staging。
- `native-account.jpg`：未勾选同意时登录不可用，保留浏览社区入口；未执行微信身份授权。

这些是当前模拟器抽样，不是37页、78图全状态，也不是 iOS/Android 真机或团队体验版验收。没有重新上传、提审或发布。

## 应用源码与验证

新增微信订单发货传输适配器及持久化单包裹同步服务。预先查询支付身份/金额/投诉与发货事实；调度在发送前提交不可倒退的 dispatch 记录；网络结果未知或进程中断后只查单，不自动重新发货；并发 claim/租约、最多5次查询后人工核对。包裹加密存储，输出不含 token、OpenID、运单号或上游错误正文。服务默认不启用外呼，没有装配 HTTP/worker 正式授权，不写本地签收/完成/退款事实。

本地验证：997单元通过、1跳过；783集成通过；9项部署/监测离线测试通过；typecheck、lint:contracts、package-gate通过。集成测试仅使用本轮 ownership harness 新建的 DB/S3 容器并按所有权清理；原始日志 SHA 见 validation.json。CI 必须以本 PR 的实时 head 为准，不能沿用 PR20。

新增73号迁移后，当前源码隐私 schema inventory 为126表；staging部署仍125表。主体地图与出站指纹已更新，不能把资产清单当全账户导出/删除实现。production [法律候选](../../legal/production-candidate-20260922/MANIFEST.json) 为 DRAFT_NOT_APPROVED_NOT_EFFECTIVE，没有发布或修改平台隐私版本。

## 仍需施工（工程项，不转嫁为截图任务）

1. 正式订单/支付命令装配、商户绑定和细粒度授权；完整查单、退款、异常恢复及账单差异闭环。
2. 发货 HTTP/worker 装配、人工核对与重驱动、每日对账、承运商签收/售后事实及消费者订单状态；当前适配器和日志服务不是完整履约。
3. 全主体数据导出/删除/许可撤回、媒体及对象/缓存/日志/备份处置、保留政策与重新认证；已有合成 profile 执行不可冒充完整隐私执行。
4. 228个方法逐项13维复核；本轮新增服务的审阅不能抵充 HTTP 总分母。当前 fullyAcceptedMethods 仍0。
5. staging 完整业务/弱网/故障/恢复/告警送达验收；production 网络可达性与可审阅切换方案；78图有效状态与 iOS/Android 真机。

外部事实：用户提供的原文为 **“小程序备案 管局审核中”**，来源是用户报告，不是工具直读，不推断代码版本审核。公众/商户私有后台仍受工具站点策略限制；MIIT查询等待滑块操作批准；腾讯草稿不能证明域名缺备案。合法域名四栏、具体商户/主体绑定仍待核验。经营承诺（配送/运费/时限/退换/客服）待批准依据，设备验收待授权设备。续费已经报价，无需因此停止施工。

**releaseReady=false，fullAcceptanceComplete=false。** 当前尚未达到“审核一过仅剩 production 切换”的状态。

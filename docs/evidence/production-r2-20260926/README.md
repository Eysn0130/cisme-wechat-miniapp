# PR22 R2 执行回执（2026-09-26）

范围：`/Users/mini/CISME` 原分支、PR22，以及现有腾讯云 Lighthouse `lhins-61ikz4mi`。本文件记录本轮实际执行结果；[上一轮只读现场记录](../production-readonly-20260926/README.md)保留其原有时间和范围。未发送生产数据、凭据或备份到 GitHub、聊天或第三方。

## 结论与边界

| 交付线 | 本轮结果 |
| --- | --- |
| A：写入恢复、远端候选、CI、main | **未完成。** 原拒绝的原始工具响应和恢复入口仍未取得；没有以 `git`、`gh`、网页、Computer 或其他身份重做被拒的 GitHub 写入。PR22 仍是旧 Draft。 |
| B：真实备份恢复与旧库升级 | **已在生产主机的独立、隔离目标实际执行。** 真实自定义格式备份恢复成功，23→95 条迁移成功，第二次执行没有重复应用。生产 `cisme` 库仍为 23 条。 |
| 生产切换 | **未执行。** 没有经过准确远端 CI 的 main 制品；生产配置、COS 恢复、完整同数据回滚等仍需验证。现行 API/worker、数据库、COS 和网络规则未切换。 |

备案、微信平台发布、实体 iOS/Android 的状态分别保留为未完成；它们没有阻止本轮源码核验和隔离演练。受控安装仍须满足实际 main 制品与数据保全门槛，公众开放另行判断。

## A 线：原拒绝与源码链

- 本地原分支 `codex/fulfillment-lifecycle-20260922` 在本轮开始为干净的 `6d083fbb4cff10eef7a06926321d6eb3e3c3fe6a`，树 `8e454e664c0222830b1d875e7d0a559f5a7328f0`；小程序有效输入 SHA-256 为 `e97db4690df66ae2c86b2e9539a5d631afbc501a27489fc32dc21c32ec436a4a`。本轮没有回退或重放旧补丁。
- 交接包 `/Users/mini/Downloads/CISME-R8-Release-Closure-Handoff.zip` 仅给出 `GitHub.create_tree follow-up UI/test corrections`、`blocked by tool safety check; no branch update`、`repositoryWritesStopped=true`、`doNotBypass=true`。定向查找原任务和本地会话后，仍没有原始错误正文、请求 ID、原通知的“查看发现/恢复”入口或解除回执。最小定位材料就是上述动作、仓库、受限范围、交接摘要及当前旧远端 SHA；不把摘要冒充原始拒绝。
- Codex TUI 的 `/approve` 只适用于该客户端中可选中的近期 Auto-review 拒绝动作，并且重试仍受审查。现有材料没有证明此 GitHub 连接器拒绝属于当前 TUI 的相同动作；在另一个 CLI 任务运行 `/approve` 不能声称恢复它。没有替用户点击安全批准，也没有伪造批准标记。
- 本轮末尾只读回查：[PR22](https://github.com/Eysn0130/cisme-wechat-miniapp/pull/22) 仍 `OPEN`、`Draft`、未合并，远端 HEAD `5ab4a00d4e71d8a9a2de14e31b64fca0bbe92e88`；`main` 为 `5740e18544fa37dd473c36934a2a12a07a2d5ec9`。旧 HEAD 的 `verify` 失败，不能代表本地 `6d083fbb…` 的 CI。没有新候选远端 CI、main CI 或 main 绑定制品。
- 已请求原拒绝任务链接或完整通知，以确定原平台的正规恢复机制。取得有效恢复回执后，才允许在原分支正常同步并回读 HEAD、运行准确 CI、转 Ready 和合并。

## B 线：真实备份、隔离恢复、迁移

目标和输入：

| 项目 | 核验值 |
| --- | --- |
| 服务器 | Lighthouse `lhins-61ikz4mi`，Linux x64，PostgreSQL/`pg_restore` 16.15，Node 24.14 |
| 真备份 | `/var/backups/cisme/cisme-20260925T191941Z.dump`，230620 字节，SHA-256 `e2f8bdb66c79d9d0f1072a9d5c71c0f6f3b7e3f20afaaa64dc3740b82fbaacca` |
| 隔离目标 | 本轮 `cisme_r2_20260926_0846` 库及 NOLOGIN owner；从 `template0` 创建、撤销 PUBLIC CONNECT、生产 `cisme` 账号不能连接 |
| 演练候选 | 来自本地 `6d083fbb…` 的 95 份 SQL 和同一提交的 `release-migrate.mjs`，仅迁移用途；无可运行 API/worker，非 main 生产制品 |
| 传输 | 现有私有 OrcaTerm 边界；清洁 tar 的本地与主机 SHA-256 均为 `65df2ce1bfac5e3461e9f228b42537c4d1fd35481878d4207df90a0fe87d632a` |

- 对上述备份执行 `pg_restore --exit-on-error --single-transaction --clean --if-exists --no-owner --no-acl`，明确指向隔离库，退出码 0。恢复后 journal 为 23 条；`member=2`、`care_cycle=0`、`care_record=0`、`privacy_request=0`。与当时生产库核对为 46 个表、202 个约束、0 个未验证约束、1 个用户触发器、1 个扩展；只读 schema 导出除 `pg_dump` 易变信息和 `public` 注释外一致。没有读取或导出会员行内容。
- 先核验迁移清单、文件哈希和制品清单（95 条迁移、101 个被校验文件），再在该恢复副本执行剩余 72 条；退出码 0，日志 72 行，最终 journal 95 条、135 个公开基础表、0 个未验证约束，会员等已有行数保持。再次运行同一迁移器退出码 0、日志 0 行。第一次迁移日志 SHA-256 `179bc526dbbccfa29788d3798a47216c74f38efbf4a6b707f740c5b76e20e6`；第二次是空文件 SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。候选 manifest 的 source 字段为明确的演练占位值，绝非 main 来源证明。
- 恢复副本与生产的**迁移名称及顺序前缀**相符。旧发布包未保存前 23 份 SQL 原文件或其安装时内容哈希；先前的 MD5 只覆盖名称列表，不能证明历史 SQL 字节一致，也不能证明不存在旧库结构漂移。可见的 2026-09-09 Git 历史提交 `56a18747…` 仅有 17 份 SQL，不能拿它填补生产库 23 份的内容证明。当前 schema 比较只覆盖本次备份时点。
- 首次隔离恢复故意使用 `--no-owner --no-acl` 及 NOLOGIN owner。归档目录含一个 `SCHEMA public` ACL 项，因此另建 `cisme_r2_acl_20260926` 独立库、NOLOGIN owner 并撤销 PUBLIC/生产 `cisme` 的库 CONNECT；在该库使用 `--no-owner` 但**保留 ACL** 执行完整 `pg_restore --exit-on-error --single-transaction`，退出码 0，journal 23 条。归档 ACL 在隔离库实际应用成功。生产 `cisme` 是 live 库 owner，对 `public` 有 USAGE/CREATE；隔离库由本轮 NOLOGIN 角色持有，`cisme` 无 CONNECT，其有效权限故意不同。故原始 owner 身份与最终部署账号的授权效果尚未在生产式身份下验证；COS 对象恢复也未通过。
- 旧生产 API 的同主机副本使用合成密钥、仅监听 `127.0.0.1:31946`、恢复库连接强制 `default_transaction_read_only=on`、后台 worker 和商务流程关闭、超时自动结束。在升级至 95 条的同数据副本上，`/health/ready` 与一条恢复会员的 `/v1/me/profile` 只读请求均返回 HTTP 200。此结果不覆盖写路径、新交易发生后的旧程序兼容性或数据库逆迁移，不能作为完整回滚通过。
- SQL 审阅发现 `202609100004_community_post_stats.sql` 对 `member/community_reaction/community_comment` 加 `SHARE ROW EXCLUSIVE` 锁并回填；`202609250001_retire_unapproved_catalog_images.sql` 变更商品约束并仅清理列明的旧预览引用；若生产数据量或写入状态与备份差异较大，仍须在切换窗口确认锁与数据条件。迁移器设 `lock_timeout=5s`、`statement_timeout=120s`，本次小规模恢复副本成功并不证明高峰负载无阻塞。
- 本轮两个独立库、两个 NOLOGIN role、迁移 tar/日志、临时服务及其文件均按各自 runId 精确清理。清理后确认：`cisme_r2_%` 库数量为 0，生产 `cisme` 仍是 23 条迁移，原备份仍在，`cisme-api` 和 `cisme-worker` 均 active，`current` 仍指向 `/opt/cisme/releases/20260909-native-login`。没有对生产 DSN 执行恢复、删表、重置、seed 或迁移。

## 配置、worker、COS、网络与回滚

- 现行生产进程仍使用旧发布包，`APP_ENV=staging`。配置核验只读取键名/非密值，未打印生产密钥。候选的受控配置不能只改 `APP_ENV`：现有发布脚本要求 `APP_ENV=production`、`ALLOW_DEV_ADAPTERS=false`、`COMMERCE_ORDER_FLOW_ENABLED=false`、`CISME_MIGRATION_READ_ONLY=true`、`RUN_BACKGROUND_WORKER=false`，并检查正式隐私抑制目录、桶和导出密钥机制。正式生产配置尚未形成并验证。
- `RUN_BACKGROUND_WORKER=false` 的实际语义是禁用 API 内嵌 worker；另有独立 `cisme-worker` 服务。直接改成 `true` 会增加双消费风险。本轮没有修改。现行 worker active 且无重启，但 `outbox_event` 有 2 条到期未处理的 `identity.accepted.v1`、尝试次数为 0；`media_cleanup_queue` 为 0。因此 active 不等于成功消费。当前候选把该事件归为 `audit_only`，但生产仍运行旧 worker，未证明端到端一次效果。
- 腾讯云控制台仅确认隐私桶 `cisme-privacy-1257392443` 存在且当时显示 0 字节；应用桶 `lhcos-81ddf-1257392443` 的对象清单和保全状态未取得。使用既有应用 COS 凭据，通过正确的 COS SDK 对本轮空前缀执行只读 `ListBucket`，返回 `AccessDenied`；读取 bucket 版本配置也返回 `AccessDenied`。这不能证明桶里没有对象，更不能声称 COS 版本保护或对象恢复通过。代码中的 UGC 不覆盖语义还要求慎重评估版本控制，不能仅为“保护”直接打开桶版本控制。本轮未修改 COS 对象或配置。
- `api.cisme.cn` 在主机回环、保持域名/TLS 校验的 `/health/ready` 返回 200；Nginx 监听 443。云防火墙缺少 TCP 443，UFW 仅放行 22，尚未修改。最小变更准备：仅在 main 对应制品、关闭商务/公众能力的 production 配置和受控来源确定后，分别给云防火墙和 UFW 增加该来源的 TCP 443；保留原 22，拒绝 5432，回滚只删除本轮两条 443 规则。先记录回环、受控来源和公网各自的 TLS/HTTP 结果，再按备案及平台边界决定公众规则。没有提前把当前 staging 服务开放全网。
- 证书有效期为 2026-09-09 至 2026-12-08；`certbot.timer` active。renewal 配置使用 DNS-01 的 auth/cleanup hook，脚本和受限维护凭据文件均存在。只证明自动续期**配置存在**，未做 dry-run 或成功续期验证。
- 同数据回滚目前只有旧 API 对升级后副本的两条只读 200。旧程序写路径、worker、72 条迁移的不可逆数据效果，以及新交易发生后的前向恢复均未证明；不能用旧备份覆盖新交易，也不能仅切回旧进程就声称回滚安全。

## 小程序与微信接线

- 当前精确小程序包检查通过：266 个文件、40 条路由、有效输入哈希 `e97db469…436a4a`。本轮定向 5 个单测文件共 50 项通过，覆盖游客登录、未认证隐私入口、会员资料、售后校验/轮询/修正，以及客服入口等源码行为。此前同一候选的完整本地测试结论见[上一轮记录](../production-readonly-20260926/README.md)，不冒称为本轮远端 CI。
- `pages/account/index.wxml` 的登录失败入口是微信原生 `open-type="contact"`，与 CISME 自有客服会话不同。按钮存在及单测通过，不证明正式微信接待账号、人员排班或消息接线。试图读取微信公众平台配置时，该站点访问被平台安全审查明确拒绝；没有换浏览器、接口或账号重试。接线状态保留 `NOT_RUN`。
- 本轮未抢占用户可能正在使用的微信开发者工具，也没有以旧截图宣称此哈希的视觉验收。当前源码的逐页 DevTools 交互帧、胶囊/安全区、按钮文字实际落点仍需同包实测；iOS/Android 实体设备为 `NOT_RUN`。该事实不否定已经完成的备份和迁移演练。
- 需求基线仍为 [PRD V2.1-R4](../../product/CISME-产品需求文档-PRD-V2.1-R4.md)，特别是 §2 的 One-App/游客与受控能力、§5 的身份护理事实、§15 的体验版/正式版边界，以及 `NFR-04` 备份恢复演练。没有创建第二后台或新产品范围。

## 接续动作

1. 从原任务取得 `GitHub.create_tree` 原始拒绝/通知与恢复入口；仅由用户在适用的原平台流程完成要求的批准或审查。取得回执后同步原分支并回读最终 HEAD，运行其准确 CI，再正常转 Ready、合并并核对 main/main CI。
2. 以最终 main 制品比对本轮演练 SQL 与迁移器字节。若不同，只补受影响的恢复/迁移测试；切换前补新鲜备份、最终运行身份权限与 COS 对象恢复、正式配置、worker 处理和同数据前向恢复证据。
3. 在正确生产实例用 main 绑定、Linux x64 原生依赖制品完成受控切换；保持原库和 COS，验证 API/worker 实际版本与业务。生产安全就绪后才按受控来源逐层开放 443。备案和微信正式发布另行记录，不以没有手机阻止上述工程步骤。

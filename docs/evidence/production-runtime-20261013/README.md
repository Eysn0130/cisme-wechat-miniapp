# 正式机与隔离体验运行读回 — 2026-10-13

初始11:48–11:52核验在唯一正式机 `lhins-61ikz4mi` / `124.223.74.198` 上只读执行。SSH 使用既有密钥与固定主机指纹，`StrictHostKeyChecking=yes`；该阶段未变更服务、数据库、密钥、防火墙、Nginx、备份或 COS 对象。没有访问旧测试机。后续12:55的独立体验协议发布另外记录于下文和单独回执。

现场时间为 **2026-10-13 11:48:23–11:52:32 UTC**。逐项时间、脱敏结果、方法与限制见 [runtime-readback.json](runtime-readback.json)。生产运行和小程序发布仍按 PRD V2.1-R4 §15.5、§15.6、`BASE-WX`、`G0-PRE/G0-OPS` 分别验收。

## 当前可确认范围

| 项目 | 现场结果 | 范围 |
| --- | --- | --- |
| API / Worker | 生产与体验四个服务均 `active/running`，两个 Worker 心跳新鲜 | 不代表交易、公开 UGC 或真机业务验收 |
| 生产进程 | API PID `2050563`，Worker PID `2050559` | 与上一轮记录一致，本轮未重启 |
| 体验进程 | API PID `3151709`，Worker PID `3151710` | 独立 OS 用户 `cisme-trial`、工作目录 `/opt/cisme-trial` |
| 不可变制品 | 两个运行目录 `migrate.mjs verify` 均 exit 0，`verified=true`；源码 `751f7407af4e525c5b6c09c6997800acfb4048fc`，97 迁移、103 制品项 | 没有执行 migration up，未重复核验整个 node_modules 树 |
| 就绪 | `127.0.0.1:3100/3101` 的 `/health/ready` 均 HTTP 200 `ready` | 本机请求，不是公网或小程序请求 |
| 本机 TLS | 两域名用实际 SNI、可信链和主机名验证通过，TLS 1.3；Nginx 配置检查 exit 0 | 使用本机 443，不证明公网 443 可达 |
| 证书 | 生产截止 `2026-12-08 05:52:00 UTC`；体验截止 `2027-01-11 01:43:12 UTC` | 当前证书，未在本轮重新 dry-run 续期 |
| 续期配置 | `certbot.timer` active；两个 renewal 文件有 `renew_hook`，体验 hook 为 Nginx 检查后 reload | `renew_hook` 是实际字段，不能因为未设置 `deploy_hook` 写成缺少 reload |
| DB 隔离 | 体验库/角色 `cisme_trial`；无 superuser、建库、建角色、复制、bypassrls 或成员关系；PUBLIC CONNECT false | 体验真实凭据自身库认证成功；生产库、postgres、template1 均被拒绝 |
| 秘密隔离 | 数据库、会话、上传令牌、联系信息加密/哈希及隐私导出秘密内部比较均不同；每环境 API 与自身 Worker 一致 | 只保存比较布尔，不保存秘密或秘密摘要 |
| 目录隔离 | 体验对象与删除抑制目录为 uid 996 / gid 987、0700，当前均空 | 未进行真实上传或恢复后抑制功能验证 |
| 体验边界 | `APP_ENV=staging`、`api_gateway`；真实交易、模拟支付、履约、积分、公开 UGC、COS 直传、手机号绑定与开发身份均关闭 | 不复制生产会员数据，不推定未实测功能可用 |

## 初始读回：体验协议尚未发布

体验 `GET /v1/legal` 现场返回 HTTP 200、`{"ready":false,"documents":[]}`；数据库 `legal_document` 和 active 文档均为 0。小程序解析该响应为 `LEGAL_NOT_PUBLISHED`，不能形成可接受的协议版本。服务端微信身份路径检查当前 active terms/privacy，缺少协议时的代码分支为 `LEGAL_VERSION_REQUIRED` / 409；本轮没有用真实微信身份发起注册，不能写成已实测 409 或手机通过。

生产 `/v1/legal` 的 ready 为 true，两个文档版本为 `2026-09-09-v3-profile`。这不能替代体验协议的真实事实与批准：当前体验使用同机独立数据库、本地对象目录及 API gateway，生产协议含有 CloudBase/COS 等描述，不能直接复制并把版本发布视为事实核实。

现有 `cisme-encrypted-backup.py` 只 dump `cisme`，没有找到 trial backup unit，不能认为生产备份覆盖体验库。本轮仅用现有生产维护身份进行 COS `GetObject`：体验 `backups/cisme-trial/` 下不存在探针对象返回 403 `AccessDenied`，生产 `backups/postgres/manifest.json` 返回 200；未读取其正文，没有创建对象，也未测试 PUT/DELETE。这不证明未来独立体验身份的权限，候选启用需要独立身份、路径、加密密钥及明确的备份与恢复/删除抑制范围。

按 PRD §15.6，完整容灾不是首次受控体验的整体前置条件，须在限定采集范围下说明当前恢复局限，持续完善适用保护措施。上述 COS 403 阻止本备份候选启用，不自动构成所有体验准入的总否决。本轮未发现或验证身份代码将备份状态作为请求强制检查，不能写成已经实施的注册技术锁；恢复时仍必须防止已删除资料重新活跃。

## 网络与备份范围

主机 UFW active，目前仅允许 22/tcp IPv4/IPv6 入站。体验 3101 绑定 loopback；生产 3100、PostgreSQL 5432 仍监听所有接口，由主机防火墙限制，须在受控维护时收窄，不能对公网开放这些端口。

root 在本轮浏览器读回云防火墙：正式机允许全部 IPv4 的 TCP 443、22、80，以及 ICMP ALL，截图为 `cloud-firewall-readback.jpg`。此来源单独标记为 `browser-readback/root`；运行核验子代理未独立观察云控制台。云 443 已允许，主机 UFW 443 尚未允许。

服务器 IPv4 DNS 对两个域名均返回 `124.223.74.198`。工作机按域名发起外网请求时走本地 DNS/代理的 `198.18.0.99` / `198.18.0.96`，TLS 连接超时，HTTP 为 000。这只能说明该工作机本次请求未完成；不能据此归因云防火墙，也不能宣布公网链路通过。备案、TLS、公网入口与微信合法域名仍需对应证据。

正式加密备份 service 最近运行 success、exit 0；现有 `last-success.json` 时间为 `2026-10-12 19:30:06 UTC`，记录 remote checksum、GCM authentication、归档可读性为 true，远端保留 30 天。**本轮读取既有回执，没有重新下载/解密该归档**。完整恢复回执来自 `2026-09-09`，只保留历史范围，不继承为本轮恢复演练。未证明外部告警消息实际送达。

## 保留策略实际读回

仅查询体验 `data_retention_policy` 的策略元数据，没有查询任何会员资料或业务内容。

| code | 时间 | active / enforcement | 自动清除 |
| --- | --- | --- | --- |
| `support_conversation_policy_pending` | 解决后 3 个日历月 | true / enforced，version 2 | false |
| `support_audit_policy_pending` | 尚无有限时长 | false / declared，version 1 | false |
| `commerce_transaction_three_years` | 36 个月 | false / declared，version 1 | false |
| `support_transaction_three_years` | 36 个月 | false / declared，version 1 | false |

策略元数据不是自动清除或真实数据删除的验收证据；尤其不能将普通咨询的 `active=true` 写为后台已自动执行清除。

## 当前可执行的后续工作

1. 已完成用户委托的合理运营参数、体验范围协议与三附件，并于12:55原子发布独立体验版本；初始空文档与 [实际发布回执](trial-legal-publication.json) 分别保留，不伪造独立法务签字或会员同意，不再逐项索取相同运营确认。
2. 完成独立体验备份候选和门禁核验，补齐授权身份、指定对象路径、加密密钥、保留规则及恢复后删除抑制；部署前绑定准确输入，不能复用生产事实推定通过。
3. 读回适用备案、微信合法域名及体验成员状态，在允许的入口状态下开放主机 HTTPS，并从外部网络及原生微信验证完整链路。
4. 为准确原生包补齐微信上传/体验版回执与真机页面、状态矩阵；服务器就绪不替代这些验收。

## root 后补：云实例与备案读回

12:55的 [实际协议发布回执](trial-legal-publication.json) 确认独立体验库原子发布两份 `2026-10-13-v1-trial` 文档及一条审计，本机可信TLS匿名读取 `ready=true`、正文摘要完全一致。成员与三类同意表均为0，正式协议、四服务PID和UFW前后全等。这解决初始协议为空，不证明公网、微信身份、平台配置或真机已经验收。

root 另行读回正式实例到期显示 `2026-12-08 22:01:23`，控制台显示时区不明确，自动续费 checkbox 为 0；未购买续费。来源为本轮正式实例概要页，随后切换防火墙页保存截图。备案草稿、核身材料及提交条款的本轮范围见 [接续记录](../../deployment/PRODUCTION-RUNTIME-2026-10-13.md)：已进入预览，服务负责人材料需修正，条款与授权未接受，未提交审核。其余政府证件大图或含身份证号的授权书不保存。

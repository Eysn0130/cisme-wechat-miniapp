# Production 数据库连接串输出事件：未轮换、调查中

本轮配置探针对 /opt/cisme/runtime.env 的带引号 DATABASE_URL 未正确去引号；URL 解析后把完整连接串误当数据库名输出，进入一次 Computer Use 终端截图/工具记录。确认包含凭据；不得复制原值。清屏不能撤销已捕获记录。尚无证据表明被提交到 GitHub或被滥用，亦不能据此认定没有滥用。

## 2026-09-22 现场只读核验

控制面：腾讯云已认证 Lighthouse 实例 lhins-61ikz4mi / cisme-app-shanghai / 124.223.74.198；OrcaTerm 同实例。以下仅属于 production。

- API、Worker 当前进程均运行，EnvironmentFiles 均为 /opt/cisme/runtime.env。
- 从进程环境在内存解析并仅输出白名单：两者使用相同数据库凭据，数据库 cisme、角色 cisme、127.0.0.1:5432；两套当前凭据的 SELECT true 认证均成功。未打印凭据或校验摘要。
- PostgreSQL listen_addresses=*；实际 0.0.0.0:5432、[::]:5432。
- ssl=on，最低 TLSv1.2，password_encryption=scram-sha-256。
- pg_hba_file_rules 无解析错误；公网 cisme/cisme 对 IPv4/IPv6 规则为 hostssl + scram-sha-256 + clientcert=verify-full；loopback 为 SCRAM，不要求客户端证书。
- 连接快照仅观察到 cisme 从 127.0.0.1（非 TLS）和本地 postgres 维护连接。此瞬时快照不是历史使用者清单。
- log_connections=off，log_disconnections=off，logging_collector=off，log_destination=stderr。不能证明所有成功外部连接均被审计。
- 当前一份 PostgreSQL 日志的 98,552 字节样本中有 443 次 no pg_hba.conf entry，涉及 19 个公网来源；记录时间原文范围 2026-09-20 01:39:36.042 至 2026-09-22 20:38:56.905（未擅自转换服务器时区）。这些是拒绝证据，不是成功入侵证据，也不能证明仅有这些请求。

## 网络与证书（未变更）

| 端口 | 云防火墙 | UFW | 当前监听 |
|---|---|---|---|
| 22 | 全 IPv4 允许 | IPv4/IPv6 Anywhere 允许 | IPv4/IPv6 |
| 80 | 全 IPv4 允许 | 无允许规则 | 未监听 |
| 443 | 无允许规则 | 无允许规则 | IPv4 |
| 5432 | 全 IPv4 允许 | IPv4/IPv6 Anywhere 允许 | IPv4/IPv6 |

UFW active。sshd 当前 PasswordAuthentication=yes、PermitRootLogin=yes、PubkeyAuthentication=yes；当前 ss 未观察到传统 SSH 会话，已认证 OrcaTerm 控制通道在用。不能因此未经确认关闭 SSH。

Production 证书 api.cisme.cn 有效期 2026-09-09T05:52:01Z 至 2026-12-08T05:52:00Z。renewal 为 manual + DNS-01，配置 DNSPod auth/cleanup hook，renew_hook 包含 reload，certbot.timer active。这里只核验配置，未执行真实续期演练、未证明 DNS 凭据最小权限。不要把 staging HTTP-01 风险套到 production。

Production 原 release /opt/cisme/releases/20260909-native-login，manifest 无 sourceHead，Git SHA UNKNOWN；API SHA256 6f1ff9ed525b924d3b398381e898ce822beabd2598bc8a8960b053893a2b357e。APP_ENV 仍错误标为 staging；原 cisme DB/COS 保留。未部署当前 main。

## 留存扫描范围与限制

- Gitleaks 8.30.1：159 个 Git 提交、约 14.98 MB，no leaks found；全量 redaction，报告未含密钥。不能替代工具记录清除或凭据轮换。
- 额外匹配扫描 Git patch 19,864,584 字节和工作区（含 ignored tmp/dist）9,514 文件、1,439,453,958 字节。7 个大于 32 MiB 文件未扫描；未解包全部归档、未 OCR 图片。
- 匹配到示例/测试 URL 和两份早于本事件的受保护本地部署配置：tmp/tencent-deployment/runtime.env、tmp/deployment-secrets/cloudbase-shanghai-env.json。均 mode 0600、Git ignored/untracked，mtime 为 9 月 9 日。未删除它们，也不把其存在误报为本次新写入。
- 对本地 runtime.env 凭据进行内存内 Git 全历史精确匹配，0 命中；未假定该本地旧副本等于当前生产凭据。部分模式候选仍需源归属判断。
- 本事件的已知泄漏位置仍是工具截图/记录；无法从当前工具删除已捕获内容。禁止把其复制进 evidence、PR 或聊天。

## 下一动作

先核对 CloudBase 等旧数据库消费者，生成并验证低中断轮换方案；在实际角色凭据变更前取得用户对应确认。网络权限单独确认；不以 SCRAM/mTLS 替代网络收紧。旧 cisme_test 事故继续 UNKNOWN / 未恢复，完全独立。

## 旧 CloudBase 消费者

官方 wechatide 在微信关联环境 cloud1-d4g0khuk495d48600 查到 cismeApi/cismeWorker 均 Active（Nodejs24.11、60s timeout）。最新小程序源码未配置 cloudFunction，不证明历史已部署客户端停止使用。腾讯云浏览器当前账号无法访问该环境；微信关联登录跳转被工具站点策略拒绝，不绕过、不重复扫码。当前云函数 DATABASE_URL 绑定仍未核验，不假定已停用。此项先于生产凭据轮换和 5432 收口；未修改云函数或权限。

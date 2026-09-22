# Production 安全变更候选（尚未批准/执行）

目标仅 lhins-61ikz4mi / 124.223.74.198；保留 cisme 数据库、角色权限、COS 和业务数据。当前安全事件说明见 SECURITY-INCIDENT.md。

## 数据库凭据轮换

1. 预检：已认证控制通道可用；API/Worker 指向同一 /opt/cisme/runtime.env；核对所有旧消费者（含旧 CloudBase），不只看瞬时 pg_stat_activity。核对系统时间、服务启动配置和可用本地 peer 维护通道。先在本轮新建 disposable PostgreSQL 演练失败路径。
2. 新凭据：在 production 主机用系统 CSPRNG 生成，直接写入 root-only 0600 暂存配置；不经聊天、剪贴板、命令行参数、日志或 Git。保留配置非秘密字段和文件权限，不建立新高权限角色。
3. 最终批准：向用户列明同一 cisme 角色密码轮换、API/Worker 短暂停机/连接池重建影响、已确认消费者、健康检查和失败恢复。未获得确认不得执行。若必须通过 Computer Use 完成凭据变更，依工具要求由用户执行最终提交，代理准备其余步骤，不要求用户复制密码。
4. 执行：先暂停 Worker 并优雅停止 API，等待在途事务结束；通过 PostgreSQL psql 的安全密码输入机制更新同一角色（不拼明文 ALTER ROLE 到命令/日志）。验证新密码后原子替换共享配置，按序启动 API/Worker。不得重建 DB、重跑 seed、修改角色权限或恢复旧库。
5. 验证：新凭据的 fresh TCP 连接成功；旧凭据 fresh TCP 连接失败；现有合法连接池重建；API live/ready、受保护接口未登录拒绝、Worker 周期及错误率、进程实际配置与资源绑定均正确。业务不变量/最新写入数量保持一致；不读取或输出业务行。
6. 回滚/失败恢复：凭据变更前失败可撤销准备；变更后不恢复已暴露的旧密码。优先用本地 peer 通道修复新配置，必要时再次生成全新密码并重建服务连接。应用回滚只切换兼容制品，保持新凭据与切换后业务写入；不得盲目恢复旧 DB。
7. 旧本地部署配置和其他已确认消费者的旧凭据应失效，不再作为以后部署的秘密来源。保留事故审计；不复制新生产配置回源码目录。

PostgreSQL 官方 psql 文档说明 \password 会加密后提交，避免新密码明文进入命令历史和服务器日志：https://www.postgresql.org/docs/18/app-psql.html 。本方案不是已经执行成功的回执。

## 网络分开批准

- 5432：候选为撤销云防火墙的 all-IPv4 TCP5432，并移除 UFW IPv4/IPv6 Anywhere5432；本机 API/Worker 的 loopback 不受入站规则影响。若存在仍有效旧消费者，先迁到已批准私网或列明精确来源 allowlist。当前未知消费者不能用猜测 IP 代替。保留旧规则的完整差异便于受控回退，但不自动永久重开公网。
- 443：待正确候选/API 身份门禁复核后，云防火墙和 UFW 分别增加 TCP443 入站；IPv4 范围按正式微信公网 API 必要性说明。先确认 TLS/证书链/SNI/路径与 Nginx 上游，再用独立外部网络验收；失败撤销本轮规则。不能只修改一层或关闭证书校验。
- 22：保留现有 OrcaTerm/TAT 与已验证 break-glass 通道，确认 SSH 实际使用者与固定来源后再提出 allowlist/VPN/堡垒机具体方案；不盲目禁用 root/密码或删除规则导致失联。
- 80：production 当前 DNS-01，不为修复 staging 的 HTTP-01而开放 production 80。是否需 HTTP redirect 单独评估；本轮不扩大长期暴露。

自动续费、真实资金、生产数据删除、微信正式提审/发布均不在上述方案授权内。

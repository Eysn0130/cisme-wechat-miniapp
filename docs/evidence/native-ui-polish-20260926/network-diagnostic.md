# 本机 HTTPS 只读诊断

执行于 2026-09-25（America/Los_Angeles）。未改系统代理、DNS、hosts、防火墙或产品域名配置，未禁用 TLS 校验。

| 层次 | 本机实际结果 |
| --- | --- |
| 系统代理 | `scutil --proxy`：HTTP、HTTPS、SOCKS 均启用，端口 7890；PAC 关闭。代理主机名已脱敏。进程环境的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 均未设置。 |
| DNS 与 hosts | `dig +short`：`staging-api.cisme.cn`→`198.18.0.113`，`api.cisme.cn`→`198.18.0.124`；系统 DNS 列出 `192.168.31.1` 和 `223.5.5.5`。`/etc/hosts` 未见这两个域名或 `198.18` 条目。 |
| TUN 路由 | `route -n get 198.18.0.113`：接口 `utun4`，网关 `198.18.0.1`。这是本机转发链线索，不能据此归责具体软件。 |
| 代理连接 | 按既有配置显式连接 `127.0.0.1:7890`，`CONNECT staging-api.cisme.cn:443` 收到代理的 `HTTP/1.1 200 Connection established`。 |
| TLS / HTTP | 对 staging 与正式域名的 `/health` 执行无 `-k` 的 HTTPS HEAD：均在 TLS ClientHello 后得到 `LibreSSL SSL_ERROR_SYSCALL`；`http_code=000`、`remote_ip=127.0.0.1`、`ssl_verify_result=1`。没有取得源站 HTTP 响应。 |

可定位到本机代理/TUN 之后、源站 HTTP 之前的 TLS 路径；单凭本机结果仍不能区分 SNI/转发、远端接入层或源站 TLS 端点问题，也不能断言 API 业务故障。现有证据不足以确认一个可安全修正的普通配置故障，因此本轮没有动网络配置。`127.0.0.1:18080` 的 HTTP 模拟器测试与正式 HTTPS 预览保持隔离；本项未证明真实 `wx.login`、支付或真机网络。

复查命令（只读，输出时脱敏代理主机和环境值）：`scutil --proxy`、`scutil --dns`、`route -n get 198.18.0.113`、`dig +short staging-api.cisme.cn`、`dig +short api.cisme.cn`、`curl --head --max-time 8 --proxy http://127.0.0.1:7890 https://staging-api.cisme.cn/health`。不加 `-k`。

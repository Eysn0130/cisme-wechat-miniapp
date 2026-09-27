# 正式目标只读复核（2026-09-24 12:51 UTC）

目标：腾讯云 Lighthouse `lhins-61ikz4mi`，上海，`cisme-app-shanghai`，公网 IPv4 `124.223.74.198`。本次通过已登录的腾讯云控制台和该实例 OrcaTerm 会话查看，没有修改运行配置、数据库、文件或防火墙。

- Lighthouse 实例防火墙页：允许规则为全部 IPv4 的 TCP 22、TCP 80 和 ICMP，共 3 条。页面未显示 TCP 443，也未显示原先公开的 TCP 5432。这里只能证明云控制面当前规则，不能单独证明端到端 HTTPS 可达性。
- OrcaTerm 只读命令 `sudo -n readlink -f /opt/cisme/current`：`/opt/cisme/releases/20260909-native-login`。目录名不是 Git SHA，当前源码尚未部署。
- OrcaTerm 只读命令 `sudo -n systemctl is-active cisme-api cisme-worker`：两项均为 `active`。这不证明两项运行的是本轮源码。
- OrcaTerm 只读命令 `sudo -n grep '^APP_ENV=' /opt/cisme/runtime.env`：`APP_ENV="staging"`。仅读取这一项，没有输出其余环境配置。
- 腾讯云「我的备案」页：现有备案订单显示「待验证备案 - 草稿」，「提交初审 未提交」，主体和互联网信息服务区域显示「暂无备案」。本轮没有提交或放弃备案。

本机网络解析到代理保留地址 `198.18.0.124`，`curl` 对该地址超时；这不是正式公网 IPv4 的独立 HTTPS 探测，不能据此判断正式域名的真实外网连通性。正式部署仍须在源码合并和真实备份隔离恢复后核对外网 TLS、合法域名、生产模式、迁移、COS、Worker、回滚和告警实收。

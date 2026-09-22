# 发布环境核验：2026-09-22

后续两环境复核以 [ENVIRONMENTS.json](ENVIRONMENTS.json) 为准。production 与 staging 的实例、域名、制品哈希、数据归属、防火墙、证书、政策和到期时间已分开记录。下文原始旧版本/隐私 v5/HTTP-01/10 月到期观察均只属于 staging，不推断 production。

production 实时记录：`lhins-61ikz4mi / 124.223.74.198 / api.cisme.cn`，运行目录 `20260909-native-login`；数据库 `127.0.0.1/cisme`、上海 COS `lhcos-81ddf-1257392443`。旧 APP_ENV=staging 标签不改变其 production 归属。production manifest 缺 Git SHA，已记录实际 API SHA256；本机校验 HTTPS 200，但 production 防火墙没有 443 规则。production 的政策实际为 `2026-09-09-v3-profile`，不同于 staging 的 v5。production 全程只读，无迁移或切换。

staging 实时记录：`lhins-ei4hz4fi / 150.158.39.74 / staging-api.cisme.cn`，现存 DB `cisme_staging` 与 release 内 api_gateway 对象目录。旧 manifest 同样缺 Git SHA，不把制品哈希称为源码 SHA。用户已授权在 staging 用全新隔离数据部署验证候选；现有 DB/对象保留，禁止真实资金。HTTP-01 风险保留但不单独阻断发布施工，本轮不改防火墙。staging 保留至 production 上线稳定期；当前自动续费未开启，报价 1 个月 65 元、3 个月 195 元、12 个月 663 元（付款时复核），未下单或扣费。

审核与备案分别记录：用户报告微信“待审核”，精确类别尚未读到；公众平台被工具站点安全策略拦截。工信部 cisme.cn 查询进入滑块安全校验，尚未获得查询结果。腾讯云旧草稿不足以认定该域名没有 ICP/接入备案，未重提、撤回或修改任何审核流程。

本报告是只读核验与本轮隔离演练记录，不是正式发布批准。源码基线 `ae31437652e2fe3fbb24e7ac493d3b60ad747d27`，tree `d1e352647d0383cfe4a1524144c132a1a7d296d2`；[main CI 35697496015](https://github.com/Eysn0130/cisme-wechat-miniapp/actions/runs/35697496015) 成功，986 单元、782 集成。PR16–19 已合并，无打开 PR（核验时）。唯一工程 `/Users/mini/CISME` 初始无未提交文件，同根其他任务 idle。

## 已解除的阻断

- 新建 Google Chrome 腾讯云控制台页可用，已有登录有效，无需用户重新登录。
- 实时确认 staging：`lhins-ei4hz4fi / cisme-staging-shanghai / 150.158.39.74`，上海八区，Ubuntu 24.04，2 CPU / 4 GiB / 50 GB。生产 `cisme-app-shanghai / 124.223.74.198` 未操作。
- 已有 OrcaTerm/TAT 免密通道连通；未新建凭证、绑定 SSH key 或扩大权限。
- Nginx 配置检查成功，`cisme-staging-api.service`、`cisme-staging-worker.service` 均 active/running。Node `v24.14.0`。
- 服务器 DNS 返回 `150.158.39.74`；启用证书校验访问 `https://staging-api.cisme.cn/health/ready`，DNS 路径与 `--resolve ...:127.0.0.1` 路径均 HTTP 200、curl exit 0。没有使用 `-k`。
- 证书 SAN 为 staging 域名，Let's Encrypt YE1，2026-09-10 17:06:37 至 2026-12-09 17:06:36 GMT 有效。
- 通过 Exa 取得[微信官方发货信息管理文档](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/)，此前文档不可达不再作为阻断。文档可读不证明商户授权或功能接线通过。

## 仍需解决的事实

| 项目 | 当前证据与影响 |
|---|---|
| 本机网络路径 | 本机解析返回 `198.18.0.113`，DNS 与直接 IP 的校验 TLS 均 EOF；HTTP/HTTPS/SOCKS 系统代理已启用，到 staging 的路由为 `utun4`。服务器侧校验 HTTPS 成功，故本机代理/隧道路径是待定位对象，不能归咎云端证书。尚无本机修复或真机网络通过证据。 |
| 部署落后 | `/opt/cisme/current` 指向 `releases/20260911T051500Z-p0p1-staging`；线上 `index.js` SHA256 `7df242062417c1190b5c714ba4a34fb46cf927508989514d9e9aa5c088ed7f8b`，与历史记录一致，manifest 缺 sourceHead。当前源码尚未部署。 |
| 数据边界 | APP_ENV=staging，DB 位于本机 `127.0.0.1/cisme_staging`，不是本轮新建的可销毁数据库。未读取业务行，未迁移、清空或恢复该库。S3 endpoint/bucket 未配置，COS direct upload=false。 |
| 微信接线 | 运行配置 AppID 与工程一致，AppSecret 已配置（只输出布尔值，未记录值）；这不证明商户绑定、支付权限、隐私平台配置或合法域名验收。公众/商户私有控制台仍受工具站点策略限制，未绕过。 |
| 隐私版本漂移 | 已部署公开 `/v1/legal` 为隐私 `2026-09-11-v5-staging`、协议 `2026-09-11-v4-staging`；工程文件为隐私 `2026-09-11-v7-staging-support`。线上公开运营主体为“熹芃（上海）生物科技有限公司”，联系渠道为小程序隐私权利与微信反馈。尚缺正式交易范围的批准政策、支持数据保留期限和实际联系渠道验证；不把体验政策自动升级为正式批准。 |
| 证书续期 | Certbot timer 存在，authenticator=webroot，`/var/www/cisme-acme`；无续期 hook。Nginx 80 提供 ACME 路径，其余路径返回 404；但实例防火墙只有 TCP443、TCP22、ICMP，未放通 80。[HTTP-01 必须从端口 80 验证](https://letsencrypt.org/docs/challenge-types/)，现状有续期失败风险，尚未执行续期 dry-run。 |
| SSH | TCP22 对全部 IPv4 开放。TAT 可用，需在确认团队其他访问需求后决定收紧，未改防火墙。 |
| 资源到期 | 控制台显示 staging 2026-10-10 09:14:34 到期，自动续费未启用；没有购买、续费或改变支付设置。 |
| 备案分歧 | 当前腾讯云账号显示“待验证备案—草稿”“提交初审未提交”，主体和服务暂无备案。不能据此否定用户所述微信小程序或其他账号/服务商备案审核中；已请求区分两者，未点击提交/放弃。 |

## 当前制品演练

`dist/tencent-release-ae31437652e2` 由干净已提交基线生成，含 72 个迁移，manifest SHA256 `f743157085925e718261a5aa306c95b064f2a76c4497be27711a0d2e25af7a94`。本轮 run `5b1a905e3bc47e964be64bda` 的全新专用 DB/S3：72 迁移首次执行、重复 0 个；bundle health=200、未认证 metrics=401。两个容器均按 ownership 标记清理。详见 `candidate-rehearsal.json`、`candidate-rehearsal.log`、`release-manifest.json`。

随后在本机 Docker Linux arm64 及与目标 x86_64 一致的 Linux amd64（Node 24.14.0）分别完成锁定依赖安装、所有 manifest 哈希验证、API 模块加载与 Sharp PNG 编码，两个专属容器已删除；见 linux-*-package-check 证据。

这是本机候选包演练。腾讯云目标安装、目标迁移、远端监控告警、备份恢复、原生及授权真机仍未通过。交付压缩包不包含本机 node_modules；Linux 应按 package-lock 执行依赖安装并复验哈希，不能把 macOS 原生依赖直接搬上服务器。

## 未完成源码（不是待补截图）

1. 全接口 13 维审阅仍只有 28/228 方法的有限切片，完整 13 维通过数为 0。
2. 正式交易命令、正式商品和生产支付/退款路径仍有 synthetic_test 范围门禁；现有正式恢复协议不是完整新交易链路。
3. 正式履约、收货、售后及微信发货同步的重试、死信、对账仍需实现与验证；官方文档已可访问。
4. 全量 125 表（其中 102 表存在候选 member 外键路径）的主体解析、导出、删除/匿名化、撤回、媒体/缓存/日志/备份执行仍未完成；现有子集不能作为全隐私执行。
5. 当前前端 hash `a296da16a0edafe3d1fc988b94539a52a23f2d7e8b1fa85d9702e96b4276161c` 的 19 图是已有范围证据；本轮未改 UI、未补真机，不扩大此前验收结论。
6. 已批准目标的隔离部署、真实告警送达、多实例指标与目标恢复仍需完成。

旧 `cisme_test` 事故仍为影响 UNKNOWN、未恢复，本轮未触碰。

## 证据边界与来源

云端观察来自 2026-09-22 07:19–07:38 UTC 的腾讯云实例/防火墙/备案 UI 与已有 OrcaTerm 终端；记录为人工转录的允许字段。未保存全量终端、浏览器会话 URL、账号账单、密码、密钥、Cookie、验证码或业务个人数据。

官方参考：[腾讯云 TLS 排查](https://cloud.tencent.com/document/product/400/53650)、[Lighthouse HTTPS](https://cloud.tencent.com/document/product/1207/84359)、[微信发货管理](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/)、[Let's Encrypt 验证方式](https://letsencrypt.org/docs/challenge-types/)。

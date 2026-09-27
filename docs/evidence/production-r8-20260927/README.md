# CISME R8：收货联动、本账号 48001 诊断与发布边界

观察窗口：2026-09-27 03:00–03:40 UTC。工程仅为 `/Users/mini/CISME`，分支仍为 `codex/fulfillment-lifecycle-20260922`，PR 仍为 [#22](https://github.com/Eysn0130/cisme-wechat-miniapp/pull/22)。本回执与代码同一次本地提交；它不是 main、生产切换、微信上传或营业回执。产品依据是 PRD V2.1 R4 的 §8.2 三轴订单事实、P18、A04/05/13 与 WX-PAY-MAKE-01。

## 继承与当前输入

R7 干净起点：HEAD `47cc03b555d2de4f23f2ea0fa7d02b63e6320372`，tree `943c430c6b26c6824b499dcede2b0cb50489603f`。R7 小程序输入完整 SHA-256 为 `1b74db6d2c359b6be1544c5f3c74d7772f3855e55e0d71a8ea091d411df2b5bb`，266 文件、40 路由。R7 原生点击、profile 503 恢复、UGC UNKNOWN/关闭区分、PG16.15 和 Linux 检查沿用其[原始范围](../production-r7-20260927/README.md)，没有重新宣布全状态通过。

R8 当前小程序完整输入 SHA-256 为 `7b9593ed1c4c271e52b2b475b72f31698e492101e0edced464d27f35ca010577`，267 文件、40 路由、主包 528,958 B、总计 1,525,854 B。当前源码清单 `docs/evidence/visual/current-source-acceptance.json` 对应该哈希，`finalResult=blocked`；以前截图不自动转成这一输入的通过证据。

## 收货联动：本轮已实现的受控代码

订单详情的微信交易收货入口现在按“本人原订单 → 服务端绑定已核验现金支付事实 → 只读 get_order → 明确点击打开 `weappOrderConfirm` → App.onShow 校验返回来源和当前会话 → 再次只读 get_order”运行。组件返回的 success/fail/cancel 仅作为重查触发，不落成本地收货或资金事实；组件打不开、取消、无能力和查询失败均保留原订单、售后和客服路径。前端从服务端获取本单交易号，不接受客户端自填商户/订单标识。旧的本店 `receipt_confirmed_at`、事件及历史页面展示保留，未改写成微信确认；正式交易的页面主动作使用平台路径，合成/非正式交易仍可记录本地收货。

服务端 `WechatReceiptService` 仅通过 `WechatOrderShippingClient.queryOrder` 调用固定的微信 `get_order`；没有调用 `processOne`、`reconcile` 或 `uploadOnce`。在网络前后验证可撤销的 `shipping.query` 授权。查询前核对当前会员、订单归属、支付尝试与已应用的完整现金 inbox、AppID/商户号/商户订单号/微信交易号/OpenID/整数分金额；返回验证 HTTP/业务码和相同支付身份。网络期间不持有数据库事务或订单锁。查询后再次核对当前身份、支付绑定、订单/发货版本；只让最新查询 ID 更新观察投影，旧响应、换号和重复返回不能覆盖新结果。独立迁移 `202609270001_wechat_receipt_observation.sql` 保存必要平台状态、投诉标志、查询时间和版本，不建立新的本地交易账；审计只记白名单状态。

`get_order` 状态 1 待发货、2 已发货、3 确认收货、4 交易完成、5 已退款、6 资金待结算分别解释；未来未知数字保持 UNKNOWN。状态 2 只有无投诉时可给组件参数；`matched`/`synced` 不等于已收货，状态 5/6 和数值 `>=3` 均不被当成收货成功。查询时间明确写“查询时间”，不伪装成用户确认时间；平台观察不触发佣金、护理、退款、发货或消息。

受影响页面只调整订单详情的“发货与物流”区域：一个平台状态、一个当前可用动作和必要异常说明，保留原售后入口。没有全站设计改版。对照[官方组件](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/order-shipping/order-shipping-half.html)与[官方 get_order](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_getorder.html)合同；账号可用性未知时失败关闭，不以合成组件回调宣称真实确认。

## 本地验证与原生证据

- `npm test`：128 文件，1463 通过、1 跳过。涵盖组件回传来源、交易与会话绑定、订单状态映射、账号 HTTP/业务码区别、隐私和原生边界。
- `CISME_TEST_POSTGRES_IMAGE=postgres:16.15-alpine npm run test:integration`：58 文件，921 通过，隔离 PG 镜像 ID `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`；最终版本保护补充后另以同镜像定向重跑 `verified-payment-inbox.test.ts`，14/14 通过。合成对象目标/PG 容器均已移除。
- Linux ARM64、无网络、只读代码挂载和受保护临时目录的生产安装/恢复合成测试：97/97 通过。这不是正式 systemd 切换。
- `npm run build`、小程序 package gate、route audit、WXML/WXSS 编译、`git diff --check` 通过。设计清单结构有效，但 `releaseReady=false`，40 路由状态矩阵和真机仍有缺口。
- 微信开发者工具 v0.3.11，原 AppID `wx4eac2d4fb11d299b`、361×804 模拟器，使用 `127.0.0.1:18080 → 18081` 故障代理与隔离合成支付/发货 fixture。原订单详情先显示“微信收货状态尚未核对”；实际点击“核对微信收货状态”后显示“微信显示已发货”、查询时间与“打开微信确认收货”。[R8 原生截图](native/order-receipt-platform-shipped.png) SHA-256 `5d6efea1ca794d869c7477bd84b7e9a30c50e7101630e4fa67f9c5dd856b42c2`，仅证明该来源/状态。没有用合成交易号打开真实微信组件，也没有真机、真实回调或真实确认的 PASS。代理和 fixture 已停止；未清除原用户登录。

## 48001：本账号定向诊断

R5/R7 材料没有可用 rid。本轮仅在既有授权的自有小程序只读查询范围，对准确 AppID `wx4eac2d4fb11d299b` 获取一次 stable token，并对 `is_trade_managed` 与 `is_trade_management_confirmation_completed` 各调用一次固定 POST。于 2026-09-27 03:27:47 UTC 取得 HTTP 200 / stable token `errcode=0`；两项业务响应均 HTTP 200 / `errcode=48001`，rid 分别为 `6ab88d33-7ad80a5c-63033670`、`6ab88d33-467c5900-539943c8`。两项状态均为 UNKNOWN，不能解读为 `false` 或“只差备案”。

再用同一 AppID token 对两条 rid 调用[官方 rid 诊断](https://developers.weixin.qq.com/doc/subscription/api/apimanage/api_getridinfo.html)。2026-09-27 03:29:12 UTC，两项诊断均 HTTP 200 / `errcode=0`、可由同账号查询，原错误仍为 48001；返回中没有可安全公开且足以区分“账号类型/接口权限/后台资格”的明确原因，也未解析出可证明 request AppID 的请求体。原响应只存在正式主机 root 0600 文件 `/root/cisme-r8-shipping-diagnostic-20260927.json` 与 `/root/cisme-r8-rid-diagnostic-20260927.json`；本回执不含 token、AppSecret、完整请求或原始诊断。没有调用发货上传、付款、退款、转账或消息接口。

结论是**该自有小程序账号的两个发货资格查询仍被微信拒绝，具体开通/协议条件尚无平台回执**。需要本人在该 AppID 已允许的微信小程序后台核对“发货管理/交易结算确认”的实际资格提示，或把上述两条 rid 和时间交给微信平台支持取得具体账号原因；原后台页面曾受站点策略拒绝，本轮没有绕入口。取得明确资格变化后才各做一次只读复测。第三方代调用的 18/142 权限集不能直接作为自有账号必须新建服务商的结论。

## 支付信任、生产配置与有限授权

现有[R5 配置映射](../production-r5-20260926/CONFIG-MAP.md)中的 v2 准备 env 位于 `/opt/cisme/prepared/r5-20260926/runtime.production.closed.authorized.v2.env`；它不是 live `/opt/cisme/runtime.env`。R5 实际商户签名请求及 `404/ORDER_NOT_EXIST` 响应公钥验签成立，不能证明真实下单、回调送达/密文解密、公网路径或 AppID 交易资格。当前可信清单是已知公钥 ID 的单公钥材料；没有微信商户平台“100% 公钥/迁移确认”或混合签名证据，不增加未知平台证书或把商户证书当作微信验签证书。合成回调原始字节验签、APIv3 解密及 inbox 幂等沿用原测试范围；真实通知仍 NOT_RUN。

正式通知配置目标为 `https://api.cisme.cn/v1/payments/wechat/callback` 和 `/v1/payments/wechat/refund-callback`；小程序 preview/trial/release 的 API 映射分别按原 release-config，request 合法域名不代替微信服务端通知链路。R7 正式主机 loopback SNI/TLS 健康查询曾 HTTP 200，外部 443 握手未证实；本轮没有伪造公网送达。准确 main 安装后仍须查反向代理原始 body、无误重定向/登录拦截、正式域名/协议与回调真实平台结果。

已读用户委托 `CISME-R5-USER-20260926`：三类真实授权截至 `2026-12-25T15:59:59Z`；没有发现覆盖此后恢复期的实际新委托。本轮未写续期文件。唯一待批准维护提案：在现有授权截止前提前停止新资金交易（建议北京时间 2026-12-25 20:00，并按实际最大待支付时限再提前），仅为已发生交易保留 `payment.query`、`refund.query`、`bill.read`、`payment.callback`、`refund.callback` 至 **2027-01-31 23:59:59 北京时间**；不含创建退款、转账、发货上传或新交易。批准后须按原身份/环境/范围原子替换私有授权、验证运行用户只读和重启前后实际装载，并由监控按既有提前 14 天告警。固定尾期不保证所有晚到结果；剩余在途事项按批准策略逐笔处理。该提案不是现行授权，不阻止当前有效期内的无关施工。

## 原 GitHub 拒绝与当前发布事实

交接包唯一可定位摘要是原 `GitHub.create_tree follow-up UI/test corrections` 被工具安全检查拒绝、分支未更新、仓库写入停止且不得绕过。原始响应、request ID、精确层与可用恢复入口仍缺。复用已有 OpenAI 支持会话：其页面确认收件，但没有案件号、人类恢复决定或对原动作适用的放行。未再次向同一会话投递无新事实草稿，未以另一工具/账号/代理、用户代跑或重试写入探测原拒绝。最小外部动作是由本人在原拒绝所在 Codex 任务找到针对**该动作**的复核/恢复结果，或向既有支持会话补原任务/会话 ID 以定位事件；自动回复、只读 GitHub 成功和本轮用户授权都不构成恢复。

2026-09-27 03:37 UTC 只读 `git ls-remote` 与 PR 回读：远端原分支仍 `5ab4a00d4e71d8a9a2de14e31b64fca0bbe92e88`，main 仍 `5740e18544fa37dd473c36934a2a12a07a2d5ec9`，PR22 Open/Draft；旧 HEAD 的 `verify` 失败，`source-evidence` 成功，另两项跳过。旧 PR 不能代表本次候选，未合并。

2026-09-27 03:39 UTC，原腾讯云 OrcaTerm 只读回读：`/opt/cisme/current → /opt/cisme/releases/20260909-native-login`；`cisme-api.service` 和 `cisme-worker.service` active，`cisme-production-health.timer` inactive；live env 白名单值 `APP_ENV=staging`、`RUN_BACKGROUND_WORKER=false`，未见 `COMMERCE_ORDER_FLOW_ENABLED` / `CISME_MIGRATION_READ_ONLY` 行。R7 先前读到 23 条迁移及 2 条未处理身份事件；本轮**没有重查其新鲜数量**，不能伪称现在仍精确等于 23/2。没有安装新 main 制品、建立切换窗口保护点、执行迁移或处理事件。

## 阶段状态与恢复后唯一顺序

| 阶段 | 本轮回执 |
| --- | --- |
| 本地 R8 代码、隔离验证、订单详情模拟器状态 | 已完成，按上述范围；候选随本提交冻结 |
| 原 GitHub 写入恢复 | BLOCKED：无适用恢复结果 |
| 候选 C 远端同步、准确 CI/审阅、PR22 合并 | NOT_RUN；不合并旧 `5ab4a00d` |
| main M 与 main CI、Linux M 制品 | NOT_RUN |
| 正式 production 安装、迁移、current 切换、API/独立 worker/monitor 与业务读回 | NOT_RUN；仍是上述旧进程 |
| 准确 M 的微信开发版上传与平台版本读回 | NOT_RUN |
| 体验版、备案、代码审核、发布、营业 | 分别 NOT_RUN/未获新平台回执；不能概括为“只等备案” |

原拒绝得到同一动作适用恢复且仓库条件满足后：先同步**本地最终 C**到原分支、读回 C 与准确 CI/审阅；正常合并 PR22、读回真实 main M/tree 与 M CI。由 M 构建 Linux 制品，在正式主机做新鲜保护点、私有输入绑定和写入者围栏，安装 `APP_ENV=production` 的非营业态、迁移、切换并启动 API/独立 worker/monitor，核对授权、回调信任、历史用户/订单/护理/售后/隐私事实和当时真实身份事件。随后从干净 M 上传微信开发版并读回版本；体验版、备案、审核、发布和营业开关各自凭实际平台/协议/授权结果推进。不得用本地包直装、旧 PR 合并或上传临时二维码填补 main 来源。

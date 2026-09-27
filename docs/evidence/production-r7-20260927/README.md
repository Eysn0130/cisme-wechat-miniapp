# CISME R7：本地原生验收与正式环境只读回执

观察时间：2026-09-27 01:33–01:57 UTC。唯一工程 `/Users/mini/CISME`，原分支 `codex/fulfillment-lifecycle-20260922`，原 PR [#22](https://github.com/Eysn0130/cisme-wechat-miniapp/pull/22)。这是本地候选及只读观察，不是 main、生产安装或微信上传完成回执。

## 候选与修复

- R6 起点：`2be6981c5466e4db10ba76c7031cfb9959d48714`，tree `7d02461a012300dd2fce08fd4f8369dda9a62052`，起始工作树干净。未回退 R5/R6。
- R7 受测代码候选：`511e46f70658800df94d7d10e68ca5c69bff2707`，tree `027060b385049768c660b4baff355b672189b1e5`。小程序有效输入 SHA-256 `1b74db6d2c359b6be1544c5f3c74d7772f3855e55e0d71a8ea091d411df2b5bb`，266 文件、40 路由；锁文件 SHA-256 `09d4a7746029d61ae3db73514b730794f906360aea6c2290753b2c01740905d9`。
- 开发者工具真实运行发现：`?new=1` 在 UGC 确认关闭时重复提示；状态查询失败又把 UNKNOWN 写成“暂未开放”。已在原生创作页只保留一条状态说明，失败时写“暂无法核验”，禁用投稿、新建草稿入口并保留已有内容。新增定向回归。无新框架、第二后台或全页改版。
- 开发者工具故障注入只使用 `scripts/native-acceptance-fault-proxy.mjs` 的 `127.0.0.1:18080 → 18081` 合成 fixture；`profile` / `ugc-status` 两个哨兵文件分别让对应 GET 返回 503。已停止代理和 fixture，移除本轮 Docker 容器；没有碰正式 API、真实身份或资金接口。
- 当前源码证据清单已更新到 `1b74db6d…`，`finalResult=blocked`。旧 `fba3b411…` 清单归档；旧 e97/fba 截图只按未变页面及状态继承。

## 原生验收：实际运行与边界

环境为已登录原 AppID `wx4eac2d4fb11d299b` 的微信开发者工具 v0.3.11、361×804 模拟器、本地开发身份和隔离 fixture。以下是原生模拟器画面及真实控件点击，均非 iOS/Android 真机、真实微信支付或正式协议验收。截图文件在 [native](native/)；本提交保留关键帧。`09`–`16` 截图对应中间输入 `182873c45e49e1e83a6353ea6b8d5bf61560a68bbd16f3f64473b41659ee3a4a`，`17`–`18` 对应最终输入 `1b74db6d…`；中间至最终只改变创作页的门禁状态文案，profile/订单/客服/设置源未变。

| 场景 | 实际观察 | 截图 |
| --- | --- | --- |
| 正常会员“我的” | 会员、护理、服务入口正常显示 | [09](native/09-profile-new-fixture-normal.png) |
| `/v1/bootstrap/profile` 单独 503 | 资料/护理/积分不被当作当前值；订单、客服、设置及独立辅助信息仍有入口 | [10](native/10-profile-core-failed.png) |
| 故障态点击“我的订单” | 到原订单列表，隔离 fixture 的既有合成订单可见 | [11](native/11-orders-from-profile-core-failed.png) |
| 故障态点击“客服” | 到原客服会话；只读取 fixture 预置合成消息，未发送消息 | [12](native/12-support-from-profile-core-failed.png) |
| 故障态点击“设置” | 到原设置页，地址与隐私入口可见 | [13](native/13-settings-from-profile-core-failed.png) |
| 503 解除后返回 | 会员和护理卡片恢复 | [14](native/14-profile-recovered.png) |
| UGC 查询 503 | 社区公开创作 FAB 不出现，`ugcFeedEnabled=false` | [15](native/15-community-ugc-status-failed.png) |
| UGC 查询 503 后直达 `?new=1` | 未创建草稿；修复后只说明“投稿状态暂无法核验” | [16 修复前](native/16-compose-deeplink-status-failed.png)、[17 修复后](native/17-compose-status-failed-distinct.png) |
| 真实返回 `publicEnabled=false` 后直达 `?new=1` | 不创建草稿；保留已有内容入口，显示确认关闭的文案 | [18](native/18-compose-confirmed-closed-current.png) |

R6 的“辅助结果先成功、主资料后失败”在本轮合成服务调用中按上表观察；换号/旧响应/401 与权限拒绝由 `tests/unit/native-progressive-load.test.ts` 等定向单测覆盖，**未在本轮模拟器完成 A→B→A 真人或双号操作**。没有设备视口/字号控制证据，窄屏、放大字号、键盘和动画全状态仍未标通过。UGC 既有草稿/申诉在本轮空 fixture 中没有正向业务数据；源码与前轮回归只证明入口及保护逻辑。

## 准确检查

均基于 R7 候选源码和未变锁文件：`npm test` 为 127 文件、1459 通过、1 跳过；`CISME_TEST_POSTGRES_IMAGE=postgres:16.15-alpine npm run test:integration` 为 58 文件、919 通过，镜像 ID `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`，合成对象目标，已自动清理。`npm run build`、typecheck、package gate、route audit、`git diff --check` 通过。package gate 输出 266 文件/40 路由，main 526416 B，总 1517676 B。`design:qa:status` 结构通过，但 `releaseReady=false`，设备、路由矩阵及既有 P0/P1 项仍未完成。

Linux ARM64 的 `python:3.12-slim` 隔离容器、网络关闭、只读挂载运行安装/前向恢复测试：首次直接使用 Linux `/tmp` 的 1777 父目录导致 2 项私有输入测试按安全规则拒绝；将 `TMPDIR` 指向容器内 root 拥有且 0700 的 `/opt/cisme-test-tmp` 后 **55/55 通过**。这是测试 fixture 目录问题，不应放松真实私有输入父目录约束。测试中的 systemctl/身份/备份批准仍为合成替身，未证明生产同沙箱哨兵写入或真实切换。

干净代码候选运行 `WECHAT_APP_ID=wx4eac2d4fb11d299b npm run wechat:upload`，在 `UPLOAD_SOURCE_NOT_CURRENT_REMOTE_MAIN` 停止，未调用微信上传 CLI。开发版本源码上传、体验版、审核及发布分别为 `NOT_RUN`。

## 原拒绝与远端状态

允许读取的交接包 `/Users/mini/Downloads/CISME-R8-Release-Closure-Handoff.zip` 中 `04-CURRENT-STATE.json` 仅记载原动作 `GitHub.create_tree follow-up UI/test corrections`、`blocked by tool safety check; no branch update`、`repositoryWritesStopped=true`、`doNotBypass=true`。没有原始工具响应、动作/request ID 或当前可操作的本人恢复卡片。**拒绝所在的精确层仍无法从现有证据定位**；旧支持邮件、只读 GitHub 成功及 `mergeable=MERGEABLE` 都不是原动作恢复。此任务环境没有能对该原拒绝执行的 `/approve` 入口；未以其他工具、账号、代理或等价用户代跑探测写入。

2026-09-27 本轮只读回读：远端原分支仍 `5ab4a00d4e71d8a9a2de14e31b64fca0bbe92e88`，main 仍 `5740e18544fa37dd473c36934a2a12a07a2d5ec9`；PR22 Open/Draft。旧 HEAD 的 `verify` 失败、`source-evidence` 通过、设计与凭据预览跳过。旧 PR 不能合并为 R7；没有准确候选 C 的远端 CI、main M、main CI 或 Linux main 制品。

原动作的唯一外部下一步是通过**同一拒绝项适用的正常复核/恢复入口**取得可用结果；若该工具明确不可恢复，需由其所属控制层给出许可或结案解释。现有交接材料缺原始拒绝通知和 ID，不能推断入口或绕过。恢复后必须先同步本地最终候选、读回准确远端 HEAD 与 checks/审阅，再按仓库规则合并，而非点旧 5ab 的 Merge。

## 正式主机本轮只读观察

用户恢复了原腾讯云 OrcaTerm 会话。本轮在 `lhins-61ikz4mi` 原窗口执行只读命令，约 2026-09-27 01:33 UTC；以下为终端视觉转录，不是生产部署回执。主机实例 metadata `ins-l9utqwxv`；`/opt/cisme/current` 指向 `/opt/cisme/releases/20260909-native-login`。API/worker 均 active，主 PID 分别 100151/100155，启动时间 2026-09-09 18:33:42 CST，运行用户 `cisme`、工作目录 `/opt/cisme/current`。

已安装 API/worker 的生效配置均为 `ProtectSystem=strict`、`ReadWritePaths=/opt/cisme/tmp /var/lib/cisme/privacy-suppression`；隐私抑制目录属主 `cisme:cisme`、0700。因此“现有旧 unit 必因缺此例外而陷入预检循环”在本机现状未复现，未修改安装器。仍没有用同一正式服务沙箱做无秘密负向写哨兵；此项随准确 main 安装核验。

live env 白名单回读 `APP_ENV=staging`、`RUN_BACKGROUND_WORKER=false`，旧 env 中未见 `CISME_MIGRATION_READ_ONLY` 与 `COMMERCE_ORDER_FLOW_ENABLED` 键；`cisme-production-health.timer` 未安装。PostgreSQL server 与 `pg_dump` 均 16.15，数据库 `schema_migration` 23 条，最新 `202609090006_member_identity_display.sql`；`identity.accepted.v1` 未处理 2 条。主机 Node v24.14.0。主机 loopback 443 用正式 SNI/TLS 查询 `/health/ready` 得 HTTP 200、证书校验结果 0；外部客户端直连 443 此次 SSL 握手失败，不能据此断定公网链路或正式协议已通过。没有在旧版本运行资金、发货或真实用户消息探针。

当前不是 `APP_ENV=production`、95 迁移、新 API/worker/monitor、正式协议和历史事件处理完成的状态。R5 已准备的 v2 closed env 与维护 503 不等于安装；当前无主线制品，所以没有进入迁移、保护点创建或服务切换。

## 平台、授权和剩余动作

- R5 的真实商户请求签名与微信 `404/ORDER_NOT_EXIST` 响应验签证据继续按原范围继承；没有真实下单、回调密文、公网送达或资金结果。微信公钥单模式/混合期的独立平台依据仍缺。回调验签、APIv3 解密和 inbox 幂等只具合成覆盖。
- 两个自有小程序发货账户查询已有 HTTP 200 / `errcode=48001`；stable token 与业务字段核对已在 R5/R6 做过，具体原因仍 UNKNOWN。[微信官方排错文档](https://developers.weixin.qq.com/doc/oplatform/developers/troubleshooting/)列出 token 账号类型不匹配和接口功能未授权两类原因；[发货管理查询](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_istrademanaged.html)与[结算确认查询](https://developers.weixin.qq.com/miniprogram/dev/server/API/order_shipping/api_istrademanagementconfirmationcompleted.html)的 18/142 权限集是第三方代调用说明，不能直接移作普通自有账号申请结论。原微信平台页访问曾被站点策略拒绝，本轮没有改用其它途径触达同一被拒站点或重放相同接口。须由该 AppID 已允许的管理后台/平台支持给出具体权限提示；状态变化后再各一次只读复测，不把 48001 说成 `managed=false` 或“备案未过”。
- 当前“确认已收到全部商品”走小程序 `services/orders.ts` → `/v1/me/orders/:orderId/confirm-receipt` → `orderFulfillment.confirmReceipt`；源码未见 `weappOrderConfirm`。[微信官方确认收货组件](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/order-shipping/order-shipping-half.html)要求以 `wx.openBusinessView` 打开，`App.onShow` 接到结果后还需服务端查询确认。当前实现仅是本业务本地确认，不能作为微信平台确认/结算完成凭据。账号 48001 及适用平台要求未明前，不自行触发或伪造组件成功，也不把本地确认推进资金状态。
- R5 三份实际有限授权均于 `2026-12-25T15:59:59Z` 到期。R6 合成“另有有效恢复授权”测试不是实际续期；到期后的晚到支付/退款结果当前会被拒。用户现有 `CISME-R5-USER-20260926` 委托覆盖本次至 12 月 25 日的有限期，未见对之后恢复期的明确范围。应在既有告警提前 14 天窗口到来前明确有限恢复期及五项恢复能力并原子换证；不无限续期。monitor 还未安装、实际告警送达未验证。
- preview/trial 仍指 `https://staging-api.cisme.cn`，release 指 `https://api.cisme.cn`，DevTools 本地 fixture 指 `127.0.0.1:18080`；源码映射正确不等于 trial/release 的后台身份、合法域名、正式协议和真实平台门禁已验证。正式账号/协议、合法域名、客服接待与微信平台资格须分别读回。
- 备案状态仅有用户先前“审核中”线索；本轮没有新的平台备案回执。开发版上传、体验版、代码审核、发布、营业准入全部分别未完成，不能写“仅等备案”。真机 iOS/Android 与全部 40 路由验收矩阵仍有缺口，不借模拟器截图改为 PASS。

## 依赖解除后的准确发布顺序

1. 原 `GitHub.create_tree` 拒绝取得适用恢复且仓库条件满足后，在原分支同步本地最终候选；读回 C、准确 PR checks/审阅，转 Ready 并正常合并 PR22；回读 main M/tree 和 M 的 main push CI。保持旧 5ab 不合并。
2. 由 M 构建 Linux 制品，正确正式主机建立新鲜保护点与所有写入者围栏，按原安装器检查 v2 私有输入、迁移、实际 units/同沙箱负向哨兵和明确的恢复资格。切换到 `APP_ENV=production` 的已安装非营业态，启动 API、独立 worker、monitor，保持 API 内嵌 worker 和新单准入关闭，业务读回 2 条身份事件与历史对象。
3. 在准确 M 的干净源码上按原上传脚本输入版本/说明并使用现有微信 CLI 上传开发版，读取平台回执；体验版、备案、审核、发布、营业开关各自有独立动作与证据。资金/发货/真实用户消息不作为验收测试。

目前第 1 步的原写入拒绝未恢复，故第 2–3 步均未执行；本地包不能旁路 main 部署。

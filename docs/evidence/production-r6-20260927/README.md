# CISME R6 本地候选与外部切换边界

观察日期：2026-09-27 UTC（洛杉矶时间 2026-09-26）。唯一工程 `/Users/mini/CISME`，原分支 `codex/fulfillment-lifecycle-20260922`，原 PR [#22](https://github.com/Eysn0130/cisme-wechat-miniapp/pull/22)。本记录是 R6 本地施工回执，不是 main、生产或微信平台的完成回执。

## 准确来源

| 层级 | 本轮事实 |
| --- | --- |
| R5 继承 | 起点 `a3421cc9b0dc9e729f5b6396ff1191a42734d175`，tree `eb43febde5886cc7e8980f467ba4882fafca7831`；R5 受测源码 `f62719e6fc896f18d18a84d3b1c25d06b0d38363`，tree `e7450768b67fdd3f4afeb9990b00deb9d66a6817`。两者差异仅为 R5 报告与证据。进入现场时工作树干净。 |
| R6 代码候选 | `75f54f66f3c571a8941eb894f756bdf3959e76bd`，tree `c2c18bef7482df73450a8a1cf3d76cad5059c674`；前一修复提交 `07094d242aa46fd052f0a40a66eb8d4ca3499474`。以下验证的 API/worker、小程序源码与此候选相同；新增本报告只改变报告树，不改变这些输入。 |
| 依赖与原生包 | Node `v24.14.0`；`package-lock.json` SHA-256 `09d4a7746029d61ae3db73514b730794f906360aea6c2290753b2c01740905d9`；小程序有效输入 SHA-256 `fba3b4114d3808536475ddd82bdd1ee0f56e2636d279cb1bbd4644fadcc33faa`，266 文件、40 路由。 |
| 远端只读回读 | 原分支 `5ab4a00d4e71d8a9a2de14e31b64fca0bbe92e88`；main `5740e18544fa37dd473c36934a2a12a07a2d5ec9`。PR22 Open/Draft，旧 HEAD `verify` 失败、`source-evidence` 成功、`candidate-design-qa` 与 `wechat-credentialed-preview` 跳过。[旧 verify](https://github.com/Eysn0130/cisme-wechat-miniapp/actions/runs/36096370307) 不代表 R6。 |

R5 的真实请求签名及微信支付 `404 / ORDER_NOT_EXIST` 响应验签、私有材料、R3/R4 真实恢复证据保持原范围继承，未重复创建订单或实际资金/发货/消息。原 GitHub `create_tree` 写入拒绝仍无适用恢复证据；只做一次远端只读回读，没有换工具、账号或通道写入。当前 main CI、Linux main 制品、生产切换、微信上传回执均为 `NOT_RUN`。

## 本轮源码修复与边界

1. **P18/P20 常用服务：** `/v1/bootstrap/profile` 失败时只清除当前资料、积分、护理的可信显示，保留已独立请求的任务结果，并让订单、客服、设置入口可达；重试资料与辅助状态分开。换号仍重置旧投影，服务端鉴权未变。改动在 `apps/miniprogram/pages/profile`。对应模拟页面行为回归覆盖独立入口、旧投影清除与重试。
2. **UGC-GATE-02：** 社区浮动创作按钮只在 `/v1/ugc/status` 确认为公开可用后显示；关闭时直达 `?new=1` 先检查能力，不创建新草稿，转向既有内容并告知当前状态。已有草稿、历史内容与申诉入口保留。错误/未知状态不放开发布。改动在社区、创作页和原 TabBar，不增加导航系统。
3. **生产服务沙箱：** `cisme-worker.service` 的 `ReadWritePaths` 增加既有隐私抑制目录 `/var/lib/cisme/privacy-suppression`，与安装器和 API 单元一致。`production-release.py` 预检现在读取**实际安装**的 API/worker `User`、`ProtectSystem`、`ReadWritePaths`，拒绝对私有运行输入、live env、current 与制品路径具有写例外的配置。模拟单元正反向测试通过。R5 一次性同沙箱检查只按其原范围继承；新单元尚未安装，真实主服务的负向哨兵写入与生效值读回仍须在准确 main 安装时执行。
4. **WX-PAY-MAKE-01：** 用合成有限授权覆盖准确截止时刻：新订单、付款与退款提交拒绝；若**另有明确批准且仍有效**的独立恢复授权，已有支付/退款回调和查单 lane 可以继续；恢复授权到期即全部停止。此测试不修改 R5 三份实际授权。实际三份都在 `2026-12-25T15:59:59Z` 结束，因此当前配置下，逾期到达的真实回调/查单确会受阻；API/worker 进程健康并不等于订单完成。不得用测试中的较晚合成期限冒充真实续期。
5. **上传与发布状态：** `wechat:upload` 现在仅作开发版本源码上传，要求正确 AppID、隐私检查、trial/release HTTPS 目标、设计证据结构有效、干净工作树，并要求本地 HEAD **等于当前远端 main**。继续要求 `--confirm-upload`、版本及说明。它不要求尚未发生的真机/备案/合法协议验收，不会自动设体验版；原 `wechat:preflight:trial/release`、`design:qa:gate` 和平台审核/正式发布验收保持原要求。当前实跑在 `UPLOAD_SOURCE_NOT_CURRENT_REMOTE_MAIN` 停止，未上传。

已读原开发者工具官方 CLI 现场帮助：`upload --project --version --desc --info-output`；`wechatide` 的包装层使用不同的 `--upload-version` 合同。本轮源码上传脚本沿用官方 CLI，项目配置 AppID 为 `wx4eac2d4fb11d299b`、`miniprogramRoot=./`。没有为上传创建新密钥或清理登录。

订单详情已有底部售后/客服面板、同一订单 ID 到客服与售后 case 的传递、幂等售后提交和草稿交接，定向源码与既有回归未发现须重建第二客服或售后系统的断点。结算步进器、面板动画、键盘与安全区未复现新增问题，本轮未改动。没有视觉实测的像素、帧率与真机状态均不标通过。

## 支付、履约和环境的精确状态

| 项目 | 已证明 | 尚未证明 |
| --- | --- | --- |
| 微信支付信任 | R5 私有配置的一个微信公钥 ID、商户签名及微信响应公钥验签通过；本地回调以原始 body、`Wechatpay-Serial`、时间/nonce/签名和 APIv3 解密校验后，核对订单/AppID/商户/金额并持久化 inbox 才应答 204。未知 ID 拒绝。 | 商户后台当前是公钥单模式还是迁移混合期的独立平台依据、真实通知密文、公网送达、真实收款/退款均未验证；一次响应验签不能替代。公网 notify_url 为 `https://api.cisme.cn/v1/payments/wechat/callback` 与 `/refund-callback`；当前 nginx 源配置原样代理路径到本机 3100，443 的真实外网可达性仍未证明。 |
| 授权维护 | R5 三类有限授权至北京时间 2026-12-25 23:59:59；监控源码从 live env 读取并在不足 14 天时告警。新交易准入与既有交易恢复代码分开。 | 告警服务安装/真实送达、跨实际截止日的既有订单恢复未完成。应在北京时间 2026-12-11 23:59:59 前核对接收目标与有限续期依据。至少按 live `COMMERCE_PENDING_ORDER_TTL_MINUTES` 的实际值（配置上限 120 分钟）提前停止新单，排空未知支付与在途退款；晚到通知没有由订单 TTL 保证的上界，仍需在截止前取得有依据的有限恢复授权或明确清零风险暴露，不能自动无限续期。 |
| 发货管理 | R5 stable_token 为 HTTP200/errcode0；两项自有小程序只读账户查询按 POST 与 `appid` 调用，代码按 `is_trade_managed`、`completed` 读字段，HTTP200/errcode48001 保持 UNKNOWN。原观察是 CUA 视觉转录，不是保存的机器回执。 | 具体账号接口权限、发货管理/交易结算确认状态未定位；平台未变化时未重复发请求。不得把 48001 认作 false、备案单因，或借服务商权限推断；不执行发货上传。 |
| 正式协议 | release 指向正式 `/v1/legal`，客户端没有硬编码假正式版本。 | 生产正式协议发布、平台同意记录、正式身份链与可访问域名未完成联调。 |

环境映射：DevTools → `http://127.0.0.1:18080`／本地开发身份和本地协议 fixture；preview、trial → `https://staging-api.cisme.cn`／需实际核对后端 `APP_ENV=staging`、合法域名、测试范围；release → `https://api.cisme.cn`／必须实际 `APP_ENV=production`、正式微信身份和服务端有效协议。支付/退款 notify_url 是服务端入站地址，不等同于小程序 request/upload/download 合法域名。相同前端源码不意味着体验版和正式版连接同一后端。

R5 准备 env `runtime.production.closed.authorized.v2.env` 的 `APP_ENV=production`、`COMMERCE_ORDER_FLOW_ENABLED=false`、`CISME_MIGRATION_READ_ONLY=true`、`RUN_BACKGROUND_WORKER=false` 用于迁移维护：API 写入含回调返回 503，独立 worker 也因只读围栏不处理任务。安装成功后若进入“已安装、营业未开放”，须在完整迁移和写入者核验后将 live `CISME_MIGRATION_READ_ONLY` 受控改为 `false`，保持 `RUN_BACKGROUND_WORKER=false` 以避免 API 内嵌 worker 重复执行，保持订单准入 `false`；独立 worker、API、monitor 重新启动并读回实际进程与历史任务结果。营业开通才在平台、支付/履约、协议、公网和运营条件满足后单独打开新单准入。以上状态转换尚未在正式服务器执行，不能把维护 503 当成安装或营业。

## 定向原生与检查结果

- 旧 `e97db469…` 接受清单保存在 `docs/evidence/visual/source-acceptance-e97db4690df6.json`；当前清单如实绑定 `fba3b411…`、`finalResult=blocked`、40 路由矩阵未完备。`design:qa:status` 为 `ok=true, releaseReady=false`。旧截图只按原 R3/R4 页面、状态和输入范围引用，不覆盖本轮改动页。
- 现有微信开发者工具已登录原 AppID。当前输入下只读 `compile_wxml` 对“我的”、社区创作页和 TabBar 返回成功；它只代表模板摘要，不是完整页面/截图/交互。此前并行调用遇到每分钟限流，之后顺序重试成功。未得到窗口空闲确认，未切换用户当前模拟器页面；本轮改动页的原生截图、窄屏、大字号、键盘、安全区、动画和 iOS/Android 实机均为 `NOT_RUN`。
- `npm test`：1458 通过、1 跳过；`npm run test:integration`：919 通过，隔离 PostgreSQL `18.4-alpine`、合成对象目标，运行在 `07094d2`，后续仅改上传脚本及单测，API/worker/SQL/小程序输入未变。`npm run build`、typecheck、contracts、package gate、route audit 通过；部署 Python staging 121/121，通过，production 10 项中 1 跳过。首次单测因旧包哈希与证据清单不符失败，归档旧清单并更新为真实 blocked 后全过；首次 Python 测试因 macOS `/etc`、`/var` 的路径解析差异失败，统一解析后全过。
- `npm run restore:verify`：95→95 条迁移、合成数据库及单对象恢复通过，**不是生产恢复**；新回执见 [synthetic-restore.json](synthetic-restore.json)。R3/R4 的真实恢复仅按原输入继承。两个 `npm audit --audit-level=high` 范围均 0；license 报告 662 项、0 unknown；本机 Gitleaks 8.30.1 校验官方 SHA-256 后扫描 413 个提交，0 泄漏。CI 的 Linux 扫描仍须在准确 PR/main 上执行。

## 外部状态和后续不可替代动作

R5 最近一次正式主机回执（`2026-09-26T16:03:45Z`）是 `lhins-61ikz4mi`／`124.223.74.198`，current `/opt/cisme/releases/20260909-native-login`，live `APP_ENV=staging`，API/worker active，23 条迁移、2 条身份事件待处理。R6 未把本地制品装入该主机；无 Linux main 制品、无新鲜切换保护点、无真实 unit 生效值及业务读回。现有准备文件和 R5 一次性验证器不等于生产安装。

1. 取得**针对原 `GitHub.create_tree` 拒绝**适用的有效恢复；然后正常同步原分支，回读新 HEAD，跑准确 PR CI/审阅并按仓库规则合并 PR22。旧 `5ab4a00d…` 的失败检查不得用于合并。随后回读 main SHA/tree、main CI，产生 Linux main 制品。
2. 在正确主机以最终源码安装审核过的 API/worker 单元与 monitor，读回真实 `ProtectSystem`、User、写例外；用同沙箱无秘密哨兵证明 API/worker 可读而不能修改私有输入。准备新鲜数据库/对象保护点与写入者围栏，用准确 `production-release.py` 资格及正常安装/必要显式 resume；完成上述已安装非营业态转换，消费并业务读回两条旧身份事件。保持原数据库、COS、CONTACT、会话与隐私导出密钥。
3. 在允许的小程序平台确认 48001 的具体权限/账号状态；状态变化后只读复测并保存机器可读脱敏回执。取得微信支付信任模式和实际公网回调入口的有效依据；正式协议、合法域名、客服接待及 monitor 运维接收目标逐项实测。真实资金、发货和用户消息继续依真实业务授权，不作为验收探针。
4. 准确 main 且源码干净后用原 AppID 上传并读回微信开发版本；本轮脚本会拒绝旧 main。设为体验版、备案、代码审核、发布、营业准入分别处理并记录。当前上传/平台版本、体验版、审核、备案完成、发布、营业均无 R6 完成回执；不得概括为“只差备案”。

# PR22 当前源码原生复测记录（2026-09-25，洛杉矶时间）

本记录对应 `/Users/mini/CISME` 的原生微信小程序，产品基线为 `docs/product/CISME-产品需求文档-PRD-V2.1-R4.md` 的 P01、P17、P20、P23，以及 A07、A11、A20、CARE-01。**结论按执行环境拆分；模拟器结果不代表 iOS 或 Android 真机结果。**

## 1. 候选与环境映射

| 锚点 | 本轮实际事实 |
| --- | --- |
| 开始时 Git HEAD / 分支 | `f47bfce491ec9001e78792098d08a16187e0c3c3` / `codex/fulfillment-lifecycle-20260922`；本轮修复和证据在其后本地提交，最终提交号见该分支 `git log -1` |
| 小程序有效输入 SHA-256 | `ed0d7d60b8e201a2d0f99213a107a5f7e5dd0631193ed4c31601624ce512ead7`；265 个文件，40 个路由，主包 514208 字节；报告和证据不计入该哈希 |
| 构建与运行配置 | `package-lock.json` SHA-256 `09d4a7746029d61ae3db73514b730794f906360aea6c2290753b2c01740905d9`；`apps/miniprogram/project.config.json` SHA-256 `cc70124ab1991c0f938fdaee9362766c0102008b703c15848e185fde65cb696a`；`release-config.ts` SHA-256 `2637939b63d272347b59d62a97593ce7248b2a26e5289411b35125daf0399483` |
| 微信项目 | `/Users/mini/CISME/apps/miniprogram`，AppID `wx4eac2d4fb11d299b`，基础库 `3.15.2` |
| 本机工具 | 微信开发者工具 Stable `2.02.2609231 RC`，其内置 `wechatide` skill/CLI `0.3.11`；Computer 可操作开发者工具；未安装独立 `miniprogram-automator`、`miniprogram-ci`、ADB 或 scrcpy |
| 本轮运行后端 | 仅 `127.0.0.1:18080` 的一次性合成服务，runId `6a903e0c2dc0ac976949f5c2`、数据库 `cisme_test_6a903e0c2dc0ac976949f5c2`、95 条迁移；支付不可用。**此地址仅对 Mac 上开发者工具模拟器有效。** |
| 预览/体验/正式选择 | `release-config.ts`：DevTools→本机 18080，开发预览与体验版→`https://staging-api.cisme.cn`，正式版→`https://api.cisme.cn`。普通真机开发预览走真实微信登录；特殊 `cisme_remote_debug=1` 不计正常模式证明 |
| 远端后端与微信制品 | 上次文档记录的 staging 来源为 `43885ba…` / `/opt/cisme/releases/rc20260922-aa3e2665-43885ba9982f`，只是历史线索。本轮未能读到现役部署 SHA，也未上传或取得当前候选的预览/体验版回执、微信安装包字节哈希；**不能建立当前源码到真机安装制品的映射。** |

开发者工具本机的被忽略文件 `apps/miniprogram/project.private.config.json` 原有 `urlCheck:false`，打开项目时工具也显示域名/TLS 校验被关闭的警告。跟踪文件 `project.config.json` 为 `urlCheck:true`。本轮没有更改私人配置；所以本机模拟器结果是隔离调试证据，不能证明合法域名、证书或正常手机模式通过。

## 2. 本轮执行结果

| 范围 | 状态 | 已执行与证据边界 |
| --- | --- | --- |
| 当前源码编译与默认路由 | **PASS（本机合成模拟器）** | 当前哈希重新编译；40/40 原始 390×844 帧、38 个正常路由与 2 个预期守卫路由（退役帖子页、关闭的资金页）。捕获时 Console/Network 过滤命中均为 0；这是该采样窗口的结果。其后本机服务出现一次有明确守卫原因的物流跟踪 503，见[运行记录](runtime-observations.txt)，不把捕获窗口的 0 命中扩大为全程无异常。见[40 路由包](../visual/review-closure-20260925-current/README.md)及其 `routes.csv`、`route-runtime-health-ed0d7d60.json`、`SHA256SUMS`。 |
| 定向用户操作与服务端事实 | **PASS（列明用例，本机合成模拟器）** | Computer 实际点按商品、结算、订单、售后、客服、隐私、护理；一次性数据库读回见[脱敏事实](isolated-business-readback.txt)和下表。未用 `setData`/注入 token 代替这些点击。 |
| 其他页面状态矩阵 | **NOT_RUN** | 40 张默认帧不覆盖每页的加载、空态、失败、权限、键盘或动画；针对关键路径做了定向操作，未宣称逐页全状态通过。 |
| 正常安全预览及真实微信登录 | **BLOCKED_EXTERNAL** | 本机解析 staging/prod 域名分别到 `198.18.0.113` / `198.18.0.124`；对两个 `/health` 的 HTTPS HEAD 均在 HTTP 之前出现 `SSL_ERROR_SYSCALL`。不能据此断言公网服务器本身故障。当前候选也无预览上传回执；未豁免域名/TLS 的正常手机运行及真实 `wx.login` 交换均未执行。 |
| iOS 真机 | **BLOCKED_EXTERNAL** | 未检测到本机已连接的获授权 iPhone；iPhone Mirroring 当前要求用户 iCloud 登录。没有设备连接、扫码、真机调试、软键盘画面或用例结果；不是 FAIL，也不是 PASS。 |
| Android 真机 | **BLOCKED_EXTERNAL** | 未检测到获授权 Android 设备，ADB/scrcpy 不可用；没有真机或镜像会话、任务 ID、画面或用例结果。 |
| 官方自动化/云测 | **NOT_RUN** | 开发者工具的“工具→自动化测试”入口可打开；创建用例的次级模拟器报 `appServiceSDKScriptError timeout`，本轮取消后仅清理该弹窗自动生成的 `minitest/test.config.json` 和 `testRoot` 修改，主模拟器刷新恢复。未获得可核验的 MiniTest 云设备、额度、用例类型或任务 ID。试图在浏览器读取官方 MiniTest 页面时，自动安全审查明确拒绝访问并禁止换通道重试；本轮遵守该拒绝。 |
| 真实资金、支付与正式消息 | **NOT_RUN** | 合成订单保持 `pending_payment`；无真实支付界面、取消回跳、回调对账或资金闭环。受控客服/隐私消息只在本轮合成账号和本机服务中闭环，不代表真实用户或正式微信客服送达。 |
| GitHub 与发布 | **BLOCKED_EXTERNAL** | PR22 仍为草稿，远端 head `5ab4a00d4e71d8a9a2de14e31b64fca0bbe92e88`、base `5740e18544fa37dd473c36934a2a12a07a2d5ec9`；远端 `verify` 失败属于旧提交。既有 GitHub 写入安全拦截未解除，本轮不换渠道推送、不合并、不部署。 |

### 定向业务操作与断言

| 用例 | 实际操作及核验 | 范围 |
| --- | --- | --- |
| 商品管理 → 用户侧 | 在本轮自有合成 SKU 只改商品文字并保存；数据库 `image_path` 仍为 `/assets/cisme/synthetic-owned.jpg`、版本 5，列表/详情显示新名称。该旧路径按现有产品策略显示中性占位，**仅证明对象路径未被文字编辑覆盖，未证明原图像素呈现。** | P17；[40 路由包](../visual/review-closure-20260925-current/README.md)与读回 |
| 结算数量和订单 | 用户入口 2→1→2 后重新报价为 2 件 ¥538；3 件报价 ¥807、创建一笔 `pending_payment` 订单 ¥807。未付款。 | P17/A07；[2 件报价画面](screenshots/checkout-quantity2-quote.png)、[3 件订单画面](screenshots/order-detail-quantity3.png)、读回 |
| 售后/双向客服 | 从本轮合成已付夹具订单发起 2 件售后，生成 `requested` 工单 ¥538；会员发受控消息，管理员从现有客服工作台回复，会员重进能看到回复；两条消息均有数据库行。夹具的“已付”不是本轮真实付款。 | [客服回复画面](screenshots/support-member-reply.png)、读回 |
| 普通客服草稿 | 复现普通会话返回重进后未发送文字丢失；修复后同一路径输入恢复、发送可用。草稿未发送；只在同会话内存保留 10 分钟，不落设备持久存储。 | [恢复画面](screenshots/support-draft-restored.jpg)、`pages/support/index.ts` 与 `services/support-draft-handoff.ts` |
| 隐私申请 | 会员提交访问申请，管理员从现有隐私工作台要求补充，会员重进提交补充；状态 `reviewing`，回复与补充均持久化。 | P20/A11；[补充画面](screenshots/privacy-reply-supplement.png)、读回 |
| 护理 D14 | 用户按 00 净澈→01 清洁→02 修护→03 精护操作，提交“舒适轻盈”；记录页/详情重进可见，数据库四个步骤按序保存，感受 `comfortable`。 | P23/A20/CARE-01；[记录详情](screenshots/care-d14-detail.png)、读回 |
| 游客首页 | 退出后首页仍可见“授权身份并开始”，无 `onShow` 强制跳转。此模拟器随后出现会话状态恢复，未建立干净的游客客服/隐私可达性证明。 | P01；仅定向观察 |

配送与售后说明经过模拟器实际滚动到底并可读。未采集可用于分析帧率的原生时序/录屏，故不声称 60 FPS、软键盘或真机动画通过。普通/会员/管理员的完整越权深链、弱网恢复、快速重复写入和支付取消均未完成正常模式验收。

## 3. 问题、最小修复与本轮测试

发现普通客服页面仅在绑定订单时使用原有文本草稿交接；普通客服无订单作用域，因此返回即丢草稿。新增普通客服作用域，沿用原有的同会话、一次性、10 分钟内存交接；不复制图片和私聊到本地存储。未知发送结果也保留原客户端消息 ID 供幂等重试。改动文件：`apps/miniprogram/pages/support/index.ts`、`apps/miniprogram/services/support-draft-handoff.ts`、`tests/unit/support-draft-handoff.test.ts`。修复后在原生模拟器重新走返回/重进；5 个相关单测通过。

当前源码运行结果：`npm run typecheck` PASS；`npm test` 为 124 个测试文件、1435 PASS、1 SKIP；`npm run miniprogram:package-gate` PASS；`npm run miniprogram:route-audit` PASS（其全状态矩阵仍未完成）；40 帧包的 `shasum -a 256 -c SHA256SUMS` PASS。服务端无本轮源码改动；918 项隔离集成通过是上轮结果，不冒充本轮重跑。

## 4. 原始证据与校验

- [本轮定向证据索引](evidence-index.json)记录 6 张原始模拟器画面及数据库读回的 SHA-256、字节数和采集范围；[运行记录](runtime-observations.txt)记载本机 HTTPS 探测、物流守卫日志及清理；[SHA256SUMS](SHA256SUMS)可直接校验这些实际文件。无真机原图或录屏。
- [40 路由默认帧](../visual/review-closure-20260925-current/README.md)的每张原图关联路由、状态、工具与当前源码哈希；[接触表](../visual/review-closure-20260925-current/contact-sheets/healthy-routes.png)仅供快速浏览，原图在该包 `screenshots/raw/`。
- [当前源码验收清单](../visual/current-source-acceptance.json)明确区分模拟器路由基线与尚未完成的设备/状态矩阵；`review-r24-community-fixture-da564b98-20260925` 仍仅是旧源码历史证据。

## 5. 下一版复跑与设备接续

2026-09-26 修订：以下仅修正复跑命令与设备接续条件；第 1–4 节的历史执行结果和原图身份不变。当前用户没有本地手机，工程回归不以连接手机为前置条件。

本机隔离回归使用已有脚本。先确认 18080 空闲且没有另一个验收会话；一次只启动一个一次性环境。在服务前台运行期间另开终端执行捕获；退出时仅停止该次启动的父进程，由现有 disposable-test 包装器清理其 runId 资源。

```sh
cd /Users/mini/CISME
npm run miniprogram:acceptance -- --synthetic-community --synthetic-fulfillment
```

```sh
cd /Users/mini/CISME
review_id="closure-$(date -u +%Y%m%dT%H%M%SZ)-current"
npx tsx scripts/update-current-source-manifest.ts
CISME_WECHATIDE_CLIENT=cisme-closure npx tsx scripts/capture-miniprogram-review.ts "$review_id" --fixture tmp/miniprogram-acceptance/fixture.json
review_root=$(jq -r --arg id "$review_id" 'select(.reviewId == $id) | input_filename | sub("/source-manifest.json$"; "")' docs/evidence/visual/review-*/source-manifest.json)
test -n "$review_root"
test -f "$review_root/source-manifest.json"
npx tsx scripts/check-miniprogram-package.ts > tmp/miniprogram-acceptance/package-check.json
jq -e --arg id "$review_id" --arg sha "$(jq -r '.actual.sourceSha256' tmp/miniprogram-acceptance/package-check.json)" \
  '.reviewId == $id and .miniProgram.sourceSha256 == $sha and .capture.capturedRawScreenshots == .miniProgram.routes' \
  "$review_root/source-manifest.json"
route_count=$(($(wc -l < "$review_root/routes.csv") - 1))
image_count=$(find "$review_root/screenshots/raw" -maxdepth 1 -type f -name '*.png' | wc -l | tr -d ' ')
test "$route_count" -eq "$(jq -r '.miniProgram.routes' "$review_root/source-manifest.json")"
test "$image_count" -eq "$route_count"
(cd "$review_root" && shasum -a 256 -c SHA256SUMS)
npm run typecheck
npm test
npm run miniprogram:package-gate
npm run miniprogram:route-audit
```

真实设备接续先在**正常安全模式**证明 staging HTTPS、微信后台合法域名、现役 API/数据库隔离、当前源码预览/体验回执和真实微信登录；之后在开发者工具“真机调试”由获授权目标手机扫码，再以官方 automator 的 `remote()` 或已启动调试会话连接，记录设备/微信/基础库/候选版本并执行关键点按与服务端读回。若本地缺一端，只有在能核验现有授权、无新增费用且未被安全审查拒绝的官方云测入口，才提交该端的定向任务并记录任务 ID/设备/报告。本轮没有可验证的真机脚本运行或云任务，因此此处是接续步骤，不写成已验证命令。

没有获授权且可核验的实体设备或真实云设备时，iOS/Android 项分别保持 NOT_RUN，并记录缺少设备会话、候选映射和报告；本机模拟器结果照实单独交付。本轮不要求用户连接手机或登录 iCloud。后续任何支付、退款、正式消息或云测付费都需单独满足原有授权边界；原 MiniTest 安全拒绝未获有效处理前不通过其他通道重试。

若仅改本报告、索引或证据，先重新核对小程序有效输入哈希，保留已执行结果；若改页面/业务，重测受影响路径与共享链路；若改登录、网络、全局样式、路由、构建配置或基础库，扩大至真实影响范围。旧截图始终保留旧来源，不改名/改哈希冒充新执行。

## 6. 清理与同步边界

本轮隔离数据库、容器、包装器只按 runId `6a903e0c2dc0ac976949f5c2` 定向停止。包装器确认两个本轮容器被移除；随后按该 runId 查无容器、18080 无监听。未清微信个人数据、未关闭用户窗口、未删除其他容器。PR22/main/远端 staging 与生产均未因本轮测试而改变；正式发布门禁继续分开判断。

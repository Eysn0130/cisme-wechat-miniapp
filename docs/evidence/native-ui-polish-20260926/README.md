# PR22 本机原生 UI 精修与收口（2026-09-26）

本轮只在 `/Users/mini/CISME` 的 `codex/fulfillment-lifecycle-20260922` 接续。开始时 HEAD 为 `b39bda607baa8197c088d8ebd949fccf296ac066`、工作树干净，小程序有效输入为 `ed0d7d60b8e201a2d0f99213a107a5f7e5dd0631193ed4c31601624ce512ead7`。依据 [PRD V2.1 R4](../../product/CISME-产品需求文档-PRD-V2.1-R4.md) 的 P01、P17、P20、P23、A07、A11、A20、CARE-01。原生 WXML/WXSS/TypeScript、微信开发者工具主模拟器和本机一次性服务是本轮执行环境；没有手机、云真机、正式支付或远端写入。

## 交付状态

| 项目 | 本轮结果 |
| --- | --- |
| 源码与本地测试 | **PASS（列明范围）**：最终小程序有效输入 SHA-256 `e96dc0f6c375e952b153266b483d008a7d7807a9a20844286ca3987cbc99e990`，266 文件、40 路由、主包 525612 字节。`typecheck`、`build`、`npm test`（1436 通过、1 跳过）、`test:integration`（919 通过）、包门禁、路由审计通过。 |
| 按钮、文案、布局与状态 | **PASS（已执行问题与定向状态）**：修复单商品窄屏卡片、售后校验消息脱离按钮且轮询清空、客服附件面板误导标题、管理员自有合成图片说明。原生点按及同视口前后图见[逐项台账](issue-ledger.md)。没有把所有路由的所有状态标为通过。 |
| 当前源包默认路由 | **PASS（本机模拟器默认入口）**：[40 路由捕获包](../visual/review-closure-20260926-ui-polish-current/README.md)与 `source-manifest.json` 绑定上述哈希，390×844 原始帧 40/40，正常 38、预期守卫 2，采集窗口 Console/Network 过滤命中 0。默认帧不代替交互与真机验收。 |
| 业务读回 | **PASS（本机合成用例）**：[读回记录](business-readback.md)含原图实际加载与文字保存、结算 2→1→2/3 件报价、未付款订单、售后、客服草稿与唯一消息、隐私补充、D14 四步与感受。干净游客入口由旧 token 401 清理后实点客服与隐私入口，均引导登录；首页保留“授权身份并开始”。 |
| HTTPS | **未恢复，原因未判定**：[只读诊断](network-diagnostic.md)定位到本机代理/TUN 后、源站 HTTP 前的 TLS 路径；没有证据支持修改系统配置或归责 API。隔离 HTTP 模拟器通过不代表安全 HTTPS 预览通过。 |
| iOS / Android | **NOT_RUN / NOT_RUN**：本机没有获授权真实手机，亦无获允许且可核验的云真机任务；[设备与原安全拒绝](device-boundary.md)。361×804、390×844、430×932 都只是主模拟器逻辑视口。 |
| GitHub、体验版、发布 | **未执行**：PR22 原分支本地提交；既有 GitHub 写入安全拦截未解除，没有推送、合并、部署、预览上传、体验版、真实 `wx.login`、支付或退款。`design:qa:status` 为 `ok=true`、`releaseReady=false`，仍有完整状态矩阵与设备证据等发布缺口。 |

## 修复与证据范围

小程序唯一商品列表在窄屏从固定双列改为单行卡片；商品详情原生按钮、数量步进器、结算按钮的操作链保持原事件。售后面板的本地校验错误移到提交按钮附近，并在数据轮询后继续显示，直到用户修正输入；加载失败才提供“重试加载”。客服订单选择面板标题改成真实动作“关联订单”。精确放行**仅测试环境**的自生成 JPG；生产商品图片写入白名单未扩大，历史未授权 `/assets/cisme/` 素材继续隐藏。自有 JPG 的 SHA-256 为 `5c9871bc1ef2cca9292e02fb47097cde53823d4fe6a63bc69be99a70457ef348`，原生 `wx.getImageInfo` 读回 320×320。

原始逐项图及连续关键帧在 [screenshots](screenshots/)，每张的字节哈希、像素尺寸、逻辑视口与显示比例见 [evidence-index.json](evidence-index.json)；本轮目录可用 `shasum -a 256 -c SHA256SUMS` 校验。部分修前/中间帧来自从 `b39bda6` 持续修改的 dirty 工作树，索引明确标记，不冒充最终哈希。最终源码默认路由有独立的 [当前源包清单](../visual/review-closure-20260926-ui-polish-current/source-manifest.json) 与原图校验。原 2026-09-25 证据及哈希不改；其 [复跑说明](../native-device-closure-20260925/README.md)已改用当前捕获实际目录验证。

## 可复跑命令与清理

在工程根目录、18080 空闲且没有另一个验收会话时，第一终端运行：

```sh
cd /Users/mini/CISME
npm run miniprogram:acceptance -- --synthetic-community --synthetic-fulfillment
```

保持该终端运行，以其输出的 `tmp/miniprogram-acceptance/fixture.json` 为输入，在第二终端运行：

```sh
cd /Users/mini/CISME
review_id="closure-$(date -u +%Y%m%dT%H%M%SZ)-current"
npx tsx scripts/update-current-source-manifest.ts
CISME_WECHATIDE_CLIENT=cisme-closure npx tsx scripts/capture-miniprogram-review.ts "$review_id" --fixture tmp/miniprogram-acceptance/fixture.json
review_root=$(jq -r --arg id "$review_id" 'select(.reviewId == $id) | input_filename | sub("/source-manifest.json$"; "")' docs/evidence/visual/review-*/source-manifest.json)
test -n "$review_root" && test -f "$review_root/source-manifest.json"
npx tsx scripts/check-miniprogram-package.ts > tmp/miniprogram-acceptance/package-check.json
jq -e --arg id "$review_id" --arg sha "$(jq -r '.actual.sourceSha256' tmp/miniprogram-acceptance/package-check.json)" '.reviewId == $id and .miniProgram.sourceSha256 == $sha and .capture.capturedRawScreenshots == .miniProgram.routes' "$review_root/source-manifest.json"
route_count=$(($(wc -l < "$review_root/routes.csv") - 1))
image_count=$(find "$review_root/screenshots/raw" -maxdepth 1 -type f -name '*.png' | wc -l | tr -d ' ')
test "$route_count" -eq "$(jq -r '.miniProgram.routes' "$review_root/source-manifest.json")"
test "$image_count" -eq "$route_count"
(cd "$review_root" && shasum -a 256 -c SHA256SUMS)
npm run typecheck
npm test
npm run test:integration
npm run build
npm run miniprogram:package-gate
npm run miniprogram:route-audit
npm run design:qa:status
```

本轮两个一次性服务 runId 为 `519be460383d35107017021e` 和 `6e290c829b156a2a5e142172`；集成测试 runId 为 `70f52881805d2bff93c6d8eb`。每轮只停止自己的验收进程，让 `disposable-test` 按 runId 清理。当前三轮均已核对标签并清除相应 Postgres/S3 容器、临时对象目录，18080 无监听；没有删除其他容器或清微信个人数据。再次清理时先核对 `cisme.synthetic.run` 与 `cisme.synthetic.purpose` 标签及对象目录 `.ownership.json`，只针对本次 runId 操作。

# CISME 聊天底部 Composer 精修与验收

范围只含原生微信小程序会员客服与人工客服聊天页底部输入区；PRD 基线是 `docs/product/CISME-产品需求文档-PRD-V2.1-R4.md`，商业客服补充交互以 `docs/product/reference/support/CISME-COMMERCIAL-CHAT-UX-CONTRACT.md` 的 Composer 条款为准。

## 结果

旧版会员是独立“+”圆键、单行输入和框外“发送”；客服端也是小输入框加框外文字发送。改后会员在一个 Plum/pearl 大圆角 Composer 右下角依次放图片、回形针、发送三个同系 SVG；客服端因现有 operator API 只允许文字，保留同一 Composer 与 SVG 发送键，不显示不可工作的图片/文件假入口。空白默认约三行，高于三行向上生长，六行后保持上限并在 textarea 内滚动。输入文字的底部预留与绝对定位的工具列分离，长文不会压到图标。30 条消息时，会话滚动条在 484px 模拟器上距右缘约 4–6px，正文右侧留白仍保持。

布局仍保留已有微信原生安全区、胶囊避让、`scroll-view` 历史锚点和本地实际测量 Composer 高度的机制；没有用新的固定 bottom 数值猜每次 textarea 高度。图片入口只给相册/拍照；回形针只给当前会员本人订单，发送时由服务端复验。空白或空格不可发，准备完成的图片/订单可发，图片上传失败时即使文字存在也不允许键盘确认绕过禁用状态。服务端确认后清正文与附件预览、恢复三行及禁用发送；失败时保留草稿与重试路径。离页时清 focus/键盘状态，既有上传中断、轮询、消息同步逻辑不变。

设计决策顺序：`mobile-ui-ux-designer` 决定默认高度、入口语义、多行/上限/中断恢复；`design-taste-frontend` 收敛 Plum/pearl/lilac 的边框、圆角、间距、图标线宽和低重量层级；`miniprogram-development` 以原生 textarea、`linechange`、`adjust-position`、安全区与微信开发者工具结果裁决实现。视觉 Skill 没有改写业务附件权限。

## 原生前后图

| | 改前（源码 `005f03d4…`） | 改后（源码 `a7a92a2b…`） |
| --- | --- | --- |
| 会员默认 | [独立 +、单行框、框外发送](visual/review-commercial-chat-005f03d4-20260912t0508cst/screenshots/raw/pages__support__index.png) | [统一三行、三 SVG、右侧细滚动条](support-composer-2026-09-12/screenshots/01-empty-disabled-safe-area.png) |
| 多行 | [旧版多行](support-commercial-chat-2026-09-12/screenshots/14-member-multiline-composer.png) | [六行](support-composer-2026-09-12/screenshots/04-six-lines-expanded.png) · [八行封顶](support-composer-2026-09-12/screenshots/05-eight-lines-internal-scroll.png) |
| 客服端 | [小框与外部发送](visual/review-commercial-chat-005f03d4-20260912t0508cst/screenshots/raw/pages__management-support-chat__index.png) | [统一 Composer](support-composer-2026-09-12/screenshots/14-admin-empty.png) · [八行封顶](support-composer-2026-09-12/screenshots/16-admin-eight-lines-capped.png) |

[16 张当前源码原生图总览](support-composer-2026-09-12/contact-sheet.png)；逐张权限、哈希和观察状态见 [证据清单](support-composer-2026-09-12/README.md)。重点可直接查看 [图片入口](support-composer-2026-09-12/screenshots/08-image-entry-sheet.png)、[回形针入口](support-composer-2026-09-12/screenshots/09-attachment-entry-sheet.png)、[本人订单选择](support-composer-2026-09-12/screenshots/10-owned-order-picker.png)、[发送前](support-composer-2026-09-12/screenshots/11-order-draft-send-active.png)、[确认后复位](support-composer-2026-09-12/screenshots/12-send-ack-reset.png) 与 [长会话靠边滚动条](support-composer-2026-09-12/screenshots/13-thread-scrollbar-near-edge.png)。

## 修改与验证

修改会员及客服页各自的 `index.wxml`/`index.wxss`/`index.ts`，四个 `assets/icons/composer-*.svg`，商业客服 Composer 契约，单元测试及当前源码原生捕获脚本/证据。没有改 API、数据库迁移、支付或聊天主流程。

- `npm run typecheck`：通过。
- `npm test`：41 文件、301 项通过，含 3/6/7 行、禁用/激活、服务端确认后复位、失败图片键盘确认不可绕过。
- `npm run test:integration`：23 文件、108 项通过。
- `npm run lint:contracts`：35 个迁移、73 张表、81 条路径、27 个事件一致。
- `npm run miniprogram:package-gate`：208 文件、27 路由、主包 1,365,617B、总包 1,826,561B，通过；当前源码 SHA-256 `a7a92a2b41ef6a2efcdf3e22401ccfc28152b54604e404f5023472bc7cc6f855`。
- 当前源码微信开发者工具健康图：27/27 路由 `PASS_LOCAL_SYNTHETIC`，目标控制台错误/网络失败匹配 0；但 `design:qa:status` 为结构通过、`releaseReady=false`，全状态矩阵及物理设备证据仍未齐。

`UNVERIFIED`：iOS/Android 物理真机键盘与候选栏、系统大字体、不同机型安全区、系统相册/相机选取及真实图片上传操作。第 07 张只注入 300px 键盘高度与 focus 呈现状态，**不是软键盘截图**。本轮没有正式小程序上传、体验版、生产数据或真实支付。

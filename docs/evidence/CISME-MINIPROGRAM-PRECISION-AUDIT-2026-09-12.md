# CISME 小程序第二轮 Precision Audit

审计先于施工。基线小程序包 SHA-256：`4e551cc6c41528a052af595e4ae48d569b9b17345a30db5a40bf2f1aec69175b`；`app.json` 为 27 条路由。截图来自 `docs/evidence/visual/review-ui-ux-4e551cc6-20260912t1735/`，包括 27 页默认健康帧、Composer 16 状态和重点页前后图；不是本轮修改后证据。产品边界按 PRD V2.1 R4 §6.1/§6.3.1 与根目录 AGENTS.md。验证范围仅为微信开发者工具模拟器和源码；真机与系统键盘仍未验。

## 自动统计与现有层级

扫描 `apps/miniprogram` 的 30 个 WXSS：`font-size` 444 处/40 种值，`font-weight` 97 处/3 种，`line-height` 246 处/26 种，`letter-spacing` 35 处/12 种，`color` 475 处/236 种；`padding` 246 处/133 种，`gap` 139 处/25 种，`border-radius` 242 处/52 种。字色数量包含 RGBA 和状态变体，不能直接等同 236 个设计 token。常见字号为 small token 95、24rpx 50、22rpx 34、20rpx 33、23rpx 30；行高以 1.5 为主（79），其次 1.55（26）、1.4（25）。间距常见 gap 14rpx（24）、12rpx（17）、16rpx（16）、20rpx（15）。完整统计方式：去 WXSS 注释后按属性声明计数，不推断覆盖后的计算样式。

| 语义 | 当前主要来源 | 审计判断 |
|---|---|---|
| Page / Navigation title | `.page-title` 46rpx Songti；`.topbar__title` 21px，客服 17px | 保留品牌展示与原生导航区分；客服长名截断要守住胶囊安全区 |
| Section / Card title | 各页 29–34rpx，常用 500 weight | 页面密度不同，不统一替换 |
| Body / Input | body 14px；两端 Composer 28rpx/40rpx 行高 | 中文输入可读；底部操作区由 104rpx padding 隔开 |
| Secondary / Caption / Metadata / Status | small 12px；micro 11px；局部 20–23rpx | micro 只留真正次要元数据；AI 可用状态、失败与操作说明不可低透明度处理 |
| Button | action 16px/20px 行高；多数普通 CTA 50px；最低触控 44px | `.primary/.secondary` 已 flex 居中；其他语义按钮逐项核对，不能全局加偏移 |
| Placeholder | 两端 Composer `#918596` | 截图偏淡，需与禁用态分离并提高可读性 |

## Button family 与共享根因

| Family | 当前几何/文字 | Disabled / pressed / loading | 本轮裁决 |
|---|---|---|---|
| Primary / Secondary / Bottom CTA | 全局 flex 双轴居中，50px，24rpx 水平 padding，16px/20px，pill；局部 `care-cta` 特例 | `.primary--disabled` 与业务 single-flight；微信 button loading | 商品详情截图的主按钮光学中心可接受，保留 1px `.action-label` 组件级补偿，不撒页面 magic number |
| Text / Inline / destructive | `.text-button` 44px；页面局部文字动作 | 需保留文字原因与确认 | 不全局改高；逐个看操作语义 |
| Icon / navigation | `.topbar__back`、Composer 工具 44px；SVG 本体 18/22px | 控件有 pressed 色/轻微缩放 | 触控与图标视觉尺寸分离，暂不改 SVG viewBox，缺少实测偏心证据 |
| Sheet tile / cancel | tile flex 居中；cancel 只有原生 button 行盒 | Sheet 蒙层/进入动画存在 | 将 cancel 改为真实双轴居中，保持既有圆角/高度 |
| Attachment remove | 图片/订单卡移除键 40px | 仅文字 ×；WXML 有 aria-label | 提升为 44px 并 flex 居中，不增大视觉图标 |
| Admin resolve | 文字链接 44px，截图中孤立且很淡 | TS 已有确认 Modal 与失败恢复 | 改为克制的 Secondary Action；草稿非空时确认文案明确会清除 |

## Precision 问题矩阵（先定位，再修）

| ID / 优先级 | 截图 + 源码事实 | 根因与影响 | Fix / 验证 |
|---|---|---|---|
| P-01 U1 Sheet cancel | Composer `08-image-entry-sheet.png`：取消文字视觉靠上；`.support-sheet__cancel` 未设 flex | 原生 button 内容行盒依赖默认排版，和 tile 的 flex 对齐不一致 | 仅 Sheet cancel 双轴居中；原生打开图片/附件/订单 Sheet 重截 |
| P-02 U1 Attachment close | `11-order-draft-send-active.png` 的订单卡右侧 × 很小；两个草稿卡移除键 40px | 触控面积低于当前 44px 基线 | 调到 44px、保持卡片网格和输入区边界；重截关联订单/图片 |
| P-03 U1 Placeholder | `01-empty-disabled-safe-area.png`、`14-admin-empty.png` 输入提示偏淡；`#918596` | 与 disabled 视觉相近，降低输入可发现性 | 两端改用既有 muted 色；重截空/聚焦/长文 |
| P-04 U1 Admin AI/resolve | `14-admin-empty.png` 中“AI 建议未接入”几乎看不清，helper 与孤立“标记已解决”层级不清 | 不可用 AI 被当成 disabled button；结束会话其实是需确认的流程操作 | 未接入时改可读状态标签；helper 清晰表达只写草稿；resolve 变 Secondary Action；原生重截空/长文/发送 |
| P-05 U1 Admin unsent draft | `resolve()` 确认后清空 `input`；原 Modal 仅告知会话历史保留 | 未发送草稿丢失风险未被说明 | 草稿非空时确认文字提示会清除；单测和交互复核 |
| P-06 U2 Header | Admin 截图 `CISME 验收会员…` 已省略，未撞胶囊，副标题稳定 | 需要短/长名与窄屏验证，不能把合理 ellipsis 判为缺陷 | 先保留结构；做当前包原生长名/窄屏复核后才决定代码改动 |
| P-07 U2 Composer action zone | 0/1/3/6/8 行与长 CJK 原截图中工具在右下，104rpx 底内边距隔开文本 | 当前无覆盖证据；不以想象改 padding 或 SVG | 保留结构；修改其他属性后完整 16 状态重新捕获 |
| P-09 U1 Management button root | 当前原生商品管理截图中「新建商品」文字贴上沿；管理列表/商品表单 4 个按钮使用 `primary-button`/`secondary-button`，但全小程序无对应 WXSS 定义 | 回退为原生 button 排版，主次操作的几何、字色与品牌层级均失联 | 改用全局 `.primary/.secondary`，保留 catalog 按钮的局部宽度并清除外边距；重截商品管理与商品编辑表单 |
| P-10 U1 Management inline button alignment | 商品编辑表单滚动后，资质确认与上下架的 row 按钮文字贴上沿；`.button-row button` 和冲突处理按钮只设 flex 宽度，未设内容居中 | 原生按钮内部行盒与高触控区分离，形成同页主次按钮对齐不一致 | 在两组同语义操作按钮内使用 flex 双轴居中与 44px 触控底线；重截商品编辑表单下半屏 |
| P-11 U1 Admin header safe lane | 开发者工具实际 rect：长标题右缘 261px，「···」按钮左缘 246px，重叠约 15px；胶囊左缘 296px | `.topbar` 按页面中心对齐，未把额外的管理操作键计入标题安全区 | 仅管理客服头部改为返回键与更多键之间的安全通道居中；重测 rect 与原生截图，确保副标题限宽和省略稳定 |
| P-08 U2 Metadata/card density | 多页 meta 20–23rpx，卡片数与页面目的相关；默认帧无统一失控 | 粗暴全局字号/卡片替换会破坏语义与包预算 | 不全局替换；只针对实测过淡状态改 |

## 交互合同与验收

- Sheet：Trigger 打开图片/附件/订单 → Rules 只显示适用动作 → Feedback 原生 Sheet + 有效可点击区 → Loops 取消、选择、重开均保留草稿。未测真机键盘时不宣称通过。
- Composer：Trigger 输入/关联 → Rules 0/1/3/6/8 行增长后封顶内滚，长文不进底部操作区 → Feedback send disabled/active、发送后清空 → Loops 失败保留草稿。重采 16 状态。
- 管理结束：Trigger 点击 Secondary Action → Rules 已接管且非 busy，非空草稿需告知丢失 → Feedback 微信确认 Modal、服务端状态 → Loops 取消保留、失败可刷新。已有 Modal 保留。

本轮不改品牌主色、导航结构、订单/护理状态机、Compose 布局模式或 SVG 源路径。后续必须按新 source hash 重采原生截图；旧图仅用于 BEFORE。

## 施工结论与最终源码

最终小程序源码 SHA-256：`72a6a61d3ad3411ac86b44c00dd511cc4deaf54e9573af311deafde6fb9082e8`。本轮持续在现有 `/Users/mini/CISME` 工作树上编辑，没有重置用户工作或建立新产品目录。源码改动集中在已有 WXML/WXSS/TypeScript 与边界测试；不改变 PRD R4 §6.1/§6.3.1 的游客首页、护理顺序或订单/客服业务状态。

| Owner 项 | 最终裁决 |
|---|---|
| A. Shared root | 管理商品的四处按钮沿用了无定义的 `primary-button`/`secondary-button`，导致原生 button 回退样式；改接现有 `.primary/.secondary`。复测发现两个 Primary 禁用态仍用旧 `control--disabled`，已接入 `.primary--disabled`。其他 Primary/Bottom CTA 的共享 flex 根已有正确居中，不加页面级位移。 |
| B. Button | 「新建商品」「保存商品」恢复品牌层级和双轴居中；商品资质/发布状态行内按钮用 flex 双轴居中并维持至少 44px 触控区；Sheet「取消」用 flex 居中；管理客服「标记已解决」变成克制的 Secondary Action。 |
| C. Typography | 保留 Page Title、Navigation Title、Section/Card Title、Body/Input、Caption/Metadata 的现有语义差异。将两端 Composer placeholder 改为现有 muted token；未接入的 AI 改为可读状态文字，管理端 helper 明确人工确认发送。未全局放大 20–30rpx 或把全部 micro 改为正文。 |
| D. Spacing | 保留不同页面的实际内容密度与 14/12/16/20rpx 等历史间距，不作机械归一。仅扩大附件卡 × 到 44px、调整管理客服头部标题安全通道；Composer 文本区与右下工具区沿用已验证布局。 |
| E. Icon/SVG | 静态复核 47 个 SVG，42 个 256×256 填充图标、5 个 24×24 线性 Composer 图标，均有 viewBox。截图未提供稳定的图标光学偏心证据，因此没有改 SVG 路径、stroke 或做无依据的 offset；44px 控件命中区与 18–22px 图标本体继续分离。 |
| F. Composer | 保留空/1/3/6/8 行增长、上限内滚、长 CJK、图片/附件/订单关联、发送与复位结构。修改 placeholder 可读性与草稿卡移除命中区；完整 16 状态按最终哈希重新采集。`07-keyboard-inset-fixture` 是模拟 inset，不等于系统软键盘真机通过。 |
| G. Bottom Sheet | 图片、附件、订单选择的既有因果流程和 tile 排版保留；「取消」改为真实双轴居中，空白区、安全区在原生模拟器截图中复核。系统相机/相册、真机关闭动画未验。 |
| H. Admin Composer | AI 未接入从淡化按钮改为明确状态；helper、输入、发送、结束会话分层。结束会话前继续使用确认 Modal；有未发送草稿时文案明确提示会清除，取消分支保留草稿与 `human_active`。标题在 393 CSS px 模拟器上右缘 217.37px，更多按钮左缘 246px，约 28.63px 空隙；胶囊左缘 296px。 |
| I. 保留不改 | 不改商品 CTA 已有 1px 组件级光学校正、SVG、全局卡片数量、Composer 结构、动效时长和品牌 Plum/Pearl。它们没有本轮原生证据支持大范围更动；部分复杂状态继续列为未验。 |

### 截图与 before/after

最终证据目录：`docs/evidence/visual/review-precision-72a6a61d-20260912t1922/`。`source-manifest.json`、`composer-current/visual-evidence-manifest.json`、`precision-evidence-manifest.json` 与 `SHA256SUMS` 均需核对同一包哈希；27 张 `screenshots/raw/` 和 16 张 `composer-current/screenshots/` 是原始帧。`contact-sheets/` 的八张图为导航索引：全部路由、按钮、Typography、Composer、Bottom Sheet、管理 Composer、Before/After，以及商品行内按钮单独对照。Before 来源分别标明 `4e551c…` 基线或 `c8eaee…` 早期管理商品表单；`144564…` 和 `228edd…` 两包只能称中间证据。合成 fixture 的时间、消息与 ID 会变，不能把数据差异当成像素改善。

### 五视角 Reviewer Pass

| 视角 | 复核结论 | 仍扣分之处 |
|---|---|---|
| A 移动 UX | 44px 删除/导航与主次动作层级更明确；管理头部安全通道可量测 | 真机单手触控、系统大字、读屏未验 |
| B Interaction | Sheet、Composer 与 resolve 的 Trigger → Rules → Feedback → Loops 保持闭合；取消 resolve 不丢草稿 | 系统 Modal 未被截图桥绘入，确认后的服务端失败路径未做本轮视觉帧 |
| C 第二 UX 复核 | Placeholder、AI 状态、管理 helper 从 disabled 感中分离；未扩大无证据的全局排版 | 元信息与局部紧密表单仍需真机可读性检查 |
| D Visual QA | 按哈希复拍 27 路由与 16 Composer、保留原图和来源，表单行内按钮截图确认光学居中 | 顶沿偶发文字透出仍见于模拟器截图；小屏/多字体矩阵不完整 |
| E 微信原生 | WXML/WXSS/TypeScript、原生 button/Sheet/textarea 和小程序包预算通过；没有引入 Web 实现 | iOS/Android 系统键盘、相册/相机、胶囊差异需要获授权真机复核 |

这是当前施工者按五个视角的独立复核步骤，**不是五位外部人员或五个独立代理的结论**。视觉意见服从 PRD、微信原生平台与实际运行帧。

### 回归与分数

最终回归：typecheck PASS；unit `302/302`；integration `108/108`；native boundary `10/10`；contract lint `35 migrations / 73 tables / 81 paths / 27 events`；build PASS；小程序 package gate PASS（208 files、27 routes、global WXSS 8137/8192 bytes）；`git diff --check` PASS。`design:qa:status` 为 `ok=true`、`releaseReady=false`，因为完整状态矩阵、iOS/Android 设备证据与开放 U0/U1 尚未达到发布门禁。定向 `vitest` 命令需排除历史 `dist/**` 交付快照；误包含旧快照的那次运行不是当前源码的失败，按仓库正式命令及定向排除重跑均通过。

| 指标 | 第一轮 → 本轮 /10 | 当前扣分依据 |
|---|---:|---|
| Typography | 7.0 → 7.2 | 提示与管理状态更易辨，系统大字/真实 Android 字体未验 |
| Spacing | 7.2 → 7.3 | 头部与触控区改善，跨宽度/长地址仍未齐验 |
| Icons | 7.5 → 7.5 | 静态 viewBox 和现有截图无改动依据，失效态及真机光学复核未全 |
| Touch & interaction | 7.0 → 7.3 | × 达 44px，重要动作与取消回路更清楚；完整手势/键盘未齐 |
| Button feedback | 6.7 → 7.2 | 管理 Primary/Secondary 与禁用态归根；全路由 pressed/loading 未逐个截图 |
| Forms | 6.4 → 6.6 | 管理操作与 Composer 状态更清楚；真实键盘/错误长文未齐 |
| Navigation | 7.3 → 7.4 | 管理长标题安全通道有实际 rect；其他机型胶囊未验 |
| Overall product polish | **6.8 → 6.9** | 默认成功态精度提升，但完整状态、真机与发布组能力仍构成主要扣分 |

**VERIFIED**：最终哈希下本地合成 API、已登录微信开发者工具的 27/27 默认健康路由、16/16 Composer 状态、管理商品下半屏按钮、管理标题 rect 与 resolve 取消分支，及上述源码回归门禁。**UNVERIFIED**：正式 API/账号/域名与体验版、真机 iOS/Android、系统软键盘和字体缩放、相机/相册、弱网、全部 loading/empty/error/offline/permission/按压状态、Modal 的实际系统绘制及正式支付/履约。不得将本轮健康帧升格为这些状态的通过记录。

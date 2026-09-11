# CISME 原生微信小程序 Design QA

复核日期：2026-09-10  
对象：`apps/miniprogram` 原生 WXML/WXSS/TypeScript 运行层  
视觉真值：冻结 Web 原型与已确认参考图；Web 代码不作为生产实现  
签字规则：只有同设备、同状态、同文案、同裁切比较通过，且真实 iOS/Android 证据齐全，结果才可为 `passed`

## 当前结论

2026-09-11：当前原生包 SHA-256 为 `7f5fad5fe84c122a28a9c54234690515a64c09cf86a666daced4ba635672957d`，199 files / 27 routes / 1,707,657 bytes。R1/R2 在同一小程序中提供客服、条件化管理中心、客服队列和人工处理页；R4-A 提供商品管理，R4-B 又增加结算、本人订单及只读脱敏订单管理共 5 条原生路由。首次 current-source 截图暴露的不是“页面慢”，而是 DevTools 指向 `127.0.0.1:18080` 时没有 listener，唯一的 `3100` API 又连接旧 `cisme` 库且订单 gate 关闭；同时 protected routes 没有 session。现已用 loopback-only `cisme_test` schema 34 验收服务修复环境，以 Account 页显式本地夹具同意/登录完成真实 `/v1/identity/dev` 会话，未注入 token；27/27 route-specific success state 均在 4 秒稳定窗后满足 current route、`loading=false`、page error 为空，console/network 有界过滤 0 命中。健康 Review Pack 为 `docs/evidence/visual/review-commercial-r4b-healthy-7f5fad5f-20260911T202609+0800`，含 27 张 482×1044 原生模拟器帧和 contact sheet。current-source manifest 仍保持 `blocked`，因为完整逐状态/交互/响应式矩阵及 iOS/Android 当前源码证据尚未完成。

2026-09-08：验收主体为原生微信小程序，优先检查微信端展示页面。Web 是视觉参考，不能替代小程序验收。用户后续明确接受的精修同步进入原生页面。

完整 route/state matrix 与 iOS/Android 设备验收仍未完成，整体为 `blocked`。

本轮原生社区双列、回复/审核计数/持久化、图片预览和导航已进行局部实测，见 `docs/evidence/visual/community-app-2026-09-08/verification.md`。DevTools RC 内部图片预览报错仍待与真机区分；不宣称当前控制台全程无错。原生商品自动轮播、箭头停止和新进入后直接手势停止均已实测；手势后 31 秒仍保持原图。详见 `docs/evidence/visual/native-pages-2026-09-08/verification.md`。94 项单元测试与类型检查通过，不扩大为视觉验收。

下表中的旧截图均未绑定当前 `7f5fad5fe84c…` 源码；`2be680bf…` 的四张诊断图及其他旧哈希证据都只作历史诊断。当前健康 Review Pack 的 27 张帧是单独、源码绑定的本地合成 success baseline，但录屏仍为 0，也不能替代交互矩阵、团队体验版或真机。正式账号、合法域名、法律文本和体验成员等条件仍需独立证明。

此前 b0b1c7c8 的 4 页、6 个状态截图清单已归档为 `acceptance-b0b1c7c8.json`；投稿与进度页的 2 张不可访问状态截图也只绑定历史哈希，详见 `docs/evidence/visual/native-pages-2026-09-08/verification.md`。当前哈希不继承旧图，这些记录不改变完整矩阵与发布验收的 `blocked` 结论。

## 视觉真值与本轮证据

| 证据 | 视口/像素 | 状态 | 可用于 |
|---|---|---|---|
| `docs/evidence/visual/review-commercial-r4b-healthy-7f5fad5f-20260911T202609+0800/screenshots/raw/*.png`、`contact-sheets/healthy-routes.png`、`route-runtime-health.json` | WeChat DevTools 0.3.9；27 × 482×1044 | 当前 `7f5fad…`；loopback `cisme_test` schema 34；已登录 synthetic member/capability；动态详情使用精确 fixture id | 当前源码 27/27 运行健康与 success-state 视觉基线；不是正式登录、交互、同状态 Web 比较或 iOS/Android pass |
| `docs/evidence/visual/profile-settings-records-audit-2026-09-10/current/04-records-empty-after.png` | Stable 2.02.2608070 全窗口；2724×1690 | 历史 `2be680bf…` / Records empty | 空态下一步、刷新与同步时间的历史视觉诊断；不继承当前源码 |
| `docs/evidence/visual/profile-settings-records-audit-2026-09-10/current/05-profile-after.png`、`06-settings-after.png` | 同一历史源码会话 | Profile default / Settings collapsed | 会员主任务层级、Settings 原生分组与互斥展开入口；不继承当前源码 |
| `docs/evidence/visual/profile-settings-records-audit-2026-09-10/current/07-address-form-after.png` | Stable 全窗口；2724×1690 | 历史 `2be680bf…` / Settings address editor | 地址表单首屏与错误恢复文案的历史诊断；不继承当前源码 |
| `docs/evidence/visual/system-audit-2026-09-10/devtools-14226538-compile-window.png` | Stable 2.02.2608070 全窗口；2636×1602 | 历史 `14226538…` / Profile default | 历史普通编译后 Build `analyzing codes success`、Problems 0；不继承当前源码 |
| `docs/evidence/visual/system-audit-2026-09-10/12-14226538-profile-transaction-closed-console-clean-window.png` | Stable 全窗口；iPhone 15 Pro Max simulator @56%；2724×1690 | 历史 `14226538…` / Profile default | 历史有界 Console 0 error / 0 warning、Problems 0 与交易关闭提示；不继承当前源码 |
| `docs/evidence/visual/system-audit-2026-09-10/09-14226538-home-console-clean-window.png`、`10-14226538-records-empty-console-clean-window.png`、`11-14226538-community-gated-console-clean-window.png` | 同一历史源码会话 | Home 日常护理、Records 空周期、Community 精选/审核门禁 | 历史默认态诊断；未形成同状态 Web/原生/比较三联图，不计矩阵 passed |
| `docs/evidence/visual/records-audit-2026-09-10/03-native-no-cycle-after.jpg` | Stable 2.02.2608070 全窗口；iPhone 15 Pro Max simulator @56% | 历史 `7a46ce3e…` / Records empty | 历史空周期首屏、页面路径、清空后 Console 0 error / 0 warning 与 Problems 0；不继承当前源码 |
| `docs/evidence/visual/motion-continuity-audit-2026-09-10/07-final-care-modal.jpg` | Stable 2.02.2608070 全窗口；iPhone 15 Pro Max simulator @56% | 历史 `9b02e9bf…` / DAILY CARE modal | 弹层终态、底部导航完整下沉；AX 树背景首页已移除；不继承当前源码 |
| `docs/evidence/visual/motion-continuity-audit-2026-09-10/08-final-community-tabs-fab.jpg` | 同一历史源码会话 | Community default | 发布按钮终态、分类标签组/选中态；静态图不冒充逐帧或当前源码证据 |
| `docs/evidence/visual/motion-continuity-audit-2026-09-10/09-final-console-clean.jpg` | 同一历史源码会话 | Console cleared | 历史有界 Errors 0 / Warnings 0、Problems 0；不继承当前源码 |
| `docs/evidence/visual/current-run/native/devtools-package-405ae15c-compile-0-problems-2026-09-01.jpg` | RC 2.02.2608031 全窗口；基础库 2.32.3 | 历史 `405ae15c…` | 历史 Problems 0；不继承当前源码 |
| `docs/evidence/visual/current-run/native/devtools-package-405ae15c-console-0-errors-0-warnings-2026-09-01.jpg` | 同一会话最终编译后的稳定 Debugger 面板 | AX Errors 0 / Warnings 0；Problems 0 | 当前稳定窗口 Console 门禁；不扩大为 Network 或此前交互历史清洁 |
| `docs/evidence/visual/current-run/native/devtools-community-405ae15c-brand-editorial-2026-09-01.jpg` | RC 全窗口；iPhone X @50% | 品牌精选、UGC gate off、本地 API经临时隧道可达 | 当前 Community diagnostic；非 exact page-frame/同状态 Web comparison，不能 passed |
| `docs/evidence/visual/current-run/native/devtools-ios-405ae15c-remote-4g-connected-2026-09-01.jpg` | DevTools 真机连接窗口 1024×733 | iPhone 17 Pro Max / iOS 26.5.2 / 微信 8.0.76 / 4G；服务正常但 Android profile mismatch | 当前远程传输 diagnostic；未捕获业务请求/handset page-frame/route，不计 iOS pass |
| `docs/evidence/visual/current-run/native/devtools-package-857110dd-*` | 历史 RC 会话 | 历史 Account unchecked compact-height | 50px 动作与协议入口修复轨迹；不继承当前 hash |
| `docs/evidence/visual/current-run/native/devtools-package-18672702-*` | 历史 RC 会话 | 历史 Progress submitted/needs_changes/Back/button checkpoint | 已被 Account 源码修正取代；只作历史轨迹，不继承当前 hash |
| `docs/evidence/visual/current-run/native/devtools-package-6857791b-*` | 历史 RC 会话 | 历史 36 项全路由诊断 | 已被 Progress Back/button 源码修复取代；只作历史轨迹，不继承当前 hash |
| `docs/evidence/visual/current-run/native/devtools-package-85b8077f-*` | 历史 RC 会话 | 历史 `85b8077f…` 五项诊断 | 已被当前 Back/并发鉴权修复取代，不继承当前 hash |
| `docs/evidence/visual/current-run/native/devtools-package-703377ee-*` / `account-unchecked-703377ee-iphonex-100pct-664x1434-2026-08-30.png` | 历史 RC 会话 | 历史 `703377ee…` 未勾协议 | 仅修复轨迹；664×1434 图含外侧细条，不继承当前 hash |
| `docs/evidence/visual/current-run/native/devtools-package-ecd59318-compile-0-problems-2026-08-16.jpg` | 历史 Stable 2.01.2510290 全窗口 | 历史 `ecd59318…` | 仅历史定位；不继承当前 hash |
| `docs/evidence/visual/current-run/native/devtools-package-ecd59318-console-0-errors-warnings-3-2026-08-16.jpg` | 历史 Stable 会话 | 历史 0 error / 3 warning | 仅历史定位；不继承当前 hash |
| `docs/evidence/visual/current-run/native/devtools-package-ecd59318-account-unchecked-button-baseline-2026-08-16.jpg` / `account-unchecked-ecd59318-375x812-2x-2026-08-16.png` / comparison | 历史 iPhone X 375×812 | 历史未勾协议 | 修复轨迹；同一 raw 与后续 3f 文件字节一致，不能绑定当前源码 |
| `docs/evidence/visual/current-run/native/devtools-package-d68a641e-*` | 历史 Stable 全窗口 | 历史 `d68a641e…` Account 检查点 | 仅历史定位；不继承当前 hash |
| `docs/evidence/visual/current-run/native/devtools-package-64561172-compile-0-project-errors-0-problems-2026-08-15.jpg` 及 `devtools-package-64561172-*` | Stable 历史会话 | 历史 13 模块 public/no-session checkpoint | 仅历史定位；不继承当前 hash |
| `docs/evidence/visual/current-run/native/account-unlogged-64561172-375x812-2x-2026-08-15.png` / `comparisons/account-unlogged-64561172-web-vs-native-375x812.png` | 历史 iPhone X 375×812 | 未同意、CTA disabled | 历史几何诊断；copy/state mismatch，不继承当前源码 |
| `docs/evidence/visual/current-run/native/community-public-64561172-375x812-2x-2026-08-15.png` / `comparisons/community-brand-editorial-64561172-web-vs-native-375x812.png` | 历史 iPhone X 375×812 | 公开品牌精选 / 人工审核 | 历史孤字修复定位；生产语义与冻结 UGC 不同，不能 passed |
| `docs/evidence/visual/current-run/native/devtools-package-8b593ce9-compile-0-project-errors-2-system-warnings-2026-08-15.jpg` | Stable 2.01.2510290 全窗口；运行时 `touristappid` | 历史 `8b593ce9…` / account | 历史编译 Project Errors 0 / Problems 0；2 条工具/基础库 warning；不继承当前 hash |
| `docs/evidence/visual/current-run/native/account-unlogged-8b593ce9-375x812-2x-2026-08-15.png` | iPhone X 375×812；原始 750×1624 | 未同意、CTA disabled、phone capability 关闭 | 历史 Account 原始帧；确认禁用主 CTA P1 修复；法律同意未代点 |
| `docs/evidence/visual/current-run/comparisons/account-unlogged-8b593ce9-web-vs-native-375x812.png` | 左右 375×812；native 由 2×机械降采样 | route/未同意一致；phone copy/state 按生产范围不同 | 历史 disabled CTA 复测与几何诊断；copy/state mismatch，不能 passed |
| `docs/evidence/visual/current-run/native/community-brand-editorial-8b593ce9-375x812-2x-2026-08-15.png` | iPhone X 375×812；原始 750×1624 | 公开品牌精选 / 人工审核 | 历史 Community 原始帧；其标题孤字 finding 已驱动后续源码修复 |
| `docs/evidence/visual/current-run/comparisons/community-brand-editorial-8b593ce9-web-vs-native-375x812.png` | 左右 375×812；native 由 2×机械降采样 | route/layout 一致；Web UGC vs native 品牌精选 | 历史 hero `9 + 1` 孤字 P1 finding；产品语义不同，不能 passed |
| `docs/evidence/visual/current-run/native/devtools-package-9e536f82-compile-0-project-errors-3-system-warnings-2026-08-15.png` | Stable 2.01.2510290 全窗口；运行时 `touristappid` | 历史 `9e536f82…` / account entry | 历史编译 Project Errors 0 / Problems 0；不继承当前 hash |
| `docs/evidence/visual/current-run/native/devtools-package-9e536f82-console-cleared-0-error-0-warning-2026-08-15.png` | 同一历史会话 Console | 分类后清洁窗口 | 历史 console 0/0；不是当前路由矩阵或全流程证据 |
| `docs/evidence/visual/current-run/native/devtools-package-9e536f82-13-route-console-cleared-0-error-0-warning-2026-08-15.png` | 同一历史会话、13 模块 lazy-load 后全窗口 | 公开页及受保护页未登录/401 恢复边界 | 历史模块加载证据；不是当前 raw frame、已登录状态或视觉通过 |
| `docs/evidence/visual/current-run/native/devtools-package-9e536f82-community-network-41-requests-no-common-4xx-5xx-2026-08-15.png` | 同一历史会话 Network 面板 | public community fresh window | 历史面板定位；精确状态以同名 HAR 为准 |
| `docs/evidence/visual/current-run/native/devtools-package-9e536f82-community-default-41-requests-2026-08-15.har` | HAR 1.2；41 entries | historical `9e536f82…` public community；1×200、20×304、20×307 | 历史有界公共窗口，无 status 0/4xx/5xx；不继承当前 hash |
| `docs/evidence/visual/current-run/comparisons/home-planned-5e2b2801-web-vs-native-375x812.png` | 历史 `5e2b2801…`；左右各 375×812；Web DPR 1，native 原始 750×1624 机械降采样 | `佳静` / planned / D1 / 0 completed；同文案 | 最新 DevTools-evidenced 首页全坐标定位；内容锚点基本一致，不继承到当前源码 |
| `docs/evidence/visual/current-run/comparisons/home-planned-5e2b2801-same-coordinate-web-vs-native-y44-375x734.png` | 左右均裁 `x=0,y=44,w=375,h=734` | 与左侧相同 | 历史 `5e2b2801…` 首页局部判定：无产品 P0/P1；不继承到当前源码 |
| `docs/evidence/visual/current-run/comparisons/home-planned-5e2b2801-shared-content-web-vs-native-375x734.png` | Web y44 / native y0 | 与左侧相同 | 证据 P1：不对称裁切人为制造约 44px 纵移，只保留为裁切方法反例，不得判 pass |
| `docs/evidence/visual/current-run/comparisons/records-planned-5e2b2801-web-vs-native-375x812.png` | 历史 `5e2b2801…`；左右各 375×812 | planned / 0 of 4 / 0 records；最近记录右上 copy 不同 | finding：卡片高度/后续节奏已驱动当前源码修复，待当前 hash 复拍；copy delta 为生产范围差异 |
| `docs/evidence/visual/current-run/comparisons/records-planned-5e2b2801-shared-content-web-vs-native-375x734.png` | Web y44 / native y0 | 同上 | 证据+页面 P1：安全区校准和固定 TabBar 被不对称裁切混入，且周期说明换行/卡片增高；不得 passed |
| `docs/evidence/visual/current-run/native/devtools-package-5e2b2801-compile-0-project-errors-2026-08-15.jpg` | Stable 2.01.2510290 全窗口；运行时 `touristappid` | 历史 `5e2b2801…` / account entry | 最新 exact Home/Records 视觉检查点所绑定的编译证据；不继承到当前源码 |
| `docs/evidence/visual/current-run/native/devtools-package-5e2b2801-console-cleared-0-error-0-warning-2026-08-15.png` | 同一会话 Console | 分类后清洁窗口 | 历史 `5e2b2801…` console 0/0；不是当前源码、全流程或真机证据 |
| `docs/evidence/visual/current-run/native/devtools-package-5e2b2801-network-16-local-no-visible-failures-2026-08-15.png` | 同一会话 Network | 16 条本地请求 | 当前窗口未见失败项；不是 HAR 或此前交互历史的证明 |
| `docs/evidence/visual/current-run/web/home-planned-fixture-375x812-exact-2026-08-15.png` | 冻结 Web 原型 `Narrow 375 × 812`；375×812 CSS px，DPR 1；从未缩放 `.device-screen` 原尺寸捕获 | `佳静` / planned / `00 done + 01 active` | 首页视觉真值 |
| `docs/evidence/visual/current-run/native/home-planned-fixture-375x812-2x-final-2026-08-15.png` | 历史 pre-`5e2b` capture snapshot（未记录 package hash）；微信开发者工具 iPhone X 逻辑视口 375×812；原生截屏输出 750×1624（2×） | 与左侧相同 | 历史微信实现证据；不得继承当前源码 |
| `docs/evidence/visual/current-run/comparisons/home-planned-fixture-content-web-vs-native-375x734-final-2026-08-15.png` | 历史 pre-`5e2b` capture snapshot（未记录 package hash）；Web 去除 44px 模拟系统层；native 从 DevTools page-frame y=0 开始；两侧各 375×734 | 与左侧相同 | 历史首页内容区判定：当时本状态无可见 P0/P1；已被后续源码取代，当前视觉仍 open |
| `docs/evidence/visual/current-run/comparisons/home-planned-fixture-web-vs-native-375x812-final-2026-08-15.png` | 历史 pre-`5e2b` capture snapshot（未记录 package hash）；左右各 375×812 | 与左侧相同 | 历史 app viewport 定位；不用于当前或平台 chrome 通过 |
| `docs/evidence/visual/current-run/comparisons/account-unlogged-shared-content-web-vs-native-375x734-final-2026-08-15.png` | 历史 pre-`812a` capture snapshot（未记录 package hash）；两侧均为 375×734 app-content | 无会话、未勾协议、主 CTA disabled | 历史账号页 app-content 判定；已被后续源码取代，当前视觉仍 open |
| `docs/evidence/visual/current-run/comparisons/records-planned-fixture-shared-content-web-vs-native-375x734-r1-2026-08-15.png` | Web 去除模拟系统层，native 从 page-frame y=0 开始 | `佳静` / planned / 0/4 / 0 records | 记录页 P1 finding：原生信息架构与冻结真值不同；已重构、待复拍，不得判定通过 |
| `docs/evidence/visual/current-run/comparisons/records-planned-fixture-web-vs-native-375x812-r4-2026-08-15.png` | 历史 pre-`5e2b` capture snapshot（未记录 package hash）；左右各 375×812 | `佳静` / planned / 0/4 / 0 records | 历史记录页全视口定位；后续 `5e2b` 已推翻其“终态”口径，当前视觉 open |
| `docs/evidence/visual/current-run/comparisons/records-planned-fixture-shared-content-web-vs-native-375x734-r4-2026-08-15.png` | 历史 pre-`5e2b` capture snapshot（未记录 package hash） | 与左侧相同 | 历史 app-content 复测；后续 `5e2b` 暴露 P1，禁止作为当前无 P0/P1 证据 |
| `docs/evidence/visual/current-run/comparisons/community-default-web-vs-native-375x812-r1-2026-08-15.png` | 左右各 375×812 | Web 公开 UGC；native 品牌编辑内容 | 社区 P1 finding：原生头部、hero、4:5 feed 密度明显缩小；业务状态也不一致 |
| `docs/evidence/visual/current-run/comparisons/community-default-web-vs-native-375x812-r4-2026-08-15.png` | 左右各 375×812 | 业务状态仍不同 | 社区几何复测：header/hero/grid 起点与卡片比例已对齐；因范围裁决保留“精选/人工审核”且不伪造推荐/最新控件，不能作为同状态 passed |
| `docs/evidence/visual/current-run/comparisons/task-available-web-vs-native-375x812-r3-2026-08-15.png` | 左右各 375×812；Web 为冻结原尺寸捕获，native 为 DevTools 2×原图机械降采样 | route/可领取一致；Web 显示积分奖励，native 因规则关闭显示“审核闭环体验” | 任务页 hero、步骤卡与固定 CTA 几何复测；奖励状态/文案不同，不能判同状态 passed |
| `docs/evidence/visual/current-run/native/task-claimed-375x812-2x-r4-2026-08-15.png` | DevTools iPhone X 375×812；原始 750×1624 | 权威 task `claimed` / submission `draft` | 真实领取后返回任务页、权威刷新和“继续完成投稿”交互证据；不是 Web 对照通过证据 |
| `docs/evidence/visual/current-run/native/submit-draft-explicit-consent-off-375x812-2x-r1-2026-08-15.png` | DevTools iPhone X 375×812；原始 750×1624 | 权威 submission `10b85e42-838d-40ce-8569-e9c342819601` / draft / 三项许可均关闭 | 真实 claim 后草稿、显式同意默认关闭、CTA disabled 证据；`textarea` 原生默认高度 finding 发生在此图 |
| `docs/evidence/visual/current-run/comparisons/submit-web-vs-native-375x812-diagnostic-r1-2026-08-15.png` | Web 375×812 设备画布在 1280×720 中等比缩放后裁切并归一化；native 2×原图降采样；两侧各 375×812 | 都是 claimed/draft，但 ID、字段、许可和奖励文案不同 | 只用于发现原生 `textarea` 高度和首屏节奏漂移；严禁作为 exact/pass 证据 |
| `docs/evidence/visual/current-run/comparisons/submit-web-vs-native-375x812-diagnostic-r2-2026-08-15.png` | 裁切/归一化方法同 r1；native 仍保留 750×1624 原图 `native/submit-draft-explicit-consent-off-375x812-2x-r2-2026-08-15.png` | 与 r1 相同 | `textarea` 修复复测：声明区与固定 CTA 回到冻结首屏节奏附近；因 copy/fixture 不同仍只作诊断，不判 passed |
| `docs/evidence/visual/current-run/comparisons/progress-submitted-web-vs-native-375x812-diagnostic-r3-2026-08-15.png` | Web 设备画布在 1280×720 中等比缩放后裁切归一化；native 2×原图降采样；两侧各 375×812 | route/submitted 一致；Web 有 24h/积分承诺，native 为无 SLA/规则关闭口径 | 修复状态标题空白并按冻结真值扩大 summary/timeline 节奏；业务 copy 不同，只作诊断 |
| `docs/evidence/visual/current-run/native/progress-needs-changes-375x812-2x-r2-top-2026-08-15.png` | DevTools iPhone X 375×812；原始 750×1624 | needs_changes / version 3 / 审核原因公开摘要 | 顶部默认滚动位、原因卡与补件 CTA 证据；本地审核夹具，不是端到端上传证据 |
| `docs/evidence/visual/current-run/native/progress-needs-changes-375x812-2x-r2-bottom-2026-08-15.png` | 同上，页面滚动到底 | 与左侧相同 | 唯一页面滚动所有者、补件、返回来源、返回社区三动作无遮挡证据 |
| `docs/evidence/visual/current-run/native/devtools-final-compile-console-cleared-0-errors-0-warnings-2026-08-15.png` | 微信开发者工具 Stable 2.01.2510290，全窗口 | 证据采集快照重新编译并清理已分类的系统告警 | 当时项目 Problems 0、console clear 后 0 errors/0 warnings；源码随后变化，当前树须重编译 |
| `docs/evidence/visual/current-run/native/devtools-final-network-empty-after-compile-2026-08-15.png` | 同上，Network 面板 | 采集快照编译后的新记录窗口 | 当时面板无请求/无失败；只证明该清洁窗口，不代表历史全流程或当前源码网络回归 |
| `docs/evidence/visual/current-run/native/devtools-package-812a483f-account-entry-compile-0-errors-3-system-warnings-2026-08-15.jpg` | 微信开发者工具 Stable 2.01.2510290；全窗口 | package `812a483f…` 在 `pages/account/index` 重新编译 | project Errors 0 / Problems 0；3 条系统/基础库 warning 单独分类；已被后续 checkpoint 取代，不继承通过 |
| `docs/evidence/visual/current-run/native/account-package-812a483f-375x812-2x-2026-08-15.png` | 微信开发者工具 iPhone X 逻辑视口 375×812；内置截屏原始 750×1624（2×） | 无会话、未勾协议、手机号能力条件启用/未开放 | package `812a483f…` 原生截图；已被当前字体/命中令牌修复取代，仅作修复前 finding/几何诊断 |
| `docs/evidence/visual/current-run/comparisons/account-web-native-package-812a483f-375x812-2x-2026-08-15.png` | 左侧 Web 375×812 DPR1 机械放大到 2×，右侧保留 DevTools 750×1624 原图 | route 一致；手机授权业务 copy/state 不一致 | 字号/卡片/按钮几何诊断；因 copy/state、系统叠层和 package hash 不一致，禁止判为 pass |
| `docs/evidence/visual/current-run/comparisons/account-web-native-package-812a483f-content-375x734-2x-diagnostic-2026-08-15.png` | Web 去除 44 CSS px 模拟系统层后放大为 750×1468；native 从 page-frame y=0 裁取 750×1468 | route 一致；copy/state 仍不一致 | 组合检查不见新的内容裁切、重叠或层级 P1；只作 package `812a483f…` 几何复测 |
| `docs/evidence/visual/current-run/native/devtools-package-f2ec3156-final-compile-0-errors-3-system-warnings-2026-08-15.jpg` | 微信开发者工具 Stable 2.01.2510290，全窗口；运行时 `touristappid` | historical package `f2ec3156…` / account entry | 历史快照编译 0 project error / 0 Problems；3 条工具/基础库 warning 单独分类 |
| `docs/evidence/visual/current-run/native/devtools-package-f2ec3156-final-console-cleared-0-errors-0-warnings-2026-08-15.jpg` | 同一全窗口 | 分类后 console 清洁窗口 | 历史 `f2ec3156…` console 0 error / 0 warning；不替代当前全流程或真机证据 |
| `docs/evidence/visual/current-run/native/devtools-package-f2ec3156-network-16-local-requests-no-visible-failures-2026-08-15.jpg` | 同一全窗口，Network 面板 | 编译后的 16 条本地资源请求 | 历史快照当前窗口未见失败项；不是早先 13 路由交互的 HAR 证明 |
| `docs/evidence/visual/current-run/native/devtools-f2ec3156-route-*.jpg` | 微信开发者工具 iPhone X 逻辑视口 375×812，桌面全窗口截图 | historical `f2ec3156…`：13 路由 exercised default states；task 另含 available/claimed 两态 | 历史逐路由 lazy-load/现场状态证据；不是当前 hash 逐页比较或真机截图 |
| `docs/evidence/visual/current-run/native/devtools-f2ec3156-profile-scroll-bottom-2026-08-15.jpg` / `devtools-f2ec3156-profile-repeat-tab-back-to-top-2026-08-15.jpg` | 同一 DevTools 视口 | historical `f2ec3156…` profile 底部与重复当前 Tab 回顶 | 历史模拟器复测；当前 hash 和 iOS/Android 仍 blocked |
| `docs/evidence/visual/current-run/web/home-planned-375x812.png` | Web CSS 视口目标 375×812；由 1400×900 浏览器窗口中的 346×750 原型画布裁切后归一化 | planned | 首页视觉真值定位 |
| `docs/evidence/visual/current-run/native/home-planned-missing-375x812.png` | 微信开发者工具 iPhone X 375×812；模拟器在 1200×768 窗口内显示后裁切并归一化 | 无周期 | 原生密度、顶部和底栏定位；不可做同状态通过判定 |
| `docs/evidence/visual/current-run/comparisons/home-planned-web-vs-native-375x812.png` | 左右各 375×812 | 左 planned，右无周期 | 只能定位排版漂移，不能归因到纯视觉差异 |
| `docs/evidence/visual/current-run/native/account-dynamic-chrome-375x812.png` | 微信开发者工具 iPhone X 375×812 | 未登录 | 动态顶栏几何的中间复测；返回图标修复发生在该图之后，需重拍 |

历史 Stable 截图由开发者工具内置截屏输出 750×1624，对应 375×812 逻辑视口的 2× 输出；当前 RC 同入口在 100% 下输出 664×1434 并包含外侧细条，不能沿用旧的 exact-page-frame 假设。Web 历史捕获 DPR 为 1。系统叠层差异、捕获命令和机械裁切见 `docs/evidence/visual/current-run/README.md`。后续真机记录仍必须同时保存设备、OS、微信版本、基础库、逻辑视口、DPR、字号、路由、状态、fixture、滚动位置和 trace ID。

历史 `docs/evidence/visual/comparisons/*.png` 将 440×956 Web 与 393×852 微信视口整体缩放到 444×959，且 home/records/profile/points/task/submit 等业务状态不同。它们仅保留为历史定位材料，不是验收证据。

## 本轮 P0/P1/P2

| 等级 | 发现 | 修复/复测状态 |
|---|---|---|
| P0 | tracked config 与当前 DevTools 已统一为 canonical AppID `wx4eac2d4fb11d299b`，但仍无公众平台所有权/正式项目角色、体验版、有效 iOS/Android、真实 `wx.login`/相册/相机/弱网证据 | local config fixed；external blocked：Owner-confirmed AppID 不等于平台/生产资格，账号后台、体验版和完整设备证据仍未提供 |
| P1 | 顶栏原用固定 188/218rpx，未读取状态栏和微信胶囊 | fixed in current source；历史 pre-current DevTools snapshot 曾复拍账号/记录/社区，但不能继承。当前 hash 与真实 iOS/Android 仍 blocked |
| P1 | 历史对照不是同状态、同设备、同裁切 | 当前 `7f5fad…` 已有 27/27 健康 success-state 原生基线，但仍是 0/27 complete comparison matrices、0 formal same-state triplets；Review Pack 逐路由绑定查询、fixture、运行健康与截图。旧 `405ae15c…` 等检查点只作 historical finding，不继承 |
| P1 | 本轮初生成的两张 `same-coordinate ... y44` 左侧被重复裁掉 44px，文件名与实际 crop 不符 | fixed + retested：改为两侧各自在 append 前执行 `crop 375×734+0+44 +repage`；Account/Community 四个左右半图对各自源 crop 的 ImageMagick AE 均为 `0`。完整比较和修正版仍因 copy/state delta 仅作 diagnostic |
| P1 | DevTools/route/device 证据门禁原只检查文件总数或文件名，isolated CI 可脱离 workflow 绕过完整门禁 | fixed + unit-retested：schema v2 逐文件绑定 SHA-256、bytes、MIME、图片尺寸、实际 current package hash、类别、route/state/platform/viewport，拒绝复用；route state 只有 reference/native/comparison 三类齐全才可通过，真机必须带真实硬件元数据；包预算错误纳入 Design QA。isolated CI 在加载预览工具前校验完整工程 checkpoint、strict QA、AppID、公开 origin、法律/域名/手工/risk gates；GitHub credentialed preview 依赖完整 `verify`，不再在 job-level `if` 直接引用 secret |
| P1 | 账号未登录页原生整体缩小、标题换行失效、卡片/CTA 层级弱于冻结真值 | fixed in current code；当前健康包已复拍 482×1044 Account 本地夹具延续态且无阻塞布局；未勾/已勾双态、真实微信授权 copy/state、同状态对照和真机 chrome 仍 blocked |
| P1 | utility/community 页面残留 8–10px 字号和不足 44px 文字按钮，低于冻结 V2 的 12px small / 14px body / 44px target 基线 | fixed in source：新增 20/24/28rpx 字体令牌和 88rpx 命中令牌；当前 Account/Community 缩放诊断无新 P1；系统大字、exact comparison 与 Android 真机仍 open |
| P1 | 微信原生 `button[disabled]` 默认样式把 Account 主 CTA 再降透明，且按钮文字基线/位置漂移 | fixed in source + historical `857110dd…` unchecked retest：primary disabled 显式覆盖原生透明度；两枚 50px 动作内使用 16/20px `.action-label`、双轴居中和 1px 光学基线。当前 hash、已勾选/启用态、长文案/大字号和真机仍 open |
| P1 | Account 生产正确长文案把“暂不登录，浏览公开社区”推到 iPhone X 812px 首屏之外 | fixed in source + current healthy 482×1044 baseline：`max-height:820px` 只收敛卡片、说明与动作间距，不缩小字体或命中区；两枚按钮与 Home Indicator 同屏完整可见；真实授权/大字号/真机仍 open |
| P1 | Account “查看协议”只有 min-height/line-height，跨字体可能基线漂移；“授权微信身份”右箭头没有 handler，形成死 affordance | fixed in source + historical `857110dd…` unchecked retest：协议入口显式 flex 双轴居中；身份步骤无死箭头。当前 hash、已勾选态和真机仍 open |
| P1 | Account 勾选框原生壳为 30px 圆形，和冻结 Web 的 19px 软方形视觉不一致；Submit 草稿保存 spinner 曾挂到最终提交按钮 | fixed in current source + target unit gate：保留 30px 行内命中容器，内部输入改为 19px/6px radius；草稿 spinner 只随 `savingDraft` 出现在草稿重试动作，最终提交只随 `working`。当前 unchecked 全窗口可定位壳体，checked/启用态仍待用户亲自勾选后复拍 |
| P1 | Community/Profile/Shop/Points 普通导航可被快速双点；Progress 权威申诉冲突后旧主动作会重新启用 | fixed in current source + target unit gate：四类入口在导航前同步置 `navigating`、禁用并在 fail/onShow 复位；`APPEAL_STATE_INVALID`/版本冲突/缺失会锁住旧申诉 CTA，必须刷新成功后才重新开放。DevTools 快速连点与真机返回栈仍需 current-hash 现场证据 |
| P1 | Account Back 返回 Home/Settings 后，来源页 `onShow` 会立即再次触发自动鉴权并重开 Account | fixed；历史 `6857791b…` protected-source retest 与 `857110dd…` 单页安全 fallback；当前 `405ae15c…` 受保护来源复拍仍 open |
| P1 | Profile 同时请求多个受保护资源时，一次性 suppression 会被首个请求消费，后续请求再次拉起 Account | fixed + unit/live retest：suppression 不再按请求消费；当前 Profile Back 后并发失败仍留在 Profile，显式 Retry 会重新打开 Account；Home/Records/Task/Submit/Progress/Points/Settings 也完成来源恢复诊断 |
| P1 | Records `5e2b2801…` 同状态图存在不对称安全区裁切、周期说明换行导致卡片增高，以及“查看全部/0 条记录”copy delta | fixed in current source / historical empty retest：`2be680bf…` 已复拍权威无周期空态，保留生产正确“0 条记录”并增加可执行下一步与同步时间；当前哈希及 active/paused/completed 同状态 Web 对照仍 open |
| P1 | 记录页 planned 使用 day-first ledger、圆点轨道和全量待办列表，偏离冻结 hero/streak/四格里程碑/周期管理/最近记录结构 | fixed in current source；pre-`5e2b` r4 曾作 app-content 复测，但随后 `5e2b` 发现新的 P1，故历史“无可见 P0/P1”已 superseded，当前复拍 open |
| P1 | Android 宋体/衬线回退、字宽和换行没有证据 | blocked：需 Android 真机；未在无授权情况下嵌入品牌字体 |
| P1 | 社区 hero/4:5 feed 密度偏离冻结真值；冻结 Web 为公开 UGC，而生产范围只允许品牌精选 | geometry fixed in current source；历史 pre-current r4 仅作几何诊断。同状态 evidence blocked：不启用或伪造 UGC/推荐/最新，仅在具备经审内容与许可后另取同状态参考 |
| P1 | `8b593ce9…` Community hero 标题同文案在原生字宽下换成 `9 + 1`，末字“式”孤行 | fixed in current source；历史 `64561172…` 曾复测两行均衡换行；当前 `405ae15c…` 只有缩放全窗口 Community diagnostic，exact same-state 仍 open |
| P1 | 真实经审 UGC 使用统一静态封面/头像，缺少受控 `coverUrl` 与响应 DTO，可能造成标题与图像不一致 | blocked：当前 `UGC_GO_LIVE_GATE=false`，品牌内容不受影响；上线前 API 必须返回许可/撤回保护的短时封面 URL 与严格 DTO，客户端非法字段/图片失败必须 fail-closed，禁止用无关静态图伪装真实投稿 |
| P1 | 投稿键盘、固定 CTA、关闭键盘后的滚动/焦点恢复未现场验收 | fixed in code / open in evidence：已监听键盘高度并保留 cursor spacing，仍需真机 |
| P1 | 任务领取后返回仍显示旧的 available 数据，用户可见“领取”而不是“继续投稿” | fixed；历史 `6857791b…` live local-API retest；当前 `405ae15c…` Task/Submit 复拍及媒体/提交/审核仍 open |
| P1 | 投稿页 `textarea` 在微信中采用原生默认高度，覆盖 108rpx 规格并把声明区推到首屏以下 | fixed in current source；历史 pre-current DevTools r2 显示当时声明区与 CTA 恢复，copy/fixture mismatch 与当前 hash 复测仍 blocked |
| P1 | 冻结 Web 投稿页仍含旧的 3–9 图、四项确认和 24h/积分文案，生产原生页按隐私/范围裁决使用 1 张代表原图、利益披露、两项必要用途与独立可选公开展示 | accepted product delta / exact visual evidence blocked：不为了同图恢复错误业务口径；需补一张经产品冻结的生产正确态视觉参考后才可 pass |
| P1 | 进度页把 `{title, subtitle}` 直接 spread 到 data，但 WXML 读取 `statusTitle/statusSubtitle`，导致状态主标题和副标题完全空白 | fixed in current source；历史 pre-current DevTools snapshot 中 submitted/needs_changes 曾现场可见，当前 hash 复测 open |
| P1 | 进度页初版 summary/timeline 明显比冻结 Web 压缩，结果动作提前约 60–70 CSS px | fixed in current source；历史 pre-current diagnostic r3 显示同画布几何接近，24h/积分 copy delta 与当前 hash 复测仍 blocked |
| P1 | Progress 顶栏/底部“返回投稿来源”无条件按当前栈 `navigateBack`，深链或无关上一页会回错来源；快速连点可重复导航 | fixed in current source；historical `18672702…` matching Task 栈与单页 redirect 现场复测，unrelated/failure/double-click 由单测锁定；current `405ae15c…` route recapture required |
| P1 | Progress 底部按钮自定义 14px/`line-height:1`，脱离全局 16/20px 动作体系，文字垂直位置漂移 | fixed in current source；historical `18672702…` submitted/needs_changes top/bottom retest；current `405ae15c…` route recapture、大字号/真机仍 open |
| P1 | profile 快捷入口、护理周期卡、交易 gate、胶囊避让和 utility 字号偏离冻结真值 | fixed in source / historical `f2ec3156…` simulator retest：恢复 phase 驱动会员卡、分享层级、三快捷、交易关闭卡、动态 chrome 与 utility 字号；历史滚底/重复 Tab 回顶不继承当前 hash。冻结图 1,280 积分与规则关闭状态不同，同状态视觉/真机仍 blocked |
| P1 | points 余额层级、账本机器码；shop/post/product 关键高度/固定动作；settings 原始 purpose 与 8.5px 说明偏离冻结与生产口径 | fixed in source / historical default-state diagnostics：已本地化账本/许可、恢复关键几何与安全区固定动作、明确目录/内容仅为未签权威的夹具；当前 hash 同状态 Web 比较和真机仍 open |
| P1 | 鉴权退出后重入、task/submit 快点导航、系统 Back 草稿、上传期间输入与 mutation 成功后导航失败会形成死路或误报 | fixed in source + current unit gate；并补齐 Profile/Post 乱序丢弃、前台 UGC 撤权复核、上传全链卸载 token guard、401 非 Tab 登录回跳去重、低端设备 reduced-motion、required-auth 无会话 precheck、权威态失败关闭和旧 UGC 清理；历史 `64561172…` 现场复测不继承，当前页面栈、键盘、系统侧滑、相册/相机和弱网仍 open |
| P1 | 数据库重置后旧 token 仍可验签，但 `/v1/me` 返回 `MEMBER_NOT_FOUND`，受保护页会停在错误态 | fixed in current source；单测通过，历史 `f2ec3156…` DevTools 曾完成再登录→home，当前 hash 现场复测 open |
| P1 | loading/empty/error 混写与无重试 | fixed in current source for all existing routes；历史 `6857791b…` 曾现场诊断部分状态；当前 `405ae15c…` 只保留 Community 品牌精选，Account 与其他 11 页及 loading/no-permission/长文案/弱网等完整 route×state 均需复拍 |
| P1 | Task 缺 id 永久停在 loading；Product/Shop/Points/Progress 慢请求可在离页或较新响应后回写旧状态，Product 深链返回形成回环 | fixed in current source + unit gate：缺 id 显示显式恢复态；异步加载使用 pageAlive/attempt token 丢弃卸载或乱序响应；Product 单页返回 fallback 改为替换到 Shop。历史 `64561172…` 现场复测不继承，当前鉴权/弱网/乱序真机仍 open |
| P1 | Product/Post 缺失资源可能混入旧商品价格/CTA或把撤回内容表述为正常经审内容 | fixed in current source；historical `6857791b…` load-error diagnostics remain non-inheritable. Current `405ae15c…` missing-resource, rights-revocation and same-state Web references remain open |
| P1 | 单页深链 Product 缺失态返回可能形成 Product→Shop→Product 回环；Post 不可用态返回来源不确定 | fixed in current source；历史 `6857791b…` Product 返回曾落到 Shop。当前 `405ae15c…` Product/Post Back、真机手势返回与失败 fallback 仍 open |
| P1 | Account/Progress/Settings 的 mutation 失败提示远离触发区；Post 缺失态标题自相矛盾且无 live announce；撤回许可的读屏名称与确认框不指明用途 | fixed in current source + unit gate：失败区有稳定锚点并自动滚入视口；Post subtitle 随 loading/item/unavailable 改变且缺失态 assertive/atomic；撤回按钮与 modal 都包含具体 purpose。屏幕阅读器与真机焦点恢复仍 open |
| P1 | Profile 合法 10 位可用积分被省略，40 字姓名在 Profile/Home 无完整展示面 | fixed in current source + unit gate：大余额使用紧凑数字级但保留完整值；Profile 长姓名/护理信息可换行，Home 使用长名/超长名两级排版。系统大字号和 Android 字宽仍 open |
| P1 | Records 自动鉴权被取消后会永久停在同步中；普通刷新失败会清空已确认档案 | fixed in current source + unit gate：登录要求成为独立页面状态，显式 CTA 恢复来源；普通刷新保留带上次同步标签的权威快照，401/会员失效才清除私人数据。弱网、会话过期与读屏现场仍 open |
| P1 | Profile / Settings 同时展开多块高密度信息；资料或地址未保存时切换、法律页跳转和退出可能覆盖草稿 | fixed in current source + unit/integration gates：资料、地址、About 互斥展开；所有离开路径执行未保存确认，保存期间锁相关控件。`2be680bf…` 有历史 Profile、Settings 与地址表单复拍；当前哈希、大字号、键盘、真机返回和远程地址保存仍 open |
| P1 | 地址表单若只存本地或复用交易假数据，会泄露 PII 并制造 checkout 已就绪错觉 | fixed in source/contract：独立会员地址 API 使用 AES-GCM/HMAC、成员隔离、10 条上限、唯一默认、版本、幂等、软删除与审计；当前本地验收服务已用纯合成地址复证，远端仍未部署。该能力不解除真实支付/履约阻断 |
| P1 | Post/Product/Submit 仍混用硬编码顶部/底部安全区，可能重复叠加胶囊或 Home Indicator 预留 | fixed in current source：堆叠页统一消费动态 chrome/safe-bottom CSS 变量；当前 DevTools 编译通过，需 iOS/Android 真机复证 |
| P1 | 自定义 Tab 重按、切换失败、选中语义和 reduced-motion 缺失 | fixed in current source：重复当前 Tab 的 JS 滚动改为始终即时，切换失败回滚；历史 profile 回顶截图不继承当前 hash，真机辅助功能仍 open |
| P2 | 页面仍有部分硬编码颜色/字号，tokens 使用率不足 | partially fixed：全局已限于 tokens/reset/共享基础，关键字体和命中面积已令牌化；其余逐组件迁移，不做大爆炸重写 |
| P2 | 旧开发者工具截图含鼠标指针或非权威缩放 | open：最终证据必须无指针、保留原图与裁切说明 |
| P2 | Web Cormorant 字标与微信 Georgia 回退的字面粗细仍有差异 | accepted only for homepage local review：不在未完成字体许可/Android 验证时内嵌字体；真机 typography 仍 blocked |

## 已完成的受控原生重构

- 全局样式只保留设计 tokens、reset、玻璃/按钮/表单/顶栏等共享基础；页面样式继续隔离在各自 WXSS。
- 原生顶栏把状态栏、胶囊顶部/高度、左右安全预留、堆叠页起点和底部安全区写入 CSS 变量，不再针对单一机型硬编码。
- 保留 CISME 珠光紫、玻璃镜片、宋体层级、深紫胶囊和液态玻璃导航，没有切换到 WeUI 或跨端框架。
- 所有 9 个堆叠页使用真实本地图标资产作为返回图标；按钮最小命中区域为 44×44 CSS px。
- 首页 planned 从业务状态、会员文案、步骤选择到 375×812 窄屏几何均按冻结 Web 真值重构；修正了微信 rpx 迁移造成的标题、CTA、流程轨道、说明和底栏整体压缩。
- 账号未登录态按冻结 identity lens、宋体两行标题、三步授权卡和双胶囊 CTA 重新标定；业务仍使用真实开发/微信身份 API，不把视觉步骤当作假登录。
- 记录页表现层恢复冻结 hero、里程碑 streak、四格周期账、周期管理和最近记录结构；数据继续来自 `/v1/me/care`，暂停/恢复/终止和返回首页动作保留闭环。
- 社区/商城/积分中无 handler 的搜索、分类和筛选视觉已隐藏或改为非交互说明，避免假控件。
- 可选公开展示许可默认关闭，界面、API 与奖励资格口径一致；真实草稿保存和安全图片替换均有可见状态。

## 必须补齐的逐页状态证据

详细 route × state × action × API × acceptance 见 `docs/ROUTE-STATE-ACTION-API-ACCEPTANCE.md`。最终至少覆盖：

- 27 条现存路由的 loading、正常、空、错误、无权限/会话过期、长文案、返回和滚动到底；其中动态详情页先保存诚实的缺参/不可用默认态，再用合成 fixture 补成功态。
- home 的无周期/planned/active D1-D28/paused/completed；submit 的拒权、取消、上传中断、安全替换、键盘、草稿冲突；progress 的补件/驳回/申诉/通过。
- 四个 Tab 的切换、重复点击回顶、快速连点、失败回滚、安全区、无 blur 和 reduced-motion。
- 393×852 主比较；另做 375×812 窄屏、440×956 iOS 大屏、427×952 Android，并至少覆盖系统大字号。

## 退出标准

1. 每条纳入签字的 route/state 都有同 fixture、同 route/state/copy/viewport/crop 的参考/微信/比较证据，且复测无 P0/P1；当前 `7f5fad…` 已有 27/27 健康原生 success-state 页面帧，但没有当前 handset page-frame、exact 同状态 comparison、完整 Account 双态或逐状态交互录屏，故仍是 0/27 complete comparison matrices。健康基线不得被扩大为整产品/平台 chrome passed。
2. 微信开发者工具编译 0 error，项目 console/network 0 error；系统级警告单独归档，不冒充应用错误。
3. iOS 与 Android 真机完成登录、相册/相机、键盘、弱网、断传、返回、弹层、焦点和安全区证据。
4. 所有设计发现有 `found → fixed/blocked → retested` 记录；不能取得的证据保持 blocked。

final result: blocked

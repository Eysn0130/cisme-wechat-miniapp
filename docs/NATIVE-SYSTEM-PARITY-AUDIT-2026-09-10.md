# CISME 原生微信小程序系统对齐审计

日期：2026-09-10  
生产实现：`apps/miniprogram` 原生 WXML / WXSS / TypeScript  
参照：整合 PRD V2.1-R4、R0 生产范围、冻结 Web `routeManifest`、当前 API/数据库契约  
结论：原生端没有“少做 7 个 Web 页面”的机械缺口；真正缺口是交易闭环、UGC 媒体/治理契约、发布验收证据。当前不得称为完整 R0 或可上架版本。

## 1. 判定规则

事实优先级如下：

1. PRD 的发布组和明确门禁决定能力是否应上线；P01–P23 是目标能力编号，不等于 23 个首发路由。
2. `R0-PRODUCTION-SCOPE.md` 与 `G0-DECISION-REGISTER.md` 决定当前边界：交易 profile 未选、积分兑换/积分发放/公众 UGC 均关闭。
3. 原生页面、API、数据库与测试决定“是否已实现”；微信开发者工具与真机证据决定“是否已验收”。两者不可混写。
4. 冻结 Web 只用于视觉、交互和历史状态参照，不能反向要求原生复制 QA 路由或本机夹具。

状态词：

- **已实现，未发布验收**：原生路由和权威契约存在，但仍缺当前哈希全状态/真机/外部签字。
- **原生子视图**：能力被合并到同权限页面，不需要独立路由。
- **门禁延期**：PRD 明确为 R1/R2 或当前 gate 关闭；没有空壳是正确行为。
- **外部/决策阻塞**：属于 R0，但缺交易选择、供应商、法务、微信后台或真机事实，代码不能伪造。

## 2. PRD P01–P23 → 原生真值

| PRD | 原生落点 | 当前判定 | 独立审计结论 |
|---|---|---|---|
| P01 生命周期首页 | `pages/home/index` | 已实现，未发布验收 | 游客可直接进入并完成不留存的四步护理；会员周期仍以服务端为权威。补货/购买不能在 P17 未闭环时伪造为主 CTA。 |
| P02 登录注册 | `pages/account/index` + P20 法务页 | 已实现，外部验收阻塞 | 微信身份、可选手机号、显式协议、来源恢复已实现；服务端已发布可读文本不等于微信隐私后台与法务签字完成。 |
| P03 任务中心 | Community/Profile 的有效邀请摘要 | 门禁延期 | R0 只接受邀请深链；公开任务广场属于 R1。无独立 `/tasks` 是范围裁决，不是漏页。 |
| P04 任务详情 | `pages/task/index` | 已实现，未发布验收 | 服务端资格、名额、时效和原子 claim 决定动作；缺当前账号真实邀请的本轮页面证据。 |
| P05 外部投稿 | `pages/submit/index` | 已实现，未发布验收 | 草稿、媒体授权、链接、许可、补件和幂等提交存在；相册/相机、弱网和当前云上传真机链路未验收。 |
| P06 审核进度 | `pages/progress/index` | 已实现，未发布验收 | 状态、补件、申诉与同一 submission 返回链存在；当前全状态视觉与真机矩阵未完成。 |
| P07 护理社区 | `pages/community/index` | 品牌只读已实现；公众 UGC 门禁延期 | production 只展示品牌精选或独立授权的只读故事；推荐/关注只在 development/test 预览。分类不允许假过滤。 |
| P08 发布内容 | 无生产路由 | 门禁延期 | 站内公众发布与外部领奖投稿是不同业务对象；`submit` 不能冒充 P08。UGC gate 通过后再建真实发布草稿。 |
| P09 内容详情 | `pages/post/index` | 品牌/只读详情已实现；社交治理延期 | 品牌故事、经审 feed 详情和分享存在；评论/赞藏/关注仅 dev/test 预览。举报、屏蔽、作者删除/私密需随公众 UGC 一起立项。 |
| P10 公开个人主页 | 无 | 门禁延期 | R1 社交能力；会员 `profile` 是本人私域页面，不能复用为公开主页。 |
| P11 成长中心 | Profile 护理进度摘要 | 原生子视图；完整能力延期 | 当前只呈现护理阶段，不创建未签字的等级/倍率/权益体系。 |
| P12 我的积分 | `pages/points/index` | 账本读取已实现；资产激活关闭 | 账本、批次与投影有权威数据；`POINTS_RULES_ENABLED=false` 时不发新资产，兑换独立关闭。 |
| P13 邀请分享 | `pages/invite/index` + Home/Post 原生分享 | 已实现，真机验收阻塞 | 唯一 share_id、访问与首触身份归因已实现；原生分享完成/取消和购买退款回算尚未证明。 |
| P14 分享数据 | 无 | 门禁延期 | R1 聚合分析；当前只有基础归因事实，不显示可能泄露被邀请人信息的假看板。 |
| P15 商城首页 | `pages/shop/index` | 只读浏览已实现 | 游客可访问公共目录；名称和价格明确为预览，不能解释为可成交库存。 |
| P16 商品详情 | `pages/product/index` | 只读浏览已实现 | 公共详情与安全返回存在；SKU 报价、库存再校验、积分抵扣和结算随 P17 阻塞。 |
| P17 直接结算 | 无 | 外部/决策阻塞 | PRD 把 R0 CHECKOUT 列为 CORE，但 `selected_transaction_profile=null`。这是完整 R0 的第一阻断，不能用禁用按钮或 Web 规格算完成。 |
| P18 订单与售后 | 无 | 外部/决策阻塞 | 无订单、支付、物流、退款权威事实；Web `order/aftersale` 只保留规格价值。 |
| P19 消息中心 | 无 | 门禁延期 | R1；当前状态通过页面刷新恢复，不伪造独立消息列表或已读事实。 |
| P20 设置与协议 | `pages/settings/index`、`pages/legal/index`、`pages/privacy-rights/index` | 已实现，运营执行/外部验收阻塞 | 资料编辑、许可撤回、手机号解绑、隐私请求及独立加密地址簿契约已实现；地址只做资料预备，不代表下单、物流或交易能力。当前 DevTools 后端尚未部署地址迁移/API，页面按失败关闭显示可重试错误。 |
| P21 会员中心 | `pages/profile/index` | 已实现，未发布验收 | 本人昵称/头像、护理、积分、邀请、目录和设置入口使用会员 API；昵称保存走微信安全校验与版本冲突保护，没有复用公开作者响应。 |
| P22 我的内容 | Profile/Community 仅恢复有效邀请 | 门禁延期 | 公开内容管理属于 R1；外部投稿状态由 Task/Progress 找回，不建立假“我的作品”。 |
| P23 护理记录 | `pages/records/index` + Home 护理弹层 | 核心记录已实现；趋势/分享草稿延期 | 当前保存 00–03 四步、自评、完成时间、协议版本并诚实呈现旧记录缺失；日历、趋势和公开分享必须等待查询口径与 UGC 契约。 |

## 3. 冻结 Web 21 路由 → 原生处置

| Web 路由 | 原生处置 | 结论 |
|---|---|---|
| `home` | `pages/home/index` | 原生实现 |
| `records` | `pages/records/index` | 原生实现 |
| `community` | `pages/community/index` | 品牌只读实现；UGC 分类受门禁 |
| `post` | `pages/post/index` | 品牌/经审只读实现；社交受门禁 |
| `profile` | `pages/profile/index` | 原生实现 |
| `account` | `pages/account/index` | 原生实现 |
| `points` | `pages/points/index` | 获取账本实现；资产和兑换关闭 |
| `invite` | `pages/invite/index` | 原生实现 |
| `shop` | `pages/shop/index` | 公共只读实现 |
| `product` | `pages/product/index` | 公共只读实现 |
| `settings` | settings + legal + privacy-rights | 原生按权限拆成三个页面 |
| `publish` | 不迁移 | P08 / UGC 门禁延期 |
| `content` | 不迁移 | P22 / R1 延期 |
| `public-profile` | 不迁移 | P10 / R1 延期 |
| `tasks` | 有效邀请摘要内联 | P03 公开任务中心延期 |
| `task` | `pages/task/index` | 原生实现 |
| `submit` | `pages/submit/index` | 原生实现 |
| `progress` | `pages/progress/index` | 原生实现 |
| `checkout` | 不迁移 | P17，交易 profile 未选 |
| `order` | 不迁移 | P18，订单事实不存在 |
| `aftersale` | 不迁移 | P18，售后事实不存在 |

原生另有 `legal`、`privacy-rights`，这是 P20 的必要拆分，不是范围膨胀。Web 已删除的 growth/messages 以及从未独立化的 share analytics，继续按 R1 追踪。

## 4. 核心旅程健康度

| 旅程 | 健康度 | 当前证据边界 |
|---|---|---|
| 游客 Home → 品牌 Community/Shop/Post/Product | 代码通过 | 访问策略集中到 16 路由表；公开读页面不再被账号门错误拦截。仍需当前哈希逐页 DevTools/真机证据。 |
| 受保护页 → Account → Back/公开浏览 | 代码通过 | Back 优先恢复真实栈/来源，Browse 才进入公开 Community；自动重定向抑制直到用户显式重试，避免账号循环。 |
| Home 四步护理 → 自评 → 权威护理记录 | 代码与契约通过 | 00–03 和自评持久化；无周期可完整护理但不伪造 D1。低端真机连续帧、网络失败现场仍未验。 |
| 有效邀请 → Task → Submit → Progress | 代码/数据库通过 | 资格、claim、草稿、审核状态与幂等已测；本轮测试会员无邀请，当前页面链截图缺失。 |
| Community/Post 社交 | production 关闭正确 | UI 从 `/health/ready` 读取能力；staging/production 的 follow/read/write 服务端直接拒绝，dev/test 才显示预览。 |
| Share → 注册归因 | 基础事实通过 | 唯一 share_id 与首触身份归因存在；微信真机分享和购买/退款归因未闭环。 |
| Points | 获取规则关闭正确 | 规则未签时不生成资产；消费与交易独立关闭。 |
| Profile → Settings → 资料/地址/协议 | 代码与契约通过 | 三个高密度面板改为一次只展开一个；切换、返回、协议跳转和退出前处理未保存资料/地址。地址 API 已有加密、成员隔离、默认项、上限、版本与幂等测试，但当前 DevTools 环境尚未部署该端点。 |
| Records 鉴权取消/刷新/恢复 | 代码通过 | 页面区分登录要求、首次加载、错误、空态和有档案；普通刷新失败保留带时间标签的权威快照，鉴权失败则清除私人数据。现场弱网与会话过期仍需真机复证。 |
| Shop → Checkout → Order → Aftersale → 复购 | 阻塞 | 仅前两级公共浏览存在；PRD 的成交/复购核心循环尚未完成。 |

### 4.1 Profile / Settings 交互契约与设计裁决链

- 信息结构：Profile 只保留会员身份、护理进度、关键目的地与交易关闭事实；Settings 把“会员资料”“收货地址”“关于 CISME”作为互斥展开区，避免在一屏并列多个表单。
- 昵称与头像：昵称使用微信昵称输入与安全检查，头像经本地安全处理后提交；保存携带 `expectedVersion`，失败不覆盖旧资料，成功后重新读取服务端权威资料并刷新全局会员显示。
- 地址：允许微信地址选择或手动填写；必填字段、手机号格式、10 条上限、默认地址、版本冲突、幂等创建、软删除与默认项迁移均有明确恢复路径。地址字段使用 AES-GCM 加密，检索/去重辅助值使用 HMAC；API 按会员隔离并记录审计日志。
- 中断恢复：资料或地址有未保存修改时，切换展开区、打开协议/隐私页、返回或退出均先确认；保存/删除/设默认期间锁定相关动作，失败后保留可恢复状态。
- 范围：地址簿当前只是未来交易所需的资料准备，不创建 checkout、order、payment、logistics、refund 或 aftersale 事实，也不解除 P17/P18 阻断。
- 决策链：PRD 与真实业务状态 → 微信小程序原生能力/平台约束 → `mobile-ui-ux-designer` → `design-taste-frontend` → 微信开发者工具与真机。移动端 Skill 负责状态、路径、中断、恢复与可访问性；Taste 只辅助视觉层级与质感，不能改写微信原生和业务事实。阶段性审计只在完整页面/流程结束后使用，不设第三个常驻审计 Skill。

## 5. 本轮修正的系统级 P1

1. **访问策略漂移**：Community/Post/Shop/Product 和 Home Tab 曾被客户端账号门拦截，违反 PRD 的公开权限。现在 16 个 `app.json` 路由全部由一个原生访问表显式分类；未知路由失败关闭，并有清单一致性测试。
2. **Account 返回语义被“浏览公开社区”吞并**：返回曾强制去 Community，破坏来源和受保护页恢复；现在 Back 先返回真实页面栈，失败才精确回来源，Browse 保持独立动作。受保护来源的自动账号跳转会被抑制，直到用户显式重新认证。
3. **关闭的社交能力仍可见/可调用**：Community 的推荐/关注、Post 的关注与互动现在由运行时能力控制；staging/production 的 follow API 在查询数据库前即返回 `COMMUNITY_PREVIEW_CLOSED`。
4. **商品轮播观察器走最慢路径**：开发者工具在 Product 页明确报告 IntersectionObserver slowest path；现切换为微信原生观察模式，减少轮播可见性判断对逻辑层/渲染层的额外往返。
5. **Records 取消鉴权后永久同步**：统一守卫返回失败时现在进入显式登录要求态，停止 loading 并清除私人快照；用户显式重试才恢复鉴权，普通刷新失败则保留带上次同步时间的权威快照。
6. **Profile / Settings 多面板与未保存修改互相覆盖**：资料、地址和 About 改为互斥展开；切换、离页、法律/隐私入口和退出均执行未保存确认，丢弃资料后使本地缓存失效并从服务端重读。

## 6. 仍未关闭的阻断与风险

- **P0 — 完整 R0 自相矛盾**：PRD 把 P17/P18 和购买→护理→复购列为 R0 CORE，但当前交易 profile 明确未选。产品可以做内部护理/内容试验，不能称完整 R0、可成交或可复购。
- **P0 — 发布证据**：微信隐私后台、法务签字、体验成员、真实登录、iOS/Android/低宽真机、当前哈希全路由状态和上传/分享/弱网证据仍不完整。
- **P1 — 经审 UGC 封面契约**：feed 目前暴露存储 object key，不是消费者可用、可撤销、限用途的图片 URL。原生选择不冒充品牌图，因此真实投稿只能无图；在授权 URL、撤权缓存和图片失败态完成前，P07/P09 不能通过 UGC 视觉验收。
- **P1 — 数据权利执行 SLA**：原生能提交和查看受理/回复，但导出、删除、注销仍需运营执行与证据；页面必须继续使用“已受理”，不得显示“已完成”。
- **P1 — 当前哈希状态矩阵**：单元/集成通过不能替代 16 路由的 loading/empty/error/offline/permission、深链、键盘、安全区、长文案、快速重复操作与 AX/真机证据。
- **P2 — 主包仍需持续门禁**：本轮从小程序主包移除 10 个 WebP 原件，其中 8 个改由受校验的原生 JPEG 输出承载，2 个无运行时引用的源图不再派生进主包；冻结原型源仍保留。当前主包为 1,542,360 / 1,800,000 bytes，余量 257,640 bytes。同步脚本会校验冻结源哈希、JPEG 输出和打包 WebP 漂移；后续新增素材或路由仍必须通过包体门禁。

## 7. 当前源码与现场证据

- 当前原生包：`40b500b8b69e958f657c73fb56c7dedfca6ee5896b1bd6f829fa0c5a3270b920`，146 files / 16 routes / 1,542,360 bytes，global WXSS 8,117 bytes。
- 本轮历史视觉证据：`docs/evidence/visual/profile-settings-records-audit-2026-09-10/current/04-records-empty-after.png`、`05-profile-after.png`、`06-settings-after.png`、`07-address-form-after.png` 绑定 `2be680bf…`。当前 `40b500b8…` 已在 Stable 2.02.2608070 现场复核护理首页重复进度文案删除，Build analyzer success、Problems 0；未形成可绑定的完整同状态三联图。
- 当前 DevTools 地址表单诚实显示“收货地址暂时无法同步，请重试”：源码与集成测试已完成，但当前连接后端没有部署 `202609100002_member_delivery_address.sql` 及对应 API。该错误不改写成成功态。
- 当前 Debugger 计数随页面导航累积到 8–10 条，未逐条归因；因此不声明当前 Console 或 Network 为 0。历史 `14226538…` 的 compile/console 图继续只作历史证据，不能继承给当前包。
- 自动验证：198 unit、68 integration、TypeScript/build、45-path/15-event contract cross-check、asset sync 与 package gate 全部通过；Design QA manifest 结构有效且 `releaseReady=false`。

## 8. 发布判定

本轮可以宣称：**原生系统边界已被重新对齐，公开访问、Account 返回和社交预览门禁的 P1 已修正；现有护理、邀请投稿、基础分享、账本和只读内容/目录是可继续验收的真实实现。**

本轮不能宣称：完整 R0、交易/复购闭环、公众 UGC、积分资产启用、体验版候选、真机通过或可提交微信审核。

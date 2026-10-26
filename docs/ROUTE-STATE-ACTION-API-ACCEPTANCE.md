# Route × State × Action × API × Acceptance

更新：2026-10-26。需求基线为 [PRD V2.1-R4](product/CISME-产品需求文档-PRD-V2.1-R4.md) §6.3、附录 K（ED-TRIAL-01–06）。

本轮仍是原生微信小程序的 **40 个既有路由**；自有精选复用社区、文章详情和作者页，没有增加路由。当前文档记录已统一应用的源码与验收合同，不表示当前体验包、服务器或真机已完成该变更。下方九月 27 路由资料独立保留为历史，不继承到十月候选。

## 2026-10-26 当前源码检查范围

本地逐页源码审计覆盖 40/40 路由，逐页列明入口、游客/权限、主动作、真实数据来源、关闭能力、加载/空/错误/重试、并发/离开恢复与隐私范围。确认的四项 P2 是设置草稿挡住手机号和许可刷新、客服权限第二次读取失败后永久加载、目录入口与既有管理能力不一致、推荐码请求期间编辑后永久 busy；均有独立本机合成反例和定向修复。它们不能替代原生状态矩阵。

自有精选与协议重新确认已于 2026-10-26 统一应用到 12 个原生源码文件，其中社区 WXML 已与目标字节相同，实际写入 11 个文件。应用前 10 文件 173 项草稿回归通过；首次统一应用后实际源码 `npm run typecheck` 与 12 文件 219 项定向回归通过；后续会话失效修复另有下述检查，不把先前结果自动继承到新源码。检查使用真实源控制流与合成响应，不是真实会员的点赞/收藏/关注，也未生成用户协议同意。原九文件草稿的 19/114 项结果仅作历史，不替代最终源码检查。

本地审计/草稿回执位于 `tmp/launch-20261026/page-interaction-source-audit.json` 和 `tmp/launch-20261026/native-editorial-renew-drafts/actual-source-apply.json`。这些是 ignored 的工作记录，尚未作为发布归档证据；实际源码 SHA 已保存在统一应用回执，最终体验包仍须另行绑定包哈希。当前没有这次新页面的完整原生截图、真机或上线互动通过结论。

## 自有精选当前路由合同

自有或逐篇获授权的精选与普通会员 UGC 分开。只有实际已发布、作者为当前小程序 canonical 活跃微信会员的文章可公开读取；发表由受权 `editorial.manage` 操作者完成，不按昵称创建或合并身份。公开作者快照使用获授权昵称，微信号、手机号、私有对象键和授权全文不作为公开字段。

| 路由/来源 | 必须状态 | 动作与真实数据 | 验收 ID | 当前证据范围 |
|---|---|---|---|---|
| `pages/community/index` 的 `featured` | loading、已发布列表、空、网络失败/重试、游标续页、离页/换号迟到响应 | `GET /v1/editorial/articles?limit=20&cursor=…`；打开 `post?id=…&source=editorial`。列表不依赖普通 UGC 或 preview 开关；没有数据时不显示旧打包故事。 | P07、ED-TRIAL-01/02 | 实际 source/unit 已检查；当前包与原生/真机待核验 |
| `pages/post/index?id=…&source=editorial` | loading、已发布、撤回/缺失 404、请求失败、图片失败、guest、本人/他人作者、互动 pending/失败/确认、离开恢复 | 独立 article detail；点赞/收藏是设置期望状态的 PUT，关注独立 PUT。成功后使用服务器 bool/count；游客登录返回完整 `id&source`；分享使用原生直达路径，不调用旧 feed/share attribution。 | P09、ED-TRIAL-02/03/04/05/06 | 实际源码合成请求验证成功后更新/失败保留/旧响应拒绝；未记录真实互动成功 |
| `pages/community-author/index?id=…&source=editorial` | loading、作者公开快照、空/续页、404/网络错误、本人隐藏关注、guest、关注失败/成功、离页迟到响应 | 独立 author page；关注使用该作者首篇实际已发布文章作为上下文，空列表不呈现可执行关注；打开同一 editorial 文章来源。 | P10、ME-01、ED-TRIAL-02/03/05 | 实际 source/unit；完整原生与真机未测 |
| `pages/account/index?intent=renew` | 当前协议读取、默认未勾选、版本变化、失败重试、确认 pending、确认成功返回、取消阅读、session 失效 | 保留有效旧 session，仅显式确认当前版本后提交窄法律接受接口；不走“已有 token 继续使用”捷径，不触发头像、手机号或再次身份授权。 | P02/P20、A21、ED-TRIAL-06 | 原生 renew 分支已应用并有独立单元测试；真实接受/原生与真机未测 |

`source=editorial` 是来源判别，不是授权凭证。普通 UGC 的 `community-post`、发布器和评论仍由既有 UGC 开关守卫，不因精选互动开放而放开。以下五个旧 ID 无论查询来源为何，均在请求前拒绝，绝不复活其文章、封面或人物照片：`brand-scalp-ritual`、`brand-night-routine`、`brand-care-journal`、`brand-roots-check`、`brand-product-ritual`。

## 独立 API 与失败边界

| 方法/路径 | 身份与结果 | 失败/并发边界 |
|---|---|---|
| `GET /v1/editorial/articles?limit&cursor` | 游客可读；`items` 仅为已发布 Card，`nextCursor` 不透明，limit 1–30。Card 的赞藏数为真实服务端投影。 | 空不等于错误；游标/身份/页代次变化丢弃旧响应；跨页与页内按 id 去重。 |
| `GET /v1/editorial/articles/:id` | 游客可读；登录后返回该会员的 liked/saved/following/isMine；纯文本 body、公开媒体链接、来源与 provenance。 | 撤回或作者停用/注销后 404；网络失败不能冒充已撤回；不向客户端下发 objectKey。 |
| `GET /v1/editorial/authors/:id?limit&cursor` | 公开作者白名单、公开文章和真实 following/isMine。 | 没有可公开文章时不可用；旧会员响应不覆盖新 session；分页不覆盖并发关注结果。 |
| `GET /v1/editorial/media/:articleId/:sha256` | 同源公开衍生媒体；服务端核对 SHA、字节数和 `image/webp`。 | 仍检查文章/作者可见性；客户端仅接受该路径，不能把对象键或第三方 URL 拼成媒体。 |
| `PUT /v1/editorial/articles/:id/reaction` | 活跃 canonical 微信会员；body `{kind:'like'或'save',active:boolean}`；返回真实 liked/saved/count。 | 幂等设置状态；无乐观加数；pending 串行；失败保留旧值并重读/重试，迟到结果不跨页/跨号生效。 |
| `PUT /v1/editorial/articles/:id/follow` | 同上；body `{active:boolean}`；返回 `{authorId,following}`。 | 禁止自关注；成功前不改 UI；作者与返回 authorId 绑定。 |
| `POST /v1/me/legal-acceptances` | 有效当前微信会员 session；body `{consents:[{documentType:terms或privacy,version}]}`，两类齐全；result `{accepted:true,documents:[{documentType,version}]}`；复用追加接受记录。 | 本轮新增的窄更新方案，见下一节；不会创建会员、旋转 token 或同意可选内容/营销许可。 |

只有后两项新的精选互动 mutation 需要当前条款/隐私接受。缺少当前接受时返回 `409 CURRENT_LEGAL_CONSENT_REQUIRED`，不写入互动或该互动的成功审计；公开阅读、查看协议和原有 session 仍可继续。401 仍按真实会话失效处理；404 是撤回/不可用；422 是无效输入/自关注，不伪装成已保存。

首批六篇正文与媒体来源另见 `docs/content/editorial-20261026/articles.original.json` 及发布素材清单。详情使用服务器真实 provenance 短标签；“AI辅助配图”同时说明仅作阅读示意，不代表实际使用效果。封面不能作为作者头像，也不生成假体验、假赞藏或假关注。心形/收藏/分享复用现有 SVG，选中状态同时有文字与可访问标签；底栏最小点击范围和安全区沿用原生样式，实际窄屏/大字仍待当前包验证。

## 当前协议重新确认：实际源码合同与验证范围

原有 `account.onShow` 在有 token 时设置 `pendingDestination`，`login` 又在协议检查前走继续使用分支；WXML 也用该字段豁免协议禁用状态。本轮以专用 renew 分支隔离这些捷径；仅访问该 URL 不产生接受事实。

本轮采用窄法律接受接口，保留原有效会话：

1. 新精选点赞、收藏或关注在同一数据库事务内核验真实 actor，再锁定当前 active terms/privacy 文档并核对该会员对应版本的接受事实；缺失则返回上述 409。与协议发布锁串行，不能在预读后越过版本切换。
2. 原页面只有在仍属于当前可见页面、相同 session 和请求代次时才保存完整内部 returnURL 并打开 `account?intent=renew`。409 不等于 session 失效，不清 token；不对普通读取或其他业务的 409 建立全局跳转。
3. renew 入口始终显示未勾选的当前条款/隐私，明确“确认并返回”；有 token 也不能走继续、头像或手机号分支。取消/返回恢复原公开阅读，保留旧 session。
4. 用户明确勾选并点击后，接口仅以服务器已验证的 member/principal 记录当前版本。`consent_acceptance` 的唯一键为 member+type+version，重复接受不覆写首份历史；principal 是真实操作者证据，不能从客户端传入。
5. 确认成功只返回原文/作者页，重新读取真实状态；不自动重放点赞/收藏/关注。用户再次操作时，服务器重新核验当前版本。确认期间又发布新版本则拒绝旧版本、重读文本并清勾选。
6. session 失效时回到正常明确身份确认；不会凭旧 token 或协议页面访问自动创建接受记录，也不伪造微信登录、手机号或用户点击。

后端变更涉及 `editorial.ts`、`server.ts` 与当前法律接受 helper/测试；原生已应用 `services/api.ts` 的专用 renew 导航、文章与作者的窄 409 处理、`account/index.ts`/WXML 的 renew 分支。所有目标先核对既有源码基线和冻结草稿 SHA，再统一写入，未代用户勾选、登录或创建接受记录。

定向回归覆盖：v1 接受对 v2 新互动返回 409 且零写入；查看不受影响；显式当前接受后才可互动；版本并发/重复提交；有 token 也不可绕过 checkbox；取消保留会话与原文；成功不自动发起互动；离页/换号的迟到 409 不跳转；renew 不调用 `wx.login`、手机号、头像或 `setSessionToken`。

普通身份登录在用户明确同意后，微信身份成功即返回来源（无来源则主页）；没有头像、资料暂时失败或挂起均不得增加登录前置步骤。资料只在后台刷新，头像仍可在设置中按需编辑，保留旧头像恢复路径。已有有效会话的“继续使用”也不再以资料读取或头像设置为前提；目标导航失败可重试而不再次交换微信身份。

精选读取的旧会话过期不能留下永久 loading。本轮补充：仅同一个仍可见的读取代次、原非空 token 已变为空且收到 401 或 `REQUEST_SESSION_CHANGED` 时，清空该页会员相关投影并结束忙态，提示手动重新加载公开内容；不自动重放请求、互动或接受。不同的新非空会话、离页和旧代次仍丢弃。Community 同时观察任务、能力、访问权与内容汇总的并发失败；Author 的后续明确重读重新绑定当前上下文。15 项新测试通过实际 API/coordinator/HTTP 层的合成 `wx.request` 401 回调核验真实 token 清除，包括各并发时序、分页、离页和换号；含既有页面回归共 9 文件 173 项通过，类型检查通过。这仍是合成传输与源码证据，未对真实会员执行注销、同意或互动。

原生默认/游客检查在旧包 `8e9479fb23ab…` 已完成 35/40 路由打开和逐张查看后暂停；返回图标细线可见性问题由当前资产增强修复，旧截图保留为历史，不继承到增强图标或会话修复后的新包。新包须另行绑定并复拍。

## 历史资料：2026-09-12 的 27 路由候选

以下历史包、截图、诊断与 `current` 字样仅指当时快照，不是本轮四十路由或新精选/renew 的证据。其未完成状态不被删除，也不能把已关闭交易/普通 UGC 的全量验收前移为本次授权的自有精选实现条件。

Current package checkpoint `005f03d43a58…` contains 27 routes, including Support, role-aware Management, the R4-A Catalog management list/editor and the isolated R4-B checkout/order pages. Structural/type/API tests pass. An authenticated local DevTools traversal opened 27/27 routes against the isolated API, captured a 484×1048 native frame for each route, and recorded zero matches in the bounded console and network failure filters. The Support slice additionally has 21 deterministic native state frames, two local-API/font-size supplements and four simulator recordings bound to this hash. These are local synthetic/runtime-presentation evidence, not physical-device or formal interaction-matrix acceptance. Every route remains `matrixComplete:false`; physical iOS/Android, system keyboard/media picker, public HTTPS/staging and the formal same-state reference/native/comparison triplets remain open. Active production legal versions remain fail-closed; staging legal status and Support retention remain independent gates. Any row below that names an older hash is historical. Every remaining `open/blocked` state stays binding until its own action/API/current-hash/device evidence exists.

| Route | 必须状态 | 核心动作 | 权威 API/JSAPI | Acceptance | 当前 |
|---|---|---|---|---|---|
| `pages/account/index` | 未同意、busy、成功、微信失败、隐私未配置、会话过期、来源返回、法务文本未签字 | 阅读协议、显式同意、登录、返回来源、明确浏览公开社区 | `wx.login`、`wx.openPrivacyContract`、`POST /v1/identity/wechat`；devtools/显式真机 `develop` 调试仅 `/identity/dev` | 未签字生产失败关闭；拒绝不建会话；Back 恢复来源、Browse 才切公开社区；协议入口居中；身份步骤无死箭头；812px 首屏两动作完整可见；trial/release 不接受调试 origin 覆盖 | historical `857110dd…` unchecked compact-height + Browse/single-page Back diagnostics；current `405ae15c…` checked/enabled、busy/success/failure、protected-source Back、exact comparison/login/device open |
| `pages/home/index` | loading、无周期、planned、active due/无 due、paused、completed、401、error、长文案 | 激活、完成节点、查看记录、重试 | `GET /v1/me`、`GET /v1/me/care`、显式 key/version `POST /care-cycles/{id}/activate`、`POST /milestones/{m}/complete` | 权威状态无闪假值；重复点击精确回放；大字/窄屏不裁主 CTA；401 登录后回来源 | historical `6857791b…` auth-Back/planned diagnostics；current `405ae15c…` recapture required；active/paused/completed/long-copy/device open |
| `pages/records/index` | loading、空、planned、active、paused、terminated、completed、跨周期/旧记录、长记录、error、三个确认弹层；cancelled 为目标差距 | 暂停、恢复、终止、取消/确认、打开详情、回首页、终态浏览目录、滚到底 | `GET /v1/me/care` 当前+history、版本化/幂等 `POST /care-cycles/{id}/{action}`、`wx.showModal` | 失败关闭旧权威动作；按冻结时区显示完成时间；每条记录回看协议版本、00–03 步骤和自评；旧记录诚实缺失；暂停不伪造未来日期；历史周期不删除 | current `3ed964cb…` empty-state DevTools capture + unit/integration contract evidence；active/paused/terminated/completed/detail/long-ledger/same-state reference/device open；cancelled 等待全退权威事实与领域迁移 |
| `pages/community/index` | loading、品牌精选、有效/无邀请、经审 feed、空 feed、error、顶部/底部 | 打开故事、打开有效邀请、重试、Tab 返回 | `GET /v1/feed`、`GET /v1/me/tasks` | UGC gate 关闭不泄漏外部投稿；经审 feed 失败保留品牌内容并明确 partial error；真实 UGC 必须有严格 DTO、有效许可/撤回状态和受控 `coverUrl`，禁止统一静态图伪装；仅 `claimable`/可继续 submission 显示邀请；无假搜索/排序；图片 4:5/crop 对齐真值 | current `405ae15c…` brand-editorial full-window diagnostic；exact/empty/error/invitation/UGC-contract/device/rights states open；historical `6857791b…` 不继承 |
| `pages/profile/index` | loading、真实 populated、无邀请、长姓名/大余额、401、error、滚到底 | 积分、目录、有效邀请、设置 | `/v1/me`、`/v1/me/points`、`/v1/me/care`、`/v1/me/tasks` | 未加载不显示伪会员；长姓名可完整换行、10 位合法余额不省略；phase/邀请来自权威事实；动态胶囊与底栏安全区无遮挡 | historical `6857791b…` concurrent-auth/normal diagnostics；current `405ae15c…` recapture required；long-name/large-balance/scroll/device open |
| `pages/support/index` | loading、无会话、AI、等待人工、人工分配但离线、真人 presence、typing、resolved、50+ 历史、阅读历史时精确新消息数、发送/图片失败、401/换号、error | 发消息/原幂等键重试、转人工、读回执、加载更早、返回底部、图片/拍照/订单附件、删除/重试附件、私有图片预览 | `/v1/me/support/summary`、`GET/POST /v1/me/support/messages`、`POST /handoff`、`POST /read`、`POST /presence`、support media authorize/complete/GET/DELETE、`GET /v1/me/orders` | 同一会员只能看自己的会话/媒体/订单；换号前清私有快照；presence TTL 才能亮绿；ACK 不推进同步水位；read 仅来自对侧游标；失败保留文字、附件和 client ID；对象键不下发 | local unit/integration PASS；`005f03d4…` 绑定 17 个 member 状态、2 个补充状态与 4 段模拟器录像；真实软键盘/系统 picker/公网弱网/iOS/Android/staging open |
| `pages/management/index` | authority loading、无能力、仅客服能力、仅商品能力、仅订单读取、混合能力、撤权、error | 打开有权入口、返回、重试 | `GET /v1/me/authority` | 只按服务端 projection 显示；客户端 flag/普通会员/legacy team role 不放权；客服、商品、订单入口按 capability 独立出现；未实现能力有诚实空态 | local unit/integration PASS；`005f03d4…` authenticated route health/frame PASS；完整状态矩阵与 physical-device open |
| `pages/management-catalog/index` | loading、空目录、分页、长商品名、pending/draft、eligible/published、blocked、撤权、401、error | 新建、打开、加载更多、重试、返回 | `GET /v1/management/catalog`、`GET /v1/me/authority` | 逐请求重验 capability；失败不伪装空目录；legacy preview 明示来源且默认 pending/draft/stock 0；购买关闭 | local API/UI contract tests passed；current `c7e457b5d63d…` route-open diagnostic passed；visual/Network/device open |
| `pages/management-product/index` | 新建、loading、资料保存成功/失败、资质缺证据、上/下架、库存正负调整、版本冲突、无部分能力、未保存离开、长文/键盘/error | 保存商品/SKU/整数分价格、资质判断、发布、库存调整、冲突恢复、返回 | management catalog create/update/qualification/publication/inventory endpoints | 分组表单；严格元转分；服务端确认才成功；资质与上架分离；库存理由必填；expected version/幂等；静态图片 allowlist；无支付假动作 | local commerce integration + yuan parser tests passed；current `c7e457b5d63d…` route-open diagnostic passed；keyboard/save-retry/conflict video/device open |
| `pages/management-support/index` | loading、空队列、waiting/unread/recent、100 会话、游标续页、轮询、撤权、error | 打开会话、加载更多、刷新、返回 | `GET /v1/management/support/conversations` | 每次 API 重新校验 `support.read`；队列游标不使用 offset；换号/重新核权时旧队列不可见；失败不伪装空队列 | local 100-member bounded test PASS；`005f03d4…` authenticated route health/frame PASS；完整 visual/Network/device matrix open |
| `pages/management-support-chat/index` | loading、待接管、本人/他人处理中、member presence/typing、resolved、50+ 历史、阅读历史新消息、上下文有/无权、发送失败、撤权、AI Provider pending、error | 接管、回复/重试、typing/offline heartbeat、解决确认、读回执、加载更早/返回底部、查看必要信息、鉴权图片预览、订单详情 | management support messages/claim/read/presence/media/resolve/member-context、management order detail、`GET /ai/status`、`POST /ai/suggested-draft` | `support.read/reply/assign/member.support_view/commerce.order.read` 分离；仅 assigned operator 可发在线/typing；单赢家接管且落 system event；ACK 不跳过远端；图片不泄露 object key；建议草稿不持久化/不发送；换号/撤权清空旧会话 | local concurrency/privacy/AI-boundary PASS；`005f03d4…` 绑定 4 个 admin 状态、订单/图片/上下文/resolved 与 route health；physical iOS/Android/staging open |
| `pages/task/index` | loading、有效未领、claimed draft/submitted、过期/缺失、busy、error、无权限 | claim、继续草稿/进度、返回、重试 | `GET /v1/tasks/{id}`、`POST /claim` | 缺 id 不永久 loading；claim 原子且回放同 submission；返回后 `onShow` 刷新权威状态；失效任务无领取 CTA；深链返回兜底 | historical `6857791b…` available→claim→resume and `18672702…` exact-source return diagnostics；current `405ae15c…` recapture required；other states/device open |
| `pages/submit/index` | loading、空草稿、单/双图、拒权、选择取消、上传中断、替换、字段错、保存冲突、键盘、长编号、API error | 输入、服务端保存、上传/安全替换、许可、提交、返回 | `GET /submissions/{id}`、`PUT /draft`、`POST /media/authorize`、对象上传、`POST /complete`、`POST /submit`、`wx.chooseMedia` | 旧证据直到新证据原子切换；必要用途必须显式开启；可选 feed 默认关闭且关闭仍可提交；未保存不可离开；键盘不挡 CTA | historical `6857791b…` empty draft/resume and `18672702…` same-ID supplement-entry diagnostics；current `405ae15c…` recapture required；real media/allow-deny/keyboard/conflict/submit/device open |
| `pages/progress/index` | loading、draft、submitted、needs_changes、rejected、appealed、approved 无/有积分、缺失、error | 补件、申诉、返回来源、重试 | `GET /submissions/{id}`、`POST /appeal` | 缺 id 不永久 loading；乱序/离页响应不得覆盖新权威态；未知 status 必须失败关闭而非伪装 draft；申诉失败滚入可见区；仅同 ID Task 栈 navigateBack，否则 redirect 精确来源并序列化离开动作 | historical `18672702…` submitted/needs_changes top/bottom、exact-Task Back、同 ID 补件入口及 action-label 复测；current `405ae15c…` recapture required；rejected/appealed/approved/keyboard/network/device open |
| `pages/points/index` | loading、规则关闭空账、规则开启、冻结/可用/欠分、长流水、401、error | 查看真实流水、重试、返回 | `GET /v1/me/points` | load 清除旧余额且丢弃乱序/离页响应；余额/条目增量只接收安全整数；条目可追溯；规则关闭不建资产；本地 maker-checker 动作守恒 | historical `6857791b…` auth-Back/empty-ledger diagnostic；current `405ae15c…` recapture required；non-empty/frozen/debt/long-ledger/device and production finance blocked |
| `pages/post/index` | loading、品牌内容、经审 UGC、撤回/缺失、长标题/正文、error、顶部/底部 | 返回、原生分享、重试 | 本地 bundled brand-editorial fixture、`GET /v1/feed`、`POST /v1/shares`、visit/identity attribution、`onShareAppMessage` | subtitle 反映 unavailable；撤回/缺失 live announce；单页 Back 回公开 Community；UGC 撤权后不可见 | historical `6857791b…` brand/error/share diagnostics；current `405ae15c…` recapture required；long-copy/scroll/UGC-rights/device open |
| `pages/shop/index` | loading、正常、空、下架、error、长商品名、库存状态、滚到底 | 打开商品、加载更多、重试、返回 | 公共 `GET /v1/catalog` | 未登录可浏览；只返回 eligible+published；慢请求离页/乱序不回写；价格以安全整数分精确格式化；只有隔离非生产订单 gate 开启且商品为 synthetic_test 时才显示可购买；无 legacy fallback | current local/API tests passed；historical `c7e457b5d63d…` route-open diagnostic passed；current `7f5fad…` empty/inventory/long-copy/Network/device open |
| `pages/product/index` | loading、正常、缺失/下架、error、长资料、SKU 缺货/不可售、数量 1/99、顶部/底部 | 返回、重试、选择 SKU、增减数量、立即购买 | 公共 `GET /v1/catalog/{productCode}`、`GET /v1/commerce/orders/status` | 直接读取详情；loading 清旧 item；缺失/非法价格不留伪价格或 CTA；乱序不回写；不可售原因明确；购买只进入隔离 checkout，不调用支付；单页 Back replace 到 Shop | current local/API/UI tests passed；current `7f5fad…` native frame/interaction/Network/device open |
| `pages/checkout/index` | loading、无地址、报价中、报价成功/过期、地址/价格/库存变化、重复确认、401、error、键盘/返回恢复 | 选 SKU/数量、选/编辑地址、获取服务端报价、确认创建待支付订单、重试 | `GET /v1/me/addresses`、`POST /v1/me/commerce/quotes`、`POST /v1/me/orders` | 客户端金额不是 authority；报价带到期时间和规则版本；创建时复核商品/SKU/价格/地址/库存；同 key 重放同订单、异内容冲突；离开登录/地址页不丢购买意图；不显示模拟支付成功 | local R4-B integration + native flow unit tests PASS；current `7f5fad…` screenshot/recording/staging/device open |
| `pages/orders/index` | loading、空、pending_payment、cancelled、expired、分页、长商品名/金额、401、error | 打开订单、加载更多、重试、返回 | `GET /v1/me/orders` | 只读本人订单；游标分页；状态/金额/商品快照来自服务端；支付不可用时不制造付款按钮或失败文案 | local owner-isolation/list tests PASS；current `7f5fad…` screenshot/Network/device open |
| `pages/order-detail/index` | loading、pending_payment 倒计时、cancelled、expired、地址快照、取消冲突/丢响应/重放、401、error | 取消待支付订单、重试、返回 | `GET /v1/me/orders/{id}`、`POST /v1/me/orders/{id}/cancel` | 订单快照不随商品/地址变化；取消需 expected version + 幂等键，精确释放库存一次；gate 关闭后仍可取消；没有 paid/requestPayment/退款/履约状态 | local snapshot/cancel/replay/release tests PASS；current `7f5fad…` visual/interaction/device open |
| `pages/management-orders/index` | authority loading、空、分页、pending/cancelled/expired、长编号/金额、撤权、401、error | 打开订单、加载更多、重试、返回 | `GET /v1/management/commerce/orders` | 每次请求重验 `commerce.order.read`；不显示用户完整地址/电话；失败不伪装空列表；本切片无改状态运营动作 | local capability/redaction tests PASS；current `7f5fad…` visual/Network/device open |
| `pages/management-order-detail/index` | loading、三种状态、快照、撤权、401、error | 查看最小必要订单事实、返回 | `GET /v1/management/commerce/orders/{id}` | 只显示掩码姓名/手机号和省市区；不得从客户端参数恢复完整 PII；本切片不伪造发货/退款/支付操作 | local capability/redaction/cross-user tests PASS；current `7f5fad…` visual/device open |
| `pages/settings/index` | loading、无/多许可、撤回确认/失败、401、长文案、滚到底 | 单项撤回、退出、返回、重试 | `GET /v1/me/consents`、`POST /consents/{id}/revoke` | 撤回按钮/确认框指明具体 purpose，失败滚入可见区；重复撤回锁；退出须确认且确认态锁住 Back/撤回/重试；展示许可与奖励独立 | historical `6857791b…` auth-Back/empty-consent/logout-modal diagnostics；current `405ae15c…` recapture required；multi-consent/revoke-failure/screen-reader/device open |
| `pages/invite/index` | loading、有效邀请、过期/撤回/已用、复制失败、分享取消、长文案、单页启动、error | 复制/分享邀请、返回、重试 | `GET /v1/me/shares?targetType=member_invitation`、`POST /v1/shares`、`wx.setClipboardData`、`onShareAppMessage` | 邀请身份/归因来自服务端且有到期/撤销；分享取消不写成功；无效邀请不泄漏成员信息；深链返回落到 Profile | local invitation/share integration + navigation tests PASS；current `7f5fad…` native/share/device evidence open |
| `pages/legal/index` | 无参数、terms、privacy、未发布/版本缺失、长文、滚到底、error | 阅读、返回 | public legal-document read endpoint / approved local fixture only where explicitly allowed | 文本类型和版本由可信 route/input 映射；production 未批准版本失败关闭；历史同意版本不被新文本覆盖；不把 staging draft 当正式生效 | legal publication/version tests PASS；current `7f5fad…` exact text/render/device evidence open |
| `pages/privacy-rights/index` | loading、无申请、处理中/已回应/拒绝、分页、导出/擦除/注销范围说明、401、error | 提交请求、刷新、查看处理状态、返回 | member privacy-request endpoints + operator workflow | UI 不把 plan/dry-run 说成已导出/已擦除/已注销；每项范围、身份确认、legal hold/retention 和人工受理边界明确；本人隔离 | local privacy lifecycle tests PASS；全系统执行闭环仍部分 PENDING；current `7f5fad…` visual/device open |
| internal admin Web/API | review/publication/finance/worker role、空队列、pending、死信、拒绝重提、权限拒绝、并发版本冲突 | 审核/发布；查看积分 grant；发起/批准/拒绝资产动作；查看并单条重驱死信 | `/v1/admin/reviews`、`/publications`、`/points/*`、`/worker-failures/*` | 内容与财务分别四眼；同人批准拒绝；精确重放；lot/projection/entry/event/audit 原子守恒；重驱保留 attempts/error 且 expected-attempt/RBAC/audit 生效 | API/domain integration passed；worker UI/alerts、admin Web browser/a11y/concurrency UX and production IdP not accepted |
| `custom-tab-bar` | 四个选中态、重复点、快速连点、失败、无 blur、reduced-motion、安全区 | 切 Tab、当前 Tab 回顶 | `wx.switchTab`、`wx.pageScrollTo`、窗口/胶囊信息 | 乐观失败回滚；选中语义可读；低端/减少动效直接到终态；不截 Home Indicator | historical `f2ec3156…` four-tab traversal + profile repeat-tab back-to-top；current failure/rapid-tap/reduced-motion/device open |

## 所有路由共同门禁

- 会话失效：清除陈旧 authority，保存内部来源，重新登录后恢复；公开 catalog/feed 不被错误强制登录。
- 网络：loading、空、服务错误、离线/超时、重试不可互相冒充；console/network 不留未处理错误。
- 布局：375×812、393×852、440×956、Android 427×952，大字号、长中文/编号、固定栏、滚动到底均无遮挡。
- 原生交互：系统 Back、深链单页启动、键盘开合、弹层遮罩、取消、焦点恢复、快速重复操作均到权威终态。
- 媒体：相册/相机允许、拒绝、取消、超限、弱网、中断、重试、替换失败均不制造成功或丢失旧证据。
- 证据：每格保存 fixture、route/state、视口/DPR、截图或视频、trace ID、expected/actual、结果与复测人。

# CISME 正式版前性能、交互与 GitHub 资源研究

研究日期：2026-09-20。源码基线：`e1d31d877f36d9245c5844786a769319558cb546`，唯一工程 `/Users/mini/CISME`，仓库 `Eysn0130/cisme-wechat-miniapp`。这是下一轮施工依据，不是正式版验收通过报告。

## 1. 结论与证据边界

先修“关键内容等待次要请求、身份入口表达、超时与连接释放”，再测真实网络和长列表，最后打磨动效。没有证据支持当前就更换框架、引入 Redis、迁移微服务、升级 WebSocket 或安装动画大包。

本轮完成源码审查、官方资料与 GitHub 资源核查，以及读取真实源码的隔离行为复现；没有修改小程序或服务端运行时代码，没有安装外部 Skills，没有访问付费设计案例库，没有新做真机性能测试。以下“已复现”指合成依赖下的确定性行为，不代表生产延迟分布。发现项尚待下一轮修复。

- [可执行复现](evidence/performance-research-20260920/reproduce.mjs)与[原始结果](evidence/performance-research-20260920/source-probes.json)：读取当前文件，在 VM 中提供合成请求/数据库；Fastify 超时对照只监听本机随机端口，不连接业务数据库。
- [GitHub 元数据快照](evidence/performance-research-20260920/github-resources.json)：11 个仓库的默认分支 SHA、维护时间、许可证；不是安全审计结论。
- [官方资料抓取记录](evidence/performance-research-20260920/retrieval-manifest.json)：URL、时间、内容哈希。微信官网页面在搜索工具中失败，随后通过普通 HTTPS 成功读取，并与已安装 `miniprogram-api-typings@5.2.3` 核对。没有上传第三方资料全文。
- 上轮主工程测试为 368 单测、562 集成通过；主工程依赖 audit 为 0。它们不能证明没有业务缺陷或正式版达标。独立且未启用的 `tools/wechat-ci` 仍有 80 项上游告警；不得混称已解决。
- 当前原生包哈希 `cf5fe2fd9baadf7a71d8bdfb4629b832ddd44559739c2226d2199d402c83c791`；主包 1,397,190 字节，总源码包 2,131,112 字节。37 路由的完整状态验收、iOS 与 Android 真机仍未完成。历史截图不因文档更新而获得新适用范围。

## 2. 当前问题与具体修复合同

编号 `PERF-*` 是本报告的工程追踪编号，不冒充 PRD 验收 ID。P1 表示正式版前优先修复；P2 表示必须测量、按影响处理的风险。安全/业务不变量仍高于性能收益。

| 编号 / 优先级 | 定位与证据 | 用户影响 | 正确施工与验收 |
|---|---|---|---|
| PERF-01 / P1 | `pages/home/index.ts:140`，护理 bootstrap 与客服未读 `Promise.all`。复现：bootstrap 已返回，support 未返回时仍 `loading=true`、护理权威不可用 | 客服请求慢，连带拖住首页护理 | bootstrap 独立提交关键视图；未读独立 loading/unknown/error。所有结果绑定 session、loadAttempt、pageAlive；次要失败不能清空护理，也不能伪称未读为零。挂起 support 时护理可用；bootstrap 失败时护理写操作仍关闭 |
| PERF-02 / P1 | `pages/profile/index.ts:31–49`，资料等待权限、客服、商业资格，再等待头像。复现：商业请求挂起时会员资料不可见 | “我的”整页被次要区域拖住 | 资料/积分/护理由 bootstrap 一致快照一次提交；权限与商业入口独立状态、缺失时 fail-closed；头像先中性图后替换。测试各请求分别慢/失败、头像慢、退出/换号；任务区已有独立加载，不重复实现 |
| PERF-03 / P1 | `pages/home/index.ts:170`，游客选步骤调用会员 `homeView`。复现按钮从“授权身份并开始”变成“开始今日护理”，`needsAuthentication` 仍为 true | 所见动作与实际授权跳转不符 | visitorView 接受选中步骤但始终保留游客身份语义；onShow/刷新/分钟时钟/选步一致。游客可浏览且不自动跳走，点击主按钮再授权；覆盖取消和过期恢复。关联 PRD §5.4、CARE-01 |
| PERF-04 / P1 | `services/api/src/server.ts:99` 把 `API_ROUTE_DEADLINE_MS` 传给 `requestTimeout`。已安装 Fastify 5.12.3 对照：20ms requestTimeout 下 70ms handler 仍返回 200 | 不能据此保证业务处理有总期限；用户可能等到客户端超时 | 分开“接收请求期限”和“业务处理期限”；验证现有版本 `handlerTimeout/request.signal`，并把剩余时间传入依赖。对照显示 handlerTimeout 返回 503 后异步工作仍继续，不能只加一个配置就宣布取消成功。显式映射错误码，处理已提交但响应丢失的查询/幂等恢复 |
| PERF-05 / P1 | `services/api/src/db.ts:112–124` 回滚后先 backoff 再 finally release。合成冲突复现等待开始时连接未释放 | 并发冲突时额外占池，放大排队 | 回滚与释放完成后再退避；每次尝试单独获取、恰好释放一次；保留 40001/40P01 有界重试。测试连接失败、回滚失败、重试耗尽、取消以及单连接并发。回滚失败的连接不得作为健康连接返回池 |
| PERF-06 / P1 | `db.ts:100` deadline 只约束重试前等待；合成时间推进到 50ms，10ms deadline 仍提交成功 | “事务总期限”名不副实；多条 SQL/池等待可超预算 | 一个单调时钟绝对期限贯穿排队、每次尝试、SQL、退避、提交前检查；按剩余预算设置事务级 statement/lock timeout，验证所用 pg 版本真实取消能力。不能用裸 Promise.race 留下后台查询，也不能把提交后断连当成未执行；用幂等键查最终事实 |
| PERF-07 / P1 | `observability.ts:48` 最多 96 路由，达到上限静默不记录新路由；复现 97 路由仅保留 96。OpenAPI 有 206 路径 / 226 方法，其中 /v1 为 204 / 224 | 后加入或低频重要路径可能不在分路由报告中；同一路径不同方法混算 | method + 归一化路由模板为键；按静态路由表覆盖，未知模板有界 overflow 计数，不使用用户 ID/原始 URL。验证全清单覆盖与内存界限。当前 http_ms 在 onSend 记录，应标明计时边界并补完成/断开统计；识别实际 timeout 错误而非仅 408/504，避免漏掉 503 handler timeout |
| PERF-08 / P2 | `services/http.ts:36` 固定单次 12s；`api.ts:210` GET 最多重试一次，普通 request 未暴露取消句柄。静态确认，尚无端到端总耗时实测 | 部分网络失败重试延长等待；离页请求占用传输能力 | 建立交互级总预算与剩余时间，明确错误分类。并非所有超时都会重试：自建 NETWORK_TIMEOUT 与原生 request:fail 分支不同，应统一并测试。只重试批准的安全 GET；写操作依赖幂等/查询恢复。共享 GET 需要消费者引用计数，离开一页不能误取消另一页共用请求；Cloud HTTP 无物理 abort 时只保证逻辑取消并抑制晚回调 |
| PERF-09 / P2 | `services/api.ts:153` 对 capabilities/legal 有 5min fresh + 55min stale；coordinator 的后台刷新没有页面订阅。资料失败 fallback 为商业 none / 未读 0 | 可能晚显示权限撤销或把“未知”显示成“没有” | 按信息风险制定缓存合同；会话隔离、generation/tag 失效保留。权限/价格/库存/积分/护理资格不得凭旧缓存开放写操作，服务端每次校验。记录是 stale/updating/error，刷新成功的传播方式明确；不简单把 TTL 全部拉长 |
| PERF-10 / P2 | `pages/community/index.ts:142–166` 分页后发送累计 feed，再发送累计 feedColumns；头像转换有 Promise.all 等待。代码路径确认，卡顿未实测，公开 UGC 当前关闭 | 大列表可能重复跨逻辑层/视图层传输和增加内存 | 先测 30/100/300 条与图片加载下 setData 字节、次数、回调耗时、内存和滚动。先减少重复视图模型、路径增量更新、固定图片尺寸及懒加载；再按证据评估有界列表与滚动位置恢复。不能为测量开启生产 UGC |

定位以研究基线为准，下一轮先对最新 main 重定位。修复不能仅让复现脚本输出改变：必须写能覆盖正确行为、竞态与失败路径的正式回归测试。`reproduce.mjs` 是诊断记录，不是断言修复成功的 CI 门禁。

另有文档口径问题 `DOC-01`：旧 `NFR-MEASUREMENT.md` 的写接口 800ms 与可用性 99.5% 不符合现行 PRD §13；本轮已将附录改为当前基线与待签测量合同。`G0-DECISION-REGISTER.md` 是 8 月历史决策，含旧基础库、旧交易实现描述；下一轮对照实际实现逐项更新状态与证据，不能照旧文本删除已实现能力或把候选目标当签字承诺。

## 3. 用户旅程的延迟、卡点与交互合同

每页交付 `触发 → 前置状态 → 请求/本地动作 → 等待反馈 → 成功 → 失败/取消 → 恢复 → 无障碍 → 事件/验收 ID`，不是只有一张成功态截图。

| 旅程 | 优先处理 | 必验中断与恢复 |
|---|---|---|
| 游客首页 → 授权 | 本地静态护理内容先显示；授权只在显式动作触发；切步骤不改游客 CTA | 拒绝授权、登录失败、返回、401、换号；不得循环重定向 |
| 会员首页 → 开始周期 | 护理快照先于未读；planned 经过确认，提交时就地反馈 | 连点、弹窗取消、版本冲突、提交成功但响应丢失；不自动激活 |
| 00–03 → 感受 → 提交 → 记录 | 步骤切换即时本地反馈；提交明确“正在保存/结果待确认/已保存”，保存成功才能庆祝 | 断网、后台/前台、重复请求、离页晚响应；服务端顺序/归属/版本/幂等，记录回看分步事实和感受；旧记录明确缺项。关联 A20、CARE-01–04 |
| 我的/积分/商业资格 | 主身份资料独立可见；权限、商业、头像局部加载，金额不跳假数字 | 未知权限不显示可执行管理按钮；刷新失败可显示标注旧值但不能作为当前权威 |
| 商品 → 结算/订单 | 图片尺寸与缩略图，价格/库存/结算资格独立验证；禁用能力解释原因 | 价格变化、库存冲突、订单重复、付款结果未知；不以动画/缓存宣称付款成功。只测当前允许的合成或已授权环境 |
| 客服文字/图片 | 保留既有前后台轮询、退避、消息差量与输入状态；发送中气泡/失败重试明确 | 键盘顶起、安全区、滚动锚点、未读、传图中断、返回恢复；先测消息到达时间和轮询开销，再判断长连接必要性 |
| 社区/记录长列表 | 先可见内容，分页进度在尾部；图片不撑动布局；返回恢复位置 | 首屏空/错与“加载更多失败”区分，保留已有内容；筛选切换/离页旧响应不混入 |

统一视觉：沿用已接受的 CISME 配色、字体和间距；主 CTA 层级清楚，胶囊/顶部/底部/键盘安全区完整。按钮忙态只禁用冲突动作；不能整屏遮罩阻断查看、返回或安全取消。空态、无权限、网络错误必须语义不同。

动效建议是项目候选参数，不是 Apple/微信强制数值：按压反馈尽快且目标 ≤100ms；轻状态切换 120–180ms；Sheet/局部过渡 180–280ms，依据现有 300ms 退出合同协调修改，不能只改 CSS 留下定时器不一致。以 WXSS transform/opacity 或经当前基础库验证的平台能力实现，避免每帧 setData、全屏 blur、多重弹簧、拖慢内容出现的入场序列。支持减少动效，离页停止，点击/返回不等待装饰动画，成功反馈必须晚于权威提交。

## 4. 测量与服务器访问方案

### 4.1 先分解一条完整时间线

记录 `用户动作/启动 → 本地反馈 → 包/页面加载 → 请求排队 → DNS/TCP/TLS → 首字节 → 响应完成 → 数据加工 → setData 回调 → 关键内容可用`。客户端、服务端使用各自单调计时；不能直接相减两台机器的墙钟。

`wx.request` 的 profile 可在支持的平台获得网络阶段与连接复用信息；队列字段要求相应基础库（当前类型标注 3.8.10）。只记录字段实际存在时的合法差值，区分字段缺失与 0，避免 TCP 与 TLS 嵌套区间重复相加。当前 Cloud HTTP 路径没有同等 profile 时，分开报告“SDK 总耗时 + 服务端耗时”，不得伪造 DNS 分解。[微信 request 官方文档](https://developers.weixin.qq.com/miniprogram/dev/api/network/request/wx.request.html)

采样事件包含构建/包哈希、route 模板、场景、网络/设备/微信/基础库、冷热、样本数、缓存命中/陈旧、结果码、分阶段时长、payload 大小。服务端 request_id 保持服务器生成；如需前后端关联，用经验证的匿名操作 ID/响应 ID，不能信任任意外部 header。禁止记录 token、openid、手机号、聊天/护理正文、签名 URL。限制采样率、队列长度、保留期和离线缓存；埋点不能阻塞业务。

服务端已有 pool_wait/sql/storage/http 与安全日志。扩展到 method+route、超时/取消/重试、事件循环延迟、CPU/内存、连接池队列；多个实例分别标记后汇总，不能把各实例 P95 求平均。网络首字节时间含网络和排队，不直接等同 SQL 时间。

### 4.2 按瓶颈选择改法

| 测量结果 | 施工 | 验证/退出 |
|---|---|---|
| 主页面等待次要请求 | PERF-01/02，独立请求状态与关键快照 | 人为挂起辅助请求，关键内容按时可用；权限仍关闭 |
| DNS/TLS/连接建立占比高 | 核对国内实际部署区域、API/DB/对象存储距离、合法域名、TLS 链、连接复用、代理超时；对 HTTP/2 做实机对照 | profile 证明连接复用/协议与收益；不盲开 QUIC/HttpDNS、不假设已配置。带身份响应不放公共 CDN |
| pool_wait 或锁等待高 | 先修连接释放/超时，优化事务长度；API/worker/运维连接总预算按实例数计算 | 同一数据集与并发重测 p95/p99、队列、重试及业务一致性；不直接无限扩池 |
| SQL 慢 | 取 top 路由实际 SQL，在合成隔离库用 EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)，关注计划/扫描行/排序/锁、N+1 | 用代表性数据规模；ANALYZE 会执行语句，写语句不得在真实库盲跑；索引迁移与回滚评估保留证据。[PostgreSQL 文档](https://www.postgresql.org/docs/current/using-explain.html) |
| 媒体慢 | 复用已存在的缩略图/压缩/头像本地缓存；首屏尺寸匹配、固定容器、按需加载；核对 CDN 命中与鉴权边界 | 私有客服/投稿媒体不公开缓存；过期签名、取消、重试、对象校验均测试 |
| 上传中继成为瓶颈 | 复用已实现但关闭的 COS 直传开关，先核对桶/权限/域名/签名/禁止覆盖/完成校验/清理 | 获得 staging/真机证据后才按部署授权启用，保留 512KiB 中继回退；断点体验不得冒称已有字节级断点续传 |
| 渲染/滚动慢 | setData 只发送必要变化、减少重复模型与不可见更新，图片优化；必要时列表窗口化 | 真机记录 setData 字节与时长、滚动掉帧、内存、返回位置；虚拟列表不是先决依赖。[微信 setData 官方指南](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/tips/runtime_setData.html) |
| 冷启动/分包慢 | 复用 requiredComponents、既有分包；只按高频下一步入口评估有限预加载 | 比较首次安装、冷启、热回访；不预加载全部 33 子包。app.wxss 当前 8,137/8,192 字节，新增样式局部化而非直接抬预算 |

超时合同：当前默认 DB statement 2.5s、事务 4s、API 配置 8s、客户端单次 12s，只是上限配置，不是性能目标，且两项上限语义存在上述缺陷。下一轮先修合同再按测量设值：正常核心 API 仍须达到 PRD P95≤500ms。必须对多次尝试给出一个用户动作总预算，上传/大导出单独分类，不把所有请求都缩到一个激进数值。

### 4.3 统一验收口径

现行 PRD §13 与 NFR-01–04 是权威：核心 API P95≤500ms，核心页面可交互 P95≤2s（不含第三方支付/媒体上传）；容量覆盖 G0 高档并保留 30% 余量。99.9% 是有条件的月可用性候选目标，不是已有 SLA。

G0 附录需明确核心路由/方法/数据集、地域、网络、机型、微信/基础库、启动状态、样本数、并发/QPS、统计窗口和负责人。缺少正式环境或签字时继续合成修复与可执行准备，不能声称正式验收结束或悄悄放宽门槛。

建议采样方案（待纳入 G0）：每个“机型×网络×冷热×核心旅程”不少于 100 次有效动作，API 每核心场景不少于 1,000 次，另做稳定负载与阶梯增压；样本不足时只报原始数及探索性分位数。只在受控 staging/合成数据上压测，设置停止阈值。区分正常网络的 2s 门槛和 PRD 至少 400ms RTT、5% 丢包的弱网韧性测试；弱网重点验证及时反馈、可恢复、无重复写入，并报告实际延迟，不能通过混合样本稀释问题。

本机 `perf:smoke` 使用 `app.inject`，适合业务/SQL回归，**不含公网 DNS/TLS/真实传输/真机渲染**。`perf:capacity`、`perf:worker-capacity` 也须标注运行模型。GitHub hosted runner 不代表中国用户网络；最终需要合法域名下的体验版和获授权 iOS/Android 实测。沿用已有脚本，缺少真实 HTTP 场景时再增加受控驱动器。

## 5. 用户提供资源与 GitHub 选型

采用规则：先回答解决哪项缺陷，再看平台兼容、维护、许可证、依赖成本、测量收益和回滚；固定版本/提交并更新 SBOM/许可证。公开仓库不自动代表可复制所有素材或运行代码。以下均为研究结论，没有安装动作。

| 资源 | 核查结果 / 本项目选择 |
|---|---|
| [Apple Design](https://developer.apple.com/design/) / [Loading](https://developer.apple.com/design/human-interface-guidelines/loading) / [Motion](https://developer.apple.com/design/human-interface-guidelines/motion) / [Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators) | 采纳渐进显示、不中断其他操作、真实进度、克制可取消的反馈；微信原生规则优先。UIKit/SwiftUI/Liquid Glass 不能直接作为本项目实现；不照搬 iOS 导航栏与玻璃效果 |
| [Appllama Skills](https://github.com/Appllama/appllama-skills/tree/dd5caaec3d5d50ad7fc0324da238119c6b7c3707) | MIT，设计 Skill v1.3.0 明确以 Expo/React Native、Reanimated 为背景。借鉴先研究真实流程、语义色、导航与全流程录像验证；不引入其运行栈。MCP 案例查询另需连接/账户额度，本轮未调用，也未声称看过其案例。现有移动 UX Skill 已可执行本项目主流程，无需重叠安装 |
| [GSAP Skills](https://github.com/greensock/gsap-skills/tree/aed9cfd3277740755f6bfc1155c7aa645403b760) | Skills MIT；检查 performance Skill，涉及 DOM/CSS/ScrollTrigger/鼠标等。只借鉴 transform/opacity、减少同时动画等原则。GSAP 可驱动对象数值，但不能因此推断 DOM 插件适配 WXML；逐帧桥接 setData 反而可能卡顿。当前不引入 GSAP，Skills 许可证也不代替运行库许可核查 |
| [Mobbin](https://mobbin.com/) | 产品流程/界面参考库，不是运行库或自动可用 Skill。本轮核查公开站点，未访问登录后的具体流程。后续若有合法访问，研究授权、分步任务、客服、结算 3–5 组完整流程，记录链接/日期/采用与拒绝原因；没有访问就用官方案例，不编造“已研究某 App”，不复制素材 |
| [Transitions.dev Skill](https://transitions.dev/skill.html) / [固定提交](https://github.com/Jakubantalik/transitions.dev/tree/598d3d6ad89dabb4bdf742fd2e887ca53914a888) | 定位 Web 动效，公开 Skill 列出骨架/弹层/状态切换等配方。仅借鉴动作目的和节奏，用 WXSS 原生翻译；不采用 hover/光标、3D tilt、模糊文字与装饰循环。GitHub 未识别到根许可证，Pro 资源另有访问条件；复制代码前逐文件核对许可，本轮不导入 |
| [微信 miniprogram-demo](https://github.com/wechat-miniprogram/miniprogram-demo/tree/0fe5c7df8e90582dd0b89e283df7fe32e04413f9) | 官方 MIT 示例，默认分支最新提交 2026-09-03。优先查原生组件、网络、动画/生命周期用法；摘取与当前基础库兼容的最小示例，不复制整个项目 |
| [微信 api-typings](https://github.com/wechat-miniprogram/api-typings) | 官方 MIT；项目已装 5.2.3。直接复用 request profile / performance 等类型，运行时仍做支持检查；类型存在不代表用户基础库一定支持 |
| [Fastify](https://github.com/fastify/fastify) / [node-postgres](https://github.com/brianc/node-postgres) | 现有主依赖，优先查已锁版本文档/测试修 PERF-04–07，无需另建后端框架。Fastify [超时文档](https://fastify.dev/docs/latest/Reference/Server/#handlertimeout)明确协作取消；pg [池文档](https://node-postgres.com/features/pooling)要求归还连接。示例中的 signal 不得不经验证就套到当前 pg 接口 |
| [OpenTelemetry JS](https://github.com/open-telemetry/opentelemetry-js/tree/66c04030f8f2cb9c1a05e8dcf63c2ba52ffdc1da) | Apache-2.0，候选用于服务端跨依赖追踪，先补现有有界指标与关联 ID。只有定位困难得到证据才引入 Node SDK/少量 instrumentation；采样、脱敏、导出故障、开销须验证。不把浏览器 SDK 塞进小程序，不默认向外部 SaaS 发送数据 |
| [k6](https://github.com/grafana/k6/tree/3fcf5388d78cb382f0c0d42ec556a06bfd1b8dee) | AGPL-3.0，备选独立测试工具；只有需要固定到达率、复杂真实 HTTP 场景/阈值时引入。复用现有数据和断言，固定工具版本，不进入小程序运行包；不把 k6 browser 结果当微信实测 |
| [autocannon](https://github.com/mcollina/autocannon/tree/9d645c3ba48bade008f1785991b2c660e0be3b15) | MIT，简单 HTTP/1.1 压测备选；不能验证小程序 UI、HTTP/2 或真实移动网络。与 k6 按场景二选一，当前脚本够用时两者均不新增 |
| [微信 recycle-view](https://github.com/wechat-miniprogram/recycle-view/tree/70a5b5af37c52ad4263d40bb9d5e2b48a7484ced) | MIT、未归档，但默认分支最后提交为 2019-10-08（push 时间与代码提交时间不同）。只做长列表方案比较，当前不采用；先局部增量/有界列表，确有需要再验证基础库、滚动锚点、动态图片高度、无障碍和维护成本 |

不以 star 数、营销用语或“百万美元设计”作为选型证据。服务端平滑来自可测量的关键路径、连接/事务/缓存/媒体策略；动效只能改善反馈，不能消除服务器等待。

## 6. Skills 执行分工

| 阶段 | Skill | 必须产出 |
|---|---|---|
| 原生能力/调试/构建 | `miniprogram-development` | 平台适配、基础库能力探测、路由/分包、开发者工具与真机验收脚本；本机来源 `~/.codex/skills/miniprogram-development/SKILL.md` |
| 页面状态/交互主设计 | `mobile-ui-ux-designer` | 逐页 interaction contract、状态与中断恢复、键盘/安全区/无障碍、渐进加载和动效目的；本机同名目录 |
| 视觉复核 | `design-taste-frontend` | 在既有品牌与原生约束内审版式、字号、间距、层级；不引入其 Web 技术栈 |
| 一个完整流程完成后 | `mobile-app-ux-auditor` | loading/empty/error/interruption/resume/navigation/accessibility 阶段审计与严重度；不是常驻替代前述设计链 |

执行优先级：PRD 与业务事实 → 微信原生 → mobile-ui-ux-designer → design-taste-frontend → 开发者工具/真机。Apple、Mobbin 是参考资料；Appllama/Transitions/GSAP 是外部候选知识源，不是本项目必装项。云端环境没有本地 Skills 时如实说明并按仓库合同继续编码/测试，不声称已调用；不得因“读 Skill”覆盖用户已授权范围或项目规则。

## 7. 下一轮施工分段与交付

1. **A：基线与测量合同。** 最新 main/Actions、PRD、当前证据、独立依赖风险复核；复现 PERF-01–10，修正过期文档；定义 NFR 计时/数据/机型与业务不变量。先提交缺陷清单和回归，不无依据扩范围。
2. **B：用户主路径。** PERF-01/02/03/09 的加载与未知状态；保留游客首页、planned 显式激活、四步和感受服务端事实。单一请求慢、所有失败、晚到/换号/隐藏恢复都要通过。此阶段必须完成，不能只加骨架图。
3. **C：超时与服务端。** PERF-04/05/06/07/08；端到端预算、协作取消、释放与回滚、错误/幂等恢复、完整可观测。通过隔离数据库并发/故障测试，写操作最终结果不含糊。
4. **D：测得慢点后的优化。** 网络、SQL、媒体、分包、列表、客服轮询按实测排序；每项一份同环境前后对照。没有足够数据的高复杂度方案保留为待验证，不提交猜测性架构改造。
5. **E：原生 UI/UX 打磨与验收。** 完整旅程录屏和全状态矩阵，紧凑/较大屏、字体变化、iOS/Android、正常/弱网/离线、中断恢复。新包新哈希，旧证据保留来源；用户使用开发者工具时不抢占页面。
6. **F：GitHub 交付。** 分支来自最新 main，按可审查修复提交/PR；通过必需检查后按授权合并、同步唯一工程，不强推不覆盖他人改动。输出修复映射、指标前后对照、回滚、剩余外部阻碍及准确 releaseReady。没有真机/域名/资质/真实链路证据就保持对应门禁关闭，源码与合成测试可以继续完成。

完整可复制施工提示词见 [CHATGPT-GITHUB-NEXT-PROMPT.md](CHATGPT-GITHUB-NEXT-PROMPT.md)。本报告不会授予真实支付、退款、转账、公开 UGC、正式隐私删除或发布上线的额外授权。

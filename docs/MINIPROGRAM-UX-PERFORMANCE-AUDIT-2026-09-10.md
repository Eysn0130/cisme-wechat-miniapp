# CISME 原生小程序用户体感性能专项审计

日期：2026-09-10  
范围：`apps/miniprogram` 当前 `app.json` 声明的全部 16 个真实路由、公共请求协调器、原生传输、图片与包边界。  
证据等级：源码、自动化测试与本地包体测量。未打开微信开发者工具，未生成预览，未上传小程序，未操作生产。

## 结论

当前代码已具备请求去重、短 TTL/SWR、会话隔离、12 秒传输上限、页面轮次防迟到回写和 4 主包页 + 12 分包页的基本性能边界。本轮修复了 SWR 后台刷新对后续读者的阻塞、微信标准网络失败未重试、社区/隐私页过期回调、Profile 次要请求瀑布，以及 Community 重复桥接列表和卡片图片首屏外解码问题。

但“中端机 + 4G，关键内容 p95 ≤ 2.5 秒”仍为 **UNVERIFIED**。仓库内没有当前源码哈希对应的真机 Performance/Network 轨迹、4G 网络条件记录、连续重复轮次或 iOS/Android 双端数据；单元测试、服务端延迟和开发者工具模拟均不能替代这个用户体验 SLO。

## 本轮可复核修复

| 修复 | 代码证据 | 用户体感影响 |
| --- | --- | --- |
| SWR 后台刷新期间所有读者继续获得 stale 值，只保留一个后台刷新 | `services/request-coordinator.ts` | 避免同一页面的第二个读者被后台刷新 Promise 阻塞 |
| 识别微信原生失败对象的 `errMsg: request:fail…`，只对 GET 做一次短抖动重试 | `services/api.ts` | 短暂网络抖动不再直接进入错误态；写请求仍不自动重试 |
| `requestCancelable` 补齐会话切换拒绝、401 当前会话处理和登录回源；直接 `wx.request` 可真实 `abort` | `services/api.ts` | 防止未来接入取消句柄时把旧会员成功响应交给新会话 |
| Profile 的任务历史与 profile bootstrap 并行启动 | `pages/profile/index.ts` | 去掉“快照 → 本地头像落盘 → 任务列表”的串行等待 |
| Community 用一次遍历构造双列，只向视图层传 `displayFeedCount + feedColumns`，不再重复传完整 `displayFeed`；卡片图和头像启用懒加载 | `pages/community/index.ts/.wxml` | 降低列表 `setData` 序列化、桥接和首屏外图片解码成本 |
| Community 审核/发布/关注/任务列表补齐 token + attempt 校验；Privacy Rights 在 hide 时废弃读轮次 | `pages/community/index.ts`、`pages/privacy-rights/index.ts` | 切账号、离页或返回时，旧请求不再覆盖新状态 |

## 16 路由逐页审计

| 路由 | 访问 / 包 | 首屏数据与生命周期 | 迟到响应 / 取消 | `setData`、图片、分页结论 |
| --- | --- | --- | --- | --- |
| `pages/home/index` | public / main | `onShow` 单次 `/v1/bootstrap/home`；游客本地 CTA 立即可见；同会话热返保留快照再校验 | `loadAttempt` + `businessVersion`；无传输 abort | 背景 JPG 97,112 B；每分钟才更新日时段；无列表分页。代码良好，真机关键内容时刻未测 |
| `pages/records/index` | member / main | `onShow` 单次 `/v1/me/care`；下拉刷新；同会话快照保留，鉴权失败清空 | `loadAttempt`；无传输 abort | 视图每次只展开 3 个周期，但 API 默认最多返回 20 个历史周期且忽略 `nextCursor`，20 个之后不可达，P1 |
| `pages/community/index` | public / main | 本地品牌精选立即存在；capabilities、公开 feed、会员 tasks 并行；会员 access/follows 在 capabilities 后读取 | token + `feedAttempt/tasksAttempt`；本轮补全审核与列表守卫；无传输 abort | 双列一次构造、无重复完整列表、卡片图懒加载；推荐/关注各只取 30 条且忽略 `nextCursor`，P1 |
| `pages/profile/index` | member / main | `/v1/bootstrap/profile` 与 `/v1/me/tasks` 本轮改为并行；头像 data URL 先落本地文件再传路径 | `loadAttempt/tasksAttempt` + token；无传输 abort | 主要快照一次桥接；任务接口无 cursor 契约。关键内容 p95 未测 |
| `pages/account/index` | public / `pages/account` | legal 与 identity capabilities 并行；登录中的 `wx.login → identity → optional phone → member/avatar` 是依赖性串行 | `authAttempt/legalAttempt/capabilityAttempt` + token；身份写不主动 abort | 头像只传本地路径；无分页。串行身份链需要真机微信授权数据，UNVERIFIED |
| `pages/task/index` | member / `pages/task` | 单次任务读；claim 失败后主动重读权威状态 | `loadAttempt`；写请求不 abort，使用幂等键与离页保护 | 小对象；无图片大载荷、无分页。弱网领取恢复待真机 |
| `pages/submit/index` | member / `pages/submit` | 单次草稿读；650 ms 草稿保存；上传严格串行 authorize → bytes/chunks → complete → reload | load/upload revision 防迟到；上传没有底层统一 abort，离页仅废弃结果 | 输入一次 `setData` 后又刷新 `canSubmit`，属于低端机桥接 P2；10 MiB 上限；相册/相机/断网 UNVERIFIED |
| `pages/progress/index` | member / `pages/progress` | 单次投稿状态读；申诉后重读 | `loadAttempt`；幂等申诉，无传输 abort | 小对象、无分页；弱网申诉结果恢复待真机 |
| `pages/points/index` | member / `pages/points` | 单次 `/v1/me/points` | `loadAttempt`；无 abort | API 默认 50 条并返回 `nextCursor`，客户端未继续加载，P1 |
| `pages/post/index` | public / `pages/post` | 品牌内容本地立即呈现；UGC 单次详情读；社交区先 capabilities 再 comments，分享异步不阻塞正文 | `loadAttempt` + 中央 token；无 abort | 本地图库最多 3 图；评论默认 20 条且忽略 `nextCursor/truncated`，P1；社交 capability → comments 是可由 bootstrap 消除的 P2 瀑布 |
| `pages/shop/index` | public / `pages/shop` | 单次公共 catalog，SWR 可复用 | `loadAttempt`；无 abort | 小目录整体渲染，无 cursor 契约；首屏 hero 不懒加载是合理取舍 |
| `pages/product/index` | public / `pages/product` | 单次公共 catalog 后本地选中 SKU；分享链接异步 | `loadAttempt`；observer unload 断开；无请求 abort | 3 张本地图库；非首屏 swiper 图片尚未按索引延迟挂载，P2 |
| `pages/settings/index` | member / `pages/settings` | settings bootstrap 与 addresses 并行；头像仅在 profile 快照返回后落盘 | token + 多类 attempt；保留编辑态；无统一读 abort | 表单逐键写视图、地址草稿落 storage，低端机需测；地址集合有业务上限，无 cursor 需求 |
| `pages/invite/index` | member / `pages/invite` | member 与 share history 并行 | `attempt`；无 abort | 只展示前 5 条；接口未暴露 cursor，历史增长策略需服务端合同确认，P2 |
| `pages/legal/index` | public / `pages/legal` | 单次缓存公共 legal 读 | `alive`；无 session 数据、无 abort | 长正文一次传给视图，需大字号/长文档滚动实测；无分页 |
| `pages/privacy-rights/index` | public shell / `pages/privacy-rights` | 游客无请求；会员单次记录读，提交后重读 | 本轮新增 hide 废弃、attempt + token 完整守卫；无 abort | 记录列表无 cursor；长期记录增长为 P2 合同缺口 |

## 横切审计

### 请求、SWR 与弱网

- GET key 包含 API origin、Cloud Function、session token、完整 options；公共读或旧账号缓存不能命中新会员。
- catalog/capabilities/legal 使用 5 分钟 fresh + 55 分钟 stale；feed 使用 5 秒 fresh + 15 秒 stale；bootstrap/member 使用 1.5 秒 fresh、不保 stale。
- 写前后按 domain tag 失效；旧 pending 完成不会删除或覆盖新 generation。
- 直接 HTTPS 与 Cloud HTTP 都有 12 秒客户端上限；迟到回调被一次性 settled 门忽略。
- GET 对 502/503、`NETWORK_ERROR` 和微信 `request:fail` 最多重试一次，等待 40–120 ms；POST/PUT/DELETE 不自动重试。
- 12 秒上限是“可恢复上限”，不是 2.5 秒用户体验 SLO。当前没有 4G 丢包、DNS、TLS、云函数冷启动或弱信号下的真机分位数。

### Abort 与后台请求

`requestCancelable` 在直接 `wx.request` 路径会调用原生 task `abort()`；Cloud HTTP SDK 没有可用 abort 句柄，只能在客户端立即结算为取消并忽略迟到回调。当前 16 个路由仍统一使用带去重/SWR 的 `request()`，没有页面接入取消句柄。因此离页会依靠 attempt/token 阻止回写，但底层读可能继续占用网络到完成或 12 秒超时。

这不是当前数据正确性缺陷，但仍是电量、连接槽和快速切页场景的 P1 性能缺口。下一步应先让 RequestCoordinator 支持“多订阅者 + 最后订阅者离开才 abort”，再按页面 scope 接入；不能直接把全部读替换成 `requestCancelable`，否则会丢失去重与 SWR。

### 图片与包边界

- 资源总量 1,077,181 B；所有单文件都低于项目 200,000 B 门禁。
- 内容 JPG 为 97,112–140,182 B；6 个头像 JPG 为 16,517–20,245 B。会员 data URL 不直接进入 `setData`，而是写入 `USER_DATA_PATH` 后仅传本地路径。
- Community 长列表卡片本轮启用 lazy-load；Home 背景、Shop hero 等首屏关键图保持立即加载。
- 所有图片仍位于主包公共 `/assets`，因此 12 个页面分包只隔离代码和页面样式，不隔离这些公共素材。主包尚在预算内，但新增素材前必须继续跑包体门禁。

### 分包与路由

`app.json` 实际声明 4 个主包 Tab 路由和 12 个普通分包路由，共 16 路由。`lazyCodeLoading` 为 `requiredComponents`。本轮包体门禁测得：总源码包 1,588,761 B，主包 1,327,531 B；最大分包 `pages/settings` 66,031 B，均低于项目内部 1.8 MB / 400 KB 门禁，source SHA-256 为 `ca6f1043fe340439f0295122297f8942e69c79aaca92d59456f724bb763a7a1a`。

## 用户体验 SLO 与真机采集门槛

目标：中端机 + 4G 下，关键内容 p95 ≤ 2.5 秒。关键内容建议按路由定义，不以 loading 消失替代：Home 为可操作的护理状态/游客 CTA；Community 为首组可读卡片；Profile 为会员名 + 护理 + 积分；Task/Submit/Progress 为可判断下一步的权威状态；Records 为当前周期和首组记录。

发布前最少采集：

1. 固定一台中端 iOS 与一台中端 Android，记录机型、OS、微信版本、基础库、包哈希。
2. 每个关键路由冷启动与热返回各至少 30 轮；4G 使用真实蜂窝网络并记录运营商/信号，另做可复现的弱网丢包场景。
3. 以页面 `onShow`/用户点击为起点，以关键内容稳定可读且关键按钮状态确定为终点；输出 p50/p95/max 和失败率。
4. 同时采集 Network 请求排队、DNS/TLS/TTFB/下载、Cloud Function 冷启动、图片解码与长任务；不得用服务端 p95 推导页面 p95。
5. 覆盖快速 Tab 切换、切账号、后台恢复、重试、滚动到底、分页续取、图片失败、相册/相机拒绝和上传中断。

截至本文日期，上述真机/4G项目全部为 **UNVERIFIED**。

## 自动化证据

- 本专项新增与关联的请求/页面/路由断言：83/83 passed。
- 全量 unit：31 files、225/225 passed。首次复跑曾暴露源码哈希证据清单需重绑，以及一次将客户端 12 秒上限误纳入重试的偏差；两者均已修正并重新全量通过。
- TypeScript（服务端 + 小程序）：passed。
- 小程序包体门禁：passed，16 routes，4 main + 12 subpackages；最终 source SHA-256 以 `current-source-acceptance.json` 为准。

## 未关闭项

1. **P0 / 发布证据**：中端机 + 4G p95、iOS/Android、当前哈希全路由状态与 Network 均 UNVERIFIED。
2. **P1 / 分页**：Records、Community feed/following、Points、Post comments 均忽略服务端稳定 `nextCursor`；必须实现追加、去重、并发锁、错误恢复和 session/attempt 保护。
3. **P1 / 真正取消**：页面 scope 尚未接入 RequestCoordinator 的多订阅者 abort；快速切页只阻止回写，不停止底层流量。
4. **P2 / 桥接**：Submit/Settings 的逐键输入仍有重复 `setData` 或同步 storage 工作，需以低端机长任务证据决定是否合并/节流。
5. **P2 / 图片**：Product 的非当前 swiper 图、Review 队列头像仍可进一步按可见性延迟，但必须先用真机解码/闪烁证据验证收益。

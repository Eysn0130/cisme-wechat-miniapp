# CISME 接管执行计划

目标：原生消费者端与真实服务闭环，经正式账号、公网 HTTPS、体验成员与 iOS/Android 验证后交付团队体验版。当前交付阻断，等待正式账号/公网/设备输入；未达到验收候选。

## 阶段及退出标准

| 阶段 | 工作 | 退出标准与证据 | 当前状态 |
|---|---|---|---|
| 0 现状核验 | 完整读取约束/PRD/范围/手册/manifest；保护未提交资产；技能与依赖来源审查 | 新源码包摘要、工作区清单、工具/服务与外部输入清单 | 进行中 |
| 1 全局根因 | 字体/button/reset、native chrome、scroll/tabbar、auth/API/navigation | 代码发现有明确位置；集中修复及适当回归测试 | 三个 Luna Max 因账户额度停止；主代理继续 |
| 2 逐页闭环 | Account → Community/Post → Home → Records → Profile → Task → Submit → Progress → Points → Shop/Product → Settings | 每页同设备/状态 Web 与 DevTools 新截图、动作/API证据；集中修复后当前源码复验；外部不可验证态明确 blocked | Account 勾选态/返回动作已复验；exact frame 与等价视觉矩阵仍 blocked |
| 3 业务与工程 | 身份/护理/邀请/上传/审核/账本/权限/幂等；隔离集成/build/audit/package/编译 | 实际执行日志；无用假成功；范围开关符合裁决 | 77 单元 + 26 隔离集成通过；类型/契约通过；继续逐页核验 |
| 4 真实团队交付 | 正式 AppID/角色、稳定公网服务/媒体/域名/隐私、上传开发版设体验版、成员扫码 | AppID/version/source/device/evidence 绑定，iOS+Android 移动网络闭环，P0/P1清零 | 外部配置待核实；不购买、不正式发布 |

## 当前核验

- 原生工作区 164 项未提交变更；无 Git remote。Web 工作区干净。禁止 reset/覆盖/清理资产/自动提交。
- 两项目范围内只发现 Web AGENTS.md，已完整读；原生根没有 AGENTS.md。
- Node v24.14.0；已安装官方 DevTools RC 2.02.2608031；本地 API 3100 在监听，健康与运行配置仍待验证。
- 首次重算包：129 files / 13 routes / 1,545,992 bytes / global WXSS 8,117 bytes；SHA-256 c0235b7f6fcda0a8928d5e42451a3becdf0fd8670dbc96881b8a3e2624bacef0。
- 现有 manifest 绑定 405ae15c…，与当前源码不同，旧图不得作为本轮源码验收。旧文档测试数量与真机描述互有出入，均不继承。
- Product Design index、user-context preflight、audit、image-to-code、design-qa 已读取；无持久用户上下文。冻结 Web/既有品牌资产优先，保留原生架构。
- Taste 已从 Leonxlnx/taste-skill 固定提交 ccbc15639c97057cbfcf32ecebc38ef716e4bb37 安装为个人 design-taste-frontend，MIT。仅作为适用的辅助建议；其 native/multi-step 限制及 React 默认不得覆盖冻结 Web 与原生架构。

## 证据规则

新证据按本轮目录记录，区分 exact page-frame 与全窗口诊断。只有重新截图/复验才能绑定变更后的源码。所有自动化夹具显式标记 local/test，不能证明真实身份、上传、支付或硬件。最终 QA 只用 passed / blocked；阶段记录不是交付签字。

## 2026-09-08 本轮实测更新

- 当前原生 SHA-256：7bbb0a92cfa52241fef7b4cc74b5d7864df31a0e9186cf0c3b62dc7a04fceffe；129 files / 13 routes / 1,546,267 bytes。
- Account：修复并发返回/浏览导致重复导航；请求已提交但响应丢失时，不再断言服务端未创建身份。新增行为测试覆盖两者。
- DevTools 复验：本地协议夹具未勾选禁用、勾选可用；点击返回回到 Home 未认证提示，不立即重开 Account。截图只证明本地模拟器行为，不代表微信真实身份核验。
- fastify 升级至 5.12.3，fast-uri 更新至修复版本；本轮 npm audit 0。构建通过。
- 分享归因集成测试统一显式测试时钟，避免固定创建日期与系统日期混用导致分享过期。
- 26 项集成测试使用本轮新建 cisme_takeover_20260908；迁移测试每次创建随机独立库，仅清理本次创建的库，不再先删除共享名称的数据库。
- 77 项单元测试、类型检查、15 migrations / 29 tables / 23 paths / 15 events 契约检查通过。
- 验收测试夹具不再依赖真实 manifest 的 DevTools 完成度。旧 405ae15c manifest 原样归档；新 manifest 只绑定本轮当前源码的 Account/Home 诊断图，结构检查通过、releaseReady=false。
- 全窗口截图经工具缩放至 966×768，即使模拟器显示 100%，也不作为 375×812 exact page-frame。01/03 是修改前源码 c0235b7f 的历史诊断；02 是冻结 Web 参考；04–06 属于 7bbb0a92。本轮误标 .png 的 JPEG 仅更正扩展名，未修改图片字节。
- 正式 AppID、自有公网部署与域名、正式法务和真实设备证据仍缺；未上传体验版、未生成新的团队体验二维码。

- 继续实测：游客 Community 在合法域名请求被拒绝时保留明确错误和品牌内容；品牌 Post 可打开并返回，返回后社区控件重新可用。
- 新证据 07/09/10/11 已加入当前 manifest：原生构建成功，但控制台 6 errors / 4 warnings，观察到本地 API 合法域名拒绝。`/health/ready` 与 `/v1/feed` 的 CLI HTTP 200 不代替模拟器 Network 通过。
- DevTools 网络相关流程阻断，未关闭域名校验。正式 HTTPS 域名配置前不声称真实身份、投稿或上传已走通。


## UGC 媒体真实性修复

源码更新为 `e72d83e163585bd44dbf699bb5481ba2c5303fdbaa8a6a243da872dafa9659be`（129 files / 13 routes / 1,546,500 bytes）。社区与详情不再给服务端投稿附加本地人物头像和品牌封面；无授权媒体 URL 时不渲染图片，冻结品牌素材未改。新增一项行为测试同时覆盖两页，针对性 15 项通过、类型检查通过。真实受控媒体 URL/作者展示 DTO 仍未完成，不能据此开启 UGC。7bbb0a92 证据已原样归档，未重绑定新源码；当前视觉矩阵待重新采集。


## Post 返回串行化修复

详情页原先每次点击都调用 navigateBack，可能连续弹出多层页面。现在返回期间锁定两个返回入口；回退到社区也失败时解锁并提示重试，卸载后回调不再启动导航。新增测试覆盖重复点击、回退中点击和双路径失败恢复，针对性 16 项通过，类型与包检查通过。

最新源码 `dcf9e35de85768b37b8236a166bf7aba6baf65644a2cc5c0d58152bff9a5d3ee`（1,547,008 bytes）。e72d83e1 截图与 manifest 已归档，未冒充最新源码证据；最新视觉复验待采集。其余页面返回路径尚在审核，不能将这项单页修复扩大为全站导航通过。

返回按钮同步使用既有 control--disabled 视觉样式。全量测试发现并修正一项静态生命周期断言与禁用样式检查。


## Product / Task / Settings 返回审核

三个页面补齐重复返回锁定、卸载后回调检查、所有回退失败后恢复重试。Task 返回社区与返回来源共享锁定，领取/继续投稿在离开期间不再启动；Settings 离开期间不启动退出或撤回请求。新增三项参数化行为测试验证重复点击、回退链和失败恢复；相关 48 项检查通过。

最新源码 `65d2b7d9e7458eb473825cf6ecf876d5fc0722372c8adba80587d4eac6db74a1`，129 files / 13 routes / 1,548,872 bytes。没有将旧截图重绑定到这个版本。逐页视觉、合法域名下的业务 Network 和硬件矩阵仍未通过。


## 正式账号目标绑定检查

体验版预检实跑仍失败：HTTPS origin、隐私指引、法务、合法域名、体验范围、成员与视觉/真机证据缺失。另发现未设置 WECHAT_APP_ID 时仅验证项目 AppID 语法，无法阻止误用当前测试账号。现在非 local 预检必须提供有效目标 AppID，并与项目一致；此检查只建立目标匹配，不证明账号权属或开发角色。原生源码未改变。

最新 65d2b7d9 的 Account、Community、Post 全窗口诊断已采集为13–15并加入manifest。游客入口可打开社区，当前编译后首次社区请求仍被合法域名校验拒绝（Console1 error/2 warnings），品牌详情可读。没有把这组图作为完整视觉矩阵或真实UGC证明。


## 交付阻断核对（本次接管暂停点）

连续多轮预检与 DevTools 实测均确认同一外部条件缺失，没有收到新的正式 AppID、可用 HTTPS 部署目标或设备证据。最新检查中 preview/trial/release origin 仍为空，approvedLegalDocumentVersions 仍为 null。冻结 Web 工作区仍无变更。

| 要求 | 现有证据 | 未完成部分与恢复条件 |
|---|---|---|
| 保留原生与冻结视觉来源 | Web git status 干净；原生129文件/13路由包检查通过 | 全部13页等价状态、尺寸与视觉比较尚未完成；当前全窗口图不能代替 exact page-frame |
| 原生操作正确性 | 83单元测试；已观察身份页游客退出、社区/品牌详情 | 真实身份后各业务态、键盘/长文/弱网需在可用正式联调环境与设备补验 |
| 后端与工程闭环 | 26隔离集成测试；类型、构建、契约与此前audit0 | 本地测试不证明生产部署、真实身份、真实媒体存储或业务签字 |
| 当前源码证据 | 65d2b7d9 manifest结构有效，13–15为新图 | releaseReady=false；缺当前完整编译/Console/Network分类与设备矩阵 |
| 正式账号 | 目标AppID强制匹配检查已实施 | 需要正式AppID及项目角色证明；不能把接口测试账号当正式账号 |
| 稳定公网与合法域名 | CLI本地API响应；DevTools明确拒绝本地request域名 | 需要用户指定已拥有的部署目标、自有域名、HTTPS及后台allowlist配置 |
| 法务与试用范围 | 开关保持关闭；本地内容明确标记夹具 | 需批准文本、隐私指引、试用范围与品牌权属证据；不由代理虚构签字 |
| 团队扫码交付 | 无本轮体验版上传、无本轮团队二维码 | 上述条件满足后继续上传体验版、核验成员并完成iOS/Android移动网络闭环 |

这不是完成声明，也不表示所有内部验收已通过。下一次恢复保留完整目标，先核实新输入，再完成尚缺的逐页及硬件验收；不通过增加本地模拟或重用旧证据来替代真实交付。需要用户先提供的非敏感信息为：正式 AppID、已有部署目标/自有域名（没有则说明没有）、可参与的 iOS/Android 测试设备。无需在聊天中发送密钥。


## 用户补充正式 AppID

用户提供 `wx4eac2d4fb11d299b`，对应原始 ID `gh_af14af2f2ad3`。已替换 project.config.json 中旧测试账号，并写入 .env.example 的非敏感目标示例；未访问后台登录链接，未保存邮箱或会话 token。角色与上传权限仍需实际工具验证。

新包摘要 `91c781cb86828b21b586c7055b212adff89acd8c6607e67f1efaca87d8792633`。账号配置变化导致包摘要更新，旧65d2b7d9图已归档，不继承到新账号。公网HTTPS/域名、法务与设备输入仍未补齐。

开发者工具响应AppID变化后自动补充 isGameTourist:false，已保留并重新计算摘要。
